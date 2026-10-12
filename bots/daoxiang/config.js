const fs = require('fs')
const path = require('path')
const { LRUMap } = require('../../utils/lruMap')

const configPath = path.join(__dirname, 'daoxiang_config.json')

// 默认值：配置文件缺项时兜底，保证机器人永远可启动
const defaults = {
    server: { host: 'localhost', port: 22224, username: 'DaoXiang', version: '26.1', auth: 'offline' },
    lever: { x: 1027, y: 70, z: 570 },
    barrels: { x: 1028, y: 70, zMin: 571, zMax: 577 },
    nightSpot: { x: 1033, y: 61, z: 598 },
    terraces: [],
    unplantable: [],
    seeds: [
        { name: 'potato', ratio: 1 },
        { name: 'carrot', ratio: 1 },
        { name: 'wheat_seeds', ratio: 5 },
        { name: 'beetroot_seeds', ratio: 1 }
    ],
    tools: { hoeItem: 'stone_hoe', minHoes: 2 },
    food: { breadItem: 'bread', triggerPercent: 30 },
    containerSearch: { radius: 24 },
    harvest: { maturityThreshold: 95, waitMaxSeconds: 60, waitMinSeconds: 10, doneRatio: 5 },
    plant: { coverageThreshold: 90, msPerPlot: 1200, maxTimeMs: 1800000 },
    scan: { intervalMs: 30000 },
    tp: { enabled: true, farDistance: 200 },
    webPort: 8936,
    posLogIntervalMs: 10000
}

const serverConfig = {}

const masterData = {
    // —— 流程锚点 ——
    lever: null,
    barrels: null,
    nightSpot: null,
    terraces: [],
    unplantable: new Set(),   // "x,y,z" 键集合（rule 4：半砖下水坑地块不可种植）
    homePos: null,            // 初始位置：spawn 时记录，极端寻路失败时 tp 回这里（rule 7）
    validCropBlocks: ['wheat', 'carrots', 'potatoes', 'beetroots'],

    // —— 物资 ——
    seeds: [],
    tools: {},                // 工具（锄头种类/数量下限）
    food: {},                 // 食物（面包/进食线）
    containerSearchRadius: 24, // 容器搜索半径（取面包/取锄头共用）

    // —— 开关与阈值 ——
    tp: {},
    harvestWaitSeconds: 60,
    harvestWaitMinSeconds: 10,
    harvestDoneRatio: 5,
    maturityThreshold: 95,
    coverageThreshold: 90,
    scanIntervalMs: 30000,
    plantMsPerPlot: 1200,
    plantMaxTimeMs: 1800000,
    webPort: 8936,
    posLogIntervalMs: 10000,

    // —— 运行时状态 ——
    farmingAreas: new Map(),
    plantProtocolBlacklist: new LRUMap(100),
    isAutoFarming: false,
    stopRequested: false,
    detailStatus: '',
    isEating: false,
    isShuttingDown: false,
    cycleCount: 0,
    supplyRetryAt: 0,        // 物资不足冷却（防 getSupplies↔waitMaturity 零间隔死循环）
    leverFailStreak: 0,
    lastLeverError: null,
    harvestRound: 0,
    _needsHarvest: false,
    _needsPlant: false,
    _eatRunId: 0
}

function loadConfig() {
    let cfg = {}
    try {
        if (fs.existsSync(configPath)) cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch (e) {
        console.log('[配置] 加载失败:', e.message)
    }

    const merged = { ...defaults, ...cfg }
    // 浅合并嵌套对象（配置缺项时用默认值兜底）
    for (const key of ['lever', 'barrels', 'nightSpot', 'tools', 'food', 'containerSearch',
        'harvest', 'plant', 'scan', 'tp', 'server']) {
        merged[key] = { ...defaults[key], ...(cfg[key] || {}) }
    }

    serverConfig.host = merged.server.host
    serverConfig.port = merged.server.port
    serverConfig.username = merged.server.username
    // 其余连接参数原样带给 mineflayer
    for (const [k, v] of Object.entries(merged.server)) {
        if (!['host', 'port', 'username'].includes(k)) serverConfig[k] = v
    }

    masterData.lever = merged.lever
    masterData.barrels = merged.barrels
    masterData.nightSpot = merged.nightSpot
    masterData.terraces = Array.isArray(merged.terraces) ? merged.terraces : []
    masterData.waypoints = Array.isArray(cfg.waypoints) ? cfg.waypoints : []
    // 播种区入口：未配置时取第一层梯田中心（到达后即可扫描全场）
    masterData.plantEntry = cfg.plantEntry || (() => {
        const t = masterData.terraces[0]
        if (!t) return null
        return { x: Math.floor((t.minX + t.maxX) / 2), y: t.y ?? 69, z: Math.floor((t.minZ + t.maxZ) / 2) }
    })()
    masterData.unplantable = new Set(
        (Array.isArray(merged.unplantable) ? merged.unplantable : []).map(p => `${p.x},${p.y},${p.z}`)
    )
    if (cfg.homePos) masterData.homePos = cfg.homePos
    masterData.seeds = merged.seeds
    masterData.tools = merged.tools             // 锄头（工具归工具，不混进 food）
    masterData.food = merged.food               // 只放食物相关（面包/进食线）
    masterData.containerSearchRadius = merged.containerSearch.radius  // 容器搜索通用参数
    masterData.tp = merged.tp
    // harvest 段：成熟阈值 + 收割等待
    masterData.maturityThreshold = merged.harvest.maturityThreshold
    masterData.harvestWaitSeconds = merged.harvest.waitMaxSeconds
    // 规则 2：收割闭环最短等待硬性下限 10s，配置写小了也拦住
    masterData.harvestWaitMinSeconds = Math.max(10, merged.harvest.waitMinSeconds ?? 10)
    masterData.harvestDoneRatio = merged.harvest.doneRatio
    // plant 段：覆盖率阈值 + 播种节奏
    masterData.coverageThreshold = merged.plant.coverageThreshold
    masterData.plantMsPerPlot = merged.plant.msPerPlot
    masterData.plantMaxTimeMs = merged.plant.maxTimeMs
    masterData.scanIntervalMs = merged.scan.intervalMs
    masterData.webPort = merged.webPort
    masterData.posLogIntervalMs = merged.posLogIntervalMs

    console.log(`[配置] 服务器: ${serverConfig.host}:${serverConfig.port} 账号: ${serverConfig.username}`)
    console.log(`[配置] 梯田: ${masterData.terraces.length} 层 ` +
        masterData.terraces.map(t => `Y${t.y}(X${t.minX}~${t.maxX},Z${t.minZ}~${t.maxZ})`).join(' / '))
    console.log(`[配置] 拉杆: (${masterData.lever.x},${masterData.lever.y},${masterData.lever.z}) ` +
        `木桶行: X=${masterData.barrels.x} Z${masterData.barrels.zMin}~${masterData.barrels.zMax} ` +
        `(y=${masterData.barrels.y} 仅作提示，实际高度自动探测)`)
    if (masterData.waypoints.length > 0) {
        console.log(`[配置] 路径点: ${masterData.waypoints.length} 个`)
    }
    if (masterData.plantEntry) {
        console.log(`[配置] 播种区入口: (${masterData.plantEntry.x},${masterData.plantEntry.y},${masterData.plantEntry.z})`)
    }
    console.log(`[配置] 不可种植地块: ${masterData.unplantable.size} 个`)
    console.log(`[配置] 种子比例: ${masterData.seeds.map(s => `${s.name}:${s.ratio}`).join(' / ')}`)
    console.log(`[配置] 工具: ${masterData.tools.hoeItem} x${masterData.tools.minHoes}, ` +
        `食物: ${masterData.food.breadItem} (进食线 ${masterData.food.triggerPercent}%), ` +
        `容器搜索半径: ${masterData.containerSearchRadius}`)
    console.log(`[配置] 收割等待: 上限${masterData.harvestWaitSeconds}s / 最少${masterData.harvestWaitMinSeconds}s (规则≥10s), ` +
        `完成阈值: 成熟占比<=${masterData.harvestDoneRatio}%`)
    console.log(`[配置] 成熟阈值: ${masterData.maturityThreshold}%, 覆盖率阈值: ${masterData.coverageThreshold}%`)
    console.log(`[配置] 夜晚发呆点: (${masterData.nightSpot.x},${masterData.nightSpot.y},${masterData.nightSpot.z})`)
}

function saveConfig() {
    try {
        const data = {
            server: serverConfig,
            lever: masterData.lever,
            barrels: masterData.barrels,
            nightSpot: masterData.nightSpot,
            terraces: masterData.terraces,
            unplantable: [...masterData.unplantable].map(k => {
                const [x, y, z] = k.split(',').map(Number)
                return { x, y, z }
            }),
            homePos: masterData.homePos,
            seeds: masterData.seeds,
            tools: masterData.tools,
            food: masterData.food,
            containerSearch: { radius: masterData.containerSearchRadius },
            tp: masterData.tp,
            harvest: {
                maturityThreshold: masterData.maturityThreshold,
                waitMaxSeconds: masterData.harvestWaitSeconds,
                waitMinSeconds: masterData.harvestWaitMinSeconds,
                doneRatio: masterData.harvestDoneRatio
            },
            plant: {
                coverageThreshold: masterData.coverageThreshold,
                msPerPlot: masterData.plantMsPerPlot,
                maxTimeMs: masterData.plantMaxTimeMs
            },
            scan: { intervalMs: masterData.scanIntervalMs },
            webPort: masterData.webPort,
            posLogIntervalMs: masterData.posLogIntervalMs
        }
        fs.writeFileSync(configPath, JSON.stringify(data, null, 4))
    } catch (e) {
        console.log('[配置] 保存失败:', e.message)
    }
}

/** 是否属于任何一层梯田。
 * 【y 容错】导航层调用时只传 {x,z}（GoalNearXZ 不含高度），此时跳过层校验、
 * 只做 XZ 外包络判断；扫描层传完整 Vec3 时才校验 y。
 * （实测教训：moveToStandOnSoil 只传 {x,z}，严格的 y 校验让每块地都在门口被拒） */
function isInTerraces(pos) {
    if (!masterData.terraces.length) return true
    return masterData.terraces.some(t =>
        pos.x >= t.minX && pos.x <= t.maxX &&
        pos.z >= t.minZ && pos.z <= t.maxZ &&
        (t.y == null || pos.y == null || pos.y === t.y)
    )
}

/** 是否属于播种区（梯田的 XZ 外包络，供导航/守卫用） */
function isInPlantArea(pos) {
    if (!masterData.terraces.length) return true
    return masterData.terraces.some(t =>
        pos.x >= t.minX && pos.x <= t.maxX && pos.z >= t.minZ && pos.z <= t.maxZ
    )
}

/** 该地块是否被规则 4 禁止种植 */
function isUnplantable(pos) {
    return masterData.unplantable.has(`${pos.x},${pos.y},${pos.z}`)
}

module.exports = {
    serverConfig,
    masterData,
    loadConfig,
    saveConfig,
    isInTerraces,
    isInPlantArea,
    isUnplantable
}
