const { openChestContainer } = require('../../../utils/container')
const { sleep, stopMovement } = require('../../../utils/movement')

const MIN_HOES = 2
const HOE_NAME = 'stone_hoe'

class BehaviorGetSeeds {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'getSeeds'
        this.active = false
        this.x = 600
        this.y = 150
        this.isFinished = false
        this.noHoes = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.noHoes = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '取种子和锄头'
        this.run()
    }

    _countHoes() {
        return this.bot.inventory.items()
            .filter(i => i.name === HOE_NAME)
            .reduce((sum, i) => sum + i.count, 0)
    }

    _calcSeedTargets() {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []

        const totalRatio = seeds.reduce((sum, s) => sum + s.ratio, 0)
        if (totalRatio <= 0) return []

        const emptySlots = 36 - this.bot.inventory.items().length
        const totalSeeds = Math.max(emptySlots * 48, 128)

        return seeds.map(s => ({
            name: s.name,
            target: Math.max(1, Math.round(totalSeeds * s.ratio / totalRatio)),
            current: this.bot.inventory.items()
                .filter(i => i.name === s.name)
                .reduce((sum, i) => sum + i.count, 0)
        }))
    }

    async run() {
        try {
            const targets = this._calcSeedTargets()
            if (targets.length === 0) {
                console.log('[取物资] 未配置种子类型')
                this.isFinished = true
                return
            }

            const hoeCount = this._countHoes()
            const needHoes = hoeCount < MIN_HOES
            const needed = targets.filter(t => t.current < t.target)

            if (needed.length === 0 && !needHoes) {
                console.log(`[取物资] 背包种子和锄头充足 (锄头:${hoeCount})`)
                this.isFinished = true
                return
            }

            if (needHoes) {
                console.log(`[取物资] 锄头不足: 当前${hoeCount}，需要至少${MIN_HOES}`)
            }
            if (needed.length > 0) {
                console.log(`[取物资] 需要种子: ${needed.map(t => `${t.name}(有${t.current}/需${t.target})`).join(', ')}`)
            }

            const chests = this.bot.findBlocks({
                matching: block => block.name === 'chest' || block.name === 'trapped_chest',
                maxDistance: 6,
                count: 5
            }).sort((a, b) =>
                this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
            )

            if (chests.length === 0) {
                console.log('[取物资] 附近没有箱子')
                if (needHoes) {
                    this.noHoes = true
                }
                this.isFinished = true
                return
            }

            for (const chestPos of chests) {
                if (!this.active || this.masterData.stopRequested) break
                if (Date.now() - this.startTime > 40000) break

                const seedsDone = targets.every(t => {
                    const cur = this.bot.inventory.items()
                        .filter(i => i.name === t.name)
                        .reduce((s, i) => s + i.count, 0)
                    return cur >= t.target
                })
                const hoesDone = this._countHoes() >= MIN_HOES
                if (seedsDone && hoesDone) break

                const chestBlock = this.bot.blockAt(chestPos)
                if (!chestBlock) continue

                let chest = null
                try {
                    chest = await openChestContainer(this.bot, chestBlock, { timeoutMs: 15000 })

                    if (!hoesDone) {
                        const hoeSlot = chest.slots.find(s => s && s.name === HOE_NAME)
                        if (hoeSlot) {
                            const currentHoes = this._countHoes()
                            const takeHoes = Math.min(MIN_HOES - currentHoes, hoeSlot.count)
                            if (takeHoes > 0) {
                                try {
                                    await chest.withdraw(hoeSlot.type, null, takeHoes)
                                    console.log(`[取物资] 取出 ${takeHoes} 把石锄头`)
                                } catch (e) {
                                    console.log(`[取物资] 取锄头失败: ${e.message}`)
                                }
                                await sleep(200)
                            }
                        }
                    }

                    for (const t of targets) {
                        const current = this.bot.inventory.items()
                            .filter(i => i.name === t.name)
                            .reduce((s, i) => s + i.count, 0)
                        const need = t.target - current
                        if (need <= 0) continue

                        const slot = chest.slots.find(s => s && s.name === t.name)
                        if (!slot) continue

                        const take = Math.min(need, slot.count)
                        try {
                            await chest.withdraw(slot.type, null, take)
                            console.log(`[取物资] 取出 ${take} 个 ${t.name}`)
                        } catch (e) {
                            console.log(`[取物资] 取出 ${t.name} 失败: ${e.message}`)
                        }
                        await sleep(200)
                    }
                } catch (e) {
                    console.log(`[取物资] 开箱失败: ${e.message}`)
                } finally {
                    if (chest) {
                        try { chest.close() } catch {}
                    }
                }

                await sleep(300)
            }

            const finalHoes = this._countHoes()
            if (finalHoes < MIN_HOES) {
                console.log(`[取物资] 锄头仍不足(${finalHoes}/${MIN_HOES})，进入等待状态`)
                this.noHoes = true
                this.isFinished = true
                return
            }

            const summary = targets.map(t => {
                const cur = this.bot.inventory.items()
                    .filter(i => i.name === t.name)
                    .reduce((s, i) => s + i.count, 0)
                return `${t.name}:${cur}`
            }).join(', ')
            console.log(`[取物资] 完成，背包: ${summary}，锄头:${finalHoes}`)
        } catch (e) {
            console.log(`[取物资] 异常: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 45000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        if (this.bot.currentWindow) {
            try { this.bot.closeWindow(this.bot.currentWindow) } catch {}
        }
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGetSeeds }
