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

- 首页创建 scenario，支持 5 步进度提示、quick starts、教育模板、agent/rounds、玩法档位、BYOK，以及 opt-in 的搜索增强推演；高级设置和 BYOK 现在分成两个可折叠区，首屏优先露出问题输入和快速开始。
- Campaign 入口当前在首页内提供每日挑战、每周 track 和成长卡：前端从 rotation 读取今日挑战、difficulty、active weekly track 和刷新倒计时；成长卡可打开进度 sheet，查看徽章、profile mastery 和本周摘要；创建 scenario 时会带上 campaign context，后端再校验 catalog、服务端 UTC 日期和 ISO week。
- 首次进入首页时会显示 onboarding carousel；用户完成或跳过后状态保存在本地，后续不再重复弹出。
- 首页启动前会用 AlertDialog 做 launch confirmation；底部安全提示跟随中英语言切换，不写入用户 key 或 provider 细节。
- 搜索增强当前在首页按低配置路径呈现：
  - `推荐：使用已配置搜索`：服务端默认 provider 可用时，普通用户只需打开开关，不需要理解 provider / API key / base URL
  - `高级：使用我的搜索服务`：服务端默认不可用、或本轮要用自己的 provider key / 本地 SearXNG / 自定义 endpoint 时再展开
- 首页搜索增强还支持搜索深度：`轻量` 抓取/注入 3 条，`标准` 抓取/注入 5 条，`深入` 抓取 10 条并向 prompt 注入 8 条；这个选择只影响本轮搜索预算和 prompt 片段数。
- 模型原生联网不是第三个 app-layer provider；它只在 Source Family 域名传给受支持的非 proxy Responses 模型时由 runtime 注入 native tools，并在结果页展示 native citations。
- Source Family 当前按有效 provider capability 开关选择项；server default 读服务端 `provider_capability`，custom override 有可识别 base URL 时按 URL 推断 Tavily / Exa / xAI / SearXNG，base URL 为空时使用下拉 provider 的 capability，只有非空未知 host 会显示 no-provider warning。provider 不支持 domain filter 时，四个 family checkbox 会保留可见但禁用，已选 family 会被清空，不会把旧选择带进下一次提交。
- InputView 当前不展示专门的 `Organization ID` 输入框；API client 仍会从 sessionStorage 读取已有组织 ID 并生成 `X-Org-Id`。
- 当 `agent_identity` capability 开启时，首页会在主模式启动前先跑 continuity preflight；只有命中 L2 fuzzy candidate 时才弹确认框，用户可选 `复用已有身份` 或 `创建新身份`。preflight 解析阶段超时会返回 `504 IDENTITY_PREFLIGHT_TIMEOUT`，后端不会把它当成“无匹配”；当前首页启动流会提示错误，但继续按无 continuity override 启动。
- 当 `custom_agents` capability 开启时，用户可以从 `/agents` 创建、编辑、收藏和选择自建 Agent，也可以在 `/agents/new` 通过 PDF document tab 生成 Agent；长 PDF 会走采样粗扫 + 全文证据精提，部分 persona 失败时保留已创建 Agent 并显示失败数量。首页 attach panel 会以卡片展示 persona、knowledge domains 和 decision bias，最多选择 5 个，并只把 identity id 传给主推演。自建 Agent 当前只允许 `IMPORTANT / CROWD` 两档，旧数据缺失或空值会回退到 `IMPORTANT`。自建 Agent 的 persona、knowledge domains 和 decision bias 会作为不可信文本/元数据进入主推演 prompt，`CORE` 不对自建 Agent 开放，后端 API、注入层和 simulator 都会把异常 `CORE` 降到 `IMPORTANT`。Agent Library 的 favorites 是普通筛选按钮，Workshop 的 manual/document tab 支持键盘方向键切换；capability/favorite 失败会显示本地化错误和 retry，不直接露出原始后端文本。
- 当 `persona_export` capability 开启时，Agent Library 的卡片可导出 Agent 备份，顶部可从备份创建新的 custom Agent；Agent Workshop header 也会显示同一套备份工具，编辑已有 Agent 时才显示导出。备份导入不会覆盖已有身份，并会把 decision bias 归一化到安全的 5 维数值；粘贴 JSON 入口默认折叠在高级区域。导入/导出失败会显示本地化提示，意外错误只进入 debug log。
- Agent Library 当前支持 `#agent_profile=<id>&tab=memory` 档案深链；ResultView 里的 Agent 档案入口会走这条 hash，而不是把用户直接丢到普通 `/agents` 列表态。
- 当 `prediction_journal` capability 开启时，`/me/journal` 提供个人预测日志、resolve 状态和 calibration 可视化；绑定 scenario 时按当前用户校验所有权，跨用户或无 owner 的旧 scenario 统一隐藏成 404，刷新时会忽略迟到响应，不用旧请求覆盖新列表。
- `SimulationView` 负责 live 推演、Classic 分支树、Theater、干预、玩法卡、结构化押注、干预回执与 capture。Theater live 启动在已有 Agent 且推演未完成时会跳过标题等待直接进入 `WorldScene`；场景 PNG 缺失时先显示程序背景，再在真实 texture 到达后替换。Classic 分支卡片仍以 `Branch.title` 为真实标题；标题太短时，前端只补一小段 `description / fork_reason` 线索，方便用户看懂路线差异。右侧 Agent 面板在筛选某个 Agent 时，会把该 Agent 的发言按世界线分组，并在组内按 round 排序。
- live 推演当前支持显式取消：前端会弹确认框，后端把 `parsing / simulating / narrating` 的 scenario 落成 `cancelled` 并请求后台任务停止；已有本地 token 的 worker 也会继续回查 DB `cancelled`，`cancelled / done / error` 终态不会被后续 stage 覆盖。
- `ResultView` 负责结局对比、Result Quality verdict、`counterfactual compare / resume / faction timeline`、档案、导演复盘 / campaign summary、分享、导出、结果追问与 replay/import；当 `result_verdict` capability 开启时，结果页会显示 ResultVerdictPanel：story 带 verdict 时先给出直接回答原问题的预测结论和置信度，verdict 缺失时显示中性的“暂无预测结论”并保留原问题。结局卡有 `question_answer` 时会把分支级一句话回答放在概率条上方；旧 scenario 或关闭开关时 header subtitle 仍走原来的多结局口径。因果档案当前改成问题、判定、系统读数、玩家动作、下一步和证据账本，不再把关键记录堆成一长串；“档案结论”会优先显示 story verdict，再补 branch insight。导演笔记和导演复盘默认收起；收起态会用 `aria-hidden` 和 `inert` 避免键盘进入隐藏内容。导演复盘会优先使用后端 `score_breakdown`，并把 campaign summary、what-if、世界线承诺、押注、干预和关键时刻展示成生涯分变化、等级进度、本局读数和下一步入口；关键记录先显示前 3 条，更多记录用原生 disclosure 展开；replay snapshot 带 `campaignSummary` 时只读展示，不重新 finalize。当后端写入 `web_search_context` 时，也会显示真实世界来源卡片；如果 payload 带 `native_citations`，结果页会单独展示 native citations，并跳过非字符串 text、非 http(s) URL 或 malformed replay 数据。`FEATURE_NEW_SOURCES=true` 且有 `family_context` 时，结果页当前还会渲染 `Polymarket / Finance / Academic / News` 四张 source family card；`failed / unsupported_provider / fallback_unconstrained / search_skipped` 都有专门文案，后端 `status_reason` 会进入卡片说明，desktop 和 mobile sheet 的 `aria-describedby` id 不复用。历史 replay 里已有数据但当前 family capability 未开启时，会显示 recorded badge，不把历史来源伪装成 live provider。`polymarket.configured_host=non-us` 时会显示地域限制占位。结果页当前的 `What's Next / 下一步` bridge 会展示 `causal / replay / compare / workbench / agents / share` 入口，disabled 卡片保留可见状态说明，但不再渲染无 `href` 的 `<a>`，文字对比也不再靠整卡 opacity 压低。分享弹窗当前还可导出 1200×630 PNG 卡片，卡片只包含问题、主导结局、可见来源 family 和前 3 个 Agent 名，不写入 BYOK key、base URL 或用户 token。结局详情当前只在展开时挂载，收起时不会再把完整 story / key moments 留在可访问性树里。续跑结局卡会显示 `续跑分支` badge、来源分支按钮和独立概率说明；点击来源按钮会展开并聚焦来源分支标题。结果页里的 `FactionTimeline` 当前会优先跟随正在展开查看的分支；未展开时会落到概率最高分支，并改成真实纵向时间线，`stance / confidence` 等指标直接可见，不再只藏在 tooltip badge 里。结果页的 compare / counterfactual / resume 入口也跟随同一条 analysis branch 语义，不再固定拿 `branches[0]`；counterfactual 入口会用 story 返回的 `fork_round` 和 `parent_branch_id` 定位来源分支，只允许改写来源分支里真实存在的一句旧发言；resume 面板在可用时会优先让用户先选分支，再选择同分支 checkpoint，并把可读 `compressed_summary` 摘成预览；没有 checkpoint 时才回到 round number 输入。结果追问也跟随同一条 analysis branch，把当前结局标题、洞察、分支原因、关键时刻和对比分支传给对话面板。replay 模式下会继续保留 replay-safe 的 `causal graph` 入口和 `FactionTimeline`，但 `counterfactual / resume / result conversation` 这类 live-only 面板仍保持隐藏。标题、空态、轮次与事件标签都会跟随 UI 语言；FactionTimeline lead 文案当前也已走 i18n key + `{{title}}` 插值。`CompareDigestView` 的非活跃 pane 当前会保留更完整的待机镜像，不再是纯黑占位。前端 gated route 当前也把 `feature disabled` 和 `capability probe 失败` 分开显示：`ReplayView` 不再 silent redirect，`KGExplorerView / CompareDigestView / FactionTimeline` 也不再直接把原始错误字符串或所有异常压成空态。
- ResultView 的 `找 Agent 追问` 入口当前是场内 `ScenarioAgentPicker`，受 `agent_conversation` capability、当前 scenario agent 列表和非 replay 模式共同控制；选择 Agent 后打开 `NodeConversationSheet`，origin 使用 `nodeType=agent`、`nodeId=agent:<id>`、当前 analysis branch 和截断 persona，关闭 sheet 或切换 scenario/replay 状态会清掉当前追问目标。带 `agent_identity_id` 的 Agent 会显示 `查看档案` 链接，指向 Agent Library 的 hash profile。
- Sprint 3 核心体验当前已完成接线：结果页有时钟倒拨入口、HOPs 分支概率动画、预测分享卡片和 snapshot export；首页有 snapshot import；snapshot export/import 会保留已完成干预的只读回执，但不会把 pending intervention 重新排队；圆桌 analyst 使用 ReACT 工具链面板；人格漂移只做 warning，不阻断 verdict。
- Sprint 4 品质提升当前已完成本地审查与修复：backend KG realtime event contract、ResultView 第一阶段拆分、isZh 文案继续迁到 locale key、voice variant 18 种和 Phaser reduced-motion guard 已并入当前工作树。ResultView 后续如果继续改，应优先收窄 `ResultContext` 的宽 context。
- ResultView 当前界面文案区分 `Reader / Explore` 两种模式；Reader 是默认阅读模式，并保留可用的 resume 面板、下一步入口和 header 图谱直达入口；Explore 会展开因果图、KG 和节点追问等较重面板，切换时滚到下一步区。用户选择仍保存在本地偏好里，内部键名沿用 `workbench`。
- 独立 `/workbench/:id` 图谱工作台保留 `view` 与 `branch` query，三种视图继续按各自 capability gate 判断；结果页 header 和下一步 bridge 都会带上当前 analysis branch，页面顶部会提供返回对应结果页的链接。workbench 的 graph / split / kg 图面都会按 scenario 拉全量 causal graph，不再把 URL `branch` 传给 `useScenarioGraph` 过滤；独立 `CausalReviewView` 的分支下拉仍保留 branch-scoped 请求。
- replay 分支链路当前也已补硬化：`counterfactual` 会在 clone 前校验目标 round 里确实有该 agent 的消息；前端带 `source_message_content` 时，后端会用它缩小到唯一旧发言；如果 seed 失败，会清理掉刚创建的脏 branch。`resume` 会先校验 scenario、来源 branch 和 round；checkpoint 列表带 `branch_id` 时也会校验 branch 属于当前 scenario，跨场景 branch 返回 `CHECKPOINT_BRANCH_NOT_FOUND`。`resume` 只有在预占 `simulation lock` 成功后才会返回 started。replay branch runtime lock 当前按 fail-closed 收口：续租返回 `None`、续租抛异常，或本地 lease 已过期时，都不会继续 clone / seed / schedule；heartbeat 会在请求内校验完成后才启动，避免同一请求自己和自己抢 SQLite 锁。若后台续跑期间丢掉预占的 `simulation lock`，任务也会直接 fail-closed 落成 `error`，不会失锁后继续跑；replay branch heartbeat 刷新异常时会释放原 lease，不再把后续请求卡到 TTL 过期。同分支重放更早轮次时，也会同步剪掉过期的 `AgentStateFrame / stance_shift`，不再把旧状态残留在当前图里。
- graph viz 当前已收口：`CausalReviewView` 会忽略 stale branch 响应，branch 切换时会先清空旧图、导出面板和 server analysis；`graph_analysis` 可用且后端返回分析时，页面会显示 summary、density、component、god nodes、degree bucket 和 cross-branch stats，`serverAnalysis=null` 时不硬造分析。graph route fetch 里的 `scenarioId / debateId`，以及 `CausalReviewView` 返回结果页的 scenario link，也都会先做 `encodeURIComponent()`，带特殊字符的 id 不会再打坏请求或跳转。URL 里带不存在的 `branch_id` 时会直接报错，不再伪装成空图；分支 selector 会优先显示 scenario branch 的标题和概率，拿不到元数据时才回退 branch id；completed branch 当前会在因果图里显示为 `outcome` 结局节点，并由 `led_to` 边接到同分支最近的来源节点；只有源图本身就没有因果边时，`多节点但 0 edges` 才会切到本地化的 event snapshot fallback；如果只是 search / filter 把边筛空，交互图和导出入口仍会保留，不会把有边的图误判成 relationless fallback。
- 图谱交互当前也会跟随 UI 语言更新节点可访问名称、React Flow controls / minimap 文案、relation list 和 edge evidence tier；CausalReview 节点可拖拽、可选择，guide 里的长 key-node 可见标签会压短但完整 `label (degree)` 仍保留在 `aria-label / title`，search、branch、语言或 compact viewport 变化时才重置布局。compact viewport 下会继续保留显式 controls 和移动端导航提示；图页外层统一走 `100dvh`，移动端 header 和 relationless fallback 都锚在当前壳层内并避开 safe-area。
- 工作台因果图的 edge label 当前只在 pill 里显示关系短标签；round 和 confidence 放在 hover / focus detail 里，tier 用左边框表示。zoom 很远时隐藏全部 label，中等 zoom 只保留 `caused / led_to / triggered fork` 这类高优先级 label，近距离显示全部 label；`Triggered Fork / Stance Shift` 这类后端英文 label 会按当前 UI 语言映射展示。
- `ArgumentMap` 在 node-only 图时仍保留 screen-reader list 和键盘可达性，状态筛选也不会误把整张 node-only 图筛成空态；强度摘要会跟随当前筛选结果。argument map 当前按 verdict -> claims -> evidence/rebuttals 的三层 DAG 排布，支持 5 种 verdict status，移动端可切到按类型分组的列表。`KGExplorerView` 当前使用真实 G6 主图和 minimap；搜索 / 类型过滤会更新可视图，不再只更新旁路列表。KG 节点点击会传业务 `kgType`、branch 与 round 给 `NodeConversationSheet`，不会把 G6 shape type 当节点语义。
- `ExportPanel` 会区分 PNG / SVG 的忙态文案；SVG 导出改成 native SVG layer + node rebuild，长标题会按节点卡宽度裁剪显示，但 `<title>` 和文本内容仍保留完整节点标题，不再依赖 `foreignObject`。`LanguageSwitcher` 的 accessible name 当前也会带可见 `EN / 中文` 文本，语音控制和读屏口径不再分叉。后端 runtime repair 当前以最新 `causal-graph / argument-map` snapshot 为 authority，重复 snapshot 的旧残留会直接删除，不再把 stale 数据合回当前图。
- CausalReview 节点点击当前会直接打开 `NodeConversationSheet`，并把 event / fork / outcome 的可读摘要作为 origin excerpt 交给后端 prompt context；面板会显示对话目标、卡片意义、前因、后续和相关关系，空态追问也会按事件、分支、结局、知识节点或裁决节点分别生成。大图超过 50 个节点时会用更紧的节点高度、间距和更低 `minZoom`，避免首屏过度撑开。KG 工作台桌面节点点击先显示 `NodeQuickCard` 快览卡；卡片会按视口钳位，用户再选择是否打开完整详情。
- Agent conversation 历史当前可在节点对话和结果页 Agent 追问等入口重新加载；列表按 scenario 做 cursor pagination，详情加载后由宿主组件恢复已提交 assistant 内容，迟到的 list/detail 响应不会覆盖新筛选、新节点或新 Agent。
- 对话与 replay 相关入口当前会显示 `QuotaBadge`，通过后端 quota summary 读取 conversation / replay bucket；本机无 signed principal / org 时 conversation 显示本机模式，replay 仍显示 scenario branch 用量。
- Leaderboard 当前支持按 scenario type、日期和 Agent 数做 segment filter；筛选状态会同步到 URL，不带筛选时仍按旧 leaderboard 数组渲染，带筛选时会按匹配的已评分 prediction 重新计算分段指标，快速切换筛选时会忽略迟到响应。

### Admin Setup

- `/admin/setup` 是 3 步本地配置向导：
  - 选择 provider preset
  - 填 API key / base URL
  - 调 `/api/admin/test-llm` 做连接测试
- 完成后只写入当前浏览器 session 的 BYOK provider policy；不会把 key 写入项目文档或 durable artifact。
- 后端同时提供 `/api/admin/preflight` 和 `make preflight`，用于检查 SQLite、ChromaDB、LLM、web search、CORS 与数据目录写权限。

### Debate Arena

- 独立 debate 域，包含 live/result/replay。
- Debate 创建请求当前可选传入最多 2 个属于当前用户的 `custom_agent_ids`；功能开关关闭时直接拒绝，ID 不存在、不是 custom 或跨用户都会被拒绝。传入后按顺序锁定 proposition / opposition 的名字、角色、persona 和 metadata，生成每轮发言时继续把 knowledge domains / decision bias 作为不可信 prompt metadata 注入。
- 已落地结构化押注、counterplay、judge rationale、supporting turns 与 replay import。import replay 在 turns 落库后会同步抽取 argument map，导入完成后就能直接打开图谱。
- 非 custom 的 Debate cast 会先用 deterministic 模板占位；`DEBATE_USE_LLM=true` 时，后台会按当前辩题生成 name、role 和 persona。name/role 会先清洗控制字符、fence 和 prompt-injection 标记，失败或空值回退模板。
- LLM persona upgrade 成功后，会在第一轮发言前通过 `debate_participants_update` 刷新 live 页参与者信息。前端按 `side` 合并，允许 WS 更新早于 REST snapshot 到达。
- Debate replay 分享当前优先走内联 `?replay=`；链接过长时会回退为本地只读 `?local=`。结果页在这条回退链路上会明确显示 `Save local read-only copy`，而导入入口继续保留 `Import as Local Run`。
- result 页里的 argument map 当前改成按需加载，并重新对齐回主页面壳；首屏先给 `Load map`，只有用户点开后才真正挂图。
- 当前 phase 视图会保留更早 phase 的已出现 turns，并以折叠历史卡形式留在当前 live 视图里，不再直接丢掉；阶段地图默认折叠，用户展开后再看完整阶段进度。
- Debate E2E 当前遵守这个折叠契约：断言完整阶段列表前会先通过稳定 toggle hook 展开阶段地图。
- 页面级播报当前仍以 phase cue 为唯一 live region；`SpotlightTurnCard` 的高亮态不再单独挂 `aria-live`，避免同一轮变化被重复播报。
- quick counterplay 当前只在 live 当前 phase 的 bet window 可提交；锁到历史 phase 时不会再发起 quick hedge。
- debate argument map 当前保留 rule-based 抽取，并默认追加每个 turn 一次 fire-and-forget LLM enrichment；上游 provider 慢或失败时会自动回退成纯规则结果。
- debate argument map 的 enrichment apply / rebuild 当前按串行收口；改写 unit type 后会按最新 claim 状态重建 `rebuts / supports` target。当前同一 turn 有多条对手 claim 时，`rebuttal` 会按句子顺序挂到最后一条 claim，而不是按 hash 顺序乱选；`counter` 改写后也会继续保留 `rebuts` 边；verdict 重算会把 unit 收口到 `accepted / standing / unaddressed / rebutted / rejected` 五种状态，并同步刷新 verdict 节点的 winner、tone 和 judge summary。whitespace-only 的句子变体当前也会按归一化文本去重，不再在同一 turn 里拆出重复单元。
- judge 的 verdict turn 当前不会再混入常规 `supports / rebuts` 抽取。
- debate argument map 的 fail-soft 当前会显示明确失败文案和 `Retry`，不会再被误判成普通空态。
- debate runtime lock 当前会在长运行期间持续续租；续租返回 `None`、续租抛异常，或本地 lease 已过期时，任务会 fail-closed 并把 debate 标成 `error`，不会继续生成后续内容。
- Debate 页面壳当前继续跟随用户自己的 UI 语言，不会再因为 `debate.language` 或结果 payload 反向切全局语言；结果页的 mixed-language fallback 已覆盖 `phase commentary / replay quote / prediction score reason` 这些长文案来源，命中时会显示明确 fallback note，并保留原文展示。
- Debate live/result 的 Podium Cards、score card 和 room card 当前支持长角色、人设与现场备注换行；长 persona / room note 可展开。裁判卡不再显示 `0/1`，而是跟随 UI 语言显示 `待裁决 / 已裁决`。移动端 score grid 会收成单列，避免横向溢出。

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
- live completed room 当前在裁决落地后开放 `Deep Dive` 工作台，包含 participant-scoped `1-on-1 Interview`、`Research Analyst` 与 `Cross-Examine`；readonly replay 不开放这组 live-only 工作台入口。`1-on-1 Interview` 会先显示代表的角色、世界线、立场、最近原话和人物简介，并把这份可读摘要作为 conversation origin context；网络失败只显示错误提示，不伪装成代表发言。
- `survey / analyst` 当前是 completed live roundtable 的 Deep Dive SSE 工作台能力；`survey` 会并发询问代表并逐条返回 `survey_response`，但它不是 EndingChatModal 的 `interaction_mode`。
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
- roundtable 的 phase insight 当前默认折叠；header 只留短 preview，展开后显示后端压缩后的一句话。后端会先剥掉重复的问题前缀，再按中文 96 字 / 英文 160 chars 的预算压缩；旧 payload 里如果残留整段 transcript 复述，侧栏和预填 prompt 也会先取第一句，避免重复占屏。
- 已新增两种交互模式：
  - `后续三回合 (epilogue)`：在结局讨论后继续 3 回合短叙事推演，不重开主 simulation。
  - `证据投牌 (evidence_card)`：把另一条世界线的摘要卡引入当前房间，由档案官解释差异。
  - 两种模式在 `crossline_gallery` 下不可用。
  - `evidence_card` 的 `cited_branch_id` 会做 scenario 级验证，防止跨场景引用。
  - `evidence_card` 追问被接受后，assistant follow-up turn 会继续保留用户引用的 `cited_branch_id`，并把原始引用信息放在 `cited_refs_json.source` 下。
- `quote / verdict / key_moment / phase` 当前都走显式 `questionAnchorIds`，不再只靠 prompt 文案表达锚点。
- `EndingChatModal / WorldlineRoundtableView` 当前会在线程 rail 与 transcript header 显式显示当前 thread 的 anchor badge。
- `EndingChatModal` 当前把 thread rail 与 evidence drawer 放在 transcript 内部滚动区外；消息列表继续独立滚动，证据卡列表在抽屉内自己滚动，避免移动端把可点击控件卷到 header / composer 下方。
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
- `ending-room / roundtable` 的主文案当前已改成 factual anchor + `LLM first, template fallback`：participant snapshot 会带 `agent_role / agent_persona / bio_short / impact_score / branch_pressure`，但角色身份块和动态词汇身份提示都会按 `UNTRUSTED DATA` 注入；provider 慢、失败、空流式、仅 reasoning 输出或返回 JSON 字符串时，会退到可显示文本或 deterministic fallback，不再默认先落模板再改写。roundtable opening / crossfire / witness / verdict 的静态锚点会把 scenario question 压成短问题前缀；英文 fallback 会避开中文问题原文；roundtable verdict 与 follow-up fallback 现在要求是可直接显示的人话，不允许把 prompt 指令或模式标签原样露给用户。
- Oracle participant 选择当前会给 `source_type=custom` 的 Agent 加 1.5x impact multiplier；这只影响会客厅/圆桌代表排序，不会把自建 Agent 提升成 `CORE`。
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
- 前端字体当前 self-host 在 `frontend/public/fonts/`，`frontend/src/fonts.css` 用 `font-display: swap` 和 `unicode-range` 拆分；页面入口不再请求 Google Fonts CDN。
- 主模式 authority 已以后端为准：
  - `director_state_json`
  - `gameplay_state_json`
- 已完成干预的 effect receipt 持久化在 `InterventionLog.effect_summary_json`；写回前会校验当前 scenario/branch，前端只读展示，snapshot import/export 会 remap receipt 引用。
- `scenarioMeta` 仍存在，但只承担缓存、兼容与 replay 输入职责。
- 自定义 BYOK 与搜索增强 override 的官方托管 base URL 当前要求 `https`；只有本地或 self-hosted 开发地址才允许 `http`。
- replay 分享优先走后端 `ReplayArtifact`；当 artifact 不可用且 URL token 也过大时，Oracle replay 会回退为本地只读副本链接。
- 新生成的主模式、ending-room 和 roundtable replay payload 会先清理 scenario replay 里的 Agent 字段：保留 `id / name / role / tier / stance / emotion / group / source_type / is_returning` 等展示字段，剥掉 `agent_identity_id` 和 persona；旧 replay token 仍按兼容路径解码。
- Oracle / roundtable replay coverage 当前按 fail-closed 收口：
  - replayCoverageError 或 readonly replay / reload restore / import 关键字段缺失会直接失败
  - 不再以 best-effort `summary.json` 保底通过
- 严格慢路径自动化当前仍在继续收口：
  - ending-room follow-up 的慢流式链路仍可能只落到 fallback 观测，不一定每次都能拿到完整 `turn_start / turn_delta / turn_commit`；空流式或仅 reasoning 输出当前会直接退回非流式改写，不会把 anchor copy 当成成功 stream
  - 但 `full / mobile` 当前已改成目标 `roomId + threadId + interaction_mode` 验真；single-ending anchored fallback 也会补校验 `questionAnchorIds` 与 assistant reply，不再接受旧线程空态或只有 user turn 的假阳性
  - 2026-05-19 复验中，`e2e-ending-room-followup-suite full` 与 `e2e-worldline-roundtable-suite full` 均通过；Ending Room summary 里的 desktop/mobile replay coverage error 为 `null`
  - roundtable `full` 当前已补 result -> roundtable 入口重试；如果入口仍卡住，会直接落 `roundtable-entry-stall.json` 并失败
  - roundtable 首开与后续 `reseat / expert_witness / selection mode reopen` 当前都按同一条 `90s` ready budget 收口，不再只给 `45s`
- 本轮 2026-04-23 fresh rerun 已再次通过：
  - `frontend/output/e2e/20260423-oracle-regression-followup-rerun/summary.json`
  - `frontend/output/e2e/20260423-oracle-regression-roundtable-rerun-v2/summary.json`

## 当前状态

- 主闭环当前维持 `release-candidate` 级别。
- Campaign Gameplay Enhancement 已并入当前基线：
  - daily challenge catalog：52 条
  - weekly track registry：7 条
  - badge registry：15 条
  - gameplay profile 展示名以共享 contract 的中英标签为准；daily catalog、首页轻量 summary 和后端玩法 prompt 需要保持同一组 label。
  - scenario 创建会持久化 `campaign_context`，并由后端校验 daily/weekly catalog、服务端 UTC 日期和 ISO week；streak 与 weekly aggregate 不信任前端本地日期。
  - campaign finalize 优先从持久化 `director_state_json / gameplay_state_json` 派生 `score_breakdown`、daily/streak、weekly bonus 和 badge unlock；旧 scenario 缺少 `campaign_context` 时仍保留 legacy fallback。
  - 首页成长 sheet 读取静态 badge definitions、当前用户 badges、mastery 和 weekly summary；旧本地数据里的 `daily_challenge / archive_record / bet_winner` 徽章 id 会映射到当前 registry id 展示。
- 最近完整本地验证：
  - backend `ruff check app/`：通过
  - backend `TOKENIZERS_PARALLELISM=false python -m pytest tests/ -q`：`3269 passed, 6 skipped`
  - frontend `npx tsc --noEmit`：通过
  - frontend `npx eslint src/ --max-warnings=0`：通过
  - frontend `npm run build`：通过
  - frontend full vitest：`202 files / 2206 tests passed`
  - frontend i18n key + placeholder parity：`zh: 2761`、`en: 2761`、parity OK
  - Graph Workbench 定向回归：`6 files / 184 tests passed`，覆盖 `CausalGraphBoard / KGGraphBoard / WorkbenchView / useG6Graph / useScenarioGraph / kgGraphConfig`；确认 workbench graph/KG 不按 URL branch 过滤，G6 ResizeObserver 会先同步 canvas 尺寸再 fitView
  - ResultView Agent follow-up browser spot-check：`/result/42ef3edc-8a33-49ed-997a-835e12ea6f35` 上浮动紫色按钮已移除，`找 Agent 追问` 会打开 Agent picker，带 identity 的 Agent 有 `查看档案` 链接，选择 Agent 后打开 `NodeConversationSheet`；关闭 sheet 后目标清空，390px mobile 无横向溢出，console error 为 0
  - Oracle E2E：`e2e-ending-room-followup-suite full` 与 `e2e-worldline-roundtable-suite full` 通过；ending-room replay coverage error 全为 null，mobile fit 为 true
  - Phaser browser spot-check：`/sim/91d5292b-36ea-4190-909d-87eb7e27f1d9` 当前 scene 为 `WorldScene`，canvas 可见，console error 为 0
  - CampaignProgressSheet browser spot-check：desktop 与 mobile forced-colors / reduced-motion 下可打开、可滚动，console/page error 为 0
  - 浏览器 E2E：Chromium mobile / gameplay / intervention / prediction、Firefox gameplay / intervention、WebKit gameplay / intervention 均通过；最终 Chromium gameplay mini 复验通过
  - `git diff --check`：通过
- 剩余架构级限制见 `overview/backlog.md`。

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
