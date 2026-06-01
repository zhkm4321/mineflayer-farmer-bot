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
        if (now - this.lastScan < 10000) return
        this.lastScan = now

        const stats = scanFarmingAreas(this.bot, this.masterData, isInWorkArea)
        const areas = Array.from(this.masterData.farmingAreas.values())
        const withCrop = areas.filter(a => a.hasCrop)
        const mature = areas.filter(a => a.isMature)
        const total = withCrop.length

        if (total === 0) {
            console.log(`[成熟度] 无作物，跳过收割直接播种`)
            this.needsHarvest = false
            this.isFinished = true
            return
        }

        const percent = Math.round(mature.length / total * 100)
        const threshold = this.masterData.maturityThreshold

        console.log(`[成熟度] ${mature.length}/${total} (${percent}%) 阈值${threshold}%`)
        this.masterData.detailStatus = `成熟 ${percent}%/${threshold}%`

        if (percent >= threshold) {
            console.log(`[成熟度] 达到阈值，准备收割`)
            this.masterData.cycleCount++
            this.needsHarvest = true
            this.isFinished = true
        }
    }

    onStateExited() {
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWaitMaturity }
