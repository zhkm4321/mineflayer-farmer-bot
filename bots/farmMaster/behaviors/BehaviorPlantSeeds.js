const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    getStandCenterOnSoil, getSoilUnderFeet, isStandingOnSoil,
    moveToStandOnSoil, faceDownAtFeetFarmland
} = require('../../../utils/movement')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isInWorkArea } = require('../config')

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

    _assignSeedToPlots(empties) {
        const seeds = this.masterData.seeds
        if (!seeds || seeds.length === 0) return []

        const totalRatio = seeds.reduce((sum, s) => sum + s.ratio, 0)
        if (totalRatio <= 0) return []

        const botPos = this.bot.entity.position
        const sorted = empties.sort((a, b) =>
            botPos.distanceTo(getStandCenterOnSoil(a.soilPos)) -
            botPos.distanceTo(getStandCenterOnSoil(b.soilPos))
        )

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

        return assignments
    }

    _canPlantAt(area) {
        const soil = this.bot.blockAt(area.soilPos)
        if (!soil || soil.name !== 'farmland') return false
        const above = this.bot.blockAt(area.cropPos)
        return !above || above.name === 'air'
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
                workAreaChecker: isInWorkArea,
                timeoutMs: 10000
            }).catch(() => false)
            if (!moved || !isStandingOnSoil(this.bot, area.soilPos)) return false
        }

        if (!await this._equipSeed(seedName)) return false
        if (!this._canPlantAt(area)) return false

        stopMovement(this.bot)
        const faced = await faceDownAtFeetFarmland(this.bot, area.soilPos, { retries: 3, settleMs: 300 })
        if (!faced) return false
        if (!isStandingOnSoil(this.bot, area.soilPos)) return false

        const soilBlock = this.bot.blockAt(area.soilPos)
        if (!soilBlock) return false

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

    async run() {
        const MAX_TIME = 3600000
        try {
            const stats = scanFarmingAreas(this.bot, this.masterData, isInWorkArea)
            const empties = Array.from(this.masterData.farmingAreas.values())
                .filter(a => a.isEmpty && !a.hasCrop && this._canPlantAt(a))

            if (empties.length === 0) {
                console.log(`[播种] 没有空地 (耕地${stats.total})`)
                this.isFinished = true
                return
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
