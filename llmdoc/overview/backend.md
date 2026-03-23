# Backend 模块地图

> 文档类型：L0 current-truth
> 作用：后端模块、authority 结构与关键接口真值。详细验证流水保留在 `progress.md`。

## 模块依赖关系

```
api/scenarios.py ──► api/schemas.py (Pydantic 模型)
    │             ├── api/helpers.py (后台任务/工具函数)
    │             ├── api/interventions.py (干预路由)
    │             └── api/social.py (社交媒体文案路由)
    │
    ├──► services/simulator.py ──► services/memory.py
    │                           ├── services/llm_client.py (含指数退避重试)
    │                           ├── services/parser.py
    │                           ├── services/narrator.py
    │                           ├── services/vector_store.py
    │                           ├── services/scoring.py (P3-B)
    │                           └── services/lang_detect.py (P9)
    │
    ├──► visualization/ ──► 像素化可视化层 (Phase 1+2)
    │       ├── events.py (事件类型枚举 + 工厂，含 WEATHER_CHANGE)
    │       ├── mapper.py (VisualizationMapper — 8 个 map_* 方法)
    │       ├── persona_mapper.py (Agent → Sprite 分配 + 坐标计算)
    │       ├── scene_selector.py (双签名 → 30 场景语义池；原始题面优先，含 `law_court_variant` / `faith_temple_variant` / `switchboard_forum_variant`)
    │       └── card_events.py (卡牌事件触发 + 可视化映射；卡牌定义由 `services/gameplay_contract.py` 装载 shared contract)
    │
api/campaign.py ──► services/campaign.py / daily_challenges.py (Track A / Phase A1 + challenge rotation)
    │
api/debate.py ──► services/debate.py / debate_prompts.py / debate_scoring.py (Track D)
    │
api/predictions.py ──► services/scoring.py (P3-B)
    │
api/ws.py ──► WebSocket Manager (内联；scenario / debate receive loop 当前复用同一套 session wrapper，并都会在 `finally` 中清理连接；connect 前会先检查目标 `scenario / debate` 是否存在，不存在就直接拒绝接入；这层当前只收住“无效 id 也能监听”的问题，不承担真正的用户级鉴权；broadcast 已改为并行发送，不再被单个慢连接拖住整组广播；除 `heartbeat` 外，当前还会给所有出站事件统一补顶层 `meta = {stream_id, sequence, event_id, manager_instance_id, emitted_at}`；空闲期仍会发送轻量 `heartbeat` 让半断开连接更快暴露；当某个 scenario 的连接列表清空后，会同步移除空 key；`LOG_LEVEL = DEBUG` 时，broadcast 还会记录 `stream/type/seq/event_id/client count` 便于排查)
    │
main.py ──► 汇总挂载 scenarios / interventions / social / campaign / predictions / ws routers + `GET /` 根信息端点；`GET /metrics` 在依赖齐全时暴露完整 Prometheus 指标，缺依赖时回退为最小文本指标；进程日志当前默认走结构化 JSON，`uvicorn / uvicorn.error / uvicorn.access` 也统一复用同一套 root formatter
    │
models/database.py ──► SQLModel (Scenario, Agent, Branch, Round, Message, InterventionLog, PendingIntervention, ReplayArtifact；`Scenario` 当前额外带 `director_state_json / gameplay_state_json`，这些 JSON 字段现在走 `MutableDict.as_mutable(JSON)`，就地修改也能被持久化；hot-path 外键已补索引；`AgentGroup.scenario_id` 现在也有索引与轻量迁移兜底；`get_engine / dispose_engine` 当前也已补上进程内锁，避免首次并发初始化撞出多个 engine；`init_db()` 的 SQLite best-effort migration 现也复用 engine-managed 连接，不再额外绕开 SQLAlchemy 连接管理)
models/agent_group.py ──► AgentGroup, AgentGroupMember (P3-A；`scenario_id` 已加索引)
models/campaign.py ──► DirectorProfile, ProfileMastery, DirectorBadgeUnlock, ScenarioCampaignLog
models/debate.py ──► Debate, DebateTurn, DebatePrediction, DebateCounterplay
models/predictions.py ──► Prediction, Leaderboard (P3-B)
services/runtime_lock.py ──► SQLite 共享运行锁（simulation / debate 跨 worker lease）
config.py ──► pydantic-settings (Settings singleton；默认 `.env` / SQLite / Chroma 路径都锚到 `backend/` 根目录；非本地 LLM 端点会拒绝占位 `LLM_API_KEY`，`LLM_MODEL_NAME` 不能为空；当前额外提供 `LOG_LEVEL / LOG_FORMAT`，默认 `INFO + json`)
alembic/ ──► Alembic 数据库迁移框架
```

## 服务层 (`app/services/`)

### `simulator.py` (≈870行) — 核心模拟引擎
- **职责**: 编排整个模拟流程（解析→生成agent→分轮辩论→分支/剪枝→叙事）
- **关键函数**:
  - `run_simulation(scenario_id, session)` — 主入口，根据 `mode` 条件初始化 `blackboards`；BYOK API Key 纯内存传递，不持久化
  - `_gather_agent_messages(..., blackboard)` — 读共享简报 + batch post
  - `_compress_round_memory(..., blackboard)` — 以上一份滚动态势简报 + 当前窗口原始消息做压缩，并更新黑板全局态势
  - `_check_fork_conditions()` — 分支检测逻辑
  - `_prune_branches()` — 概率低分支剪枝
  - `_get_recent_messages(engine, branch_id)` — LEFT JOIN 单查询取消息+agent名（P0-2 N+1修复）
  - `_get_messages_in_range(engine, branch_id, start, end)` — LEFT JOIN 范围查询（P0-2 N+1修复）
- **模式**: `blackboard`（默认，每分支一个 Blackboard，fork深拷贝）| `raw`（跳过 Blackboard，Agent 直接读 DB）
- **分层模式** (P3-A): `_gather_hierarchical_messages()` — Leader 代表推演 + Worker 响应合成，千人规模时 LLM 调用量降低 90%+；Worker 合成消息也广播 `viz:bubble_show` 可视化事件
- **Leader 缺失回退**: 分层模式若 group 配置的 leader 不在当前 agent 集合中，当前会回退到该组第一个可用成员作为 effective leader，并记录 warning；不会再让整组 Worker 退化成“保持沉默”
- **Agent JSON 容错**: `_gather_agent_messages()` 现在会通过 `llm_call_json(..., fallback_mode="agent_message")` 恢复轻微损坏的 agent JSON；如果模型至少吐出了 `content/emotion/diverge` 这样的键或纯文本，不会直接让该 agent 丢一整轮发言
- **结局类型 3 级映射**: `ending_type` 按概率分 3 档: `< 0.3` → "negative", `0.3-0.5` → "neutral", `> 0.5` → "positive"
- **Theater 结局选择**: branch-only 补跑优先当前 `branch_id`；只有没指定分支或找不到目标分支时，才回退到概率最高的已叙事分支
- **可视化 stance 归一化**: `_coerce_stance_value()` 将数值 stance 与中英文立场词（如 `支持/反对/neutral/support`）统一映射到 `[-1, 1]`，避免 Theater 定位阶段因文本 stance 触发类型错误
- **占位根分支复用**: `_get_or_create_root_branch()` 会复用 `POST /api/scenario` 阶段创建的 provisional root branch，避免启动期前端世界线骨架与模拟期真实根分支重复
- **viz_push 辅助函数**: 统一所有 viz 广播调用，含 `viz_mapper is not None` 安全守卫
- **Fork 抑制**: 最后一轮不 fork，保证所有叶子分支都有 Agent 发言
- **分支归一化**: fork 后自动归一化子分支概率使总和为 1.0；若活跃分支概率和意外掉到 `<= 0`，当前会退回均匀分布并记 warning，避免后续剪枝/叙事继续吃坏概率；使用单数据库会话优化 (P2-8)
- **批量删除**: `delete_scenario` 使用批量 SQL DELETE（P2-7）
- **状态收口**: 进入 narration 前会先持久化 `ScenarioStatus.NARRATING` 再广播 `status=narrating`；后续读场景响应时，helpers 会把卡在 `SIMULATING / NARRATING` 且所有分支都已终局的 scenario reconcile 到 `DONE`
- **并发**: `_gather_agent_messages()` 当前按 `get_runtime_parallelism_limit()` 创建局部 semaphore，不直接硬读 `LLM_CONCURRENCY`；有请求级 quota 时会自动收口到安全 fan-out 上限
- **语言感知**: 全链路透传 `detected_language` 参数给 memory、narrator、fork 检测、round 压缩，确保输出语言匹配用户输入；`setting` 标签与 fork-detect prompt 当前都已按语言切换，不再让英文场景吃中文主体提示
- **数据完整性**: LEFT JOIN 保证已删除 Agent 的消息仍可读取（显示 "Unknown"），不会静默丢失
- **消息落库**: 普通 agent 发言与 synthesized Worker 发言当前都改成按批次写入 `AgentMessage`，不再每条消息单独 commit；`_save_message()` 仍保留给旧调用点和测试使用
- **压缩链路**: `_compress_round_memory()` 当前会读取更早一轮的 `compressed_summary` 作为 `previous_briefing`，和当前窗口 raw messages 一起滚动压缩，而不是每次只看孤立窗口；新的 round summary 已统一按 JSON 持久化，同时保留对旧 `str(dict)` 历史数据的兼容回退读取
- **干预队列**: API 层与模拟主循环当前都统一走 helper；当多个 worker 共用同一个 SQLite 文件时，待注入干预会先落到 `PendingIntervention` 共享队列表，再由模拟主循环按分支 FIFO 原子取出；scenario 结束或删除时也会一并清理残留队列

### `blackboard.py` (≈110行) — 共享空间 (**NEW**)
- **职责**: 中央共享黑板，所有 Agent 共读同一份信息
- **关键API**:
  - `post(agent, content, emotion, diverge)` — Agent 写入
  - `get_shared_briefing(max_entries)` — 生成共享简报 dict
  - `update_global_summary(compressed)` — 从压缩输出摄入结构化数据
  - `fork()` → `Blackboard` — 深拷贝，分支独立
  - `set_agent_group(agent_id, group_name)` — 注册 Agent 分组 (P3-A)
  - `get_group_briefing(group_name, max_entries)` — 组内专属简报 (P3-A)
  - `get_leaders_only_briefing(max_entries)` — Leader 跨组摘要 (P3-A)
- **滑动窗口**: activity_log 默认 max 20 entries

### `memory.py` (≈230行) — 记忆管理
- **职责**: L0上下文构建 + 结构化压缩 + 分层上下文 + 黑板格式化
- **关键函数**:
  - `compress_rounds(messages_text, previous_briefing?)` → `dict` (态势简报)
  - `_validate_compress_result(raw)` — 防御性LLM输出校验
  - `format_messages_for_context(messages, max_recent, tier)` — 按tier差异化消息数量
  - `format_briefing_for_context(briefing)` — 黑板 dict → 中文结构化文本
  - `build_agent_context(..., tier, shared_briefing)` — Blackboard模式替换 messages+memories
  - `_build_crowd_context(...)` — CROWD精简prompt (~800 tokens)
- **Tier映射**: `_TIER_MAX_RECENT` = CORE→8, IMPORTANT→5, CROWD→3
- **输出格式**: `{situation, active_debates, key_quotes, tension_points, consensus}`
- **干预 / 玩法卡注入**:
  - `intervention_text` 当前会在 agent prompt 里被明确描述成“高优先级、持续生效的世界线事件”，要求先回应、再在后续轮次持续体现影响
  - 玩法卡当前不是从 `gameplay_state` 直接反向注入 prompt；前端 `GameplayCardsModal` 会先把 card prompt 作为 `/intervene` 文本发给后端，再把 `usage_log` 同步进 `gameplay_state`
- **滚动压缩**: `compress_rounds()` 当前会把上一份结构化 briefing 和当前窗口原始消息合并成新的态势简报；旧 briefing 只保留关键局势/争点/原话/紧张点/共识，不再无限膨胀
- **摘要边界**: `situation / consensus` 与各 list 字段当前都有条目数和字符上限，避免滚动摘要反过来把压缩 prompt 撑爆
- **输入防护与兜底**: `compress_rounds()` 当前会把“当前窗口原始对话”包进 `UNTRUSTED DATA` 区块；若压缩超时、LLM 报错或返回坏 payload，会回退到上一份 briefing（没有旧 briefing 时回默认空摘要），不再把整局场景直接打进 error
- **Prompt 注入边界**: `build_agent_context()` / `_build_crowd_context()` 当前也会把 `shared_briefing / recent_messages` 统一包成 `UNTRUSTED DATA`，不再把共享简报或最近对话裸拼进 agent prompt
- **BYOK 透传**: `compress_rounds()` 当前也接受 `api_key / base_url / model` 覆盖；`simulator.py` 会沿现有 `llm_overrides` 纯内存透传给压缩链路，不会把凭证写回场景记录
- **L2向量记忆**:
  - `store_memory(scenario_id, agent_name, content)` — 写入 ChromaDB（fire-and-forget）
  - `retrieve_relevant_memories(scenario_id, query, top_k)` → 格式化 Top-K 语义相关记忆

### `vector_store.py` (≈170行) — ChromaDB 向量存储 (**NEW**)
- **职责**: L2 层语义记忆检索，跨 session 记忆存储与检索
- **关键API**:
  - `VectorStore.store(scenario_id, agent_name, content, ...)` — 存入 ChromaDB
  - `VectorStore.retrieve(scenario_id, query_text, top_k)` → `list[dict]` — 余弦相似度检索
  - `VectorStore.delete_collection(scenario_id)` — 按 canonical collection name 删除单个 scenario 的 collection
  - `VectorStore.health_check()` — 连通性检查
- **设计**:
  - collection name 当前统一走 canonical naming：`scenario_{scenario_id.replace('-', '_')}`；创建、读取和删除共用同一套命名规则
  - `_collections` 当前是有上限的 LRU 缓存（默认 128），避免长期运行时无界持有 collection 引用
  - `PersistentClient` 初始化当前有超时上限；超时后会先返回 `unavailable`，避免主线程一直卡住；如果后台初始化稍后完成，同一个 `VectorStore` 实例会在后续访问时接管这份 client
  - 模块级单例当前会区分“ready”与“仍在后台初始化”：`_store_ready()` 只代表已经可立即使用，`get_vector_store()` 在 init pending 时仍会复用同一个实例，避免并发请求重复拉起多个 Chroma init 线程
  - 模块级单例当前不会把“初始化失败/超时后仍不可用”的实例永久缓存住；若初始化最终失败，后续 `get_vector_store()` 仍会重试
  - 如果 Chroma 在运行期才出错，当前会优先按场景隔离：`collection lookup / store / query` 这类单场景故障只会清掉对应 scenario 的 cache，不会顺手把整个共享 client 置空；`health_check` / 初始化这类更广义故障仍会失效本地 `client + collection cache`
  - 写入与删 collection 当前都会先拿进程内锁，再尝试拿 SQLite shared runtime lock；shared lock key 现已按 `scenario_id` 分片，不同 scenario 的 Chroma 写入不再被全局单 key 串成一条队列
  - 全局单例初始化当前也已补进程内锁，避免并发首次访问时创建出多个 `VectorStore` 实例
  - ChromaDB 不可用时静默降级

### `runtime_lock.py` (≈150行) — SQLite 共享运行锁 (**NEW**)
- **职责**: 为 simulation / debate 后台任务提供 crash-safe、跨 worker 的共享 lease
- **关键API**:
  - `acquire_runtime_lock(lock_key, lease_seconds)` → `RuntimeLockLease | None`
  - `release_runtime_lock(lease)` → `bool`
  - `simulation_lock_key(scenario_id)` / `debate_lock_key(debate_id)` — 构造运行锁 key
- **设计**:
  - 当 `DATABASE_URL` 指向同一个 SQLite 文件时，当前会通过单表 `runtime_lock` 共享运行锁状态
  - 获取新锁前会清理过期 lease；worker crash 后只要 lease 到期，后续 worker 仍可接管
  - `DATABASE_URL` 不是文件型 SQLite 时，当前会安全回退成进程内互斥 lease，而不是“永远成功”的空锁；这条 fast path 仍只保证单进程内防重入
  - 进程内 fallback 当前会在每次 `acquire` 前顺手清理过期 key，不再把已失效 lease 永远留在内存字典里
- **集成点**:
  - `api/helpers.py` 的 `run_sim_background()` 当前会在真正启动 simulation 前拿 `simulation:{scenario_id}` 锁
  - `services/debate.py` 的 `run_debate_background()` 当前会在广播 `LIVE` 前拿 `debate:{debate_id}` 锁

### `gameplay_contract.py` (≈15行) — shared gameplay contract 载入器 (**NEW**)
- **职责**: 从 `shared/gameplay_contract.v1.json` 读取后端与前端共用的玩法契约
- **关键API**:
  - `load_gameplay_contract()` → `dict[str, Any]` — 基于文件 `mtime_ns` 的轻量缓存；文件未变更时复用缓存，变更后自动重读
- **缓存保护**: contract cache 当前已补上进程内锁，避免多线程 / 多请求同时 miss cache 时重复读同一个文件
- **缺文件报错**: 若 `shared/gameplay_contract.v1.json` 缺失，当前会直接抛出清晰 `RuntimeError`，提示先恢复 shared contract，而不是让后端在 `Path.stat()` 上抛裸异常
- **集成点**: `visualization/card_events.py` 启动时据此构建 `CARD_TYPES`，后端测试 `test_gameplay_contract_sync.py` 会校验卡牌 ID 与触发模式和 shared contract 保持一致

### `llm_client.py` (≈270行) — LLM调用封装
- **职责**: httpx异步调用OpenAI兼容API
- **关键函数**:
  - `llm_call(prompt, reasoning_effort, api_key?, base_url?)` → `str`
  - `llm_call_json(prompt, reasoning_effort, api_key?, base_url?)` → `dict`
  - `llm_call_stream(...)` — SSE 流式异步生成器
  - `llm_call_json_stream(...)` — 流式 + JSON 解析
  - `health_check()` — 连通性检查
- **健康探测**: `POST /api/health/test` 先跑 `health_check()`；只有 LLM status=`ok` 时才会附带 `probe`，内容来自 `measure_provider_parallelism()` 的并发探测摘要
- **特性**: 支持 Chat Completions 和 Responses API 两种格式
- **指数退避重试** (P1-3): 对 429/5xx 错误自动重试 3 次，退避间隔 1s→2s→4s；当前实现直接复用模块级 `asyncio`，5xx 重试路径不会再触发本地 `UnboundLocalError`
- **HTTP client 生命周期**: `llm_call()` / `llm_call_stream()` 当前复用共享 `httpx.AsyncClient`，但这份 client 现在是按 event loop 归属隔离的：切到新 loop 时会重建 client，旧 client 走后台 best-effort 关闭；进程退出时仍由 `main.py` 的 shutdown/lifespan 统一关闭当前共享 client
- **JSON 容错**:
  - `_clean_json_text` 会先剥掉 markdown code fence、前后缀和非法控制字符
  - `llm_call_json()` 在常规 `json.loads()` 失败后，会依次尝试：
    - 正则抽取对象 / 数组
    - keyed fallback（恢复轻微损坏的 `story/content/emotion/diverge` 这类键值）
    - `agent_message` 专用 fallback（把带键的坏 JSON 或纯文本尽量恢复成单条 agent 发言）
  - `llm_call_json_stream()` 当前复用同一套恢复链，不再只做一次裸 `json.loads()`
- **全局治理**:
  - `LLM_CONCURRENCY <= 0` 现在表示关闭全局并发上限；启用时，进程内全局 semaphore 会统一限制 LLM 并发，不再只靠单局内部 `Semaphore`，且当前 semaphore 在进程生命周期内保持单实例，运行期修改 `LLM_CONCURRENCY` 只会记录 warning，不会热替换现有对象
  - `LLM_MAX_PENDING / LLM_USER_MAX_PENDING <= 0` 现在表示关闭对应 pending 上限；启用时会在请求入队前做 backpressure，当 `DATABASE_URL` 指向同一个 SQLite 文件时，会优先使用 SQLite reservation 表作为全局/用户级 pending 真值，不再和进程内 pending 计数双重叠加
  - `get_runtime_parallelism_limit()` 会按当前 request scope 把全局并发、全局 pending 和用户 pending 收口成单次本地 fan-out 的安全上限；都关闭时回退 `MAX_AGENTS`
  - SQLite runtime guard 当前会先用较短 DB timeout 试一次 reservation；若锁竞争或 SQLite 路径暂时不可用，外层会尽快打 warning 并退回进程内计数，不再长时间卡在 `BEGIN IMMEDIATE`
  - 同一 provider 连续失败会按 `LLM_CIRCUIT_BREAKER_THRESHOLD / RESET_SECONDS` 打开简易熔断；这部分和全局 semaphore 当前都仍是进程内状态
  - LLM pending reservation 和 `runtime_lock.py` 是两条不同的 SQLite 共享治理链路：前者管 LLM 配额，后者管 simulation / debate 后台任务防重入
  - `llm_call_stream()` 当前也支持连接阶段重试；只有在首个 content 产出前才会重试，避免重复发出部分流片段
- **输入防护**:
  - `sanitize_untrusted_text()` / `format_untrusted_text_block()` 会把用户题面、干预文本、评分输入等包成 `UNTRUSTED DATA`
  - 常见 prompt-injection 语句只会作为待分析数据进入 prompt，不再直接裸拼到系统指令附近
- **错误脱敏**: `_sanitize_error()` 当前除了 `Bearer ...`，还会掩码更通用的 key/token-like secret 片段，降低 BYOK/provider 错误回包把凭证打进日志的风险
- **BYOK (P4-E)**: 所有函数接受 `api_key`/`base_url`/`model` 可选覆盖，用户可自带 OpenAI 兼容 API Key；API Key 仅内存传递不持久化
- **Provider policy 贯通**: 当前 BYOK/provider policy 已接进 `createScenario / social copy / score-predictions / createDebate`，同一份 `user_id` 也会参与用户级 pending 配额
- **容器部署提示**: 如果后端在 Docker 容器内运行而 LLM 服务在宿主机本地，`LLM_RESPONSES_URL` 需要改为 `host.docker.internal` 或其他宿主可达地址；`POST /api/health` 会同步探测 LLM，因此容器健康检查现改用 `GET /`

### `parser.py` (≈200行) — 问题解析
- **职责**: 将用户问题解析为结构化场景上下文
- **输出**: `{era, setting, question, agents[], total_rounds, fork_sensitivity}`
- **启动策略**: 解析阶段固定使用 `reasoning_effort="low"`，优先缩短 Theater 首次可见世界线前的等待窗口
- **语言检测** (P9): 调用 `lang_detect.detect_language()` 检测输入语言，存入 `result["_language"]` 供下游服务使用
- **分层模式** (P3-A): `PARSE_PROMPT_HIERARCHICAL` 生成 `groups[]` 分组信息，含 fallback 自动分组逻辑
- **坏 JSON / 缺字段兜底**: 若 parse 阶段的 `llm_call_json()` 返回不可恢复坏 JSON，或返回了结构不完整的 payload（例如缺少 `agents` / `setting`），parser 当前都会退到确定性 fallback 结构，而不是直接让整条 `create scenario -> simulate` 链路中断；fallback 结果仍会按 `requested_agents` 补足最小角色集，并保留同样的 rounds / sensitivity 边界
- **人数补足**: 如果 parser 在重试后仍少吐角色，当前会继续用确定性 extras 把 agent 数补到 `requested_agents`，不再只在 `requested_agents <= 12` 时才补齐
- **fallback rounds**: fallback 轮数当前不再写死 `10`；会优先使用调用方给的默认轮数，再按 `max_rounds` 做 clamp
- **BYOK**: 接受 `api_key`/`base_url`/`model` 覆盖并透传到 `llm_call_json`

### `logging_utils.py` (≈90行) — 结构化日志配置 (**NEW**)
- **职责**: 统一 backend 运行时日志格式，不改各模块现有 `logger.info/warning/error` 调用方式
- **关键API**:
  - `JsonLogFormatter` — 把标准日志字段、异常、extra 字段统一序列化为 JSON
  - `configure_logging(level_name, log_format)` — 按配置初始化 root logger，并收口 `uvicorn / uvicorn.error / uvicorn.access`
- **当前口径**:
  - 默认 `LOG_FORMAT = json`
  - 默认 `LOG_LEVEL = INFO`
  - 如果切回 `LOG_FORMAT = plain`，仍使用原来的人类可读格式

### `lang_detect.py` (≈70行) — 语言检测 (P9 **NEW**)
- **职责**: 基于字符比例启发式检测用户输入语言，生成 LLM prompt 语言指令
- **关键函数**:
  - `detect_language(text)` → `str` — 返回 "Chinese"/"English"/"Japanese"/"Korean"，字符比例启发式，无外部依赖
  - `get_language_directive(language)` → `str` — 生成 prompt 注入的多语言指令文本
  - `get_anonymous_director_name(language)` / `get_anonymous_predictor_name(language)` — 生成 language-aware 的匿名显示名
- **覆盖范围**: CJK 统一表意文字、日文假名（平假名+片假名）、韩文谚文
- **日语提示**: 当前还会额外检查常见日语助词/敬体词（如 `の / は / が / を / です / ます`），降低纯汉字占比较高的短日文被误判成 Chinese 的概率
- **防护**: 空输入默认 English；不计入全角Latin/数字避免误判
- **集成点**: `parser.py` (检测)、`simulator.py`/`memory.py`/`narrator.py`/`scoring.py` (指令注入)

### Visualization 模块 (`app/visualization/`) — Phase 1+2 像素化可视化层
- **职责**: 将模拟事件映射为前端 Phaser.js 场景指令，实现像素风可视化
- **模块组成**:
  - `events.py` (≈60行) — `VizEventType` 枚举 (9 种事件类型，含 `WEATHER_CHANGE`) + `make_viz_event()` 工厂函数
  - `mapper.py` (≈300行) — `VisualizationMapper` 类，8 个 `map_*` 方法（agent_speak、stance_move、branch_split、intervention、emotion_change、scene_change、ending、**weather_change**）；stance 参数统一 clamp [-1, 1]
  - `persona_mapper.py` (≈130行) — `assign_sprite()`/`assign_sprites_batch()`/`assign_position()` — 角色→精灵分配 + 坐标计算；本轮又补齐 `alchemist / assassin / bard / knight / monk / thief / witch` 7 张 sprite 的 persona/role 映射，并把 `general / scientist / monk` 等口径与前端拉齐；total_agents ≤ 0 守卫 + stance clamp [-1, 1]
  - `scene_selector.py` — `select_scene(question)` / `select_scene(era=, setting=)` 双签名；当前已扩到 30 个语义场景主题，优先扫描原始 `question`，再回退到 parser 的 `era/setting`，避免泛化词压过更贴题的场景语义；generic / law / faith 已补进 `switchboard_forum_variant / law_court_variant / faith_temple_variant`
  - `card_events.py` (≈120行) — `check_card_trigger()`/`get_card_viz_event()` — 卡牌事件触发 + 冷却 + 加权随机（单候选安全回退）
- **集成点**: `simulator.py` (调用 `assign_sprites_batch`/`assign_position`) → WebSocket (`viz:*` 事件) → 前端 `EventBridge.ts` → Phaser `WorldScene.ts`
- **测试覆盖**: `test_simulator_viz_integration.py` 覆盖 scene reachability、ending type 3级映射、Worker viz 事件和全流程 smoke

### `narrator.py` (≈50行) — 叙事生成
- **职责**: 为已完成的分支生成故事总结和洞察
- **输出**: `{title, story, insight, key_moments[]}`
- **返回值归一化**: narrator 现在会容忍 `llm_call_json()` 返回 `list[dict]` 或字符串列表，优先提取第一条可用叙事，避免再因 `list` 没有 `.get()` 把整局场景打进 `error`
- **fallback 语言**: 当 LLM 不可用时，fallback narration 当前会跟随 `language` 输出中英文摘要，而不是固定中文兜底
- **输入防护**: `branch_title / agents_summary / raw_rounds` 当前都会通过 `format_untrusted_text_block()` 包进 `UNTRUSTED DATA` 区块，再进入 narration prompt；可疑 prompt-injection 文本只会被当成待分析数据
- **BYOK 透传**: narrator 当前也接受 `api_key / base_url / model` 覆盖；`simulator.py` 会沿现有 `llm_overrides` 纯内存透传，不把 BYOK 凭证落库

### `campaign.py` (≈330行) — Campaign 进度服务 (**NEW**)
- **职责**: 管理导演 campaign 进度结算、档案积分、题材 mastery 与 badge 解锁，以及单局 `director_state / gameplay_state` 权威态
- **关键函数**:
  - `finalize_scenario_campaign(...)` — 对已完成 scenario 做一次性结算；同一 scenario 对同一导演幂等，若绑定到不同导演则抛 `CampaignConflictError`
  - `remove_scenario_campaign_artifacts(session, scenario)` — 在 scenario 删除时回滚这局留下的 campaign 副作用：删 `ScenarioCampaignLog`、解除 badge 的 `source_scenario_id`，并重算 `DirectorProfile / ProfileMastery`
  - `calculate_campaign_score_delta(...)` — 按 archive grade / profile resonance / bet / daily challenge 规则计算积分增量
  - `get_scenario_director_state(scenario_id)` — 读取单局 goals / commitment 权威态
  - `save_scenario_director_state(scenario_id, director_state)` — 写入单局 goals / commitment 权威态；当前要求 `revision` 匹配，stale 写入会抛 `CampaignConflictError`
  - `get_scenario_gameplay_state(scenario_id)` — 读取单局玩法层权威态
  - `save_scenario_gameplay_state(scenario_id, gameplay_state)` — 写入单局玩法层权威态；当前要求 `revision` 匹配，stale 写入会抛 `CampaignConflictError`
  - `normalize_scenario_gameplay_state(payload)` — 规范化 `cards.usage_log / betting.bets / archive.key_moments / archive.branch_snapshots`
  - `get_scenario_campaign_summary(scenario_id)` — 读取单局已落库的 campaign 摘要；供 `ResultView` 在本地档案缺失时回填关键字段
  - `get_campaign_profile_summary(user_id)` — 读取导演总览
  - `list_campaign_mastery_summaries(user_id)` — 按 `campaign_score` 列出题材 mastery
  - `list_campaign_badge_summaries(user_id)` — 列出已解锁 badge
  - `get_daily_challenge_summary(user_id, profile_id, local_date, timezone_offset_minutes)` — 返回指定题材在调用方本地日期上的 daily challenge 完成态
  - `get_weekly_campaign_summary(user_id, local_date, timezone_offset_minutes)` — 返回调用方本地周窗口内的轻量周汇总
- **数据写入**: 会更新 `DirectorProfile`、`ProfileMastery`，并写入不可变的 `ScenarioCampaignLog`
- **档案摘要**: profile summary 现会带 `last_daily_challenge_completed_at / profile_id / scenario_id`，供首页把后端真值与本地缓存合并显示
- **单局摘要**: scenario summary 会返回 `profile_id / archive_grade / profile_resonance / betting_hit / most_used_card / completed_daily_challenge / campaign_score_delta / finalized_at`
- **周汇总**: `weekly-summary` 当前不改 schema，直接按 `ScenarioCampaignLog.created_at` + 调用方本地时区聚合 `total_runs / completed_daily_challenges / hit_bets / campaign_score_delta / best_archive_grade / top_profile_id / profile_runs`
- **查询下推**: `daily-status` / `weekly-summary` 当前会先把调用方本地日期窗口换算成 UTC `[start, end)`，再把 `created_at >= ... AND created_at < ...` 下推到 SQL；`ScenarioCampaignLog` 也已补上 daily/weekly lookup 复合索引
- **director state**:
  - goals / commitment 当前落在 `Scenario.director_state_json`
  - live/result 前端会优先读取这一份
  - 当前还会带 `revision`，用于乐观并发控制；stale PUT 会返回 `409`
- **gameplay state**:
  - 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 当前都落在 `Scenario.gameplay_state_json`
  - 前端会基于远端 `usage_log` 重算导演点数、卡牌冷却、`most_used_card`、`counterplay_card_count` 与 `last_counterplay_card`
  - 当前还会带 `revision`，用于乐观并发控制；stale PUT 会返回 `409`
  - 这次只是扩现有 JSON 列契约，没有新增 DB column，也没有新增 Alembic migration
- **时区归一**: `daily-status` 查询现在会把 SQLite round-trip 回来的 naive UTC 时间先按 UTC 归一，再换算调用方本地日期，避免跨时区同日完成态误判
- **时间序列化**: `profile / mastery / badges / daily-status` 响应里的时间字段统一输出带 `+00:00` 的 UTC ISO 字符串
- **空导演容错**: `profile / mastery / badges / daily-status` 读接口现在会给新设备返回空摘要或 `completed=false`，避免首页首次加载就打 404 噪声
- **默认名策略**: finalize 时若 `user_name` 为空，当前会按 scenario 语言回退到匿名导演显示名，而不是固定中文
- **徽章解锁**: `badge` 当前通过 SQLite `on_conflict_do_nothing` 风格的幂等写入保证唯一性；重复命中不会再靠“先查后插”判断
- **防护**: 只接受 `ScenarioStatus.DONE` 的场景；对并发 finalize 通过 `IntegrityError` 回退到已存在日志，保持幂等返回

### `daily_challenges.py` (≈190行) — 每日/每周挑战轮换服务 (**NEW**)
- **职责**: 提供首页 today / weekly challenge 的定义与轮换口径，不再让前端自己维护静态 challenge catalog
- **关键函数**:
  - `challenge_week_key(local_date)` — 计算调用方本地周窗口 key
  - `get_today_challenge_definition(local_date)` — 返回某个本地日期对应的 today challenge 定义
  - `get_weekly_challenge_definitions(local_date, count)` — 返回本地周窗口下的 featured profiles / challenge 列表
  - `get_challenge_rotation(local_date, weekly_count)` — 汇总 today + weekly challenge rotation payload
- **当前口径**:
  - challenge 定义源头现在在 backend；首页只负责消费 rotation API，不再自己轮换 12 条静态 challenge 题库
  - `daily-status / weekly-summary` 继续负责 campaign 真值，`challenge rotation` 则负责题目定义和 weekly featured profiles
  - challenge catalog 目前仍是后端内置数据，不依赖数据库；改 challenge 文案、轮换口径时只需要改 backend 这一处

### `debate.py` / `debate_prompts.py` / `debate_scoring.py` — Debate Arena 领域服务 (**NEW**)
- **职责**:
  - `debate.py`：独立 Debate Arena 运行、turn 落库、LLM 回合生成、结构化 judge analysis、`LLM hybrid` verdict 结算、prediction 评分、counterplay 显式 payload
  - `debate_prompts.py`：deterministic motion / cast / 语义锚点文案与 LLM turn prompt builder
  - `debate_scoring.py`：winner / verdict tone / breakdown / phase delta 规划
- **关键行为**:
  - Debate 不复用通用 `scenario` 链路，而是独立走 `Debate / DebateTurn / DebatePrediction / DebateCounterplay`
  - 当前固定 5 个阶段：`opening / crossfire / rebuttal / closing / verdict`
  - prediction 只支持 `winner` 与 `verdict_tone`
  - 若整场没有合适的 winner / rebuttal turn，`best_argument / best_rebuttal` 当前会回退到可读文案，而不是空字符串
  - `counterplay` 当前已提升成 Debate 域内的显式记录：提交时会同时写 `DebatePrediction + DebateCounterplay`，live snapshot / result payload / WS 会优先读独立 `DebateCounterplay`，仅在缺失时回退到旧的 prediction metadata
  - 当前终局裁决已升级为 `LLM hybrid`：后端会优先读取 judge analysis 里的 `adjudication` scorecard，与 deterministic plan 混合后生成最终 `winner / verdict_tone / breakdown`；结果 payload 当前会显式带 `adjudication_mode`，若 LLM 不可用或输出无效则退回 deterministic fallback
  - `debate_prompts.py` 现在不再只是换 profile 标签：`law / governance / trade / faith / ecology / war` 都有各自 deterministic 语义锚点，同时会生成更强的 LLM prompt，要求回应上一轮、避免套话，并压缩长句、保留更像现场回击的节奏
  - `debate_scoring.py` 会按题材做轻量维度偏置；`war / ecology` 在高风险题面更容易收敛到 `rupture`
  - `_serialize_debate()` 当前支持复用外层已算好的 deterministic `plan`，不会在 live/result 序列化时无意义重复构建
  - `_question_signal` 的 deterministic 关键词覆盖这轮又补了 `innovation / growth / breakthrough / sanction / deadlock / unrest / coup` 等中英文信号词，仍保持 deterministic 评分路线
  - Track D 的 `profile -> scene_theme` 已改为 Debate 专属背景：`debate_arena_civic / debate_arena_judicial / debate_arena_forum`
  - `counterplay` 现在除了 `outcome`，还会返回 `phase_score / explanation`，并被织进 `judge summary` 与 replay digest
  - live snapshot / result payload 顶层当前还会返回 `phase_insights[]`，每个阶段都有 `stakes / judge_focus / commentary / pressure_margin / confidence_drift`
  - `counterplay` 当前不只影响顶层摘要；若某阶段命中了对冲，后端会把这条信息直接织进对应阶段的 `phase_insights.commentary`
  - replay import 当前会把输入 payload 里的 `phase_insights` 一并持久化；后续 live/result 读路径会优先回放这份已导入的阶段洞察，而不是只靠重算
  - replay import 当前还会校验 `winner / verdict_tone / turns[*].sequence / phase_insights` 的关键字段；坏快照会直接返回 `422`，同时 turn 会按 `sequence` 排序后再落库
  - `debate_verdict` WS 事件当前会发送 `DebateResultSummary + phase_insights`，这样前端 live 页在 verdict 到来时就能直接看到完整阶段洞察
  - 如果 debate background runner 失败，当前发给前端的 `status=error` 事件也已统一成结构化 `error = {code, message}`；详细异常仍只留在后端日志，不再把原始 `str(exc)` 直接透给前端
  - Debate 结果 payload 当前还会返回结构化 `judge_rationale`（`winner_reason / loser_gap / swing_factor / closing_note / dimension_rationales`）以及 `supporting_turns`
  - Debate 结果会自动给已提交的 prediction 打分，不要求另开批量评分接口
  - `POST /api/debate/{id}/predict` 当前会先持久化 `DebatePrediction / DebateCounterplay`，再 best-effort 广播 `debate_counterplay`；若 WebSocket 广播失败，只会记 warning，不会把已落库请求翻成假 `500`
  - `run_debate_background()` 当前会在广播 `LIVE` 前先拿 SQLite shared runtime lock；同一 `debate_id` 若已被另一 worker 持锁，会直接返回，不会重复推进回合
  - 除了 shared runtime lock，进程内 `_running_debates` 当前也有 thread lock 原子保护；同一进程里若未来出现线程/回调并发进入，也不会在 check-add 之间重复起同一场 debate

### `scoring.py` (≈200行) — 预测评分 (P3-B **NEW**)
- **职责**: LLM 对比用户预测与模拟实际结果，给出 0-100 准确度评分
- **关键函数**:
  - `score_prediction(prediction_id)` — 评估单条预测，自动读取场景 `_language` 匹配输出语言
  - `score_all_for_scenario(scenario_id)` — 批量评分场景所有未评预测
  - `_update_leaderboard(session, user_id, user_name, score)` — 按已评分 `Prediction` 真值全量重算单个排行榜行，不再继续信任旧聚合值
  - `recompute_leaderboard_entry(session, user_id, user_name)` — 在删 scenario / 删 prediction 后按剩余已评分预测重建单个排行榜行
- **排行榜物化**:
  - `total_predictions / total_score / avg_score / best_score / win_streak` 当前都按已评分 `Prediction` 真值重算；即使 `Leaderboard` 行先前是 stale 值，也会在下一次更新时被纠正
  - `entry.user_name` 当前始终使用本次请求传入的显示名，不再回跳到历史 prediction 上的旧名字
- **原子持久化**:
  - `score_prediction()` 当前会先用单条 `UPDATE ... WHERE score IS NULL` 原子 claim 未评分 prediction，再落 leaderboard 事务
  - 若并发 scorer 已经先写入，该请求会回读已有分数返回，不再重复覆盖
  - 若 LLM 返回后发现原场景已被删除，该次写入会直接回滚，不再把孤儿 prediction 落分
  - 若 leaderboard 更新失败，会整笔回滚，不再留下“prediction 已评分但 leaderboard 未更新”的半提交状态
  - `score_all_for_scenario()` 当前返回值已细化为 `attempted / scored / failed / all_failed / results`，可以区分“没有待评分 prediction”和“全部评分失败”
- **语言感知 prompt**: 评分 prompt 当前已拆成中英模板；英文场景会使用英文标题、标签与 rubric，不再只靠中文主体 + language directive 混合驱动

## API层 (`app/api/`) — P0-1 拆分

> **重构 (P0-1)**: 原 `scenarios.py` (≈600行) 拆分为 5 个模块：
> - `scenarios.py` — 核心 CRUD 路由
> - `schemas.py` — Pydantic 请求/响应模型
> - `helpers.py` — 后台任务管理、工具函数 (`_background_tasks` set)
> - `interventions.py` — 干预路由（标准/回溯/批量）
> - `social.py` — 社交媒体文案路由 (P6)
>
> **错误返回口径**：这批 REST 路由当前都统一走结构化 `HTTPException.detail = {code, message}`。已经覆盖 `campaign / interventions / predictions / social / scenarios / debate`，前端现在按 `status / code / message` 消费，不再把自由文本错误字符串当协议。
>
> **helpers 运行口径**：`api/helpers.py` 里的 fire-and-forget background task 当前会在 done callback 中主动记录未捕获异常，不再静默吞掉；simulation 失败时发给前端的 `simulation_error` 事件，也已经升级成结构化 `error = {code, message}`。
>
> **response 口径**：`load_scenario_response()` 读场景前会先 reconcile stale `simulating/narrating -> done`；当前顶层响应额外带 `fork_debug`，`messages[]` 会带 `diverge / branch_title`，`branches[]` 会带 `fork_round`。

### `scenarios.py` — 核心 REST 路由
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /scenario` | POST | 创建场景（含 `num_agents`, `mode`, `visualization_enabled`, `disable_user_quota` 参数），立即返回 `simulating` 占位场景；若启用 Theater，会同步返回 `scene_theme` 与一条 provisional root branch，后台继续 parse + simulate；`disable_user_quota` 只在本地/self-hosted provider 下才会真正关闭用户级 quota |
| `GET /scenario/{id}` | GET | 获取场景详情；读之前会先 reconcile 卡在 `simulating / narrating` 但其实已终局的 scenario 到 `done`；响应包含 `visualization_enabled`、`scene_theme`、顶层 `director_state / gameplay_state / fork_debug`，以及 `messages[]` 里的 `diverge / branch_title`、`branches[]` 里的 `fork_round`，供前端恢复 Theater 状态和分叉上下文 |
| `POST /scenario/import-replay` | POST | 把 replay 快照导入为真实本地 scenario；当前给 `/result/replay` 与 `/sim/replay` 的“导入为本地运行”按钮使用；请求体会先做 payload bytes、`question` 长度，以及 `groups / agents / branches / messages` 数量上限校验 |
| `GET /scenario/{id}/branches` | GET | 获取分支列表 |
| `GET /scenario/{id}/agents` | GET | 获取agent列表（含 group_id, group_name） |
| `GET /scenario/{id}/story` | GET | 获取叙事结果；若尚无 completed branches，会回退返回该场景现有 branches，并为根分支补 placeholder title |
| `GET /scenario/{id}/groups` | GET | 获取分层分组信息 (P3-A) |
| `GET /scenarios` | GET | 场景列表（分页+状态筛选，JOIN优化 P0-2）(P4-A) |
| `DELETE /scenario/{id}` | DELETE | 删除场景（批量 SQL DELETE P2-7 + Leaderboard + pending intervention queue + ChromaDB 清理）；若该局已经写入 campaign，也会同步回滚这局留下的 campaign side effects (P4-A) |
| `GET /scenario/{id}/export` | GET | 导出场景 Markdown (P4-C) |
| `POST /replay-artifact` | POST | 持久化 replay payload，返回短 `share id`；当前主模式优先用它生成 `/result/replay?share=...` 与 `/sim/replay?share=...` |
| `GET /replay-artifact/{id}` | GET | 读取 replay payload；供 replay 页面 hydrate |
| `GET /intervention-templates` | GET | 干预模板列表 (P4-D) |

> 补充：`POST /api/health/test` 会先做 `health_check()`；只有 LLM 连通时才会追加 `probe`，内容来自 `measure_provider_parallelism()` 的并发探测摘要。

### `interventions.py` — 干预路由
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /api/scenario/{id}/intervene` | POST | 注入蝴蝶效应干预（文本上限 2000 字符） |
| `POST /api/scenario/{id}/intervene/retrospective` | POST | 回溯干预（回到第N轮重新推演） |
| `POST /api/scenario/{id}/intervene/batch` | POST | 多点干预（同时注入多个分支；当前单次请求最多 50 条） |

> intervene / retrospective / batch 这三条路由当前仍不改变 REST 形状，但待注入文本已经改成共享 pending queue；当多个 worker 共用同一个 SQLite 文件时，请求落在哪个 worker、模拟跑在哪个 worker，不再影响干预是否能被真正消费。
>
> `batch` 当前在 SQLite pending queue 路径下会把 `InterventionLog` 和 `PendingIntervention` 放进同一个事务提交；若前置校验失败，不会留下半写入的 queue/log 残留。

### `social.py` — 社交媒体文案路由 (P6)
| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /api/scenario/{id}/social/{platform}` / `POST /api/scenario/{id}/social/{platform}` | GET / POST | 生成社交媒体文案；provider overrides 当前只能走 `POST body`，不能放在 `GET query`；当前 wrapper / instruction 会跟随场景语言，英文场景不再收到中文包装文案 |

> social 路由当前也已纳入结构化错误口径；像 `LLM temporarily unavailable / generation failed` 这类失败，仍保留原 message 含义，但现在会通过 `{code, message}` 对外返回，而不是混用自由文本 detail。

### `campaign.py` — Campaign 路由 (Track A / Phase A1 **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `GET /api/campaign/scenario/{scenario_id}/summary` | GET | 读取单局 campaign 摘要；若该 scenario 尚未 finalize，则返回 `404` |
| `GET /api/campaign/scenario/{scenario_id}/director-state` | GET | 读取单局 goals / commitment 权威态；若该 scenario 已存在但尚未写入，会返回安全默认值；响应当前还会带 `revision` |
| `PUT /api/campaign/scenario/{scenario_id}/director-state` | PUT | 写入单局 goals / commitment 权威态；当前只覆盖这批导演层状态，不负责主模式 `cards.usageLog` 之外的玩法状态；若 `revision` 过期则返回 `409` |
| `GET /api/campaign/scenario/{scenario_id}/gameplay-state` | GET | 读取单局玩法层权威态；当前已包含主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots`，响应还会带 `revision` |
| `PUT /api/campaign/scenario/{scenario_id}/gameplay-state` | PUT | 写入单局玩法层权威态；当前用于主模式整套 gameplay raw state 的跨设备同步；若 `revision` 过期则返回 `409` |
| `GET /api/campaign/profile/{user_id}` | GET | 获取导演 campaign 总览 |
| `GET /api/campaign/profile/{user_id}/mastery` | GET | 获取该导演的题材 mastery 列表 |
| `GET /api/campaign/profile/{user_id}/badges` | GET | 获取已解锁 badge 列表 |
| `GET /api/campaign/challenges/rotation` | GET | 返回调用方本地日期下的 today challenge 与 weekly featured challenge 定义；供首页生成 daily / weekly challenge 卡片 |
| `GET /api/campaign/profile/{user_id}/daily-status` | GET | 获取某个题材在调用方本地日期上的 daily challenge 完成态；内部会先把 SQLite round-trip 的 naive UTC 时间按 UTC 归一后再做本地日期换算 |
| `GET /api/campaign/profile/{user_id}/weekly-summary` | GET | 获取调用方本地周窗口内的轻量周汇总；供首页的 weekly challenge / director growth Lite 展示 |
| `POST /api/campaign/scenario/{scenario_id}/finalize` | POST | 对已完成 scenario 做 campaign 结算，返回积分增量、profile、mastery 与 badge 结果 |

> 读接口边界已按当前代码更新：若导演档案尚不存在，`profile` 返回空摘要，`mastery / badges` 返回空数组，`daily-status` 返回 `completed = false`；首页不再因为新用户首次进入而打 404。`scenario/{id}/summary` 只在该局已有 campaign log 时返回结果，否则给 `404`。`scenario/{id}/director-state` 与 `scenario/{id}/gameplay-state` 只要场景存在就返回结果，未写入时会回安全默认值，且当前都会带 `revision = 0`。authority PUT 若带来的 `revision` 已过期，会返回 `409`，前端再回读最新 authority。`daily-status` 的 `completed_at` 当前返回 UTC ISO 字符串。`finalize` 若传空 `user_name`，会按场景语言落匿名导演名。`challenges/rotation` 当前只依赖 `local_date` 和可选 `weekly_count`；日期非法时返回 `400`，challenge 定义 payload 里会直接带 `question / question_en / subtitle_zh / subtitle_en / profile_id / rounds / num_agents / mode / visualization_enabled`。

**安全防护**:
- simulation / debate 当前都同时有进程内 fast path 和 SQLite shared runtime lock；当多个 worker 共用同一个 SQLite 文件时，同一 `scenario_id / debate_id` 不会被重复启动
- 总模拟超时 `MAX_ROUNDS × 180s`
- 删除校验当前只允许 `DONE / ERROR / PARSING` 场景通过；仍在 `SIMULATING / NARRATING` 的场景会拒绝删除

### `predictions.py` — 预测与排行榜路由 (P3-B **NEW**)
> 当前 `/api/scenario/{id}/predict`、`/predictions`、`/score-predictions` 与 `/api/leaderboard` 只由本模块持有；`scenarios.py` 内的旧实现已移除，不再存在 shadow route。

| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /api/scenario/{id}/predict` | POST | 提交预测（模拟完成前；当前 `confidence` 走 Pydantic 范围校验） |
| `GET /api/scenario/{id}/predictions` | GET | 列出场景所有预测；若 scenario 不存在则返回 `404` |
| `POST /api/scenario/{id}/score-predictions` | POST | 触发 LLM 评分；响应当前会显式带 `attempted / scored / failed / all_failed / results` |
| `GET /api/leaderboard` | GET | 全局预测排行榜；支持 `limit / offset` |
- **默认名策略**: 若 `predict` 请求里的 `user_name` 留空，当前会按 scenario 语言回退到匿名预测者显示名，而不是固定中文
- **提交窗口**: `POST /api/scenario/{id}/predict` 当前只在 `ScenarioStatus.PARSING / SIMULATING` 开放；进入 `NARRATING / DONE / ERROR` 后都会直接拒绝新预测
- **分页**:
  - `GET /api/scenario/{id}/predictions` 当前支持可选 `limit / offset`
  - `GET /api/leaderboard` 当前支持 `limit / offset`

### `debate.py` — Debate Arena 路由 (Track D **NEW**)
| 端点 | 方法 | 描述 |
|------|------|------|
| `POST /api/debate` | POST | 创建独立 Debate Arena；立即返回 live snapshot，并把后台阶段推进交给独立 debate worker；当前可选透传 `user_id / llm_* / reasoning_effort`，并会保留约 `5s` pre-roll 供前端进入 live 页并完成下注 |
| `GET /api/debate/{id}` | GET | 获取 debate live snapshot（participants / score / turns / prediction options）；当前顶层会显式带可选 `counterplay` 与 `phase_insights[]` |
| `GET /api/debate/{id}/result` | GET | 获取 verdict 完整结果（winner / breakdown / `judge_rationale` / replay digest / predictions）；当前顶层也会显式带 `counterplay`、`phase_insights[]` 与 `adjudication_mode`，结果页 automation 还会显式暴露 `supporting_turns`；未就绪时返回 `409`，`ERROR` 终态返回 `500` |
| `POST /api/debate/import-replay` | POST | 把 replay 快照导入为真实本地 Debate；当前给 `/debate/replay/result` 的“导入为本地运行”按钮使用，并会保留输入里的 `phase_insights` / `adjudication_mode` |
| `POST /api/debate/{id}/predict` | POST | 提交结构化押注（`winner` 或 `verdict_tone`）；当前只在 `DebateStatus.LIVE` 且阶段仍处于 `opening / crossfire / rebuttal` 时接受新押注；`QUEUED / ERROR / DONE / closing / verdict` 都会拒绝；当 `is_counterplay = true` 时，会同时写入 `DebatePrediction` 与独立 `DebateCounterplay` 记录 |

### `ws.py` — WebSocket路由
- `WS /ws/scenario/{scenario_id}` — 实时事件流
- **事件类型**: `heartbeat`, `status`, `agent_speak_start`, `agent_speak_delta`, `agent_speak`, `round_summary`, `branch_fork`, `branch_prune`, `narration`, `intervention_applied`, `intervention_injected`, `retrospective_start`, `batch_intervention_applied`, `simulation_done`, `simulation_error`
- `WS /ws/debate/{debate_id}` — Debate Arena 实时事件流
- **接入边界**: scenario / debate 两条 WS 当前都会先检查目标资源是否存在；不存在就直接拒绝接入。这里只收住“无效 id 也能监听”的问题，还不等于完整鉴权。
- **连接清理**: scenario / debate 两条 receive loop 当前都会在 `finally` 中执行 disconnect；除正常 `WebSocketDisconnect` 外，意外异常路径也不会把连接残留在 manager 列表里；空闲期还会发送应用层 `heartbeat`，让半断开连接在发送路径上更快暴露并清理
- **广播语义**: `broadcast()` 当前会先给所有非 `heartbeat` 出站事件统一补顶层 `meta = {stream_id, sequence, event_id, manager_instance_id, emitted_at}`，再把 payload 序列化一次并并行 `gather` 发给所有连接；单个慢连接不会再阻塞同一 scenario 的其它连接，但发送异常的 socket 仍会在广播后统一清理
- **调试口径**: `LOG_LEVEL = DEBUG` 时，`broadcast()` 当前还会为每条非 `heartbeat` 出站事件记录 `stream / type / seq / event_id / clients`；connect / disconnect / heartbeat 本身的行为不变
- **事件类型**:
  - `heartbeat`（客户端可忽略；主要用于 idle keepalive / dead socket cleanup）
  - `status`
  - `simulation_error`（当前 payload 已升级成 `error = {code, message}`，不再只给一段自由文本）
  - `agent_speak`
  - `debate_phase_change`
  - `debate_score_update`
  - `debate_counterplay`
  - `debate_verdict`（当前 payload = `DebateResultSummary + phase_insights`）
  - `status=error`（Debate 路径当前也走结构化 `error = {code, message}`）

## 模型层 (`app/models/`)

### SQLModel 实体
| 模型 | 主要字段 | 关系 |
|------|----------|------|
| `Scenario` | id, question, status, context_json | has_many: agents, branches |
| `Agent` | id, name, role, persona, tier, stance, emotion | belongs_to: scenario |
| `Branch` | id, parent_branch_id, title, description, probability, status | has_many: rounds; self-referential tree |
| `Round` | id, number, compressed_summary | has_many: messages |
| `Message` | id, content, emotion, diverge_score | belongs_to: round, agent |
| `InterventionLog` | id, branch_id, round_number, text | belongs_to: branch |
| `AgentGroup` | id, scenario_id, name, leader_agent_id, member_count | belongs_to: scenario (P3-A) |
| `AgentGroupMember` | id, group_id, agent_id, is_leader | belongs_to: group, agent (P3-A) |
| `DirectorProfile` | id, user_id, user_name, total_runs, completed_challenges, total_bets, hit_bets, highest_archive_grade | campaign 导演总档案 |
| `ProfileMastery` | id, director_profile_id, profile_id, runs, challenge_completions, signature_hits, aligned_hits, campaign_score, level | belongs_to: DirectorProfile |
| `DirectorBadgeUnlock` | id, director_profile_id, badge_id, unlocked_at, source_profile_id, source_scenario_id | belongs_to: DirectorProfile |
| `ScenarioCampaignLog` | id, scenario_id, director_profile_id, profile_id, archive_grade, profile_resonance, campaign_score_delta | 每局结算不可变日志 |
| `Debate` | id, question, motion, language, profile_id, scene_theme, status, current_phase, winner, verdict_tone | Debate Arena 主体 |
| `DebateTurn` | id, debate_id, sequence, phase, speaker_side, speaker_name, content, score_delta_json | belongs_to: Debate |
| `DebatePrediction` | id, debate_id, kind, target_value, confidence, score, is_counterplay, counterplay_phase, counterplay_variant | belongs_to: Debate |
| `DebateCounterplay` | id, debate_id, prediction_id, kind, target_value, confidence, phase, variant, outcome | belongs_to: Debate |
| `ReplayArtifact` | id, kind, payload_json, created_at | 短链接 replay payload 存储 |
| `Prediction` | id, scenario_id, user_id, prediction_text, confidence, score | belongs_to: scenario (P3-B) |
| `Leaderboard` | id, user_id, user_name, avg_score, best_score, win_streak | per-user materialized (P3-B) |

> 这轮又补了 hot-path 外键索引：`AgentMessage.round_id / agent_id`、`Round.branch_id`、`Agent.scenario_id`、`AgentGroup.scenario_id`、`Branch.scenario_id`、`InterventionLog.scenario_id / branch_id`、`Prediction.scenario_id`、`DebateTurn.debate_id`、`DebatePrediction.debate_id`、`DebateCounterplay.prediction_id`。对应 Alembic revision：`008_add_hot_path_foreign_key_indexes` 与 `011_add_agent_group_scenario_index`。
>
> 当前仓库内 `backend/swarmoracle.db` 的 `alembic_version` 仍是 `008_add_hot_path_foreign_key_indexes`；开发 / 测试启动路径会通过 `init_db()` 轻量补上 `AgentGroup.scenario_id` 索引，正式库升级仍应执行 `alembic upgrade head`。

## 测试覆盖

历史全量基线：**815 passed**

当前发布判断以后端 targeted `pytest` 与 `release:signoff` 为准：

- backend signoff set：**90 passed**
- `/metrics` live check：`200 text/plain`
- 详细命令与最新工件路径见 `llmdoc/guides/development.md`
- 本 session 还额外实跑了一组更宽的 backend 回归：**269 passed**
- 本 session 这轮“leaderboard 全量重算 / vector-store 场景级故障隔离 / debate 进程内防重入 / sqlite runtime guard 快速降级 / zero-sum 概率兜底”还额外实跑通过：
  - `python -m pytest tests/test_predictions.py tests/test_vector_store.py tests/test_debate_service.py tests/test_llm_client.py tests/test_simulator.py -q`：`161 passed in 25.52s`
  - `python -m ruff check --ignore E501 app/services/scoring.py app/services/vector_store.py app/services/debate.py app/services/llm_client.py app/services/simulator.py tests/test_predictions.py tests/test_vector_store.py tests/test_debate_service.py tests/test_llm_client.py tests/test_simulator.py`：通过
- 本 session 这轮“WS meta envelope + debug broadcast log”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_ws.py -q`：`28 passed in 1.17s`
  - `python -m ruff check --ignore E501 app/api/ws.py tests/test_ws.py`：通过
- 本轮这类“config 校验 / shared AsyncClient / stream retry / replay import 校验 / simulator batch message writes”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py -q`：`368 passed in 37.64s`
  - `python -m ruff check --ignore E501 app/config.py app/main.py app/api/debate.py app/services/llm_client.py app/services/simulator.py tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py`：通过
- 本轮这类“engine-managed SQLite 轻量迁移 / shared AsyncClient 跨 event loop 隔离 / stale client 后台关闭 / Chroma init 超时后接管与重试恢复”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_corner_cases.py -k init_db_reuses_engine_managed_connection_for_sqlite_migrations -q`：`1 passed, 33 deselected in 0.21s`
  - `python -m pytest tests/test_llm_client.py -k 'shared_async_client or event_loop_closed_runtime_error' -q`：`3 passed in 0.32s`
  - `python -m pytest tests/test_vector_store.py -q`：`27 passed in 3.63s`
  - `python -m pytest tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py -q`：`82 passed in 25.37s`
  - `python -m ruff check --ignore E501 app/models/database.py app/services/llm_client.py app/services/vector_store.py tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py`：通过
- 本轮这类 backend review fixes 还额外实跑通过：
  - `tests/test_predictions.py + tests/test_gameplay_contract_sync.py + tests/test_memory.py + tests/test_narrator.py`：`86 passed in 1.85s`
  - `tests/test_simulator.py -k 'passes_llm_overrides_into_compression or passes_llm_overrides_into_narration'`：`2 passed in 0.31s`
  - `tests/test_debate_api.py + tests/test_api.py -k 'predict_counterplay_still_succeeds_when_broadcast_fails or social_copy_rejects_provider_overrides_in_get_query'`：`2 passed in 0.41s`
- 本轮这类“shared pending queue / campaign summary indexes / batch scoring summary / Chroma write guard”改动，当前还额外实跑通过：
  - `tests/test_predictions.py tests/test_parser.py tests/test_memory.py tests/test_campaign_service.py tests/test_gameplay_contract_sync.py -q`：`106 passed in 101.36s`
  - `tests/test_campaign_api.py -q`：`12 passed in 0.72s`
  - `tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`60 passed in 1.79s`
  - `tests/test_simulator.py tests/test_intervention.py tests/test_api.py -k 'intervene or pending_intervention or delete_cascade_data or pop_next_pending_intervention_preserves_order or clear_pending_interventions_for_scenario_is_scoped or delete_uses_vector_store_cleanup' -q`：`19 passed in 1.49s`
  - `tests/test_vector_store.py -q`：`21 passed in 3.50s`
  - `tests/test_runtime_lock.py tests/test_vector_store.py tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`84 passed in 4.82s`
- 本 session 这轮“vector-store per-scenario write lock / runtime-lock cleanup”还额外实跑通过：
  - `python -m pytest tests/test_runtime_lock.py tests/test_vector_store.py -q`：`38 passed in 4.86s`
  - `python -m ruff check --ignore E501 app/services/runtime_lock.py app/services/vector_store.py tests/test_runtime_lock.py tests/test_vector_store.py`：通过
- 本 session 这轮“review fixes / structured logging / parser incomplete fallback”还额外实跑通过：
  - `python -m pytest tests/test_backend_code_review_fixes.py -q`：`4 passed in 0.45s`
  - `python -m pytest tests/test_vector_store.py tests/test_parser.py tests/test_models.py -q`：`64 passed in 71.56s`
  - `python -m pytest tests/test_logging_utils.py tests/test_config.py -q`：`13 passed in 0.41s`
  - `python -m pytest tests/test_api.py -k 'test_root or test_health' -q`：`2 passed, 90 deselected in 2.96s`
  - 扩大定向回归：`23 passed, 215 deselected in 3.75s`
  - 全量 backend：`998 passed in 223.31s (0:03:43)`
  - 相关 `ruff check`：通过
- 本 session 这轮“WS 并行广播 / challenge rotation API”还额外实跑通过：
  - `python -m pytest tests/test_ws.py -q`：`21 passed in 0.96s`
  - `python -m ruff check app/api/ws.py tests/test_ws.py`：通过
  - `python -m pytest tests/test_campaign_api.py -q`：`14 passed in 0.88s`
  - `python -m ruff check --ignore E501 app/api/campaign.py app/services/daily_challenges.py tests/test_campaign_api.py`：通过

覆盖重心：

- REST / Story / Scenario 生命周期：
  - `test_api.py`
  - 覆盖创建场景最小占位态、导出、模板、`/story` fallback 等
- 模拟与可视化集成：
  - `test_simulator.py`
  - `test_simulator_viz_integration.py`
  - `test_visualization_mapper.py`
  - `test_visualization_events.py`
  - `test_scene_selector.py`
- Campaign / shared contract 定向回归：
  - `test_campaign_api.py`
  - `test_campaign_service.py`
  - `test_config.py`
  - `test_gameplay_contract_sync.py`
  - 覆盖 `campaign` router / service 的 finalize 流程、幂等返回、`daily-status` / `weekly-summary` 查询、`challenges/rotation` 定义接口、`scenario summary` 路由、backend-root 路径归一，以及 `card_events.py` 与 `shared/gameplay_contract.v1.json` 的同步约束
- E2E 样本契约回归：
  - `test_e2e_sample_matrix.py`
  - 校验 `frontend/output/e2e/sample_matrix.json` 与 `sample_matrix_variants.json` 的 `scene_theme` 和当前 `select_scene(question)` 保持一致，避免旧样本主题漂移
- 测试夹具：
  - `tests/conftest.py`
  - 每个 pytest case 使用独立临时 SQLite 文件，并在前后显式 `dispose_engine()`，避免共享 `test_swarmoracle.db` 带来的 `readonly database / disk I/O / table already exists`
- 记忆 / 黑板 / 向量存储：
  - `test_memory.py`
  - `test_blackboard.py`
  - `test_blackboard_bench.py`
  - `test_vector_store.py`
- 干预 / 分层代理 / 预测 / 排行榜 / WebSocket：
  - `test_intervention.py`
  - `test_agent_group.py`
  - `test_predictions.py`
  - `test_ws.py`
- 语言、配置、模型与边界回归：
  - `test_lang_detect.py`
  - `test_models.py`
  - `test_config.py`
  - `test_corner_cases.py`
  - `test_token_matrix.py`
  - `test_parser.py`

> **注**: `benchmark_compression.py` 为离线压缩质量标尺，不计入主回归套件。
> `CreateScenarioRequest.question` 当前会在 schema 层直接拒绝空字符串和纯空白输入：
> - 空字符串 / 纯空白：`422`
> - 超过 `1000` 字符：`422`
> - `rounds < 1` 或 `rounds > MAX_ROUNDS`：`422`
