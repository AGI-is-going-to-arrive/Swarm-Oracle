# 🔮 SwarmOracle

> AI "What-If" Prediction Playground。输入一个历史或假设性问题，系统用多 Agent 推演、分支时间线、Pixel Theater 和结构化押注把结果可视化出来。

## 当前状态

- 当前交付形态是浏览器优先的 Web 应用。
- `跨平台` 指桌面/移动浏览器响应式与视口 E2E，不包含原生 Windows/macOS/Linux/iOS/Android 客户端壳。
- 最近一次 clean runtime 基线 `release:signoff` 已通过，工件位于 `frontend/output/e2e/current-head-audit-signoff/summary.json`。
- 这份 `summary.json` 绑定运行时代码 commit `3c96b52f618bc1e1e06d2630ecacb885951948a3`，且 `dirty=false`。
- `release:signoff` 的 `summary.json` 会记录 git commit / worktree 绑定信息；引用工件时，以工件里的 git metadata 为准，不要只看目录名猜当前代码状态。

## Documentation Contract

1. `README.md`
   负责产品范围、快速上手和当前交付状态。
2. `llmdoc/overview/*.md`
   负责代码结构与模块真值。
3. `llmdoc/guides/development.md`
   负责开发、测试和签收命令。
4. `implement/README.md`
   负责实现文档索引，并标记哪些是归档基线、历史快照或已过时备忘。
5. `progress.md`
   负责保留逐轮发现、修复和复验流水，不作为当前真值。

## Features

| 功能 | 描述 |
|------|------|
| Multi-Agent Simulation | 多 Agent 基于 persona、立场、情绪进行推演 |
| Branching Timelines | 生成平行分支与概率追踪 |
| Butterfly Effect | 支持实时干预、回溯干预和批量干预；前端当前已有统一干预弹窗闭环 |
| Pixel Theater | Phaser 驱动的像素剧场，可视化角色、场景、气泡和结局 |
| Structured Betting | 支持押世界线、押结局倾向、押题材回响 |
| Gameplay Cards | 14 张玩法卡，包括 10 张导演卡和 4 张反制卡 |
| Director Campaign | 导演目标、风险/资源轨道、worldline 承诺、成长与徽章 |
| Debate Arena | 独立 Debate domain，含 live/result/replay、结构化押注、judge rationale、supporting turns |
| Replay & Import | 主模式和 Debate 均支持 replay 分享页，并可导入为本地运行 |
| i18n | 中英文界面与输入语言联动输出 |
| BYOK & Provider Policy | 支持自带 OpenAI 兼容 API，并带全局并发、pending 配额和熔断 |
| Observability | `/metrics` 暴露 Prometheus 文本指标，依赖缺失时仍有最小回退文本 |

## Architecture

```text
Frontend (React + TypeScript + Vite)
  ├─ Classic branch tree / Result / History / Leaderboard
  ├─ Pixel Theater (Phaser)
  └─ Replay / Share / E2E automation hooks

Backend (FastAPI + SQLModel + SQLite + ChromaDB)
  ├─ Scenario simulation
  ├─ Campaign authority (`director_state_json`, `gameplay_state_json`)
  ├─ Debate domain
  └─ Prediction / leaderboard / social copy / metrics
```

## Quick Start

### Docker

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`

### Local Development

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927
```

```bash
cd frontend
npm install
npm run dev
```

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LLM_RESPONSES_URL` | OpenAI-compatible API endpoint | `http://127.0.0.1:8318/v1/chat/completions` |
| `LLM_API_KEY` | API key | `sk-12345678` |
| `LLM_MODEL_NAME` | Model name | `gpt-5.4-mini` |
| `MAX_AGENTS` | Max agents per scenario | `100` |
| `MAX_ROUNDS` | Max rounds | `40` |

本地直接启动 backend 时读取 `backend/.env`；`docker compose` 读取仓库根目录 `.env`。

## Testing And Signoff

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run assets:provenance:check
```

```bash
cd frontend
npm run release:signoff -- --headless
```

```bash
cd frontend
SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid npm run release:signoff -- --headless
```

- Historical full baseline: backend `815 passed`, frontend `179 passed`.
- Current targeted verification:
  - backend targeted set `82 passed`
  - frontend targeted set `104 passed`
  - `tsc` / `build` / assets check 通过
- Current session focused verification:
  - `src/game/PhaserGameLoader.test.ts`: `8 passed`
  - `src/lib/scenarioMeta.test.ts + src/lib/scenarioGameplayState.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`: `41 passed`
  - `src/lib/scenarioReplay.test.ts + src/pages/ResultView.test.tsx`: `13 passed`
  - `tsc` / `build`: 多轮复验通过
- Default `release:signoff` contract:
  - targeted backend `pytest`
  - backend `/metrics` reachability check
  - `npx tsc --noEmit -p tsconfig.app.json`
  - `npm run build`
  - `npm run assets:provenance:check`
  - `scripts/e2e-suite.mjs corners`
  - `scripts/e2e-suite.mjs mobile`
  - `scripts/e2e-suite.mjs cross-browser`
  - `scripts/e2e-debate-suite.mjs full`
- `summary.json` 现在会记录 git commit / worktree 绑定信息。
- 如果本地 LLM 链路可用，可以用 `SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid` 强制要求 Debate 结果返回 `adjudication_mode = llm_hybrid`。
- 如果本轮改动涉及高级干预、结果页 authority 或 `scenarioMeta / replay` 收口，优先跑上面的扩展前端定向回归；本 session 实跑通过 `104 passed`。
- Safari is optional and not part of the default full signoff.
- 最近一次 clean runtime 基线工件：`frontend/output/e2e/current-head-audit-signoff/summary.json`（绑定 commit `3c96b52f618bc1e1e06d2630ecacb885951948a3`，`dirty=false`）。

## CI

- `.github/workflows/ci.yml`
  - targeted backend `pytest`
  - frontend `assets:provenance:check / build / targeted vitest`；当前 targeted vitest lane 已与文档口径对齐，包含 `InterventionModal.test.tsx` 与 `simulationStore.test.ts`
  - `release-signoff-dry-run`
  - deterministic `debate-signoff-smoke`
- `.github/workflows/release-signoff.yml`
  - nightly + manual full signoff
  - preflight on `LLM_RESPONSES_URL / LLM_API_KEY`
  - secrets 可用时，当前 full signoff lane 会要求 Debate `adjudication_mode = llm_hybrid`

## License

AGPL-3.0-only
