# Frontend 模块地图

> 文档类型：L0 current-truth
> 作用：描述前端页面、状态边界、性能收口与自动化入口。历史修复细节不再写入本页。

## 技术栈

- React 19
- TypeScript 5.9
- Vite 7
- `@vitejs/plugin-legacy` + `terser`
- Zustand
- i18next
- Phaser
- Playwright-based E2E

当前默认构建/测试路径会把 `phaser` alias 到本地精简入口 `frontend/experiments/phaser-custom/entry.mjs`，用于降低默认包体。
- production build 当前会额外产出 legacy bundle，目标口径是 Chrome / Edge 79+、Firefox 78+、Safari / iOS 12+。
- 本地 Phaser 入口当前不再依赖 top-level `await`，不会把 legacy 构建链卡死。
- `vite preview` 当前和 `vite dev` 一样会代理 `/api` 和 `/ws`；如果要让 preview 指到指定 backend，启动前设置 `SWARM_BACKEND_URL` 即可。
- 本地如果用非默认 backend 端口做 preview/browser 复核，`vite preview` 启动时要显式带 `SWARM_BACKEND_URL`；否则 `/api` 和 `/ws` 仍会走默认端口。
- `Vite manualChunks` 当前显式拆为 `vendor / i18n-vendor / animation-vendor / g6-vendor / radix-vendor / dnd-vendor / icon-vendor / pretext / capture-html / capture-gif`；React 继续留在共享 `vendor`，React Flow 栈继续交给 Rollup 自动分块，不再强行命名 `flow-vendor`，既避开 production preview 启动白屏，也不把 `g6-vendor / capture-html` 拉进首页 preload。`perf:budgets:check` 当前也已经把 React Flow 自动拆出来的 `style / graphTraversal / graphTokens / utils` 这批 chunk 纳入门禁，不再只盯手工命名 chunk。

## 页面地图

| 页面 | 位置 | 责任 |
|------|------|------|
| InputView | `frontend/src/pages/InputView.tsx` | scenario 创建、5 步进度提示、quick starts、daily challenge、weekly track、difficulty、streak/refresh countdown、成长卡与 CampaignProgressSheet、教育模板选择器、主模式档位、搜索增强 toggle、source family 选择、搜索深度选择、推荐已配置搜索 / 高级自定义 provider 切换、独立 BYOK 折叠区、advanced accordion、custom Agent quick selector + attach panel、identity continuity preflight / confirm dialog、preflight-aware submit loading、snapshot import、首次引导和底部安全提示；quick start 题目/副标题走 `quickstart.*` i18n key，代码只保留结构元数据 |
| SetupWizardView | `frontend/src/pages/SetupWizardView.tsx` | `/admin/setup` 3 步 provider 配置向导；选择 preset、填 API key/base URL、测试连接并写入 session-scoped provider policy |
| AgentLibrary | `frontend/src/pages/AgentLibrary.tsx` | 自建 Agent 列表、收藏筛选、tier badge、profile modal、`#agent_profile=<id>&tab=memory` 档案深链、编辑/删除入口、返回首页按钮、卡片级 Agent 备份导出与从备份创建 Agent 入口 |
| AgentWorkshopView | `frontend/src/pages/AgentWorkshopView.tsx` | 自建 Agent 创建/编辑，包含 knowledge domains、`IMPORTANT / CROWD` tier 选择、PDF document upload tab，以及 capability-gated Agent 备份工具 |
| IdentityInspectorView | `frontend/src/pages/IdentityInspectorView.tsx` | `/agents/identities/:id/memories` 只读 memory inspector |
| PersonalJournalView | `frontend/src/pages/PersonalJournalView.tsx` | `/me/journal` 个人预测日志、resolve 状态与 calibration 可视化 |
| SimulationView | `frontend/src/pages/SimulationView.tsx` | live 推演、Classic 分支树、Theater、干预 lifecycle、玩法卡、押注、只读干预回执、capture |
| ResultView | `frontend/src/pages/ResultView.tsx` | 结局对比、Result Quality verdict panel（verdict 缺失时显示 unavailable fallback）、分支级 question answer（显示在概率条上方）、因果档案 / archive（档案结论优先 story verdict）、默认折叠的导演笔记/导演复盘、campaign summary、weekly leaderboard preview、achievement toast、分享、PNG share artifact、预测卡片、Markdown/snapshot 导出、replay/import、真实世界来源卡片、native citation 区块、historical source badge、counterfactual / resume / faction 入口、续跑分支来源链接和独立概率说明、结果页 Agent 追问、generated/replay Agent 页内档案 sheet、header 图谱直达入口，以及 capability-gated `What's Next` bridge；主体区块已拆到 `frontend/src/pages/result/*` |
| WorkbenchView | `frontend/src/pages/WorkbenchView.tsx` | 独立图谱工作台；支持 `graph / split / kg` 三种 view，保留 URL 里的 analysis branch query，但 workbench 图面按 scenario 拉全量 causal graph，不再按 URL branch 过滤；页面提供返回结果页链接 |
| ReplayView | `frontend/src/pages/ReplayView.tsx` | replay trace 分页、branch filter、timeline scrubber、capability disabled / probe error surface |
| TimelineGalaxy | `frontend/src/pages/TimelineGalaxy.tsx` | `/timeline-galaxy/:id` 的 G6 时间线视图；复用 `kg_explorer` capability，capability probe 失败时先显示可重试错误，不会继续拉图谱数据 |
| CompareDigestView | `frontend/src/pages/CompareDigestView.tsx` | 反事实对比页；单活跃 Theater、shared round selector、digest compare、pane screenshot capture |
| DebateArenaView | `frontend/src/pages/DebateArenaView.tsx` | debate live、Podium Cards、room state、phase 历史卡、counterplay、live argument map |
| DebateResultView | `frontend/src/pages/DebateResultView.tsx` | debate result、share、replay/import、裁判状态文案、按需加载 argument map |
| WorldlineRoundtableView | `frontend/src/pages/WorldlineRoundtableView.tsx` | 世界线圆桌 live/replay、participant follow-up、analyst ReACT 面板、人格漂移 warning |
| HistoryView | `frontend/src/pages/HistoryView.tsx` | scenario 历史列表 |
| LeaderboardView | `frontend/src/pages/LeaderboardView.tsx` | prediction leaderboard 与 segment filters；筛选状态同步到 URL params，顶部返回按钮回到首页 |

## 状态与 authority 边界

### 当前 authority

- 主模式 authority 来自后端：
  - `director_state`
  - `gameplay_state`
- `gameplay_state` 当前按分区看 authority：
  - 只要后端显式返回该分区字段，即使值是空数组，也视为后端已接管该分区
  - 前端不会再把本地 `scenarioMeta` 里的 stale `bets / key_moments / branch_snapshots / usage_log` 反向补回去
- `director_state / gameplay_state` 写回当前由 `useSimulationViewState` 串行化；如果后端返回 revision conflict，前端会先回读最新 authority，再把本次本地增量合进去重试：
  - director 侧保留远端 objectives，除非本地这次真的改了 objectives；commitment 只合并本次用户操作
  - gameplay 侧按 key 合并 `usage_log / bets / key_moments / branch_snapshots`
  - 重试仍失败时，页面提示冲突并停止用旧本地缓存继续覆盖 authority
- 前端 authority 合流主要通过：
  - `frontend/src/lib/scenarioAuthority.ts`
  - `frontend/src/lib/scenarioDirectorState.ts`
  - `frontend/src/lib/scenarioGameplayState.ts`
- 主模式里 `scenario / branches / messages / status` 是 durable truth；`thinkingAgents` 只是瞬时 UI 态，resync 时会清空，不承担 replay authority。
- Campaign launch context 只表达本轮入口意图；daily/weekly catalog、服务端日期、ISO week、streak、weekly bonus 和 badge unlock 都以后端 summary/finalize 为准。前端只展示后端返回的 campaign summary、weekly summary、静态 badge definitions、user badges 和 mastery；首页进度 sheet 允许部分请求失败时继续展示已取到的区块。未知 `profile_id` 会回退到 `General Topics / 综合话题`，不把 raw id 直接露给用户。

### 兼容与缓存层

- `scenarioMeta` 仍存在，但不是跨设备真值。
- 它现在主要承担：
  - 本地缓存
  - 兼容旧数据
  - replay 输入与 hydrate

### Replay

- 主模式 replay helper：
  - `scenarioReplay.ts`
  - `simulationReplay.ts`
- Debate replay helper：
  - `debateReplay.ts`
- Oracle replay helper：
  - `oracleReplay.ts`
- 编解码共享：
  - `replayCodec.ts`
- 新生成的 replay token 当前统一走 `plain.*`，上限 `4096` 字符；payload 过大时继续回退 artifact / local readonly。旧的 `gz.*` token 仍可解码。
- Simulation replay 的 branch / round selection 只在 simulation complete 后保留；live 或 incomplete 状态会清掉旧 selection，完成态下缺失或失效 selection 会回到默认 branch 和最新 round。
- 主模式完成态的非 replay 冷加载默认回到 Classic；同一 scenario 的 live resync 不会强行打断用户当前 Theater。结果页点“返回推演”会显式要求 completed scenario 回 Classic；replay hydrate 会保留 visualization-enabled 场景的 Theater。
- ResultView replay payload 可以携带 `campaignScenarioSummary / campaignSummary`；`campaignSummary` 可带后端 `score_breakdown`，replay 页会用快照渲染导演复盘，但不会重新 finalize campaign。
- 新生成的主模式、ending-room 和 roundtable replay payload 会先清理 scenario replay Agent 字段：`agent_identity_id` 和 persona 不进入 inline token、artifact payload 或 local readonly copy；旧 token decode 后也会走同一组展示字段白名单。

## 实时链路

- scenario live：`useSimulationWS`
- debate live：`useDebateWS`
- ending room / roundtable：各自独立 WS hook + store

当前约束：

- 前端会按 `sequence / event_id` 做重复丢弃与时序修正。
- store 负责保持 phase/branch 状态单调，不让旧事件覆盖新状态。
- `simulationStore` 把 `cancelled` 当终态处理；取消后晚到的 `status / state` 事件不会再把页面回退到 `simulating` 或重新触发 WS 重连。
- `simulationStore` 的消息去重集（`seenMessageKeys`）按 scenario ID 隔离，切换场景时自动重置，避免跨场景 hash 碰撞。
- `simulationStore` 当前会记录干预 lifecycle：`intervention_applied / retrospective_start` 写成 `queued`，`intervention_injected` 写成 `injected`，simulation 完成后再把已完成 receipt 对应项推进到 `receipt_ready`；切换 scenario 时会清空这份 Map。
- `simulationStore` 当前会接收 `kg:delta` 与 `kg:snapshot_invalidated`，但不在 store 内维护图谱增量状态；图谱视图仍以各自的 REST snapshot / resync 路径为准。
- `useSimulationWS` 在 `scenarioId` 为空或 `ready` 为 false 时不会发起连接；重连使用 `connectRef` 模式防止闭包过期；初始连接也会调用 `requestScenarioResync` 补拉状态（与 `useEndingRoomWS` 行为对齐）。
- 三个 WS hooks 均支持首帧 auth：如果 `localStorage` 有 token，`onopen` 时发送 `{"type":"auth","token":"..."}`，收到 `auth_ok` 后才触发 resync；无 token 时直接 resync（兼容 auth 未开启场景）。
- 三个 WS hooks 对 `4001`（认证失败）和 `4404`（资源不存在）不进行自动重连；`1006`（异常断连）照常重连。
- `useAgentConversationWS` 当前也已对齐同一套 WS 契约：
  - 前端实际连接路径是 `/ws/agent-conversation/{thread_id}`
  - 不再误连旧的 `/api/ws/agent-conversation/{thread_id}`
  - 首帧 auth、`auth_ok`、`4001 / 4404` 非重连口径与另外三条 WS 保持一致
- `useEndingRoomWS` 与 `useAgentConversationWS` 当前都按同源 `window.location.host` 组装 WS host，不再写死本地 dev backend 端口；ending-room live room 当前实际连接 `/ws/ending-room/{room_id}`，不再从前端走旧的 `/api/ws/...` 路径；`19030 -> 19027` 这类 preview/backend 组合下，ending-room / roundtable live 更新也能正常跟上。
- REST API 路径参数统一使用 `encodeURIComponent()` 编码（约 30 处），防止含特殊字符的 ID 破坏 URL 结构。
- API client 当前仍会读取 session-scoped `Organization ID` 并映射成 `X-Org-Id`；InputView 当前没有专门的 Organization ID 输入框。
- API 客户端对服务端错误文本做脱敏处理（`sanitizeErrorText`），超过 200 字符或包含 stack trace / HTML 的响应会被替换为通用错误信息。
- `ResultView` 当前的 `What's Next / 下一步` bridge：
  - capability ready 后在 Reader / Explore 都渲染，不再只藏在探索面板下面
  - `causal / replay / compare / workbench / agents / share` 共用同一套 bridge 样式
  - header 也会在 capability 允许时直接显示 `查看因果图谱` 和 `/workbench/:id` 图谱工作台入口
  - workbench 卡片当前指向因果、知识图谱和节点追问同一视图，并保留当前 analysis branch query
  - `agents` 卡片当前是按钮，不再跳 `/agents`；它会打开 `ScenarioAgentPicker`，再用 `NodeConversationSheet` 发起场内 Agent 追问
  - Agent picker 只在 `agent_conversation` enabled、当前 scenario 有 agents 且非 replay 模式时可用；custom Agent 的 `查看档案` 走 Agent Library hash 深链，generated / replay Agent 的 `查看档案` 打开页内 `AgentProfileSheet`
  - disabled 卡片保留 link 语义，但不再渲染无 `href` 的 `<a>`
  - disabled 状态会保留可见原因和 `aria-describedby`，文字对比不再靠整卡 opacity 压低
- `ResultView` 当前在 `result_verdict` capability enabled 时显示 `ResultVerdictPanel`：
  - panel 用 React 文本节点渲染 verdict，不走 raw HTML
  - `verdict_confidence` 只接受 `high / medium / low`，未知值显示成 `medium`
  - story verdict 非空时显示 verdict 和 confidence；空 verdict、旧 scenario 或生成失败时显示中性的“暂无预测结论”，并尽量保留原问题
  - `ResultHeader` 只有在 capability enabled 且 story verdict 非空时，才把 subtitle 切到预测结论口径
  - 结局卡的 `question_answer` 非空时会作为 focal answer 放在概率条上方；空白值不渲染 focal block
  - 因果档案的“档案结论”优先显示 story verdict，同时保留 branch insight 作为次级信号；没有 verdict 时仍回退到 insight / fork reason / key moment
  - confidence badge 与 region heading 已有屏幕阅读器文本和 `aria-live`
- `ShareModal` 当前接入 `ShareArtifact`：
  - PNG 导出只读取问题、主导结局、可见来源 family 和前 3 个 Agent 名
  - BYOK key、base URL、用户邮箱、session token 和本地 provider 配置不进入导出卡片
  - 导出失败会回到 modal 可见错误态，不只打 `console.error`
  - 预测卡片导出复用 `ShareablePredictionCard` 和 `screenCaptureHtmlVendor`，支持 PNG 下载；图片剪贴板按钮只有浏览器支持 `ClipboardItem + navigator.clipboard.write()` 时才显示
  - modal 当前有共享 `useFocusTrap`、Escape 关闭、关闭/unmount abort；社交文案请求不会因为 automation state 触发父组件重渲染就被误 abort
  - 社交文案请求使用 session-bound `user_id`；导演本地身份只用于展示名，不作为 API owner
  - `shareEnvelope.ts` 当前只保留 `ShareFlavorContext` 类型；前端不再本地拼接“题材档案”前缀到社交文案或 Markdown 导出
- snapshot import/export 当前受 `snapshot_export` capability 控制：
  - 首页只在 capability enabled 时显示 `Import snapshot`
  - 结果页只在非 replay 且 capability enabled 时显示 `Export snapshot`
  - `SnapshotImportDialog` 前端先挡非 ZIP 和大于 50 MB 的文件，再调用后端 import
  - `SnapshotExportWizard / SnapshotImportDialog / ShareModal / ResultView` 共享 `useFocusTrap`
- `ResultView` 的因果档案当前把 what-if、结局判定、系统读数、玩家动作、下一步建议和证据账本放在同一块里；关键记录只露出前几条，剩余记录用 details 展开，避免把结果页撑成长列表。
- `ResultView` 的导演复盘当前由 `DirectorDebriefPanel` 渲染：默认收起，trigger 使用 `aria-expanded / aria-controls / aria-describedby`，body 收起时带 `aria-hidden` 和 `inert`。展开后优先使用后端 `score_breakdown`，同时接收 what-if、主导世界线、世界线承诺、押注、最后一次干预、结构化关键记录、director goals 与 gameplay card 状态，展示得分原因、等级进度、本局读数、下一步入口和新增徽章。关键记录先显示前 3 条，更多记录放到原生 `details / summary` 里；campaign 边界提示、新徽章文案、archive key moment 和 moment detail 都走 `result.*` locale key。
- `ResultView` 的 faction timeline lead 当前已走 i18n key + `{{title}}` 插值，不再在组件里手写 `isZh` 三元文案。
- `ResultView` 的 replay/import 错误、ending-room replay action、archive summary label 和 ending-room picker copy 当前也已走 locale key；剩下的 `isZh` 用在玩法/候选人/弹窗语言选择这类领域语义上。
- `ResultView` 当前已做第一阶段拆分：入口仍是 `frontend/src/pages/ResultView.tsx`，主体区块拆到 `frontend/src/pages/result/ResultHeader.tsx`、`EndingCardsGrid.tsx`、`ResultVerdictPanel.tsx`、`ExploreDeeperBridge.tsx`、`WebSourcesSection.tsx`、`PredictionsSection.tsx`、`DirectorNotebook.tsx`、`AgentRoster.tsx`、`ResultModals.tsx` 和 `ResultContext.tsx`。`ResultContext` 仍偏宽，后续触碰结果页时优先评估 selector / useMemo 收窄。
- InputView 当前在 `agent_identity` capability 开启时会在主模式启动前先调用 identity continuity preflight：
  - 只要命中 `L2 fuzzy candidate` 才会弹确认框
  - 用户可选 `复用已有身份` 或 `创建新身份`
  - preflight 失败时会显示错误，但继续按无 continuity override 启动，不会把失败伪装成“无匹配”确认结果
  - 如果 preflight 打开确认框，submit loading 会先退出，避免按钮一直保持提交态
  - BYOK 自动 preflight 或 continuity launch 仍在路上时，会用同步 ref guard 防重复弹 launch confirmation 或重复启动
- InputView 当前还有两层启动确认：
  - 首次访问会显示 capability-aware onboarding carousel；完成或跳过后写入 localStorage
  - 真正 launch 前使用 Radix AlertDialog 展示问题和本局设置，关闭后把焦点还给 textarea
- InputView 底部安全提示当前走 locale key；中英切换时会一起更新。
- InputView 的 placeholder typewriter、确认弹窗入场和首页动效都会遵守 `prefers-reduced-motion`；textarea 提交有 IME composition guard，中文拼音回车不会误触发 launch。
- InputView 当前也会在 `custom_agents` capability 开启时显示主区 `AgentSelectionStrip` 和高级设置里的 `AgentAttachPanel`：
  - 两个入口都用 `getSessionBoundUserId()` 解析出的 API user id 读取 Agent；`directorIdentity` 只用于展示导演名
  - 主区 strip 只显示轻量 pill、最多 3 个 Agent 和 `+N more`；完整 persona、knowledge domains 和 decision bias 仍在高级设置的 attach panel 中展示
  - 选中的自建 Agent 会通过 `customAgentIdentityIds -> custom_agent_identity_ids` 传给主推演
  - 可选数量按 `min(numAgents, capabilities.custom_agents.max_custom_agents)` 动态收口；capability 没有返回上限时前端按 1 个自建 Agent 保守兜底
  - 提交 scenario 前会再次同步裁剪 selected IDs，避免用户刚调低 Agent 数量就立刻提交时带上 stale 超限选择；capability 关闭时不会显示 Start badge，也不会提交旧 selected IDs
  - 创建 Debate 时，会把当前选中的前 2 个自建 Agent 透传成 `customAgentIds -> custom_agent_ids`
  - 这条链路只传 identity id，不引入 URL 或外部 fetch 配置
  - strip 与 attach panel 都按文本节点渲染 Agent 名字、persona、knowledge domains 和 decision bias，不走 `dangerouslySetInnerHTML`
  - `agentStore` 会按 user id 缓存身份列表，忽略迟到响应，同一 user 的 in-flight 请求会去重，并在 user/list 变化时剪掉已经失效的 selected id

## Theater 与性能边界

- Pixel Theater 运行时在 `frontend/src/game/`。
- `PhaserGameLoader` 负责按需加载 Theater；`SimulationView` 仍保留 `.theater-panel` 与 `.phaser-game-container` 作为 screenshot / GIF capture 选择器。
- live simulation 已经有 Agent 且尚未完成时，Phaser 会跳过 `TitleScene` 直接进入 `WorldScene`；completed replay 仍走 replay sync，避免停在标题页。
- `TitleScene / EndingScene` 的副标题、初始化提示、无描述 fallback 和返回提示都走 `game.*` i18n key，不再用 `i18next.language` 手写中英分支。
- screenshot / GIF capture runtime 已拆分，不进入默认首包。
- `capture_game_screenshot('panel')` 继续走 `.theater-panel`，`capture_game_screenshot('canvas')` 继续走 `.phaser-game-container`；本轮没有修改 `useSimulationViewState.ts` 的截图选择器契约。
- 主题、素材与 UI asset 路径的单一事实源位于 `themeRegistry.ts`；冷启动标题等待期间会预拉当前 scene theme PNG，`WorldScene` 初始 bootstrap 和后续 theme swap 也会按需补拉真实场景图。
- Theater 当前布局是 canvas-first 的 Light Theater：
  - 外壳使用暖白背景 `#faf8f5`、暗棕正文 `#181611`、暖灰边框和少量 `#c61583` accent；Phaser canvas 内的场景渲染仍保持游戏画面，不强行改成亮色 UI
  - React 侧 HUD 已移除，Theater 控制拆到 `frontend/src/pages/sim/*`
  - floating toolbar 承载 replay、capture mode、截图/GIF、玩法卡入口和 status chips
  - Director goals / commitment 移到 Radix Sheet drawer，保留 focus trap、Escape 和 return focus
  - completed Theater 仍显示玩法卡入口，但只作为只读回看；live 未完成且已有 active branch/agents 时才允许应用玩法卡
- Theater 气泡当前行为：
  - React DOM bubble overlay 默认开启；URL 带 `?domBubbles=0` 或 `?useDomBubbles=false` 时退回 Phaser bubble 路径
  - Phaser 通过 `viz:sprite_positions` 发出 sprite 坐标，`BubbleOverlay` 用 refs + `transform: translate3d()` 同步位置，不靠 React setState 逐帧更新
  - bubble overlay 保留 `role="log"` / `aria-live="polite"` 的 sr-only 完整文本
  - 最大同时可见气泡数 = `min(agentCount, 8)`，compact 宽度下会减少可见数量并避开底部浮动控件
  - Agent bubble 色板来自 `agentPalette.ts` 的 WCAG AA 双色 token
- Phaser canvas 当前按 `width * dpr` 与 `height * dpr` 初始化 backing store，DPR capped at 3；automation state 会回显 `device_pixel_ratio / dpr`。`BootScene` 的 fallback texture 与 `WorldScene` 的绘制单位会读取 registry DPR 做缩放。
- Theater CSS 对 `backdrop-filter` 保留 solid fallback 与 `-webkit-backdrop-filter`；`color-mix()` / `oklch()` 使用 fallback 或 `@supports` 门控；`100dvh` 保留 `100vh` fallback；reduced-motion 和 forced-colors 口径由对应 CSS 与 `legacyCssFallbacks` 测试覆盖。
- completed Theater 的 replay filters 只有多分支或多轮时才显示下拉框；单分支 / 单轮会显示静态文本，避免把不可选择的控件暴露给用户和屏幕阅读器。轮次静态值走 `game.round_value` locale key。
- Theater Agent sprite 当前采用动态缩放：
  - 尺寸 = `max(40, Math.min(width, height) * 0.055)` 宽，保持 2:3 宽高比
  - 阴影、名牌、faction bar 位置跟随 sprite 尺寸自动计算（`spriteH` 存储在 `AgentSpriteData` 中，各处统一使用 `spriteH * 0.5 + 2` 作 Y 偏移）
  - 阵营聚拢动画：`viz:faction_cluster` 事件驱动，对象池 flash、命名常量、tween 预算限制、reduced-motion snap
  - 重复 `scene_init` 会按 agent id 清掉旧 container、minimap dot、halo/wander timer 和相关 tween，再创建新 sprite，避免重复角色或 idle-wander loop 残留
  - 原始 640×640 PNG 素材的宽高比不会因为 canvas 比例变化而拉伸

## 关键模块

| 模块 | 位置 | 责任 |
|------|------|------|
| `themeRegistry.ts` | `frontend/src/lib/themeRegistry.ts` | Theater / Debate / Oracle 资产注册表；当前包含 18 个 gameplay profiles 与 44 个主题场景 |
| `emotionColors.ts` | `frontend/src/game/constants/emotionColors.ts` | 情绪-光环颜色映射共享常量（PhaserGame 和 VizSynthesizer 共用） |
| `agentPalette.ts` | `frontend/src/game/constants/agentPalette.ts` | Theater DOM bubbles 的 Agent 双色 token；用于保持浅色 Theater 中的文本对比 |
| `BubbleOverlay.tsx` | `frontend/src/game/BubbleOverlay.tsx` | React DOM 气泡层；消费 `viz:sprite_positions`，用 transform3d 跟随 sprite，并提供 polite live log |
| Theater Controls | `frontend/src/pages/sim/*` | 从 `SimulationView` 拆出的 Theater toolbar、capture controls、status chips 和 Director drawer |
| `scenarioAuthority.ts` | `frontend/src/lib/scenarioAuthority.ts` | 主模式 authority 合流入口 |
| `scenarioGameplayState.ts` | `frontend/src/lib/scenarioGameplayState.ts` | gameplay_state 映射与判等 |
| `scenarioDirectorState.ts` | `frontend/src/lib/scenarioDirectorState.ts` | director_state 映射 |
| `predictionBetting.ts` | `frontend/src/lib/predictionBetting.ts` | 结构化押注 helper |
| `gameplayContract.ts` | `frontend/src/lib/gameplayContract.ts` | 共享玩法契约消费层；profile 展示名与首页轻量 summary 需要和 shared contract 保持一致 |
| `GameplayCardsModal.tsx` | `frontend/src/components/GameplayCardsModal.tsx` | 玩法卡弹窗；推荐卡、分组折叠、后端 contract payload、focus trap、label/select 显式关联与 disclosure ARIA；完成态 Theater 可只读回看 |
| Campaign Components | `frontend/src/components/campaign/*` | campaign UI 组件；覆盖 streak、difficulty、refresh countdown、weekly track chip/dialog/leaderboard、progress sheet、badge cabinet、level progress 和 achievement toast；progress sheet 会并行读取 badge definitions、user badges、mastery，并复用已取到的 weekly summary |
| `dailyChallenge.ts` | `frontend/src/lib/dailyChallenge.ts` | challenge date key 与 ISO week helper；用于前端入口显示和请求 context，最终结算仍以后端派生日期为准 |
| `PredictionModal.tsx` | `frontend/src/components/PredictionModal.tsx` | 结构化预测弹窗；串行提交、快速重复提交防护、branch 晚到兜底、高级题材回响 disclosure 与 focus trap；预测提交使用 session-bound `user_id`，展示名仍来自本地导演身份 |
| `InterventionReceiptCard.tsx` | `frontend/src/components/InterventionReceiptCard.tsx` | 只读干预效果回执；推演未完成时只按 lifecycle 显示 pending/injected 占位，完成后拉取当前 scenario 的 persisted effects，倒序展示，不展示内部 log id |
| `roundtableSelection.ts` | `frontend/src/lib/roundtableSelection.ts` | `trait_mix / fault_line_first / witness_augmented` 选择辅助与测试入口 |
| `endingRoomReplayAutomation.js` | `frontend/src/lib/endingRoomReplayAutomation.js` | ending-room replay URL 判定 helper；当前识别 `roomReplay / roomShare / roomLocal`，并复用 live modal / readonly UI 判定；replay action 文案兼容 `Save copy / 保存副本` 与 `Import run / 导入运行` |
| `roundtableReplayAutomation.js` | `frontend/src/lib/roundtableReplayAutomation.js` | roundtable live / readonly replay automation payload 判定 helper |
| `endingRoomPickerAutomation.js` | `frontend/src/lib/endingRoomPickerAutomation.js` | 结果页 ending-room picker 的 DOM-first 打开 helper 与 UI-ready 判定 |
| `endingRoomStore.ts` / `worldlineRoundtableStore.ts` | `frontend/src/stores/` | ending-room / roundtable 状态；`worldlineRoundtableStore` 是 `endingRoomStore` 的 re-export |
| `textLayout/*` | `frontend/src/lib/textLayout/` | `pretext` helper、Oracle transcript layout kernel、overflow contract、Input 面高度预测 (`inputPredict`)、Canvas bubble 预测 (`canvasTextPredict`)、P5 文本契约测试 (`textContract.test`) |
| `useTranscriptScroll.ts` | `frontend/src/hooks/useTranscriptScroll.ts` | `EndingChatModal` 与 `WorldlineRoundtableView` 共享的 transcript scroll 锚定 hook |
| `roundtableHelpers.ts` | `frontend/src/pages/roundtableHelpers.ts` | 圆桌纯函数：选型模式、锚点构建、fault-line 算法、anchor 描述 |
| `endingChatHelpers.ts` | `frontend/src/components/endingChatHelpers.ts` | 会客厅纯函数：角色标签、模式标签、prompt 构建、anchor 描述 |
| `resultHelpers.ts` | `frontend/src/pages/resultHelpers.ts` | 结果页纯函数：押注 badge、campaign cache、locale-backed badge copy、结构化关键记录 |
| `DirectorDebriefPanel.tsx` | `frontend/src/components/result/DirectorDebriefPanel.tsx` | 结果页导演复盘面板；外层折叠状态来自 `ResultContext`，消费后端 `score_breakdown` 和结果页整理出的问题、世界线、承诺、押注、干预、关键记录、目标与玩法卡状态，展示得分原因、本局读数、下一步入口与新增徽章 |
| `simulationHelpers.ts` | `frontend/src/pages/simulationHelpers.ts` | 推演页纯函数：Theater 场景/天气/时间标签、预热检测 |
| `ClassicBranchTree.tsx` / `BranchTree.tsx` / `branchTitle.ts` | `frontend/src/components/` | Classic 分支树；短标题会用 `description / fork_reason` 的首句补成更好读的展示标题，原始 `Branch.title` 仍保留给干预等业务动作 |
| `PostVerdictPanel.tsx` | `frontend/src/pages/PostVerdictPanel.tsx` | completed live roundtable 的 `Deep Dive` 面板；聚合 participant-scoped `1-on-1 Interview`、`Research Analyst` 与 `Cross-Examine`，并对 `agent_conversation / roundtable_analyst / roundtable_survey` 做 inline capability gate |
| `RoundtableAgentChat.tsx` | `frontend/src/pages/RoundtableAgentChat.tsx` | 圆桌 post-verdict 的 `1-on-1 Interview`；按 participant 维护独立 conversation thread |
| `AnalystStreamView.tsx` / `SurveyStreamView.tsx` / `postVerdictCaches.ts` | `frontend/src/pages/` | post-verdict analyst / survey 的独立流式 UI、缓存与 context reset；会区分 user abort、stream error、retry 和 source/tool chip |
| `useRoundtableSseStream.ts` | `frontend/src/hooks/useRoundtableSseStream.ts` | roundtable analyst / survey 共享 SSE hook；负责 POST stream、frame 解析、timeout 与 abort |
| `manualChunks.ts` / `performanceBudgetConfig.mjs` | `frontend/src/lib/manualChunks.ts` / `frontend/scripts/lib/performanceBudgetConfig.mjs` | 前端构建分块与预算门禁单一事实源；React 保留在共享 `vendor`，`@antv/*` 隔离到 `g6-vendor`，`html2canvas / gif.js` 按需拆分，React Flow 栈继续走 Rollup 自动分块并纳入预算检查 |
| `useG6Graph.ts` | `frontend/src/hooks/useG6Graph.ts` | G6 图谱 hook；等 ref-backed container 真正挂载后再建图，强制启用 G6 autoResize，同时用 ResizeObserver 同步容器尺寸后再 fitView；调用方也可传 layout resize key，在父级 flex 面板切换但 ResizeObserver 不可靠时主动按容器尺寸 `setSize + fitView`；稳定数据值变化可走 `setData + draw`，结构或 options 变化仍走 `setOptions + render`，并保留事件订阅清理 |
| `useNodeConversationTransport.ts` | `frontend/src/hooks/useNodeConversationTransport.ts` | `NodeConversationSheet` 的本地 transport hook；负责 `/start` / `/turn` 请求、origin branch/round/node/excerpt 透传、AbortController 生命周期和 SSE frame 解析 |
| `orgContext.ts` / `useOrgContext.ts` | `frontend/src/lib/orgContext.ts` / `frontend/src/hooks/useOrgContext.ts` | `Organization ID` 的 sessionStorage helper；当前由 API client 读取并生成 `X-Org-Id`，InputView 不再展示专门输入框 |
| `frontendPreflight.mjs` | `frontend/scripts/lib/frontendPreflight.mjs` | 前端 preview / deep-link 预检 helper；graph E2E 与 `release-signoff` 当前共用它来校验 SPA shell、一致的 module/CSS/legacy 入口，以及入口资产可达性 |
| `e2e-new-source-ingestion-live.mjs` | `frontend/scripts/e2e-new-source-ingestion-live.mjs` | source-ingestion 专项脚本；默认走 fixture，`SWARM_E2E_MODE=live` 时走真实 backend。live 模式会先显式打开首页总开关，校验 `/api/scenario` 请求里的 `web_search_families`，再检查结果页四个 source family 的状态；ready 时要求真实列表项，provider non-ready / unavailable / failed 状态按显式 UI 接受；`Polymarket` 的 `non-us` geo-gate 也走同一条 live 口径 |
| `e2e-capability-matrix.mjs` | `frontend/scripts/e2e-capability-matrix.mjs` | graph/playability capability matrix；当前覆盖 `AgentWorkshop / AgentLibrary / CausalReview / CompareDigest / KGExplorer / ReplayView` 六个 gated route，fixture payload 也包含 `agent_conversation / kg_explorer / replay_trace`。`ReplayView` 的 disabled 路径现在会落显式 unavailable surface，不再回首页；如果脚本还按旧 redirect 口径断言，先同步脚本再跑 |
| `e2e-ws-contract-suite.mjs` | `frontend/scripts/e2e-ws-contract-suite.mjs` | WS 契约诊断脚本；当前覆盖 `scenario / debate / ending-room` 的首帧 auth、`4001 / 4404` 非重连、`1006` 可重连、auth timeout、oversize auth frame 和 pending-auth limit |
| `e2e-result-share-fixture.mjs` | `frontend/scripts/e2e-result-share-fixture.mjs` | ResultView + ShareModal fixture browser 回归；脚本 stub 后端 scenario/branch/story/social/capability JSON，检查真实分支渲染、分享弹窗、预测卡片、social endpoint、控制台/page/request 错误和横向溢出。`full` 默认跑 desktop + mobile Chromium |
| `e2e-gameplay-cards-modal.mjs` / `e2e-prediction-modal.mjs` / `e2e-intervention-receipt.mjs` | `frontend/scripts/` | gameplay surface fixture E2E；默认用 `page.route()` stub 后端，`SWARM_E2E_MODE=live` 时才走 live backend |
| `compatUuid.ts` | `frontend/src/lib/compatUuid.ts` | 兼容 UUID helper；优先 `crypto.randomUUID()`，再退 `getRandomValues`，最后才走时间戳兜底 |
| `PipelineStepper.tsx` | `frontend/src/components/PipelineStepper.tsx` | `/sim/:id` 与 `/result/:id` 的 fixed-bottom pipeline progressbar；error 状态下 `aria-valuenow` 会钳到有效范围 |
| `AgentPanel.tsx` | `frontend/src/components/AgentPanel.tsx` | 主推演右侧 Agent 列表与实时发言；筛选某个 Agent 时，会按世界线分组展示该 Agent 的发言，并在每组内按 round 排序 |
| `ResultConversationWidget.tsx` | `frontend/src/components/ResultConversationWidget.tsx` | 结果页轻量追问入口，复用 `NodeConversationSheet`；会把当前 analysis branch 的标题、insight、fork reason、关键时刻和对比分支传成 result origin；replay 结果页不渲染这条 live-only 入口 |
| `HookSummaryPanel.tsx` / `useHookSummary.ts` | `frontend/src/components/result/` / `frontend/src/hooks/` | 结果页追问前的上下文摘要；identity growth-events 请求会带 session-bound `user_id`，避免 identity endpoint 因缺少 owner scope 返回 400 |
| `ScenarioAgentPicker.tsx` | `frontend/src/components/result/ScenarioAgentPicker.tsx` | 结果页 `找 Agent 追问` dialog；用 `ul > li > button` 呈现场内 Agent，展示 tier、role、persona，带 identity 时提供 Agent profile hash 深链，选择后交给 `NodeConversationSheet` |
| `graphTokens.ts` | `frontend/src/lib/graphTokens.ts` | 图谱视觉 token 单一事实源：颜色、边样式、图标、graph i18n key；KG 另有浅/深色 WCAG AA 色板，选中态用陶土赭，hover 用森林绿，避免影响 DAG / ArgumentMap / Faction 图面 |
| `GraphNodeCard.tsx` | `frontend/src/components/GraphNodeCard.tsx` | `CausalReviewView` / `ArgumentMap` 共用的 ReactFlow 节点卡；当前已改成可键盘聚焦的 button 口径 |
| `CausalGraphBoard.tsx` | `frontend/src/components/workbench/CausalGraphBoard.tsx` | 工作台 graph tab 的因果图；按 `scenarioId` 读取全量 causal graph，不接收 `branchId` prop，大图 fitView 会保留更低最小 zoom，边标签按 zoom 密度和优先级显示，导出面板打开时不会启用 visible-elements culling |
| `AnimatedEdge.tsx` / `EdgeLabelTooltip.tsx` | `frontend/src/components/` | 工作台因果边和标签 pill；label 坐标使用 React Flow smooth-step label 坐标并叠加 parallel offset，motion 由 CSS `prefers-reduced-motion` 收口，tooltip 支持 hover 和键盘 focus |
| `NodeDetailPanel.tsx` | `frontend/src/components/NodeDetailPanel.tsx` | 两个图面的共用节点详情侧栏；显示 type / round / payload / unit details；event / fork / outcome 会优先展示用户可读语义字段 |
| `NodeContextBanner.tsx` | `frontend/src/components/kg/NodeContextBanner.tsx` | `NodeConversationSheet` 的来源摘要卡；显示 node type、round、对话目标、卡片意义、前因/后续/关系、label 和截断 excerpt |
| `NodeQuickCard.tsx` | `frontend/src/components/workbench/NodeQuickCard.tsx` | KG 工作台桌面节点快览卡；按视口钳位位置，避免靠边节点把卡片挤出屏幕 |
| `e2e-web-search-suite.mjs` | `frontend/scripts/e2e-web-search-suite.mjs` | 首页搜索增强专项 E2E：custom override、provider/key/base URL、搜索深度、scenario 请求体校验 |
| `RoundtablePickerPanel.tsx` | `frontend/src/pages/RoundtablePickerPanel.tsx` | 圆桌代表选型面板组件（6 种模式 + 证人选择；桌面端 `@dnd-kit/core` 入席交互，移动端保留 click-to-seat） |
| `RoundtableTranscriptList.tsx` | `frontend/src/pages/RoundtableTranscriptList.tsx` | 圆桌 transcript 列表组件（turns + drafts + 折叠/锚点操作 + phase 分隔线 + speaker 左侧色标） |
| `AgentSelectionStrip.tsx` | `frontend/src/components/AgentSelectionStrip.tsx` | 首页主区自建 Agent 轻量选择器；用 fieldset/legend + 原生 checkbox，最多展示 3 个 pill 和 `+N more`，支持 loading/error 状态、keyboard focus、forced-colors 和 reduced-motion |
| `AgentAttachPanel.tsx` | `frontend/src/components/AgentAttachPanel.tsx` | 首页高级设置里的自建 Agent 选择卡片；按 `maxSelected` 动态限制数量，支持 loading/error/retry/empty 状态，长 persona 和复杂 decision bias 只作为文本展示 |
| `AgentCard.tsx` | `frontend/src/components/AgentCard.tsx` | Agent Library 共享卡片；展示 tier、domains、favorite 状态与 profile/edit/export 等动作；长 persona 按 Unicode code point 截断 |
| `AgentProfileModal.tsx` | `frontend/src/components/AgentProfileModal.tsx` | Agent profile 弹窗；展示成长、记忆、timeline 和 decision bias 分布，切换 Agent 或关闭后的迟到请求不会覆盖当前弹窗 |
| `AgentProfileSheet.tsx` | `frontend/src/components/result/AgentProfileSheet.tsx` | 结果页内联 Agent 档案 sheet；用于 generated / replay Agent，带 request sequence guard、loading/error/empty 状态、reduced-motion/forced-colors/mobile CSS 和 generated Agent 的继续对话入口 |
| `IdentityInspectorView.tsx` | `frontend/src/pages/IdentityInspectorView.tsx` | identity memory inspector 页面；切换 id 时清掉旧标题，迟到 memory 响应不会覆盖新 identity，空记忆、基础设施错误和正常 memory list 分开显示 |
| `DocumentUploader.tsx` | `frontend/src/pages/AgentWorkshop/DocumentUploader.tsx` | Agent Workshop PDF 上传入口；展示抽取进度、部分成功、错误和新建 identities，取消/重试只更新当前请求 |
| `PersonaExportImport.tsx` / `personaExportImportUtils.ts` | `frontend/src/components/` | Agent 备份导出 / 从备份创建 UI 与 JSON 校验 helper；创建成功后刷新 Agent Library，失败时显示本地化错误，不直接露出原始 API 文本；`AgentWorkshop/PersonaExportMenu.tsx` 复用同一组 ExportButton / ImportDialog primitive |
| `EducationTemplatePicker.tsx` | `frontend/src/components/EducationTemplatePicker.tsx` | 首页教育模板 dialog；支持 category / difficulty filter、空结果、Retry、Escape 关闭和 focus trap；加载 / retry 使用 request id、cancel guard 和 fetch token，迟到响应不会覆盖当前状态 |
| `QuickStartCards.tsx` | `frontend/src/components/QuickStartCards.tsx` | 首页 quick-start 预设卡；TypeScript 只保留 emoji、key、轮数、Agent 数和模式，题目与副标题从 `quickstart.*` locale key 读取 |
| `Journal/*` | `frontend/src/components/Journal/` | 个人 journal 辅助面板：Agent roster、calibration curve、worldline mini map；当前右侧 roster / mini-map 是 Sprint 7 前的占位辅助面板 |
| `PersonalJournalView.tsx` | `frontend/src/pages/PersonalJournalView.tsx` | 个人预测日志页面；读取 `/api/me/journal` 与 `/api/me/calibration`，resolve 后显示实际结果与 Brier 分，刷新时忽略迟到响应 |
| `MemoryTimeline.tsx` | `frontend/src/components/MemoryTimeline.tsx` | Agent 记忆时间线；样式已从组件内联迁到 CSS，按 scenario/time 组织事件 |
| `ProgressIndicator.tsx` | `frontend/src/components/ProgressIndicator.tsx` | 5 步流程 pill；当前用在 InputView / ResultView，`currentStep` 会钳到有效范围 |
| `ShareArtifact.tsx` | `frontend/src/components/ShareArtifact.tsx` | 1200×630 offscreen OG card；通过 html2canvas 导出 PNG，只包含公开展示用摘要字段 |
| `SetupWizardView.tsx` / `Setup/*` | `frontend/src/pages/SetupWizardView.tsx` / `frontend/src/components/Setup/` | `/admin/setup` provider 向导、preset radio card 和 LLM connection test |
| `OnboardingGuide.tsx` / `useOnboardingState.ts` | `frontend/src/components/Onboarding/` / `frontend/src/hooks/useOnboardingState.ts` | 首页首次引导 carousel；完成状态写入 localStorage，存储不可用时不阻塞用户 |
| `ConversationHistoryPicker.tsx` | `frontend/src/components/ConversationHistoryPicker.tsx` | scenario 级 Agent Conversation 历史选择器；负责分页、skeleton、重试和 stale response guard |
| `QuotaBadge.tsx` | `frontend/src/components/shared/QuotaBadge.tsx` | conversation / replay quota pill；读取 `/api/quota/summary`，本机 local conversation 显示本机模式，replay 仍显示 scenario branch quota |
| `DecisionBiasSlider.tsx` | `frontend/src/components/Controls/DecisionBiasSlider.tsx` | Agent Workshop 的 5 维 decision bias slider；0-100 UI 映射到 0-1 payload |
| `uiPreferencesStore.ts` | `frontend/src/stores/uiPreferencesStore.ts` | ResultView `reader / workbench` 内部模式偏好；界面显示为 Reader / Explore，使用 localStorage 持久化 |
| `alert-dialog.tsx` | `frontend/src/components/ui/alert-dialog.tsx` | 共享 Radix AlertDialog wrapper；当前用于 InputView launch confirm 和 Simulation cancel confirm，并支持 overlay class / overlay click handler |

## 当前边界

- 前端交付目标仍是浏览器端，不维护原生壳约束。
- `follow-up` 体验已经可用，但与经典模式的完整流式一致性仍在继续收口。
- InputView 当前会把 continuity 确认结果按 request-scoped `continuityOverrides` 传给 `POST /api/scenario`，只影响这次启动，不改本地缓存身份。
- Agent Library / Workshop 当前按 `custom_agents` capability gate 显示：
  - Workshop 的 tier selector 使用原生 radio 语义，选项固定为 `IMPORTANT / CROWD`
  - Workshop 的 manual / document tab 使用真实 tab 语义，支持方向键、Home 和 End 切换
  - Workshop 的 document tab 只接受 PDF 上传；上传请求给后端最多 8 分钟处理，期间用户仍可取消。后端成功创建 identities 后，页面会显示新建 Agent 并提示用户回到 Library 查看；部分 persona 失败会显示失败数量但保留已创建 Agent；0 个 Agent 创建成功时不会显示确认按钮。空文件、非法 PDF、无文本 PDF、处理超时和全部创建失败都会显示本地化错误态
  - 编辑旧 Agent 时会把后端返回的 `preferred_tier` 回填；缺失或未知值回退为 `IMPORTANT`
  - knowledge domains 优先读取后端解析后的数组，旧 payload 只带 JSON 字符串时再本地 parse，解析失败显示为空
  - Library card 显示 tier badge、domains 和 favorite 状态；favorite filter 是 pressed button group，不是 tab panel；空库会给出创建入口
  - capability / favorite 失败显示本地化错误与 Retry，不把原始后端错误文本直接露到页面
  - Agent 备份入口按 `persona_export` capability gate 显示；Library 卡片显示导出备份，Library / Workshop header 显示从备份创建 Agent。从备份创建成功只新增当前用户的 custom Agent，不覆盖现有 Agent，返回的 `identity_id` 是 string；粘贴 JSON 入口默认折叠在高级区域
- Education template picker 当前按 `education_templates` capability gate 显示；选中模板后会回填首页问题、Agent 数和轮数；加载失败走本地化错误和 Retry，不显示 raw error。
- Personal Journal 当前按 `prediction_journal` capability gate 显示；journal 与 calibration 数据都从当前 user scope 读取，resolve 后会显示实际结果和 Brier 分，refresh 会忽略迟到响应。右侧 roster / worldline panel 目前是明确占位，不代表已有 live 联动。
- Leaderboard segment filters 当前会把 `type/date/agent count` 筛选同步到 URL params；不带筛选时仍消费旧数组响应。
  - Leaderboard 的 loading、empty、retry 和 row/skeleton 动画都走 locale / reduced-motion 口径；快速切换筛选时会忽略迟到响应
  - 这些页面新增样式集中在共享 BEM class 和 editorial token 上，不使用新增 inline style
- InputView 当前不展示专门的 `Organization ID` 输入框；API client 仍会从 sessionStorage 读取已有组织 ID 并生成 `X-Org-Id`。
- InputView 的搜索增强当前口径：
  - 搜索增强入口默认显示；`VITE_ENABLE_WEB_SEARCH` 只是旧开关，不再决定入口是否出现
  - `GET /api/capabilities` 只决定推荐的已配置搜索是否可直接使用，不决定整个 section 是否显示
  - `provider_capability.supports_domain_filter=false` 时，4 个 source family toggle 会保持可见但不可选，并显示当前语言的说明
  - `推荐：使用已配置搜索` 模式只发送 `webSearchEnabled=true`，provider / key / base URL 输入不展示
  - `高级：使用我的搜索服务` 模式才发送 `webSearchProvider / webSearchApiKey / webSearchBaseUrl`
  - 搜索深度保存在 `localStorage`，当前可选 `light / standard / deep`；提交时映射成 `webSearchIntensity -> web_search_intensity`
  - 高级模式下，API 型 provider 先显示 API key；base URL 只在用户打开自定义 endpoint 后展示；SearXNG 隐藏 API key，直接展示实例地址
  - 自定义 provider capability 会先从可识别的 base URL 推断；base URL 为空时使用当前下拉 provider 的 capability，只有非空未知 host 会显示 no-provider warning
  - 模型原生搜索当前不是前端独立模式；首页只用说明文案解释它是独立 LLM native path，native citations 只在后端 LLM native path 真的产出后由 ResultView 展示
  - SearXNG base URL 推断只看 hostname label token（`searx` / `searxng`），不会用任意子串匹配
  - 4 个 source family toggle 只有在搜索总开关开启、且当前 provider 支持 domain filter 时，才会把勾选结果透传成 `webSearchFamilies -> web_search_families`
  - 搜索总开关关闭，或 provider capability 从支持变成不支持时，已勾选的 source family 会被清空；重新打开不会恢复旧选择
  - disabled 的 source family 当前会保留可见项，并显示跟随当前 UI 语言的 tooltip，不再回落成英文硬编码
  - 输入搜索 API key / base URL 时不再反复重打 capability 探针
  - Advanced Settings 关闭时会裁掉内部内容，不会把 Source Family controls 漏到关闭态页面里
- ResultView 的来源展示当前会把普通 web snippets、Source Family cards 和 LLM native citations 分开显示；native citations 只接受字符串 text 和 http(s) URL，`javascript:`、非数组和 malformed replay payload 都不会渲染成链接。
- InputView 的主问题输入有稳定 accessible name，并带 IME composition guard；中文输入法组词期间按 Enter 不会误触发启动。
- continuity 确认框是 modal dialog：打开后会聚焦第一个控件，Tab 留在弹层内，Escape 或取消会关闭并恢复焦点。
- `useCapabilityCheck` 当前会复用同一份 `/api/capabilities` 结果：
  - 多个组件同时 mount 时会共享同一个 in-flight 请求
  - 成功结果会缓存 5 分钟，避免 30+ consumer 频繁重打 capabilities
  - capability 请求失败会从 2 秒开始退避，最多 60 秒；`reload()` 可强制重试
  - consumer 现在能区分 `loading / enabled / error / reload`
  - capability 请求失败时不再直接伪装成 `enabled=false`
- ResultView 当前除了折叠的 `真实世界来源` 入口，也会按 `web_search_context.family_context` 渲染四张 source family card：
  - 被选中的 family 才会变成 `ready`
  - 未选中的 family 会保持 `empty`
  - `failed / unsupported_provider / fallback_unconstrained / search_skipped` 都有专门文案；后端 `status_reason` 优先作为卡片说明，缺失时才回到本地化默认文案
  - desktop grid 和 mobile sheet 分别使用自己的 source card test id / `aria-describedby` id，不复用同一组 DOM id
  - replay / historical payload 里已经带来源数据时，即使当前 capability 关闭，也会用 recorded badge 标出这是历史来源
  - `polymarket.configured_host=non-us` 时会显示 geo-gated placeholder
- `SimulationView` 的 automation payload 当前已补：
  - `thinkingAgentCount`
  - `thinkingAgents`
  - classic live-fork fixture 已能直接观测“谁正在说话前的 thinking 态”
- `SimulationView` 当前的 cancel 按钮走 Radix AlertDialog；确认后调用 `POST /api/scenario/{id}/cancel`，请求 in-flight 时 dialog 标 `aria-busy`，显示 `role=status` 的取消中提示，并禁用关闭/确认按钮；收到 cancelled 后保持终态，不把旧 WS 事件当成新一轮 live 状态。
- Classic 分支树当前直接消费 `store.branches[].title`。
  如果标题过短，前端只在展示层拼上 `description / fork_reason` 的第一句线索；干预弹窗等业务动作仍拿原始标题。
- `SimulationView` 的默认 director objectives 只在后端和本地 meta 都没有 objectives 时补一次；seed key 按 `scenario / question / gameplay profile / signature card` 计算，避免同一局反复 backfill。
- `PredictionModal` 当前在 branch list 晚到时会自动把默认目标补齐：
  - 如果 modal 打开时还没有可押世界线，UI 会先临时回退到 `ending_tone`
  - 只要后续收到可用 `ACTIVE` branch，就会自动切回 `branch_winner`，并选中当前仍有效的默认 branch
  - 如果用户已经手动改选了一个仍然有效的 branch，提交时会继续用用户当前选择；commitment branch 只作为默认兜底，不会把用户已选目标强行改回去
  - 提交给 backend 的 structured prediction text 仍按 500 字符预算；textarea 会先扣掉下注元数据占用的长度，超限时显示本地化错误
  - 对应的 `predict-late-branches` fixture 当前会先采 `before` 工件，再放出 late branch 事件；`before` 态应保持 `ending_tone`，`after` 态才切到 `branch_winner`
  - CSS 当前已收口到单滚动容器、`100dvh` / safe-area、移动端 44px footer control、`prefers-reduced-motion` 和 forced-colors fallback；OKLCH 颜色仍带 sRGB fallback
  - 预测提交按“prediction API -> 本地 bet meta -> gameplay-state 持久化回调”串行；最后一步失败时弹窗保持打开，重试复用 pending meta，不重复提交 prediction。同步提交锁会拦住同一帧内的快速重复点击。
  - `profile_resonance` 默认藏在高级选项里；disclosure 展开时才挂载内容，并只在目标 DOM 存在时输出 `aria-controls`。
- `GameplayCardsModal` 当前先展示 profile/局势驱动的 3 张推荐卡，再把剩余卡按 4 个分组折叠展示；分组按钮使用 `aria-expanded`，只在展开且 region 存在时输出 `aria-controls`。branch / agent / source select 都有稳定的 `label htmlFor` / `id` 配对。directive textarea 只在桌面 fine pointer 环境自动聚焦；手机和粗指针设备不会自动弹出键盘。
- `InterventionReceiptCard` 当前在 completed SimulationView 中只读展示已持久化的 intervention effects；它读取 `/api/scenario/{id}/intervention-effects`，只接受当前 scenario 的 state，按 `created_at` 防御性倒序展示。没有 effects、scenario 不匹配或页面还没完成时不渲染卡片；有 loading/error 折叠态，不显示内部 `intervention_log_id`。
- `endingRoomStore` 当前会在 committed turn、room hydrate、thread hydrate 时清掉 stale draft；迟到的 `turn_start / turn_delta` 不再把 ghost bubble 重新挂回当前 transcript。
- `endingRoomStore` 当前把 `snapshot / result / thread hydrate + commitTurn` 作为 authority；`pendingDrafts` 只是流式草稿缓存。recoverable `turn_error` 只清 draft，不会把整个 room 升成 fatal error。
- `endingRoomStore.loadRoom` 当前在 result 加载失败时不再把整个 room 标记为 error；room 仍可正常使用，result 会在下次 WS 事件或手动刷新时重试。
- `endingRoomStore` 当前在 `hydrateThread()` 时也会同步更新 `snapshot.threads`；新建 anchored thread 后，Oracle replay 不会再只序列化旧主桌快照。
- `endingRoomStore.openRoom()` 当前带 request epoch；用户连续切房间时，旧请求晚到不会再把新 room 状态覆盖回去。
- `CompareDigestView` 当前采用“单活跃 live Theater + 非活跃镜像预览”的 compare 方案，不会同时挂两个 live Phaser runtime；左右 pane 共用 round timeline。未抓到快照时会先显示待机镜像卡片，保留当前 round / divergence / branch weight，不再落回黑底 `Snapshot pending` 占位。
- `CompareDigestView` 当前已把三类状态分开：
  - 缺 `branch_a / branch_b` 时走缺参态
  - compare `404` 走 `no data`
  - compare fetch / scenario fetch 失败走可重试的加载失败态
  - `branch_a / branch_b` 请求参数都会先做 `encodeURIComponent()`
- `ReplayView` 当前在 `replay_trace` capability 关闭时会显示显式 unavailable surface，不再 silent redirect 到首页；如果 capability 探针自己失败，也会给出单独的 retry surface。trace 计数标签当前用静态本地化 copy（`Frame / Branches`、`帧 / 分支`），不会再把 `{{count}}` 模板串露到页面上。trace 数据通过 `after / limit / root_branch_id` 做 cursor pagination；空第一页但后端返回 `next_cursor` 时仍保留 `Load more`，rapid click 会被 loading guard 收口，branch filter 变化时会重置旧 cursor。
- `KGExplorerView` 当前会把 capability 失败、feature disabled、graph fetch 失败分开显示；graph fetch 失败时会清掉旧图，再给出本地化错误和 retry。主图用真实 G6 canvas 渲染，minimap 是 G6 minimap plugin，不是占位卡片；search / type filter 会通过 deferred value 更新 G6 数据本身，搜索匹配节点 `id / key / label`，并复用 `toKgG6Data / resolveKGG6Tokens`。大图默认隐藏过密的节点/边标签，搜索或筛选时会恢复节点标签以便定位。点击节点时，`NodeConversationSheet` 收到的是业务 `kgType`、节点 label、branch 与 round，不再使用 G6 shape type。
- KG / causal / argument / result 四种入口当前都会给 `NodeConversationSheet` 传 surface-specific origin。空态问题会按卡片类型和上下文生成：事件问前因后果，分支问分岔路线，结局问落点和对比分支，知识图谱问邻近概念，裁决图谱问主张/证据/裁决关系。
- `ConversationHistoryPicker` 是 Agent Conversation 历史的共享入口：
  - 当前用于 `EndingChatModal`、`RoundtableAgentChat` 和 `NodeConversationSheet`
  - 列表调用 `GET /api/scenario/{id}/conversations`
  - 详情调用 `GET /api/conversation/{thread_id}`
  - 支持 cursor pagination、skeleton、错误重试和空态；scenario/filter 切换时会丢弃迟到响应
  - `NodeConversationSheet` 选择历史后会恢复最后一条已提交 assistant 回复
- `QuotaBadge` 当前从 `GET /api/quota/summary` 读取 conversation / replay bucket；本机 local conversation 会显示本机模式，scenario 或 bucket 切换时，迟到响应不会覆盖新 badge。
- `ResultView` 当前默认进入 Reader mode；界面上的 Explore mode 会持久化到 `swarm-ui-preferences` 的 workbench 键，并显示 graph / KG / workbench-only panels。结果页 header 会同时显示 conversation/replay `QuotaBadge`，也会在能力允许时直接显示 `查看因果图谱` 与 `图谱工作台`。
- `WorkbenchView` 当前三种 tab 的能力门槛分开判断：`graph` 只要求 causal graph，`kg` 只要求 KG capability，`split` 才要求两者都可用。结果页 header、next-step bridge 和 `/workbench/:id` 都会把当前 analysis branch 写进 query；进入工作台后 graph / split / kg 图面仍按 scenario 拉全量 causal graph，不用这条 branch 过滤。正常工作台 header 会提供返回对应结果页的链接。
- Oracle replay copy 现在优先走 artifact；如果 artifact 不可用且 URL token 也过大，会回退为本地只读副本链接，而不是直接失效。
- ending-room artifact/local replay 当前统一落到 `/result/replay?...`；不再要求先拼出 `/result/:scenarioId?...` 才能读出来。artifact payload 里的 `scenario.total_rounds=null` 也会被前端 replay 正常接受，不会再把只读页打成空结果。
- ending-room replay automation helper 当前识别 `roomReplay / roomShare / roomLocal`；roundtable 页面除 `roomShare / roomLocal` 外也兼容 `share / local` 别名。
- ResultView 在 ending-room modal 已打开时，会把 replay/import action 收到 modal header；外层结果页不再重复显示同一个 import 入口，关闭 modal 后外层入口仍可用。
- `WorldlineRoundtableView` 的 readonly replay 现在会按 `active_thread_id` 恢复对应 thread 的 `interaction_mode` 与 hotseat target，不再把 hotseat replay 误显示成 `archivist_route`。
- roundtable 的 anchored thread readonly replay / local restore 当前已补过 Firefox / WebKit scoped regression，口径与 Chromium 对齐。
- Oracle 页面 UI 语言当前跟随用户语言开关；room payload 会显式带 `zh | en`，但页面不再反向用 `scenario.language` 覆盖当前 UI 语言。
- Oracle / roundtable 的本轮界面文案迁移已覆盖 `EndingChatModal`、`WorldlineRoundtableView`、`RoundtablePickerPanel`、`RoundtableTranscriptList` 和相关 helper；en/zh key 与 placeholder 当前保持一致。`RoundtablePickerPanel` 的取消拖拽播报会带 `{{name}}`，中英文口径一致。
- `src/i18n/config.ts` 当前把 `localStorage` 读写失败视为可恢复错误；隐私模式或受限环境下，语言初始化与切换仍可工作。
- `GlobalOfflineBanner` 当前把 WS grace timer 改成了 SSR-safe 的 layout effect fallback；当前 SPA 行为不变，未来如果接 SSR 也不会再因为 `useLayoutEffect` 打 warning。
- `LanguageSwitcher` 当前按 `role="group"` + button `aria-label / title / lang` 暴露，不再只是视觉开关；accessible name 也会带上可见的 `EN / 中文` 文本，避免语音控制和视觉标签口径分叉。
- `useFactionOverlay` 当前只会在 `factions` capability 开启时发请求；`FEATURE_FACTIONS=false` 时，ending-room / roundtable 不再反复打 `faction-timeline 404`。
- `WorldlineRoundtableView` 当前开桌 payload 会跟随最新的 `selectionMode` 与当前 UI 语言，不再复用旧闭包值。
- `useEndingRoomWS` 当前重连会复用最新的 connect 回调，不再依赖旧的自引用调度。
- ending-room room/thread user-turn 请求当前走 `90s` 前端 timeout；发送失败或超时后，store 会清掉目标 thread 的 `pending_drafts`，忽略迟到 draft delta，并 best-effort 重拉 room / result / thread，不把整个 room 直接打成 fatal error。
- `ShareModal / GameplayCardsModal / InputView / DebateArenaView / DebateResultView / SimulationView / ResultView / EndingChatModal / WorldlineRoundtableView` 当前已清完 `react-hooks/exhaustive-deps` warning；本轮只补 hook 依赖与派生值稳定化，没有改业务口径。
- 单结局结果页当前不展示 `worldline_roundtable / crossline_gallery` 入口，只保留 `ending_chamber / one_move_only`。
- Oracle fresh live room 的 English deterministic anchor copy 当前已补去混句兜底；single-ending / roundtable 在 fresh room 下不会再把中文 hinge 直接嵌进英文句子。
- `EndingChatModal` 当前已补：
  - `继续追问 / 另开线程 / 复制纪要 / 追问洞察`
  - transcript `quote` 级 `沿这句追问 / 另开线程`
  - transcript `quote` 动作栏在触控设备上默认可见，不再要求 hover
  - `后续三回合` 按钮：设置 `interaction_mode=epilogue` 并预填追问内容
  - 证据卡抽屉：在非 crossline gallery 模式下，可展开其他世界线摘要卡，点击 `提交证据卡` 以 `interaction_mode=evidence_card` 和对应 `cited_branch_id / cited_refs_json` 发送
  - thread rail 与证据卡抽屉位于 transcript 内部滚动区外；transcript list 继续独立滚动，证据卡列表在抽屉内滚动，移动端不会再把这些控件卷到 header / composer 下方
  - `parallel_survey` 不是 EndingChatModal interaction mode；并行问卷能力保留在 completed-state roundtable 的 Deep Dive survey SSE 工作台里
  - mobile sidebar sheet 已补 `SheetTitle / SheetDescription`；第一次 `Escape` 只关闭 sheet，不会误关外层 chamber
- `NodeConversationSheet` 当前也复用 `SheetTitle / SheetDescription` 作为单一无障碍描述来源，不再手工覆写 `aria-labelledby / aria-describedby`，Radix 下不会再打缺 description 警告。桌面端现在按 non-modal 右侧 sidecar 挂载，移动端仍是 modal bottom sheet；有 origin 时会显示 `NodeContextBanner`，让用户看到当前追问来自哪个节点、哪一轮、正在问谁、这张卡代表什么，以及它的前因/后续/关系。节点对话的本地 transport 现在收口在 `useNodeConversationTransport.ts`：sheet unmount 会 abort 活跃请求，`/start` 和 `/turn` 会透传 origin branch / round / node / excerpt，SSE parser 也已兼容 multiline `data:` frame。bootstrap start 当前带 epoch guard；关闭或切换节点后的迟到 start response 不会再把旧 thread 写回当前 sheet。公共会话状态机在 `turn_completed / turn_error / abort` 之后会忽略迟到 delta，并用 committed turn 计数驱动结果页 deepen hint；committed assistant 文本会切到 `SafeMarkdown` 渲染，列表和加粗不会再显示成原始 Markdown。结果页追问会使用当前 result context 的标题、说明和空态问题，不再套用“选择图节点”的文案。
- `DebateArenaView` 当前只允许在 live 当前 phase 的下注窗口打开/提交 quick counterplay；锁到历史 phase 时不再发起 counterplay。
- `DebateArenaView` 当前在“当前 live phase”视图下会保留更早 phase 的已出现 turns，并以 `FoldableTurn` 历史卡形式继续展示；切到历史 phase 时仍只显示该 phase 自己的 turns。
- Debate 的页面级播报当前只保留 phase cue；`SpotlightTurnCard` 的高亮态不再单独暴露 live-region 语义，避免同一轮变化在读屏器里重复播报。
- `useDebateWS` 当前会处理 `debate_participants_update`；`debateStore` 按 `side` 合并 participants，并支持 WS 更新早于 REST snapshot 到达的情况。空 name/role 不会覆盖已有可读值。
- `DebateArenaView / DebateResultView` 的 Podium/score card 当前会展示 participant role/persona；长 persona 和 room note 可展开，长 role/persona 会自动换行。裁判分数位显示本地化状态，不再用数字占位。
- Debate live 的 speaker initial 当前按 grapheme 截取，emoji、旗帜和 CJK 扩展字符不会被 `charAt(0)` 截坏。
- `WorldlineRoundtableView` 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程（当前会覆盖返回的全部 `phase_insights`，不再只限前 3 条）
  - phase insight 卡片默认折叠；header 保留短 preview，展开后显示后端按中文 96 字 / 英文 160 chars 预算压缩的一句 commentary。phase prompt 预填仍使用这条 commentary；后端会去掉重复的问题前缀，如果标题已经包含同一句，preview 不再重复显示。
  - transcript `quote` 级 `Follow this quote / Start anchored thread`
  - transcript `quote` 级 `Hotseat this rep / 点名这位代表`
  - committed transcript 长段折叠 / 展开
  - `后续三回合` 按钮
  - mobile roster modal 当前会区分 `archivist / witness / representative`，不再把 witness 回落成普通代表标签
  - `Reseat and reopen` 与阶段导航当前会跟随 `prefers-reduced-motion` 切到 `auto` scroll，不再强制 smooth scroll
  - replay share artifact payload 当前用显式字段对象构造，不再用 `as unknown as Record` 穿透类型
  - `describeRoundtableAnchor()` 当前会先判断 phase 是否属于 `EndingRoomPhase`；未知 phase 会回退原始 label，不会强行拼不存在的 locale key
- Oracle 当前锚点规则：
  - `EndingChatModal`
    - `verdict / insight / key_moment / quote`
    - 都先落到显式 `questionAnchorIds`
  - `WorldlineRoundtableView`
    - `verdict / phase / quote`
    - 都先落到显式 `questionAnchorIds`
  - `appendUserTurn()` 与 `createThread()` 两条链都带锚点语义，不再只靠 prompt 预填
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail / transcript header 回显当前 thread 的 anchor badge，只显示用户可读 label，不直接暴露内部 ids。
- Oracle 自动化状态当前会额外输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `pending_question_anchor_ids`
  - `current_speaker_turn_key`
  - `current_speaker_participant_id`
  - `pending_drafts`
  - `stream_state`
  - `anchor_kind / anchor_label`
  - `transcript_layout`
    - 当前也包含 `collapsible_turn_count / collapsed_turn_count`
- `roundtableSelection.ts` 当前承接 `trait_mix` 选择逻辑；`trait_mix / fault_line_first / witness_augmented` 的状态切换已补 no-op guard，避免对同一份 selection 反复写回。
- `WorldlineRoundtableView` 当前已支持：
  - `manual_shortlist`
  - `expert_witness`
  - `trait_mix`
  - `fault_line_first`
  - `witness_augmented`
- completed live roundtable 当前在 verdict 后会开放 `Deep Dive`：
  - `1-on-1 Interview`：按 participant 作用域开启代表私聊，复用 conversation `/start` + `/turn`；目标卡会显示角色、世界线、立场、最近原话和人物简介，传给后端的 `origin_excerpt` 也是同一份可读摘要，不再把 raw JSON 直接塞进 prompt context
  - `Research Analyst`：走 roundtable analyst SSE，展示 tool iteration 与最终回答
  - `Cross-Examine`：对选中的 participants 发同一问题，按 participant 返回 survey response
- `Deep Dive` 的三个 tabpanel 会一直保留稳定 id，便于 `aria-controls` 指向真实目标；`agent_conversation / roundtable_analyst / roundtable_survey` capability 探针失败时显示可重试错误，功能关闭时显示本地化占位。analyst / survey 关闭时不会挂载对应 SSE 子面板。
- `Deep Dive` 只在 live completed room 打开。roundtable replay 继续保持只读，只恢复 transcript / thread / share / import，不重新开放 chat、analyst 或 survey 这类 live 工具。
- `1-on-1 Interview` 的请求失败、空响应或 stream error 当前显示为独立 `role=alert` 错误提示，不再追加成代表自己的气泡。
- post-verdict 工具当前有独立于 room composer 的流状态与缓存：`PostVerdictPanel` 持有 tab / analyst / survey state，result context 变化时会 reset cache 并 abort in-flight stream；`AnalystStreamView` 与 `SurveyStreamView` 共享 `useRoundtableSseStream` 处理 SSE。用户 abort、首帧前 abort、完成后 abort 和服务端 error 会落到不同 UI 状态；analyst tool result 与 survey participant source 会以 chip 形式展示。
- roundtable mobile 当前以 `live room` 为优先目标：
  - `live room` 已收口到首屏无页面级纵向滚动
  - `picker / reseat` 仍允许滚动，不与 live-room 口径混用
- 当前 Oracle mobile 专项脚本已覆盖：
  - ending-room：`mobile single-ending verdict-anchor thread / artifact readonly / local readonly / reload restore / import`，以及 `multi-ending hotseat / all_present / epilogue / crossline gallery / evidence_card / artifact readonly / local readonly / reload restore / import`
  - roundtable：`trait_mix / fault_line_first / witness_augmented / hotseat thread switch / quote-anchor thread / artifact readonly / local readonly / reload restore / import`
- `ResultView` 当前支持自动化专用的 query 参数直开 live ending-room：
  - `debugEndingRoomBranch`
  - `debugEndingRoomMode`
  - `debugEndingRoomAgents`
  - 仅用于脚本/调试稳定打开 live chamber，正常用户流仍走结果页按钮 + picker。
- `ResultView` 当前在 replay 模式下会：
  - 禁用 `Export Markdown`
  - 隐藏 `score_predictions`
  - 隐藏 `ResultConversationWidget` 和 Agent follow-up picker
  - 保留本地导入、只读分享与 permalink 相关动作
  - 保留 replay-safe 的 `causal graph` 入口
  - 保留按当前展开分支切换的 `FactionTimeline`
  - 继续隐藏 live-only 的 `CounterfactualPanel / ResumePanel`
- live Reader 模式当前只挂一个 `ResumePanel`，Explore 模式继续走工作台侧面板；两个模式不会同时渲染两份续跑入口。
- `ResultView` 的结局详情当前只在展开时挂载：
  - 收起时不会再把完整 story / key moments 留在 DOM 或可访问性树里
  - 展开按钮也不会再保留指向已卸载详情节点的悬空 `aria-controls`
- `DebateResultView` 当前把 argument map 改成按需加载，并放回主结果壳内对齐：
  - 首屏只显示 `Load map / Hide map` 按钮和提示文案，不会默认把 React Flow 一起挂上来
  - 只有用户真正点开后才渲染 `ArgumentMap`，主要是为了减少结果页首屏额外开销
- `ArgumentMap` 的节点对话当前需要调用方显式提供 `conversationScenarioId` 才会打开 `NodeConversationSheet`；打开时会把附近最多 3 条论证关系作为 related context 传给 banner 和空态问题。`DebateArenaView` 和 `DebateResultView` 现在都传 `null`，所以 debate argument-map 节点暂时不会直接起对话，等真实 scenario id 接通后再开放。
- `CausalReviewView` 的节点点击当前会同时打开详情和节点对话；节点对话固定传真实 `scenarioId`，`identityId` 保持为空，不再走假 id 或占位值。event 节点会尽量指向发言者；fork / outcome 等没有发言者的节点会走图谱解读 Agent / 结局解读 Agent 文案。
- `DebateResultView` 当前的 replay 分享有两条只读路径：
  - URL 足够短时走内联 `?replay=`
  - URL 过长时，把 payload 落到本地存储后改走 `?local=`
  - replay 结果页会同时识别这两条只读路径；只有 `?local=` 的分享按钮文案会明确显示 `Save local read-only copy`，普通 `?replay=` 仍保留通用 permalink 文案；导入入口和语言兜底提示当前都走 locale key
  - automation payload 当前会显式区分 `replay_source=api|token|local`，并额外暴露 `replay.is_readonly / controls.can_import_local_run / controls.importing_local_run`
- `InputView / DebateArenaView / DebateResultView` 当前都不会再因为 debate payload 里的 `language` 改全局 UI 语言：
  - 页面壳继续只跟用户当前语言开关走
  - `DebateResultView` 遇到中英混排的长文案时，会显示明确 fallback note，并保留原文展示
  - mixed-language 检测当前覆盖：
    - `best_argument / best_rebuttal / judge_summary`
    - `counterplay.explanation`
    - `judge_rationale.*`
    - `supporting_turns`
    - `phase_insights.commentary`
    - `result.replay.quote`
    - `prediction.score_reason`
- `ResultView` 当前在 `counterfactual_replay` capability 开启且结果里存在 branches 时，会显示：
  - `CounterfactualPanel`
  - `ResumePanel`
  - `FactionTimeline`
- 续跑分支卡片当前会显示 resumed badge、来源分支按钮和独立概率说明；来源按钮会把焦点带回对应原始分支标题。
- 前端 `StoryBranch / BranchInfo` 类型当前接受 `fork_round`，以及可空的 `replay_kind / replay_source_branch_id`，用于展示 fork point、resume/import/counterfactual 来源语义；普通分支可以没有 replay 字段。
- `CounterfactualBrand` 当前也接在 ResultView 的反事实入口上：
  - 最多展示 3 个可回溯 fork point
  - 只使用带真实正整数 `fork_round` 和 `parent_branch_id` 的分支
  - 点击后会把 `CounterfactualPanel` 的来源分支同步到 parent branch，并把轮次同步到对应 `fork_round`
  - `CounterfactualPanel` 只允许选择该来源分支里已保存消息的回合，以及该回合实际发言过的 Agent；提交时会带原始发言文本，让后端做唯一消息匹配
- `HOPsAnimation` 当前已挂到 `ResultView`，多分支结果页会在 endings grid 前展示分支概率采样动画和“100 次采样”说明；replay 模式下不播放。
- `ResultView` 当前在 `agent_conversation` capability 开启、当前 scenario 有 Agent 且不是 replay 模式时，会显示场内 Agent follow-up bridge；这条入口打开 `ScenarioAgentPicker`，不会直接跳到 `/agents`。Agent 卡上的档案链接只在有 `agent_identity_id` 时显示，并指向 Agent Library 的 hash profile。
- `ResultView` 的阵营分析当前不再固定绑 `branches[0]`：
  - 用户展开了某个结局时，`FactionTimeline` 跟随当前展开分支
  - 没有展开分支时，默认跟随概率最高的分支
  - `CounterfactualPanel` 和 compare link 也复用这条 `analysisBranch`，不会再把旧 `branches[0]` 当默认分析分支
- `FactionTimeline` 当前改成真正的纵向时间线：
  - 头部直接显示 `branch scope / round span / faction count`
  - faction 卡片直接显示 `members / stance / confidence`
  - event 卡片直接显示 `actor / faction`，未知事件类型会走显式 fallback
- `FactionTimeline` 当前也把“空数据”和“加载失败”拆开了：
  - 真的没有阵营数据时，会提示这局推演还不够长
  - fetch 失败时走可重试的错误态，不再把所有异常都压成 `empty`
- `FactionTimeline.test.tsx` 当前通过真实 `en / zh` locale JSON + i18next 验证这条口径，不再 fake `t(key)`；未命中的 `event_labels.*` 会回退为 `event_type` 去下划线后的文本。
- `en / zh` locale 当前已补齐这批共享 copy：
  - graph：`search_summary / graph_node_a11y / graph_edge_a11y / graph_handle`
  - argument-map：`filter_status_group`
  - factions：`current_branch / branch_scope / round_span / members / stance / confidence / actor / faction / event_type / event_labels.*`
  - debate replay：`import_local_run / importing_local_run`
- `CausalReviewView` 与 `ArgumentMap` 当前共用：
  - `GraphNodeCard`
  - `NodeDetailPanel`
  - `graphTokens`
- `CausalReviewView` 当前优先使用后端 `available_branches` 保持分支 selector；如果后端没带这个字段，会回退到 `payload.branch_id + fork children` 重建选项，因此即使当前带 `branch_id` 过滤，兄弟分支和 fork child branch 也不会从下拉里消失
  分支 selector 当前会优先显示 scenario branch 的标题和概率；拿不到 branch 元数据时才回退完整 branch id。
- `CausalGraphBoard` 是独立工作台的轻量因果图面：只把 `scenarioId` 传给 `useScenarioGraph`，始终展示 scenario 的全量 causal graph；URL `branch` 保留在 workbench query 里，但不再作为 graph tab 的 fetch filter。大图超过 50 个节点时用更低的 fitView minimum zoom，节点/边结构变化才触发布局同步和 fitView；选中、关联、展开、dimmed 和 edge opacity 这类状态变化按 shallow diff 更新，避免每次交互重建整张图。
- `CausalGraphBoard` 的边标签按 `far / mid / near` zoom bucket 走 CSS 密度管理，不在同一 bucket 内反复 re-render；far 隐藏全部 label，mid 只显示高优先级 label，near 显示全部。visual label pill 只放关系短名，round / confidence 放 hover 或 keyboard focus detail，tier color 用左边框表达。screen-reader relation list 仍保留完整关系文本。
- `KGGraphBoard` 继续按 scenario 展示全量 causal graph 的 KG 视图，KG 数据和样式与 `KGExplorerView` 共用 `toKgG6Data / buildKgG6Options`。工作台 layout 从 split 切到 KG 单图面时，会把 layout resize key 传给 G6 hook，按当前容器重新 `setSize + fitView`，避免继续沿用 split 半宽 canvas。图例默认折叠；toolbar 使用固定尺寸 icon buttons；搜索会匹配节点 `id / key / label`，搜索和类型筛选会更新图数据本身，如果当前选中节点被过滤掉，会清掉选中和锁定高亮；节点超过 label 限制时默认收起节点标签，搜索、筛选、hover 或锁定时再打开当前语境；screen-reader fallback table 跟随当前可见节点，移动端超过 200 节点仍走截断提示。
- `CausalReviewView` 的错误页当前提供 `Retry`，成功重拉后不会残留旧错误态；capability probe 失败会先显示可重试错误，不会误落到 feature disabled；graph fetch 错误文案会按 `network / branch_not_found / unauthorized / server / load_failed` 映射到本地化 copy，不再把原始 `HTTP 404` 或后端 message 直接露给用户。
- `CausalReviewView` 当前在 branch 切换时会忽略迟到的旧响应，不让旧分支结果覆盖最新选择。
- `CausalReviewView` / `ArgumentMap` 当前对 graph route fetch 里的 `scenarioId / debateId`，以及 `CausalReviewView` 返回结果页的 scenario link，都先做 `encodeURIComponent()`；带特殊字符的 id 不会再把请求或跳转拆坏。
- URL 里如果带了不存在的 `branch_id`，`CausalReviewView` 当前会直接显示后端错误，不再把未知分支伪装成空图。
- `CausalReviewView` 当前只有在源图本身就没有因果边时，`多节点但 0 edges` 才会走 relationless snapshot fallback：
  - 显示本地化提示和 event snapshot 列表
  - 仍可打开节点详情
  - 不再把这类图伪装成可交互 DAG
- `CausalReviewView` 当前会先用 graph payload 渲染，再异步补拉 scenario branch 元数据；分支标题请求变慢时，不会再把整张图一起卡在 loading。节点当前可拖拽、可选择；用户拖拽后的位置会保留到下一次结构性重置，不会被普通 rerender 抢回 dagre 布局。
- `CausalReviewView` 当前在 compact viewport 下会把 dagre 布局切成纵向 `TB`，并继续保留 React Flow controls 与本地化 mobile navigation hint；`MiniMap` 只在桌面显示。legend toggle 也补上了 `aria-expanded / aria-controls`。
- `CausalReviewView` / `ArgumentMap` 的 media query hook 当前兼容 legacy WebKit `addListener / removeListener`；旧 Safari / WebKit 下的 compact viewport 和 `prefers-reduced-motion` 切换也会实时更新，不再只吃首帧值。
- `experiments/phaser-custom/entry.mjs` 当前会先加载独立的 `global-shim.mjs` 再进 Phaser；WebKit 下不再因为 `Can't find variable: global` 直接落到错误页。
- 如果只是 search / filter 把边筛空，`CausalReviewView` 当前仍会保留交互图和导出入口，不会误切 relationless fallback。
- `CausalReviewView` 当前在非交互 fallback（relationless snapshot / 大图 text fallback）时都会隐藏导出按钮，并且只保留一条具名的 a11y 列表；列表名会跟随当前语言本地化。
- `CausalReviewView` 的 agent search 输入当前统一使用 `Search nodes or agents... / 搜索节点或 Agent...`；placeholder 和 `aria-label` 走同一条 i18n key。
- `CausalReviewView` 当前补了 guide panel 和 explanatory empty-state：
  - guide 默认显示一句图谱概览和规模 chip，可继续展开详情，也可完全收起
  - 展开后会显示分支去向、建议先看的节点、关系数说明和完整文本预览入口
  - close / show 两个按钮都带完整 disclosure `aria-expanded / aria-controls`
  - key nodes 的可见标签会按近似显示宽度压短；完整文本仍保留在 `aria-label / title`，长文本可用 `查看全文` 展开
  - guide / empty-state 文案当前集中走组件内 `CAUSAL_COLORS` dark-surface token，不再把正文直接压到低对比颜色
- `CausalReviewView` 当前在 `graph_analysis` 数据可用时会显示 analysis panel：
  - summary、density、average / max degree、component、god nodes、cross-branch edges 和 degree distribution 都来自后端 `serverAnalysis`
  - `serverAnalysis=null` 时不显示假分析，仍保留图本身和本地说明
- `CausalReviewView` 与 `ArgumentMap` 当前只会在图结构真的变化后重新 `fitView()`；search / status filter / branch 切换仍会重算视口，但选中节点或取消选中不会再把视口强制拉回去
- `CausalReviewView` / `ArgumentMap` 的图节点、边、handle 可访问文案，以及 React Flow controls / `MiniMap` 文案当前都会跟随 UI 语言实时更新；切语言不会重打图请求。
- `CausalReviewView` / `ArgumentMap` 的 `MiniMap` 当前是非交互 overlay（`pointer-events: none`），只在桌面显示；移动端不再和图操作抢热区。
- 两个图面当前除了 node/unit 的 sr fallback list，也会额外输出本地化 relation list；因果图会保留 `causes / precedes`，`ArgumentMap` 会区分 `supports / rebuts / accepts / rejects / leaves unaddressed`，边语义不再只剩颜色和箭头。edge evidence 的 `low / medium / high` 也会走本地化文案，不再把 `[medium]` 这类原始值直接露出来。
- `ArgumentMap` 当前在筛选结果为空时会保留筛选 chips 和 `Clear`，同时显示按状态区分的空态文案，不会把用户困在空态里；这个空态会拦截图面点击，只在当前图本来就有 `units` 时出现，node-only 图不会被状态筛选误筛成空白面板。
- `ArgumentMap` / `NodeDetailPanel` 当前继续支持显示 `accepted / standing / unaddressed / rebutted / rejected` 五种状态；前端视觉 token 与后端合法状态口径已重新对齐，filter chip 会显示每个状态的当前数量。
- `NodeDetailPanel` 当前对 outcome / fork 会优先显示可读字段：结局详情、insight、概率、来源分支、分支原因、分支影响和子分支；没有这些语义字段时才回退 raw payload。
- `ArgumentMap` 当前把 `verdict` 节点也接到共享 graph i18n label；节点可访问名称会跟随当前语言。verdict 节点会优先显示 winner + 本地化“胜出 / wins”，完整摘要放在节点详情文本里。
- `ArgumentStrengthMeter` 当前按本地化 `list / listitem` 摘要语义渲染，不再使用 `meter`；状态筛选激活时，摘要也会跟着当前可见 `units` 一起更新，不再继续显示全量分布。
- `ArgumentMap` 当前在 compact viewport 下也会保留显式 controls 与本地化 mobile navigation hint，并提供 `Graph / List` 切换；list 模式按 `claim / evidence / rebuttal / counter` 分组展示 accordion。`prefers-reduced-motion` 下会关闭边动画、强度条宽度过渡和节点卡片 dim 过渡。
- `ArgumentMap` 与 `CausalReviewView` 的节点详情打开文案当前已走 i18n；screen-reader fallback 和 text fallback 不再把 `event / claim / standing` 这类原始 token 直接露给用户。
- `ArgumentMap` 当前在 node-only 图（有节点、没 units）时，仍会保留 screen-reader fallback list；图节点 button 口径也继续支持键盘打开详情。
- `ArgumentMap` 当前使用三层 DAG 口径：verdict 放顶层，claim 放中层，evidence / rebuttal 放下层；dagre 的边方向只用于排版，React Flow 渲染边仍保留原始 `source / target`。支持边为绿色实线，反驳边为红色虚线，verdict 连边为紫色。
- `ArgumentMap` 当前有本地 `localStorage` 控制的一次性 3 步 tour；键盘快捷键只在非编辑区域接管，`/` 聚焦搜索，`F` fit view，`Escape` 清掉搜索、筛选和选中节点。
- 两个图面的节点卡当前会直接显示 `type / round` 或 `type / status` 这层 meta；移动端图谱 chrome 也继续保留显式 controls、`Fit view` 和本地化导航提示。
- 两个图面的节点卡当前都按 button 口径渲染：
  - 可键盘聚焦
  - 保留 pointer click 打开详情
  - React Flow 外层 node wrapper 不再重复暴露 button 语义，避免出现 button 套 button 的可访问性冲突
- `NodeDetailPanel` 当前按轻量 dialog 语义工作，仍由需要详情面板的图面复用：
  - 打开后焦点会先落到关闭按钮
  - 调用方会显式传入 `panelId`，节点卡的 `aria-controls` 会指向真实详情面板
  - 关闭后会把焦点还回最新一次打开详情的 trigger
  - 面板内 `Escape` 仍可关闭；焦点已经离开 panel 时，不会再全局劫持 `Escape`
  - compact viewport 下会改成贴底展开，不再固定挤在右上角
  - `Copy Reference` 先走 `clipboard.writeText()`；失败时回退 `execCommand('copy')`
  - 如果两条复制路径都失败，会显示可见错误提示，不再静默成功
  - 关闭时会顺手清掉旧的复制失败提示；重新打开同一节点时，不会再把上一轮错误提醒残留出来
  - 详情关闭后仍走 pane click / close button 这条现有口径
