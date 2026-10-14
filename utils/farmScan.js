function isCropMature(block) {
    if (!block) return false
    // 【实测】1.21.11 里 getProperties().age 返回字符串 "0"~"7"（不是数字）。
    // 旧代码直接 `age >= 7` 靠 JS 隐式转换碰巧正确，这里显式转换以免将来翻车。
    const raw = block.getProperties?.()?.age ?? block.metadata
    const age = Number(raw)
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

/** 扫描并更新 farmData.farmingAreas，返回统计。
 * @param {object} options
 * @param {boolean} options.includeDirt 把被踩成 dirt 的耕地也纳入扫描（DaoXiang 规则 8：
 *   被踩坏的耕地要用锄头犁回。不开启则只认 farmland，与 FarmMaster 行为一致）。
 *   注意：dirt 只有出现在梯田层（workAreaChecker 含 y 校验）才算被踩坏的耕地。
 */
function scanFarmingAreas(bot, farmData, workAreaChecker = () => true, options = {}) {
    const farmingAreas = farmData.farmingAreas
    farmingAreas.clear()

    // maxDistance 48：机器人回拉杆/家位置等待时，到梯田远角的对角线距离约 33 格，
    // 用 32 会漏扫最远端 1~2 列地块（覆盖率/成熟度决策基于残缺数据）
    const farmBlocks = bot.findBlocks({
        matching: block => block.name === 'farmland' ||
            (options.includeDirt === true && block.name === 'dirt'),
        maxDistance: 48,
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
