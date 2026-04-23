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
- Docker 模板 `.env.docker` 当前指向 `http://host.docker.internal:8317/v1`；如果你本机想改用别的本地兼容网关端口，直接改 `.env.docker` 或 `backend/.env` 即可。

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
- `llm_base_url` 必须通过 hostname allowlist + scheme 校验：
  - 官方托管 host 只接受 `https`
  - 本地开发 host（如 `localhost / 127.0.0.1 / 0.0.0.0 / host.docker.internal / ::1`）才允许 `http`
  - 业务入口 (scenario/debate/predictions/social) 要求 `base_url` 必须同时带 `api_key`，否则返回 400 `BYOK_API_KEY_REQUIRED`
  - `/api/health/test` 是连通性探测，不走业务入口这条 `base_url + api_key` 绑定约束
- `llm_requests_per_minute / llm_tokens_per_minute` 会覆盖服务端默认 RPM/TPM。触发限流后请求会排队等待下一个窗口（最多等 2 个 rate window），不会立即拒绝。
- `disable_user_quota` 只对本地或 self-hosted provider 生效；它只移除单用户公平队列这一层，不会绕过全局并发、全局 pending、lane 隔离或 RPM/TPM 等待。

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

补充：

- `continuity_overrides` 也是 `POST /api/scenario` 的单局字段，不是环境变量。
- 正常前端链路里，它来自 `POST /api/agents/identities/preflight` 之后的用户确认结果。

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
- agent conversation 的 `user / org` daily quota 当前也走 SQLite 持久化 ledger：
  - backend 重启后不会归零
  - 多进程会共享同一份 rolling 24h 计数
  - 删除 scenario / thread 不会把已消耗额度返还
- `LLM_CONCURRENCY` 当前会叠加全局并发和按用途的 lane 隔离；scenario fan-out 不会再独占 Oracle / Debate / parse / background 的全部 slot。
- `LLM_CONCURRENCY` 的修改需要重启 backend 才能稳定生效。
- `LLM_CONCURRENCY / LLM_MAX_PENDING / LLM_USER_MAX_PENDING` 设为 `<= 0` 时表示关闭对应限制，不是字面上的 `0 并发 / 0 pending`。

## 数据存储

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATABASE_URL` | `sqlite:///<backend-root>/swarmoracle.db` | 主数据库 |
| `CHROMA_PERSIST_DIR` | `<backend-root>/chroma_data` | Chroma 持久化目录 |

说明：

- 普通文件路径形式的相对 `DATABASE_URL` 会统一解析到 `backend/` 根目录。
- `DATABASE_URL` 如果使用 SQLite URI 形式（例如 `sqlite:///file:/tmp/swarmoracle.db?uri=true`），当前会原样保留，不会再被路径规范化改写。
- 当 `DATABASE_URL` 指向同一个 file-backed SQLite 文件时，runtime lock 会共享；这条口径既适用于普通 SQLite 文件路径，也适用于 `sqlite:///file:/...?...uri=true`。
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
| `SESSION_SECRET` | `""` (空 = 跳过鉴权) | 设置后所有业务 REST 端点要求 `X-Session-Token` header，WebSocket 连接要求首帧 auth。未通过则返回 401/4001。 |

说明：

- **这是临时开发态的全局门禁 hardening，不是 owner-aware authorization。**
- 空值时完全跳过鉴权，本地开发零影响。
- 前端通过 `localStorage.swarmoracle_session_token` 存取 token，所有业务 REST 调用（包括原生 `fetch('/api/...')` 页面）都会自动注入 `X-Session-Token` header，WS 在连接建立后发送首帧 `{"type":"auth","token":"..."}` 进行认证。
- `X-Session-Token` 当前支持两种形态：
  - 裸 `SESSION_SECRET`：只提供门禁，不携带 caller principal。
  - signed principal token：格式 `v1.<payload>.<signature>`，payload 至少包含 `sub`（user_id），由 `SESSION_SECRET` 做 HMAC-SHA256 验签。
- ownership-sensitive 接口（当前至少包括 agent identity / workshop，以及按 `user_id` 读取的 campaign profile 系列）在 `SESSION_SECRET` 开启时要求 signed principal token；裸 secret 只够通过一般业务门禁，不够声明调用者身份。
- WS 首帧 auth 协议：服务端 accept 后等待客户端首帧（10 秒超时，64KB 上限），验证通过后回复 `{"type":"auth_ok"}`，再注册连接并启动 heartbeat。认证失败或超时返回 `close(4001)`。
- 前端对 `4001`（认证失败）和 `4404`（资源不存在）不进行自动重连。
- 当前显式例外是 app 级非业务端点，如 `/` 和 `/metrics`；挂在业务 router 下的 `/api/capabilities`、`/api/health`、`/api/health/test` 也受此门禁约束。
- 不是最终 auth 设计。最终方案需要 JWT/OAuth2 + per-resource ownership + httpOnly cookie。

## Web Search Enhancement (搜索增强推演)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_WEB_SEARCH` | `false` | 总开关，opt-in |
| `WEB_SEARCH_PROVIDER` | `tavily` | 服务端默认搜索 provider：`tavily` / `exa` / `xai` / `searxng` |
| `WEB_SEARCH_API_KEY` | `""` | 服务端默认搜索 API Key（`searxng` 不需要） |
| `XAI_WEB_SEARCH_MODEL` | `grok-4.20-reasoning` | `xai` provider 使用的模型 |
| `XAI_WEB_SEARCH_TIMEOUT_SECONDS` | `45` | `xai` provider 独立超时 |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG 基址（`WEB_SEARCH_PROVIDER=searxng` 时使用） |
| `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST` | `us` | `Polymarket` source family 的当前 host hint；只接受 `us / non-us` |
| `WEB_SEARCH_MAX_RESULTS` | `5` | 每次搜索最大 snippet 数 |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `8` | `tavily / exa / searxng` 单次搜索超时 |
| `WEB_SEARCH_CACHE_TTL_SECONDS` | `300` | 搜索结果缓存 TTL（5 分钟） |

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_ENABLE_WEB_SEARCH` | `false` | 控制 InputView 搜索增强 toggle 显示 |

说明：

- 搜索在场景创建时执行一次（Round 1 之前），结果存入 `Scenario.web_context_json`。
- 搜索失败不阻断推演（graceful degradation）。
- 前端 toggle 为 opt-in（默认关闭）。当前只要 `VITE_ENABLE_WEB_SEARCH=true` 就会显示，不再要求服务端默认搜索已就绪。
- `GET /api/capabilities` 的 `web_search` 字段当前只表达服务端默认搜索是否 ready（`scope: "server"`）：
  - ready 时，首页可选 `沿用服务器默认`
  - not ready 时，首页仍可选 `自定义覆盖`
- 首页搜索增强当前有两档：
  - `沿用服务器默认`：只发送 `web_search_enabled=true`
  - `自定义覆盖`：额外发送 `web_search_provider / web_search_api_key / web_search_base_url`
- 首页 4 个 source family toggle 当前会跟着 `web_search_enabled=true` 一起透传成 `web_search_families`。
- request-scoped override 当前约束：
  - `web_search_enabled=false` 时，override 字段会被忽略
  - 如果 custom override 的 provider 与服务端默认 provider 不同，留空不会复用服务端默认 key，需要显式填写该 provider 的 key
  - 官方 provider 的 `web_search_base_url` 当前只接受 `https`
  - `searxng` 的 `web_search_base_url` 只接受和 `SEARXNG_URL` 完全一致的基址
- `FEATURE_NEW_SOURCES=true` 且搜索成功时，后端会把同一份 live snippets 投影成 `web_search_context.family_context`：
  - 被选中的 family 才会变成 `ready`
  - 未选中的 family 会保持 `empty`
  - `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us` 时，`polymarket` 会显式带上 geo-gated 口径
- 详细设计见 `implement/web_search_augmentation_design.md`。

## Phase 3 功能开关

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEATURE_CUSTOM_AGENTS` | `false` | 启用自建 Agent workshop CRUD |
| `FEATURE_AGENT_IDENTITY` | `false` | 启用跨场景身份解析 + 记忆查询 |
| `FEATURE_CAUSAL_GRAPH` | `false` | 启用因果图谱 API + simulator 逐轮写入 |
| `FEATURE_COUNTERFACTUAL_REPLAY` | `true` | 启用反事实回溯 + 分支比较 + 检查点 |
| `FEATURE_FACTIONS` | `false` | 启用阵营检测 + 时间线 API |
| `FEATURE_ARGUMENT_MAP` | `false` | 启用辩论论证图谱抽取 + API |
| `FEATURE_REPLAY_TRACE` | `false` | 启用 replay branch lineage API：`GET /api/scenario/{id}/replay-trace` |
| `FEATURE_AGENT_CONVERSATION` | `false` | 启用图谱节点对话 REST API 与 `/turn` SSE |
| `FEATURE_KG_EXPLORER` | `false` | 启用 KG Explorer / Timeline Galaxy 的 capability gate；图谱数据仍读取 causal graph API |
| `ARGUMENT_MAP_LLM_ENRICHMENT` | `true` | Argument map 在 rule-based 抽取后，默认追加每个 debate turn 一次 fire-and-forget LLM enrichment；设为 `false` 可退回纯规则模式 |

说明：

- `FEATURE_COUNTERFACTUAL_REPLAY` 当前默认开启，其余 Phase 3 功能默认关闭，可通过环境变量逐个启用。
- 本地直启 backend 时，在 `backend/.env` 里设置这些变量并重启 backend 后生效。
- 仓库根 `.env.docker` 当前已经把 `FEATURE_CAUSAL_GRAPH / FEATURE_FACTIONS / FEATURE_ARGUMENT_MAP` 打开，Docker 评审栈默认就是图谱开启态。
- `ARGUMENT_MAP_LLM_ENRICHMENT` 只影响 argument map 的 enrich 路径，不改变 `FEATURE_ARGUMENT_MAP` 的开关语义；只有 argument map 功能启用时它才会生效。
- `FEATURE_*=false` 时：受后端 gate 的 API 返回 404；simulator/debate 中的 hook 不执行；前端通过 `GET /api/capabilities` 检测到 `enabled=false` 后隐藏入口且不发请求。`FEATURE_KG_EXPLORER` 属于前端 capability gate，数据仍由 causal graph API 提供。
- 这些开关互相独立，可单独开启任意功能。

## 相关文件

- 模板：`.env.example`（根目录）
- Docker 模板：`.env.docker`
- 后端配置实现：`backend/app/config.py`
- Web Search 设计稿：`implement/web_search_augmentation_design.md`
