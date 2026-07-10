[English](CONFIGURATION.en.md) | 中文

# SwarmOracle 配置说明

## 1. 配置来源与优先级

- 本地开发：复制 `.env.example` 到 `backend/.env`，编辑 `backend/.env`。
- Docker：复制 `.env.docker.example` 到 `.env.docker`，Compose 自动读取。
- `.env.example` 是公开默认值的权威；开发机上的 `backend/.env` 不是公开默认。
- 未列出的运行时和报告调优项，以模板注释和 `backend/app/config.py` 为准。

环境变量修改后需要重启后端。前端通过 `/api/capabilities` 读取实际能力。

## 2. 运行路径

| 路径 | 需要真实 LLM | 用途 |
|---|---:|---|
| Snapshot 演示 | 否 | 导入 `samples/snapshots/*.swarm`，查看已保存结果与 replay |
| 实时生成 | 是 | 新建推演、辩论、会客厅、报告和其它 LLM 功能 |
| Docker 本机部署 | 视用途 | 默认只发布到 `127.0.0.1:18927` / `127.0.0.1:18928` |
| 生产或公网部署 | 是 | 还必须配置生产安全门禁 |

占位 endpoint 和占位 key 能启动 Snapshot 演示，但会让 `llm_static_configured=false`。只有同时没有带 key 的 model profile、且本轮未提供 BYOK 时，才不能开始实时生成。

## 3. LLM 配置

公开模板当前值：

| 变量 | `.env.example` 默认 | 含义 |
|---|---|---|
| `LLM_RESPONSES_URL` | `http://127.0.0.1:8317/v1` | OpenAI-compatible Base URL |
| `LLM_API_KEY` | `your-api-key-here` | 占位 key；非本地 endpoint 必须换成真实 key |
| `LLM_MODEL_NAME` | `gpt-5.4-mini` | provider 的实际模型 ID |
| `LLM_REASONING_EFFORT` | `none` | `none/low/medium/high` |
| `LLM_REQUESTS_PER_MINUTE` | `0` | `0` 表示不设置 RPM 限制 |
| `LLM_TOKENS_PER_MINUTE` | `0` | `0` 表示不设置 TPM 限制 |
| `LLM_CONCURRENCY` | `5` | 全局并发上限；`0` 关闭该上限 |
| `LLM_MAX_PENDING` | `24` | 全局等待队列上限；`0` 关闭该保护 |
| `LLM_USER_MAX_PENDING` | `4` | 单用户等待上限；`0` 关闭该保护 |

服务端默认模型由以上变量决定。不要把某台机器的临时模型名、地址或 key 写成项目默认。模型 ID 必须由你的 provider 实际支持。

## 4. Model Profile 与 BYOK

`/admin/setup` 可测试连接并保存 model profile；`/model-profiles` 可管理 provider、Base URL、模型、key、限速、并发和能力覆盖。带 key 的 profile 会参与 `llm_configured` 判断。

首页的 **高级设置** 与 **BYOK** 是两个独立折叠区。BYOK 只覆盖当前请求；高级设置负责推演、显示、主题包和搜索选项。请求级 Base URL 必须与 API key 一起提交，不能把凭据放进 URL。

请求级 BYOK 的 host 控制：

- `LLM_EXTRA_ALLOWED_HOSTS`：额外 host 白名单，只接受 host，不接受完整 URL。
- `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false`：默认拒绝通过额外白名单加入的 private/LAN host；它不控制内置本地别名。
- `LLM_ALLOW_LOCAL_BYOK_HOSTS=true`：控制 `localhost`、loopback 等内置本地别名；多用户、LAN 或公网部署应改为 `false`。

完整 SSRF 与凭据边界见 [SECURITY.md](../SECURITY.md)。

## 5. 搜索增强

app-layer 搜索默认关闭：

| 变量 | 默认 | 说明 |
|---|---:|---|
| `ENABLE_WEB_SEARCH` | `false` | 外部搜索总开关 |
| `WEB_SEARCH_PROVIDER` | `tavily` | `tavily/exa/firecrawl/xai/searxng` |
| `WEB_SEARCH_API_KEY` | 空 | 托管 provider 的 key |
| `SEARXNG_URL` | `http://localhost:8888` | 自建 SearXNG 地址 |
| `FEATURE_NEW_SOURCES` | `false` | 来源家族筛选 |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | `false` | 来源查询词优化 |

模型原生搜索属于 model profile / Responses adapter 路径，不通过 `WEB_SEARCH_PROVIDER=native` 开启。结果页只展示真实返回的 citations。

## 6. 功能开关

`.env.example` 默认开启主要用户功能，包括：

- Agent 与身份：`FEATURE_CUSTOM_AGENTS`、`FEATURE_AGENT_IDENTITY`、`FEATURE_PERSONA_EXPORT`
- 图谱与 replay：`FEATURE_CAUSAL_GRAPH`、`FEATURE_GRAPH_ANALYSIS`、`FEATURE_COUNTERFACTUAL_REPLAY`、`FEATURE_KG_EXPLORER`、`FEATURE_REPLAY_TRACE`
- 结果与协作：`FEATURE_RESULT_VERDICT`、`FEATURE_RESULT_REPORT`、`FEATURE_AGENT_CONVERSATION`、`FEATURE_ROUNDTABLE_SURVEY`、`FEATURE_ROUNDTABLE_ANALYST`
- 其它入口：`FEATURE_SNAPSHOT_EXPORT`、`FEATURE_PREDICTION_JOURNAL`、`FEATURE_EDUCATION_TEMPLATES`、`FEATURE_LOCAL_PACKS`、`FEATURE_MODEL_PROFILES`、`FEATURE_MULTI_RUN`

类别与路由见 [FEATURES.md](FEATURES.md)。默认值变化时，以 `.env.example` 与运行中的 `/api/capabilities` 为准。

## 7. 服务与数据

| 变量 | 默认 | 说明 |
|---|---|---|
| `ENV` | `development` | `production/prod` 启用生产 fail-fast |
| `HOST` | `127.0.0.1` | 后端监听地址 |
| `PORT` | `18927` | 后端端口 |
| `DATABASE_URL` | `sqlite:///./swarmoracle.db` | SQLite |
| `CHROMA_PERSIST_DIR` | `./chroma_data` | 向量数据 |
| `CORS_ORIGINS` | 模板列表 | 允许的前端来源 |

前端开发服务器使用 `18928`，默认把 `/api` 与 `/ws` 代理到 `http://127.0.0.1:18927`；可用 `SWARM_BACKEND_URL` 覆盖。Docker 把数据库和 ChromaDB 放进 `/data` volume。

## 8. 生产部署

Docker Compose 默认只绑定 loopback。改成 LAN 或公网绑定前：

```bash
openssl rand -hex 32
```

分别生成并设置唯一的 `SESSION_SECRET` 和 `ADMIN_TOKEN`，同时设置 `ENV=production`。生产模式缺少任一密钥会拒绝启动。不要复用示例值；不要在日志、文档、URL 或分享 artifact 中放入密钥。

`SESSION_SECRET`、`ADMIN_TOKEN`、管理端点、`/metrics` 与多用户限制的权威说明见 [SECURITY.md](../SECURITY.md)。

## 9. 高级调优

推演上限、memory、runtime lock、stall timeout、报告预算和 `REPORT_*` 参数不在这里复制。需要调优时直接阅读 `.env.example` 的注释，改动后先运行 `make preflight`。
