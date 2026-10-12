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
        this.arrived = false // 是否真正到达目标；调用方必须检查
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.arrived = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.label
        this.run()
    }

    async _gotoPoint(point, label, timeoutMs = 30000) {
        const target = new Vec3(point.x, point.y, point.z)
        const dist = this.bot.entity.position.distanceTo(target)
        const before = this.bot.entity.position.clone()

        if (dist <= 3) {
            console.log(`[${this.label}] ${label} 已在附近，跳过`)
            // 【必须返回 true】调用方用返回值判断成败。undefined 会被当成失败，
            // 造成"已在附近 → 判失败 → 未到达 → 重新导航"的零间隔死循环（实测 1 秒 6 轮）
            return true
        }

        console.log(`[${this.label}] ${label} (${point.x},${point.y},${point.z}) 距离${dist.toFixed(1)}`)
        stopMovement(this.bot)
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2)
        // 失败时【不再】向外抛：任何一个路径点走不到，都不应该让整段导航"悄悄成功"。
        // 旧写法把异常抛到 run() 的 catch 里，日志打一句"寻路失败"后就直接 isFinished=true，
        // 于是状态机以为"到达了"、接着去播种 —— 实际人还在原地。
        const ok = await pathfinderGoto(this.bot, goal, timeoutMs).then(
            () => true,
            (e) => {
                console.log(`[${this.label}] ${label} 寻路失败: ${e.message}`)
                return false
            }
        )
        const moved = before.distanceTo(this.bot.entity.position)
        if (!ok || moved < 0.5) {
            console.log(`[${this.label}] ${label} 未取得进展(实际移动 ${moved.toFixed(1)} 格)` +
                (ok ? '，判定为原地卡住' : ''))
            return false
        }
        await sleep(300)
        return true
    }

    async run() {
        let ok = true
        try {
            const target = this.getPosFunc()
            if (!target) {
                console.log(`[${this.label}] 目标位置未配置`)
                this.arrived = false
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
                if (!await this._gotoPoint(wp, `路径点 ${i + 1}/${waypoints.length}`)) {
                    ok = false
                    break
                }
            }

            if (ok && !(!this.active || this.masterData.stopRequested)) {
                ok = await this._gotoPoint(target, '终点')
            }
        } catch (e) {
            console.log(`[${this.label}] 寻路异常: ${e.message}`)
            ok = false
        }

        // arrived 是本状态唯一对外暴露的结果标志：只有真正走到过目标才算"到达"。
        // 调用方必须检查它，否则"寻路失败后照样进播种"的老问题会重现。
        const finalTarget = this.getPosFunc()
        const finalDist = finalTarget
            ? this.bot.entity.position.distanceTo(new Vec3(finalTarget.x, finalTarget.y, finalTarget.z))
            : Infinity
        this.arrived = ok && finalDist <= 8
        if (this.arrived) {
            console.log(`[${this.label}] 已到达 (距目标 ${finalDist.toFixed(1)})`)
        } else {
            console.log(`[${this.label}] 未到达 (距目标 ${finalDist.toFixed(1)})，放弃本次导航`)
        }
        this.isFinished = true
    }

    update() {
        // 注意：状态机的 update() 在检查转移【之前】调用（statemachine.js:184），
        // 所以这里一置 isFinished，下一次转移就会立刻切走。超时兜底只作为最后保险。
        const totalTimeout = 35000 + (this.getWaypoints?.()?.length || 0) * 30000
        if (Date.now() - this.startTime > totalTimeout) {
            this.arrived = false
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGoTo }
