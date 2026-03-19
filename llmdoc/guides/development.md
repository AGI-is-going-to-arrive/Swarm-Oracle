# 开发指南

> 文档类型：L0 current-truth
> 作用：当前开发、测试、签收与部署命令的唯一操作手册。逐轮验证流水保留在 `progress.md`，不再反向灌入本页。

## 环境要求

- Python ≥ 3.11
- Node.js ≥ 18
- npm ≥ 9

## 本地开发

### Backend

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927
```

- 如果本机有多个同级工作区都带 `app/` 包，优先显式指定：

```bash
uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --reload --port 18927
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### 环境变量

本地直接启动 backend 时，默认读取 `backend/.env`：

```bash
cp .env.example backend/.env
```

- `docker compose` 读取仓库根目录 `.env`。
- 默认模型为 `gpt-5.4-mini`；若本地网关没有该模型映射，需要先更新网关。

## 测试写法约定

- Historical full baseline
  - 背景说明，不作为当前发布判断。
  - backend: `815 passed`
  - frontend: `179 passed`
- Current targeted verification
  - 当前 `HEAD` 的定向回归，用于快速判断关键路径是否仍然健康。
- Current release signoff
  - 当前发布判断的唯一合同。

## 当前推荐定向回归

### Backend

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

- 当前 targeted backend set：`82 passed`

### Frontend

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run assets:provenance:check
```

- 当前 targeted frontend set：`79 passed`

## Release Signoff

在准备对外分享 build、做 release candidate，或重新确认文档口径时，优先跑完整签收链路。

```bash
cd backend
source .venv/bin/activate
uvicorn app.main:app --host 127.0.0.1 --port 18927
```

```bash
cd frontend
npm run preview -- --host 127.0.0.1 --port 18928
```

```bash
cd frontend
npm run release:signoff -- --headless
```

默认合同包含：

- targeted backend `pytest`
- backend `/metrics` 可达性检查
- `npx tsc --noEmit -p tsconfig.app.json`
- `npm run build`
- `npm run assets:provenance:check`
- `scripts/e2e-suite.mjs corners`
- `scripts/e2e-suite.mjs cross-browser`
- `scripts/e2e-debate-suite.mjs full`

可选项：

- `--include-safari --scenario-id <id>`
- `--skip-backend-checks`
- `--skip-assets-check`
- `--backend-python /absolute/path/to/python`

可调超时环境变量：

- `SWARM_DEBATE_RESULT_TIMEOUT_MS`
- `SWARM_DEBATE_STALL_TIMEOUT_MS`
- `SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`

最新通过工件：

- `frontend/output/e2e/20260320-codex-live-signoff/summary.json`

## CI

- `.github/workflows/ci.yml`
  - targeted backend `pytest`
  - frontend `assets:provenance:check / build / targeted vitest`
  - `release-signoff-dry-run`
  - deterministic `debate-signoff-smoke`
- `.github/workflows/release-signoff.yml`
  - nightly + manual full signoff
  - preflight on `LLM_RESPONSES_URL / LLM_API_KEY`

## Docker 部署

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`

## 数据库迁移

```bash
cd backend
source .venv/bin/activate
alembic revision --autogenerate -m "describe change"
alembic upgrade head
alembic current
```

## 代码约定

- `README.md`
  - 产品范围、当前交付状态、快速上手
- `llmdoc/overview/*.md`
  - 模块真值
- `progress.md`
  - 过程日志，不作为当前真值
