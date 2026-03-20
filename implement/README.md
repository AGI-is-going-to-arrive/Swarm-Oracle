# SwarmOracle — 实现文档索引

> 汇总自多个开发对话的所有项目文档
> 最后更新: 2026-03-20
>
> 读取规则：
> - 当前产品范围、交付状态与签收口径以仓库根 `README.md` 和 `llmdoc/*` 为准。
> - 本目录主要保存实现归档、设计基线、历史快照和研究记录。
> - `progress.md` 负责保留逐轮发现/修复/复验流水，不作为当前真值。

---

## 📁 文档目录

| # | 文件 | 状态 | 内容 | 来源会话 |
|---|------|------|------|----------|
| 01 | [架构设计](01_architecture_design.md) | historical snapshot | 初版系统架构、MVP 计划与早期技术选型；含历史性的 Tauri/原生壳设想 | 后端测试 |
| 02 | [后端测试结果](02_backend_test_results.md) | historical snapshot | 阶段性后端测试与 Bug 修复记录 | 后端测试 + 全面 Review |
| 03 | [Week 1-3 代码审查](03_week1_3_code_review.md) | historical snapshot | Week 1-3 阶段性 code review 与测试快照 | 代码审查与测试 |
| 04 | [Week 4 代码审查](04_week4_code_review.md) | historical snapshot | Week 4 阶段性 code review 与修复记录 | 代码审查与修复 |
| 05 | [Week 4 实现计划](05_week4_implementation_plan.md) | historical snapshot | 已完成事项对应的历史实施计划 | 代码审查与修复 |
| 06 | [前端代码审查](06_frontend_code_review.md) | historical snapshot | 阶段性前端审查与修复记录 | 前端 Bug 修复 |
| 07 | [实时流式 + UX 改进](07_realtime_streaming_ux.md) | historical snapshot | 单轮功能修复快照 | 当前会话 |
| 09 | [多 Agent 上下文分析](09_multi_agent_context_analysis.md) | historical snapshot | 研究型分析文档，保留上下文工程方案思路 | 上下文研究 |
| 10 | [上下文优化可行性](10_context_optimization_feasibility.md) | historical snapshot | 实施前可行性评估与风险分析 | 优化分析 |
| 11 | [**后续优化路线图**](11_optimization_roadmap.md) | active archive | P0-P9 路线的归档收口版；用于说明哪些旧 roadmap 已完成、哪些口径已过时 | Benchmark 矩阵 |
| 12 | — | merged into current docs | Phase 1 像素化可视化事实已并入 `README.md` / `llmdoc/*` | 可视化 Review |
| 13 | — | merged into current docs | Phase 2 推理可视化事实已并入 `README.md` / `llmdoc/*` | Phase 2 实现 |
| 14 | — | merged into current docs | Phase 3 游戏化 UI 事实已并入 `README.md` / `llmdoc/*` | Phase 3 实现 |
| 15 | — | merged into current docs | Phase 1-3 Code Review 修复事实已并入当前真值文档 | Code Review |
| 16 | — | merged into current docs | Phase 4 开源准备事实已并入 `README.md` / `ASSET_CREDITS.md` / `llmdoc/*` | Phase 4 实现 |
| 17 | — | merged into current docs | Phase 5 HUD 迁移事实已并入 `README.md` / `llmdoc/*` | HUD 迁移 |
| 18 | [下一轮玩法/美术/回放执行文档](18_next_session_gameplay_art_replay_plan.md) | superseded archive | 早期玩法/美术/回放执行思路；正文已改平，但不再作为当前执行入口 | 当前会话 |
| 19 | [四轨优化执行文档](19_four_track_execution_plan.md) | active archive | 四轨设计基线与当前已落地范围；正文里的计划段按历史拆解阅读 | 当前会话 |
| 20 | [Track D 辩论竞技场设计与执行方案](20_track_d_debate_arena_design_execution_plan.md) | active archive | Debate Arena 设计基线与实现状态同步；不再按待开发清单阅读 | 当前会话 |
| 21 | [Track D 辩论竞技场 MVP 蓝图](21_track_d_debate_arena_mvp_blueprint.md) | active archive | Debate Arena 蓝图与验收参考；phase 拆解按历史设计基线阅读 | 当前会话 |
| 22 | [跨设备状态收口执行文档](22_cross_device_state_closure_plan.md) | active archive | 跨设备状态 authority 收口报告 | 当前会话 |

---

## 📚 状态说明

- `current truth`
  - 不在本目录内维护；请优先阅读仓库根 `README.md`、`llmdoc/overview/project.md`、`llmdoc/guides/development.md`。
- `active archive`
  - `11 / 19 / 20 / 21 / 22`
  - 这些文件保留当前设计基线或收口报告，但正文里若仍含计划段，按文件顶部状态说明阅读。
- `historical snapshot`
  - `01 / 02 / 03 / 04 / 05 / 06 / 07 / 09 / 10`
  - 用于保留当时的架构、修复、code review 或研究记录。
- `outdated memo`
  - `18`
  - 存在明确的旧数量、旧 authority 或旧 TODO 口径，不能直接当当前真值使用。
- `missing standalone files`
  - `12-17` 当前没有独立 Markdown；相关事实已被合并进 `README.md`、`llmdoc/*` 和本索引。

---

## 📊 开发进度总览

### 当前结论

- 在当前 `browser-first Web` 作用域内，项目当前工作树已完成完整 `release:signoff` 实跑，可按 `release-candidate` 看待。
- 这一目录页只保留高层结论；细节请按文件状态继续下钻到 `11 / 19 / 20 / 21 / 22` 或仓库根 `README.md`、`llmdoc/*`。

### 已并入当前基线

- 后端核心链路已完成：解析 → 模拟 → 叙事、REST / WebSocket、场景管理、干预、导出、社交文案、预测与排行榜。
- 前端核心链路已完成：`InputView → SimulationView → ResultView → HistoryView → LeaderboardView`。
- Pixel Theater 已完成并长期收口：Phase 1-5、语义场景池、HUD 迁移、可读性修复、按需加载与截图/GIF 分流。
- 主模式玩法层已完成：14 张玩法卡、结构化押注、因果档案、daily/weekly challenge、Replay / Import。
- 主模式高级干预前端闭环已完成：`InterventionModal` 当前已支持 `即时 / 回溯 / 批量` 三模式。
- 主模式 authority 已完成：`director_state_json / gameplay_state_json` 为后端真值，`scenarioMeta` 仅保留兼容/缓存层职责。
- authority 写路径本 session 又补了 `revision` 版乐观并发控制：`director_state / gameplay_state` stale PUT 会返回 `409`，前端会回读最新 authority，而不是静默覆盖。
- 结果页 authority 又收了一步：远端 `director_state / gameplay_state / campaign summary` 当前作为展示基线，只有缺字段时才回退本地 `scenarioMeta`；本 session 又继续压缩了本地兼容层：`scenarioMeta` 的 localStorage 不再长期保留 archive 摘要重复字段，主模式 `result / simulation replay` 也会先压缩 `scenarioMeta`，读路径再按 usage/bets 现算回补。
- Debate Arena 已完成最小闭环并持续增强：独立 domain、live/result/replay、`counterplay`、`judge_rationale`、`supporting_turns`、`adjudication_mode`；本 session 又补了 replay import 的 `phase_insights` 保真。
- 工程收口已完成：shared gameplay contract、provider policy、Alembic、Prometheus `/metrics`、CI、`release:signoff`；Theater 这轮又补了意图级 loader 预取、WebKit 截图兜底、移动端首屏压缩，以及 `BootScene` 初始 sprite 预载收紧 + `WorldScene` 缺失 sprite 按需补载。

### 当前验证口径

- Historical full baseline：
  - backend `815 passed`
  - frontend `179 passed`
- Current targeted verification：
  - backend targeted set `86 passed`
  - frontend targeted set `104 passed`
- Current session focused verification：
  - `backend/tests/test_campaign_service.py + backend/tests/test_campaign_api.py + backend/tests/test_debate_api.py`：`32 passed`
  - `src/pages/SimulationView.test.tsx + src/lib/scenarioReplay.test.ts + src/lib/simulationReplay.test.ts + src/pages/ResultView.test.tsx`：`32 passed`
  - `tsc / build`：通过
- Current release signoff：
  - 本 session 代码相关完整签收工件：`frontend/output/e2e/current-head-rerun/summary.json`
  - 同一批代码改动在更干净工作树上的实跑工件：`frontend/output/e2e/current-head-recheck/summary.json`
  - 最近一次 clean runtime 基线工件：`frontend/output/e2e/current-head-audit-signoff/summary.json`
  - 这份 `summary.json` 绑定 commit `3c96b52f618bc1e1e06d2630ecacb885951948a3`，且 `dirty=false`
  - `summary.json` 会带 git `branch / commit / worktree` 绑定信息
  - 默认合同当前已包含 `mobile`
  - Debate full 当前可按要求校验 `adjudication_mode = llm_hybrid`

### 当前边界

- 当前交付形态仍是浏览器优先的 Web 应用；`跨平台` 指桌面/移动浏览器响应式与视口 E2E，不代表原生客户端壳已交付。
- Safari 属于可选附加验证，不在默认 full signoff 合同内；其截图仍可能受浏览器/插件浮层污染。
- `scenarioMeta` 仍存在，但已经不是跨设备 authority；它现在主要保留兼容、缓存和 replay 输入职责，usage-derived director/cooldown 字段、ResultView 摘要字段与 replay archive 冗余项都已进一步压缩。
- 当前最主要的增量空间是 `phaser` 主 chunk、`capture-html` chunk，以及 `frontend/public/assets` 下大体积 PNG 资源；其次才是 Safari/WebKit 取证边界与更细的玩法/视觉 polish，而不是核心功能缺失。

### 推荐下钻顺序

1. `11_optimization_roadmap.md`
   看旧 roadmap 的归档收口。
2. `19_four_track_execution_plan.md`
   看四轨设计基线与当前已落地范围。
3. `20_track_d_debate_arena_design_execution_plan.md`
   看 Debate Arena 设计基线。
4. `21_track_d_debate_arena_mvp_blueprint.md`
   看 Debate MVP 蓝图与验收参考。
5. `22_cross_device_state_closure_plan.md`
   看 authority 收口与剩余边界。