- `ExportPanel` 当前在 PNG / SVG 导出失败时会显示可见失败提示，不再只打 `console.error`；忙态文案也会按格式区分成 `Exporting PNG... / Exporting SVG...`。SVG 导出当前改成 native SVG background / edge / node markup，不再依赖 `foreignObject`；校验脚本也会拒绝 `foreignObject` 回退。节点卡标题过长时，SVG 文本会按卡片宽度裁剪显示，但 `<title>` 和文本内容仍优先保留完整标题，不再把省略号文本写进 SVG。
- `CausalReviewView` 当前在 branch 切换时会先收起旧图和导出面板，等新分支数据 ready 后再恢复；图页外层统一走 `100dvh`，relationless snapshot fallback 里的节点详情也会锚在当前容器里，不再飘到视口右上角。
- P1 post-review hardening 的前端 fresh 验证当前已补：
  - targeted vitest：`237 tests passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
  - ResultView replay conversation fixture：replay 模式不暴露 live conversation，不发 `/api/conversation/start`
  - CausalReview graph-analysis fixture：server analysis 渲染，中文 evidence tier 不泄漏原始枚举
  - capability matrix E2E：`30 passed / 0 skipped / 30 total`
- P1 post-review follow-up 的前端窄集当前也已补：
  - `CausalReviewView.test.tsx / ResultView.test.tsx / locales.test.ts`：`126 passed`
  - 目标文件 eslint：通过
  - TypeScript noEmit：通过
- 本次 bridge/workbench 文案 + CausalReview guide key-node 标签窄集：
  - `cd frontend && npm run test -- --run src/pages/CausalReviewView.test.tsx src/i18n/locales.test.ts --reporter=verbose`：`87 passed`
  - `cd frontend && npx tsc --noEmit`：通过
  - Playwright：ResultView bridge 文案和 CausalReview guide 长 key-node 标签压缩 / `title` / `aria-label` 保留通过
- 本轮 local quota + ResultView 图谱入口定向复验：
  - `npm test -- --run src/components/shared/QuotaBadge.test.tsx src/lib/conversationStateMachine.test.ts src/pages/ResultView.test.tsx src/i18n/locales.test.ts`：`121 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
  - `npm exec -- eslint src/pages/result/ResultHeader.tsx src/pages/result/ExploreDeeperBridge.tsx src/pages/ResultView.test.tsx src/i18n/locales.test.ts`：通过
  - 浏览器实测本机结果页显示 `对话 · 本机模式`，header 可直接进入因果图谱和图谱工作台；点击 `探索` 会滚到下一步区。
- 当前 frontend 稳定验证口径：
  - `npm test -- --run`：`206 files / 2328 tests passed`
  - `npx eslint src/ --max-warnings=0`：通过
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
  - i18n key parity：`zh: 2800`、`en: 2800`
  - CausalReviewView / TimelineGalaxy capability 浏览器复核：Chromium、Firefox、WebKit 均覆盖 capability probe error 与正常 capability payload；WebKit 的 TimelineGalaxy 正常态以页面文本和 canvas 数量复核通过
  - Pixel Theater browser spot-check：完成态 `/sim/e1a41453-2cb2-43a1-a054-0d7cd04a6bf5` 的 toolbar 玩法卡入口可见，modal 以只读状态打开，Chrome DevTools console error 为 0
  - KG visualization 定向回归：`5 files / 193 tests passed`
  - Workbench KG resize 定向回归：`useG6Graph.test.ts + WorkbenchView.test.tsx` 为 `56 passed`，`KGGraphBoard.test.tsx` 为 `42 passed`；本机浏览器复核 `graph -> split -> KG` 后，KG 容器与内部 G6 canvas 同宽，`widthDelta=0`，console error 为 0
  - KG Explorer fixture E2E：Chromium desktop + mobile、Firefox desktop、WebKit desktop 共 `4 runs / allPassed=true`
  - Custom Agent attach / session userId 本轮通过 frontend full vitest、backend `TestCustomAgentOwnership` 窄集和 Chrome 首页 smoke
  - ResultView Agent profile / follow-up 本轮通过 full vitest 覆盖；custom Agent 档案走 Agent Library hash，generated / replay Agent 档案走页内 sheet，generated Agent 可从 sheet 继续进入 `NodeConversationSheet`
  - Intervention upgrade 浏览器复核：`e2e-suite.mjs mobile` 在 Chromium mobile 通过；`e2e-suite.mjs cross-browser --browsers firefox,webkit` 在 Firefox / WebKit desktop 通过 director-state 和 result archive readback scoped regression。Firefox/WebKit `.result-archive` 隐藏元素截图当前会落 full-page fallback；这不是 BrowserStack / Sauce 或真实移动设备签收
  - Oracle E2E：`e2e-ending-room-followup-suite full` 与 `e2e-worldline-roundtable-suite full` 通过
  - Phaser browser spot-check：`/sim/91d5292b-36ea-4190-909d-87eb7e27f1d9` 当前 scene 为 `WorldScene`，canvas 可见，console error 为 0
  - CampaignProgressSheet browser spot-check：desktop 与 mobile forced-colors / reduced-motion 下可打开、可滚动，console/page error 为 0
  - campaign/gameplay 浏览器 E2E：Chromium mobile / gameplay / intervention / prediction、Firefox gameplay / intervention、WebKit gameplay / intervention 均通过；最终 Chromium gameplay mini 复验通过
  - Source Family Playwright 复核覆盖 Chromium / Firefox / WebKit 的 desktop `1440px` 与 mobile `375px` 六组合矩阵
  - native citation 浏览器复核覆盖 Chromium / Firefox / WebKit 的 desktop + mobile 六组合矩阵；WebKit Tab-to-links 按平台限制记录
  - legacy `e2e:web-search` 已用真实 provider 跑过 Tavily / Exa / xAI-local / SearXNG-local；`e2e:new-source-ingestion-live` 已跑 desktop + mobile live；`e2e:capability-matrix` 为 `30 passed / 0 failed`
- frontend i18n key + placeholder parity 的历史深层记录保留在对应 release 行；本轮只跑了 top-level spot-check。
- Gate 3/Sprint 4 browser probe final rerun：desktop `10/10`、mobile `10/10`，工件位于 `frontend/output/e2e/codex-review/overall-rerun/`。
- Sprint 0-2 browser matrix 当前工件位于 `frontend/output/e2e/sprint0-2-review-20260510-browser/summary.json`：12 个功能、Chromium / Firefox / WebKit、desktop 1440 与 mobile 375，`72 passed / 0 failed`。
- Classic 分支标题本轮已补定向验证：
  - `npm exec -- vitest run src/components/BranchTree.test.tsx`：`5 passed`
  - `npm exec -- eslint src/components/BranchTree.tsx src/components/BranchNode.tsx src/components/BranchTree.test.tsx src/components/branchTitle.ts`：通过
  - `npm exec -- tsc --noEmit -p tsconfig.app.json`：通过
- custom agent upgrade browser spot-check 已覆盖桌面 `/agents` 创建 IMPORTANT / CROWD、tier badge、编辑回填、tooltip hover、ResultView bridge、移动端 tier selector 单列，以及 Debate 请求体里的 `custom_agent_ids`。
- frontend 目标文件 `eslint`、`typecheck`、`build`（含 `perf:budgets:check`）当前通过。
- fixture-backed local preview 浏览器复核当前已补：
  - ResultView bridge DOM / disabled 样式
  - faction timeline i18n 插值
  - CausalReviewView guide disclosure 语义
  - console clean
- `node --test scripts/e2e-frontend-preflight.test.mjs` 本轮 `25 passed`。
- P1 前置图谱/回放/结果页浏览器复核当前已覆盖：
  - `/kg-explorer/dbac37a3-3578-42b2-99c0-06185caad147`
  - `/sim/dbac37a3-3578-42b2-99c0-06185caad147/causal-map`
  - `/replay/32728bd6-282c-42f1-a7da-493892fce32a`
  - `/result/dbac37a3-3578-42b2-99c0-06185caad147`
  - 截图位于 `frontend/output/e2e/20260424-p1-preflight-fixes/`
- 这轮 graph/playability 增量回归当前也已补：
  - `node --test scripts/e2e-ws-contract-suite.test.mjs`：`18 passed`
  - clean-room `e2e:ws:contract`：`20 passed / 1 skipped / 0 failed`
  - clean-room `e2e:capability-matrix`：`30 passed / 0 skipped / 0 failed`
  - capability / replay / compare / kg / faction / i18n 定向 vitest：`64 passed`
- `npm run build`（含 `perf:budgets:check`）当前通过。
- fresh local live 的 `node-conversation-live / kg-explorer-live / replay-view-live` 当前通过。
- 本轮 local preview 复核也已补：
  - 首页 source family disabled tooltip 已按当前 UI 语言显示，不再回落成英文硬编码
  - `ReplayView` capability disabled 不再回首页，而是显式 unavailable surface
  - 结果页 `FactionTimeline` 空态文案已改成解释性提示
- preview-driven Chromium `phase3-batch-a full / phase3-batch-b full / phase3-batch-c full` 本轮全绿。
- `e2e-new-source-ingestion-live` 当前在 `fixture full` 和 `live full` 两条口径下都已通过。
  - live 口径当前已覆盖 `web_search_families` 请求体、结果页 web sources、四个 source family card 与 live state 展示；真实 provider 没有可用结果时允许明确的 non-ready state，不再要求每张 family card 都必须有列表项
- focused browser spot-check 当前建议覆盖：
  - CausalReview 节点点击后打开 `NodeConversationSheet`，并带上当前节点摘录
  - KG 工作台桌面节点点击后先出现 `NodeQuickCard`，靠近视口边缘时不会溢出屏幕
  - 需要详情面板的图面仍能正常打开、关闭并恢复焦点
  - `/agents` 在当前 live 栈里继续稳定显示 capability disabled 文案
- preview-driven `zh-CN phase3-batch-a full / phase3-batch-b full` 本轮全绿。
- graph mobile smoke 当前会额外检查 controls 与 mobile navigation hint；viewport 交互从空白画布锚点拖拽开始，并以 `Fit view` 后的 baseline 判断 pan / zoom / reset；`MiniMap` 继续维持桌面限定。
- `phase3-batch-a` 当前也会检查：
  - branch selector 真的发出带 `branch_id` 的请求
  - `/api/scenario/:id` 返回的可读 branch title + probability 确实进了 selector
  - sr fallback list 的 accessible name 按 `/^(Causal events list|因果事件列表)$/` 精确匹配；这条 regex 也会以 `srFallbackListLabelPattern` 导出给脚本契约复用
  - default / `zh-CN` locale 走同一条 fixture 口径
  - 桌面端节点详情打开后，脚本会继续确认 close 按钮可点，并真的等到 detail panel hidden 才判关闭成功
- `phase3-batch-a / batch-b` 的 graph SVG smoke 当前会校验下载文件内容，不只看文件名。
- `phase3-batch-a / batch-b` 的浏览器问题监控当前会按 URL + resourceType 过滤 Google Fonts 外链噪音；不同 locale / 浏览器 runtime 下的外部字体失败不再被记成图谱回归。
- `phase3-batch-b` 的 compare digest fixture 当前会补 `agents / messages`；compare theater smoke 会检查 `agent / message / bubble` 计数都大于 0。
- `phase3-batch-b` 的 `zh-CN` mobile 口径本轮通过。
- `phase3-batch-b` 当前除了 map 容器 / filter smoke，也会检查 argument-map 的强度摘要在 default / `zh-CN` locale 都能定位，以及 `Export SVG`、本地化 verdict 节点标签、节点点击打开详情、详情文本、accepted 状态与关闭动作。
- `phase3-batch-b` 当前会先等 `Argument Map / Load map / verdict node` 真正可见再断言；桌面 WebKit 下的 verdict 节点 smoke 不再靠无效 timeout 的 `isVisible()` 碰运气。
- `phase3-batch-b` 当前还会覆盖 argument-map fail-soft：脚本会在结果页 ready 后走 `Load map / 加载图谱`，再检查错误态是否显示失败文案和 `Retry`，并确认图和导出同时隐藏；mobile 重试口径已稳定。
- `phase3-batch-a / batch-b` 的 summary 当前会按 step 结果重算 `failedTests`；step 失败时，不会再出现 `failedSteps > 0` 但 `failedTests=[]` 的空诊断。
- `phase3-batch-a / batch-b` 当前都支持 `--browser chromium|firefox|webkit` scoped 执行；本轮桌面 Firefox / WebKit 的 `batch-a / batch-b` 都通过。
- `phase3-batch-a / batch-b` 当前都会在真正打开浏览器前先跑共享 `frontendPreflight`：
  - deep-link 必须返回同一份 SPA shell
  - 所有目标路由必须引用同一 entry module
  - 本地 CSS entry asset、inline `nomodule` fallback、Vite legacy polyfill / legacy entry 都必须跨路由一致
  - modern / CSS / legacy 入口资产都必须可达，且 content-type 符合脚本 / 样式预期
  - preview 没 ready、SPA fallback 失效，或任一入口资产不一致 / 不可达时会直接 fail-closed，不再把 404 混成图谱页面回归
- graph-viz 相关构建回归当前也会检查共享 `vendor` chunk，并按 modern / legacy 两套 chunk 名一起核对 `vendor / phaser / capture-html / capture-gif / g6-vendor / i18n-vendor / radix-vendor / dnd-vendor / icon-vendor / pretext`，不再额外要求独立的 `flow-vendor`。
- 关键页面样式当前已补一层 sRGB / rgba fallback：
  - 全局 token 在 `index.css` 里先声明 fallback，再用 `oklch()` / `color-mix()` 覆盖
  - `SimulationView`、`ResultView`、`WorldlineRoundtableView`、`GameplayCardsModal`、`PredictionModal`、`InterventionReceiptCard` 的高流量表面已补关键 fallback
  - gameplay / prediction / receipt 相关 CSS 会在 `prefers-reduced-motion` 下禁用入口、hover 或 slider thumb transform，并在 forced-colors 下显式区分 selected、recommended、disabled 和 silent confidence 状态
  - 玩法卡说明、预测摘要和 receipt agent 名等长文本有 wrap 或 ellipsis containment，避免移动端横向溢出
  - 目的是让旧 Safari / Firefox 在不支持现代颜色函数时仍保持可读
- 字体当前通过 `src/fonts.css` 和 `public/fonts/*.woff2` 本地提供：
  - `index.html` 不再 preconnect 或加载 Google Fonts
  - `font-display: swap` 和 `unicode-range` 会让浏览器按实际文本拉取需要的字体分片
  - 当前字体目录约 200 个 woff2 文件，约 11 MB
- `ResumePanel` 当前会：
  - 先等用户选定来源分支，再加载同 scenario / branch 的 checkpoints
  - 有 checkpoint 时要求用户选中一个 checkpoint；没有 checkpoint 时才回到 round number 输入
  - checkpoint 超过当前 `totalRounds` 会被过滤；选中 checkpoint 后会同步 round number
  - `compressed_summary` 会先解析成可读摘要预览；结构化 JSON 不会直接露给用户
  - checkpoint 加载失败时显示错误反馈，并回到 round number 输入
  - 成功后锁表单并在 500ms 后跳回 `/sim/:id`
  - 对 `429` 统一显示 replay branch 上限提示
- `ResumePanel` 当前有独立 smoke 入口：
  - `frontend/scripts/e2e-phase3-batch-c.mjs`
  - `cd frontend && npm run e2e:resume -- full`
- `e2e-worldline-roundtable-suite` 当前会在 verdict anchored thread 前等待 draft settle；`e2e-ending-room-followup-suite` 当前让 `hotseat / all_present / epilogue` 走 API-driven 口径，`evidence_card` 走真实 UI 抽屉提交，不再靠 mobile `all_present` 的 mode-arm / settled wait 硬等。
- `e2e-ending-room-suite.mjs` 当前已重新回到可用的基础 smoke 口径：
  - picker confirm 先等 `.ending-chat-modal` 挂载，再等 room 进入 usable 状态
  - 如果 `modal_state` 因 room bootstrap / effect cleanup 短暂回到 `null`，脚本会退回 modal UI-ready 判定，不再把它误判成 chamber 没打开
- `e2e-ending-room-followup-suite.mjs` 当前也会在 multi-ending 桌面/移动端链路下额外覆盖：
  - 先 API 预热 `ending_chamber`，再通过 ResultView 调试参数直开 live chamber
  - `hotseat / all_present / epilogue` 由 API 发起；`evidence_card` 由 UI 抽屉点击 `提交证据卡` 发起，并落 `*-evidence-card-ui.json / ui_submission`
  - 两种模式均有截图 + JSON artifact 留档
- `e2e-ending-room-followup-suite.mjs` 当前对 replay coverage 额外做了三层收口：
  - live room page 复用前先 revalidate
  - replay `Copy / Save / Import` 只在 `.ending-chat-header__actions` 内定位
  - readonly replay 必须同时满足 replay URL、Import 可见、composer 不可发
- `e2e-ending-room-followup-suite.mjs` 当前对 replay/import/reload restore 走 fail-closed：
  - 关键字段缺失会直接失败
  - 不再以 best-effort `summary.json` 保底通过
- `e2e-ending-room-followup-suite.mjs` 当前对 `hotseat / all_present / epilogue` 额外做了目标线程验真：
  - 以 `roomId + threadId + interaction_mode` 为准
  - fallback 会优先回到 API-driven / snapshot 校验，而不是只看当前可见线程的局部 `modal_state`
  - live `modal_state` 比 API snapshot 慢一拍时，`epilogue` 不会再因为旧 `turn_count` 被误判成 target-thread 失败
- `e2e-ending-room-followup-suite.mjs full / mobile` 当前更适合专项 follow-up 回归：
  - fixture 选择当前会优先取最新、且 branches 全部 `COMPLETED` 的 `single / multi done scenario`，不再命中陈旧脏数据
  - 当前 fresh rerun 已通过 desktop / mobile
  - 慢 provider 下仍可能只落到 fallback 观测，不一定每次都能抓到完整 lifecycle 工件
  - 基础 smoke 仍以 `e2e-ending-room-suite.mjs full` 为准
- `e2e-ending-room-followup-suite.mjs` 当前也会在命中的 follow-up 场景下额外落：
  - `turn-start`
  - `turn-delta`
  - `turn-commit`
  这些中间态工件，方便直接看 single-ending / multi-ending 的真流式观测。
- 默认 `release-signoff` 当前会把 `corners` 步骤固定到 `SWARM_E2E_FIXTURE_MODE=1`，避免 capture-modes 因短 live window 冷启动抖动而误报失败。
- 默认 `release-signoff` 当前还会纳入前置 gate：
  - `lint`
  - `graph_focused_vitest`
- 默认 `release-signoff` 当前还会串行执行：
  - `phase3_graph_preflight`
  - `script_contracts`
  - `prediction_modal_late_branches`
  - `phase3a / phase3b` 的 default graph smoke
  - `phase3c` 的 result graph smoke
  - `phase3a / phase3b` 的 `zh-CN` graph smoke
  - `phase3a / phase3b` 的 Firefox / WebKit graph desktop smoke
  - `ending_room_followup / ending_room_followup_en`
  - `ending_room_followup_firefox / ending_room_followup_en_firefox`
  - `ending_room_followup_webkit / ending_room_followup_en_webkit`
  - `roundtable_full / roundtable_en`
  - `roundtable_firefox / roundtable_en_firefox`
  - `roundtable_webkit / roundtable_en_webkit`
  - `debate_full / debate_firefox / debate_webkit`
- `single-ending` 的 mobile verdict-anchor thread 当前也走 deterministic 兜底：
  - thread title 每次唯一，避免复用同一 room 时点到旧 thread
  - 如果 UI automation 状态刷新偏慢，脚本会回退到 backend room snapshot 合成可验证状态
  - fallback 也必须命中目标 `threadId + questionAnchorIds`，并至少看到 1 条 assistant reply；不再接受 `state: null` 或只有 user turn 的伪成功
- `e2e-worldline-roundtable-suite.mjs` 当前已补：
  - 更稳的 quote-anchor thread 交互链
  - hotseat settle / anchored send 的慢路径等待
  - desktop 当前覆盖 pointer drag 与 `KeyboardSensor` 键盘拖拽
  - mobile 当前保留真实 touch `tap-to-seat`
  - `--browser chromium|firefox|webkit` scoped 执行
  - 优先复用最近成功的稳定 fixture
  - replay `Copy / Save / Import` 优先走 hero/header action scoped locator，也兼容 `More actions / 更多操作` 菜单
  - live room page 复用前会先做 revalidate；readonly replay 也会校验 replay URL 契约
- `e2e-debate-suite.mjs` 当前会保持 Debate live 阶段地图默认折叠的产品契约；脚本在检查 `.debate-stage-summary-list` 前会点击 `debate-stage-map-toggle` 展开阶段地图。
  - artifact/local readonly replay 都会额外校验 reload restore；缺字段直接失败
  - result -> roundtable 入口当前也会重试；如果还停在结果页，会落 `roundtable-entry-stall.json` 并直接失败
  - 首开、`reseat / drag-to-seat / keyboard reseat / expert witness / selection mode reopen` 当前统一按 `90s` ready budget 等待最终 `has_result=true`
  - hotseat / anchored composer user-turn settle 当前按 `120s` 预算等待，和开桌 ready budget 分开
- roundtable anchored follow-up 的 desktop rerun 当前已能稳定落：
  - hotseat `turn_start / turn_delta / turn_commit`
  - anchored thread `turn_start / turn_delta / turn_commit`
- roundtable 的 `full` 当前仍可能受 provider 慢路径波动影响；如果目标只是 Oracle transcript `P2` 布局签收，当前更稳的口径是：
  - desktop 一份 summary
  - mobile 一份 summary
- roundtable `full` 当前 fresh rerun 已通过 desktop + mobile：
  - 如果入口链路再退化，会直接落 `roundtable-entry-stall.json`
  - transcript 布局专项签收时，desktop / mobile 分端 summary 仍然更快读
- 本轮 2026-04-23 Oracle 回归复验工件：
  - `frontend/output/e2e/20260423-oracle-regression-followup-rerun/summary.json`
  - `frontend/output/e2e/20260423-oracle-regression-roundtable-rerun-v2/summary.json`
- roundtable desktop live room 当前已补一轮轻量可读性收口：
  - 左栏更窄
  - summary card sticky
  - 长摘要走内部滚动
  - transcript 段落行距更松
  - committed transcript 长段默认可折叠
- roundtable replay 的自动化口径当前已修正：
  - readonly replay 下 `interaction_mode` 会跟随 active replay thread
  - mobile artifact replay readonly 不再因为错误暴露 `archivist_route` 而超时
- 最近一次默认本地全链签收工件位于：
  - `frontend/output/e2e/2026-04-14T13-23-55-764Z-release-signoff/summary.json`
- 当前 single-ending Oracle 已额外做过真实浏览器复核：
  - 结果页无 `Start Roundtable / Crossline Gallery`
  - `ending_chamber / one_move_only` 可正常打开
  - single-ending chamber readonly replay 仍可 `import`
  - `Save local read-only copy` 文案与 replay automation 契约一致
  - mobile `390x844` 下 chamber modal 仍能完整落在视口内
- Debate replay/import 当前也已做过真实浏览器复核：
  - `share -> readonly replay -> reload restore -> import` 主链通过
  - desktop Firefox / WebKit scoped regression 通过
  - `?local=` fallback 当前会把分享入口明确显示成 `Save local read-only copy`
  - mobile E2E 打开下注和结果页时只定位 `.debate-primary-cta--rail` 主 CTA，不再误点 rail 内其他按钮
- `pretext` 当前已接到 Oracle transcript 运行时布局内核：
  - `EndingChatModal / WorldlineRoundtableView` 的 bubble `min-height` 预测
  - transcript scroll bottom anchor 稳定化
  - automation payload / E2E summary 当前会带 `transcript_layout`
- `pretext` 当前已扩展到：
  - `InputView`：textarea 高度预测替代 scrollHeight 回流，中英语言切换自动重估（`inputPredict.ts`）
  - P5 文本契约测试矩阵：71 项，覆盖按钮标签 / 卡片标题 / 描述文本 / Oracle 布局 / Share 文案 的中英双语溢出检测（`textContract.test.ts`）
  - Canvas bubble 尺寸预测模块已独立封装（`canvasTextPredict.ts`），当前已正式接入 WorldScene 的 `showBubble()` 方法——预测可用时跳过 Phaser `getBounds()` DOM 调用，不可用时自动回退原路径
- `ResultView` 当前已做 Summary-First 优化：
  - 结局卡默认只显示标题 + 概率条 + insight 引言 + 操作按钮
  - 故事、分歧原因、关键时刻需点击"阅读完整故事"展开；收起时详情区不会保留正文和 key moments DOM，可访问性树也只在展开时看到详情
  - 桌面端 2 列网格布局，主结局（概率最高）跨两列
  - 概率条按区间着色：>60% rose、30-60% amber、<30% gray
  - 关键时刻改为 mini-timeline 视觉化
  - 故事文本限宽 62ch、行高 1.8，提升长文可读性
- `EndingChatModal` 当前已补对话可读性优化：
  - speaker 左侧色标：按参与者 index 自动分配 oklch 颜色
  - 档案官 verdict 消息用高亮卡样式突出
  - transcript 气泡文本限宽 58ch、行高 1.75
  - transcript 列表间距从 12px 增加到 16px
  - transcript bubble 内的操作按钮（"沿这句追问 / 另开线程"）当前有上边框分隔线，颜色加深为 `oklch(45% 0.2 350)` + 700 加粗，确保在浅色气泡背景上可读
  - `onAutomationStateChange` 回调改用 `useRef` 稳定引用，修复了 "Maximum update depth exceeded" 循环渲染问题
  - automation effect 当前会对输出 payload 做 JSON 去重，相同状态不重复上报（只在 modal 关闭或 unmount 时清空快照）
- `WorldlineRoundtableView` 圆桌 transcript 当前已补：
  - 按 phase 分组的视觉分隔线（`<h3>` 语义标签 + 渐变横线 + phase label）
  - 每条发言左侧色标（5-hue oklch 调色板，与 EndingChatModal 一致）
  - 档案官发言使用 `--oracle-accent` 跟随主题皮肤变化
  - 移动端分隔线 label 有 `text-overflow: ellipsis` 防溢出
- 贴图修复：`/assets/ui/generated/` 下的 1408x768 AI 全景图引用大部分已替换为 CSS gradient / box-shadow，涉及 EndingChatModal.css、WorldlineRoundtable.css、ResultView.css 共 15 处；ResultView 因果档案区域已改回使用 `scenario.scene_theme` 对应的场景图（带半透明渐变遮罩）
  - speaker glow → `radial-gradient`
  - archivist emblem → `conic-gradient`
  - oracle chamber panel → `repeating-linear-gradient` 细条纹
  - dossier divider → `linear-gradient` 渐变线
  - influence badge → `radial-gradient` 圆点
  - `daily_challenge_panel.png` 保留原图（`object-fit: cover` 裁切效果尚可）
- 交互动效当前已补：
  - PredictionModal：modal 入场、confidence badge 颜色反馈、成功脉冲、提交 shimmer
  - GameplayCardsModal：卡牌选择弹跳 + icon pop、未激活灰化
  - InterventionModal：模式选择弹跳、模板标签微交互
  - EndingChatModal：bubble 入场动画、anchor 高亮、线程切换过渡、idle 粒子
  - WorldlineRoundtable：idle 环境粒子
  - 所有新增动画均有 `prefers-reduced-motion: reduce` 覆盖
- `ResultView` 的 `endingRoomAutomation` 当前使用 `useRef` 而不是 `useState`。原因：EndingChatModal 的 automation effect 每次 deps 变化都会生成新对象并调用 `onAutomationStateChange`。如果用 `useState`，每次调用都会触发 ResultView 重渲染，形成 "store→effect→setState→re-render" 循环（190+ "Maximum update depth exceeded" error）。改为 `useRef` 后回调写入 ref 不触发渲染，`render_game_to_text()` 在调用时通过 `ref.current` 读取最新值。
- `themeRegistry.ts` 当前 `GameplayProfileId` 包含 18 种：`governance / war / empire / industry / trade / law / faith / ecology / frontier / mythic / survival / finance / scholar / medical / technology / entertainment / diplomacy / generic`。
  - 展示名以 shared gameplay contract 为准；首页轻量 summary 与 contract 同步，未知值回退到 `generic`。
  - 新增的 6 种 profile（`finance / scholar / medical / technology / entertainment / diplomacy`）现在均有各自专属 card frame PNG（通过 Gemini Image API 生成），不再复用其他 profile 的素材。
  - 新增 11 个主题场景入口（`finance_exchange / cyber_market / medical_institute / academy_hall / tech_campus / arena_colosseum / concert_hall / media_tower / diplomatic_summit / underground_network`）。
  - 当前全部 33 个主题场景（含变体）均已有专属 PNG 素材（512x288 像素风），无占位图。
  - `inferSceneThemeFromQuestion()` 通过关键词匹配自动路由到新主题。

## 设计 Token 体系

- 全局 token 定义在 `frontend/src/index.css` 的 `:root` 中（OKLCH 色彩空间）。
- 当前包含：背景色、主色、语义色、文本色、边框、阴影、圆角、字体栈、流体文本尺度、过渡曲线、间距缩放、z-index 层级、状态 badge 色、Oracle 暗色覆层 token。
- GBC 像素风 token 在 `frontend/src/game/game.css` 中独立定义。
- Oracle 皮肤（按 gameplay profile 动态切换）在 `WorldlineRoundtable.css` 和 `EndingChatModal.css` 中通过 `.oracle-skin--{id}` 类选择器覆盖。
- 结果页押注 badge 颜色已迁移到 CSS 变量（`--color-success-bg` / `--color-danger-bg` 等），不再硬编码 hex。

## 查找路径

- 查页面入口：`frontend/src/pages/*`
- 查页面 helper：`frontend/src/pages/*Helpers.ts`
- 查组件 helper：`frontend/src/components/*Helpers.ts`
- 查 store：`frontend/src/stores/*`
- 查 lib/helper：`frontend/src/lib/*`
- 查 hooks：`frontend/src/hooks/*`
- 查 Theater：`frontend/src/game/*`
- 查设计 token：`frontend/src/index.css`
- 查开发/签收命令：`llmdoc/guides/development.md`
