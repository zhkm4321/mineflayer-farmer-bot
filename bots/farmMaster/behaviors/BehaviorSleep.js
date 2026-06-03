const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

const NIGHT_START = 12542
const NIGHT_END = 23460

class BehaviorSleep {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'sleeping'
        this.active = false
        this.x = 50
        this.y = 400
        this.isFinished = false
        this.startTime = 0
    }

    static isNight(bot) {
        const time = bot.time?.timeOfDay
        if (time == null) return false
        return time >= NIGHT_START && time <= NIGHT_END
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '准备睡觉'
        this.run()
    }

    _findBed() {
        const pos2 = this.masterData.pos2
        const point = pos2 ? new Vec3(pos2.x, pos2.y, pos2.z) : undefined
        return this.bot.findBlock({
            matching: block => block.name.endsWith('_bed'),
            maxDistance: 6,
            point
        })
    }

    async _gotoPos2() {
        const pos2 = this.masterData.pos2
        if (!pos2) return

        const target = new Vec3(pos2.x, pos2.y, pos2.z)
        if (this.bot.entity.position.distanceTo(target) <= 4) return

        console.log('[睡觉] 前往 pos2 附近找床')
        stopMovement(this.bot)
        const goal = new goals.GoalNear(pos2.x, pos2.y, pos2.z, 2)
        await pathfinderGoto(this.bot, goal, 30000)
        await sleep(300)
    }

    async run() {
        try {
            if (!BehaviorSleep.isNight(this.bot)) {
                console.log('[睡觉] 还不是夜晚，跳过')
                this.isFinished = true
                return
            }

            await this._gotoPos2()

            const bedBlock = this._findBed()
            if (!bedBlock) {
                console.log('[睡觉] pos2 附近未找到床')
                this.isFinished = true
                return
            }

            const bedPos = bedBlock.position
            console.log(`[睡觉] 找到床 (${bedPos.x},${bedPos.y},${bedPos.z})`)

            stopMovement(this.bot)
            const goal = new goals.GoalNear(bedPos.x, bedPos.y, bedPos.z, 2)
            await pathfinderGoto(this.bot, goal, 15000)
            await sleep(300)

            const bed = this.bot.blockAt(bedPos)
            if (!bed) {
                console.log('[睡觉] 床方块丢失')
                this.isFinished = true
                return
            }

            this.masterData.detailStatus = '睡觉中'
            console.log('[睡觉] 上床睡觉')
            await this.bot.sleep(bed)
            console.log(`[睡觉] 天亮了，起床! 时间: ${this.bot.time.timeOfDay}`)
        } catch (e) {
            const msg = e.message || String(e)
            if (msg.includes('wake')) {
                console.log('[睡觉] 已醒来')
            } else {
                console.log(`[睡觉] 失败: ${msg}`)
            }
        }
        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 120000) {
            if (this.bot.isSleeping) {
                try { this.bot.wake() } catch {}
            }
            this.isFinished = true
        }
    }

    onStateExited() {
        if (this.bot.isSleeping) {
            try { this.bot.wake() } catch {}
        }
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorSleep }
