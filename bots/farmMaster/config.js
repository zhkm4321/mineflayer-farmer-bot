const fs = require('fs')
const path = require('path')

const { LRUMap } = require('../../utils/lruMap')

const configPath = path.join(__dirname, 'farmmaster_config.json')

const PLANT_BLACKLIST_MAX_SIZE = 100

const serverConfig = {}

const masterData = {
    pos1: null,
    pos2: null,
    workArea: null,
    seeds: [],
    harvestWaitSeconds: 60,
    maturityThreshold: 95,

    farmingAreas: new Map(),
    validCropBlocks: ['wheat', 'carrots', 'potatoes', 'beetroots'],
    plantProtocolBlacklist: new LRUMap(PLANT_BLACKLIST_MAX_SIZE),

    isAutoFarming: false,
    stopRequested: false,
    detailStatus: '',
    isEating: false,
    isShuttingDown: false,
    cycleCount: 0,
}

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            if (data.server) {
                Object.assign(serverConfig, data.server)
            }
            if (data.pos1) masterData.pos1 = data.pos1
            if (data.pos2) masterData.pos2 = data.pos2
            if (data.workArea) masterData.workArea = data.workArea
            if (Array.isArray(data.seeds) && data.seeds.length > 0) masterData.seeds = data.seeds
            if (data.harvestWaitSeconds != null) masterData.harvestWaitSeconds = data.harvestWaitSeconds
            if (data.maturityThreshold != null) masterData.maturityThreshold = data.maturityThreshold

            console.log(`[配置] 服务器: ${serverConfig.host}:${serverConfig.port} 账号: ${serverConfig.username}`)
            console.log(`[配置] pos1: (${masterData.pos1?.x},${masterData.pos1?.y},${masterData.pos1?.z})`)
            console.log(`[配置] pos2: (${masterData.pos2?.x},${masterData.pos2?.y},${masterData.pos2?.z})`)
            if (masterData.workArea) {
                const wa = masterData.workArea
                console.log(`[配置] 工作区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`)
            }
            console.log(`[配置] 种子: ${masterData.seeds.map(s => `${s.name}(${s.ratio})`).join(', ')}`)
            console.log(`[配置] 收割等待: ${masterData.harvestWaitSeconds}s, 成熟阈值: ${masterData.maturityThreshold}%`)
        } else {
            console.log('[配置] 未找到配置文件，使用默认值')
        }
    } catch (e) {
        console.log('[配置] 加载失败:', e.message)
    }
}

function saveConfig() {
    try {
        const data = {
            server: serverConfig,
            pos1: masterData.pos1,
            pos2: masterData.pos2,
            workArea: masterData.workArea,
            seeds: masterData.seeds,
            harvestWaitSeconds: masterData.harvestWaitSeconds,
            maturityThreshold: masterData.maturityThreshold
        }
        fs.writeFileSync(configPath, JSON.stringify(data, null, 4))
        console.log('[配置] 已保存')
    } catch (e) {
        console.log('[配置] 保存失败:', e.message)
    }
}

function isInWorkArea(pos) {
    if (!masterData.workArea) return true
    const { minX, maxX, minZ, maxZ } = masterData.workArea
    return pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ
}

module.exports = { serverConfig, masterData, loadConfig, saveConfig, isInWorkArea }
