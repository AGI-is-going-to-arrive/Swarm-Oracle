# SwarmOracle

> 群体预言机 -- AI "What-If" Prediction Playground
> 基于 FastAPI + React 19 + Phaser 3 的 AI 驱动互动叙事推演平台。用户提出"如果…会怎样"的假设问题，由 AI 代理群体模拟多分支叙事，支持辩论竞技场 / 神谕密室 / 世界线圆桌等模式，生成可分享的预测结果。

## 架构总览

| 层级 | 技术栈 | 端口 |
|------|--------|------|
| 前端 | Vite + React 19 + TypeScript + Phaser 3 + Zustand | 18928 |
| 后端 | FastAPI + SQLModel + Alembic + ChromaDB | 18927 |
| LLM  | OpenAI-compatible API (按环境变量配置) | 可配置 |
| 数据库 | SQLite + ChromaDB (向量检索) | 本地文件 |
| 部署 | Docker Compose | 18927/18928 |

## 模块索引

| 模块 | 路径 | 语言 | 职责 | 模块文档 |
|------|------|------|------|----------|
| backend | `backend/` | Python 3.11+ | FastAPI 后端，LLM 编排，模拟引擎，Web 搜索增强 | [backend/CLAUDE.md](./backend/CLAUDE.md) |
| frontend | `frontend/` | TypeScript | React SPA，Phaser 游戏引擎，实时 WS | [frontend/CLAUDE.md](./frontend/CLAUDE.md) |
| video | `video/` | Markdown | 宣传视频脚本与分镜稿 | -- |

- 后端 `app/`：`api / services / models / visualization` + `alembic / tests`
- 前端 `src/`：`pages / components / game / lib / stores / hooks / api / i18n` + `scripts`
- 测试基线：backend pytest **3415 passed / 6 skipped**；frontend vitest **213 文件 / 2397 tests**；i18n parity **2843/2843**

## 运行与开发

```bash
# 后端 (端口 18927)
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && cp ../.env.example .env   # 配置 LLM_API_KEY
uvicorn app.main:app --host 0.0.0.0 --port 18927 --reload
alembic upgrade head                                  # 数据库迁移

# 前端 (端口 18928)
cd frontend && npm install && npm run dev

# Docker 一键部署
docker compose up --build
```

## 测试与质量门禁

| 层级 | 命令 |
|------|------|
| 后端单元/集成 | `cd backend && pytest` |
| 后端 Lint | `cd backend && ruff check app/` |
| 前端单元/组件 | `cd frontend && npm test` |
| 前端 Lint / 构建 | `npm run lint` / `npm run build` |
| 前端 E2E | `npm run e2e:full`（子集 `e2e:ending-room:full` / `e2e:roundtable:full` / `e2e:debate:full`） |

## 编码规范

- **后端**：Python, ruff (line-length=100, target py311), select E/F/I/W
- **前端**：TypeScript strict, eslint + react-hooks + react-refresh
- **i18n**：双语 (zh/en)，`i18next` + `react-i18next`，提交前保持 parity
- **状态管理**：Zustand；**路由**：React Router v7 (前端) / FastAPI APIRouter (后端)

## AI 使用指引（代码读不出的约定）

### 核心架构
- `ending_room_service` 已拆成子模块包（`_utils / _participants / _threads / _content`），改动注意 re-export 兼容
- `worldlineRoundtableStore.ts` 是 `endingRoomStore` 的 re-export，不是 stub
- 大文件：`EndingChatModal.tsx`、`WorldlineRoundtableView.tsx`
- LLM 客户端支持 BYOK，前端通过 `LlmProviderRequestOptions` 传递
- ChromaDB 双层 memory：scenario-scoped + identity-scoped（`identity_{user_id}`，200 条 FIFO，串行化锁）
- Agent continuity key：SHA-256(role+persona[:30])[:16]，跨场景身份匹配

### 安全边界
- BYOK：业务入口统一要求 `base_url` 必须带 `api_key`（前移 400）；SSRF allowlist 17 域名 + hostname 校验
- 不可信文本走 `format_untrusted_text_block()` fenced block，三反引号转义防 fence-breakout
- WS 首帧 auth 协议（`auth` → `auth_ok`），4001/4404 不重连；`MAX_WS_PER_SCENARIO=50` 含 pending_auth
- `GET /api/capabilities` 轻量配置端点（无 LLM 调用），不暴露 key/base URL

### Feature flags & Capabilities
- `/api/capabilities` = web_search + 17 功能开关；flags 以 `config.py` 为准，多数默认 `false`
- 前端页面通过 `useCapabilityCheck` hook 做 capability gate（5 分钟 TTL + 共享 in-flight + 最多 60s 退避，区分 loading/enabled/error/reload）；capability 关闭时不挂载对应 SSE 面板
- `simulator.py` 4 个非阻塞 hook（因果图谱 / 阵营 / 检查点 / 身份）均受 `FEATURE_*` 控制

### Result Quality / Question Anchoring
- `FEATURE_RESULT_VERDICT` 默认开启；主 scenario 完成后生成直接回答原问题的 verdict / confidence / 一句话答案，失败 fail-soft，不阻断 `simulation_done`
- 数据写在 `Scenario.parsed_context.result_quality`（顶层 verdict/confidence/question_answer + branch_question_answers），无新增 DB 表/column
- narration Pass-1/Pass-2 都带原问题锚点；前端 `ResultVerdictPanel` 受 `capabilities.result_verdict` 控制，verdict 缺失时显示中性"暂无预测结论"

### Web 搜索增强
- InputView toggle 默认可见，推演前自动搜索注入 Agent 提示词（CORE/IMPORTANT/CROWD 三层）
- Source family 受 `FEATURE_NEW_SOURCES` + provider capability 双重门控；`detect_provider(base_url)` hostname 检测 15 个 provider + proxy/local 分类
- 域名过滤：Tavily/Exa API、SearXNG `site:`、xAI Responses `filters.allowed_domains`，均做 URL 后过滤
- Native search adapter 框架（`native_search_adapters.py`：xAI/OpenAI Responses + null adapter）；`llm_call(native_search_domains=...)` 按 capability 注入 `tools`，citation 经 ContextVar 暴露；派生官方 responses 端点只换 path 不换 host（SSRF 不变量，测试锁定）
- 代理/本地端点模型推断：`resolve_native_search_injection_decision(model=...)` 在 `auto` 模式下根据模型名前缀（`grok-*`→xAI / `gpt-*`·`o1`·`o3`→OpenAI）推断上游 provider，释放 `is_proxy` 门控；前端设置页 live native probe 验证实际可用性
- 预算 fail-closed：`NATIVE_SEARCH_MAX_TOOL_CALLS=5` / `NATIVE_SEARCH_MAX_CITATIONS=50`
- `native_citations` 后端+前端双层 sanitize（过滤非 http(s)）；`WebSourcesSection` 展示 native citations；`SourceCategoryCard` 的 `status_reason` 对普通用户可见，屏幕阅读器经 `aria-describedby` → sr-only span 获取

### 辩论竞技场
- Persona：`generate_persona_with_llm()` + `build_cast_async()` 3 方并行，失败回退模板，持久化 `breakdown_json.metadata.personas`
- Prompt 口语化 + 禁用术语列表，turn pass-2 retry（temp 0.8→0.6）后 fallback `anchor_copy`；Phase insights 受 `DEBATE_USE_LLM` gate
- ArgumentMap 全宽底部，OKLCH + sRGB fallback + `@supports` 渐进增强

### Oracle 文案
- 3-tier fallback：generation temp=0.82 → rewrite temp=0.78 → static anchor
- 四种房间类型均接入 factual_guardrail + scenario_question + transcript_quotes
- 18 种 voice variant（role_hint + bio_hint 子串匹配），stream 温度 0.75 + reasoning_effort medium
- generation-first 路径可处理 JSON 字符串输出；follow-up 空流式或仅 reasoning 输出退回非流式改写

### 圆桌 (Roundtable)
- `worldline_roundtable` 有 `discussion_format / cast_mode` 合同（旧 `selection_recipe` 仍 fallback）
- Hero 做减法 + PostVerdictPanel 三 tab（Agent 对话 / 分析师 / 问卷），仅 verdict 后可用，分别走 `roundtable_analyst / roundtable_survey / agent_conversation` capability
- `roundtable_survey.py` SSE + Semaphore(3)；`roundtable_analyst.py` ReACT 3 工具 5 轮迭代；二者是 Deep Dive 工作台能力，非 `EndingRoomInteractionMode`
- 主界面走 factual anchor 口径（Synthesis 显示讨论结果 / 主持人小结），不包装成裁判口吻；有原问题时结果区/transcript/phase 侧栏都显示问题锚定

### 图谱可视化
- DAG（@xyflow/react）：共享 BFS `traceConnectedPath`（`graphTraversal.ts`），`PERF_ANIMATION_LIMIT=150`
- KG（@antv/g6）：`kgGraphConfig.ts` 工厂，双层色系（DAG 鲜明 vs KG 暖灰），Agent 色环 15 色；全面 `prefers-reduced-motion` 覆盖
- `getFactionRelations` 路径无 `/graphs/` 前缀；faction-timeline 校验 `branch_id` 存在+归属，缺失 404
- 因果图谱边标签经 `BACKEND_CAUSAL_EDGE_LABEL_I18N` 映射翻译（如 `triggered fork` → `触发分支`），未知 raw fallback；结果页导航默认展示全部分支，不带 `branch_id`

### 前端约定
- InputView IME 三重防护 + 推演确认弹窗；模式选择器默认展示，BYOK 独立折叠
- Session gate 以 router 级 dependencies 统一注入
- `SafeMarkdown`（react-markdown + rehype-sanitize）渲染 Agent 消息 + TypingIndicator
- 硬编码文本全面 i18n 化

## 变更记录摘要

> 完整逐条历史见 git log；下表只保留功能里程碑。

| 阶段 | 内容 |
|------|------|
| 2026-05 | 发布前配置/文档/i18n 收口；UX 去模板化（推演模式三档）；Roundtable Overhaul（`discussion_format`/`cast_mode`）；Pixel Theater Overhaul；反事实对比逐消息 diff + resimulate；Result Quality / Question Anchoring 二次收口；Document Ingestion Upgrade（长 PDF 采样 + 全文证据）；Web Search P2–P5（native search / citation / provider capability / source family） |
| 2026-04 | Oracle 文案去模板化；圆桌优化（Hero 减法 + PostVerdictPanel 三 tab + 2 SSE）；P6–P7 图谱升级（KG/DAG 双层色系 + Replay 重构）；P2 审查 + KG 工作台；graph-playability-upgrade 6 层交付；Phase 3 六大功能 (F1–F6) + P0/P1 接线 + 安全修复；Web 搜索增强 + WS 首帧 auth + session gate；初始生成 (04-02) |
