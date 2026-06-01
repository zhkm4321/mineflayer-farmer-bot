const fs = require('fs')
const path = require('path')

const { LRUMap } = require('../../utils/lruMap')

const configPath = path.join(__dirname, 'farmer_config.json')

const PLANT_BLACKLIST_MAX_SIZE = 100
const PLANT_BLACKLIST_TTL_MS = 30 * 60 * 1000
const PLANT_BLACKLIST_SCAN_MS = 30 * 60 * 1000

const serverConfig = {}

const farmData = {
    farmingAreas: new Map(),
    currentCrop: null,
    workArea: null,
    isAutoFarming: false,
    stopRequested: false,
    detailStatus: '',
    cropTypes: {
        wheat: 'wheat_seeds',
        carrot: 'carrot',
        potato: 'potato',
        beetroot: 'beetroot_seeds'
    },
    cropHarvests: {
        wheat: 'wheat',
        carrot: 'carrot',
        potato: 'potato',
        beetroot: 'beetroot'
    },
    validCropBlocks: ['wheat', 'carrots', 'potatoes', 'beetroots'],
    unreachableBlacklist: new Set(),
    plantProtocolBlacklist: new LRUMap(PLANT_BLACKLIST_MAX_SIZE),
    isEating: false,
    isShuttingDown: false
}

function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            if (data.server) {
                Object.assign(serverConfig, data.server)
            }
            if (data.workArea) {
                farmData.workArea = data.workArea
                console.log(`[配置] 工作区域: X(${data.workArea.minX}~${data.workArea.maxX}) Z(${data.workArea.minZ}~${data.workArea.maxZ})`)
            }
            if (data.currentCrop) {
                farmData.currentCrop = data.currentCrop
                console.log(`[配置] 作物类型: ${data.currentCrop}`)
            }
            console.log(`[配置] 服务器: ${serverConfig.host}:${serverConfig.port} 账号: ${serverConfig.username}`)
        }
    } catch (e) {
        console.log('[配置] 加载失败:', e.message)
    }
}

function saveConfig() {
    try {
        const data = {
            server: serverConfig,
            workArea: farmData.workArea,
            currentCrop: farmData.currentCrop
        }
        fs.writeFileSync(configPath, JSON.stringify(data, null, 4))
        console.log('[配置] 已保存')
    } catch (e) {
        console.log('[配置] 保存失败:', e.message)
    }
}

function isInWorkArea(pos) {
    if (!farmData.workArea) return true
    const { minX, maxX, minZ, maxZ } = farmData.workArea
    return pos.x >= minX && pos.x <= maxX && pos.z >= minZ && pos.z <= maxZ
}

const blacklistCleanupInterval = setInterval(() => {
    if (farmData.unreachableBlacklist.size > 0) {
        console.log(`[黑名单] 清理 ${farmData.unreachableBlacklist.size} 个不可达位置`)
        farmData.unreachableBlacklist.clear()
    }
}, 5 * 60 * 1000)

const plantBlacklistCleanupInterval = setInterval(() => {
    const removed = farmData.plantProtocolBlacklist.purgeOlderThan(PLANT_BLACKLIST_TTL_MS)
    const remain = farmData.plantProtocolBlacklist.size
    if (removed > 0) {
        console.log(`[种植黑名单] 清理 ${removed} 个过期地块，剩余 ${remain} 个`)
    }
}, PLANT_BLACKLIST_SCAN_MS)

function stopBackgroundTasks() {
    clearInterval(blacklistCleanupInterval)
    clearInterval(plantBlacklistCleanupInterval)
}

module.exports = { serverConfig, farmData, loadConfig, saveConfig, isInWorkArea, stopBackgroundTasks }
