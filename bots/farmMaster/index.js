require('../../utils/log').installLogTimestamp()

const mineflayer = require('mineflayer')
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

        // 兜底进食：只有在没有正在进行的进食/BedEat 流程时才介入，
        // 否则会和 BehaviorEat 并发 equip/consume 冲突（isEating 由 BehaviorEat 持有）
        bot.on('health', () => {
            if (bot.food <= 6 && !masterData.isEating) {
                console.log(`[警告] 食物值过低: ${bot.food}/20，强制进食`)
                masterData.isEating = true
                forceEat()
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

async function forceEat() {
    try {
        let bread = bot.inventory.items().find(i => i.name === 'bread')
        if (!bread) { masterData.isEating = false; return }
        while (bot.food < 18) {
            bread = bot.inventory.items().find(i => i.name === 'bread')
            if (!bread) break
            await bot.equip(bread, 'hand')
            await bot.consume()
        }
    } catch (e) {
        console.log(`[强制进食] 失败: ${e.message}`)
    }
    masterData.isEating = false
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

        // GetSeeds -> Idle（锄头不足时等待）
        new StateTransition({
            parent: getSeeds,
            child: idle,
            shouldTransition: () => getSeeds.isFinished && getSeeds.noHoes
        }),

        // GetSeeds -> GoToPos1（物资充足时继续）
        new StateTransition({
            parent: getSeeds,
            child: gotoPos1,
            shouldTransition: () => getSeeds.isFinished && !getSeeds.noHoes
        }),

        // GoToPos1 -> PlantSeeds
        new StateTransition({
            parent: gotoPos1,
            child: plantSeeds,
            shouldTransition: () => gotoPos1.isFinished
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
            shouldTransition: () => gotoPos2.isFinished
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
