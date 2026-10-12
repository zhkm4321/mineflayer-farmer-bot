/**
 * DaoXiang（稻香）— 梯田农民机器人
 *
 * 职责（规则 8）：
 *   1. 拉动拉杆放水收割成熟作物（收割后 ≥10s 闭环确认，规则 2）
 *   2. 播种前确认拉杆关闭（规则 3），从木桶取种子按比例播种（规则 5）
 *   3. 从附近容器自寻面包/石锄，保持饥饿值不低于 20%
 *   4. 用锄头修复被踩坏的耕地（dirt → farmland）
 *   5. 夜晚前往发呆点躲避幻翼
 *   6. tp 策略（规则 7）：目标 >200 格直传；寻路极端失败传回初始位置
 */
const mineflayer = require('mineflayer')
const { StateTransition, BotStateMachine, NestedStateMachine } = require('mineflayer-statemachine')

const { serverConfig, masterData, loadConfig, isInTerraces, isInPlantArea } = require('./config')
const { configureMovements, stopMovement } = require('../../utils/movement')
const { ClosableWebserver } = require('../../utils/closableWebserver')
const { BehaviorWaitMaturity } = require('./behaviors/BehaviorWaitMaturity')
const { BehaviorCheckHunger } = require('./behaviors/BehaviorCheckHunger')
const { BehaviorEat } = require('./behaviors/BehaviorEat')
const { BehaviorGetSupplies } = require('./behaviors/BehaviorGetSupplies')
const { BehaviorOperateLever } = require('./behaviors/BehaviorOperateLever')
const { BehaviorWaitHarvest } = require('./behaviors/BehaviorWaitHarvest')
const { BehaviorGoTo } = require('./behaviors/BehaviorGoTo')
const { BehaviorPlantSeeds } = require('./behaviors/BehaviorPlantSeeds')
const { BehaviorNightIdle } = require('./behaviors/BehaviorNightIdle')

let bot = null
let stateMachine = null
let webserver = null
let eatBehavior = null
let reconnectTimer = null
let posLogTimer = null
let isReconnecting = false
let isShuttingDown = false
let isSetUp = false   // 本次连接是否已完成一次性初始化（防重生重复叠加状态机/监听器）

const reconnectConfig = { attempts: 0, maxAttempts: 10, delay: 8000 }

loadConfig()

// ---------------- 周期性坐标日志 ----------------
function startPositionLogger() {
    stopPositionLogger()
    const interval = masterData.posLogIntervalMs || 10000
    posLogTimer = setInterval(() => {
        if (!bot || !bot.entity) return
        const p = bot.entity.position
        const lastSpeed = bot._posLogLast
            ? p.distanceTo(bot._posLogLast.pos) / Math.max(1, (Date.now() - bot._posLogLast.t) / 1000)
            : 0
        bot._posLogLast = { pos: p.clone(), t: Date.now() }
        console.log(`[坐标] (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) ` +
            `速度${lastSpeed.toFixed(2)}/s 食物${bot.food ?? '?'}/20 ` +
            `状态${masterData.detailStatus || '-'} 时间${bot.time?.timeOfDay ?? '?'}`)
    }, interval)
}

function stopPositionLogger() {
    if (posLogTimer) {
        clearInterval(posLogTimer)
        posLogTimer = null
    }
}

// ---------------- 兜底进食（并发守卫） ----------------
async function forceEat(myRun) {
    try {
        const eat = eatBehavior
        if (!eat) return
        const breadName = masterData.food.breadItem || 'bread'
        const hasBread = () => bot.inventory.items().find(i => i.name === breadName)

        let bread = hasBread()
        if (!bread) {
            try {
                await eat.fetchBreadFromContainers()
            } catch (e) {
                console.log(`[强制进食] 取面包失败: ${e.message}`)
            }
            bread = hasBread()
        }
        if (!bread) {
            console.log('[强制进食] 背包和附近容器中都没有面包')
            return
        }

        let lastErr = null
        for (let attempt = 0; attempt < 3 && bot.food < 18; attempt++) {
            bread = hasBread()
            if (!bread) break
            try {
                await bot.equip(bread, 'hand')
                await bot.consume()
                lastErr = null
            } catch (e) {
                lastErr = e
                await new Promise(r => setTimeout(r, 1000))
            }
        }
        if (bot.food < 18) {
            console.log(`[强制进食] 结束时食物仍为 ${bot.food}/20` +
                (lastErr ? `，最后错误: ${lastErr.message}` : ''))
        }
    } catch (e) {
        console.log(`[强制进食] 失败: ${e.message}`)
    } finally {
        // BehaviorEat 状态若已接管（bump 了 id），锁归它管，不能在这里清
        const latestRun = masterData._eatRunId || 0
        if (myRun == null || myRun === latestRun) {
            masterData.isEating = false
        }
    }
}

// ---------------- 聊天命令 ----------------
function registerCommands() {
    bot.on('chat', (username, message) => {
        if (username === bot.username) return
        const msg = message.trim()
        if (msg === '稻香 停' || msg === 'daoxiang stop') {
            masterData.stopRequested = true
            masterData.isAutoFarming = false
            stopMovement(bot)
            bot.chat('收到，停止工作')
        } else if (msg === '稻香 状态' || msg === 'daoxiang status') {
            bot.chat(`状态: ${masterData.detailStatus || '空闲'} | 食物 ${bot.food}/20 | 收割轮次 ${masterData.harvestRound}`)
        }
    })
}

// ---------------- 状态机 ----------------
function setupStateMachine() {
    const idle = {
        stateName: 'idle',
        active: false,
        x: 50, y: 200,
        isReady: false,
        enterTime: 0,
        onStateEntered() {
            this.isReady = false
            this.enterTime = Date.now()
            masterData.detailStatus = '空闲'
        },
        update() { if (Date.now() - this.enterTime >= 3000) this.isReady = true },
        onStateExited() { this.isReady = false; masterData.detailStatus = '' }
    }

    const waitMaturity = new BehaviorWaitMaturity(bot, masterData)
    const checkHunger = new BehaviorCheckHunger(bot, masterData)
    const eat = new BehaviorEat(bot, masterData)
    eatBehavior = eat
    const activateLever = new BehaviorOperateLever(bot, masterData, 'on')
    const waitHarvest = new BehaviorWaitHarvest(bot, masterData)
    const deactivateLever = new BehaviorOperateLever(bot, masterData, 'off')
    const getSupplies = new BehaviorGetSupplies(bot, masterData)
    const getWaypoints = () => masterData.waypoints
    const gotoPlant = new BehaviorGoTo(bot, masterData, () => masterData.plantEntry, '前往播种区', {
        getWaypoints, tpHomeOnFail: true, stateName: 'gotoPlant', x: 150, y: 150
    })
    const plantSeeds = new BehaviorPlantSeeds(bot, masterData)
    const gotoHome = new BehaviorGoTo(bot, masterData, () => masterData.lever, '返回拉杆区', {
        getWaypoints, reverseWaypoints: true, tpHomeOnFail: true, stateName: 'gotoHome', x: 150, y: 250
    })
    const nightIdle = new BehaviorNightIdle(bot, masterData)

    // [1] 停止（最高优先级）
    const stopTargets = [
        waitMaturity, checkHunger, eat, activateLever, waitHarvest,
        deactivateLever, getSupplies, gotoPlant, plantSeeds, gotoHome, nightIdle
    ]
    const stopTransitions = stopTargets.map(state =>
        new StateTransition({
            parent: state,
            child: idle,
            name: 'stop',
            shouldTransition: () => masterData.stopRequested
        })
    )

    // [2] 夜晚发呆（规则 8；不覆盖收割等待，避免拉杆开着无人管）
    const nightTransitions = [waitMaturity, idle].map(state =>
        new StateTransition({
            parent: state,
            child: nightIdle,
            name: 'night',
            shouldTransition: () => BehaviorNightIdle.shouldIdle(bot, masterData)
        })
    )

    // [3] 工作流
    //   Idle → WaitMaturity → CheckHunger → Eat?
    //     ├─ 收割 → ActivateLever(开) → WaitHarvest(闭环≥10s) → DeactivateLever(关) → GetSupplies → GoToPlant → Plant → GoToHome → WaitMaturity
    //     └─ 播种 → GetSupplies → GoToPlant → Plant → GoToHome → WaitMaturity
    //   Plant 发现拉杆未开(规则3违背) → DeactivateLever 先关水
    const flowTransitions = [
        new StateTransition({
            parent: idle,
            child: waitMaturity,
            shouldTransition: () => idle.isReady && masterData.isAutoFarming && !masterData.stopRequested
        }),
        new StateTransition({
            parent: waitMaturity,
            child: checkHunger,
            shouldTransition: () => waitMaturity.isFinished
        }),
        new StateTransition({
            parent: checkHunger,
            child: eat,
            shouldTransition: () => checkHunger.checked && checkHunger.needsFood
        }),
        new StateTransition({
            parent: checkHunger,
            child: activateLever,
            shouldTransition: () => checkHunger.checked && !checkHunger.needsFood && masterData._needsHarvest
        }),
        new StateTransition({
            parent: checkHunger,
            child: getSupplies,
            shouldTransition: () => checkHunger.checked && !checkHunger.needsFood && !masterData._needsHarvest
        }),
        new StateTransition({
            parent: eat,
            child: activateLever,
            shouldTransition: () => eat.isFinished && masterData._needsHarvest
        }),
        new StateTransition({
            parent: eat,
            child: getSupplies,
            shouldTransition: () => eat.isFinished && !masterData._needsHarvest
        }),
        new StateTransition({
            parent: activateLever,
            child: waitHarvest,
            shouldTransition: () => activateLever.isFinished && activateLever.succeeded
        }),
        new StateTransition({
            parent: activateLever,
            child: waitMaturity,
            shouldTransition: () => activateLever.isFinished && !activateLever.succeeded
        }),
        new StateTransition({
            parent: waitHarvest,
            child: deactivateLever,
            shouldTransition: () => waitHarvest.isFinished
        }),
        new StateTransition({
            parent: deactivateLever,
            child: getSupplies,
            shouldTransition: () => deactivateLever.isFinished && deactivateLever.succeeded
        }),
        new StateTransition({
            parent: deactivateLever,
            child: waitMaturity,
            shouldTransition: () => deactivateLever.isFinished && !deactivateLever.succeeded
        }),
        new StateTransition({
            parent: getSupplies,
            child: gotoPlant,
            shouldTransition: () => getSupplies.isFinished && getSupplies.noShortage
        }),
        // 没取够物资：等冷却后回监测（入口闸门在 GetSupplies.onStateEntered）
        new StateTransition({
            parent: getSupplies,
            child: waitMaturity,
            shouldTransition: () => getSupplies.isFinished && getSupplies.shortage
        }),
        // 【arrived 契约】没真正到达播种区就不许开播
        new StateTransition({
            parent: gotoPlant,
            child: plantSeeds,
            shouldTransition: () => gotoPlant.isFinished && gotoPlant.arrived
        }),
        new StateTransition({
            parent: gotoPlant,
            child: checkHunger,
            shouldTransition: () => gotoPlant.isFinished && !gotoPlant.arrived
        }),
        // 规则 3：播种前发现拉杆开着 → 先去关掉
        new StateTransition({
            parent: plantSeeds,
            child: deactivateLever,
            shouldTransition: () => plantSeeds.isFinished && plantSeeds.leverStillOn
        }),
        new StateTransition({
            parent: plantSeeds,
            child: gotoHome,
            shouldTransition: () => plantSeeds.isFinished && !plantSeeds.leverStillOn
        }),
        new StateTransition({
            parent: gotoHome,
            child: waitMaturity,
            shouldTransition: () => gotoHome.isFinished && gotoHome.arrived
        }),
        new StateTransition({
            parent: gotoHome,
            child: checkHunger,
            shouldTransition: () => gotoHome.isFinished && !gotoHome.arrived
        })
    ]

    const transitions = [...stopTransitions, ...nightTransitions, ...flowTransitions]

    const rootLayer = new NestedStateMachine(transitions, idle)
    rootLayer.stateName = 'daoXiang'

    stateMachine = new BotStateMachine(bot, rootLayer)

    try {
        if (!webserver?.isServerRunning()) {
            webserver = new ClosableWebserver(bot, stateMachine, masterData.webPort || 8936)
            webserver.startServer()
            console.log(`[Web] 状态机可视化: http://localhost:${masterData.webPort || 8936}`)
        }
    } catch (e) {
        console.log('[Web] 启动失败:', e.message)
    }

    console.log(`[状态机] DaoXiang 已初始化，12 个状态，${transitions.length} 条转移`)
}

