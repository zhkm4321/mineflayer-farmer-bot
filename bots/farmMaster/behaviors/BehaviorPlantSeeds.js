const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    getStandCenterOnSoil, getSoilUnderFeet, isStandingOnSoil,
    moveToStandOnSoil, faceDownAtFeetFarmland
} = require('../../../utils/movement')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInWorkArea, isInPlantArea } = require('../config')

const HOE_NAME = 'stone_hoe'

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
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '播种中'
        this.run()
    }

    /**
     * 按高度分层排序空地，同层内按距离排序，然后按比例分配种子
     */
    _assignSeedToPlots(empties) {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []

        const totalRatio = seeds.reduce((sum, s) => sum + s.ratio, 0)
        if (totalRatio <= 0) return []

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

        const assignments = []
        let plotIndex = 0

        for (const seed of seeds) {
            const count = Math.round(sorted.length * seed.ratio / totalRatio)
            for (let i = 0; i < count && plotIndex < sorted.length; i++) {
                assignments.push({ area: sorted[plotIndex], seedName: seed.name })
                plotIndex++
            }
        }
        while (plotIndex < sorted.length) {
            assignments.push({ area: sorted[plotIndex], seedName: seeds[seeds.length - 1].name })
            plotIndex++
        }

        console.log(`[播种] 分层: ${sortedYLevels.map(y => `Y=${y}(${layers.get(y).length}块)`).join(' → ')}`)
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
        } catch {
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
            if (after?.name === 'farmland') {
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
        } catch {
            return false
        }
    }

    async _plantOne(area, seedName) {
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            stopMovement(this.bot)
            const moved = await moveToStandOnSoil(this.bot, area.soilPos, {
                workAreaChecker: isInPlantArea,
                timeoutMs: 10000
            }).catch(() => false)
            if (!moved || !isStandingOnSoil(this.bot, area.soilPos)) return false
        }

        if (this._needsTilling(area)) {
            const tilled = await this._tillDirt(area)
            if (!tilled) return false
        }

        if (!await this._equipSeed(seedName)) return false
        if (!this._canPlantAt(area)) return false

        stopMovement(this.bot)
        const faced = await faceDownAtFeetFarmland(this.bot, area.soilPos, { retries: 3, settleMs: 300 })
        if (!faced) return false
        if (!isStandingOnSoil(this.bot, area.soilPos)) return false

        const soilBlock = this.bot.blockAt(area.soilPos)
        if (!soilBlock || soilBlock.name !== 'farmland') return false

        try {
            stopMovement(this.bot)
            await sleep(100)
            await this.bot.placeBlock(soilBlock, new Vec3(0, 1, 0))
            await sleep(400)

            const after = this.bot.blockAt(area.cropPos)
            if (after && this.masterData.validCropBlocks.includes(after.name)) {
                area.hasCrop = true
                area.isEmpty = false
                return true
            }
            return false
        } catch {
            return false
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

    async run() {
        const MAX_TIME = 1800000
        try {
            const stats = scanFarmingAreas(this.bot, this.masterData, isInPlantArea)
            const farmlandEmpties = Array.from(this.masterData.farmingAreas.values())
                .filter(a => a.isEmpty && !a.hasCrop && this._canPlantAt(a))

            const dirtAreas = this._scanDirtBlocks()
            const empties = [...farmlandEmpties, ...dirtAreas]

            if (empties.length === 0) {
                console.log(`[播种] 没有空地 (耕地${stats.total}，待犁地${dirtAreas.length})`)
                this.isFinished = true
                return
            }

            if (dirtAreas.length > 0) {
                console.log(`[播种] 发现 ${dirtAreas.length} 块需要犁地的土地`)
            }

            const assignments = this._assignSeedToPlots(empties)
            console.log(`[播种] ${empties.length} 块空地，分配: ${this.masterData.seeds.map(s => `${s.name}(${s.ratio})`).join(', ')}`)

            let planted = 0
            let failStreak = 0
            let lastSeedName = null

            for (const { area, seedName } of assignments) {
                if (!this.active || this.masterData.stopRequested) break
                if (Date.now() - this.startTime > MAX_TIME) {
                    console.log(`[播种] 达到时间上限(3600s)`)
                    break
                }
                if (this.bot.food <= 6) break

                if (seedName !== lastSeedName) {
                    if (!await this._equipSeed(seedName)) {
                        console.log(`[播种] 没有种子 ${seedName}，跳过`)
                        continue
                    }
                    lastSeedName = seedName
                }

                if (await this._plantOne(area, seedName)) {
                    planted++
                    failStreak = 0
                    this.masterData.detailStatus = `播种 ${planted}/${assignments.length}`
                } else {
                    failStreak++
                    if (failStreak >= 8) {
                        console.log('[播种] 连续失败过多，结束')
                        break
                    }
                }

                await sleep(50)
            }

            const summary = this.masterData.seeds.map(s => {
                const cur = this.bot.inventory.items()
                    .filter(i => i.name === s.name)
                    .reduce((sum, i) => sum + i.count, 0)
                return `${s.name}:${cur}`
            }).join(', ')
            console.log(`[播种] 完成，种植 ${planted} 株，剩余种子: ${summary}`)
        } catch (e) {
            console.log(`[播种] 异常: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 185000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorPlantSeeds }
