const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInWorkArea } = require('../config')

// 连续 N 次扫描农田状态毫无变化时告警一次（用于发现水源/光照/拉杆异常）
const STALL_WARN_SCANS = 10

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
        this.startTime = 0
        this.lastScan = 0
        this.stallScans = 0
        this.prevSnapshot = null
    }

    onStateEntered() {
        this.isFinished = false
        this.needsHarvest = false
        this.startTime = Date.now()
        this.lastScan = 0
        this.stallScans = 0
        this.prevSnapshot = null
        this.masterData.detailStatus = '等待成熟'
        console.log(`[成熟度] 开始监测，成熟阈值 ${this.masterData.maturityThreshold}%，覆盖率阈值 ${this.masterData.coverageThreshold}%`)
    }

    _stats() {
        scanFarmingAreas(this.bot, this.masterData, isInWorkArea)
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

    /** 农田长时间无任何变化时给出一次告警，避免"静默永远等待" */
    _trackProgress(s) {
        const key = `${s.total}:${s.withCrop}:${s.mature}`
        if (key === this.prevSnapshot) {
            this.stallScans++
            if (this.stallScans >= STALL_WARN_SCANS) {
                console.log(`[成熟度][告警] 已连续 ${this.stallScans} 次扫描无进展 (耕地${s.total} 作物${s.withCrop} 成熟${s.mature})，请检查水源/光照/拉杆状态`)
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
        const interval = this.masterData.scanIntervalMs || 30000
        if (now - this.lastScan < interval) return
        this.lastScan = now

        const s = this._stats()
        this._trackProgress(s)

        if (s.total === 0) {
            console.log('[成熟度] 未检测到耕地')
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        const coverageThreshold = this.masterData.coverageThreshold || 90
        const threshold = this.masterData.maturityThreshold
        const coveragePercent = Math.round(s.withCrop / s.total * 100)
        const maturityPercent = s.withCrop > 0 ? Math.round(s.mature / s.withCrop * 100) : 0

        console.log(`[成熟度] 成熟 ${s.mature}/${s.withCrop} (${maturityPercent}%) 阈值${threshold}% | 覆盖率 ${s.withCrop}/${s.total} (${coveragePercent}%)`)
        this.masterData.detailStatus = `成熟 ${maturityPercent}%/${threshold}% 覆盖${coveragePercent}%`

        // 1) 成熟优先：成熟比例达标就收割。
        //    这里必须在覆盖率判断之前，否则大田块播种永远打不满覆盖率时，
        //    收割路径会被永久饿死（成熟作物一直烂在地里）。
        if (s.withCrop > 0 && maturityPercent >= threshold) {
            console.log('[成熟度] 达到成熟阈值，准备收割')
            this.masterData.cycleCount++
            this.needsHarvest = true
            this.isFinished = true
            return
        }

        // 2) 场上完全没作物：直接进入播种流程
        if (s.withCrop === 0) {
            console.log('[成熟度] 场上无作物，转入播种')
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        // 3) 覆盖率不足：优先补种（此时作物尚未成熟）
        if (coveragePercent < coverageThreshold) {
            console.log(`[覆盖率] ${s.withCrop}/${s.total} (${coveragePercent}%) 低于${coverageThreshold}%，空地${s.empty}，优先播种`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        // 4) 覆盖足够但尚未成熟：继续等待
    }

    onStateExited() {
        this.masterData._needsHarvest = this.needsHarvest
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWaitMaturity }
