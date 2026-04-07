[根目录](../CLAUDE.md) > **backend**

# Backend -- SwarmOracle FastAPI 后端

## 模块职责

FastAPI 后端服务，负责 LLM 编排、多代理模拟、辩论引擎、神谕密室 / 世界线圆桌、Campaign 系统、预测与排行榜。提供 REST API + WebSocket 实时推送。

## 入口与启动

| 文件 | 说明 |
|------|------|
| `app/main.py` | FastAPI 应用入口，注册所有路由，配置 CORS/Prometheus/异常处理 |
| `app/config.py` | pydantic-settings 配置，从 `.env` 加载，含 LLM / 模拟 / 并发 / DB 参数 |

```bash
# 开发启动
uvicorn app.main:app --host 0.0.0.0 --port 18927 --reload

# Docker
docker compose up backend
```

## 对外接口

### REST API 路由

| 路由前缀 | 文件 | 功能 |
|----------|------|------|
| `/api/scenario` | `api/scenarios.py` | 场景 CRUD、模拟启动、导入/导出 Replay、Web 搜索增强 |
| `/api/capabilities` | `api/scenarios.py` | 轻量配置端点（无 LLM 调用），返回服务端功能开关 |
| `/api/debate` | `api/debate.py` | 辩论竞技场创建、快照、结果、预测投注 |
| `/api/scenario/{id}/ending-room` | `api/ending_rooms.py` | 神谕密室 / 世界线圆桌创建、follow-up threads |
| `/api/ending-room/{id}` | `api/ending_rooms.py` | 密室快照、结果、用户回合追加 |
| `/api/campaign` | `api/campaign.py` | Campaign 档案、徽章、精通度、每日挑战 |
| `/api/scenario/{id}/predict` | `api/predictions.py` | 预测提交、评分、排行榜 |
| `/api/scenario/{id}/intervene` | `api/interventions.py` | 蝴蝶效应干预（单次/回溯/批量） |
| `/api/scenario/{id}/social` | `api/social.py` | 社交媒体文案生成 |
| `/` | `app/main.py` | 健康检查 |
| `/metrics` | Prometheus | Prometheus 指标 |

### WebSocket 端点

| 端点 | 功能 |
|------|------|
| `ws://host/ws/scenario/{id}` | 模拟实时事件流 |
| `ws://host/ws/debate/{id}` | 辩论实时事件流 |
| `ws://host/ws/ending-room/{id}` | 密室/圆桌实时事件流 |

## 关键依赖与配置

### 依赖 (pyproject.toml)

| 依赖 | 用途 |
|------|------|
| fastapi + uvicorn | Web 框架 + ASGI 服务器 |
| sqlmodel + alembic | ORM + 数据库迁移 |
| httpx | 异步 HTTP 客户端 (LLM 调用) |
| chromadb | 向量存储 (Agent 记忆检索) |
| pydantic-settings | 配置管理 |
| websockets | WebSocket 支持 |
| prometheus-fastapi-instrumentator | 监控指标 |

### 环境变量 (主要)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_RESPONSES_URL` | `http://127.0.0.1:8317/v1` | LLM API 地址 |
| `LLM_API_KEY` | `sk-12345678` | LLM API Key |
| `LLM_MODEL_NAME` | `gpt-5.4-mini` | 模型名称 |
| `DATABASE_URL` | `sqlite:///swarmoracle.db` | SQLite 路径 |
| `LLM_CONCURRENCY` | `5` | LLM 并发请求数 |
| `MAX_AGENTS` | `1500` | 最大代理数 |
| `MAX_ROUNDS` | `40` | 最大模拟轮次 |
| `LOG_LEVEL` | `INFO` | 日志级别 |
| `LOG_FORMAT` | `json` | 日志格式 (json/plain) |

## 数据模型

### 核心 ORM 模型 (`app/models/`)

| 模型 | 文件 | 说明 |
|------|------|------|
| Scenario, Agent, Branch, Round, AgentMessage | `database.py` | 模拟核心实体 |
| InterventionLog, PendingIntervention | `database.py` | 蝴蝶效应干预 |
| ReplayArtifact | `database.py` | Replay 持久化 |
| AgentGroup, AgentGroupMember | `agent_group.py` | 层级代理分组 (50+ 代理自动启用) |
| Debate, DebateTurn, DebatePrediction, DebateCounterplay | `debate.py` | 辩论竞技场 |
| EndingRoom, EndingRoomParticipant, EndingRoomThread, EndingRoomTurn | `ending_room.py` | 神谕密室 / 世界线圆桌 |
| DirectorProfile, ProfileMastery, DirectorBadgeUnlock, ScenarioCampaignLog | `campaign.py` | Campaign 系统 |
| Prediction, Leaderboard | `predictions.py` | 预测与排行榜 |

### 数据库迁移 (Alembic)

13 个迁移版本，从 `001_initial` 到 `013_add_web_context_json`。

## 服务层 (`app/services/`)

| 服务 | 文件 | 职责 |
|------|------|------|
| ending_room_service | `ending_room_service/` (包) | 密室/圆桌编排核心，拆分为 _utils/_participants/_threads/_content |
| simulator | `simulator.py` | 多代理模拟引擎 |
| debate | `debate.py` | 辩论引擎 |
| llm_client | `llm_client.py` | LLM 调用封装 (JSON/流式/探测)，BYOK URL allowlist + scheme 校验，不可信文本 guardrail |
| campaign | `campaign.py` | Campaign 计算 |
| memory | `memory.py` | Agent 记忆管理与压缩 |
| blackboard | `blackboard.py` | 黑板模式通信 |
| web_context | `web_context.py` | Web 搜索增强 (Tavily/SearXNG 提供商, TTL 缓存, 上下文格式化) |
| narrator | `narrator.py` | 叙事生成 |
| scoring | `scoring.py` | 预测评分 |
| vector_store | `vector_store.py` | ChromaDB 向量检索 |
| runtime_lock | `runtime_lock.py` | 运行时互斥锁 |
| parser | `parser.py` | LLM 输出解析 |
| lang_detect | `lang_detect.py` | 语言检测 |

## 可视化层 (`app/visualization/`)

| 文件 | 职责 |
|------|------|
| `events.py` | 可视化事件类型 |
| `mapper.py` | 模拟事件到可视化映射 |
| `card_events.py` | 卡片事件 |
| `persona_mapper.py` | 角色映射 |
| `scene_selector.py` | 场景选择器 |

## 测试与质量

- **46 个测试文件**，位于 `tests/`
- 框架: pytest + pytest-asyncio (asyncio_mode=auto)
- Lint: ruff (line-length=100, py311, select E/F/I/W)
- 运行: `cd backend && pytest`
- 含基准测试: `benchmark_compression.py`, `test_blackboard_bench.py`

## 相关文件清单

```
backend/
  app/
    main.py              # FastAPI 入口
    config.py            # 配置
    logging_utils.py     # 日志配置
    api/                 # REST/WS 路由 (8 个路由模块)
    models/              # ORM 模型 (5 个模型模块)
    services/            # 业务逻辑 (15 个服务)
    visualization/       # 可视化映射 (5 个文件)
  alembic/               # 数据库迁移 (13 个版本)
  tests/                 # 测试 (46 个文件)
  pyproject.toml         # 项目配置
  Dockerfile             # Docker 构建
```

## 深度补扫

### simulator.py -- 多代理模拟引擎 (2170 行)

#### 核心函数

| 函数 | 说明 |
|------|------|
| `run_simulation(scenario_id, ws_callback, llm_overrides, branch_id)` | **主入口**，执行完整模拟流水线 (Stage 2 模拟 + Stage 3 叙事) |
| `_gather_agent_messages(...)` | 并发收集所有 Agent 的 LLM 响应，支持 Blackboard 模式和 DB 直读模式 |
| `_gather_hierarchical_messages(...)` | P3-A 层级模式：仅 Leader Agent 调用 LLM，Worker 从 Leader 输出合成响应，1000 agent 降为 ~10 次 LLM 调用 |
| `_detect_fork(...)` | 分歧检测：分析 Agent diverge 信号，通过 LLM 判断是否需要分叉时间线 |
| `_compress_round_memory(...)` | 每 N 轮压缩记忆，更新 Blackboard 全局摘要 |
| `_narrate_branch_data(...)` | Stage 3 叙事：收集分支数据，调用 narrator 生成故事/洞察 |
| `reconcile_scenario_done_if_complete(...)` | 检测停滞场景，自动标记为完成 |

#### 模拟流程

1. **加载场景** -- 从 DB 读取 Scenario + Agents，解析 parsed_context 获取语言/轮数/灵敏度/fork_prompt_variant 等
2. **初始化可视化** -- 若 `visualization_enabled`，分配精灵、位置、场景主题，推送 `viz:scene_init`
3. **层级检测** -- 若 `hierarchical=true`，解析 groups 配置，分离 Leader/Worker Agent 集合
4. **模拟循环** (round 1..N) -- 对每个活跃分支：
   - (a) 弹出用户干预 (蝴蝶效应)
   - (b) 收集 Agent 消息 (并发 LLM 调用，受 semaphore 限流)
   - (c) 推送 round_summary
   - (d) 检测卡片事件触发
   - (e) 每 N 轮压缩记忆
   - (f) 分歧检测 -- 若 diverge_signals 存在且未达上限，调用 `_detect_fork`
   - (g) 若 should_fork=true，创建子分支，fork Blackboard，推送 `branch_fork`
   - (h) 归一化分支概率，剪枝低概率分支
5. **Stage 3 叙事** -- 对所有 ACTIVE/COMPLETED 分支生成叙事，推送 `narration`
6. **完成** -- 清理干预队列，标记场景完成，推送结局可视化

#### 分歧检测 (Fork Detection)

- **6 个 Prompt 变体** (a-f) x 2 种语言 (中/英) = 12 个模板
- 变体 a: 默认保守分析师；b: 积极分叉；c: 隐含互斥未来即 fork；d: 制度/审批分叉；e: 拿不准倾向 fork；f: 压缩到 2 条主路径
- 分歧调试追踪完整记录到 `scenario.parsed_context.fork_debug_trace`
- 跳过条件：已达 MAX_BRANCHES / 超出 detector 预算 / 最后一轮

#### 干预队列 (Intervention Queue)

- 双存储策略：文件型 SQLite 使用 DB 队列 (`PendingIntervention` 表)，内存型使用 `dict`
- FIFO 顺序，支持 `add/pop/count/clear` 操作
- 原子弹出使用 `BEGIN IMMEDIATE` + raw SQL

#### 与其他服务的交互

| 被调用服务 | 交互方式 |
|-----------|----------|
| `llm_client.llm_call_json` | Agent 消息生成 + 分歧检测 |
| `memory.*` | 上下文构建、记忆检索、存储、压缩 |
| `blackboard.Blackboard` | 共享信息板 (fork 时 `.fork()` 深拷贝) |
| `narrator.narrate_branch` | 分支叙事生成 |
| `visualization.*` | 精灵分配、位置计算、场景选择、事件映射 |
| `runtime_lock` | 模拟互斥锁检测 |
| `lang_detect` | 语言指令生成 |

### database.py -- 完整 ORM Schema (522 行)

#### 枚举类型

| 枚举 | 值 |
|------|------|
| `ScenarioStatus` | `parsing`, `simulating`, `narrating`, `done`, `error` |
| `AgentTier` | `CORE`, `IMPORTANT`, `CROWD` |
| `BranchStatus` | `ACTIVE`, `COMPLETED`, `PRUNED` |

#### 表结构

| 表名 | 模型类 | 关键字段 | 关系 |
|------|--------|----------|------|
| `scenario` | `Scenario` | `id(PK)`, `question`, `parsed_context(JSON)`, `director_state_json(JSON)`, `gameplay_state_json(JSON)`, `web_context_json(JSON)`, `status`, `created_at`, `user_id`, `visualization_enabled`, `scene_theme` | has many: agents, branches |
| `agent` | `Agent` | `id(PK)`, `scenario_id(FK)`, `name`, `role`, `persona`, `tier(AgentTier)`, `stance`, `emotion`, `group_id` | belongs to: scenario |
| `branch` | `Branch` | `id(PK)`, `scenario_id(FK)`, `parent_branch_id`, `fork_round`, `fork_reason`, `title`, `description`, `summary`, `story`, `insight`, `key_moments(JSON str)`, `probability`, `status(BranchStatus)` | belongs to: scenario; has many: rounds |
| `round` | `Round` | `id(PK)`, `branch_id(FK)`, `round_number`, `compressed_summary` | belongs to: branch; has many: messages |
| `agent_message` | `AgentMessage` | `id(PK)`, `round_id(FK)`, `agent_id(FK)`, `content`, `emotion`, `diverge`, `tokens_used` | belongs to: round |
| `intervention_log` | `InterventionLog` | `id(PK)`, `scenario_id(FK)`, `branch_id(FK)`, `round_number`, `user_input`, `created_at` | -- |
| `pending_intervention` | `PendingIntervention` | `id(PK, autoincrement)`, `scenario_id(FK)`, `branch_id(FK)`, `user_input`, `created_at` | 复合索引: (scenario_id, branch_id, id) |
| `replay_artifact` | `ReplayArtifact` | `id(PK)`, `kind`, `payload_json(JSON)`, `created_at` | -- |

#### 数据库引擎管理

- `get_engine()` -- 线程安全单例 (Thread Lock)，SQLite 自动设置 WAL 模式 + busy_timeout=5000
- `dispose_engine()` -- 优雅关闭 (M-2 fix)
- `init_db()` -- `create_all` + 轻量迁移 (自动 `ALTER TABLE ADD COLUMN`，自动 `CREATE INDEX`)
- 安全: SQL 标识符白名单校验 (`_SAFE_IDENTIFIER` 正则)，防止迁移 SQL 注入 (C-2 fix)
- 枚举迁移: `_migrate_normalize_enum_values` 将旧 `.value` 格式统一为 `.name` 格式

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-04-07 | Web 搜索增强 + 安全加固 | web_context 服务、`/api/capabilities`、migration 013、BYOK 校验统一 (scenario/debate/predictions/social)、fence-breakout 修复、`_sanitize_url` 协议白名单、malformed JSON shape 防御、20 条边界回归测试 |
| 2026-04-02 | 深度补扫 | 补充 simulator.py 模拟流程 + database.py 完整 ORM schema |
| 2026-04-02 | 初始生成 | 模块扫描完成 |
