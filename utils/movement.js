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
    movements.allowParkour = true
    movements.allowFreeMotion = true
    movements.allowSprinting = true
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

    // 台阶/半砖可行走（如农田中的 stone_slab 通道）
    for (const block of registry.blocksArray) {
        if (block.name.endsWith('_slab') || block.name === 'snow') {
            movements.carpets.add(block.id)
        }
    }

    bot.pathfinder.setMovements(movements)

    if (!bot._farmlandJumpGuard) {
        bot._farmlandJumpGuard = true
        bot.on('physicsTick', () => {
            if (bot.controlState.jump && isOnNoJumpBlock(bot)) {
                bot.setControlState('jump', false)
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

/**
 * pathfinder.goto 包装：避免超时 stop() 与 PathStopped 竞态
 * 增加卡住检测：执行中如果 bot 持续未移动则尝试跳跃越过障碍
 * @see mineflayer-pathfinder lib/goto.js
 */
async function pathfinderGoto(bot, goal, timeoutMs) {
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        bot.pathfinder.setGoal(null)
    }, timeoutMs)

    let lastPos = bot.entity.position.clone()
    let stuckTicks = 0
    const stuckChecker = () => {
        const pos = bot.entity.position
        const moved = pos.distanceTo(lastPos)
        if (moved < 0.03) {
            stuckTicks++
            if (stuckTicks >= 3 && bot.entity.onGround) {
                safeJump(bot)
            }
        } else {
            stuckTicks = 0
        }
        lastPos = pos.clone()
    }
    const stuckInterval = setInterval(stuckChecker, 250)

    try {
        await bot.pathfinder.goto(goal)
    } catch (err) {
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

const NO_JUMP_BLOCKS = new Set(['farmland', 'birch_slab'])

/** 脚下是否为禁止跳跃的方块 */
function isOnNoJumpBlock(bot) {
    const pos = bot.entity.position
    const below = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)))
    return below != null && NO_JUMP_BLOCKS.has(below.name)
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

/** 安全跳跃：在禁跳方块上不跳 */
function safeJump(bot) {
    if (isOnNoJumpBlock(bot)) return false
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
    bot.setControlState('sprint', true)

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
}

/** 作物方块中心（用于距离/视线判定） */
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

/** 是否站在目标耕地格上（X/Z 对齐） */
function isStandingOnSoil(bot, soilPos) {
    const s = floorPos(soilPos)
    return Math.floor(bot.entity.position.x) === s.x &&
        Math.floor(bot.entity.position.z) === s.z
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
    if (options.workAreaChecker && !options.workAreaChecker({ x: soilPos.x, z: soilPos.z })) {
        return false
    }

    if (isStandingOnSoil(bot, soilPos)) {
        stopMovement(bot)
        return true
    }

    stopMovement(bot)
    await moveToFlat(bot, getStandCenterOnSoil(soilPos), {
        ...options,
        reach: 0.45,
        timeoutMs: options.timeoutMs || 10000
    }).catch(() => false)

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
    sleep
}
