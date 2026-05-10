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
  - director campaign / 导演复盘、因果档案、玩法卡、结构化押注
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
- 当前 active handoff 在 `.claude/team-plan/comprehensive-improvement-plan.md`：Sprint 0-4 已完成本地审查、修复和验证；下次从 Sprint 4 剩余 follow-up 与 Sprint 5 开始。

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
| Multi-Agent Simulation | 已落地，支持 branch、narration、visualization |
| Pixel Theater | 已落地，Phaser 驱动，按需加载 |
| Butterfly Effect | 已落地，支持即时 / 回溯 / 批量干预 |
| Gameplay Cards | 已落地，14 张卡，走共享 gameplay contract |
| Structured Betting | 已落地，支持世界线 / 结局倾向 / 题材回响 |
| Director Campaign | 已落地，含 goals、risk/resource、commitment、growth、后端 `score_breakdown` 与结果页导演复盘 / 因果档案 |
| Admin Setup / Preflight | 已落地，`/admin/setup` 提供 3 步 provider 配置向导；后端提供 `/api/admin/preflight`、`/api/admin/test-llm` 和 `make preflight` |
| Custom Agent Library | 已落地，受 `FEATURE_CUSTOM_AGENTS` gate；支持创建/编辑自建 Agent、knowledge domains、`IMPORTANT / CROWD` tier、首页卡片选择、主推演注入和 Debate 双方席位绑定；自建 Agent 不开放 `CORE` 层级 |
| Counterfactual Replay & Compare | 已落地，支持 counterfactual / resume / compare；resume 当前会优先使用同分支 checkpoint picker，compare 当前采用单活跃 Theater + shared round selector |
| Debate Arena | 已落地，含 live/result/replay、counterplay、judge rationale、readonly replay import；只有分享链接过长并回退到本地只读 `?local=` 时，结果页才会明确显示 `Save local read-only copy` |
| Oracle Chambers / Worldline Roundtable | 已进入可玩签收基线，支持 participant picker、follow-up、replay/share/import、`manual_shortlist`、`expert_witness`、`trait_mix`、`fault_line_first`、`witness_augmented`；single-ending 当前已补 `继续追问 / 另开线程 / 复制纪要 / 追问洞察 / quote 级追问`，roundtable 当前已补 `Continue this table / Start anchored thread / Copy roundtable brief / phase insight / quote 级追问 / 点名这位代表`；桌面代表改选当前支持 `drag-to-seat / keyboard reseat`，移动端保留 `click-to-seat`；桌面 roundtable committed transcript 当前已补长段折叠 / 展开，phase insight 展示和预填 prompt 会把长段复述压成一句；`quote / verdict / key_moment / phase` 当前都走显式锚点语义；readonly replay 已重新签收到 anchored thread restore，并已补 Firefox / WebKit scoped regression；单结局结果页只暴露 `进入会客厅 / 只改一步`；已新增 `后续三回合 (epilogue)` 与 `证据投牌 (evidence_card)` 两种交互模式，证据卡追问会把用户引用的世界线保留到 assistant turn；completed live roundtable 的 `1-on-1 Interview` 会先展示代表的角色、世界线、立场、最近原话和人物简介；Oracle 主文案当前以 factual anchor + LLM generation/rewrite fallback 为主，角色身份和动态词汇提示按 `UNTRUSTED DATA` 处理，follow-up 空流式或仅 reasoning 输出会退回非流式改写，最终 fallback 也必须是可直接显示的人话 |
| Replay & Import | 主模式与 Debate 均支持；主模式 Replay Trace 支持分页和分支过滤；Debate replay 当前已补 `share -> readonly replay -> reload restore -> import` 完整 E2E 覆盖 |
| Snapshot Export / Import | 已接线，受 `FEATURE_SNAPSHOT_EXPORT` gate；后端导出 ZIP snapshot 并校验导入 archive/manifest/checksum，导入会拒绝 ZIP traversal、symlink、重复物理成员、超大 member 与异常压缩比；前端首页导入、结果页导出 |
| KG Realtime | 已接线，causal graph append 返回 `GraphDelta`，scenario WS 可推送 `kg:delta` / `kg:snapshot_invalidated`；payload 过大或 out-of-sync 时仍以 REST snapshot fallback 为准 |
| i18n | UI 与自动生成内容按输入语言联动输出；Oracle fresh live room 的英文文案已补去混句兜底，不再把中文 hinge 直接嵌进英文句子；Oracle 英文 signoff 当前已覆盖 Chromium full 与桌面 Firefox / WebKit scoped regression |

## 架构概览

```text
frontend/  React + TypeScript + Vite
  ├─ pages/         主模式、Debate、History、Leaderboard
  ├─ game/          Pixel Theater / Phaser runtime
  ├─ stores/        页面状态与 authority 合流
  └─ lib/           replay、authority、gameplay、分享等 helper

backend/   FastAPI + SQLModel + SQLite + ChromaDB
  ├─ app/api/       scenarios / campaign / debate / ending-room / ws
  ├─ app/services/  simulator / memory / llm / scoring / ending-room
  ├─ app/models/    scenario / campaign / debate / ending-room / prediction
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
- `.env.docker` 当前默认开启：
  - `FEATURE_COUNTERFACTUAL_REPLAY`
  - `FEATURE_CAUSAL_GRAPH`
  - `FEATURE_FACTIONS`
  - `FEATURE_ARGUMENT_MAP`
- `KG Explorer`、`Replay Trace` 和图谱节点对话默认不随 Docker 评审栈开启；需要时显式设置 `FEATURE_KG_EXPLORER=true`、`FEATURE_REPLAY_TRACE=true`、`FEATURE_AGENT_CONVERSATION=true`，然后重启 backend。
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

当前 Sprint 4 收口验证口径：

- backend 全量 `pytest -x -q`：`2581 passed, 3 skipped, 9 warnings`。
- frontend 全量 `npx vitest run`：`179 files / 1926 tests / 0 failed`。
- frontend `tsc --noEmit`、`eslint src/game/scenes --max-warnings=0`、`npm run build` 全部通过，build performance budget 无 violations。
- i18n parity：`en:2159 zh:2159`，missing/mismatch 均为空。
- Gate 3/Sprint 4 browser probe 最终 rerun：desktop `10/10`、mobile `10/10`，工件位于 `frontend/output/e2e/codex-review/overall-rerun/`。
- 剩余非阻塞项：`ResultContext` 仍偏宽，后续可按 selector/useMemo 收窄；backend 全量 pytest 仍有 `tests/test_web_context_integration.py` 里的 `_noop_background` ResourceWarning。

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
