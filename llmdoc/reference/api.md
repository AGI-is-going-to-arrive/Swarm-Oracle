# REST + WebSocket API 参考

> 作用：提供当前稳定接口地图与关键约束。字段细节和完整 schema 以 `backend/app/api/*.py`、Pydantic model 与测试为准。

## 通用约定

### Base URL

- REST：后端服务根地址，例如 `http://localhost:18927`
- WebSocket：同主机的 `ws://` 或 `wss://`

### 业务错误形状

项目自定义业务错误统一收口为：

```json
{
  "detail": {
    "code": "SOME_ERROR_CODE",
    "message": "Human-readable message"
  }
}
```

说明：

- 路由层未显式处理的异常，会统一收口为 `INTERNAL_ERROR`。
- FastAPI/Pydantic 原生 `422` 仍保持框架默认形状。

### Session Gate

当 `SESSION_SECRET` 非空时：

- 所有业务 REST 路由都会要求 `X-Session-Token`。
- app 级非业务端点（当前如 `/`、`/metrics`）不走 router 级门禁。
- 部分 ownership-sensitive 路由当前还要求 signed principal token，而不是只接受裸 `SESSION_SECRET`。
  - 当前至少包括：
    - agent identity / workshop
    - campaign profile 系列
    - admin diagnostics
    - quota summary
    - 按 scenario / ending-room / thread owner 读取或写入的路由
- 这类路由常见业务错误包括：
  - `SESSION_PRINCIPAL_REQUIRED`
  - `SESSION_PRINCIPAL_MISMATCH`

## Scenarios

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario` | 创建 scenario 并启动后台模拟 |
| `GET` | `/api/scenario/templates` | 列出教育场景模板 |
| `GET` | `/api/scenario/templates/{template_id}` | 读取单个教育场景模板 |
| `GET` | `/api/scenario/{scenario_id}` | 获取 scenario 详情 |
| `GET` | `/api/scenario/{scenario_id}/branches` | 获取 branch 列表 |
| `GET` | `/api/scenario/{scenario_id}/agents` | 获取 agent 列表 |
| `GET` | `/api/scenario/{scenario_id}/groups` | 获取分层分组信息 |
| `GET` | `/api/scenario/{scenario_id}/story` | 获取叙事结果 |
| `GET` | `/api/scenario/{scenario_id}/conversations` | 分页列出该 scenario 下的 Agent Conversation thread 摘要 |
| `POST` | `/api/scenario/{scenario_id}/cancel` | 请求取消仍在运行中的 scenario |
| `GET` | `/api/scenarios` | 分页列出 scenario |
| `DELETE` | `/api/scenario/{scenario_id}` | 级联删除 scenario 与关联数据 |
| `POST` | `/api/scenario/import-replay` | 把 replay 快照导入为本地 scenario |
| `GET` | `/api/scenario/{scenario_id}/snapshot` | 导出自包含 scenario ZIP snapshot |
| `POST` | `/api/scenario/import-snapshot` | 导入 scenario ZIP snapshot 为本地 scenario |

关键约束：

- `GET /api/scenario/{scenario_id}` 会在读取前尽量收敛 stale `simulating/narrating` 状态。
- `POST /api/scenario` 当前也接受搜索增强字段：
  - `web_search_enabled`
  - `web_search_families`
  - `web_search_provider`
  - `web_search_api_key`
  - `web_search_base_url`
  - `web_search_intensity`
- 这些字段的当前口径：
  - 只有 `web_search_enabled=true` 时才会真正参与搜索
  - `web_search_families` 当前只接受 `polymarket / finance / academic / news_deep`；空白会 trim，重复值会去重
  - `web_search_intensity` 当前只接受 `light / standard / deep`；开启搜索但未传时默认为 `standard`
  - `light` 抓取并注入 3 条，`standard` 抓取并注入 5 条，`deep` 抓取 10 条并向 prompt 注入 8 条
  - 首页当前只会在 web search 已开启、且当前有效 provider capability 支持 domain filter 时发送已选 family；推荐 server default 读服务端 capability，advanced custom override 有可识别 base URL 时按 URL 推断 capability，base URL 为空时按下拉 provider 使用 capability
  - `web_search_enabled=false` 时，override 字段和 intensity 都会被忽略
  - 官方 provider 的 `web_search_base_url` 只接受 `https` endpoint
  - `searxng` 的 `web_search_base_url` 只接受和服务端 `SEARXNG_URL` 完全一致的基址
  - 如果 custom override 的 provider 和服务端默认 provider 不同，调用方需要显式传该 provider 的 API key；后端不会跨 provider 复用默认 key
- 搜索成功时，scenario response 会带 `web_search_context`，并持久化到 `Scenario.web_context_json`。
  - `FEATURE_NEW_SOURCES=true` 时，`web_search_context` 里还会带 `family_context`
  - LLM native search 有 citation 时，`web_search_context` 可带 `native_citations`
  - `native_citations` 只保留字符串 text 和安全的 `http/https` URL；旧 JSON、`null`、非数组和 unsafe URL 会被过滤或忽略
  - base search 和 family search 独立执行；base search 失败不会阻止已选择的 family search
  - 后端当前可写出 `ready / empty / failed / unsupported_provider / search_skipped`；历史/兼容 parser 还允许 `loading / rate_limited / network_error / fallback_unconstrained`
  - family entry 可能带 `domain_filter_mode / domain_coverage / status_reason`；`polymarket` 当前额外带 `configured_host / geo_gated`
- `POST /api/scenario` 当前也接受可选 `continuity_overrides`：
  - 前端通常先调用 `POST /api/agents/identities/preflight`
  - `reuse_existing` 需要带 `identity_id`，后端会校验它属于当前 `user_id`
  - `create_new` 会让真正的 identity 解析跳过 L2 fuzzy reuse
- `GET /api/scenario/{scenario_id}` 和 `GET /api/scenario/{scenario_id}/story` 的 `branches[]` 当前会回显 `fork_round / replay_kind / replay_source_branch_id`；普通分支的 replay 字段可为 `null`，replay/import/counterfactual/resume 分支用它保留来源分支语义，结果页也用 `fork_round` 定位可回溯的 fork point。
- `GET /api/scenario/{scenario_id}/story` 在 `FEATURE_RESULT_VERDICT=true` 且 `parsed_context.result_quality` 有数据时，会额外回显顶层 `verdict / verdict_confidence`，以及 `branches[].question_answer`。关闭开关、旧 scenario、空字符串或 malformed `result_quality` 都会降级为空字段；未知 confidence 会归一化为 `medium`。
- `GET /api/scenario/{scenario_id}/conversations` 受 `FEATURE_AGENT_CONVERSATION` gate，要求 signed principal 能看到该 scenario；`cursor` 是 offset cursor，`limit` 范围 `1..50`，返回项只带 thread 摘要，完整 turn 历史仍走 `GET /api/conversation/{thread_id}`。
- `POST /api/scenario/{scenario_id}/cancel` 只接受 `parsing / simulating / narrating / cancelled`；`done / error` 会返回 `409 SIMULATION_NOT_RUNNING`。成功请求会把 scenario 持久化到 `cancelled`，并尽量取消本进程里的后台 task。运行中 worker 即使已经有本地 cancel token，也会继续读取 DB `cancelled` 状态，避免跨进程取消被漏掉。
- `GET /api/scenario/{scenario_id}/snapshot` 和 `POST /api/scenario/import-snapshot` 受 `FEATURE_SNAPSHOT_EXPORT` gate；关闭时返回 404 `FEATURE_DISABLED`。export 会做 scenario ownership 校验，并剥掉常见 secret key/base URL/token/password 变体，也会清理 `key_moments`、web context 这类 JSON 字符串里的敏感字段。开启 `SESSION_SECRET` 时 import 要求 signed principal，并把新 scenario 绑定到该 principal。空文件返回 422 `SNAPSHOT_FILE_EMPTY`，超过 50 MB 返回 413 `SNAPSHOT_FILE_TOO_LARGE`，archive/manifest/checksum 不合法、JSON/JSONL 不是 UTF-8、JSONL 行数或单行过大都会返回 422 `SNAPSHOT_IMPORT_INVALID`。导入还会拒绝重复 ZIP member name、超过 256 个物理 member、路径穿越、symlink、异常压缩比和总解压超限；branch 的 `replay_source_branch_id` 会按新 branch id remap，找不到来源时清空。
- `GET /api/scenario/templates` 和 `GET /api/scenario/templates/{template_id}` 受 `FEATURE_EDUCATION_TEMPLATES` gate；关闭时返回 404 `FEATURE_DISABLED`。列表接口支持 `category` 与 `difficulty` filter，空结果返回空数组。
- 删除 scenario 时会一并清理 replay、prediction、campaign side effect、ending-room 与向量数据；个人 journal entry 会保留，但关联的 `scenario_id` 会置空，避免硬删除破坏用户日志历史。

## Replay Artifact

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/replay-artifact` | 持久化 replay payload，返回短 `share id` |
| `GET` | `/api/replay-artifact/{artifact_id}` | 读取 replay payload |

说明：

- 主模式与 replay 页面优先使用 artifact 短链。
- `POST /api/replay-artifact` 当前要求 payload 能解析出 source scenario；后端会把 artifact 绑定到该 scenario owner。
- 常见业务错误包括：`REPLAY_ARTIFACT_PAYLOAD_INVALID`、`REPLAY_ARTIFACT_PAYLOAD_TOO_LARGE`、`REPLAY_ARTIFACT_NOT_FOUND`。

## Interventions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/intervene` | 即时干预；也承载正式玩法卡注入 |
| `POST` | `/api/scenario/{scenario_id}/intervene/retrospective` | 回溯干预 |
| `POST` | `/api/scenario/{scenario_id}/intervene/batch` | 批量干预 |
| `GET` | `/api/intervention-templates` | 干预模板列表 |

关键约束：

- 正式玩法卡仍走 `intervene`，但 authority、冷却与 director points 在后端校验并落库。
- `InterveneRequest.text` 和 `RetrospectiveInterveneRequest.text` 上限 2000 字符（strip 后计算），空文本返回 422。
- 当多个 backend worker 共用同一个 SQLite 文件时，待处理干预会进入共享 pending queue。

## Campaign Authority

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/campaign/profile/{user_id}` | profile |
| `GET` | `/api/campaign/profile/{user_id}/mastery` | mastery |
| `GET` | `/api/campaign/profile/{user_id}/badges` | badges |
| `GET` | `/api/campaign/profile/{user_id}/daily-status` | daily status |
| `GET` | `/api/campaign/profile/{user_id}/weekly-summary` | weekly summary |
| `GET/PUT` | `/api/campaign/scenario/{scenario_id}/director-state` | 主模式 director authority |
| `GET/PUT` | `/api/campaign/scenario/{scenario_id}/gameplay-state` | 主模式 gameplay authority |
| `GET` | `/api/campaign/scenario/{scenario_id}/summary` | scenario campaign summary |
| `POST` | `/api/campaign/scenario/{scenario_id}/finalize` | 结算 campaign 结果 |

关键约束：

- `director-state` 与 `gameplay-state` 的写入都使用 `revision` 乐观并发控制。
- 前端命中 stale 写入时应先回读最新 authority，再决定是否重试。
- `gameplay-state` 采用分区级 authority：
  - 后端只要显式返回 `cards.usage_log`、`betting.bets`、`archive.key_moments`、`archive.branch_snapshots`，即使为空数组，也表示该分区 authoritative empty。
  - 前端不得再用本地缓存把该分区的旧数据补回去。
- `summary` 与 `finalize` 会返回同一套 `score_breakdown`；每项包含 `id / label_key / points / applied`，由后端派生，用于解释 campaign score delta，不要求前端重新计算结算分。

## Predictions

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/predict` | 提交 prediction |
| `GET` | `/api/scenario/{scenario_id}/predictions` | 列出 scenario predictions |
| `POST` | `/api/scenario/{scenario_id}/score-predictions` | 触发评分 |
| `GET` | `/api/leaderboard` | 获取 leaderboard |

关键约束：

- 同一 `scenario_id + user_id` 只能提交一条 prediction。
- `PredictRequest` 的 `user_id` 和 `user_name` 上限 128 字符。
- `score-predictions` 支持 request-scoped provider policy。
- `GET /api/leaderboard` 现在支持 segment filters：
  - `scenario_type`: `debate / simulation / roundtable`
  - `date_from / date_to`: ISO date 或 datetime
  - `min_agents / max_agents`: `1..50`
- 不带 segment filter 时，leaderboard 仍返回旧的 JSON 数组；只要带任一 segment filter，就返回 `{ entries, segment_metadata }`，其中 metadata 会带 `active_filters / total_count / filtered_count`。分段响应里的 `total_predictions / avg_score / best_score / win_streak` 会从匹配筛选条件的已评分 prediction 重新计算；`total_count` 仍表示未筛选的 leaderboard 行数。

## Personal Prediction Journal

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/me/journal` | 分页列出当前用户的预测日志 |
| `POST` | `/api/me/journal` | 写入一条个人预测日志 |
| `PATCH` | `/api/me/journal/{entry_id}/resolve` | 解析一条未解析日志 |
| `GET` | `/api/me/calibration` | 返回当前用户的校准曲线数据 |

关键约束：

- 这些端点受 `FEATURE_PREDICTION_JOURNAL` gate；关闭时返回 404 `FEATURE_DISABLED`。
- `POST /api/me/journal` 如果带 `scenario_id`，该 scenario 必须属于当前用户；不存在、跨用户或无 owner 的旧 scenario 都返回 404 `SCENARIO_NOT_FOUND`，不暴露资源是否存在。
- user scope 来自 signed principal；无 signed session 的本地开发态可用 `X-User-Id`。
- `PATCH /api/me/journal/{entry_id}/resolve` 只允许当前用户解析自己的 entry；不存在或跨用户 entry 都返回 404 `JOURNAL_ENTRY_NOT_FOUND`。已解析 entry 返回 409 `JOURNAL_ENTRY_ALREADY_RESOLVED`，并发 stale resolve 也返回 409，不会覆盖旧结果。
- `GET /api/me/calibration` 只读取当前用户的 resolved entries；实现侧按 `user_id / resolved_at / actual_outcome` 索引和有界读取收口，接口返回形状不变。

## Social / Export / Health

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST` | `/api/scenario/{scenario_id}/social/{platform}` | 生成社交文案 |
| `GET` | `/api/scenario/{scenario_id}/export` | 导出 Markdown |
| `POST` | `/api/health` | 后端健康检查 |
| `POST` | `/api/health/test` | provider 探测与预算预检；返回服务端默认搜索 hint |
| `GET` | `/api/capabilities` | 轻量配置探测（无 LLM 调用），返回 `web_search` + 功能开关 capability registry |
| `GET` | `/` | 根信息 |
| `GET` | `/metrics` | Prometheus 文本指标 |

关键约束：

- provider overrides 只能通过 `POST body` 传入，不能放在社交文案 `GET query` 中。
- `export` 通过附件下载返回 Markdown 文件。
- `/api/health`、`/api/health/test`、`/api/capabilities` 当前都属于业务 REST 门禁范围；`/` 和 `/metrics` 仍是显式例外。
- `GET /api/capabilities` 的 `web_search` 字段当前只表达服务端默认配置是否 ready（`scope: "server"`），不是 request-scoped custom override 探测结果。前端推荐路径只依赖该 server hint；advanced custom override 为空 base URL 时使用下拉 provider 的本地 capability 表，非空未知 host 仍按 unknown 处理。
- `web_search.provider_capability` 描述当前服务端默认搜索 provider 的能力：
  - `supports_domain_filter`
  - `supports_sources`
  - `domain_filter_mode`: `api / query / prompt / none`
- 模型原生搜索不通过 `web_search.provider_capability` 表达，也不是 `WEB_SEARCH_PROVIDER=native`。当前它由 runtime 在 LLM provider 支持 native search、且拿到 source family domains 时注入 provider tools；前端只用说明文案解释它和 server default/custom override 是两条路径，不把它当成可独立选择的 app-layer provider。
- `FEATURE_NEW_SOURCES=true` 时，`web_search.providers.{family}.capability` 会给每个 family entry 附上同一套 domain-filter 能力摘要和 `max_domains`。
- `GET /api/capabilities` 当前顶层 key 固定为：
  `web_search / custom_agents / agent_identity / causal_graph / graph_analysis / counterfactual_replay / factions / argument_map / agent_conversation / kg_explorer / replay_trace / roundtable_survey / roundtable_analyst / snapshot_export / education_templates / persona_export / prediction_journal / result_verdict`。
  除 `web_search` 外，其余 17 个都是功能开关 registry entry，至少带 `enabled / version`。`FEATURE_HALLUCINATION_GATE` 只影响后端 warning metadata，不是 capability key；`result_verdict` 是 story 字段与前端展示 gate，不是新 endpoint。

## Admin Diagnostics

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/admin/preflight` | 返回 SQLite、ChromaDB、LLM、web search、CORS 与 volume 预检结果 |
| `POST` | `/api/admin/test-llm` | 用当前请求里的 provider 配置做一次 LLM 连接测试 |

关键约束：

- 两个 endpoint 都走业务 REST session gate；如果配置了 `ADMIN_TOKEN`，还必须带匹配的 `X-Admin-Token`，否则返回 403 `ADMIN_TOKEN_REQUIRED`。
- `test-llm` 当前兼容 `api_key / llm_api_key`、`base_url / llm_base_url`、`model / llm_model` 这几组字段名。
- `base_url` 会先做 URL 解析和 allowlist 校验；官方托管 host 只接受 `https`，本地开发 host 才允许 `http`。`ENV=production` 时，`/api/admin/test-llm` 也会拒绝本地 LLM base URL。
- 这些接口只用于本地配置和诊断，不会把 API key 写入项目文档、replay artifact 或 scenario 记录。

## Debate

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/debate` | 创建 debate |
| `GET` | `/api/debate/{debate_id}` | live snapshot |
| `GET` | `/api/debate/{debate_id}/result` | result payload |
| `POST` | `/api/debate/{debate_id}/predict` | 提交 counterplay/prediction |
| `POST` | `/api/debate/import-replay` | 导入 replay 为本地 debate |
| `GET` | `/api/debate/{debate_id}/argument-map` | 论证图谱 (Phase 3 F6)，受 `FEATURE_ARGUMENT_MAP` gate |

说明：

- Debate 是独立域，不与主模式复用 scenario authority。
- `POST /api/debate` 当前接受 request-scoped LLM override：
  - `llm_api_key / llm_base_url / llm_model`
  - `reasoning_effort`
  - `llm_requests_per_minute / llm_tokens_per_minute`
  - `llm_base_url` 必须通过 allowlist；自定义 base URL 必须同时带 `llm_api_key`
  - 这些覆盖项只影响当前 debate，会用于 persona、turn、judge、phase insight、supporting turns 和 argument-map enrichment 相关 LLM 调用
- `POST /api/debate` 当前接受可选 `custom_agent_ids`：
  - 最多 2 个，重复值返回 422
  - `FEATURE_CUSTOM_AGENTS=false` 时返回 400
  - 每个 ID 都必须存在、`kind=custom` 且属于当前有效 `user_id`；跨用户返回 403
  - 第 1 个 ID 覆盖 proposition，第 2 个 ID 覆盖 opposition
  - 覆盖内容包括 display name、role、persona、knowledge domains 和 decision bias；这些文本只进入 prompt，不触发任何外部 URL 请求
- replay import 会保留 imported `phase_insights` 与 `adjudication_mode`。
- `POST /api/debate/import-replay` 当前会对 `turns / predictions / phase_insights` 的列表项做对象校验；非对象项仍返回 `422`。
- `POST /api/debate/import-replay` 在 `FEATURE_ARGUMENT_MAP=true` 时，会在 turns 落库后同步抽取 argument map；导入完成后就能直接读取图谱。
- `phase_insights` 当前只要求 `pressure_margin / turn_count >= 0`；`confidence_drift.phase_margin / cumulative_margin` 可以为负数，表示置信优势反向漂移。
- 常规 prediction 当前允许 `counterplay_variant: null`；只有显式给出非空值时才校验它是否属于合法 variant。
- `GET /api/debate/{debate_id}/result` 会在存在时返回 verdict 后处理写入的 `result.hallucination_gate`；gate 关闭或没有 metadata 时该字段为 `null`/缺省，不影响 result 成功返回。
- `GET /api/debate/{debate_id}/argument-map` 的 `edges[]` 使用 `source / target / type` 字段，并在有证据元数据时返回：
  `evidence: { confidence_tier, source_ref, source_round_number, detail }`。
  旧边或无证据边的 `evidence` 可以为 `null`。`detail` 同样是 `GraphEdge.evidence_json` 的预留透传字段；当前 argument-map 写边只填 coarse provenance，不填真实 detail。
- verdict linking 写出的 unit status 当前是 `accepted / standing / unaddressed / rebutted / rejected`。verdict 节点 payload 当前包含 `winner / verdict_tone / judge_summary`；`judge_summary` 是给前端展示用的短摘要，不作为新的判定 authority。
- `GET /api/debate/{debate_id}/argument-map` 在功能开启但读取阶段出错时，当前走 fail-soft：
  返回 `200`，并带空的 `nodes / edges / units` 和 `error: "ARGUMENT_MAP_LOAD_FAILED"`。

## Agent Conversation

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/conversation/start` | 创建 conversation thread，并写入第一条 user turn + 一条预留 assistant turn；受 `FEATURE_AGENT_CONVERSATION` gate |
| `GET` | `/api/conversation/{thread_id}` | 读取 thread 与已提交 turn 历史；受 `FEATURE_AGENT_CONVERSATION` gate |
| `POST` | `/api/conversation/{thread_id}/turn` | 通过 SSE 追加/启动 assistant turn；受 `FEATURE_AGENT_CONVERSATION` gate |
| `DELETE` | `/api/conversation/{thread_id}/active` | 中止当前 active assistant turn；受 `FEATURE_AGENT_CONVERSATION` gate |

说明：

- `POST /api/conversation/start` 会先验证 request-scoped BYOK override，但这一步本身不调用 LLM。
- `POST /api/conversation/start` 的 origin 字段当前包括：
  - `origin_branch_id`
  - `origin_round_number`
  - `origin_node_id`
  - `origin_node_type`
  这些字段会回显到 thread response，并写入后续 turn 的 `source_*` 字段。
- `POST /api/conversation/start` 和 `POST /api/conversation/{thread_id}/turn` 当前也接受可选 `origin_excerpt`：
  - strip 后为空会当作未传
  - 上限 1000 字符
  - 只作为本次 assistant prompt 的前端来源摘要，不写入 thread origin 字段，也不会在 thread response 里回显
- `start` 成功后，返回体会带 `thread_id / user_turn_id / assistant_turn_id`，供前端继续接 `/turn`。
- 如果首个 `/turn` 和 bootstrap 阶段的 `first_user_content` 相同，后端当前会直接 claim 这条预留 assistant turn，而不是再追加一条重复的 user turn。
- 同一个 bootstrap placeholder 只会被 claim 一次；并发重复首轮请求不会再同时拿到两条 live stream。
- 流式 prompt 会按 thread origin 尝试补 scenario question、branch summary、origin graph node、相邻关系摘要和最近几轮同分支 transcript；前端传 `origin_excerpt` 时，也会放进同一段 untrusted context。这层只读取同 scenario 的最新 causal snapshot，且会截断文本。origin 如果没有可用 `agent_name`，后端按 graph analyst 口径回答，不冒充具体参与者。
- `start` 和后续 `/turn` 当前都会消耗 rolling 24h 的 daily quota：
  - user quota 键取自 `thread.owner_user_id`
  - org quota 键取自 `X-Org-Id` 落库后的 `thread.organization_id`
  - 超限时返回 `429`，并带 `Retry-After`
  - 这层计数已经落到持久化 ledger，backend 重启后不会丢
- `/turn` 的 SSE 正常事件仍是 `turn_started / turn_token_delta / turn_completed`。
- 如果 bootstrap 预留 assistant turn 在首个 `turn_started` 前已经被 abort，就不会再补一条 stale `turn_started`。
- scenario 删除打断 stream 时，服务端当前会补一条终态 `turn_error`，并带 `code: "SCENARIO_DELETED"`；如果删除发生在首个 `turn_started` 前，也会直接收成这条终态。
- 已经进入流式阶段的 user abort / 连接断开仍收口到 `USER_ABORTED`。

## Quota

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/quota/summary` | 返回 conversation 与 replay 两个 quota bucket |

关键约束：

- 每个 bucket 都带 `used / limit / remaining / enforced / scope / window_seconds`。
- 开启 `SESSION_SECRET` 后，owner-scoped 读取要求 signed principal；裸 `SESSION_SECRET` 不能读取 owner-scoped quota。
- `conversation.scope` 可能是 `local / user / org`：
  - 无 signed principal 且无 `X-Org-Id` 时是 `local`，`enforced=false`，前端显示本机模式，不把 `500` 当成在线额度。
  - 有 signed principal 时按 user rolling 24h ledger 统计。
  - 有 `X-Org-Id` 且无 signed principal 时按 org rolling 24h ledger 统计；header 只接受 `[A-Za-z0-9_-]`，最长 128 字符。
- `replay.scope` 固定是 `scenario`，`enforced=true`；不带 `scenario_id` 时 `used=0`。
- 带 `scenario_id` 时，后端会先校验 caller 能看到该 scenario，再统计该 scenario 下 `counterfactual / resume` replay branch 用量。

## Phase 3 — Agents / Graphs

| 方法 | 路径 | 说明 | 开关 |
|------|------|------|------|
| `GET` | `/api/agents/identities` | Agent 身份列表 | `FEATURE_CUSTOM_AGENTS` 或 `FEATURE_AGENT_IDENTITY` |
| `GET` | `/api/agents/identities/favorites` | 当前用户收藏的 Agent 身份 | `FEATURE_CUSTOM_AGENTS` |
| `POST` | `/api/agents/identities/preflight` | 创建 scenario 前预览 continuity 匹配 | `FEATURE_AGENT_IDENTITY` |
| `GET` | `/api/agents/identities/{id}/memory` | 跨场景记忆 | `FEATURE_AGENT_IDENTITY` |
| `GET` | `/api/agents/identities/{id}/memories` | identity memory inspector 明细 | `FEATURE_AGENT_IDENTITY` |
| `GET` | `/api/agents/identities/{id}/growth-events` | 成长事件时间线 | `FEATURE_AGENT_IDENTITY` |
| `POST` | `/api/agents/identities/{id}/favorite` | 收藏当前用户拥有的 Agent identity | `FEATURE_CUSTOM_AGENTS` |
| `DELETE` | `/api/agents/identities/{id}/favorite` | 取消收藏当前用户拥有的 Agent identity | `FEATURE_CUSTOM_AGENTS` |
| `POST` | `/api/agents/workshop` | 创建自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `PUT` | `/api/agents/workshop/{id}` | 更新自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `PATCH` | `/api/agents/workshop/{id}` | 更新自建 Agent，当前与 `PUT` 同语义 | `FEATURE_CUSTOM_AGENTS` |
| `DELETE` | `/api/agents/workshop/{id}` | 删除自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `POST` | `/api/agents/from-document` | 从 PDF 文档抽取实体并创建自建 Agent | `FEATURE_CUSTOM_AGENTS` |
| `GET` | `/api/agents/identities/{id}/export` | 导出单个 Agent 备份 JSON | `FEATURE_PERSONA_EXPORT` |
| `POST` | `/api/agents/export-bulk` | 批量导出 Agent 备份 JSON | `FEATURE_PERSONA_EXPORT` |
| `POST` | `/api/agents/import` | 从 Agent 备份 JSON 创建新的 custom Agent | `FEATURE_PERSONA_EXPORT` |
| `GET` | `/api/scenario/{id}/causal-graph` | 因果图谱 | `FEATURE_CAUSAL_GRAPH` |
| `GET` | `/api/scenario/{id}/graph-analysis` | 因果图谱摘要分析 | `FEATURE_GRAPH_ANALYSIS` + `FEATURE_CAUSAL_GRAPH` |
| `GET` | `/api/scenario/{id}/personality-drift` | Agent 人格漂移 warning 数据 | `FEATURE_AGENT_IDENTITY` |
| `POST` | `/api/scenario/{id}/counterfactual` | 创建反事实分支 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `POST` | `/api/scenario/{id}/resume` | 从指定 round 续跑新分支 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/compare` | 分支对比 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/checkpoints` | 检查点列表 | `FEATURE_COUNTERFACTUAL_REPLAY` |
| `GET` | `/api/scenario/{id}/replay-trace` | replay branch lineage | `FEATURE_REPLAY_TRACE` |
| `GET` | `/api/scenario/{id}/faction-timeline` | 阵营时间线 | `FEATURE_FACTIONS` |

说明：

- 所有 Phase 3 endpoint 在对应 `FEATURE_*=false` 时返回 404，不执行任何业务逻辑。
- `FEATURE_KG_EXPLORER` 只控制 KG Explorer / Timeline Galaxy 的前端 capability gate；当前页面数据仍读取 `GET /api/scenario/{id}/causal-graph`，因此也需要 `FEATURE_CAUSAL_GRAPH=true`。
- `POST /api/agents/identities/preflight` 当前只返回需要 L3 确认的 `L2 fuzzy candidate`；`L1 exact` 和全新 identity 不会阻断前端启动。解析阶段最多等待 10 秒；超时返回 `504 IDENTITY_PREFLIGHT_TIMEOUT`，后端不会把它包装成“无匹配”。当前首页启动流会提示 preflight 错误，但继续按无 continuity override 创建 scenario。
- favorite 只写当前用户拥有的 identity；跨用户或不存在的 identity 返回 404，不泄漏数据。
- `GET /api/agents/identities/{id}/memories` 会按 owner 校验，并返回最多 100 条 inspector memory。向量库不可用时仍返回 200，但会带机器可读的 `error` 字段，方便前端区分空记忆和基础设施错误。
- `GET /api/agents/identities/{id}/growth-events` 当前要求 `user_id`；缺失时返回 400，identity 不存在或 owner 不匹配时返回 404。
- `POST /api/agents/from-document` 只接受 PDF：`application/pdf / application/x-pdf` 直接通过，空 content type 或 `application/octet-stream` 只在文件名以 `.pdf` 结尾时作为兼容路径接受。上传上限 25 MB，最多读取 200 页和 1000000 个字符，并带 30 秒 PDF 解析超时；空文件返回 `DOCUMENT_FILE_EMPTY`，超大文件返回 413 `DOCUMENT_FILE_TOO_LARGE`，非法 PDF 返回 `DOCUMENT_PDF_INVALID`，无可抽取文本返回 `DOCUMENT_TEXT_EMPTY`，解析超时返回 `DOCUMENT_PDF_TIMEOUT`。
- 文档实体提取有独立超时；长文档会先采样粗扫候选实体和 alias，再从全文取匹配证据做精提。所有 PDF 文本、候选和证据进入 prompt 前都会按 untrusted text block 包装。
- 文档生成 Agent 时，单个 persona 超时、业务校验失败或生成失败会被计入 `agents_failed`，已成功创建的 identities 仍会返回；全部 persona 都失败时返回结构化错误，不会伪装成 `201 + agents_created: 0`。持久化等运行时异常不会被包装成成功响应。
- Agent 备份使用 `schema_version=1`；export 会去掉本地 untrusted-data wrapper，只导出可移植 persona 文本；bulk export 最多 20 个 identity。import 不覆盖旧 identity，而是为当前用户创建新的 custom Agent，成功响应为 `{ "success": true, "identity_id": "..." }`。`schema_version` 不支持、必填字段缺失或 `decision_bias` 不是对象时返回 422 `PERSONA_IMPORT_INVALID`；bias 对象里的 boolean、`NaN/Inf` 和非数字值会回到默认值，超出 `0..1` 的数字会被 clamp。
- `POST /api/agents/workshop` / `PUT /api/agents/workshop/{id}` 当前支持：
  - `persona`
  - `knowledge_domains`
  - `decision_bias`
  - `preferred_tier`
- `decision_bias` 固定为 5 个 key：`caution / optimism / conservatism / risk_tolerance / creativity`。缺失 key 会补 `0.5`；未知 key 会被拒绝；数字字符串会按浮点数解析；boolean、非数字、`NaN/Inf` 或超出 `0..1` 的值会被拒绝。
- `preferred_tier` 只接受 `IMPORTANT / CROWD`。create 默认 `IMPORTANT`；update 不传表示不改。`CORE` 会被 schema 拒绝，不是自建 Agent 可选层级。
- 只有 `kind=custom` 的 identity 可以通过 workshop update/delete 修改；generated identity 会返回 `AGENT_NOT_EDITABLE` 或 `AGENT_NOT_DELETABLE`。
- workshop response / identity list 当前会回显：
  - 原始 JSON 字段：`knowledge_domain_json / decision_bias_json`
  - 解析后的字段：`knowledge_domains / decision_bias`
  - `preferred_tier`
- 旧数据里 JSON 解析失败时，解析后的字段会降级为空，不影响 identity list 返回。
- `GET /api/scenario/{id}/causal-graph` 当前会先 `trim` `branch_id`：
  - 空白值按未过滤处理
  - 不属于当前 `scenario` 的 `branch_id` 返回 `404 BRANCH_NOT_FOUND`
  - 旧 SQLite 如果还留有重复 `graph_snapshot`，运行时 repair 会保留最新 snapshot，并删除旧 snapshot 的 node/edge；返回体不再混入 stale duplicate node/edge
  - 成功返回体仍会带 `available_branches`
- `GET /api/scenario/{id}/causal-graph` 的 `nodes[]` 除持久化图节点外，也可能包含合成节点：
  - `type=outcome`：由 completed branch 投影出来，payload 带 `branch_id / title / probability / status / story_excerpt / insight / parent_branch_id`
  - `id` 以 `legacy-event:` 开头的 event：用于只读回补旧 snapshot 里孤立 fork 的消息 provenance，payload 会带 `synthetic_provenance=true`
- `GET /api/scenario/{id}/causal-graph` 的 `edges[]` 使用 `source / target / type / weight / label` 字段；有证据元数据时会返回
  `evidence: { confidence_tier, source_ref, source_round_number, detail }`。旧边或无证据边的 `evidence` 可以为 `null`。重放轮次只会补齐旧边缺失的 evidence 字段，不覆盖已有非空值。当前 causal graph 会返回已有 `temporal / caused` 边，也可能返回后端规则生成的 `responds_to / supports_stance / opposes_stance`，以及合成结局使用的 `led_to`。inter-agent 边只来自同一 `branch / round` 的 event 节点，`detail` 会透传确定性 rule / reason JSON；其它 causal graph 边可能仍只有 coarse provenance。客户端不要把 `detail` 当成 LLM 解释文本。
- `GET /api/scenario/{id}/graph-analysis` 返回 `god_nodes / degree_distribution / cross_branch_edges / summary`。`summary.total_nodes` 统计序列化 causal snapshot 的可见节点，包含合成 `outcome` nodes。大图会按最新 snapshot size 做 SQL 预检，超过 `5000 nodes / 20000 edges` 时返回 `truncated: true`。带 `branch_id` 时，预检按该 branch 的可见节点/边计数；未带 `branch_id` 时仍按全图计数。
- `GET /api/scenario/{id}/personality-drift` 返回 `agent_id / agent_name / drift_score / drift_dimensions / severity / evidence`。结果按 drift score 降序排列；波动项来自消息 emotion 变化，不读取不存在的 message stance 时间线。前端只把 medium/high 当 warning 展示，不把它当 hard gate。
- `GET /api/scenario/{id}/replay-trace` 当前是只读 cursor pagination：
  - `after` 是上一页最后一个 branch id；空白值按未传处理
  - `limit` 范围为 `1..100`
  - `root_branch_id` 用于按 replay source branch 过滤分支链路，前端的 branch filter 会走这个参数
  - 返回体为 `{ nodes, next_cursor }`，不写库，也不消耗 replay branch quota
- `GET /api/scenario/{id}/checkpoints` 当前可选 `branch_id`：
  - 不传时返回 scenario 下全部 checkpoint
  - 传入时会先校验 branch 属于当前 scenario；不存在或跨 scenario 时返回 `404 CHECKPOINT_BRANCH_NOT_FOUND`
  - 校验通过后只返回该 branch 的 checkpoint
  - 返回项包含 `round_number / compressed_summary / blackboard_json / created_at`；前端 resume 面板只把 `compressed_summary` 当作可见预览，不把它当新的 authority
- `POST /api/scenario/{id}/counterfactual` 当前约束：
  - scenario 状态必须是 `done`；否则返回 `409 COUNTERFACTUAL_SCENARIO_STATUS_INVALID`
  - source branch 不存在时返回 `404 COUNTERFACTUAL_BRANCH_NOT_FOUND`
  - `round_number` 通过 schema 校验，必须 `>= 1`
  - `round_number` 超出 source branch 已有范围时返回 `400 COUNTERFACTUAL_ROUND_OUT_OF_RANGE`
  - clone 前会先校验目标 round 里是否存在该 `agent_id` 的消息；找不到时返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_NOT_FOUND`
  - 请求体当前也支持可选 `source_message_content`
    - 同 agent 同轮只有 1 条消息时，不传也可以
    - 同 agent 同轮有多条消息时，不传会返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS`
    - 纯空白值会按“未指定”处理，口径与不传一致
    - 传了但找不到唯一匹配时，会返回 `400 COUNTERFACTUAL_AGENT_MESSAGE_MISMATCH` 或 `400 COUNTERFACTUAL_AGENT_MESSAGE_AMBIGUOUS`
  - 如果 seed 阶段失败，会返回 `400 COUNTERFACTUAL_SEED_FAILED`，并清理刚创建的 replay branch
- `POST /api/scenario/{id}/counterfactual` 与 `POST /api/scenario/{id}/resume` 当前共用 replay branch 锁：
  - 正在跑另一条 replay branch 操作时返回 `409 REPLAY_BRANCH_BUSY`
  - 达到共享上限时返回 `429 REPLAY_BRANCH_LIMIT_REACHED`
- `POST /api/scenario/{id}/resume` 当前还会先预占 simulation lock：
  - 在尝试 replay branch 锁前，会先校验 scenario/source branch/round；这些前置校验失败时不会占用 replay branch 锁
  - scenario 状态不是 `done` 时返回 `400 RESUME_SCENARIO_STATUS_INVALID`
  - source branch 不存在时返回 `404 RESUME_BRANCH_NOT_FOUND`
  - round 超范围时返回 `400 RESUME_ROUND_OUT_OF_RANGE`
  - simulation lock 已被占用时返回 `409 SIMULATION_ALREADY_RUNNING`
  - 只有后台任务真正成功挂起后才会返回 `201`
- 当 `SESSION_SECRET` 非空时：
  - agent identity / workshop 当前要求 signed principal token
  - 读取 scenario owner 资源的 graph / counterfactual / checkpoints / faction-timeline 也会按 principal 收口
- 前端通过 `GET /api/capabilities` 检测 `enabled` 字段，disabled 时隐藏入口且不发请求。

## Ending Room / Worldline Roundtable

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/scenario/{scenario_id}/ending-room` | 创建或复用 room |
| `GET` | `/api/ending-room/{room_id}` | room snapshot |
| `GET` | `/api/ending-room/{room_id}/result` | room result payload |
| `POST` | `/api/ending-room/{room_id}/thread` | 创建 follow-up thread |
| `GET` | `/api/ending-room/thread/{thread_id}` | 读取 thread snapshot |
| `POST` | `/api/ending-room/{room_id}/user-turn` | room 级追问 |
| `POST` | `/api/ending-room/thread/{thread_id}/user-turn` | thread 级追问 |
| `POST` | `/api/scenario/{scenario_id}/survey` | 通过 SSE 向同一 roundtable room 的代表发起短问询 |
| `POST` | `/api/scenario/{scenario_id}/analyst` | 通过 SSE 启动 roundtable analyst 追问与工具式分析 |

关键约束：

- `ending_room` 是独立域，room/thread memory partition 隔离。
- `crossline_gallery` 是只读摘要视图，不会开启可写 follow-up。
- 请求体列表字段有大小上限（`selected_branch_ids / selected_agent_ids` ≤ 50，`addressed_agent_ids / question_anchor_ids` ≤ 20），超出会返回 Pydantic 422。
- 用户追问 `content` 上限 5000 字符，线程 `title` 上限 500 字符。
- `POST /api/ending-room/{room_id}/thread`
  当前也接受 `question_anchor_ids`，用于显式记录 thread 是由哪个 `quote / verdict / key_moment / phase` 发起。
- `POST /api/ending-room/{room_id}/user-turn` 与 `POST /api/ending-room/thread/{thread_id}/user-turn`
  当前都接受 `question_anchor_ids`。
  当前还接受可选字段 `cited_branch_id`（引用另一条世界线）和 `cited_refs_json`（引用元数据，上限 4 KB）。
  当 `cited_branch_id` 存在时，后端会验证它属于同一 scenario，验证失败则静默忽略。
  当 `interaction_mode` 未指定但 `cited_branch_id` 存在时，自动使用 `evidence_card` 模式。
  接受后的 assistant follow-up turn 会继续回显该 `cited_branch_id`；assistant 的 `cited_refs_json` 会带 `kind / thread_mode`，并把用户提交的引用元数据保存在 `source` 字段下。
- `EndingRoomInteractionMode` 当前支持：
  `auto_recap / archivist_route / hotseat / all_present / thread_followup / epilogue / evidence_card`。
  - `epilogue`：后续三回合短叙事推演。
  - `evidence_card`：引入另一条世界线的摘要卡。
  - `epilogue` 与 `evidence_card` 在 `crossline_gallery` 下不可用。
- `GET /api/ending-room/thread/{thread_id}` 与 room/result snapshot 里的 turn 数据
  当前都会回显：
  - `question_anchor_ids_json`
  - 便于 replay/read-only 恢复与自动化验证锚点语义。
- `POST /api/scenario/{scenario_id}/survey`
  受 `FEATURE_ROUNDTABLE_SURVEY` gate；请求体包含 `question`、`participant_ids`，并可选 `room_id / llm_api_key / llm_base_url / llm_model`。
  - `participant_ids` 必须去重后仍非空，当前最多 6 个。
  - `room_id` 用于限定目标 `worldline_roundtable` room；如果指定但不属于当前 scenario，返回 `404 ROUNDTABLE_ROOM_NOT_FOUND`。
  - 同一请求里不允许混用不同 roundtable room 的 participant；这类歧义返回 `409 ROUNDTABLE_ROOM_AMBIGUOUS`。
  - SSE 正常事件为 `survey_response`；单个代表的 LLM 错误会收口在对应 `survey_response.error`，不把整个流升级成 fatal error。
- `POST /api/scenario/{scenario_id}/analyst`
  受 `FEATURE_ROUNDTABLE_ANALYST` gate；请求体包含 `question`，并可选 `room_id / llm_api_key / llm_base_url / llm_model`。
  - 同一 scenario 里只有一个 roundtable room 时，`room_id` 可以省略；存在多个 roundtable room 时必须显式传 `room_id`。
  - 缺少必要 `room_id` 造成的多房间歧义返回 `409 ROUNDTABLE_ROOM_AMBIGUOUS`；指定的 `room_id` 不属于当前 scenario 时返回 `404 ROUNDTABLE_ROOM_NOT_FOUND`。
  - SSE 事件为 `analyst_thinking / analyst_tool_result / analyst_response`；`analyst_response` 是终态响应，也承载 LLM 错误或迭代上限结果。
- `survey` 与 `analyst` 的 request-scoped LLM override 口径一致：
  - `llm_api_key / llm_base_url / llm_model` 只影响当前请求，不改服务端默认配置。
  - 传 `llm_base_url` 时会走允许列表校验；自定义 base URL 必须同时带 `llm_api_key`。
  - `llm_model` 只接受逻辑模型名，不能传 URL。

## WebSocket

| 协议 | 路径 | 说明 |
|------|------|------|
| `WS` | `/ws/scenario/{scenario_id}` | 主模式 live 事件 |
| `WS` | `/ws/debate/{debate_id}` | Debate live 事件 |
| `WS` | `/ws/agent-conversation/{thread_id}` | 图谱节点对话 thread 事件 |
| `WS` | `/ws/ending-room/{room_id}` | Ending room / roundtable 事件 |
| `WS` | `/api/ws/ending-room/{room_id}` | ending-room WS alias |

说明：

- scenario / debate live 事件都会带 `meta`，前端按 `sequence / event_id` 去重。
- Debate live 事件当前还包括 `debate_participants_update`：
  - payload 为 `{ participants: DebateParticipant[] }`
  - 通常在 LLM persona upgrade 成功后、首个 `agent_speak` 前广播
  - 客户端应按 `side` 合并 participants，并允许该事件早于 REST snapshot 到达
- scenario cancel 成功后会广播 `simulation_cancelled`；前端把 `cancelled` 视为终态，晚到的旧 `status/state` 事件不能把页面带回 live 状态。
- scenario WS 当前也可以广播 `kg:delta` 与 `kg:snapshot_invalidated`：
  - `kg:delta` 的 `data` 是合并后的 causal graph delta，包含 `scenario_id / version / added / updated / deleted / snapshot_invalidated`。
  - `kg:snapshot_invalidated` 表示客户端应丢弃本地增量状态并拉取 `GET /api/scenario/{id}/causal-graph`。
- 空闲期会发送轻量 `heartbeat`。
- `X-Session-Token` 只用于 REST。
- 当 `SESSION_SECRET` 非空时，`scenario / debate / agent-conversation / ending-room` 这 4 条 WS 都继续走首帧 auth 协议，不依赖 HTTP-style dependency 注入。
  - 客户端先连上 socket，再发送 `{"type":"auth","token":"..."}`。
  - 服务端验证通过后返回 `{"type":"auth_ok"}`，然后才注册连接。
  - `4001 / 4404` 属于非重连关闭码；`1006` 仍按可恢复异常断连处理。

## 源码入口

- `CreateScenarioRequest.user_id` 上限 128 字符。
- `CreateReplayArtifactRequest.kind` 上限 64 字符，不能为空。
- `/docs`、`/redoc`、`/openapi.json` 默认不暴露，需设置 `EXPOSE_API_DOCS=true`。
- 路由：`backend/app/api/*.py`
- schema：`backend/app/api/schemas.py`
- 运行时逻辑：`backend/app/services/*.py`
