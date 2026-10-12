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
        this.maxRetries = 5
        this.succeeded = false
    }

    onStateEntered() {
        this.isFinished = false
        this.succeeded = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.mode === 'on' ? '开启拉杆' : '关闭拉杆'
        this.run()
    }

    _findLever() {
        const pos2 = this.masterData.pos2
        // 先以 pos2 为中心搜，找不到再放宽到自身周围。
        // 原来只搜 pos2 半径 6，一旦寻路偏差或 pos2 配置略偏，就会在第 4、5 次重试时
        // 报"在 pos2 附近未找到拉杆"——但前 3 次明明是找到了并操作过的（状态不一致的假象）。
        if (pos2) {
            const found = this.bot.findBlock({
                matching: block => block.name === 'lever',
                maxDistance: 6,
                point: new Vec3(pos2.x, pos2.y, pos2.z)
            })
            if (found) return found
        }

        const self = this.bot.findBlock({
            matching: block => block.name === 'lever',
            maxDistance: 8
        })
        if (self && pos2) {
            console.log(`[拉杆] pos2 附近无拉杆，改用自身附近找到的 (${self.position.x},${self.position.y},${self.position.z})`)
        }
        return self
    }

    /** 读取拉杆 powered 状态。
     *  【实测】prismarine-block getProperties() 对 bool 类型状态返回真正的布尔值
     *  （lever powered: true/false），不是字符串 'true'/'false'。
     *  旧代码写成 `=== 'true'`，永远得到 false —— 拉杆明明拨成功了却判定失败，
     *  重试时又拨回去，来回震荡；关闭模式连续失败 3 次还会暂停整个自动循环。 */
    _readPowered(block) {
        return block?.getProperties?.()?.powered === true
    }

    /**
     * 激活拉杆并等待服务器确认状态变化。
     * 用官方按坐标事件 `blockUpdate:(x, y, z)`（mineflayer blocks.js:595-600 自动转发，
     * 官方插件 place_block.js/digging.js 均按此方式订阅），不再手动挂全局事件+过滤坐标。
     * @returns {Promise<boolean>} 操作后的 powered 状态
     */
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
                // 触发 once 后监听器自动移除；超时路径需手动移除
                this.bot.removeListener(eventName, onUpdate)
                resolve(powered)
            }

            const onUpdate = (oldBlock, newBlock) => {
                // 按坐标事件只收本坐标的更新；仍校验方块类型以防异常包
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
        if (!found) throw new Error('在 pos2 附近未找到拉杆')

        const leverPos = found.position

        const goal = new goals.GoalLookAtBlock(leverPos, this.bot.world, { reach: 4.5 })
        stopMovement(this.bot)
        await pathfinderGoto(this.bot, goal, 15000)
        await sleep(300)

        const lever = this.bot.blockAt(leverPos)
        if (!lever || lever.name !== 'lever') {
            throw new Error(`方块状态异常: ${lever?.name}`)
        }

        const wantPowered = this.mode === 'on'
        const beforePowered = this._readPowered(lever)
        console.log(`[拉杆] 操作前 powered=${beforePowered}，目标 powered=${wantPowered}`)

        if (beforePowered === wantPowered) {
            console.log(`[拉杆] 已经是目标状态，无需操作`)
            return true
        }

        await this.bot.lookAt(leverPos.offset(0.5, 0.5, 0.5), true)
        await sleep(200)

        const afterPowered = await this._activateAndWaitUpdate(lever)

        if (afterPowered === wantPowered) {
            return true
        }

        throw new Error(`操作后 powered=${afterPowered}，期望 ${wantPowered}`)
    }

    async run() {
        const label = this.mode === 'on' ? '开启' : '关闭'

        const pos2 = this.masterData.pos2
        if (!pos2) {
            console.log('[拉杆] pos2 未配置')
            this.succeeded = false
            this.isFinished = true
            return
        }

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            if (!this.active || this.masterData.stopRequested) break

            try {
                const ok = await this._tryOnce()
                if (ok) {
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

        // 关闭失败说明红石农场可能仍在运行，此时播种会被冲毁 → 暂停自动循环并告警
        if (this.mode === 'off' && this.masterData.leverFailStreak >= 3) {
            console.log('[拉杆][告警] 连续 3 次无法关闭拉杆，已暂停自动循环，请人工检查')
            this.masterData.isAutoFarming = false
            this.masterData.stopRequested = true
            try {
                this.bot.chat('FarmMaster 告警: 拉杆关闭连续失败，已暂停自动循环')
            } catch (e) { /* ignore */ }
        }

        this.isFinished = true
    }

    update() {
        if (Date.now() - this.startTime > 60000) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorOperateLever }
