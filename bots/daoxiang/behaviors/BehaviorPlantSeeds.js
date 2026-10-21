const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    getStandCenterOnSoil, isStandingOnSoil,
    moveToStandOnSoil, faceDownAtFeetFarmland
} = require('../../../utils/movement')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { logImportant } = require('../../../utils/logger')
const { isPlantBlacklisted, addPlantBlacklist, isProtocolPlantFailure } = require('../../../utils/plantBlacklist')
const { isInTerraces, isInPlantArea, isUnplantable } = require('../config')
const { findLeverBlock, isLeverPowered } = require('../lever')

const HOE_NAME_DEFAULT = 'stone_hoe'
const SEED_FAIL_LIMIT = 8
const MIN_TIME_BUDGET_MS = 60000
// 同一层连续移动失败达到该值 → 判定该层不可达，跳过整层（不烧种子配额）
const MOVE_FAIL_LAYER_SKIP = 15

/**
 * 播种 + 耕地修复：
 *   - 只在梯田内播种；跳过规则 4 的不可种植地块与协议黑名单地块
 *   - 按比例分配作物（最大余数法，规则 5：potato:carrot:wheat:beetroot = 1:1:5:1）
 *   - 【规则 8】发现被踩坏的耕地（farmland 变 dirt）时先用锄头犁回去
 *   - 【规则 3】开播前检查拉杆必须关闭，否则刚播的种子会被水流冲走
 *   - 全程禁止在耕地上跳跃（configureMovements 的 farmland 跳跃守卫）
 */
class BehaviorPlantSeeds {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'plantSeeds'
        this.active = false
        this.x = 500
        this.y = 150
        this.isFinished = false
        this.startTime = 0
        this.leverStillOn = false   // 播种前发现拉杆未关 → 转移去关拉杆
        this.timeBudgetMs = MIN_TIME_BUDGET_MS
    }

    onStateEntered() {
        this.isFinished = false
        this.leverStillOn = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '播种中'
        this.run()
    }

    /** 背包内指定物品总数 */
    _countItem(name) {
        return this.bot.inventory.items()
            .filter(i => i.name === name)
            .reduce((sum, i) => sum + i.count, 0)
    }

    /** 背包里是否还有指定种子 */
    _hasSeed(seedName) {
        return this.bot.inventory.items().some(i => i.name === seedName)
    }

    /** 规则 3：播种前确认拉杆关闭。
     *  与 BehaviorOperateLever 共用同一查找逻辑（含半径回退搜索），
     *  避免配置坐标失效时 OperateLever 拨对了搜索到的拉杆、
     *  这里却只看配置坐标误判为"已关闭"。 */
    _isLeverOff() {
        if (!this.masterData.lever) return true
        const lever = findLeverBlock(this.bot, this.masterData.lever)
        if (!lever) return true // 找不到拉杆时不阻塞播种
        if (isLeverPowered(lever)) {
            console.log('[播种][规则3] 检测到拉杆仍处于开启状态，水流会冲走种子，先去关闭拉杆')
            return false
        }
        return true
    }

    _canPlantAt(area) {
        const soil = this.bot.blockAt(area.soilPos)
        if (!soil) return false
        if (isUnplantable(area.soilPos)) return false
        if (soil.name !== 'farmland' && soil.name !== 'dirt') return false
        const above = this.bot.blockAt(area.cropPos)
        return !above || above.name === 'air'
    }

    _needsTilling(area) {
        // farmland 被"踩坏"后变成 dirt —— 用锄头犁回（规则 8）
        const soil = this.bot.blockAt(area.soilPos)
        return soil?.name === 'dirt'
    }

    async _equipHoe() {
        const hoeItem = this.masterData.tools.hoeItem || HOE_NAME_DEFAULT
        const hoe = this.bot.inventory.items().find(i => i.name === hoeItem)
        if (!hoe) return false
        if (this.bot.heldItem?.name === hoeItem) return true
        try {
            await this.bot.equip(hoe, 'hand')
            await sleep(100)
            return this.bot.heldItem?.name === hoeItem
        } catch (e) {
            return false
        }
    }

    /** 踩坏的耕地（dirt）犁回 farmland（规则 8） */
    async _tillDirt(area) {
        if (!await this._equipHoe()) {
            console.log('[播种] 没有锄头，无法修复被踩坏的耕地')
            return false
        }
        const dirtBlock = this.bot.blockAt(area.soilPos)
        if (!dirtBlock || dirtBlock.name !== 'dirt') return false
        try {
            await this.bot.lookAt(area.soilPos.offset(0.5, 0.5, 0.5), true)
            await sleep(200)
            await this.bot.activateBlock(dirtBlock)
            await sleep(400)
            const after = this.bot.blockAt(area.soilPos)
            if (after?.name === 'farmland') {
                console.log(`[播种] 已修复被踩坏的耕地 (${area.soilPos.x},${area.soilPos.z})`)
                return true
            }
            return false
        } catch (e) {
            console.log(`[播种] 犁地失败: ${e.message}`)
            return false
        }
    }

    async _equipSeed(seedName) {
        const item = this.bot.inventory.items().find(i => i.name === seedName)
        if (!item) return false
        if (this.bot.heldItem?.name === seedName) return true
        try {
            await this.bot.equip(item, 'hand')
            await sleep(100)
            return this.bot.heldItem?.name === seedName
        } catch (e) {
            return false
        }
    }

    /**
     * @returns {Promise<{ok: boolean, kind?: 'move'|'plant', reason?: string}>}
     * kind=move：移动/站位失败（不该烧种子熔断配额）
     * kind=plant：真实种植失败（计入每种种子的熔断配额）
     */
    async _plantOne(area, seedName) {
        // 【先查库存再动腿】缺该类种子时不必白跑到地块上才发现（旧逻辑要走过去才失败）
        if (!this._hasSeed(seedName)) {
            return { ok: false, kind: 'plant', reason: `没有种子(${seedName})` }
        }
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            stopMovement(this.bot)
            const from = this.bot.entity.position.clone()
            const moved = await moveToStandOnSoil(this.bot, area.soilPos, {
                // 地块在扫描阶段已用完整 X/Y/Z 限定；这里的导航目标只需验证 X/Z 包络
                workAreaChecker: isInPlantArea,
                timeoutMs: 10000,
                pathfinderOnly: true,
                debugMovement: true
            }).catch((e) => {
                console.log(`[播种][移动诊断] moveToStandOnSoil 抛错: ${e.message}`)
                return false
            })
            if (!moved || !isStandingOnSoil(this.bot, area.soilPos)) {
                const p = this.bot.entity.position
                console.log(`[播种][移动诊断] 未站上 (${area.soilPos.x},${area.soilPos.y},${area.soilPos.z})；` +
                    `起点(${from.x.toFixed(2)},${from.y.toFixed(2)},${from.z.toFixed(2)}) → ` +
                    `终点(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})；` +
                    `包络=${isInPlantArea({ x: area.soilPos.x, z: area.soilPos.z })}，` +
                    `farmland=${this.bot.blockAt(area.soilPos)?.name || 'null'}，` +
                    `jumpGuard=${this.bot._jumpGuardBlocked || 0}`)
                // 移动失败不进协议黑名单（不是 protocol 问题），也不烧种子配额
                return { ok: false, kind: 'move', reason: '未站上耕地(移动失败)' }
            }
        }

        // 规则 8：踩坏的耕地先犁回
        if (this._needsTilling(area)) {
            const tilled = await this._tillDirt(area)
            if (!tilled) return { ok: false, kind: 'plant', reason: '犁地失败' }
        }

        if (!await this._equipSeed(seedName)) {
            return { ok: false, kind: 'plant', reason: `没有种子(${seedName})` }
        }
        if (!this._canPlantAt(area)) {
            return { ok: false, kind: 'plant', reason: '目标不可种植' }
        }

        stopMovement(this.bot)
        const faced = await faceDownAtFeetFarmland(this.bot, area.soilPos, { retries: 3, settleMs: 300 })
        if (!faced) return { ok: false, kind: 'plant', reason: 'placeBlock超时(低头未对准脚下耕地)' }
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            return { ok: false, kind: 'move', reason: '种植中被移动离开耕地' }
        }

        const soilBlock = this.bot.blockAt(area.soilPos)
        if (!soilBlock || soilBlock.name !== 'farmland') {
            return { ok: false, kind: 'plant', reason: '耕地方块异常' }
        }

        try {
            stopMovement(this.bot)
            await sleep(100)
            await this.bot.placeBlock(soilBlock, new Vec3(0, 1, 0))
            await sleep(400)
            const after = this.bot.blockAt(area.cropPos)
            if (after && this.masterData.validCropBlocks.includes(after.name)) {
                area.hasCrop = true
                area.isEmpty = false
                return { ok: true }
            }
            return { ok: false, kind: 'plant', reason: 'placeBlock超时(放置后未见作物)' }
        } catch (e) {
            return { ok: false, kind: 'plant', reason: `placeBlock超时(${e.message || '异常'})` }
        }
    }

    /** 跨层移动失败时的诊断：打印层间过渡方块，用于定位"上不去"的物理原因 */
    _logLayerBoundaryDiagnostic(area) {
        const botPos = this.bot.entity.position
        const guardDelta = (this.bot._jumpGuardBlocked || 0) - (this._guardBlockedAtRoundStart || 0)
        const targetLayer = area.soilPos.y
        const botLayer = Math.floor(botPos.y)
        const cells = []
        // 采样 bot 与目标之间的过渡列：目标格、目标格下、bot 前方一格
        for (const p of [
            { x: area.soilPos.x, y: targetLayer, z: area.soilPos.z, tag: '目标格' },
            { x: area.soilPos.x, y: targetLayer - 1, z: area.soilPos.z, tag: '目标格下' },
            { x: Math.floor(botPos.x), y: botLayer, z: Math.floor(botPos.z), tag: '脚下' }
        ]) {
            const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z))
            cells.push(`${p.tag}(${p.x},${p.y},${p.z})=${b ? b.name : '未加载'}`)
        }
        console.log(`[播种][诊断] 跨层失败: bot层Y=${botLayer}(脚部${botPos.y.toFixed(2)}) → 目标层Y=${targetLayer}, ` +
            `守卫拦截${guardDelta}次, ${cells.join(', ')}`)
    }

    /** 收集所有可播种的空地（排除规则 4 地块、黑名单、障碍）。
     *  includeDirt：被踩成 dirt 的耕地也收进来（站上去后先用锄头犁回，规则 8） */
    _collectEmptyPlots() {
        scanFarmingAreas(this.bot, this.masterData, isInTerraces, { includeDirt: true })
        const areas = Array.from(this.masterData.farmingAreas.values())
        return areas.filter(a =>
            a.isEmpty &&
            this._canPlantAt(a) &&
            !isPlantBlacklisted(a, this.masterData.plantProtocolBlacklist)
        )
    }

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

    /** 按高度分层（离 bot 最近的层优先），层内蛇形（S 形）扫描排序。
     *  【为什么不用距离排序】旧逻辑按"距出发点的直线距离"排 —— 等距的地块在场上
     *  围成一圈圈环，机器人沿环来回横跳，表现为反复横穿田地（实测效率极低）。
     *  蛇形：行(z)间贪心链接相邻行、行内沿 x 单向扫、逐行掉头，一趟扫完一层；
     *  层与层之间以上一层的终点作为下一层的起点参考，避免扫完还要跑回头路。 */
    _orderPlotsBySweep(empties) {
        const botPos = this.bot.entity.position
        const layers = new Map()
        for (const area of empties) {
            const y = area.soilPos.y
            if (!layers.has(y)) layers.set(y, [])
            layers.get(y).push(area)
        }
        // 排序基准用"当前支撑层"（站在耕地上时脚部Y=耕地格+0.9375，
        // 直接拿脚部Y比较会把上一层排到最前——上一层往往还没法到达）
        const supportY = Math.floor(botPos.y)
        const sortedY = [...layers.keys()].sort((a, b) =>
            Math.abs(a - supportY) - Math.abs(b - supportY) || a - b
        )
        const sorted = []
        let refPos = botPos   // 每层的起点参考：上一层扫完的终点
        for (const y of sortedY) {
            const layerSorted = this._serpentineWithinLayer(layers.get(y), refPos)
            if (layerSorted.length > 0) {
                const last = layerSorted[layerSorted.length - 1].soilPos
                refPos = getStandCenterOnSoil(last)
            }
            sorted.push(...layerSorted)
        }
        console.log(`[播种] 当前支撑层 Y=${supportY}，分层顺序: ` +
            sortedY.map(y => `Y=${y}(${layers.get(y).length}块)`).join(' → ') + '（层内蛇形扫描）')
        return sorted
    }

    /** 单层内蛇形排序：行按相邻链接（从参考点最近的行开始，先扫完一个方向到边界，
     *  再回头扫另一侧），行内 x 单向、逐行掉头 —— 相邻两行的起终点只差一格。 */
    _serpentineWithinLayer(areas, refPos) {
        if (areas.length === 0) return []

        const rows = new Map()
        for (const a of areas) {
            const z = a.soilPos.z
            if (!rows.has(z)) rows.set(z, [])
            rows.get(z).push(a)
        }

        // 行访问顺序：每次选离上一行最近的未访问行 → 行间始终相邻
        const pending = [...rows.keys()]
        const rowOrder = []
        let lastZ = Math.floor(refPos.z)
        while (pending.length > 0) {
            pending.sort((a, b) => Math.abs(a - lastZ) - Math.abs(b - lastZ))
            const next = pending.shift()
            rowOrder.push(next)
            lastZ = next
        }

        const sorted = []
        let forward = null   // 行内 x 方向：首行取离参考点近的一端，之后逐行掉头
        for (const z of rowOrder) {
            const row = rows.get(z).sort((a, b) => a.soilPos.x - b.soilPos.x)
            if (forward === null) {
                forward = Math.abs(row[0].soilPos.x - refPos.x) <=
                    Math.abs(row[row.length - 1].soilPos.x - refPos.x)
            } else {
                forward = !forward
            }
            sorted.push(...(forward ? row : row.slice().reverse()))
        }
        return sorted
    }

    /** 按比例分配作物（最大余数法），并考虑实际库存：
     *  某类种子缺货时把它的配额按原比例让给还有库存的类型，
     *  库存整体不足则只分配能种的部分（"按现有库存播种"的真正实现）。 */
    _assignSeedToPlots(sorted) {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []
        const available = seeds.map(s => this._countItem(s.name))
        const totalAvailable = available.reduce((a, b) => a + b, 0)
        if (totalAvailable === 0) {
            console.log('[播种] 库存没有任何种子，跳过分配')
            return []
        }

        const counts = seeds.map(() => 0)
        let remaining = sorted.length
        let open = seeds.map((_, i) => i)   // 仍有库存余量的类型
        while (remaining > 0 && open.length > 0) {
            const sub = this._allocateCounts(remaining, open.map(i => seeds[i]))
            let progressed = false
            for (let k = 0; k < open.length; k++) {
                const si = open[k]
                const add = Math.min(sub[k], available[si] - counts[si])
                if (add > 0) {
                    counts[si] += add
                    remaining -= add
                    progressed = true
                }
            }
            open = open.filter(si => available[si] - counts[si] > 0)
            if (!progressed) break
        }
        if (remaining > 0) {
            console.log(`[播种] 库存不足以覆盖全部空地，${remaining} 块本轮跳过`)
        }
        console.log(`[播种] 配额: ${seeds.map((s, i) => `${s.name}=${counts[i]}`).join(', ')} ` +
            `(空地${sorted.length}块, 库存${totalAvailable})`)

        // 交错分配，让各作物在田间大致按比例混布
        const assignments = []
        let idx = 0
        const left = counts.slice()
        while (idx < sorted.length) {
            let progressed = false
            for (let si = 0; si < seeds.length; si++) {
                if (left[si] <= 0) continue
                assignments.push({ area: sorted[idx++], seedName: seeds[si].name })
                left[si]--
                progressed = true
                if (idx >= sorted.length) break
            }
            if (!progressed) break
        }
        return assignments
    }

    async run() {
        try {
            // 规则 3：拉杆必须关闭
            if (!this._isLeverOff()) {
                this.leverStillOn = true
                this.isFinished = true
                return
            }

            // 背包里没有任何种子时不做 412 次无用尝试（补给不足由 GetSupplies 冷却兜底）
            const totalSeeds = this.masterData.seeds.reduce(
                (sum, s) => sum + this._countItem(s.name), 0)
            if (totalSeeds === 0) {
                console.log('[播种] 背包里没有任何种子，跳过本轮')
                this.isFinished = true
                return
            }

            this.timeBudgetMs = Math.max(MIN_TIME_BUDGET_MS, this.masterData.plantMaxTimeMs)
            this._guardBlockedAtRoundStart = this.bot._jumpGuardBlocked || 0
            const empties = this._collectEmptyPlots()
            if (empties.length === 0) {
                console.log('[播种] 没有可播种的空地')
                this.isFinished = true
                return
            }

            const sorted = this._orderPlotsBySweep(empties)
            const assignments = this._assignSeedToPlots(sorted)
            if (assignments.length === 0) {
                console.log('[播种] 种子分配为空（可能没有任何库存种子）')
                this.isFinished = true
                return
            }

            const perPlot = this.masterData.plantMsPerPlot || 1200
            const failCounts = new Map()
            let planted = 0
            let failed = 0
            let idx = 0
            let consecutiveMoveFails = 0
            let lastLayer = null

            while (idx < assignments.length) {
                const { area, seedName } = assignments[idx]
                const elapsed = Date.now() - this.startTime
                if (elapsed > this.timeBudgetMs) {
                    console.log('[播种] 达到时间预算，本轮结束')
                    break
                }
                if (!this.active || this.masterData.stopRequested) break

                // 饥饿中断（规则 8：饥饿值不低于 20%）
                const trigger = this.masterData.food.triggerPercent ?? 30
                if (this.bot.food < Math.ceil(20 * trigger / 100)) {
                    console.log(`[播种] 饥饿 ${this.bot.food}/20，中断播种先去进食`)
                    break
                }

                // 换层时重置连续移动失败计数
                if (area.soilPos.y !== lastLayer) {
                    lastLayer = area.soilPos.y
                    consecutiveMoveFails = 0
                }

                // 同一层连续移动失败 → 判定不可达，跳过该层剩余地块
                if (consecutiveMoveFails >= MOVE_FAIL_LAYER_SKIP) {
                    console.log(`[播种] 连续 ${consecutiveMoveFails} 次移动失败，跳过 Y=${lastLayer} 层剩余地块（可能不可达）`)
                    const skippedY = lastLayer
                    while (idx < assignments.length && assignments[idx].area.soilPos.y === skippedY) idx++
                    consecutiveMoveFails = 0
                    continue
                }

                // 每种种子的真实种植失败熔断（移动失败不占配额）
                if ((failCounts.get(seedName) || 0) >= SEED_FAIL_LIMIT) {
                    idx++
                    continue
                }

                const r = await this._plantOne(area, seedName)
                idx++
                if (r.ok) {
                    planted++
                    consecutiveMoveFails = 0
                } else {
                    failed++
                    if (r.kind === 'move') {
                        consecutiveMoveFails++
                        // 跨层移动失败：第一条打一次诊断，帮助定位层间过渡问题
                        if (area.soilPos.y !== Math.floor(this.bot.entity.position.y) &&
                            consecutiveMoveFails === 1) {
                            this._logLayerBoundaryDiagnostic(area)
                        }
                        if (consecutiveMoveFails === 1 || consecutiveMoveFails % 5 === 0) {
                            console.log(`[播种] 移动失败 @ (${area.soilPos.x},${area.soilPos.y},${area.soilPos.z}): ${r.reason}`)
                        }
                    } else {
                        consecutiveMoveFails = 0
                        const fails = failCounts.get(seedName) || 0
                        failCounts.set(seedName, fails + 1)
                        if (fails === 0 || fails % 5 === 0) {
                            console.log(`[播种] ${seedName} @ (${area.soilPos.x},${area.soilPos.y},${area.soilPos.z}) 失败: ${r.reason}`)
                        }
                        // 协议类失败记入黑名单，避免反复撞同一格
                        if (isProtocolPlantFailure(r.reason)) {
                            addPlantBlacklist(area, r.reason, this.masterData.plantProtocolBlacklist)
                        }
                    }
                }

                const done = planted + failed
                if (done % 20 === 0) {
                    console.log(`[播种] 进度 ${done}/${assignments.length}，成功 ${planted}`)
                }
                // 播种节奏：按 msPerPlot 配额 pacing（上限 5s 防手滑配置拖垮整轮）
                await sleep(Math.min(perPlot, 5000))
            }

            logImportant(`[播种] 本轮结束: 成功 ${planted}，失败 ${failed}` +
                (planted > 0 ? '' : '（若全部为移动失败，请查看日志文件中[播种][诊断]段落）'))
        } catch (e) {
            console.log(`[播种] 异常: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        // 【防重入】同上：置位后到转移前 update 仍会被反复调用，没闸门就会刷屏
        if (this.isFinished) return
        if (Date.now() - this.startTime > this.timeBudgetMs + 30000) {
            console.log('[播种] 超时兜底触发')
            stopMovement(this.bot)
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorPlantSeeds }
