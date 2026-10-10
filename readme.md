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

## 状态机可视化

启动后提供 Web 可视化（重连时会自动重建，不会指向已失效的状态机）：

- FarmMaster: http://localhost:8935

## 依赖

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 机器人框架
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 自动寻路
- [mineflayer-statemachine](https://github.com/TheDudeFromCI/mineflayer-statemachine) — 状态机 + Web 可视化
