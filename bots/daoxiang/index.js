/**
 * DaoXiang（稻香）— 梯田农民机器人
 *
 * 职责（规则 8）：
 *   1. 拉动拉杆放水收割成熟作物（收割后 ≥10s 闭环确认，规则 2）
 *   2. 播种前确认拉杆关闭（规则 3），从木桶取种子按比例播种（规则 5）
 *   3. 从附近容器自寻面包/石锄，保持饥饿值不低于 20%（supplyChest 为兜底锚点）
 *   4. 用锄头修复被踩坏的耕地（dirt → farmland）
 *   5. 夜晚前往发呆点躲避幻翼（夜间转移优先级仅次于"停止"，打断一切工作状态；
 *      唯一例外是合计 ≤4 分钟的收割闭环，避免水阀开着过夜）
 *   6. tp 策略（规则 7）：目标 >200 格直传；寻路极端失败传回初始位置
 *   7. 命令只认私聊（whisper）："daoxiang stop" 停止 / "daoxiang start" 恢复，
 *      裸 "stop"/"start"（/msg daoxiang stop 的形式）同样受理；公屏一律不响应
 */
const mineflayer = require('mineflayer')
const { StateTransition, BotStateMachine, NestedStateMachine } = require('mineflayer-statemachine')

const { serverConfig, masterData, loadConfig, isInTerraces, isInPlantArea } = require('./config')
const { configureMovements, stopMovement } = require('../../utils/movement')
const { ClosableWebserver } = require('../../utils/closableWebserver')
const { buildDashboardStatus } = require('./dashboardStatus')
const { BehaviorWaitMaturity } = require('./behaviors/BehaviorWaitMaturity')
const { BehaviorCheckHunger } = require('./behaviors/BehaviorCheckHunger')
const { BehaviorEat } = require('./behaviors/BehaviorEat')
const { BehaviorGetSupplies } = require('./behaviors/BehaviorGetSupplies')
const { BehaviorOperateLever } = require('./behaviors/BehaviorOperateLever')
const { BehaviorWaitHarvest } = require('./behaviors/BehaviorWaitHarvest')
const { BehaviorGoTo } = require('./behaviors/BehaviorGoTo')
const { BehaviorPlantSeeds } = require('./behaviors/BehaviorPlantSeeds')
const { BehaviorNightIdle } = require('./behaviors/BehaviorNightIdle')

// ---- 日志：全部写入 logs/daoxiang-日期.log（按天滚动、保留 7 天、行首带系统时间戳）；
// ---- 控制台只回显重要信息（logImportant / [告警] / warn / error），详情看文件
const { initLogger, logImportant } = require('../../utils/logger')
initLogger({ name: 'daoxiang', retentionDays: 7 })
logImportant('[日志] 详情写入 logs/daoxiang-日期.log（按天滚动，保留 7 天），控制台仅显示重要信息')

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
// 工作时按 posLogIntervalMs（默认 10s）一条；
// 停机（stop 后）静默降频：最多每 30 分钟一条存活心跳（确认 stop 生效的那条会立即打出）
const IDLE_HEARTBEAT_MS = 30 * 60 * 1000

function startPositionLogger() {
    stopPositionLogger()
    const interval = masterData.posLogIntervalMs || 10000
    let lastIdleLogAt = 0
    posLogTimer = setInterval(() => {
        if (!bot || !bot.entity) return
        const p = bot.entity.position
        const lastSpeed = bot._posLogLast
            ? p.distanceTo(bot._posLogLast.pos) / Math.max(1, (Date.now() - bot._posLogLast.t) / 1000)
            : 0
        // 测速基准每拍都更新（即使静默），恢复工作后速度值不失真
        bot._posLogLast = { pos: p.clone(), t: Date.now() }

        const stopped = masterData.stopRequested || !masterData.isAutoFarming
        if (stopped) {
            if (Date.now() - lastIdleLogAt < IDLE_HEARTBEAT_MS) return
            lastIdleLogAt = Date.now()
        }
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
            logImportant('[强制进食][告警] 背包和附近容器中都没有面包，请补充面包库存')
            return
        }

        let lastErr = null
        // 与 BehaviorEat 对齐：吃到 20（面包 +5/个，从进食线 6 到满需 3 个；
        // 留 5 次余量覆盖个别的 consume 取消重试）
        for (let attempt = 0; attempt < 5 && bot.food < 20; attempt++) {
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
        if (bot.food < 20) {
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

// ---------------- 私聊命令 ----------------
// 【规则】只响应发给机器人的私聊：daoxiang stop / daoxiang start（也接受裸
// "stop"/"start"，即 /msg daoxiang stop 的形式）。公屏聊天不注册任何监听。
// 【注意】mineflayer 的 whisper 事件靠正则从渲染文本匹配，只内置两套英文格式；
// 这里补充中文/箭头变体（见 ./commands.js），并打诊断日志兜底。
function registerCommands() {
    const { parseWhisperCommand, EXTRA_WHISPER_PATTERNS } = require('./commands')

    // 补充私聊格式识别：不同服务端/Via 转译的私聊渲染不同，
    // 匹配后与默认格式一样触发 bot.on('whisper', 用户名, 消息)
    for (const p of EXTRA_WHISPER_PATTERNS) {
        try { bot.addChatPattern('whisper', p, { deprecated: true }) } catch (e) { /* ignore */ }
    }

    // 诊断：任何含命令关键词的聊天原文都打一行（含位置标记）。
    // 若私聊仍无响应：有这行日志却没有 [私聊] 行 → 渲染格式没被认出，
    // 把"原文"发回来即可补正则；连这行都没有 → 消息根本没到机器人。
    bot.on('messagestr', (msg, position) => {
        const m = String(msg).toLowerCase()
        if (m.includes('daoxiang') || m.includes('稻香') ||
            /(?:^|\s)(?:stop|start|status)(?:\s|$)/.test(m) || /停|开始|状态/.test(msg)) {
            console.log(`[私聊诊断] 位置=${position} 原文: ${msg}`)
        }
    })

    // 与默认英文正则重叠时会连续触发两次相同事件，3 秒内去重
    let lastWhisper = null
    bot.on('whisper', (username, message) => {
        if (String(username).trim().toLowerCase() === bot.username.toLowerCase()) return

        const key = `${username}|${message}`
        if (lastWhisper && lastWhisper.key === key && Date.now() - lastWhisper.at < 3000) return
        lastWhisper = { key, at: Date.now() }

        const cmd = parseWhisperCommand(String(message))
        if (cmd) logImportant(`[私聊] 收到来自 ${username}: ${message} → ${cmd}`)
        if (cmd === 'stop') {
            masterData.stopRequested = true
            masterData.isAutoFarming = false
            stopMovement(bot)
            bot.whisper(username, '收到，停止工作')
        } else if (cmd === 'start') {
            startFarming()
            bot.whisper(username, '收到，开始工作')
        } else if (cmd === 'status') {
            bot.whisper(username, `状态: ${masterData.detailStatus || '空闲'} | 食物 ${bot.food}/20 | 收割轮次 ${masterData.harvestRound}`)
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

    // [2] 夜晚发呆（规则 8）：幻翼会击杀夜间干活的机器人，所以夜间转移的优先级
    //     高于除"停止"之外的一切工作状态（状态机按数组顺序取首个命中的转移）。
    //     【唯一例外】收割闭环 activateLever → waitHarvest → deactivateLever 不打断：
    //     三步各有硬超时、合计 ≤4 分钟，中途弃管会让水阀开着过夜（弃管后播种前的
    //     规则 3 检查也能补救，但没必要冒险）；闭环一结束就从 getSupplies 立即转入夜间。
    const nightTargets = [
        waitMaturity, checkHunger, eat,
        getSupplies, gotoPlant, plantSeeds, gotoHome, idle
    ]
    const nightTransitions = nightTargets.map(state =>
        new StateTransition({
            parent: state,
            child: nightIdle,
            name: 'night',
            shouldTransition: () => BehaviorNightIdle.shouldIdle(bot, masterData)
        })
    )
    // 【必须】天亮后离开 nightIdle 的出口。少了这条转移，isFinished=true 后状态机无路可走，
    // 会永远停在 nightIdle 里反复调用 update（实测天亮瞬间刷几十行日志）。
    nightTransitions.push(
        new StateTransition({
            parent: nightIdle,
            child: waitMaturity,
            name: 'dawn',
            shouldTransition: () => nightIdle.isFinished
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
            shouldTransition: () => deactivateLever.isFinished && deactivateLever.succeeded,
            // 收割闭环到此结束：清除"待收割"标志。否则 gotoPlant/gotoHome 导航失败
            // 转回 checkHunger 时会带着过期标志误入 activateLever，把已关好的水阀再开一次
            onTransition: () => { masterData._needsHarvest = false }
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
            webserver = new ClosableWebserver(
                bot,
                stateMachine,
                masterData.webPort || 8936,
                () => buildDashboardStatus(bot, masterData)
            )
            webserver.startServer()
            logImportant(`[Web] 状态机可视化: http://localhost:${masterData.webPort || 8936}`)
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
        logImportant('[连接][告警] 达到最大重连次数，停止重连，进程退出')
        process.exit(1)
    }

    reconnectConfig.attempts++
    logImportant(`[连接] ${reconnectConfig.delay / 1000}s 后重连 (${reconnectConfig.attempts}/${reconnectConfig.maxAttempts})`)
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
        logImportant(`[连接] ${bot.username} 已连接到服务器 (协议 ${bot.protocolVersion} / 客户端 ${bot.version})`)
    })

    bot.on('death', () => {
        logImportant('[死亡] DaoXiang 死亡，等待自动重生')
        try { stopMovement(bot) } catch (e) { /* ignore */ }
    })

    bot.on('spawn', () => {
        const p = bot.entity.position
        console.log(`当前坐标: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`)

        // 连接已确认存活：重连计数归零。
        // 【修复】旧逻辑只增不减，跨多天累计断线 10 次后（哪怕每次都重连成功）
        // 会误判"达到最大重连次数"直接退出进程
        reconnectConfig.attempts = 0

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
                // 与 BehaviorCheckHunger 用同一比较方向（<），阈值完全一致
                const trigger = masterData.food.triggerPercent ?? 30
                if (bot.food < Math.ceil(20 * trigger / 100) && !masterData.isEating) {
                    console.log(`[警告] 食物值过低: ${bot.food}/20，强制进食`)
                    masterData.isEating = true
                    const myRun = ++masterData._eatRunId
                    forceEat(myRun)
                }
            })

            masterData.isAutoFarming = true
            masterData.stopRequested = false
            logImportant('[自动启动] DaoXiang 已上线，开始工作循环')
            bot.chat('稻香上线! 自动开始务农，私聊我 "daoxiang stop" 停止 / "daoxiang start" 恢复')
        } else {
            // 重生：状态机仍在运行，恢复寻路配置即可
            configureMovements(bot)
            logImportant('[重生] 已回到世界，继续工作')
        }

        startPositionLogger()
    })

    bot.on('kicked', (reason) => {
        logImportant(`[连接][告警] 被踢出服务器: ${reason}`)
        handleDisconnect()
    })
    bot.on('error', (err) => logImportant(`[连接][告警] 连接错误: ${err.message}`))
    bot.on('end', () => { logImportant('[连接] 连接断开'); handleDisconnect() })
}

async function shutdown(signal = 'SIGINT') {
    if (isShuttingDown) process.exit(1)
    isShuttingDown = true
    masterData.isShuttingDown = true
    logImportant(`收到 ${signal}，安全退出...`)
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
