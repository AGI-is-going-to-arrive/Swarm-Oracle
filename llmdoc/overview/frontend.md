# Frontend 模块地图

## 技术栈概览

React 19 + TypeScript 5.9 + Vite 7 + Zustand + @xyflow/react + GSAP + i18next + Phaser.js

## 页面 (`src/pages/`)

| 页面 | 文件 | 描述 |
|------|------|------|
| InputView | `InputView.tsx/.css` | 首页：输入"What-If"问题，Agent数量滑块(3-100)，推演模式切换(RAW/Blackboard)，BYOK 自定义 LLM 折叠面板 (P4-E)，快速开始卡片；问题输入在移动端使用自动增高多行 textarea，长问题会换行而非裁切；每日挑战卡支持中英文文案与完成态/已用卡数/下注态反馈，并会显示当前题材 label、signature hooks 与题材回响反馈 |
| SimulationView | `SimulationView.tsx/.css` | 模拟进行中：实时agent对话流 + 干预入口 + 可收起侧边栏（磨砂玻璃药丸Toggle） + 分支卡片实时讨论动态脉冲；Theater 顶部包含 live status HUD、玩法卡入口、结构化下注入口、显式截图模式切换（`Panel/Canvas/Modal`）以及“当前截取目标”提示；完成态支持世界线/轮次回放筛选、重播/跳到最新/倍速控制，并把 compact TimelineBar 直接嵌回 Theater 面板内；live warmup 会显示“导演准备中”状态，玩法卡支持只读预览；LanguageSwitcher 在剧场页会自动上移，避免挡住底部状态条；Theater 背景现为 26 个语义主题，按题面选景而不是随机轮换 |
| ResultView | `ResultView.tsx/.css` | 结果页：分支树 + 叙事对比 + 社交媒体文案生成 (P6)；如果用户在 narration 完成前过早打开 `/result/:id`，页面会先停在 loading，等故事真正生成完再展示；结构化下注与“因果档案”区块现已支持按单条下注显示 `命中 / 未中 / 待判定`，档案摘要会展示命中比，并保留 `dominantBranchTitle`、`dominantTone`、`mostUsedCard`、`archiveGrade`、`directorStyleTag`、`profileResonance`；导出 Markdown 和分享文案会附带题材档案前缀 |

## 组件 (`src/components/`)

| 组件 | 描述 |
|------|------|
| `AgentPanel` | Agent面板：显示agent列表、角色、情绪状态；右上角agent图标可过滤查看单个agent全部历史轮次消息；面板支持frosted-glass pill toggle收起/展开 |
| `BranchTree` | 分支树可视化（@xyflow/react + dagre自动布局） |
| `BranchNode` | 分支树节点（概率、状态、标题） |
| `BranchEdge` | 分支树边（自定义样式） |
| `BranchDetailModal` | 分支详情弹窗（故事、洞察、关键时刻） |
| `InterventionModal` | 蝴蝶效应干预弹窗 |
| `GameplayCardsModal` | 玩法卡弹窗：8 张玩法卡按题目画像动态推荐，支持目标分支/角色/来源分支选择、导演点数与冷却提示；当前额外补进 `公开听证 / 资源分诊 / 禁术仪式`，分别强化 law/trade、ecology/survival/frontier 与 faith/mythic 的题材张力；题材包已扩到 12 类，modal 会显示题材 hooks、题材导向文案，并在 warmup 时支持只读预览；生成的 prompt 现显式标注为“导演级 override”，要求 LLM 把玩法卡当成已经发生且持续生效的世界线事件 |
| `TimelineBar` | 时间线进度条（轮次追踪）；完成态 replay 会接入 round marker 图标（`fork/card/bet/result`）并支持直接跳轮次回放；hover tooltip 会显示本轮分支标题、玩法卡、下注与结局摘要；compact 版会直接嵌入完成态 Theater 面板内 |
| `QuickStartCards` | 首页快速开始示例卡片 |
| `ShareModal` | 社交媒体文案生成弹窗 (P6) — 支持小红书/微博/知乎/Reddit/X 一键生成；结果区会显示题材 label / 回响 / hooks，复制与导出版本会带题材档案前缀 |
| `LanguageSwitcher` | 全局语言切换器（EN/ZH），固定右下角，切换后刷新 i18n 上下文 |

## 状态管理 (`src/stores/`)

### `simulationStore.ts` (Zustand)
- **状态**: scenario, agents, branches, messages, groups (P3-A), hierarchical (P3-A), status, error, visualizationEnabled, viewMode
- **Actions**: startSimulation(question, rounds?, numAgents?, mode?, hierarchical?, llmApiKey?, llmBaseUrl?, llmModel?), setScenario, addMessage, updateBranch, setStatus, reset
- **特性**: 不可变更新、WebSocket事件驱动
- **场景 hydration**: `setScenario()` / `loadScenario()` 会读取 `Scenario.visualization_enabled`，并在直开 `/sim/:id` 时自动恢复 `viewMode='theater'`，避免已启用像素剧场的场景回落到 Classic
- **防护**: `MAX_MESSAGES=5000` 消息上限 + composite-key dedup 防止内存无限增长

## 本地玩法元数据 (`src/lib/`)

### `scenarioMeta.ts`
- 单局前端持久化层（localStorage）
- 保存：
  - 导演点数
  - 卡牌冷却
  - 玩法卡使用日志
  - 结构化下注记录
  - 因果档案摘要

### `predictionBetting.ts`
- 定义结构化下注协议：
  - `branch_winner`
  - `ending_tone`
  - `profile_resonance`
- 负责：
  - 将下注编码进 `prediction_text`
  - 从 `prediction_text` 反解析下注标签与理由
  - 在结果页按 `dominantBranch / dominantTone / profileResonance` 结算单条下注状态

### `dailyChallenge.ts`
- 内置每日挑战题库（治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态）
- 按日期轮换题目
- 记录 challenge started / completed 状态；进度以 `challengeId` 为主键读写，避免首页读不到当日状态
- 已按本地日期换日，不再用 UTC 日期切 challenge
- 完成反馈会记录 `profileResonance`

## Hooks (`src/hooks/`)

### `useSimulationWS.ts`
- WebSocket连接管理（自动连接/断开/指数退避重连）
- 初始连接延迟到 effect tick 后建立，并在清理阶段显式取消 pending reconnect timer，减少 mount/unmount 抖动时的首次 WS 噪声
- 事件分发到 Zustand store
- 支持流式agent发言（start → delta → complete）

### `useScreenCapture.ts` (Phase 3)
- 截图支持按调用覆盖 selector / captureTarget
- `SimulationView` 当前显式暴露三种截图模式：
  - `panel`
  - `canvas`
  - `modal`
- 模式切换本身不改页面布局，但会更新“当前截取目标”提示，告诉用户此刻会下载哪一块内容
- `panel` 优先抓 `.theater-panel`
- `canvas` 只抓 `.phaser-game-container`
- `modal` 只抓 `.modal-overlay`，无弹窗时禁用
- DOM capture 在 `html2canvas` 遇到 `oklch()` 解析失败时，会自动回退到颜色归一化 + `foreignObject SVG` 路径，确保 `panel / modal` 仍可生成图片
- `html2canvas` 现为按需动态导入，不再静态进入 `SimulationView` 首包
- GIF 录制（gif.js 动态导入，帧序列 fallback）
- 状态管理: idle → capturing/recording → done
- 自动下载 + 状态指示器；下载前会按扩展名归一化成标准 `image/png` / `image/gif`

## 类型定义 (`src/types.ts`)

核心接口: `Scenario`, `AgentInfo`, `BranchInfo`, `AgentMessage`, `StoryData`, `WSEvent` 等。
- `Scenario` 新增 `visualization_enabled?: boolean` 与 `scene_theme?: string | null`，用于从后端恢复 Theater 开关状态与场景主题
- P3-A: `GroupInfo`, `AgentGroupDetail` (分层分组信息)
- P3-B: `PredictionInfo`, `LeaderboardEntry` (竞猜/排行榜)

`WSEvent` 为联合类型，覆盖 15 种WebSocket事件（含 `retrospective_start`、`batch_intervention_applied`、`simulation_error`）。
`AgentMessage` 新增 `synthesized?: boolean` 标志 Worker 合成消息 (P3-A)。

## 国际化 (`src/i18n/`)

i18next 配置，支持 `zh-CN` 和 `en` 两种语言。
- UI 文案跟随右下角 `LanguageSwitcher` 切换
- 剧场页里的 `世界线 / 轮次 / 截图模式反馈 / 面板折叠提示` 已接入同一套 i18n
- agent 发言、结果叙事、评分与 narrator 输出语言主要跟随后端输入语言检测：
  - 英文输入 → 英文输出
  - 中文输入 → 中文输出

## 动画 (`src/animations/`)

GSAP 动画工具函数，用于页面转场和元素入场动画。

## 自动化可观测性

- `render_game_to_text()` 已覆盖 `InputView`、`SimulationView`、`ResultView`、`HistoryView`、`LeaderboardView`
- `SimulationView` / `ResultView` 在输出中带页面级控件摘要（按钮可用性、激活 modal、可展开/可干预分支等）
- `SimulationView` 的预测弹窗会额外输出表单级状态摘要（文本长度、自信度、提交可用性、错误状态）
- `SimulationView` 的玩法卡弹窗会额外输出玩法画像、推荐卡、目标分支/角色、导演点数与冷却摘要
- `SimulationView` 还会输出：
  - `page.controls.capture_mode`
  - `page.controls.can_capture_modal`
  - `page.warmup`
- `ResultView` 的分享弹窗会额外输出平台选择、生成中状态、复制状态和文案长度摘要
- `ResultView` 的分享弹窗会带 `share_context`
- 完成态 `SimulationView` 会输出 `page.replay_state`（选中世界线/轮次、batch 数、显示中的 bubble 数）
- `inferSceneTheme(question)` 已与后端 `scene_selector` 对齐：优先取原始题面中的强语义词；当前 Theater 场景池已扩到 26 个主题，支持主场景与轻量语义变体
- 固定回归样本集已落盘到：
  - `frontend/output/e2e/sample_matrix.json`
  - 当前固定样本为 14 条，覆盖主场景和部分轻量变体
- 一键回归入口：
  - `npm run e2e:matrix`
  - `npm run e2e:corners`
  - `npm run e2e:full`
  - `scripts/e2e-suite.mjs` 现在会在输出目录附带 `browser-launch.json`，记录 `requestedHeadless / actualHeadless / channel / usedSwiftShader / attempts`
  - 如果 Playwright 在 `page.screenshot()` 阶段卡在字体加载，suite 会自动回退到 Chromium CDP 截图，避免整套回归直接中断
  - 最新完整黑盒结果位于 `frontend/output/e2e/full-regression-final/result.json`

## 像素化可视化游戏引擎 (`src/game/`) — Phase 1+2+3+4

### 架构

```
WebSocket (viz:* events) → EventBridge → CustomEvent → Phaser WorldScene
```

### 组件

| 文件 | 描述 |
|------|------|
| `PhaserGame.tsx` | Phaser 游戏 React 包装组件，管理 Phaser.Game 生命周期 + 增量气泡分发（store 订阅实时消息）+ fallback synth init（竞态条件防御）；对自动化暴露 `advanceTime(ms)`，并通过 replay sync 在已完成回放与 live Theater 启动期跳过 `TitleScene`；Phaser `preBoot` 会注入初始 `scene_theme` |
| `PhaserGameLoader.tsx` | 懒加载器，显示加载状态，动态导入 Phaser；透传 `playbackMode/replaySpeed/playbackBranchId/playbackRound` 到 `PhaserGame` |
| `EventBridge.ts` | WebSocket 事件 → Phaser CustomEvent 桥接层，解耦 React 与 Phaser |
| `EventBridge.test.ts` | EventBridge 单元测试（13 tests）— 生命周期/订阅/错误隔离/边界情况 |
| `scenes/BootScene.ts` | Phaser 启动场景，加载角色、26 个场景背景、特效、UI 和结局资源，路由到 TitleScene |
| `scenes/TitleScene.ts` | 像素风标题画面，打字机字幕效果 + 点击跳过交互 + 微光扫描线动画，i18n 支持 (Phase 3 + 3.0-B3)；自动化可读取标题场景状态 |
| `scenes/WorldScene.ts` | 主游戏场景 — agent 精灵、打字机对话气泡变体、移动、世界分裂、情绪光环、天气/昼夜系统、阵营标记、MiniMap HUD、鼠标视差滚动、垂直擦除场景过渡；首次 `scene_init` 在 bootstrap 阶段会直接应用主题，避免先闪默认村庄；Phaser SHUTDOWN 生命周期自动清理所有 GameObjects/tweens/timers；气泡框仍保留像素风，但气泡文字已切到更高分辨率的常规 UI 字体栈，减少“字糊成像素块”的观感；自动化可读取主题/天气/agent/bubble 摘要 |
| `HudOverlay.tsx` | React HUD 浮层 — 排行榜（画布上方）+ 竞猜面板（画布下方），通过 EventBridge 监听 `viz:leaderboard_update` / `viz:bet_update` 事件；竞猜条新增 CTA，可直接打开结构化下注弹窗 |
| `replaySelection.ts` | 完成态 Theater 回放筛选 helper：按世界线/轮次提取消息与回放选项 |
| `scenes/EndingScene.ts` | 6 种像素结局演出，电影式转场 + 粒子特效 + 自动返回标题 (Phase 3)；自动化可读取 `ending_id/title/story_summary` |

### 支持的可视化事件

| 事件类型 | 前端效果 |
|---------|--------|
| `bubble_show` | 显示 agent 对话气泡（10 种情绪变体样式 + !/? 指示器） |
| `agent_move` | 精灵滑动到新位置 + 阵营色彩移动轨迹 |
| `world_split` | 世界分裂动画（水平/象限） |
| `event_anim` | 播放蝴蝶效应动画 + 粒子特效叠加 |
| `emotion_change` | 更新精灵情绪光环颜色 + 粒子脉冲 |
| `scene_change` | 切换像素世界主题（26 个语义场景） |
| `ending_play` | 渲染结局场景 → 切换至 EndingScene |
| `weather_change` | 天气效果（雨/雪/雷/沙尘暴） + 昼夜光照切换 |
| `bet_update` | 更新竞猜面板 — 阵营赔率 + 动态投注条 (Phase 3) |
| `leaderboard_update` | 更新排行榜 — Top-3 玩家 + 称号徽章 (Phase 3) |

### Phase 2 前端可视化增强

| 系统 | 描述 |
|------|------|
| 天气系统 | 4 种天气（雨/雪/雷电/沙尘暴），程序化粒子渲染 |
| 昼夜系统 | 4 时段（dawn/noon/dusk/night），全屏色调叠加 + 缓动过渡 |
| 阵营标记 | 4 色阵营色条（left/right/center/unknown） + 移动轨迹着色 |
| 对话气泡变体 | 10 种情绪样式（不同边框色/背景色/指示器图标） |
| 粒子特效 | 事件动画 + 情绪变化叠加星光/烟雾粒子 |

### Phase 3 游戏化 + 结局演出

| 系统 | 描述 |
|------|------|
| 标题画面 | TitleScene — 像素风标题 + 打字机字幕 + 点击跳过 + 微光扫描线 + i18n |
| 结局演出 | EndingScene — 6 种结局（繁荣/衰败/平衡/混沌/技术/自然），电影转场 + 粒子 |
| MiniMap HUD | 右下 80×80 小地图（canvas 内），实时显示 Agent 位置分布 |
| BetPanel HUD | 竞猜面板（React HudOverlay，画布下方）— 阵营赔率 + 动态投注条 |
| Leaderboard HUD | 排行榜（React HudOverlay，画布上方）— Top-3 玩家 + 称号徽章 |
| 截图/GIF 导出 | useScreenCapture hook — 支持 `Panel/Canvas/Modal` 三种截图模式；GIF 保持 `Panel/Canvas` 可用（modal 模式禁用） |
| Structured Betting 2.x | `PredictionModal` 支持押世界线 / 押结局倾向 / 押题材回响，Theater HUD 可直接打开下注；分支尚未 hydrate 时会自动回退到 `ending_tone`，避免空目标下注 |
| Gameplay Cards | `GameplayCardsModal` 提供 8 张玩法卡，支持题目画像驱动推荐、导演点数与冷却；其中 `公开听证` 会强制摊开证据/账本/代价，`资源分诊` 会明确谁先保命、谁被限供，`禁术仪式` 会引入高代价、可能不可逆的禁术或例外条款；题材包已扩到 12 类，并会影响卡面导向文案、选角建议与来源分支建议；注入 prompt 会显式要求 agent 把玩法卡当成高优先级、持续生效的世界线事件 |
| Semantic Scene Pool | Theater 背景已扩到 26 个主题，包含主场景和轻量语义变体；同一 profile 可按题面落到不同场景，例如 `governance -> scifi_base/civic_chamber/surveillance_megacity` |
| Causal Archive | `ResultView` 展示玩法记录、下注记录、关键记录、导演点数、每日挑战标记；新增 `profileResonance`，并把题材档案前缀接进导出/分享结果 |
| Daily Challenge | `InputView` 每日挑战卡 + `dailyChallenge.ts` 题库/完成状态；挑战池现为 9 条，并会显示题材 hooks 与完成后的题材回响 |
| Branch/Round Replay | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 会直接出现在 Theater 面板内并显示 `fork/card/bet/result` marker |

### Phase 4 开源准备 + 性能优化

| 系统 | 描述 |
|------|------|
| Weather 对象池 | acquireWeatherDot/releaseWeatherDot — 120 个 Graphics 对象回收复用，减少 GC 压力 |
| 视口裁剪 | cullAgent — VIEWPORT_MARGIN 40px 外 Agent 隐藏，减少 GPU 绘制调用 |
| Pool 清理 | shutdown() 中销毁 weatherPool/bubblePool，防止内存泄漏 |
| Automation Hooks | `render_game_to_text()` + `advanceTime(ms)` + `preserveDrawingBuffer=true`，提升浏览器黑盒测试的状态读取与截图稳定性；已覆盖页面级控件摘要、warmup 摘要、capture mode、modal 内部状态摘要与分享上下文摘要 |
| WorldScene.test.ts | 19 断言 — 26 主题 + 13 事件 + 4 阵营 + 10 气泡 + 4 时段 + 双语 + 性能常量 |
| EndingScene.test.ts | 14 断言 — 6 结局配置 + 3 类型映射 + resolveEndingId 逻辑 |

### 3.0 Phase B 美术风格全面升级

| 系统 | 描述 |
|------|------|
| GBC 调色板统一 | 16 个 CSS custom properties (`--gbc-*`)，替代硬编码色值 |
| 资产重生成 | 场景背景已扩到 26 张，统一沿用当前 GBC 像素风与 Theater 视觉语言 |
| TitleScene B3 增强 | 打字机字幕 + 点击跳过 + 微光扫描线 |
| WorldScene B4 增强 | 鼠标视差滚动 + 打字机气泡 + 垂直擦除过渡 |

### 3.0 Phase C UI/UX 布局 + Theater Mode 完善

| 系统 | 描述 |
|------|------|
| SimulationView 布局 | Theater 模式画布 65% + Agent 面板 35%，GBC 暗色主题全覆写；完成态 replay-ready 现保持固定视口首屏，不再把主剧场推到页面中段；compact TimelineBar 直接嵌回 Theater 面板 |
| Theater Bug 修复 (8项) | 精灵不可见/全部相同/灰色背景/小地图/LLM JSON/气泡UUID/静止+重叠/多轮缺失 |
| VizSynthesizer 多轮回放 | 移除 60 条消息上限，全量回放所有轮次消息（如 171 条 → 57 批次） |
| PhaserGame 增量分发 | store 订阅 `useSimulationStore.subscribe` 检测新消息，实时 dispatch `viz:bubble_show` |
| Agent 漫游 | `startIdleWander()` — ±50px 漂移 + 3-7s 随机间隔 + AABB 抗重叠堆叠 |
| Theater Live HUD | 顶部 chips 展示场景/主题/轮次/角色数/气泡数/天气/时段/消息数 |
| Theater Replay Filters | 完成态 Theater 支持 `世界线` / `轮次` 下拉过滤回放 |

### 3.0-D Theater 气泡冻结修复

| 系统 | 描述 |
|------|------|
| visualization_enabled 透传 | `client.ts` + `simulationStore.ts` 将 `visualizationEnabled` 参数传递给后端 `createScenario` API，启用 `VisualizationMapper` |
| Fallback Synth Init | `PhaserGame.tsx` store 订阅中增加 fallback 逻辑 — 当 `synthDone` 因竞态条件未置位时，检测场景激活 + agent/message 存在后自动触发合成初始化 |

## CSS 约定

- **动态值传递**: 使用 `ref` callback 而非 inline `style` 设置 CSS custom properties（避免 lint 警告）
- **oklch() 兼容**: 所有 `oklch()` 颜色前必须有 `hsla()` 回退行（渐进增强）
- **line-clamp**: 同时声明 `-webkit-line-clamp` 和标准 `line-clamp`

## 构建与部署

- **开发**: `npm run dev` → Vite dev server (localhost:18928)
- **测试**: `npm test` → Vitest + Testing Library — 142 tests（覆盖状态管理、场景推断、回放、截图、玩法卡、分享和页面自动化摘要）
- **构建**: `npm run build` → `tsc -b && vite build` → `dist/`
- **Docker**: Nginx静态文件服务，代理 `/api` 和 `/ws` 到后端
