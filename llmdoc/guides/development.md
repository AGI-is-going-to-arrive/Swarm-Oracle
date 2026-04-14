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

### 全仓回归

```bash
cd backend
source .venv/bin/activate
python -m pytest -q

cd ../frontend
npm test
```

### Backend 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

### Web Search 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_web_context.py tests/test_web_context_integration.py tests/test_web_search_contract.py tests/test_config.py -q

cd ../frontend
npm test -- --run src/pages/InputView.test.tsx
npx tsc --noEmit -p tsconfig.app.json
npm run lint
VITE_ENABLE_WEB_SEARCH=true npm run build
npm run e2e:web-search -- --url http://127.0.0.1:18928 --output-dir output/e2e/review-web-search --provider tavily
```

说明：

- 这组回归当前覆盖：
  - `tavily / exa / xai / searxng` provider dispatch
  - request-scoped `provider / API key / base URL`
  - 首页 `沿用服务器默认 / 自定义覆盖`
  - frontend custom override E2E 请求体校验
- `e2e:web-search` 当前会额外校验 `/api/scenario` 请求体里是否真的带上：
  - `web_search_enabled`
  - `web_search_provider`
  - `web_search_api_key`
  - `web_search_base_url`
- 如果要单独做真实 provider 烟测，可在 `backend/.venv` 下直接调用 `app.services.web_context.fetch_web_context()`。

### Backend 安全审计回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_audit_fixes.py -v
```

覆盖：输入长度验证、BYOK key 脱敏、OpenAPI 暴露开关、SQLite WAL、WS 消息大小限制、fork prompt 模板一致性、语言检测收口。共 65 个测试。

### Config Reload / Feature Gate / 时间敏感存储回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_audit_fixes.py tests/test_contract_freeze.py tests/test_counterfactual.py tests/test_growth_events_endpoint.py -q
python -m pytest tests/test_corner_cases.py -k 'init_db_reuses_engine_managed_connection_for_sqlite_migrations or init_db_adds_agent_group_scenario_index' -q

cd ../frontend
npm test -- --run src/lib/dailyChallenge.test.ts
```

说明：

- backend 这组回归当前主要看：
  - `app.config` / `app.main` reload 之后，缓存过 `from app.config import settings` 的模块要重新绑回当前 `settings`，避免拿旧对象继续断言
  - feature gate 测试直接 patch live router module 的 `settings`，不要 patch 测试文件顶层缓存的旧对象
  - 如果目标是 `_init_db_lightweight()` fallback 语义，测试里先显式 `monkeypatch.setattr(database_module, "_load_alembic_runtime", lambda: None)`，再断言 SQLite engine-managed migration / index 创建行为
- frontend 这组回归当前主要看：
  - 像 `dailyChallenge` 这种既吃传入 `date`、又会读 `Date.now()` 的存储逻辑，测试 setup 里统一 `vi.useFakeTimers()` + `vi.setSystemTime(fixedDate)`，避免 TTL prune 把固定历史 bucket 提前清掉

### Frontend 定向回归

```bash
cd frontend
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/scenarioGameplayState.test.ts src/lib/archiveSummary.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
```

- Vitest 当前在 `frontend/src/setupTests.ts` 里统一注入内存版 `localStorage / sessionStorage`。
- 需要预置持久化状态的前端测试，直接在测试体里写 `window.localStorage` 或 `window.sessionStorage`，不要依赖 Node Web Storage 的文件参数。

### Graph Viz / Debate Graph 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_counterfactual.py tests/test_resume.py tests/test_runtime_lock.py tests/test_fallback_migrations.py tests/test_causal_graph.py tests/test_debate_argument_map.py tests/test_contract_freeze.py tests/test_async_io_hooks.py tests/test_factions.py tests/test_debate_api.py -q
# 更宽一点的 backend smoke，用来兜住相邻 API / service 回归；不是 graph 专项断言
python -m pytest tests/test_api.py tests/test_debate_service.py -q
python -m ruff check app/api/graphs.py app/api/helpers.py app/services/runtime_lock.py app/services/causal_graph.py app/services/debate_argument_map.py app/models/checkpoint.py alembic/versions/021_scope_debate_argument_unit_dedup_per_turn.py tests/test_counterfactual.py tests/test_resume.py tests/test_runtime_lock.py tests/test_fallback_migrations.py tests/test_causal_graph.py tests/test_debate_argument_map.py

cd ../frontend
npm test -- --run src/lib/manualChunks.test.ts src/lib/performanceBudgets.test.ts src/lib/exportValidation.test.ts src/components/ArgumentMap.test.tsx src/components/GraphNodeCard.test.tsx src/components/NodeDetailPanel.test.tsx src/pages/CausalReviewView.test.tsx src/pages/ReplayEmptyState.test.tsx src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
npm run perf:budgets:check

# These two scripts use page.route() fixtures.
# They do not need a live backend, but they do need a reachable frontend host.
npm run preview -- --host 127.0.0.1 --port 18930
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-a.mjs full
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-b.mjs full
# Optional locale smoke
SWARM_E2E_LOCALE=zh-CN SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-a.mjs full
SWARM_E2E_LOCALE=zh-CN SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-b.mjs full
# Optional desktop cross-browser smoke
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-a.mjs desktop --browser firefox --headless
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-b.mjs desktop --browser firefox --headless
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-a.mjs desktop --browser webkit --headless
SWARM_URL=http://127.0.0.1:18930 node scripts/e2e-phase3-batch-b.mjs desktop --browser webkit --headless
```

说明：

- 本轮实测结果：
  - backend graph / replay / migration 定向 `268 passed`
  - backend 相邻 `api / service` smoke `158 passed`
  - targeted `ruff check` 通过
  - `npx tsc --noEmit -p tsconfig.app.json` / `npm run lint` / `npm run build` / `npm run perf:budgets:check` 通过
  - `phase3-batch-a full` `35/35`，Chromium 的 default / `zh-CN` locale 都通过，desktop / mobile 都绿
  - `phase3-batch-b full` `43/43`，Chromium 的 default / `zh-CN` locale 都通过，desktop / mobile 都绿
  - graph scoped cross-browser desktop rerun 通过：`phase3-batch-a` / `phase3-batch-b` 的 Firefox / WebKit 都通过
  - backend 全量 `python -m pytest -q` 本轮实测 `2049 passed, 2 skipped`
  - frontend 全量 `npm test` 本轮实测 `1001 passed`
- 这组回归当前覆盖：
  - `manualChunks` production 分块回归（`react` / `react/jsx-runtime` / `react-dom/client` / `scheduler` 保持在共享 `vendor`）
  - `perf:budgets:check` 当前也会检查共享 `vendor` chunk，并补上 `capture-gif / i18n-vendor`，不再只看 `phaser / capture-html / flow-vendor`
  - replay branch runtime lock 当前已补：
    - `counterfactual / resume` 的 mock 续租异常 fail-closed
    - 真实 SQLite 跨线程 heartbeat 续租异常 fail-closed
    - 锁丢失后被并发请求吃满最后一个 branch slot 时回退成 `429 REPLAY_BRANCH_LIMIT_REACHED`
  - debate runtime lock 当前已补：
    - 长运行续租
    - 续租返回 `None`
    - 续租抛异常
    - 真实 SQLite 跨线程 heartbeat 续租异常
    - 以上路径都会 fail-closed，把 debate 落成 `error`
  - `CausalReviewView` 分支 selector：
    - `available_branches` 缺失时，会从 payload 里的 `branch_id + children` 恢复可选分支
    - 相似前缀的 branch 也会直接显示完整 label，不再挤成同一个短标签
    - 较旧分支请求的返回不会覆盖较新的分支结果
    - 非法 `branch_id` 当前会返回 `404 BRANCH_NOT_FOUND`，不再伪装成空图
    - 非交互 fallback 路径会隐藏 export controls，并只保留一条具名的 a11y list；relationless snapshot fallback 也会走本地化提示
    - 错误态会按 `network / branch_not_found / unauthorized / server / load_failed` 映射到本地化 copy，不再把原始 `HTTP 404` 或后端 message 直接露给用户
  - `CausalReviewView` / `ArgumentMap` minimap 当前是非交互 overlay（`pointer-events: none`），不会挡住移动端 node click
    图节点可访问名称，以及 React Flow controls / minimap 文案也会跟随 UI 语言实时更新；切语言不会重打图请求。
  - `ArgumentMap`
    - `ArgumentStrengthMeter` 当前按本地化 `list / listitem` 摘要语义渲染，不再使用 `meter`
    - `verdict` 节点当前也走共享 graph i18n label，不再把可访问名称写死成英文
    - node-only 图当前也会保留 sr-only list，并可通过 graph node button 键盘打开 `NodeDetailPanel`
  - `NodeDetailPanel`
    - 关闭后会把焦点还给最近一次触发它的节点 / 按钮
    - `Copy Reference` 在 clipboard API 被拒时会回退到 `document.execCommand('copy')`
  - `ExportPanel` 当前在 PNG / SVG 导出失败时会显示可见失败提示，不再只打 `console.error`
  - `GraphNodeCard`
  - graph locale 资源
  - backend causal graph / debate argument map / contract freeze / async hook / factions 相关链路：
    - `020` migration 对 runtime schema repair 先跑的路径保持兼容
    - causal graph 读取 legacy duplicate snapshot 时优先取最新一份
    - causal append 幂等
    - replay branch runtime lock 当前会续租；慢 clone / seed 不会再因为 lease 过期突破共享上限
    - `resume` 当前会先预占 simulation lock，不再出现 `201` 已返回但后台实际没启动的假成功
    - `counterfactual` 当前会在 clone 前先校验目标 agent message；同 agent 同轮多消息时要求显式选定 source message，seed 失败也会清理掉新建 branch
    - `021` migration 当前会移除 legacy `debate_id + semantic_hash` 约束，并在升级前清理同 turn 的脏重复行
    - same-round sibling branch 节点隔离（含 `id=None`）
    - same-round 重复 `msg.id` 当前会继续按 branch 与 agent 隔离
    - 同 agent 同轮多消息
    - child-branch fork provenance
    - 非法 `trigger_node_ids` 会回退到 same-round provenance
    - fork replay 时显式 `trigger_node_ids` 会替换旧的 fallback provenance edge
    - argument map `? ! ？ ！` punctuation split
    - enrichment apply / rebuild 当前串行化
    - `supports / rebuts` 重建后会重挂到最新 claim，不保留 stale target；同一 turn 里按句子顺序取最后一条
    - `link_verdict()` 不会再把其他 snapshot 的 stale unit 重连回当前图里
- `npm run build` 当前必须配合 `src/lib/manualChunks.test.ts` 与 preview smoke 一起看；单看构建成功不足以证明 preview 不会白屏
- `phase3-batch-a` 主要看：
  - `CausalReviewView` 基础渲染
  - branch selector 会校验 `scenario title + probability` 的可读 option，同时把 `branch_id` 真正写回 URL，并发出过滤请求
  - graph export 按钮可见，且 `Export SVG` 会校验下载下来的 SVG 非空、结构可读
  - graph node 点击后 `NodeDetailPanel` 打开、展示 payload，并可关闭
  - screen-reader fallback list 确实存在，且至少有 1 条 list item
  - relationless graph（多节点但 0 边）会切到本地化 snapshot fallback；此时不再挂 ReactFlow，也不会显示 export controls，并且只保留一条 a11y list
- `phase3-batch-b` 主要看：
  - `ArgumentMap` 基础渲染
  - 本地化强度摘要 aria-label（default / `zh-CN` locale 都能定位）
  - legend 可见
  - `Export SVG` 会校验下载下来的 SVG 非空、结构可读
  - 本地化 verdict 节点标签可见
  - graph node 点击后 `NodeDetailPanel` 打开、展示详情文本 / status，并可关闭
  - fail-soft 错误态会显示失败文案和 `Retry`，同时隐藏图与导出
  - status filter 走到空态分支，并可 `Clear` 恢复图谱
  - compare theater 的 actor / message / bubble 状态都非空
  - 与结果页图谱接线是否还活着
  - 脚本 summary 在 step 失败时会把测试名写进 `failedTests`
- 两条 `phase3` 脚本当前都走 `page.route()` fixtures；fixture 命中的请求会继续按脚本内假数据完成，不需要 live backend
- 两条 `phase3` 脚本当前都支持 `--browser chromium|firefox|webkit`；这轮 Firefox / WebKit 只做 desktop scoped regression
- 两条 `phase3` 脚本现在按 fail-closed 收口浏览器侧异常：
  - 任意 `pageerror`
  - 任意非导航中止类 `requestfailed`
  - 任意相关 `console.error / console.assert`
  - 都会写入 `browser-issues.json`，并让该 surface 失败
- 当前放行的浏览器噪音只有两类：
  - 浏览器导航收尾常见的 `ERR_ABORTED / NS_BINDING_ABORTED`
  - `fonts.googleapis.com / fonts.gstatic.com` 的 `stylesheet / font` 外部字体失败
- 其他 `ECONNREFUSED`、未拦截 API、脚本报错都会直接反映到 summary 和退出码

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
npm test -- --run src/pages/InputView.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/ui/SpotlightTurnCard.test.tsx
node --test scripts/e2e-debate-suite.test.mjs
node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/debate-full --headless
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

- debate mobile E2E 当前按 rail fail-closed：
  - 只认 `.debate-mobile-rail .btn`
  - rail 按钮不可用，或点击后没打开 modal / 没跳到结果页，脚本会直接失败
  - 不再 fallback 去点隐藏 hero CTA
- 这组定向回归当前还会看：
  - 页面壳不再跟着 debate payload 里的 `language` 静默改全局 UI 语言
  - mixed-language fallback 当前覆盖 `phase commentary / replay quote / prediction score reason`
  - `node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/debate-full --headless` 本轮通过

### Oracle Chambers / Roundtable 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_ending_room_service.py tests/test_ending_room_api.py tests/test_ending_room_ws.py tests/test_vector_store.py tests/test_api.py -q

cd ../frontend
npm test -- --run src/lib/textLayout/pretext.test.ts src/lib/textLayout/textOverflowPredictor.test.ts src/lib/textLayout/oracleTranscriptLayout.test.ts src/lib/roundtableSelection.test.ts src/lib/e2eReplayGuards.test.ts src/lib/endingRoomReplayAutomation.test.ts src/lib/roundtableReplayAutomation.test.ts src/lib/endingRoomPickerAutomation.test.ts src/pages/ResultView.test.tsx src/components/EndingChatModal.test.tsx src/hooks/useEndingRoomWS.test.tsx src/stores/endingRoomStore.test.ts src/pages/WorldlineRoundtableView.test.tsx src/pages/roundtableHelpers.test.ts src/components/endingChatHelpers.test.ts src/pages/resultHelpers.test.ts src/pages/simulationHelpers.test.ts src/hooks/useTranscriptScroll.test.ts
node --test scripts/e2e-ending-room-followup-suite.test.mjs
npx tsc --noEmit -p tsconfig.app.json
npm run build

node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-followup-full --headless
node scripts/e2e-ending-room-followup-suite.mjs mobile --url http://127.0.0.1:18928 --output-dir output/e2e/oracle-ending-room-followup-mobile --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-desktop --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --browser firefox --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-firefox --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --browser webkit --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-webkit --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-full --headless
node scripts/e2e-worldline-roundtable-suite.mjs mobile --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-mobile --headless
```

当前脚本口径：

- `e2e-ending-room-suite.mjs full`
  - 默认 `fixture=single`，覆盖 desktop + mobile 的结果页基础链路：
    - result -> picker -> ending chamber
    - `hotseat / all_present`
    - `one_move_only`
  - 如需多结局基础 smoke，再补 `--fixture multi-ending`
  - picker confirm 当前走 DOM-first：
    - 先等 `.ending-chat-modal`
    - 再等 live chamber usable
    - 如果 `modal_state` 因 bootstrap / cleanup 短暂回到 `null`，脚本会退回 chamber UI-ready 判定，不会误报“modal 没打开”
- `e2e-ending-room-followup-suite.mjs full`
  - 覆盖桌面 multi-ending，以及 mobile `single-ending verdict-anchor thread / multi-ending` 两条链路
  - 桌面/移动端均覆盖 `epilogue`（后续三回合）和 `evidence_card`（证据投牌）交互模式
  - ending-room follow-up 当前走 deterministic API-driven 口径：
    - 先 API 预热 `ending_chamber`
    - 再通过 `ResultView` 的 `debugEndingRoomBranch / debugEndingRoomMode / debugEndingRoomAgents` 直开 live chamber
  - `hotseat / all_present / epilogue / evidence_card` 由 API 发起，UI 只负责观测已提交状态和 readonly replay
  - replay coverage 当前额外做了三层收口：
    - 复用旧页面前先 revalidate live chamber
    - `Copy / Save / Import` 只在 `.ending-chat-header__actions` 里找
    - readonly replay 必须同时满足 replay URL、Import 可见、composer 不可发
  - replay coverage 现在按 fail-closed 收口：
    - artifact/local readonly
    - import
    - reload/restore
    - 任一关键字段缺失都会直接报错，不再 best-effort 保 `summary.json`
  - `hotseat / all_present / epilogue` 当前会额外校验目标 `roomId + threadId + interaction_mode`
    - 不再只看当前可见线程的局部 `modal_state`
    - fallback 优先走 API-driven / snapshot / settled 验真
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
  - fixture 选择当前会优先取最新、且 branches 全部 `COMPLETED` 的 `single / multi done scenario`
  - `single-ending` anchored thread 当前会使用唯一 thread title；如果 UI automation 状态刷新偏慢，脚本会回退到 backend room snapshot 合成可验证状态
  - anchored fallback 也会补校验 `threadId + questionAnchorIds + assistant reply`，不再把 `state: null` 或只有 user turn 的快照当成成功
- `e2e-ending-room-followup-suite.mjs full / mobile`
  - 当前更适合专项 follow-up 回归
  - `full` 本轮通过
  - 当前最新 mobile rerun 已通过：`frontend/output/e2e/review-ending-room-mobile-pass3/summary.json`
  - 慢流式场景仍可能只落到 fallback 观测，不一定每次都有完整 lifecycle 工件
  - 如果目标只是基础 smoke，优先跑 `e2e-ending-room-suite.mjs full`
- `single-ending`
  - mobile 的 `verdict-anchor thread -> readonly replay -> reload restore -> import` 仍是目标覆盖链路
  - 桌面 single-ending 与中英语言切换当前仍建议保留真实浏览器复核
- `e2e-worldline-roundtable-suite.mjs desktop`
  - 当前适合单独复核 roundtable anchored follow-up 的真流式生命周期
  - Chromium / Firefox / WebKit 当前都可通过 `--browser` 单独执行
  - desktop 链路当前覆盖 pointer drag、`KeyboardSensor` 键盘拖拽、expert witness、selection mode 切换、hotseat、anchored thread、artifact/local readonly replay
  - replay 覆盖当前和 ending-room followup 保持同一口径：
    - hero/header action scoped locator
    - live room 复用前先 revalidate
    - readonly replay 先校验 replay URL 契约
    - artifact share readonly restore 与 local readonly restore 都会校验，coverage 缺口直接失败
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
  - result -> roundtable 入口当前会重试；如果还停在结果页，会落 `roundtable-entry-stall.json` 并直接失败
  - 当前 fresh full rerun 已通过 desktop + mobile
- `e2e-worldline-roundtable-suite.mjs mobile`
  - 只跑移动端圆桌链路，适合单独复核 recipe 切换、touch `click-to-seat`、hotseat thread switch、quote-anchor thread、readonly replay 与 restore/import
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

`test_blackboard_e2e.py`、`test_token_matrix.py`、`test_e2e_matrix.py` 是需要真实 LLM 服务的集成测试。URL 从 `settings.LLM_RESPONSES_URL` 读取（通过 `_resolve_llm_api_url()` 统一解析），不再硬编码本地端口。`test_blackboard_e2e.py` 当前会对瞬时 `5xx` 做有限重试；持续 `4xx / 5xx` 仍然直接失败。运行方式：

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
python -m pytest tests/test_simulator.py -q -k 'IdentityCompactionSummary or passes_llm_overrides_into_detector or detector_variant_b_uses_alternate_prompt or detector_falls_back_to_no_fork_when_helper_errors'
python -m pytest tests/test_identity_compaction.py tests/test_identity_compaction_integration.py tests/test_predictions.py -q -k 'score_prediction or score_all_for_scenario or score_predictions_endpoint'
python -m pytest tests/test_debate_service.py tests/test_debate_argument_map.py tests/test_ending_room_service.py -q
```

