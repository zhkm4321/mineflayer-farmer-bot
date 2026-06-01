const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

class BehaviorGoTo {
    /**
     * @param {object} bot
     * @param {object} masterData
     * @param {function} getPosFunc - 返回目标 {x,y,z} 的函数
     * @param {string} label - 日志标签
     */
    constructor(bot, masterData, getPosFunc, label = '前往目标') {
        this.bot = bot
        this.masterData = masterData
        this.getPosFunc = getPosFunc
        this.label = label
        this.stateName = `goto_${label}`
        this.active = false
        this.x = 400
        this.y = label.includes('1') ? 150 : 350
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.label
        this.run()
    }

    async run() {
        try {
            const target = this.getPosFunc()
            if (!target) {
                console.log(`[${this.label}] 目标位置未配置`)
                this.isFinished = true
                return
            }

            const dist = this.bot.entity.position.distanceTo(
                new (require('vec3').Vec3)(target.x, target.y, target.z)
            )
            console.log(`[${this.label}] 前往 (${target.x},${target.y},${target.z}) 距离${dist.toFixed(1)}`)

            if (dist <= 3) {
                console.log(`[${this.label}] 已在目标附近`)
                this.isFinished = true
                return
            }

            stopMovement(this.bot)
            const goal = new goals.GoalNear(target.x, target.y, target.z, 2)
            await pathfinderGoto(this.bot, goal, 30000)
            await sleep(300)

            console.log(`[${this.label}] 已到达`)
        } catch (e) {
            console.log(`[${this.label}] 寻路失败: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 35000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGoTo }
