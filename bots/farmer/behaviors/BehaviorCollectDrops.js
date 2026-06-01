const { gotoNear, stopMovement } = require('../../../utils/movement')
const { isInWorkArea } = require('../config')

class BehaviorCollectDrops {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'collectDrops'
        this.active = false
        this.x = 650
        this.y = 200
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.farmData.detailStatus = '捡取掉落物'
        this.runCollect()
    }

    async runCollect() {
        const MAX_TIME = 30000
        let collected = 0
        const { cropTypes, cropHarvests, currentCrop, unreachableBlacklist } = this.farmData

        const seedName = currentCrop ? cropTypes[currentCrop] : null
        const harvestName = currentCrop ? cropHarvests[currentCrop] : null

        const relevantNames = new Set()
        if (seedName) relevantNames.add(seedName)
        if (harvestName) relevantNames.add(harvestName)

        const items = Object.values(this.bot.entities)
            .filter(e => {
                if (e.name !== 'item') return false
                const itemName = e.metadata?.[8]?.itemId
                    ? this.bot.registry?.items?.[e.metadata[8].itemId]?.name
                    : null
                if (!itemName) return true
                return relevantNames.has(itemName)
            })
            .filter(e => {
                const key = `${Math.floor(e.position.x)},${Math.floor(e.position.z)}`
                return !unreachableBlacklist.has(key)
            })
            .filter(e => this.bot.entity.position.distanceTo(e.position) <= 32)
            .filter(e => isInWorkArea(e.position))
            .sort((a, b) =>
                this.bot.entity.position.distanceTo(a.position) -
                this.bot.entity.position.distanceTo(b.position)
            )
            .slice(0, 15)

        for (const item of items) {
            if (!this.active || this.farmData.stopRequested) break
            if (Date.now() - this.startTime > MAX_TIME) break

            try {
                await gotoNear(this.bot, item.position, 1, 8000, { workAreaChecker: isInWorkArea })
                collected++
                await new Promise(r => setTimeout(r, 100))
            } catch (e) {
                const key = `${Math.floor(item.position.x)},${Math.floor(item.position.z)}`
                unreachableBlacklist.add(key)
                console.log(`[捡取] 无法到达 ${key}，已加入黑名单`)
            }
        }

        if (collected > 0) {
            console.log(`[捡取] 收集了 ${collected} 个掉落物品`)
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 35000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.farmData.detailStatus = ''
    }
}

module.exports = { BehaviorCollectDrops }