当前覆盖面：

- parser
- narrator
- memory 压缩
- identity compaction
- prediction scoring
- debate judge summary
- debate argument map enrichment
- fork detection
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

补充：

- 这条 probe 现在会把非流式 `500`、空正文、空 `output` 都记成观测结果，不会因为某个本地网关瞬时波动直接把整条 probe 跑挂

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
- 默认 `release-signoff` 当前已纳入：
  - graph default / `zh-CN` smoke（`phase3-batch-a`、`phase3-batch-b`）
  - roundtable Firefox / WebKit scoped regression
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

- `frontend/output/e2e/2026-04-12T04-12-03-164Z-release-signoff/summary.json`

最近一轮 Oracle replay hardening 工件：

- `frontend/output/e2e/review-phase-d-ending-desktop-replay-hardened/summary.json`
- `frontend/output/e2e/review-phase-d-ending-mobile-replay-hardened/summary.json`
- `frontend/output/e2e/review-roundtable-suite-hardened-desktop/summary.json`
- `frontend/output/e2e/review-roundtable-suite-hardened-mobile/summary.json`

最近一轮 ending-room 基础 smoke 修复工件：

- `frontend/output/e2e/review-ending-room-suite-fixed-single/summary.json`
- `frontend/output/e2e/review-ending-room-suite-fixed-full-single/summary.json`
- `frontend/output/e2e/review-ending-room-suite-fixed-desktop-multi/summary.json`

最近一轮 Oracle roundtable Firefox / WebKit scoped regression 工件：

- `frontend/output/e2e/2026-04-14-roundtable-firefox-postfix-r2/summary.json`
- `frontend/output/e2e/2026-04-14-roundtable-webkit-postfix/summary.json`

最近一轮 Debate / ending-room follow-up 工件：

- `frontend/output/e2e/2026-04-14-debate-full-rerun/result.json`
- `frontend/output/e2e/2026-04-14-ending-room-followup-full-r3/summary.json`

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
