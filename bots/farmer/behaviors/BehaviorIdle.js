class BehaviorIdle {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'idle'
        this.active = false
        this.x = 50
        this.y = 300
        this.isReady = false
        this.enterTime = 0
    }

    onStateEntered() {
        this.isReady = false
        this.enterTime = Date.now()
        this.farmData.detailStatus = '等待中'
    }

    update() {
        if (Date.now() - this.enterTime >= 5000) {
            this.isReady = true
        }
    }

    onStateExited() {
        this.isReady = false
        this.farmData.detailStatus = ''
    }
}

module.exports = { BehaviorIdle }
