const { Vec3 } = require('vec3')
const {
    sleep, stopMovement,
    isStandingOnSoil, moveToStandOnSoil, faceDownAtFeetFarmland
} = require('./movement')

function hasSeedAvailable(bot, seedItem) {
    if (bot.heldItem?.name === seedItem) return true
    return bot.inventory.items().some(i => i.name === seedItem)
}

async function ensureSeedInHand(bot, seedItem) {
    if (bot.heldItem?.name === seedItem) return true

    const seeds = bot.inventory.items().find(i => i.name === seedItem)
    if (!seeds) return false

    try {
        await bot.equip(seeds, 'hand')
        await sleep(100)
        return bot.heldItem?.name === seedItem
    } catch {
        return false
    }
}

function canPlantAt(bot, area, validCropBlocks) {
    const soil = bot.blockAt(area.soilPos)
    if (!soil) return { ok: false, reason: '区块未加载' }
    if (soil.name !== 'farmland') return { ok: false, reason: `非耕地(${soil.name})` }

    const above = bot.blockAt(area.cropPos)
    if (!above || above.name === 'air') return { ok: true }

    if (validCropBlocks.includes(above.name)) {
        return { ok: false, reason: `已有作物(${above.name})` }
    }

    return { ok: false, reason: `障碍(${above.name})` }
}

async function placeSeedQuick(bot, soilBlock, cropPos, validCropBlocks, area, timeoutMs = 4000) {
    if (!isStandingOnSoil(bot, area.soilPos)) return false

    stopMovement(bot)
    const faced = await faceDownAtFeetFarmland(bot, area.soilPos, { retries: 2, settleMs: 200 })
    if (!faced) return false

    if (!isStandingOnSoil(bot, area.soilPos)) return false

    try {
        stopMovement(bot)
        await sleep(100)
        await bot.placeBlock(soilBlock, new Vec3(0, 1, 0))
        await sleep(400)
    } catch {
        await sleep(200)
    }

    const after = bot.blockAt(cropPos)
    return !!(after && validCropBlocks.includes(after.name))
}

/** 在指定耕地格补种一颗（背包或手持有对应种子时） */
async function tryPlantAtArea(bot, area, farmData, options = {}) {
    const { currentCrop, cropTypes, validCropBlocks } = farmData
    const seedItem = currentCrop ? cropTypes[currentCrop] : null
    if (!seedItem || !hasSeedAvailable(bot, seedItem)) return false

    const check = canPlantAt(bot, area, validCropBlocks)
    if (!check.ok) return false

    const soilBlock = bot.blockAt(area.soilPos)
    if (!soilBlock) return false

    stopMovement(bot)

    if (!isStandingOnSoil(bot, area.soilPos)) {
        if (options.moveIfNeeded === false) return false
        const moved = await moveToStandOnSoil(bot, area.soilPos, {
            workAreaChecker: options.workAreaChecker,
            timeoutMs: options.moveTimeoutMs ?? 5000
        }).catch(() => false)
        if (!moved || !isStandingOnSoil(bot, area.soilPos)) return false
    }

    if (!await ensureSeedInHand(bot, seedItem)) return false

    const planted = await placeSeedQuick(
        bot, soilBlock, area.cropPos, validCropBlocks, area, options.placeTimeoutMs ?? 4000
    )
    if (planted) {
        area.hasCrop = true
        area.isEmpty = false
        area.isMature = false
    }
    return planted
}

module.exports = {
    hasSeedAvailable,
    ensureSeedInHand,
    canPlantAt,
    tryPlantAtArea
}
