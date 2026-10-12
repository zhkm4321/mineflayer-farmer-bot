/**
 * DaoXiang Web 状态页快照。只输出展示所需字段，不暴露 NBT/连接配置。
 */
function readDamageUsed(item) {
    if (Number.isFinite(item?.durabilityUsed)) return item.durabilityUsed

    // Minecraft 1.20.5+ 以 item component 储存损伤；26.1 SlotComponentType.damage = 3。
    const components = Array.isArray(item?.components) ? item.components : []
    const component = components.find(c =>
        c && (c.type === 3 || c.type === 'damage' || c.type === 'minecraft:damage')
    ) || item?.componentMap?.get?.(3) || item?.componentMap?.get?.('damage') ||
        item?.componentMap?.get?.('minecraft:damage')
    const componentValue = component?.data ?? component?.value ?? component?.damage
    if (Number.isFinite(componentValue)) return componentValue

    // 旧版 NBT：Damage 为 int tag。
    const nbtDamage = item?.nbt?.value?.Damage
    const nbtValue = nbtDamage && typeof nbtDamage === 'object' ? nbtDamage.value : nbtDamage
    if (Number.isFinite(nbtValue)) return nbtValue
    return null
}

function getItemDurability(item) {
    const max = Number.isFinite(item?.maxDurability) ? item.maxDurability : null
    if (max == null || max <= 0) return null
    const used = readDamageUsed(item)
    return {
        max,
        used,
        remaining: used == null ? null : Math.max(0, max - used),
        percent: used == null ? null : Math.max(0, Math.round((max - used) / max * 100))
    }
}

function buildDashboardStatus(bot, masterData) {
    const inventoryItems = bot?.inventory?.items?.() || []
    const counts = new Map()
    for (const item of inventoryItems) {
        const name = item.name || 'unknown'
        const entry = counts.get(name) || { name, displayName: item.displayName || name, count: 0 }
        entry.count += Number(item.count) || 0
        counts.set(name, entry)
    }

    const hoeName = masterData?.tools?.hoeItem || 'stone_hoe'
    const hoes = inventoryItems
        .filter(item => item.name === hoeName)
        .map(item => ({
            slot: Number.isFinite(item.slot) ? item.slot : null,
            count: Number(item.count) || 0,
            displayName: item.displayName || item.name,
            durability: getItemDurability(item)
        }))

    const pos = bot?.entity?.position
    return {
        updatedAt: Date.now(),
        online: !!(bot?.entity && bot?._client?.socket?.connected !== false),
        state: masterData?.detailStatus || '空闲',
        health: Number.isFinite(bot?.health) ? bot.health : null,
        maxHealth: Number.isFinite(bot?.maxHealth) ? bot.maxHealth : 20,
        food: Number.isFinite(bot?.food) ? bot.food : null,
        maxFood: 20,
        saturation: Number.isFinite(bot?.foodSaturation) ? bot.foodSaturation : null,
        position: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
        inventory: [...counts.values()].sort((a, b) => a.name.localeCompare(b.name)),
        hoe: {
            name: hoeName,
            count: hoes.reduce((sum, item) => sum + item.count, 0),
            items: hoes
        }
    }
}

module.exports = { readDamageUsed, getItemDurability, buildDashboardStatus }
