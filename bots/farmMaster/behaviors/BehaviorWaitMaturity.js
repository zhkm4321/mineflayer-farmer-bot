const { scanFarmingAreas, isCropMature } = require('../../../utils/farmScan')
const { isInWorkArea } = require('../config')

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
    }

    onStateEntered() {
        this.isFinished = false
        this.needsHarvest = false
        this.startTime = Date.now()
        this.lastScan = 0
        this.masterData.detailStatus = '等待成熟'
        console.log(`[成熟度] 开始监测，阈值 ${this.masterData.maturityThreshold}%`)
    }

    update() {
        const now = Date.now()
        if (now - this.lastScan < 30000) return
        this.lastScan = now

        const stats = scanFarmingAreas(this.bot, this.masterData, isInWorkArea)
        const areas = Array.from(this.masterData.farmingAreas.values())
        const totalFarmland = areas.length
        const withCrop = areas.filter(a => a.hasCrop)
        const emptyCount = areas.filter(a => a.isEmpty).length
        const mature = areas.filter(a => a.isMature)

        if (totalFarmland === 0) {
            console.log(`[成熟度] 未检测到耕地`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        const coveragePercent = Math.round(withCrop.length / totalFarmland * 100)
        const coverageThreshold = this.masterData.coverageThreshold || 90

        if (coveragePercent < coverageThreshold) {
            console.log(`[覆盖率] ${withCrop.length}/${totalFarmland} (${coveragePercent}%) 低于${coverageThreshold}%，空地${emptyCount}，优先播种`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        if (withCrop.length === 0) {
            console.log(`[成熟度] 无作物，跳过收割直接播种`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        const maturityPercent = Math.round(mature.length / withCrop.length * 100)
        const threshold = this.masterData.maturityThreshold

        console.log(`[成熟度] ${mature.length}/${withCrop.length} (${maturityPercent}%) 阈值${threshold}% | 覆盖率 ${coveragePercent}%`)
        this.masterData.detailStatus = `成熟 ${maturityPercent}%/${threshold}% 覆盖${coveragePercent}%`

        if (maturityPercent >= threshold) {
            console.log(`[成熟度] 达到阈值，准备收割`)
            this.masterData.cycleCount++
            this.needsHarvest = true
            this.isFinished = true
        }
    }

    onStateExited() {
        this.masterData._needsHarvest = this.needsHarvest
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWaitMaturity }
