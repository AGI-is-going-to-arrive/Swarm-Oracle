[根目录](../CLAUDE.md) > **frontend**

# Frontend -- SwarmOracle React + Phaser SPA

## 模块职责

React 19 + TypeScript 单页应用，集成 Phaser 3 游戏引擎实现可视化模拟剧场、辩论竞技场、神谕密室、世界线圆桌等交互场景。使用 Zustand 状态管理、React Router v7 路由、i18next 国际化。

## 入口与启动

| 文件 | 说明 |
|------|------|
| `src/main.tsx` | React 入口，挂载 App 到 DOM |
| `src/App.tsx` | 路由定义 (BrowserRouter)，lazy-load 所有页面 |
| `src/api/client.ts` | REST API 客户端，封装全部后端接口调用 |
| `vite.config.ts` | Vite 构建配置 |
| `vitest.config.ts` | Vitest 测试配置 |

```bash
# 开发
npm run dev        # Vite dev server (port 18928)

# 构建
npm run build      # tsc -b && vite build

# 测试
npm test           # vitest run
npm run test:watch # vitest (watch mode)
```

## 对外接口 (页面路由)

| 路径 | 组件 | 功能 |
|------|------|------|
| `/` | `InputView` | 首页，创建场景/辩论入口 |
| `/sim/:id` | `SimulationView` | 模拟实时观察 + Phaser 剧场 |
| `/sim/replay` | `SimulationView` | Replay 模式 |
| `/result/:id` | `ResultView` | 模拟结果展示 |
| `/result/replay` | `ResultView` | Replay 结果 |
| `/debate/:id` | `DebateArenaView` | 辩论实时观察 |
| `/debate/:id/result` | `DebateResultView` | 辩论结果 |
| `/roundtable/:id` | `WorldlineRoundtableView` | 世界线圆桌 |
| `/roundtable/replay` | `WorldlineRoundtableView` | 圆桌 Replay |
| `/history` | `HistoryView` | 历史记录 |
| `/leaderboard` | `LeaderboardView` | 排行榜 |
| `/agents` | `AgentLibrary` | Agent 身份库 (Phase 3 F1) |
| `/agents/new` | `AgentWorkshopView` | 自建 Agent 工坊 (Phase 3 F3) |
| `/sim/:id/causal-map` | `CausalReviewView` | 因果图谱 DAG (Phase 3 F2) |
| `/result/:id/compare` | `CompareDigestView` | 反事实分支对比 (Phase 3 F4) |

## 目录结构

### `src/pages/` -- 页面组件

| 文件 | 说明 |
|------|------|
| `InputView.tsx` | 首页输入，含搜索增强 toggle |
| `SimulationView.tsx` | 模拟视图 + Phaser 集成 |
| `ResultView.tsx` | 结果展示 (Summary-First 布局，含真实世界来源卡片，畸形数据防御) |
| `DebateArenaView.tsx` | 辩论竞技场 |
| `DebateResultView.tsx` | 辩论结果 |
| `WorldlineRoundtableView.tsx` | 世界线圆桌 (~1848 行) |
| `HistoryView.tsx` | 历史记录 |
| `LeaderboardView.tsx` | 排行榜 |
| `RoundtablePickerPanel.tsx` | 圆桌选择面板 (子组件) |
| `RoundtableTranscriptList.tsx` | 圆桌对话列表 (子组件) |
| `roundtableHelpers.ts` | 圆桌辅助函数 |
| `resultHelpers.ts` | 结果辅助函数 |
| `simulationHelpers.ts` | 模拟辅助函数 |
| `AgentWorkshopView.tsx` | 自建 Agent 表单 (Phase 3 F3) |
| `AgentLibrary.tsx` | Agent 身份网格 + 删除 (Phase 3 F1) |
| `CausalReviewView.tsx` | @xyflow/react DAG + dagre 布局 (Phase 3 F2) |
| `CompareDigestView.tsx` | 逐轮分支对比 + 发散度条 (Phase 3 F4) |

### `src/components/` -- 共享组件

| 文件 | 说明 |
|------|------|
| `EndingChatModal.tsx` | 神谕密室聊天弹窗 (~1509 行) |
| `BranchTree.tsx` / `ClassicBranchTree.tsx` | 分支树可视化 |
| `InterventionModal.tsx` | 干预操作弹窗 |
| `ShareModal.tsx` / `DebateShareModal.tsx` | 分享弹窗 |
| `DebateBetModal.tsx` | 辩论投注弹窗 |
| `GameplayCardsModal.tsx` | 游戏卡牌弹窗 |
| `TimelineBar.tsx` | 时间线进度条 |
| `AppErrorBoundary.tsx` | 全局错误边界 |
| `LanguageSwitcher.tsx` | 语言切换器 |
| `endingChatHelpers.ts` | 密室聊天辅助函数 |
| `AgentAttachPanel.tsx` | Agent 勾选面板 (tab+space 键盘可达, Phase 3 F3) |
| `ArgumentMap.tsx` | 辩论论证树 (role="tree", Phase 3 F6) |
| `CounterfactualPanel.tsx` | 反事实种子选择器 (Phase 3 F4) |
| `FactionTimeline.tsx` | 阵营时间线 (逐轮色条, Phase 3 F5) |
| `ReturningBadge.tsx` | 跨场景回归标记 (Phase 3 F1) |

### `src/game/` -- Phaser 游戏引擎

| 文件 | 说明 |
|------|------|
| `index.ts` | Phaser 游戏配置 |
| `PhaserGameLoader.tsx` | React-Phaser 桥接组件 |
| `HudOverlay.tsx` | HUD 浮层 |
| `scenes/WorldScene.ts` | 主剧场场景 (代理气泡、精灵) |
| `scenes/BootScene.ts` | 启动场景 |
| `scenes/TitleScene.ts` | 标题场景 |
| `scenes/EndingScene.ts` | 结局场景 |
| `managers/EventBridge.ts` | 事件桥 (React <-> Phaser) |
| `managers/VizSynthesizer.ts` | 可视化合成器 |
| `worldSceneBootstrap.ts` | WorldScene 初始化 |
| `sceneAssetPlan.ts` | 场景资源规划 |
| `replaySync.ts` | Replay 同步 |
| `replaySelection.ts` | Replay 选择 |
| `automation.test.ts` | 自动化测试 |

### `src/stores/` -- Zustand 状态管理

| 文件 | 说明 |
|------|------|
| `simulationStore.ts` | 模拟状态 |
| `debateStore.ts` | 辩论状态 |
| `endingRoomStore.ts` | 密室/圆桌状态 |
| `worldlineRoundtableStore.ts` | endingRoomStore 的 re-export |
| `agentStore.ts` | Agent 身份选择 (max 5, Phase 3 F1/F3) |

### `src/hooks/` -- 自定义 Hooks

| 文件 | 说明 |
|------|------|
| `useDebateWS.ts` | 辩论 WebSocket |
| `useEndingRoomWS.ts` | 密室 WebSocket |
| `useWorldlineRoundtableWS.ts` | 圆桌 WebSocket |
| `useSimulationWS.test.tsx` | 模拟 WebSocket |
| `useScreenCapture.ts` | 截图 / GIF 录制 |
| `useInputViewState.ts` | 输入页状态，含搜索增强开关与服务端能力检测 |
| `useSimulationViewState.ts` | 模拟页状态 |
| `useTranscriptScroll.test.ts` | 对话滚动 (密室/圆桌共享) |

### `src/lib/` -- 工具函数库

| 类别 | 文件 |
|------|------|
| 主题 | `themeRegistry.ts`, `themeLabels.ts` |
| 场景 | `scenarioAuthority.ts`, `scenarioMeta.ts`, `scenarioDirectorState.ts`, `scenarioGameplayState.ts`, `scenarioGameplayDerivations.ts`, `scenarioReplay.ts` |
| 辩论 | `debateCounterplay.ts`, `debateInsights.ts`, `debateLabels.ts`, `debateReplay.ts`, `debateShare.ts` |
| 密室 | `endingRoomCandidates.ts`, `endingRoomLabels.ts`, `endingRoomReplay.ts`, `oracleReplay.ts` |
| 分享 | `shareEnvelope.ts`, `challengeShare.ts`, `copyText.ts`, `permalink.ts` |
| 排版 | `textLayout/pretext.ts`, `textLayout/textOverflowPredictor.ts`, `textLayout/oracleTranscriptLayout.ts`, `textLayout/inputPredict.ts`, `textLayout/canvasTextPredict.ts` |
| 其他 | `apiErrorMessage.ts`, `dailyChallenge.ts`, `directorIdentity.ts`, `directorObjectives.ts`, `gameplayContract.ts`, `gameplayProfileCatalog.ts`, `llmProviderPolicy.ts`, `predictionBetting.ts`, `replayCodec.ts`, `roundtableSelection.ts`, `runtimePreset.ts`, `wsDebug.ts` |

### `src/i18n/` -- 国际化

- `config.ts` -- i18next 配置
- `locales/zh.json` -- 中文
- `locales/en.json` -- 英文

### `scripts/` -- E2E 与工具脚本

16 个 `.mjs` 脚本，包括 E2E 测试套件、资源生成、性能预算检查、Release 签核。

## 关键依赖与配置

| 依赖 | 用途 |
|------|------|
| react 19 + react-dom | UI 框架 |
| phaser 3 | 2D 游戏引擎 (剧场可视化) |
| zustand 5 | 状态管理 |
| react-router-dom 7 | 路由 |
| @xyflow/react + dagre | 分支树图可视化 |
| gsap | 动画 |
| i18next + react-i18next | 国际化 |
| html2canvas + gif.js | 截图/GIF 录制 |

## 测试与质量

- **77 个测试文件** (`.test.ts` / `.test.tsx`) / **715 tests**
- 框架: vitest + @testing-library/react + jsdom
- Lint: eslint + react-hooks + react-refresh
- E2E: Playwright (自定义脚本封装)
- 运行: `npm test` (单元) / `npm run e2e:full` (E2E)

## 常见问题 (FAQ)

**Q: `worldlineRoundtableStore` 为什么是空文件?**
A: 它是 `endingRoomStore` 的 re-export，不是 stub。圆桌和密室共享同一个 store。

**Q: 为什么 EndingChatModal 和 WorldlineRoundtableView 这么大?**
A: 已通过提取 helper 函数和子组件进行拆分 (endingChatHelpers, roundtableHelpers, RoundtablePickerPanel, RoundtableTranscriptList 等)，但核心组件仍较大。

**Q: Phaser 和 React 如何通信?**
A: 通过 `EventBridge` (自定义事件总线) 和 `PhaserGameLoader` (React 桥接组件)。

## 相关文件清单

```
frontend/
  src/
    main.tsx            # React 入口
    App.tsx             # 路由定义
    types.ts            # TypeScript 类型定义
    index.css           # 全局样式 + Design tokens
    api/client.ts       # REST API 客户端
    pages/              # 8 个页面 + 辅助函数
    components/         # 15+ 共享组件
    game/               # Phaser 游戏引擎 (6 场景 + 管理器)
    stores/             # Zustand 状态 (3 个 store)
    hooks/              # 自定义 Hooks (10+)
    lib/                # 工具函数库 (30+ 文件)
    i18n/               # 国际化 (zh/en)
  scripts/              # E2E + 工具脚本 (16 个)
  package.json          # 依赖与脚本
  vite.config.ts        # Vite 配置
  vitest.config.ts      # 测试配置
  Dockerfile            # Docker 构建
```

## 深度补扫

### types.ts -- 全局 TypeScript 类型定义 (832 行)

#### 核心模拟类型

| 接口 | 说明 | 对应后端模型 |
|------|------|-------------|
| `Scenario` | 场景快照，含 agents/branches/groups/messages/director_state/gameplay_state | `Scenario` 表 + 关联 |
| `AgentInfo` | Agent 信息 (id/name/role/persona/tier/stance/emotion/group_id) | `Agent` 表 |
| `BranchInfo` | 分支信息 (含 story/insight/key_moments/probability/status) | `Branch` 表 |
| `AgentMessage` | Agent 发言 (agent/message/emotion/diverge/branch/round/synthesized) | `AgentMessage` 表 |
| `GroupInfo` / `AgentGroupDetail` | P3-A 分组信息 | `AgentGroup` 表 |

#### 干预类型

| 接口 | 说明 |
|------|------|
| `InterventionPayload` | 蝴蝶效应干预请求 (branch_id/text/card_id/profile_id/directive) |
| `RetrospectiveInterventionPayload` | 回溯干预 (额外 round_number) |
| `BatchInterventionPayload` | 批量干预 |
| `InterventionResponse` / `BatchInterventionResponse` | 干预响应 |

#### 辩论竞技场类型

| 接口 | 说明 |
|------|------|
| `DebateSnapshot` | 辩论完整快照 (participants/score/turns/phase_insights/counterplay) |
| `DebateTurn` | 辩论回合 (phase/speaker_side/content/score_delta) |
| `DebateResultSummary` | 判决结果 (winner/verdict_tone/score/breakdown/judge_rationale) |
| `DebatePrediction` | 用户预测投注 (kind/target_value/confidence/is_counterplay) |
| `DebatePhaseInsight` | 阶段洞察 (stakes/judge_focus/pressure_side/confidence_drift) |
| `DebateCounterplayResult` | 反击结果 |

#### 神谕密室 / 世界线圆桌类型

| 接口 | 说明 |
|------|------|
| `EndingRoomSnapshot` | 密室/圆桌快照 (participants/threads/turns/result_ready) |
| `EndingRoomParticipant` | 参与者 (role_slot/display_name/persona_snapshot/worldline_echo_key) |
| `EndingRoomTurn` | 回合 (thread_id/source/interaction_mode/memory_partition_id/cited_refs) |
| `EndingRoomThread` / `EndingRoomThreadSnapshot` | Follow-up 线程 |
| `EndingRoomResult` | 密室结果 (summary/next_move/archivist_note/phase_insights/supporting_turns) |
| `CreateEndingRoomRequest` | 创建请求 (roomType/selectedBranchIds/selectionRecipe) |

#### Campaign 系统类型

| 接口 | 说明 |
|------|------|
| `CampaignProfileSummary` | 用户 Campaign 档案 |
| `CampaignMastery` | 精通度 (runs/challenge_completions/campaign_score/level) |
| `CampaignFinalizeResult` | 场景结算结果 (score_delta/newly_unlocked_badges) |
| `CampaignScenarioSummary` | 场景 Campaign 摘要 (archive_grade/profile_resonance/commitment_outcome) |
| `ScenarioDirectorState` | 导演状态 (objectives/commitment) |
| `ScenarioGameplayState` | 游戏状态 (cards/betting/archive) |
| `CampaignDailyChallengeStatus` / `CampaignWeeklySummary` | 每日/每周挑战 |

#### WebSocket 事件联合类型

| 类型 | 事件列表 |
|------|---------|
| `WSEvent` | auth_ok, heartbeat, status, agent_speak_start/delta/speak, round_summary, branch_init/fork/prune/update, narration, intervention_applied/injected, retrospective_start, batch_intervention_applied, simulation_done/error |
| `DebateWSEvent` | auth_ok, heartbeat, status, agent_speak, debate_phase_change, debate_score_update, debate_counterplay, debate_verdict |
| `EndingRoomWSEvent` | auth_ok, heartbeat, status, ending_room_turn_start/delta/commit/error, ending_room_phase_change, ending_room_result_ready, ending_room_thread_created, ending_room_scope_notice |

#### 关键枚举 / 联合类型

| 类型 | 值 |
|------|------|
| `EndingRoomType` | `ending_chamber`, `worldline_roundtable`, `one_move_only`, `crossline_gallery` |
| `EndingRoomInteractionMode` | `auto_recap`, `archivist_route`, `hotseat`, `all_present`, `thread_followup`, `epilogue`, `evidence_card` |
| `DebatePhase` | `opening`, `crossfire`, `rebuttal`, `closing`, `verdict` |
| `RoundtableSelectionRecipe` | `representative`, `manual_shortlist`, `expert_witness`, `trait_mix`, `fault_line_first`, `witness_augmented` |

### WorldScene.ts -- Phaser 主场景 (~1800 行)

#### 场景生命周期

| 方法 | 说明 |
|------|------|
| `constructor()` | 注册 scene key = `'WorldScene'` |
| `create()` | 绘制背景 + MiniMap + 注册 EventBridge 监听 + 视差输入 + 派发 `viz:scene_ready` |
| `shutdown()` | 解绑所有 EventBridge 监听，销毁天气/环境粒子/计时器 |
| `getAutomationState()` | 返回场景快照 (theme/weather/agents/bubbles)，供 E2E 测试读取 |

#### 视觉系统

| 子系统 | 说明 |
|--------|------|
| **背景渲染** | 支持场景贴图 (PNG) + 多层程序化生成后备 (天空渐变 + 地平线辉光 + 远/中地形剪影 + 地面纹理 + 漂浮云层) |
| **场景主题** | 29 种主题调色板 (medieval_village, scifi_base, war_battlefield, space_station 等)，每种含 sky1/sky2/ground/accent/icon |
| **主题切换** | `transitionTheme()` 使用垂直黑幕擦除过渡 (B4 wipe transition) |
| **天气系统** | 对象池回收 (WEATHER_POOL_SIZE=120)，支持 clear/rain/snow/fog/storm |
| **日夜系统** | 4 种时段色调 (dawn/noon/dusk/night)，覆盖半透明遮罩 |
| **环境粒子** | 浮动微粒 (motes)，对象池回收 (AMBIENT_MOTE_POOL_SIZE=24)，主题色 + 白色随机 |
| **视差效果** | 鼠标移动驱动地形层 + 云层视差 |

#### 精灵管理

| 功能 | 说明 |
|------|------|
| `spawnAgent()` | 创建 Container (阴影 + 光晕 + 精灵 + 名牌 + 阵营色条)，Bounce 弹入动画，呼吸动画 |
| `moveAgent()` | 立场驱动位移 (stance -> 800x600 虚拟坐标 -> 实际坐标)，尾迹粒子，Phase 4 视口剔除 |
| `startIdleWander()` | 空闲漫步 (半径 50px，3-7s 间隔，1.5-3.5s 持续)，保持场景活力 |
| `updateHalo()` | 情绪光晕 (脉冲动画 + 爆裂粒子) |
| 精灵尺寸 | 动态缩放：`baseScale * 0.055` 宽度，1.5:1 高宽比 (原始 32x48 像素) |

#### 对话气泡系统

| 配置常量 | 值 | 说明 |
|----------|-----|------|
| `BUBBLE_MAX_VISIBLE_CAP` | 8 | 最大同时显示气泡数 (动态 = min(agentCount, 8)) |
| `BUBBLE_MAX_TEXT_CHARS` | 72 / 48 (compact) | 气泡文本截断长度 |
| `BUBBLE_TEXT_WRAP_*_WIDTH` | 220-300px | 气泡文本换行宽度 |
| `BUBBLE_TEXT_RESOLUTION` | 4x | Canvas 文本渲染分辨率 |
| 打字机延迟 | 14ms (live) / 20ms (replay) | 逐字显示速度 |
| 停留时间 | 1800ms (live) / 2800ms (replay) + 18ms/字 | 气泡展示时长 |

- **10 种情绪气泡样式**: aggressive, angry, anxious, fearful, cautious, calm, hopeful, cooperative, confident, neutral
- **紧凑模式** (viewport < 360px): 底部居中固定定位，暗色半透明背景
- **布局算法**: 6 个预设插槽 + 重叠检测，选择最少重叠的插槽
- **P4 Pretext 集成**: 优先用 `predictBubbleTextSize()` (Canvas 预测) 计算气泡尺寸，后备 Phaser getBounds

#### 事件系统 (EventBridge 监听)

| 事件 | 处理 |
|------|------|
| `viz:scene_init` | 设置主题 + 批量生成精灵 |
| `viz:bubble_show` | 显示对话气泡 (打字机效果) |
| `viz:clear_bubbles` | 清除所有活跃气泡 |
| `viz:agent_move` | 立场驱动位移 + 阵营色条更新 |
| `viz:world_split` | 分支分裂动画 (辉光线 + 涟漪 + 镜头震动) |
| `viz:emotion_change` | 更新光晕颜色 + 脉冲动画 |
| `viz:event_anim` | 事件动画 (17 种预设: 地震/火灾/瘟疫/技术突破/联盟/间谍等) |
| `viz:scene_change` | 主题过渡 (垂直擦除) |
| `viz:ending_play` | 切换到 EndingScene |
| `viz:weather_change` | 天气 + 日夜切换 |

#### 性能优化 (Phase 4)

- **对象池**: 天气粒子 (120) + 环境微粒 (24) 回收复用
- **视口剔除**: 超出 `VIEWPORT_MARGIN=40px` 的精灵自动隐藏
- **纹理延迟加载**: 场景贴图和精灵贴图按需异步加载，加载完成后热替换
- **MiniMap**: 120x64 浮动小地图，实时同步精灵位置和阵营颜色

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-04-09 | Phase 3 六大功能 | 4 新页面 (AgentWorkshop/Library/CausalReview/CompareDigest)、5 新组件 (AgentAttach/ArgumentMap/Counterfactual/FactionTimeline/ReturningBadge)、agentStore、i18n Phase 3 keys、4 新路由、contract-freeze 测试、29+ 新测试 |
| 2026-04-09 | 遗留项收口 | mobile roster dialog 焦点管理 (打开聚焦 + 关闭回触发按钮)；sidebar `<details>` 加 aria-label；hotseat/overflow CSS 颜色提取为 token；e2e 脚本死代码清理；reducedMotion tween guard 结构测试 ×5 |
| 2026-04-08 | 圆桌 UI 升级 (Track D) | Synthesis-First section (verdict 主区顶部)；phase nav pill bar + scrollIntoView；mobile roster modal (dialog 语义 + Escape 关闭)；tablet sidebar `<details>` 折叠；8-hue speaker 色条；transcript role="log"；280 行新增测试 |
| 2026-04-08 | WS 首帧 auth + 重连策略 | 三个 WS hooks 从 URL query token 迁移到首帧 auth 协议，auth_ok 加入事件联合类型，4001/4404 不重连，3 条 M1 测试 |
| 2026-04-07 | Web 搜索增强 + 安全加固 | InputView 搜索增强 toggle、ResultView 来源卡片 (含 XSS 防护 + 畸形数据防御 + 长文本溢出保护)、`getCapabilities()` API、3 条来源卡片回归测试 |
| 2026-04-02 | 深度补扫 | 补充 types.ts 全局类型定义 + WorldScene.ts 场景系统详解 |
| 2026-04-02 | 初始生成 | 模块扫描完成 |
