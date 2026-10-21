const { scanFarmingAreas } = require('../../../utils/farmScan')
const { logImportant } = require('../../../utils/logger')
const { isInTerraces } = require('../config')

const SCAN_INTERVAL_MS = 4000

/**
 * 收割等待（闭环）：拉杆开启后轮询农田。
 * 规则 2：开拉杆后至少等 10s 水流才能把庄稼冲进漏斗 —— 由 harvestWaitMinSeconds 保证（默认 10）。
 * 完成条件：场上无作物，或成熟占比降至 harvestDoneRatio 以下，或到达上限。
 */
class BehaviorWaitHarvest {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'waitHarvest'
        this.active = false
        this.x = 550
        this.y = 50
        this.isFinished = false
        this.startTime = 0
        this.enteredAt = 0
        this.lastScan = 0
        this.doneRatio = 0.05
    }

    onStateEntered() {
        const maxSec = this.masterData.harvestWaitSeconds || 60
        const minSec = this.masterData.harvestWaitMinSeconds || 10
        this.isFinished = false
        this.enteredAt = Date.now()
        this.startTime = Date.now()
        this.lastScan = 0
        this.doneRatio = (this.masterData.harvestDoneRatio ?? 5) / 100
        this.masterData.detailStatus = '等待收割'
        console.log(`[收割等待] 闭环监测: 上限 ${maxSec}s / 最少 ${minSec}s，成熟占比降至 ${(this.doneRatio * 100).toFixed(0)}% 视为完成`)
    }

    _stats() {
        // includeDirt：与 WaitMaturity/PlantSeeds 使用同一视野，统计口径一致
        scanFarmingAreas(this.bot, this.masterData, isInTerraces, { includeDirt: true })
        const areas = Array.from(this.masterData.farmingAreas.values())
        const withCrop = areas.filter(a => a.hasCrop)
        const mature = areas.filter(a => a.isMature)
        return {
            total: areas.length,
            withCrop: withCrop.length,
            mature: mature.length,
            ratio: withCrop.length > 0 ? mature.length / withCrop.length : 0
        }
    }

    _finish(reason) {
        this.masterData.harvestRound = (this.masterData.harvestRound || 0) + 1
        logImportant(`[收割] 第 ${this.masterData.harvestRound} 轮收割完成: ${reason}`)
        this.isFinished = true
    }

    update() {
        if (this.isFinished) return

        const now = Date.now()
        const elapsed = now - this.startTime
        const maxMs = (this.masterData.harvestWaitSeconds || 60) * 1000
        // 规则 2：至少等 flushMinSeconds（harvestWaitMinSeconds 默认 10s）
        const minMs = Math.max(this.masterData.harvestWaitMinSeconds ?? 10, 10) * 1000

        if (elapsed >= maxMs) {
            this._finish(`到达上限 ${Math.round(maxMs / 1000)}s，结束等待`)
            return
        }

        // 进入后 2s 内不扫描（等水流动起来，立即扫描结果没有意义）
        if (now - this.enteredAt < 2000) return
        if (now - this.lastScan < SCAN_INTERVAL_MS) return
        this.lastScan = now

        const s = this._stats()
        const remainSec = Math.ceil((maxMs - elapsed) / 1000)
        const maturePercent = Math.round(s.ratio * 100)
        console.log(`[收割等待] 剩余${remainSec}s | 作物 ${s.withCrop}/${s.total}，成熟 ${s.mature} (${maturePercent}%)`)
        this.masterData.detailStatus = `等待收割 ${remainSec}s 成熟${maturePercent}%`

        if (s.withCrop === 0) {
            this._finish('场上已无作物，收割完成')
            return
        }

        if (elapsed >= minMs && s.ratio <= this.doneRatio) {
            this._finish(`成熟占比 ${maturePercent}% 已降至阈值，收割完成`)
        }
    }

    onStateExited() {
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWaitHarvest }
