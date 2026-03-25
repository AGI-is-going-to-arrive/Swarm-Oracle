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

- backend 当前默认输出结构化 JSON 日志；`uvicorn / uvicorn.error / uvicorn.access` 会统一走同一套 root formatter。

### Frontend

```bash
cd frontend
npm install
npm run dev
```

- 做视频采集时，当前以 `preview` 为准，不建议直接用 `dev`：

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 18929
```

### 环境变量

本地直接启动 backend 时，默认读取 `backend/.env`：

```bash
cp .env.example backend/.env
```

- `docker compose` 默认读取仓库根目录 `.env.docker`。
- `.env.example` 是本地直启 backend 的模板，不再作为 Docker 默认环境文件。
- 默认模型为 `gpt-5.4-mini`；若本地网关没有该模型映射，需要先更新网关。
- backend 当前默认输出 JSON 结构化日志；如需切回传统文本，可在 `backend/.env` 里设 `LOG_FORMAT=plain`。`LOG_LEVEL` 默认 `INFO`。
- memory 压缩预算当前也可通过 backend `.env` 调整；相关 `MEMORY_COMPRESS_* / MEMORY_*_MAX_RECENT / MEMORY_*_CONTEXT_MAX_CHARS` 仅供 backend 开发者/运维调参，不暴露到前端用户。

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

- 当前 targeted backend set：`156 passed`
- 本 session 这轮“parser fallback group 回写 / memory 两段式高信号压缩 + developer-only budget”改动，当前还额外实跑通过：
  - `tests/test_agent_group.py + tests/test_memory.py + tests/test_simulator.py + tests/test_config.py`：`142 passed in 4.18s`
- 本轮这类“runtime guard / rolling briefing / language-aware fallback / mtime-aware contract”改动，当前还额外实跑通过：
  - `tests/test_llm_client.py + tests/test_campaign_api.py + tests/test_campaign_service.py + tests/test_debate_api.py + tests/test_debate_service.py + tests/test_gameplay_contract_sync.py + tests/test_memory.py + tests/test_models.py + tests/test_narrator.py + tests/test_predictions.py + tests/test_ws.py + tests/test_api.py`：`269 passed in 30.26s`
  - `tests/test_parser.py -k fallback_rounds_use_explicit_default_rounds`：`1 passed`
  - `tests/test_simulator.py -k reuses_latest_rolling_briefing_before_current_window`：`1 passed`
- 本轮这类“WS heartbeat keepalive / Debate LIVE-only prediction / intervention queue async-safe pop”改动，当前还额外实跑通过：
  - `tests/test_debate_api.py + tests/test_debate_service.py + tests/test_ws.py + tests/test_simulator.py + tests/test_intervention.py`：`104 passed in 2.69s`
- 本轮这类“backend review fixes / scoring atomicity / gameplay contract clear error / memory+narrator BYOK pass-through / debate-social API guard”改动，当前还额外实跑通过：
  - `tests/test_predictions.py + tests/test_gameplay_contract_sync.py + tests/test_memory.py + tests/test_narrator.py`：`86 passed in 1.85s`
  - `tests/test_simulator.py -k 'passes_llm_overrides_into_compression or passes_llm_overrides_into_narration'`：`2 passed in 0.31s`
  - `tests/test_debate_api.py + tests/test_api.py -k 'predict_counterplay_still_succeeds_when_broadcast_fails or social_copy_rejects_provider_overrides_in_get_query'`：`2 passed in 0.41s`
- 本轮这类“SQLite runtime lock / leaderboard incremental update / vector cache LRU / whitespace question validation / hierarchical leader fallback”改动，当前还额外实跑通过：
  - `tests/test_predictions.py + tests/test_vector_store.py + tests/test_runtime_lock.py + tests/test_debate_service.py + tests/test_debate_api.py + tests/test_api.py + tests/test_simulator.py`：`206 passed in 61.40s`
  - `ruff check --ignore E501 app/api/helpers.py app/api/scenarios.py app/api/schemas.py app/services/debate.py app/services/runtime_lock.py app/services/scoring.py app/services/vector_store.py tests/test_api.py tests/test_debate_service.py tests/test_predictions.py tests/test_runtime_lock.py tests/test_vector_store.py`：通过
- 本轮这类“campaign finalize / rolling briefing + compression override / intervention queue cleanup / vector store / runtime lock”改动，当前还额外实跑通过：
  - `tests/test_predictions.py tests/test_parser.py tests/test_memory.py tests/test_campaign_service.py tests/test_gameplay_contract_sync.py -q`：`106 passed in 101.36s`
  - `tests/test_campaign_api.py -q`：`12 passed in 0.72s`
  - `tests/test_simulator.py -k 'reuses_latest_rolling_briefing_before_current_window or passes_llm_overrides_into_compression' -q`：`2 passed in 0.31s`
  - `tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`60 passed in 1.79s`
  - `tests/test_simulator.py tests/test_intervention.py tests/test_api.py -k 'intervene or pending_intervention or delete_cascade_data or pop_next_pending_intervention_preserves_order or clear_pending_interventions_for_scenario_is_scoped or delete_uses_vector_store_cleanup' -q`：`19 passed in 1.49s`
  - `tests/test_vector_store.py -q`：`21 passed in 3.50s`
  - `tests/test_runtime_lock.py tests/test_vector_store.py tests/test_predictions.py tests/test_campaign_service.py tests/test_campaign_api.py -q`：`84 passed in 4.82s`
  - 对应两组 `ruff check`：通过
- 本 session 这轮“vector-store per-scenario write lock / runtime-lock cleanup”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_runtime_lock.py tests/test_vector_store.py -q`：`38 passed in 4.86s`
  - `python -m ruff check --ignore E501 app/services/runtime_lock.py app/services/vector_store.py tests/test_runtime_lock.py tests/test_vector_store.py`：通过
- 本轮这类“engine 初始化竞态 / scenario replay import 边界 / prediction 提交窗口 / scenario 删除回滚 campaign side effects / Debate 空 turn fallback”改动，当前还额外实跑通过：
  - `pytest -q backend/tests/test_models.py backend/tests/test_api.py backend/tests/test_debate_service.py backend/tests/test_predictions.py -k 'get_engine_initializes_once_under_concurrency or import_replay_scenario or submit_prediction_rejects or delete_cascade_removes_campaign_log_and_detaches_badge_source or social_copy_trims_output_to_platform_limit or run_debate_background_finishes_with_structured_result or concurrent_calls_only_persist_once'`：`9 passed, 145 deselected in 1.07s`
  - `python -m ruff check --ignore E501 backend/app/models/database.py backend/app/api/predictions.py backend/app/api/scenarios.py backend/app/services/debate.py backend/tests/test_api.py backend/tests/test_models.py`：通过
- 本轮这类“backend review hardening / JSON round summary / language-aware prompts / runtime guard / pagination / transactional pending queue / social copy safety trim”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_llm_client.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py -q`：`335 passed`
  - `python -m ruff check --ignore E501 app/services/simulator.py app/services/memory.py app/services/lang_detect.py app/services/llm_client.py app/services/vector_store.py app/services/runtime_lock.py app/api/ws.py app/api/interventions.py app/api/predictions.py app/services/scoring.py app/api/social.py tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_llm_client.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py`：通过
- 本轮这类“config 启动期校验 / shared AsyncClient / stream 首包前重试 / debate replay import 收紧 / simulator 批量写消息”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py tests/test_memory.py tests/test_lang_detect.py tests/test_vector_store.py tests/test_runtime_lock.py tests/test_ws.py tests/test_intervention.py tests/test_api.py tests/test_predictions.py -q`：`368 passed in 37.64s`
  - `python -m ruff check --ignore E501 app/config.py app/main.py app/api/debate.py app/services/llm_client.py app/services/simulator.py tests/test_config.py tests/test_debate_api.py tests/test_llm_client.py tests/test_simulator.py`：通过
- 本轮这类“engine-managed SQLite 轻量迁移 / shared AsyncClient 跨 event loop 隔离 / stale client 后台关闭 / Chroma init 超时后接管与重试恢复”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_corner_cases.py -k init_db_reuses_engine_managed_connection_for_sqlite_migrations -q`：`1 passed, 33 deselected in 0.21s`
  - `python -m pytest tests/test_llm_client.py -k 'shared_async_client or event_loop_closed_runtime_error' -q`：`3 passed in 0.32s`
  - `python -m pytest tests/test_predictions.py -k 'score_prediction_not_found or score_prediction_already_scored or score_all_for_scenario_reports_no_pending_predictions' -q`：`3 passed in 0.50s`
  - `python -m pytest tests/test_parser.py -k 'falls_back_to_deterministic_parse_when_llm_json_is_invalid or fallback_rounds_use_explicit_default_rounds' -q`：`2 passed in 0.30s`
  - `python -m pytest tests/test_vector_store.py -q`：`27 passed in 3.63s`
  - `python -m pytest tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py -q`：`82 passed in 25.37s`
  - `python -m ruff check --ignore E501 app/models/database.py app/services/llm_client.py app/services/vector_store.py tests/test_corner_cases.py tests/test_llm_client.py tests/test_vector_store.py`：通过
- 本 session 这轮“prediction 唯一约束 / runtime_lock 只读路径 / vector store busy-skip / 前端状态单调守卫”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_predictions.py tests/test_api.py tests/test_runtime_lock.py tests/test_vector_store.py -q`：`190 passed in 9.60s`
  - `python -m ruff check --ignore E501 app/models/predictions.py app/api/predictions.py app/models/database.py app/services/runtime_lock.py app/services/vector_store.py tests/test_predictions.py tests/test_api.py tests/test_runtime_lock.py tests/test_vector_store.py alembic/versions/012_add_prediction_scenario_user_unique_index.py`：通过
- 本 session 这轮“WS 并行广播 / challenge rotation API”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_ws.py -q`：`21 passed in 0.96s`
  - `python -m pytest tests/test_campaign_api.py -q`：`14 passed in 0.88s`
  - `python -m ruff check --ignore E501 app/api/campaign.py app/services/daily_challenges.py tests/test_campaign_api.py`：通过
- 本 session 这轮“structured API errors / replay artifact structured detail / ws resource guard”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_api.py tests/test_debate_api.py tests/test_campaign_api.py tests/test_ws.py -q`：`157 passed in 7.01s`
  - `python -m ruff check --ignore E501 app/api app/services/debate.py app/services/vector_store.py tests/test_api.py tests/test_debate_api.py tests/test_campaign_api.py tests/test_ws.py tests/test_debate_service.py tests/test_corner_cases.py tests/test_vector_store.py`：通过
- 本 session 这轮“debate/simulation ws structured error payload + vector store self-heal”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_debate_service.py tests/test_corner_cases.py tests/test_ws.py -q`：`72 passed in 2.29s`
- 本 session 这轮“backend review fixes / structured logging / parser incomplete fallback”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_backend_code_review_fixes.py -q`：`4 passed in 0.45s`
  - `python -m pytest tests/test_vector_store.py tests/test_parser.py tests/test_models.py -q`：`64 passed in 71.56s`
  - `python -m pytest tests/test_logging_utils.py tests/test_config.py -q`：`13 passed in 0.41s`
  - `python -m pytest tests/test_api.py -k 'test_root or test_health' -q`：`2 passed, 90 deselected in 2.96s`
  - `python -m pytest tests/test_logging_utils.py tests/test_config.py tests/test_api.py tests/test_metrics.py tests/test_vector_store.py tests/test_parser.py tests/test_predictions.py tests/test_models.py tests/test_backend_code_review_fixes.py tests/test_corner_cases.py -k 'init_db_reuses_engine_managed_connection_for_sqlite_migrations or test_root or test_health or test_metrics_endpoint_available or test_score_prediction_uses_english_prompt_for_english_scenario or test_retries_underfilled_agent_plan_and_tops_up_small_shortfall or test_hot_path_foreign_key_indexes_exist or test_store_ready_false_while_init_pending or test_get_vector_store_reuses_pending_instance_without_duplicate_init or test_get_vector_store_recovers_after_late_init_finishes or test_import_replay_scenario_persists_snapshot or test_create_scenario_returns_immediately_and_schedules_background_parse or test_import_replay_scenario_maps_message_agent_by_name_when_agent_id_missing or test_get_groups_returns_leader_and_members or test_settings_defaults or test_settings_from_env or test_settings_normalize_log_config or test_settings_reject_invalid_log_level or test_settings_reject_invalid_log_format or test_json_log_formatter_outputs_structured_payload or test_json_log_formatter_includes_exception_text or test_configure_logging_uses_requested_formatter' -q`：`23 passed, 215 deselected in 3.75s`
  - `python -m pytest -q`：`998 passed in 223.31s (0:03:43)`
  - `python -m ruff check --ignore E501 app/main.py app/config.py app/logging_utils.py app/services/vector_store.py app/models/agent_group.py app/models/database.py app/api/scenarios.py app/api/schemas.py tests/test_logging_utils.py tests/test_config.py tests/test_api.py tests/test_metrics.py tests/test_vector_store.py tests/test_parser.py tests/test_predictions.py tests/test_models.py tests/test_backend_code_review_fixes.py tests/test_corner_cases.py alembic/versions/011_add_agent_group_scenario_index.py`：通过
- 本 session 这轮“review 收口 + leaderboard 重算 + vector store 场景级失效隔离 + debate/llm/simulator hardening”改动，当前还额外实跑通过：
  - `python -m pytest tests/test_predictions.py tests/test_vector_store.py tests/test_debate_service.py tests/test_llm_client.py tests/test_simulator.py -q`：`161 passed in 25.52s`
  - `python -m ruff check --ignore E501 app/services/scoring.py app/services/vector_store.py app/services/debate.py app/services/llm_client.py app/services/simulator.py tests/test_predictions.py tests/test_vector_store.py tests/test_debate_service.py tests/test_llm_client.py tests/test_simulator.py`：通过
- 本 session 这轮“WS event meta / BYOK session policy / WS debug observability”改动，当前还额外实跑通过：
  - `source .venv/bin/activate && cd backend && python -m pytest tests/test_ws.py -q`：`28 passed in 1.17s`
  - `source .venv/bin/activate && cd backend && python -m ruff check --ignore E501 app/api/ws.py tests/test_ws.py`：通过
- 本 session 这轮 `api / llm_client / runtime_lock / simulator` 定向回归，当前还额外实跑通过：
  - `python -m pytest tests/test_api.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_simulator.py -q`：`205 passed in 26.75s`
  - `python -m ruff check --ignore E501 app/api/helpers.py app/api/scenarios.py app/api/schemas.py app/services/llm_client.py app/services/runtime_lock.py app/services/simulator.py tests/test_api.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_simulator.py`：通过
- 本 session 这轮“runtime lock lease / runtime guard ensure cache / pending count SQL COUNT / global INTERNAL_ERROR / contract fstat / challenge rotation 固定 order”改动，当前还额外实跑通过：
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_debate_service.py tests/test_llm_client.py tests/test_runtime_lock.py tests/test_api.py tests/test_intervention.py -q`：`189 passed in 25.36s`
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_intervention.py tests/test_gameplay_contract_sync.py tests/test_api.py -q`：`143 passed in 8.77s`
  - `cd backend && source .venv/bin/activate && python -m pytest tests/test_campaign_api.py tests/test_corner_cases.py -q`：`54 passed in 1.69s`

### Frontend

```bash
cd frontend
npm test -- --run src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/stores/simulationStore.test.ts src/components/TimelineBar.test.tsx src/components/BranchEdge.test.tsx src/components/GameplayCardsModal.test.tsx src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run test:spike:phaser-custom
```

- 当前 targeted frontend set：`112 passed`
- 本 session 这轮“安全读重试 / WS 去重与重连日志 / 409 可见反馈 / 移动端结果页操作区修复”改动，当前还额外实跑通过：
  - `src/api/client.test.ts + src/hooks/useSimulationWS.test.tsx + src/hooks/useDebateWS.test.tsx + src/i18n/locales.test.ts`：`26 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
  - `node scripts/e2e-suite.mjs mobile --url http://127.0.0.1:18930 --output-dir output/e2e/20260325-postfix-mobile-review --headless`：通过
  - `node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18930 --output-dir output/e2e/20260325-postfix-debate-review --headless`：通过
- 当前推荐前端定向回归已收口到本 session 实跑过的 Input / Simulation / timeline / branch edge / GameplayCardsModal / VizSynthesizer / WorldScene / i18n 子集；类型检查、build 与 `phaser-custom` spike 单列执行。
- 本 session 这轮“Input/Simulation hook 拆分 + `startSimulation(options)` + Simulation i18n 收口”改动，当前还额外实跑通过：
  - `src/lib/directorIdentity.test.ts + src/lib/debateCounterplay.test.ts + src/lib/scenarioMeta.test.ts + src/lib/dailyChallenge.test.ts + src/lib/llmProviderPolicy.test.ts + src/pages/InputView.test.tsx + src/pages/SimulationView.test.tsx + src/stores/simulationStore.test.ts + src/hooks/useSimulationWS.test.tsx`：`81 passed in 1.57s`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 本轮这类“`scenarioMeta` 继续收口 + replay helper 动态加载 + Theater 首屏/截图兜底 + BootScene/WorldScene 资源加载优化”改动，当前还额外实跑通过：
  - `src/hooks/useScreenCapture.test.ts + src/lib/scenarioMeta.test.ts + src/lib/scenarioReplay.test.ts + src/pages/ResultView.test.tsx + src/pages/SimulationView.test.tsx`：`42 passed`
  - `src/lib/simulationReplay.test.ts + src/lib/scenarioReplay.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`：`32 passed`
  - `src/game/sceneAssetPlan.test.ts + src/game/PhaserGameLoader.test.ts + src/pages/SimulationView.test.tsx`：`30 passed`
- 本轮这类“默认 build / vitest 切到本地精简 Phaser 入口 + `e2e-suite` revision 修复”改动，当前还额外实跑通过：
  - `src/game/PhaserGame.test.ts + src/game/PhaserGameLoader.test.ts + src/game/replaySync.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx`：`41 passed`
- 本轮这类“`scenarioMeta` 持久化继续压缩 + shared replay codec + WebKit capture / mobile Theater 收口”改动，当前还额外实跑通过：
  - `src/lib/scenarioReplay.test.ts + src/lib/simulationReplay.test.ts + src/lib/scenarioMeta.test.ts + src/hooks/useScreenCapture.test.ts + src/pages/SimulationView.test.tsx + src/components/ShareModal.test.tsx`：`38 passed`
- 本轮这类“前端显式忽略 WS heartbeat keepalive，保持 live 页面无状态噪声”改动，当前还额外实跑通过：
  - `src/hooks/useDebateWS.test.tsx + src/stores/simulationStore.test.ts`：`22 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“截图 URL 回收 / replay 校验 / scenarioMeta 跨标签协议”改动，当前还额外实跑通过：
  - `src/hooks/useScreenCapture.test.ts + src/lib/simulationReplay.test.ts + src/pages/SimulationView.test.tsx`：`28 passed`
  - `src/lib/scenarioMeta.test.ts + src/pages/SimulationView.test.tsx + src/pages/ResultView.test.tsx + src/lib/scenarioReplay.test.ts`：`47 passed`
- 本 session 这轮“daily challenge rotation 后端化 / WorldScene ambient mote 池化 / GameplayCardsModal 联动收敛”改动，当前还额外实跑通过：
  - `src/pages/InputView.test.tsx + src/lib/dailyChallenge.test.ts + src/game/scenes/WorldScene.test.ts + src/components/GameplayCardsModal.test.tsx`：`34 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“ApiError.code 本地化映射 / Input+stores 错误收口 / ws error envelope / automation error object”改动，当前还额外实跑通过：
  - `src/pages/InputView.test.tsx + src/stores/simulationStore.test.ts + src/stores/debateStore.test.ts + src/hooks/useDebateWS.test.tsx + src/lib/apiErrorMessage.test.ts + src/api/client.test.ts`：`48 passed`
  - `src/pages/InputView.test.tsx + src/pages/SimulationView.test.tsx + src/pages/DebateArenaView.test.tsx + src/pages/ResultView.test.tsx + src/pages/DebateResultView.test.tsx + src/game/automation.test.ts + src/lib/apiErrorMessage.test.ts + src/stores/simulationStore.test.ts + src/stores/debateStore.test.ts + src/hooks/useDebateWS.test.tsx + src/api/client.test.ts`：`87 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“BYOK sessionStorage / WS meta envelope + debug / ResultView score BYOK 回归”改动，当前还额外实跑通过：
  - `cd backend && python -m pytest tests/test_ws.py -q`：`28 passed in 1.17s`
  - `cd backend && python -m ruff check --ignore E501 app/api/ws.py tests/test_ws.py`：通过
  - `cd frontend && npm test -- --run src/lib/llmProviderPolicy.test.ts src/components/ShareModal.test.tsx src/hooks/useSimulationWS.test.tsx src/hooks/useDebateWS.test.tsx src/pages/InputView.test.tsx`：`30 passed`
  - `cd frontend && npm test -- --run src/lib/wsDebug.test.ts src/pages/ResultView.test.tsx src/hooks/useSimulationWS.test.tsx src/hooks/useDebateWS.test.tsx`：`33 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“前端 provider-policy 测试同步 / phase&branch 单调守卫 / tone fallback”改动，当前还额外实跑通过：
  - `cd frontend && npm test -- --run src/lib/llmProviderPolicy.test.ts src/lib/predictionBetting.test.ts src/stores/debateStore.test.ts src/stores/simulationStore.test.ts`：`47 passed`
  - `cd frontend && npm test -- --run src/hooks/useDebateWS.test.tsx src/hooks/useSimulationWS.test.tsx src/pages/InputView.test.tsx src/i18n/locales.test.ts`：`30 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“scenarioMeta 锁竞争收口 / DebateArena stale counterplay + bet error / Result replay import error / History+Leaderboard i18n 回归”改动，当前还额外实跑通过：
  - `cd frontend && npm test -- --run src/lib/scenarioMeta.test.ts src/pages/DebateArenaView.test.tsx src/pages/ResultView.test.tsx`：`41 passed in 1.80s`
  - `cd frontend && npm test -- --run src/pages/HistoryView.test.tsx src/pages/LeaderboardView.test.tsx`：`2 passed in 496ms`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮“review fix 批次：回溯概率下限 / Debate 下注契约 / daily challenge & counterplay TTL / engine-managed SQLite guard / parser retry+重名收口 / detached Debate runtime”还额外实跑通过：
  - `cd backend && ../.venv/bin/python -m pytest tests/test_intervention.py tests/test_campaign_service.py tests/test_card_events.py tests/test_corner_cases.py tests/test_llm_client.py tests/test_parser.py tests/test_debate_api.py tests/test_debate_service.py -q`：`183 passed in 157.35s`
  - `cd backend && ../.venv/bin/python -m pytest tests/test_parser.py -q`：`14 passed in 100.08s`
  - `cd frontend && npm test -- --run src/components/DebateBetModal.test.tsx src/pages/DebateArenaView.test.tsx src/lib/dailyChallenge.test.ts src/lib/debateCounterplay.test.ts`：`25 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
  - 浏览器验收产物：
    - `output/web-game-debate/shot-0.png`
    - `output/web-game-debate/shot-1.png`
    - `output/web-game-debate/state-0.json`
    - `output/web-game-debate/state-1.json`
    - `output/e2e/debate-live-modal-playwright.png`
    - `output/e2e/debate-live-mobile-post-fix.png`
    - `output/e2e/debate-result-zh-playwright.png`
- 本 session 这轮“EventBridge stale-listener hardening / scenarioGameplayState structural compare”改动，当前还额外实跑通过：
  - `cd frontend && npm test -- --run src/game/managers/EventBridge.test.ts src/game/PhaserGame.test.ts src/game/scenes/WorldScene.test.ts src/pages/SimulationView.test.tsx src/lib/scenarioGameplayState.test.ts`：`66 passed`
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过
- 本 session 这轮 `InputView / SimulationView / simulationStore / TimelineBar / BranchEdge / GameplayCardsModal / VizSynthesizer / WorldScene / locales` 定向回归，当前还额外实跑通过：
  - `npm test -- --run src/pages/InputView.test.tsx src/pages/SimulationView.test.tsx src/stores/simulationStore.test.ts src/components/TimelineBar.test.tsx src/components/BranchEdge.test.tsx src/components/GameplayCardsModal.test.tsx src/game/managers/VizSynthesizer.test.ts src/game/scenes/WorldScene.test.ts src/i18n/locales.test.ts`：`112 passed`
  - `npx tsc --noEmit -p tsconfig.app.json`：通过
  - `npm run build`：通过
  - `npm run test:spike:phaser-custom`：`34 passed`

### WebSocket 调试

本地排查 scenario / debate 事件时，当前有两条轻量入口：

```bash
# 前端：浏览器地址后加 ?wsDebug=1
http://127.0.0.1:18928/sim/scenario-id?wsDebug=1
```

```js
// 前端：或在浏览器控制台里手动打开
sessionStorage.setItem('swarmoracle.ws-debug', '1')
```

```bash
# 后端：把 LOG_LEVEL 提到 DEBUG，可看到 stream/type/seq/event_id/client count
cd backend
LOG_LEVEL=DEBUG uvicorn app.main:app --host 127.0.0.1 --port 18927
```

### 视频素材采集

V2 系列当前统一走：

```bash
cd frontend
node scripts/capture-v2-series-assets.mjs <blackboard-walkthrough|gameplay-explainer|longform-showcase> <zh|en> --url http://127.0.0.1:18929 --headless
```

- 当前已实跑通过 6 组素材 manifest：
  - `video/output/swarmoracle-blackboard-walkthrough-v1.zh.capture-manifest.json`
  - `video/output/swarmoracle-blackboard-walkthrough-v1.en.capture-manifest.json`
  - `video/output/swarmoracle-gameplay-explainer-v1.zh.capture-manifest.json`
  - `video/output/swarmoracle-gameplay-explainer-v1.en.capture-manifest.json`
  - `video/output/swarmoracle-longform-showcase-v1.zh.capture-manifest.json`
  - `video/output/swarmoracle-longform-showcase-v1.en.capture-manifest.json`
- 当前视频采集注意点：
  - `gameplay-explainer` 必须拆成 `board scenario` 和 `interaction scenario`
  - 切 Theater 前必须等 automation payload 里的 `can_toggle_view_mode=true`
  - 玩法卡、下注和分享都按页面 automation state 等待，不要靠固定 sleep 猜状态
  - `longform-showcase` 的 Debate 段默认复用 `promo-v1` 已有 Debate raw/gif/still

### Fork Detector 实验

当前若要复现实验链路，统一走：

```bash
cd frontend
npm run e2e:fork-experiment -- \
  --api-url http://127.0.0.1:18927 \
  --question '如果我是马斯克 能登上月球吗？' \
  --temperatures 0,0.4,0.7,1.0 \
  --branch-sensitivities 0.3,0.7,0.9 \
  --fork-prompt-variants a,b,c,d,e,f \
  --fork-detector-active-branch-limits 0,1,2 \
  --runs 2 \
  --rounds 3 \
  --num-agents 20 \
  --concurrency 1 \
  --timeout-ms 1800000 \
  --output-dir output/e2e/manual-fork-lab
```

- 当前脚本会：
  - 直接调用 `POST /api/scenario`
  - 轮询 `/api/scenario/{id}` 到 `done / error`
  - 读取 `/api/scenario/{id}/story`
  - 输出 `result.json + results.csv + samples/*.json`
- 当前主工件字段包括：
  - `temperature`
  - `branch_sensitivity`
  - `fork_prompt_variant`
  - `fork_detector_active_branch_limit`
  - `fork_event_count / forked_branch_count / branch_count / story_branch_count`
  - `fork_debug.round_checks[*]`
- 本 session 已落盘的 detector 实验工件包括：
  - `frontend/output/e2e/musk-factor-matrix/`
  - `frontend/output/e2e/musk-sensitivity-temperature-matrix/`
  - `frontend/output/e2e/musk-prompt-ablation-matrix-r3/`
  - `frontend/output/e2e/budget-generalization-matrix/`

### 本轮新增验证

- backend：
  - `python -m pytest backend/tests/test_llm_client.py -k temperature_when_provided -q`
  - `python -m pytest backend/tests/test_api.py -k 'forwards_temperature or forwards_branch_controls or detector_branch_budget or persisted_fork_debug_round_checks or get_scenario_exposes_diverge_messages_and_fork_debug' -q`
  - `python -m pytest backend/tests/test_simulator.py -k 'fork_debug_trace or passes_llm_overrides_into_compression or passes_llm_overrides_into_narration or passes_llm_overrides_into_detector or variant_b_uses_alternate_prompt or detector_branch_budget_skips_lower_ranked_active_branch' -q`
  - `python -m ruff check --ignore E501 backend/app/services/llm_client.py backend/app/services/parser.py backend/app/services/memory.py backend/app/services/narrator.py backend/app/services/simulator.py backend/app/api/schemas.py backend/app/api/helpers.py backend/app/api/scenarios.py backend/tests/test_llm_client.py backend/tests/test_api.py backend/tests/test_simulator.py`
- frontend：
  - `cd frontend && npx tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果我是马斯克 能登上月球吗？' --temperatures 0,0.4,0.7,1.0 --runs 3 --rounds 5 --num-agents 20 --output-dir output/e2e/musk-factor-matrix`
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？' --temperatures 0.4 --branch-sensitivities 0.7 --fork-prompt-variants a,b,c,d --runs 1 --rounds 3 --num-agents 20 --output-dir output/e2e/jury-prompt-matrix`
  - `cd frontend && node scripts/fork-experiment.mjs --api-url http://127.0.0.1:18927 --question '如果我是马斯克 能登上月球吗？' --question '如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？' --question '如果互联网从未被发明？' --temperatures 0.4 --branch-sensitivities 0.7 --fork-prompt-variants b --fork-detector-active-branch-limits 0,1,2 --runs 1 --rounds 3 --num-agents 20 --output-dir output/e2e/budget-generalization-matrix`

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
- 当前默认 `vite.config.ts` / `vitest.config.ts` 已通过 alias 指向本地精简 Phaser 入口 `frontend/experiments/phaser-custom/entry.mjs`
- `e2e-suite.mjs` 里的 `director_state_roundtrip / gameplay_state_roundtrip` 当前也会先回读 authority 的最新 `revision` 再 PUT，避免 signoff 被固定历史样本的 stale revision 卡住
- 当前 checkout 是否已严格签收，应以重新实跑生成的 `summary.json` 为准，而不是直接套用旧工件

本 session 还额外实跑通过了一次带脏工作树的 release signoff：

- `cd frontend && node scripts/release-signoff.mjs --url http://127.0.0.1:18931 --backend-url http://127.0.0.1:18927 --output-root output/e2e/20260325-session-release-signoff --headless`
- 工件：`frontend/output/e2e/20260325-session-release-signoff/summary.json`
- 状态：`passed`
- 绑定 git：
  - `branch = master`
  - `commit = 8c94b2bac5482c2ddaed44d8c8dbfc2fa0639787`
  - `dirty = true`
- 这份工件同样覆盖 backend targeted checks、`/metrics`、`tsc`、`build`、perf budgets、assets、`corners`、`mobile`、`cross-browser`、`debate-full`

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
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- Docker 默认 LLM 地址是 `http://host.docker.internal:8318/v1/chat/completions`，用于容器访问宿主机本地代理。

## 数据库迁移

```bash
cd backend
source .venv/bin/activate
alembic revision --autogenerate -m "describe change"
alembic upgrade head
alembic current
```

- 当前最新 revision：`008_add_hot_path_foreign_key_indexes`。
- 若本地 SQLite 文件是早期通过 `init_db()` 长出来的 legacy 数据库，Alembic revision 标记可能比实际 schema 更旧；若 `alembic upgrade head` 命中“table already exists”这类错误，先看 `alembic current` 再继续处理。

## 代码约定

- `README.md`
  - 产品范围、当前交付状态、快速上手
- `llmdoc/overview/*.md`
  - 模块真值
- `progress.md`
  - 过程日志，不作为当前真值
