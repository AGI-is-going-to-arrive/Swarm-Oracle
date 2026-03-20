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

- 当前 targeted backend set：`86 passed`
- 本轮这类“parse 阶段坏 JSON fallback 兜底”改动，当前还额外实跑通过：
  - `tests/test_parser.py -k deterministic_parse`：`1 passed`

### Frontend

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run perf:budgets:check
npm run assets:provenance:check
```

- 当前 targeted frontend set：`107 passed`
- 这组扩展回归适用于本轮这类“authority 写入 / 结果页 authority / scenarioMeta-replay 收口”改动；更贴近本 session 的前端相关子集实跑为 `32 passed`。
- 当前 CI 的 frontend targeted vitest lane 已与这组文档口径对齐，包含 `src/components/InterventionModal.test.tsx`、`src/components/ShareModal.test.tsx` 与 `src/stores/simulationStore.test.ts`。
- 本轮这类“`scenarioMeta` 继续收口 + replay helper 动态加载 + Theater 首屏/截图兜底 + BootScene/WorldScene 资源加载优化”改动，当前还额外实跑通过：
  - `src/hooks/useScreenCapture.test.ts + src/lib/scenarioMeta.test.ts + src/lib/scenarioReplay.test.ts + src/pages/ResultView.test.tsx + src/pages/SimulationView.test.tsx`：`42 passed`
  - `src/lib/simulationReplay.test.ts + src/lib/scenarioReplay.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`：`32 passed`
  - `src/game/sceneAssetPlan.test.ts + src/game/PhaserGameLoader.test.ts + src/pages/SimulationView.test.tsx`：`30 passed`
- 本轮这类“默认 build / vitest 切到本地精简 Phaser 入口 + `e2e-suite` revision 修复”改动，当前还额外实跑通过：
  - `src/game/PhaserGame.test.ts + src/game/PhaserGameLoader.test.ts + src/game/replaySync.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`：`41 passed`
- 本轮这类“`scenarioMeta` 持久化继续压缩 + shared replay codec + WebKit capture / mobile Theater 收口”改动，当前还额外实跑通过：
  - `src/lib/scenarioReplay.test.ts + src/lib/simulationReplay.test.ts + src/lib/scenarioMeta.test.ts + src/hooks/useScreenCapture.test.ts + src/pages/SimulationView.test.tsx + src/components/ShareModal.test.tsx`：`38 passed`

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

```bash
cd frontend
npm run test:spike:phaser-custom
npm run build:spike:phaser-custom
```

如需把 Debate 结果强约束到真 `LLM hybrid` 裁决，可显式加：

```bash
cd frontend
SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid npm run release:signoff -- --headless
```

默认合同包含：

- targeted backend `pytest`
- backend `/metrics` 可达性检查
- `npx tsc --noEmit -p tsconfig.app.json`
- `npm run build`
- `npm run perf:budgets:check`
- `npm run assets:provenance:check`
- `scripts/e2e-suite.mjs corners`
- `scripts/e2e-suite.mjs mobile`
- `scripts/e2e-suite.mjs cross-browser`
- `scripts/e2e-debate-suite.mjs full`
- output root 的 `summary.json` 会带 git `branch / commit / worktree` 绑定信息

可选项：

- `--include-safari --scenario-id <id>`
- `--skip-backend-checks`
- `--skip-assets-check`
- `--backend-python /absolute/path/to/python`
- `--require-debate-adjudication-mode deterministic|llm_hybrid`

可调超时环境变量：

- `SWARM_DEBATE_RESULT_TIMEOUT_MS`
- `SWARM_DEBATE_STALL_TIMEOUT_MS`
- `SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`

最近一次 clean runtime 基线工件：

- `frontend/output/e2e/post-commit-signoff-clean/summary.json`
- 这份工件绑定 commit `421f6d6c37980a5fb1b79cf6ddd664f5ecda3473`，且 `dirty=false`
- 引用 signoff 结果时，以 `summary.json` 里的 git `branch / commit / worktree` 为准

仓库内最近一次通过的完整 signoff 工件：

- `frontend/output/e2e/post-commit-signoff-clean/summary.json`
- 这份工件对应当前工作树的真实完整 signoff：backend checks、`/metrics`、`tsc`、`build`、assets、`corners`、`mobile`、`cross-browser`、`debate-full` 全部通过
- 这份工件绑定 commit `421f6d6c37980a5fb1b79cf6ddd664f5ecda3473`，状态 `passed`
- 这份工件显式要求 `adjudication_mode = llm_hybrid`
- `corners` 里的 share 生成 / share retry 等待当前也已跟前端更长的社交文案超时窗口对齐，减少正常 LLM 延迟下的假失败
- 当前默认 `vite.config.ts` / `vitest.config.ts` 已通过 alias 指向本地精简 Phaser 入口 `frontend/experiments/phaser-custom/entry.cjs`
- `e2e-suite.mjs` 里的 `director_state_roundtrip / gameplay_state_roundtrip` 当前也会先回读 authority 的最新 `revision` 再 PUT，避免 signoff 被固定历史样本的 stale revision 卡住
- 当前 checkout 是否已严格签收，应以重新实跑生成的 `summary.json` 为准，而不是直接套用旧工件

## CI

- `.github/workflows/ci.yml`
  - targeted backend `pytest`
  - frontend `assets:provenance:check / perf:budgets:check / build / targeted vitest`；当前 lane 已与文档里的 targeted frontend set 对齐
  - `release-signoff-dry-run`
  - `release-signoff-fixture`：无 secrets 的 deterministic full-flow signoff，主模式走隔离 mock LLM（默认 `18318`），Debate 强约束 `deterministic`；真实 LLM 路径仍按 `LLM_RESPONSES_URL` 走现有配置
  - `debate-signoff-smoke`：secrets 可用时真实要求 `llm_hybrid`，否则安全回退 deterministic
- `.github/workflows/release-signoff.yml`
  - nightly + manual full signoff
  - preflight on `LLM_RESPONSES_URL / LLM_API_KEY`
  - secrets 可用时，当前 full signoff lane 会要求 Debate 返回 `adjudication_mode = llm_hybrid`

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
