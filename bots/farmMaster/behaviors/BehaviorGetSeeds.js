const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { openChestContainer } = require('../../../utils/container')
const { sleep, stopMovement, pathfinderGoto } = require('../../../utils/movement')

const MIN_HOES = 2
const HOE_NAME = 'stone_hoe'
const CHEST_SEARCH_RADIUS = 6
// 物资不足后，多久才允许再次尝试取物资（避免 waitMaturity↔getSeeds 零间隔死循环）
const SUPPLY_RETRY_COOLDOWN_MS = 60000

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
        this.startTime = Date.now()
        this.masterData.detailStatus = '取种子和锄头'

        // 重试闸门：上一次"物资不足"之后必须等一段时间才能再进本状态。
        // 【为什么必须放在这里】index.js 里的流程是一个环路：
        //     waitMaturity → getSeeds → waitMaturity → ...
        // 只要 getSeeds 判定"物资不足"，这个环就会以接近零的间隔无限自转
        // （实测 6 秒内 getSeeds 进入 21 次，日志被刷爆）。
        // 单纯把失败目标从 idle 改成 waitMaturity 只是换了个绕法，必须在入口拦截。
        const now = Date.now()
        const until = this.masterData.supplyRetryAt || 0
        if (now < until) {
            const left = ((until - now) / 1000).toFixed(0)
            console.log(`[取物资] 物资不足冷却中，还需 ${left}s（请在 pos2 箱子里补充锄头/种子）`)
            this.retryBlocked = true
            this.noHoes = true
            this.isFinished = true
            return
        }

        this.retryBlocked = false
        this.noHoes = false
        this.run()
    }

    _countHoes() {
        return this.bot.inventory.items()
            .filter(i => i.name === HOE_NAME)
            .reduce((sum, i) => sum + i.count, 0)
    }

    /** 记下"物资不足"的冷却截止时间，防止流程环路零间隔自转 */
    _setSupplyCooldown() {
        this.masterData.supplyRetryAt = Date.now() + SUPPLY_RETRY_COOLDOWN_MS
        console.log(`[取物资] 将在 ${SUPPLY_RETRY_COOLDOWN_MS / 1000}s 后重试取物资`)
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
                this._setSupplyCooldown()
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
                // 这条路径也必须设冷却。漏掉它曾导致：noHoes=true → 回 waitMaturity →
                // 立刻又进 getSeeds → 又没箱子 → ... 6 秒内刷 21 轮（实测）。
                this._setSupplyCooldown()
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

            // 重新核对种子：盒子里可能根本不够，取完仍不足会让播种立刻空转，
            // 这里先量化出来（不阻塞流程，只报告缺口）
            const stillShort = targets.filter(t => this._countItem(t.name) < t.target)
            if (stillShort.length > 0) {
                console.log(`[取物资] 种子仍不足: ${stillShort.map(t => `${t.name}(有${this._countItem(t.name)}/需${t.target})`).join(', ')}`)
            }

            // 关键：得出"锄头不足"的结论必须走 console.log 之外的显式标志，
            // 否则调用方会以为物资齐备、直接去播种，然后一株都种不了
            if (finalHoes < MIN_HOES) {
                const hitTimeLimit = Date.now() - this.startTime > 45000
                console.log(`[取物资] 锄头仍不足(${finalHoes}/${MIN_HOES})，跳过本轮播种` +
                    (hitTimeLimit ? '（已达时间上限）' : ''))
                this.noHoes = true
                this._setSupplyCooldown()
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
