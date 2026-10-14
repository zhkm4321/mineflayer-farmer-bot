const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInTerraces } = require('../config')

// 最小驻留：本状态是流程枢纽（所有环路都经过它），瞬间完成会导致环路零间隔自转
const MIN_DWELL_MS = 3000
// 连续 N 次扫描无变化时告警
const STALL_WARN_SCANS = 10

/**
 * 成熟度监测：
 *   - 成熟占比 >= maturityThreshold → 需要收割（规则 2：水流收割）
 *   - 覆盖率 < coverageThreshold 或场上无作物 → 需要播种
 *   - 否则继续等
 */
class BehaviorWaitMaturity {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'waitMaturity'
        this.active = false
        this.x = 600
        this.y = 350
        this.isFinished = false
        this.needsHarvest = false
        this.enteredAt = 0
        this.startTime = 0
        this.lastScan = 0
        this.stallScans = 0
        this.prevSnapshot = null
    }

    onStateEntered() {
        this.isFinished = false
        this.needsHarvest = false
        this.enteredAt = Date.now()
        this.startTime = Date.now()
        this.lastScan = 0
        this.stallScans = 0
        this.prevSnapshot = null
        this.masterData.detailStatus = '监测成熟度'
        console.log(`[成熟度] 开始监测，成熟阈值 ${this.masterData.maturityThreshold}%，覆盖率阈值 ${this.masterData.coverageThreshold}%`)
    }

    _stats() {
        // includeDirt：被踩成 dirt 的耕地也计入统计（否则 total 静默缩水、覆盖率虚高）
        scanFarmingAreas(this.bot, this.masterData, isInTerraces, { includeDirt: true })
        const areas = Array.from(this.masterData.farmingAreas.values())
        const withCrop = areas.filter(a => a.hasCrop)
        const mature = areas.filter(a => a.isMature)
        return {
            total: areas.length,
            withCrop: withCrop.length,
            empty: areas.filter(a => a.isEmpty).length,
            mature: mature.length
        }
    }

    _trackProgress(s) {
        const key = `${s.total}:${s.withCrop}:${s.mature}`
        if (key === this.prevSnapshot) {
            this.stallScans++
            if (this.stallScans >= STALL_WARN_SCANS) {
                console.log(`[成熟度][告警] 已连续 ${this.stallScans} 次扫描无进展 (耕地${s.total} 作物${s.withCrop} 成熟${s.mature})，请检查水源/拉杆状态`)
                this.stallScans = 0
            }
        } else {
            this.stallScans = 0
            this.prevSnapshot = key
        }
    }

    update() {
        if (this.isFinished) return

        const now = Date.now()
        // 驻留闸门：防环路零间隔自转
        if (now - this.enteredAt < MIN_DWELL_MS) return

        const interval = this.masterData.scanIntervalMs || 30000
        if (now - this.lastScan < interval) return
        this.lastScan = now

        const s = this._stats()
        this._trackProgress(s)

        if (s.total === 0) {
            console.log('[成熟度] 未检测到耕地（请检查梯田配置/机器人站位）')
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        const threshold = this.masterData.maturityThreshold
        const coverageThreshold = this.masterData.coverageThreshold || 90
        const coveragePercent = Math.round(s.withCrop / s.total * 100)
        const maturityPercent = s.withCrop > 0 ? Math.round(s.mature / s.withCrop * 100) : 0

        console.log(`[成熟度] 成熟 ${s.mature}/${s.withCrop} (${maturityPercent}%) 阈值${threshold}% | 覆盖率 ${s.withCrop}/${s.total} (${coveragePercent}%)`)
        this.masterData.detailStatus = `成熟 ${maturityPercent}%/${threshold}% 覆盖${coveragePercent}%`

        // 1) 成熟优先：收割
        if (s.withCrop > 0 && maturityPercent >= threshold) {
            console.log('[成熟度] 达到成熟阈值，准备收割')
            this.masterData.cycleCount++
            this.needsHarvest = true
            this.isFinished = true
            return
        }

        // 2) 场上无作物：播种
        if (s.withCrop === 0) {
            console.log('[成熟度] 场上无作物，转入播种')
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        // 3) 覆盖率不足：补种
        if (coveragePercent < coverageThreshold) {
            console.log(`[覆盖率] ${s.withCrop}/${s.total} (${coveragePercent}%) 低于${coverageThreshold}%，优先补种`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        // 4) 覆盖足够尚未成熟：继续等
    }

    onStateExited() {
        this.masterData._needsHarvest = this.needsHarvest
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWaitMaturity }
