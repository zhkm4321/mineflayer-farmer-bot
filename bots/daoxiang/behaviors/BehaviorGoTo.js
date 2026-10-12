const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

/**
 * 导航行为：路径点序列 + 终点，带 DaoXiang 规则 7 的两条 tp 策略：
 *   1. 目标距离 > tp.farDistance(默认200格) → 不寻路，直接 /minecraft:tp 到目标
 *   2. 寻路极端失败（含 utils 层的卡住/超时 tp 兜底也失败）→ tp 回初始位置（homePos）
 *
 * 【arrived 契约】run() 结束时必须给出诚实的 arrived 标志，
 * 状态机转移只信 arrived，不信 isFinished —— 否则会重现"寻路失败却照样播种"。
 */
class BehaviorGoTo {
    constructor(bot, masterData, targetGetter, label, opts = {}) {
        this.bot = bot
        this.masterData = masterData
        this.targetGetter = targetGetter
        this.label = label
        this.waypointsGetter = opts.getWaypoints || (() => [])
        this.reverseWaypoints = !!opts.reverseWaypoints
        this.tpHomeOnFail = !!opts.tpHomeOnFail
        // 配置目标通常是方块坐标（梯田入口 y=69 是 farmland 方块），tp 要落在其上方一格。
        this.tpYOffset = opts.tpYOffset ?? 1
        this.stateName = opts.stateName || label
        this.active = false
        this.x = opts.x || 150
        this.y = opts.y || 150
        this.isFinished = false
        this.arrived = false
        this.startTime = 0
    }

    onStateEntered() {
        this.isFinished = false
        this.arrived = false
        this.startTime = Date.now()
        this.masterData.detailStatus = this.label
        this.run()
    }

    /** 直传 tp：距离太远时使用（rule 7-2） */
    async _tpDirectly(point, label) {
        const target = new Vec3(point.x + 0.5, point.y + this.tpYOffset, point.z + 0.5)
        console.log(`[${this.label}] ${label} 距离超过 ${this.masterData.tp.farDistance} 格，直接 /tp → ` +
            `安全站位(${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)})`)
        this.bot.chat(`/minecraft:tp ${target.x} ${target.y} ${target.z}`)
        await sleep(1800)
        const dist = this.bot.entity.position.distanceTo(target)
        if (dist <= Math.max(4, this.masterData.tp.farDistance / 50)) {
            console.log(`[${this.label}] /tp 成功 (距目标 ${dist.toFixed(1)})`)
            return true
        }
        console.log(`[${this.label}] /tp 未生效 (距目标仍 ${dist.toFixed(1)}，可能无传送权限)`)
        return false
    }

    /** 极端失败兜底：tp 回初始位置重新开始（rule 7-1） */
    async _tpHomeFallback() {
        const home = this.masterData.homePos
        if (!home) return
        const here = this.bot.entity.position
        if (here.distanceTo(new Vec3(home.x, home.y, home.z)) < 4) return
        console.log(`[${this.label}] 寻路极端失败，/tp 回初始位置 (${home.x},${home.y},${home.z}) 重新决策`)
        this.bot.chat(`/minecraft:tp ${home.x + 0.5} ${home.y} ${home.z + 0.5}`)
        await sleep(1800)
        stopMovement(this.bot)
    }

    /**
     * 走向单点。成功返回 true。
     * 【注意】"已在附近"必须 return true —— 返回 undefined 会被当成失败，
     * 造成零间隔死循环（FarmMaster 时代实测 1 秒 6 轮）。
     */
    async _gotoPoint(point, label, timeoutMs = 30000) {
        const target = new Vec3(point.x, point.y, point.z)
        const dist = this.bot.entity.position.distanceTo(target)

        if (dist <= 3) {
            console.log(`[${this.label}] ${label} 已在附近，跳过`)
            return true
        }

        // rule 7-2：太远直接传送，不浪费寻路时间
        const farLimit = this.masterData.tp?.farDistance || 200
        if ((this.masterData.tp?.enabled !== false) && dist > farLimit) {
            return this._tpDirectly(point, label)
        }

        console.log(`[${this.label}] ${label} (${point.x},${point.y},${point.z}) 距离${dist.toFixed(1)}`)
        stopMovement(this.bot)
        const goal = new goals.GoalNear(point.x, point.y, point.z, 2)
        // pathfinder.goto 仍以点的原始 Y 做路径规划；只有 utils 的 tp 脱困使用 y+1 安全站位
        goal.teleportYOffset = this.tpYOffset
        const ok = await pathfinderGoto(this.bot, goal, timeoutMs).then(
            () => true,
            (e) => {
                console.log(`[${this.label}] ${label} 寻路失败: ${e.message}`)
                return false
            }
        )
        if (ok) {
            const finalDist = this.bot.entity.position.distanceTo(target)
            console.log(`[${this.label}] ${label} 已到达 (距目标 ${finalDist.toFixed(1)})`)
            return finalDist <= 8
        }
        return false
    }

    async run() {
        const target = this.targetGetter()
        if (!target) {
            console.log(`[${this.label}] 目标未配置，跳过导航`)
            this.arrived = false
            this.isFinished = true
            return
        }

        let ok = true
        let wps = (this.waypointsGetter() || []).slice()
        if (this.reverseWaypoints) wps = wps.reverse()

        try {
            // 逐个路径点：任一失败即中断（【必须】中断而不是继续，否则会在错误路径上播种）
            for (let i = 0; i < wps.length; i++) {
                if (!this.active || this.masterData.stopRequested) {
                    ok = false
                    break
                }
                if (!await this._gotoPoint(wps[i], `路径点 ${i + 1}/${wps.length}`)) {
                    ok = false
                    break
                }
            }

            if (ok) {
                ok = await this._gotoPoint(target, '终点')
            }
        } catch (e) {
            console.log(`[${this.label}] 导航异常: ${e.message}`)
            ok = false
        }

        this.arrived = ok && this.bot.entity.position.distanceTo(new Vec3(target.x, target.y, target.z)) <= 8

        // rule 7-1：极端失败 → tp 回初始位置，从安全点重新决策
        if (!this.arrived && this.tpHomeOnFail && (this.masterData.tp?.enabled !== false)) {
            await this._tpHomeFallback()
        }

        if (!this.arrived) {
            console.log(`[${this.label}] 未到达 (距目标 ` +
                `${this.bot.entity.position.distanceTo(new Vec3(target.x, target.y, target.z)).toFixed(1)})，放弃本次导航`)
        }
        this.isFinished = true
    }

    update() {
        // 【防重入】isFinished 置位后要等下一 tick 才转移，期间 update 仍会被调用
        if (this.isFinished) return
        // 总时长上限（60s/路径点 + 终点 60s + 富余）
        if (Date.now() - this.startTime > (this.waypointsGetter().length + 2) * 60000) {
            console.log(`[${this.label}] 导航总时长超限，放弃`)
            stopMovement(this.bot)
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorGoTo }
