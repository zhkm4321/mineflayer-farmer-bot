require('../../utils/log').installLogTimestamp()

const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const { configureMovements, stopMovement } = require('../../utils/movement')
const {
    StateTransition,
    BotStateMachine,
    NestedStateMachine
} = require('mineflayer-statemachine')
const { ClosableWebserver } = require('../../utils/closableWebserver')

const { serverConfig, masterData, loadConfig, saveConfig, stopBackgroundTasks } = require('./config')
const { registerCommands } = require('./commands')
const { BehaviorCheckHunger } = require('./behaviors/BehaviorCheckHunger')
const { BehaviorEat } = require('./behaviors/BehaviorEat')
const { BehaviorOperateLever } = require('./behaviors/BehaviorOperateLever')
const { BehaviorWaitHarvest } = require('./behaviors/BehaviorWaitHarvest')
const { BehaviorGetSeeds } = require('./behaviors/BehaviorGetSeeds')
const { BehaviorGoTo } = require('./behaviors/BehaviorGoTo')
const { BehaviorPlantSeeds } = require('./behaviors/BehaviorPlantSeeds')
const { BehaviorWaitMaturity } = require('./behaviors/BehaviorWaitMaturity')
const { BehaviorSleep } = require('./behaviors/BehaviorSleep')

const reconnectConfig = { maxAttempts: 10, delay: 5000, attempts: 0 }

let bot = null
let isReconnecting = false
let isShuttingDown = false
let reconnectTimer = null

// eat 行为实例在 setupStateMachine 里创建；forceEat 兜底路径需要复用它去 pos2 取面包
let eatBehavior = null
function getEatBehavior() {
    return eatBehavior
}
let stateMachine = null
let webserver = null

function logBanner(title, lines = []) {
    console.log('')
    console.log('========================================')
    console.log(`  ${title}`)
    for (const line of lines) console.log(`  ${line}`)
    console.log('========================================')
    console.log('')
}

function logStep(step, message) {
    console.log(`  [${step}] ${message}`)
}

/**
 * bot 是否已经站在某个配置点附近（水平 + 垂直都够近）。
 * 用于 GetSeeds 之后判断"还需不需要再导航一次"，避免明明就在播种区却重复寻路。
 */
function isNearPoint(point, radius = 3) {
    if (!point || !bot?.entity) return false
    const p = bot.entity.position
    const dx = p.x - point.x
    const dy = p.y - point.y
    const dz = p.z - point.z
    return Math.abs(dx) <= radius && Math.abs(dz) <= radius && Math.abs(dy) <= 3
}

// 周期性坐标日志：每 POS_LOG_INTERVAL_MS 打印一次位置与状态。
// 寻路失败时能直接看到"人到底在哪、有没有在动"，不用靠猜。
const POS_LOG_INTERVAL_MS = 10000
let posLogTimer = null

function startPositionLogger() {
    stopPositionLogger()
    let lastPos = bot.entity.position.clone()
    let lastTime = Date.now()
    posLogTimer = setInterval(() => {
        if (!bot || !bot.entity) return
        const pos = bot.entity.position
        const now = Date.now()
        const moved = pos.distanceTo(lastPos)
        const speed = moved / ((now - lastTime) / 1000)
        console.log(`[坐标] (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}) ` +
            `速度${speed.toFixed(2)}/s 食物${bot.food ?? '?'}/20 ` +
            `状态${masterData.detailStatus || '-'} 卡住计数${bot._jumpGuardBlocked || 0}`)
        lastPos = pos.clone()
        lastTime = now
    }, POS_LOG_INTERVAL_MS)
}

function stopPositionLogger() {
    if (posLogTimer) {
        clearInterval(posLogTimer)
        posLogTimer = null
    }
}

