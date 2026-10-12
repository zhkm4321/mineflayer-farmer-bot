const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

const NIGHT_START = 12542
const NIGHT_END = 23460

// 睡觉失败后的冷却时间：避免夜晚"进 waitMaturity → sleep 失败 → 立刻重进"的无退避抖动
const RETRY_COOLDOWN_MS = 30000
// 兜底上限：仅用于 bot.sleep() 永不 resolve 的异常场景，必须远大于一夜(约420s)
const MAX_SLEEP_MS = 20 * 60 * 1000
// 天已亮但仍标记在睡觉时，确认若干秒后主动起床
const WAKE_AFTER_DAWN_MS = 5000

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
        this.slept = false
    }

    static isNight(bot) {
        const time = bot.time?.timeOfDay
        if (time == null) return false
        return time >= NIGHT_START && time <= NIGHT_END
    }

    /** 是否应当尝试睡觉：夜晚 + 未在睡 + 未停止 + 不在失败冷却期 */
    static shouldSleep(bot, masterData) {
        if (!masterData || masterData.stopRequested) return false
        if (bot.isSleeping) return false
        if (Date.now() < (masterData.sleepFailedUntil || 0)) return false
        return BehaviorSleep.isNight(bot)
    }

    _noteFailure(reason) {
        this.masterData.sleepFailedUntil = Date.now() + RETRY_COOLDOWN_MS
        console.log(`[睡觉] ${reason}，${RETRY_COOLDOWN_MS / 1000}s 内不再尝试`)
    }

    onStateEntered() {
        this.isFinished = false
        this.slept = false
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

    /** 等待官方 'wake' 事件（服务器确认起床后由 mineflayer bed.js:186 发出）。
     *  bot.sleep() 在"入睡成功"时就 resolve（bed.js waitUntilSleep 监听 'sleep' 事件），
     *  旧代码在 sleep() 返回后立刻打"天亮了，起床!"——实际还在深夜，
     *  随后状态机切走触发 onStateExited → bot.wake() 把自己从床上拽起来，
     *  于是整夜都在"上床-立刻起床"循环，从来没真正睡到天亮。 */
    _waitWake(timeoutMs) {
        return new Promise((resolve) => {
            if (!this.bot.isSleeping) return resolve()
            const cleanup = () => {
                clearTimeout(timer)
                this.bot.removeListener('wake', onWake)
            }
            const onWake = () => { cleanup(); resolve() }
            const timer = setTimeout(() => { cleanup(); resolve() }, timeoutMs)
            this.bot.once('wake', onWake)
        })
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
                this._noteFailure('pos2 附近未找到床')
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
                this._noteFailure('床方块丢失')
                this.isFinished = true
                return
            }

            this.masterData.detailStatus = '睡觉中'
            console.log('[睡觉] 上床睡觉，等待天亮')
            await this.bot.sleep(bed)
            this.slept = true
            this.masterData.sleepFailedUntil = 0

            // 等服务器确认"天亮被强制起床"（wake 事件）；update() 的主动 wake 也会触发它
            await this._waitWake(MAX_SLEEP_MS)
            console.log(`[睡觉] 醒来了，当前时间: ${this.bot.time?.timeOfDay ?? '?'}`)
        } catch (e) {
            const msg = e.message || String(e)
            if (msg.includes('wake')) {
                console.log('[睡觉] 已醒来')
                this.masterData.sleepFailedUntil = 0
            } else {
                this._noteFailure(`失败: ${msg}`)
            }
        }
        this.isFinished = true
    }

    update() {
        if (!this.bot.isSleeping) return

        const elapsed = Date.now() - this.startTime

        if (elapsed > MAX_SLEEP_MS) {
            console.log('[睡觉] 超过兜底上限，强制起床')
            try { this.bot.wake() } catch (e) { /* ignore */ }
            this.isFinished = true
            return
        }

        if (elapsed > WAKE_AFTER_DAWN_MS && !BehaviorSleep.isNight(this.bot)) {
            console.log('[睡觉] 天已亮，主动起床')
            try { this.bot.wake() } catch (e) { /* ignore */ }
            this.isFinished = true
        }
    }

    onStateExited() {
        if (this.bot.isSleeping) {
            try { this.bot.wake() } catch (e) { /* ignore */ }
        }
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorSleep }
