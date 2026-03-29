# 🔮 SwarmOracle

> AI "What-If" Prediction Playground。输入一个历史或假设性问题，系统用多 Agent 推演、分支时间线、Pixel Theater 和结构化押注把结果可视化出来。

## 当前状态

- 当前交付形态是浏览器优先的 Web 应用。
- `跨平台` 指桌面/移动浏览器响应式与视口 E2E，不包含原生 Windows/macOS/Linux/iOS/Android 客户端壳。
- 当前默认前端构建 / 测试入口已切到本地精简 Phaser 入口：`frontend/experiments/phaser-custom/entry.mjs`，由根 `vite.config.ts` / `vitest.config.ts` 通过 alias 接入。
- 当前默认前端构建里的 `phaser` chunk 已从约 `1202.19 kB` 降到 `718.94 kB`，gzip 从 `328.41 kB` 降到 `203.76 kB`。
- `Oracle Chambers / 世界线圆桌` 当前已进入可玩签收版：
  - backend 已有独立 `ending_room` 域、REST/WS、`selected_agent_ids`、follow-up thread、room/thread memory partition、`worldline_echo_key` 与 `user-turn` API
  - frontend 结果页每张结局卡当前会先经过 participant picker，再进入 `进入会客厅 / 只改一步`
  - 单结局会客厅当前已支持 follow-up thread、`archivist_route / hotseat / all_present` 三种追问模式，并已完成桌面/移动端闭环签收
  - `WorldlineRoundtableView` 当前已落地 live roundtable、`改选代表并重开`、`archivist_route / hotseat` 追问与只读 replay，并已进入 `release:signoff` 总链
  - Oracle 关键文案链路当前已升级为 `LLM-first + deterministic fallback`：`verdict`、`one_move_only` 与 follow-up 回复会优先尝试模型重写，失败时快速回退；同时 room 创建时会预建稳定 `user participant`，follow-up 写路径也已补上 SQLite `database is locked` 的短重试
  - `follow-up` 当前仍不是经典模式同级的完整流式：自动复盘与圆桌主桌已有 `turn_start -> turn_delta -> turn_commit`，但追问回复目前仍以“后端算完后 committed turn 回来”为主
  - 最新稳定总链工件见 `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json`，其中 `ending_room_followup / roundtable_full / debate_full` 均为 `passed`
  - 当前仍未单独签收的残余主要是 follow-up 与经典模式的流式一致性、roundtable mobile 一屏体验，以及 roundtable 代表声线还可继续拉开
- 首页当前已把主模式 runtime tuning 正式收成 `神谕档位 / Oracle Profile`。三档分别是 `守望 / 校准 / 裂界`（`Watchful / Calibrated / Riftbound`），只作用于主模式 worldline branching；首页还会按当前 `Agent 数量 × 推演轮数` 给出预计耗时，`3-5 分钟` 提示现在也明确只对应 Debate Arena。
- 主模式 `SimulationView / ResultView` 当前都只保留一个 runtime preset 标签，不再展开 prompt / sensitivity / budget 细节 chip；`分享挑战` 链接会继续把当前 `preset` 一起带回首页预填。
- 主模式结果页 `ShareModal` 当前已收掉上方 context chips，社交文案也不再自动在正文前拼题材/神谕/permalink 前缀；`导出 Markdown` 当前改成浏览器直连后端附件下载，目标是更稳定地拿到 `.md` 文件名，而不是继续依赖前端 `blob:` 下载。
- 主模式结果页当前还会在同一标签页会话里缓存 `finalizeCampaign` 完整结果；同一 `scenario + director + profile` 二次进入结果页时不再重复 `POST /finalize`，但首次进入仍会拿完整 `profile / mastery / badges` 数据。
- 当前自动生成内容已统一跟随输入语言：主模式 agent 发言 / 压缩摘要 / 叙事、Debate live/result 文本、分享文案与导出摘要都按输入语言输出；`reddit / x` 不再单独强制英文，backend 语言检测也已扩到 `French / German / Spanish / Portuguese / Italian`。
- 本 session 最新稳定通过的 `release:signoff` 工件位于 `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json`。
- 这份工件状态为 `passed`；当前工作树是否已严格签收，仍以最新 `summary.json` 里的 git metadata 为准。
- CI 现额外包含 `release-signoff-fixture`：无 secrets 的 deterministic full-flow signoff，主模式走隔离 mock LLM；mock 默认使用 `18318`，不影响真实 LLM 路径（本地默认仍走 `8318`）。
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
| Oracle Profile | 首页提供主模式 `神谕档位 / Oracle Profile` 三档，收口 `branchSensitivity / forkPromptVariant / forkDetectorActiveBranchLimit` |
| Director Campaign | 导演目标、风险/资源轨道、worldline 承诺、成长与徽章 |
| Debate Arena | 独立 Debate domain，含 live/result/replay、结构化押注、judge rationale、supporting turns |
| Oracle Chambers / Worldline Roundtable | 后端已实现 `ending_room` 域、REST/WS、`selected_agent_ids`、follow-up thread、room/thread memory partition、`worldline_echo_key` 和世界线隔离；Oracle 关键文本链路当前已升级成 `LLM-first + deterministic fallback`，并补了 room-stable `user participant` 与 SQLite lock 短重试；前端结果页已接入 participant picker、`进入会客厅 / 只改一步`、follow-up thread 与 `archivist_route / hotseat / all_present`，`WorldlineRoundtableView` 也已支持 live roundtable、改选重开与只读 replay，并通过稳定 `release:signoff` 总链；当前未单独签收的残余主要是 follow-up 与经典模式的流式一致性、roundtable mobile 一屏体验，以及代表/档案官声线还可继续去模板化 |
| Replay & Import | 主模式和 Debate 均支持 replay 分享页，并可导入为本地运行 |
| i18n | 中英文界面与输入语言联动输出；自动生成内容当前统一跟随输入语言，backend 语言检测已扩到 `Chinese / English / Japanese / Korean / French / German / Spanish / Portuguese / Italian` |
| BYOK & Provider Policy | 支持自带 OpenAI 兼容 API，并带全局并发、pending 配额和熔断；`POST /api/health/test` 当前会返回 provider probe 摘要，本地 / 自托管 provider 还可按次关闭 user-level quota；同一 SQLite `DATABASE_URL` 下的多进程仍会共享 pending / quota 计数 |
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
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- `docker compose` 默认读取仓库根目录 `.env.docker`。
- 如果 LLM 服务跑在宿主机本地，默认 Docker 配置已经使用 `http://host.docker.internal:8318/v1/chat/completions`。

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
| `MAX_AGENTS` | Max agents per scenario | `1500` |
| `MAX_ROUNDS` | Max rounds | `40` |
| `LOG_LEVEL` | Backend log level | `INFO` |
| `LOG_FORMAT` | Backend log format (`json` / `plain`) | `json` |

本地直接启动 backend 时读取 `backend/.env`，可由 `.env.example` 初始化；`docker compose` 默认读取仓库根目录 `.env.docker`。

- 占位 `LLM_API_KEY=sk-12345678` 当前只适用于本地网关，例如 `localhost`、`127.0.0.1` 或 `host.docker.internal`。
- 如果 `LLM_RESPONSES_URL` 指向非本地 LLM 端点，后端会在配置加载阶段直接拒绝占位 key，而不是等到第一次调用时才失败。
- `LLM_MODEL_NAME` 不能为空；留空会在配置加载阶段直接报错。
- `POST /api/health/test` 在 LLM 可用时还会返回 provider probe 摘要，供首页 BYOK 预检显示推荐的 `agents / rounds` 区间。
- `disable_user_quota` 只对本地 / 自托管 provider 生效；它只跳过 user-level fairness cap，不会绕过全局并发闸门。
- backend 默认输出结构化 JSON 日志；`uvicorn` 相关日志也会统一走同一套 root formatter。
- memory 压缩预算当前也可在 backend `.env` 中调节；`MEMORY_COMPRESS_* / MEMORY_*_MAX_RECENT / MEMORY_*_CONTEXT_MAX_CHARS` 只给 backend 开发者/运维调参，不暴露到前端用户。

## Testing And Signoff

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run perf:budgets:check
npm run assets:provenance:check
```

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
SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid npm run release:signoff -- --headless
```

- Historical full baseline: backend `815 passed`, frontend `179 passed`.
- Current targeted verification:
  - backend targeted set `156 passed`
  - frontend targeted set `112 passed`
  - `tsc` / `build` / perf budgets / assets check 通过
- Current session focused verification:
  - `backend/tests/test_agent_group.py + backend/tests/test_memory.py + backend/tests/test_simulator.py + backend/tests/test_config.py`: `142 passed in 4.18s`
  - `frontend src/api/client.test.ts + src/hooks/useSimulationWS.test.tsx + src/hooks/useDebateWS.test.tsx + src/i18n/locales.test.ts`: `26 passed`
  - `frontend/output/e2e/20260325-postfix-mobile-review/`：移动端结果页与主模式 mobile 后修复回归产物已落盘
  - `frontend/output/e2e/20260325-postfix-debate-review/`：Debate full 后修复回归产物已落盘
  - `frontend src/pages/InputView.test.tsx + src/i18n/locales.test.ts`: `14 passed`
  - `frontend src/lib/shareEnvelope.test.ts + src/components/ShareModal.test.tsx + src/pages/ResultView.test.tsx`: `22 passed`
  - `backend/tests/test_api.py -k export_with_branches -q`: `1 passed`
  - `backend/tests/test_api.py + backend/tests/test_simulator.py`: `179 passed`
  - `frontend/output/e2e/20260324-runtime-preset-corners/`：主模式 corners 回归产物已落盘
  - `frontend/output/e2e/20260324-runtime-preset-debate/`：Debate full 回归产物已落盘
  - `backend/tests/test_api.py + backend/tests/test_llm_client.py + backend/tests/test_runtime_lock.py + backend/tests/test_simulator.py`: `205 passed in 26.75s`
  - `python -m ruff check --ignore E501 app/api/helpers.py app/api/scenarios.py app/api/schemas.py app/services/llm_client.py app/services/runtime_lock.py app/services/simulator.py tests/test_api.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_simulator.py`: `passed`
  - `frontend InputView / SimulationView / simulationStore / TimelineBar / BranchEdge / GameplayCardsModal / VizSynthesizer / WorldScene / locales`: `112 passed`
  - `frontend tsc / build / spike phaser-custom tests`: `passed`，其中 `npm run test:spike:phaser-custom` 为 `34 passed`
  - `backend/tests/test_backend_code_review_fixes.py -q`: `4 passed in 0.45s`
  - `backend/tests/test_vector_store.py backend/tests/test_parser.py backend/tests/test_models.py -q`: `64 passed in 71.56s`
  - `backend/tests/test_logging_utils.py backend/tests/test_config.py -q`: `13 passed in 0.41s`
  - `backend/tests/test_api.py -k 'test_root or test_health' -q`: `2 passed, 90 deselected in 2.96s`
  - expanded backend targeted regression: `23 passed, 215 deselected in 3.75s`
  - full backend suite: `998 passed in 223.31s (0:03:43)`
  - `backend/tests/test_llm_client.py + backend/tests/test_campaign_api.py + backend/tests/test_campaign_service.py + backend/tests/test_debate_api.py + backend/tests/test_debate_service.py + backend/tests/test_gameplay_contract_sync.py + backend/tests/test_memory.py + backend/tests/test_models.py + backend/tests/test_narrator.py + backend/tests/test_predictions.py + backend/tests/test_ws.py + backend/tests/test_api.py`: `269 passed`
  - `backend/tests/test_predictions.py + backend/tests/test_gameplay_contract_sync.py + backend/tests/test_memory.py + backend/tests/test_narrator.py`: `86 passed in 1.85s`
  - `backend/tests/test_simulator.py -k 'passes_llm_overrides_into_compression or passes_llm_overrides_into_narration'`: `2 passed in 0.31s`
  - `backend/tests/test_debate_api.py + backend/tests/test_api.py -k 'predict_counterplay_still_succeeds_when_broadcast_fails or social_copy_rejects_provider_overrides_in_get_query'`: `2 passed in 0.41s`
  - `backend/tests/test_simulator.py -k reuses_latest_rolling_briefing_before_current_window`: `1 passed`
  - `python -m pytest tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py -q`: `368 passed in 37.64s`
  - `python -m ruff check --ignore E501 app/config.py app/main.py app/api/debate.py app/services/llm_client.py app/services/simulator.py tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py`: `passed`
  - `src/lib/scenarioAuthority.test.ts + src/lib/scenarioGameplayState.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx + src/hooks/useScreenCapture.test.ts`：`37 passed`
  - `backend/tests/test_parser.py -k fallback_rounds_use_explicit_default_rounds`: `1 passed`
  - `src/lib/scenarioReplay.test.ts + src/lib/simulationReplay.test.ts + src/lib/scenarioMeta.test.ts + src/hooks/useScreenCapture.test.ts + src/pages/SimulationView.test.tsx + src/components/ShareModal.test.tsx`: `38 passed`
  - `backend/tests/test_campaign_service.py + backend/tests/test_campaign_api.py + backend/tests/test_debate_api.py`: `32 passed`
  - `src/game/PhaserGame.test.ts + src/game/PhaserGameLoader.test.ts + src/game/replaySync.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`: `41 passed`
  - `src/lib/scenarioMeta.test.ts + src/lib/archiveSummary.test.ts + src/components/gameplayCards.test.ts + src/components/gameplayContract.test.ts + src/components/InterventionModal.test.tsx + src/components/ShareModal.test.tsx + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx + src/components/GameplayCardsModal.test.tsx + src/pages/DebateArenaView.test.tsx + src/pages/DebateResultView.test.tsx + src/components/DebateBetModal.test.tsx + src/components/DebateShareModal.test.tsx + src/hooks/useDebateWS.test.tsx + src/i18n/locales.test.ts + src/stores/simulationStore.test.ts`: `107 passed`
  - `tsc` / `build` / perf budgets / assets check：当前代码相关复验通过
  - clean real full `release:signoff`：`frontend/output/e2e/post-commit-signoff-clean/summary.json`（`passed`，绑定 commit `421f6d6c37980a5fb1b79cf6ddd664f5ecda3473`，`dirty=false`）
- Default `release:signoff` contract:
  - targeted backend `pytest`
  - backend `/metrics` reachability check
  - `npx tsc --noEmit -p tsconfig.app.json`
  - `npm run build`
  - `npm run perf:budgets:check`
  - `npm run assets:provenance:check`
  - `scripts/e2e-suite.mjs corners`
  - `scripts/e2e-suite.mjs mobile`
  - `scripts/e2e-suite.mjs cross-browser`
  - `scripts/e2e-debate-suite.mjs full`
- `summary.json` 现在会记录 git commit / worktree 绑定信息。
- 如果本地 LLM 链路可用，可以用 `SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid` 强制要求 Debate 结果返回 `adjudication_mode = llm_hybrid`。
- 如果本轮改动涉及 authority 写入、`scenarioMeta / replay` 收口或结果页展示链路，优先跑上面的扩展前端定向回归；本 session 相关前端子集实跑通过 `32 passed`。
- Safari is optional and not part of the default full signoff.
- 仓库内最近一次通过的 clean real full signoff 工件：`frontend/output/e2e/post-commit-signoff-clean/summary.json`。
- 这份工件绑定 commit `421f6d6c37980a5fb1b79cf6ddd664f5ecda3473`，状态 `passed`，并记录当前工作树为 `dirty=false`。
- 当前 checkout 是否已通过完整签收，应以最近实跑生成的 `summary.json` 为准，不应直接把旧工件等同于当前 `HEAD`。
- CI 当前还包含 `release-signoff-fixture`，用于无 secrets 的 deterministic 全链路回归；这条链路使用隔离 mock LLM，不占用真实 `LLM_RESPONSES_URL`。

## CI

- `.github/workflows/ci.yml`
  - targeted backend `pytest`
  - frontend `assets:provenance:check / perf:budgets:check / build / targeted vitest`；当前 targeted vitest lane 已与文档口径对齐，包含 `InterventionModal.test.tsx`、`ShareModal.test.tsx` 与 `simulationStore.test.ts`
  - `release-signoff-dry-run`
  - `release-signoff-fixture`：无 secrets 的 deterministic full-flow signoff，主模式走隔离 mock LLM（默认 `18318`），Debate 强约束 `deterministic`
  - `debate-signoff-smoke`：secrets 可用时真实要求 `llm_hybrid`，否则安全回退 deterministic
- `.github/workflows/release-signoff.yml`
  - nightly + manual full signoff
  - preflight on `LLM_RESPONSES_URL / LLM_API_KEY`
  - secrets 可用时，当前 full signoff lane 会要求 Debate `adjudication_mode = llm_hybrid`

## License

AGPL-3.0-only
