# 配置项参考

所有配置通过环境变量或 `.env` 文件加载（pydantic-settings）。

> 本地后端默认读取 `backend/.env`。`docker compose` 仍使用仓库根目录 `.env`。

## LLM 配置

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_RESPONSES_URL` | str | `http://127.0.0.1:8318/v1/chat/completions` | OpenAI兼容API端点 |
| `LLM_API_KEY` | str | `sk-12345678` | API密钥 |
| `LLM_MODEL_NAME` | str | `gpt-5.4-mini` | 模型名称 |
| `LLM_REASONING_EFFORT` | str | `none` | 推理强度 (`none` / `low` / `medium` / `high`) |
| `DEBATE_USE_LLM` | bool | `true` | Debate Arena 回合文案是否优先走 LLM；关闭时会退回 deterministic 文案 |

> **BYOK (P4-E)**: 以上 LLM 配置为服务器默认值。用户可在创建场景时通过 `llm_api_key`、`llm_base_url`、`llm_model` 字段覆盖，支持所有 OpenAI 兼容 API；当前同一份 provider policy 也已贯通到 `createDebate / social copy / scorePredictions`。

> **Docker 运行提示**: 如果后端在 Docker 容器里，而 LLM 服务跑在宿主机本地，`LLM_RESPONSES_URL` 不能继续写 `127.0.0.1`。本轮真实容器验证使用的是 `http://host.docker.internal:8318/v1/chat/completions`；Linux 请替换成实际可达宿主机的地址。

## 模拟参数

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `MAX_AGENTS` | int | 1500 | 用户可创建的最大agent数（P3-A提升至千人规模） |
| `HIERARCHICAL_AGENT_THRESHOLD` | int | 50 | 超过此数量自动启用分层架构 (P3-A) |
| `MAX_ROUNDS` | int | 40 | 最大模拟轮数 |
| `MAX_BRANCHES` | int | 8 | 最大并行分支数 |
| `MEMORY_COMPRESS_INTERVAL` | int | 5 | 每N轮压缩一次记忆 |
| `BRANCH_PRUNE_THRESHOLD` | float | 0.05 | 概率低于此值的分支被剪枝 |
| `FORK_SENSITIVITY` | float | 0.7 | 分支灵敏度 (0-1) |
| `DEFAULT_NUM_AGENTS` | int | 20 | 用户不传参时默认agent数 (3-100) |
| `DEFAULT_ROUNDS` | int | 10 | 用户不传参时默认模拟轮数 |

## 并发控制

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_CONCURRENCY` | int | 5 | 进程内全局 LLM 并发上限 |
| `LLM_MAX_PENDING` | int | 24 | 全局排队中的 LLM 请求上限；超过后直接返回 backpressure |
| `LLM_USER_MAX_PENDING` | int | 4 | 单个 `user_id` 同时挂起的 LLM 请求上限 |
| `LLM_CIRCUIT_BREAKER_THRESHOLD` | int | 6 | 同一 provider 连续失败达到此阈值后，短时间打开熔断 |
| `LLM_CIRCUIT_BREAKER_RESET_SECONDS` | int | 30 | 熔断打开后的冷却秒数 |

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

## 服务器

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `HOST` | str | `0.0.0.0` | 监听地址 |
| `PORT` | int | 18927 | 监听端口 |
| `CORS_ORIGINS` | list[str] | `["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]` | CORS允许的源；Docker compose 运行时通常会额外补 `http://127.0.0.1` 与 `http://127.0.0.1:18928` |
