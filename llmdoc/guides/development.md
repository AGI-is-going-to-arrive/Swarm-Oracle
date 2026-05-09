# 开发指南

> 文档类型：L0 current-truth
> 作用：当前开发、测试、预览与签收命令入口。只保留操作手册，不保留 session 级验证日志。

## 环境要求

- Python `>= 3.11`
- Node.js `>= 20`
- npm `>= 11`

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
npm run preview -- --host 127.0.0.1 --port 18930
```

如果要按这轮本地 `uv + vite preview` 口径复核非默认端口：

```bash
cd backend
source .venv/bin/activate
uv run uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --host 127.0.0.1 --port 19027

cd ../frontend
SWARM_BACKEND_URL=http://127.0.0.1:19027 npm exec -- vite preview --host 127.0.0.1 --port 19030
```

## Docker

```bash
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- Docker 默认读取仓库根目录 `.env.docker`。
- `.env.docker` 当前默认开启：
  - `FEATURE_COUNTERFACTUAL_REPLAY`
  - `FEATURE_CAUSAL_GRAPH`
  - `FEATURE_FACTIONS`
  - `FEATURE_ARGUMENT_MAP`
- `KG Explorer`、`Replay Trace` 和图谱节点对话默认不随 Docker 评审栈开启；需要时显式设置 `FEATURE_KG_EXPLORER=true`、`FEATURE_REPLAY_TRACE=true`、`FEATURE_AGENT_CONVERSATION=true`，然后重启 backend。
- 根目录 `.dockerignore` 当前已经排除了本地 `frontend/output`、SQLite/Chroma 数据和常见缓存；E2E 产物不会再被一起塞进 Docker build context。
- 如果你要拉一套干净的评审栈，不复用旧 named volume，直接带 project 名启动：

```bash
docker compose -p upgrade-test-review up --build -d
docker compose -p upgrade-test-review ps -a
curl -s -X POST http://127.0.0.1:18927/api/health
```

- 如果默认 project 下的旧 volume 里留着半迁移态 SQLite，启动时可能会报 `table scenario already exists`。这种情况不要反复重试旧 volume；先备份旧库，再换新 project 名起栈，或者清理旧 volume 后再起。

## 环境变量

- 本地直接启动 backend 时，读取 `backend/.env`。
- 仓库根 `.env.example` 用于初始化本地模板。
- 修改 `FEATURE_*` 开关后需要重启 backend；前端会通过 `/api/capabilities` 重新读取能力状态。
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
npm run e2e:web-search -- --url http://127.0.0.1:18930 --output-dir output/e2e/review-web-search --provider tavily

# source-ingestion: fixture + live
cd ../backend
source .venv/bin/activate
ENABLE_WEB_SEARCH=true FEATURE_NEW_SOURCES=true WEB_SEARCH_PROVIDER=searxng SEARXNG_URL=http://127.0.0.1:8888 \
  NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=us \
  uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --host 127.0.0.1 --port 18927

cd ../frontend
VITE_ENABLE_WEB_SEARCH=true npm run build
SWARM_BACKEND_URL=http://127.0.0.1:18927 npm run preview -- --host 127.0.0.1 --port 18930
node scripts/e2e-new-source-ingestion-live.mjs full --url http://127.0.0.1:18930 --headless
SWARM_E2E_MODE=live node scripts/e2e-new-source-ingestion-live.mjs full --url http://127.0.0.1:18930 --headless

# source-ingestion: live non-us geo-gate
cd ../backend
source .venv/bin/activate
ENABLE_WEB_SEARCH=true FEATURE_NEW_SOURCES=true WEB_SEARCH_PROVIDER=searxng SEARXNG_URL=http://127.0.0.1:8888 \
  NEW_SOURCES_POLYMARKET_CONFIGURED_HOST=non-us \
  uvicorn --app-dir /absolute/path/to/upgrade-test/backend app.main:app --host 127.0.0.1 --port 18927

cd ../frontend
SWARM_E2E_MODE=live node scripts/e2e-new-source-ingestion-live.mjs full --url http://127.0.0.1:18930 --headless
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
- `e2e-new-source-ingestion-live.mjs` 当前也会校验 `/api/scenario` 请求体里是否真的带上：
  - `web_search_enabled`
  - `web_search_families`
- `vite preview` 当前也会代理 `/api` 和 `/ws`；如果 preview 要接别的 backend，启动前设置 `SWARM_BACKEND_URL`。
- `e2e-new-source-ingestion-live.mjs` 当前默认走 fixture；`SWARM_E2E_MODE=live` 时才会打真实 backend。
- live 模式现在会先显式打开首页总开关，再检查 `/api/scenario` 请求体里是否真的带上 `web_search_enabled=true`。
- live 模式当前还会检查结果页四个 source family card：
  - `us` 口径下要求四张卡都有非空 live 内容
  - `non-us` 口径下要求 `Polymarket` 显示 geo-gated placeholder，其余被选 family 仍保持 `ready`