function createBot() {
    bot = mineflayer.createBot(serverConfig)
    bot.loadPlugin(pathfinder)

    bot.once('spawn', () => {
        console.log(`Bot ${bot.username} 已连接到服务器`)
        reconnectConfig.attempts = 0
        console.log(`协议版本: ${bot.protocolVersion}, 客户端版本: ${bot.version}`)
        const pos = bot.entity.position
        console.log(`当前坐标: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`)

        configureMovements(bot)
        setupStateMachine()
        registerCommands(bot, startFarming, stopFarming)
        startPositionLogger()

        // 兜底进食：只有在没有正在进行的进食/BedEat 流程时才介入，
        // 否则会和 BehaviorEat 并发 equip/consume 冲突（isEating 由 BehaviorEat 持有）
        bot.on('health', () => {
            if (bot.food <= 6 && !masterData.isEating) {
                console.log(`[警告] 食物值过低: ${bot.food}/20，强制进食`)
                masterData.isEating = true
                // 竞态守卫：BehaviorEat 状态若在本轮 forceEat 进行中启动（onStateEntered
                // 会 bump 此 id），forceEat 结束时就【不能】清掉 isEating，否则会出现
                // "兜底进食 + 状态机进食"并发 consume 冲突
                const myRun = ++masterData._eatRunId
                forceEat(myRun)
            }
        })

        masterData.isAutoFarming = true
        masterData.stopRequested = false
        console.log('[自动启动] FarmMaster 已上线，开始工作循环')
        bot.chat(`FarmMaster 上线! 自动开始工作，输入 stop 停止`)
    })

    bot.on('kicked', (reason) => {
        console.log('被踢出服务器:', reason)
        handleDisconnect()
    })
    bot.on('error', (err) => console.log('连接错误:', err.message))
    bot.on('end', () => { console.log('连接断开'); handleDisconnect() })
}

async function forceEat(myRun) {
    try {
        // 先确保手上有面包：背包没有就去 pos2 箱子取一次。
        // 原实现直接 `if (!bread) return`，所以背包一旦没面包，兜底进食就永久失效。
        let bread = bot.inventory.items().find(i => i.name === 'bread')
        if (!bread) {
            try {
                const eat = getEatBehavior()
                if (eat) {
                    const pos2 = masterData.pos2
                    if (pos2 && bot.entity.position.distanceTo(new Vec3(pos2.x, pos2.y, pos2.z)) > 3) {
                        await eat._gotoPos2()
                    }
                    await eat.fetchBreadFromChest()
                }
            } catch (e) {
                console.log(`[强制进食] 取面包失败: ${e.message}`)
            }
            bread = bot.inventory.items().find(i => i.name === 'bread')
        }
        if (!bread) {
            console.log('[强制进食] 背包和附近箱子里都没有面包')
            return
        }

        let lastErr = null
        for (let attempt = 0; attempt < 3 && bot.food < 18; attempt++) {
            bread = bot.inventory.items().find(i => i.name === 'bread')
            if (!bread) break
            try {
                await bot.equip(bread, 'hand')
                await bot.consume()
                lastErr = null
            } catch (e) {
                lastErr = e
                // "Consuming cancelled due to calling bot.consume() again" 多半是上一轮 consume
                // 还没收尾；退避重试，不要一次失败就彻底不吃（会一直饿着去干活）
                await new Promise(r => setTimeout(r, 1000))
            }
        }
        if (bot.food < 18) {
            console.log(`[强制进食] 结束时食物仍为 ${bot.food}/20` + (lastErr ? `，最后错误: ${lastErr.message}` : ''))
        }
    } catch (e) {
        console.log(`[强制进食] 失败: ${e.message}`)
    } finally {
        // 无论走哪条路径都必须释放锁，否则之后所有兜底进食都会被 isEating 挡住。
        // 但如果期间 BehaviorEat 状态已接管（id 被它 bump），锁归它管，不能在这里清
        const latestRun = masterData._eatRunId || 0
        if (myRun == null || myRun === latestRun) {
            masterData.isEating = false
        }
    }
}

