# SwarmOracle — 项目概览

> 文档类型：L0 current-truth
> 作用：描述当前产品范围、交付边界与阅读入口。历史实现流水保留在 `implement/` 与 `progress.md`。

## 项目定位

SwarmOracle 是一个 `AI What-If Prediction Playground`：

- 用户输入一个历史或假设性问题。
- 系统生成多 Agent 推演与分支时间线。
- 前端以 Pixel Theater、结果卡、押注与 replay 形式展示不同世界线。

## 当前产品面

### 主模式

- 首页创建 scenario，支持 agent/rounds、BYOK、玩法档位、quick starts，以及 opt-in 的搜索增强推演。
- 搜索增强当前在首页有两档入口：
  - `沿用服务器默认`：直接复用服务端默认 provider
  - `自定义覆盖`：当前局单独指定 `provider / API key / base URL`
- 首页高级设置当前还支持可选 `Organization ID`；值只在当前浏览器 session 内保存，并随请求头 `X-Org-Id` 透传，留空就不发送。
- 当 `agent_identity` capability 开启时，首页会在主模式启动前先跑 continuity preflight；只有命中 L2 fuzzy candidate 时才弹确认框，用户可选 `复用已有身份` 或 `创建新身份`。
- `SimulationView` 负责 live 推演、Theater、干预、玩法卡、结构化押注与 capture。
- `ResultView` 负责结局对比、`counterfactual compare / resume / faction timeline`、档案、campaign summary、分享、导出、结果追问与 replay/import；当后端写入 `web_search_context` 时，也会显示真实世界来源卡片。`FEATURE_NEW_SOURCES=true` 且有 `family_context` 时，结果页当前还会渲染 `Polymarket / Finance / Academic / News` 四张 source family card；`polymarket.configured_host=non-us` 时会显示地域限制占位。结果页当前还新增了 capability-gated 的 `Explore Deeper` bridge（`causal / replay / compare`）；disabled 卡片保留 link 语义，但不再渲染无 `href` 的 `<a>`，文字对比也不再靠整卡 opacity 压低。结局详情当前只在展开时挂载，收起时不会再把完整 story / key moments 留在可访问性树里。结果页里的 `FactionTimeline` 当前会优先跟随正在展开查看的分支；未展开时会落到概率最高分支，并改成真实纵向时间线，`stance / confidence` 等指标直接可见，不再只藏在 tooltip badge 里。结果页的 compare / counterfactual 入口也跟随同一条 analysis branch 语义，不再固定拿 `branches[0]`。replay 模式下会继续保留 replay-safe 的 `causal graph` 入口和 `FactionTimeline`，但 `counterfactual / resume / result conversation` 这类 live-only 面板仍保持隐藏。标题、空态、轮次与事件标签都会跟随 UI 语言；FactionTimeline lead 文案当前也已走 i18n key + `{{title}}` 插值。`CompareDigestView` 的非活跃 pane 当前会保留更完整的待机镜像，不再是纯黑占位。前端 gated route 当前也把 `feature disabled` 和 `capability probe 失败` 分开显示：`ReplayView` 不再 silent redirect，`KGExplorerView / CompareDigestView / FactionTimeline` 也不再直接把原始错误字符串或所有异常压成空态。
- replay 分支链路当前也已补硬化：`counterfactual` 会在 clone 前校验目标 round 里确实有该 agent 的消息；如果 seed 失败，会清理掉刚创建的脏 branch；`resume` 只有在预占 `simulation lock` 成功后才会返回 started。replay branch runtime lock 当前按 fail-closed 收口：续租返回 `None`、续租抛异常，或本地 lease 已过期时，都不会继续 clone / seed / schedule；heartbeat 会在请求内校验完成后才启动，避免同一请求自己和自己抢 SQLite 锁。若后台续跑期间丢掉预占的 `simulation lock`，任务也会直接 fail-closed 落成 `error`，不会失锁后继续跑；replay branch heartbeat 刷新异常时会释放原 lease，不再把后续请求卡到 TTL 过期。同分支重放更早轮次时，也会同步剪掉过期的 `AgentStateFrame / stance_shift`，不再把旧状态残留在当前图里。
- graph viz 当前已收口：`CausalReviewView` 会忽略 stale branch 响应，branch 切换时会先清空旧图、导出面板和 server analysis；graph route fetch 里的 `scenarioId / debateId`，以及 `CausalReviewView` 返回结果页的 scenario link，也都会先做 `encodeURIComponent()`，带特殊字符的 id 不会再打坏请求或跳转。URL 里带不存在的 `branch_id` 时会直接报错，不再伪装成空图；分支 selector 会优先显示 scenario branch 的标题和概率，拿不到元数据时才回退 branch id；只有源图本身就没有因果边时，`多节点但 0 edges` 才会切到本地化的 event snapshot fallback；如果只是 search / filter 把边筛空，交互图和导出入口仍会保留，不会把有边的图误判成 relationless fallback。
- 图谱交互当前也会跟随 UI 语言更新节点可访问名称、React Flow controls / minimap 文案、relation list 和 edge evidence tier；CausalReview 节点可拖拽、可选择，search、branch、语言或 compact viewport 变化时才重置布局。compact viewport 下会继续保留显式 controls 和移动端导航提示；图页外层统一走 `100dvh`，移动端 header 和 relationless fallback 都锚在当前壳层内并避开 safe-area。
- `ArgumentMap` 在 node-only 图时仍保留 screen-reader list 和键盘可达性，状态筛选也不会误把整张 node-only 图筛成空态；强度摘要会跟随当前筛选结果。`KGExplorerView` 当前使用真实 G6 主图和 minimap；搜索 / 类型过滤会更新可视图，不再只更新旁路列表。KG 节点点击会传业务 `kgType`、branch 与 round 给 `NodeConversationSheet`，不会把 G6 shape type 当节点语义。
- `ExportPanel` 会区分 PNG / SVG 的忙态文案；SVG 导出改成 native SVG layer + node rebuild，长标题会按节点卡宽度裁剪显示，但 `<title>` 和文本内容仍保留完整节点标题，不再依赖 `foreignObject`。`LanguageSwitcher` 的 accessible name 当前也会带可见 `EN / 中文` 文本，语音控制和读屏口径不再分叉。后端 runtime repair 当前以最新 `causal-graph / argument-map` snapshot 为 authority，重复 snapshot 的旧残留会直接删除，不再把 stale 数据合回当前图。
- CausalReview 节点点击当前会直接打开 `NodeConversationSheet`，并把 event content 作为 origin excerpt 交给后端 prompt context；大图超过 50 个节点时会用更紧的节点高度、间距和更低 `minZoom`，避免首屏过度撑开。KG 工作台桌面节点点击先显示 `NodeQuickCard` 快览卡；卡片会按视口钳位，用户再选择是否打开完整详情。

### Debate Arena

- 独立 debate 域，包含 live/result/replay。
- 已落地结构化押注、counterplay、judge rationale、supporting turns 与 replay import。import replay 在 turns 落库后会同步抽取 argument map，导入完成后就能直接打开图谱。
- Debate replay 分享当前优先走内联 `?replay=`；链接过长时会回退为本地只读 `?local=`。结果页在这条回退链路上会明确显示 `Save local read-only copy`，而导入入口继续保留 `Import as Local Run`。
- result 页里的 argument map 当前改成按需加载，并重新对齐回主页面壳；首屏先给 `Load map`，只有用户点开后才真正挂图。
- 当前 phase 视图会保留更早 phase 的已出现 turns，并以折叠历史卡形式留在当前 live 视图里，不再直接丢掉。
- 页面级播报当前仍以 phase cue 为唯一 live region；`SpotlightTurnCard` 的高亮态不再单独挂 `aria-live`，避免同一轮变化被重复播报。
- quick counterplay 当前只在 live 当前 phase 的 bet window 可提交；锁到历史 phase 时不会再发起 quick hedge。
- debate argument map 当前保留 rule-based 抽取，并默认追加每个 turn 一次 fire-and-forget LLM enrichment；上游 provider 慢或失败时会自动回退成纯规则结果。
- debate argument map 的 enrichment apply / rebuild 当前按串行收口；改写 unit type 后会按最新 claim 状态重建 `rebuts / supports` target。当前同一 turn 有多条对手 claim 时，`rebuttal` 会按句子顺序挂到最后一条 claim，而不是按 hash 顺序乱选；`counter` 改写后也会继续保留 `rebuts` 边；verdict 重算也会同步刷新 verdict 节点元数据，不再只改 unit 状态。whitespace-only 的句子变体当前也会按归一化文本去重，不再在同一 turn 里拆出重复单元。
- judge 的 verdict turn 当前不会再混入常规 `supports / rebuts` 抽取。
- debate argument map 的 fail-soft 当前会显示明确失败文案和 `Retry`，不会再被误判成普通空态。
- debate runtime lock 当前会在长运行期间持续续租；续租返回 `None`、续租抛异常，或本地 lease 已过期时，任务会 fail-closed 并把 debate 标成 `error`，不会继续生成后续内容。
- Debate 页面壳当前继续跟随用户自己的 UI 语言，不会再因为 `debate.language` 或结果 payload 反向切全局语言；结果页的 mixed-language fallback 已覆盖 `phase commentary / replay quote / prediction score reason` 这些长文案来源，命中时会显示明确 fallback note，并保留原文展示。

### Oracle Chambers / 世界线圆桌

- 已进入可玩签收基线。
- 结果页可通过 participant picker 进入：
  - `进入会客厅`
  - `只改一步`
  - `异线旁听席`
- 单结局结果页当前只保留：
  - `进入会客厅`
  - `只改一步`
  - 不会展示 `发起圆桌` / `异线旁听席`
- `WorldlineRoundtableView` 已支持 live roundtable、改选重开、只读 replay，以及 `manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented`。
- live completed room 当前在裁决落地后开放 `Deep Dive` 工作台，包含 participant-scoped `1-on-1 Interview`、`Research Analyst` 与 `Cross-Examine`；readonly replay 不开放这组 live-only 工作台入口。
- 代表改选当前支持桌面 `drag-to-seat / keyboard reseat`；移动端保留 `click-to-seat`。
- single-ending 当前已补：
  - `继续追问`
  - `另开线程`
  - `复制纪要`
  - `追问洞察`
  - transcript `quote` 级追问 / 开线程
- roundtable 当前已补：
  - `Continue this table / Start anchored thread / Copy roundtable brief`
  - `phase insight` 级追问 / 开线程
  - transcript `quote` 级追问 / 开线程
  - transcript `quote` 级 `点名这位代表 / Hotseat this rep`
- roundtable committed transcript 当前已补长段折叠 / 展开，避免主区直接被长段挤满。
- 已新增两种交互模式：
  - `后续三回合 (epilogue)`：在结局讨论后继续 3 回合短叙事推演，不重开主 simulation。
  - `证据投牌 (evidence_card)`：把另一条世界线的摘要卡引入当前房间，由档案官解释差异。
  - 两种模式在 `crossline_gallery` 下不可用。
  - `evidence_card` 的 `cited_branch_id` 会做 scenario 级验证，防止跨场景引用。
- `quote / verdict / key_moment / phase` 当前都走显式 `questionAnchorIds`，不再只靠 prompt 文案表达锚点。
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail 与 transcript header 显式显示当前 thread 的 anchor badge。
- transcript `quote` 动作栏当前在触控设备上不再依赖 hover；粗指针设备会直接显示相关操作。
- Oracle 自动化口径当前会输出：
  - `question_anchor_ids`
  - `thread_question_anchor_ids_json`
  - `anchor_kind / anchor_label`
  - `pending_question_anchor_ids`
  - `current_speaker_turn_key`
  - `current_speaker_participant_id`
  - `pending_drafts`
  - `stream_state`
- Oracle 专项自动化当前分三层：
  - `e2e-ending-room-suite` 负责结果页 picker -> live chamber / one-move-only 的基础 smoke
  - `e2e-ending-room-followup-suite` 负责 ending-room follow-up / readonly replay / reload restore / import
  - `e2e-worldline-roundtable-suite` 负责 roundtable live / readonly replay / reload restore / import
- ending-room 基础 smoke、`e2e-debate-suite full`、`e2e-ending-room-followup-suite full` 与 roundtable desktop replay restore 已完成本轮 post-fix 复验。
- Oracle 英文链路当前也已补到真实浏览器签收：
  - Chromium full：`ending-room follow-up`、`roundtable`
  - desktop Firefox / WebKit scoped regression：`ending-room follow-up`、`roundtable`
- ending-room / roundtable 的 replay 回归当前都已收口到同一条自动化口径：
  - header action 只在各自 header action 区域内定位
  - 复用旧页面前先 revalidate live room
  - readonly replay 必须同时满足 replay URL 与只读 UI 契约
- ending-room replay helper 当前识别 `roomReplay / roomShare / roomLocal`；roundtable 页面继续使用 `roomShare / roomLocal`，并兼容 `share / local` alias。
- roundtable 的 readonly replay 当前会跟随 `active_thread_id` 恢复对应 thread 语义；若落在 `hotseat` follow-up，页面不会再退回成 `archivist_route`。
- mobile roundtable artifact replay readonly 当前也会跟随 active replay thread 恢复 `interaction_mode`，不再在自动化口径里卡成 `archivist_route`。
- roundtable 的 scoped regression 当前已覆盖 Chromium 桌面/移动，以及桌面 Firefox / WebKit；`reseat / keyboard reseat / anchored thread / hotseat / witness_augmented / readonly replay` 口径与 Chromium 对齐。
- `ending-room / roundtable` 的主文案当前已改成 factual anchor + `LLM first, template fallback`：participant snapshot 会带 `agent_role / agent_persona / bio_short / impact_score / branch_pressure`，但角色身份块和动态词汇身份提示都会按 `UNTRUSTED DATA` 注入；provider 慢、失败、空流式或仅 reasoning 输出时，会退到非流式改写或 deterministic fallback，不再默认先落模板再改写。
- ending-room 后台生成当前也持有 runtime lock heartbeat；续租返回 `None`、续租抛异常，或 lease 过期时，会直接 fail-closed 把 room 落成 `error`，不会失锁后继续写 turn 或 result。
- Oracle 页面当前按用户正在使用的 UI 语言渲染界面壳，不再强制跟随 `scenario.language` 覆盖全局语言开关。
- Oracle fresh live room 的英文 deterministic copy 当前已补去混句兜底，不再把中文 hinge 直接嵌进英文句子；fresh live 的节点对话、KG Explorer 与 replay-view 浏览器链路本轮也已复核通过。
- `EndingChatModal` 的 mobile sidebar sheet 当前已补可访问标题/描述；sheet 打开时第一次 `Escape` 只收 sheet，不会直接关外层 chamber。
- 结果页 live ending-room 当前把 English 只读保存入口统一为 `Save local read-only copy`；readonly replay 仍保留 `Import as Local Run`。

## 当前工程边界

- 交付形态仍是 `browser-first Web`。
- `跨平台` 当前以 Chromium 桌面/移动与桌面 Firefox / WebKit 的 scoped regression 为准，不表示原生壳或所有移动浏览器组合已单独交付。
- 旧浏览器兼容当前以 legacy bundle + runtime/css fallback 为主：
  - Vite production 会额外产出旧浏览器入口
  - 运行时已补 `localStorage`、`crypto.randomUUID`、`<dialog>.showModal()`、`inert`、replay token portability 与关键配色 fallback
  - 但还没有 BrowserStack / Sauce 级实机签收
