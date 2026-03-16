# 🔮 SwarmOracle

> AI "What-If" Prediction Playground — 提出一个历史/假设性问题，AI agents 实时辩论并探索分支时间线。

## Features

| 功能 | 描述 |
|------|------|
| **Multi-Agent Simulation** | AI 角色带有 persona、立场、情绪进行辩论 |
| **Branching Timelines** | 决策产生平行分支，附概率追踪 |
| **Butterfly Effect** | 实时注入干预改变模拟走向（回溯 + 多点 + 模板） |
| **Multi-Ending Comparison** | 跨分支比较结局、洞察、关键时刻 |
| **Real-time WebSocket** | 实时观看 agent 发言流 |
| **Hierarchical Agents** | Leader-Worker 分层架构，支持千人规模模拟 |
| **Prediction Leaderboard** | 用户竞猜 + LLM 评分 + 排行榜 |
| **Structured Betting 2.x** | 支持押世界线 / 押结局倾向 / 押题材回响，结果页可逐条查看命中状态 |
| **Gameplay Cards** | 5 张玩法卡以导演级事件注入当前世界线，并要求后续轮次持续响应 |
| **Semantic Scene Pool** | Pixel Theater 现有 26 个语义场景背景，按题面关键词选景，不做粗暴轮换 |
| **Responsive Scenario Startup** | 创建场景后立即返回 `parsing` 状态，后台继续解析并填充 Agent / 分支 |
| **Scenario Management** | 场景列表 / 删除 / 导出 Markdown |
| **Intervention Templates** | 预设干预模板（自然灾害、技术突破等） |
| **BYOK** | 用户自带 OpenAI 兼容 API Key / URL / Model |
| **Social Media Copy** | 一键生成小红书 / 微博 / 知乎 / Reddit / X 文案 |
| **Language Detection** | 输入语言自动检测 + 全链路 LLM prompt 语言指令注入 |
| **Codebase Modularization** | API 层拆分为 5 个独立模块（schemas/helpers/interventions/social/scenarios） |
| **N+1 Query Optimization** | LEFT JOIN 消除逐条查询，保留已删除 agent 消息完整性 |
| **LLM Retry with Backoff** | 429/5xx 自动重试 3 次，指数退避 1s→2s→4s |
| **Alembic Migrations** | 数据库版本化迁移框架 |
| **Pixel Art Visualization** | 像素风可视化：事件映射 + 精灵分配 + 场景主题 + 卡牌事件 (Phase 1) |
| **Prometheus Observability** | `/metrics` 端点暴露请求延迟、计数、活跃模拟指标 |
| **i18n** | 中英文全局切换器 |

## Architecture

```
┌────────────┐           ┌────────────────┐
│  Frontend  │ ◄──WS──►  │    Backend     │
│  React/TS  │ ◄─REST──► │ FastAPI/Python │
│  Vite+Nginx│           │ SQLite+Chroma  │
└────────────┘           └────────┬───────┘
                                  │
                          ┌───────▼───────┐
                          │  LLM Provider │
                          │ (OpenAI-compat)│
                          └───────────────┘
```

## Quick Start

### Docker (recommended)

```bash
cp .env.example .env   # 配置 LLM_RESPONSES_URL / LLM_API_KEY
docker compose up --build
# → Frontend: http://localhost:18928
# → Backend:  http://localhost:18927
```

### Local Development

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927

# Frontend (separate terminal)
cd frontend
npm install && npm run dev
# → http://localhost:18928
```

Scenario creation now returns immediately with a placeholder scenario in `parsing`.
The UI enters `/sim/:id` right away, then fills agents / branches asynchronously
through polling + WebSocket updates.

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_RESPONSES_URL` | OpenAI-compatible API endpoint | `http://127.0.0.1:8317/v1/responses` |
| `LLM_API_KEY` | API key | `sk-12345678` |
| `LLM_MODEL_NAME` | Model name | `gpt-5.2` |
| `MAX_AGENTS` | Max agents per scenario | `100` |
| `MAX_ROUNDS` | Max simulation rounds | `40` |
| `MAX_BRANCHES` | Max parallel branches | `8` |
| `DEFAULT_NUM_AGENTS` | Default agent count | `20` |
| `DEFAULT_ROUNDS` | Default simulation rounds | `10` |

## Testing

```bash
cd backend
.venv/bin/python -m pytest tests/ -v

# Frontend tests
cd frontend && npm install && npm test

# Matrix / corner-case / full black-box regression
cd frontend && npm run e2e:matrix
cd frontend && npm run e2e:corners
cd frontend && npm run e2e:full
```

- 本轮已验证的后端场景/可视化定向回归：**201 passed**
- 当前前端主回归：**139 passed**
- 固定回归样本矩阵：**14 条**
- 最新完整黑盒结果：`frontend/output/e2e/full-regression-final/result.json`

## License

AGPL-3.0-only
