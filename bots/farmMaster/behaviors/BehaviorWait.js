class BehaviorWait {
    /**
     * @param {object} bot
     * @param {object} masterData
     * @param {function} getDurationSec - 返回等待秒数的函数（支持动态配置）
     * @param {string} label - 日志标签
     */
    constructor(bot, masterData, getDurationSec, label = '等待') {
        this.bot = bot
        this.masterData = masterData
        this.getDurationSec = getDurationSec
        this.label = label
        this.stateName = `wait_${label}`
        this.active = false
        this.x = 500
        this.y = 50
        this.isFinished = false
        this.startTime = 0
        this.durationMs = 0
        this.lastLog = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.durationMs = this.getDurationSec() * 1000
        this.lastLog = 0
        const sec = Math.round(this.durationMs / 1000)
        console.log(`[${this.label}] 开始等待 ${sec} 秒`)
        this.masterData.detailStatus = `${this.label} ${sec}s`
    }

    update() {
        const elapsed = Date.now() - this.startTime
        const remain = Math.max(0, Math.ceil((this.durationMs - elapsed) / 1000))

        if (elapsed - this.lastLog >= 10000) {
            console.log(`[${this.label}] 剩余 ${remain} 秒`)
            this.masterData.detailStatus = `${this.label} ${remain}s`
            this.lastLog = elapsed
        }

        if (elapsed >= this.durationMs) {
            console.log(`[${this.label}] 等待完成`)
            this.isFinished = true
        }
    }

    onStateExited() {
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorWait }
