const { Vec3 } = require('vec3')

/** 查找拉杆方块：优先按配置坐标精确读取；配置失效时在附近半径搜索。
 *  【统一入口】OperateLever 与 PlantSeeds 的规则 3 检查共用同一查找逻辑，
 *  避免出现"OperateLever 靠半径搜索拨对了拉杆、PlantSeeds 只看配置坐标
 *  误判为无拉杆/已关闭"的不一致。
 */
function findLeverBlock(bot, leverConfig) {
    if (!leverConfig) return null
    // 优先按配置坐标精确读取
    const configured = bot.blockAt(new Vec3(leverConfig.x, leverConfig.y, leverConfig.z))
    if (configured && configured.name === 'lever') return configured
    // 配置坐标失效时按半径搜索（配置可能没跟上地形改动）
    const found = bot.findBlock({
        matching: block => block.name === 'lever',
        maxDistance: 8,
        point: new Vec3(leverConfig.x, leverConfig.y, leverConfig.z)
    })
    if (found) {
        console.log(`[拉杆] 配置坐标无拉杆，在附近搜索到 (${found.position.x},${found.position.y},${found.position.z})`)
    }
    return found
}

/** 读取拉杆 powered 状态。
 *  【实测】prismarine-block getProperties() 对 bool 状态返回真布尔值（true/false），
 *  不是字符串 —— 旧代码 `=== 'true'` 恒为 false，曾导致"拨成功却判失败→重试拨回"的震荡。
 */
function isLeverPowered(leverBlock) {
    return leverBlock?.getProperties?.()?.powered === true
}

module.exports = { findLeverBlock, isLeverPowered }
