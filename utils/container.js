const { Vec3 } = require('vec3')
const { Movements, goals } = require('mineflayer-pathfinder')
const { approachChest, sleep, isNearBlock, pathfinderGoto } = require('./movement')

const FACE_OFFSETS = [
    new Vec3(1, 0, 0),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(0, 0, -1),
]

/**
 * 打开箱子/容器
 * 优先使用 GoalLookAtBlock 走到能看到箱子面的位置；
 * 若失败则逐一尝试四个水平相邻位置。
 * @see mineflayer API: bot.openContainer(containerBlock, direction?, cursorPos?)
 * @see mineflayer-pathfinder GoalLookAtBlock — "Path into a position where a blockface is visible"
 */
async function openChestContainer(bot, block, options = {}) {
    const timeoutMs = options.timeoutMs ?? 20000
    const pos = block.position

    if (bot.currentWindow) {
        try { bot.closeWindow(bot.currentWindow) } catch {}
        await sleep(200)
    }

    const deadline = Date.now() + timeoutMs

    // 第一步：用 GoalLookAtBlock 让 pathfinder 自动选择能看到箱子面的位置
    try {
        await approachChest(bot, pos, Math.min(Math.floor(timeoutMs / 2), 8000))
    } catch (e) {
        console.log(`[箱子] GoalLookAtBlock 失败: ${e.message}，将尝试四面靠近`)
    }

    // 检查是否已可交互。
    // 【重要】bot.openContainer 内部固定等 windowOpen 20 秒（mineflayer 的 once() 默认值，
    // 且 openBlock 不暴露 timeout 参数），这个 20s 会吃掉整个预算，导致下面"四面靠近"的兜底
    // 因为 remain < 3000 一次都跑不到。所以这里必须自己加 race 把单次开箱压到 6 秒。
    const tryOpen = async (openTimeoutMs = 6000) => {
        bot.clearControlStates()
        await sleep(200)
        if (!isNearBlock(bot, pos, 4.5)) return null
        await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)
        await sleep(100)
        let timer = null
        try {
            return await Promise.race([
                bot.openContainer(block),
                new Promise((resolve) => {
                    timer = setTimeout(() => resolve(null), openTimeoutMs)
                })
            ])
        } finally {
            if (timer) clearTimeout(timer)
        }
    }

    if (isNearBlock(bot, pos, 4.5)) {
        const remainFirst = Math.max(4000, Math.min(6000, deadline - Date.now()))
        try {
            const w = await tryOpen(remainFirst)
            if (w) return w
            console.log(`[箱子] 当前位置开箱超时(${Math.round(remainFirst / 1000)}s)，转为四面靠近`)
        } catch (e) {
            console.log(`[箱子] 当前位置开箱失败: ${e.message}`)
        }
    }

    // 第二步：逐一尝试箱子四个水平相邻位置
    const botPos = bot.entity.position
    const sortedFaces = FACE_OFFSETS
        .map(offset => ({
            offset,
            standPos: pos.plus(offset),
            dist: botPos.distanceTo(pos.plus(offset).offset(0.5, 0.5, 0.5))
        }))
        .filter(({ standPos }) => {
            const atFeet = bot.blockAt(standPos)
            const above = bot.blockAt(standPos.offset(0, 1, 0))
            const passable = (!atFeet || atFeet.boundingBox === 'empty')
                && (!above || above.boundingBox === 'empty')
            if (!passable) {
                console.log(`[箱子] 面 (${standPos.x},${standPos.z}) 被 ${atFeet?.name || '?'} 阻挡，跳过`)
            }
            return passable
        })
        .sort((a, b) => a.dist - b.dist)

    for (const { standPos } of sortedFaces) {
        const remain = deadline - Date.now()
        if (remain < 6000) break

        console.log(`[箱子] 尝试从 (${standPos.x},${standPos.y},${standPos.z}) 靠近箱子`)
        bot.clearControlStates()

        try {
            await pathfinderGoto(
                bot,
                new goals.GoalNear(standPos.x + 0.5, standPos.y, standPos.z + 0.5, 1),
                Math.min(remain - 5000, 12000)
            )
        } catch (e) {
            console.log(`[箱子] 寻路到 (${standPos.x},${standPos.z}) 失败: ${e.message}`)
            continue
        }

        try {
            const w = await tryOpen(Math.min(6000, Math.max(4000, deadline - Date.now())))
            if (w) return w
        } catch (e) {
            console.log(`[箱子] 在 (${standPos.x},${standPos.z}) 开箱失败: ${e.message}`)
        }
    }

    const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)).toFixed(1)
    throw new Error(`无法打开箱子(距${dist}格)`)
}

module.exports = { openChestContainer }
