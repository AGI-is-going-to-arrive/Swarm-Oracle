[English](USAGE.en.md) | 中文

# SwarmOracle 使用指南

## 开始前

本地开发使用后端 `18927`、前端 `18928`，浏览器打开 http://127.0.0.1:18928 。启动命令见 [README](../README.md)。

- **离线演示**：无需真实 LLM。启动前后端后，可一键打开 3 个官方完整样例，也可从首页导入 `samples/snapshots/` 中或你自己的 `.swarm` 文件。
- **实时生成**：新建推演、辩论、会客厅和报告需要可用 LLM。配置服务端默认模型、在 `/admin/setup` 保存可用 model profile，或使用首页独立的 **BYOK** 折叠区。明确配置的精确本地 host 可不填 key，远端仍需要 key；随附的默认地址与空值/占位 key 组合只是“未配置”哨兵。

首页的 Agent 数与轮数是主表单滑块。**高级设置** 与 **BYOK** 是两个独立折叠区：高级设置负责模式、显示、本地主题包和搜索等选项；BYOK 负责本轮 LLM 连接。完整变量见 [配置说明](CONFIGURATION.md)。

第一次配置模型时，`/admin/setup` 会测试当前 Base URL、key 与模型的精确组合。只有测试成功，或你勾选“未验证，可能无法运行，仍要保存”，向导才能完成；任一连接字段变化都会清除旧验证与风险确认。本地免 key 只适用于 `localhost`、`127.0.0.1`、`0.0.0.0`、`host.docker.internal` 和 `[::1]` 这些精确 host。

## 发起实时推演

1. 在首页输入“如果……会怎样？”的问题，或选择快速开始、教学模板、本地主题包。导入主题包会一次替换问题、语言、Agent 数、轮数、模式、世界背景、利益约束和角色预览；字段有长度与数量上限。
2. 调整 Agent 数、轮数和模式。需要预置社交环境时，在初始世界事件 Feed 中添加最多 20 条事件：填写来源与正文，并按需填写发布时间、可信度提示和标签；也可载入内置模板后编辑。Feed 内容是不可信数据，请勿粘贴凭据或把它当作系统指令。需要时在高级设置中选择 Classic / Pixel Theater、搜索增强等；需要本轮覆盖 LLM 时单独展开 BYOK。直接选用已保存 profile 时，结果页会按场景恢复它；若修改端点或模型，旧 profile 的模型、key 与 RPM/TPM 会被清空，必须为新绑定重新填写完整连接（精确本地端点仍可免 key）。
3. 点 **开始推演**，在确认框核对设置。按钮不可用时，下方会显示问题为空、LLM 未配置或预算受限等原因。

主题包作者 prompt 会以“Untrusted local pack author note”标记为普通参考证据，不是系统指令。角色预览不会创建或选择持久化的权威 Agent 身份，但有界的姓名、角色和视角会作为不可信世界背景实体进入本局，因此可能影响推演。点“刷新主题包”会重新读取当前同 ID 包的详情；切换包时旧详情、模板和操作会先清空，迟到响应不会覆盖新选择。再选另一主题包会完整替换旧内容，转到快速开始、教学模板或挑战会清掉主题包背景，避免带入下一局。包详情中的 `demo_snapshots` 可直接点击导入；后端只接受当前包和官方目录共同列出的 Snapshot，并执行完整 Snapshot 校验。明确失败时页面会显示可重试错误；如果连接中断导致结果无法确认，先到 `/history` 检查是否已导入，再决定是否重试。

多次推演会先进入等待面板；首条运行可打开实时 `/sim/:id`，全部完成后结果页汇总分布。

## 推演过程中

- 顶部显示轮次、轮内发言进度、总进度和 ETA；慢模型会显示已运行时长。
- Classic 展示分支树，Pixel Theater 展示舞台与工具栏。
- Agent 每轮可在 `POST`、`COMMENT`、`REACTION`、`FOLLOW`、`MUTE`、`SEARCH`、`TREND`、`REFRESH` 和 `IDLE` 中执行一个原生社交动作。目标、搜索、趋势和刷新只有在上一轮真实机会快照允许时才开放；带领域规则的动作还必须满足同一份冻结 schema、状态 revision 和阈值。关注与静音面向当前可见账户；静音来源不会继续出现在该 Agent 的 Feed、搜索和趋势结果中。
- 推演页的领域状态条显示当前分支最多 6 个有界变量、最新 verified 变化和单位。变量旁的阈值入口列出满足/未满足的规则与 actual/expected 值；最新完整轮次因领域 precondition 阻塞而选择 `IDLE` 时，会另列 Agent 与 blocked rule。没有合法 schema、旧数据或无法重放时显示 `unavailable`，不会从发言补算。
- 干预、玩法卡应用、预测押注和世界线承诺只可在 live 状态写入。终局只读已有记录（玩法卡可预览），Replay 不提供写入口。
- 从 Agent 列表打开档案，可区分配置立场与已观察情绪，并查看这次观察对应的世界线和轮次；Replay 只查当前有效谱系与轮次截点，包括截点内的分叉前祖先轮次，没有匹配证据时明确显示“无匹配观察”。绑定持久身份时还会展示已有记忆与成长事件；每条成长事件显示场景、分支、轮次和 `event_type`，只有同时匹配当前路由场景与明确所选分支时才标为“当前 · 所选分支片段”，其它可判定事件标为“历史”。
- 发言成功但情绪/立场元数据解析失败时，发言仍会显示；Agent 档案、Replay 和 Pixel Theater 会把观测标为不可用，不会将其解释成中性情绪。有界错误码会保留在 wire、Replay 与 Snapshot 中，恢复或导入后该状态仍会保留。
- 中断、取消和错误会进入明确终态。页面不会把未完成分支伪装成成功结果。

## 结果页

`/result/:id` 先显示原问题、预测结论和终局世界线。概率只在完成的终局叶分支之间归一，分叉父节点不作为最终结局。报告的 likelihood 和分析置信度也只把已完成终局叶分支作为分支样本，并结合证据数；带符号的情绪收敛代理值不会抬高分析置信度。

常用操作：

- 展开世界线故事，查看因果档案、导演复盘或 `/result/:id/report` 完整报告；因果档案会对照玩法卡、预测押注、世界线承诺与最终结算。
- 查看领域状态条和“世界结局”：后者按分支汇总 initial → final 与净变化，只展示由 verified durable action 确定性重放出的变化，并附有界 action、rule 与可用 Claim refs。无 verified 变化、partial 和 unavailable 分别显示，不会把未发生的变化写成结局。
- 完整报告会显示外层生命周期、已保存章节的生成/重写/静态回退层级、回退原因和证据坐标。章节在生成、重写或双层失败后静态回退时实际执行的有界工具轨迹都会保存，刷新、轮询或重开报告后仍能恢复；结构化 premortem 会按 available / partial / missing 展示失败模式、机制、早期信号、不确定性和独立 evidence chain。当前手动生成流的章节进度和“当前位置”仍是瞬时状态，不会重放。历史摘录由模型依据模拟历史合成并附上分支/轮次位置，不是逐字原始证据、新采访或真实人物言论；分支占比始终标为模拟权重，而非现实概率。
- 进入会客厅、只改一步或世界线圆桌；多结局才显示跨线和圆桌入口。
- 从真实发言创建反事实分支，或从 checkpoint 续跑。
- 打开图谱工作台、知识图谱、时间线、Replay Trace 或 Agent 追问。
- 导出 Markdown、Snapshot、分享链接或预测卡片。脱敏 Public Artifact 可下载为 JSON、单文件 HTML 或复制离线 Gallery hash 链接，`gallery.html` 也能打开本地 JSON；这些操作不会发布到 hosted Gallery 或社区 registry。分享前仍要检查问题、结局和自填文本是否适合公开。

报告、结论或图谱缺失时，页面会显示 unavailable / partial / failed 状态；报告还会区分 generating / cancelled / skipped / stalled / truncated。这些增强功能失败不会抹掉已有世界线结果或已保存章节。

## 模式与工作区

- **辩论竞技场**：从首页启动，运行页 `/debate/:id`，结果页可按需加载论点地图。
- **结局会客厅**：从某条世界线进入。会客厅里的 model profile 选择位于它自己的高级设置中；不选则用全局默认。
- **世界线圆桌**：多结局时可用，支持讨论形式与代表选择；完成后提供 1 对 1 访谈、研究分析师和交叉质询。
- **反事实、续跑与 Replay**：修改某轮真实发言或选择 checkpoint，生成带来源关系的新分支；回放消息、Agent 状态和记忆只读取所选有效谱系及轮次截点之前的内容，包括符合范围的分叉前祖先轮次，并排除兄弟分支和分叉后的父分支未来。自包含 Replay 在自己的 Replay 边界停止。Agent 与轮次选择器会在手机窄屏换行，不需要横向滚动。
- **图谱**：`/workbench/:id` 汇集 Causal、Split、Knowledge Graph；`/kg-explorer/:id` 和 `/timeline-galaxy/:id` 提供独立视图。Causal Review 的 Action Ledger 面板按有效分支谱系展示已持久化的原生动作、目标、状态和领域裁决；展开一条动作可核对 rule、before/after 与失败码。独立证据回执接口投影发言、上下文观察和派生后果，记忆只以哈希引用与来源场景坐标出现。旧推演缺少对应证据时显示 `unavailable`，不会从正文反推。因果图中的旧 `stance` 边和节点只按情绪代理值显示，不是已验证的立场或因果证据。
- **阵营时间线**：结果页会明确当前分析的世界线。旧 `stance` / `trust` / `opposition` 字段只是由模型生成的 `emotion` / `diverge` 推导出的情绪代理值；关系提示只取同场景、同分支上一轮的有界证据摘要。带 `branch_id` 的 causal、faction、report、Replay 和 compare 使用同一有效 root-to-leaf 谱系与 cutoff，包含符合范围的分叉前祖先轮次，不代表所有结局或现实关系。
- **自定义 Agent**：`/agents` 管理 Agent，`/agents/new` 创建或从 PDF 生成；单人物备份导入会新建身份，不覆盖旧身份。Agent Library 还可按资料库选择顺序导出 Agent Pack v1，或在预览后原子导入整包；导出不含身份 ID、owner、记忆、成长历史、对话和单独存储的凭据，并会脱敏常见凭据模式，导入成员会重建为自定义 Agent。

## 其他入口

- `/history`：历史推演
- `/leaderboard`：预测排行榜
- `/me/journal`：个人预测与校准
- `/replay/:id`：replay 分支来源轨迹；公开 replay 会移除本地身份、persona、凭据和仅供 live 使用的连接信息
- `/model-profiles`：模型连接配置
- `/gallery.html`：从本地 JSON 或 `#data=` 链接打开脱敏 Public Artifact；不上传、索引或发布到社区

## 搜索增强

搜索增强是可选的 app-layer 外部检索。服务端配置可直接复用；首页高级搜索区也可为本轮提供搜索 provider。模型原生搜索属于 LLM profile 的另一条能力路径。两者都只在真实产出来源时显示 citations。配置见 [CONFIGURATION.md](CONFIGURATION.md)。

## 常见问题

- **能打开页面但不能开始新推演？** Snapshot 演示不代表 LLM 已配置。检查 `/admin/setup`、model profile 或服务端 `LLM_*` 配置。
- **演示快照导入后连接中断？** 结果可能已经提交，先到 `/history` 检查，再决定是否重试；明确的校验或服务端失败会直接显示失败状态。
- **为什么分支视图里会出现祖先轮次？** branch-scoped causal、faction、report、Replay 和 compare 都读取有效谱系及 cutoff；自包含 Replay 只读取自身坐标。
- **Gallery 会把内容上传到社区吗？** 不会。JSON、单文件 HTML、hash 链接和本地文件 viewer 都是离线分享方式，不是 hosted registry。
- **本地模型没有 API key？** 使用上述精确本地 host 并填写模型 ID；免 key 请求不发送 `Authorization`。随附的 `127.0.0.1:8317 + 空值/占位 key` 是“未配置”哨兵，请改用实际地址或在 Setup 中明确保存该连接。相似子域名、数字/十六进制 loopback 写法和其它远端地址不会被当作本地，仍必须提供 key。
- **前端一直等待？** 确认后端已在 http://127.0.0.1:18927 运行；前端依赖 `/api` 与 `/ws` 代理。
- **功能入口缺失？** 页面会区分能力检查中的 loading、error、disabled 和 enabled；error 可直接重试。确认禁用后再查看 `/api/capabilities` 与对应 `FEATURE_*`，修改环境变量后重启后端。
- **旧 Snapshot 没有 Agent 情绪来源？** 页面会标为快照或无匹配观察，不会补写不存在的世界线和轮次。
- **旧推演为什么没有完整的 Action Ledger 证据？** 原生动作和上下文回执只存在于记录了对应合同的推演；旧数据会显示 `unavailable`，不会从发言猜测动作或记忆使用情况。
- **为什么找不到 verified memory promotion 的开关或记录？** 该能力目前只是默认关闭的后端 core，只有 `FEATURE_AGENT_IDENTITY=true` 与 `FEATURE_MEMORY_PROMOTION=true` 同时满足时才会启用，并且没有 capability、REST 或 UI 入口。不要把已有 Identity Inspector 或 Action Ledger 的哈希引用当成已启用的 promotion 证据；Stage 3B 激活面尚未交付。
- **可以把预测当事实吗？** 不可以。不要用于金融、医疗、法律或其它现实决策。
