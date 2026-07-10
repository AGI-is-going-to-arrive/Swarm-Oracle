[English](FEATURES.en.md) | 中文

# SwarmOracle 功能索引

本页按能力类别列出主要入口，不再维护逐项发布核对表。操作步骤见 [USAGE.md](USAGE.md)，默认值与开关见 [CONFIGURATION.md](CONFIGURATION.md)。实际可用能力以运行中的 `/api/capabilities` 为准。

![推演与结果](screenshots/21-simulation.png)

## 核心推演

- **问题入口**：快速开始、教学模板、本地主题包和每日/每周挑战会把问题与建议设置带入首页。
- **文档种子**：上传资料，为本轮添加世界背景与 Agent 预览；它不会替用户填写问题。
- **多 Agent 世界线**：支持 Agent 数、轮数、谨慎/均衡/探索模式、多次推演和分支概率。
- **两种视图**：Classic 分支树用于查看结构，Pixel Theater 用舞台、气泡和工具栏展示 live 运行。
- **Live 玩法**：干预、玩法卡、预测押注和世界线承诺只在 live 推演中可写；终局只读已有记录，replay 不提供写入口。
- **辩论竞技场**：正方、反方和评委按阶段推进，结果可按需加载论点地图。

主要路由：`/`、`/sim/:id`、`/debate/:id`、`/debate/:id/result`。

## 结果与报告

- **终局世界线**：显示结论、置信度、每条叶分支的回答、概率与故事；父分叉不计入终局分布。
- **完整报告**：`/result/:id/report` 展示章节、证据、不确定性、观察指标和可用图表；partial / failed / truncated 都有明确状态。
- **因果档案与复盘**：把玩法卡、预测押注、世界线承诺和终局结算放在同一条可追踪记录中；另有导演复盘、用户预测对比、run-group 分布和阵营时间线。
- **导出**：Markdown、Snapshot、固定链接、预测卡片和脱敏公开 artifact；公开 replay 不携带本地身份、persona、凭据或仅供 live 使用的连接信息。

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
- **Replay Trace**：追踪反事实和续跑分支的来源；消息、Agent 状态和记忆按所选谱系与轮次截点隔离，不混入兄弟分支或分叉后的未来信息。
- **图谱工作台**：Causal、Split、Knowledge Graph 三种视图；另有知识图谱浏览器和时间线星系。
- **节点追问**：从可用图节点继续发起上下文对话。

主要路由：`/result/:id/compare`、`/replay/:id`、`/workbench/:id`、`/kg-explorer/:id`、`/timeline-galaxy/:id`。

## Agent 与个人数据

- **Agent Library / Workshop**：创建、编辑、收藏自定义 Agent，也可从 PDF 生成。
- **推演内档案**：从 Agent 列表打开档案，分开展示配置立场与已观察情绪，并标明对应世界线和轮次。
- **身份、记忆与成长**：持久身份档案展示 persona、知识领域、决策风格、记忆和成长事件；推演记忆按 Agent、分支谱系和轮次范围隔离。
- **人物备份**：导入会创建新身份，不覆盖已有 Agent。
- **预测日志**：记录概率、resolve 结果并查看校准。
- **历史与排行榜**：按状态查看本地推演，按条件筛选预测榜单。

主要路由：`/agents`、`/agents/new`、`/me/journal`、`/history`、`/leaderboard`。

## Snapshot 演示与实时生成

- **官方样例**：无真实 LLM 时也能一键导入 3 个内置完整推演，直接查看结果、因果档案和 replay。
- **本地 Snapshot**：也可从首页导入自己的 `.swarm` 文件；仓库样例位于 `samples/snapshots/`。
- **实时生成**：新推演、辩论、会客厅和报告需要服务端默认模型、带 key 的 model profile 或本轮 BYOK。
- **模型管理**：`/admin/setup` 用于连接测试和建档，`/model-profiles` 用于管理 profile。
- **界面边界**：首页高级设置与 BYOK 是两个独立折叠区。

## 可选搜索

搜索增强、来源家族筛选和来源查询优化默认关闭，需要外部 provider。app-layer 搜索与模型原生搜索是两条路径；统一来源信息流只显示实际返回的网页片段和 citations。配置见 [CONFIGURATION.md](CONFIGURATION.md)。

## 能力边界

功能入口会随 feature flags、数据状态和 replay/live 模式变化。能力检查会明确区分 loading、error、disabled 和 enabled；失败态提供重试，不会把探测失败误报为禁用。旧 Snapshot 若缺少观察来源，会明确显示快照或无匹配观察，不会伪造世界线与轮次。其它缺失字段会降级为只读、partial 或 unavailable。所有生成内容只供娱乐和探索。
