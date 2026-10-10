const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    getStandCenterOnSoil, isStandingOnSoil,
    moveToStandOnSoil, faceDownAtFeetFarmland
} = require('../../../utils/movement')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isPlantBlacklisted, addPlantBlacklist, isProtocolPlantFailure } = require('../../../utils/plantBlacklist')
const { isInPlantArea } = require('../config')

const HOE_NAME = 'stone_hoe'
// 同一种作物连续失败达到该次数后，放弃它本轮剩余地块（不影响其他作物）
const SEED_FAIL_LIMIT = 8
const MIN_TIME_BUDGET_MS = 60000
const DEFAULT_MS_PER_PLOT = 1200

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
        this.timeBudgetMs = MIN_TIME_BUDGET_MS
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '播种中'
        this.run()
    }

    /**
     * 最大余数法（Hamilton）按 ratio 把 total 块地分给各作物。
     * 保证 sum(counts) === total，且余数按小数部分大小分配，不会全堆给最后一种作物。
     */
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

    /** 按高度分层排序空地：优先离 bot 最近的层，层内按距离排序 */
    _sortPlotsByLayer(empties) {
        const botY = Math.floor(this.bot.entity.position.y)
        const botPos = this.bot.entity.position

        const layers = new Map()
        for (const area of empties) {
            const y = area.soilPos.y
            if (!layers.has(y)) layers.set(y, [])
            layers.get(y).push(area)
        }

        const sortedYLevels = [...layers.keys()].sort((a, b) =>
            Math.abs(a - botY) - Math.abs(b - botY) || a - b
        )

        const sorted = []
        for (const y of sortedYLevels) {
            const layer = layers.get(y)
            layer.sort((a, b) =>
                botPos.distanceTo(getStandCenterOnSoil(a.soilPos)) -
                botPos.distanceTo(getStandCenterOnSoil(b.soilPos))
            )
            sorted.push(...layer)
        }

        console.log(`[播种] 分层: ${sortedYLevels.map(y => `Y=${y}(${layers.get(y).length}块)`).join(' → ')}`)
        return sorted
    }

    /**
     * 生成 (地块, 作物) 分配表。
     * 分层排序决定地块先后，再按配额交错落位 —— 避免同一作物扎堆成一大片。
     */
    _assignSeedToPlots(empties) {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []

        const sorted = this._sortPlotsByLayer(empties)
        const counts = this._allocateCounts(sorted.length, seeds)
        const remaining = counts.slice()

        console.log(`[播种] 配额: ${seeds.map((s, i) => `${s.name}=${counts[i]}`).join(', ')} (共${sorted.length}块)`)

        const assignments = []
        let idx = 0
        while (idx < sorted.length) {
            let progressed = false
            for (let si = 0; si < seeds.length; si++) {
                if (remaining[si] <= 0) continue
                assignments.push({ area: sorted[idx++], seedName: seeds[si].name })
                remaining[si]--
                progressed = true
                if (idx >= sorted.length) break
            }
            if (!progressed) break
        }
        return assignments
    }

    _canPlantAt(area) {
        const soil = this.bot.blockAt(area.soilPos)
        if (!soil || (soil.name !== 'farmland' && soil.name !== 'dirt')) return false
        const above = this.bot.blockAt(area.cropPos)
        return !above || above.name === 'air'
    }

    _needsTilling(area) {
        const soil = this.bot.blockAt(area.soilPos)
        return soil?.name === 'dirt'
    }

    async _equipHoe() {
        const hoe = this.bot.inventory.items().find(i => i.name === HOE_NAME)
        if (!hoe) return false
        if (this.bot.heldItem?.name === HOE_NAME) return true
        try {
            await this.bot.equip(hoe, 'hand')
            await sleep(100)
            return this.bot.heldItem?.name === HOE_NAME
        } catch (e) {
            return false
        }
    }

    async _tillDirt(area) {
        if (!await this._equipHoe()) {
            console.log('[播种] 没有锄头，无法犁地')
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
            return after?.name === 'farmland'
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
     * @returns {Promise<{ok: boolean, reason?: string}>} 失败原因用于分类是否加入协议黑名单
     */
    async _plantOne(area, seedName) {
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            stopMovement(this.bot)
            const moved = await moveToStandOnSoil(this.bot, area.soilPos, {
                workAreaChecker: isInPlantArea,
                timeoutMs: 10000
            }).catch(() => false)
            if (!moved || !isStandingOnSoil(this.bot, area.soilPos)) {
                // 用"未站上耕地"措辞，isProtocolPlantFailure 会把它排除在黑名单之外
                return { ok: false, reason: '未站上耕地(移动失败)' }
            }
        }

        if (this._needsTilling(area)) {
            const tilled = await this._tillDirt(area)
            if (!tilled) return { ok: false, reason: '犁地失败' }
        }

        if (!await this._equipSeed(seedName)) {
            return { ok: false, reason: `没有种子(${seedName})` }
        }
        if (!this._canPlantAt(area)) {
            return { ok: false, reason: '目标不可种植' }
        }

        stopMovement(this.bot)
        const faced = await faceDownAtFeetFarmland(this.bot, area.soilPos, { retries: 3, settleMs: 300 })
        if (!faced) return { ok: false, reason: 'placeBlock超时(低头未对准脚下耕地)' }
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            return { ok: false, reason: '种植中被移动离开耕地' }
        }

        const soilBlock = this.bot.blockAt(area.soilPos)
        if (!soilBlock || soilBlock.name !== 'farmland') {
            return { ok: false, reason: '耕地方块异常' }
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
            return { ok: false, reason: 'placeBlock超时(放置后未见作物)' }
        } catch (e) {
            return { ok: false, reason: `placeBlock超时(${e.message || '异常'})` }
        }
    }

    _scanDirtBlocks() {
        const dirtBlocks = this.bot.findBlocks({
            matching: block => block.name === 'dirt',
            maxDistance: 32,
            count: 500
        }).filter(pos => isInPlantArea(pos))

        const dirtAreas = []
        for (const soilPos of dirtBlocks) {
            const cropPos = soilPos.offset(0, 1, 0)
            const cropBlock = this.bot.blockAt(cropPos)
            const isEmpty = !cropBlock || cropBlock.name === 'air'
            if (isEmpty) {
                dirtAreas.push({
                    soilPos,
                    cropPos,
                    hasCrop: false,
                    isEmpty: true,
                    needsTilling: true
                })
            }
        }
        return dirtAreas
    }

    _computeTimeBudget(plotCount) {
        const perPlot = this.masterData.plantMsPerPlot || DEFAULT_MS_PER_PLOT
        const maxMs = this.masterData.plantMaxTimeMs || 1800000
        return Math.min(maxMs, Math.max(MIN_TIME_BUDGET_MS, plotCount * perPlot))
    }

    async run() {
        try {
            const stats = scanFarmingAreas(this.bot, this.masterData, isInPlantArea)
            const farmlandEmpties = Array.from(this.masterData.farmingAreas.values())
                .filter(a => a.isEmpty && !a.hasCrop && this._canPlantAt(a))

            const dirtAreas = this._scanDirtBlocks()
            const allEmpties = [...farmlandEmpties, ...dirtAreas]

            const blacklist = this.masterData.plantProtocolBlacklist
            const empties = allEmpties.filter(a => !isPlantBlacklisted(a, blacklist))
            const blacklisted = allEmpties.length - empties.length
            if (blacklisted > 0) {
                console.log(`[播种] 跳过 ${blacklisted} 块协议黑名单地块 (LRU ${blacklist.size}/100)`)
            }

            if (empties.length === 0) {
                console.log(`[播种] 没有可种空地 (耕地${stats.total}，待犁地${dirtAreas.length}，黑名单${blacklisted})`)
                this.isFinished = true
                return
            }

            if (dirtAreas.length > 0) {
                console.log(`[播种] 发现 ${dirtAreas.length} 块需要犁地的土地`)
            }

            const assignments = this._assignSeedToPlots(empties)
            this.timeBudgetMs = this._computeTimeBudget(assignments.length)
            console.log(`[播种] ${empties.length} 块空地，分配: ${this.masterData.seeds.map(s => `${s.name}(${s.ratio})`).join(', ')}，本轮预算 ${Math.round(this.timeBudgetMs / 1000)}s`)

            let planted = 0
            let lastSeedName = null
            const seedFailStreak = new Map()
            const giveUp = new Set()

            for (const { area, seedName } of assignments) {
                if (!this.active || this.masterData.stopRequested) break
                if (Date.now() - this.startTime > this.timeBudgetMs) {
                    console.log(`[播种] 达到本轮时间预算 ${Math.round(this.timeBudgetMs / 1000)}s，剩余地块下轮继续`)
                    break
                }
                if (this.bot.food <= 6) break
                if (giveUp.has(seedName)) continue

                if (seedName !== lastSeedName) {
                    if (!await this._equipSeed(seedName)) {
                        console.log(`[播种] 没有种子 ${seedName}，放弃该作物本轮地块`)
                        giveUp.add(seedName)
                        continue
                    }
                    lastSeedName = seedName
                }

                const result = await this._plantOne(area, seedName)

                if (result.ok) {
                    planted++
                    seedFailStreak.set(seedName, 0)
                    this.masterData.detailStatus = `播种 ${planted}/${assignments.length}`
                } else {
                    const fails = (seedFailStreak.get(seedName) || 0) + 1
                    seedFailStreak.set(seedName, fails)

                    // 仅把"协议超时"类失败加入黑名单；移动失败等可恢复问题不入黑名单
                    if (isProtocolPlantFailure(result.reason)) {
                        addPlantBlacklist(area, result.reason.slice(0, 24), this.masterData.plantProtocolBlacklist)
                    }

                    if (fails === 1 || fails % 5 === 0) {
                        console.log(`[播种] 失败 (${area.soilPos.x},${area.soilPos.z}) ${seedName}: ${result.reason} [连续${fails}]`)
                    }

                    if (fails >= SEED_FAIL_LIMIT) {
                        console.log(`[播种] ${seedName} 连续失败 ${fails} 次，放弃该作物本轮剩余地块`)
                        giveUp.add(seedName)
                    }
                }

                await sleep(50)
            }

            const summary = this.masterData.seeds.map(s => `${s.name}:${this._countSeed(s.name)}`).join(', ')
            const gaveUp = giveUp.size > 0 ? `，放弃作物: ${[...giveUp].join('/')}` : ''
            console.log(`[播种] 完成，种植 ${planted} 株，剩余种子: ${summary}${gaveUp}`)
        } catch (e) {
            console.log(`[播种] 异常: ${e.message}`)
        }
        this.isFinished = true
    }

    _countSeed(name) {
        return this.bot.inventory.items()
            .filter(i => i.name === name)
            .reduce((sum, i) => sum + i.count, 0)
    }

    update() {
        if (!this.isFinished && Date.now() - this.startTime > this.timeBudgetMs + 5000) {
            console.log('[播种] 超时保护结束')
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorPlantSeeds }
