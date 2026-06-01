const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, sleep, stopMovement } = require('../../../utils/movement')

class BehaviorOperateLever {
    /**
     * @param {object} bot
     * @param {object} masterData
     * @param {'on'|'off'} mode - 'on' = 激活拉杆, 'off' = 关闭拉杆
     */
    constructor(bot, masterData, mode) {
        this.bot = bot
        this.masterData = masterData
        this.mode = mode
        this.stateName = mode === 'on' ? 'activateLever' : 'deactivateLever'
        this.active = false
        this.x = mode === 'on' ? 300 : 700
        this.y = 50
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.mode === 'on' ? '开启拉杆' : '关闭拉杆'
        this.run()
    }

    async run() {
        try {
            const pos2 = this.masterData.pos2
            if (!pos2) throw new Error('pos2 未配置')

            const found = this.bot.findBlock({
                matching: block => block.name === 'lever',
                maxDistance: 6,
                point: new Vec3(pos2.x, pos2.y, pos2.z)
            })

            if (!found) {
                console.log(`[拉杆] 在 pos2 附近未找到拉杆`)
                this.isFinished = true
                return
            }

            const leverPos = found.position

            const goal = new goals.GoalLookAtBlock(leverPos, this.bot.world, { reach: 4.5 })
            stopMovement(this.bot)
            await pathfinderGoto(this.bot, goal, 15000)
            await sleep(300)

            // 走到拉杆附近后，用 blockAt 读取最新状态
            const lever = this.bot.blockAt(leverPos)
            if (!lever || lever.name !== 'lever') {
                console.log(`[拉杆] 方块状态异常: ${lever?.name}`)
                this.isFinished = true
                return
            }

            const powered = lever.getProperties?.()?.powered === 'true'
            const label = this.mode === 'on' ? '开启' : '关闭'
            console.log(`[拉杆] 当前状态 powered=${powered}，目标: ${label}`)

            const needToggle = (this.mode === 'on' && !powered) || (this.mode === 'off' && powered)
            if (!needToggle) {
                console.log(`[拉杆] 已经是${label}状态，无需操作`)
                this.isFinished = true
                return
            }

            await this.bot.lookAt(leverPos.offset(0.5, 0.5, 0.5), true)
            await sleep(200)
            await this.bot.activateBlock(lever)
            await sleep(500)

            const after = this.bot.blockAt(leverPos)
            const afterPowered = after?.getProperties?.()?.powered
            console.log(`[拉杆] ${label}完成 (powered=${afterPowered})`)
        } catch (e) {
            console.log(`[拉杆] 操作失败: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 20000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorOperateLever }
