const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    getStandCenterOnSoil, getSoilUnderFeet, isStandingOnSoil,
    moveToStandOnSoil, faceDownAtFeetFarmland, getFacingDiagnostics
} = require('../../../utils/movement')
const { scanFarmingAreas } = require('../../../utils/farmScan')
const { isPlantBlacklisted, addPlantBlacklist, isProtocolPlantFailure } = require('../../../utils/plantBlacklist')
const { isInWorkArea } = require('../config')

class BehaviorPlant {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'planting'
        this.active = false
        this.x = 500
        this.y = 400
        this.isFinished = false
        this.startTime = 0
        this.aborted = false
        this.runId = 0
        this.planting = false
    }

    onStateEntered() {
        this.runId += 1
        const runId = this.runId
        this.isFinished = false
        this.aborted = false
        this.startTime = Date.now()
        this.farmData.detailStatus = '种植中'
        stopMovement(this.bot)
        this.runPlant(runId)
    }

    onStateExited() {
        this.runId += 1
        this.aborted = true
        this.planting = false
        stopMovement(this.bot)
        this.farmData.detailStatus = ''
    }

    isRunActive(runId) {
        return this.runId === runId && this.active && !this.aborted && !this.farmData.stopRequested
    }

    areaKey(area) {
        return `${area.soilPos.x},${area.soilPos.z}`
    }

    findArea(farmingAreas, soilPos) {
        const key = `${soilPos.x},${soilPos.y},${soilPos.z}`
        return farmingAreas.get(key) ?? {
            soilPos,
            cropPos: soilPos.offset(0, 1, 0),
            hasCrop: false,
            isEmpty: true
        }
    }

    async prepareForPlanting(seedItem) {
        stopMovement(this.bot)
        if (this.bot.currentWindow) {
            try { this.bot.closeWindow(this.bot.currentWindow) } catch (e) { /* ignore */ }
        }
        await sleep(200)

        const seeds = this.bot.inventory.items().find(i => i.name === seedItem)
        if (!seeds) return false

        const hand = this.bot.heldItem
        if (!hand || hand.name !== seedItem) {
            try {
                await this.bot.equip(seeds, 'hand')
            } catch (e) {
                console.log(`[种植] 装备种子失败: ${e.message}`)
                return false
            }
        }

        await sleep(400)

        const after = this.bot.heldItem
        console.log(`[种植] 准备就绪 手持=${after ? `${after.name}x${after.count}` : '空'}`)
        return !!(after && after.name === seedItem)
    }

    async sendPlantPacket(soilBlock, cropPos, validCropBlocks, timeoutMs) {
        stopMovement(this.bot)
        await sleep(200)
        await this.bot.placeBlock(soilBlock, new Vec3(0, 1, 0))

        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            await sleep(200)
            const after = this.bot.blockAt(cropPos)
            if (after && validCropBlocks.includes(after.name)) return
        }
        throw new Error('placeBlock timeout')
    }

    async placeSeed(soilBlock, cropPos, validCropBlocks, seedItem, area, timeoutMs = 5000) {
        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            throw new Error(`未站上耕地 (${area.soilPos.x},${area.soilPos.z})`)
        }

        stopMovement(this.bot)

        for (let attempt = 0; attempt < 3; attempt++) {
            if (!isStandingOnSoil(this.bot, area.soilPos)) {
                const diag = this.getPlantDiagnostics(area, validCropBlocks, seedItem)
                throw new Error(`种植中被移动离开耕地 | ${diag}`)
            }

            const faced = await faceDownAtFeetFarmland(this.bot, area.soilPos, { retries: 3 })
            if (!faced) {
                throw new Error(`低头未对准脚下耕地 | ${getFacingDiagnostics(this.bot, area.soilPos)}`)
            }

            if (!isStandingOnSoil(this.bot, area.soilPos)) {
                const diag = this.getPlantDiagnostics(area, validCropBlocks, seedItem)
                throw new Error(`对准后被移动离开耕地 | ${diag}`)
            }

            const before = this.bot.blockAt(cropPos)
            try {
                await this.sendPlantPacket(soilBlock, cropPos, validCropBlocks, timeoutMs)
                return
            } catch (err) {
                await sleep(300)
                const after = this.bot.blockAt(cropPos)
                if (after && validCropBlocks.includes(after.name)) return

                if (!isStandingOnSoil(this.bot, area.soilPos)) {
                    const diag = this.getPlantDiagnostics(area, validCropBlocks, seedItem)
                    throw new Error(`placeBlock期间被移动离开 | ${diag}`)
                }

                if (attempt < 2) {
                    try {
                        await this.sendPlantPacket(soilBlock, cropPos, validCropBlocks, timeoutMs)
                        return
                    } catch (e) {
                        await sleep(300)
                        const retryBlock = this.bot.blockAt(cropPos)
                        if (retryBlock && validCropBlocks.includes(retryBlock.name)) return
                    }
                    continue
                }

                const diag = this.getPlantDiagnostics(area, validCropBlocks, seedItem)
                const beforeName = before ? before.name : 'null'
                const afterName = after ? after.name : 'null'

                if (err.message.includes('timeout')) {
                    throw new Error(
                        `placeBlock超时 | 放置前上方=${beforeName} 放置后上方=${afterName} | ${diag}`
                    )
                }
                throw new Error(`${err.message} | 放置前=${beforeName} 放置后=${afterName} | ${diag}`)
            }
        }
    }

    getPlantDiagnostics(area, validCropBlocks, seedItem) {
        const botPos = this.bot.entity.position
        const soil = this.bot.blockAt(area.soilPos)
        const above = this.bot.blockAt(area.cropPos)
        const hand = this.bot.heldItem
        const onFeet = isStandingOnSoil(this.bot, area.soilPos)

        const parts = [
            `土(${area.soilPos.x},${area.soilPos.y},${area.soilPos.z})`,
            `bot(${botPos.x.toFixed(1)},${botPos.y.toFixed(1)},${botPos.z.toFixed(1)})`,
            `站上=${onFeet ? '是' : '否'}`,
            `耕地=${soil ? soil.name : '未加载'}`,
            `上方=${above ? above.name : '未加载'}`,
            `手持=${hand ? `${hand.name}x${hand.count}` : '空'}`,
            getFacingDiagnostics(this.bot, area.soilPos)
        ]

        let cause = '未知'
        if (!soil) cause = '区块未加载'
        else if (soil.name !== 'farmland') cause = `不是耕地(${soil.name})`
        else if (above && validCropBlocks.includes(above.name)) cause = `已有作物(${above.name})`
        else if (above && above.name !== 'air') cause = `障碍(${above.name})`
        else if (!hand || hand.name !== seedItem) cause = `未持种子(需要${seedItem})`
        else if (!onFeet) cause = '未站上目标耕地'
        else {
            try {
                if (typeof this.bot.canPlaceBlock === 'function') {
                    const ok = this.bot.canPlaceBlock(soil, new Vec3(0, 1, 0))
                    cause = ok ? 'canPlaceBlock=true(可能协议超时)' : 'canPlaceBlock=false'
                } else {
                    cause = '表面可种(可能协议超时)'
                }
            } catch (e) {
                cause = `canPlaceBlock异常:${e.message}`
            }
        }

        parts.push(`原因=${cause}`)
        return parts.join(' | ')
    }

    canPlantAt(area, validCropBlocks) {
        const soil = this.bot.blockAt(area.soilPos)
        if (!soil) return { ok: false, reason: '区块未加载' }
        if (soil.name !== 'farmland') return { ok: false, reason: `非耕地(${soil.name})` }

        const above = this.bot.blockAt(area.cropPos)
        if (!above || above.name === 'air') return { ok: true }

        if (validCropBlocks.includes(above.name)) {
            return { ok: false, reason: `已有作物(${above.name})` }
        }

        return { ok: false, reason: `障碍(${above.name})` }
    }

    getPlantableEmpties(farmingAreas) {
        return Array.from(farmingAreas.values()).filter(a => {
            if (!a.isEmpty || a.hasCrop) return false
            const check = this.canPlantAt(a, this.farmData.validCropBlocks)
            return check.ok
        })
    }

    pickPlantTarget(empties, skipSet) {
        const botPos = this.bot.entity.position
        return empties
            .filter(a => !skipSet.has(this.areaKey(a)))
            .filter(a => !isPlantBlacklisted(a, this.farmData.plantProtocolBlacklist))
            .sort((a, b) =>
                botPos.distanceTo(getStandCenterOnSoil(a.soilPos)) -
                botPos.distanceTo(getStandCenterOnSoil(b.soilPos))
            )[0] ?? null
    }

    async plantOne(area, seedItem, validCropBlocks, currentCrop, runId) {
        if (!this.isRunActive(runId)) return false
        if (this.planting) return false

        const seeds = this.bot.inventory.items().find(it => it.name === seedItem)
        if (!seeds || seeds.count <= 0) return false

        if (!isStandingOnSoil(this.bot, area.soilPos)) {
            console.log(`[种植] 跳过 @ ${area.soilPos.x},${area.soilPos.z}: 未站上耕地 bot(${this.bot.entity.position.x.toFixed(1)},${this.bot.entity.position.z.toFixed(1)})`)
            return false
        }

        const hand = this.bot.heldItem
        if (!hand || hand.name !== seedItem) {
            try {
                await this.bot.equip(seeds, 'hand')
                await sleep(100)
            } catch (e) {
                console.log(`[种植] 重新装备种子失败: ${e.message}`)
                return false
            }
        }

        const check = this.canPlantAt(area, validCropBlocks)
        if (!check.ok) {
            console.log(`[种植] 跳过 @ ${area.soilPos.x},${area.soilPos.z}: ${check.reason}`)
            if (check.reason.includes('已有作物') || check.reason.includes('障碍')) {
                area.isEmpty = false
                area.hasCrop = check.reason.includes('已有作物')
            }
            return false
        }

        const soilBlock = this.bot.blockAt(area.soilPos)
        if (!soilBlock) {
            console.log(`[种植] 跳过 @ ${area.soilPos.x},${area.soilPos.z}: 耕地方块未加载`)
            return false
        }

        this.planting = true
        try {
            stopMovement(this.bot)
            await this.placeSeed(soilBlock, area.cropPos, validCropBlocks, seedItem, area)
            area.hasCrop = true
            area.isEmpty = false
            console.log(`[种植] 种下 ${currentCrop} @ ${area.soilPos.x},${area.cropPos.y},${area.soilPos.z} (脚下)`)
            return true
        } catch (e) {
            console.log(`[种植] 放置失败 @ ${area.soilPos.x},${area.soilPos.z}: ${e.message}`)
            if (isProtocolPlantFailure(e.message)) {
                addPlantBlacklist(area, '协议超时', this.farmData.plantProtocolBlacklist)
            }
            return false
        } finally {
            this.planting = false
        }
    }

    async runPlant(runId) {
        const MAX_TIME = 120000
        const { currentCrop, cropTypes, validCropBlocks, farmingAreas } = this.farmData
        const seedItem = currentCrop ? cropTypes[currentCrop] : null

        if (!seedItem) {
            console.log('[种植] 未设置作物类型')
            this.isFinished = true
            return
        }

        if (!this.bot.inventory.items().some(i => i.name === seedItem)) {
            console.log(`[种植] 没有 ${seedItem}`)
            this.isFinished = true
            return
        }

        if (!await this.prepareForPlanting(seedItem)) {
            console.log('[种植] 无法准备种植（种子未装备）')
            this.isFinished = true
            return
        }

        const skipSet = new Set()
        let totalPlanted = 0
        let moveFailStreak = 0

        while (true) {
            if (!this.isRunActive(runId)) break
            if (Date.now() - this.startTime > MAX_TIME) {
                console.log(`[种植] 达到时间上限(120s)，累计种植 ${totalPlanted} 株`)
                break
            }
            if (this.bot.food <= 6) break
            if (this.planting) {
                await sleep(100)
                continue
            }

            const stats = scanFarmingAreas(this.bot, this.farmData, isInWorkArea)
            const empties = this.getPlantableEmpties(farmingAreas)

            if (empties.length === 0) {
                console.log(`[种植] 没有更多可种空地 (耕地${stats.total} 障碍${stats.obstructedCount})`)
                break
            }

            this.farmData.detailStatus = `种植中 累计${totalPlanted} 剩余${empties.length}`

            const under = getSoilUnderFeet(this.bot)
            if (under) {
                const feetArea = this.findArea(farmingAreas, under.soilPos)
                const feetKey = this.areaKey(feetArea)
                const feetCheck = this.canPlantAt(feetArea, validCropBlocks)
                if (feetCheck.ok && !skipSet.has(feetKey) && !isPlantBlacklisted(feetArea, this.farmData.plantProtocolBlacklist)) {
                    if (await this.plantOne(feetArea, seedItem, validCropBlocks, currentCrop, runId)) {
                        totalPlanted++
                        moveFailStreak = 0
                        continue
                    }
                    if (isPlantBlacklisted(feetArea, this.farmData.plantProtocolBlacklist)) {
                        skipSet.add(feetKey)
                        continue
                    }
                }
            }

            const target = this.pickPlantTarget(empties, skipSet)
            if (!target) {
                const blacklisted = empties.filter(a => isPlantBlacklisted(a, this.farmData.plantProtocolBlacklist)).length
                if (blacklisted > 0) {
                    console.log(`[种植] ${blacklisted} 块地在协议黑名单中暂跳过 (LRU ${this.farmData.plantProtocolBlacklist.size}/100)`)
                }
                break
            }

            const key = this.areaKey(target)

            if (!isStandingOnSoil(this.bot, target.soilPos)) {
                stopMovement(this.bot)
                const moved = await moveToStandOnSoil(this.bot, target.soilPos, {
                    workAreaChecker: isInWorkArea,
                    timeoutMs: 10000
                }).catch(() => false)
                stopMovement(this.bot)

                if (!moved || !isStandingOnSoil(this.bot, target.soilPos)) {
                    skipSet.add(key)
                    moveFailStreak++
                    const p = this.bot.entity.position
                    console.log(`[种植] 无法站上 (${target.soilPos.x},${target.soilPos.z}) bot(${p.x.toFixed(1)},${p.z.toFixed(1)})`)
                    if (moveFailStreak >= 5) {
                        console.log('[种植] 连续5次移动失败，结束本轮')
                        break
                    }
                    continue
                }

                await this.prepareForPlanting(seedItem)
                moveFailStreak = 0
            }

            if (!isStandingOnSoil(this.bot, target.soilPos)) {
                console.log(`[种植] 未站上目标 (${target.soilPos.x},${target.soilPos.z})，重新移动`)
                continue
            }

            if (await this.plantOne(target, seedItem, validCropBlocks, currentCrop, runId)) {
                totalPlanted++
                moveFailStreak = 0
                continue
            }

            if (isPlantBlacklisted(target, this.farmData.plantProtocolBlacklist)) {
                console.log(`[种植] 跳过黑名单 (${target.soilPos.x},${target.soilPos.z})`)
                skipSet.add(key)
                continue
            }

            skipSet.add(key)
            moveFailStreak++
            if (moveFailStreak >= 8) {
                console.log('[种植] 连续跳过过多，结束本轮')
                break
            }
        }

        console.log(`[种植] 完成，本轮共种植 ${totalPlanted} 株`)
        if (this.runId === runId) {
            this.isFinished = true
        }
    }

    update() {
        if (Date.now() - this.startTime > 125000 && !this.isFinished) {
            console.log('[种植] 强制结束（超时保护）')
            this.runId += 1
            this.aborted = true
            this.planting = false
            stopMovement(this.bot)
            this.isFinished = true
        }
    }
}

module.exports = { BehaviorPlant }
