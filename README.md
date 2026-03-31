# 🔮 SwarmOracle

> AI "What-If" Prediction Playground。输入一个历史或假设性问题，系统用多 Agent 推演、分支时间线、Pixel Theater、结构化押注与结果房间把不同世界线可视化出来。

## 当前定位

- 当前交付形态是 `browser-first Web`。
- `跨平台` 仅指桌面/移动浏览器响应式与视口 E2E，不包含原生客户端壳。
- 当前主闭环已覆盖：
  - 主模式 `InputView -> SimulationView -> ResultView`
  - `Debate Arena` live/result/replay
  - `Oracle Chambers / 世界线圆桌`
  - replay 分享与导入
  - director campaign、玩法卡、结构化押注
- 最近一次稳定全链签收工件位于 `frontend/output/e2e/20260330-full-release-signoff-stable/summary.json`。
- 最近一次 Oracle 专项签收工件位于：
  - `frontend/output/e2e/20260331-oracle-signoff-ending-room/summary.json`
  - `frontend/output/e2e/20260331-oracle-signoff-roundtable/summary.json`
- 单结局结果页当前只保留：
  - `进入会客厅`
  - `只改一步`
  - 不会展示 `发起圆桌` / `异线旁听席`
- 当前仍在持续收口的增量主要是：
  - follow-up 与经典模式的流式一致性
  - `pretext` 是否继续推进到运行时 transcript 稳定化（`P2+`）
  - Oracle 更深的回归、跨浏览器与 corner-case hardening

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
| Director Campaign | 已落地，含 goals、risk/resource、commitment、growth |
| Debate Arena | 已落地，含 live/result/replay、counterplay、judge rationale |
| Oracle Chambers / Worldline Roundtable | 已进入可玩签收基线，支持 participant picker、follow-up、replay/share/import、`manual_shortlist`、`expert_witness`、`trait_mix`、`fault_line_first`、`witness_augmented`；single-ending 当前已补 `继续追问 / 另开线程 / 复制纪要 / 追问洞察 / quote 级追问`，roundtable 当前已补 `Continue this table / Start anchored thread / Copy roundtable brief / phase insight / quote 级追问`；`quote / verdict / key_moment / phase` 当前都走显式锚点语义；readonly replay 已重新签收到移动端 hotseat thread / local restore / import 主链；单结局结果页只暴露 `进入会客厅 / 只改一步` |
| Replay & Import | 主模式与 Debate 均支持 |
| i18n | UI 与自动生成内容按输入语言联动输出；Oracle fresh live room 的英文文案已补去混句兜底，不再把中文 hinge 直接嵌进英文句子 |

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
- `ending_room` 是独立域，room/thread transcript 与 memory partition 隔离。
- replay 分享优先走后端 `ReplayArtifact`，失败且 URL token 也不可用时，会回退为本地只读副本链接。

## 快速开始

### Docker

```bash
docker compose up --build -d
```

- Frontend: `http://localhost:18928`
- Backend: `http://localhost:18927`
- Docker 默认读取仓库根目录 `.env.docker`。

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
npm run build
```

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

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
