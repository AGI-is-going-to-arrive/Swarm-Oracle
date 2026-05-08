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
| InputView | `frontend/src/pages/InputView.tsx` | scenario 创建、BYOK、quick starts、challenge、主模式档位、搜索增强 toggle、可选 `Organization ID`、`沿用服务器默认 / 自定义覆盖` 切换、identity continuity preflight / confirm dialog |
| AgentLibrary | `frontend/src/pages/AgentLibrary.tsx` | 自建 Agent 列表、tier badge、profile modal、编辑/删除入口 |
| AgentWorkshopView | `frontend/src/pages/AgentWorkshopView.tsx` | 自建 Agent 创建/编辑，包含 knowledge domains 与 `IMPORTANT / CROWD` tier 选择 |
| SimulationView | `frontend/src/pages/SimulationView.tsx` | live 推演、Theater、干预、玩法卡、押注、capture |
| ResultView | `frontend/src/pages/ResultView.tsx` | 结局对比、archive、campaign summary、分享、导出、replay/import、真实世界来源卡片、counterfactual / resume / faction 入口，以及 capability-gated `Explore Deeper` bridge |
| CompareDigestView | `frontend/src/pages/CompareDigestView.tsx` | 反事实对比页；单活跃 Theater、shared round selector、digest compare、pane screenshot capture |
| DebateArenaView | `frontend/src/pages/DebateArenaView.tsx` | debate live |
| DebateResultView | `frontend/src/pages/DebateResultView.tsx` | debate result、share、replay/import |
| WorldlineRoundtableView | `frontend/src/pages/WorldlineRoundtableView.tsx` | 世界线圆桌 live/replay |
| HistoryView | `frontend/src/pages/HistoryView.tsx` | scenario 历史列表 |
| LeaderboardView | `frontend/src/pages/LeaderboardView.tsx` | prediction leaderboard |

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

## 实时链路

- scenario live：`useSimulationWS`
- debate live：`useDebateWS`
- ending room / roundtable：各自独立 WS hook + store

当前约束：

- 前端会按 `sequence / event_id` 做重复丢弃与时序修正。
- store 负责保持 phase/branch 状态单调，不让旧事件覆盖新状态。
- `simulationStore` 的消息去重集（`seenMessageKeys`）按 scenario ID 隔离，切换场景时自动重置，避免跨场景 hash 碰撞。
- `useSimulationWS` 在 `scenarioId` 为空或 `ready` 为 false 时不会发起连接；重连使用 `connectRef` 模式防止闭包过期；初始连接也会调用 `requestScenarioResync` 补拉状态（与 `useEndingRoomWS` 行为对齐）。
- 三个 WS hooks 均支持首帧 auth：如果 `localStorage` 有 token，`onopen` 时发送 `{"type":"auth","token":"..."}`，收到 `auth_ok` 后才触发 resync；无 token 时直接 resync（兼容 auth 未开启场景）。
- 三个 WS hooks 对 `4001`（认证失败）和 `4404`（资源不存在）不进行自动重连；`1006`（异常断连）照常重连。
- `useAgentConversationWS` 当前也已对齐同一套 WS 契约：
  - 前端实际连接路径是 `/ws/agent-conversation/{thread_id}`
  - 不再误连旧的 `/api/ws/agent-conversation/{thread_id}`
  - 首帧 auth、`auth_ok`、`4001 / 4404` 非重连口径与另外三条 WS 保持一致
- `useEndingRoomWS` 与 `useAgentConversationWS` 当前都按同源 `window.location.host` 组装 WS host，不再写死本地 dev backend 端口；ending-room live room 当前实际连接 `/ws/ending-room/{room_id}`，不再从前端走旧的 `/api/ws/...` 路径；`19030 -> 19027` 这类 preview/backend 组合下，ending-room / roundtable live 更新也能正常跟上。
- REST API 路径参数统一使用 `encodeURIComponent()` 编码（约 30 处），防止含特殊字符的 ID 破坏 URL 结构。
- API client 当前会把首页高级设置里的可选 `Organization ID` 以 session-scoped `X-Org-Id` 请求头透传；留空时不发送。
- API 客户端对服务端错误文本做脱敏处理（`sanitizeErrorText`），超过 200 字符或包含 stack trace / HTML 的响应会被替换为通用错误信息。
- `ResultView` 当前新增 `Explore Deeper` bridge：
  - capability ready 后才渲染
  - `causal / replay / compare / workbench` 四张卡共用同一套 bridge 样式
  - workbench 卡片当前指向因果、知识图谱和节点追问同一视图
  - disabled 卡片保留 link 语义，但不再渲染无 `href` 的 `<a>`
  - disabled 状态改成 dashed border + icon grayscale，文字对比不再靠整卡 opacity 压低
- `ResultView` 的 faction timeline lead 当前已走 i18n key + `{{title}}` 插值，不再在组件里手写 `isZh` 三元文案。
- `ResultView` 的 replay/import 错误、ending-room replay action、archive summary label 和 ending-room picker copy 当前也已走 locale key；剩下的 `isZh` 用在玩法/候选人/弹窗语言选择这类领域语义上。
- `ResultView` 当前仍是大文件；source family 里重复的 finance card 已抽成 `FinanceSourceCard`，后续新增 UI 仍应优先抽组件。
- InputView 当前在 `agent_identity` capability 开启时会在主模式启动前先调用 identity continuity preflight：
  - 只要命中 `L2 fuzzy candidate` 才会弹确认框
  - 用户可选 `复用已有身份` 或 `创建新身份`
  - preflight 失败时会阻断启动并显示错误，不会静默绕过确认
- InputView 当前也会在 `custom_agents` capability 开启时显示 Agent attach panel：
  - 选中的自建 Agent 会通过 `customAgentIdentityIds -> custom_agent_identity_ids` 传给主推演
  - 创建 Debate 时，会把当前选中的前 2 个自建 Agent 透传成 `customAgentIds -> custom_agent_ids`
  - 这条链路只传 identity id，不引入 URL 或外部 fetch 配置

## Theater 与性能边界

- Pixel Theater 运行时在 `frontend/src/game/`。
- `PhaserGameLoader` 负责按需加载 Theater。
- screenshot / GIF capture runtime 已拆分，不进入默认首包。
- 主题、素材与 UI asset 路径的单一事实源位于 `themeRegistry.ts`。
- Theater 当前布局采用 canvas-first 浮动 HUD 方案：
  - Phaser canvas 以 `position: absolute; inset: 0` 填满整个舞台区域
  - 控制面板（header / status / director / filters / timeline）浮动在 canvas 上方，使用 `backdrop-filter: blur(12px)` 半透明叠加
  - 移动端（≤900px）降级为实色半透明背景（`rgba(18, 16, 38, 0.95)`），避免多层 blur 导致帧率下降
  - Theater 背景色从固定 `#06061a` 改为 `--oracle-bg-dark`，支持主题皮肤过渡
- Theater 气泡当前行为：
  - 最大同时可见气泡数 = `min(agentCount, 8)`，根据场景内 agent 数量动态计算
  - compact 模式（canvas 宽 < 360px，即真手机端）下最多 2 个，气泡固定在画面底部中央（底部安全间距从 104px 增加到 160px，避免被浮动 HUD 遮挡）
  - 非 compact 模式下气泡跟随各自 agent 头顶显示
  - 气泡文字统一为 16px / 700，不再按 compact / replay 区分字号
  - 气泡换行宽度从 180-240px 增加到 220-300px
  - 文字渲染分辨率 = 4x
  - compact 模式下文字增加了描边（`strokeThickness: 1.5`）和阴影（`blur: 2`）以提升暗色背景上的可读性
- Theater Agent sprite 当前采用动态缩放：
  - 尺寸 = `max(40, Math.min(width, height) * 0.055)` 宽，保持 2:3 宽高比
  - 阴影、名牌、faction bar 位置跟随 sprite 尺寸自动计算（`spriteH` 存储在 `AgentSpriteData` 中，各处统一使用 `spriteH * 0.5 + 2` 作 Y 偏移）
  - 阵营聚拢动画：`viz:faction_cluster` 事件驱动，对象池 flash、命名常量、tween 预算限制、reduced-motion snap
  - 原始 640×640 PNG 素材的宽高比不会因为 canvas 比例变化而拉伸

## 关键模块

| 模块 | 位置 | 责任 |
|------|------|------|
| `themeRegistry.ts` | `frontend/src/lib/themeRegistry.ts` | Theater / Debate / Oracle 资产注册表；当前包含 18 个 gameplay profiles 与 44 个主题场景 |
| `emotionColors.ts` | `frontend/src/game/constants/emotionColors.ts` | 情绪-光环颜色映射共享常量（PhaserGame 和 VizSynthesizer 共用） |
| `scenarioAuthority.ts` | `frontend/src/lib/scenarioAuthority.ts` | 主模式 authority 合流入口 |
| `scenarioGameplayState.ts` | `frontend/src/lib/scenarioGameplayState.ts` | gameplay_state 映射与判等 |
| `scenarioDirectorState.ts` | `frontend/src/lib/scenarioDirectorState.ts` | director_state 映射 |
| `predictionBetting.ts` | `frontend/src/lib/predictionBetting.ts` | 结构化押注 helper |
| `gameplayContract.ts` | `frontend/src/lib/gameplayContract.ts` | 共享玩法契约消费层 |
| `roundtableSelection.ts` | `frontend/src/lib/roundtableSelection.ts` | `trait_mix / fault_line_first / witness_augmented` 选择辅助与测试入口 |
| `endingRoomReplayAutomation.js` | `frontend/src/lib/endingRoomReplayAutomation.js` | ending-room replay URL 判定 helper；当前识别 `roomReplay / roomShare / roomLocal`，并复用 live modal / readonly UI 判定；replay action 文案兼容 `Save copy / 保存副本` 与 `Import run / 导入运行` |
| `roundtableReplayAutomation.js` | `frontend/src/lib/roundtableReplayAutomation.js` | roundtable live / readonly replay automation payload 判定 helper |
| `endingRoomPickerAutomation.js` | `frontend/src/lib/endingRoomPickerAutomation.js` | 结果页 ending-room picker 的 DOM-first 打开 helper 与 UI-ready 判定 |
| `endingRoomStore.ts` / `worldlineRoundtableStore.ts` | `frontend/src/stores/` | ending-room / roundtable 状态；`worldlineRoundtableStore` 是 `endingRoomStore` 的 re-export |
| `textLayout/*` | `frontend/src/lib/textLayout/` | `pretext` helper、Oracle transcript layout kernel、overflow contract、Input 面高度预测 (`inputPredict`)、Canvas bubble 预测 (`canvasTextPredict`)、P5 文本契约测试 (`textContract.test`) |
| `useTranscriptScroll.ts` | `frontend/src/hooks/useTranscriptScroll.ts` | `EndingChatModal` 与 `WorldlineRoundtableView` 共享的 transcript scroll 锚定 hook |
| `roundtableHelpers.ts` | `frontend/src/pages/roundtableHelpers.ts` | 圆桌纯函数：选型模式、锚点构建、fault-line 算法、anchor 描述 |
| `endingChatHelpers.ts` | `frontend/src/components/endingChatHelpers.ts` | 会客厅纯函数：角色标签、模式标签、prompt 构建、anchor 描述 |
| `resultHelpers.ts` | `frontend/src/pages/resultHelpers.ts` | 结果页纯函数：押注 badge、campaign cache、badge copy |
| `simulationHelpers.ts` | `frontend/src/pages/simulationHelpers.ts` | 推演页纯函数：Theater 场景/天气/时间标签、预热检测 |
| `PostVerdictPanel.tsx` | `frontend/src/pages/PostVerdictPanel.tsx` | completed live roundtable 的 `Deep Dive` 面板；聚合 participant-scoped `1-on-1 Interview`、`Research Analyst` 与 `Cross-Examine` |
| `RoundtableAgentChat.tsx` | `frontend/src/pages/RoundtableAgentChat.tsx` | 圆桌 post-verdict 的 `1-on-1 Interview`；按 participant 维护独立 conversation thread |
| `AnalystStreamView.tsx` / `SurveyStreamView.tsx` / `postVerdictCaches.ts` | `frontend/src/pages/` | post-verdict analyst / survey 的独立流式 UI、缓存与 context reset |
| `useRoundtableSseStream.ts` | `frontend/src/hooks/useRoundtableSseStream.ts` | roundtable analyst / survey 共享 SSE hook；负责 POST stream、frame 解析、timeout 与 abort |
| `manualChunks.ts` / `performanceBudgetConfig.mjs` | `frontend/src/lib/manualChunks.ts` / `frontend/scripts/lib/performanceBudgetConfig.mjs` | 前端构建分块与预算门禁单一事实源；React 保留在共享 `vendor`，`@antv/*` 隔离到 `g6-vendor`，`html2canvas / gif.js` 按需拆分，React Flow 栈继续走 Rollup 自动分块并纳入预算检查 |
| `useG6Graph.ts` | `frontend/src/hooks/useG6Graph.ts` | G6 图谱 hook；等 ref-backed container 真正挂载后再建图，支持 options 更新、ResizeObserver resize、node click 订阅清理 |
| `useNodeConversationTransport.ts` | `frontend/src/hooks/useNodeConversationTransport.ts` | `NodeConversationSheet` 的本地 transport hook；负责 `/start` / `/turn` 请求、origin branch/round/node/excerpt 透传、AbortController 生命周期和 SSE frame 解析 |
| `orgContext.ts` / `useOrgContext.ts` | `frontend/src/lib/orgContext.ts` / `frontend/src/hooks/useOrgContext.ts` | 首页 `Organization ID` 的 sessionStorage 单一事实源；InputView 与 API client 共用，避免 header 逻辑散落 |
| `frontendPreflight.mjs` | `frontend/scripts/lib/frontendPreflight.mjs` | 前端 preview / deep-link 预检 helper；graph E2E 与 `release-signoff` 当前共用它来校验 SPA shell、一致的 module/CSS/legacy 入口，以及入口资产可达性 |
| `e2e-new-source-ingestion-live.mjs` | `frontend/scripts/e2e-new-source-ingestion-live.mjs` | source-ingestion 专项脚本；默认走 fixture，`SWARM_E2E_MODE=live` 时走真实 backend。live 模式会先显式打开首页总开关，校验 `/api/scenario` 请求里的 `web_search_families`，再检查结果页四个 source family 的 live/non-empty 卡片；`Polymarket` 的 `non-us` geo-gate 也走同一条 live 口径 |
| `e2e-capability-matrix.mjs` | `frontend/scripts/e2e-capability-matrix.mjs` | graph/playability capability matrix；当前覆盖 `AgentWorkshop / AgentLibrary / CausalReview / CompareDigest / KGExplorer / ReplayView` 六个 gated route，fixture payload 也包含 `agent_conversation / kg_explorer / replay_trace`。`ReplayView` 的 disabled 路径现在会落显式 unavailable surface，不再回首页；如果脚本还按旧 redirect 口径断言，先同步脚本再跑 |
| `e2e-ws-contract-suite.mjs` | `frontend/scripts/e2e-ws-contract-suite.mjs` | WS 契约诊断脚本；当前覆盖 `scenario / debate / ending-room` 的首帧 auth、`4001 / 4404` 非重连、`1006` 可重连、auth timeout、oversize auth frame 和 pending-auth limit |
| `compatUuid.ts` | `frontend/src/lib/compatUuid.ts` | 兼容 UUID helper；优先 `crypto.randomUUID()`，再退 `getRandomValues`，最后才走时间戳兜底 |
| `PipelineStepper.tsx` | `frontend/src/components/PipelineStepper.tsx` | `/sim/:id` 与 `/result/:id` 的 fixed-bottom pipeline progressbar；error 状态下 `aria-valuenow` 会钳到有效范围 |
| `ResultConversationWidget.tsx` | `frontend/src/components/ResultConversationWidget.tsx` | 结果页轻量追问入口，复用 `NodeConversationSheet`；replay 结果页不渲染这条 live-only 入口 |
| `graphTokens.ts` | `frontend/src/lib/graphTokens.ts` | 图谱视觉 token 单一事实源：颜色、边样式、图标、graph i18n key |
| `GraphNodeCard.tsx` | `frontend/src/components/GraphNodeCard.tsx` | `CausalReviewView` / `ArgumentMap` 共用的 ReactFlow 节点卡；当前已改成可键盘聚焦的 button 口径 |
| `NodeDetailPanel.tsx` | `frontend/src/components/NodeDetailPanel.tsx` | 两个图面的共用节点详情侧栏；显示 type / round / payload / unit details |
| `NodeContextBanner.tsx` | `frontend/src/components/kg/NodeContextBanner.tsx` | `NodeConversationSheet` 的来源摘要卡；显示 node type、round、agent、label 和截断 excerpt |
| `NodeQuickCard.tsx` | `frontend/src/components/workbench/NodeQuickCard.tsx` | KG 工作台桌面节点快览卡；按视口钳位位置，避免靠边节点把卡片挤出屏幕 |
| `e2e-web-search-suite.mjs` | `frontend/scripts/e2e-web-search-suite.mjs` | 首页搜索增强专项 E2E：custom override、provider/key/base URL、scenario 请求体校验 |
| `RoundtablePickerPanel.tsx` | `frontend/src/pages/RoundtablePickerPanel.tsx` | 圆桌代表选型面板组件（6 种模式 + 证人选择；桌面端 `@dnd-kit/core` 入席交互，移动端保留 click-to-seat） |
| `RoundtableTranscriptList.tsx` | `frontend/src/pages/RoundtableTranscriptList.tsx` | 圆桌 transcript 列表组件（turns + drafts + 折叠/锚点操作 + phase 分隔线 + speaker 左侧色标） |

## 当前边界

- 前端交付目标仍是浏览器端，不维护原生壳约束。
- `follow-up` 体验已经可用，但与经典模式的完整流式一致性仍在继续收口。
- InputView 当前会把 continuity 确认结果按 request-scoped `continuityOverrides` 传给 `POST /api/scenario`，只影响这次启动，不改本地缓存身份。
- Agent Library / Workshop 当前按 `custom_agents` capability gate 显示：
  - Workshop 的 tier selector 使用原生 radio 语义，选项固定为 `IMPORTANT / CROWD`
  - 编辑旧 Agent 时会把后端返回的 `preferred_tier` 回填；缺失或未知值回退为 `IMPORTANT`
  - knowledge domains 优先读取后端解析后的数组，旧 payload 只带 JSON 字符串时再本地 parse，解析失败显示为空
  - Library card 显示 tier badge 和 domains；空库会给出创建入口
  - 这些页面新增样式集中在共享 BEM class 和 editorial token 上，不使用新增 inline style
- InputView 高级设置当前支持可选 `Organization ID`；值会写进 sessionStorage，并由 API client 自动映射成 `X-Org-Id`。清空输入时会同步移除该请求头。
- InputView 的搜索增强当前口径：
  - `VITE_ENABLE_WEB_SEARCH=true` 时就显示 toggle，不再要求服务端默认搜索已就绪
  - `GET /api/capabilities` 只决定 `沿用服务器默认` 是否可选，不决定整个 section 是否显示
  - `沿用服务器默认` 模式只发送 `webSearchEnabled=true`
  - `自定义覆盖` 模式才发送 `webSearchProvider / webSearchApiKey / webSearchBaseUrl`
  - 4 个 source family toggle 当前会把勾选结果透传成 `webSearchFamilies -> web_search_families`
  - disabled 的 source family 当前会保留可见项，并显示跟随当前 UI 语言的 tooltip，不再回落成英文硬编码
  - 输入搜索 API key / base URL 时不再反复重打 capability 探针
- `useCapabilityCheck` 当前会复用同一份 `/api/capabilities` 结果：
  - 多个组件同时 mount 时不会再各自重打一遍同样的请求
  - consumer 现在能区分 `loading / enabled / error`
  - capability 请求失败时不再直接伪装成 `enabled=false`
- ResultView 当前除了折叠的 `真实世界来源` 入口，也会按 `web_search_context.family_context` 渲染四张 source family card：
  - 被选中的 family 才会变成 `ready`
  - 未选中的 family 会保持 `empty`
  - `polymarket.configured_host=non-us` 时会显示 geo-gated placeholder
- `SimulationView` 的 automation payload 当前已补：
  - `thinkingAgentCount`
  - `thinkingAgents`
  - classic live-fork fixture 已能直接观测“谁正在说话前的 thinking 态”
- `SimulationView` 的默认 director objectives 只在后端和本地 meta 都没有 objectives 时补一次；seed key 按 `scenario / question / gameplay profile / signature card` 计算，避免同一局反复 backfill。
- `PredictionModal` 当前在 branch list 晚到时会自动把默认目标补齐：
  - 如果 modal 打开时还没有可押世界线，UI 会先临时回退到 `ending_tone`
  - 只要后续收到可用 `ACTIVE` branch，就会自动切回 `branch_winner`，并选中当前仍有效的默认 branch
  - 如果用户已经手动改选了一个仍然有效的 branch，提交时会继续用用户当前选择；commitment branch 只作为默认兜底，不会把用户已选目标强行改回去
  - 提交给 backend 的 structured prediction text 仍按 500 字符预算；textarea 会先扣掉下注元数据占用的长度，超限时显示本地化错误
  - 对应的 `predict-late-branches` fixture 当前会先采 `before` 工件，再放出 late branch 事件；`before` 态应保持 `ending_tone`，`after` 态才切到 `branch_winner`
- `GameplayCardsModal` 的 directive textarea 只在桌面 fine pointer 环境自动聚焦；手机和粗指针设备不会自动弹出键盘。
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
- `ReplayView` 当前在 `replay_trace` capability 关闭时会显示显式 unavailable surface，不再 silent redirect 到首页；如果 capability 探针自己失败，也会给出单独的 retry surface。trace 计数标签当前用静态本地化 copy（`Frame / Branches`、`帧 / 分支`），不会再把 `{{count}}` 模板串露到页面上。
- `KGExplorerView` 当前会把 capability 失败、feature disabled、graph fetch 失败分开显示；graph fetch 失败时会清掉旧图，再给出本地化错误和 retry。主图用真实 G6 canvas 渲染，minimap 是 G6 minimap plugin，不是占位卡片；search / type filter 会更新图数据本身。点击节点时，`NodeConversationSheet` 收到的是业务 `kgType`、节点 label、branch 与 round，不再使用 G6 shape type。
- `WorkbenchView` 当前三种 tab 的能力门槛分开判断：`graph` 只要求 causal graph，`kg` 只要求 KG capability，`split` 才要求两者都可用。结果页的 workbench bridge 会把当前 analysis branch 写进 query，进入工作台后仍可保留同一条分析分支语义。
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
  - mobile sidebar sheet 已补 `SheetTitle / SheetDescription`；第一次 `Escape` 只关闭 sheet，不会误关外层 chamber
