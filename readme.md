# Minecraft Farm Bots

基于 Mineflayer + mineflayer-statemachine 的 Minecraft 自动化农业机器人。

> 目前仅维护 **FarmMaster**（红石农场主机器人）。

## 项目结构

```
mc_bot/
├── utils/                          # 共享工具层
│   ├── movement.js                 # 寻路、移动、站位、种植朝向
│   ├── container.js                # 箱子交互（多面靠近 + 开箱）
│   ├── farmScan.js                 # 农田扫描与统计
│   ├── plantBlacklist.js           # 种植协议超时黑名单
│   ├── lruMap.js                   # LRU Map 数据结构
│   ├── log.js                      # 控制台时间戳
│   └── closableWebserver.js        # 可关闭的状态机 Web 可视化
├── bots/
│   └── farmMaster/                 # 农场主机器人 — 拉杆收割 + 多种子播种
│       ├── index.js                # 入口 + 状态机
│       ├── config.js               # 运行时状态
│       ├── farmmaster_config.json  # 持久化配置
│       ├── commands.js             # 聊天命令
│       └── behaviors/              # 专用行为状态
└── package.json
```

## 快速开始

```bash
npm install

# 启动农场主机器人
npm run farmmaster

# 开发模式（自动重启）
npm run farmmaster:dev
```

## DaoXiang（稻香）— 梯田农民机器人

为**新版两层梯田**重做的农民机器人（旧 FarmMaster 面向单层农田布局，保留可并行运行，Web 端口不同）。

启动：

```
npm run daoxiang
```

### 游戏规则 → 代码映射

| 规则 | 实现 |
|---|---|
| 两层梯田 Y=69(X1017~1024)/Y=70(X1010~1016) 跨上不跳 | `configureMovements` 的耕地跳跃守卫：站在 farmland 上禁止跳跃，楼梯/台阶路径不受影响 |
| 拉杆 (1027,70,570) 收割；开启后 ≥10s 水流才冲完 | `BehaviorWaitHarvest`：`harvest.waitMinSeconds` 配置且**硬性下限 10s**，闭环等到成熟占比≤5% |
| 播种前拉杆必须关闭（否则种子被冲走） | `BehaviorPlantSeeds._isLeverOff()` 播种前读拉杆 powered，仍开着 → 转去 `deactivateLever` 先关水 |
| 8 个半砖下水坑地块不可种植 | `unplantable` 配置集合，扫描与播种双层过滤 |
| 木桶(1028 70 571~577)取种，比例 potato:carrot:wheat:beetroot = 1:1:5:1 | `BehaviorGetSupplies` 最大余数法分配 + 按需从木桶 withdraw |
| 参数配置化 | `bots/daoxiang/daoxiang_config.json`，全部规则参数可调 |
| tp 规则 | 目标 >200 格直传（`tp.farDistance`）；寻路极端失败传回初始位置（spawn 时自动记录 `homePos`）；utils 层还有卡住 10s/超时的 tp 脱困 |
| 饥饿 ≥20%，面包+石锄自寻容器 | `BehaviorCheckHunger`（triggerPercent 默认 30% 留余量）→ `BehaviorEat` 自寻 chest/barrel 取面包；`minHoes` 不足时取石锄 |
| 踩坏耕地用锄头修复 | `_needsTilling()` 发现 dirt → `_tillDirt()` 用锄头犁回 farmland |
| 夜晚去 (1033,61,598) 发呆避幻翼 | `BehaviorNightIdle`：timeOfDay ∈ [12542,23460] 时前往 nightSpot 站到天亮 |

### 聊天命令

- `daoxiang stop` 或 `稻香 停` — 停止工作
- `daoxiang status` 或 `稻香 状态` — 查询状态

### 前置要求

给 DaoXiang 传送权限（规则 7 依赖）：

```
lp user daoxiang permission set minecraft.command.teleport true
```

木桶里放好四种种子、附近箱子放面包和石锄。状态机可视化: http://localhost:8936。DaoXiang 页面右上角同时显示生命/饥饿/饱和度、坐标、全背包物品数量，以及石锄数量与耐久；数据每秒刷新。

### 关键配置项（daoxiang_config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `lever` | (1027,70,570) | 拉杆坐标 |
| `barrels` | X=1028, Z 571~577 | 种子木桶行。**只按 X/Z 匹配**，`y` 仅为提示——实际高度自动探测，不一致时打日志提醒 |
| `nightSpot` | (1033,61,598) | 夜晚发呆点 |
| `terraces` | 两层梯田 | 播种区判定来源，`plantEntry` 未配置时自动取第一层中心 |
| `unplantable` | 8 个坐标 | 规则 4 的禁种地块 |
| `seeds` | 1:1:5:1 | 播种比例（最大余数法保证总和守恒） |
| `tools` | stone_hoe ×2 | 锄头种类与数量下限 |
| `food` | bread, triggerPercent 30 | 食物相关：面包种类与进食线（饥饿 ≤ 进食线触发进食） |
| `containerSearch` | radius 24 | 容器搜索半径（取面包/取锄头共用） |
| `harvest` | maturityThreshold 95 等 | 收割段：成熟阈值/等待上限/最短等待(硬下限 10s，规则 2)/完成占比 |
| `plant` | coverageThreshold 90 等 | 播种段：覆盖率阈值/单块耗时/总时间预算 |
| `scan` | intervalMs 30000 | 成熟度扫描间隔 |
| `tp` | enabled, farDistance 200 | 规则 7 |

## FarmMaster — 农场主机器人

用于自动化红石农场：检测成熟度 → 拉杆收割 → 闭环等待收割完成 → 关闭拉杆 → 从箱子取种子和锄头 → 前往播种区 → 按比例播种 → 返回等待区 → 循环。夜晚会自动睡觉。

### 状态机流程

转移按声明顺序匹配，**靠前者优先**，因此显式分为三段：

```
[1] stop   任意工作状态 → Idle          （最高优先级，保证 stop 一定生效）
[2] sleep  WaitMaturity / Idle → Sleep → WaitMaturity
           （waitHarvest 不参与，避免收割中途去睡觉把拉杆留在开启状态）
[3] flow   正常工作流
```

正常工作流：

```
Idle → WaitMaturity（成熟度/覆盖率判定）→ CheckHunger（必经）→ Eat?
  ├─ 需要收割 → ActivateLever(开) → WaitHarvest(闭环) → DeactivateLever(关) → GetSeeds
  │              └─ 拉杆失败 → 回到 WaitMaturity（本轮不收割）
  └─ 需要播种 → GetSeeds
                    ↓
        GoTo(pos1) → PlantSeeds → GoTo(pos2) → WaitMaturity
```

关键判定规则（`BehaviorWaitMaturity`）：

1. **成熟优先**：成熟比例 ≥ `maturityThreshold` 即进入收割，不受覆盖率门禁影响。
   若覆盖率先判，大田块播种永远打不满覆盖率时收割路径会被永久饿死。
2. 场上无作物 → 直接播种。
3. 覆盖率 < `coverageThreshold` → 补种。
4. 覆盖足够但未成熟 → 继续等待（每 `scanIntervalMs` 轮询一次，长时间无进展会告警）。

### 配置文件 `bots/farmMaster/farmmaster_config.json`

```json
{
    "server": { "host": "localhost", "port": 25565, "username": "FarmMaster", "version": "1.21.11" },
    "pos1": { "x": 0, "y": 64, "z": 0 },
    "pos2": { "x": 0, "y": 64, "z": 100 },
    "waypoints": [{ "x": 0, "y": 64, "z": 50 }],
    "workArea":  { "minX": -20, "maxX": 20, "minZ": -20, "maxZ": 20 },
    "plantArea": { "minX": -20, "maxX": 20, "minY": 64, "maxY": 68, "minZ": -20, "maxZ": 20 },
    "seeds": [
        { "name": "wheat_seeds", "ratio": 40 },
        { "name": "carrot", "ratio": 30 },
        { "name": "potato", "ratio": 30 }
    ],
    "harvestWaitSeconds": 60,
    "harvestWaitMinSeconds": 8,
    "harvestDoneRatio": 5,
    "maturityThreshold": 95,
    "coverageThreshold": 90,
    "scanIntervalMs": 30000,
    "plantMsPerPlot": 1200,
    "plantMaxTimeMs": 1800000
}
```

| 配置项 | 说明 |
|--------|------|
| `pos1` | 播种区目标点 |
| `pos2` | 拉杆/箱子/床区域目标点 |
| `waypoints` | 两点之间的中转路径点，按前往方向自动正序/倒序经过 |
| `workArea` | 活动范围，成熟度扫描边界 |
| `plantArea` | 播种区边界（含可选 Y 范围），播种扫描与站位校验边界 |
| `seeds[].ratio` | 种子播种比例（最大余数法按整数比分配空地，并按作物交错落位） |
| `harvestWaitSeconds` | 拉杆开启后**等待上限**（秒），实际由闭环提前结束 |
| `harvestWaitMinSeconds` | 收割等待的最小驻留时间（秒），避免刚开拉杆就判定完成 |
| `harvestDoneRatio` | 场上成熟作物占比 ≤ 该百分比视为收割完成（默认 5%） |
| `maturityThreshold` | 成熟百分比达到此值后触发收割 |
| `coverageThreshold` | 作物覆盖率低于此值时优先补种 |
| `scanIntervalMs` | 成熟度轮询间隔（毫秒） |
| `plantMsPerPlot` | 每格播种的时间预算，用于自适应单轮时长 |
| `plantMaxTimeMs` | 单轮播种的硬上限（毫秒） |

### 游戏内命令

| 命令 | 说明 |
|------|------|
| `start` | 开始自动循环 |
| `stop` | 停止（任何状态下立即回到 Idle） |
| `status` | 查看状态（含收割轮次、协议黑名单、拉杆失败计数） |
| `setpos1 <x> <y> <z>` | 设置播种区位置 |
| `setpos2 <x> <y> <z>` | 设置拉杆区位置 |
| `setarea <x1> <z1> <x2> <z2>` | 设置工作区域 |
| `help` | 帮助 |

## 寻路与移动策略

这几条是刻意配置的，改动前请先读完，否则很容易让机器人"上不了楼梯"或"在田里蹦跳"。

**0. 耕地跳跃守卫（2025 更新：差一修复 + 台阶放行）**

- 耕地碰撞箱高 15/16，站在耕地上脚部 Y = 耕地格Y + 0.9375，支撑格是 `floor(脚部Y)` **本身**而不是 floor-1。旧实现只查 floor-1，导致守卫在耕地上从不触发。
- 原地/平跳落回耕地：fallDistance≈1.2 > 原版踩踏阈值 0.5，按 `fallDistance-0.5` 概率踩坏 → **拦截**。
- 跳上 +1 台阶：落回时 fallDistance≈0.25 < 0.5，且起跳块不会被落回 → **放行**（`isStepUpAhead`，靠 yaw 探测前方 0.6/1.1 格处脚部高度是否有实体方块）。
- `walkToFlat` 对齐不再开冲刺：冲刺跳落地就是踩田，且 4+ 格飞行对 0.45 精度对齐只有坏处。

**1. 上楼梯靠"走"，不靠"跳"** —— `allowSprinting = false`、`allowParkour = false`

pathfinder 选择动作的优先顺序（`mineflayer-pathfinder/lib/index.js:611-629`）：

| 顺序 | 条件 | 结果 |
|---|---|---|
| 1 | `allowSprinting && canStraightLine(sprint)` | 冲刺，不跳 |
| 2 | `allowSprinting && canSprintJump` | 冲刺 **+ 跳** ← 会"蹦" |
| 3 | `canStraightLine` | 步行，不跳 ← **上楼梯走这条** |
| 4 | `canWalkJump` | 跳 |

第 2 条排在第 3 条前面，所以**开着冲刺时，凡是"走不上去"的地方都会优先尝试跳上去**。
关掉冲刺后，能走的地方一律走（含 0.5/0.6 的台阶由游戏自动上台阶），只有物理上真的必须跳才跳。
`allowParkour` 关闭后不再生成跨沟长跳的寻路分支。

**2. 绝对不要把 `*_slab` / 楼梯加进 `movements.carpets`**

`carpets` 的语义是"这种方块可以站进去、视同空气"（pathfinder 默认只收录碰撞高度 < 0.1 的真地毯/雪片）。
半砖/楼梯是实体方块，加进去会让 pathfinder 同时认为它 `physical = true` 且 `safe = true`，
于是规划出**"水平走进半砖方块"**的路径 —— 物理上根本走不动。表现就是：机器人反复重规划、
既不报无路也走不到，最后 30s 超时。半砖/楼梯交给 pathfinder 按碰撞高度原生处理即可，本来就能走。

**3. 跳跃守卫只保护耕地** —— `NO_JUMP_BLOCKS`

跳起来再落回耕地会踩坏作物、把耕地踩回泥土，所以站在耕地上时强制不跳。
半砖/楼梯**不在**此列：在半砖上跳不会破坏任何东西，列进去反而会让机器人永远上不了楼梯
（想跳就立刻被取消，动作永远完不成）。

**4. 物理限制**
如果某级台阶的落差 **> 0.6 格**（例如整砖、`type=top` / `type=double` 的半砖），
那就**必须跳**才能上去 —— 这是 Minecraft 的规则，不是机器人的问题。此时二选一：

- 把楼梯改成落差 ≤ 0.5 格（半砖 `type=bottom` / 楼梯方块），即可全程零跳跃；
- 或接受"楼梯上跳、耕地上不跳"。若某段路必须跳却被耕地保护拦下，
  `pathfinderGoto` 会**快速失败**并报 `此段路必须跳跃，但被耕地保护拦截`，不再干等 30 秒。

**5. 开箱的单次超时必须自己设上限**

`bot.openContainer` 内部固定等 `windowOpen` **20 秒**（mineflayer `once()` 的默认值，且 `openBlock` 不暴露 timeout 参数，外部无法调短）。
如果不自己用 `Promise.race` 包一层，"当前位置开箱"会把整个预算吃光，"四面靠近"兜底逻辑因为剩余时间不足而**一次都不会执行**。
`utils/container.js` 里单次开箱上限 6 秒，就是为了保证兜底一定跑得到。

**6. 导航结果必须检查 `arrived`**

`BehaviorGoTo` 暴露 `arrived` 标志：只有真正走到过目标才算成功。状态机据此分流 ——
`gotoPos1` 只有 `arrived` 才进 `plantSeeds`，否则回到 `checkHunger` 重新决策。
`BehaviorPlantSeeds` 自己也有位置守卫（不在播种区就拒绝开播），双重保险。
**新增 goto 相关转移时务必带上 `arrived` 判断**，否则"寻路失败却照样播种"的老问题会重现。

**7. 诊断日志**

启动后每 10 秒打印一次位置与状态：

```
[坐标] (1020.6, 68.0, 601.3) 速度0.00/s 食物20/20 状态空闲 卡住计数0
```

寻路过程中每 3 秒打印一次进度，卡住时尝试跳跃脱困：

```
[寻路] 3s 坐标(1020.6,68.0,601.3) 速度0.00/s 距目标 11.6 格 未移动 卡住计数12
[寻路] 连续 12 次未移动，尝试跳跃脱困 坐标(1020.6,68.0,601.3)
```

**8. /tp 脱困兜底（2025-10-10 实测驱动）**

探测脚本 `probe-stuck.js` 证实：A\* 规划成功的路径也可能物理走不动 —— 例如从
(1028,60,598) 出发的第一个斜穿步，夹角方块是 stone_bricks+箱子 的两格墙，碰撞箱
必然剐蹭卡死；pathfinder 每 3.5s 重规划出同样的路径，跳跃也翻不过两格墙，只能
等 30s 超时。因此：

- 寻路卡住 10 秒（40 个 stuck tick）仍无进展 → 取消寻路并 `/minecraft:tp` 到目标附近
- 寻路超时（30s）→ 同样尝试 tp 兜底
- `GoalLookAtBlock` 不参与 tp（它的坐标是被看的方块，传进去会窒息）
- 需要服务器授权（LuckPerms）：
  `lp user farmmaster permission set minecraft.command.teleport true`
- 无权限时只多花 1.8s 等待窗口，按原失败路径处理，行为不劣化
- 可用 `setTeleportFallbackEnabled(false)` 整体关闭

诊断工具：`node probe-stuck.js` 连接服务器探测卡住点周边方块的 pathfinder 判定
（safe/physical/height）、楼梯几何、真实寻路结果；优先尝试 `/minecraft:tp` 到卡住点。

这组日志是排查"没移动成功"的主要依据：`速度` 为 0 且 `卡住计数` 持续增长 = 原地卡死；
`速度` 正常但 `距目标` 不降 = 在绕路或来回震荡。

## 状态机可视化

启动后提供 Web 可视化（重连时会自动重建，不会指向已失效的状态机）：

- FarmMaster: http://localhost:8935

## API 使用规范（与官方实现保持一致）

### 方块属性类型（实测，1.21.11 / prismarine-block）

`block.getProperties()` 的返回类型**因状态类型而异**，这是踩过坑的地方：

| 状态类型 | 返回类型 | 例子 |
|---|---|---|
| bool | 真·布尔值 `true/false` | lever `powered` |
| int（带 values 表） | **字符串** `"0"~"7"` | wheat/carrots `age` |

- 拉杆必须写 `getProperties()?.powered === true`，写 `=== 'true'` 恒为 false —— 曾导致
  "拉杆拨成功了却判定失败 → 重试又拨回去"的震荡，且关闭失败 3 次会暂停整个自动循环。
- 作物成熟判定用 `Number(age) >= 7`，不要依赖 `"7" >= 7` 的隐式转换。

### 优先使用官方 API 的场景

以下功能官方 API 已覆盖，项目中直接使用、不要自造：

- `bot.clearControlStates()` — 清空全部按键（`stopMovement` 内部就是它）
- `bot.equip(item, 'hand')` / `bot.consume()` — 换手持 / 进食
- `bot.sleep(bed)` / `bot.wake()` — 睡觉 / 起床
- `chest.withdraw(type, null, count)` / `chest.close()` — 箱子取物（prismarine-windows）
- `bot.findBlock` / `bot.findBlocks` — 方块搜索
- pathfinder 目标：`GoalNear` / `GoalBlock` / `GoalLookAtBlock`（站位/视线）
- `bot.blockAtCursor(maxDist)` — 视线落点方块（种植对准判定用它，不用手写 raycast）

### 事件订阅

- **按坐标的方块更新**用官方事件 `bot.on('blockUpdate:(x, y, z)')`（mineflayer 会自动转发到
  world，官方插件 place_block.js/digging.js 均按此用法），不要挂全局 `blockUpdate` 再手动过滤坐标。
- `bot.sleep()` 官方语义是**"入睡成功即 resolve"**（内部等 `sleep` 事件）；"醒来"由服务器确认后
  发出 **`wake` 事件**。想睡到天亮必须等 `wake`，不能在 `sleep()` 返回后就当已经天亮 ——
  否则状态机立刻切走，`onStateExited` 会把 bot 从床上拽起来，整夜在"上床-起床"循环。

### 已知的自定义偏离（有意保留）

- `utils/movement.js` 的 `walkToFlat`（短距离直线走，**不开冲刺**，防踩田/防冲过头）自定义实现，未用 pathfinder。
  原因：322 块耕地上的微移动（reach 0.45）用 pathfinder 会触发 3.5s stuck 重规划开销，
  且历史上受 carpets 误配置拖累。它失败时会 fallback 到 pathfinder（官方），风险可控。
  若后续真实服务器验证 pathfinder 微移动稳定，可将其改为 pathfinder 优先。

## 依赖

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 机器人框架
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 自动寻路
- [mineflayer-statemachine](https://github.com/TheDudeFromCI/mineflayer-statemachine) — 状态机 + Web 可视化
