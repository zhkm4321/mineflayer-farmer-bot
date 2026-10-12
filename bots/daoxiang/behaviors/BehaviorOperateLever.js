const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, sleep, stopMovement } = require('../../../utils/movement')

/**
 * 拉杆操作（规则 2/3）。
 * 【实测】prismarine-block getProperties() 对 bool 状态返回真布尔值（true/false），
 * 不是字符串 —— 旧代码 `=== 'true'` 恒为 false，曾导致"拨成功却判失败→重试拨回"的震荡。
 * blockUpdate 用官方按坐标事件 `blockUpdate:(x,y,z)`（mineflayer 自动转发，
 * 官方插件 place_block.js/digging.js 均按此用法）。
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
        return block?.getProperties?.()?.powered === true
    }

    _findLever() {
        const L = this.masterData.lever
        if (!L) return null
        // 优先按配置坐标精确读取
        const configured = this.bot.blockAt(new Vec3(L.x, L.y, L.z))
        if (configured && configured.name === 'lever') return configured
        // 配置坐标失效时按半径搜索（配置可能没跟上地形改动）
        const found = this.bot.findBlock({
            matching: block => block.name === 'lever',
            maxDistance: 8,
            point: new Vec3(L.x, L.y, L.z)
        })
        if (found) {
            console.log(`[拉杆] 配置坐标无拉杆，在附近搜索到 (${found.position.x},${found.position.y},${found.position.z})`)
        }
        return found
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
        if (Date.now() - this.startTime > 90000) this.isFinished = true
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorOperateLever }
