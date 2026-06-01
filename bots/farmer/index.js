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

const { serverConfig, farmData, loadConfig, saveConfig, isInWorkArea, stopBackgroundTasks } = require('./config')
const { registerCommands } = require('./commands')
const { BehaviorIdle } = require('./behaviors/BehaviorIdle')
const { BehaviorCheckHunger } = require('./behaviors/BehaviorCheckHunger')
const { BehaviorEat } = require('./behaviors/BehaviorEat')
const { BehaviorScan } = require('./behaviors/BehaviorScan')
const { BehaviorHarvest } = require('./behaviors/BehaviorHarvest')
const { BehaviorCollectDrops } = require('./behaviors/BehaviorCollectDrops')
const { BehaviorStore } = require('./behaviors/BehaviorStore')
const { BehaviorPlant } = require('./behaviors/BehaviorPlant')
const { scanFarmingAreas } = require('../../utils/farmScan')

function refreshFarmStats() {
    return scanFarmingAreas(bot, farmData, isInWorkArea)
}

const reconnectConfig = {
    maxAttempts: 10,
    delay: 5000,
    attempts: 0
}

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
    for (const line of lines) {
        console.log(`  ${line}`)
    }
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
        configureMovements(bot)

        setupStateMachine()
        registerCommands(bot, startFarming, stopFarming)

        bot.on('health', () => {
            if (bot.food <= 6 && !farmData.isEating) {
                console.log(`[警告] 食物值过低: ${bot.food}/20，强制进食`)
                farmData.isEating = true
                forceEat()
            }
        })

        if (farmData.currentCrop) {
            console.log(`[自动恢复] 开始农场模式: ${farmData.currentCrop}`)
            farmData.isAutoFarming = true
            farmData.stopRequested = false
        }

        bot.chat(`FarmerBot 上线! 输入 help 查看命令`)
    })

    bot.on('kicked', (reason) => {
        console.log('被踢出服务器:', reason)
        handleDisconnect()
    })

    bot.on('error', (err) => {
        console.log('连接错误:', err.message)
    })

    bot.on('end', () => {
        console.log('连接断开')
        handleDisconnect()
    })
}

async function forceEat() {
    try {
        let bread = bot.inventory.items().find(i => i.name === 'bread')
        if (!bread) {
            farmData.isEating = false
            return
        }
        while (bot.food < 18) {
            bread = bot.inventory.items().find(i => i.name === 'bread')
            if (!bread) break
            await bot.equip(bread, 'hand')
            await bot.consume()
        }
    } catch (e) {
        console.log(`[强制进食] 失败: ${e.message}`)
    }
    farmData.isEating = false
}

function setupStateMachine() {
    const idle = new BehaviorIdle(bot, farmData)
    const checkHunger = new BehaviorCheckHunger(bot, farmData)
    const eat = new BehaviorEat(bot, farmData)
    const scan = new BehaviorScan(bot, farmData)
    const harvest = new BehaviorHarvest(bot, farmData)
    const collectDrops = new BehaviorCollectDrops(bot, farmData)
    const store = new BehaviorStore(bot, farmData)
    const plant = new BehaviorPlant(bot, farmData)

    const transitions = [
        new StateTransition({
            parent: idle,
            child: checkHunger,
            shouldTransition: () => idle.isReady && farmData.isAutoFarming && !farmData.stopRequested
        }),
        new StateTransition({
            parent: checkHunger,
            child: eat,
            shouldTransition: () => checkHunger.checked && checkHunger.needsFood
        }),
        new StateTransition({
            parent: checkHunger,
            child: scan,
            shouldTransition: () => checkHunger.checked && !checkHunger.needsFood
        }),
        new StateTransition({
            parent: eat,
            child: scan,
            shouldTransition: () => eat.isFinished
        }),
        new StateTransition({
            parent: scan,
            child: harvest,
            shouldTransition: () => scan.isFinished && scan.hasMature
        }),
        new StateTransition({
            parent: scan,
            child: store,
            shouldTransition: () => scan.isFinished && !scan.hasMature && scan.hasPlantableEmpty
        }),
        new StateTransition({
            parent: scan,
            child: idle,
            shouldTransition: () => scan.isFinished && !scan.hasMature && !scan.hasPlantableEmpty
        }),
        new StateTransition({
            parent: harvest,
            child: collectDrops,
            shouldTransition: () => harvest.isFinished
        }),
        new StateTransition({
            parent: collectDrops,
            child: store,
            shouldTransition: () => collectDrops.isFinished
        }),
        new StateTransition({
            parent: store,
            child: harvest,
            shouldTransition: () => {
                if (!store.isFinished) return false
                const stats = refreshFarmStats()
                return stats.matureCount > 0
            }
        }),
        new StateTransition({
            parent: store,
            child: plant,
            shouldTransition: () => {
                if (!store.isFinished) return false
                const stats = refreshFarmStats()
                return stats.matureCount === 0 && stats.plantableEmptyCount > 0
            }
        }),
        new StateTransition({
            parent: store,
            child: idle,
            shouldTransition: () => {
                if (!store.isFinished) return false
                const stats = refreshFarmStats()
                return stats.matureCount === 0 && stats.plantableEmptyCount <= 0
            }
        }),
        new StateTransition({
            parent: plant,
            child: checkHunger,
            shouldTransition: () => plant.isFinished
        }),

        // stop transitions
        ...[checkHunger, eat, scan, harvest, collectDrops, store, plant].map(state =>
            new StateTransition({
                parent: state,
                child: idle,
                name: 'stop',
                shouldTransition: () => farmData.stopRequested
            })
        ),
    ]

    const rootLayer = new NestedStateMachine(transitions, idle)
    rootLayer.stateName = 'farmBot'

    stateMachine = new BotStateMachine(bot, rootLayer)

    try {
        if (!webserver?.isServerRunning()) {
            webserver = new ClosableWebserver(bot, stateMachine, 8934)
            webserver.startServer()
            console.log('[Web] 状态机可视化: http://localhost:8934')
        }
    } catch (e) {
        console.log('[Web] 启动失败:', e.message)
    }

    console.log('[状态机] 已初始化，共 8 个状态')
}

function startFarming() {
    farmData.isAutoFarming = true
    farmData.stopRequested = false
}

function stopFarming() {
    farmData.stopRequested = true
    farmData.isAutoFarming = false
    if (bot) stopMovement(bot)
}

function handleDisconnect() {
    if (isShuttingDown || isReconnecting) return
    isReconnecting = true
    stateMachine = null

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

function stopStateMachine() {
    if (!bot) return
    bot.removeAllListeners('physicsTick')
    bot.removeAllListeners('physicTick')
    stateMachine = null
}

function finishShutdown(exitCode = 0) {
    console.log('')
    console.log('----------------------------------------')
    console.log('  FarmerBot 已安全退出，再见!')
    console.log('----------------------------------------')
    console.log('')
    process.exit(exitCode)
}

async function shutdown(signal = 'SIGINT') {
    if (isShuttingDown) {
        console.log('')
        console.log('  正在强制退出...')
        process.exit(1)
    }
    isShuttingDown = true
    farmData.isShuttingDown = true

    const forceExitTimer = setTimeout(() => {
        console.log('')
        console.log('  清理超时，强制退出...')
        process.exit(0)
    }, 5000)

    const signalLabel = signal === 'SIGINT' ? 'Ctrl+C' : signal
    logBanner('FarmerBot 正在关闭', [
        `收到退出信号 (${signalLabel})`,
        '请稍候，正在清理资源...'
    ])

    logStep('1/4', '停止农场任务与状态机...')
    farmData.stopRequested = true
    farmData.isAutoFarming = false
    stopStateMachine()
    if (bot?.pathfinder) {
        try { bot.pathfinder.setGoal(null) } catch (e) {}
    }

    logStep('2/4', '取消自动重连...')
    if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
    }

    logStep('3/4', '断开 Minecraft 连接...')
    if (bot) {
        bot.removeAllListeners('end')
        bot.removeAllListeners('kicked')
        try {
            bot.quit('FarmerBot 已下线')
        } catch (e) {
            try { bot.end() } catch (e2) {}
        }
    }

    logStep('4/4', '关闭 Web 服务并保存配置...')
    stopBackgroundTasks()
    if (webserver?.isServerRunning()) {
        try {
            await webserver.stopServer()
            console.log('  Web 可视化已关闭 (8934)')
        } catch (e) {
            console.log(`  Web 关闭失败: ${e.message}`)
        }
    }
    saveConfig()

    clearTimeout(forceExitTimer)
    finishShutdown(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

loadConfig()
logBanner('FarmerBot 已启动', [
    `连接: ${serverConfig.host}:${serverConfig.port}`,
    `账号: ${serverConfig.username}`,
    '按 Ctrl+C 安全退出'
])
createBot()
