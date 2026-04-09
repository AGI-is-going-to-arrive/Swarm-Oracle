# SwarmOracle

> 群体预言机 -- AI "What-If" Prediction Playground
> 一个基于 FastAPI + React + Phaser 的 AI 驱动互动叙事游戏平台。

## 项目愿景

SwarmOracle 允许用户提出 "如果...会怎样" 的假设性问题，由 AI 代理群体模拟多分支叙事推演，支持辩论竞技场、神谕密室、世界线圆桌等多种互动模式，最终生成可分享的预测结果。

## 架构总览

| 层级 | 技术栈 | 端口 |
|------|--------|------|
| 前端 | Vite + React 19 + TypeScript + Phaser 3 + Zustand | 18928 |
| 后端 | FastAPI + SQLModel + Alembic + ChromaDB | 18927 |
| LLM  | MiniMax-M2.5 (可配置任意 OpenAI 兼容 API) | 可配置 |
| 数据库 | SQLite + ChromaDB (向量检索) | 本地文件 |
| 部署 | Docker Compose (backend + frontend) | 18927/18928 |

## 模块结构图

```mermaid
graph TD
    A["SwarmOracle"] --> B["backend"]
    A --> C["frontend"]
    A --> D["video"]

    B --> B1["app/api"]
    B --> B2["app/services"]
    B --> B3["app/models"]
    B --> B4["app/visualization"]
    B --> B5["alembic"]
    B --> B6["tests"]

    C --> C1["src/pages"]
    C --> C2["src/components"]
    C --> C3["src/game"]
    C --> C4["src/lib"]
    C --> C5["src/stores"]
    C --> C6["src/hooks"]
    C --> C7["src/api"]
    C --> C8["src/i18n"]
    C --> C9["scripts"]

    click B "./backend/CLAUDE.md" "查看 backend 模块文档"
    click C "./frontend/CLAUDE.md" "查看 frontend 模块文档"
```

## 模块索引

| 模块 | 路径 | 语言 | 职责 | 文件数 | 测试数 |
|------|------|------|------|--------|--------|
| backend | `backend/` | Python 3.11+ | FastAPI 后端，LLM 编排，模拟引擎，Web 搜索增强 | ~70 | 62 文件 / 1709 tests |
| frontend | `frontend/` | TypeScript | React SPA，Phaser 游戏引擎，实时 WS | ~130+ | 77 文件 / 715 tests |
| video | `video/` | Markdown | 宣传视频脚本与分镜稿 | 10 | -- |

## 运行与开发

### 环境准备

```bash
# 后端
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env  # 配置 LLM_API_KEY 等

# 前端
cd frontend
npm install
```

### 开发服务器

```bash
# 后端 (端口 18927)
cd backend && uvicorn app.main:app --host 0.0.0.0 --port 18927 --reload

# 前端 (端口 18928)
cd frontend && npm run dev
```

### Docker 部署

```bash
docker compose up --build
```

### 数据库迁移

```bash
cd backend && alembic upgrade head
```

## 测试策略

| 层级 | 工具 | 命令 |
|------|------|------|
| 后端单元/集成 | pytest + pytest-asyncio | `cd backend && pytest` |
| 前端单元/组件 | vitest + @testing-library/react | `cd frontend && npm test` |
| 前端 E2E | Playwright + 自定义脚本 | `cd frontend && npm run e2e:full` |
| E2E 子集 | -- | `npm run e2e:ending-room:full` / `npm run e2e:roundtable:full` / `npm run e2e:debate:full` |
| Lint (后端) | ruff | `cd backend && ruff check .` |
| Lint (前端) | eslint | `cd frontend && npm run lint` |
| 构建校验 | tsc + vite | `cd frontend && npm run build` |

## 编码规范

- **后端**: Python, ruff (line-length=100, target py311), select E/F/I/W
- **前端**: TypeScript strict, eslint + react-hooks + react-refresh
- **i18n**: 双语 (zh/en)，通过 `i18next` + `react-i18next`
- **状态管理**: Zustand (前端全局状态)
- **路由**: React Router v7 (前端), FastAPI APIRouter (后端)

## AI 使用指引

- 后端核心服务 `ending_room_service` 已拆分为子模块包 (`_utils`, `_participants`, `_threads`, `_content`)，修改时注意 re-export 兼容性
- `frontend/src/stores/worldlineRoundtableStore.ts` 是 `endingRoomStore` 的 re-export，不是 stub
- 大文件注意：`EndingChatModal.tsx` (~1509 行)，`WorldlineRoundtableView.tsx` (~1848 行)
- LLM 客户端支持 BYOK (Bring Your Own Key)，前端通过 `LlmProviderRequestOptions` 传递
- WebSocket 用于实时模拟推送，每个场景最多 50 个连接
- Web 搜索增强：用户可在 InputView 开启搜索增强，推演前自动搜索真实世界背景注入 Agent 提示词（CORE/IMPORTANT/CROWD 三层），结果在 ResultView 展示来源卡片
- `GET /api/capabilities` 是轻量配置端点（无 LLM 调用），前端 mount 时用它检测服务端功能开关
- BYOK 安全：业务入口 (scenario/debate/predictions/social) 统一要求 `base_url` 必须同时带 `api_key`，前移 400 拒绝；`/api/health/test` 是连通性探测，不做前移拒绝，返回 `200 + llm.status=error`。allowlist 校验 hostname + http(s) scheme
- 不可信文本（搜索结果、用户输入）通过 `format_untrusted_text_block()` 包装进 fenced block，三反引号已做转义防 fence-breakout
- WS 认证已从 query string `?token=` 迁移到首帧 auth 协议（`{"type":"auth","token":"..."}` → `{"type":"auth_ok"}`），token 不再出现在 URL 中。前端对 4001/4404 不自动重连
- WS 连接上限 `MAX_WS_PER_SCENARIO=50` 同时计入已认证连接和 pending_auth 连接，防止未认证 socket 绕过限制
- Oracle 角色化词汇 13 种 voice variant（imperial / field / finance / market / faith / industry / frontier / survival / scholar / civic / diplomat / advisor / science），基于 role_hint + bio_hint 子串匹配分类
- campaign / ending-room REST 路由的 session gate 以 router 级 `dependencies` 统一注入，不再逐端点声明
- Phase 3 六大功能增强 (F1-F6)：Agent 身份+跨场景记忆、世界线因果图谱、用户自建 Agent、蝴蝶效应回溯、涌现阵营系统、辩论论证图谱
- 13 个新 ORM 模型分布在 `agent_identity.py`、`graph.py`、`checkpoint.py`，3 个 Alembic 迁移 (014-016)
- 6 个新后端服务：`persona_workshop`、`agent_identity`、`causal_graph`、`replay`、`factions`、`debate_argument_map`
- 2 个新 API router：`/api/agents/*`、`/api/graphs/*`；`/api/capabilities` 升级为 7-key 通用 capability registry
- 4 个新前端页面：`AgentWorkshopView`、`AgentLibrary`、`CausalReviewView`、`CompareDigestView`
- 5 个新前端组件：`AgentAttachPanel`、`ArgumentMap`、`CounterfactualPanel`、`FactionTimeline`、`ReturningBadge`
- `simulator.py` 新增因果图谱 hook (非阻塞 try/except)，在 round_summary 和 branch_fork 后触发
- ChromaDB 双层 memory：scenario-scoped (不变) + identity-scoped (`identity_{user_id}` collection，200 条 FIFO)
- Agent continuity key：SHA-256(role+persona[:30])[:16]，跨场景身份匹配
- 自定义 Agent persona 通过 `format_untrusted_text_block()` 防注入
- `ScenarioResponse` 新增 3 个 additive 字段，`custom_agent_identity_ids` 最多 5 个

## 变更记录 (Changelog)

| 日期 | 操作 | 说明 |
|------|------|------|
| 2026-04-09 | Phase 3 六大功能增强 | F1 Agent身份+记忆、F2 因果图谱、F3 自建Agent、F4 蝴蝶效应回溯、F5 涌现阵营、F6 论证图谱；13 新模型、6 新服务、3 迁移、4 新页面、5 新组件、171 新测试 |
| 2026-04-09 | 遗留项收口 + 文档同步 | m1/m2 WS 异常处理加固、s1 session gate 提升 router 级、s2 CSS token 提取、s3 tween guard 测试、s4/s5 a11y + 死代码清理、llmdoc 10→13 variants 同步 |
| 2026-04-08 | WS pending_auth + Track B2 + E4/E5 | pending_auth 计入连接上限 + auth_ok 发送失败释放；voice variant 10→13 (diplomat/advisor/science) + 关键词扩充 + scholar/civic overlap 修复；Codex+Claude 交叉审查 E4 + 签收 E5 PASS |
| 2026-04-08 | WS 首帧 auth + session gate 测试 | WS 认证从 query string 迁移到首帧 auth 协议，4001/4404 不重连，15 backend + 3 frontend 测试，auth_ok 类型定义 |
| 2026-04-07 | Web 搜索增强 + 安全加固 | web_context 服务、搜索增强 toggle、ResultView 来源卡片、`/api/capabilities`、BYOK 业务入口校验统一、fence-breakout 修复、累计 21 条边界回归测试 |
| 2026-04-02 | 初始生成 | 全仓扫描，生成根级 + 模块级 CLAUDE.md 及 index.json |
