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
| `DEBATE_USE_LLM` | `true` | Debate 是否优先走 LLM 生成；开启后会尝试生成角色 name/role/persona、turn、judge、phase insight 和 supporting-turn reason，失败时回退 deterministic copy |

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
- Debate 路径会把 request-scoped override 透传到本场内部 LLM 调用；包括 persona generation、turn generation、judge analysis、phase insight rewrite、supporting-turn reason 和 argument-map enrichment。

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
- `POST /api/agents/identities/preflight` 的解析阶段有固定 10 秒超时；超时返回 `504 IDENTITY_PREFLIGHT_TIMEOUT`，不是通过环境变量配置。
- identity profile 写入 Chroma 时，调用方最多等待 5 秒；写入本身是 best-effort，并受单进程 pending gate、SQLite runtime lock 和本地 Chroma lock 保护。`CHROMA_PERSIST_DIR` 仍只配置持久化目录，不配置这些锁和超时参数。

## 日志与服务

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENV` | `development` | 运行环境标记；`production` 时 `/api/admin/test-llm` 不允许测试本地 LLM base URL |
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
| `ADMIN_TOKEN` | `""` (空 = 不额外保护 admin API) | 设置后 `/api/admin/*` 除 session gate 外，还要求匹配的 `X-Admin-Token` header；失败返回 403 `ADMIN_TOKEN_REQUIRED`。 |

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
- `ADMIN_TOKEN` 只收紧 `/api/admin/*`，不改变普通业务 REST 或 WebSocket 的 session gate 语义。
- 不是最终 auth 设计。最终方案需要 JWT/OAuth2 + per-resource ownership + httpOnly cookie。

## Web Search Enhancement (搜索增强推演)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_WEB_SEARCH` | `false` | 总开关，opt-in |
| `WEB_SEARCH_PROVIDER` | `tavily` | 服务端默认 app-layer 搜索 provider：`tavily` / `exa` / `xai` / `searxng`；`native` 只保留 legacy 配置兼容，不代表 app-layer provider 已实现 |
| `WEB_SEARCH_API_KEY` | `""` | 服务端默认搜索 API Key（`searxng` 不需要） |
| `XAI_WEB_SEARCH_MODEL` | `grok-4.20-reasoning` | `xai` provider 使用的模型 |
| `XAI_WEB_SEARCH_TIMEOUT_SECONDS` | `45` | `xai` provider 独立超时 |
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG 基址（`WEB_SEARCH_PROVIDER=searxng` 时使用） |
| `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST` | `us` | `Polymarket` source family 的当前 host hint；只接受 `us / non-us` |
| `WEB_SEARCH_MAX_RESULTS` | `5` | 每次搜索最大 snippet 数 |
| `WEB_SEARCH_TIMEOUT_SECONDS` | `8` | `tavily / exa / searxng` 单次搜索超时 |
| `WEB_SEARCH_CACHE_TTL_SECONDS` | `300` | 搜索结果缓存 TTL（5 分钟） |
| `NATIVE_SEARCH_MAX_TOOL_CALLS` | `5` | 单次 LLM native search 调用允许的最大 web-search tool call 数；超过会 fail-closed |
| `NATIVE_SEARCH_MAX_CITATIONS` | `50` | 单次 LLM native search 最多保留的 citation 数；超过会截断 |

前端环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VITE_ENABLE_WEB_SEARCH` | `false` | 旧编译期开关；InputView 当前默认显示搜索增强入口，不再靠它决定入口是否出现 |

说明：

- 搜索在场景创建时执行一次（Round 1 之前），结果存入 `Scenario.web_context_json`。
- 搜索失败不阻断推演（graceful degradation）。
- LLM native search 不由 `WEB_SEARCH_PROVIDER=native` 开启；当前只在 `llm_call(native_search_domains=...)` 且 provider 被识别为支持 native search 的非 proxy Responses API 路径下启用。`native` 只是 app-layer legacy placeholder，不应当作为用户可配置的搜索 provider 讲解。未知 proxy、malformed URL、非 http(s) URL 或 chat endpoint 不会注入 native tools。
- Native search citations 会写入 `web_context_json.native_citations`，但只保留安全的 `http/https` URL。
- xAI app-layer 搜索的 `web_search_base_url` 官方托管地址只接受 `https://api.x.ai/v1/responses`；非 production 下允许 localhost / 127.0.0.1 / ::1 这类本地 xAI-compatible Responses proxy 做实测。
- SearXNG 不需要搜索 API key，但需要一个可访问的 SearXNG 实例；可以是本地 Docker / 自建服务 / 公共实例。公共实例只适合实验：可能没有启用 JSON API、被限流、返回空结果或临时下线，不能作为稳定发布能力或免费额度承诺。
- 前端 toggle 为 opt-in（默认关闭）。InputView 当前默认显示搜索增强入口，不再要求 `VITE_ENABLE_WEB_SEARCH=true` 或服务端默认搜索已就绪。
- 首页搜索深度不是环境变量，是 `POST /api/scenario` 的单局字段 `web_search_intensity`，前端会保存在 `localStorage`：
  - `light`：抓取 3 条结果，并向 prompt 注入 3 条 snippet
  - `standard`：抓取 5 条结果，并向 prompt 注入 5 条 snippet
  - `deep`：抓取 10 条结果，并向 prompt 注入 8 条 snippet
  - 未传或本地存储值非法时回到 `standard`
- `GET /api/capabilities` 的 `web_search` 字段当前只表达服务端默认搜索是否 ready（`scope: "server"`）：
  - ready 时，首页默认展示 `推荐：使用已配置搜索`
  - not ready 时，首页仍可选 `高级：使用我的搜索服务`
  - `provider_capability` 描述当前服务端默认 provider 是否支持 domain filter 和 sources；它不是每个 custom override provider 的实时探测结果
- 首页搜索增强当前有两档：
  - `推荐：使用已配置搜索`：只发送 `web_search_enabled=true`，普通用户推荐使用这条路径
  - `高级：使用我的搜索服务`：额外发送 `web_search_provider / web_search_api_key / web_search_base_url`
- 自定义覆盖下，前端会先从可识别的 `web_search_base_url` 推断 capability；base URL 为空时使用下拉选择的 provider capability，和后端默认 endpoint 解析保持一致；只有非空且未知的 host 才会显示 no-provider warning。
- 首页 4 个 source family toggle 只有在 `web_search_enabled=true` 且当前 provider capability 支持 domain filter 时，才会透传成 `web_search_families`；关闭搜索或 capability 不支持时会清空选择。
- request-scoped override 当前约束：
  - `web_search_enabled=false` 时，override 字段会被忽略
  - `web_search_intensity` 只接受 `light / standard / deep`；关闭搜索时会被忽略
  - 如果 custom override 的 provider 与服务端默认 provider 不同，留空不会复用服务端默认 key，需要显式填写该 provider 的 key
  - 官方 provider 的 `web_search_base_url` 当前只接受 `https`
  - `searxng` 的 `web_search_base_url` 只接受和 `SEARXNG_URL` 完全一致的基址
- `FEATURE_NEW_SOURCES=true` 且选中了 family 时，后端会为 base search 和 family search 分开执行。`family_context` 当前可能出现：
  - `ready`：该 family 有通过 URL 后过滤的结果
  - `empty`：未选中或搜索后没有可用结果
  - `failed`：该 family 搜索异常
  - `unsupported_provider`：当前 provider 不支持 domain filter
  - `NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us` 时，`polymarket` 会显式带上 geo-gated 口径
- `search_skipped` 当前会在 provider 429 / rate limit 时写出；历史 payload 解析还保留 `loading / rate_limited / network_error / fallback_unconstrained` 白名单。前端会为这些扩展状态显示专门文案，后端 `status_reason` 会作为说明进入卡片。
- 未引入 no-key HTML scraping provider。Google / Bing / Baidu 搜索页解析这类方案稳定性和合规风险高，当前只作为产品研究风险项记录，不在 app-layer provider 列表中暴露。
- 详细设计见 `implement/web_search_augmentation_design.md`。

## Phase 3 功能开关

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEATURE_CUSTOM_AGENTS` | `false` | 启用自建 Agent workshop CRUD、主推演自建 Agent 注入，以及 Debate `custom_agent_ids` 绑定 |
| `FEATURE_AGENT_IDENTITY` | `false` | 启用跨场景身份解析 + 记忆查询 |
| `FEATURE_PREDICTION_JOURNAL` | `false` | 启用个人预测日志、resolve 与校准数据 API |
| `FEATURE_RESULT_VERDICT` | `true` | 启用 Result Quality verdict generation、branch question-answer 持久化、`/api/capabilities.result_verdict` 与 story extra fields |
| `FEATURE_HALLUCINATION_GATE` | `false` | 启用 verdict 后的 hallucination warning metadata；只告警，不阻断生成 |
| `HALLUCINATION_GATE_THRESHOLD` | `0.75` | Hallucination Gate 的 claim verified 阈值，范围 `0..1`；只影响 metadata，不阻断 verdict |
| `FEATURE_EDUCATION_TEMPLATES` | `false` | 启用教育模板 API，并让前端首页显示模板选择器 |
| `FEATURE_PERSONA_EXPORT` | `false` | 启用 persona 单个 / 批量导出与 JSON 导入 API |
| `FEATURE_CAUSAL_GRAPH` | `false` | 启用因果图谱 API + simulator 逐轮写入 |
| `FEATURE_GRAPH_ANALYSIS` | `false` | 启用 `GET /api/scenario/{id}/graph-analysis`；实际对外 enabled 还要求 `FEATURE_CAUSAL_GRAPH=true` |
| `FEATURE_COUNTERFACTUAL_REPLAY` | `true` | 启用反事实回溯 + 分支比较 + 检查点 |
| `FEATURE_FACTIONS` | `false` | 启用阵营检测 + 时间线 API |
| `FEATURE_ARGUMENT_MAP` | `false` | 启用辩论论证图谱抽取 + API |
| `FEATURE_REPLAY_TRACE` | `false` | 启用 replay branch lineage API：`GET /api/scenario/{id}/replay-trace` |
| `FEATURE_AGENT_CONVERSATION` | `false` | 启用图谱节点对话 REST API 与 `/turn` SSE |
| `FEATURE_ROUNDTABLE_SURVEY` | `false` | 启用圆桌问卷 SSE 端点：`POST /api/scenario/{id}/survey` |
| `FEATURE_ROUNDTABLE_ANALYST` | `false` | 启用圆桌 ReACT 分析师 SSE 端点：`POST /api/scenario/{id}/analyst` |
| `FEATURE_KG_EXPLORER` | `false` | 启用 KG Explorer / Timeline Galaxy 的 capability gate；图谱数据仍读取 causal graph API |
| `FEATURE_SNAPSHOT_EXPORT` | `false` | 启用 scenario ZIP snapshot 导出/导入 API，并让前端显示首页导入和结果页导出入口 |
| `ARGUMENT_MAP_LLM_ENRICHMENT` | `true` | Argument map 在 rule-based 抽取后，默认追加每个 debate turn 一次 fire-and-forget LLM enrichment；设为 `false` 可退回纯规则模式 |

说明：

- `FEATURE_COUNTERFACTUAL_REPLAY` 和 `FEATURE_RESULT_VERDICT` 当前默认开启，其余 Phase 3 功能默认关闭，可通过环境变量逐个启用。
- 本地直启 backend 时，在 `backend/.env` 里设置这些变量并重启 backend 后生效。
- 仓库根 `.env.docker` 当前已经把 `FEATURE_CAUSAL_GRAPH / FEATURE_FACTIONS / FEATURE_ARGUMENT_MAP` 打开，Docker 评审栈默认就是图谱开启态。
- `ARGUMENT_MAP_LLM_ENRICHMENT` 只影响 argument map 的 enrich 路径，不改变 `FEATURE_ARGUMENT_MAP` 的开关语义；只有 argument map 功能启用时它才会生效。
- `FEATURE_*=false` 时：受后端 gate 的 API 通常返回 404；simulator/debate 中的 hook 不执行；前端通过 `GET /api/capabilities` 检测到 `enabled=false` 后隐藏入口且不发请求。`POST /api/debate` 如果显式带了 `custom_agent_ids` 且 `FEATURE_CUSTOM_AGENTS=false`，当前返回 400，避免调用方误以为 custom Agent 已参与本场 debate。`FEATURE_KG_EXPLORER` 属于前端 capability gate，数据仍由 causal graph API 提供。`FEATURE_RESULT_VERDICT=false` 是字段级开关：不生成/回显 Result Quality verdict 和 branch question-answer，不让 story endpoint 变成 404。
- `FEATURE_HALLUCINATION_GATE` 当前不是前端 capability key；它只控制后端 verdict 后处理是否附加 claims / evidence / warning metadata。`HALLUCINATION_GATE_THRESHOLD` 只改变 claim 的 verified 判定阈值。
- `FEATURE_ROUNDTABLE_SURVEY / FEATURE_ROUNDTABLE_ANALYST` 会通过 `GET /api/capabilities` 暴露为 `roundtable_survey / roundtable_analyst`，供前端 capability gate 判断入口是否开放。
- `FEATURE_SNAPSHOT_EXPORT` 会通过 `GET /api/capabilities` 暴露为 `snapshot_export`，关闭时后端 snapshot API 返回 404，前端不显示 import/export 入口。
- `FEATURE_EDUCATION_TEMPLATES / FEATURE_PERSONA_EXPORT / FEATURE_PREDICTION_JOURNAL` 会通过 `GET /api/capabilities` 暴露为 `education_templates / persona_export / prediction_journal`。
- `FEATURE_RESULT_VERDICT` 会通过 `GET /api/capabilities` 暴露为 `result_verdict`，并控制结果页是否读取 story verdict 字段。
- 这些开关大多可单独开启；`graph_analysis` 的 capability 需要 `FEATURE_GRAPH_ANALYSIS` 和 `FEATURE_CAUSAL_GRAPH` 同时为 true。

## 相关文件

- 模板：`.env.example`（根目录）
- Docker 模板：`.env.docker`
- 后端配置实现：`backend/app/config.py`
- Web Search 设计稿：`implement/web_search_augmentation_design.md`
