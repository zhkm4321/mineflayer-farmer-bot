const { openChestContainer } = require('../../../utils/container')

class BehaviorEat {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'eating'
        this.active = false
        this.x = 350
        this.y = 200
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.farmData.detailStatus = '进食中'
        this.runEat()
    }

    async runEat() {
        try {
            if (this.bot.food >= 20) {
                this.isFinished = true
                return
            }

            let bread = this.bot.inventory.items().find(i => i.name === 'bread')

            if (!bread) {
                this.farmData.detailStatus = '从箱子取面包'
                await this.fetchBreadFromChest()
                bread = this.bot.inventory.items().find(i => i.name === 'bread')
            }

            if (!bread) {
                console.log('[进食] 没有面包可吃')
                this.isFinished = true
                return
            }

            while (this.bot.food < 20 && this.active) {
                bread = this.bot.inventory.items().find(i => i.name === 'bread')
                if (!bread) break

                await this.bot.equip(bread, 'hand')
                await this.bot.consume()
            }

            console.log(`[进食] 完成，食物值: ${this.bot.food}/20`)
        } catch (e) {
            console.log(`[进食] 失败: ${e.message}`)
        }
        this.isFinished = true
    }

    async fetchBreadFromChest() {
        const chests = this.bot.findBlocks({
            matching: block => block.name === 'chest' || block.name === 'trapped_chest',
            maxDistance: 32,
            count: 10
        })

        if (chests.length === 0) return

        const sorted = chests.sort((a, b) =>
            this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
        )

        for (const chestPos of sorted) {
            if (!this.active) return
            const chestBlock = this.bot.blockAt(chestPos)
            if (!chestBlock) continue

            try {
                const chest = await openChestContainer(this.bot, chestBlock, { timeoutMs: 12000 })
                const breadSlot = chest.slots.find(s => s && s.name === 'bread')
                if (breadSlot) {
                    await chest.withdraw(breadSlot.type, null, Math.min(breadSlot.count, 32))
                    console.log('[进食] 从箱子取到面包')
                    chest.close()
                    return
                }
                chest.close()
            } catch (e) {
                // skip this chest
            }
        }
    }

    update() {
        if (Date.now() - this.startTime > 30000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        this.farmData.detailStatus = ''
        this.farmData.isEating = false
    }
}

module.exports = { BehaviorEat }
