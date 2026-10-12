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
        this.enteredAt = 0
    }

    onStateEntered() {
        this.needsFood = this.bot.food < 14
        // 不在这里放行：必须先满足最小驻留时间（见 update），否则流程环路会零间隔自转
        this.checked = false
        this.enteredAt = Date.now()
        this.masterData.detailStatus = '检查饥饿'
    }

    update() {
        // 本状态是流程环路必经的枢纽（所有失败兜底都会回到这里重新决策）。
        // 若瞬间放行，"getSeeds → gotoPos1 → checkHunger → getSeeds"这类环路会
        // 以接近零的间隔无限自转 —— 这里强制至少停留 1 秒后才给出判定。
        if (Date.now() - this.enteredAt < 1000) return
        this.checked = true
    }

    onStateExited() {
        this.checked = false
    }
}

module.exports = { BehaviorCheckHunger }
