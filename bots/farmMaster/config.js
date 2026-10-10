const fs = require('fs')
const path = require('path')

const { LRUMap } = require('../../utils/lruMap')

const configPath = path.join(__dirname, 'farmmaster_config.json')

const PLANT_BLACKLIST_MAX_SIZE = 100
const PLANT_BLACKLIST_TTL_MS = 30 * 60 * 1000
const PLANT_BLACKLIST_SCAN_MS = 30 * 60 * 1000

const serverConfig = {}

const masterData = {
    pos1: null,
    pos2: null,
    waypoints: [],
    workArea: null,
    plantArea: null,
    seeds: [],

    // 收割等待：由 BehaviorWaitHarvest 闭环驱动，harvestWaitSeconds 仅作为上限
    harvestWaitSeconds: 60,
    harvestWaitMinSeconds: 8,
    harvestDoneRatio: 5,

    maturityThreshold: 95,
    coverageThreshold: 90,
    scanIntervalMs: 30000,
    plantMsPerPlot: 1200,
    plantMaxTimeMs: 1800000,

    farmingAreas: new Map(),
    validCropBlocks: ['wheat', 'carrots', 'potatoes', 'beetroots'],
    plantProtocolBlacklist: new LRUMap(PLANT_BLACKLIST_MAX_SIZE),

    isAutoFarming: false,
    stopRequested: false,
    detailStatus: '',
    isEating: false,
    isShuttingDown: false,
    cycleCount: 0,

    // 运行时协调状态（不持久化）
    sleepFailedUntil: 0,
    leverFailStreak: 0,
    lastLeverError: null,
    harvestRound: 0,
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
            if (Array.isArray(data.waypoints)) masterData.waypoints = data.waypoints
            if (data.workArea) masterData.workArea = data.workArea
            if (data.plantArea) masterData.plantArea = data.plantArea
            if (Array.isArray(data.seeds) && data.seeds.length > 0) masterData.seeds = data.seeds
            if (data.harvestWaitSeconds != null) masterData.harvestWaitSeconds = data.harvestWaitSeconds
            if (data.harvestWaitMinSeconds != null) masterData.harvestWaitMinSeconds = data.harvestWaitMinSeconds
            if (data.harvestDoneRatio != null) masterData.harvestDoneRatio = data.harvestDoneRatio
            if (data.maturityThreshold != null) masterData.maturityThreshold = data.maturityThreshold
            if (data.coverageThreshold != null) masterData.coverageThreshold = data.coverageThreshold
            if (data.scanIntervalMs != null) masterData.scanIntervalMs = data.scanIntervalMs
            if (data.plantMsPerPlot != null) masterData.plantMsPerPlot = data.plantMsPerPlot
            if (data.plantMaxTimeMs != null) masterData.plantMaxTimeMs = data.plantMaxTimeMs

            console.log(`[配置] 服务器: ${serverConfig.host}:${serverConfig.port} 账号: ${serverConfig.username}`)
            console.log(`[配置] pos1: (${masterData.pos1?.x},${masterData.pos1?.y},${masterData.pos1?.z})`)
            console.log(`[配置] pos2: (${masterData.pos2?.x},${masterData.pos2?.y},${masterData.pos2?.z})`)
            if (masterData.waypoints.length > 0) {
                console.log(`[配置] 路径点: ${masterData.waypoints.length} 个`)
            }
            if (masterData.workArea) {
                const wa = masterData.workArea
                console.log(`[配置] 工作区域: X(${wa.minX}~${wa.maxX}) Z(${wa.minZ}~${wa.maxZ})`)
            }
            if (masterData.plantArea) {
                const pa = masterData.plantArea
                const yRange = pa.minY != null && pa.maxY != null ? ` Y(${pa.minY}~${pa.maxY})` : ''
                console.log(`[配置] 播种区域: X(${pa.minX}~${pa.maxX})${yRange} Z(${pa.minZ}~${pa.maxZ})`)
            }
            console.log(`[配置] 种子: ${masterData.seeds.map(s => `${s.name}(${s.ratio})`).join(', ')}`)
            console.log(`[配置] 收割等待: 上限${masterData.harvestWaitSeconds}s / 最少${masterData.harvestWaitMinSeconds}s, 完成阈值: 成熟占比<=${masterData.harvestDoneRatio}%`)
            console.log(`[配置] 成熟阈值: ${masterData.maturityThreshold}%, 覆盖率阈值: ${masterData.coverageThreshold}%`)
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
            waypoints: masterData.waypoints,
            workArea: masterData.workArea,
            plantArea: masterData.plantArea,
            seeds: masterData.seeds,
            harvestWaitSeconds: masterData.harvestWaitSeconds,
            harvestWaitMinSeconds: masterData.harvestWaitMinSeconds,
            harvestDoneRatio: masterData.harvestDoneRatio,
            maturityThreshold: masterData.maturityThreshold,
            coverageThreshold: masterData.coverageThreshold,
            scanIntervalMs: masterData.scanIntervalMs,
            plantMsPerPlot: masterData.plantMsPerPlot,
            plantMaxTimeMs: masterData.plantMaxTimeMs
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

function isInPlantArea(pos) {
    if (!masterData.plantArea) return isInWorkArea(pos)
    const { minX, maxX, minY, maxY, minZ, maxZ } = masterData.plantArea
    const inXZ = pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ
    if (minY != null && maxY != null) {
        return inXZ && pos.y >= minY && pos.y <= maxY
    }
    return inXZ
}

// LRU 已有容量上限，这里按时间维度清理过期的种植协议黑名单
const plantBlacklistCleanupInterval = setInterval(() => {
    const removed = masterData.plantProtocolBlacklist.purgeOlderThan(PLANT_BLACKLIST_TTL_MS)
    if (removed > 0) {
        console.log(`[种植黑名单] 清理 ${removed} 个过期地块，剩余 ${masterData.plantProtocolBlacklist.size}`)
    }
}, PLANT_BLACKLIST_SCAN_MS)

function stopBackgroundTasks() {
    clearInterval(plantBlacklistCleanupInterval)
}

module.exports = {
    serverConfig,
    masterData,
    loadConfig,
    saveConfig,
    isInWorkArea,
    isInPlantArea,
    stopBackgroundTasks
}