- 如果服务端默认搜索没 ready，live 脚本当前也支持：
  - `SWARM_E2E_WEB_SEARCH_PROVIDER`
  - `SWARM_E2E_WEB_SEARCH_API_KEY`
  - `SWARM_E2E_WEB_SEARCH_BASE_URL`
- live 模式当前不再要求固定 snippet 文案；只要求结果页真的出现 web sources 入口，并能展开读到 snippet / link。
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
npm test -- --run src/lib/scenarioMeta.test.ts src/lib/scenarioGameplayState.test.ts src/lib/archiveSummary.test.ts src/pages/resultHelpers.test.ts src/components/gameplayCards.test.ts src/components/gameplayContract.test.ts src/components/InterventionModal.test.tsx src/components/ShareModal.test.tsx src/pages/SimulationView.test.tsx src/pages/ResultView.test.tsx src/components/result/DirectorDebriefPanel.test.tsx src/components/GameplayCardsModal.test.tsx src/pages/DebateArenaView.test.tsx src/pages/DebateResultView.test.tsx src/components/DebateBetModal.test.tsx src/components/DebateShareModal.test.tsx src/hooks/useDebateWS.test.tsx src/i18n/locales.test.ts src/stores/simulationStore.test.ts
npm test -- --run src/i18n/config.test.ts src/components/LanguageSwitcher.test.tsx src/lib/replayCodec.test.ts src/lib/debateReplay.test.ts src/components/AgentProfileModal.test.tsx src/lib/legacyCssFallbacks.test.ts
npm test -- --run src/api/client.test.ts src/pages/InputView.test.tsx src/pages/ResultView.test.tsx src/pages/ReplayView.test.tsx src/pages/CausalReviewView.test.tsx src/pages/PostVerdictStreams.test.tsx src/components/AgentAttachPanel.test.tsx src/components/AgentProfileModal.test.tsx src/components/ResumePanel.test.tsx src/components/ShareModal.test.tsx src/i18n/locales.test.ts
```

- Vitest 当前在 `frontend/src/setupTests.ts` 里统一注入内存版 `localStorage / sessionStorage`。
- 需要预置持久化状态的前端测试，直接在测试体里写 `window.localStorage` 或 `window.sessionStorage`，不要依赖 Node Web Storage 的文件参数。
- 这组回归当前额外兜住：
  - `localStorage` 读写失败时的 i18n 初始化 / 切语言
  - `LanguageSwitcher` 的 `role / aria-label / lang` 契约
  - replay token 的 `plain.*` portability 与旧 token 兼容解码
  - `crypto.randomUUID()` 缺失时的本地 replay / director id fallback
  - `<dialog>.showModal()` 缺失时的 `AgentProfileModal` 降级
  - 关键 CSS token / 高流量页面表面的 sRGB / rgba fallback
  - InputView accordion / Agent attach panel / ResultView bridge / ReplayView pagination / ResumePanel checkpoint picker / ShareModal PNG export 这些产品面回归

### Custom Agent Upgrade 定向回归

```bash
cd backend
source .venv/bin/activate
ruff check app/api/agents.py app/api/debate.py app/api/helpers.py app/services/persona_workshop.py app/services/memory.py app/services/simulator.py app/services/debate.py app/services/debate_prompts.py tests/test_persona_workshop.py tests/test_memory.py tests/test_debate_prompts.py tests/test_simulator.py tests/test_migration_022.py
python -m pytest tests/test_persona_workshop.py tests/test_memory.py tests/test_debate_prompts.py tests/test_simulator.py tests/test_migration_022.py -q

cd ../frontend
npx tsc --noEmit -p tsconfig.app.json
npm test -- --run src/pages/AgentLibrary.test.tsx src/pages/AgentWorkshopView.test.tsx src/pages/InputView.test.tsx src/pages/DebateArenaView.test.tsx src/pages/ResultView.test.tsx src/i18n/locales.test.ts
```

浏览器复核优先覆盖：

- `/agents` 创建 `IMPORTANT / CROWD` 两档自建 Agent，列表 badge 与编辑回填一致。
- `/` 主模式 Agent attach panel 选中自建 Agent 后，创建 scenario 请求带 `custom_agent_identity_ids`；loading/error/retry/empty 与超过 5 个可选项时的选择上限都要可见。
- Debate 创建时，已选自建 Agent 的前 2 个 ID 进入 `custom_agent_ids`。
- `/result/:id` 在 `custom_agents` capability 开启时显示 Agent Library bridge。
- 移动端 tier selector 单列显示，badge 不溢出。

### SimulationView / PredictionModal / Gameplay Cards 回归

```bash
cd frontend
npm test -- --run src/pages/SimulationView.test.tsx --reporter=verbose
npm test -- --run src/components/PredictionModal.test.tsx src/components/GameplayCardsModal.test.tsx src/i18n/locales.test.ts --reporter=verbose
npm exec -- tsc -b --noEmit
```

如果要补一条真实浏览器 fixture：

```bash
cd frontend
npm run preview -- --host 127.0.0.1 --port 18930
npm run e2e:predict:late-branches -- --url http://127.0.0.1:18930 --headless
```

说明：

- `SimulationView.test.tsx` 要按全文件跑；polling、default objectives backfill、replay selection 和 authority conflict retry 这几块容易只在组合运行时暴露问题。
- 这组回归当前主要看：
  - modal 打开时 `branches=[]`，后续 branch list 晚到后会自动切回 `branch_winner`
  - 当前选中的 branch 失效时会自动回退到仍然有效的默认目标
  - 如果用户已经改选了一个仍然有效的 branch，提交时会继续用用户当前选择
  - structured prediction text 的最终 payload 不超过 500 字符，textarea 长度会扣掉下注元数据
  - `GameplayCardsModal` 在手机或粗指针设备上不会自动聚焦 directive textarea
  - 真实浏览器 fixture 会同时校验 automation state、DOM 选中值，以及提交请求里的 structured bet `targetId / targetLabel`
  - `predict-late-branches-before.{json,png}` 当前会先在 late branch 到达前采样；`before` 应看到 `bet_kind=ending_tone` 且 `target_branch_id=null`
  - `predict-late-branches-after.{json,png}` 才对应 late branch 到达后的状态；`after` 应看到 `bet_kind=branch_winner`，并选中实际 branch id
  - 如果 `18930` 被占用，就直接把 preview 实际打印出来的 URL 传给 `--url`

### Agent Conversation / Node Conversation 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_agent_conversation.py tests/test_team_review_round6_fixes.py tests/test_migration_022.py tests/test_conversation.py tests/test_conversation_service.py tests/test_api.py -q

cd ../frontend
npm test -- --run src/components/shared/GlobalOfflineBanner.test.tsx src/components/shared/GlobalOfflineBanner.ssr.test.tsx src/components/kg/EmptyStateQuickQuestions.test.tsx src/components/kg/NodeContextBanner.test.tsx src/components/kg/NodeConversationSheet.test.tsx src/components/kg/NodeConversationSheet.ref-stability.test.tsx src/components/workbench/NodeQuickCard.test.tsx src/components/workbench/WorkbenchView.test.tsx src/pages/CausalReviewView.test.tsx src/pages/ResultView.test.tsx src/hooks/useAgentConversation.test.ts src/hooks/useNodeConversationTransport.test.tsx src/lib/conversationStateMachine.test.ts
npx tsc --noEmit -p tsconfig.app.json
```

如果只先卡这轮 `delete / abort / cancel` 四个边界：

```bash
cd backend
source .venv/bin/activate
python -m pytest \
  tests/test_agent_conversation.py::TestDeleteAbortPath::test_abort_active_turn_returns_204_like_payload \
  tests/test_api.py::TestDeleteScenario::test_delete_scenario_swallow_signal_failures_after_commit \
  tests/test_conversation.py::TestAbort::test_preclaimed_turn_abort_signal_before_first_frame_finalizes_aborted \
  tests/test_conversation.py::TestSSEStream::test_scenario_deleted_before_first_iteration_emits_terminal_error \
  tests/test_conversation.py::TestAbort::test_cancel_and_next_chunk_same_tick_prefers_cancel -q
```

如果要补一条 fresh local live：

```bash
cd frontend
npm run dev -- --host 127.0.0.1 --port 18931
node scripts/e2e-node-conversation-live.mjs desktop --url http://127.0.0.1:18931 --output-dir output/e2e/r11-fix-node-conversation-live
```

说明：

- backend 这组回归当前主要看：
  - `WS /ws/agent-conversation/{thread_id}` 的 feature gate、owner freeze 和 scenario 级 pending-auth 容量约束
  - `user / org` daily quota 当前走持久化 ledger，不再依赖进程内 dict；相关回归会直接验证 persisted usage 读回来的超限口径
  - scenario delete 先 `commit()` 再发 signal；signal 失败只记 warning，公共 HTTP `/turn` SSE 包装层最终仍会收到 `turn_error(code=SCENARIO_DELETED)`
  - 公共 `DELETE /api/conversation/{thread_id}/active` 路径既会 abort 活跃流，也会把预留 `pending` assistant turn 收成 `aborted`
  - bootstrap 预留 turn 在 started 前如果已经被 abort / cancel，不会再补 stale `turn_started`；如果场景已经删掉，会直接收成 `SCENARIO_DELETED`
  - cancel 和 next chunk 同 tick 完成时会优先 cancel，不再多漏一条 delta
  - origin 没有 `agent_name` 时，prompt 会用 graph analyst 口径解释节点、分支、回合和相邻关系，不会冒充具体 Agent
- frontend 这组回归当前主要看：
  - `GlobalOfflineBanner` 的 WS grace timer 行为和 SSR-safe effect fallback
  - `NodeConversationSheet` 的 unmount abort、multiline SSE frame、bubble ref 稳定性、origin excerpt 透传和 bootstrap start 迟到响应防护
  - `NodeContextBanner` 的来源摘要、对话目标、卡片意义、前因、后续、相关关系和长 excerpt 展开/折叠
  - `NodeQuickCard` 的视口钳位、关闭和打开详情交互
  - `useNodeConversationTransport` 通过组件合同回归继续覆盖 `/start` + `/turn` 链路
  - `useAgentConversation` 在 `turn_completed / turn_error / abort` 之后会忽略迟到 delta，不再把 ghost 文本重新刷回 bubble 或 aria-live；committed assistant 文本会交给 `SafeMarkdown` 渲染

### Backend Auth / Provider Safety 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_session_auth.py tests/test_llm_client.py tests/test_web_context.py tests/test_ending_room_service.py tests/test_api.py -q
```

- 这组回归当前主要看：
  - scenario WS 的 `pending-auth` 容量预留不会被并发握手冲穿
  - ending-room 后台生成在 runtime lock 丢失 / 续租异常时会 fail-closed
  - 官方托管 provider 的 `llm_base_url / web_search_base_url` 只接受 `https`
  - 本地开发 host 的 BYOK `http` 例外仍保留

### Capability / WS Contract 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest -q tests/test_evidence_card_flow.py
python -m pytest -q tests/test_session_auth.py -k 'auth_timeout_closes_4001 or oversized_auth_frame_closes_1009 or pending_blocks_new_connections'

cd ../frontend
node --test scripts/e2e-ws-contract-suite.test.mjs
npx eslint scripts/e2e-capability-matrix.mjs scripts/e2e-ws-contract-suite.mjs scripts/e2e-ws-contract-suite.test.mjs src/hooks/useAgentConversationWS.ts src/hooks/useAgentConversationWS.test.tsx
npx tsc --noEmit -p tsconfig.app.json
npm test -- --run src/hooks/useAgentConversationWS.test.tsx src/hooks/useCapabilityCheck.test.ts src/pages/AgentLibrary.test.tsx src/pages/CompareDigestView.test.tsx src/pages/KGExplorerView.test.tsx src/pages/ReplayView.test.tsx
HEADLESS=1 node scripts/e2e-ws-contract-suite.mjs --url http://127.0.0.1:19030 --backend-url http://127.0.0.1:19027 --headless --session-token test-secret --session-subject ws-contract-owner
HEADLESS=1 npm run e2e:capability-matrix -- --url http://127.0.0.1:19030 --headless
```

说明：

- backend 这组回归当前主要看：
  - `evidence_card` 的 `cited_branch_id` 过滤和降级路径不回退
  - `scenario` WS 的 auth timeout / oversize auth frame / pending-auth limit 仍维持 `4001 / 1009 / 1013-or-1006` 口径
- frontend 这组回归当前主要看：
  - `useAgentConversationWS` 实际连接 `/ws/agent-conversation/{thread_id}`，不再误连旧的 `/api/ws/agent-conversation/{thread_id}`
  - `e2e-ws-contract-suite.mjs` 当前先跑 raw probe，再跑 live page case1，避免 live fixture 活动把 `scenario` raw probe 污染成假失败
  - `case1` 当前使用绝对 URL 打开 `/sim` 和 `/debate`，不再因为 Playwright page 没有 `baseURL` 把相对路径静默 skip
  - `e2e-capability-matrix.mjs` 当前覆盖 6 个 gated route；`ReplayView` 的 disabled 路径现在会落显式 unavailable surface，不再回到 `/`。如果脚本还按旧 redirect 口径断言，先同步脚本再跑。
- 这轮 clean-room 真实结果是：
  - `tests/test_evidence_card_flow.py`：`5 passed`
  - `tests/test_session_auth.py -k ...`：`3 passed`
  - `node --test scripts/e2e-ws-contract-suite.test.mjs`：`18 passed`
  - 前端定向 vitest：`32 passed`
  - `e2e:ws:contract`：`20 passed / 1 skipped / 0 failed`
  - `e2e:capability-matrix`：`30 passed / 0 skipped / 0 failed`

### Graph Viz / Debate Graph 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest -q

cd ../frontend
npm test
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
npm run preview -- --host 127.0.0.1 --port 18930
```

如果只复核图谱节点对话 / 节点详情回归：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_causal_graph.py tests/test_conversation_service.py -q
ruff check app/services/causal_graph.py app/services/conversation_service.py tests/test_causal_graph.py tests/test_conversation_service.py

cd frontend
npm test -- --run src/pages/CausalReviewView.test.tsx src/pages/KGExplorerView.test.tsx src/components/ArgumentMap.integration.test.tsx src/components/NodeDetailPanel.test.tsx src/components/ResultConversationWidget.test.tsx src/components/kg/EmptyStateQuickQuestions.test.tsx src/components/kg/NodeContextBanner.test.tsx src/components/kg/NodeConversationSheet.test.tsx src/i18n/locales.test.ts
npm exec -- tsc --noEmit -p tsconfig.app.json
npm exec -- eslint src/pages/CausalReviewView.tsx src/pages/KGExplorerView.tsx src/pages/ResultView.tsx src/components/ArgumentMap.tsx src/components/NodeDetailPanel.tsx src/components/ResultConversationWidget.tsx src/components/kg/EmptyStateQuickQuestions.tsx src/components/kg/NodeContextBanner.tsx src/components/kg/NodeConversationSheet.tsx src/components/kg/StreamingBubbleIsolated.tsx src/hooks/useAgentConversation.ts
```

说明：

- 如果要先收图谱节点对话 / 节点详情这条回归，优先跑上面的窄集；过了再决定要不要扩大到 full pytest / full vitest。
- 这条窄集当前主要看：
  - causal graph 是否把 completed branch 投影成 `outcome` 结局节点，并用 `led_to` 接到同分支最近来源节点
  - fork label 是否使用用户可读的 `display_reason`，fork-only append 是否保留已有 provenance；旧孤立 fork 是否能回补只读 synthetic provenance
  - `NodeContextBanner` 是否显示对话目标、卡片意义、前因、后续和相关关系
  - 因果、知识、裁决和结果入口的空态追问是否跟随当前卡片语境
  - 结果页追问是否跟随 `analysisBranch`，并带当前结局、洞察、分支原因、关键时刻和对比分支
  - committed assistant 文本是否按 Markdown 渲染，不再把列表和加粗符号原样露出
- 如果要先收 P1 前置图谱修复，最小窄集是：

```bash
cd frontend
npm test -- --run src/hooks/useG6Graph.test.ts src/pages/KGExplorerView.test.tsx src/pages/CausalReviewView.test.tsx src/pages/ReplayView.test.tsx src/pages/ResultView.test.tsx src/components/ArgumentMap.test.tsx src/components/PipelineStepper.test.tsx src/components/ResultConversationWidget.test.tsx src/components/kg/NodeConversationSheet.test.tsx src/i18n/locales.test.ts src/hooks/useNodeConversationTransport.test.tsx
npx tsc --noEmit -p tsconfig.app.json
node --test scripts/e2e-frontend-preflight.test.mjs
npm run build

cd ../backend
source .venv/bin/activate
python -m pytest tests/test_conversation.py tests/test_agent_conversation.py tests/test_graph_analysis.py tests/test_causal_graph.py tests/test_debate_argument_map.py tests/test_contract_freeze.py tests/test_fallback_migrations.py::test_init_db_repairs_no_version_bootstrap_schema_missing_graph_edge_evidence_columns tests/test_fallback_migrations.py::test_020_upgrade_deletes_duplicate_snapshot_graph_rows tests/test_fallback_migrations.py::test_020_sqlite_duplicate_snapshot_tiebreaker_matches_runtime_rowid tests/test_migration_022.py::test_024_graph_edge_evidence_columns_downgrade_roundtrip_preserves_edges -q
```

- 这组 P1 前置窄集当前主要看：
  - KGExplorer 主图 / minimap / search filter / 业务 `kgType`
  - CausalReview 节点拖拽与选择
  - CausalReview server analysis stale clear、graph-analysis 双 gate、大图截断和 branch-aware 预检
  - GraphEdge evidence 字段落库、causal graph 返回 evidence、旧边缺失 evidence 回填、024 downgrade roundtrip、debate argument-map `edges[].evidence` 和 edge tier 本地化
  - ReplayView 计数标签不泄漏 `{{count}}`
  - ResultView compare / counterfactual 跟随 `analysisBranch`
  - ResultView replay 模式不暴露 live conversation
  - PipelineStepper error 状态 progressbar ARIA 值仍在合法范围内
  - conversation prompt 带轻量 scenario / branch / node / graph 语境
- 当前这条窄集之外，focused browser spot-check 建议覆盖：
  - CausalReview 节点点击后打开 `NodeConversationSheet`，并带上当前节点摘录
  - KG 工作台桌面节点点击后先出现 `NodeQuickCard`，靠近视口边缘时不会溢出屏幕
  - 需要详情面板的图面仍能正常打开、关闭并恢复焦点

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
node --test scripts/e2e-debate-suite.test.mjs scripts/e2e-ending-room-followup-suite.test.mjs
node scripts/e2e-debate-suite.mjs full --url http://127.0.0.1:18930 --output-dir output/e2e/debate-full --headless
node scripts/e2e-debate-suite.mjs desktop --browser firefox --url http://127.0.0.1:18930 --output-dir output/e2e/debate-firefox --headless
node scripts/e2e-debate-suite.mjs desktop --browser webkit --url http://127.0.0.1:18930 --output-dir output/e2e/debate-webkit --headless
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

- debate mobile E2E 当前按 rail fail-closed：
  - 只认 `.debate-mobile-rail .debate-primary-cta--rail`
  - rail 按钮不可用，或点击后没打开 modal / 没跳到结果页，脚本会直接失败
  - 不再 fallback 去点隐藏 hero CTA
- 这组定向回归当前还会看：
  - 页面壳不再跟着 debate payload 里的 `language` 静默改全局 UI 语言
  - mixed-language fallback 当前覆盖 `phase commentary / replay quote / prediction score reason`
  - `e2e-debate-suite` 当前会覆盖 `share -> readonly replay -> reload restore -> import`
  - backend import replay 当前接受负数 `confidence_drift.phase_margin / cumulative_margin`，也接受常规 prediction 的 `counterplay_variant: null`
  - desktop Firefox / WebKit scoped rerun 当前也已通过

### Oracle Chambers / Roundtable 定向回归

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_ending_room_service.py tests/test_ending_room_api.py tests/test_ending_room_ws.py tests/test_vector_store.py tests/test_api.py -q

cd ../frontend
npm test -- --run src/api/client.test.ts src/lib/textLayout/pretext.test.ts src/lib/textLayout/textOverflowPredictor.test.ts src/lib/textLayout/oracleTranscriptLayout.test.ts src/lib/roundtableSelection.test.ts src/lib/e2eReplayGuards.test.ts src/lib/endingRoomReplayAutomation.test.ts src/lib/roundtableReplayAutomation.test.ts src/lib/endingRoomPickerAutomation.test.ts src/pages/ResultView.test.tsx src/components/EndingChatModal.test.tsx src/hooks/useEndingRoomWS.test.tsx src/stores/endingRoomStore.test.ts src/pages/WorldlineRoundtableView.test.tsx src/pages/roundtableHelpers.test.ts src/components/endingChatHelpers.test.ts src/pages/resultHelpers.test.ts src/pages/simulationHelpers.test.ts src/hooks/useTranscriptScroll.test.ts
node --test scripts/e2e-debate-suite.test.mjs scripts/e2e-ending-room-followup-suite.test.mjs
npx tsc --noEmit -p tsconfig.app.json
npm run build

node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-followup-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --locale en --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-followup-en --headless
node scripts/e2e-ending-room-followup-suite.mjs mobile --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-followup-mobile --headless
node scripts/e2e-ending-room-followup-suite.mjs desktop --browser firefox --locale en --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-followup-en-firefox --headless
node scripts/e2e-ending-room-followup-suite.mjs desktop --browser webkit --locale en --url http://127.0.0.1:18930 --output-dir output/e2e/oracle-ending-room-followup-en-webkit --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-desktop --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --browser firefox --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-firefox --headless
node scripts/e2e-worldline-roundtable-suite.mjs desktop --browser webkit --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-webkit --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-full --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --locale en --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-en --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --browser firefox --locale en --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-en-firefox --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --browser webkit --locale en --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-en-webkit --headless
node scripts/e2e-worldline-roundtable-suite.mjs mobile --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/oracle-roundtable-mobile --headless
```

如果只想先复核这轮本地修复过的结果页开房、legacy 索引修复和 roundtable transcript/UI 口径，最小命令是：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_ending_room_api.py -q
python -m pytest tests/test_fallback_migrations.py -k 'legacy_ending_room_scope_unique_index or legacy_ending_room_schema_before_upgrade' -q

cd ../frontend
npm exec -- tsc -b --pretty false
npm test -- --run src/pages/WorldlineRoundtableView.test.tsx src/components/EndingChatModal.test.tsx
```

如果只改 Oracle 主文案的 LLM generation / rewrite fallback 路径，先跑这两条最小回归：

```bash
cd backend
source .venv/bin/activate
python -m pytest \
  tests/test_ending_room_service.py::test_oracle_generation_first_uses_llm_before_anchor_template \
  tests/test_ending_room_service.py::test_oracle_empty_generation_then_rewrite_uses_anchor_reference \
  tests/test_ending_room_service.py::test_oracle_prompts_wrap_vocabulary_identity_as_untrusted_data \
  tests/test_ending_room_service.py::test_followup_falls_back_when_stream_ends_without_visible_delta \
  tests/test_ending_room_service.py::test_load_branch_transcript_excerpts_keeps_recent_order_per_branch \
  -q
```

如果同一轮还改了 roundtable / ending-room 前端文案、anchor helper 或 replay share payload，补这组前端窄集：

```bash
cd frontend
npm test -- --run src/api/client.test.ts src/stores/endingRoomStore.test.ts src/components/EndingChatModal.test.tsx src/pages/ResultView.test.tsx src/pages/WorldlineRoundtableView.test.tsx src/lib/endingRoomReplayAutomation.test.ts src/pages/roundtableHelpers.test.ts src/i18n/locales.test.ts
node --test scripts/e2e-debate-suite.test.mjs scripts/e2e-ending-room-followup-suite.test.mjs
npm exec -- tsc --noEmit -p tsconfig.app.json
```

如果改的是 completed-state roundtable 的 `Deep Dive` / analyst / survey / participant-scoped chat，先跑这组最小命令：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_roundtable_survey.py tests/test_roundtable_analyst.py tests/test_contract_freeze.py -q
ruff check app/services/

cd ../frontend
npx vitest run src/pages/RoundtableAgentChat.test.tsx src/pages/WorldlineRoundtableView.test.tsx src/pages/PostVerdictStreams.test.tsx src/components/kg/NodeConversationSheet.test.tsx --reporter=verbose
npx tsc --noEmit -p tsconfig.app.json
```

这组只看 completed-state roundtable 的 survey / analyst 后端合同，以及 Deep Dive 到 participant-scoped chat / analyst / survey 的前端链路；`PostVerdictStreams.test.tsx` 负责兜住首帧前 abort、完成后 abort、stream error、retry 和 source/tool chip。若改了开房、replay、移动端或跨浏览器口径，继续跑上面的完整 Oracle / Roundtable 回归。

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
  - ending-room follow-up 当前走 deterministic 口径：
    - 先 API 预热 `ending_chamber`
    - 再通过 `ResultView` 的 `debugEndingRoomBranch / debugEndingRoomMode / debugEndingRoomAgents` 直开 live chamber
  - `hotseat / all_present / epilogue` 由 API 发起，UI 负责观测已提交状态和 readonly replay
  - `evidence_card` 走真实 UI 抽屉提交，会落 `*-evidence-card-ui.json / ui_submission`，不再使用 direct API append 产物当主证据
  - replay coverage 当前额外做了三层收口：
    - 复用旧页面前先 revalidate live chamber
    - `Copy / Save / Import` 只在 `.ending-chat-header__actions` 里找
    - readonly replay 必须同时满足 replay URL、Import 可见、composer 不可发
  - backend `tests/test_fallback_migrations.py` 当前也会单独兜住 legacy `uq_ending_room_scope` 修复；老 SQLite 本地库升级后，再点结果页 `进入会客厅` 不会因为旧唯一索引直接 `500`
  - replay coverage 现在按 fail-closed 收口：
    - artifact/local readonly
    - import
  - backend `tests/test_ending_room_service.py` 当前还会兜住 runtime lock 丢失 / 续租异常 -> room `error` 这条 fail-closed 合同
    - reload/restore
    - 任一关键字段缺失都会直接报错，不再 best-effort 保 `summary.json`
  - `hotseat / all_present / epilogue` 当前会额外校验目标 `roomId + threadId + interaction_mode`
    - 不再只看当前可见线程的局部 `modal_state`
    - fallback 优先走 API-driven / snapshot / settled 验真
    - `epilogue` 遇到 live `modal_state` 还停在旧 `turn_count` 时，会继续回到 room snapshot 合成状态，不再把已提交 follow-up 误报成 target-thread 失败
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
  - `full --locale en` 本轮也已通过
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
    - hero/header action scoped locator；如果动作收进 `More actions / 更多操作` 菜单，也会从菜单里点
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
  - 首开与后续 `reseat / drag-to-seat / keyboard reseat / expert witness / selection mode reopen` 当前统一按 `90s` ready budget 等待最终 `has_result=true`
  - composer user-turn settle 当前按 `120s` 预算等待，避免和开桌 ready budget 混在一起判读
  - 当前 fresh full rerun 已通过 desktop + mobile
  - `full --locale en` 本轮也已通过
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
- 官方托管 provider 的 `llm_base_url / web_search_base_url` 当前要求 `https`；只有本地开发 host 才允许 `http`

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
npm run preview -- --host 127.0.0.1 --port 18930

cd frontend
npm run release:signoff -- --url http://127.0.0.1:18930 --headless
```

说明：

- `release:signoff` 当前不会自己拉起 backend / preview。
- 这组示例命令固定使用：
  - frontend `http://127.0.0.1:18930`
  - backend `http://127.0.0.1:18927`
- 脚本默认 frontend URL 仍是 `http://127.0.0.1:18928`；如果你像上面一样把 preview 起在 `18930`，就显式传 `--url http://127.0.0.1:18930`。
- 默认 `release-signoff` 当前已纳入：
  - `lint`
  - `graph_focused_vitest`
  - `perf_budgets`
  - `phase3_graph_preflight`
  - `script_contracts`
  - `prediction_modal_late_branches`
  - graph default / `zh-CN` smoke（`phase3-batch-a`、`phase3-batch-b`）
  - graph Firefox / WebKit desktop smoke（`phase3-batch-a`、`phase3-batch-b`）
  - `node_conversation_live`
  - `kg_explorer_live`
  - `replay_view_live`
  - `ending_room_followup / ending_room_followup_en`
  - `ending_room_followup_firefox / ending_room_followup_en_firefox`
  - `ending_room_followup_webkit / ending_room_followup_en_webkit`
  - `roundtable_full / roundtable_en`
  - `roundtable_firefox / roundtable_en_firefox`
  - `roundtable_webkit / roundtable_en_webkit`
  - `debate_full / debate_firefox / debate_webkit`
- 如果本地预览端口不同，显式传 `--url http://127.0.0.1:<port>`。
- `release-signoff` 当前会在 graph smoke 前先跑 `phase3_graph_preflight`；如果 preview deep-link 还没 ready、SPA fallback 失效，或 entry module、CSS entry、legacy fallback 资源不一致 / 不可达，会直接在这一步失败。

如果需要强制 Debate 使用 `llm_hybrid` 裁决模式：

```bash
cd frontend
SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE=llm_hybrid npm run release:signoff -- --url http://127.0.0.1:18930 --headless
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

- `frontend/output/e2e/20260508-fix-debate-mobile-zh/result.json`
- `frontend/output/e2e/20260508-fix-ending-room-basic/summary.json`
- `frontend/output/e2e/20260508-fix-ending-followup-mobile-multi-zh/summary.json`
- `frontend/output/e2e/2026-04-14-debate-full-rerun/result.json`
- `frontend/output/e2e/2026-04-14-ending-room-followup-full-r3/summary.json`
- `frontend/output/e2e/2026-04-15-debate-replay-full-r9/result.json`
- `frontend/output/e2e/2026-04-15-ending-room-followup-en-r1/summary.json`
- `frontend/output/e2e/2026-04-15-ending-room-followup-en-firefox-r1/summary.json`
- `frontend/output/e2e/2026-04-15-ending-room-followup-en-webkit-r1/summary.json`
- `frontend/output/e2e/2026-04-15-roundtable-en-r1/summary.json`
- `frontend/output/e2e/2026-04-15-roundtable-en-firefox-r1/summary.json`
- `frontend/output/e2e/2026-04-15-roundtable-en-webkit-r1/summary.json`
- `frontend/output/e2e/recheck-debate-firefox/result.json`
- `frontend/output/e2e/recheck-debate-webkit-r2/result.json`

最近一轮 Oracle 回归复验工件：

- `frontend/output/e2e/20260508-fix-roundtable-desktop-zh-final4/summary.json`
- `frontend/output/e2e/20260508-fix-roundtable-mobile-zh-final2/summary.json`
- `frontend/output/e2e/20260423-oracle-regression-followup-rerun/summary.json`
- `frontend/output/e2e/20260423-oracle-regression-roundtable-rerun-v2/summary.json`

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
