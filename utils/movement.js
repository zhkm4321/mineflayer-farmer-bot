const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const CROP_BLOCKS = ['wheat', 'carrots', 'potatoes', 'beetroots']
const PROTECT_BLOCKS = ['farmland', 'chest', 'trapped_chest']

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function floorPos(pos) {
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
}

/** 为平面农田优化 pathfinder 配置 */
function configureMovements(bot) {
    const movements = new Movements(bot)
    const registry = bot.registry

    movements.canDig = false
    movements.allow1by1towers = false
    // 禁止"抄近路式"跳跃。pathfinder 选择动作的顺序是（lib/index.js:611-629）：
    //   1. allowSprinting && canStraightLine(sprint)   → 冲刺，不跳
    //   2. allowSprinting && canSprintJump              → 冲刺 + 跳   ← 会"蹦"
    //   3. canStraightLine                              → 步行，不跳   ← 上楼梯靠这条
    //   4. canWalkJump                                  → 跳
    // 第 2 条排在第 3 条前面，所以开启冲刺时，凡是"走不上去"的地方都会优先尝试跳上去。
    // 关掉冲刺后，能走的地方一律走（含 0.5/0.6 的台阶自动上台阶），只有物理上必须跳才跳。
    movements.allowSprinting = false
    // 跨沟/长距离跑酷跳跃一律禁用
    movements.allowParkour = false
    movements.allowFreeMotion = true
    movements.allowEntityDetection = false
    movements.canOpenDoors = true

    for (const name of PROTECT_BLOCKS) {
        const block = registry.blocksByName[name]
        if (block) movements.blocksCantBreak.add(block.id)
    }

    // 耕地高度较低，当作可行走平面
    const farmland = registry.blocksByName.farmland
    if (farmland) movements.carpets.add(farmland.id)

    for (const name of CROP_BLOCKS) {
        const block = registry.blocksByName[name]
        if (block) movements.emptyBlocks.add(block.type)
    }

    // 【重要】不要把 *_slab / 楼梯 加进 movements.carpets！
    // carpets 的语义是"这种方块可以站进去、视同空气"（pathfinder 默认只收录碰撞高度 < 0.1 的
    // 真地毯/雪片，见 lib/movements.js:88-89），而半砖/楼梯是实体方块。
    // 一旦加进去，pathfinder 会同时认为它 physical=true 且 safe=true，于是规划出"穿过半砖"的
    // 路径；机器人物理上撞在半砖上走不动，pathfinder 每 3.5s 判定 stuck 重规划、又算出同样的
    // 路径，循环到 30s wall-clock 超时（现象就是"有路但永远走不到"）。
    // 半砖/楼梯交给 pathfinder 按碰撞高度原生处理即可，本来就能走。

    bot.pathfinder.setMovements(movements)

    // A* 默认 thinkTimeout=5000ms、searchRadius=-1（不限半径）。
    // 在"上层农田 + 下层通道"这种大地形里，5 秒很容易被 A* 全部烧在搜索上，
    // 于是报 "Took to long to decide path to goal!" 而不是给出一条路径。
    // 放宽思考时间，并限制搜索半径，避免为了一个 10 格的目标去遍历整片农田。
    bot.pathfinder.thinkTimeout = 15000
    if (bot.pathfinder.searchRadius === -1) bot.pathfinder.searchRadius = 64

    if (!bot._farmlandJumpGuard) {
        bot._farmlandJumpGuard = true
        // 计数：守卫拦下了多少次跳跃。pathfinder 若正需要跳着上台阶却被拦，这个值会持续增长，
        // pathfinderGoto 靠它快速失败，而不是傻等 30s 超时。
        if (bot._jumpGuardBlocked == null) bot._jumpGuardBlocked = 0
        bot.on('physicsTick', () => {
            // 耕地上原地/平跳 → 拦；前方有 +1 台阶（跳上去不会落回耕地，不会踩坏）→ 放行
            if (bot.controlState.jump && shouldBlockJump(bot)) {
                bot.setControlState('jump', false)
                bot._jumpGuardBlocked++
            }
        })
    }

    return movements
}

/** 等待区块加载后再读取方块（Via 翻译时区块可能延迟） */
async function waitForBlock(bot, pos, timeoutMs = 6000) {
    const target = floorPos(pos)
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        const block = bot.blockAt(target, false)
        if (block) return block

        try {
            if (typeof bot.waitForChunksToLoad === 'function') {
                await bot.waitForChunksToLoad()
            }
        } catch (e) {
            // ignore
        }

        await sleep(250)
    }

    return null
}

const REACH = 4.5       // 通用交互/寻路到达距离
const PLANT_REACH = 2   // 种植必须在玩家 2 格以内

function isNearBlock(bot, pos, reach = REACH) {
    const center = floorPos(pos).offset(0.5, 0.5, 0.5)
    return bot.entity.position.distanceTo(center) <= reach
}

/** 寻路卡住时是否允许 /tp 脱困（需服务器授予 bot minecraft.command.teleport 权限） */
let teleportFallbackEnabled = true
function setTeleportFallbackEnabled(v) { teleportFallbackEnabled = !!v }

/**
 * 寻路卡住/超时后的兜底：用 /tp 直接传送到目标附近。
 *
 * 依据实测（2025-10-10 probe-stuck.js 探测）：A* 规划成功的路径也可能物理走不动 ——
 * 例如从 (1028,60,598) 出发的第一个斜穿步，夹角方块是 stone_bricks+箱子 两格高的墙，
 * 碰撞箱必然剐蹭卡死，pathfinder 每 3.5s 重规划出同样的路径，跳也没用（墙太高），
 * 只能等 30s 超时。服务器授予传送权限后，/tp 是最省事的脱困方式。
 *
 * 注意：GoalLookAtBlock 的 x/y/z 是"被看的方块"而不是站位，tp 进去会窒息，必须跳过。
 * @returns {Promise<boolean>} true = 已传送到目标附近，本次导航视为成功
 */
async function tryTeleportEscape(bot, goal) {
    if (!teleportFallbackEnabled) return false
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y) || !Number.isFinite(goal.z)) return false
    if (goal.constructor && goal.constructor.name === 'GoalLookAtBlock') return false

    // 默认目标点可能是方块坐标（尤其 farmland 自身格），直接传送到 goal.y 会把实体塞进方块，
    // 服务器随后将其推出/落回底层。本次导航可通过 goal.teleportYOffset 指定安全站立高度。
    const tpYOffset = Number.isFinite(goal.teleportYOffset) ? goal.teleportYOffset : 0
    const target = new Vec3(goal.x + 0.5, goal.y + tpYOffset, goal.z + 0.5)
    const before = bot.entity.position.clone()
    console.log(`[寻路] 尝试 /tp 脱困 → (${target.x.toFixed(1)},${target.y},${target.z.toFixed(1)})`)
    bot.chat(`/minecraft:tp ${target.x} ${target.y} ${target.z}`)
    await sleep(1800)

    const after = bot.entity.position
    const range = Number.isFinite(goal.range) ? Math.max(goal.range, 1.5) : 3
    bot.clearControlStates()
    if (after.distanceTo(target) <= range) {
        console.log('[寻路] /tp 脱困成功')
        return true
    }
    if (after.distanceTo(before) > 0.5) {
        // 传到了别处但确实动了：不算到达，交给上层重新决策
        console.log('[寻路] /tp 已生效但未到目标附近，放弃本次导航')
        return false
    }
    console.log('[寻路] /tp 未生效 (可能缺少传送权限)，继续按失败处理')
    return false
}

/**
 * pathfinder.goto 包装：避免超时 stop() 与 PathStopped 竞态
 * 增加卡住检测：执行中如果 bot 持续未移动则尝试跳跃越过障碍；
 * 若跳跃被"耕地保护"守卫连续拦下，说明这段路物理上必须跳，直接快速失败而不是干等超时；
 * 卡住 10 秒仍无进展时用 /tp 脱困（探测证实部分卡点物理上无解，重规划无意义）。
 * @see mineflayer-pathfinder lib/goto.js
 */
async function pathfinderGoto(bot, goal, timeoutMs) {
    let timedOut = false
    let bailed = false // 因"必须跳跃但被耕地保护拦截"主动放弃
    let escapeTried = false // 每次 goto 只尝试一次 /tp 脱困
    const startedAt = Date.now()
    const hasTarget = Number.isFinite(goal?.x) && Number.isFinite(goal?.y) && Number.isFinite(goal?.z)
    const timer = setTimeout(() => {
        timedOut = true
        bot.pathfinder.setGoal(null)
    }, timeoutMs)

    let lastPos = bot.entity.position.clone()
    let stuckTicks = 0
    let lastJumpTryTicks = 0
    let lastPathUpdate = 0
    const blockedAtStart = bot._jumpGuardBlocked || 0
    const stuckChecker = () => {
        if (bailed) return
        const pos = bot.entity.position
        // 【只看水平位移】贴墙原地跳（y 方向 0↔0.8 振荡、x/z 冻结）在旧的三维位移判定里
        // 被当成"在移动"，stuckTicks 反复清零，10s /tp 脱困永远不触发
        // （实测卡墙角：卡住计数 2→0→4→0 循环，磨满 45s 整段超时）。
        // 合法的跳跃前进每个采样周期水平位移远大于阈值，不受影响；
        // 纯垂直通道（梯子/气泡柱）超过 10s 会被误判 —— 本农田地形没有这类结构。
        const horizMoved = Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z)
        // 每 3 秒汇报一次：位置 / 速度 / 剩余距离 / 是否在移动。
        // 光看 "timeout" 无法区分"真的没路"和"原地卡死"，这里把过程打出来
        if (Date.now() - lastPathUpdate > 3000) {
            lastPathUpdate = Date.now()
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0)
            const speed = (horizMoved / 0.25).toFixed(2)
            const dist = hasTarget ? pos.distanceTo(new Vec3(goal.x, goal.y, goal.z)).toFixed(1) : '?'
            const status = bot.pathfinder.isMoving?.() ? '移动中' : '未移动'
            console.log(`[寻路] ${elapsed}s 坐标(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) ` +
                `速度${speed}/s 距目标 ${dist} 格 ${status} 卡住计数${stuckTicks}`)
        }
        if (horizMoved < 0.03) {
            stuckTicks++
            if (stuckTicks >= 3 && bot.entity.onGround) {
                // 守卫连续拦截跳跃 → 这一段路非要跳不可，早点报错
                if ((bot._jumpGuardBlocked || 0) - blockedAtStart >= 5) {
                    bailed = true
                    bot.pathfinder.setGoal(null)
                    return
                }
                // 卡住 10 秒仍无进展：跳跃试过了也没用（实测有些卡点物理无解），
                // 取消寻路触发 goto reject，在 catch 里执行 /tp 脱困
                if (stuckTicks >= 40 && !escapeTried) {
                    escapeTried = true
                    console.log(`[寻路] 连续 ${stuckTicks} 次未移动，请求 /tp 脱困`)
                    bot.pathfinder.setGoal(null)
                    return
                }
                // 自上次尝试跳跃以来仍无进展，说明跳也没用：不再重复刷日志，只继续物理尝试
                if (stuckTicks - lastJumpTryTicks >= 12) {
                    lastJumpTryTicks = stuckTicks
                    console.log(`[寻路] 连续 ${stuckTicks} 次未移动，尝试跳跃脱困 ` +
                        `坐标(${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)})`)
                }
                safeJump(bot)
            }
        } else {
            stuckTicks = 0
            lastJumpTryTicks = 0
        }
        lastPos = pos.clone()
    }
    const stuckInterval = setInterval(stuckChecker, 250)

    try {
        await bot.pathfinder.goto(goal)
    } catch (err) {
        // 兜底：卡死/超时后用 /tp 直接脱困（卡住 10s 的主动取消和超时都会走到这里）
        const escapeOk = hasTarget && !escapeTried && await tryTeleportEscape(bot, goal)
        if (escapeOk) return

        if (bailed) throw new Error('此段路必须跳跃，但被耕地保护拦截')
        if (timedOut) throw new Error('timeout')
        const msg = err.message || String(err)
        if (err.name === 'NoPath' || msg.includes('No path')) {
            throw new Error('no path')
        }
        if (err.name === 'GoalChanged' || err.name === 'PathStopped' ||
            msg.includes('Path was stopped') || msg.includes('goal was changed')) {
            throw new Error('path stopped')
        }
        throw err
    } finally {
        clearTimeout(timer)
        clearInterval(stuckInterval)
        bot.setControlState('jump', false)
    }
}

/**
 * 靠近箱子以便交互（需要能看到箱子的某个面）
 * @see mineflayer-pathfinder GoalLookAtBlock — "Path into a position where a blockface is visible"
 */
async function approachChest(bot, chestPos, timeoutMs = 20000) {
    const pos = floorPos(chestPos)
    const block = await waitForBlock(bot, pos, 3000)
    if (!block) throw new Error('chunk not loaded')

    if (isNearBlock(bot, pos, 4.5) && bot.canSeeBlock(block)) {
        return
    }

    bot.clearControlStates()

    const goal = new goals.GoalLookAtBlock(pos, bot.world, { reach: 4.5 })
    await pathfinderGoto(bot, goal, timeoutMs)
}

/** @deprecated 使用 approachChest */
async function approachBlock(bot, pos, timeoutMs = 12000) {
    return approachChest(bot, pos, timeoutMs)
}

/**
 * 寻路到方块相邻格（官方文档：GoalGetToBlock，适用于箱子）
 * @see mineflayer-pathfinder readme GoalGetToBlock
 */
async function gotoBlock(bot, pos, timeoutMs = 15000, options = {}) {
    const target = floorPos(pos)
    const block = await waitForBlock(bot, target, Math.min(timeoutMs / 2, 5000))
    if (!block) {
        throw new Error('chunk not loaded')
    }
    if (isNearBlock(bot, target) && !options.forInteract) return

    const goal = options.forInteract
        ? new goals.GoalLookAtBlock(target, bot.world, { reach: REACH })
        : new goals.GoalGetToBlock(target.x, target.y, target.z)
    await pathfinderGoto(bot, goal, timeoutMs)
}

/**
 * 平面寻路：只用 X/Z，忽略 Y 偏差（适合农田）
 * @param {object} options
 * @param {function} options.workAreaChecker 可选的工作区域检查函数 (pos) => boolean
 */
async function gotoNear(bot, pos, range = 2, timeoutMs = 10000, options = {}) {
    const { workAreaChecker } = options
    const target = floorPos(pos)
    const x = target.x
    const z = target.z

    if (workAreaChecker && !workAreaChecker({ x, z })) {
        throw new Error('target outside work area')
    }

    const block = await waitForBlock(bot, target, Math.min(timeoutMs / 2, 5000))
    if (!block) {
        console.log(`[移动] 区块未加载: ${x},${target.y},${z}`)
        throw new Error('chunk not loaded')
    }

    const goal = new goals.GoalNearXZ(x, z, range)

    try {
        await pathfinderGoto(bot, goal, timeoutMs)
    } catch (err) {
        const msg = err.message || String(err)
        if (!msg.includes('timeout') && !msg.includes('path stopped') && !msg.includes('no path')) {
            console.log(`[移动] 寻路失败 -> ${x},${z}: ${msg}`)
        }
        throw err
    }
}

// 只在"耕地"上禁止跳跃：原地起跳落回耕地 fallDistance≈1.2 > 原版踩踏阈值 0.5，
// 会以 (fallDistance-0.5) 的概率把耕地踩回泥土。
// 半砖/楼梯【不】在此列 —— 在半砖上跳一下不会破坏任何东西，把它们列进来反而会让机器人
// 永远上不了半砖楼梯（想跳就立刻被取消，动作永远完不成）。
const NO_JUMP_BLOCKS = new Set(['farmland'])

/**
 * 脚下是否为禁止跳跃的方块。
 * 【注意】耕地碰撞箱高度 15/16，站在耕地上时脚部 Y = 耕地格Y + 0.9375，
 * 所以支撑格是 floor(脚部Y) 本身而不是 floor-1（普通满格方块才是 floor-1）。
 * 两种情况都要查，否则守卫在耕地上永远不触发（实测踩过这个坑）。
 */
function isOnNoJumpBlock(bot) {
    const pos = bot.entity.position
    const baseY = Math.floor(pos.y)
    const belowFull = bot.blockAt(new Vec3(Math.floor(pos.x), baseY - 1, Math.floor(pos.z)))
    if (belowFull != null && NO_JUMP_BLOCKS.has(belowFull.name)) return true
    // 低碰撞箱支撑（耕地 0.9375）：脚部落在支撑格内部
    const belowLow = bot.blockAt(new Vec3(Math.floor(pos.x), baseY, Math.floor(pos.z)))
    return belowLow != null && NO_JUMP_BLOCKS.has(belowLow.name)
}

/**
 * 前方是否有 +1 台阶需要跳上去。
 * 跳上台阶时落回高度只比起跳高 1 格，落回时 fallDistance≈0.25 < 0.5 踩踏阈值，
 * 且起跳块不会被落回 —— 这种跳跃【不会】踩坏耕地，应当放行。
 * 真正危险的是原地跳/平跳落回耕地（fallDistance≈1.2），那才是要拦的。
 */
function isStepUpAhead(bot) {
    const pos = bot.entity.position
    const yaw = bot.entity.yaw ?? 0
    const dx = -Math.sin(yaw)
    const dz = -Math.cos(yaw)
    const feetY = Math.floor(pos.y)
    for (const d of [0.6, 1.1]) {
        const ahead = bot.blockAt(new Vec3(Math.floor(pos.x + dx * d), feetY, Math.floor(pos.z + dz * d)))
        if (ahead && ahead.boundingBox === 'block') return true
    }
    return false
}

/** 脚下在耕地上且前方没有台阶 → 该跳被禁 */
function shouldBlockJump(bot) {
    return isOnNoJumpBlock(bot) && !isStepUpAhead(bot)
}

/** 检测前方是否有需要跳跃才能越过的方块 */
function hasBlockAhead(bot) {
    const pos = bot.entity.position
    const yaw = bot.entity.yaw
    const dx = -Math.sin(yaw)
    const dz = -Math.cos(yaw)
    const ahead = new Vec3(
        Math.floor(pos.x + dx * 0.8),
        Math.floor(pos.y),
        Math.floor(pos.z + dz * 0.8)
    )
    const block = bot.blockAt(ahead)
    return block && block.boundingBox === 'block'
}

/** 安全跳跃：原地/平跳落回耕地时禁跳；前方有台阶的起跳放行 */
function safeJump(bot) {
    if (shouldBlockJump(bot)) return false
    bot.setControlState('jump', true)
    setTimeout(() => bot.setControlState('jump', false), 120)
    return true
}

/** 短距离直线移动（不依赖 pathfinder） */
async function walkToFlat(bot, pos, timeoutMs = 5000, reach = REACH) {
    const targetCenter = floorPos(pos).offset(0.5, 0, 0.5)
    const startTime = Date.now()
    const startPos = bot.entity.position.clone()
    let lastDist = Infinity
    let stuckCount = 0

    bot.setControlState('forward', true)
    // 【不要 sprint】冲刺跳落地 fallDistance≈1.2 > 0.5 阈值，会踩坏耕地；
    // 而且冲刺跳飞行 4+ 格会冲过头，对 0.45 精度的对齐毫无帮助
    bot.setControlState('sprint', false)

    try {
        while (Date.now() - startTime < timeoutMs) {
            const dist = bot.entity.position.distanceTo(targetCenter)
            if (dist <= reach) return true

            const lookTarget = targetCenter.offset(0, 0.5, 0)
            await bot.lookAt(lookTarget, true).catch(() => {})

            if (Math.abs(dist - lastDist) < 0.05) {
                stuckCount++
                if (stuckCount > 8) throw new Error('stuck')
                if (stuckCount >= 4 && hasBlockAhead(bot)) {
                    if (safeJump(bot)) await sleep(100)
                }
            } else {
                stuckCount = 0
            }

            lastDist = dist
            await sleep(50)
        }

        const moved = startPos.distanceTo(bot.entity.position)
        if (moved >= 0.5) return true
        throw new Error('walk timeout')
    } finally {
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        bot.setControlState('jump', false)
    }
}/** 作物方块中心（用于距离/视线判定） */
function getCropCenter(soilPos) {
    return floorPos(soilPos).offset(0.5, 1.5, 0.5)
}

function canReachCrop(bot, soilPos, reach = PLANT_REACH) {
    return bot.entity.position.distanceTo(getCropCenter(soilPos)) <= reach
}

/** 耕地顶面中心（placeBlock 视线目标） */
function getFarmlandFaceCenter(soilPos) {
    return floorPos(soilPos).offset(0.5, 1.0, 0.5)
}

/** 视线是否对准目标耕地 */
function getCursorFarmland(bot, soilPos, maxDist = PLANT_REACH + 0.5) {
    const soil = floorPos(soilPos)
    if (typeof bot.blockAtCursor !== 'function') return null

    const block = bot.blockAtCursor(maxDist)
    if (!block || block.name !== 'farmland') return null
    if (block.position.x !== soil.x || block.position.y !== soil.y || block.position.z !== soil.z) return null
    return block
}

function isFacingFarmland(bot, soilPos) {
    return !!getCursorFarmland(bot, soilPos)
}

/** 目标土壤格对应的脚部节点层：farmland 是 15/16 碰撞箱，dirt 是完整方块 */
function getSoilFootY(bot, soilPos) {
    const s = floorPos(soilPos)
    const block = bot.blockAt(s)
    // pathfinder 把 farmland 加入 carpets 后，farmland 站位节点仍是同一 block Y；
    // dirt/full block 的脚部节点必须在方块上方一格。
    return block?.name === 'farmland' ? s.y : s.y + 1
}

/** 是否确实站在目标土壤格上（校验 X/Y/Z，支持 trampled dirt 修复） */
function isStandingOnSoil(bot, soilPos) {
    const s = floorPos(soilPos)
    const p = bot.entity.position
    return Math.floor(p.x) === s.x &&
        Math.floor(p.y) === getSoilFootY(bot, s) &&
        Math.floor(p.z) === s.z
}

/** 获取 bot 脚下的 farmland */
function getSoilUnderFeet(bot) {
    const p = bot.entity.position
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    const baseY = Math.floor(p.y)

    for (let y = baseY; y >= baseY - 2; y--) {
        const soilPos = new Vec3(x, y, z)
        const block = bot.blockAt(soilPos)
        if (block?.name === 'farmland') {
            return { soilPos, block }
        }
    }
    return null
}

function getStandCenterOnSoil(soilPos) {
    return floorPos(soilPos).offset(0.5, 1, 0.5)
}

/** 移动到目标耕地格上站定 */
async function moveToStandOnSoil(bot, soilPos, options = {}) {
    // workAreaChecker 可能带 y 校验（如 DaoXiang 的分层梯田）—— 把 y 一起传过去，
    // 只传 {x,z} 会让 "pos.y === 期望层" 的检查拿到 undefined 恒为 false
    if (options.workAreaChecker &&
        !options.workAreaChecker({ x: soilPos.x, y: soilPos.y, z: soilPos.z })) {
        if (options.debugMovement) {
            console.log(`[移动][诊断] workAreaChecker 拒绝地块 (${soilPos.x},${soilPos.y},${soilPos.z})`)
        }
        return false
    }

    if (isStandingOnSoil(bot, soilPos)) {
        stopMovement(bot)
        return true
    }

    stopMovement(bot)
    if (options.pathfinderOnly) {
        // 农田格之间/跨一格台阶，用 pathfinder 的 XZ 目标定位到方块列；
        // 旧的 walkToFlat 是自定义直线控制，遇到低碰撞箱耕地可能停在相邻格，且吞掉了失败原因。
        try {
            // 精确目标格：farmland 的 pathfinder 节点 Y=soilY；trampled dirt 是完整方块，站位节点 Y=soilY+1。
            // GoalNearXZ 会忽略高度，可能停在上层地块正下方；GoalBlock 同时约束正确站立层。
            const soilBlock = bot.blockAt(floorPos(soilPos))
            const footY = soilBlock?.name === 'farmland' ? soilPos.y : soilPos.y + 1
            const goal = new goals.GoalBlock(soilPos.x, footY, soilPos.z)
            // farmland 方块本身的 tp 落点为 soilY+1；dirt 的 GoalBlock 已是表面脚部层，不再偏移。
            const defaultTpOffset = soilBlock?.name === 'farmland' ? 1 : 0
            goal.teleportYOffset = options.teleportYOffset ?? defaultTpOffset
            await pathfinderGoto(bot, goal, options.timeoutMs || 10000)
        } catch (e) {
            if (options.debugMovement) {
                console.log(`[移动][诊断] GoalBlock 失败 soil=(${soilPos.x},${soilPos.y},${soilPos.z}): ${e.message}`)
            }
        }
    } else {
        await moveToFlat(bot, getStandCenterOnSoil(soilPos), {
            ...options,
            reach: 0.45,
            timeoutMs: options.timeoutMs || 10000
        }).catch((e) => {
            if (options.debugMovement) console.log(`[移动][诊断] moveToFlat 失败: ${e.message}`)
        })
    }

    if (isStandingOnSoil(bot, soilPos)) {
        console.log(`[移动] 站上耕地 (${soilPos.x},${soilPos.z})`)
        stopMovement(bot)
        return true
    }

    const p = bot.entity.position
    console.log(`[移动] 未能站上耕地 (${soilPos.x},${soilPos.z}) bot(${p.x.toFixed(1)},${p.z.toFixed(1)})`)
    return false
}

/** 低头看脚下耕地（站在这格上时种植） */
async function faceDownAtFeetFarmland(bot, soilPos, options = {}) {
    const maxRetries = options.retries ?? 4
    const settleMs = options.settleMs ?? 400
    const face = getFarmlandFaceCenter(soilPos)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        stopMovement(bot)
        await bot.lookAt(face)
        await sleep(settleMs)

        if (await confirmFacing(bot, soilPos)) return true

        await bot.look(bot.entity.yaw, 1.15)
        await sleep(settleMs)
        if (await confirmFacing(bot, soilPos)) return true
    }

    return false
}

/** @deprecated 使用 moveToStandOnSoil + faceDownAtFeetFarmland */
function isOnCardinalStand(bot, soilPos) {
    return isStandingOnSoil(bot, soilPos)
}

/**
 * 低头种植：水平朝向与移动方向一致，pitch 向下看目标耕地顶面
 * （站在目标正相邻格时，等价于低头看前方脚下那块田）
 */
async function faceDownAtTargetFarmland(bot, soilPos, options = {}) {
    const maxRetries = options.retries ?? 5
    const settleMs = options.settleMs ?? 400
    const targetFace = getFarmlandFaceCenter(soilPos)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        stopMovement(bot)

        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const dx = targetFace.x - eye.x
        const dz = targetFace.z - eye.z
        const yaw = Math.atan2(-dx, -dz)
        const horiz = Math.sqrt(dx * dx + dz * dz)
        const dy = targetFace.y - eye.y
        const pitch = Math.atan2(dy, horiz)

        await bot.look(yaw, pitch)
        await sleep(settleMs)

        if (await confirmFacing(bot, soilPos)) {
            return true
        }

        // 再略低头
        await bot.look(yaw, Math.min(pitch + 0.12, Math.PI / 2 - 0.05))
        await sleep(settleMs)
        if (await confirmFacing(bot, soilPos)) {
            return true
        }
    }

    return false
}

/** @deprecated 使用 faceDownAtTargetFarmland */
async function faceFarmlandForPlant(bot, soilPos, options = {}) {
    return faceDownAtTargetFarmland(bot, soilPos, options)
}

/** 连续两次确认视线落在目标耕地（避免 Via 延迟误判） */
async function confirmFacing(bot, soilPos) {
    if (!isFacingFarmland(bot, soilPos)) return false
    await sleep(120)
    return isFacingFarmland(bot, soilPos)
}

function getFacingDiagnostics(bot, soilPos) {
    const cursor = getCursorFarmland(bot, soilPos)
    let cursorInfo = '无'
    if (cursor) {
        const p = cursor.position
        cursorInfo = `farmland@${p.x},${p.y},${p.z}`
    } else if (typeof bot.blockAtCursor === 'function') {
        const hit = bot.blockAtCursor(PLANT_REACH + 0.5)
        cursorInfo = hit ? `${hit.name}@${hit.position}` : '无'
    }

    return `yaw=${bot.entity.yaw.toFixed(2)} pitch=${bot.entity.pitch.toFixed(2)} 视线=${cursorInfo}`
}

const STAND_BLOCK_NAMES = new Set(['farmland'])

function isStandBlock(block) {
    if (!block) return false
    if (STAND_BLOCK_NAMES.has(block.name)) return true
    return block.name.endsWith('_slab')
}

/** 目标耕地周围可站立的位置（仅正相邻四格） */
function getPlantStandCenters(bot, soilPos) {
    const s = floorPos(soilPos)
    const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1]]

    return offsets
        .map(([dx, dz]) => ({ dx, dz, pos: new Vec3(s.x + dx, s.y, s.z + dz) }))
        .filter(({ pos }) => isStandBlock(bot.blockAt(pos)))
        .map(({ pos }) => ({
            center: pos.offset(0.5, 1, 0.5),
            cardinal: true
        }))
}

/**
 * 移动到能种目标耕地的站立点（不走向空气格，而是相邻耕地）
 */
