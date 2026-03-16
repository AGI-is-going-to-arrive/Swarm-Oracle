# SwarmOracle 2.0 升级计划

> **核心定位**：What-If 推理引擎 + 像素文明可视化层
>
> 本质：SwarmOracle 的多 Agent "What-If" 推理不变，但推演过程以像素世界形态呈现，而非纯文字报告。
>
> 2026-03-16 状态同步：
> - 2.0 线路上的像素剧场、回放、截图/GIF、玩法卡、结构化下注都已落地并持续迭代。
> - 结构化下注现支持：押世界线 / 押结局倾向 / 押题材回响。
> - 玩法卡 prompt 已提升为导演级 override，要求后续轮次持续响应。
> - 完成态 Theater 现在使用内嵌 compact TimelineBar 与图标 marker，不再把主剧场挤出首屏。
> - 当前主回归：后端 `708 passed`，前端 `128 passed`。

---

## 一、设计哲学：What-If 驱动一切

### 现有 SwarmOracle 核心
- 用户提出假设性问题（"如果罗马帝国没有灭亡？"）
- AI Agents（不同 persona/立场）实时辩论推演
- 产生分支时间线 + 概率追踪
- 蝴蝶效应干预 + 多结局比较

### 2.0 的进化：推演过程可视化
- **不是**让 Agent 自主生活（那是 AI Town）
- **而是**把 Agent 的辩论推演过程，映射到一个像素世界上
- Agent 发言 → 像素角色对话气泡
- 立场对立 → 角色分成两个阵营站队
- 分支产生 → 世界地图分裂成两条路线
- 蝴蝶效应 → 像素世界发生可视化的事件动画（地震、新发明闪光等）
- 推演结束 → 像素世界展现不同的结局景象

> **核心差异**：竞品要么只做纯推理（ChatGPT），要么只做自主模拟（AI Town）。
> SwarmOracle 2.0 = 推理引擎 + 沉浸式可视化，是"带剧场效果的思想实验"。

---

## 二、竞品分析与差异化定位

### 2.1 竞争格局全景

| 赛道 | 代表项目 | 最大竞品⭐ | 我们的差异 |
|------|---------|:---------:|-----------|
| 纯文字推理 | ChatGPT / Claude 对话 | N/A | 我们有多Agent辩论+分支+可视化 |
| AI 文明自主模拟 | a16z AI Town (9.5k⭐) | 9,494 | 我们核心是推理，不是模拟生活 |
| LLM 排行对比 | LMSYS Arena (4.7k⭐) | 4,760 | 我们是故事推演，不是Q&A对比 |
| AI 狼人杀 | Wolfcha (537⭐) | 537 | 不做，只作为文明内子场景 |
| 反向图灵测试 | Human or Not (百万级) | 百万级 | 不做，只作为文明内子场景 |

### 2.2 SwarmOracle 2.0 的独特卖点

```
┌──────────────────────────────────────────────────────────┐
│               SwarmOracle 2.0 独特组合                    │
│                                                          │
│  ┌─────────┐   ┌──────────────┐   ┌────────────────┐    │
│  │ What-If  │ + │  像素世界     │ + │  竞猜/排行      │    │
│  │ 推理引擎  │   │  可视化推演   │   │  游戏化机制      │    │
│  └─────────┘   └──────────────┘   └────────────────┘    │
│       ↓               ↓                 ↓                │
│  多Agent辩论     角色站队动画       猜谁赢/猜走向          │
│  分支时间线      世界分裂特效       ELO积分排行            │
│  蝴蝶效应       事件动画演出       社交分享截图            │
└──────────────────────────────────────────────────────────┘
```

**竞品没有这个组合。** 纯推理没有可视化，纯模拟没有What-If引擎，纯竞猜没有Agent推演。

---

## 三、功能架构设计

### 3.1 核心玩法循环

```
用户提问 → Agents 辩论推演 → 像素世界实时演绎 → 分支/干预 → 比较结局 → 竞猜排行
    ↑                                                                        │
    └────────────────────── 新问题 ←───────────────────────────────────────────┘
```

### 3.2 模块架构

#### 模块 A：What-If 推理引擎（已有，增强）

| 功能 | 现有状态 | 2.0 升级 |
|------|---------|---------|
| 多 Agent 辩论 | ✅ persona + 立场 + 情绪 | + 阵营自动分组 + 立场强度可视化 |
| 分支时间线 | ✅ 概率追踪 | + 像素世界分裂动画 + 关键节点高亮 |
| 蝴蝶效应 | ✅ 干预模板 | + 像素事件动画（地震/发明/瘟疫） |
| 多结局比较 | ✅ 跨分支比较 | + 双屏像素世界并排对比 |
| 层级Agent | ✅ Leader-Worker | + Agent像素形象绑定 |

#### 模块 B：像素可视化层（新增核心）

| 功能 | 描述 |
|------|------|
| **Agent 映射** | 每个 Agent → 一个像素角色（根据 persona 分配外观） |
| **对话气泡** | Agent 发言 → 像素角色头上弹出气泡（摘要版） |
| **阵营站队** | 辩论时，Agent 按立场自动走向不同方向 |
| **世界场景** | 根据问题主题自动选择场景（中世纪/现代/未来/自然） |
| **事件动画** | 蝴蝶效应触发时播放对应的像素动画 |
| **分支分裂** | 时间线分支时，像素世界一分为二的动画 |
| **结局演出** | 推演结束时，根据结论渲染结局场景 |
| **情绪指示** | Agent 情绪值 → 像素角色表情/身上光环颜色 |

#### 模块 C：游戏化机制（已有，增强）

| 功能 | 现有状态 | 2.0 升级 |
|------|---------|---------|
| 竞猜系统 | ✅ 基本竞猜 | + 可视化下注面板 + 赔率动态变化 |
| 排行榜 | ✅ 基本排行 | + 像素风排行榜UI + 称号系统 |
| 社交分享 | ✅ 文案生成 | + 像素截图生成 + GIF动画导出 |

#### 模块 D：文明内嵌入式玩法（新增，轻量子功能）

> 以下不是独立模块，而是推演过程中的**特殊事件卡牌**

| 玩法 | 触发方式 | 描述 |
|------|---------|------|
| **文明辩论** | 特定分支节点自动触发 | 两个 Agent 公开辩论，其他 Agent 旁听 → 影响后续立场 |
| **间谍推理** | 用户手动注入"间谍事件" | 标记一个 Agent 为"卧底"，观察其他 Agent 的推理变化 |
| **人类潜入** | 特殊模式可选 | 某一轮用户可以替代一个 Agent 发言，其他 Agent 不知情 |
| **时空裂缝** | 蝴蝶效应变体 | 从另一个分支"传送"一条信息到当前分支，观察影响 |

---

## 四、美术素材清单（AI 生成，Antigravity Nano Banana）

> 全部素材通过 Antigravity IDE 的 Nano Banana AI 图像生成工具自动生成，统一像素风格，无第三方许可依赖。
> 素材目录：`frontend/public/assets/`

### 4.1 角色精灵 — `assets/characters/` (18 张 PNG)

> 每个 Agent persona 对应一个独立像素精灵，16-bit SNES 风格

| 文件名 | 角色定位 | 用于 Persona |
|--------|---------|-------------|
| `sprite_king.png` | 国王/统治者 | leader, ruler, emperor |
| `sprite_warrior.png` | 战士/军事 | military, soldier, general |
| `sprite_scholar.png` | 学者/智者 | scholar, academic, philosopher |
| `sprite_merchant.png` | 商人/贸易 | merchant, trader, banker |
| `sprite_farmer.png` | 农民/平民 | farmer, peasant, commoner |
| `sprite_priest.png` | 祭司/宗教 | priest, cleric, religious |
| `sprite_rebel.png` | 反叛者/革命 | rebel, revolutionary, anarchist |
| `sprite_diplomat.png` | 外交官 | diplomat, ambassador, negotiator |
| `sprite_villager.png` | 村民(默认) | 未匹配 persona 的默认角色 |
| `sprite_spy.png` | 间谍/情报 | spy, infiltrator, agent |
| `sprite_explorer.png` | 探险家 | explorer, adventurer, voyager |
| `sprite_scientist.png` | 科学家 | scientist, inventor, engineer |
| `sprite_general.png` | 将军/指挥 | general, commander, warlord |
| `sprite_artist.png` | 艺术家/文化 | artist, bard, poet |
| `sprite_engineer.png` | 工程师/建造 | engineer, architect, builder |
| `sprite_healer.png` | 治疗者/医师 | healer, doctor, medic |
| `sprite_noble.png` | 贵族/领主 | noble, lord, aristocrat |
| `sprite_default.png` | 通用默认 | 兜底角色 |

### 4.2 场景背景 — `assets/scenes/` (11 张 PNG)

> 宽幅全景式像素背景，根据 What-If 问题主题自动匹配

| 文件名 | 场景主题 | 匹配关键词 |
|--------|---------|----------|
| `medieval_village.png` | 中世纪村庄 | medieval, kingdom, feudal |
| `ancient_empire.png` | 古代帝国 | roman, empire, ancient, dynasty |
| `industrial_city.png` | 工业革命城市 | industrial, factory, revolution |
| `modern_city.png` | 现代都市 | modern, contemporary, urban |
| `scifi_base.png` | 科幻基地 | future, sci-fi, technology |
| `post_apocalypse.png` | 末日废土 | apocalypse, collapse, extinction |
| `fantasy_kingdom.png` | 魔幻王国 | magic, fantasy, enchanted |
| `war_battlefield.png` | 战争战场 | war, battle, conflict, invasion |
| `space_station.png` | 太空站 | space, interstellar, colony |
| `underwater_kingdom.png` | 海底王国 | ocean, underwater, atlantis |
| `desert_outpost.png` | 沙漠前哨 | desert, oasis, nomad, silk road |

### 4.3 事件特效 — `assets/effects/` (14 张 PNG)

> 蝴蝶效应/干预事件触发时的像素动画效果图标

| 文件名 | 效果类型 | 触发场景 |
|--------|---------|--------|
| `earthquake.png` | 地震/自然灾害 | `natural_disaster` 干预 |
| `fire.png` | 火灾/战争火焰 | `war`, `fire_spread` 干预 |
| `fog.png` | 迷雾/瘟疫扩散 | `plague`, `dark_fog_spread` 干预 |
| `tech.png` | 科技突破闪光 | `tech_breakthrough` 干预 |
| `treasure.png` | 宝藏/发现闪光 | `discovery`, `treasure_sparkle` 干预 |
| `handshake.png` | 联盟/和平握手 | `alliance`, `handshake_glow` 干预 |
| `debate.png` | 辩论/对立冲突 | 辩论场景中 Agent 激烈争论 |
| `spy.png` | 间谍/暗影揭露 | 间谍推理子玩法触发 |
| `portal.png` | 传送门/时空裂缝 | `时空裂缝` 子玩法触发 |
| `branch_split.png` | 分支分裂 | 时间线产生新分支 |
| `generic_flash.png` | 通用闪光 | 未匹配事件的默认效果 |
| `player_swap.png` | 玩家接管 | 人类潜入子玩法触发 |
| `particle_star.png` | 星光粒子序列帧 | 正面事件的粒子装饰 |
| `particle_smoke.png` | 烟雾粒子序列帧 | 毁灭/战争事件的烟雾装饰 |

### 4.4 UI 界面组件 — `assets/ui/` (9 张 PNG)

> 像素风 RPG 游戏 UI 元素，用于 HUD 覆盖层

| 文件名 | 组件类型 | 用途 |
|--------|---------|-----|
| `title_screen.png` | 标题画面 | SwarmOracle 主标题画面 |
| `dialog_panel.png` | 对话面板 | Agent 发言时的对话框背景 |
| `health_bar.png` | 信心条 | Agent 情绪/信心百分比条 |
| `buttons.png` | 按钮组(3态) | 普通/悬停/按下三种状态 |
| `panel_bg.png` | 控制面板背景 | 右侧控制面板半透明背景 |
| `leaderboard.png` | 排行榜框架 | 玩家竞猜排名展示框架 |
| `bet_panel.png` | 竞猜下注面板 | 两支队伍赔率对比+下注按钮 |
| `status_icons.png` | 状态图标集 | 经济/军事/知识/自然/魔法/工业/和平/危险 |
| `minimap_frame.png` | 小地图边框 | 指南针罗盘样式的小地图边框 |

### 4.5 结局场景 — `assets/endings/` (6 张 PNG)

> 推演结束时根据结论渲染的全屏结局画面

| 文件名 | 结局类型 | 触发条件 |
|--------|---------|--------|
| `prosperity.png` | 🌟 黄金繁荣时代 | 合作共赢、经济繁荣 |
| `peace.png` | 🕊️ 和平统一 | 敌对阵营最终和解 |
| `war.png` | ⚔️ 永恒战争 | 冲突持续无法解决 |
| `ruin.png` | 💀 文明崩塌 | 全面失败、文明毁灭 |
| `tyranny.png` | 👑 黑暗暴政 | 独裁势力胜出 |
| `revolution.png` | 🔥 革命黎明 | 人民推翻旧政权 |

### 4.6 素材生成策略

```
生成工具：Antigravity IDE → Nano Banana (AI Image Generation)
风格统一：全部使用 "16-bit SNES RPG pixel art" 关键词约束
透明背景：Effects/UI 类素材使用透明背景，方便叠加
场景/结局：使用全幅全景构图，适合 800×600 画面
角色精灵：侧面半身像，适合 32×48~64×64 游戏内显示
```

> **总计：58 张原创像素风 PNG 素材**，无外部许可依赖，全部为项目原创生成。

---

## 五、技术架构

### 5.1 整体架构（在现有基础上扩展）

```
┌──────────────────────────────────────────────────────┐
│                    Frontend                           │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ React UI │  │  Phaser.js │  │   D3.js Charts   │  │
│  │ 控制面板  │  │  像素世界   │  │  时间线/概率图    │  │
│  │ 竞猜/排行 │  │  Agent演出  │  │  分支对比        │  │
│  └─────┬────┘  └─────┬─────┘  └────────┬─────────┘  │
│        │             │                  │             │
│        └─────────────┼──────────────────┘             │
│                      │ events                         │
│              ┌───────▼────────┐                       │
│              │ Event Bridge    │                       │
│              │ WS ↔ Phaser    │                       │
│              └───────┬────────┘                       │
└──────────────────────┼───────────────────────────────┘
                       │ WebSocket + REST
┌──────────────────────┼───────────────────────────────┐
│                  Backend (现有, 增强)                   │
│  ┌──────────┐  ┌─────▼─────┐  ┌──────────────────┐  │
│  │Simulation│  │  WS Hub   │  │  Visualization   │  │
│  │Engine    │  │ (现有增强) │  │  Mapper (新增)    │  │
│  │(现有)    │  │           │  │  推理→场景映射    │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │Branching │  │ Prediction│  │  Agent Persona   │  │
│  │Timeline  │  │ System    │  │  → Sprite Mapper │  │
│  │(现有)    │  │ (现有)    │  │  (新增)          │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 5.2 新增后端模块

#### `app/visualization/` — 推理→可视化映射器

```python
# 核心职责：把推理引擎的事件翻译成像素世界指令

class VisualizationMapper:
    """将 simulation 事件映射为前端 Phaser 场景指令"""

    def map_agent_speak(self, agent, message, stance) -> dict:
        """Agent发言 → 像素角色对话气泡 + 位置调整"""
        return {
            "type": "agent_speak",
            "sprite_id": agent.id,
            "bubble_text": self.summarize(message, max_chars=40),
            "move_to": self.stance_to_position(stance),  # 按立场站队
            "emotion": agent.emotion_state
        }

    def map_branch_split(self, parent_branch, child_branches) -> dict:
        """时间线分支 → 世界分裂动画"""
        return {
            "type": "world_split",
            "split_direction": "horizontal",
            "branches": [b.id for b in child_branches],
            "transition_duration": 2000
        }

    def map_intervention(self, intervention_type, params) -> dict:
        """蝴蝶效应 → 事件动画"""
        animation_map = {
            "natural_disaster": "earthquake_shake",
            "tech_breakthrough": "lightbulb_flash",
            "plague": "dark_fog_spread",
            "discovery": "treasure_sparkle",
            "war": "fire_spread",
            "alliance": "handshake_glow"
        }
        return {
            "type": "world_event",
            "animation": animation_map.get(intervention_type, "generic_flash"),
            "params": params
        }
```

#### `app/visualization/persona_mapper.py` — Agent Persona → 像素角色

```python
# 根据 Agent 的 persona 属性自动分配像素角色外观

SPRITE_MAP = {
    # persona关键词 → 精灵资源ID
    "leader": "sprite_king",
    "military": "sprite_warrior",
    "scholar": "sprite_scholar",
    "merchant": "sprite_merchant",
    "farmer": "sprite_farmer",
    "priest": "sprite_priest",
    "rebel": "sprite_rebel",
    "diplomat": "sprite_diplomat",
}

def assign_sprite(persona: str) -> str:
    """根据 persona 描述自动匹配最佳精灵"""
    for keyword, sprite in SPRITE_MAP.items():
        if keyword in persona.lower():
            return sprite
    return "sprite_villager"  # 默认村民
```

### 5.3 新增前端模块

#### Phaser.js 像素世界引擎

```
frontend/src/
├── game/                          # 新增：Phaser 游戏层
│   ├── PhaserGame.tsx             # React ↔ Phaser 桥接组件
│   ├── scenes/
│   │   ├── WorldScene.ts          # 主世界场景
│   │   ├── DebateScene.ts         # 辩论演出场景
│   │   ├── SplitScene.ts          # 分支分裂过渡场景
│   │   └── EndingScene.ts         # 结局演出场景
│   ├── sprites/
│   │   ├── AgentSprite.ts         # Agent 像素角色类
│   │   ├── BubbleSprite.ts        # 对话气泡类
│   │   └── EventAnimation.ts     # 事件动画类
│   ├── managers/
│   │   ├── AgentManager.ts        # 管理所有 Agent 精灵
│   │   ├── EventBridge.ts         # WS事件 → Phaser动作
│   │   └── SceneTransition.ts    # 场景切换管理
│   └── assets/
│       ├── characters/            # 18 角色精灵 (AI 生成)
│       ├── scenes/                # 11 场景背景 (AI 生成)
│       ├── effects/               # 14 事件特效 (AI 生成)
│       ├── ui/                    # 9 UI 组件 (AI 生成)
│       └── endings/               # 6 结局画面 (AI 生成)
```

#### React ↔ Phaser 桥接

```typescript
// PhaserGame.tsx — 核心桥接组件
// React 控制面板 + Phaser 像素世界在同一页面

import { useEffect, useRef } from 'react';
import Phaser from 'phaser';
import { WorldScene } from './scenes/WorldScene';

export function PhaserGame({ wsEvents, onSceneReady }) {
  const gameRef = useRef(null);

  useEffect(() => {
    const config = {
      type: Phaser.AUTO,
      parent: 'phaser-container',
      pixelArt: true,             // 关键：像素风渲染
      roundPixels: true,
      width: 800,
      height: 600,
      scene: [WorldScene],
      scale: { mode: Phaser.Scale.FIT }
    };
    gameRef.current = new Phaser.Game(config);
    return () => gameRef.current?.destroy(true);
  }, []);

  // WS事件转发给 Phaser 场景
  useEffect(() => {
    if (wsEvents && gameRef.current) {
      const scene = gameRef.current.scene.getScene('WorldScene');
      scene?.handleServerEvent(wsEvents);
    }
  }, [wsEvents]);

  return <div id="phaser-container" />;
}
```

### 5.4 WebSocket 事件扩展

```typescript
// 新增 WS 事件类型（在现有基础上扩展）

// 现有事件（保持不变）
"agent_message"     // Agent发言
"round_complete"    // 轮次结束
"branch_created"    // 分支创建
"simulation_end"    // 模拟结束
"intervention"      // 干预触发

// 新增可视化事件
"viz:agent_move"    // Agent 移动到新位置（立场站队）
"viz:bubble_show"   // 显示对话气泡
"viz:world_split"   // 世界分裂动画
"viz:event_anim"    // 事件动画播放
"viz:emotion_change" // Agent 情绪变化（表情/光环）
"viz:scene_change"  // 切换场景主题
"viz:ending_play"   // 结局演出
```

---

## 六、UI 布局设计

```
┌──────────────────────────────────────────────────────────────┐
│  SwarmOracle 2.0                          [语言] [设置] [?]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ 像素世界视窗 (Phaser) ──────────────────────────────┐   │
│  │                                                       │   │
│  │   🏰 ← Agent甲        Agent乙 → 🏠                  │   │
│  │   💬 "我认为应该..."    💬 "但是..."                   │   │
│  │                                                       │   │
│  │   🧑‍🌾 Agent丙          🗡️ Agent丁                   │   │
│  │   (中立,观望中)        (偏向甲方)                     │   │
│  │                                                       │   │
│  │  ═══════════════ 分支线 ═══════════════               │   │
│  │                                                       │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ 控制面板 ──────────────────┐ ┌─ 时间线面板 ──────────┐  │
│  │                              │ │                        │  │
│  │ 问题: [如果...会怎样？]      │ │ ○─┬─○ 分支A (55%)     │  │
│  │ [开始推演]  [注入事件 ▼]     │ │   ├─○ 分支B (30%)     │  │
│  │                              │ │   └─○ 分支C (15%)     │  │
│  │ 竞猜: [猜A赢] [猜B赢]       │ │                        │  │
│  │ 当前赔率: A 1.8x  B 2.5x    │ │ [对比分支] [Fork]      │  │
│  │                              │ │                        │  │
│  └──────────────────────────────┘ └────────────────────────┘  │
│                                                              │
│  ┌─ Agent 状态条 (像素风) ──────────────────────────────────┐│
│  │ 🧑‍🌾甲 ████████░░ 80%信心  🗡️乙 ██████░░░░ 60%信心       ││
│  │ 👸丙 █████░░░░░ 50%信心  🧙丁 ████░░░░░░ 40%信心          ││
│  └──────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

---

## 七、分阶段实施计划

### Phase 1：像素化基础设施 ✅ 已完成

**目标**：在现有项目中集成 Phaser.js，实现基本的像素世界渲染

| 任务 | 具体内容 | 状态 |
|------|---------|:----:|
| Phaser 集成 | 安装 phaser + 创建 PhaserGame 桥接组件 | ✅ 完成 |
| 美术素材生成 | Nano Banana 生成 58 张原创像素风 PNG | ✅ 完成 |
| 基础场景 | WorldScene 场景背景渲染 + 交叉淡入切换 | ✅ 完成 |
| Agent 精灵 | AgentSprite 18种角色 + persona自动映射 | ✅ 完成 |
| 事件桥接 | EventBridge 将 WS 事件传递给 Phaser | ✅ 完成 |
| 对话气泡 | BubbleSprite + 发言摘要显示 | ✅ 完成 |
| BootScene | 预加载 PNG 素材 + 加载失败自动降级 | ✅ 完成 |
| 后端 viz 测试 | 225 条可视化集成测试（含 Phase 1 Review 修复测试） | ✅ 完成 |

**已交付**：Phaser.js 完整集成，58张 AI 生成像素素材全部部署，TypeScript 零编译错误，Phase 1 Review 全部通过（4 个问题修复 + 22 新测试）

### Phase 2：推理可视化核心（3 周） ✅ 已完成

**目标**：把 What-If 推理的核心机制映射到像素世界

| 任务 | 具体内容 | 素材依赖 | 状态 |
|------|---------|----------|:--------:|
| 立场站队动画 | Agent 按立场自动移动到不同阵营位置 | `characters/*.png` | ✅ 完成 |
| 后端 Mapper | VisualizationMapper 模块 + WS 事件扩展 | — | ✅ 完成 |
| 分支分裂动画 | SplitScene 世界一分为二视觉效果 | `effects/branch_split.png` | ✅ 完成 |
| 事件动画系统 | 12种事件效果图标动画（参见4.3节） | `effects/*.png` | ✅ 完成 |
| Persona→Sprite | Agent persona 自动分配精灵外观(18种) | `characters/*.png` 全部18种 | ✅ 完成 |
| 情绪可视化 | Agent 情绪值 → 角色光环颜色/表情 | `ui/health_bar.png` + `ui/status_icons.png` | ✅ 完成 |
| 多场景切换 | 根据问题主题自动匹配11种场景背景 | `scenes/*.png` 全部11种 | ✅ 完成 |
| 粒子特效合成 | 事件动画叠加粒子效果（星光/烟雾） | `effects/particle_star.png` + `particle_smoke.png` | ✅ 完成 |
| 天气/昼夜系统 | 4种天气(雨/雪/雷/沙尘暴) + 4时段光照 | 程序化生成 | ✅ 完成 |
| 阵营标记 | 4色阵营色条 + 移动轨迹着色 | 程序化生成 | ✅ 完成 |
| 对话气泡变体 | 10种情绪气泡样式 + !/? 标记 | 程序化生成 | ✅ 完成 |
| select_scene 修复 | 双签名支持 + 11场景全覆盖 | — | ✅ 完成 |

**已交付**：完整 What-If 推演可视化 + 天气/昼夜系统 + 阵营标记 + 气泡变体 + Code Review 全部修复 + 269 项可视化测试全绿

**Phase 2 额外美术需求（扩展生成）**：

> 以下素材应在 Phase 2 开发过程中按需使用 Nano Banana 补充生成

| 类别 | 素材描述 | 生成数量 | 目录 |
|------|---------|:--------:|------|
| 表情精灵 | 每角色 4 种表情变体（开心/愤怒/悲伤/惊讶） | 72张 | `characters/emotions/` |
| 行走动画帧 | 每角色 4 方向×4 帧行走序列 | 288帧 | `characters/walk/` |
| 对话气泡变体 | 普通/惊叹/疑问/愤怒/低语 5种气泡样式 | 5张 | `ui/bubbles/` |
| 天气特效 | 雨/雪/雷/沙尘暴叠加层 | 4张 | `effects/weather/` |
| 昼夜循环 | 黎明/正午/黄昏/深夜 4种光照叠加 | 4张 | `effects/lighting/` |
| 阵营标记 | 红/蓝/绿/紫 4种阵营旗帜/光环 | 4张 | `effects/faction/` |

### Phase 3：游戏化 + 结局演出（2 周）

**目标**：强化竞猜机制 + 结局视觉冲击力

| 任务 | 具体内容 | 素材依赖 | 预计工时 |
|------|---------|----------|:--------:|
| 像素竞猜面板 | 用 `bet_panel.png` 重做竞猜界面 + 动态赔率 | `ui/bet_panel.png` | 2天 |
| 结局演出 | EndingScene 渲染 6 种不同结局全屏画面 | `endings/*.png` 全部6种 | 3天 |
| 双屏分支对比 | 分支并排对比时左右两个像素世界 | `scenes/*.png` × 2 | 2天 |
| 截图/GIF导出 | 像素世界关键时刻截图 + 短动画导出 | 所有视觉素材 | 2天 |
| 排行榜UI | 像素风排行榜 + 称号系统 | `ui/leaderboard.png` | 1天 |
| 小地图集成 | minimap 实时显示 Agent 位置分布 | `ui/minimap_frame.png` | 1天 |
| 标题画面 | 游戏启动时的标题画面展示 | `ui/title_screen.png` | 0.5天 |

**交付物**：竞猜有赔率变化动画，6种震撼像素结局演出，小地图+排行榜+标题画面

**Phase 3 额外美术需求（扩展生成）**：

| 类别 | 素材描述 | 生成数量 | 目录 |
|------|---------|:--------:|------|
| 结局过渡动画 | 每种结局的渐变过渡帧序列 | 24帧 | `endings/transitions/` |
| 奖牌/称号图标 | 青铜/白银/黄金/钻石/传说 5级称号 | 5张 | `ui/ranks/` |
| 社交分享模板 | 分享卡片背景 + 头像框 | 3张 | `ui/share/` |
| 成就解锁效果 | 成就弹出动画帧 | 4张 | `effects/achievement/` |

### Phase 4：打磨 + 开源准备（1 周）

| 任务 | 具体内容 | 预计工时 |
|------|---------|:--------:|
| 性能优化 | Phaser 对象池 + 精灵图集合并 + 渲染裁剪 | 2天 |
| 精灵图集打包 | 将分散 PNG 合并为 TextureAtlas (减少 HTTP 请求) | 0.5天 |
| 文档更新 | README + 部署指南 + 素材生成说明 | 1天 |
| 素材清单 | ASSET_CREDITS.md 列出所有 AI 生成素材 | 0.5天 |
| 测试覆盖 | 新增模块的单元测试 + E2E 可视化测试 | 1.5天 |

---

## 八、技术栈汇总

| 层 | 技术 | 备注 |
|----|------|------|
| **前端框架** | React + TypeScript + Vite | 现有，保持 |
| **像素渲染** | Phaser.js 3.80+ | 新增，核心渲染引擎 |
| **数据可视化** | D3.js | 现有(图表)，保持 |
| **后端** | FastAPI + Python | 现有，新增 visualization 模块 |
| **数据库** | SQLite + ChromaDB | 现有，保持 |
| **实时通信** | WebSocket | 现有，扩展事件类型 |
| **素材处理** | Aseprite / Piskel (调色) | 开发工具 |
| **截图导出** | html2canvas + GIF.js | 新增 |

---

## 九、风险评估与缓解

| 风险 | 严重度 | 概率 | 缓解措施 |
|------|:------:|:----:|---------|
| **Phaser + React 集成复杂** | 高 | 中 | 使用 `@phaserjs/react` 官方桥接库 + 参考 AI Town 实现 |
| **素材风格不统一** | 中 | 高 | 统一使用 16x16 网格 + HEPT32 调色板批量调色 |
| **Agent 过多性能下降** | 高 | 中 | Phaser 对象池 + LOD(远处Agent简化) + 渲染裁剪 |
| **推理→可视化映射质量** | 高 | 中 | 先用规则映射，后期可引入 LLM 自动生成场景描述 |
| **LLM 调用成本** | 中 | 低 | 现有 Leader-Worker 层级架构已解决，不额外增加调用 |
| **分支分裂动画流畅度** | 中 | 中 | 预加载分支场景 + 过渡动画遮盖加载时间 |

---

## 十、与 V1 的兼容性

> **核心原则：2.0 是 V1 的增强，不是替代**

| V1 功能 | 2.0 状态 |
|---------|---------|
| 纯文字模拟 | ✅ 保留，像素视窗可关闭 |
| REST/WS API | ✅ 完全兼容，新增 `viz:*` 事件 |
| 竞猜/排行榜 | ✅ 保留，UI 升级为像素风 |
| 社交分享 | ✅ 保留，增加截图/GIF |
| 蝴蝶效应 | ✅ 保留，增加动画演出 |
| 分支比较 | ✅ 保留，增加双屏像素对比 |
| 测试体系 | ✅ 保留并持续扩展（当前主回归：后端 708 + 前端 128） |

**升级路径**：用户可以选择 "经典模式"（纯文字）或 "剧场模式"（像素可视化），随时切换。

---

## 十一、国际化（i18n）强制规范

