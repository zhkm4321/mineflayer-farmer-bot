function isCropMature(block) {
    if (!block) return false
    const age = block.getProperties?.()?.age ?? block.metadata
    switch (block.name) {
        case 'wheat':
        case 'carrots':
        case 'potatoes':
            return age >= 7
        case 'beetroots':
            return age >= 3
        default:
            return false
    }
}

function getCropType(block) {
    switch (block.name) {
        case 'wheat': return 'wheat'
        case 'carrots': return 'carrot'
        case 'potatoes': return 'potato'
        case 'beetroots': return 'beetroot'
        default: return null
    }
}

/** 扫描并更新 farmData.farmingAreas，返回统计 */
function scanFarmingAreas(bot, farmData, workAreaChecker = () => true) {
    const farmingAreas = farmData.farmingAreas
    farmingAreas.clear()

    const farmBlocks = bot.findBlocks({
        matching: block => block.name === 'farmland',
        maxDistance: 32,
        count: 1500
    }).filter(pos => workAreaChecker(pos))

    let obstructedCount = 0

    for (const soilPos of farmBlocks) {
        const cropPos = soilPos.offset(0, 1, 0)
        const cropBlock = bot.blockAt(cropPos)
        const key = `${soilPos.x},${soilPos.y},${soilPos.z}`

        const hasCrop = cropBlock && farmData.validCropBlocks.includes(cropBlock.name)
        const isObstructed = cropBlock && cropBlock.name !== 'air' && !hasCrop
        const isEmpty = !cropBlock || cropBlock.name === 'air'
        const isMature = hasCrop && isCropMature(cropBlock)

        if (isObstructed) obstructedCount++

        farmingAreas.set(key, {
            soilPos,
            cropPos,
            hasCrop,
            isEmpty: isEmpty && !isObstructed,
            isObstructed,
            obstructBlock: isObstructed ? cropBlock.name : null,
            isMature,
            cropType: hasCrop ? getCropType(cropBlock) : null
        })
    }

    const areas = Array.from(farmingAreas.values())
    const emptyCount = areas.filter(a => a.isEmpty).length
    const blacklist = farmData.plantProtocolBlacklist
    const blacklistedEmptyCount = areas.filter(a =>
        a.isEmpty && blacklist.has(`${a.soilPos.x},${a.soilPos.y},${a.soilPos.z}`)
    ).length

    return {
        total: farmBlocks.length,
        matureCount: areas.filter(a => a.isMature).length,
        emptyCount,
        plantableEmptyCount: emptyCount - blacklistedEmptyCount,
        obstructedCount
    }
}

module.exports = { scanFarmingAreas, isCropMature, getCropType }