async function moveToPlant(bot, area, options = {}) {
    const reach = options.reach ?? PLANT_REACH
    const cropCenter = getCropCenter(area.soilPos)
    const canPlantFromHere = () => bot.entity.position.distanceTo(cropCenter) <= reach

    const finishMove = async () => {
        if (!canPlantFromHere()) return false
        if (!isOnCardinalStand(bot, area.soilPos)) return false
        return faceDownAtTargetFarmland(bot, area.soilPos, options)
    }

    if (await finishMove()) return true

    const botPos = bot.entity.position
    const stands = getPlantStandCenters(bot, area.soilPos)
        .filter(({ center }) => {
            if (!options.workAreaChecker) return true
            return options.workAreaChecker({ x: Math.floor(center.x), z: Math.floor(center.z) })
        })
        .map(({ center, cardinal }) => ({
            stand: center,
            cardinal,
            fromBot: botPos.distanceTo(center),
            toCrop: center.distanceTo(cropCenter)
        }))
        .filter(s => s.toCrop <= reach + 0.01)
        .sort((a, b) => a.fromBot - b.fromBot)

    if (stands.length === 0) {
        console.log(`[移动] 无可用站立点 (${area.soilPos.x},${area.soilPos.z})`)
        return false
    }

    for (const { stand } of stands) {
        stopMovement(bot)

        await moveToFlat(bot, stand, {
            ...options,
            reach: 0.55,
            timeoutMs: options.timeoutMs || 8000
        }).catch(() => false)

        if (canPlantFromHere()) {
            if (await finishMove()) {
                console.log(`[移动] 到达种植位 (${Math.floor(area.soilPos.x)},${Math.floor(area.soilPos.z)}) 距作物${bot.entity.position.distanceTo(cropCenter).toFixed(1)}`)
                return true
            }
            continue
        }

        // 微调：朝作物中心短距离挪动（结束后会重新对准耕地）
        try {
            await walkToFlat(bot, cropCenter, 2500, reach)
        } catch (e) {
            // ignore
        }

        if (await finishMove()) {
            console.log(`[移动] 微调到达 (${Math.floor(area.soilPos.x)},${Math.floor(area.soilPos.z)}) 距作物${bot.entity.position.distanceTo(cropCenter).toFixed(1)}`)
            return true
        }
    }

    const remain = bot.entity.position.distanceTo(cropCenter)
    if (canPlantFromHere()) {
        console.log(`[移动] 距离够但朝向不对 (${area.soilPos.x},${area.soilPos.z}) ${getFacingDiagnostics(bot, area.soilPos)}`)
    } else {
        console.log(`[移动] 未能靠近 (${area.soilPos.x},${area.soilPos.z}) 仍距${remain.toFixed(1)}格(需要≤${reach})`)
    }
    return false
}

/** 先直线走，失败再用 pathfinder；必须实际靠近目标才算成功 */
async function moveToFlat(bot, pos, options = {}) {
    const reach = options.reach ?? REACH
    const startPos = bot.entity.position.clone()
    const distBefore = startPos.distanceTo(pos)

    if (distBefore <= reach) {
        return true
    }

    if (distBefore <= 12) {
        try {
            await walkToFlat(bot, pos, 5000, reach)
        } catch (e) {
            // fallback to pathfinder
        }
    }

    const distMid = bot.entity.position.distanceTo(pos)
    if (distMid > reach) {
        try {
            await gotoNear(bot, pos, Math.min(2, reach), options.timeoutMs || 12000, options)
        } catch (e) {
            // 下面统一验证是否真的靠近了
        }
    }

    const distAfter = bot.entity.position.distanceTo(pos)
    const moved = startPos.distanceTo(bot.entity.position)

    if (distAfter <= reach) {
        console.log(`[移动] 到达 (${Math.floor(pos.x)},${Math.floor(pos.z)}) 移动了${moved.toFixed(1)}格 距目标${distAfter.toFixed(1)}`)
        return true
    }

    console.log(`[移动] 未能靠近 (${Math.floor(pos.x)},${Math.floor(pos.z)}) 仍距${distAfter.toFixed(1)}格(需要≤${reach})`)
    return false
}

function stopMovement(bot) {
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
}

module.exports = {
    REACH,
    PLANT_REACH,
    getCropCenter,
    getFarmlandFaceCenter,
    canReachCrop,
    isFacingFarmland,
    getStandCenterOnSoil,
    getSoilUnderFeet,
    isStandingOnSoil,
    moveToStandOnSoil,
    faceDownAtFeetFarmland,
    isOnCardinalStand,
    faceDownAtTargetFarmland,
    faceFarmlandForPlant,
    confirmFacing,
    getFacingDiagnostics,
    moveToPlant,
    configureMovements,
    waitForBlock,
    gotoNear,
    gotoBlock,
    approachBlock,
    approachChest,
    isNearBlock,
    walkToFlat,
    moveToFlat,
    stopMovement,
    pathfinderGoto,
    tryTeleportEscape,
    setTeleportFallbackEnabled,
    isOnNoJumpBlock,
    isStepUpAhead,
    shouldBlockJump,
    sleep
}
