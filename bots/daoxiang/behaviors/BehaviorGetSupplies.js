const { Vec3 } = require('vec3')
const { openChestContainer } = require('../../../utils/container')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')
const { isInTerraces, isUnplantable } = require('../config')
const { goals } = require('mineflayer-pathfinder')

// 物资不足后的重试冷却：防止 supplies↔waitMaturity 零间隔死循环（FarmMaster 教训）
const SUPPLY_RETRY_COOLDOWN_MS = 60000

/**
 * 物资补给：
 *   - 种子从木桶取（规则 5：木桶 1028 70 571~577，比例 potato:carrot:wheat:beetroot = 1:1:5:1）
 *   - 石锄从附近箱子取（规则 8：需要机器人自己寻找）
 * 退出标志：
 *   - noShortage=true  物资充足，可以直接去播种
 *   - shortage=true    没取够（锄头/种子不足），进入冷却后回 waitMaturity
 */
class BehaviorGetSupplies {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'getSupplies'
        this.active = false
        this.x = 600
        this.y = 150
        this.isFinished = false
        this.noShortage = false
        this.shortage = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.shortage = false
        this.noShortage = false
        this.masterData.detailStatus = '补给物资'
        this.run()
    }

    _countItem(name) {
        return this.bot.inventory.items()
            .filter(i => i.name === name)
            .reduce((sum, i) => sum + i.count, 0)
    }

    _emptySlots() {
        const inv = this.bot.inventory
        return inv.emptySlotCount()
    }

    /** 扫描当前空地数量（排除不可种植地块） */
    _countEmptyPlots() {
        scanFarmingAreas(this.bot, this.masterData, isInTerraces)
        const areas = Array.from(this.masterData.farmingAreas.values())
        return areas.filter(a =>
            a.isEmpty &&
            !isUnplantable(a.soilPos) &&
            !this.masterData.plantProtocolBlacklist.has(`${a.soilPos.x},${a.soilPos.y},${a.soilPos.z}`)
        ).length
    }

    /** 最大余数法按比例分配空地给各作物 */
    _allocateCounts(total, seeds) {
        const totalRatio = seeds.reduce((sum, s) => sum + s.ratio, 0)
        if (totalRatio <= 0 || total <= 0) return seeds.map(() => 0)
        const raw = seeds.map(s => total * s.ratio / totalRatio)
        const counts = raw.map(Math.floor)
        let assigned = counts.reduce((a, b) => a + b, 0)
        const order = raw
            .map((v, i) => ({ i, frac: v - Math.floor(v) }))
            .sort((a, b) => b.frac - a.frac || a.i - b.i)
        let k = 0
        while (assigned < total) {
            counts[order[k % order.length].i]++
            assigned++
            k++
        }
        return counts
    }

    _calcNeeded() {
        const seeds = this.masterData.seeds
        const empty = this._countEmptyPlots()
        const counts = this._allocateCounts(empty, seeds)
        return seeds.map((s, i) => ({
            name: s.name,
            need: Math.max(0, counts[i] - this._countItem(s.name))
        })).filter(t => t.need > 0)
    }

    /**
     * 找木桶。【y 不参与匹配】—— 配置只约束 X/Z 行，同一列任何高度的木桶都算。
     * 实际高度与配置不同时打日志提醒（但不阻塞）；配置行整体没匹配上时回退到半径内最近木桶。
     */
    _findBarrels() {
        const b = this.masterData.barrels
        const byDist = (p1, p2) =>
            this.bot.entity.position.distanceTo(p1) - this.bot.entity.position.distanceTo(p2)
        const found = this.bot.findBlocks({
            matching: block => block.name === 'barrel',
            maxDistance: 16,
            count: 30
        }) || []

        if (found.length === 0) {
            console.log('[补给][诊断] 半径 16 内没有找到任何木桶（请确认木桶位置/机器人站位）')
            return []
        }

        if (!b) return found.sort(byDist)

        // 只按 X/Z 匹配配置行，高度自动探测
        const inRow = found.filter(p => p.x === b.x && p.z >= b.zMin && p.z <= b.zMax)
        if (inRow.length > 0) {
            const ys = [...new Set(inRow.map(p => p.y))]
            if (b.y != null && !ys.includes(b.y)) {
                console.log(`[补给][提示] 木桶行实际高度 Y=${ys.join('/')}，配置写的是 Y=${b.y}` +
                    `（已自动按实际高度使用，建议同步更新配置）`)
            }
            return inRow.sort(byDist)
        }

        console.log(`[补给][诊断] 配置木桶行 X=${b.x} Z${b.zMin}~${b.zMax} 无匹配，` +
            `附近实际木桶: ${found.map(p => `(${p.x},${p.y},${p.z})`).join(', ')}，回退使用最近的`)
        return found.sort(byDist)
    }

    /** 从木桶取种子（导航目标取实际找到的木桶位置，高度跟随探测结果） */
    async _withdrawSeeds(needed) {
        let barrels = this._findBarrels()

        // 当前站位扫不到桶：按配置 X/Z 行走过去（GoalNearXZ 不依赖任何高度），到了再扫一遍
        if (barrels.length === 0 && this.masterData.barrels) {
            const b = this.masterData.barrels
            const midZ = Math.floor((b.zMin + b.zMax) / 2)
            console.log(`[补给] 站位附近未探到木桶，先按配置 X/Z 行 (${b.x}, Z${b.zMin}~${b.zMax}) 走过去再扫`)
            stopMovement(this.bot)
            try {
                await pathfinderGoto(this.bot, new goals.GoalNearXZ(b.x, midZ, 3), 45000)
            } catch (e) {
                console.log(`[补给] 前往配置木桶区失败: ${e.message}`)
            }
            await sleep(500)
            barrels = this._findBarrels()
        }

        if (barrels.length === 0) {
            console.log('[补给] 未找到木桶（检查 barrels 配置与实际坐标）')
            return false
        }

        // 先靠近第一个木桶（用它的实际 x/y/z，而不是配置 y）
        const first = barrels[0]
        if (this.bot.entity.position.distanceTo(new Vec3(first.x, first.y, first.z)) > 4) {
            console.log(`[补给] 前往木桶 (${first.x},${first.y},${first.z})`)
            stopMovement(this.bot)
            try {
                const goal = new goals.GoalNear(first.x, first.y, first.z, 2)
                goal.teleportYOffset = 1
                await pathfinderGoto(this.bot, goal, 45000)
            } catch (e) {
                console.log(`[补给] 前往木桶失败: ${e.message}（仍尝试开桶，交互距离可达 4.5 格）`)
            }
            await sleep(300)
        }

        for (const pos of barrels) {
            if (needed.length === 0) break
            if (this.masterData.stopRequested) break
            if (Date.now() - this.startTime > 120000) break
            const block = this.bot.blockAt(pos)
            if (!block) continue

            let barrel = null
            try {
                barrel = await openChestContainer(this.bot, block, { timeoutMs: 12000 })
                // 等服务器的 window_items 包到达再读 slots，
                // 否则会拿到上一个桶的槽位残影（表现为 Can't find X in slots 刷屏）
                await sleep(300)
                for (const t of [...needed]) {
                    const slot = barrel.slots.find(s => s && s.name === t.name)
                    if (!slot) continue
                    const take = Math.min(t.need, slot.count)
                    try {
                        await barrel.withdraw(slot.type, null, take)
                        console.log(`[补给] 从木桶取出 ${take} 个 ${t.name}`)
                        t.need -= take
                    } catch (e) {
                        const msg = e.message || String(e)
                        // 桶里实际已经没有该物品（槽位残影/取空）→ 静默跳过，不算错误
                        if (!msg.includes("Can't find") && !msg.includes('找不到')) {
                            console.log(`[补给] 取出 ${t.name} 失败: ${msg}`)
                        }
                    }
                    await sleep(200)
                }
            } catch (e) {
                console.log(`[补给] 开木桶失败 (${pos.x},${pos.y},${pos.z}): ${e.message}`)
            } finally {
                if (barrel) {
                    try { barrel.close() } catch (e) { /* ignore */ }
                }
            }
            needed = needed.filter(t => t.need > 0)
        }
        return needed.length === 0
    }

    /** 从附近箱子取石锄（规则 8） */
    async _withdrawHoes() {
        const hoeItem = this.masterData.tools.hoeItem || 'stone_hoe'
        const minHoes = this.masterData.tools.minHoes || 2
        const radius = this.masterData.containerSearchRadius || 24
        const chests = this.bot.findBlocks({
            matching: b => b.name === 'chest' || b.name === 'trapped_chest',
            maxDistance: radius,
            count: 10
        }).sort((a, b) => this.bot.entity.position.distanceTo(a) - this.bot.entity.position.distanceTo(b))

        for (const pos of chests) {
            if (this._countItem(hoeItem) >= minHoes) break
            if (this.masterData.stopRequested) break
            const block = this.bot.blockAt(pos)
            if (!block) continue
            let chest = null
            try {
                chest = await openChestContainer(this.bot, block, { timeoutMs: 12000 })
                const slot = chest.slots.find(s => s && s.name === hoeItem)
                if (slot) {
                    const lack = minHoes - this._countItem(hoeItem)
                    const take = Math.min(lack, slot.count)
                    await chest.withdraw(slot.type, null, take)
                    console.log(`[补给] 从箱子取出 ${take} 把 ${hoeItem}`)
                }
                chest.close()
            } catch (e) {
                console.log(`[补给] 开箱失败 (${pos.x},${pos.y},${pos.z}): ${e.message}`)
            }
        }
        return this._countItem(hoeItem) >= minHoes
    }

    async run() {
        try {
            // 冷却闸门：物资不足时【原地等满冷却】再重试，而不是瞬间放行。
            // 之前瞬间放行会造成 waitMaturity→checkHunger→getSupplies 每 4s 空转一圈。
            const cooldownAt = this.masterData.supplyRetryAt || 0
            if (Date.now() < cooldownAt) {
                const waitSec = Math.ceil((cooldownAt - Date.now()) / 1000)
                console.log(`[补给] 物资不足冷却中，原地等待 ${waitSec}s（请补充木桶里的种子或箱子里的锄头）`)
                while (Date.now() < cooldownAt && this.active && !this.masterData.stopRequested) {
                    await sleep(1000)
                }
                if (!this.active || this.masterData.stopRequested) {
                    this.shortage = true
                    this.isFinished = true
                    return
                }
                console.log('[补给] 冷却结束，重试补给')
            }

            const hoeItem = this.masterData.tools.hoeItem || 'stone_hoe'
            const minHoes = this.masterData.tools.minHoes || 2
            const needed = this._calcNeeded()
            const needHoes = this._countItem(hoeItem) < minHoes

            if (needed.length === 0 && !needHoes) {
                console.log('[补给] 种子和锄头充足')
                this.noShortage = true
                this.isFinished = true
                return
            }
            if (needed.length > 0) {
                console.log(`[补给] 需要种子: ${needed.map(t => `${t.name}(${t.need})`).join(', ')}`)
            }
            if (needHoes) {
                console.log(`[补给] 锄头不足: ${this._countItem(hoeItem)}/${minHoes}`)
            }
            if (this._emptySlots() <= 0) {
                console.log('[补给][告警] 背包已满，无法取物资')
                this.shortage = true
                this._setCooldown()
                this.isFinished = true
                return
            }

            if (needed.length > 0) {
                // _withdrawSeeds 内部先按 X/Z 行自动探测木桶（高度不依赖配置），
                // 再导航到实际木桶位置并逐桶取种
                await this._withdrawSeeds(needed)
                // 一个种子都没拿到 → 不去播种（去了也是 412 连败空转），进冷却等补货
                const totalSeeds = this.masterData.seeds.reduce(
                    (sum, s) => sum + this._countItem(s.name), 0)
                if (totalSeeds === 0) {
                    console.log('[补给][告警] 种子一个都没取到，背包无种子！请在木桶中补充种子')
                    this.shortage = true
                    this._setCooldown()
                    this.isFinished = true
                    return
                }
                if (needed.some(t => t.need > 0 && this._countItem(t.name) === 0)) {
                    console.log('[补给] 部分种子缺货（将按现有库存播种缺的类型）')
                }
            }

            if (this._countItem(hoeItem) < minHoes) {
                const hoesOk = await this._withdrawHoes()
                if (!hoesOk) {
                    console.log(`[补给] 箱子中锄头不足 (${this._countItem(hoeItem)}/${minHoes})，暂停播种`)
                    this.shortage = true
                    this._setCooldown()
                    this.isFinished = true
                    return
                }
            }

            console.log(`[补给] 完成，背包: ${this.masterData.seeds.map(s => `${s.name}:${this._countItem(s.name)}`).join(', ')}` +
                `，锄头:${this._countItem(hoeItem)}`)
            this.noShortage = true
        } catch (e) {
            console.log(`[补给] 异常: ${e.message}`)
            this.shortage = true
            this._setCooldown()
        }
        this.isFinished = true
    }

    _setCooldown() {
        this.masterData.supplyRetryAt = Date.now() + SUPPLY_RETRY_COOLDOWN_MS
        console.log(`[补给] 将在 ${SUPPLY_RETRY_COOLDOWN_MS / 1000}s 后重试`)
    }

    update() {
        if (Date.now() - this.startTime > 300000) {
            console.log('[补给] 超时，放弃本轮')
            stopMovement(this.bot)
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

module.exports = { BehaviorGetSupplies }
