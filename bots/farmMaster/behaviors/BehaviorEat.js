const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { openChestContainer } = require('../../../utils/container')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

class BehaviorEat {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'eating'
        this.active = false
        this.x = 200
        this.y = 50
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '进食中'
        this.runEat()
    }

    async _gotoPoint(point, label, timeoutMs = 30000) {
        const target = new Vec3(point.x, point.y, point.z)
        const dist = this.bot.entity.position.distanceTo(target)
        if (dist <= 3) return

        console.log(`[进食] ${label} (${point.x},${point.y},${point.z}) 距离${dist.toFixed(1)}`)
        stopMovement(this.bot)
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2)
        await pathfinderGoto(this.bot, goal, timeoutMs)
        await sleep(300)
    }

    async _gotoPos2() {
        const { pos1, pos2, waypoints } = this.masterData
        if (!pos2) return

        const botPos = this.bot.entity.position
        const distToPos2 = botPos.distanceTo(new Vec3(pos2.x, pos2.y, pos2.z))
        if (distToPos2 <= 3) return

        const useWaypoints = pos1 && Array.isArray(waypoints) && waypoints.length > 0
            && botPos.distanceTo(new Vec3(pos1.x, pos1.y, pos1.z)) <
               botPos.distanceTo(new Vec3(pos2.x, pos2.y, pos2.z))

        if (useWaypoints) {
            const reversed = [...waypoints].reverse()
            console.log(`[进食] 靠近 pos1，按路径点倒序返回 pos2 (${reversed.length} 个路径点)`)
            for (let i = 0; i < reversed.length; i++) {
                if (!this.active) return
                await this._gotoPoint(reversed[i], `路径点 ${i + 1}/${reversed.length}`)
            }
        }

        await this._gotoPoint(pos2, '前往 pos2')
    }

    async runEat() {
        try {
            if (this.bot.food >= 20) {
                this.isFinished = true
                return
            }

            let bread = this.bot.inventory.items().find(i => i.name === 'bread')

            if (!bread) {
                this.masterData.detailStatus = '前往 pos2 取面包'
                await this._gotoPos2()
                this.masterData.detailStatus = '从箱子取面包'
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
        const pos2 = this.masterData.pos2
        const searchPoint = pos2 ? new Vec3(pos2.x, pos2.y, pos2.z) : undefined

        const chests = this.bot.findBlocks({
            matching: block => block.name === 'chest' || block.name === 'trapped_chest',
            maxDistance: 4,
            count: 5,
            point: searchPoint
        })
        if (chests.length === 0) {
            console.log('[进食] pos2 附近未找到箱子')
            return
        }

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
                // skip
            }
        }
        console.log('[进食] 附近箱子中没有面包')
    }

    update() {
        if (Date.now() - this.startTime > 30000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        this.masterData.detailStatus = ''
        this.masterData.isEating = false
    }
}

module.exports = { BehaviorEat }
