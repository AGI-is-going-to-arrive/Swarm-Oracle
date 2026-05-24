# 🔮 SwarmOracle

> AI "What-If" Prediction Playground。输入一个历史或假设性问题，系统用多 Agent 推演、分支时间线、Pixel Theater、结构化押注与结果房间把不同世界线可视化出来。

## 当前定位

- 当前交付形态是 `browser-first Web`。
- `跨平台` 当前以 Chromium 桌面/移动与桌面 Firefox / WebKit 的 scoped regression 为准，不包含原生客户端壳。
- 当前主闭环已覆盖：
  - 主模式 `InputView -> SimulationView -> ResultView`
  - `Debate Arena` live/result/replay
  - `Oracle Chambers / 世界线圆桌`
  - replay 分享与导入
  - director campaign / 默认折叠的导演笔记与导演复盘、因果档案、玩法卡、结构化押注
- 最近一次稳定全链签收工件位于 `frontend/output/e2e/2026-04-12T04-12-03-164Z-release-signoff/summary.json`。
- 当前默认本地 `release-signoff` 脚本会覆盖：
  - backend checks
  - backend `/metrics`
  - `tsc`
  - `build`
  - `perf:budgets:check`
  - script contract tests
  - asset provenance check
  - `phase3_graph_preflight`
  - `corners / mobile / cross_browser`
  - `phase3-batch-a / phase3-batch-b` 的 default / `zh-CN` graph smoke
  - `phase3-batch-a / phase3-batch-b` 的 Firefox / WebKit graph desktop smoke
  - `ending_room_followup / ending_room_followup_en`
  - `ending_room_followup_firefox / ending_room_followup_en_firefox`
  - `ending_room_followup_webkit / ending_room_followup_en_webkit`
  - `roundtable_full / roundtable_en`
  - `roundtable_firefox / roundtable_en_firefox`
  - `roundtable_webkit / roundtable_en_webkit`
  - `debate_full / debate_firefox / debate_webkit`
- graph smoke 和默认 `release-signoff` 当前都会先跑前端 preview preflight；如果 deep-link 没 ready、SPA fallback 失效，或 entry asset 指纹不一致，会直接 fail-closed，不再把 404 混成图谱回归。
- 最近一次 Oracle 专项签收工件位于：
  - `frontend/output/e2e/20260331-oracle-signoff-ending-room/summary.json`
  - `frontend/output/e2e/20260331-oracle-signoff-roundtable/summary.json`
- 最近一轮 roundtable 可读性收口工件位于：
  - `frontend/output/e2e/20260331-codex-roundtable-readability-pass-desktop/summary.json`
- 最近一轮 roundtable strict 桌面/移动工件位于：
  - `frontend/output/e2e/2026-04-12-final9-roundtable-desktop/summary.json`
  - `frontend/output/e2e/2026-04-12-final8-roundtable-mobile/summary.json`
- 最近一轮 roundtable Firefox / WebKit scoped regression 工件位于：
  - `frontend/output/e2e/2026-04-12-roundtable-firefox-final/summary.json`
  - `frontend/output/e2e/2026-04-12-roundtable-webkit-final/summary.json`
- 最近一轮 Oracle ending-room follow-up / evidence-card UI 工件位于：
  - `frontend/output/e2e/20260508-fix-ending-room-basic/summary.json`
  - `frontend/output/e2e/20260508-fix-ending-followup-mobile-multi-zh/summary.json`
- 最近一轮 Oracle roundtable 回归复验工件位于：
  - `frontend/output/e2e/20260508-fix-roundtable-desktop-zh-final4/summary.json`
  - `frontend/output/e2e/20260508-fix-roundtable-mobile-zh-final2/summary.json`
- 最近一轮 Sprint 0-2 review/browser 矩阵工件位于：
  - `frontend/output/e2e/sprint0-2-review-20260510-browser/summary.json`
  - 覆盖 12 个功能、Chromium / Firefox / WebKit、desktop 1440 与 mobile 375，当前 `72 passed / 0 failed`
- 单结局结果页当前只保留：
  - `进入会客厅`
  - `只改一步`
  - 不会展示 `发起圆桌` / `异线旁听席`
- 当前 active handoff 在 `.claude/team-plan/comprehensive-improvement-plan.md`：Sprint 0-6 已完成本地审查、修复和验证；当前工作树已完成 Agent、Journal、模板、leaderboard segment、snapshot、admin setup、cancel 与相关安全/可用性收口。剩余架构级限制见 `llmdoc/overview/backlog.md`。

## 文档契约

默认只读下面 4 层，不要把历史文档当当前真值：

1. `README.md`
   产品范围、快速上手、仓库入口。
2. `llmdoc/index.md`
   AI/开发者的文档路由入口。
3. `llmdoc/overview/*.md`
   当前架构真值与模块边界。
4. `llmdoc/guides/development.md`
   开发、测试、签收命令。

补充规则：

- `llmdoc/reference/*.md` 只在查接口或配置时按需打开。
- `implement/README.md` 只负责归档索引，不承担当前真值。
- `progress.md` 只保留逐轮发现、修复与复验流水，不应作为产品或代码当前状态依据。

## 核心能力

| 能力 | 当前状态 |
|------|----------|
| Multi-Agent Simulation | 已落地，支持 branch、narration、visualization；选中某个 Agent 时，实时发言会按世界线分组，方便看同一角色在不同分支里的差异 |
| Pixel Theater | 已落地，Phaser 驱动，按需加载；当前是 Light Theater 外壳、浮动 toolbar、Director drawer、React DOM bubbles 和 HiDPI canvas，capture 仍保留 `.theater-panel` / `.phaser-game-container` 选择器；completed 场景从结果页返回推演时默认回 Classic，live resync 和 replay 不会误打断 Theater |
| Butterfly Effect | 已落地，支持即时 / 回溯 / 批量干预；普通和批量干预只在 active simulation 接收，终态不会返回假成功；回溯干预受 `counterfactual_replay` capability 控制，关闭或探针失败时前端不会提交回溯请求，后端同样返回 404；待处理干预走 durable queue claim/lease，前端显示 queued / injected / receipt-ready lifecycle，完成后展示持久化只读 receipt |
| Gameplay Cards | 已落地，14 张卡与 18 个玩法 profile 走共享 gameplay contract；后端校验可用性、冷却与点数，重建正式干预 prompt，并把分支、Agent 名和自定义指令按 untrusted data 包裹；完成态 Theater 可从 toolbar 打开玩法卡只读回看 |
| Structured Betting | 已落地，支持世界线 / 结局倾向 / 题材回响；题材回响放在高级选项里 |
| Result Quality / Question Anchoring | 已落地，受 `FEATURE_RESULT_VERDICT` 和 `/api/capabilities.result_verdict` 控制；结果页在有 verdict 时先给出直接回答原问题的预测结论、置信度，verdict 缺失时显示中性的“暂无预测结论”并保留原问题；结局卡有 `question_answer` 时会把分支级一句话回答放在概率条上方 |
| Director Campaign | 已落地，含 52 条 daily challenge catalog、streak、7 条 weekly track + leaderboard、15 个 registry badge、非线性 mastery level、首页成长 sheet、后端权威 `score_breakdown` 与结果页导演复盘 / 因果档案；结果页导演笔记和导演复盘默认收起，展开后再查看完整复盘，导演复盘的关键记录超过 3 条时用原生 disclosure 展开 |
| Graph Workbench / Causal Graph | 已落地，结果页 header 和下一步入口可进入 `/workbench/:id`；工作台会保留当前 analysis branch query，但 workbench 的因果图和 KG 图都按 scenario 拉全量 causal graph，不再用 URL `branch` 过滤。因果图边标签会按 zoom 密度显示，hover 或键盘 focus 时展示轮次与可信度；KG 图会用真实 G6 canvas / minimap，搜索和类型筛选直接更新可视图，从 split 切回 KG 单图面时会按当前容器重新铺满画布；移动端超过 200 个节点会显示截断提示，图例默认折叠，键盘仍可遍历节点；PNG / SVG 导出继续走 ExportPanel |
| Admin Setup / Preflight | 已落地，`/admin/setup` 提供 3 步 provider 配置向导；后端提供 `/api/admin/preflight`、`/api/admin/test-llm` 和 `make preflight`；设置 `ADMIN_TOKEN` 后 admin API 要求 `X-Admin-Token` |
| Custom Agent Library | 已落地，受 `FEATURE_CUSTOM_AGENTS` gate；支持创建/编辑/收藏自建 Agent、PDF 文档生成 Agent、knowledge domains、`IMPORTANT / CROWD` tier、首页主区 quick selector、高级设置里的 attach panel、主推演注入和 Debate 双方席位绑定；主推演每局可附加的自建 Agent 上限为 `min(num_agents, MAX_CUSTOM_AGENTS)`，前端会按 capability 动态限制，后端 schema 和注入层也会去重并再次校验；选中 Agent 后 Start 按钮显示数量 badge，capability 关闭时不会显示 badge 或提交旧选择；Agent Library 支持 `#agent_profile=<id>&tab=memory` 档案深链，结果页里 custom Agent 继续走深链，generated / replay Agent 会在当前页打开内联档案 sheet；identity continuity preflight 超时会按 504 返回，后端不会把它伪装成“无匹配”；首页启动流当前会提示错误但继续按无 continuity override 启动；自建 Agent 不开放 `CORE` 层级 |
| Agent Backups | 已落地，受 `FEATURE_PERSONA_EXPORT` gate；支持单个 / 批量导出 `schema_version=1` Agent 备份 JSON；从备份创建会为当前用户创建新的 custom Agent，不覆盖已有 Agent，并把 decision bias 归一化到安全的 5 维数值 |
| Education Templates | 已落地，受 `FEATURE_EDUCATION_TEMPLATES` gate；首页可打开模板选择器，按学科与难度筛选后回填问题、Agent 数和轮数 |
| Prediction Journal | 已落地，受 `FEATURE_PREDICTION_JOURNAL` gate；支持个人预测日志、resolve、校准曲线和 journal 页面；绑定 scenario 时按当前用户校验所有权，跨用户或无 owner 的旧 scenario 统一隐藏成 404，calibration 查询已走有界/索引路径 |
| Leaderboard Segments | 已落地；`/api/leaderboard` 在传入 segment filters 时返回 `entries + segment_metadata`，并按匹配到的已评分 prediction 重新计算分段指标；不传筛选时保持旧数组响应 |
| Hallucination Gate | 已接线为 warning-only 后处理；只给 verdict 附加 claims / evidence / warning metadata，不阻断生成结果；`threshold` 只影响 claim 是否标记为 verified，常见中英文否定会进入矛盾检测 |
| Web Search / Source Family | 已落地为 opt-in 搜索增强；普通用户推荐直接开启并使用已配置搜索（server default），无需填写 provider / API key / base URL；高级用户可为当前请求自定义 `provider / API key / base URL`。首页还可选择搜索深度：轻量抓取/注入 3 条，标准 5 条，深入抓取 10 条并注入 8 条。Source Family 支持 `polymarket / finance / academic / news_deep`，按当前有效 provider capability 控制前端 family checkbox；server default 读服务端 capability，custom override 有可识别 base URL 时按 URL 推断 provider，base URL 为空时按下拉 provider 使用默认 endpoint，只有非空且未知的 base URL 才显示 no-provider warning。Tavily/Exa 走 API 域名过滤，SearXNG 走归一化 `site:` 查询 + URL 后过滤；SearXNG 不需要搜索 API key，但需要可访问且通常需启用 JSON 的 SearXNG 实例，公共实例只适合实验，不承诺稳定。xAI app-layer 走 `filters.allowed_domains` + URL 后过滤。模型原生联网是独立的 LLM native path，不是 `WEB_SEARCH_PROVIDER=native`：当 Source Family 域名传入支持 native search 的非 proxy Responses API provider 时才注入 provider tools，并把安全的 native citations 展示在 ResultView。native search 有 tool-call budget 和 citation cap，超出 tool-call budget 会 fail-closed。未知 proxy、malformed URL 或非 http(s) base URL 不启用 native tools；非 production 下可指向本地 xAI-compatible Responses proxy 做 app-layer 测试。LLM BYOK 和 Web Search BYOK 独立，不复用 key。 |
| Counterfactual Replay & Compare | 已落地，支持 counterfactual / resume / compare；counterfactual 当前是“改一句旧发言再重演”，只允许选择来源分支里真实存在的回合和该回合发过言的 Agent；retrospective 会从选中轮重新生成带 replay provenance 的分支；resume 当前会先选来源分支，再使用同分支 checkpoint picker，并把结构化 checkpoint summary 转成人话预览，没有 checkpoint 时才回到 round 输入；续跑结局卡会标出来源分支和独立概率说明，compare 当前采用单活跃 Theater + shared round selector，并能识别 counterfactual / retrospective 的干预上下文 |
| Debate Arena | 已落地，含 live/result/replay、counterplay、judge rationale、readonly replay import；argument map 支持五种 verdict status、三层 DAG 和移动端列表；LLM cast 更新后 live 页会刷新名字、角色和 persona，长角色/人设可换行或展开，裁判卡显示本地化的 `待裁决 / 已裁决` 状态；live 阶段地图默认折叠，自动化会通过稳定按钮 hook 展开后再检查完整阶段列表；只有分享链接过长并回退到本地只读 `?local=` 时，结果页才会明确显示 `Save local read-only copy` |
| Oracle Chambers / Worldline Roundtable | 已进入可玩签收基线，支持 participant picker、follow-up、replay/share/import、`manual_shortlist`、`expert_witness`、`trait_mix`、`fault_line_first`、`witness_augmented`；roundtable 开桌现在有显式 `discussion_format` 与 `cast_mode`，默认是 `deep_dive / smart_pick`，可切到 `quick_review` 或 `clash_mode`，也可用 `custom` 保留用户逐线选定的代表；旧 `selection_recipe` 仍保留并映射到新字段，旧 replay / readonly artifact 继续可读；single-ending 当前已补 `继续追问 / 另开线程 / 复制纪要 / 追问洞察 / quote 级追问`，roundtable 当前已补 `Continue this table / Start anchored thread / Copy roundtable brief / phase insight / quote 级追问 / 点名这位代表`；桌面代表改选当前支持 `drag-to-seat / keyboard reseat`，移动端保留 `click-to-seat`；roundtable committed transcript 与 verdict 摘要都默认折叠，用户展开后再看完整内容；phase insight 当前是 timeline 样式，标题保留短 preview，展开后显示按中文 96 字 / 英文 160 chars 预算压缩后的主持人提炼，并会先去掉重复的问题前缀；Phase 编号走 locale key，英文显示 `Phase 01`，中文显示 `阶段 01`；首开房间会通过瞬时 planning 状态提示 format/cast 和计划轮次，durable turn/result/error 到达后清掉 skeleton；Transcript 列表独立滚动，Synthesis 区域不再被内部滚动或移动端 flex 压缩裁切；`quote / verdict / key_moment / phase` 当前都走显式锚点语义；readonly replay 已签收到 anchored thread restore；单结局结果页只暴露 `进入会客厅 / 只改一步`；EndingChatModal 当前支持 `后续三回合 (epilogue)` 与 `证据投牌 (evidence_card)`，证据卡追问会把用户引用的世界线保留到 assistant turn；圆桌 `survey / analyst` 是 completed live roundtable 的 Deep Dive SSE 工作台能力，不是 EndingChatModal 的 interaction mode；Deep Dive 会按 `roundtable_survey / roundtable_analyst / agent_conversation` capability 显示可重试错误或禁用占位，禁用时不挂载对应 SSE 子面板；Oracle 主文案当前以 factual anchor + LLM generation/rewrite fallback 为主，角色身份和动态词汇提示按 `UNTRUSTED DATA` 处理，空流式、仅 reasoning 输出或 JSON 字符串输出都会收口到可直接显示的人话 fallback |
| Replay & Import | 主模式与 Debate 均支持；主模式 Replay Trace 支持分页和分支过滤；scenario/story branch response 会回显 `replay_kind / replay_source_branch_id / replay_source_round` 以保留 counterfactual / retrospective / resume provenance；主模式 completed replay 会按 `visualization_enabled` 保持 Theater，单分支或单轮只显示静态标签；新生成的主模式和 Oracle replay payload 会剥掉 Agent 的 `agent_identity_id` 和 persona，只保留回放展示需要的字段；Debate replay 当前已补 `share -> readonly replay -> reload restore -> import` 完整 E2E 覆盖 |
| Snapshot Export / Import | 已接线，受 `FEATURE_SNAPSHOT_EXPORT` gate；后端导出 ZIP snapshot 并校验导入 archive/manifest/checksum，导出会剥离常见 secret key/base URL/token 变体和 JSON 字符串里的敏感字段，malformed 或标量 JSON 字符串按空值处理，并携带只读干预 receipt ledger；导入会拒绝非 UTF-8 JSON/JSONL、ZIP traversal、symlink、重复物理成员、超大 member、异常压缩比和无法映射的顶层 receipt branch 引用；旧 snapshot 仍可导入，pending intervention 不会被重新排队；前端首页导入、结果页导出 |
| KG Realtime | 已接线，causal graph append 返回 `GraphDelta`，scenario WS 可推送 `kg:delta` / `kg:snapshot_invalidated`；payload 过大或 out-of-sync 时仍以 REST snapshot fallback 为准 |
| i18n | UI 与自动生成内容按输入语言联动输出；QuickStart、ResultView campaign/archive 文案和 Phaser Title/Ending 文案都走 locale key；Oracle fresh live room 的英文文案已补去混句兜底，不再把中文 hinge 直接嵌进英文句子；Oracle 英文 signoff 当前已覆盖 Chromium full 与桌面 Firefox / WebKit scoped regression |

## 架构概览

```text
frontend/  React + TypeScript + Vite
  ├─ pages/         主模式、Debate、History、Leaderboard、Agents、Journal
  ├─ game/          Pixel Theater / Phaser runtime
  ├─ stores/        页面状态与 authority 合流
  └─ lib/           replay、authority、gameplay、分享等 helper

backend/   FastAPI + SQLModel + SQLite + ChromaDB
  ├─ app/api/       scenarios / agents / campaign / debate / ending-room / journal / ws
  ├─ app/services/  simulator / memory / llm / scoring / ending-room / journal / agent backup export
  ├─ app/models/    scenario / campaign / debate / ending-room / prediction / journal
  └─ shared/        gameplay contract
```

关键边界：

- `Scenario.director_state_json` 与 `gameplay_state_json` 是主模式 authority。
- `scenarioMeta` 仍存在，但只承担缓存、兼容和 replay 输入职责，不再是跨设备真值。
- 前端写回 `director_state / gameplay_state` 时会带 `revision` 串行写入；如果遇到 stale conflict，会先回拉最新 authority，再只合并这次本地增量重试。
- `ending_room` 是独立域，room/thread transcript 与 memory partition 隔离。
- replay 分享优先走后端 `ReplayArtifact`，失败且 URL token 也不可用时，会回退为本地只读副本链接；Debate 当前会把这条入口明确标成 `Save local read-only copy`。
- 前端字体已改为 self-hosted `/fonts/*.woff2`，入口页不再请求 Google Fonts CDN。

## 快速开始

### Docker

```bash
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- Docker 默认读取仓库根目录 `.env.docker`。
- backend image runtime 以非 root `appuser` / uid `1000` 运行；挂载自定义 `/data` volume 时要保证该用户可写。
- `.env.docker` 当前默认开启：
  - `FEATURE_COUNTERFACTUAL_REPLAY`
  - `FEATURE_CAUSAL_GRAPH`
  - `FEATURE_FACTIONS`
  - `FEATURE_ARGUMENT_MAP`
- `KG Explorer`、`Replay Trace`、图谱节点对话、教育模板、persona 导入导出和个人预测日志默认不随 Docker 评审栈开启；需要时显式设置对应 `FEATURE_*`，然后重启 backend。
- 如果你只是想拉一套全新的评审环境，不复用旧 named volume，直接带 project 名起一套隔离栈：

```bash
docker compose -p upgrade-test-review up --build -d
```

### 本地开发

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 18927
```

```bash
cd frontend
npm install
npm run dev
```

环境变量说明与可调项见 `llmdoc/reference/config.md`。

## 验证

常用最小验证：

```bash
cd frontend
npx tsc --noEmit -p tsconfig.app.json
npx vitest run
npm run build
```

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

当前验证口径（最近更新：2026-05-24 Roundtable Overhaul 收口）：

- backend：`python -m pytest tests/ --tb=short -q` 为 `3374 passed, 6 skipped`；`python -m ruff check app` 通过。
- frontend：本轮 `npx vitest run` 为 `212 files / 2374 tests passed`；`npm run lint`、`npx tsc --noEmit -p tsconfig.app.json`、`npm run build` 通过；i18n key parity 为 `2841 / 2841`。
- Custom Agent 定向复核：主推演注入按 `CROWD -> tail -> append`，parser 自带 `identity_id/source_type` 不会被信任；首页 quick selector 和 Agent drawer 统一走 `getSessionBoundUserId()`，Advanced Settings 不再挂载 Agent attach panel，scenario/debate payload 都会按 capability 和 Agent 数量二次裁剪。
- Playwright browser smoke：本地 backend + frontend preview 下覆盖 desktop `1280x800`、mobile `375x812`、capability off、select/deselect、Start Simulation confirm payload 和 Advanced Settings；console error 为 0。
- Intervention upgrade 浏览器复核：`e2e-suite.mjs mobile` 在 Chromium mobile 通过；`e2e-suite.mjs cross-browser --browsers firefox,webkit` 在 Firefox / WebKit desktop 通过 director-state 和 result archive readback scoped regression。这个结论不等于 Firefox/WebKit mobile、Native Safari/Edge 或 BrowserStack / Sauce 级全矩阵签收。
- 主模式 completed/replay 定向浏览器回归：Playwright fixture 在 Chromium、Firefox、WebKit 均通过，覆盖 completed 冷加载 Classic、结果页返回 Classic、replay Theater、单分支/单轮静态标签、多分支/多轮下拉、空分支/空消息、`cancelled` 和 `error` 状态。
- Pixel Theater 浏览器复核：Chrome DevTools MCP 打开 `/sim/e1a41453-2cb2-43a1-a054-0d7cd04a6bf5`，`.theater-floating-toolbar` 里的玩法卡入口可见，完成态玩法卡 modal 以只读提示打开，console error 为 0；截图保存在本地忽略目录 `frontend/output/theater-gameplay-cards-toolbar-fix.png`。
- KG visualization 定向回归：`5 files / 193 tests passed`，覆盖 `KGGraphBoard / KGExplorerView / useG6Graph / kgGraphConfig / locales`；KG Explorer fixture E2E 覆盖 Chromium desktop + mobile、Firefox desktop 和 WebKit desktop，`4 runs / allPassed=true`。
- Workbench KG resize 定向回归：`useG6Graph.test.ts + WorkbenchView.test.tsx` 为 `56 passed`，`KGGraphBoard.test.tsx` 为 `42 passed`；本机浏览器复核 `graph -> split -> KG` 后，KG 容器与内部 G6 canvas 同宽，`widthDelta=0`，console error 为 0。
- ResultView Agent 追问当前入口仍是场内按钮；custom Agent 的 `查看档案` 走 Agent Library hash 深链，generated / replay Agent 的 `查看档案` 会在结果页内打开 `AgentProfileSheet`，可查看 persona、memory 和 growth events；generated Agent 还可从 sheet 继续发起对话，replay 只读。
- Oracle browser E2E：`e2e:roundtable` 与 `e2e:ending-room` 在本地 preview/backend 口径通过；Ending Room summary 里 desktop/mobile replay coverage error 为 `null`，readonly replay / reload restore / import 关键字段齐全。
- Roundtable phase insight / picker 增量复核：后端 `tests/test_ending_room_service.py` 覆盖 `insight_body`、CLOSING phase、可选 LLM rewrite、异常/取消/过短/JSON/fence 输出和 cap；前端 `WorldlineRoundtableView.test.tsx` 覆盖 phase chip、unknown fallback、展开态 `stakes / moderator_focus / insight_body`、旧 payload 回退和 replay action 隐藏。
- Roundtable format/cast 增量复核：后端 `tests/test_ending_room_api.py / test_ending_room_service.py / test_ending_room_ws.py` 覆盖 `discussion_format / cast_mode`、非 roundtable 422、旧 recipe fallback、`cast_mode=custom` 代表校验、generation version 5 和 `ending_room_planning`；前端 `WorldlineRoundtableView.test.tsx`、`useEndingRoomWS.test.tsx`、`endingRoomStore.test.ts`、`roundtableReplayAutomation.test.ts` 与 `frontend/src/pages/roundtable/*` 测试覆盖 selector、planning skeleton、timeline 拆分、WS malformed fallback、result hydration 清理和 replay contract。
- Roundtable format/cast 浏览器复核：本地 backend 以 `ORACLE_CHAMBERS_USE_LLM=false` 跑确定性链路，`e2e-worldline-roundtable-suite.mjs` 已通过 Chromium desktop zh、Chromium mobile zh、Chromium desktop en、Firefox desktop zh、WebKit desktop zh；脚本会断言 UI controls、request body、snapshot/result 里的 `discussion_format / cast_mode`，并覆盖 `deep_dive / quick_review / clash_mode`。这不等于真实 provider 慢流式、Native Safari 或 Edge 全矩阵签收。
- Roundtable browser 增量复核：Playwright desktop roundtable 在 Chromium / Firefox / WebKit 通过；Chromium / Firefox 使用 `dragMethod: "mouse"`，Playwright WebKit 在 dnd-kit 输入模拟未命中时记录 `dragMethod: "click-after-mouse-keyboard-miss"` 并走同一候选卡入席兜底。这里的 WebKit 是 Playwright WebKit，不等同于真实 Safari 全版本矩阵。
- WS contract 增量复核：默认本地 backend 未开启 `SESSION_SECRET` 时，`e2e:ws:contract` 为 `11 passed / 10 skipped / 0 failed`；`SESSION_SECRET=test-secret --require-auth-hardening` 时为 `20 passed / 1 skipped / 0 failed`。
- `git diff --check` 通过。

完整签收入口：

```bash
cd frontend
npm run release:signoff -- --headless
```

更详细的开发、预览、签收与产物约定见 `llmdoc/guides/development.md`。

## 目录导航

- `llmdoc/`
  当前真值文档。
- `implement/`
  实现归档、阶段性方案、历史评审记录。
- `backend/`
  FastAPI 服务端。
- `frontend/`
  React + Phaser 前端。
- `shared/`
  前后端共享契约。
- `progress.md`
  历史流水，不做默认阅读入口。

## License

AGPL-3.0-only
