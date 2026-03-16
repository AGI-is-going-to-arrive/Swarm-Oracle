# 配置项参考

所有配置通过环境变量或 `.env` 文件加载（pydantic-settings）。

## LLM 配置

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `LLM_RESPONSES_URL` | str | `http://127.0.0.1:8318/v1/chat/completions` | OpenAI兼容API端点 |
| `LLM_API_KEY` | str | `sk-12345678` | API密钥 |
| `LLM_MODEL_NAME` | str | `gpt-5.1-codex-mini` | 模型名称 |
| `LLM_REASONING_EFFORT` | str | `none` | 推理强度 (`none` / `low` / `medium` / `high`) |

> **BYOK (P4-E)**: 以上 LLM 配置为服务器默认值。用户可在创建场景时通过 `llm_api_key`、`llm_base_url`、`llm_model` 字段覆盖，支持所有 OpenAI 兼容 API。

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
| `LLM_CONCURRENCY` | int | 5 | 并发LLM调用数上限 |

## 数据库

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `DATABASE_URL` | str | `sqlite:///./swarmoracle.db` | SQLite数据库路径 |
| `CHROMA_PERSIST_DIR` | str | `./chroma_data` | ChromaDB持久化目录 |

## 服务器

| 变量 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `HOST` | str | `0.0.0.0` | 监听地址 |
| `PORT` | int | 18927 | 监听端口 |
| `CORS_ORIGINS` | list[str] | `["http://localhost:5173", "http://localhost:9528", "http://localhost:18928"]` | CORS允许的源；Docker compose 运行时通常会额外补 `http://127.0.0.1` 与 `http://127.0.0.1:18928` |
