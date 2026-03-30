# 配置项参考

所有配置通过环境变量或 `.env` 文件加载（pydantic-settings）。

> 本地后端默认读取 `backend/.env`。`docker compose` 默认使用仓库根目录 `.env.docker`。

## LLM 配置

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_RESPONSES_URL` | str | `https://api.edgefn.net/v1` | OpenAI兼容API地址；当前 backend 会在调用时自动补成具体 endpoint（例如 `/chat/completions`），所以 BYOK 既支持填完整 endpoint，也支持直接填到 `/v1` |
| `LLM_API_KEY` | str | 非占位 key（当前模板已指向 edgefn） | API密钥 |
| `LLM_MODEL_NAME` | str | `MiniMax-M2.5` | 模型名称 |
| `LLM_REASONING_EFFORT` | str | `none` | 推理强度 (`none` / `low` / `medium` / `high`) |
| `LLM_REQUESTS_PER_MINUTE` | int | `10` | 服务器默认 RPM；`<= 0` 表示关闭这层限制 |
| `LLM_TOKENS_PER_MINUTE` | int | `100000` | 服务器默认 TPM；`<= 0` 表示关闭这层限制 |
| `DEBATE_USE_LLM` | bool | `true` | Debate Arena 回合文案是否优先走 LLM；关闭时会退回 deterministic 文案 |

> **BYOK (P4-E)**: 以上 LLM 配置为服务器默认值。用户当前可在首页或对应调用点透传 `llm_api_key / llm_base_url / llm_model / llm_requests_per_minute / llm_tokens_per_minute` 覆盖，支持所有 OpenAI 兼容 API；同一份 provider policy 仍贯通 `createScenario / createDebate / social copy / scorePredictions`。前端这份 provider policy 继续按标签页会话保存在 `sessionStorage`，关闭标签页后清空；若浏览器里仍有旧 `localStorage` 记录，首次读取时会自动迁移一次。首页当前还会：
> - 给每个 BYOK 字段显示一行人话说明
> - 在用户填了 `RPM / TPM` 后即时给出预算提醒
> - 若当前 `agents / rounds` 超预算，直接禁止主模式 `Start Simulation`
>
> backend 当前会把 `RPM / TPM` 当作 request-scoped runtime limit：
> - 窗口打满时，会等到下一个窗口再发，而不是直接把 agent 打成“沉默了”
> - 非流式调用会在 provider 返回 `usage` 后回填真实 token 计数
> - 流式路径当前仍以估算 token 做准入
>
> `disable_user_quota` 仍只对本地 / self-hosted provider 生效；它只跳过 user-level fairness cap，不会绕过 `LLM_CONCURRENCY / LLM_MAX_PENDING` 这类全局并发闸门。

> **启动期校验**:
> - 占位 `LLM_API_KEY = sk-12345678` 当前只允许用于本地 LLM 网关（如 `localhost / 127.0.0.1 / host.docker.internal`）
> - 若 `LLM_RESPONSES_URL` 指向非本地端点，配置加载阶段就会拒绝占位 key，而不是等到第一次 LLM 调用才失败
> - `LLM_MODEL_NAME` 当前不能为空；空白值会在配置加载阶段直接报错

> **Docker 运行提示**: 当前仓库默认 Docker 模板已经直接指向 edgefn，不再默认假设宿主机本地代理。如果你要把容器切回宿主机本地 LLM，再把 `.env.docker` 里的 `LLM_RESPONSES_URL` 改回 `host.docker.internal` 即可。

## Scenario Runtime Tuning

以下字段不是环境变量，而是 `POST /api/scenario` 的**单局运行时调参项**。适合做 fork 行为实验，或作为将来的产品默认配置。

| 字段 | 类型 | 合法范围 / 可选值 | 作用 |
|------|------|-------------------|------|
| `temperature` | float | `0.0 - 2.0` | Chat Completions 采样温度。会影响 agent 发言、fork detector、memory compression、narrator 的采样风格 |
| `branch_sensitivity` | float | `0.0 - 1.0` | 覆盖 parser 产出的 `branch_sensitivity`，直接进入 fork detector prompt |
| `fork_prompt_variant` | str | `a / b / c / d / e / f` | 切换 `_detect_fork()` 的 detector prompt 口径 |
| `fork_detector_active_branch_limit` | int | `0 - MAX_BRANCHES` | 每轮仅允许前 `K` 个 `ACTIVE` 分支继续跑 detector；`0` 表示关闭预算，保留默认行为 |

> 这组运行时调参当前都会进入 `Scenario.parsed_context`，并在 `GET /api/scenario/{id}` 的 `fork_debug.round_checks` 里回显。它们不会修改服务器级全局默认值；不传时仍走当前默认行为。

### Variant 说明

| Variant | detector 口径 | 当前实验结论 |
|---------|---------------|--------------|
| `a` | 基线保守口径；强调“根本分歧”与“真正不同未来路径” | 命中率与强度都相对克制 |
| `b` | 激进口径；把互斥未来、制度/审批/责任链分流与更积极的 fork 先验一起叠满 | 当前最稳定、最容易出多结局，但也最容易 branch 爆炸 |
| `c` | 只要已经形成互斥未来，就足够 fork | 是最强单因子之一 |
| `d` | 只要形成不同审批路径、责任链或治理结构，就足够 fork | 在制度题上非常有效，也是最强单因子之一 |
| `e` | 只有明确收敛到单一路线，才允许 `no_fork` | 在当前样本里不是主因 |
| `f` | `c + d` 再加“默认压缩成 2 条主路径” | 实验未能抑制 branch 爆炸，不建议作为默认配置 |

### 产品推荐

假设用户**不能直接控制 `temperature`**，当前最推荐的产品默认配置是：

```text
fork_prompt_variant = b
branch_sensitivity = 0.7
fork_detector_active_branch_limit = 1
```

理由：

- `fork_prompt_variant = b` 当前最稳定地让用户看到 branch / fork / 多结局
- `fork_detector_active_branch_limit = 1` 是目前最有效的“压 branch 爆炸但不把多结局打没”的结构手段
- `branch_sensitivity = 0.7` 先保持中位，不把 detector 调成过于漂移的状态

### 档位建议

这三档当前已经正式挂到首页 UI，入口文案为：

```text
神谕档位 / Oracle Profile
```

前端显示名是：

```text
守望 / Watchful
校准 / Calibrated
裂界 / Riftbound
```

它们只作用于主模式的世界线分岔，不影响 Debate Arena。

| 档位 | 建议配置 | 适用场景 | 风险 |
|------|----------|----------|------|
| 守望版（Watchful） | `d + 0.7 + k=1` | 治理、审批、法院、委员会、制度题 | branch 与多结局更克制；人物题不一定稳定出分支 |
| 校准版（Calibrated，推荐） | `b + 0.7 + k=1` | 默认产品配置 | 兼顾分支可见性和 branch 控制；仍会有一定题目波动 |
| 裂界版（Riftbound） | `b + 0.7 + k=0` | 内部 demo / spectacle 场景 | fork 命中率高，但 branch 爆炸和长尾 narration 风险都更高 |

### 跨题预算实验摘要

以下结果来自 `prompt=b, temperature=0.4, branch_sensitivity=0.7, rounds=3` 的 budget 泛化实验：

| 题目 | `k=0` | `k=1` | `k=2` | 结论 |
|------|-------|-------|-------|------|
| 马斯克登月 | `10 / 9` | `7 / 7` | `10 / 10` | `k=1` 明显压 branch 数；`k=2` 几乎不够 |
| 轮值外审团重裁 | `13 / 13` | `7 / 7` | `10 / 10` | `k=1` 同样有效 |
| 无互联网世界 | `13 / 13` | `9 / 9` | `11 / 11` | 天然高分叉题也能压，但幅度较小 |

表格中的 `x / y` 含义为 `branch_count / story_branch_count`。

当前可以把结论收成一句话：

```text
prompt 负责“什么时候该 fork”，
k 负责“fork 以后别炸开”，
sensitivity 只负责微调。
```

## 日志

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LOG_LEVEL` | str | `INFO` | root logger 与 `uvicorn / uvicorn.error / uvicorn.access` 的日志级别；支持 `CRITICAL / ERROR / WARNING / INFO / DEBUG` |
| `LOG_FORMAT` | str | `json` | 日志输出格式；支持 `json` 与 `plain` |

> 当前 backend 启动时会统一配置 root logging：
> - 默认输出结构化 JSON
> - `uvicorn / uvicorn.error / uvicorn.access` 会清空自带 handler，统一复用 root formatter
> - 若 `LOG_FORMAT = plain`，会回到原来的可读文本格式
> - 当 `LOG_LEVEL = DEBUG` 时，`WSManager.broadcast()` 现在还会为每条非 `heartbeat` 的出站 WebSocket 事件记录 `stream / type / seq / event_id / clients`，便于本地排查 scenario / debate 的事件时序

## 模拟参数

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `MAX_AGENTS` | int | 1500 | 用户可创建的最大agent数（P3-A提升至千人规模） |
| `HIERARCHICAL_AGENT_THRESHOLD` | int | 50 | 超过此数量自动启用分层架构 (P3-A) |
| `MAX_ROUNDS` | int | 40 | 最大模拟轮数 |
| `MAX_BRANCHES` | int | 8 | 最大并行分支数 |
| `MEMORY_COMPRESS_INTERVAL` | int | 5 | 每N轮压缩一次记忆；当前压缩会把“此前滚动态势简报 + 当前窗口原始对话”合并成新的态势简报，且滚动摘要字段会做固定上限约束，避免 prompt 逐轮膨胀 |
| `BRANCH_PRUNE_THRESHOLD` | float | 0.05 | 概率低于此值的分支被剪枝 |
| `FORK_SENSITIVITY` | float | 0.7 | 分支灵敏度 (0-1) |
| `DEFAULT_NUM_AGENTS` | int | 20 | 用户不传参时默认agent数 (3-100) |
| `DEFAULT_ROUNDS` | int | 10 | 用户不传参时默认模拟轮数 |

> 当前这组旧参数也已补启动期范围校验：
> - `BRANCH_PRUNE_THRESHOLD`：`>= 0` 且 `< 1`
> - `FORK_SENSITIVITY`：`0 - 1`

## 并发控制

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_CONCURRENCY` | int | 5 | 进程内全局 LLM 并发上限；`<= 0` 表示关闭该限制。当前 semaphore 在进程启动后固定，修改该值需重启进程才能稳定生效 |
| `LLM_MAX_PENDING` | int | 24 | 全局排队中的 LLM 请求上限；`<= 0` 表示关闭该限制；超过后直接返回 backpressure |
| `LLM_USER_MAX_PENDING` | int | 4 | 单个 `user_id` 同时挂起的 LLM 请求上限；`<= 0` 表示关闭该限制 |
| `LLM_CIRCUIT_BREAKER_THRESHOLD` | int | 6 | 同一 provider 连续失败达到此阈值后，短时间打开熔断 |
| `LLM_CIRCUIT_BREAKER_RESET_SECONDS` | int | 30 | 熔断打开后的冷却秒数 |

> 当前 LLM runtime guard 有两层：
> - 进程内 `Semaphore + circuit breaker`
> - 当 `DATABASE_URL` 指向同一个 SQLite 文件时，`LLM_MAX_PENDING / LLM_USER_MAX_PENDING` 还会通过 SQLite 共享 reservation 做跨进程计数
>
> 也就是说：
> - `LLM_CONCURRENCY` 当前不会在运行时安全热更新；若配置变更，应该重启 backend 进程
> - `LLM_CONCURRENCY / LLM_MAX_PENDING / LLM_USER_MAX_PENDING <= 0` 当前都表示关闭对应限制；`get_runtime_parallelism_limit()` 也会忽略这些已关闭的项，并在所有限制都关闭时回退到 `MAX_AGENTS`
> - 同一台机器上多个 backend 进程共用同一个 SQLite 文件时，pending 配额会共享
> - 当 SQLite reservation 可用时，它就是 pending / quota 计数的单一真相源；进程内 fallback 计数不会再额外叠加
> - simulator 这类本地 fan-out 调用点当前不再只看全局并发；`get_runtime_parallelism_limit()` 会结合 `LLM_CONCURRENCY / LLM_MAX_PENDING` 与当前请求上下文里的 user pending cap 一起收口本次请求的并发上限
> - provider 熔断与单进程内 `Semaphore` 仍是进程本地行为，不会跨进程同步
> - `llm_call / llm_call_stream` 当前会复用进程内共享 `httpx.AsyncClient`，并在 app shutdown 时统一关闭
> - `llm_call_stream` 当前只会在首个内容片段产出前做连接/起始响应重试，避免已经开始输出后重复发送流片段
> - `llm_runtime_guard` 的 `CREATE TABLE / CREATE INDEX` 当前也已按 SQLite db path 做首次缓存；同一个 db path 的后续 reserve/release 不会再重复 ensure 整组 DDL
>
> 除了 LLM runtime guard，这一轮后台任务也补上了 SQLite shared lease：
> - 主模式 simulation 与 Debate background task 当前都会通过 `runtime_lock` 表做跨 worker 防重入
> - 只有当 `DATABASE_URL` 指向同一个 SQLite 文件时，这层 lease 才能跨进程共享
> - 若 `DATABASE_URL = sqlite:///:memory:`、`file:` URI，或根本不是 SQLite，这层锁会退回进程内互斥 fast path；仍能防止同一进程内的重复启动，但不会跨 worker 共享
> - `runtime_lock` 当前也已改成 per-thread SQLite connection reuse，不再每次 `acquire / is_active / release` 都重新 `connect()/close()`
> - Debate background task 当前默认 lease 为 `15 分钟`；simulation 仍按 `MAX_ROUNDS * 180 + 60` 的动态上限计算

## 数据库

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `DATABASE_URL` | str | `sqlite:///<backend-root>/swarmoracle.db` | SQLite 数据库路径；默认锚到 `backend/` 根目录 |
| `CHROMA_PERSIST_DIR` | str | `<backend-root>/chroma_data` | ChromaDB 持久化目录；默认锚到 `backend/` 根目录 |

> 当前实现会把相对本地路径统一解析到 `backend/` 根目录：
> - `DATABASE_URL=sqlite:///./relative-dev.db` → `sqlite:///<backend-root>/relative-dev.db`
> - `CHROMA_PERSIST_DIR=./relative-chroma` → `<backend-root>/relative-chroma`
>
> 这样本地直接在 repo root、`backend/` 目录，或通过 `uvicorn --app-dir ...` 启动时，都不会再因为 cwd 不同命中不同 SQLite / Chroma 数据目录。`test_config.py` 已覆盖这条行为。

> `VectorStore` 当前的 collection cache 也是进程内实现：
> - 走 bounded LRU，默认上限 `128`
> - 这是内部实现细节，不对应环境变量
> - cache 超限时只淘汰内存里的 collection 引用，不会删除 Chroma 持久化数据

> `shared/gameplay_contract.v1.json` 当前走 mtime-aware 缓存：文件未变时复用内存结果，文件更新时间变化后会自动重新读取，不再要求后端重启才能看到新的 contract 内容。

> 当前 Alembic 目录里的最新 revision 文件为 `011_add_agent_group_scenario_index`。其中：
> - `008_add_hot_path_foreign_key_indexes` 补齐大部分热路径外键索引
> - `011_add_agent_group_scenario_index` 额外补上 `AgentGroup.scenario_id` 索引
> - 当前仓库内 `backend/swarmoracle.db` 的 `alembic_version` 仍是 `008_add_hot_path_foreign_key_indexes`

## 服务器

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `HOST` | str | `0.0.0.0` | 监听地址 |
| `PORT` | int | 18927 | 监听端口 |
| `CORS_ORIGINS` | list[str] | `["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]` | CORS允许的源；Docker compose 运行时通常会额外补 `http://127.0.0.1` 与 `http://127.0.0.1:18928` |

> `CORS_ORIGINS` 当前只接受显式 origin 列表：
> - 不能为空
> - 不能包含 `"*"`
>
> 原因是 app 当前启用了 `allow_credentials=True`；继续允许 wildcard 会让配置口径自相矛盾。生产环境应继续维护明确白名单。
