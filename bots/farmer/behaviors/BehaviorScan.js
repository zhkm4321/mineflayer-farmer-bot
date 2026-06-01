const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInWorkArea } = require('../config')

class BehaviorScan {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'scanning'
        this.active = false
        this.x = 350
        this.y = 300
        this.isFinished = false
        this.hasMature = false
        this.hasEmpty = false
        this.hasPlantableEmpty = false
    }

    onStateEntered() {
        this.isFinished = false
        this.hasMature = false
        this.hasEmpty = false
        this.hasPlantableEmpty = false
        this.farmData.detailStatus = '扫描农田'
        this.runScan()
    }

    runScan() {
        const stats = scanFarmingAreas(this.bot, this.farmData, isInWorkArea)
        this.hasMature = stats.matureCount > 0
        this.hasEmpty = stats.emptyCount > 0
        this.hasPlantableEmpty = stats.plantableEmptyCount > 0

        const blacklisted = stats.emptyCount - stats.plantableEmptyCount
        const extra = blacklisted > 0 ? `，黑名单: ${blacklisted}` : ''
        console.log(`[扫描] 找到 ${stats.total} 块耕地，成熟: ${stats.matureCount}，空地: ${stats.emptyCount}(可种${stats.plantableEmptyCount})${extra}，障碍: ${stats.obstructedCount}`)
        this.isFinished = true
    }

    update() {}

    onStateExited() {
        this.farmData.detailStatus = ''
    }
}

module.exports = { BehaviorScan }
