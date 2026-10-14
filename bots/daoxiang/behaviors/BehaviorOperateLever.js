const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, sleep, stopMovement } = require('../../../utils/movement')
const { findLeverBlock, isLeverPowered } = require('../lever')

/**
 * 拉杆操作（规则 2/3）。
 * 拉杆查找/状态读取统一走 ../lever（与 PlantSeeds 的规则 3 检查共用，
 * 避免"一边靠半径搜索、一边只认配置坐标"的不一致）。
 * blockUpdate 用官方按坐标事件 `blockUpdate:(x, y, z)`（vec3 的 toString 恰好
 * 是该格式，mineflayer 会把匹配的监听器转发到 bot.world）。
 */
class BehaviorOperateLever {
    constructor(bot, masterData, mode) {
        this.bot = bot
        this.masterData = masterData
        this.mode = mode // 'on' = 开拉杆放水收割, 'off' = 关拉杆准备播种
        this.stateName = mode === 'on' ? 'activateLever' : 'deactivateLever'
        this.active = false
        this.x = mode === 'on' ? 300 : 700
        this.y = 50
        this.isFinished = false
        this.startTime = 0
        this.maxRetries = 5
        this.succeeded = false
    }

    onStateEntered() {
        this.isFinished = false
        this.succeeded = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.mode === 'on' ? '开启拉杆收割' : '关闭拉杆'
        this.run()
    }

    _readPowered(block) {
        return isLeverPowered(block)
    }

    _findLever() {
        return findLeverBlock(this.bot, this.masterData.lever)
    }

    _activateAndWaitUpdate(lever) {
        const leverPos = lever.position
        const timeoutMs = 3000
        const eventName = `blockUpdate:${leverPos}`

        return new Promise((resolve) => {
            let settled = false
            const finish = (powered) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                this.bot.removeListener(eventName, onUpdate)
                resolve(powered)
            }

            const onUpdate = (oldBlock, newBlock) => {
                if (!newBlock || newBlock.name !== 'lever') return
                const powered = this._readPowered(newBlock)
                console.log(`[拉杆] 收到 blockUpdate: powered=${powered}`)
                finish(powered)
            }

            const timer = setTimeout(() => {
                const block = this.bot.blockAt(leverPos)
                const powered = this._readPowered(block)
                console.log(`[拉杆] blockUpdate 超时(${timeoutMs}ms)，blockAt 读取 powered=${powered}`)
                finish(powered)
            }, timeoutMs)

            this.bot.once(eventName, onUpdate)
            this.bot.activateBlock(lever).catch(() => {})
        })
    }

    async _tryOnce() {
        const found = this._findLever()
        if (!found) throw new Error('未找到拉杆')

        const leverPos = found.position
        const goal = new goals.GoalLookAtBlock(leverPos, this.bot.world, { reach: 4.5 })
        stopMovement(this.bot)
        await pathfinderGoto(this.bot, goal, 20000)
        await sleep(300)

        const lever = this.bot.blockAt(leverPos)
        if (!lever || lever.name !== 'lever') throw new Error(`方块状态异常: ${lever?.name}`)

        const wantPowered = this.mode === 'on'
        const beforePowered = this._readPowered(lever)
        console.log(`[拉杆] 操作前 powered=${beforePowered}，目标 powered=${wantPowered}`)

        if (beforePowered === wantPowered) {
            console.log('[拉杆] 已经是目标状态，无需操作')
            return true
        }

        await this.bot.lookAt(leverPos.offset(0.5, 0.5, 0.5), true)
        await sleep(200)

        const afterPowered = await this._activateAndWaitUpdate(lever)
        if (afterPowered === wantPowered) return true
        throw new Error(`操作后 powered=${afterPowered}，期望 ${wantPowered}`)
    }

    async run() {
        const label = this.mode === 'on' ? '开启' : '关闭'

        if (!this.masterData.lever) {
            console.log('[拉杆] 未配置拉杆坐标')
            this.isFinished = true
            return
        }

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            if (!this.active || this.masterData.stopRequested) break
            try {
                if (await this._tryOnce()) {
                    console.log(`[拉杆] ${label}成功`)
                    this.succeeded = true
                    this.masterData.leverFailStreak = 0
                    this.masterData.lastLeverError = null
                    this.isFinished = true
                    return
                }
            } catch (e) {
                console.log(`[拉杆] ${label}失败(${attempt}/${this.maxRetries}): ${e.message}`)
                this.masterData.lastLeverError = e.message
            }
            if (attempt < this.maxRetries) {
                const waitSec = Math.min(attempt * 2, 8)
                console.log(`[拉杆] ${waitSec}s 后重试...`)
                await sleep(waitSec * 1000)
            }
        }

        console.log(`[拉杆] ${label}达到最大重试次数，本次失败`)
        this.succeeded = false
        this.masterData.leverFailStreak = (this.masterData.leverFailStreak || 0) + 1
        // 开启失败连续 3 次：收割流程无法进行，告警但不停机（下轮 waitMaturity 重试）
        if (this.masterData.leverFailStreak >= 3) {
            console.log('[拉杆][告警] 连续 3 次操作失败，请人工检查拉杆/权限')
            try { this.bot.chat('DaoXiang 告警: 拉杆连续操作失败，请人工检查') } catch (e) { /* ignore */ }
        }
        this.isFinished = true
    }

    update() {
        // 【防重入】置位后到转移前 update 仍会被反复调用
        if (this.isFinished) return
        if (Date.now() - this.startTime > 90000) this.isFinished = true
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorOperateLever }
