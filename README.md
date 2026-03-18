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
| **Structured Betting 2.x** | 支持押世界线 / 押结局倾向 / 押题材回响；下注提交成功后会立刻回写后端 `gameplay_state`，结果页可逐条查看命中状态 |
| **Gameplay Cards** | 14 张玩法卡以导演级事件注入当前世界线；除原有推进卡外，现已补进 `审计清算 / 情报反噬 / 民意回摆 / 停火委员会` 4 张反制卡。玩法卡弹窗会给出题材专属三段式连锁事件、常驻 `风险 / 资源` 轨道、当前承诺 worldline 的默认目标分支，以及 profile-specific 的打法提示 |
| **Theme Registry & Asset Manifest** | 前端已把 33 个 Theater / Debate 场景主题、关键词、题材画像归属，以及玩法 frame / badge 素材统一收进单一注册表；`generic` 现有独立 `gameplay_card_frame_generic` 卡框 |
| **Expanded Runtime Sprite Pool** | 25 张角色 sprite 已进入运行时清单；本轮新接入 `alchemist / assassin / bard / knight / monk / thief / witch` 7 张精灵，前后端 persona/role 映射也已同步收口 |
| **Semantic Scene Pool** | 当前 registry 共有 33 个主题条目：30 张 Theater 语义背景 + 3 张 Debate 专属背景；`law / faith / generic` 已补进 `law_court_variant / faith_temple_variant / switchboard_forum_variant` 三个变体，Debate 另有 `debate_arena_civic / debate_arena_judicial / debate_arena_forum` 三张专用背景 |
| **Director Campaign** | 导演生涯最小闭环已落地：后端已有 `finalize/profile/mastery/badges/daily-status` API，首页会把 daily challenge 的后端真值与本地缓存合并显示，结果页会展示本局 campaign 进展 |
| **Debate Arena** | 独立 Debate domain 已落地，包含 `/api/debate` + `/ws/debate/{id}`、live/result 页、结构化押注、分享链路，以及最小 `counterplay` 闭环；当前 `counterplay` 已由后端显式返回到 live snapshot / result payload / WS，结果页与分享文案都会显示这次反制是否命中 |
| **Director Goals & Worldline Commitment** | Theater 局内现有最小导演层：2 个导演目标、常驻 `风险 / 资源` 轨道、worldline 承诺，以及结果页里的目标完成度 / 承诺命中或落空结算；当前这批状态已后端化到 `Scenario.director_state_json` |
| **Gameplay State Authority** | 主模式 `cards.usageLog / betting.bets / archive.key_moments / archive.branch_snapshots` 现已统一收口到 `Scenario.gameplay_state_json`；前端会优先从远端 `gameplay_state` 回填并重算导演点数、卡牌冷却、`most_used_card`、`counterplay_card_count` 与 `last_counterplay_card`，清空本地缓存后仍可跨设备读回下注记录与 archive raw 明细 |
| **Generic Quick Start** | 首页 generic 题材现为 3 条 `switchboard_forum` 题库，并会一键带入推荐预设：`Theater / 4 rounds / 4 agents / blackboard` |
| **Asset Provenance** | `frontend/public/assets/ui/generated + frontend/public/assets/scenes` 下当前 62 张 PNG 都已有同名 `.meta.json` sidecar；较新的 Debate 资产保留完整生成记录，较早的 legacy 资产会标记为 backfilled provenance。这里的 backfill 只表示 sidecar 补齐，不代表恢复了原始生成时间、模型或 prompt |
| **Platform Scope** | 当前交付形态是浏览器优先的 Web 应用；主模式现已有 `e2e:cross-browser` 与 `e2e:safari` 正式 smoke 入口，并已实跑 Chromium/Chrome、Firefox、WebKit 与 Safari 的主模式状态回读；桌面/移动浏览器视口也已做响应式与 E2E 复验，但不包含原生 Windows/macOS/Linux/iOS/Android 客户端壳 |
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
cd frontend && npm run e2e:cross-browser
cd frontend && npm run e2e:safari
cd frontend && npm run e2e:full
```

- 仓库内历史全量基线仍记录为：后端 **815 passed**、前端 **179 passed**
- 本轮面向当前仓库状态重新复验：
  - 后端：`test_debate_service.py / test_debate_api.py / test_config.py / test_campaign_api.py / test_campaign_service.py / test_predictions.py / test_card_events.py / test_gameplay_contract_sync.py` → **65 passed**
  - 前端：`scenarioMeta / archiveSummary / gameplayCards / gameplayContract / SimulationView / ResultView / GameplayCardsModal / DebateArenaView / DebateResultView / DebateBetModal / DebateShareModal / useDebateWS / locales` → **60 passed**
  - `frontend`：`npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `frontend`：`npm run build` → 通过
  - 资产 provenance：`cd frontend && npm run assets:provenance:check` → 通过
  - 黑盒：`e2e-suite.mjs full`、`e2e-debate-suite.mjs full`、`e2e-debate-suite.mjs mobile --width 430 --height 932` → 通过
- 本次 session 围绕 Debate `counterplay` 又补跑：
  - 后端：`tests/test_debate_api.py / tests/test_debate_service.py` → **11 passed**
  - 前端：`DebateArenaView / DebateResultView / useDebateWS / DebateShareModal / debateShare / debateCounterplay` → **13 passed**
  - `frontend`：`npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `frontend`：`npm run build` → 通过
  - Debate desktop 最小黑盒：`frontend/output/e2e/20260318-codex-audit-debate-live-counterplay-desktop/result.json`
- 本次 session 围绕主模式 director state 后端化又补跑：
  - 后端：`tests/test_campaign_api.py / tests/test_campaign_service.py` → **17 passed**
  - 前端：`SimulationView / ResultView / scenarioMeta` 定向回归 → **21 passed**
  - `frontend`：`npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `frontend`：`npm run build` → 通过
  - 主模式黑盒：`frontend/output/e2e/20260319-post-director-state-corners-v2/result.json`
  - 跨浏览器 smoke：
    - Firefox / WebKit：`frontend/output/e2e/20260319-official-cross-browser/result.json`
    - Safari：`frontend/output/e2e/20260319-official-safari-v5/result.json`
- 本次 session 又补跑：
  - 后端：`tests/test_campaign_api.py / tests/test_campaign_service.py / tests/test_persona_mapper.py` → **80 passed**
  - 前端：`scenarioGameplayState / gameplayCards / VizSynthesizer / SimulationView / ResultView` → **66 passed**
  - 前端：`SimulationView / TimelineBar` → **12 passed**
  - `frontend`：`npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `frontend`：`npm run build` → 通过
  - 黑盒：`e2e-suite.mjs corners`（含 `gameplay_state_roundtrip`）→ 通过
- 本次 session 围绕主模式 cross-device gameplay raw state 收口又补跑：
  - 后端：`tests/test_campaign_api.py / tests/test_campaign_service.py` → **19 passed**
  - 前端：`scenarioGameplayState / PredictionModal / SimulationView / ResultView` 定向回归 → **26 passed**
  - `frontend`：`npx tsc --noEmit -p tsconfig.app.json` → 通过
  - `frontend`：`npm run build` → 通过
  - 黑盒：`e2e-suite.mjs corners / cross-browser / safari` → 通过
- 固定回归样本矩阵：**15 条** 主样本 + **3 条** 变体样本（`output/e2e/sample_matrix_variants.json`）
- `scripts/e2e-suite.mjs` 在历史 `scenario_id` 缺失，或样本 `scene_theme` 已与当前 `select_scene(question)` 漂移时，会按 theme runtime fallback 重建样本；输出目录会写入 `browser-launch.json`，截图阶段若超时或失败，会自动回退到 Chromium CDP 截图
- `scripts/e2e-suite.mjs` 的 `corners` 现已补：
  - `director_state_roundtrip`
  - `gameplay_state_roundtrip`
  - 结果 JSON 会直接带：
    - `simulationDirector`
    - `simulationBetting`
    - `resultArchiveSummary`
    - `resultBetList`
    - `resultKeyMoments`
    - `resultBranchSnapshots`
    - `directorGoalsCard`
    - `commitmentCard`
    - `mostUsedCard`
    - `counterplayCard`
- 当前 Track C 主工件目录：
  - `frontend/output/e2e/20260317-track-c/matrix/`
  - `frontend/output/e2e/20260317-track-c/corners/`
  - `frontend/output/e2e/20260317-track-c/mobile/`
  - `frontend/output/e2e/20260317-track-c/variants/`
- 本轮重新验证通过的主模式 full smoke 工件：`frontend/output/e2e/20260318-post-director-goals-full/result.json`
- 本轮重新验证通过的主模式 corners 工件：`frontend/output/e2e/20260319-post-gameplay-state-corners/result.json`
- 本次 cross-device state 收口工件：
  - `frontend/output/e2e/20260319-cross-device-state-corners/result.json`
  - `frontend/output/e2e/20260319-cross-device-state-cross-browser/result.json`
  - `frontend/output/e2e/20260319-cross-device-state-safari/result.json`
  - `frontend/output/e2e/20260319-cross-device-state-safari-panel/result.json`
- 本轮重新验证通过的 Debate full 工件：`frontend/output/e2e/20260318-post-director-goals-debate-full/result.json`
- 本轮额外复验通过的主模式 full 工件：`frontend/output/e2e/20260318-codex-audit-main-full/result.json`
- 本轮额外复验通过的 Debate full 工件：`frontend/output/e2e/20260318-codex-audit-debate-full-rerun/result.json`
- 本轮额外复验通过的 Debate `430x932` 工件：`frontend/output/e2e/20260318-codex-audit-debate-mobile-430x932/result.json`
- 本轮 `develop-web-game` 取证工件：
  - `frontend/output/web-game/20260318-director-layer-smoke-v2/state-0.json`
  - `frontend/output/web-game/20260318-director-layer-smoke-v2/shot-0.png`
- 本轮 `develop-web-game` 补充取证工件：
  - `frontend/output/web-game/20260319-post-cross-browser-client/state-0.json`
  - `frontend/output/web-game/20260319-post-cross-browser-client/shot-0.png`
- `scripts/e2e-debate-suite.mjs` 现支持 `--width / --height / --question / --profile-hint`，可直接补移动端新视口或指定 Debate 主题工件
- Safari 默认 session screenshot 偶尔仍会拍到空白 Theater 画布；若需要核对 HUD / 面板可见性，可额外启用 `SWARM_SAFARI_PANEL_CAPTURE=1` 产出 panel capture 工件
- 本轮还完成了一次 `docker compose up --build -d` 运行时 smoke：前端代理 `POST /api/scenario` 成功创建 Theater 场景并跑到 `status = done`

## License

AGPL-3.0-only
