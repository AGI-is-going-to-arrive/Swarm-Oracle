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
| Scenarios | `backend/app/api/scenarios.py` | scenario 创建、查询、列表、删除、story、replay artifact |
| Agents | `backend/app/api/agents.py` | identity 列表 / preflight、memory、growth-events、自建 Agent workshop |
| Interventions | `backend/app/api/interventions.py` | 即时 / 回溯 / 批量干预、模板 |
| Campaign | `backend/app/api/campaign.py` | director/gameplay authority、profile、mastery、badge、summary |
| Predictions | `backend/app/api/predictions.py` | scenario prediction、评分、leaderboard |
| Debate | `backend/app/api/debate.py` | debate live/result/import-replay/predict |
| Ending Room | `backend/app/api/ending_rooms.py` | ending-room room/result/thread/user-turn 与 WS |
| Scenario WS | `backend/app/api/ws.py` | 主模式 WebSocket |
| Social | `backend/app/api/social.py` | 社交文案与 Markdown 导出 |

### 服务层

| 模块 | 位置 | 责任 |
|------|------|------|
| Simulator | `backend/app/services/simulator.py` | scenario 主循环、fork、narration 编排、Phase 3 hooks (causal/factions WS/checkpoint/identity lifecycle) |
| Agent Identity | `backend/app/services/agent_identity.py` | continuity key 预览 / 解析、跨场景 identity、growth event、memory 查询 |
| Memory | `backend/app/services/memory.py` | L1 压缩、context 组装 |
| Web Context | `backend/app/services/web_context.py` | 搜索增强 provider dispatch、请求级 override、缓存与上下文格式化 |
| LLM Client | `backend/app/services/llm_client.py` | LLM 调用、并发控制、限流、熔断、JSON stream-first fallback |
| Vector Store | `backend/app/services/vector_store.py` | Chroma L2 记忆 + identity memory/profile（串行化锁保护写入） |
| Ending Room Service | `backend/app/services/ending_room_service/` | room/thread scope、follow-up、后台生成（已拆分为 `__init__.py` + `_utils.py` + `_content.py` + `_participants.py` + `_threads.py`） |
| Scoring | `backend/app/services/scoring.py` | prediction 评分与 leaderboard 物化 |
| Runtime Lock | `backend/app/services/runtime_lock.py` | SQLite shared lease，防重入 |
| Gameplay Contract | `backend/app/services/gameplay_contract.py` | 读取共享玩法契约 |

### 数据模型

| 模块 | 位置 | 责任 |
|------|------|------|
| Core Models | `backend/app/models/database.py` | `Scenario`、`Branch`、`Round`、`Message`、`ReplayArtifact` 等 |
| Campaign Models | `backend/app/models/campaign.py` | director profile、mastery、badge、campaign log |
| Debate Models | `backend/app/models/debate.py` | debate、turn、prediction、counterplay |
| Ending Room Models | `backend/app/models/ending_room.py` | room、participant、thread、turn |
| Prediction Models | `backend/app/models/predictions.py` | prediction、leaderboard |

## 当前 authority

### 主模式

- `Scenario.director_state_json`
  主模式 director goals、risk/resource、commitment 的 authority。
- `Scenario.gameplay_state_json`
  玩法卡、押注、archive raw 的 authority。
- 这两块都通过 `campaign` 路由读写，并带 `revision` 乐观并发控制。

### Replay

- 短链 replay 通过 `ReplayArtifact` 持久化。
- 前端分享链路优先使用后端 artifact，失败时才回退本地 token。
- `delete_scenario()` 当前也会同步清理该 scenario 关联的 `ReplayArtifact`，不会继续保留可读的旧 share artifact。
- `compare_branches()` 当前会先验证 `branch_a / branch_b` 属于传入的 `scenario_id`，不再允许跨场景 branch 混入 compare 结果。

### Ending Room

- `ending_room` 是独立域。
- room、thread、participant、turn 都在独立表中维护。
- room/thread transcript 与 memory partition 隔离，不与主模式消息链混用。
- `ending_room_turn.question_anchor_ids_json`
  当前已用于显式记录 `quote / verdict / key_moment / phase` 等锚点来源。
- `ending_room_thread.question_anchor_ids_json`
  当前也已成为真实字段，thread create 与后续 replay/read-only 恢复都能保留锚点语义。
- `EndingRoomInteractionMode` 当前支持 7 种模式：
  `auto_recap / archivist_route / hotseat / all_present / thread_followup / epilogue / evidence_card`。
  - `epilogue`：后续三回合短叙事推演，不重启主 simulation。
  - `evidence_card`：把另一条世界线的摘要卡引入当前讨论，由档案官解释差异。
- `create_ending_room_thread()` 当前会在创建阶段校验 room type 与 `interaction_mode` 的组合是否合法；例如 `worldline_roundtable` 不会再先落库一个从一开始就不可用的 `all_present` thread。
- Oracle 改写 prompt 当前包含双层角色化词汇提示（`_oracle_vocabulary_hints()`）：
  - 领域调色板层：按 voice variant（imperial / field / finance / market / faith / industry / frontier / survival / scholar / civic / diplomat / advisor / science，共 13 种）提供领域专属术语、句式风格和情绪基调。已知限制：子串匹配可能造成少量误分类（如 warlord→imperial via "lord"）。
  - 身份层：从 `persona_snapshot_json` 中提取 agent 的实际身份（`agent_role`）、简介（`bio_short`）、影响力（`impact_score`）、叙事地位（`tier`）和推演参与度（`turn_count / key_moment_hits`），动态生成 identity 提示。
  - 高影响力 agent（impact_score ≥ 7）措辞更自信有分量；低影响力 agent（≤ 3）措辞更谨慎。
  - 档案官有独立的词汇提示，不受 variant 影响。
  - plain variant 没有领域词汇，但仍会输出 identity 层（只要 snapshot 有数据）。
- `ending_room_turn` 的 `cited_branch_id` 与 `cited_refs_json` 当前已从 API 层开放写入。
  - `cited_branch_id` 会做 scenario 级验证，不允许跨场景引用。
  - `cited_refs_json` 有 4 KB 大小限制。
- Agent identity L2 profile 当前使用独立 `identity_profile_{user_id}` collection：
  - generated/custom identity 都会同步 profile
  - custom agent create/update/delete 会同步写入或清理 profile
  - 旧的 shared-collection profile 文档会在后续写入时自动清理，不再参与 memory eviction / compaction
- main simulation 当前已补 continuity preflight/override 链路：
  - `POST /api/agents/identities/preflight` 会先跑 parser，再只把 `L2 fuzzy candidate` 返回给前端确认
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
  - debate argument map enrichment
  - identity compaction
  - fork detection
  - Oracle auto-recap 静态改写
  - 行为是：先 probe 当前 provider/model 是否支持流式 JSON；支持则优先流式，不支持或失败再退非流式。各业务自己的本地 fallback 仍保留，不靠 LLM helper 兜底所有问题。
- `llm_call()` 当前会把“`HTTP 200` 但非流式正文为空”视为 provider incompatibility，而不是静默返回空字符串：
  - `chat/completions` 的 `choices[0].message.content` 为空会直接报错
  - `responses` 会先尝试 `content[].text`、`content[].output_text`、top-level `output_text`；还拿不到正文就报错
  - 这样上层不会再把空正文拖到 `json.loads("")` 才暴露
- 本地兼容网关的 live probe 当前有独立测试：
  - `backend/tests/test_llm_gateway_probe.py`
  - 用来确认本地 OpenAI-compatible 端点的非流式正文和流式 JSON 路径是否可用。
- Oracle follow-up 的 stream support probe 当前复用 `llm_call_stream()`；`estimated_tokens` 预估已补回，不再因为 probe 自身变量缺失而误触发 fallback。
- Oracle follow-up 流式链路当前会给“首个可见 delta”一个短预算；如果 provider 长时间不出可见 token，会尽快回退到非流式改写，而不是把 anchored follow-up 长时间挂住。
- Oracle follow-up 当前会在 WebSocket delta 广播和最终 turn 落库前先剥掉 provider reasoning block；`<think>` 不会再泄漏进 transcript。
- Oracle follow-up append 当前不是整房间 all-or-nothing：
  - user turn 先提交
  - assistant follow-up turn 在真正落库时重新分配最终 `sequence`
  - 这样并发 follow-up 不会继续复用旧序号窗口
- 只要 follow-up 已经发出 `ending_room_turn_start`，后续无论是 partial stream 中断，还是后面的 rewrite / commit 失败，都会补 `ending_room_turn_error`；payload 当前带 `message / error / code / recoverable`，前端可据此清理 draft 而不把整 room 升成 fatal error。
- Oracle auto-recap 的静态改写当前已接到 `stream-first + non-stream fallback` helper；follow-up / thread 仍走独立流式状态机，不和 auto-recap 共用同一条改写调度逻辑。
- SQLite 当前默认启用 WAL 模式（`journal_mode=WAL`）和 `busy_timeout=5000`，缓解并发写入冲突。内存数据库会跳过 WAL 设置。
- `resolve_identity()` 当前已支持复用外层 SQLModel session，避免 scenario parse 路径在同一事务里二次开 session 时撞到 SQLite `database is locked`。
- request-scoped BYOK / RPM / TPM 当前不仅作用在主 simulation turns，也会继续透传到 fork detection、narration、memory compression 与 identity compaction。
- 搜索增强当前走 `web_context.py`：
  - provider 支持 `tavily / exa / xai / searxng`
  - `POST /api/scenario` 可传 request-scoped `web_search_provider / web_search_api_key / web_search_base_url`
  - `web_search_enabled=false` 时，这些 override 字段会在路由层被忽略，不影响正常建局
  - custom provider override 不会再复用“另一个 provider”的服务端默认 key
  - `xai` 走 Responses API + `web_search` tool，并使用独立 `XAI_WEB_SEARCH_TIMEOUT_SECONDS`
  - `searxng` 自定义 base URL 当前只接受与服务端 `SEARXNG_URL` 完全一致的基址
- Ending Room 的同步服务函数（`create_ending_room`、`create_ending_room_thread`、`load_ending_room_snapshot` 等）在 async 端点中通过 `asyncio.to_thread()` 调用，不阻塞事件循环。路由层对 `to_thread` 内部的非业务异常有通用 `except Exception` 兜底，不会让裸 DB 异常直接落成未分类 500。
- Debate argument map 当前走两层抽取：
  - 第一层：rule-based sentence split + claim/evidence/rebuttal 分类
  - 第二层：默认开启的 fire-and-forget LLM enrichment，补 `type / stance / confidence`
  - 第二层失败不会中断 debate 主链，也不会覆盖第一层结果
- `debate import-replay` 当前会把非法 `phase / speaker_side / prediction / counterplay` 字段统一收口为稳定 `422`，不再 silent corruption，也不再把枚举/浮点解析错误打成未分类 `500`。
- WebSocket 入站消息有 64KB UTF-8 字节大小限制，超出会以 `1009` 状态码关闭连接。
- BYOK API key 在内存传递时使用 `_OpaqueStr` 包裹，`repr()` 和 JSON 结构化日志都会输出 `"***"` 而非真实值；但 `str()` 和 f-string 仍返回真实值，确保 httpx header 正常工作。
- BYOK `llm_base_url` 必须通过 hostname allowlist + http(s) scheme 校验。业务入口 (scenario/debate/predictions/social) 要求 `base_url` 必须同时带 `api_key`，否则返回 400。
- 当多个 backend worker 共用同一个 SQLite 文件时：
  - pending/quota 共享计数会生效
  - runtime lock 会跨进程共享

## WebSocket 口径

- 主模式与 Debate 都通过 WS 推送 live 事件。
- 出站事件统一带顶层 `meta`，供前端按 `sequence / event_id` 去重与补拉。
- 空闲期会发送轻量 `heartbeat`，便于更快暴露半断开连接。
- `ending_room` 也有独立 WS 通道，不复用 scenario/debate stream。
- ending-room WS 当前挂在独立的 ws router 上：
  - 业务 REST router 统一通过 `verify_session` 校验 `X-Session-Token` header
  - 当路由需要 caller identity 时，会继续要求 signed principal token，而不是只接受裸 `SESSION_SECRET`
  - WebSocket 继续使用首帧 auth 协议
- Oracle replay 的自动化状态当前也会显式跟随 active replay thread 的 `interaction_mode`，避免 mobile roundtable readonly 在自动化口径里误报成主桌模式。
- 当 `SESSION_SECRET` 非空时，WS 采用首帧 auth 协议：服务端先 accept，再等待客户端发送 `{"type":"auth","token":"..."}`（10 秒超时，64KB 上限），验证通过后回复 `{"type":"auth_ok"}`，然后才注册连接并启动 heartbeat。未认证的 socket 不会进入 `_connections` 池，不会收到 broadcast 或 heartbeat。
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
