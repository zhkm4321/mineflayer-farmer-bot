const { openChestContainer } = require('../../../utils/container')
const { stopMovement, sleep } = require('../../../utils/movement')

const KEEP_ITEMS = ['bread', 'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop']
const SEED_KEEP_COUNT = 64

function isChestFullError(err) {
    const msg = err?.message || String(err)
    return msg.includes('destination full') || msg.includes('Unable to deposit')
}

function collectItemsToStore(bot, farmData) {
    const { currentCrop, cropTypes } = farmData
    const seedName = currentCrop ? cropTypes[currentCrop] : null
    const itemsToStore = []
    let seedsKept = 0

    for (const item of bot.inventory.items()) {
        if (KEEP_ITEMS.includes(item.name)) continue

        if (seedName && item.name === seedName) {
            const canKeep = Math.max(0, SEED_KEEP_COUNT - seedsKept)
            const keepThisSlot = Math.min(item.count, canKeep)
            const storeThisSlot = item.count - keepThisSlot
            seedsKept += keepThisSlot
            if (storeThisSlot > 0) {
                itemsToStore.push({ item, storeCount: storeThisSlot, type: item.type })
            }
            continue
        }

        itemsToStore.push({ item, storeCount: item.count, type: item.type })
    }

    return itemsToStore
}

class BehaviorStore {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'storing'
        this.active = false
        this.x = 650
        this.y = 300
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.farmData.detailStatus = '存储物品'
        this.runStore()
    }

    async runStore() {
        await sleep(300)
        const MAX_TIME = 45000
        let itemsToStore = collectItemsToStore(this.bot, this.farmData)

        if (itemsToStore.length === 0) {
            console.log('[存储] 没有需要存储的物品')
            this.isFinished = true
            return
        }

        const chests = this.bot.findBlocks({
            matching: block => block.name === 'chest' || block.name === 'trapped_chest',
            maxDistance: 24,
            count: 3
        }).sort((a, b) =>
            this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
        )

        if (chests.length === 0) {
            console.log('[存储] 附近没有箱子')
            this.isFinished = true
            return
        }

        console.log(`[存储] 准备存储 ${itemsToStore.length} 种物品，找到 ${chests.length} 个箱子`)
        let storedCount = 0

        for (const chestPos of chests) {
            if (!this.active || this.farmData.stopRequested) break
            if (Date.now() - this.startTime > MAX_TIME) {
                console.log('[存储] 达到时间上限(45s)')
                break
            }

            itemsToStore = collectItemsToStore(this.bot, this.farmData)
            if (itemsToStore.length === 0) break

            const chestBlock = this.bot.blockAt(chestPos)
            if (!chestBlock) continue

            let chest = null
            try {
                chest = await openChestContainer(this.bot, chestBlock, { timeoutMs: 20000 })

                let chestFull = false
                for (const { item, storeCount, type } of itemsToStore) {
                    if (storeCount <= 0) continue

                    try {
                        await chest.deposit(type, null, storeCount)
                        storedCount += storeCount
                        console.log(`[存储] 存入 ${storeCount} 个 ${item.name} -> (${chestPos.x},${chestPos.y},${chestPos.z})`)
                    } catch (e) {
                        if (isChestFullError(e)) {
                            console.log(`[存储] 箱子 (${chestPos.x},${chestPos.y},${chestPos.z}) 已满，换下一个箱子`)
                            chestFull = true
                            break
                        }
                        console.log(`[存储] 存入 ${item.name} 失败: ${e.message}`)
                    }
                }

                itemsToStore = collectItemsToStore(this.bot, this.farmData)
                if (itemsToStore.length === 0) break
                if (chestFull) continue
            } catch (e) {
                console.log(`[存储] 无法打开箱子 (${chestPos.x},${chestPos.y},${chestPos.z}): ${e.message}`)
            } finally {
                if (chest) {
                    try { chest.close() } catch (e) { /* ignore */ }
                }
            }

            await new Promise(r => setTimeout(r, 300))
        }

        itemsToStore = collectItemsToStore(this.bot, this.farmData)
        console.log(`[存储] 完成，共存入 ${storedCount} 个物品 (剩余未存: ${itemsToStore.map(i => `${i.item.name}×${i.storeCount}`).join(', ') || '无'})`)
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 50000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        if (this.bot.currentWindow) {
            try { this.bot.closeWindow(this.bot.currentWindow) } catch (e) { /* ignore */ }
        }
        this.farmData.detailStatus = ''
    }
}

module.exports = { BehaviorStore }
