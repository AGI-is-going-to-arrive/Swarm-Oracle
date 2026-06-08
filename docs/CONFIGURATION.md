[English](CONFIGURATION.en.md) | 中文

# SwarmOracle 配置说明

所有配置都通过环境变量提供。两个模板：

- **本地开发**：把 `.env.example` 复制成 `backend/.env`，编辑 `backend/.env`（注意：直接改 `.env.example` 不会生效，它只是模板）。
- **Docker 部署**：编辑 `.env.docker`，`docker compose` 会自动读取。

下面只列**面向用户**的常用配置；更细的调优项见模板文件里的注释。

最低浏览器要求：Chrome/Edge >= 111、Firefox >= 113、Safari/iOS >= 16.2（支持 oklch / color-mix 的现代浏览器）。

---

## 1. LLM 配置（必填）

SwarmOracle 兼容任何 OpenAI 格式的 API（OpenAI、各类代理、Ollama 等本地服务都可以）。

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM 服务地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API 密钥 | `sk-...` |
| `LLM_MODEL_NAME` | 模型名称（取决于你的服务） | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |

> 安全提示：模板里的 `your-api-key-here` 只是占位值。只要 `LLM_RESPONSES_URL` 不是本地地址，后端会拒绝用占位 key 继续运行，换成你的真实密钥即可。如果你用的是本地网关（如 Ollama），可以保持占位。

可选的 LLM 调优项（一般不用动）：`LLM_REASONING_EFFORT`（推理力度 `none/low/medium/high`）、`LLM_REQUESTS_PER_MINUTE`、`LLM_TOKENS_PER_MINUTE`（限速，`0` 表示不限）、`LLM_CONCURRENCY`（并发数）。

---

## 2. 功能开关（Feature Flags）

`.env.example` 与 `.env.docker` 现在默认开启这组用户能直接看到的功能；本地启动后不需要再手动打开：

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
| `FEATURE_PREDICTION_JOURNAL` | ✅ 开 | `/me/journal` 可以记录预测、标记结果，并查看校准曲线。 |
| `FEATURE_RESULT_VERDICT` | ✅ 开 | 结果页会尽量给出一句话结论、置信度和每条世界线对原问题的回答。 |
| `FEATURE_EDUCATION_TEMPLATES` | ✅ 开 | 首页会显示教学模板入口，适合快速填入课堂场景。 |
| `FEATURE_PERSONA_EXPORT` | ✅ 开 | Agent 库可以导出人物备份，也可以从备份创建新 Agent。 |

`graph_analysis` 是组合能力：`FEATURE_GRAPH_ANALYSIS=true` 还不够，`FEATURE_CAUSAL_GRAPH=true` 也必须同时开启，前端才会把它当成可用。

图谱工作台在窄屏上会把 Split 视图收成单图视图；知识图谱浏览器和时间线星系也会保留移动端提示或可访问的列表回退。

还有几个后端内部/实验开关默认保持关闭，不作为普通用户入口介绍：`FEATURE_ROUNDTABLE_INSIGHT_LLM`、`FEATURE_HALLUCINATION_GATE`、`FEATURE_IDENTITY_COMPACTION`。

`FEATURE_RESULT_REPORT` 也默认关闭。打开后，结果页会出现深读报告入口，后端会把报告写入 `Scenario.parsed_context.full_report`，并通过 `POST /api/scenario/{id}/report:generate` 生成或重试。报告章节数、每章工具调用上限、超时、证据摘录长度和完整报告字节上限由 `.env.example` 里的 `REPORT_*` 参数控制。

> 改完开关后需要**重启后端**才会生效。大多数开关对应界面上的功能，前端通过 `/api/capabilities` 自动感知是否可用，关闭的功能会隐藏或提示不可用，不会报错。

### 需要额外配置的搜索功能

下面三个功能默认关闭，因为它们需要外部搜索服务。托管搜索服务通常要配置 `WEB_SEARCH_PROVIDER` 和 `WEB_SEARCH_API_KEY`；如果你用 `searxng`，则需要提供可访问的 `SEARXNG_URL`，它本身不需要 API key。

| 开关 | 默认 | 什么时候打开 |
|------|------|--------------|
| `ENABLE_WEB_SEARCH` | ❌ 关 | 想让推演在开始前先联网搜索资料时打开；需要一个可用的搜索 provider。 |
| `FEATURE_NEW_SOURCES` | ❌ 关 | 想在首页高级设置里显示四个来源复选框时打开：预测市场（prediction market / `polymarket`）、金融（`finance`）、学术（`academic`）、深度新闻（`news_deep`）。复选框只有在搜索增强已打开、且当前 provider 支持 domain filter 时才会真正生效。 |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | ❌ 关 | 已经使用来源复选框，并希望系统先为每类来源生成更合适的搜索词时再打开。 |

---

## 3. 搜索增强推演（可选）

打开后，推演前会自动联网搜索资料并注入角色提示，让结果更贴近现实信息。

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `ENABLE_WEB_SEARCH` | 总开关 | `false`（默认） |
| `WEB_SEARCH_PROVIDER` | 搜索服务商 | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` / `native` |
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