- 主模式 authority 已以后端为准：
  - `director_state_json`
  - `gameplay_state_json`
- `scenarioMeta` 仍存在，但只承担缓存、兼容与 replay 输入职责。
- 自定义 BYOK 与搜索增强 override 的官方托管 base URL 当前要求 `https`；只有本地或 self-hosted 开发地址才允许 `http`。
- replay 分享优先走后端 `ReplayArtifact`；当 artifact 不可用且 URL token 也过大时，Oracle replay 会回退为本地只读副本链接。
- Oracle / roundtable replay coverage 当前按 fail-closed 收口：
  - replayCoverageError 或 readonly replay / reload restore / import 关键字段缺失会直接失败
  - 不再以 best-effort `summary.json` 保底通过
- 严格慢路径自动化当前仍在继续收口：
  - ending-room follow-up 的慢流式链路仍可能只落到 fallback 观测，不一定每次都能拿到完整 `turn_start / turn_delta / turn_commit`；空流式或仅 reasoning 输出当前会直接退回非流式改写，不会把 anchor copy 当成成功 stream
  - 但 `full / mobile` 当前已改成目标 `roomId + threadId + interaction_mode` 验真；single-ending anchored fallback 也会补校验 `questionAnchorIds` 与 assistant reply，不再接受旧线程空态或只有 user turn 的假阳性
  - roundtable `full` 当前已补 result -> roundtable 入口重试；如果入口仍卡住，会直接落 `roundtable-entry-stall.json` 并失败
  - roundtable 首开与后续 `reseat / expert_witness / selection mode reopen` 当前都按同一条 `90s` ready budget 收口，不再只给 `45s`
- 本轮 2026-04-23 fresh rerun 已再次通过：
  - `frontend/output/e2e/20260423-oracle-regression-followup-rerun/summary.json`
  - `frontend/output/e2e/20260423-oracle-regression-roundtable-rerun-v2/summary.json`

## 当前状态

- 主闭环当前维持 `release-candidate` 级别。
- 当前稳定基线仍保留：
  - `graph / replay / backend correctness` 修复，以及 UI review findings 对应前端修复，当前都已并入基线
  - P1 post-review hardening 的 fresh 验证当前已补：
    - backend P1/迁移/契约窄集 pytest：`186 passed`
    - backend ruff format/check：通过
    - frontend targeted vitest：`237 tests passed`
    - `npx tsc --noEmit -p tsconfig.app.json`：通过
    - `node --check scripts/e2e-capability-matrix.mjs`：通过
    - fixture-backed Playwright：ResultView replay 不暴露 live conversation；CausalReview server analysis 和 evidence tier 本地化通过
    - capability matrix E2E：`30 passed / 0 skipped / 30 total`
  - P1 post-review follow-up 当前也已补窄集复验：
    - backend causal graph：`68 passed`
    - backend graph/evidence 定向：`125 passed`
    - frontend ResultView / CausalReviewView / locale 定向：`126 passed`
    - 后端 ruff、前端目标文件 eslint、TypeScript noEmit 均通过
  - backend `agent-conversation / quota / migration` 定向回归当前通过
  - backend 全量 `pytest` 最近一次记录为 `2399 passed, 2 skipped`
  - frontend `typecheck / lint / build / perf budgets` 通过
  - frontend bridge / guide 定向 vitest `124 passed`
  - frontend 全量 vitest 最近一次记录为 `1782 passed`
  - 本轮真实验证还包括：
    - `cd backend && source .venv/bin/activate && ruff check app/services/ending_room_service/ app/services/simulator.py tests/test_simulator.py tests/test_ending_room_service.py tests/test_memory.py tests/test_corner_cases.py`：通过
    - `cd frontend && npm exec -- tsc --noEmit -p tsconfig.app.json`：通过
    - frontend i18n 深层 key + placeholder parity：`1587 = 1587`，通过
  - frontend 目标文件 `eslint`、`typecheck`、`build / perf budgets` 通过
  - fixture-backed local preview 浏览器复核：
    - ResultView bridge DOM / disabled 样式通过
    - FactionTimeline 文案 i18n 插值通过
    - CausalReviewView guide disclosure 语义通过
    - console clean
  - 这轮 graph/playability 增量回归也已补：
    - clean-room `e2e:ws:contract` `20 passed / 1 skipped / 0 failed`
    - clean-room `e2e:capability-matrix` `30 passed / 0 skipped / 0 failed`
    - `node --test scripts/e2e-ws-contract-suite.test.mjs` `18 passed`
    - capability / replay / compare / kg / faction / i18n 定向 vitest `64 passed`
  - 本轮 fresh local live 验证已补：
    - `node-conversation-live`
    - `kg-explorer-live`
    - `replay-view-live`
  - graph script contract：`node --test scripts/e2e-frontend-preflight.test.mjs` `25 passed`
  - P1 前置图谱复核当前已覆盖指定本地 preview URL：
    - `/kg-explorer/dbac37a3-3578-42b2-99c0-06185caad147`
    - `/sim/dbac37a3-3578-42b2-99c0-06185caad147/causal-map`
    - `/replay/32728bd6-282c-42f1-a7da-493892fce32a`
    - `/result/dbac37a3-3578-42b2-99c0-06185caad147`
    - 截图位于 `frontend/output/e2e/20260424-p1-preflight-fixes/`
  - production preview 当前可挂到 `127.0.0.1:18930`
  - 本轮 local `uv + vite preview` 复核也已补：
    - 结果页 `进入会客厅 / 异线旁听席` 可直接打开
    - roundtable live completed-state 不再卡在 `正在搭建世界线圆桌...`
  - graph smoke / release-signoff 当前都会先跑前端 deep-link preflight；preview 没 ready、SPA fallback 失效，或 entry module、CSS entry、legacy fallback 资源不一致 / 不可达时会直接 fail-closed，不再把 404 混成图谱回归
  - `phase3-batch-a full`、`phase3-batch-b full`、`phase3-batch-c full` 当前都已在 Chromium desktop/mobile + Firefox desktop + WebKit desktop 通过
  - `e2e-new-source-ingestion-live` 当前在 `fixture full` 和 `live full` 下都已 fresh 通过
    - live 口径已补 `web_search_families` 请求、四个 source family 非空卡片，以及 `Polymarket us / non-us` 两条 geo-gate 路径
  - `zh-CN batch-a full`、`zh-CN batch-b full` 通过
  - focused browser spot-check 当前建议覆盖 CausalReview 节点对话、KG 工作台 `NodeQuickCard` 视口钳位，以及详情面板打开/关闭后的焦点恢复
  - focused browser spot-check 当前也已确认 `/agents` 继续按 capability gate 落 disabled 文案，不是假阳性
  - 这轮 local preview 复核也已补：
    - 首页 source family disabled tooltip 已跟随当前 UI 语言
    - `ReplayView` capability disabled 不再回首页
    - 结果页 `FactionTimeline` 空态已改成解释性提示
- 当前无产品级 active backlog；剩余架构级限制见 `overview/backlog.md`。

## 文档入口

- 产品和仓库入口：仓库根 `README.md`
- 后端真值：`overview/backend.md`
- 前端真值：`overview/frontend.md`
- 开发与签收命令：`guides/development.md`
- 接口与配置：`reference/api.md`、`reference/config.md`
- 实现归档：`implement/README.md`

## 不应再做的事情

- 不要把 `progress.md` 当当前状态说明。
- 不要把 `implement/*.md` 的旧计划段落当待办列表。
- 不要在本页记录 session 级测试流水、逐轮修复清单或历史签收日志。
