const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

class BehaviorGoTo {
    /**
     * @param {object} bot
     * @param {object} masterData
     * @param {function} getPosFunc - 返回最终目标 {x,y,z}
     * @param {string} label - 日志标签
     * @param {object} [options]
     * @param {function} [options.getWaypoints] - 返回路径点数组 [{x,y,z}, ...]
     * @param {boolean} [options.reverseWaypoints] - 是否反向经过路径点
     */
    constructor(bot, masterData, getPosFunc, label = '前往目标', options = {}) {
        this.bot = bot
        this.masterData = masterData
        this.getPosFunc = getPosFunc
        this.getWaypoints = options.getWaypoints || null
        this.reverseWaypoints = options.reverseWaypoints || false
        this.label = label
        this.stateName = `goto_${label}`
        this.active = false
        this.x = 400
        // 可视化节点坐标：显式传入优先，否则按是否反向走路径点区分
        this.y = options.y ?? (this.reverseWaypoints ? 350 : 150)
        this.isFinished = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.label
        this.run()
    }

    async _gotoPoint(point, label, timeoutMs = 30000) {
        const target = new Vec3(point.x, point.y, point.z)
        const dist = this.bot.entity.position.distanceTo(target)

        if (dist <= 3) {
            console.log(`[${this.label}] ${label} 已在附近，跳过`)
            return
        }

        console.log(`[${this.label}] ${label} (${point.x},${point.y},${point.z}) 距离${dist.toFixed(1)}`)
        stopMovement(this.bot)
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2)
        await pathfinderGoto(this.bot, goal, timeoutMs)
        await sleep(300)
    }

    async run() {
        try {
            const target = this.getPosFunc()
            if (!target) {
                console.log(`[${this.label}] 目标位置未配置`)
                this.isFinished = true
                return
            }

            let waypoints = []
            if (this.getWaypoints) {
                const raw = this.getWaypoints()
                if (Array.isArray(raw) && raw.length > 0) {
                    waypoints = this.reverseWaypoints ? [...raw].reverse() : [...raw]
                }
            }

            for (let i = 0; i < waypoints.length; i++) {
                if (!this.active || this.masterData.stopRequested) break
                const wp = waypoints[i]
                await this._gotoPoint(wp, `路径点 ${i + 1}/${waypoints.length}`)
            }

            if (!this.active || this.masterData.stopRequested) {
                this.isFinished = true
                return
            }

            await this._gotoPoint(target, '终点')
            console.log(`[${this.label}] 已到达`)
        } catch (e) {
            console.log(`[${this.label}] 寻路失败: ${e.message}`)
        }
        this.isFinished = true
    }

    update() {
        const totalTimeout = 35000 + (this.getWaypoints?.()?.length || 0) * 30000
        if (Date.now() - this.startTime > totalTimeout) {
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGoTo }
