# 开发指南

> 文档类型：L0 current-truth
> 作用：当前开发、测试、预览与签收命令入口。只保留操作手册，不保留 session 级验证日志。

## 环境要求

- Python `>= 3.11`
- Node.js `>= 18`
- npm `>= 9`

## 本地开发

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927
```

如果本机有多个同级工作区都带 `app/` 包，优先显式指定：

```bash
uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --reload --port 18927
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

### 预览构建

```bash
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 18928
```

## Docker

```bash
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- Docker 默认读取仓库根目录 `.env.docker`。

## 环境变量

- 本地直接启动 backend 时，读取 `backend/.env`。
- 仓库根 `.env.example` 用于初始化本地模板。
- 详细配置项见 `llmdoc/reference/config.md`。

常见初始化：

```bash
cp .env.example backend/.env
```

## 常用验证

### Backend 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

### Backend 安全审计回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_audit_fixes.py -v
```

覆盖：输入长度验证、BYOK key 脱敏、OpenAPI 暴露开关、SQLite WAL、WS 消息大小限制、fork prompt 模板一致性、语言检测收口。共 65 个测试。

### Frontend 定向回归

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/scenarioGameplayState.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
```

- Vitest 当前在 `frontend/src/setupTests.ts` 里统一注入内存版 `localStorage / sessionStorage`。
- 需要预置持久化状态的前端测试，直接在测试体里写 `window.localStorage` 或 `window.sessionStorage`，不要依赖 Node Web Storage 的文件参数。

### Resume / P1-9 定向回归

```bash
cd frontend
npm test -- --run src/components/ResumePanel.test.tsx src/pages/ResultView.test.tsx src/i18n/locales.test.ts
npm run e2e:resume -- full
```

### P1-10 / P1-11 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_debate_argument_map.py tests/test_debate_service.py tests/test_config.py tests/test_agent_identity.py tests/test_api.py tests/test_p0_wiring.py tests/test_contract_freeze.py -q

cd ../frontend
npm test -- --run src/pages/InputView.test.tsx
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

### Oracle Chambers / Roundtable 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_ending_room_service.py tests/test_ending_room_api.py tests/test_ending_room_ws.py tests/test_vector_store.py tests/test_api.py -q

cd ../frontend
npm test -- --run src/lib/textLayout/pretext.test.ts src/lib/textLayout/textOverflowPredictor.test.ts src/lib/textLayout/oracleTranscriptLayout.test.ts src/lib/roundtableSelection.test.ts src/pages/ResultView.test.tsx src/components/EndingChatModal.test.tsx src/hooks/useEndingRoomWS.test.tsx src/stores/endingRoomStore.test.ts src/pages/WorldlineRoundtableView.test.tsx src/pages/roundtableHelpers.test.ts src/components/endingChatHelpers.test.ts src/pages/resultHelpers.test.ts src/pages/simulationHelpers.test.ts src/hooks/useTranscriptScroll.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run build

node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-followup-full --headless
node scripts/e2e-ending-room-followup-suite.mjs mobile --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-followup-mobile --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-desktop --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-full --headless
node scripts/e2e-worldline-roundtable-suite.mjs mobile --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-mobile --headless
```

当前脚本口径：

- `e2e-ending-room-followup-suite.mjs full`
  - 覆盖桌面 multi-ending，以及 mobile `single-ending verdict-anchor thread / multi-ending` 两条链路
  - 桌面/移动端均覆盖 `epilogue`（后续三回合）和 `evidence_card`（证据投牌）交互模式
  - ending-room follow-up 当前走 deterministic API-driven 口径：
    - 先 API 预热 `ending_chamber`
    - 再通过 `ResultView` 的 `debugEndingRoomBranch / debugEndingRoomMode / debugEndingRoomAgents` 直开 live chamber
    - `hotseat / all_present / epilogue / evidence_card` 由 API 发起，UI 只负责观测已提交状态和 readonly replay
  - current summary 会落出：
    - `question_anchor_ids / thread_question_anchor_ids_json / anchor_kind`
    - `current_speaker_turn_key / current_speaker_participant_id`
    - `pending_drafts / stream_state`
    - `transcript_layout`
  - 命中的 follow-up 场景当前还会额外落：
    - `turn-start`
    - `turn-delta`
    - `turn-commit`
- `e2e-ending-room-followup-suite.mjs mobile`
  - 覆盖 mobile `single-ending verdict-anchor thread / artifact readonly / local readonly / reload restore / import`
  - 同时覆盖 mobile multi-ending 的 `hotseat / all_present / epilogue / crossline gallery / evidence_card / readonly replay / restore / import`
  - `single-ending` anchored thread 当前会使用唯一 thread title；如果 UI automation 状态刷新偏慢，脚本会回退到 backend room snapshot 合成可验证状态
- `single-ending`
  - mobile 的 `verdict-anchor thread -> readonly replay -> reload restore -> import` 当前已进入 CLI summary
  - 桌面 single-ending 与中英语言切换当前仍建议保留真实浏览器复核
- `e2e-worldline-roundtable-suite.mjs desktop`
  - 当前适合单独复核 roundtable anchored follow-up 的真流式生命周期
  - current summary 会落出：
    - `question_anchor_ids / thread_question_anchor_ids_json / anchor_kind`
    - `current_speaker_turn_key / current_speaker_participant_id`
    - `pending_drafts / stream_state`
    - `transcript_layout`
      - `collapsible_turn_count / collapsed_turn_count`
  - desktop rerun 当前已能稳定落：
    - hotseat `turn_start / turn_delta / turn_commit`
    - anchored thread `turn_start / turn_delta / turn_commit`
- `e2e-worldline-roundtable-suite.mjs full`
  - 覆盖桌面 + mobile 的 `representative / manual_shortlist / expert_witness / trait_mix / fault_line_first / witness_augmented / hotseat`
  - 当前也覆盖 `quote-anchor thread -> artifact/local readonly -> reload restore -> import`
  - current summary 会落出 `transcript_layout`
- `e2e-worldline-roundtable-suite.mjs mobile`
  - 只跑移动端圆桌链路，适合单独复核 recipe 切换、hotseat thread switch、quote-anchor thread、readonly replay 与 restore/import
  - mobile rerun 当前也已重新抓回 anchored thread 的 `turn_delta`
  - 如果目标是 `P2` transcript layout 签收，desktop / mobile 分端 summary 当前比 `full` 更稳

### Type Check 与 Build

```bash
cd frontend
npm run lint
npx tsc --noEmit -p tsconfig.app.json
npm run build
npm run perf:budgets:check
npm run assets:provenance:check
```

### LLM 集成测试

`test_blackboard_e2e.py`、`test_token_matrix.py`、`test_e2e_matrix.py` 是需要真实 LLM 服务的集成测试。URL 从 `settings.LLM_RESPONSES_URL` 读取（通过 `_resolve_llm_api_url()` 统一解析），不再硬编码本地端口。运行方式：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_blackboard_e2e.py tests/test_token_matrix.py tests/test_e2e_matrix.py -v
```

如需使用不同 LLM 服务：

```bash
LLM_API_KEY=sk-xxx LLM_MODEL_NAME=gpt-xxx LLM_RESPONSES_URL=https://your-api/v1 python -m pytest tests/test_token_matrix.py tests/test_e2e_matrix.py -v
```

### Backend JSON Stream-First 定向回归

这组命令覆盖当前已经接到 `llm_call_json_with_stream_fallback()` 的主要结构化 JSON 链路：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_llm_client.py tests/test_parser.py tests/test_narrator.py tests/test_memory.py -q
python -m pytest tests/test_simulator.py -q -k 'IdentityCompactionSummary'
python -m pytest tests/test_identity_compaction.py tests/test_identity_compaction_integration.py tests/test_predictions.py -q -k 'score_prediction or score_all_for_scenario or score_predictions_endpoint'
python -m pytest tests/test_debate_service.py tests/test_ending_room_service.py -q
```

当前覆盖面：

- parser
- narrator
- memory 压缩
- identity compaction
- prediction scoring
- debate judge summary
- Oracle auto-recap 静态改写

### 本地网关 live probe

如果你在本地用 `8318 / 8317` 这类 OpenAI-compatible 兼容网关，先跑这条 probe，再决定是否把真实 LLM 纳入调试链路：

```bash
cd backend
source .venv/bin/activate
RUN_REAL_LLM_TESTS=1 python -m pytest tests/test_llm_gateway_probe.py -v -s
```

这条 probe 不进默认回归。它只回答两件事：

- 非流式 `chat/completions` / `responses` 当前有没有正文
- 流式 JSON 路径当前能不能正常返回可解析结果

### Identity Compaction 集成烟雾测试

真实 Chroma 路径的 identity compaction 烟雾测试是单独文件，不和原有 mock 单测混在一起：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_identity_compaction.py tests/test_identity_compaction_integration.py -q
```

说明：

- `test_identity_compaction.py` 仍是 mock 单测
- `test_identity_compaction_integration.py` 走真实临时 SQLite + 真实临时 Chroma
- 默认不用真实 LLM；LLM 路径问题应先用 `test_llm_gateway_probe.py` 单独确认

### Backend 健康检查

```bash
curl -sS http://127.0.0.1:18927/
curl -sS http://127.0.0.1:18927/metrics
curl -sS -X POST http://127.0.0.1:18927/api/health
```

## 发布签收

默认全链入口：

```bash
cd backend
source .venv/bin/activate
uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --host 127.0.0.1 --port 18927

cd frontend
npm run preview -- --host 127.0.0.1 --port 18928

cd frontend
npm run release:signoff -- --headless
```

说明：

- `release:signoff` 当前不会自己拉起 backend / preview。
- 默认口径固定读取：
  - frontend `http://127.0.0.1:18928`
  - backend `http://127.0.0.1:18927`
- 如果本地预览端口不同，显式传 `--url http://127.0.0.1:<port>`。

如果需要强制 Debate 使用 `llm_hybrid` 裁决模式：

```bash
cd frontend
SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid npm run release:signoff -- --headless
```

## 签收口径

- `README.md`
  产品范围与仓库入口。
- `llmdoc/overview/*.md`
  当前架构真值。
- `llmdoc/reference/*.md`
  按需查接口与配置。
- `frontend/output/e2e/**/summary.json`
  具体某次签收的产物与 git metadata。

最近一次稳定总链工件：

- `frontend/output/e2e/2026-04-10T14-07-43-466Z-release-signoff/summary.json`

最近一次 Oracle 专项签收工件：

- `frontend/output/e2e/20260331-oracle-signoff-ending-room/summary.json`
- `frontend/output/e2e/20260331-oracle-signoff-roundtable/summary.json`

最近一轮 Oracle 0.3 锚点观测工件：

- `frontend/output/e2e/20260331-codex-oracle-anchor-ending-room-mobile-v3/summary.json`
- `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-desktop-v8/summary.json`
- `frontend/output/e2e/20260331-codex-oracle-anchor-roundtable-mobile-v2/summary.json`

最近一轮 Oracle `P2` transcript layout scoped signoff 工件：

- `frontend/output/e2e/20260331-codex-p2-signoff-ending-room/summary.json`
- `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-desktop/summary.json`
- `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-mobile/summary.json`

最近一轮 roundtable 可读性收口工件：

- `frontend/output/e2e/20260331-codex-roundtable-readability-pass-desktop/summary.json`

最近一轮 Oracle roundtable Firefox / WebKit scoped regression 工件：

- `frontend/output/e2e/20260331-codex-oracle-roundtable-cross-browser-scoped/firefox/summary.json`
- `frontend/output/e2e/20260331-codex-oracle-roundtable-cross-browser-scoped/webkit/summary.json`

最近一次 roundtable `full` 稳定工件：

- `frontend/output/e2e/20260331-codex-roundtable-full-stable5/summary.json`

最近一轮 Oracle 流式观测 rerun 工件：

- `frontend/output/e2e/20260331-codex-followup-stream-lifecycle/summary.json`
- `frontend/output/e2e/20260331-codex-roundtable-stream-desktop-rerun/summary.json`
- `frontend/output/e2e/20260331-codex-roundtable-stream-mobile-rerun2/summary.json`

最近一轮经典模式流式 hardening 工件：

- `frontend/output/e2e/20260331-codex-classic-stream-hardening-rerun3/result.json`

使用规则：

- 引用“已签收”时，以具体 `summary.json` 中的 git metadata 为准。
- 不要把历史 session 日志或旧工件目录名直接当当前 `HEAD` 状态。

## 调试提示

- 主模式与 Debate WS 都会发送 `heartbeat`。
- 本地排查 WS 时序时，可使用 `?wsDebug=1` 或 `sessionStorage['swarmoracle.ws-debug']=1`。
- 需要更细的接口和配置说明时，再打开：
  - `llmdoc/reference/api.md`
  - `llmdoc/reference/config.md`
