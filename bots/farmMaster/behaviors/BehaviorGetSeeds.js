const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { openChestContainer } = require('../../../utils/container')
const { sleep, stopMovement, pathfinderGoto } = require('../../../utils/movement')

const MIN_HOES = 2
const HOE_NAME = 'stone_hoe'
const CHEST_SEARCH_RADIUS = 6

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

    _countItem(name) {
        return this.bot.inventory.items()
            .filter(i => i.name === name)
            .reduce((sum, i) => sum + i.count, 0)
    }

    /** 主背包(含快捷栏)的空槽数；用窗口自身边界推导，避免硬编码 36 */
    _emptySlots() {
        const inv = this.bot.inventory
        if (inv && typeof inv.emptySlotCount === 'function') {
            try { return inv.emptySlotCount() } catch (e) { /* fall through */ }
        }
        const total = (inv && typeof inv.inventoryStart === 'number' && typeof inv.inventoryEnd === 'number')
            ? inv.inventoryEnd - inv.inventoryStart
            : 36
        return Math.max(0, total - this.bot.inventory.items().length)
    }

    _calcSeedTargets() {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []

        const totalRatio = seeds.reduce((sum, s) => sum + s.ratio, 0)
        if (totalRatio <= 0) return []

        const emptySlots = this._emptySlots()
        const totalSeeds = Math.max(emptySlots * 48, 128)

        return seeds.map(s => ({
            name: s.name,
            target: Math.max(1, Math.round(totalSeeds * s.ratio / totalRatio)),
            current: this._countItem(s.name)
        }))
    }

    async _gotoPoint(point, label, timeoutMs = 30000) {
        const target = new Vec3(point.x, point.y, point.z)
        const dist = this.bot.entity.position.distanceTo(target)
        if (dist <= 3) return

        console.log(`[取物资] ${label} (${point.x},${point.y},${point.z}) 距离${dist.toFixed(1)}`)
        stopMovement(this.bot)
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2)
        await pathfinderGoto(this.bot, goal, timeoutMs)
        await sleep(300)
    }

    /**
     * 先确保到达 pos2 再找箱子。
     * 原来直接用 maxDistance:6 搜箱子，开局/从播种区回来时附近根本没有箱子，
     * 会导致锄头判定失败而空转到 idle。
     */
    async _gotoPos2() {
        const { pos1, pos2, waypoints } = this.masterData
        if (!pos2) return

        const botPos = this.bot.entity.position
        if (botPos.distanceTo(new Vec3(pos2.x, pos2.y, pos2.z)) <= 3) return

        const useWaypoints = pos1 && Array.isArray(waypoints) && waypoints.length > 0
            && botPos.distanceTo(new Vec3(pos1.x, pos1.y, pos1.z)) <
               botPos.distanceTo(new Vec3(pos2.x, pos2.y, pos2.z))

        if (useWaypoints) {
            const reversed = [...waypoints].reverse()
            console.log(`[取物资] 靠近 pos1，按路径点倒序返回 pos2 (${reversed.length} 个路径点)`)
            for (let i = 0; i < reversed.length; i++) {
                if (!this.active || this.masterData.stopRequested) return
                await this._gotoPoint(reversed[i], `路径点 ${i + 1}/${reversed.length}`)
                    .catch(e => console.log(`[取物资] 路径点 ${i + 1} 失败: ${e.message}`))
            }
        }

        await this._gotoPoint(pos2, '前往 pos2')
            .catch(e => console.log(`[取物资] 前往 pos2 失败: ${e.message}`))
    }

    _seedsSatisfied(targets) {
        return targets.every(t => this._countItem(t.name) >= t.target)
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

            if (this._emptySlots() <= 0) {
                console.log('[取物资][告警] 背包已满，无法取种子/锄头，跳过（请清理背包）')
                this.noHoes = needHoes
                this.isFinished = true
                return
            }

            if (needHoes) {
                console.log(`[取物资] 锄头不足: 当前${hoeCount}，需要至少${MIN_HOES}`)
            }
            if (needed.length > 0) {
                console.log(`[取物资] 需要种子: ${needed.map(t => `${t.name}(有${t.current}/需${t.target})`).join(', ')}`)
            }

            await this._gotoPos2()
            if (!this.active || this.masterData.stopRequested) {
                this.isFinished = true
                return
            }

            const chests = this.bot.findBlocks({
                matching: block => block.name === 'chest' || block.name === 'trapped_chest',
                maxDistance: CHEST_SEARCH_RADIUS,
                count: 5
            }).sort((a, b) =>
                this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b)
            )

            if (chests.length === 0) {
                console.log(`[取物资] pos2 附近 ${CHEST_SEARCH_RADIUS} 格内没有箱子`)
                if (needHoes) {
                    this.noHoes = true
                }
                this.isFinished = true
                return
            }

            for (const chestPos of chests) {
                if (!this.active || this.masterData.stopRequested) break
                if (Date.now() - this.startTime > 40000) break

                const seedsDone = this._seedsSatisfied(targets)
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
                        const need = t.target - this._countItem(t.name)
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
                        try { chest.close() } catch (e) { /* ignore */ }
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

            const summary = targets.map(t => `${t.name}:${this._countItem(t.name)}`).join(', ')
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
            try { this.bot.closeWindow(this.bot.currentWindow) } catch (e) { /* ignore */ }
        }
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGetSeeds }
