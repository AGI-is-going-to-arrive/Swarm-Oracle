[English](FEATURES.en.md) | 中文

# SwarmOracle 功能索引

本页按能力类别列出主要入口，不再维护逐项发布核对表。操作步骤见 [USAGE.md](USAGE.md)，默认值与开关见 [CONFIGURATION.md](CONFIGURATION.md)。实际可用能力以运行中的 `/api/capabilities` 为准。

![推演与结果](screenshots/21-simulation.png)

## 核心推演

- **问题入口**：快速开始、教学模板、本地主题包和每日/每周挑战会把问题与建议设置带入首页。本地主题包会原子替换问题、语言、建议设置和有界世界背景；作者 prompt 只作为不可信参考证据。角色预览不会创建或选择持久化的权威 Agent 身份，但有界的姓名、角色和视角会作为不可信世界背景实体进入本局，因此可能影响推演。
- **文档种子**：上传资料，为本轮添加世界背景与 Agent 预览；它不会替用户填写问题。
- **初始世界事件 Feed**：可在首页为本轮配置最多 20 条事件；每条包含来源与正文，可选发布时间、可信度提示和标签。所有字段都按不可信数据处理，不会成为系统指令，凭据样式内容会被拒绝。
- **多 Agent 世界线**：支持 Agent 数、轮数、谨慎/均衡/探索模式、多次推演和分支概率。
- **原生社交动作**：每轮 Agent 可执行 `POST`、`COMMENT`、`REACTION`、`FOLLOW`、`MUTE`、`SEARCH`、`TREND`、`REFRESH` 或 `IDLE`。初始事件的来源账户可被关注或静音；静音来源会从后续 Feed、搜索和趋势投影中排除。
- **两种视图**：Classic 分支树用于查看结构，Pixel Theater 用舞台、气泡和工具栏展示 live 运行。
- **Live 玩法**：干预、玩法卡、预测押注和世界线承诺只在 live 推演中可写；终局只读已有记录，replay 不提供写入口。
- **辩论竞技场**：正方、反方和评委按阶段推进，结果可按需加载论点地图。

主要路由：`/`、`/sim/:id`、`/debate/:id`、`/debate/:id/result`。

## 结果与报告

- **终局世界线**：显示结论、置信度、每条叶分支的回答、概率与故事。likelihood 与分析置信度只把已完成的终局叶分支当作分支样本，并结合证据数；分叉父节点不计数，带符号的情绪收敛代理值不会抬高分析置信度。
- **完整报告**：`/result/:id/report` 展示章节、证据、不确定性、观察指标和可用图表；生成中、partial、failed、cancelled、skipped、stalled 和 truncated 都有明确外层状态，已保存章节不会被终态抹掉。
- **报告过程透明度**：已保存章节标明生成稿、重写稿或静态回退，降级时显示原因，证据可回到 replay 坐标。每个章节实际执行的有界工具轨迹会随成功或静态回退结果持久化，刷新、轮询或重开后仍可恢复；当前手动生成流的章节进度与“当前位置”仍是瞬时事件，不会在刷新后重放。所谓“访谈”是模型依据模拟历史合成并附上分支/轮次坐标的摘录，不是逐字原始证据，也不是新发生的实时采访。
- **结构化 premortem**：完整报告按 available / partial / missing 展示失败模式、失败机制、早期信号和不确定性；每个失败模式使用独立 evidence chain 指向报告证据坐标，不以普通章节正文替代证据链，也不把推演证据宣称为现实证明。
- **因果档案与复盘**：把玩法卡、预测押注、世界线承诺和终局结算放在同一条可追踪记录中；另有导演复盘、用户预测对比、run-group 分布和阵营时间线。
- **导出**：Markdown、Snapshot、固定链接、预测卡片和脱敏公开 artifact。Public Artifact 可下载 JSON、单文件 HTML 或复制离线 Gallery hash 链接，`gallery.html` 也可打开本地 JSON；它不是 hosted registry 或在线社区。公开 replay 不携带本地身份、persona、凭据或仅供 live 使用的连接信息。