function startFarming() {
    masterData.isAutoFarming = true
    masterData.stopRequested = false
}

function handleDisconnect() {
    if (isShuttingDown || isReconnecting) return
    isReconnecting = true
    stateMachine = null
    stopPositionLogger()

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

function createBot() {
    bot = mineflayer.createBot({
        ...serverConfig,
        hideErrors: false
    })
    isSetUp = false   // 新连接需要重新初始化

    bot.on('login', () => {
        console.log(`Bot ${bot.username} 已连接到服务器`)
        console.log(`协议版本: ${bot.protocolVersion}, 客户端版本: ${bot.version}`)
    })

    bot.on('death', () => {
        console.log('[死亡] DaoXiang 死亡，等待自动重生')
        try { stopMovement(bot) } catch (e) { /* ignore */ }
    })

    bot.on('spawn', () => {
        const p = bot.entity.position
        console.log(`当前坐标: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`)

        // 记录初始位置（规则 7：极端寻路失败时 tp 回这里）
        if (!masterData.homePos) {
            masterData.homePos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
            console.log(`[配置] 已记录初始位置: (${masterData.homePos.x},${masterData.homePos.y},${masterData.homePos.z})`)
        }

        // 【一次性初始化】只在每次连接的第一次 spawn 执行。
        // 死亡重生会再次触发 spawn，若重复执行会叠加多台状态机和监听器
        // （实测：夜里死亡重生 4 次 → 4 台状态机同时驱动）。
        if (!isSetUp) {
            isSetUp = true
            bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
            configureMovements(bot)

            // 【已知上游问题】mineflayer-statemachine@1.7.0 仍监听废弃的 physicTick，
            // mineflayer 4.x 会打警告 —— 第三方库内部行为，不影响功能，不修改 node_modules
            setupStateMachine()
            registerCommands()

            bot.on('health', () => {
                const trigger = masterData.food.triggerPercent ?? 30
                if (bot.food <= Math.ceil(20 * trigger / 100) && !masterData.isEating) {
                    console.log(`[警告] 食物值过低: ${bot.food}/20，强制进食`)
                    masterData.isEating = true
                    const myRun = ++masterData._eatRunId
                    forceEat(myRun)
                }
            })

            masterData.isAutoFarming = true
            masterData.stopRequested = false
            console.log('[自动启动] DaoXiang 已上线，开始工作循环')
            bot.chat(`稻香上线! 自动开始务农，输入 "daoxiang stop" 停止`)
        } else {
            // 重生：状态机仍在运行，恢复寻路配置即可
            configureMovements(bot)
            console.log('[重生] 已回到世界，继续工作')
        }

        startPositionLogger()
    })

    bot.on('kicked', (reason) => {
        console.log('被踢出服务器:', reason)
        handleDisconnect()
    })
    bot.on('error', (err) => console.log('连接错误:', err.message))
    bot.on('end', () => { console.log('连接断开'); handleDisconnect() })
}

async function shutdown(signal = 'SIGINT') {
    if (isShuttingDown) process.exit(1)
    isShuttingDown = true
    masterData.isShuttingDown = true
    console.log(`\n收到 ${signal}，安全退出...`)
    stopPositionLogger()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (bot) {
        try { stopMovement(bot) } catch (e) { /* ignore */ }
        try { bot.quit() } catch (e) { /* ignore */ }
    }
    if (webserver) {
        try { if (webserver.isServerRunning()) await webserver.stopServer() } catch (e) { /* ignore */ }
    }
    process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

console.log('========================================')
console.log('  DaoXiang（稻香）— 梯田农民机器人')
console.log(`  连接: ${serverConfig.host}:${serverConfig.port}`)
console.log(`  账号: ${serverConfig.username}`)
console.log('  按 Ctrl+C 安全退出')
console.log('========================================')

createBot()