- `NodeConversationSheet` 当前也复用 `SheetTitle / SheetDescription` 作为单一无障碍描述来源，不再手工覆写 `aria-labelledby / aria-describedby`，Radix 下不会再打缺 description 警告。桌面端现在按 non-modal 右侧 sidecar 挂载，移动端仍是 modal bottom sheet；有 origin 时会显示 `NodeContextBanner`，让用户看到当前追问来自哪个节点、哪一轮和哪段摘录。节点对话的本地 transport 现在收口在 `useNodeConversationTransport.ts`：sheet unmount 会 abort 活跃请求，`/start` 和 `/turn` 会透传 origin branch / round / node / excerpt，SSE parser 也已兼容 multiline `data:` frame。bootstrap start 当前带 epoch guard；关闭或切换节点后的迟到 start response 不会再把旧 thread 写回当前 sheet。公共会话状态机在 `turn_completed / turn_error / abort` 之后会忽略迟到 delta，并用 committed turn 计数驱动结果页 deepen hint；不会再把 ghost 文本重新刷回 bubble 或 aria-live。结果页追问会使用 result context 的标题、说明和空态问题，不再套用“选择图节点”的文案。
- `DebateArenaView` 当前只允许在 live 当前 phase 的下注窗口打开/提交 quick counterplay；锁到历史 phase 时不再发起 counterplay。
- `DebateArenaView` 当前在“当前 live phase”视图下会保留更早 phase 的已出现 turns，并以 `FoldableTurn` 历史卡形式继续展示；切到历史 phase 时仍只显示该 phase 自己的 turns。
- Debate 的页面级播报当前只保留 phase cue；`SpotlightTurnCard` 的高亮态不再单独暴露 live-region 语义，避免同一轮变化在读屏器里重复播报。
- `WorldlineRoundtableView` 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程（当前会覆盖返回的全部 `phase_insights`，不再只限前 3 条）
  - phase insight 展示和 phase prompt 预填会先压成长段 commentary 的第一句；如果标题已经包含同一句，preview 不再重复显示。
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
- `Deep Dive` 只在 live completed room 打开。roundtable replay 继续保持只读，只恢复 transcript / thread / share / import，不重新开放 chat、analyst 或 survey 这类 live 工具。
- `1-on-1 Interview` 的请求失败、空响应或 stream error 当前显示为独立 `role=alert` 错误提示，不再追加成代表自己的气泡。
- post-verdict 工具当前有独立于 room composer 的流状态与缓存：`PostVerdictPanel` 持有 tab / analyst / survey state，result context 变化时会 reset cache 并 abort in-flight stream；`AnalystStreamView` 与 `SurveyStreamView` 共享 `useRoundtableSseStream` 处理 SSE。
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
  - 隐藏 `ResultConversationWidget` 和结果追问 action card
  - 保留本地导入、只读分享与 permalink 相关动作
  - 保留 replay-safe 的 `causal graph` 入口
  - 保留按当前展开分支切换的 `FactionTimeline`
  - 继续隐藏 live-only 的 `CounterfactualPanel / ResumePanel`
- `ResultView` 的结局详情当前只在展开时挂载：
  - 收起时不会再把完整 story / key moments 留在 DOM 或可访问性树里
  - 展开按钮也不会再保留指向已卸载详情节点的悬空 `aria-controls`
- `DebateResultView` 当前把 argument map 改成按需加载，并放回主结果壳内对齐：
  - 首屏只显示 `Load map / Hide map` 按钮和提示文案，不会默认把 React Flow 一起挂上来
  - 只有用户真正点开后才渲染 `ArgumentMap`，主要是为了减少结果页首屏额外开销
- `ArgumentMap` 的节点对话当前需要调用方显式提供 `conversationScenarioId` 才会打开 `NodeConversationSheet`；`DebateArenaView` 和 `DebateResultView` 现在都传 `null`，所以 debate argument-map 节点暂时不会直接起对话，等真实 scenario id 接通后再开放。
- `CausalReviewView` 的节点点击当前会同时打开详情和节点对话；节点对话固定传真实 `scenarioId`，`identityId` 保持为空，不再走假 id 或占位值。
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
- `ResultView` 当前在 `custom_agents` capability 开启时会显示 Agent Library bridge；这条入口只受 `custom_agents` gate 影响，不再误绑到 `agent_identity` gate。
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
- `CausalReviewView` 的错误页当前提供 `Retry`，成功重拉后不会残留旧错误态；错误文案会按 `network / branch_not_found / unauthorized / server / load_failed` 映射到本地化 copy，不再把原始 `HTTP 404` 或后端 message 直接露给用户。
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
  - guide 会显示 full-graph 概览、key nodes 和说明文案
  - close / show 两个按钮都带完整 disclosure `aria-expanded / aria-controls`
  - key nodes 的可见标签会按近似显示宽度压短；完整 `label (degree)` 仍保留在 `aria-label / title`
  - guide / empty-state 文案当前集中走组件内 `CAUSAL_COLORS` dark-surface token，不再把正文直接压到低对比颜色
- `CausalReviewView` 与 `ArgumentMap` 当前只会在图结构真的变化后重新 `fitView()`；search / status filter / branch 切换仍会重算视口，但选中节点或取消选中不会再把视口强制拉回去
- `CausalReviewView` / `ArgumentMap` 的图节点、边、handle 可访问文案，以及 React Flow controls / `MiniMap` 文案当前都会跟随 UI 语言实时更新；切语言不会重打图请求。
- `CausalReviewView` / `ArgumentMap` 的 `MiniMap` 当前是非交互 overlay（`pointer-events: none`），只在桌面显示；移动端不再和图操作抢热区。
- 两个图面当前除了 node/unit 的 sr fallback list，也会额外输出本地化 relation list；因果图会保留 `causes / precedes`，`ArgumentMap` 会区分 `supports / rebuts / accepts / rejects / leaves unaddressed`，边语义不再只剩颜色和箭头。edge evidence 的 `low / medium / high` 也会走本地化文案，不再把 `[medium]` 这类原始值直接露出来。
- `ArgumentMap` 当前在筛选结果为空时会保留筛选 chips 和 `Clear`，同时显示空态文案，不会把用户困在空态里；但这个空态只在当前图本来就有 `units` 时才会出现，node-only 图不会被状态筛选误筛成空白面板。
- `ArgumentMap` / `NodeDetailPanel` 当前继续支持显示 `rejected` 状态；前端视觉 token 与后端合法状态口径已重新对齐
- `ArgumentMap` 当前把 `verdict` 节点也接到共享 graph i18n label；节点可访问名称会跟随当前语言。
- `ArgumentStrengthMeter` 当前按本地化 `list / listitem` 摘要语义渲染，不再使用 `meter`；状态筛选激活时，摘要也会跟着当前可见 `units` 一起更新，不再继续显示全量分布。
- `ArgumentMap` 当前在 compact viewport 下也会保留显式 controls 与本地化 mobile navigation hint；`prefers-reduced-motion` 下会关闭边动画、强度条宽度过渡和节点卡片 dim 过渡。
- `ArgumentMap` 与 `CausalReviewView` 的节点详情打开文案当前已走 i18n；screen-reader fallback 和 text fallback 不再把 `event / claim / standing` 这类原始 token 直接露给用户。
- `ArgumentMap` 当前在 node-only 图（有节点、没 units）时，仍会保留 screen-reader fallback list；图节点 button 口径也继续支持键盘打开详情。
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
- frontend full vitest 本 session fresh rerun：`165 files / 1790 passed`。
- frontend i18n key + placeholder parity：`1621 = 1621`，通过。
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
  - live 口径当前已覆盖 `web_search_families` 请求体、四个 source family 非空卡片，以及 `Polymarket us / non-us` 两条 geo-gate 路径
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
  - `SimulationView`、`ResultView`、`WorldlineRoundtableView` 的高流量表面已补关键 fallback
  - 目的是让旧 Safari / Firefox 在不支持现代颜色函数时仍保持可读
- `ResumePanel` 当前会：
  - 只在用户已选分支且 round 为有效整数时允许提交
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
