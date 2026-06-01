const { farmData, saveConfig } = require('./config')

const KNOWN_CMDS = new Set(['farm', 'stop', 'status', 'setarea', 'help'])

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
            case 'farm':
                handleFarm(bot, args, username, startFarming, reply)
                break
            case 'stop':
                handleStop(bot, username, stopFarming, reply)
                break
            case 'status':
                handleStatus(bot, username, reply)
                break
            case 'setarea':
                handleSetArea(bot, args, username, reply)
                break
            case 'help':
                reply(username, '命令: farm [wheat|carrot|potato|beetroot], stop, status, setarea <x1> <z1> <x2> <z2>, help')
                break
            default:
                reply(username, `未知命令: ${cmd}，输入 help 查看帮助`)
                break
        }
    }

    bot.on('chat', (username, message) => handleCommand(username, message, false))
    bot.on('whisper', (username, message) => handleCommand(username, message, true))
}

function handleFarm(bot, args, username, startFarming, reply) {
    const cropType = args[1] || 'wheat'
    const validCrops = ['wheat', 'carrot', 'potato', 'beetroot']

    if (!validCrops.includes(cropType)) {
        reply(username, `无效作物: ${cropType}，可选: ${validCrops.join(', ')}`)
        return
    }

    farmData.currentCrop = cropType
    farmData.stopRequested = false
    farmData.isAutoFarming = true
    saveConfig()

    reply(username, `已开始自动农场: ${cropType}`)
    console.log(`[命令] ${username} 启动农场模式: ${cropType}`)
    startFarming()
}

function handleStop(bot, username, stopFarming, reply) {
    farmData.stopRequested = true
    farmData.isAutoFarming = false
    bot.pathfinder.setGoal(null)
    stopFarming()
    reply(username, '已停止所有任务')
    console.log(`[命令] ${username} 停止了机器人`)
}

function handleStatus(bot, username, reply) {
    const areas = Array.from(farmData.farmingAreas.values())
    const matureCount = areas.filter(a => a.isMature).length
    const emptyCount = areas.filter(a => a.isEmpty).length
    const totalCount = areas.length

    const items = bot.inventory.items()
    const seeds = items.filter(i => i.name.includes('seed')).reduce((s, i) => s + i.count, 0)
    const wheat = items.filter(i => i.name === 'wheat').reduce((s, i) => s + i.count, 0)
    const bread = items.filter(i => i.name === 'bread').reduce((s, i) => s + i.count, 0)

    let msg = `状态: ${farmData.isAutoFarming ? '工作中' : '空闲'}`
    if (farmData.detailStatus) msg += ` (${farmData.detailStatus})`
    msg += ` | 作物: ${farmData.currentCrop || '未设置'}`
    msg += ` | 食物: ${bot.food}/20`
    msg += ` | 农田: ${totalCount} (成熟:${matureCount} 空地:${emptyCount})`
    msg += ` | 背包: 种子${seeds} 小麦${wheat} 面包${bread}`

    if (farmData.workArea) {
        const wa = farmData.workArea
        msg += ` | 区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`
    }

    reply(username, msg)
}

function handleSetArea(bot, args, username, reply) {
    if (args[1] === 'clear') {
        farmData.workArea = null
        saveConfig()
        reply(username, '已清除工作区域限制')
        return
    }

    if (args.length < 5) {
        reply(username, '用法: setarea <x1> <z1> <x2> <z2> 或 setarea clear')
        return
    }

    const x1 = parseInt(args[1])
    const z1 = parseInt(args[2])
    const x2 = parseInt(args[3])
    const z2 = parseInt(args[4])

    if ([x1, z1, x2, z2].some(isNaN)) {
        reply(username, '坐标必须是数字')
        return
    }

    farmData.workArea = {
        minX: Math.min(x1, x2),
        maxX: Math.max(x1, x2),
        minZ: Math.min(z1, z2),
        maxZ: Math.max(z1, z2)
    }
    saveConfig()

    const wa = farmData.workArea
    reply(username, `工作区域已设置: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`)
    console.log(`[命令] 设置工作区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`)
}

module.exports = { registerCommands }
