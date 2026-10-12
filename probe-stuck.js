/**
 * probe-stuck.js — 寻路卡住原因探测器
 *
 * 连接 MC 服务器，用与 FarmMaster 完全相同的 Movements 配置，探测：
 *   1. 卡住点 (1028,60,598) 附近 pathfinder 眼中的方块判定（safe/physical/height/shapes）
 *   2. 楼梯区所有 slab/stairs 的几何类型（bottom/top/double）—— 上不去的头号嫌疑
 *   3. 用真实 pathfinder 从当前位置算一条到 (1025,70,598) 的路径，打印每个节点
 *      以及失败状态（noPath/partial/success）
 *
 * 用法: node probe-stuck.js
 * 探测账号 FarmProbe 与 FarmMaster 互不冲突；优先尝试 /tp，失败则自己走过去。
 */
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder, goals, Move } = require('mineflayer-pathfinder')
const { configureMovements } = require('./utils/movement')

const fs = require('fs')
const path = require('path')
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'bots/farmMaster/farmmaster_config.json'), 'utf-8'))

// 卡住点与目标（来自 17:58 的运行日志）
const STUCK_CELL = new Vec3(1028, 60, 598)      // bot 卡住时脚下的整数坐标
const GOAL = { x: 1025, y: 70, z: 598 }          // 路径点 2
const POS2 = new Vec3(1026, 60, 598)

const bot = mineflayer.createBot({
    ...cfg.server,
    username: 'FarmProbe',
    hideErrors: false
})

bot.on('kicked', (reason) => { console.log('[探测] 被踢出:', reason); process.exit(2) })
bot.on('error', (e) => { console.log('[探测] 连接错误:', e.message) })

process.on('unhandledRejection', (e) => console.log('[探测][未处理]', e && e.message))

bot.on('spawn', async () => {
    try {
        console.log(`[探测] 已上线，出生点 (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${bot.entity.position.z.toFixed(1)})`)
        bot.loadPlugin(pathfinder)

        // 与 FarmMaster 完全相同的移动配置
        const movements = configureMovements(bot)
        console.log('[探测] Movements 已按 FarmMaster 配置加载 ' +
            `(canDig=${movements.canDig} allowSprinting=${movements.allowSprinting} allowParkour=${movements.allowParkour})`)

        await bot.waitForChunksToLoad()

        // ---- 尝试 /tp（Essentials 可能拦截别名，依次尝试原版/带命名空间形式） ----
        const distToSite = () => bot.entity.position.distanceTo(STUCK_CELL.offset(0.5, 0, 0.5))
        if (distToSite() > 24) {
            console.log('[探测] 距卡住点较远，尝试 /tp ...')
            const tpVariants = [
                coords => `/tp ${coords}`,
                coords => `/minecraft:tp ${coords}`,
                coords => `/teleport ${coords}`
            ]
            const coords = '1028.2 61 598.7'
            for (let round = 0; round < 6 && distToSite() > 24; round++) {
                const variant = tpVariants[round % tpVariants.length]
                bot.chat(variant(coords))
                await new Promise(r => setTimeout(r, 3000))
                if (distToSite() <= 24) break
                console.log(`[探测] ${variant('(x y z)')} 未生效 (第 ${round + 1} 次)，换下一种写法...`)
            }
        }
        if (distToSite() > 24) {
            console.log('[探测] /tp 均未生效，尝试自己走过去 (最长90s)...')
            try {
                await bot.pathfinder.goto(new goals.GoalNear(1028, 61, 598, 1))
            } catch (e) {
                console.log(`[探测] 走过去失败: ${e.message} (当前 ${bot.entity.position.floored()})`)
            }
        }

        // 等待卡住点所在区块加载（最多 30s）
        for (let i = 0; i < 60; i++) {
            if (bot.blockAt(STUCK_CELL) && bot.blockAt(new Vec3(GOAL.x, GOAL.y - 1, GOAL.z))) break
            await new Promise(r => setTimeout(r, 500))
        }
        if (!bot.blockAt(STUCK_CELL)) {
            console.log('[探测] 卡住点区块始终未加载，无法继续探测。请手动 /tp FarmProbe 1028 61 598 后重跑本脚本')
            return finish(3)
        }
        console.log(`[探测] 就位 (${bot.entity.position.floored()})，距卡住点 ${distToSite().toFixed(1)} 格，开始诊断\n`)

        // ================= 诊断 1: 卡住点九宫格 + 站位判定 =================
        console.log('===== [1] 卡住点 (1028,60,598) 周围 pathfinder 判定 =====')
        console.log('说明: safe=可站立 physical=实体碰撞 height=顶面高度 (相对Y)')
        for (const dy of [1, 0, -1]) {
            console.log(`--- dy=${dy} (Y=${STUCK_CELL.y + dy}) ---`)
            for (let dz = -1; dz <= 1; dz++) {
                const row = []
                for (let dx = -1; dx <= 1; dx++) {
                    const b = movements.getBlock(STUCK_CELL, dx, dy, dz)
                    const flag = `${b.safe ? 'S' : '-'}${b.physical ? 'P' : '-'}`
                    row.push(`${b.name}@${flag}@h${b.height.toFixed(2)}`)
                }
                console.log(`  z${dz >= 0 ? '+' : ''}${dz}: ${row.join(' | ')}`)
            }
        }

        // ================= 诊断 2: 楼梯几何 =================
        console.log('\n===== [2] 卡住点周围 20 格内所有 slab/stairs =====')
        const slabs = bot.findBlocks({
            matching: b => b.name.endsWith('_slab') || b.name.endsWith('_stairs'),
            point: POS2,
            maxDistance: 20,
            count: 300
        }).sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)

        if (slabs.length === 0) {
            console.log('  (未找到任何 slab/stairs!)')
        } else {
            // findBlocks 返回的是 Vec3 位置数组，不是方块对象
            const byY = new Map()
            for (const p of slabs) {
                const b = bot.blockAt(p)
                if (!b) continue
                const props = b.getProperties?.() ?? {}
                const t = props.type ?? props.half ?? '?'
                if (!byY.has(p.y)) byY.set(p.y, [])
                byY.get(p.y).push(`(${p.x},${p.z})${b.name.replace('birch_', 'b_')}:${t}`)
            }
            for (const [y, list] of [...byY.entries()].sort((a, b) => a[0] - b[0])) {
                console.log(`  Y=${y}: ${list.join(' ')}`)
            }
        }

        // ================= 诊断 3: 目标点周边 =================
        console.log('\n===== [3] 目标点 (1025,70,598) 周边方块 =====')
        for (const [label, p] of [
            ['目标脚下', new Vec3(GOAL.x, GOAL.y - 1, GOAL.z)],
            ['目标站位', new Vec3(GOAL.x, GOAL.y, GOAL.z)],
            ['目标头顶', new Vec3(GOAL.x, GOAL.y + 1, GOAL.z)],
            ['pos1(上层)', new Vec3(1026, 70, 599)],
            ['pos1脚下', new Vec3(1026, 69, 599)]
        ]) {
            const b = bot.blockAt(p)
            const props = b ? JSON.stringify(b.getProperties?.() ?? {}) : '?'
            console.log(`  ${label} (${p.x},${p.y},${p.z}): ${b ? b.name : 'null(未加载)'} ${props}`)
        }

        // ================= 诊断 4: 真实寻路 =================
        console.log('\n===== [4] 用 FarmMaster 的 Movements 计算到 (1025,70,598) 的路径 =====')
        const startPos = STUCK_CELL.offset(0.5, 0, 0.5)
        const gen = bot.pathfinder.getPathFromTo(movements, startPos, new goals.GoalNear(GOAL.x, GOAL.y, GOAL.z, 2), { timeout: 5000 })
        const { value: { result } } = gen.next()
        console.log(`  状态: ${result.status}  路径长度: ${result.path ? result.path.length : 0}  cost: ${result.cost}`)

        if (result.path && result.path.length > 0) {
            console.log('  --- 路径节点 (前 40 个) ---')
            result.path.slice(0, 40).forEach((n, i) => {
                const ground = bot.blockAt(new Vec3(n.x, n.y - 1, n.z))
                const feet = bot.blockAt(new Vec3(n.x, n.y, n.z))
                const dy = i === 0 ? 0 : n.y - result.path[i - 1].y
                console.log(`  #${i} (${n.x},${n.y},${n.z}) dy=${dy} 地面=${ground ? ground.name : '?'} 站位=${feet ? feet.name : '?'}`)
            })
        } else {
            console.log('  [无路径] —— 上面第 1 节的 S/P/h 标记就是原因')
        }

        return finish(0)
    } catch (e) {
        console.log('[探测] 异常:', e.stack || e.message)
        return finish(4)
    }
})

function finish(code) {
    try { bot.quit() } catch (e) { /* ignore */ }
    setTimeout(() => process.exit(code), 500)
}

// 整体超时保护
setTimeout(() => {
    console.log('[探测] 超时退出 (240s)')
    process.exit(5)
}, 240000)