主要路由：`/result/:id`、`/result/:id/report`。

## 会客厅与圆桌

- **结局会客厅**：从一条世界线追问参与者，支持只改一步、锚定线程、证据投牌和三回合后续。
- **世界线圆桌**：多结局代表共同讨论，支持讨论形式和选角。
- **Deep Dive**：圆桌完成后提供 1 对 1 访谈、研究分析师和交叉质询。
- **模型选择**：会客厅可在自己的高级设置中选择 model profile；不选则使用全局默认。

主要路由：`/roundtable/:id`；会客厅从 `/result/:id` 打开。

## 反事实、Replay 与图谱

- **反事实与续跑**：改写一条真实发言，或从 checkpoint 创建带来源关系的新分支。
- **分支对比**：并排查看原分支与新分支的差异。
- **窄屏操作**：反事实的 Agent 与轮次控件会在手机宽度换行收缩，长 Agent 名不会把面板撑出视口。
- **Replay Trace**：追踪反事实和续跑分支的来源；消息、Agent 状态和记忆按所选有效谱系与轮次截点隔离，包含截点内的分叉前祖先轮次，不混入兄弟分支、父分支分叉后的未来或 cutoff 之后的信息。自包含 replay 在自身边界停止。
- **图谱工作台**：Causal、Split、Knowledge Graph 三种视图；另有知识图谱浏览器和时间线星系。
- **Action Ledger**：Causal Review 面板按当前场景与有效分支谱系展示持久化的原生动作、目标和状态；独立证据回执接口投影 Agent 发言、上下文观察和派生后果。记忆只显示哈希引用与来源场景坐标，不公开正文；旧数据缺少对应证据时显示 `unavailable`，不会推测补齐。
- **因果与阵营语义**：旧 `stance` / `trust` / `opposition` 字段只是由模型生成的 `emotion` / `diverge` 推导出的情绪代理值，不是已验证的立场、信任、关系或因果证据；带 `branch_id` 的 causal、faction、report、Replay 和 compare 使用同一有效 root-to-leaf 谱系与 branch cutoff，包含符合范围的分叉前祖先轮次并排除兄弟分支和分叉后的父分支未来。
- **节点追问**：从可用图节点继续发起上下文对话。

主要路由：`/result/:id/compare`、`/replay/:id`、`/workbench/:id`、`/kg-explorer/:id`、`/timeline-galaxy/:id`。

## Agent 与个人数据

- **Agent Library / Workshop**：创建、编辑、收藏自定义 Agent，也可从 PDF 生成。
- **推演内档案**：从 Agent 列表打开档案，分开展示配置立场与已观察情绪。成长事件显示场景、分支、轮次与 `event_type`；只有同时匹配当前路由场景和明确所选分支时才标为“当前 · 所选分支片段”，其它可判定事件标为“历史”。
- **元数据失败不造假**：Agent 发言与结构化情绪/立场解析分成两步。第二步失败时保留真实发言，把观测明确标为不可用并携带有界错误码；live、Replay、Snapshot、导入导出和 Pixel Theater 都不会回填虚假的 `neutral`。
- **身份、记忆与成长**：持久身份档案展示 persona、知识领域、决策风格、记忆和成长事件；推演记忆按 Agent、分支谱系和轮次范围隔离。
- **观察与关系边界**：结果页只从所选有效谱系寻找 Agent 观察，replay 还会应用所选轮次截点；阵营时间线使用当前指定谱系的已物化轮次，包括符合 cutoff 的分叉前祖先轮次。注入下一轮 Agent 上下文的关系信号仅来自同场景、同分支的上一轮，并受条数、长度和证据摘要限制。
- **人物备份与 Agent Pack**：单个人物备份导入会创建新身份，不覆盖已有 Agent。Agent Pack v1 按资料库选择顺序导出并原子导入一组 Agent；不导出身份 ID、owner、记忆、成长历史、对话或单独存储的凭据，并脱敏常见凭据模式，分享前仍应检查自填人设文本。
- **预测日志**：记录概率、resolve 结果并查看校准。
- **历史与排行榜**：按状态查看本地推演，按条件筛选预测榜单。

主要路由：`/agents`、`/agents/new`、`/me/journal`、`/history`、`/leaderboard`。

## Snapshot 演示与实时生成

- **官方样例**：无真实 LLM 时也能一键导入 3 个内置完整推演，直接查看结果、因果档案和 replay。
- **本地 Snapshot**：也可从首页导入自己的 `.swarm` 文件；仓库样例位于 `samples/snapshots/`。导入会在首次写库前拒绝重复的 Agent、Message、Graph Node 源 ID，以及映射到不同坐标的同一 Round 源 ID。
- **Feed 与动作可重放性**：初始 Feed、来源账户和原生动作随 Snapshot 保存并在导入时重映射；Replay 按有效谱系和 cutoff 恢复同一动作世界，不从旧消息猜测缺失动作。
- **实时生成**：新推演、辩论、会客厅和报告需要服务端默认模型、可用 model profile 或本轮 BYOK。精确本地 host 可无 key，远端仍必须提供 key。启用 LLM 时，Debate 的必需发言与裁判结果在重试耗尽或无可用内容后显式失败，不会用确定性文案冒充成功；Ending Room 初始核心计划采用相同的 fail-closed 边界，但 follow-up 仍可 best-effort 使用 anchor。显式关闭对应 LLM 模式时允许确定性内容。
- **模型管理**：`/admin/setup` 用于连接测试和建档；当前组合只有验证成功或明确接受未验证风险后，向导才能完成。`/model-profiles` 用于管理 profile。未改动的 profile 不会复制成缺 key 的 session 覆盖；修改远端端点或模型必须同时提供完整连接，并解绑旧 profile、清除其限速与能力策略。
- **主题包刷新与演示引用**：刷新会重新读取当前同 ID 包详情；切换包时先清除旧详情、模板和操作，迟到响应不能覆盖新选择。随附主题包只列出真实存在的 Snapshot；`demo_snapshots` 可点击、按目录白名单和 Snapshot 合同校验并直接导入。明确失败可以重试；无法确认结果时会提示先检查历史记录，避免重复导入。
- **界面边界**：首页高级设置与 BYOK 是两个独立折叠区。

## 可选搜索

搜索增强、来源家族筛选和来源查询优化默认关闭，需要外部 provider。app-layer 搜索与模型原生搜索是两条路径；统一来源信息流只显示实际返回的网页片段和 citations。配置见 [CONFIGURATION.md](CONFIGURATION.md)。

## 发布完整性

GHCR 的 backend/frontend 镜像从通过 CI 的精确 commit 构建，先写入同一 SHA 的不可变标签，两张都成功后才成对晋升；任一晋升失败会触发并验证两张旧标签的恢复，恢复不完整会显式阻断作业。版本标签还要求同一 SHA 的实际 release signoff。过期的 edge 构建不会覆盖更新的 `main`，release dry-run 只标记为 planned，浏览器关闭失败会让 E2E 失败而不是被吞掉。

## 能力边界

功能入口会随 feature flags、数据状态和 replay/live 模式变化。能力检查会明确区分 loading、error、disabled 和 enabled；失败态提供重试，不会把探测失败误报为禁用。旧 Snapshot 若缺少观察来源，会明确显示快照或无匹配观察，不会伪造世界线与轮次。Local Pack 上下文切换到快速开始等其它入口时会被清除，不会泄漏到下一次启动。Gallery 与 Agent Pack 都是本地、离线文件工作流，不提供 hosted registry、在线发布或社区索引。其它缺失字段会降级为只读、partial 或 unavailable。所有概率、关系和发言都来自模拟，只供娱乐和探索。
