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
| **Gameplay Cards** | 10 张玩法卡以导演级事件注入当前世界线，并要求后续轮次持续响应；玩法卡弹窗现会给出题材专属三段式连锁事件，以及 `风险时钟 / 资源轨道` 两条轻量状态，帮助用户沿着当前题材继续推进 |
| **Theme Registry & Asset Manifest** | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 frame / badge 素材统一收进单一注册表；`generic` 现有独立 `gameplay_card_frame_generic` 卡框 |
| **Semantic Scene Pool** | Pixel Theater 现有 30 个语义场景背景，按题面关键词选景；`law / faith / generic` 已补进 `law_court_variant / faith_temple_variant / switchboard_forum_variant` 三个变体 |
| **Director Campaign** | 导演生涯最小闭环已落地：后端已有 `finalize/profile/mastery/badges/daily-status` API，首页会把 daily challenge 的后端真值与本地缓存合并显示，结果页会展示本局 campaign 进展 |
| **Generic Quick Start** | 首页 generic 题材现为 3 条 `switchboard_forum` 题库，并会一键带入推荐预设：`Theater / 4 rounds / 4 agents / blackboard` |
| **Responsive Scenario Startup** | 创建场景后立即返回 `simulating` 占位状态，并附带 provisional root branch；后台继续解析并填充 Agent / 分支 |
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

If your LLM service is running on the host machine instead of inside Docker,
set `LLM_RESPONSES_URL` to `http://host.docker.internal:8318/v1/chat/completions`
before `docker compose up --build`. On Linux, replace it with an actual host-reachable address.

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

Scenario creation now returns immediately with a placeholder scenario in `simulating`.
The UI enters `/sim/:id` right away, then fills agents / branches asynchronously
through polling + WebSocket updates.

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_RESPONSES_URL` | OpenAI-compatible API endpoint | `http://127.0.0.1:8318/v1/chat/completions` |
| `LLM_API_KEY` | API key | `sk-12345678` |
| `LLM_MODEL_NAME` | Model name | `gpt-5.1-codex-mini` |
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
cd frontend && npm run e2e:variants
cd frontend && npm run e2e:corners
cd frontend && npm run e2e:full
```

- 本轮已验证的后端全量回归：**815 passed**
- 后端定向回归：`test_card_events.py / test_gameplay_contract_sync.py = 24 passed`，`test_campaign_service.py / test_campaign_api.py = 9 passed`，`test_predictions.py = 17 passed`
- 当前前端主回归：**179 passed**
- 本轮已重新执行 `npm run build`，结果为通过
- 固定回归样本矩阵：**15 条** 主样本 + **3 条** 变体样本（`output/e2e/sample_matrix_variants.json`）
- `scripts/e2e-suite.mjs` 在历史 `scenario_id` 缺失，或样本 `scene_theme` 已与当前 `select_scene(question)` 漂移时，会按 theme runtime fallback 重建样本；输出目录会写入 `browser-launch.json`，截图阶段若超时或失败，会自动回退到 Chromium CDP 截图
- 当前 Track C 主工件目录：
  - `frontend/output/e2e/20260317-track-c/matrix/`
  - `frontend/output/e2e/20260317-track-c/corners/`
  - `frontend/output/e2e/20260317-track-c/mobile/`
  - `frontend/output/e2e/20260317-track-c/variants/`
- 当前仓库内可见且本轮重新验证通过的 full smoke 工件：`frontend/output/e2e/20260318-codex-full-smoke/result.json`
- Debate 专项完整黑盒基线：`frontend/output/e2e/20260318-post-b2-debate-full/result.json`
- 本轮新增 Debate 工件：
  - `frontend/output/e2e/20260318-debate-mobile-430x932-v2/result.json`
  - `frontend/output/e2e/20260318-debate-civic-v2/result.json`
- `scripts/e2e-debate-suite.mjs` 现支持 `--width / --height / --question / --profile-hint`，可直接补移动端新视口或指定 Debate 主题工件
- 本轮还完成了一次 `docker compose up --build -d` 运行时 smoke：前端代理 `POST /api/scenario` 成功创建 Theater 场景并跑到 `status = done`

## License

AGPL-3.0-only
