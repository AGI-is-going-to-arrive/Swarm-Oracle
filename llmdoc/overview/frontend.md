# Frontend 模块地图

## 技术栈概览

React 19 + TypeScript 5.9 + Vite 7 + Zustand + @xyflow/react + GSAP + i18next + Phaser.js

- 交付形态：浏览器优先的 Web 应用。当前“跨平台”指桌面/移动浏览器响应式与视口 E2E，不包含原生 Windows/macOS/Linux/iOS/Android 客户端壳。

## 页面 (`src/pages/`)

| 页面 | 文件 | 描述 |
|------|------|------|
| InputView | `InputView.tsx/.css` | 首页：输入"What-If"问题，Agent数量滑块(3-100)，推演模式切换(RAW/Blackboard)，BYOK 自定义 LLM 折叠面板 (P4-E)，快速开始卡片；问题输入在移动端使用自动增高多行 textarea，长问题会换行而非裁切；每日挑战卡支持中英文文案与完成态/已用卡数/下注态反馈，并会显示当前题材 label、signature hooks 与题材回响反馈；首页会同时读取 director campaign `profile / mastery / badges / daily-status / weekly-summary`，把后端真值与本地缓存合并显示；当前还补了 `weekly challenge` 与 `director growth` 两张 Lite 卡，以及从分享 challenge URL 预填 `question / rounds / agents / mode / viz / profile` 的 banner；首页现在只读取轻量题材摘要 helper（`label / hooks / badge`），不再直接 runtime 引完整玩法策略表；BYOK/provider policy 当前也会本地持久化，供 createScenario / createDebate / social copy / scorePredictions 共用 |
| DebateArenaView | `DebateArenaView.tsx/.css` | Debate live 页：首页 `Debate Arena` 入口会创建独立 debate，会场首屏展示辩题、阶段条、势能条、三方 score card、阶段发言和结果 CTA；当前先用 DOM 舞台复用 Theater 场景图与 Debate 专属 UI 资产，不把 Debate 硬塞进 Phaser 场景；live 页现已支持阶段锁定回看、`Arena Read / 局势解读` 面板、移动端固定底部主 CTA，并会按 `debate.language` 自动同步整页 UI 语言；当前移动端同屏只保留一个主 CTA，避免 hero CTA 与底部 rail 重叠；页面已接 `render_game_to_text()` / `advanceTime(ms)` / `capture_game_screenshot()`，方便桌面/移动端自动化取证；当前 live 页会优先读取后端显式 `counterplay` snapshot/WS 数据，本地 helper 只做兜底；本轮又补了赛况总览卡、房间席位图、阶段地图，以及后端 `phase_insights` 直出的阶段解读；`debate_verdict` 到来时，这批阶段洞察会直接进 store，而不是等结果页二次拉取 |
| DebateResultView | `DebateResultView.tsx/.css` | Debate 结果页：展示 winner、scoreline、维度 breakdown、best argument / best rebuttal / judge summary、结构化 `judge_rationale`、`supporting_turns`、phase replay digest、prediction settlement 与 share modal；顶部 hero、verdict panel、quote frame、side badge 等都已接入 Debate D4 资产；结果页会按 payload `language` 自动同步 UI 语言，若 result API 返回终态错误会直接展示，不再无限轮询；分享弹窗按钮与生成文案首行现会按平台带 emoji 图标；当前结果页会优先读取后端显式 `counterplay` 字段，展示反制摘要、命中/未中结果、`explanation`，并继续传给 share copy；share copy 现还会带 1-2 条关键引文；本轮又补了结果信号卡与阶段地图，并优先消费后端顶层 `phase_insights`，所以 live / result 的阶段 stakes、judge focus 和 commentary 现在是同一套口径；同一组件当前还负责 `/debate/replay/result`，会从 replay token 直接 hydrate 结果、显示 `adjudication_mode`，并支持“导入为本地运行” |
| SimulationView | `SimulationView.tsx/.css` | 模拟进行中：实时agent对话流 + 干预入口 + 可收起侧边栏（磨砂玻璃药丸Toggle） + 分支卡片实时讨论动态脉冲；Theater 顶部包含 live status HUD、玩法卡入口、结构化下注入口、显式截图模式切换（`Panel/Canvas/Modal`）以及“当前截取目标”提示；完成态支持世界线/轮次回放筛选、重播/跳到最新/倍速控制，并把 compact TimelineBar 直接嵌回 Theater 面板内；live warmup 会显示“导演准备中”状态，玩法卡支持只读预览；当前导演层会在 Theater 面板内显示 2 个短目标、常驻 `风险 / 资源` 轨道、worldline 承诺选择与锁定/取消按钮；这部分 goals / commitment 现在走后端 `director_state` 权威态，主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 都走后端 `gameplay_state` 权威态，本地 `scenarioMeta` 退为缓存/兼容层；结构化下注提交成功后会立刻把新 meta 回传父层并回写后端；本 session 又去掉了把后端 authority 反向 apply 到 localStorage 的镜像链路，页面内只做 authority 优先的内存合并与 replay payload 组装；玩法卡 modal 现会显示题材专属三段式连锁事件、`风险 / 资源` 两条轻量状态，以及 profile-specific 的打法说明；桌面端 Theater 本轮又做了“场景优先”的可读性修复：右栏收成固定窄宽、`game-wrapper` 提前到 replay filters/timeline 前、导演目标改成双列、compact timeline 隐藏二级 stats，气泡文字也同步放大和加清晰化样式；移动端 Theater 头部动作区在窄屏下会自动换行，并把视图切换收成图标胶囊，避免控件裁切；Theater 背景现为 30 个 Theater 语义主题 + 3 个 Debate 专属主题，共 33 个 registry 条目；当前 Phaser 预热只会在用户真正切进 Theater 后再触发，并优先走 idle 时机，避免普通首页 / Classic 路径提前拉取大引擎包；本 session 又把 `PhaserGameLoader` 本身移到 Theater 动态边界；截图自动化摘要现还会带 `capture_result_kind`，便于区分 `gif` 与 `gif_fallback_png`；同一组件当前还负责 `/sim/replay`，replay 模式会关闭 WS、下注、干预和玩法卡写操作，只保留回放 / 截图 / 复制 replay 链接 / 导入为本地运行 |
| ResultView | `ResultView.tsx/.css` | 结果页：分支树 + 叙事对比 + 社交媒体文案生成 (P6)；如果用户在 narration 完成前过早打开 `/result/:id`，页面会先停在 loading，等故事真正生成完再展示；故事与档案摘要就绪后会调用 `finalizeCampaign()` 结算导演生涯，并渲染 `Campaign Progress` 区块（积分增量 / 等级 / 下次解锁 / 徽章）；结构化下注与“因果档案”区块现已支持按单条下注显示 `命中 / 未中 / 待判定`，档案摘要会展示命中比，并保留 `dominantBranchTitle`、`dominantTone`、`mostUsedCard`、`archiveGrade`、`directorStyleTag`、`profileResonance`；本轮新增的归档字段包括导演目标完成度、worldline 承诺结果，以及最终 `风险 / 资源` 轨道；结果页现在会把远端 `betting / archive` raw state 合并回展示层，`key moments` 会按当前 UI 语言格式化展示，并新增 `branch snapshots` 区块；导出 Markdown 和分享文案会附带题材档案前缀；页面当前会先读后端 `director_state`、`gameplay_state`，再并行读取后端 `/api/campaign/scenario/{id}/summary` 回填 `archive_grade / profile_resonance / most_used_card / betting_hit / completed_daily_challenge`，并避免把默认 `3/3` 导演点数误当成真值展示；本 session 又去掉了用本地 `scenarioMeta` 反向回填后端 `director_state / gameplay_state` 的路径；本轮又补了 `分享挑战` 按钮，可直接复制 challenge URL，把同题同参数带回首页预填；同一组件当前还负责 `/result/replay`，会优先从后端短 `share id` 读取 replay，失败时回退 token，并跳过 `finalizeCampaign()` 与后端 authority 回写，必要时可直接“导入为本地运行” |

## 组件 (`src/components/`)

| 组件 | 描述 |
|------|------|
| `AgentPanel` | Agent面板：显示agent列表、角色、情绪状态；右上角agent图标可过滤查看单个agent全部历史轮次消息；面板支持frosted-glass pill toggle收起/展开 |
| `BranchTree` | 分支树可视化（@xyflow/react + dagre自动布局） |
| `BranchNode` | 分支树节点（概率、状态、标题） |
| `BranchEdge` | 分支树边（自定义样式） |
| `BranchDetailModal` | 分支详情弹窗（故事、洞察、关键时刻） |
| `InterventionModal` | 蝴蝶效应干预弹窗 |
| `GameplayCardsModal` | 玩法卡弹窗：当前共有 14 张玩法卡，按题目画像动态推荐，支持目标分支/角色/来源分支选择、导演点数与冷却提示；除原有导演卡外，本轮新增 `审计清算 / 情报反噬 / 民意回摆 / 停火委员会` 4 张反制卡；题材包已扩到 12 类，modal 会显示题材 hooks、题材导向文案、三段式题材连锁事件、当前承诺 worldline，以及 `风险 / 资源 / 压强` 三项摘要；本轮又补了 profile 战术层：modal 会显示当前题材的打法说明，并把这条说明一起带进玩法卡 prompt；generic 题材现使用独立 `gameplay_card_frame_generic` 卡框，不再复用 `gameplay_panel` 做装饰框；生成的 prompt 现显式标注为“导演级 override”，要求 LLM 把玩法卡当成已经发生且持续生效的世界线事件 |
| `TimelineBar` | 时间线进度条（轮次追踪）；完成态 replay 会接入 round marker 图标（`fork/card/bet/result`）并支持直接跳轮次回放；hover tooltip 会显示本轮分支标题、玩法卡、下注与结局摘要；compact 版会直接嵌入完成态 Theater 面板内 |
| `QuickStartCards` | 首页快速开始示例卡片；generic 现为 3 条 `switchboard_forum` 题面，并可直接传递推荐起局参数 |
| `DebateStageRibbon` | Debate Arena 五阶段 ribbon，支持按已解锁阶段切片回看，并可手动锁定在某个阶段后再回到 live |
| `DebateMomentumBar` | Debate 势能条；当前已收敛成更易读的深色 HUD，不再把透明像素边框直接压在核心文案上 |
| `DebateScoreCard` | Debate 三方 score card；现支持 proposition / opposition / judge badge 装饰位 |
| `DebateBetModal` | Debate Arena 结构化押注弹窗，只支持 `winner / verdict_tone`；现会输出 modal 内部 automation state，并显示更直白的押注说明文案；当 live 页触发 `counterplay` 预设时，它会接收 preset kind/target/confidence |
| `DebateShareModal` | Debate 结果页专用分享弹窗，复用现有 share copy 口径但不走旧 scenario social API；现会输出平台、copy length、复制状态等 automation state，平台按钮与文案首行也会带对应 emoji 图标；当前 share copy 会带 `counterplay` 摘要和命中/未中结果，以及 replay permalink |
| `ShareModal` | 社交媒体文案生成弹窗 (P6) — 支持小红书/微博/知乎/Reddit/X 一键生成；结果区会显示题材 label / 回响 / hooks，复制与导出版本会带题材档案前缀；当前如果页面已有 replay permalink，也会一起放进分享 envelope |
| `LanguageSwitcher` | 全局语言切换器（EN/ZH）；桌面端固定右下角，移动端普通页面移到右上安全区，Theater 页继续贴右下安全区 |

## 状态管理 (`src/stores/`)

### `simulationStore.ts` (Zustand)
- **状态**: scenario, agents, branches, messages, groups (P3-A), hierarchical (P3-A), status, error, visualizationEnabled, viewMode
- **Actions**: `startSimulation(question, rounds?, numAgents?, mode?, hierarchical?, llmApiKey?, llmBaseUrl?, llmModel?, reasoningEffort?, visualizationEnabled?, userId?)`，当前会把 `userId` 一起透传给后端，用于 provider policy / 用户级配额
- **特性**: 不可变更新、WebSocket事件驱动
- **场景 hydration**: `setScenario()` / `loadScenario()` 会读取 `Scenario.visualization_enabled`，并在直开 `/sim/:id` 时自动恢复 `viewMode='theater'`，避免已启用像素剧场的场景回落到 Classic
- **防护**: `MAX_MESSAGES=5000` 消息上限 + composite-key dedup 防止内存无限增长

### `debateStore.ts` (Zustand)
- **状态**: `debate`、`status`、`error`
- **Actions**:
  - `startDebate(question)` — 创建独立 Debate Arena
  - `loadDebate(id)` — 拉取 live snapshot
  - `appendTurn()` / `setPhase()` / `setScore()` / `setCounterplay()` / `setVerdict()` / `setError()`
- **特点**:
  - 与 `simulationStore` 完全分离，不把 Debate 状态继续塞回 scenario 主 store
  - `agent_speak / debate_phase_change / debate_score_update / debate_counterplay / debate_verdict` 只更新 Debate 闭环需要的最小状态
  - `setVerdict()` 当前还会把 `debate_verdict` 事件里一并带回来的 `phase_insights` 落进 store，保证 live 页在 verdict 到来时就能拿到完整阶段洞察

## 本地玩法元数据 (`src/lib/`)

### `scenarioMeta.ts`
- 单局前端持久化层（localStorage）
- 当前不是整套玩法系统的后端权威状态，也不承诺跨设备完全一致
- 保存：
  - 导演点数
  - 卡牌冷却
  - 玩法卡使用日志
  - 结构化下注记录
  - 因果档案摘要
  - 题材连锁事件与 `风险 / 资源` 轨道的计算底座（由 usage log 派生，不额外要求后端 schema）
  - 读取阶段会为旧 localStorage 自动补默认值，避免因新增字段让旧本地状态直接崩页
- 当前口径：
  - `cards.usageLog` 已不再是纯本地 authority；前端会优先用后端 `gameplay_state.cards.usage_log` 回填，再把本地当缓存/兼容层
  - `betting.bets`、`archive.keyMoments` 与 `archive.branchSnapshots` 也已进入后端 `gameplay_state`；`scenarioMeta` 继续保留缓存/兼容层与派生字段
  - 本 session 又去掉了 `ResultView` 的 authority backfill；`PredictionModal` 也不再自己直读本地 `scenarioMeta`

### `scenarioDirectorState.ts`
- director goals / worldline commitment 的前后端映射层
- 负责：
  - 把本地 `scenarioMeta` 映射成后端 `Scenario.director_state_json`
  - 在前端把后端 `director_state` 合并回现有 `scenarioMeta` 结构
  - 只在后端 `director_state` 有有效数据时覆盖本地，避免把旧局的本地缓存误清空
- 当前口径：
  - goals / commitment 已以后端 `director_state` 为准
  - `scenarioMeta` 继续保留本地缓存和兼容层，但不再承担 `goals / commitment` authority
  - 页面层当前不会再把远端 `director_state` 反向 apply 成 localStorage 镜像

### `scenarioGameplayState.ts`
- 主模式 gameplay raw state 的前后端映射层
- 负责：
  - 把本地 `scenarioMeta.cards.usageLog / betting.bets / archive.keyMoments / archive.branchSnapshots` 映射成后端 `Scenario.gameplay_state_json`
  - 把后端 `gameplay_state.cards / betting / archive` 合并回现有 `scenarioMeta`
  - 基于远端 `usage_log` 重算导演点数、卡牌冷却、`mostUsedCard`、`counterplayCardCount` 与 `lastCounterplayCard`
  - 用完整 gameplay signature 比较远端/本地状态，避免只靠 `usage_log.length` 判定是否需要回写
- 当前口径：
  - 主模式 `cards.usageLog / betting.bets / archive.keyMoments / archive.branchSnapshots` 已以后端 `gameplay_state` 为准
  - 页面层当前不会再把远端 `gameplay_state` 反向 apply 成 localStorage 镜像；结果页也不再用本地 meta 回填后端 authority

### `themeRegistry.ts`
- Theater 场景与玩法素材的单一事实源
- 保存：
  - 33 个 `scene_theme` 的标签 / 关键词 / profile 归属 / asset path；在原 30 张 Theater 场景之外，Track D 另补 `debate_arena_civic / debate_arena_judicial / debate_arena_forum`
  - 运行时预载的角色 / 结局 / UI 资源 key；本轮又把 `sprite_alchemist / sprite_assassin / sprite_bard / sprite_knight / sprite_monk / sprite_thief / sprite_witch` 7 张原库存精灵接入 runtime
  - 玩法卡 frame / badge / panel 素材路径；generic 卡框已改为独立 `gameplay_card_frame_generic`，不再借用 `gameplay_panel`
  - `DEBATE_UI_ASSETS`：`debate_stage_banner / debate_verdict_panel / debate_score_meter / debate_badge_* / debate_quote_frame`
- `BootScene.ts`、`VizSynthesizer.ts` 与 `gameplayCards.ts` 已共用这份 registry，避免扩新主题时多处手工同步

### `debateLabels.ts` / `debateShare.ts`
- `debateLabels.ts`
  - 提供 Debate phases / sides / dimensions / verdict tone 的双语标签 helper
- `debateShare.ts`
  - 提供 Debate 结果页 share copy 组装 helper
  - 当前会统一提供平台 `icon + labelKey` 元数据
  - 保证 Debate share 文案和结果页字段口径一致；文案首行会带平台 emoji
  - 当前 share copy 会带 `counterplay` 摘要、命中/未中结果、更具体的 `counterplay explanation`、1-2 条 `supporting_turns` 引文，以及 replay permalink

### `scenarioReplay.ts` / `simulationReplay.ts` / `debateReplay.ts`
- replay 分享与回放 helper
- 负责：
  - 主模式结果页 replay 快照编码与解码
  - 主模式过程页 replay 快照编码与解码
  - Debate 结果页 replay token 编码与解码
- 当前口径：
  - 主模式优先走后端 `ReplayArtifact` 短 `share id`
  - token 仍保留为 fallback
  - replay 页面默认只读，但都支持“导入为本地运行”

### `debateCounterplay.ts`
- Debate 轻量 counterplay helper
- 负责：
  - 本地兜底记录（仍保留 `localStorage`）
  - 从后端 `counterplay` payload 或 legacy `predictions[]` 提取统一记录
  - 计算摘要文本与 hit/miss outcome；更细的 `explanation / phase_score` 直接以后端 payload 为准
- 当前优先级：
  1. 后端显式 `counterplay`
  2. `predictions[]` 中的 legacy metadata
  3. 本地记录

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
- 内置每日挑战题库（治理/帝国/战争/工业/边疆/贸易/法律/信仰/生态/mythic/survival/generic）
- 按日期轮换题目
- 记录 challenge started / completed 状态；进度以 `challengeId` 为主键读写，避免首页读不到当日状态
- 已按本地日期换日，不再用 UTC 日期切 challenge
- 完成反馈会记录 `profileResonance`
- 题面现同时维护 `question / questionEn`，通过 `getChallengeQuestion()` 按当前 UI 语言返回实际文案
- `challengeWeekKey()` / `getWeeklyChallenges()` 现可生成 Lite 周赛道，用于首页 weekly challenge 展示
- `resolveChallengeProgress()` 会把后端 `campaign daily-status` 与本地缓存合并，优先以后端完成态为真；后端在判定 `completed` 时会先把 SQLite round-trip 的 naive UTC `created_at` 归一为 UTC，再按调用方本地日期换算；只有本地已知细节才显示 `usedCards / betPlaced`

### `gameplayProfileSummary.ts` / `gameplayProfileCatalog.ts`
- 首页题材摘要与玩法题材目录 helper
- `gameplayProfileSummary.ts`
  - 只提供 landing route 需要的轻量信息：
    - `profile label`
    - `signature hooks`
    - `badge asset path`
  - 目的：避免 `InputView` 为了显示首页题材文案而直接把整份玩法策略表带进首屏路径
- `gameplayProfileCatalog.ts`
  - 继续承接完整题材目录
  - 供 `gameplayCards.ts` 等后续玩法链路复用
  - 这样首页轻量摘要和深层玩法 helper 仍保持同一套题材口径

## Hooks (`src/hooks/`)

### `useSimulationWS.ts`
- WebSocket连接管理（自动连接/断开/指数退避重连）
- 初始连接延迟到 effect tick 后建立，并在清理阶段显式取消 pending reconnect timer，减少 mount/unmount 抖动时的首次 WS 噪声
- 事件分发到 Zustand store
- 支持流式agent发言（start → delta → complete）

### `useDebateWS.ts`
- WebSocket 连接到 `/ws/debate/{id}`
- 分发最小 Debate 事件：
  - `status`
  - `agent_speak`
  - `debate_phase_change`
  - `debate_score_update`
  - `debate_counterplay`
  - `debate_verdict`
- 出错时会保留 `error` 状态，而不是把整个 Debate store 清空，便于前端显示可读错误
- `debate_verdict` 当前除了 winner / score / judge summary 这些 verdict 字段，还会把后端 `phase_insights` 一起透传给 `debateStore.setVerdict()`
- 初始连接和重连都已补 cleanup：
  - effect cleanup 会取消延迟首连 timer
  - `code=1000` 的正常关闭不会再误触发重连
  - 目前这条 hook 也有独立单测覆盖 `unmount-before-connect / normal close / abnormal close`

### `useScreenCapture.ts` (Phase 3)
- 截图支持按调用覆盖 selector / captureTarget
- `useScreenCapture` 现在是轻壳 hook；真正的 DOM capture / GIF runtime 已拆到 `screenCaptureRuntime.ts`，只在用户真的点击截图 / GIF 时才加载
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
- GIF 录制（`gif.js` 与 `gif.worker` 都改为按需动态导入，仍保留帧序列 fallback）
- 状态管理: idle → capturing/recording → done
- 自动下载 + 状态指示器；下载前会按扩展名归一化成标准 `image/png` / `image/gif`

## 类型定义 (`src/types.ts`)

核心接口: `Scenario`, `AgentInfo`, `BranchInfo`, `AgentMessage`, `StoryData`, `WSEvent` 等。
- `Scenario` 新增 `visualization_enabled?: boolean` 与 `scene_theme?: string | null`，用于从后端恢复 Theater 开关状态与场景主题
- `ScenarioGameplayState` 现已显式包含：
  - `cards.usage_log`
  - `betting.bets`
  - `archive.key_moments`
  - `archive.branch_snapshots`
- P3-A: `GroupInfo`, `AgentGroupDetail` (分层分组信息)
- P3-B: `PredictionInfo`, `LeaderboardEntry` (竞猜/排行榜)
- Track A: `CampaignScenarioSummary`，对应 `GET /api/campaign/scenario/{id}/summary`
- Track A: `CampaignWeeklySummary`，对应 `GET /api/campaign/profile/{user_id}/weekly-summary`
- Track D: `DebatePhaseInsight` 当前为后端权威的阶段洞察结构，包含：
  - `phase`
  - `stakes`
  - `judge_focus`
  - `commentary`
  - `pressure_side / pressure_margin / turn_count`
  - `confidence_drift.direction / phase_margin / cumulative_margin`
- Track D: `DebateVerdictEventPayload` = `DebateResultSummary + phase_insights`
- Track D: `DebateCounterplayResult` 现还会带 `phase_score / explanation`
- Track D: `DebateResultSummary` 现还会带 `judge_rationale`，其中可选包含 `supporting_turns`

`WSEvent` 为联合类型，覆盖 15 种WebSocket事件（含 `retrospective_start`、`batch_intervention_applied`、`simulation_error`）。
`AgentMessage` 新增 `synthesized?: boolean` 标志 Worker 合成消息 (P3-A)。

## 国际化 (`src/i18n/`)

i18next 配置，支持 `zh-CN` 和 `en` 两种语言。
- UI 文案跟随右下角 `LanguageSwitcher` 切换
- 剧场页里的 `世界线 / 轮次 / 截图模式反馈 / 面板折叠提示` 已接入同一套 i18n
- Track D 新增的 `Debate Arena` 入口、五阶段阶段名、三方标签、维度分数、押注文案、分享文案与结果页标题也已进入同一套 locale
- Debate 页面在拿到后端 payload 后，会按 `debate.language` 自动同步整页 UI 语言：
  - 英文题 / 英文 debate payload → 英文 UI
  - 中文题 / 中文 debate payload → 中文 UI
- agent 发言、结果叙事、评分与 narrator 输出语言主要跟随后端输入语言检测：
  - 英文输入 → 英文输出
  - 中文输入 → 中文输出

## 动画 (`src/animations/`)

GSAP 动画工具函数，用于页面转场和元素入场动画。

## 自动化可观测性

- `render_game_to_text()` 已覆盖 `InputView`、`SimulationView`、`ResultView`、`HistoryView`、`LeaderboardView`、`DebateArenaView`、`DebateResultView`
- `InputView` 的自动化摘要现会带 `campaign`（`user_id / total_runs / badge_count / daily_profile_level / daily_profile_score_to_next_level`），可直接取证首页 director campaign 进展
- `InputView` 现在还会把 daily challenge 的后端真值合并进 `page.challenge_progress`，但不会凭空伪造本地未知的卡牌/下注细节
- `SimulationView` / `ResultView` 在输出中带页面级控件摘要（按钮可用性、激活 modal、可展开/可干预分支等）
- `SimulationView` / `ResultView` / `DebateResultView` 当前还会输出 `replay_source`，用于区分 `api / share id / token`
- `SimulationView` 的预测弹窗会额外输出表单级状态摘要（文本长度、自信度、提交可用性、错误状态）
- `SimulationView` 的玩法卡弹窗会额外输出玩法画像、推荐卡、目标分支/角色、导演点数与冷却摘要
- 玩法卡弹窗的输出现还包含 `signature_arc`：链路标题、已完成步数、下一步推荐，以及 `risk_value / resource_value`
- 玩法卡弹窗当前还会输出：
  - `tactical_mode`
  - `tactical_note`
- `SimulationView` 还会输出：
  - `page.controls.capture_mode`
  - `page.controls.can_capture_modal`
  - `page.controls.capture_result_kind`
  - `page.warmup`
- `SimulationView` 现还会输出 `page.director`：
  - `completed_objectives / objective_count`
  - `objectives[]`
  - `system_tracks`
  - `commitment`
- `ResultView` 的分享弹窗会额外输出平台选择、生成中状态、复制状态和文案长度摘要
- `ResultView` 的分享弹窗会带 `share_context`
- `SimulationView` 当前还会输出 `page.controls.can_copy_replay_link`
- `ResultView` 在故事落稳后会调用 `finalizeCampaign()`；自动化摘要会输出 `campaign_summary`（`campaign_score_delta / level / score_to_next_level / badge_count / newly_unlocked_badges`）
- `ResultView` 的 `archive_summary` 现还会输出：
  - `profile_id`
  - `profile_resonance`
  - `completed_daily_challenge`
  - `objective_completed_count / objective_total_count`
  - `commitment_outcome`
- `DebateResultView` 的自动化摘要当前还会输出 `result.adjudication_mode`
  - `risk_value / resource_value`
- 完成态 `SimulationView` 会输出 `page.replay_state`（选中世界线/轮次、batch 数、显示中的 bubble 数）
- `DebateArenaView` 现会输出：
  - `page.kind = "debate"`
  - `page.phase`
  - `page.selected_phase / is_phase_locked / unlocked_phases`
  - `page.controls.can_open_prediction`
  - `page.controls.can_open_counterplay`
  - `page.controls.counterplay_used`
  - `page.controls.can_view_result`
  - `page.controls.active_modal / show_bet_modal / modal_state`
  - `page.debate.motion / visible_quotes / proposition.score / opposition.score / judge.summary_ready / bet_window_open / counterplay / counterplay_used`
  - `page.debate.server_phase_insights / room_map / stage_summaries / overview_cards`
- `DebateResultView` 现会输出：
  - `page.kind = "debate_result"`
  - `page.controls.active_modal / show_share_modal / modal_state`
  - `page.result.winner / verdict_tone / score / prediction_count / judge_rationale / supporting_turns / counterplay_summary / counterplay_outcome`
  - `page.result.phase_summaries / server_phase_insights / signal_cards / prediction_stats`
