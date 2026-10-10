const { masterData, saveConfig } = require('./config')

const KNOWN_CMDS = new Set(['start', 'stop', 'status', 'setarea', 'setpos1', 'setpos2', 'help'])

function registerCommands(bot, startFarming, stopFarming) {
    function reply(username, message) {
        bot.chat(`@${username} ${message}`)
    }

    function handleCommand(username, message, wasPrefixed = false) {
        if (username === bot.username) return

        let msg = message.trim()
        const botName = bot.username.toLowerCase()
        const lowerMsg = msg.toLowerCase()
        if (lowerMsg.startsWith(botName + ' ')) {
            msg = msg.slice(botName.length + 1).trim()
            wasPrefixed = true
        } else if (lowerMsg.startsWith('bot ')) {
            msg = msg.slice(4).trim()
            wasPrefixed = true
        }

        if (!msg) {
            if (wasPrefixed) reply(username, '请输入命令，输入 help 查看帮助')
            return
        }

        const args = msg.split(/\s+/)
        const cmd = args[0].toLowerCase()

        if (!wasPrefixed && !KNOWN_CMDS.has(cmd)) return

        switch (cmd) {
            case 'start':
                masterData.stopRequested = false
                masterData.isAutoFarming = true
                startFarming()
                reply(username, '已启动自动农场循环')
                console.log(`[命令] ${username} 启动`)
                break

            case 'stop':
                masterData.stopRequested = true
                masterData.isAutoFarming = false
                bot.pathfinder.setGoal(null)
                stopFarming()
                reply(username, '已停止')
                console.log(`[命令] ${username} 停止`)
                break

            case 'status':
                handleStatus(bot, username, reply)
                break

            case 'setarea':
                handleSetArea(args, username, reply)
                break

            case 'setpos1':
                handleSetPos(args, username, reply, 'pos1')
                break

            case 'setpos2':
                handleSetPos(args, username, reply, 'pos2')
                break

            case 'help':
                reply(username, '命令: start, stop, status, setpos1 <x> <y> <z>, setpos2 <x> <y> <z>, setarea <x1> <z1> <x2> <z2>, help')
                break

            default:
                reply(username, `未知命令: ${cmd}`)
                break
        }
    }

    bot.on('chat', (username, message) => handleCommand(username, message, false))
    bot.on('whisper', (username, message) => handleCommand(username, message, true))
}

function handleStatus(bot, username, reply) {
    const d = masterData
    let msg = `状态: ${d.isAutoFarming ? '运行中' : '空闲'}`
    if (d.detailStatus) msg += ` (${d.detailStatus})`
    msg += ` | 收割轮次: ${d.harvestRound || 0}`
    msg += ` | 播种周期: ${d.cycleCount}`
    msg += ` | 食物: ${bot.food}/20`
    if (d.plantProtocolBlacklist?.size > 0) msg += ` | 协议黑名单: ${d.plantProtocolBlacklist.size}`
    if (d.leverFailStreak > 0) msg += ` | 拉杆连续失败: ${d.leverFailStreak}`

    if (d.pos1) msg += ` | pos1: (${d.pos1.x},${d.pos1.y},${d.pos1.z})`
    if (d.pos2) msg += ` | pos2: (${d.pos2.x},${d.pos2.y},${d.pos2.z})`

    if (d.workArea) {
        const wa = d.workArea
        msg += ` | 区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`
    }

    const seedInfo = d.seeds.map(s => {
        const count = bot.inventory.items()
            .filter(i => i.name === s.name)
            .reduce((sum, i) => sum + i.count, 0)
        return `${s.name}:${count}`
    }).join(' ')
    if (seedInfo) msg += ` | 种子: ${seedInfo}`

    reply(username, msg)
}

function handleSetArea(args, username, reply) {
    if (args[1] === 'clear') {
        masterData.workArea = null
        saveConfig()
        reply(username, '已清除工作区域')
        return
    }

    if (args.length < 5) {
        reply(username, '用法: setarea <x1> <z1> <x2> <z2>')
        return
    }

    const [, x1, z1, x2, z2] = args.map(Number)
    if ([x1, z1, x2, z2].some(isNaN)) {
        reply(username, '坐标必须是数字')
        return
    }

    masterData.workArea = {
        minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
        minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2)
    }
    saveConfig()
    const wa = masterData.workArea
    reply(username, `工作区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`)
}

function handleSetPos(args, username, reply, posKey) {
    if (args.length < 4) {
        reply(username, `用法: ${posKey} <x> <y> <z>`)
        return
    }

    const x = parseInt(args[1])
    const y = parseInt(args[2])
    const z = parseInt(args[3])
    if ([x, y, z].some(isNaN)) {
        reply(username, '坐标必须是数字')
        return
    }

    masterData[posKey] = { x, y, z }
    saveConfig()
    reply(username, `${posKey} 已设置: (${x},${y},${z})`)
    console.log(`[命令] ${posKey} = (${x},${y},${z})`)
}

module.exports = { registerCommands }
