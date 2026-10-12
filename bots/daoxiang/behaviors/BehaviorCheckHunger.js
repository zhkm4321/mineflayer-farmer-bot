/** 饥饿检查（枢纽状态）。
 *  【最小驻留 1s】本状态是流程环路必经节点，瞬间放行会导致环路零间隔自转
 *  （FarmMaster 时代实测 6 秒进入 21 次）。 */
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
        // 规则 8：保证饥饿值不低于 20%（food 4/20）。triggerPercent 默认 30% 留出余量
        const trigger = this.masterData.food.triggerPercent ?? 30
        this.needsFood = this.bot.food < Math.ceil(20 * trigger / 100)
        // 不在这里放行：必须先满足最小驻留时间（见 update）
        this.checked = false
        this.enteredAt = Date.now()
        this.masterData.detailStatus = '检查饥饿'
    }

    update() {
        if (Date.now() - this.enteredAt < 1000) return
        this.checked = true
    }

    onStateExited() {
        this.checked = false
    }
}

module.exports = { BehaviorCheckHunger }