function setupStateMachine() {
    // Idle: 简单等待 3 秒的门控状态
    const idle = {
        stateName: 'idle',
        active: false,
        x: 50, y: 200,
        isReady: false,
        enterTime: 0,
        onStateEntered() { this.isReady = false; this.enterTime = Date.now(); masterData.detailStatus = '空闲' },
        update() { if (Date.now() - this.enterTime >= 3000) this.isReady = true },
        onStateExited() { this.isReady = false; masterData.detailStatus = '' }
    }

    const checkHunger = new BehaviorCheckHunger(bot, masterData)
    const eat = new BehaviorEat(bot, masterData)
    eatBehavior = eat
    const activateLever = new BehaviorOperateLever(bot, masterData, 'on')
    const waitHarvest = new BehaviorWaitHarvest(bot, masterData)
    const deactivateLever = new BehaviorOperateLever(bot, masterData, 'off')
    const getSeeds = new BehaviorGetSeeds(bot, masterData)
    const getWaypoints = () => masterData.waypoints
    const gotoPos1 = new BehaviorGoTo(bot, masterData, () => masterData.pos1, '前往播种区', {
        getWaypoints, reverseWaypoints: false, y: 150
    })
    const plantSeeds = new BehaviorPlantSeeds(bot, masterData)
    const gotoPos2 = new BehaviorGoTo(bot, masterData, () => masterData.pos2, '前往拉杆区', {
        getWaypoints, reverseWaypoints: true, y: 350
    })
    const waitMaturity = new BehaviorWaitMaturity(bot, masterData)
    const sleepBehavior = new BehaviorSleep(bot, masterData)

    // 状态机转移按数组顺序匹配，靠前者优先，因此显式分三段拼接：
    //   [1] stop  : 任意工作状态 → idle（最高优先级，保证 stop 一定生效）
    //   [2] sleep : WaitMaturity/Idle → Sleep → WaitMaturity
    //   [3] flow  : 正常工作流
    // 注意 sleep 不覆盖 waitHarvest —— 收割等待中途去睡觉会把拉杆留在开启状态。
    //
    // 工作流：
    // Idle → WaitMaturity → CheckHunger（必经）→ Eat?
    //   ├─ 需要收割 → ActivateLever(开) → WaitHarvest(闭环) → DeactivateLever(关) → GetSeeds → GoTo(pos1) → Plant → GoTo(pos2) → WaitMaturity
    //   └─ 需要播种 → GetSeeds → GoTo(pos1) → PlantSeeds → GoTo(pos2) → WaitMaturity

    // ---- [1] 停止（最高优先级）----
    const stopTargets = [
        waitMaturity, checkHunger, eat, activateLever, waitHarvest,
        deactivateLever, getSeeds, gotoPos1, plantSeeds, gotoPos2, sleepBehavior
    ]
    const stopTransitions = stopTargets.map(state =>
        new StateTransition({
            parent: state,
            child: idle,
            name: 'stop',
            shouldTransition: () => masterData.stopRequested
        })
    )

    // ---- [2] 夜晚睡觉（受 stop 与失败冷却约束）----
    const sleepTransitions = [waitMaturity, idle].map(state =>
        new StateTransition({
            parent: state,
            child: sleepBehavior,
            name: 'sleep',
            shouldTransition: () => BehaviorSleep.shouldSleep(bot, masterData)
        })
    )

    // ---- [3] 正常工作流 ----
    const flowTransitions = [
        // Idle -> WaitMaturity
        new StateTransition({
            parent: idle,
            child: waitMaturity,
            shouldTransition: () => idle.isReady && masterData.isAutoFarming && !masterData.stopRequested
        }),

        // WaitMaturity -> CheckHunger（总是先检查饥饿）
        new StateTransition({
            parent: waitMaturity,
            child: checkHunger,
            shouldTransition: () => waitMaturity.isFinished
        }),

        // CheckHunger -> Eat（饿了先吃）
        new StateTransition({
            parent: checkHunger,
            child: eat,
            shouldTransition: () => checkHunger.checked && checkHunger.needsFood
        }),
        // CheckHunger -> ActivateLever（不饿 + 需要收割）
        new StateTransition({
            parent: checkHunger,
            child: activateLever,
            shouldTransition: () => checkHunger.checked && !checkHunger.needsFood && masterData._needsHarvest
        }),
        // CheckHunger -> GetSeeds（不饿 + 需要播种）
        new StateTransition({
            parent: checkHunger,
            child: getSeeds,
            shouldTransition: () => checkHunger.checked && !checkHunger.needsFood && !masterData._needsHarvest
        }),
        // 【已删除】曾经的重复转移 `checkHunger → eat` 带 `masterData.forceEat` 条件：
        // forceEat 是本文件的函数，masterData 上根本没有这个字段，恒为 undefined，
        // 整条转移是死代码（与上面 271 行的 checkHunger→eat 完全重复）。

        // Eat -> ActivateLever（吃完 + 需要收割）
        new StateTransition({
            parent: eat,
            child: activateLever,
            shouldTransition: () => eat.isFinished && masterData._needsHarvest
        }),
        // Eat -> GetSeeds（吃完 + 需要播种）
        new StateTransition({
            parent: eat,
            child: getSeeds,
            shouldTransition: () => eat.isFinished && !masterData._needsHarvest
        }),

        // ActivateLever 成功 -> WaitHarvest
        new StateTransition({
            parent: activateLever,
            child: waitHarvest,
            shouldTransition: () => activateLever.isFinished && activateLever.succeeded
        }),
        // ActivateLever 失败 -> WaitMaturity（本轮不收割，下轮重试）
        new StateTransition({
            parent: activateLever,
            child: waitMaturity,
            shouldTransition: () => activateLever.isFinished && !activateLever.succeeded
        }),

        // WaitHarvest -> DeactivateLever
        new StateTransition({
            parent: waitHarvest,
            child: deactivateLever,
            shouldTransition: () => waitHarvest.isFinished
        }),

        // DeactivateLever 成功 -> GetSeeds
        new StateTransition({
            parent: deactivateLever,
            child: getSeeds,
            shouldTransition: () => deactivateLever.isFinished && deactivateLever.succeeded
        }),
        // DeactivateLever 失败 -> WaitMaturity（拉杆可能仍开启，禁止此时播种）
        new StateTransition({
            parent: deactivateLever,
            child: waitMaturity,
            shouldTransition: () => deactivateLever.isFinished && !deactivateLever.succeeded
        }),

        // GetSeeds -> PlantSeeds（物资充足，且已经站在播种区 → 直接开播，无需再导航）
        new StateTransition({
            parent: getSeeds,
            child: plantSeeds,
            shouldTransition: () => getSeeds.isFinished && !getSeeds.noHoes && isNearPoint(masterData.pos1)
        }),

        // GetSeeds -> GoToPos1（物资充足但还没到播种区）
        new StateTransition({
            parent: getSeeds,
            child: gotoPos1,
            shouldTransition: () => getSeeds.isFinished && !getSeeds.noHoes && !isNearPoint(masterData.pos1)
        }),

        // GetSeeds -> WaitMaturity（没取到锄头/种子）
        // 【重要】失败分支不能指回"自己的父状态"，否则形成 [父 → 取物资 → 父] 的零间隔死循环。
        // 但仅靠换目标还不够：本流程本身就是一个环（waitMaturity → getSeeds → ...），
        // 所以 BehaviorGetSeeds.onStateEntered 里还有一道 supplyRetryAt 冷却闸门兜底。
        new StateTransition({
            parent: getSeeds,
            child: waitMaturity,
            shouldTransition: () => getSeeds.isFinished && getSeeds.noHoes
        }),

        // GoToPos1 -> PlantSeeds（必须真正到达，否则不许开播）
        new StateTransition({
            parent: gotoPos1,
            child: plantSeeds,
            shouldTransition: () => gotoPos1.isFinished && gotoPos1.arrived
        }),

        // GoToPos1 -> CheckHunger（没走到就回去重新决策；播种状态自带位置守卫，会拒绝在区外开播）
        new StateTransition({
            parent: gotoPos1,
            child: checkHunger,
            shouldTransition: () => gotoPos1.isFinished && !gotoPos1.arrived
        }),

        // PlantSeeds -> GoToPos2
        new StateTransition({
            parent: plantSeeds,
            child: gotoPos2,
            shouldTransition: () => plantSeeds.isFinished
        }),

        // GoToPos2 -> WaitMaturity (循环回成熟度检测)
        new StateTransition({
            parent: gotoPos2,
            child: waitMaturity,
            shouldTransition: () => gotoPos2.isFinished && gotoPos2.arrived
        }),

        // GoToPos2 -> CheckHunger（回程失败：先补状态再重新决策，不要假装已回到等待区）
        new StateTransition({
            parent: gotoPos2,
            child: checkHunger,
            shouldTransition: () => gotoPos2.isFinished && !gotoPos2.arrived
        }),

        // Sleep -> WaitMaturity（醒来后继续工作）
        new StateTransition({
            parent: sleepBehavior,
            child: waitMaturity,
            shouldTransition: () => sleepBehavior.isFinished
        }),
    ]

    const transitions = [...stopTransitions, ...sleepTransitions, ...flowTransitions]

    const rootLayer = new NestedStateMachine(transitions, idle)
    rootLayer.stateName = 'farmMaster'

    stateMachine = new BotStateMachine(bot, rootLayer)

    try {
        if (!webserver?.isServerRunning()) {
            webserver = new ClosableWebserver(bot, stateMachine, 8935)
            webserver.startServer()
            console.log('[Web] 状态机可视化: http://localhost:8935')
        }
    } catch (e) {
        console.log('[Web] 启动失败:', e.message)
    }

    console.log('[状态机] FarmMaster 已初始化，12 个状态')
}

function startFarming() {
    masterData.isAutoFarming = true
    masterData.stopRequested = false
}

function stopFarming() {
    masterData.stopRequested = true
    masterData.isAutoFarming = false
    if (bot) stopMovement(bot)
}

function handleDisconnect() {
    if (isShuttingDown || isReconnecting) return
    isReconnecting = true
    stateMachine = null
    stopPositionLogger()

    // 关闭旧的 Web 可视化：它持有旧 bot / stateMachine 的引用，
    // 重连后不会自动切换（页面永远停在旧状态机），而且会一直占着端口
    if (webserver) {
        const ws = webserver
        webserver = null
        try {
            if (ws.isServerRunning()) ws.stopServer().catch(() => {})
        } catch (e) { /* ignore */ }
    }

    if (reconnectConfig.attempts >= reconnectConfig.maxAttempts) {
        console.log('达到最大重连次数，停止重连')
        process.exit(1)
    }

    reconnectConfig.attempts++
    console.log(`${reconnectConfig.delay / 1000}s 后重连 (${reconnectConfig.attempts}/${reconnectConfig.maxAttempts})`)

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        isReconnecting = false
        createBot()
    }, reconnectConfig.delay)
}

async function shutdown(signal = 'SIGINT') {
    if (isShuttingDown) { process.exit(1) }
    isShuttingDown = true
    masterData.isShuttingDown = true

    const forceExitTimer = setTimeout(() => process.exit(0), 5000)

    const signalLabel = signal === 'SIGINT' ? 'Ctrl+C' : signal
    logBanner('FarmMaster 正在关闭', [`收到退出信号 (${signalLabel})`])

    logStep('1/4', '停止任务与状态机...')
    masterData.stopRequested = true
    masterData.isAutoFarming = false
    if (bot) {
        bot.removeAllListeners('physicsTick')
        bot.removeAllListeners('physicTick')
    }
    stateMachine = null
    if (bot?.pathfinder) { try { bot.pathfinder.setGoal(null) } catch (e) { /* ignore */ } }

    logStep('2/4', '取消自动重连...')
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    logStep('3/4', '断开连接...')
    if (bot) {
        bot.removeAllListeners('end')
        bot.removeAllListeners('kicked')
        try { bot.quit('FarmMaster 已下线') } catch (e) { try { bot.end() } catch (e2) { /* ignore */ } }
    }

    logStep('4/4', '关闭 Web 服务并保存配置...')
    stopBackgroundTasks()
    stopPositionLogger()
    if (webserver?.isServerRunning()) {
        try { await webserver.stopServer() } catch (e) { /* ignore */ }
    }
    saveConfig()

    clearTimeout(forceExitTimer)
    console.log('')
    console.log('  FarmMaster 已安全退出')
    console.log('')
    process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

loadConfig()
logBanner('FarmMaster 已启动', [
    `连接: ${serverConfig.host}:${serverConfig.port}`,
    `账号: ${serverConfig.username}`,
    '按 Ctrl+C 安全退出'
])
createBot()
