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
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.mode === 'on' ? '开启拉杆' : '关闭拉杆'
        this.run()
    }

    _findLever() {
        const pos2 = this.masterData.pos2
        if (!pos2) return null
        return this.bot.findBlock({
            matching: block => block.name === 'lever',
            maxDistance: 6,
            point: new Vec3(pos2.x, pos2.y, pos2.z)
        })
    }

    /**
     * 激活拉杆并等待服务器 blockUpdate 事件确认状态变化
     * @returns {Promise<boolean>} 操作后的 powered 状态
     */
    _activateAndWaitUpdate(lever) {
        const leverPos = lever.position
        const timeoutMs = 3000

        return new Promise((resolve) => {
            let settled = false
            const finish = (powered) => {
                if (settled) return
                settled = true
                this.bot.world.removeListener('blockUpdate', onUpdate)
                clearTimeout(timer)
                resolve(powered)
            }

            const onUpdate = (oldBlock, newBlock) => {
                if (!newBlock || !newBlock.position.equals(leverPos)) return
                if (newBlock.name !== 'lever') return
                const powered = newBlock.getProperties?.()?.powered === 'true'
                console.log(`[拉杆] 收到 blockUpdate: powered=${powered}`)
                finish(powered)
            }

            const timer = setTimeout(() => {
                const block = this.bot.blockAt(leverPos)
                const powered = block?.getProperties?.()?.powered === 'true'
                console.log(`[拉杆] blockUpdate 超时(${timeoutMs}ms)，blockAt 读取 powered=${powered}`)
                finish(powered)
            }, timeoutMs)

            this.bot.world.on('blockUpdate', onUpdate)
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
        const beforePowered = lever.getProperties?.()?.powered === 'true'
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
            console.log(`[拉杆] pos2 未配置`)
            this.isFinished = true
            return
        }

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            if (!this.active || this.masterData.stopRequested) break

            try {
                const ok = await this._tryOnce()
                if (ok) {
                    console.log(`[拉杆] ${label}成功`)
                    this.isFinished = true
                    return
                }
            } catch (e) {
                console.log(`[拉杆] ${label}失败(${attempt}/${this.maxRetries}): ${e.message}`)
            }

            if (attempt < this.maxRetries) {
                const waitSec = Math.min(attempt * 2, 8)
                console.log(`[拉杆] ${waitSec}s 后重试...`)
                await sleep(waitSec * 1000)
            }
        }

        console.log(`[拉杆] 达到最大重试次数，跳过`)
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
