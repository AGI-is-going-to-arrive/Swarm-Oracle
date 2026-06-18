[根目录](../CLAUDE.md) > **backend**

# Backend -- SwarmOracle FastAPI 后端

## 模块职责

FastAPI 后端：LLM 编排、多代理模拟、辩论引擎、神谕密室 / 世界线圆桌、Campaign 系统、预测与排行榜。提供 REST API + WebSocket 实时推送。

- 入口：`app/main.py`（注册路由，配置 CORS/Prometheus/异常处理）；`app/config.py`（pydantic-settings，从 `.env` 加载 LLM/模拟/并发/DB 参数）
- 启动：`uvicorn app.main:app --host 0.0.0.0 --port 18927 --reload`（或 `docker compose up backend`）

## 目录结构

```
backend/app/
  main.py / config.py / logging_utils.py
  api/            # REST/WS 路由 (10 模块)
  models/         # ORM 模型 (8 模块)
  services/       # 业务逻辑 (23 服务)
  visualization/  # 可视化映射 (events/mapper/card_events/persona_mapper/scene_selector)
backend/alembic/  # 数据库迁移 (16 版本: 001_initial → 016_checkpoint_faction_argument_tables)
backend/tests/    # 99+ 个 test_*.py
```

## 对外接口

### REST API（路由前缀 → 文件）

| 路由前缀 | 文件 | 功能 |
|----------|------|------|
| `/api/scenario` | `api/scenarios.py` | 场景 CRUD、模拟启动、story result-quality 字段、Replay 导入导出、Web 搜索增强 |
| `/api/capabilities` | `api/scenarios.py` | 18-key capability registry（`web_search` + 17 功能开关，无 LLM 调用，不暴露 key/base URL） |
| `/api/debate` | `api/debate.py` | 辩论创建、快照、结果、预测投注；`/{id}/argument-map` 受 `FEATURE_ARGUMENT_MAP` gate (F6) |
| `/api/scenario/{id}/ending-room` · `/api/ending-room/{id}` | `api/ending_rooms.py` | 密室/圆桌创建、follow-up threads、快照、结果、用户回合追加 |
| `/api/scenario/{id}/survey` · `/analyst` | `api/ending_rooms.py` | 圆桌问卷 / 分析师 SSE，分别受 `FEATURE_ROUNDTABLE_SURVEY` / `FEATURE_ROUNDTABLE_ANALYST` gate |
| `/api/campaign` | `api/campaign.py` | 档案、徽章定义/解锁、精通度、每日挑战、每周 track、leaderboard preview |
| `/api/scenario/{id}/predict` | `api/predictions.py` | 预测提交、评分、排行榜 |
| `/api/scenario/{id}/intervene` | `api/interventions.py` | 蝴蝶效应干预（单次/回溯/批量）；回溯端点受 `FEATURE_COUNTERFACTUAL_REPLAY` gate，关闭返回 404 `FEATURE_DISABLED` |
| `/api/scenario/{id}/social` | `api/social.py` | 社交媒体文案生成 |
| `/api/agents` | `api/agents.py` | Agent 身份/记忆查询、自建 Agent CRUD (F1/F3)，受 `FEATURE_CUSTOM_AGENTS` / `FEATURE_AGENT_IDENTITY` gate；`/from-document` 长 PDF 采样+全文证据 |
| `/api/graphs` | `api/graphs.py` | 因果图谱、阵营时间线、反事实比较、检查点 (F2/F4/F5)，受对应 `FEATURE_*` gate。`compare_branches` 响应含轮级 `branches[]` + 逐消息 `branch_a_messages`/`branch_b_messages`（agent_name+content+emotion）；`POST /counterfactual/{branch_id}/resimulate` 给只 clone+seed 的反事实分支补跑完整叙事 |
| `/` · `/metrics` | `app/main.py` · Prometheus | 健康检查 / Prometheus 指标 |

### WebSocket

`ws://host/ws/{scenario,debate,ending-room}/{id}` — 模拟 / 辩论 / 密室圆桌实时事件流。

## 关键依赖与配置

依赖（pyproject.toml）：`fastapi+uvicorn`（Web/ASGI）、`sqlmodel+alembic`（ORM/迁移）、`httpx`（异步 LLM 调用）、`chromadb`（向量记忆）、`pydantic-settings`、`websockets`、`prometheus-fastapi-instrumentator`。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_RESPONSES_URL` | `http://127.0.0.1:8317/v1` | LLM API 地址 |
| `LLM_API_KEY` | 占位 key | `your-api-key-here`（旧 `sk-12345678` 也按占位处理）；非本地 endpoint 配占位 key 会启动失败，preflight 把占位 key 当未配置并跳过连通性测试 |
| `LLM_MODEL_NAME` | `gpt-4o`（模板） | 模型名称 |
| `DATABASE_URL` | `sqlite:///swarmoracle.db` | SQLite 路径 |
| `LLM_CONCURRENCY` / `MAX_AGENTS` / `MAX_ROUNDS` | `5` / `1500` / `40` | LLM 并发 / 最大代理 / 最大轮次 |
| `LOG_LEVEL` / `LOG_FORMAT` | `INFO` / `json` | 日志级别 / 格式 (json/plain) |
| `ENABLE_WEB_SEARCH` | `false` | 启用 app-layer 搜索增强 |
| `WEB_SEARCH_PROVIDER` | `tavily` | 服务端默认 provider：`tavily/exa/firecrawl/xai/searxng`；`native` 已移除，启动 fail-fast |
| `WEB_SEARCH_API_KEY` / `SEARXNG_URL` | `""` / `http://localhost:8888` | provider key（`searxng` 不需要） / SearXNG 基址 |
| `NATIVE_SEARCH_MAX_TOOL_CALLS` / `NATIVE_SEARCH_MAX_CITATIONS` | `5` / `50` | 单次 LLM native search tool-call 上限（超出 fail-closed） / citation 保留上限 |
| `IDENTITY_COMPACT_THRESHOLD` / `_BATCH_SIZE` / `_GROUP_SIZE` | `50` / `30` / `10` | identity memory 压缩触发阈值 / 每次压缩条数 / 每组 LLM 摘要文档数 |
| `DOCUMENT_*`（ENTITY/PERSONA/PERSONA_SINGLE_TIMEOUT、MAX_TEXT_FOR_SCAN、SCAN_SAMPLE_SIZE、MAX_EXTRACTED_TEXT_CHARS） | -- | 文档导入超时/采样/全文上限（PDF 文本上限 1000000 字符） |

### Feature flags（`config.py` 为准，多数默认 `false`）

| flag | 默认 | 作用 |
|------|------|------|
| `FEATURE_CUSTOM_AGENTS` / `FEATURE_AGENT_IDENTITY` | false | 自建 Agent CRUD+workshop / 跨场景身份解析+记忆 API |
| `FEATURE_RESULT_VERDICT` | **true** | Result Quality verdict 生成、branch question-answer 持久化、`/api/capabilities.result_verdict` |
| `FEATURE_CAUSAL_GRAPH` / `FEATURE_GRAPH_ANALYSIS` | false | 因果图谱 API+simulator hook / 图谱摘要分析（对外 enabled 还要求 `FEATURE_CAUSAL_GRAPH=true`） |
| `FEATURE_COUNTERFACTUAL_REPLAY` | **true** | 反事实回溯+比较+检查点 API，并 gate 回溯干预端点 |
| `FEATURE_FACTIONS` / `FEATURE_ARGUMENT_MAP` | false | 阵营检测 API+simulator hook / 辩论论证图谱 API+debate hook |
| `FEATURE_REPLAY_TRACE` / `FEATURE_AGENT_CONVERSATION` | false | replay branch lineage API / 图谱节点+结果追问 REST+SSE |
| `FEATURE_ROUNDTABLE_SURVEY` / `FEATURE_ROUNDTABLE_ANALYST` | false | 圆桌问卷 SSE / 圆桌 ReACT 分析师 SSE |
| `FEATURE_KG_EXPLORER` | **true** | KG Explorer / Timeline Galaxy 前端 capability gate |
| `FEATURE_NEW_SOURCES` | false | source family 分类搜索（预测市场/财经/学术/深度新闻），前端 4 领域 checkbox + capabilities 返回 `web_search.providers` 块 |
| `FEATURE_IDENTITY_COMPACTION` | false | identity memory LLM 摘要压缩 |

## 数据模型（`app/models/`）

| 模型 | 文件 |
|------|------|
| Scenario, Agent, Branch, Round, AgentMessage, InterventionLog, PendingIntervention, ReplayArtifact | `database.py` |
| AgentGroup, AgentGroupMember（层级分组，50+ 代理自动启用） | `agent_group.py` |
| Debate, DebateTurn, DebatePrediction, DebateCounterplay | `debate.py` |
| EndingRoom, EndingRoomParticipant, EndingRoomThread, EndingRoomTurn | `ending_room.py` |
| DirectorProfile, ProfileMastery, DirectorBadgeUnlock, ScenarioCampaignLog | `campaign.py` |
| Prediction, Leaderboard | `predictions.py` |
| AgentIdentity, AgentIdentityCampaign(+Member), AgentGrowthEvent (F1/F3) | `agent_identity.py` |
| GraphSnapshot, GraphNode, GraphEdge, AgentStateFrame (F2/F6) | `graph.py` |
| ScenarioCheckpoint, AgentRelationEdge, FactionSnapshot, FactionEvent, DebateArgumentUnit (F4/F5/F6) | `checkpoint.py` |

### ORM 约定（`database.py`）
- 枚举：`ScenarioStatus`(parsing/simulating/narrating/done/error)、`AgentTier`(CORE/IMPORTANT/CROWD)、`BranchStatus`(ACTIVE/COMPLETED/PRUNED)；迁移时 `_migrate_normalize_enum_values` 把旧 `.value` 统一为 `.name`
- `get_engine()` 线程安全单例，SQLite 自动 WAL + busy_timeout=5000；`init_db()` 做轻量迁移（自动 `ALTER TABLE ADD COLUMN` / `CREATE INDEX`）
- 安全：迁移 SQL 标识符走 `_SAFE_IDENTIFIER` 白名单正则，防注入
- `pending_intervention` 复合索引 (scenario_id, branch_id, id)

## 服务层（`app/services/`，代码读不出的约定）

| 服务 | 关键约定 |
|------|---------|
| `ending_room_service/`（包） | 密室/圆桌编排核心，拆分 `_utils/_participants/_threads/_content`，**改动注意 re-export 兼容**。Oracle 文案 generation-first 3-tier fallback（纯生成 temp=0.82 → rewrite temp=0.78 → 静态模板）；四种房间类型（WORLDLINE_ROUNDTABLE/ENDING_CHAMBER/ONE_MOVE_ONLY/CROSSLINE_GALLERY）均注入 `scenario_question + transcript_quotes + factual_guardrail`；roundtable 静态锚点用清洗后的 scenario question 作短问题前缀，`_phase_insight()` 先去重问题前缀再按中文 96 字 / 英文 160 chars 压缩；wrap-up/follow-up fallback 跟随 room language（英文房间翻译中文片段，不露 prompt 标签）；voice variant 18 种（role_hint+bio_hint 子串匹配） |
| `simulator.py` | 多代理模拟引擎（主入口 `run_simulation`）。Result Quality verdict 生成（prompt 用分支 title/insight/probability/`story_excerpt[:1200]`，branch summaries untrusted block 上限 15000 字符）；4 个 Phase 3 hook：causal / factions(+WS 事件) / checkpoint / identity lifecycle，均受 `FEATURE_*` gate，identity hook 走 `asyncio.to_thread` 非阻塞；`_strip_diverge_marker()` 清理用户可见 `content` 里的 `[DIVERGE: ...]`/`[DIVERGE：...]`（`diverge` 字段仍独立给 fork 检测）；fork 检测 6 prompt 变体(a-f)×中英=12 模板，trace 写 `parsed_context.fork_debug_trace`；干预队列文件 SQLite 用 `PendingIntervention` 表（FIFO，`BEGIN IMMEDIATE` 原子弹出），内存型用 dict；层级模式 1000 agent 降为 ~10 次 LLM 调用 |
| `debate.py` | 辩论引擎，含 argument map 抽取+verdict linking hook（受 `FEATURE_ARGUMENT_MAP` gate）；phase insights `_enhance_insights_with_llm()` 重写，受 `DEBATE_USE_LLM` gate（默认 true），失败静默回退 |
| `llm_client.py` | LLM 调用封装（JSON/流式/探测），BYOK URL allowlist + scheme 校验，不可信文本 guardrail，content=null `or ""` 防御；native-search tool-call budget fail-closed，citation 按 `NATIVE_SEARCH_MAX_CITATIONS` 截断 + ContextVar 每次调用隔离；`_infer_upstream_from_model_name()` 为代理/本地端点根据模型名推断上游 provider（grok→xai / gpt·o1·o3→openai），`/health/test` live probe 验证 native search 实际可用 |
| `web_context.py` | Web 搜索增强（Tavily/SearXNG/Exa/xAI，TTL 缓存 + stampede 去重，snippet 规范化）；`FEATURE_NEW_SOURCES` 开启后 `fetch_family_context()` 异步并发，每 family 经 `include_domains` 独立搜索（`FAMILY_DOMAIN_FILTERS` 常量；Tavily/Exa 透传 API、SearXNG 拼 `site:`、xAI 注入 prompt 域名指令）；provider body error 统一映射 failed，不回显 provider 原始 message |
| `narrator.py` | 叙事生成；Pass-1/Pass-2/fallback 都带原问题锚点，Pass-2 要求具体 `question_answer`；返回 branch-level `question_answer` 存入 `parsed_context.result_quality.branch_question_answers` |
| `vector_store.py` | ChromaDB 向量检索，identity memory 双层存储，写入经 `identity:{user_id}` 粒度串行化锁；`CompactionGroup`/`check`/`prepare`/`execute`/`build_compaction_prompt`（FIFO eviction raw-first） |
| `memory.py` | Agent 记忆管理与压缩；CROWD persona 双层包装 `startswith("【")` 哨兵防二次包裹，CORE/IMPORTANT 层走 `format_untrusted_text_block` |
| `replay.py` | 反事实检查点/克隆/种子/比较 (F4)；`compare_branches()` CJK-aware 逐字分歧度计算 + `branch_a_messages`/`branch_b_messages` 逐消息列表 + `intervention`/`is_identical`/`common_rounds` |
| `parser.py` | LLM 输出解析；scenario 初始标题 fallback 为 `问题起点 / Starting point` |
| 其余 | `campaign.py` Campaign 计算 · `blackboard.py` 黑板通信（fork 时 `.fork()` 深拷贝，`export_snapshot()`/`from_snapshot()` 8 字段持久化） · `scoring.py` 预测评分 · `persona_workshop.py` 自建 Agent CRUD+防注入 (F3) · `agent_identity.py` 跨场景身份+成长事件 (F1) · `causal_graph.py` 因果 DAG+stance 推导 (F2，`GraphDelta`) · `factions.py` 阵营检测+聚类+背叛 (F5) · `debate_argument_map.py` 规则抽取+判决关联 (F6，`link_verdict()` 五状态 accepted/standing/unaddressed/rebutted/rejected) · `roundtable_survey.py` SSE+Semaphore(3) · `roundtable_analyst.py` ReACT 3 工具(query_causal_graph/search_identity_memories/search_web_context) 最多 5 轮 · `runtime_lock.py` 互斥锁 · `lang_detect.py` 语言检测 |

## 测试与质量

- 框架 pytest + pytest-asyncio (`asyncio_mode=auto`)；Lint `ruff`（line-length=100, py311, select E/F/I/W）；运行 `cd backend && pytest`
- 基线：full gate `3415 passed / 6 skipped`，`ruff check app/` 通过
- 5 条 `test_llm_client` 集成测试在 LLM 代理返回 content=null 时自动 skip（probe 机制）
- live LLM benchmark / observation 测试默认跳过，需 `RUN_REAL_LLM_TESTS=1` 显式开启；基准测试 `benchmark_compression.py` / `test_blackboard_bench.py`

## 变更记录摘要

> 完整逐条历史（含每次测试 pass 数）见 git log；下表只保留功能里程碑。

| 阶段 | 内容 |
|------|------|
| 2026-05 | 发布前配置收口（占位 key 识别 + 非本地 endpoint fail-fast）；UX 去模板化（parser/simulator/ending_room 标题与 fallback 走人话口径）；Capability gate 收口（回溯干预 `FEATURE_COUNTERFACTUAL_REPLAY`）；Counterfactual 逐消息对比 + `/resimulate` 端点；Oracle prompt/narration hardening + Result Quality 二次锚定；Document Ingestion Upgrade（长 PDF 采样+全文）；Web Search P5 release gate（native search budget fail-closed + `detect_body_error` + source family 边界）；Sprint 4 KG realtime（`GraphDelta`/coalescer/`kg:delta`）+ voice variant 13→18 |
| 2026-04 | 辩论全面去模板化（LLM persona 3 方并行 + 口语化 prompt + 禁用术语 + UNTRUSTED DATA 包装 + phase insight LLM 增强）；Oracle 文案去模板化（3-tier fallback + factual_guardrail）；source family 分类搜索 + quota/contract 收口；graph-playability-upgrade BE 交付（migration 022 + `DELETE /scenario` 级联 + `/conversation` SSE + `/replay-trace` + 4-family web-context）；Phase 3 六大功能 F1-F6（13 模型 + 6 服务 + 迁移 014-016 + simulator hook + capabilities registry + ChromaDB 双层 memory）+ P0/P1 接线 + 安全修复；P1-9 resume + P1-12 identity compaction；Web 搜索增强 + WS 首帧 auth + session gate；初始生成 (04-02) |
