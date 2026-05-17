# Backend 模块地图

> 文档类型：L0 current-truth
> 作用：描述后端模块分工、authority 与运行时边界。详细实现以源码为准，历史验证流水不再写入本页。

## 技术栈

- FastAPI
- SQLModel + SQLite
- ChromaDB
- Alembic
- OpenAI-compatible LLM
- Prometheus 文本指标

## 模块地图

### 入口与路由

| 模块 | 位置 | 责任 |
|------|------|------|
| App 入口 | `backend/app/main.py` | 挂载所有 router、根信息、`/metrics` |
| Admin | `backend/app/api/admin.py` | admin preflight 与 LLM 连接测试；受 session gate 保护，`ADMIN_TOKEN` 非空时还要求 `X-Admin-Token` |
| Scenarios | `backend/app/api/scenarios.py` | scenario 创建、查询、列表、删除、story、replay artifact、snapshot export/import；scenario/story branch response 会回显 `parent_branch_id / fork_round / fork_reason / replay_kind / replay_source_branch_id`，并在 Result Quality 开启时回显 `verdict / verdict_confidence / branches[].question_answer` |
| Agents | `backend/app/api/agents.py` | identity 列表 / preflight、memory、growth-events、identity inspector、自建 Agent workshop、收藏、PDF 文档生成 Agent 与 Agent 备份导入导出；identity preflight 解析超时按 504 fail-closed |
| Quota | `backend/app/api/quota.py` | conversation / replay quota summary；bucket 会回显 `enforced / scope / window_seconds` |
| Interventions | `backend/app/api/interventions.py` | 即时 / 回溯 / 批量干预、模板；正式玩法卡注入会在后端校验 contract、冷却、点数和 pending metadata，玩法卡业务校验失败返回结构化 `422` |
| Campaign | `backend/app/api/campaign.py` | director/gameplay authority、profile、mastery、badge、summary、score breakdown、只读 intervention effect receipts |
| Conversation | `backend/app/api/conversation.py` | 图谱节点对话的 thread/start/get/turn/abort；`/turn` 通过 SSE 返回 assistant stream |
| Predictions | `backend/app/api/predictions.py` | scenario prediction、评分、leaderboard 与 segment filters |
| Journal | `backend/app/api/journal.py` | 个人预测日志、resolve 与 calibration 数据 |
| Debate | `backend/app/api/debate.py` | debate live/result/import-replay/predict；后台 participant update 通过 WS 推给 live 页 |
| Ending Room | `backend/app/api/ending_rooms.py` | ending-room room/result/thread/user-turn、roundtable survey/analyst SSE 与 WS |
| Scenario WS | `backend/app/api/ws.py` | 主模式 WebSocket + thread-scoped agent-conversation WebSocket |
| Social | `backend/app/api/social.py` | 社交文案与 Markdown 导出 |

### 服务层

| 模块 | 位置 | 责任 |
|------|------|------|
| Simulator | `backend/app/services/simulator.py` | scenario 主循环、fork、分支标题生成提示、narration 编排、Result Quality verdict 生成与 branch question-answer 持久化、干预 pending metadata 消费与 effect receipt 写回；receipt 写回前会核对当前 scenario/branch，Phase 3 hooks (causal/factions WS/checkpoint/identity lifecycle)；Agent prompt 会带当前世界线标题/分叉原因，Agent 可见消息会剥离内部 `[DIVERGE: ...]` / `[DIVERGE：...]` 标记 |
| Simulation Cancel | `backend/app/services/simulation_cancel.py` | scenario 取消 token、DB cancelled fallback 与后台任务取消信号 |
| Preflight | `backend/app/services/preflight.py` | admin/CLI 预检：SQLite、ChromaDB、LLM、web search、CORS、volume |
| Agent Identity | `backend/app/services/agent_identity.py` | continuity key 预览 / 解析、跨场景 identity、growth event、memory 查询 |
| Personality Drift | `backend/app/services/personality_drift.py` | 从 identity metadata、消息和成长事件派生 Big Five drift warning |
| Memory | `backend/app/services/memory.py` | L1 压缩、context 组装；Agent context 可接收当前世界线块，提醒同一角色在不同分支里不要复用同一组例子和结论；已知玩法卡用 contract label，未知 `card_label` 会按 untrusted data 包裹 |
| Web Context | `backend/app/services/web_context.py` | 搜索增强 provider dispatch、请求级 override、搜索深度预算、缓存、`ProviderSearchOutcome` 状态映射、native citation 序列化与上下文格式化 |
| LLM Client | `backend/app/services/llm_client.py` | LLM 调用、并发控制、限流、熔断、JSON stream-first fallback；Responses API native search tools 只在已识别 provider + 非 proxy 路径启用 |
| Native Search Adapters | `backend/app/services/native_search_adapters.py` | provider-specific native search tools/citation parsing；当前有 xAI native pilot、OpenAI structural adapter/fixtures 和 null adapter；OpenAI live signoff 仍是 backlog |
| Conversation Service | `backend/app/services/conversation_service.py` | conversation thread/turn 创建、bootstrap claim、SSE stream 终态与取消原因收口 |
| Roundtable Survey | `backend/app/services/roundtable_survey.py` | 世界线圆桌问卷 SSE；按 room 绑定 participant、补 identity memory、并发发问后逐条回传 |
| Roundtable Analyst | `backend/app/services/roundtable_analyst.py` | 世界线圆桌 analyst SSE；有界 ReACT 工具循环，串 causal graph / identity memory / web evidence |
| Vector Store | `backend/app/services/vector_store.py` | Chroma L2 记忆 + identity memory/profile；identity profile 写入有 pending gate、SQLite runtime lock、本地 Chroma lock 与 5 秒调用方等待上限 |
| Ending Room Service | `backend/app/services/ending_room_service/` | room/thread scope、follow-up、后台生成（已拆分为 `__init__.py` + `_utils.py` + `_content.py` + `_participants.py` + `_threads.py`） |
| Scoring | `backend/app/services/scoring.py` | prediction 评分与 leaderboard 物化 |
| Journal Service | `backend/app/services/journal_service.py` | personal prediction journal 写入、resolve、分页与 calibration 聚合 |
| Document Ingestion | `backend/app/services/document_ingestion.py` | PDF 文本抽取、长文档实体抽取与 persona 生成 helper |
| Education Templates | `backend/app/services/education_templates.py` | 教育场景模板列表、分类 / 难度筛选与单模板读取 |
| Agent Backups | `backend/app/services/persona_export.py` | Agent 备份 schema v1 导出、批量导出、导入校验与 custom identity 创建 |
| Hallucination Gate | `backend/app/services/hallucination_gate.py` | verdict 后的 warning-only claim / evidence 检查 |
| Graph Analysis | `backend/app/services/graph_analysis.py` | 对最新 causal graph snapshot 做度数分布、god nodes、跨分支边摘要；大图会返回 `truncated: true` |
| KG Realtime | `backend/app/services/kg_realtime.py` | 合并 `GraphDelta` 后通过 scenario WS 推送 `kg:delta`，payload 过大或失效时推送 `kg:snapshot_invalidated` |
| Snapshot Export | `backend/app/services/snapshot_export.py` | scenario ZIP export/import、manifest/checksum、旧 ID 到新 ID remap、intervention receipt ledger、物理 member 计数、重复 member 拒绝与 ZIP 安全校验；JSON 字符串字段只有对象/数组会递归脱敏，malformed 或标量值按空值处理 |
| Runtime Lock | `backend/app/services/runtime_lock.py` | SQLite shared lease + lease refresh，防重入 |
| Debate Prompts | `backend/app/services/debate_prompts.py` | Debate motion/cast/turn prompt；LLM name、role、persona 生成与清洗 |
| Gameplay Contract | `backend/app/services/gameplay_contract.py` | 读取共享玩法契约，生成后端权威的安全玩法卡指令与可读 prompt；目标世界线、Agent 名和自定义 directive 都按 untrusted data 包裹进 prompt |

### 数据模型

| 模块 | 位置 | 责任 |
|------|------|------|
| Core Models | `backend/app/models/database.py` | `Scenario`、`Branch`、`Round`、`Message`、`ReplayArtifact`、`PendingIntervention`、`InterventionLog` 等 |
| Agent Identity Models | `backend/app/models/agent_identity.py` | generated/custom identity、persona metadata、preferred tier、favorite 标记 |
| Campaign Models | `backend/app/models/campaign.py` | director profile、mastery、badge、campaign log |
| Debate Models | `backend/app/models/debate.py` | debate、turn、prediction、counterplay |
| Ending Room Models | `backend/app/models/ending_room.py` | room、participant、thread、turn |
| Prediction Models | `backend/app/models/predictions.py` | prediction、leaderboard |
| Prediction Journal Models | `backend/app/models/prediction_journal.py` | personal prediction journal entry |

## 当前 authority

### 主模式

- `Scenario.director_state_json`
  主模式 director goals、risk/resource、commitment 的 authority。
- `Scenario.gameplay_state_json`
  玩法卡、押注、archive raw 的 authority。
- 这两块都通过 `campaign` 路由读写，并带 `revision` 乐观并发控制。
- `PendingIntervention.metadata_json`
  只保存待处理干预的运行时元数据，例如玩法卡、profile、目标分支和原始用户输入；玩法卡 prompt 由后端 contract 重建，snapshot import 不会把 pending queue 重新排队。
- `InterventionLog.effect_summary_json`
  干预完成后的只读效果回执；effects endpoint 和 snapshot export/import 都读取这份持久化数据，不从前端重算。写回时会丢弃 scenario/branch 不匹配的 pending metadata。
- `Scenario.parsed_context.result_quality`
  Result Quality 的持久载荷；当前存顶层 `verdict / confidence / question_answer` 和 `branch_question_answers`，受 `FEATURE_RESULT_VERDICT` 控制，不是新表或新 column。
- campaign finalize 与 scenario summary 当前返回同一套 `score_breakdown`；每项包含 `id / label_key / points / applied`，由后端按 archive grade、profile resonance、daily challenge、押注、director goals 与 worldline commitment 派生，不是新的持久化字段。
- fork detector 当前要求新分支标题写成“行动 + 目标/后果”。
  这些标题仍作为 `Branch.title` 持久化，并随 `branch_fork` 事件广播给前端。
- `POST /api/scenario/{id}/cancel` 当前只接受 `parsing / simulating / narrating / cancelled`：
  - 请求会先把可取消 scenario 持久化为 `cancelled`
  - token 获取是幂等的；即使本进程已经有未触发 token，后续检查也会回读 DB `cancelled` 并设置本地 event
  - 如果本进程有运行中的 background task，会直接 `task.cancel()`
  - `done / error` 返回 `409 SIMULATION_NOT_RUNNING`，不会被取消路径降级
- simulator 不会覆盖 `cancelled / done / error` 终态；取消事件广播前，agent message 会先落库，避免前端收到不可重放的 stale 事件。

### Replay

- 短链 replay 通过 `ReplayArtifact` 持久化。
- `GET /api/scenario/{id}` 与 `GET /api/scenario/{id}/story` 的 `branches[]` 会带 `fork_round / replay_kind / replay_source_branch_id`，用于结果页还原 fork point，并让 replay、import、counterfactual 和 resume 链路恢复来源语义；普通分支的 replay 字段可为空。
- SQLite 数据库如果是“由 lightweight bootstrap / `SQLModel.metadata.create_all()` 建出来、但还没有 `alembic_version`”的旧库，`init_db()` 当前会先补齐轻量 additive columns（包括 `graph_edge` 的 evidence 字段），再 `stamp` 到当前 head 并执行 upgrade；不会再重放初始迁移把已有表撞成 `table already exists`。
- 同一类无版本旧库如果缺少后来加入的 SQLModel metadata 表，`init_db()` 会先按 metadata 补齐缺表，再 stamp 到当前 head；例如 `prediction_journal_entries` 不会因为旧库被直接 stamp 而缺失。
- SQLite 本地旧库如果还留着 legacy `uq_ending_room_scope` 唯一索引（`scenario_id + anchor_branch_id + room_type + participant_set_hash`），`init_db()` 当前也会在 lightweight fallback 和 Alembic upgrade 后统一修回 `scope_fingerprint`；generation 升级后再点结果页 `进入会客厅 / 异线旁听席` 不会再因为旧索引直接 `500`。
- `counterfactual` 与 `resume` 当前共用独立的 replay branch runtime lock；慢 clone / seed 路径也会续租，不再只在短请求里可靠。
- `resume` 当前会先完成 scenario/source branch/round 校验，再尝试 replay branch lock；这些前置校验失败不会占用 replay branch lock。
- replay branch runtime lock 当前按 fail-closed 收口：
  - 续租返回 `None`、续租抛异常，或本地 lease 已过期时，`counterfactual / resume` 都不会继续 clone / seed / schedule
  - 如果锁丢失前，别的请求已经吃满最后一个 replay branch slot，会回退成 `429 REPLAY_BRANCH_LIMIT_REACHED`
  - heartbeat 会在请求侧校验完成后才启动，避免同一请求自己的 SQLite 校验事务和 heartbeat 抢锁
  - heartbeat 刷新异常时会释放原 replay lease，不再把后续 replay/resume 锁死到 TTL 过期
- 前端分享链路优先使用后端 artifact，失败时才回退本地 token。
- `delete_scenario()` 当前也会同步清理该 scenario 关联的 `ReplayArtifact`，不会继续保留可读的旧 share artifact。
- `delete_scenario()` 当前不会删除个人 prediction journal 历史；它会把相关 journal entry 的 `scenario_id` 置空，避免 FK enforcement 下硬删除失败，也避免用户日志跟着 scenario 一起消失。
- `compare_branches()` 当前会先验证 `branch_a / branch_b` 属于传入的 `scenario_id`，不再允许跨场景 branch 混入 compare 结果。
- `POST /api/scenario/{id}/counterfactual` 当前会在 clone 前先校验目标 `round_number` 里确实存在该 `agent_id` 的消息：
  - scenario 状态必须是 `done`；否则返回 `409 COUNTERFACTUAL_SCENARIO_STATUS_INVALID`
  - source branch 不存在时返回 `404 COUNTERFACTUAL_BRANCH_NOT_FOUND`
  - `round_number` 超出 source branch 已有范围时返回 `400 COUNTERFACTUAL_ROUND_OUT_OF_RANGE`
  - `round_number < 1` 会先被 schema 拦成 `422`
  - 找不到目标消息时返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_NOT_FOUND`
  - 同 agent 同轮有多条消息时，如果前端没带 `source_message_content`，会返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS`
  - 前端带了 `source_message_content` 但找不到唯一匹配时，会返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_MISMATCH` 或 `400 COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS`
  - 纯空白的 `source_message_content` 当前会按“未指定”处理，不再单独打成 mismatch
  - 如果 seed 阶段仍失败，后端会把刚创建的 replay branch、round 和 message 一起清掉，不再留下脏 branch 占 quota
- `POST /api/scenario/{id}/resume` 当前会先预占 `simulation lock`，再把锁 lease 传给后台任务：
  - 锁拿不到时直接返回 `409 SIMULATION_ALREADY_RUNNING`
  - 预占成功后的 lock lease 会在后台续跑期间持续续租，直到任务结束才释放
  - 如果后台续跑期间丢掉这把预占 lock，任务会直接 fail-closed 落成 `error`，不会失锁后继续跑
  - 不再出现 `201` 已返回、但后台其实没启动、scenario 卡在 `simulating` 的假成功
- `GET /api/scenario/{id}/checkpoints?branch_id=...` 当前会先确认 branch 属于同一个 scenario；跨 scenario 或不存在的 branch 返回 `404 CHECKPOINT_BRANCH_NOT_FOUND`，不会退成空列表。
- causal graph snapshot 当前会返回 `available_branches`（包含 fork payload 里的 `children`，也包含已完成结局分支），供前端 branch selector 在过滤态下继续保留全量可切分支。
- causal graph snapshot 当前在 child branch 过滤时，也会保留该 fork 的直接 provenance 节点，不再返回只有 fork 自己的孤儿图。
- causal graph snapshot 当前会把已完成的 `Branch` 投影成合成 `outcome` 结局节点：
  - payload 带 `branch_id / title / probability / status / story_excerpt / insight / parent_branch_id`
  - 同 branch 能找到最近 event / stance_shift / fork 时，会补一条 `led_to` 边连到结局节点
  - 带 `branch_id` 过滤时，只返回匹配分支的结局节点，但 selector 仍保留所有可用分支
- causal graph append 当前在“先重放早轮、后面轮次已存在”时，会把同 branch 的下一轮 temporal edge 一起补回；同一 round 如果不再产生 fork，也会清掉旧 fork 节点和 `available_branches` 里的残留 child branch，不再把过期分支信息留在快照里。
- fork 节点当前会保留原始 `reason`，同时生成面向用户的 `display_reason / display_summary`；API 返回的 fork label 使用 `display_reason`，避免把 `因此应 fork` 这类内部模板话直接露给用户。
- fork-only append 当前不会把同 round 已有 event / stance_shift provenance 清掉；旧 snapshot 如果已经留下孤立 fork，`build_snapshot()` 会从持久化的 `Round / AgentMessage` 回补只读合成 event provenance，并用 `synthetic_provenance=true` 标记。
- causal graph append 当前也会在同一 `branch / round` 的 event 节点之间补 inter-agent 边：
  - `responds_to`：消息正文提到另一位 agent 的可信 display name；不会拿短 id 兜底匹配
  - `supports_stance / opposes_stance`：只按本轮派生 stance score 的固定阈值判断，不调用 LLM
  - 重放同一轮时，只清理当前 branch 当前轮 event 节点之间的旧 inter-agent 边，不会误删其它 branch 的同轮边
- `GET /api/scenario/{id}/causal-graph` 当前会先校验 `branch_id` 属于当前 scenario：
  - 空白 `branch_id` 仍归一化为“全部分支”
  - 不存在的 branch 会返回 `404 BRANCH_NOT_FOUND`，不再伪装成 `200 + 空图`
- `GET /api/scenario/{id}/graph-analysis` 当前同时要求 `FEATURE_GRAPH_ANALYSIS=true` 和 `FEATURE_CAUSAL_GRAPH=true`；返回 god nodes、degree distribution、cross-branch edges 和 summary。`summary.total_nodes` 统计的是序列化 causal snapshot 的可见节点，包含合成 `outcome` nodes。分析前会先按最新 snapshot 的 node/edge 数做 SQL 预检，超过 `5000 nodes / 20000 edges` 时返回 `truncated: true`；带 `branch_id` 时，预检会按该 branch 的可见节点/边计数，避免大 scenario 下的小 branch 查询被保守截断。
- `GraphEdge` 当前已有 `confidence_tier / source_ref / source_round_number / evidence_json` nullable 字段。causal graph 新边会写入 coarse evidence，并在 API response 里返回；重放轮次遇到旧 edge 时，会只补齐缺失的 evidence 字段，不覆盖已有非空值。inter-agent 边会把确定性 rule / reason 写进 `evidence_json`；其它 causal graph 写图路径仍可能只有 coarse provenance。debate argument map 也会在 `GET /api/debate/{id}/argument-map` 的 `edges[].evidence` 返回 `confidence_tier / source_ref / source_round_number / detail`。`detail` 只是 `evidence_json` 的透传，不是 LLM 解释文本。
- `GET /api/scenario/{id}/personality-drift` 当前要求 `FEATURE_AGENT_IDENTITY=true`，并先校验 caller 能看到该 scenario。返回值按 drift score 排序，只做 warning 数据，不阻断 verdict；波动项来自消息 emotion 变化，不把 `Agent.stance` 当成时间线字段。
- `GET /api/scenario/{id}/snapshot` 当前要求 `FEATURE_SNAPSHOT_EXPORT=true`，并先校验 scenario ownership。ZIP 包含 `manifest.json`、scenario、branches、agents、messages、causal graph、`intervention_receipts.jsonl` 和 `checksums.sha256`；manifest 会带 receipt schema version。默认不导出 `user_id`，也会剥掉 API key、base URL、token、password 及常见 provider secret key 变体，branch `key_moments`、web context 和 effect summary 这类 JSON 字符串也会被清理；malformed JSON 字符串或解析后不是对象/数组的值会导出为空值，不再把原文带出。
- `POST /api/scenario/import-snapshot` 当前也受 `FEATURE_SNAPSHOT_EXPORT` gate；开启 `SESSION_SECRET` 时要求 signed principal。上传上限是 50 MB；导入前会拒绝绝对路径、`..`、反斜杠路径、symlink、重复 ZIP member name、超过 256 个物理 member、超大 member、总解压超限、异常压缩比、manifest/schema/checksum 不匹配、非 UTF-8 JSON/JSONL、单行超过 1 MB 的 JSONL，以及超过 100000 行的 JSONL。导入会新建 scenario/branch/agent/message/graph/intervention receipt 主键并 remap FK，branch `replay_source_branch_id` 与 receipt 的 scenario/branch/log/agent 引用也会 remap；映射不到的旧引用会清空，但顶层 receipt `branch_id` 映射不到会拒绝导入。旧 snapshot 没有 `intervention_receipts.jsonl` 时仍可导入，pending intervention 不会随 snapshot import 重新排队。

### Ending Room

- `ending_room` 是独立域。
- room、thread、participant、turn 都在独立表中维护。
- room/thread transcript 与 memory partition 隔离，不与主模式消息链混用。
- `create_ending_room()` 当前会把 `generation_version` 并入 scope 去重；旧 generation 的 room 不会再被结果页或 roundtable 新入口复用。
- `ending_room_turn.question_anchor_ids_json`
  当前已用于显式记录 `quote / verdict / key_moment / phase` 等锚点来源。
- `ending_room_thread.question_anchor_ids_json`
  当前也已成为真实字段，thread create 与后续 replay/read-only 恢复都能保留锚点语义。
- `EndingRoomInteractionMode` 当前支持 7 种模式：
  `auto_recap / archivist_route / hotseat / all_present / thread_followup / epilogue / evidence_card`。
  - `epilogue`：后续三回合短叙事推演，不重启主 simulation。
  - `evidence_card`：把另一条世界线的摘要卡引入当前讨论，由档案官解释差异。
- `thread_followup` 的 generation/rewrite prompt 当前会明确要求回答 active thread 与当前 anchor；不能重开 verdict、复述整间房、扩到新话题，或解释线程机制。
- `create_ending_room_thread()` 当前会在创建阶段校验 room type 与 `interaction_mode` 的组合是否合法；例如 `worldline_roundtable` 不会再先落库一个从一开始就不可用的 `all_present` thread。
- Oracle 的 participant snapshot 当前会带 `agent_name / agent_role / agent_persona / agent_stance / agent_emotion / tier / impact_score / branch_pressure / latest_quote / opening_quote / source_type`，供 ending-room / roundtable 的 LLM 生成直接消费。
- `ending-room / roundtable` 的主文案生成当前走 `LLM first, template fallback`：先 structured LLM，再 plain-text retry，最后才回 deterministic fallback；模板不再是主路径。
- roundtable verdict 和 follow-up 的 deterministic fallback 当前必须是 display-ready copy：不能包含 prompt 指令、模式标签或事实清单式占位，因为 LLM 关闭或耗尽时它会直接展示给用户。
- `_phase_insight()` 当前会把长 turn commentary 压成 phase-specific 的一句主持人提炼；后端 result 不再默认把整段 transcript 复制进 phase insight。
- Oracle 主文案的 LLM 路径当前先走 generation-first prompt，这一步不会把 anchor copy 当中心参考；只有生成为空或失败时，才进入带 anchor reference 的 rewrite fallback，最后才退 deterministic fallback。
- Oracle prompt 当前包含双层角色化词汇提示：
  - 领域调色板层：按 voice variant（imperial / field / finance / market / faith / industry / frontier / survival / scholar / civic / diplomat / advisor / science / tech-visionary / journalist / educator / artist / entrepreneur，共 18 种）提供领域专属术语、句式风格和情绪基调。ASCII 关键词按词边界匹配，CJK 仍按子串匹配，避免 `warlord/lord`、`consultant/consul`、`federation/ration` 这类旧误匹配；关键词匹配也会避开已知过宽词，例如 `medium confidence` 不应误入 artist，`large-scale` 不应误入 entrepreneur。
  - 身份层：从 `persona_snapshot_json` 中提取 agent 的实际身份（`agent_role`）、简介（`bio_short`）、影响力（`impact_score`）、叙事地位（`tier`）和推演参与度（`turn_count / key_moment_hits`），动态生成 identity 提示。
  - prompt 里只有静态领域词汇会进入可信 `Persona vocabulary` 行；身份层会通过 `Persona Vocabulary Identity / UNTRUSTED DATA` fenced block 注入，三反引号和 prompt-injection 标记由统一 helper 处理。
  - 高影响力 agent（impact_score ≥ 0.75）措辞更自信有分量；低影响力 agent（≤ 0.35）措辞更谨慎。
  - 档案官有独立的词汇提示，不受 variant 影响。
  - plain variant 没有领域词汇，但仍可输出身份层（只要 snapshot 有数据），并同样按不可信文本处理。
- `_load_branch_transcript_excerpts()` 当前用窗口函数一次取每条分支最近 top-N 消息；调用方可传 `branch_ids` 限定范围。room plan 只查当前 participants 所在分支，follow-up 只查本次 responder 所在分支，不再为每次追问 rank 整个 scenario 的所有分支 transcript。
- `ending_room_turn` 的 `cited_branch_id` 与 `cited_refs_json` 当前已从 API 层开放写入。
  - `cited_branch_id` 会做 scenario 级验证，不允许跨场景引用。
  - `cited_refs_json` 有 4 KB 大小限制。
  - assistant follow-up turn 会保留已接受的用户 `cited_branch_id`；`cited_refs_json` 会带 `kind / thread_mode`，并把用户原始引用放进 `source`。
  - follow-up context hint 当前会把引用世界线的标题、hinge、insight 与最多 4 个 anchor id 一起交给生成层。
- Agent identity L2 profile 当前使用独立 `identity_profile_{user_id}` collection：
  - generated/custom identity 都会同步 profile
  - custom agent create/update/delete 会同步写入或清理 profile
  - 旧的 shared-collection profile 文档会在后续写入时自动清理，不再参与 memory eviction / compaction
- 自建 Agent 当前多一层 `preferred_tier`：
  - 迁移 `026_agent_identity_preferred_tier` 给 `agent_identity` 增加 `preferred_tier`，SQLite 走幂等 `ALTER TABLE ... ADD COLUMN ... DEFAULT 'IMPORTANT'`
  - 迁移 `028_agent_favorite` 给 `agent_identity` 增加 `is_favorite`，用于 Agent Library 收藏筛选
  - workshop create/update 只接受 `IMPORTANT / CROWD`
  - 旧行里 `preferred_tier` 缺失、为空或无法识别时，注入层和 simulator 会回退到 `IMPORTANT`
  - 自建 Agent 不允许获得 `CORE`；如果数据库里已经有脏的 custom `CORE`，scenario 注入和 `_agent_to_dict()` 都会降成 `IMPORTANT`
  - workshop update/delete 只允许 `kind=custom`；generated identity 会返回不可编辑/不可删除的业务错误
  - `decision_bias` 固定为 `caution / optimism / conservatism / risk_tolerance / creativity` 5 个 key；缺失 key 补 `0.5`，数字字符串会转成 float，boolean、非数字、`NaN/Inf`、超出 `0..1` 或未知 key 都会被拒绝
  - `knowledge_domain_json / decision_bias_json` 解析失败时会降级为空 metadata，不阻断列表、推演或 debate
  - 主推演和 Debate prompt 里，自建 Agent 的名字、角色、persona、knowledge domains 和 decision bias 都按不可信输入注入，不把用户文本当系统指令
  - 非 custom 的 Debate cast 在 LLM upgrade 时也会先清洗 name / role：控制字符、fence 和常见 prompt-injection 标记会被去掉，空值或失败时回退 deterministic 模板
- Agent Library 相关 API 当前按 user scope 收口：
  - favorite 只允许当前用户自己的 identity；跨用户或不存在统一返回 404
  - identity inspector 会先校验 owner，再读取最多 100 条 memory；向量库异常会落 `error` 字段，不把只读 inspector 变成 fatal
  - PDF 文档生成 Agent 只接受 PDF；`application/pdf / application/x-pdf` 直接通过，空 content type 或 `application/octet-stream` 只在文件名以 `.pdf` 结尾时作为兼容路径接受。上传上限 25 MB；空文件、非法 PDF、无可抽取文本和超大文件都会返回结构化错误
  - PDF 解析最多读取 200 页 / 1000000 字符，并带 30 秒解析超时；超时返回结构化错误，不让上传请求无限卡住
  - 短文档继续走原有 chunk 抽取；长文档先做采样粗扫，再用候选名和 alias 在全文里取证据片段精提。粗扫、候选和证据文本都会包进 untrusted text block；malformed JSON、非对象条目和超大 LLM JSON response 会被拒绝或跳过
  - 实体提取和 persona 批次使用独立超时；persona 生成按 `0.7 -> 0.6 -> 0.5` 递减温度重试。部分 persona 失败会保留已创建 Agent，并在响应里返回 `agents_failed`；全部失败才返回结构化错误
  - Agent 备份导出/导入使用 `schema_version=1`；bulk export 最多 20 个；import 会创建新的 custom identity，不覆盖旧数据
  - Agent 备份导入会把 decision bias 归一化到 `caution / optimism / conservatism / risk_tolerance / creativity` 5 个 key；boolean、`NaN/Inf` 或非数字值落到默认值，超出 `0..1` 的数字会被 clamp
- Prediction Journal 当前由 `prediction_journal_entry` 持久化：
  - 迁移 `027_prediction_journal` 创建 journal 表
  - 迁移 `029_prediction_journal_calibration_index` 给 `user_id / resolved_at / actual_outcome` 增加 calibration 查询索引
  - list/create/resolve/calibration 都按当前 user scope 查询
  - create 绑定 `scenario_id` 时只查当前用户可见 scenario；不存在、跨用户、旧的无 owner scenario 都统一返回 404，不暴露资源是否存在
  - resolve 只查当前用户 entry；不存在或跨用户 entry 返回 404，已解析 entry 或并发 stale resolve 会返回 409，不会重复改写结果
  - calibration 聚合会限制读取条数，避免一次把当前用户历史全量扫进内存
- `FEATURE_HALLUCINATION_GATE` 当前只控制 verdict 后处理：
  - 空 verdict、没有可校验 claim、低置信度或矛盾 claim 都只进入 warning metadata
  - claim 是否标记为 verified 会使用调用方传入的 `threshold`
  - 矛盾检测会识别常见中英文否定；中文里 `无/无法/无力` 这类谓词否定会计入，`无论/无疑` 这类中性组合不会被当成否定
  - Debate result payload 会在存在时回显 `score_breakdown.metadata.hallucination_gate`
  - gate 不会阻断 verdict，也不会把 LLM 失败提升成业务失败
- `GET /api/leaderboard` 当前保持旧兼容：不带 segment filter 时仍返回 leaderboard 数组；带 `scenario_type / date_from / date_to / min_agents / max_agents` 任一筛选时，才返回 `entries + segment_metadata`。分段响应的 `total_predictions / avg_score / best_score / win_streak` 会从匹配筛选条件的已评分 prediction 重新计算，`filtered_count` 是匹配 segment 的 distinct user 数，`total_count` 是未筛选的非 anonymous leaderboard user 数。
- main simulation 当前已补 continuity preflight/override 链路：
  - `POST /api/agents/identities/preflight` 会先跑 parser，再只把 `L2 fuzzy candidate` 返回给前端确认
  - parser 阶段最多等待 10 秒；超时返回 `504 IDENTITY_PREFLIGHT_TIMEOUT`，不会把失败当成“无匹配”继续启动
  - `POST /api/scenario` 当前接受 `continuity_overrides`
  - `reuse_existing` 会校验目标 identity 属于当前 `user_id`
  - `create_new` 会在真正 `resolve_identity()` 时跳过 L2 fuzzy reuse
- Ending Room API 请求体当前已统一添加输入上限（防超大 payload DOS）：
  - `selected_branch_ids / selected_agent_ids / selected_representatives` 各 ≤ 50 条
  - `addressed_agent_ids / question_anchor_ids` 各 ≤ 20 条
  - `content`（用户追问）≤ 5000 字符
  - `title`（线程标题）≤ 500 字符
- Debate API 的 `user_name` 当前限制为 ≤ 100 字符。
- `InterveneRequest.text` 和 `RetrospectiveInterveneRequest.text` 当前限制为 ≤ 2000 字符（strip 后计算），空文本会被拒绝。
- `CreateScenarioRequest.user_id` 限制为 ≤ 128 字符。
- `PredictRequest.user_id` 和 `user_name` 限制为 ≤ 128 字符。
- `CreateReplayArtifactRequest.kind` 限制为 ≤ 64 字符。
- Campaign gameplay-state API 的列表字段当前也有上限：
  - `usage_log` ≤ 200 条、`bets` ≤ 100 条、`key_moments` ≤ 100 条、`branch_snapshots` ≤ 50 条
  - 这些限制远超正常业务用量（一局最多 ~20 Agent / 8 分支），只拦截异常请求。

## 运行时约束

- 主模式与 Debate 的后台任务都通过 `runtime_lock` 做跨 worker 防重入。
- ending-room 后台生成当前也持有 runtime-lock heartbeat：
  - 续租返回 `None`
  - 续租抛异常
  - 本地 lease 已过期
  - 以上路径都会 fail-closed，把 room 落成 `error`，不会继续写 turn 或 result
- Debate live 当前会启动 runtime-lock heartbeat，并在每个长 await 前后校验本地 lease 是否仍有效：
  - 续租返回 `None`、续租抛异常，或本地 lease 已过期时，任务会在下一个 guard 点 fail-closed 并把 debate 标成 `error`
  - 不会再继续落库或广播后续 turn，也不会继续 verdict / finalize；如果锁在单次生成途中丢失，会在下一次 guard 点被拦下
- replay branch 路径当前也走 runtime lock：
  - `counterfactual / resume` 会先完成请求侧校验，再在进入 `clone / seed / schedule` 前启动同一把 scenario 级 replay lock heartbeat
  - 续租返回 `None`、续租抛异常，或本地 lease 已过期时，请求会直接 fail-closed，不会继续 clone / seed / schedule
  - 如果锁丢失前，并发请求已经吃满最后一个 replay branch slot，会回退成 `429 REPLAY_BRANCH_LIMIT_REACHED`
- 主模式后台 simulation 当前在拿着预占 `simulation lock` 续跑时，也会显式监听 lock 丢失；一旦 lease 被别人抢走或续租失败，任务会立刻取消并把 scenario 标成 `error`。
- `runtime_lock` 当前也能正确解析 `sqlite:///file:/...?...uri=true` 这类 SQLite URI；多 worker 共用同一文件时，仍然走共享 SQLite lease，不会静默退回进程内锁。
- `VectorStore` 读取默认按 branch 或 allowed-branch scope 收口，不再放宽到整个 scenario。
- `llm_client` 负责：
  - 进程内 semaphore
  - pending/quota 控制
  - circuit breaker
  - 共享 `httpx.AsyncClient`
  - 按用途做 lane 隔离，避免 scenario fan-out 抢满 Oracle / Debate / parse / background 的全部 slot
  - request-scoped RPM/TPM 限制（BYOK 场景下由前端传入）。scope 限制只覆盖服务端默认值，触发后请求会排队等待下一个窗口，不会立即拒绝。
- `llm_call_json_with_stream_fallback()` 当前已落到这些结构化 JSON 链路：
  - parser
  - narrator
  - memory 压缩
  - prediction scoring
  - debate judge summary
  - debate persona generation
  - debate phase insight rewrite
  - debate supporting-turn reason
  - debate argument map enrichment
  - identity compaction
  - fork detection
  - Oracle auto-recap 静态改写
  - 行为是：先 probe 当前 provider/model 是否支持流式 JSON；支持则优先流式，不支持或失败再退非流式。各业务自己的本地 fallback 仍保留，不靠 LLM helper 兜底所有问题。
- `llm_call()` 当前会把“`HTTP 200` 但非流式正文为空”视为 provider incompatibility，而不是静默返回空字符串：
  - `chat/completions` 的 `choices[0].message.content` 为空会直接报错
  - `responses` 会先尝试 `content[].text`、`content[].output_text`、top-level `output_text`；还拿不到正文就报错
  - 这样上层不会再把空正文拖到 `json.loads("")` 才暴露
- `narrate_branch()` 当前会保证 completed branch 的 `insight` 非空；如果 LLM 只返回 story 或空 payload，会从 story 截一段，或者退到当前语言的简短 fallback，避免 reconcile 因空 insight 卡住。
- 本地兼容网关的 live probe 当前有独立测试：
  - `backend/tests/test_llm_gateway_probe.py`
  - 用来确认本地 OpenAI-compatible 端点的非流式正文和流式 JSON 路径是否可用。
