const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../utils/movement')

/** 面包搜索接受的容器（木箱/陷阱箱/木桶） */
const BREAD_CONTAINER_KINDS = ['chest', 'trapped_chest', 'barrel']
/** 锄头搜索接受的容器（规则 8：石锄放木箱；木桶只放种子） */
const HOE_CONTAINER_KINDS = ['chest', 'trapped_chest']

/**
 * 取补给容器候选列表（按距离排序）。
 * 半径搜索为主；配置的 supplyChest 锚点无条件追加（去重），
 * 保证半径外的补给箱也不会被漏掉。
 * 半径内一个容器都没有、且锚点较远（>16 格）时，先走近锚点再重扫 ——
 * 否则 openChestContainer 的短程寻路预算够不到远距离锚点。
 * @param {string[]} kinds 允许的容器方块名
 */
async function findSupplyContainers(bot, masterData, kinds, radius) {
    const anchor = masterData.supplyChest
    const anchorPos = anchor
        ? new Vec3(anchor.x, anchor.y, anchor.z)
        : null

    const anchorValid = () => {
        if (!anchorPos) return false
        const b = bot.blockAt(anchorPos)
        return !!(b && kinds.includes(b.name))
    }

    const scan = () => {
        const found = (bot.findBlocks({
            matching: b => kinds.includes(b.name),
            maxDistance: radius,
            count: 10
        }) || []).slice()
        if (anchorValid() && !found.some(q => q.equals(anchorPos))) {
            found.push(anchorPos.clone())
        }
        return found.sort((a, b) =>
            bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
        )
    }

    let containers = scan()
    if (anchorValid()) {
        const dist = bot.entity.position.distanceTo(anchorPos)
        const radiusFound = containers.filter(p => !p.equals(anchorPos))
        if (radiusFound.length === 0 && dist > 16) {
            console.log(`[补给箱] 附近没有可用容器，前往配置补给箱 (${anchor.x},${anchor.y},${anchor.z})`)
            stopMovement(bot)
            try {
                await pathfinderGoto(bot, new goals.GoalNearXZ(anchor.x, anchor.z, 3), 45000)
            } catch (e) {
                console.log(`[补给箱] 前往补给箱失败: ${e.message}`)
            }
            await sleep(300)
            containers = scan()
        }
    }
    return containers
}

module.exports = { findSupplyContainers, BREAD_CONTAINER_KINDS, HOE_CONTAINER_KINDS }
