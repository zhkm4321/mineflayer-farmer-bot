const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInWorkArea } = require('../config')

const SCAN_INTERVAL_MS = 4000

/**
 * 收割等待（闭环）：拉杆开启后轮询农田，直到成熟作物占比降到 harvestDoneRatio 以下、
 * 或场上作物清空、或到达 harvestWaitSeconds 上限才结束。
 *
 * 取代原先固定 harvestWaitSeconds 的开环死等：既不会收早了，也不会白等满 60 秒。
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
        this.lastScan = 0
        this.doneRatio = 0.05
    }

    onStateEntered() {
        const maxSec = this.masterData.harvestWaitSeconds || 60
        const minSec = this.masterData.harvestWaitMinSeconds ?? 8
        this.isFinished = false
        this.startTime = Date.now()
        this.lastScan = 0
        this.doneRatio = (this.masterData.harvestDoneRatio ?? 5) / 100
        this.masterData.detailStatus = '等待收割'
        console.log(`[收割等待] 闭环监测: 上限 ${maxSec}s / 最少 ${minSec}s，成熟占比降至 ${(this.doneRatio * 100).toFixed(0)}% 视为完成`)
    }

    _stats() {
        scanFarmingAreas(this.bot, this.masterData, isInWorkArea)
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
        console.log(`[收割等待] ${reason}`)
        this.masterData.harvestRound = (this.masterData.harvestRound || 0) + 1
        this.isFinished = true
    }

    update() {
        if (this.isFinished) return

        const now = Date.now()
        const elapsed = now - this.startTime
        const maxMs = (this.masterData.harvestWaitSeconds || 60) * 1000
        const minMs = (this.masterData.harvestWaitMinSeconds ?? 8) * 1000

        if (elapsed >= maxMs) {
            this._finish(`到达上限 ${Math.round(maxMs / 1000)}s，结束等待`)
            return
        }

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
