[English](CONFIGURATION.en.md) | 中文

# SwarmOracle 配置说明

所有配置都通过环境变量提供。两个模板：

- **本地开发**：把 `.env.example` 复制成 `backend/.env`，编辑 `backend/.env`（注意：直接改 `.env.example` 不会生效，它只是模板）。
- **Docker 部署**：编辑 `.env.docker`，`docker compose` 会自动读取。

下面只列**面向用户**的常用配置；更细的调优项见模板文件里的注释。

最低浏览器要求：Chrome/Edge >= 111、Firefox >= 113、Safari/iOS >= 16.2（支持 oklch / color-mix 的现代浏览器）。

---

## 1. LLM 配置（必填）

SwarmOracle 兼容任何 OpenAI 格式的 API（OpenAI、Google Gemini 的 OpenAI-compatible endpoint、各类代理、Ollama 等本地服务都可以）。Google Gemini 推荐 Base URL 为 `https://generativelanguage.googleapis.com/v1beta/openai`，并需要填写 Gemini API key。
xAI / OpenRouter / SiliconFlow 的 `response_format` 能力目前仍按 OpenAI-compatible 假设处理；现有 fail-soft 会在 provider 拒绝时降级。Gemini 这条 OpenAI-compatible chat 路径不注入模型原生搜索工具；搜索增强仍按下方搜索 provider 配置。

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM 服务地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API 密钥 | `sk-...` |
| `LLM_MODEL_NAME` | 模型名称（取决于你的服务） | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |
| `LLM_EXTRA_ALLOWED_HOSTS` | 请求级 BYOK 额外允许的 host，逗号分隔 | `llm.example.com,192.168.1.25` |
| `LLM_ALLOW_PRIVATE_BYOK_HOSTS` | 是否允许请求级 BYOK 使用额外配置的私网 / LAN / loopback host | `false`（默认） |
| `LLM_ALLOW_LOCAL_BYOK_HOSTS` | 是否允许请求级 BYOK 使用内置本地别名 | `true`（默认） |

> 安全提示：模板里的 `your-api-key-here` 只是占位值。只要 `LLM_RESPONSES_URL` 不是本地地址，后端会拒绝用占位 key 继续运行，换成你的真实密钥即可。如果你用的是本地网关（如 Ollama），可以保持占位。

可选的 LLM 调优项（一般不用动）：`LLM_REASONING_EFFORT`（推理力度 `none/low/medium/high`）、`LLM_REQUESTS_PER_MINUTE`、`LLM_TOKENS_PER_MINUTE`（限速，`0` 表示不限）、`LLM_CONCURRENCY`（并发数）。

服务端默认 LLM 与请求级 BYOK 是两条不同边界：

- 部署级 `LLM_RESPONSES_URL` 是服务端管理员配置，运行时会通过 `_resolve_llm_api_url()` 解析成 OpenAI-compatible endpoint；它不走请求级 BYOK allowlist。
- 请求级 `llm_base_url` 来自用户请求，只作用于当前请求，必须通过 allowlist、scheme 和 URL 形状校验；业务入口如果传 `llm_base_url`，必须把 API key 单独传入，不要把 key 放进 URL。
- 请求级自定义 LLM base URL 只接受允许列表里的 host。官方托管 host 必须使用 `https`；已有本地开发别名（`localhost`、`127.0.0.1`、`0.0.0.0`、`host.docker.internal`、`::1`）可用 `http`。
- `LLM_EXTRA_ALLOWED_HOSTS` 会把逗号分隔的 host 归一化为 IDNA + 小写后并入请求级 allowlist。它只接受 host，不接受 URL、端口、userinfo、query 或 fragment。
- `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false` 时，通过 `LLM_EXTRA_ALLOWED_HOSTS` 加入的私网 / LAN / loopback host 仍会被拒绝；设为 `true` 后才允许这类 host，并应只在单机或可信 LAN 中使用。
- `LLM_ALLOW_LOCAL_BYOK_HOSTS=true` 是为了本地开发和 Docker quickstart 默认可用；多用户、暴露公网或 LAN 部署应设为 `false`，这样请求级 BYOK 会拒绝内置本地别名及等价 loopback / unspecified IP 形态。部署级 `LLM_RESPONSES_URL` 不受这个开关影响。
- 带 `user:pass@host`、query、fragment 或 path params 的请求级 BYOK URL 一律拒绝。

`GET /api/capabilities` 会返回零成本静态字段 `llm_configured: boolean`。当运行时仍是占位 URL（`http://127.0.0.1:8317/v1`、`http://localhost:8317/v1` 或 `http://host.docker.internal:8317/v1`），且 `LLM_API_KEY` 仍为空或占位值（如 `sk-12345678` / `your-api-key-here`）时为 `false`；配置了真实 key，或显式改到其它 endpoint 时为 `true`。这个字段不会调用 `health_check()`，不会发起 LLM 或网络请求。

已知限制：如果你真实使用的本地 OpenAI-compatible 代理刚好也是 `:8317/v1` 且不需要 API key，`llm_configured` 会把它当作未配置。首页提示可以关闭，诊断按钮仍可用于确认实际连通性。

主推演 / 辩论 / 会客厅主路径上的已识别 LLM provider 失败会暴露稳定机器码和短安全消息，不回显 provider body、HTML、stack trace、Authorization header、URL 凭据或 API key：

- `LLM_UNREACHABLE`：网络、DNS、连接拒绝、超时等连接错误。
- `LLM_AUTH_FAILED`：HTTP `401` / `403`。
- `LLM_MODEL_NOT_FOUND`：HTTP `404`，或 provider body 明确提示 model missing。
- `LLM_RATE_LIMITED`：HTTP `429`。

其它失败继续走既有 generic error 路径。

---

## 2. 功能开关（Feature Flags）

`.env.example` 与 `.env.docker.example` 模板现在默认开启这组用户能直接看到的功能；本地启动后不需要再手动打开：

| 开关 | 默认 | 打开后你会看到什么 |
|------|------|------------------|
| `FEATURE_CUSTOM_AGENTS` | ✅ 开 | 首页可以进入 Agent 库和自定义 Agent 工坊，把你自己做的 Agent 加进推演或辩论。 |
| `FEATURE_AGENT_IDENTITY` | ✅ 开 | Agent 会有跨场景身份、记忆和成长记录，结果页也能看人物档案。 |
| `FEATURE_CAUSAL_GRAPH` | ✅ 开 | 结果页可以打开因果图谱，看事件、分叉和结局之间的因果线。 |
| `FEATURE_GRAPH_ANALYSIS` | ✅ 开 | 图谱页可以展开图谱分析，看关键节点、连线密度和跨分支关系。 |
| `FEATURE_COUNTERFACTUAL_REPLAY` | ✅ 开 | 你可以改写某个 Agent 真实说过的一句话，重新推演并对比分支。 |
| `FEATURE_FACTIONS` | ✅ 开 | 结果页和圆桌会显示阵营演化、结盟和对立关系。 |
| `FEATURE_ARGUMENT_MAP` | ✅ 开 | 辩论结果页可以加载论点地图，把主张、证据、反驳和裁决连起来看。 |
| `FEATURE_KG_EXPLORER` | ✅ 开 | 图谱工作台可以切到 Knowledge Graph；结果页的 **下一步 / What's Next** 会显示知识图谱浏览器 / Knowledge Graph Explorer 和时间线星系 / Timeline Galaxy。 |
| `FEATURE_REPLAY_TRACE` | ✅ 开 | replay trace 页面可以按时间查看反事实、续跑等分支的来源轨迹。 |
| `FEATURE_AGENT_CONVERSATION` | ✅ 开 | 圆桌 Deep Dive 里可以选一位代表做 1 对 1 访谈，图谱节点也能发起追问。 |
| `FEATURE_ROUNDTABLE_SURVEY` | ✅ 开 | 圆桌 Deep Dive 里可以把同一个问题群发给多位代表，横向比较回答。 |
| `FEATURE_ROUNDTABLE_ANALYST` | ✅ 开 | 圆桌 Deep Dive 里可以让研究分析师梳理因果图、角色记忆和搜索证据。 |
| `FEATURE_SNAPSHOT_EXPORT` | ✅ 开 | 首页可以导入 scenario snapshot，结果页可以导出 ZIP snapshot。 |
| `FEATURE_PUBLIC_ARTIFACTS` | ✅ 开 | 分享弹窗可以导出脱敏 public artifact JSON 或单文件 HTML gallery。 |
| `FEATURE_PREDICTION_JOURNAL` | ✅ 开 | `/me/journal` 可以记录预测、标记结果，并查看校准曲线。 |
| `FEATURE_RESULT_VERDICT` | ✅ 开 | 结果页会尽量给出一句话结论、置信度和每条世界线对原问题的回答。 |
| `FEATURE_RESULT_REPORT` | ✅ 开 | 结果页会显示完整报告入口，也可以在 `/result/:id/report` 单独查看或重试生成。 |
| `FEATURE_MULTI_RUN` | ✅ 开 | 首页可以发起多次推演，结果页会显示 run group 分布和终局直方图。 |
| `FEATURE_YOU_VS_ORACLE` | ✅ 开 | 结果页可以把用户预测和 Oracle 结果做并排对比。 |
| `FEATURE_SOCIAL_HEADLINES` | ✅ 开 | 结果页社交动态会生成可下载或复制的 headline cards。 |
| `FEATURE_DOCUMENT_SEED` | ✅ 开 | 首页可以把上传文档整理成 scenario seed context。 |
| `FEATURE_LOCAL_PACKS` | ✅ 开 | 首页可以加载本地场景包，并把包内素材带入推演。 |
| `FEATURE_MODEL_PROFILES` | ✅ 开 | 模型配置页可以管理本地模型 profile，并在启动推演时选择。 |
| `FEATURE_EDUCATION_TEMPLATES` | ✅ 开 | 首页会显示教学模板入口，适合快速填入课堂场景。 |
| `FEATURE_PERSONA_EXPORT` | ✅ 开 | Agent 库可以导出人物备份，也可以从备份创建新 Agent。 |

`graph_analysis` 是组合能力：`FEATURE_GRAPH_ANALYSIS=true` 还不够，`FEATURE_CAUSAL_GRAPH=true` 也必须同时开启，前端才会把它当成可用。

图谱工作台在窄屏上会把 Split 视图收成单图视图；知识图谱浏览器和时间线星系也会保留移动端提示或可访问的列表回退。

还有几个后端内部/实验开关默认保持关闭，不作为普通用户入口介绍：`FEATURE_ROUNDTABLE_INSIGHT_LLM`、`FEATURE_HALLUCINATION_GATE`、`FEATURE_IDENTITY_COMPACTION`。

`FEATURE_RESULT_REPORT` 默认开启。打开时，结果页会出现完整报告入口，后端会把报告写入 `Scenario.parsed_context.full_report`，并通过 `POST /api/scenario/{id}/report:generate` 的 HTTP SSE 生成或重试。报告证据会保存 round / branch / agent / message 坐标，前端可从证据侧栏跳回 replay；失败、partial 和超限截断都有可显示状态，不会阻断原本的结果页。重试会沿用当前标签页的 BYOK provider policy；`llm_requests_per_minute / llm_tokens_per_minute` 传 `0` 表示本次不加单独 RPM/TPM 限制。报告章节数、每章工具调用上限、超时、证据摘录长度和完整报告字节上限由 `.env.example` 里的 `REPORT_*` 参数控制；如果需要回到纯 verdict + story 结果页，可以把它改为 `false` 后重启后端。

> 改完开关后需要**重启后端**才会生效。大多数开关对应界面上的功能，前端通过 `/api/capabilities` 自动感知是否可用，关闭的功能会隐藏或提示不可用，不会报错。

### 需要额外配置的搜索功能

下面三个功能默认关闭，因为它们需要外部搜索服务。托管搜索服务通常要配置 `WEB_SEARCH_PROVIDER` 和 `WEB_SEARCH_API_KEY`；如果你用 `searxng`，则需要提供可访问的 `SEARXNG_URL`，它本身不需要 API key。

| 开关 | 默认 | 什么时候打开 |
|------|------|--------------|
| `ENABLE_WEB_SEARCH` | ❌ 关 | 想让推演在开始前先联网搜索资料时打开；需要一个可用的搜索 provider。 |
| `FEATURE_NEW_SOURCES` | ❌ 关 | 想在首页高级设置里显示四个来源复选框时打开：预测市场（`polymarket`）、财经资讯（`finance`）、学术文献（`academic`）、深度报道（`news_deep`）。复选框只有在搜索增强已打开、且当前 provider 支持 domain filter 时才会真正生效。 |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | ❌ 关 | 已经使用来源复选框，并希望系统先为每类来源生成更合适的搜索词时再打开。 |

---

## 3. 搜索增强推演（可选）

打开后，推演前会自动联网搜索资料并注入角色提示，让结果更贴近现实信息。

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `ENABLE_WEB_SEARCH` | 总开关 | `false`（默认） |
| `WEB_SEARCH_PROVIDER` | 搜索服务商 | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` |
| `WEB_SEARCH_API_KEY` | 搜索服务密钥（`searxng` 不需要） | — |
| `SEARXNG_URL` | 自建 SearXNG 地址（仅 `searxng` 时） | `http://localhost:8888` |

---

## 4. 服务器与数据库

| 配置项 | 说明 | 默认 |
|--------|------|------|
| `PORT` | 后端端口 | `18927` |
| `DATABASE_URL` | SQLite 数据库路径 | `sqlite:///./swarmoracle.db` |
| `CHROMA_PERSIST_DIR` | 向量库（角色记忆）目录 | `./chroma_data` |
| `CORS_ORIGINS` | 允许的前端来源 | 已含 `http://localhost:18928` |

> Docker 部署时，`docker-compose.yml` 会把数据库和向量库放到 `/data` 数据卷，便于持久化。

---

## 5. 会话门禁与管理端点（可选，进阶）

`SESSION_SECRET` 默认留空，表示本地开发不开鉴权。设置后，REST 接口需要 `X-Session-Token` 头、WebSocket 需要首帧鉴权。这是一个**临时的全局粗粒度门禁**，适合给 demo 加一道简单口令，不是完整的多用户权限系统。

`ADMIN_TOKEN` 默认也留空，此时 `/api/admin/*` 诊断端点对本地开发开放。设置后，管理端点必须携带 `X-Admin-Token` 请求头。只要把 Docker 部署暴露给本机以外的访问者，就应同时设置 `SESSION_SECRET` 和 `ADMIN_TOKEN`。

---

更多未列出的调优参数（推演上限、记忆压缩预算等）见 `.env.example` 内的注释。
