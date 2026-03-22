# 配置项参考

所有配置通过环境变量或 `.env` 文件加载（pydantic-settings）。

> 本地后端默认读取 `backend/.env`。`docker compose` 默认使用仓库根目录 `.env.docker`。

## LLM 配置

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_RESPONSES_URL` | str | `http://127.0.0.1:8318/v1/chat/completions` | OpenAI兼容API端点；Docker 默认模板 `.env.docker` 会改写成 `http://host.docker.internal:8318/v1/chat/completions` |
| `LLM_API_KEY` | str | `sk-12345678` | API密钥 |
| `LLM_MODEL_NAME` | str | `gpt-5.4-mini` | 模型名称 |
| `LLM_REASONING_EFFORT` | str | `none` | 推理强度 (`none` / `low` / `medium` / `high`) |
| `DEBATE_USE_LLM` | bool | `true` | Debate Arena 回合文案是否优先走 LLM；关闭时会退回 deterministic 文案 |

> **BYOK (P4-E)**: 以上 LLM 配置为服务器默认值。用户可在创建场景时通过 `llm_api_key`、`llm_base_url`、`llm_model` 字段覆盖，支持所有 OpenAI 兼容 API；当前同一份 provider policy 也已贯通到 `createDebate / social copy / scorePredictions`。

> **启动期校验**:
> - 占位 `LLM_API_KEY = sk-12345678` 当前只允许用于本地 LLM 网关（如 `localhost / 127.0.0.1 / host.docker.internal`）
> - 若 `LLM_RESPONSES_URL` 指向非本地端点，配置加载阶段就会拒绝占位 key，而不是等到第一次 LLM 调用才失败
> - `LLM_MODEL_NAME` 当前不能为空；空白值会在配置加载阶段直接报错

> **Docker 运行提示**: 如果后端在 Docker 容器里，而 LLM 服务跑在宿主机本地，`LLM_RESPONSES_URL` 不能继续写 `127.0.0.1`。仓库默认 Docker 模板 `.env.docker` 已改成 `http://host.docker.internal:8318/v1/chat/completions`；同时 compose 会给 backend 注入 `host.docker.internal:host-gateway`。Linux 如需覆盖，改 `.env.docker` 即可。

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

## 并发控制

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_CONCURRENCY` | int | 5 | 进程内全局 LLM 并发上限；当前 semaphore 在进程启动后固定，修改该值需重启进程才能稳定生效 |
| `LLM_MAX_PENDING` | int | 24 | 全局排队中的 LLM 请求上限；超过后直接返回 backpressure |
| `LLM_USER_MAX_PENDING` | int | 4 | 单个 `user_id` 同时挂起的 LLM 请求上限 |
| `LLM_CIRCUIT_BREAKER_THRESHOLD` | int | 6 | 同一 provider 连续失败达到此阈值后，短时间打开熔断 |
| `LLM_CIRCUIT_BREAKER_RESET_SECONDS` | int | 30 | 熔断打开后的冷却秒数 |

> 当前 LLM runtime guard 有两层：
> - 进程内 `Semaphore + circuit breaker`
> - 当 `DATABASE_URL` 指向同一个 SQLite 文件时，`LLM_MAX_PENDING / LLM_USER_MAX_PENDING` 还会通过 SQLite 共享 reservation 做跨进程计数
>
> 也就是说：
> - `LLM_CONCURRENCY` 当前不会在运行时安全热更新；若配置变更，应该重启 backend 进程
> - 同一台机器上多个 backend 进程共用同一个 SQLite 文件时，pending 配额会共享
> - 当 SQLite reservation 可用时，它就是 pending / quota 计数的单一真相源；进程内 fallback 计数不会再额外叠加
> - provider 熔断与单进程内 `Semaphore` 仍是进程本地行为，不会跨进程同步
> - `llm_call / llm_call_stream` 当前会复用进程内共享 `httpx.AsyncClient`，并在 app shutdown 时统一关闭
> - `llm_call_stream` 当前只会在首个内容片段产出前做连接/起始响应重试，避免已经开始输出后重复发送流片段
>
> 除了 LLM runtime guard，这一轮后台任务也补上了 SQLite shared lease：
> - 主模式 simulation 与 Debate background task 当前都会通过 `runtime_lock` 表做跨 worker 防重入
> - 只有当 `DATABASE_URL` 指向同一个 SQLite 文件时，这层 lease 才能跨进程共享
> - 若 `DATABASE_URL = sqlite:///:memory:`、`file:` URI，或根本不是 SQLite，这层锁会退回进程内互斥 fast path；仍能防止同一进程内的重复启动，但不会跨 worker 共享

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

> 当前 Alembic 最新 revision 为 `008_add_hot_path_foreign_key_indexes`，用于补齐热路径外键索引。

## 服务器

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `HOST` | str | `0.0.0.0` | 监听地址 |
| `PORT` | int | 18927 | 监听端口 |
| `CORS_ORIGINS` | list[str] | `["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]` | CORS允许的源；Docker compose 运行时通常会额外补 `http://127.0.0.1` 与 `http://127.0.0.1:18928` |
