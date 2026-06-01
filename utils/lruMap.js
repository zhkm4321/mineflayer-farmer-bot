/** 简单 LRU Map：超出容量时淘汰最久未访问项 */
class LRUMap {
    constructor(maxSize = 100) {
        this.maxSize = maxSize
        this.map = new Map()
    }

    _touch(key, entry) {
        this.map.delete(key)
        entry.lastAccessAt = Date.now()
        this.map.set(key, entry)
    }

    get(key) {
        const entry = this.map.get(key)
        if (!entry) return undefined
        this._touch(key, entry)
        return entry.value
    }

    has(key) {
        return this.map.has(key)
    }

    set(key, value) {
        const now = Date.now()
        if (this.map.has(key)) {
            const entry = this.map.get(key)
            entry.value = value
            entry.addedAt = now
            this._touch(key, entry)
            return
        }

        this.map.set(key, { value, addedAt: now, lastAccessAt: now })
        while (this.map.size > this.maxSize) {
            const oldestKey = this.map.keys().next().value
            this.map.delete(oldestKey)
        }
    }

    delete(key) {
        return this.map.delete(key)
    }

    get size() {
        return this.map.size
    }

    /** 清理 addedAt 超过 maxAgeMs 的条目 */
    purgeOlderThan(maxAgeMs) {
        const now = Date.now()
        let removed = 0
        for (const [key, entry] of this.map) {
            if (now - entry.addedAt > maxAgeMs) {
                this.map.delete(key)
                removed++
            }
        }
        return removed
    }
}

module.exports = { LRUMap }
