# Minecraft Farm Bots

基于 Mineflayer + mineflayer-statemachine 的 Minecraft 自动化农业机器人合集。

## 项目结构

```
mc_bot/
├── utils/                          # 共享工具层
│   ├── movement.js                 # 寻路、移动、站位、种植朝向
│   ├── container.js                # 箱子交互（多面靠近 + 开箱）
│   ├── farmScan.js                 # 农田扫描与统计
│   ├── cropHarvest.js              # 作物挖掘
│   ├── plantAction.js              # 单格补种
│   ├── plantBlacklist.js           # 种植协议超时黑名单
│   ├── lruMap.js                   # LRU Map 数据结构
│   ├── log.js                      # 控制台时间戳
│   └── closableWebserver.js        # 可关闭的状态机 Web 可视化
├── bots/
│   ├── farmer/                     # 农民机器人 — 自动种/收/存
│   │   ├── index.js                # 入口 + 状态机
│   │   ├── config.js               # 运行时状态
│   │   ├── farmer_config.json      # 持久化配置
│   │   ├── commands.js             # 聊天命令
│   │   └── behaviors/              # 专用行为状态
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

# 启动农民机器人
npm run farmer

# 启动农场主机器人
npm run farmmaster

# 开发模式（自动重启）
npm run farmer:dev
npm run farmmaster:dev
```

## 机器人介绍

### Farmer — 农民机器人

循环执行：扫描农田 → 收割成熟作物 → 捡取掉落物 → 存储到箱子 → 补种空地。

**配置文件** `bots/farmer/farmer_config.json`：

```json
{
    "server": {
        "host": "localhost",
        "port": 25565,
        "username": "FarmerBot",
        "version": "1.21.11"
    },
    "workArea": {
        "minX": 100, "maxX": 120,
        "minZ": 200, "maxZ": 220
    },
    "currentCrop": "wheat"
}
```

**游戏内命令**（聊天发送）：

| 命令 | 说明 |
|------|------|
| `farm [wheat\|carrot\|potato\|beetroot]` | 开始自动农场 |
| `stop` | 停止所有任务 |
| `status` | 查看状态 |
| `setarea <x1> <z1> <x2> <z2>` | 设置工作区域 |
| `help` | 帮助 |

### FarmMaster — 农场主机器人

用于自动化红石农场：检测成熟度 → 拉杆收割 → 等待 → 关闭拉杆 → 从箱子取种子 → 前往播种区 → 按比例播种 → 返回等待区 → 循环。

**状态机流程**：

```
上线 → WaitMaturity（检测成熟度）
  ├─ 有成熟作物 → CheckHunger → ActivateLever → Wait(60s) → DeactivateLever → GetSeeds → GoTo(pos1) → PlantSeeds → GoTo(pos2) → WaitMaturity
  └─ 无作物 → GetSeeds → GoTo(pos1) → PlantSeeds → GoTo(pos2) → WaitMaturity
```

**配置文件** `bots/farmMaster/farmmaster_config.json`：

```json
{
    "server": {
        "host": "localhost",
        "port": 25565,
        "username": "FarmMaster",
        "version": "1.21.11"
    },
    "pos1": { "x": 0, "y": 64, "z": 0 },
    "pos2": { "x": 0, "y": 64, "z": 100 },
    "workArea": {
        "minX": -20, "maxX": 20,
        "minZ": -20, "maxZ": 20
    },
    "seeds": [
        { "name": "wheat_seeds", "ratio": 40 },
        { "name": "carrot", "ratio": 30 },
        { "name": "potato", "ratio": 30 }
    ],
    "harvestWaitSeconds": 60,
    "maturityThreshold": 95
}
```

| 配置项 | 说明 |
|--------|------|
| `pos1` | 播种区目标点 |
| `pos2` | 拉杆/箱子区域目标点 |
| `workArea` | 机器人活动范围，扫描农田和成熟度检测的边界 |
| `seeds[].ratio` | 种子播种比例（按整数比分配空地） |
| `harvestWaitSeconds` | 拉杆激活后等待收割完成的秒数 |
| `maturityThreshold` | 作物成熟百分比达到此值后触发下一轮收割 |

**游戏内命令**：

| 命令 | 说明 |
|------|------|
| `start` | 开始自动循环 |
| `stop` | 停止 |
| `status` | 查看状态 |
| `setpos1 <x> <y> <z>` | 设置播种区位置 |
| `setpos2 <x> <y> <z>` | 设置拉杆区位置 |
| `setarea <x1> <z1> <x2> <z2>` | 设置工作区域 |

## 状态机可视化

两个机器人启动后分别在以下端口提供 Web 可视化：

- Farmer: http://localhost:8934
- FarmMaster: http://localhost:8935

## 依赖

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — Minecraft 机器人框架
- [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) — 自动寻路
- [mineflayer-statemachine](https://github.com/TheDudeFromCI/mineflayer-statemachine) — 状态机 + Web 可视化