> **核心要求：所有用户可见文本必须支持中英双语，禁止硬编码任何一种语言**

### 前端代码层

| 规则 | 说明 |
|------|------|
| React 组件 | **必须**使用 `useTranslation()` + `t('key')` 获取翻译，禁止直接写中/英文字符串 |
| Phaser 游戏层 | 因 Canvas 无法使用 React hook，**必须**通过 `import i18next` 并用 `i18next.language` 判断语言选取对应文本 |
| 多语言键对称 | `en.json` 与 `zh.json` 的键结构必须 1:1 完全对称，新增键时**两个文件同步添加** |
| 新组件审查 | 所有 PR 中的新增 TSX 文件必须检查是否引入了 `useTranslation`，否则打回 |

### 美术素材层

| 规则 | 说明 |
|------|------|
| UI 素材禁止烘焙文字 | 所有 UI PNG 素材（按钮、面板、排行榜、标题等）**禁止**在图片中嵌入任何语言文字 |
| 文字由代码叠加 | 所有按钮标签、面板标题、提示文字必须通过 Phaser `Text` 对象或 React 组件在运行时渲染 |
| 图标可包含通用符号 | 罗马数字、指南针方向（N/S/E/W）、数学符号等国际通用符号可保留 |

### 后端数据层

| 规则 | 说明 |
|------|------|
| 双语字段下发 | 事件卡、结局、场景描述等后端推送内容需同时包含 `name`（英文）+ `name_zh`（中文）字段 |
| 语言检测 | 后端已有 `lang_detect.py` 支持请求级语言检测，新模块应复用此机制 |
| API 返回 | REST/WS 响应中的用户可见消息应根据 `Accept-Language` 或查询参数返回对应语言 |

### 当前合规状态

| 层级 | 合规率 | 备注 |
|------|:------:|------|
| React 组件/页面 | **100%** (15/15) | 全部使用 `useTranslation()` |
| 多语言键对称性 | **100%** (219/219) | `en.json` = `zh.json` 完全对称 |
| Phaser 游戏层 | **100%** (已修复) | 通过 `i18next.language` 双语解析 |
| 后端双语字段 | **100%** (4/4) | `card_events.py` 全部双语 |
| UI 美术素材 | **100%** (已修复) | 5 张含文字素材已重新生成为无文字版 |

---

## 十二、里程碑总结

```
✅ Phase 1: 像素基础设施 → 已完成！58张素材部署+Phaser集成  ✨ 视觉基础就绪
✅ Phase 2: 推理可视化   → 已完成！天气/昼夜+阵营+气泡变体+Code Review+269项测试  🎯 核心差异化完成
✅ Phase 3: 游戏化打磨   → 已完成！竞猜面板+排行榜+6种结局+截图分享+小地图+标题画面  🎮 病毒传播能力
✅ Phase 4: 开源准备     → 已完成！对象池+视口裁剪+ASSET_CREDITS(58张)+32项新测试+tsc零错误  🚀 开源发布就绪
```

**总工期：8 周**（全部 4 个 Phase 已完成！）

**美术素材总预算：**

| 阶段 | 已完成 | Phase 2 补充 | Phase 3 补充 | 总计 |
|------|:------:|:-----------:|:-----------:|:----:|
| 角色精灵 | 18 | +72(表情)+288(行走) | — | 378 |
| 场景背景 | 11 | — | — | 11 |
| 事件特效 | 14 | +12(天气/光照/阵营) | +4(成就) | 30 |
| UI 组件 | 9 | +5(气泡变体) | +8(排名/分享) | 22 |
| 结局画面 | 6 | — | +24(过渡帧) | 30 |
| **合计** | **58** | **+377** | **+36** | **471** |

---

## 十三、素材许可声明

> 所有美术素材均通过 Antigravity IDE 的 Nano Banana AI 图像生成工具自动生成。
> 无第三方素材依赖，无外部许可约束。

```markdown
# Asset Credits — SwarmOracle 2.0

All pixel art assets in this project are **original AI-generated works**,
created using Antigravity IDE's Nano Banana image generation tool.

No third-party assets or external licenses are involved.

## Asset Summary
- 18 Character Sprites  → frontend/public/assets/characters/
- 11 Scene Backgrounds   → frontend/public/assets/scenes/
- 14 Event Effects        → frontend/public/assets/effects/
- 9  UI Components        → frontend/public/assets/ui/
- 6  Ending Scenes        → frontend/public/assets/endings/

Total: 58 original PNG files
Style: 16-bit SNES pixel art
Generation Tool: Antigravity Nano Banana (AI Image Generation)
```
