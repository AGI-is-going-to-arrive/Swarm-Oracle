# 配置项参考

> 作用：汇总当前仍有效的环境变量与运行时调参项。历史实验记录和 session 级结论不再保留在本页。

## 加载规则

- backend 本地直启默认读取 `backend/.env`
- Docker 默认读取仓库根目录 `.env.docker`
- `.env.example` 用于初始化本地模板

## LLM 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_RESPONSES_URL` | `http://127.0.0.1:8317/v1` | OpenAI-compatible endpoint 或 base URL |
| `LLM_API_KEY` | `sk-12345678`（占位） | 默认 provider API key |
| `LLM_MODEL_NAME` | `gpt-5.4-mini` | 默认模型 |
| `LLM_REASONING_EFFORT` | `none` | 推理强度 |
| `LLM_REQUESTS_PER_MINUTE` | `0` | 默认 RPM，`0` 表示不限 |
| `LLM_TOKENS_PER_MINUTE` | `0` | 默认 TPM，`0` 表示不限 |
| `DEBATE_USE_LLM` | `true` | Debate 是否优先走 LLM 文案 |

关键约束：

- 占位 `LLM_API_KEY=sk-12345678` 只允许用于本地网关。
- 非本地端点配合占位 key 会在启动期直接报错。
- `LLM_MODEL_NAME` 不能为空。

## Request-scoped BYOK

前端与部分后端接口支持透传：

- `llm_api_key`
- `llm_base_url`
- `llm_model`
- `llm_requests_per_minute`
- `llm_tokens_per_minute`
- `disable_user_quota`

说明：

- 这些覆盖项只作用于当前请求，不会改写服务端默认值。
- `llm_base_url` 必须通过 hostname allowlist + http(s) scheme 校验；业务入口 (scenario/debate/predictions/social) 要求 `base_url` 必须同时带 `api_key`，否则返回 400 `BYOK_API_KEY_REQUIRED`。`/api/health/test` 是连通性探测，不做此前移拒绝。
- `llm_requests_per_minute / llm_tokens_per_minute` 会覆盖服务端默认 RPM/TPM。触发限流后请求会排队等待下一个窗口（最多等 2 个 rate window），不会立即拒绝。
- `disable_user_quota` 只对本地或 self-hosted provider 生效。

## Scenario 运行时调参

下面这些字段不是环境变量，而是 `POST /api/scenario` 的单局参数：

| 字段 | 范围 | 说明 |
|------|------|------|
| `temperature` | `0.0 - 2.0` | LLM 采样温度 |
| `branch_sensitivity` | `0.0 - 1.0` | fork detector 灵敏度 |
| `fork_prompt_variant` | `a / b / c / d / e / f` | fork detector prompt 档位 |
| `fork_detector_active_branch_limit` | `0 - MAX_BRANCHES` | 每轮允许继续跑 detector 的 active branch 数量 |

前端当前把这组调参收成主模式 `Oracle Profile`：

| 档位 | 默认组合 | 用途 |
|------|----------|------|
| `Watchful / 守望` | `d + 0.7 + k=1` | 更保守 |
| `Calibrated / 校准` | `b + 0.7 + k=1` | 默认推荐 |
| `Riftbound / 裂界` | `b + 0.7 + k=0` | 更激进 |

## 模拟与系统限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MAX_AGENTS` | `1500` | 最大 agent 数 |
| `HIERARCHICAL_AGENT_THRESHOLD` | `50` | 超过阈值自动启用分层模式 |
| `MAX_ROUNDS` | `40` | 最大轮数 |
| `MAX_BRANCHES` | `8` | 最大并行 branch 数 |
| `MEMORY_COMPRESS_INTERVAL` | `5` | 记忆压缩间隔 |
| `BRANCH_PRUNE_THRESHOLD` | `0.05` | 低概率剪枝阈值 |
| `FORK_SENSITIVITY` | `0.7` | 默认 fork 灵敏度 |
| `DEFAULT_NUM_AGENTS` | `20` | 默认 agent 数 |
| `DEFAULT_ROUNDS` | `10` | 默认轮数 |

## 并发与限流

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_CONCURRENCY` | `5` | 进程内 LLM 并发上限 |
| `LLM_MAX_PENDING` | `24` | 全局 pending 上限 |
| `LLM_USER_MAX_PENDING` | `4` | 单用户 pending 上限 |
| `LLM_CIRCUIT_BREAKER_THRESHOLD` | `6` | 连续失败熔断阈值 |
| `LLM_CIRCUIT_BREAKER_RESET_SECONDS` | `30` | 熔断恢复冷却时间 |

说明：

- 多个 backend 进程共用同一个 SQLite 文件时，pending/quota 计数会共享。
- `LLM_CONCURRENCY` 的修改需要重启 backend 才能稳定生效。

## 数据存储

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `sqlite:///<backend-root>/swarmoracle.db` | 主数据库 |
| `CHROMA_PERSIST_DIR` | `<backend-root>/chroma_data` | Chroma 持久化目录 |

说明：

- 相对路径会统一解析到 `backend/` 根目录。
- `VectorStore` 的 collection cache 是进程内 LRU，实现细节不作为环境变量暴露。

## 日志与服务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LOG_LEVEL` | `INFO` | 日志级别 |
| `LOG_FORMAT` | `json` | `json` 或 `plain` |
| `EXPOSE_API_DOCS` | `false` | 是否暴露 `/docs`、`/redoc`、`/openapi.json`。与 `LOG_LEVEL` 独立，生产环境开 DEBUG 日志不会意外暴露 API schema |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `18927` | 监听端口 |
| `CORS_ORIGINS` | 本地开发 origin 列表 | 允许的前端源 |

说明：

- backend 默认输出 JSON 结构化日志。JSON 序列化器会识别带 `__opaque__` 标记的 secret 类型，输出 `"***"` 而非真实值。
- `uvicorn / uvicorn.error / uvicorn.access` 会复用同一套 root formatter。
- `/docs`、`/redoc`、`/openapi.json` 默认不暴露，需显式设置 `EXPOSE_API_DOCS=true` 才可访问。

## Memory 调参

这些变量只用于 backend prompt budgeting 与 context retention，不面向前端用户：

- `MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS`
- `MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS`
- `MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS`
- `MEMORY_CORE_MAX_RECENT`
- `MEMORY_IMPORTANT_MAX_RECENT`
- `MEMORY_CROWD_MAX_RECENT`
- `MEMORY_CORE_CONTEXT_MAX_CHARS`
- `MEMORY_IMPORTANT_CONTEXT_MAX_CHARS`

## Security — Session Gate

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SESSION_SECRET` | `""` (空 = 跳过鉴权) | 设置后所有 REST 端点要求 `X-Session-Token` header，WebSocket 连接要求首帧 auth。未通过则返回 401/4001。 |

说明：

- **这是临时开发态的全局门禁 hardening，不是 owner-aware authorization。**
- 空值时完全跳过鉴权，本地开发零影响。
- 前端通过 `localStorage.swarmoracle_session_token` 存取 token，REST 自动注入 `X-Session-Token` header，WS 在连接建立后发送首帧 `{"type":"auth","token":"..."}` 进行认证。
- WS 首帧 auth 协议：服务端 accept 后等待客户端首帧（10 秒超时，64KB 上限），验证通过后回复 `{"type":"auth_ok"}`，再注册连接并启动 heartbeat。认证失败或超时返回 `close(4001)`。
- 前端对 `4001`（认证失败）和 `4404`（资源不存在）不进行自动重连。
- 不是最终 auth 设计。最终方案需要 JWT/OAuth2 + per-resource ownership + httpOnly cookie。

## Web Search Enhancement (搜索增强推演)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_WEB_SEARCH` | `false` | 总开关，opt-in |
| `WEB_SEARCH_PROVIDER` | `tavily` | 搜索提供商：`tavily` / `exa` / `searxng` / `brave` / `native` |
| `WEB_SEARCH_API_KEY` | `""` | 搜索 API Key（`searxng` 和 `native` 模式不需要） |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG 实例地址（仅 `WEB_SEARCH_PROVIDER=searxng` 时使用） |
| `WEB_SEARCH_MAX_RESULTS` | `5` | 每次搜索最大 snippet 数 |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `8` | 单次搜索超时 |
| `WEB_SEARCH_CACHE_TTL_SECONDS` | `300` | 搜索结果缓存 TTL（5 分钟） |

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_ENABLE_WEB_SEARCH` | `false` | 控制 InputView 搜索增强 toggle 显示 |

说明：

- 搜索在场景创建时执行一次（Round 1 之前），结果存入 `Scenario.web_context_json`。
- 搜索失败不阻断推演（graceful degradation）。
- 前端 toggle 为 opt-in（默认关闭），仅当后端 `ENABLE_WEB_SEARCH=true` 且 `GET /api/capabilities` 返回 `web_search.server_enabled=true` 时显示。注意：该字段报告的是服务端全局配置（`scope: "server"`），不是当前 BYOK provider 的搜索能力。Per-provider 探测属于 V2。
- 详细设计见 `implement/web_search_augmentation_design.md`。

## 相关文件

- 模板：`.env.example`（根目录）
- Docker 模板：`.env.docker`
- 后端配置实现：`backend/app/config.py`
- Web Search 设计稿：`implement/web_search_augmentation_design.md`
