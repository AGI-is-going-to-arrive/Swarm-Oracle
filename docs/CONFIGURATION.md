# SwarmOracle 配置说明

所有配置都通过环境变量提供。两个模板：

- **本地开发**：把 `.env.example` 复制成 `backend/.env`，编辑 `backend/.env`（注意：直接改 `.env.example` 不会生效，它只是模板）。
- **Docker 部署**：编辑 `.env.docker`，`docker compose` 会自动读取。

下面只列**面向用户**的常用配置；更细的调优项见模板文件里的注释。

---

## 1. LLM 配置（必填）

SwarmOracle 兼容任何 OpenAI 格式的 API（OpenAI、各类代理、Ollama 等本地服务都可以）。

| 配置项 | 说明 | 示例 |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM 服务地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API 密钥 | `sk-...` |
| `LLM_MODEL_NAME` | 模型名称（取决于你的服务） | `gpt-4o` / `deepseek-chat` / `qwen-plus` |

> 安全提示：模板里的 `your-api-key-here` 只是占位值。只要 `LLM_RESPONSES_URL` 不是本地地址，后端会拒绝用占位 key 继续运行——换成你的真实密钥即可。如果你用的是本地网关（如 Ollama），可以保持占位。

可选的 LLM 调优项（一般不用动）：`LLM_REASONING_EFFORT`（推理力度 `none/low/medium/high`）、`LLM_REQUESTS_PER_MINUTE`、`LLM_TOKENS_PER_MINUTE`（限速，`0` 表示不限）、`LLM_CONCURRENCY`（并发数）。

---

## 2. 功能开关（Feature Flags）

部分进阶玩法由开关控制。**本仓库的 `.env.example` 与 `.env.docker` 已默认开启下面这组核心功能**，对应 README 宣传的玩法，开箱即用：

| 开关 | 解锁的功能 | 模板默认 |
|------|-----------|---------|
| `FEATURE_COUNTERFACTUAL_REPLAY` | 反事实对比（改一句话重新推演看差异） | ✅ 开 |
| `FEATURE_CAUSAL_GRAPH` | 因果图谱（事件因果关系可视化） | ✅ 开 |
| `FEATURE_FACTIONS` | 阵营关系（结盟 / 背叛识别） | ✅ 开 |
| `FEATURE_ARGUMENT_MAP` | 论点地图（辩论的论证结构） | ✅ 开 |

下面这组属于**进阶 / 实验功能，默认关闭**，需要时把对应项设为 `true`：

| 开关 | 解锁的功能 |
|------|-----------|
| `FEATURE_AGENT_CONVERSATION` | 圆桌 Deep Dive：与单个代表私聊 |
| `FEATURE_ROUNDTABLE_SURVEY` | 圆桌 Deep Dive：多代表问卷质询 |
| `FEATURE_ROUNDTABLE_ANALYST` | 圆桌 Deep Dive：研究分析师 |
| `FEATURE_KG_EXPLORER` | 知识图谱浏览器 |
| `FEATURE_CUSTOM_AGENTS` | 自定义 Agent 工坊 |
| `FEATURE_AGENT_IDENTITY` | 跨场景 Agent 身份记忆 |
| `FEATURE_PREDICTION_JOURNAL` | 预测记录册 |
| `FEATURE_PERSONA_EXPORT` | 人物档案导出 |
| `FEATURE_EDUCATION_TEMPLATES` | 教学模板 |
| `FEATURE_HALLUCINATION_GATE` | 事实性校验闸 |
| `FEATURE_REPLAY_TRACE` | 回放轨迹 |
| `FEATURE_ROUNDTABLE_INSIGHT_LLM` | 圆桌阶段要点用 LLM 重写 |

> 说明：「多分支推演」「辩论竞技场」「神谕密室」「世界线圆桌」是核心玩法，**无需功能开关**；其中世界线圆桌只在多结局结果页显示，单结局结果页不显示圆桌入口。`FEATURE_RESULT_VERDICT`（结果页一句话结论）在后端默认开启。
>
> 改完开关后需要**重启后端**才会生效。大多数开关对应界面上的功能，前端通过 `/api/capabilities` 自动感知是否可用，关闭的功能会隐藏或提示不可用，不会报错。
>
> 少数开关是**后端内部处理选项**、不出现在 `/api/capabilities` 里，只影响生成质量而非界面：`FEATURE_HALLUCINATION_GATE`（事实性校验闸）与 `FEATURE_ROUNDTABLE_INSIGHT_LLM`（圆桌阶段要点用 LLM 重写）。

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

## 5. 会话门禁（可选，进阶）

`SESSION_SECRET` 默认留空，表示本地开发不开鉴权。设置后，REST 接口需要 `X-Session-Token` 头、WebSocket 需要首帧鉴权。这是一个**临时的全局粗粒度门禁**，适合给 demo 加一道简单口令，不是完整的多用户权限系统。

---

更多未列出的调优参数（推演上限、记忆压缩预算等）见 `.env.example` 内的注释。
