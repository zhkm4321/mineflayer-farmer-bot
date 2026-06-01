const {
    stopMovement, sleep, getStandCenterOnSoil,
    isStandingOnSoil, moveToStandOnSoil
} = require('../../../utils/movement')
const { hasSeedAvailable, tryPlantAtArea } = require('../../../utils/plantAction')
const { digCropBlock } = require('../../../utils/cropHarvest')
const { isInWorkArea } = require('../config')

class BehaviorHarvest {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'harvesting'
        this.active = false
        this.x = 500
        this.y = 200
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.farmData.detailStatus = '收割中'
        stopMovement(this.bot)
        this.runHarvest()
    }

    getMatureAreas(skipSet = new Set()) {
        const botPos = this.bot.entity.position
        return Array.from(this.farmData.farmingAreas.values())
            .filter(area => {
                const key = `${area.soilPos.x},${area.soilPos.z}`
                if (skipSet.has(key)) return false
                const crop = this.bot.blockAt(area.cropPos)
                if (!crop || crop.name === 'air') {
                    area.hasCrop = false
                    area.isEmpty = true
                    area.isMature = false
                    return false
                }
                return area.isMature
            })
            .sort((a, b) =>
                botPos.distanceTo(getStandCenterOnSoil(a.soilPos)) -
                botPos.distanceTo(getStandCenterOnSoil(b.soilPos))
            )
    }

    async harvestOne(area) {
        const cropBlock = this.bot.blockAt(area.cropPos)
        if (!cropBlock || cropBlock.name === 'air') {
            area.hasCrop = false
            area.isEmpty = true
            area.isMature = false
            return false
        }

        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            stopMovement(this.bot)
            const moved = await moveToStandOnSoil(this.bot, area.soilPos, {
                workAreaChecker: isInWorkArea,
                timeoutMs: 10000
            }).catch(() => false)
            if (!moved || !isStandingOnSoil(this.bot, area.soilPos)) {
                const p = this.bot.entity.position
                console.log(`[收割] 无法站上 (${area.soilPos.x},${area.soilPos.z}) bot(${p.x.toFixed(1)},${p.z.toFixed(1)})`)
                return false
            }
        }

        stopMovement(this.bot)

        const cropName = cropBlock.name
        const result = await digCropBlock(this.bot, area.cropPos)
        if (!result.ok) {
            console.log(`[收割] 失败 @ (${area.soilPos.x},${area.soilPos.z}): ${result.reason}`)
            return false
        }

        console.log(`[收割] 收割 ${cropName} @ ${area.soilPos.x},${area.cropPos.y},${area.soilPos.z}`)
        area.hasCrop = false
        area.isEmpty = true
        area.isMature = false
        return true
    }

    async runHarvest() {
        const MAX_TIME = 60000
        let harvestedCount = 0
        let failStreak = 0
        const skipSet = new Set()

        const initial = this.getMatureAreas(skipSet).length
        console.log(`[收割] 开始收割 ${initial} 株成熟作物`)

        while (true) {
            if (!this.active || this.farmData.stopRequested) break
            if (Date.now() - this.startTime > MAX_TIME) {
                console.log(`[收割] 达到时间上限(60s)，已收割 ${harvestedCount}/${initial}`)
                break
            }
            if (this.bot.food <= 6) {
                this.farmData.detailStatus = '饥饿，等待进食'
                break
            }

            const matureAreas = this.getMatureAreas(skipSet)
            if (matureAreas.length === 0) break

            const area = matureAreas[0]
            const areaKey = `${area.soilPos.x},${area.soilPos.z}`
            this.farmData.detailStatus = `收割 ${harvestedCount} 剩余${matureAreas.length}`

            try {
                const ok = await this.harvestOne(area)
                if (ok) {
                    harvestedCount++
                    failStreak = 0
                    await this.replantIfPossible(area)
                } else {
                    skipSet.add(areaKey)
                    failStreak++
                    if (failStreak >= 8) {
                        console.log('[收割] 连续失败过多，结束本轮')
                        break
                    }
                }
            } catch (e) {
                failStreak++
                console.log(`[收割] 失败 @ (${area.soilPos.x},${area.soilPos.z}): ${e.message}`)
                if (failStreak >= 8) break
            }

            await sleep(50)
        }

        console.log(`[收割] 完成，收割了 ${harvestedCount} 株`)
        this.isFinished = true
    }

    async replantIfPossible(area) {
        if (!this.active || this.farmData.stopRequested) return

        const { currentCrop, cropTypes } = this.farmData
        const seedItem = currentCrop ? cropTypes[currentCrop] : null
        if (!seedItem || !hasSeedAvailable(this.bot, seedItem)) return

        stopMovement(this.bot)
        const planted = await tryPlantAtArea(this.bot, area, this.farmData, {
            moveIfNeeded: false,
            placeTimeoutMs: 4000
        })
        if (planted) {
            console.log(`[收割] 补种 ${currentCrop} @ ${area.soilPos.x},${area.cropPos.y},${area.soilPos.z}`)
        }
    }

    update() {
        if (Date.now() - this.startTime > 65000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.farmData.detailStatus = ''
    }
}

module.exports = { BehaviorHarvest }