- Oracle follow-up 的 stream support probe 当前复用 `llm_call_stream()`；`estimated_tokens` 预估已补回，不再因为 probe 自身变量缺失而误触发 fallback。
- Oracle follow-up 流式链路当前会给“首个可见 delta”一个短预算；如果 provider 长时间不出可见 token，会尽快回退到非流式改写，而不是把 anchored follow-up 长时间挂住。
- Oracle follow-up 当前会在 WebSocket delta 广播和最终 turn 落库前先剥掉 provider reasoning block；`<think>` 不会再泄漏进 transcript。
- Oracle follow-up 如果 stream 正常结束但没有任何可见内容（空 chunk 或仅 reasoning block），也会回到非流式改写；不会把 deterministic anchor copy 当成成功的流式输出。
- Oracle follow-up append 当前不是整房间 all-or-nothing：
  - user turn 先提交
  - assistant follow-up turn 在真正落库时重新分配最终 `sequence`
  - 这样并发 follow-up 不会继续复用旧序号窗口
- 只要 follow-up 已经发出 `ending_room_turn_start`，后续无论是 partial stream 中断，还是后面的 rewrite / commit 失败，都会补 `ending_room_turn_error`；payload 当前带 `message / error / code / recoverable`，前端可据此清理 draft 而不把整 room 升成 fatal error。
- Oracle auto-recap 的静态改写当前已接到 `stream-first + non-stream fallback` helper；structured LLM 失败后会先做 plain-text retry，再退 deterministic fallback。follow-up / thread 仍走独立流式状态机，不和 auto-recap 共用同一条改写调度逻辑。
- SQLite 当前默认启用 WAL 模式（`journal_mode=WAL`）和 `busy_timeout=5000`，缓解并发写入冲突。内存数据库会跳过 WAL 设置。
- `causal_graph.append_round_nodes()` 当前对同一 `branch / round` 的重复追加是幂等的：
  - 同一 agent 同 round 多条消息会用最后一条覆盖 `AgentStateFrame`
  - 同一 agent 同 round 就算消息没有 `id`，event 节点也会继续保留为多条；不会再被后一条静默覆盖
  - 已存在的 event / stance_shift 节点会按 `branch + node_key` 复用；同 round 就算 `msg_id` 重复，event 节点也会按 agent 隔离
  - 同一 `scenario / branch / round` 如果 id-less 消息集合变少，旧的 stale `event` 节点和相关边也会一起清掉，不会把上一版快照残留在当前图里
  - 同一 `branch / round` 的 `responds_to / supports_stance / opposes_stance` 边会用 `_add_edge_if_missing()` 保持幂等；重放时先按当前 branch 的同轮 event 节点清掉旧 inter-agent 边，再按当前消息重建
  - 重放旧轮次时，会先删掉该轮已过期的 `AgentStateFrame`，并清掉不再成立的 stale `stance_shift` 节点和相关边，再按当前消息重建
  - append 路径当前通过固定大小的 scenario lock pool 串行化同一 scenario；同一 scenario 并发写入不会再撞出重复 event 节点，长期进程也不会按 scenario 数量无限增长锁对象
  - 同一 fork 如果先走 same-round fallback、后面又带显式 `trigger_node_ids` 重放，旧的 `triggered fork` provenance edge 会先被替换；显式 ids 非法时也会回退 same-round provenance
- `AgentStateFrame` 当前按 `scenario_id + branch_id + round_number + agent_id` 唯一。
  同一个 `(branch / round / agent)` 组合就算出现在不同 scenario，也不会再互相撞库。
  `020` 迁移当前也兼容“runtime repair 先跑、Alembic 后补”的顺序，不会再因为旧约束名已经不存在而卡住升级；runtime repair 在重建唯一约束前也会先按最新一条脏数据去重，不会因为 legacy 重复行直接炸掉。
  `020` 到 `030` 的 offline Alembic SQL 当前不依赖运行时 SQLite reflection / PRAGMA 查询；`030` 只新增 `pending_intervention.metadata_json` 与 `intervention_log.effect_summary_json`，并有 offline SQL 与 SQLite downgrade/upgrade roundtrip 覆盖。
- `GraphSnapshot` 当前按 `owner_type + owner_id + graph_kind` 唯一。
  同一个 causal graph / argument map 在首次并发创建时，会回退到同一份 snapshot，而不是拆成多份；读取最新 snapshot 时，SQLite 按 `created_at DESC, rowid DESC`，非 SQLite 按 `created_at DESC, id DESC`。如果 SQLite legacy duplicate snapshot 还残留，runtime repair 会直接以最新 snapshot 为 authority，删除其他重复 snapshot 的 `graph_node / graph_edge` 和相关引用边；不会把旧残留合回当前图。
- `resolve_identity()` 当前已支持复用外层 SQLModel session，避免 scenario parse 路径在同一事务里二次开 session 时撞到 SQLite `database is locked`。
- request-scoped BYOK / RPM / TPM 当前不仅作用在主 simulation turns，也会继续透传到 fork detection、narration、memory compression 与 identity compaction。
- 搜索增强当前走 `web_context.py`：
  - app-layer provider 支持 `tavily / exa / xai / searxng`；`native` 仍是 legacy placeholder，preflight 会给 warn，不会当作已实现 provider pass
  - 模型原生联网不是 `WEB_SEARCH_PROVIDER=native` 这条 app-layer provider；它来自 simulation runtime 把 source family domain 传给支持 native search 的非 proxy Responses API LLM provider
  - `POST /api/scenario` 可传 request-scoped `web_search_families / web_search_provider / web_search_api_key / web_search_base_url / web_search_intensity`
  - `web_search_intensity` 当前只接受 `light / standard / deep`；分别对应 3/3、5/5、10/8 的抓取结果数与 prompt 注入片段数
  - `web_search_enabled=false` 时，这些 override 字段会在路由层被忽略，不影响正常建局
  - custom provider override 不会再复用“另一个 provider”的服务端默认 key
  - `xai` 走 Responses API + `web_search` tool；source family 会用 `filters.allowed_domains`，并在返回后再次按 URL 过滤
  - `searxng` 的 source family 会先把域名规范化再拼 `site:` query，返回后也会再次按 URL 过滤
  - source family URL 后过滤当前只接受 `http/https`，会做 IDN/punycode 规范化，并只允许 exact host 或真实子域名匹配
  - 官方 provider 的 `web_search_base_url` 当前只接受 `https`
  - `searxng` 自定义 base URL 当前只接受与服务端 `SEARXNG_URL` 完全一致的基址
  - `FEATURE_NEW_SOURCES=true` 且选中了 family 时，base search 与 family search 分开执行；base search 失败不会短路 family search
    - 只被选中的 family 会标成 `ready`
    - 未选中的 family 会保持 `empty`
    - 当前 provider 不支持 domain filter 时，family 会标成 `unsupported_provider`
    - family 搜索异常时，family 会标成 `failed`
    - family entry 可能带 `domain_filter_mode / domain_coverage / status_reason`，这些字段会经 API helper 白名单保留给前端展示
    - `polymarket` 当前额外带 `configured_host / geo_gated`
    - `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us` 时，`polymarket` 会显式保持 `empty + geo_gated`
- Ending Room 的同步服务函数（`create_ending_room`、`create_ending_room_thread`、`load_ending_room_snapshot` 等）在 async 端点中通过 `asyncio.to_thread()` 调用，不阻塞事件循环。路由层对 `to_thread` 内部的非业务异常有通用 `except Exception` 兜底，不会让裸 DB 异常直接落成未分类 500。
- Agent conversation 当前走两步启动：
  - `POST /api/conversation/start` 先创建 thread、首条 user turn 和一条 `pending` assistant turn
  - 紧跟的 `POST /api/conversation/{thread_id}/turn` 如果还是同一条首轮 user 内容，会直接 claim 这条预留 assistant turn 开始流式返回，不再追加重复 user turn
  - 这条 claim 当前按原子 CAS 执行；并发首轮流里只会有一个请求拿到这条预留 turn，其他请求会 fail-closed，不会两路同时 stream 同一 turn
  - bootstrap 预留 turn 在真正发出首个 `turn_started` 前，当前还会再看一次 turn 状态和 cancel flag；如果 started 前已经被 abort，就不会再补 stale `turn_started`；如果场景已经删掉，则直接收成 `SCENARIO_DELETED`
- Agent conversation prompt 当前会带轻量 worldline-local 语境：
  - scenario question
  - 前端传入的 `origin_excerpt`
  - origin branch id / round
  - branch title / fork reason / summary
  - origin graph node label / type / round / 截断后的 payload 摘要
  - 最多 6 条相邻边/邻居摘要；有 edge evidence 时会带截断后的 `evidence_json / detail`
  - origin branch 最近几轮 transcript 摘要
  - 历史 turn 只取最近 12 条，并按单 turn 长度截断
  - 这些图谱/场景文本统一通过 `format_untrusted_text_block()` 注入，不把节点 payload 当系统指令
  - `origin_branch_id` 必须属于同一个 scenario；跨 scenario branch 会按不存在处理，不把其它 scenario transcript 暴露给当前 thread
- Agent conversation prompt 当前会按 origin 语境选择回答身份：
  - 有 `agent_name` 时，继续按 in-story Agent 口径回答
  - 没有 `agent_name` 时，按 graph analyst 口径解释节点、分支、回合和相邻图谱上下文，不冒充具体参与者
- `WS /ws/agent-conversation/{thread_id}` 当前也已上线：复用统一首帧 auth / pending-auth 容量门控；feature 关闭或 thread 不存在时返回 `4404`；owner freeze 按 thread owner 收口；容量仍按 scenario 维度计算，不会因为 thread 数量放大
  - scenario 删除如果发生在流式中途，会先在删除事务内把活跃 turn 标成 `scenario_deleted`，真正唤醒 in-flight SSE 的 cancel signal 改为事务提交后再发；这样 rollback 不会提前把客户端打成终态。当前 delete endpoint 会在 `session.commit()` 后 drain `session.info["scenario_deleted_turn_ids"]` 并统一调用 `signal_scenario_deleted_turns()`；signal 失败只记 warning，不会把已经删成功的请求误报成 500。事务成功提交后，流末尾仍会补 `turn_error(code=SCENARIO_DELETED)`；如果场景刚好在首个 chunk 出来前被删，也会直接收成这条终态，不再误落到 `LLM_5XX`
  - `DELETE /api/conversation/{thread_id}/active` 当前除了唤醒活跃流式协程，也会把还没开始流式的预留 `pending` assistant turn 直接收成 `aborted`；不会再出现 abort 已返回，但同一条预留 turn 还被后续 `/turn` claim 走的假成功
  - bootstrap 预留 turn 在真正发出首个 `turn_started` 前，当前除了看 cancel event，也会看已登记的 cancel reason；即使 `event.set()` 还没跑到 loop，只要 abort 已登记，也会在首帧前直接收成 `aborted`，不会把 turn/thread 留在 `streaming`
  - `_stream_with_cancel_signal()` 当前在 cancel 和 next chunk 同 tick 完成时会优先走 cancel，不再多漏一条 `turn_token_delta`
  - SSE 通用兜底错误当前统一发 `turn_error(code=LLM_5XX)`，不再回落到模糊的 `STREAM_FAILED`
- Debate argument map 当前走两层抽取：
  - 第一层：rule-based sentence split + claim/evidence/rebuttal 分类；当前分句覆盖 `. ! ?`、`。！？` 和换行
  - 第二层：默认开启的 fire-and-forget LLM enrichment，补 `type / stance / confidence`
  - 第二层失败不会中断 debate 主链，也不会覆盖第一层结果
  - judge turn 也会分句落 unit，但不会参与普通 `supports / rebuts` 抽取；verdict 语义只走 `link_verdict()` 重算成 `accepted / standing / unaddressed / rebutted / rejected` 五种状态
  - SQLite lightweight fallback 当前也会尽力把唯一语义修到 `debate_id + turn_id + semantic_hash`；如果 repair 本身失败，会记 warning，但不会把旧的 best-effort index 补齐链路一起打断
  - `DebateArgumentUnit` 的唯一语义当前是 `debate_id + turn_id + semantic_hash`，不再把跨 turn 的同句子误判成重复；`semantic_hash` 会按归一化后的文本计算，纯 whitespace 变体不会再在同一 turn 里拆成两条
  - `021` 迁移当前会移除 legacy 的 `debate_id + semantic_hash` 约束；升级前若已有同 turn 脏重复行，会先按 `created_at DESC, id DESC` 保留最新一条再升级
  - SQLite lightweight fallback 修重复 `debate_argument_unit` 时，也会同步清掉已经失效的 `graph_node / graph_edge`，避免旧图残留 orphan node/edge 混进当前 argument map
  - legacy SQLite 上如果已经留下重复 snapshot，读取最新 snapshot 时，SQLite 按 `created_at DESC, rowid DESC`，非 SQLite 按 `created_at DESC, id DESC`；runtime repair 会直接以最新 snapshot 为 authority，删除其他重复 snapshot 的 `graph_node / graph_edge / debate_argument_unit`，不会再把 stale rebuttal 或其他旧 unit 合回当前 argument map
  - 如果 enrichment 改写了 unit type，会在进程锁下按整个 argument-map snapshot 重建 `supports / rebuts` 边，不再只修当前 turn；`counter` 当前也会继续参与 `rebuts` 边重建，不会掉成孤点
  - 读取结果当前只返回属于当前 snapshot 的 `nodes / edges / units`；旧 snapshot 里残留、但 `node_id` 不在当前图里的 unit 不会再混进来
  - `rebuttal` 的 target 当前统一按“最新的对手 claim”选择：先看更新的 round/turn；同一 turn 里再按句子顺序取最后一条，不再按 hash 字典序猜
  - 重建时不会复用旧 target；`supports / rebuts` 会按当前 claim 状态重新选边，`DebateTurn.content` 可用时再按 turn 内句子顺序定序
  - `link_verdict()` 复用既有 verdict 节点时，也会同步刷新 verdict `label / winner / verdict_tone / judge_summary`；`label` 当前用 `winner · verdict_tone` 这条短文案，`judge_summary` 只进 payload
  - `link_verdict()` 当前只会重连当前 snapshot 里的 argument units；其他 snapshot 的 stale unit 不会再被拉回当前图里，缺 node 或 node 已丢失的 unit 只会重算状态，不会留下悬空 verdict edge
  - 如果 judge 没给 `supporting_turns`，verdict fallback 会按当前 turn / 句子顺序最多把 3 条 winner-side claim 标为 `accepted`；winner side 会先读 node payload，payload 坏掉时再回退到 `DebateTurn.speaker_side`
  - `semantic_hash` 并发冲突当前收口到“单句跳过”而不是整 turn 回滚；同一 turn 里已经成功写入的 argument unit 不会被一起抹掉
- `debate import-replay` 当前会把非法 `phase / speaker_side / prediction / counterplay` 字段统一收口为稳定 `422`；`turns / predictions / phase_insights` 的非对象 entry 也会直接拒绝，不再 silent corruption，也不再把枚举/浮点解析错误打成未分类 `500`。
- `debate import-replay` 当前在 turns 落库后会同步抽取 argument map；功能开启时，导入完成后就能直接读到图谱，不再先落成空图。
- `POST /api/debate` 当前可选传入 `custom_agent_ids`：
  - 最多 2 个，重复值在 schema 层拒绝
  - `FEATURE_CUSTOM_AGENTS=false` 时返回 400，不进入自建 Agent 绑定逻辑
  - 每个 ID 都必须存在、`kind=custom` 且属于当前 `user_id` / signed principal；跨用户返回 403
  - 第 1 个 custom Agent 锁到 proposition，第 2 个锁到 opposition，并把 persona、knowledge domains、decision bias 放入 `breakdown_json.metadata.personas`
  - debate runtime snapshot 会透传这份 metadata，生成 turn prompt 时继续走不可信文本格式化
- `DEBATE_USE_LLM=true` 时，Debate 开局会按当前辩题为 proposition / opposition / judge 生成 name、role 和 persona；name/role 会去控制字符、fence 和 prompt-injection 标记并限长，失败或空值回退 deterministic 模板。
- persona upgrade 成功后会写入 `breakdown_json.metadata.personas`，并在首个 `agent_speak` 前通过 `debate_participants_update` 广播最新 participants。
- Debate 的 request-scoped BYOK / RPM / TPM 会继续透传到 persona generation、turn generation、judge analysis、phase insight rewrite、supporting-turn reason 和 argument-map enrichment。
- `phase_insights` 当前只要求 `pressure_margin / turn_count >= 0`；`confidence_drift.phase_margin / cumulative_margin` 可以是负数。
- 常规 prediction 当前允许 `counterplay_variant: null`；只有显式给出非空值时才校验 variant。
- WebSocket 入站消息有 64KB UTF-8 字节大小限制，超出会以 `1009` 状态码关闭连接。
- BYOK API key 在内存传递时使用 `_OpaqueStr` 包裹，`repr()` 和 JSON 结构化日志都会输出 `"***"` 而非真实值；但 `str()` 和 f-string 仍返回真实值，确保 httpx header 正常工作。
- BYOK `llm_base_url` 必须通过 hostname allowlist + scheme 校验：
  - 官方托管 host 只接受 `https`
  - 本地开发 host 才允许 `http`
  - 业务入口 (scenario/debate/predictions/social) 要求 `base_url` 必须同时带 `api_key`，否则返回 400
- 当多个 backend worker 共用同一个 SQLite 文件时：
  - pending/quota 共享计数会生效
  - runtime lock 会跨进程共享
- Agent conversation 的 rolling 24h `user / org` daily quota 当前已经改成持久化 ledger：
  - 额度键仍只看 `thread.owner_user_id` 和 `thread.organization_id`
  - backend 重启后不会归零
  - 多进程共用同一 SQLite 文件时会共享这份计数
  - 删除 scenario / thread 不会把已经消耗的 daily quota 返还回去
- `GET /api/scenario/{id}/conversations` 当前按 scenario 列出 Agent Conversation thread：
  - 受 `FEATURE_AGENT_CONVERSATION` gate
  - 要求 signed principal 能看到该 scenario
  - `cursor` 是 offset cursor，`limit` 范围 `1..50`
  - 返回列表只带 thread 摘要；完整 turn 历史仍通过 `GET /api/conversation/{thread_id}` 读取
- `GET /api/quota/summary` 当前返回两个 bucket：
  - `conversation`：`local / user / org` scope；本机无 signed principal / org 时 `enforced=false`，不把 500 次显示成在线额度
  - `replay`：`scenario` scope；统计当前 scenario 下 `counterfactual / resume` replay branch 数
  - 每个 bucket 都带 `used / limit / remaining / enforced / scope / window_seconds`
  - 开启 `SESSION_SECRET` 后，owner-scoped 读取要求 signed principal；裸 `SESSION_SECRET` 不能用来读取 owner-scoped quota

## 当前验证基线

- 当前 Document Ingestion / backend gate 后端验证口径：
  - `python -m pytest tests/test_document_ingestion.py -q`：`48 passed`
  - `python -m pytest -x -q --timeout=60`：`3070 passed, 6 skipped`
  - live LLM benchmark / observation 测试默认跳过；需要 `RUN_REAL_LLM_TESTS=1` 才会执行
- backend `agent-conversation / quota / migration` 定向回归当前通过
- 本轮 local quota contract 定向复验：
  - `pytest tests/test_quota_routes.py tests/test_agent_conversation.py::TestDocumentedQuotas -q`：`13 passed`
  - `ruff check app/api/quota.py tests/test_quota_routes.py`：通过
- P1 post-review follow-up 窄集当前也已补：
  - `tests/test_causal_graph.py -q`：`68 passed`
  - `tests/test_debate_argument_map.py tests/test_graph_analysis.py tests/test_causal_graph.py -q`：`125 passed`
  - `ruff check app/services/causal_graph.py tests/test_causal_graph.py`：通过
- `ruff check app/services/ending_room_service/ app/services/simulator.py tests/test_simulator.py tests/test_ending_room_service.py tests/test_memory.py tests/test_corner_cases.py`：通过
- custom agent upgrade 定向 ruff 已覆盖 `agents / debate / helper / memory / persona_workshop / simulator` 相关改动文件；最近记录里后端仓库级 ruff 已全绿。
- gameplay-system hardening 最终后端复验：
  - `python -m pytest -q`：`3141 passed, 6 skipped`
  - `ruff check .`：通过
- Classic 分支标题提示本轮已补定向验证：
  - `pytest tests/test_audit_fixes.py::TestForkPromptTemplateConsistency -q`：`31 passed`
  - `pytest tests/test_simulator.py::TestDetectFork -q`：`4 passed`
  - `ruff check app/services/simulator.py tests/test_audit_fixes.py`：通过
- Sprint 0-2 收尾定向验证：
  - `tests/test_simulation_cancel.py tests/test_quota_routes.py tests/test_decision_bias.py tests/test_preflight_cli.py`：`36 passed`
  - `ruff check app/api/scenarios.py app/api/quota.py app/services/simulation_cancel.py app/services/simulator.py tests/test_simulation_cancel.py tests/test_quota_routes.py tests/test_decision_bias.py tests/test_preflight_cli.py`：通过
- Sprint 3 snapshot / personality drift 窄集当前已跑：
  - `python -m pytest tests/test_snapshot_export.py tests/test_personality_drift.py -q`：`46 passed`

## WebSocket 口径

- 主模式与 Debate 都通过 WS 推送 live 事件。
- 出站事件统一带顶层 `meta`，供前端按 `sequence / event_id` 去重与补拉。
- Debate live 当前还会广播 `debate_participants_update`：payload 只包含 `participants[]` 的 `side / name / role / persona`，用于在 LLM cast 更新后刷新前端出场卡，不携带 BYOK key、base URL 或 provider 配置。
- scenario WS 当前也注册 KG realtime 事件：
  - `kg:delta`：推送合并后的 `GraphDelta`
  - `kg:snapshot_invalidated`：payload 过大、delta 标记失效或客户端需要 REST snapshot fallback 时使用
- 空闲期会发送轻量 `heartbeat`，便于更快暴露半断开连接。
- `ending_room` 也有独立 WS 通道，不复用 scenario/debate stream。
- ending-room WS 当前挂在独立的 ws router 上：
  - 业务 REST router 统一通过 `verify_session` 校验 `X-Session-Token` header
  - 当路由需要 caller identity 时，会继续要求 signed principal token，而不是只接受裸 `SESSION_SECRET`
  - WebSocket 继续使用首帧 auth 协议
- Oracle replay 的自动化状态当前也会显式跟随 active replay thread 的 `interaction_mode`，避免 mobile roundtable readonly 在自动化口径里误报成主桌模式。
- 当 `SESSION_SECRET` 非空时，WS 采用首帧 auth 协议：服务端先 accept，再等待客户端发送 `{"type":"auth","token":"..."}`（10 秒超时，64KB 上限），验证通过后回复 `{"type":"auth_ok"}`，然后才注册连接并启动 heartbeat。未认证的 socket 不会进入 `_connections` 池，不会收到 broadcast 或 heartbeat。
- scenario WS 的容量限制当前按“已注册连接 + pending-auth”一起算，pending slot 会在 `accept()` 前原子预留；并发握手不会再把 `MAX_WS_PER_SCENARIO` 冲穿。
- 开启 auth 后，资源存在性与 owner 检查会延后到首帧 auth 之后：
  - `scenario WS` 当前也会校验 signed principal 与 scenario owner，不再只做 session gate
  - `debate / ending-room` WS 还会继续要求 signed principal；认证通过但资源不存在或不属于该 principal 时会走 `4404`
- app 级非业务端点（当前如 `/`、`/metrics`）不走 router 级 `verify_session`；`/api/capabilities`、`/api/health`、`/api/health/test` 已纳入业务 REST 门禁。
- agent identity / workshop 与按 `user_id` 读取的 campaign profile 系列当前已开始优先使用 token 内的 principal `sub` 作为 owner 真值，不再单纯信任 query/body 里的 `user_id`。

## 源码入口建议

- 查接口：`llmdoc/reference/api.md`
- 查配置：`llmdoc/reference/config.md`
- 查 runtime 细节：对应 `backend/app/api/*.py` 与 `backend/app/services/*.py`
- 查 schema 与表结构：`backend/app/models/*.py`
