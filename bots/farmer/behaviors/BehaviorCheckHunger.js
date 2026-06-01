class BehaviorCheckHunger {
    constructor(bot, farmData) {
        this.bot = bot
        this.farmData = farmData
        this.stateName = 'checkHunger'
        this.active = false
        this.x = 200
        this.y = 300
        this.needsFood = false
        this.checked = false
    }

    onStateEntered() {
        this.needsFood = this.bot.food < 14
        this.checked = true
        this.farmData.detailStatus = '检查饥饿'
    }

    update() {}

    onStateExited() {
        this.checked = false
    }
}

module.exports = { BehaviorCheckHunger }
