function plantAreaKey(area) {
    const p = area.soilPos
    return `${p.x},${p.y},${p.z}`
}

function isPlantBlacklisted(area, blacklistMap) {
    return blacklistMap.has(plantAreaKey(area))
}

function addPlantBlacklist(area, reason, blacklistMap) {
    const key = plantAreaKey(area)
    const already = blacklistMap.has(key)
    blacklistMap.set(key, reason)
    if (!already) {
        console.log(
            `[种植黑名单] 加入 (${area.soilPos.x},${area.soilPos.z}) ${reason}，` +
            `LRU ${blacklistMap.size}/100`
        )
    }
}

function isProtocolPlantFailure(message) {
    if (!message) return false
    if (message.includes('被移动离开') || message.includes('未站上耕地')) return false
    return message.includes('placeBlock超时') ||
        message.includes('协议超时') ||
        message.includes('canPlaceBlock=true')
}

module.exports = {
    plantAreaKey,
    isPlantBlacklisted,
    addPlantBlacklist,
    isProtocolPlantFailure
}
