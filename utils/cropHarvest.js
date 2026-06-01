const { stopMovement } = require('./movement')

/**
 * 收割作物 — 官方 mineflayer 用法
 * @see node_modules/mineflayer/examples/digger.js
 * @see node_modules/mineflayer/docs/api.md bot.dig
 */
async function digCropBlock(bot, cropPos) {
    stopMovement(bot)

    const block = bot.blockAt(cropPos)
    if (!block || block.name === 'air') {
        return { ok: false, reason: '无作物' }
    }

    if (bot.targetDigBlock) {
        return { ok: false, reason: '正在挖掘' }
    }

    if (!bot.canDigBlock(block)) {
        return { ok: false, reason: 'cannot dig' }
    }

    try {
        await bot.dig(block)
        return { ok: true }
    } catch (err) {
        return { ok: false, reason: (err.message || 'dig失败').slice(0, 60) }
    }
}

module.exports = { digCropBlock }