- `inferSceneTheme(question)` 已与后端 `scene_selector` 对齐：优先取原始题面中的强语义词；当前 Theater 场景池为 30 个语义主题，再加 3 个 Debate 专属背景，共 33 个 registry 条目；`law_court_variant / faith_temple_variant / switchboard_forum_variant` 已接好 `switchboard_forum / switchboard_forum_variant -> generic` fallback
- Track D 资产生成链路：
  - `npm run generate:ui-assets -- --preset ...`
  - 新生成的 Debate PNG 现会在同目录补同名 `.meta.json`
  - 当前 Debate D4 已生成 3 张 `debate_arena_*` 背景和 7 张 `debate_*` UI 资产
- Legacy provenance 回填链路：
  - `npm run assets:provenance:backfill`
  - `npm run assets:provenance:check`
  - 当前 `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下 62 张 PNG 都已有 sidecar；其中 `10` 份保留完整生成字段，`4` 份为 `backfilled_partial`，`48` 份为 `backfilled_legacy`
  - backfilled 口径表示 sidecar 补齐；允许 `unknown / null` 字段存在，不代表恢复了原始生成时间、模型或 prompt
- 固定回归样本集已落盘到：
  - `frontend/output/e2e/sample_matrix.json`
  - `frontend/output/e2e/sample_matrix_variants.json`
  - 当前固定样本为 15 条；另有 3 条场景变体样本（`law_court_variant / faith_temple_variant / switchboard_forum_variant`），最新主工件位于 `frontend/output/e2e/20260317-track-c/variants/`
- 一键回归入口：
  - `npm run e2e:matrix`
  - `npm run e2e:variants`
  - `npm run e2e:corners`
  - `npm run e2e:cross-browser`
  - `npm run e2e:safari`
  - `npm run e2e:full`
  - `npm run e2e:debate:desktop`
  - `npm run e2e:debate:mobile`
  - `npm run e2e:debate:full`
  - `npm run e2e:debate`
  - `scripts/e2e-suite.mjs` 现在会在输出目录附带 `browser-launch.json`，记录 `requestedHeadless / actualHeadless / channel / usedSwiftShader / attempts`
  - `scripts/e2e-debate-suite.mjs` 会单独跑 `live -> bet -> result -> share` Debate 基线，并分别输出 `desktop/` 与 `mobile/` 工件；现在还支持 `--width / --height / --question / --profile-hint` 覆盖
  - `capture-modes` case 现在会额外落盘 `predictionModalBytes / gameplayModalBytes`
  - 历史 `scenario_id` 缺失时，`e2e-suite.mjs` 会按 theme 使用内置 fallback 题面 runtime 新建样本，而不是直接依赖旧数据库快照
  - 如果历史样本的 `scene_theme` 已经与当前 `select_scene(question)` 漂移，matrix 也会自动 runtime fallback 重建样本
  - `scripts/e2e-suite.mjs` 的截图现在会先走带 `timeout` 的 Playwright `page.screenshot()`；任意截图失败都会回退到 Chromium CDP 截图，避免整套回归直接中断
  - `history-delete-last-page` case 现在会在最终截图前等待删除弹窗真正脱离 DOM，减少删除后重排阶段的挂起风险
  - `replay` corner case 现在会等到 `playback_mode = replay` 且 `theater_ready = true` 才判定恢复完成
  - 当前 Track C 的主工件目录为：
    - `frontend/output/e2e/20260317-track-c/matrix/`
    - `frontend/output/e2e/20260317-track-c/corners/`
    - `frontend/output/e2e/20260317-track-c/mobile/`
    - `frontend/output/e2e/20260317-track-c/variants/`
  - 本轮 full smoke 工件目录为：
    - `frontend/output/e2e/20260318-post-director-goals-full/`
  - 本次 `gameplay_state_roundtrip` corners 工件目录为：
    - `frontend/output/e2e/20260319-cross-device-state-corners/`
  - Firefox / WebKit 官方 cross-browser 工件目录为：
    - `frontend/output/e2e/20260319-cross-device-state-cross-browser/`
  - Safari 官方工件目录为：
    - `frontend/output/e2e/20260319-cross-device-state-safari/`
  - Safari `panel capture` 补充工件目录为：
    - `frontend/output/e2e/20260319-cross-device-state-safari-panel/`
  - 结果页 backend summary smoke 工件为：
    - `frontend/output/e2e/20260318-result-backend-summary-smoke-v2/result-final.json`
  - 当前 Track D Debate 主工件目录为：
    - `frontend/output/e2e/20260318-post-director-goals-debate-full/`
  - 本轮额外复验通过的主模式 full 工件：
    - `frontend/output/e2e/20260318-codex-audit-main-full/result.json`
  - 本轮额外复验通过的 Debate full 工件：
    - `frontend/output/e2e/20260318-codex-audit-debate-full-rerun/result.json`
  - 本轮额外复验通过的 Debate `430x932` 工件：
    - `frontend/output/e2e/20260318-codex-audit-debate-mobile-430x932/result.json`
  - 本轮新增 Debate 工件目录为：
    - `frontend/output/e2e/20260318-debate-mobile-430x932-v2/`
    - `frontend/output/e2e/20260318-debate-civic-v2/`
  - `generic` 变体 smoke 取证仍保留在 `frontend/output/e2e/generic-variant-smoke-switchboard-20260317/`（`scenario.json` + `theater.png`）
  - `develop-web-game` 相关 Playwright 工件已存在：运行时脚本位于 `frontend/.tmp-playwright/web_game_playwright_client.mjs`，输出工件位于 `frontend/output/web-game*/` 下的 `shot-*.png` / `state-*.json`
  - `e2e-suite.mjs` / `e2e-automation.mjs` 现在会把 `frontend/output/...` 这类参数归一化到真正的前端根目录，避免后续再写出 `frontend/frontend/output/...` 嵌套路径

## 像素化可视化游戏引擎 (`src/game/`) — Phase 1+2+3+4

### 架构

```
WebSocket (viz:* events) → EventBridge → CustomEvent → Phaser WorldScene
```

### 组件

| 文件 | 描述 |
|------|------|
| `PhaserGame.tsx` | Phaser 游戏 React 包装组件，管理 Phaser.Game 生命周期 + 增量气泡分发（store 订阅实时消息）+ fallback synth init（竞态条件防御）；对自动化暴露 `advanceTime(ms)`，并通过 replay sync 在已完成回放与 live Theater 启动期跳过 `TitleScene`；`worldSceneBootstrap.ts` 现额外负责 completed replay / mobile Theater 的 `WorldScene` bootstrap guard，避免 `scene=null` 或 Agent 尚未 hydrate 时误判完成；Phaser `preBoot` 会注入初始 `scene_theme` |
| `PhaserGameLoader.tsx` | 懒加载器，显示加载状态，动态导入 Phaser；透传 `playbackMode/replaySpeed/playbackBranchId/playbackRound` 到 `PhaserGame` |
| `EventBridge.ts` | WebSocket 事件 → Phaser CustomEvent 桥接层，解耦 React 与 Phaser |
| `EventBridge.test.ts` | EventBridge 单元测试（13 tests）— 生命周期/订阅/错误隔离/边界情况 |
| `scenes/BootScene.ts` | Phaser 启动场景，加载角色、30 个场景背景、特效、UI 和结局资源，路由到 TitleScene |
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
| `scene_change` | 切换像素世界主题（30 个 Theater 语义场景） |
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
| Structured Betting 2.x | `PredictionModal` 支持押世界线 / 押结局倾向 / 押题材回响，Theater HUD 可直接打开下注；分支尚未 hydrate 时会自动回退到 `ending_tone`，避免空目标下注；下注提交成功后会立刻把新 meta 回传父层，并由 `SimulationView` 直接回写后端 `gameplay_state` |
| Gameplay Cards | `GameplayCardsModal` 现提供 14 张玩法卡，支持题目画像驱动推荐、导演点数与冷却；新增 4 张反制卡后，law/trade、ecology/survival/frontier、faith/mythic 与 generic 都有更完整的推进/反制配对；generic 卡框已改用独立 `gameplay_card_frame_generic`，不再复用 `gameplay_panel`；注入 prompt 会显式要求 agent 把玩法卡当成高优先级、持续生效的世界线事件；本轮又补了 profile-specific 战术层与打法说明 |
| Director Layer | Theater 当前有最小导演玩法层：2 个 run-scoped 短目标、常驻 `风险 / 资源` 轨道、worldline 承诺，以及结果页中的目标完成度 / 承诺命中或落空结算；这批状态当前已下沉到后端 `director_state`，主模式 `cards.usageLog` 也已下沉到后端 `gameplay_state`，前端 `scenarioMeta` 退为缓存/兼容层 |
| Semantic Scene Pool | Theater 背景已扩到 30 个主题，包含主场景和轻量语义变体；本轮新增 `law_court_variant / faith_temple_variant / switchboard_forum_variant`，generic 现会按题面落到 `switchboard_forum` 或其变体，同一 profile 也可按语义命中不同场景，例如 `governance -> scifi_base/civic_chamber/surveillance_megacity` |
| Causal Archive | `ResultView` 展示玩法记录、下注记录、关键记录、世界线快照、导演点数、每日挑战标记；新增 `profileResonance`，并把题材档案前缀接进导出/分享结果 |
| Daily Challenge | `InputView` 每日挑战卡 + `dailyChallenge.ts` 题库/完成状态；挑战池现为 12 条，已补齐 mythic / survival / generic，并会显示题材 hooks 与完成后的题材回响 |
| Landing Route Summary Split | 首页题材 `label / hooks / badge` 当前改走 `gameplayProfileSummary.ts`，不再直接把整份玩法策略表挂进 landing route；深层玩法 contract / strategy 仍保留在后续路由和导演层链路中 |
| Branch/Round Replay | 完成态 Theater 支持按世界线/轮次筛选回放，并保留重播/跳到最新/倍速控制；compact TimelineBar 会直接出现在 Theater 面板内并显示 `fork/card/bet/result` marker |

### Phase 4 开源准备 + 性能优化

| 系统 | 描述 |
|------|------|
| Weather 对象池 | acquireWeatherDot/releaseWeatherDot — 120 个 Graphics 对象回收复用，减少 GC 压力 |
| 视口裁剪 | cullAgent — VIEWPORT_MARGIN 40px 外 Agent 隐藏，减少 GPU 绘制调用 |
| Pool 清理 | shutdown() 中销毁 weatherPool/bubblePool，防止内存泄漏 |
| Automation Hooks | `render_game_to_text()` + `advanceTime(ms)` + `preserveDrawingBuffer=true`，提升浏览器黑盒测试的状态读取与截图稳定性；已覆盖页面级控件摘要、warmup 摘要、capture mode、modal 内部状态摘要与分享上下文摘要 |
| WorldScene.test.ts | 20 断言 — 30 主题 + 15 事件 + 4 阵营 + 10 气泡 + 4 时段 + 双语 + 性能常量 |
| EndingScene.test.ts | 14 断言 — 6 结局配置 + 3 类型映射 + resolveEndingId 逻辑 |

### 3.0 Phase B 美术风格全面升级

| 系统 | 描述 |
|------|------|
| GBC 调色板统一 | 16 个 CSS custom properties (`--gbc-*`)，替代硬编码色值 |
| 资产重生成 | 场景背景已扩到 30 张，统一沿用当前 GBC 像素风与 Theater 视觉语言；本轮补入 `law_court_variant / faith_temple_variant / switchboard_forum_variant`，generic 卡框也已独立生成为 `gameplay_card_frame_generic` |
| TitleScene B3 增强 | 打字机字幕 + 点击跳过 + 微光扫描线 |
| WorldScene B4 增强 | 鼠标视差滚动 + 打字机气泡 + 垂直擦除过渡 |

### 3.0 Phase C UI/UX 布局 + Theater Mode 完善

| 系统 | 描述 |
|------|------|
| SimulationView 布局 | Theater 模式当前改为“场景优先”：左侧舞台自适应、右栏收成固定窄宽；完成态 replay-ready 现保持固定视口首屏，不再把主剧场推到页面中段；`game-wrapper` 会优先出现在 replay filters/timeline 前，compact TimelineBar 也进一步压缩并隐藏二级 stats；小屏头部动作区会自动换行，视图切换胶囊会收成图标按钮 |
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
- **测试**: `npm test` → Vitest + Testing Library — 仓库内历史全量基线仍记录为 **179 passed**；本轮重新复验：
- `src/lib/scenarioMeta.test.ts / src/lib/archiveSummary.test.ts / src/components/gameplayCards.test.ts / src/components/gameplayContract.test.ts / src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx / src/components/GameplayCardsModal.test.tsx / src/pages/DebateArenaView.test.tsx / src/pages/DebateResultView.test.tsx / src/components/DebateBetModal.test.tsx / src/components/DebateShareModal.test.tsx / src/hooks/useDebateWS.test.tsx / src/i18n/locales.test.ts` → **60 passed**
- 本次 director-state 后端化又补跑：
  - `src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx / src/lib/scenarioMeta.test.ts` → **21 passed**
- 本次 `gameplay_state` authority + 玩法/素材分化又补跑：
  - `src/lib/scenarioGameplayState.test.ts / src/components/gameplayCards.test.ts / src/game/managers/VizSynthesizer.test.ts / src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx` → **66 passed**
- 本次 cross-device state 收口又补跑：
  - `src/lib/scenarioGameplayState.test.ts / src/components/PredictionModal.test.tsx / src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx` → **26 passed**
- **类型检查**: `npx tsc --noEmit -p tsconfig.app.json` → 通过
- 本次 Theater 可读性修复又补跑：
  - `src/pages/SimulationView.test.tsx / src/components/TimelineBar.test.tsx` → **12 passed**
- 本次 session 又补跑：
  - `src/lib/llmProviderPolicy.test.ts / src/components/ShareModal.test.tsx / src/pages/InputView.test.tsx / src/pages/ResultView.test.tsx` → **11 passed**
- `src/pages/DebateArenaView.test.tsx / src/pages/DebateResultView.test.tsx / src/lib/debateShare.test.ts / src/lib/debateCounterplay.test.ts` → **8 passed**
- 当前 session 围绕 Debate `judge_rationale / supporting_turns / share copy` 又补跑：
  - `src/lib/debateShare.test.ts / src/components/DebateShareModal.test.tsx / src/pages/DebateResultView.test.tsx` → **5 passed**
  - `src/pages/DebateArenaView.test.tsx / src/pages/DebateResultView.test.tsx / src/lib/debateShare.test.ts / src/lib/debateCounterplay.test.ts / src/components/DebateBetModal.test.tsx / src/components/DebateShareModal.test.tsx / src/hooks/useDebateWS.test.tsx` → **16 passed**
  - `src/lib/challengeShare.test.ts / src/pages/InputView.test.tsx / src/pages/ResultView.test.tsx` → **11 passed**
- 本次 replay share/import session 又补跑：
  - `src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx / src/pages/DebateResultView.test.tsx` → **24 passed**
  - `src/lib/scenarioReplay.test.ts / src/lib/simulationReplay.test.ts / src/lib/debateReplay.test.ts / src/components/ShareModal.test.tsx / src/components/DebateShareModal.test.tsx` → **8 passed**
- 本次 bundle / compat 收口又补跑：
  - `src/hooks/useScreenCapture.test.ts / src/components/PredictionModal.test.tsx / src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx / src/pages/DebateArenaView.test.tsx / src/pages/DebateResultView.test.tsx` → **32 passed**
- **构建**: `npm run build` → `tsc -b && vite build` → `dist/`；本轮已重新验证通过
- **Docker**: Nginx 静态文件服务，代理 `/api` 和 `/ws` 到后端 `18927`；本轮已完成一次 `docker compose up --build -d` 运行时 smoke，前端代理创建 Theater 场景可跑到 `done`
- **跨浏览器 smoke**:
  - `corners`：本次 `gameplay_state_roundtrip` 已扩到 bet list / key moments / branch snapshots，工件位于 `frontend/output/e2e/20260319-cross-device-state-corners/`
  - Firefox / WebKit：主模式官方 cross-browser smoke 已实跑通过，工件位于 `frontend/output/e2e/20260319-cross-device-state-cross-browser/`
  - Safari：主模式官方 Safari smoke 已实跑通过，工件位于 `frontend/output/e2e/20260319-cross-device-state-safari/`
  - Safari 若默认 session screenshot 拍到空白，当前可再跑 `panel capture` 补充取证；本次补充工件位于 `frontend/output/e2e/20260319-cross-device-state-safari-panel/`
- **本次 bundle / compat 工件**:
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-corners/`
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-cross-browser/`
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-debate-full/`
  - `frontend/output/e2e/2026-03-19T15-20-32-479Z-release-signoff/`
  - `frontend/output/e2e/2026-03-19T15-25-24-398Z-release-signoff/`
  - `frontend/output/e2e/2026-03-19T15-35-24-820Z-release-signoff/`
- 本次 session 又补了首页首包收口：
  - `src/pages/InputView.test.tsx / src/pages/SimulationView.test.tsx / src/pages/ResultView.test.tsx` → **24 passed**
  - `npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `npm run build` → 通过
  - `npm run release:signoff -- --headless` → 通过
  - 当前新增口径：
    - `InputView` 不再 chain-import 深层玩法策略表
    - 首页题材文案、hooks、badge 现在来自 `gameplayProfileSummary.ts`
    - 深层玩法 contract / strategy helper 仍在后续异步 chunk 中
