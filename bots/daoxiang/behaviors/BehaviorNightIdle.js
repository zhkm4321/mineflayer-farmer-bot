const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { pathfinderGoto, stopMovement, sleep } = require('../../../utils/movement')

const NIGHT_START = 12542
const NIGHT_END = 23460

/**
 * 夜晚发呆（规则 8）：天黑后前往 nightSpot(1033 61 598) 站着不动，等天亮再干活，
 * 避免在农田里被幻翼袭击。不做睡觉（没有床需求），原地站桩到黎明。
 */
class BehaviorNightIdle {
    constructor(bot, masterData) {
        this.bot = bot
        this.masterData = masterData
        this.stateName = 'nightIdle'
        this.active = false
        this.x = 50
        this.y = 450
        this.isFinished = false
        this.startTime = 0
        this.movedToSpot = false
    }

    static isNight(bot) {
        const time = bot.time?.timeOfDay
        if (time == null) return false
        return time >= NIGHT_START && time <= NIGHT_END
    }

    static shouldIdle(bot, masterData) {
        if (!masterData || masterData.stopRequested) return false
        return BehaviorNightIdle.isNight(bot)
    }

    onStateEntered() {
        this.isFinished = false
        this.movedToSpot = false
        this.startTime = Date.now()
        this.masterData.detailStatus = '夜晚发呆'
        console.log('[发呆] 夜晚降临，前往发呆点躲避幻翼')
        this.run()
    }

    async run() {
        try {
            const spot = this.masterData.nightSpot
            if (!spot) {
                console.log('[发呆] 未配置 nightSpot，原地待到天亮')
                this.movedToSpot = true
                return
            }

            const target = new Vec3(spot.x, spot.y, spot.z)
            const dist = this.bot.entity.position.distanceTo(target)
            // 规则 7-2：超过 tp.farDistance 不寻路，直接传送（夜晚从出生点过来往往上千格）
            const farLimit = this.masterData.tp?.farDistance || 200
            if (dist > 3 && (this.masterData.tp?.enabled !== false) && dist > farLimit) {
                console.log(`[发呆] 距发呆点 ${dist.toFixed(0)} 格 > ${farLimit}，直接 /tp`)
                const safeY = spot.y + 1
                this.bot.chat(`/minecraft:tp ${spot.x + 0.5} ${safeY} ${spot.z + 0.5}`)
                await sleep(1800)
                const after = this.bot.entity.position.distanceTo(new Vec3(spot.x + 0.5, safeY, spot.z + 0.5))
                if (after > 16) {
                    console.log(`[发呆] /tp 未生效 (距发呆点仍 ${after.toFixed(0)}，可能无传送权限)`)
                } else {
                    this.movedToSpot = true
                    console.log(`[发呆] /tp 就位 (${this.bot.entity.position.floored()})，站到天亮`)
                    return
                }
            }
            if (dist > 3) {
                stopMovement(this.bot)
                const goal = new goals.GoalNear(spot.x, spot.y, spot.z, 2)
                goal.teleportYOffset = 1
                await pathfinderGoto(this.bot, goal, 45000)
                await sleep(300)
            }
            this.movedToSpot = true
            console.log(`[发呆] 已就位 (${this.bot.entity.position.floored()})，站到天亮`)
        } catch (e) {
            console.log(`[发呆] 前往发呆点失败: ${e.message}，原地待到天亮`)
            this.movedToSpot = true
        }
    }

    update() {
        // 天亮即结束（发呆点站桩）
        if (this.movedToSpot && !BehaviorNightIdle.isNight(this.bot)) {
            console.log(`[发呆] 天亮了，继续干活 (时间: ${this.bot.time?.timeOfDay ?? '?'})`)
            this.isFinished = true
            return
        }
        // 兜底：一整夜 + 富余
        if (Date.now() - this.startTime > 15 * 60 * 1000) {
            console.log('[发呆] 等待超时，返回流程')
            this.isFinished = true
        }
    }

    onStateExited() {
        stopMovement(this.bot)
        this.masterData.detailStatus = ''
    }
}

module.exports = { BehaviorNightIdle }
