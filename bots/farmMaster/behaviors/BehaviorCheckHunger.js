class BehaviorCheckHunger {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'checkHunger'
        this.active = false
        this.x = 100
        this.y = 50
        this.needsFood = false
        this.checked = false
    }

    onStateEntered() {
        this.needsFood = this.bot.food < 14
        this.checked = true
        this.masterData.detailStatus = '检查饥饿'
    }

    update() {}

    onStateExited() {
        this.checked = false
    }
}

module.exports = { BehaviorCheckHunger }
