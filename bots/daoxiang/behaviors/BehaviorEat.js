const { openChestContainer } = require('../../../utils/container')
const { stopMovement, sleep } = require('../../../utils/movement')

/**
 * 进食：优先吃背包里的面包；没有则自己搜索附近木箱取面包（规则 8）。
 * 【mineflayer 语义】bot.consume() 报 "Consuming cancelled due to calling bot.consume()
 * again" 多半是上一轮没收尾，退避重试而不是放弃。
 */
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
        // 进食锁：health 兜底看到 isEating=true 就不并发 consume；
        // bump _eatRunId 让"仍在飞行中的兜底进食"结束时不清掉这把锁
        this.masterData._eatRunId = (this.masterData._eatRunId || 0) + 1
        this.masterData.isEating = true
        this.masterData.detailStatus = '进食中'
        this.runEat()
    }

    _findBreadInInventory() {
        const name = this.masterData.food.breadItem || 'bread'
        return this.bot.inventory.items().find(i => i.name === name)
    }

    /** 搜索附近木箱/木桶取面包（规则 8：需要机器人自己寻找） */
    async fetchBreadFromContainers() {
        const radius = this.masterData.containerSearchRadius || 24
        const containers = this.bot.findBlocks({
            matching: b => ['chest', 'trapped_chest', 'barrel'].includes(b.name),
            maxDistance: radius,
            count: 10
        }).sort((a, b) =>
            this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
        )

        if (containers.length === 0) {
            console.log(`[进食] 半径 ${radius} 内没有找到任何箱子/木桶`)
            return false
        }

        for (const pos of containers) {
            if (this.masterData.stopRequested) return false
            const block = this.bot.blockAt(pos)
            if (!block) continue
            let container = null
            try {
                container = await openChestContainer(this.bot, block, { timeoutMs: 12000 })
                const slot = container.slots.find(s => s && s.name === (this.masterData.food.breadItem || 'bread'))
                if (slot) {
                    await container.withdraw(slot.type, null, Math.min(slot.count, 32))
                    console.log(`[进食] 从 (${pos.x},${pos.y},${pos.z}) 取到面包`)
                    container.close()
                    return true
                }
                container.close()
            } catch (e) {
                console.log(`[进食] 开容器失败 (${pos.x},${pos.y},${pos.z}): ${e.message}`)
            }
        }
        console.log('[进食] 附近容器里没有面包')
        return false
    }

    async runEat() {
        try {
            if (this.bot.food >= 20) {
                this.isFinished = true
                return
            }

            let bread = this._findBreadInInventory()
            if (!bread) {
                this.masterData.detailStatus = '寻找面包'
                await this.fetchBreadFromContainers()
                bread = this._findBreadInInventory()
            }

            if (!bread) {
                console.log('[进食] 背包和附近容器中都没有面包（请补充面包库存）')
                this.isFinished = true
                return
            }

            // 吃到 20（规则 8：饥饿值不低于 20%，直接补满最稳）
            while (this.bot.food < 20 && this.active) {
                bread = this._findBreadInInventory()
                if (!bread) break
                await this.bot.equip(bread, 'hand')
                await this.bot.consume()
                await sleep(300)
            }
            console.log(`[进食] 完成，食物值: ${this.bot.food}/20`)
        } catch (e) {
            console.log(`[进食] 失败: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        // 兜底窗口：找容器 + 进食可能要几分钟，30s 会把进食拦腰打断
        if (Date.now() - this.startTime > 300000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        this.masterData.detailStatus = ''
        this.masterData.isEating = false
    }
}

module.exports = { BehaviorEat }
