# SwarmOracle — 实现文档索引

> 汇总自多个开发对话的所有项目文档  
> 最后更新: 2026-03-19

---

## 📁 文档目录

| # | 文件 | 内容 | 来源会话 |
|---|------|------|----------|
| 01 | [架构设计](01_architecture_design.md) | 系统架构、数据模型、API 设计、前端组件、技术栈、MVP 计划、关键决策 | 后端测试 |
| 02 | [后端测试结果](02_backend_test_results.md) | 135 个测试通过、3 个 Critical Bug 修复、Deprecation 修复、全面 Review 修复 | 后端测试 + 全面 Review |
| 03 | [Week 1-3 代码审查](03_week1_3_code_review.md) | 108 个测试通过、10 个 Bug 修复（前后端）、新测试覆盖 | 代码审查与测试 |
| 04 | [Week 4 代码审查](04_week4_code_review.md) | 142 个测试通过、8 个 Bug 修复、Live E2E 测试 | 代码审查与修复 |
| 05 | [Week 4 实现计划](05_week4_implementation_plan.md) | Intervention API、ResultView、InterventionModal、Docker、文档 | 代码审查与修复 |
| 06 | [前端代码审查](06_frontend_code_review.md) | 17 个 Bug 修复（CSS、动画、路由、颜色）、构建验证 | 前端 Bug 修复 |
| 07 | [实时流式 + UX 改进](07_realtime_streaming_ux.md) | 修复 JSON 乱码、轮数滑块(3-40)、分支描述 | 当前会话 |
| 09 | [多 Agent 上下文分析](09_multi_agent_context_analysis.md) | 前沿技术全景、五种范式对比、SwarmOracle 接入方案 | 上下文研究 |
| 10 | [上下文优化可行性](10_context_optimization_feasibility.md) | 三阶段可行性评估、代码逐行分析、Phase 1-3 改动量评估 | 优化分析 |
| 11 | [**后续优化路线图**](11_optimization_roadmap.md) | 已改为 P0-P9 路线的归档收口版；用于说明哪些旧 roadmap 已全部落地、哪些正文口径已过时 | Benchmark 矩阵 |
| 12 | — | **Phase 1 像素化可视化**: 事件映射 + 精灵分配 + 场景选择 + 卡牌事件 + 225 tests | 可视化 Review |
| 13 | — | **Phase 2 推理可视化**: 天气/昼夜 + 阵营标记 + 气泡变体 + 粒子特效 + 11场景全覆盖 | Phase 2 实现 |
| 14 | — | **Phase 3 游戏化 UI**: 标题画面 + 6种结局 + MiniMap/BetPanel/Leaderboard HUD + 截图/GIF导出 | Phase 3 实现 |
| 15 | — | **Phase 1-3 Code Review 修复**: P0 内存泄漏 + P1 事件监听器 + P2 关键词优先级/卡牌概率 + P3 防御性守卫, 7 修复 5 文件 | Code Review |
| 16 | — | **Phase 4 开源准备**: Weather 对象池(120) + 视口裁剪(40px) + ASSET_CREDITS 106 个 runtime + source 资产条目 + WorldScene/EndingScene 32 新测试 | Phase 4 实现 |
| 17 | — | **Phase 5 HUD 迁移**: 排行榜/竞猜面板从 Phaser canvas 迁移至 React HudOverlay.tsx，画布无遮挡 | HUD 迁移 |
| 18 | [下一轮玩法/美术/回放执行文档](18_next_session_gameplay_art_replay_plan.md) | 下一次对话可直接复用的执行 briefing：玩法系统、Vertex 生图、Theater 回放、验收标准；已同步本轮真实落地状态 | 当前会话 |
| 19 | [四轨优化执行文档](19_four_track_execution_plan.md) | 四轨路线的执行与落地状态文档；已同步 `Track A` 最小闭环、`Track B2` shared contract 收口、`Track C` 工件基线，以及 `Track D Debate Arena` 已实现事实、测试与 E2E 工件 | 当前会话 |
| 20 | [Track D 辩论竞技场设计与执行方案](20_track_d_debate_arena_design_execution_plan.md) | Debate Arena 的设计基线 + 2026-03-18 落地偏差记录；覆盖当前真实 API、前端拆分、i18n、跨平台、自动化钩子、测试与 E2E 工件 | 当前会话 |
| 21 | [Track D 辩论竞技场 MVP 蓝图](21_track_d_debate_arena_mvp_blueprint.md) | Debate Arena MVP 的产品/美术/代码蓝图及其已实现状态同步；包含 live/result、押注、分享、自动化钩子与现有 skill-based QA 工件 | 当前会话 |
| 22 | [跨设备状态收口执行文档](22_cross_device_state_closure_plan.md) | 已改为跨设备状态 authority 收口报告；记录 `director_state / gameplay_state` 最终形态、验证结果与剩余边界 | 当前会话 |

---

## 📊 开发进度总览

### 已完成
- ✅ 后端核心（解析 → 模拟 → 叙事三阶段）
- ✅ REST API + WebSocket 实时推送
- ✅ 前端核心（InputView → SimulationView → BranchTree）
- ✅ 蝴蝶效应干预功能（回溯 + 多点 + 模板）
- ✅ ResultView 多结局对比
- ✅ 后端历史全量基线仍记录为 **815 passed**
- ✅ 前端历史全量基线仍记录为 **179 passed**（Vitest）
- ✅ 中英双语 i18n
- ✅ 实时 Agent 消息推送（per-agent 即时推送）
- ✅ 用户可选推演轮数（滑块 3-40）
- ✅ Blackboard 共享空间 + L2 向量记忆
- ✅ 分层代理架构（P3-A，千人规模）
- ✅ 排行榜 / 竞猜社交层（P3-B）
- ✅ 场景管理 + 导出 + BYOK（P4）
- ✅ Fork 抑制 + 叙事改进（P5）
- ✅ 社交媒体文案生成（P6）
- ✅ 可收起侧边栏 + 分支讨论卡片 + Agent 消息过滤（P7）
- ✅ 代码审查加固 + CSS 兼容性（P8）
- ✅ 语言检测 + 全局语言切换器（P9）
- ✅ API 层拆分重构（scenarios → 5 模块）(P0-1)
- ✅ N+1 查询优化（LEFT JOIN）(P0-2)
- ✅ LLM 重试 + 指数退避 (P1-3)
- ✅ Alembic 数据库迁移框架 (P1-4)
- ✅ Prometheus 可观测性 (`/metrics`) (P3-9)
- ✅ 前端测试框架 (Vitest) (P2-6) — 历史全量基线 **179 passed**；本轮围绕玩法卡 / Debate / i18n / 自动化摘要的定向回归为 **60 passed**
- ✅ 批量 SQL 删除优化 (P2-7)
- ✅ **Phase 2 推理可视化**: 天气/昼夜系统 + 阵营标记 + 气泡变体 + 粒子特效 + 30 个语义场景主题（含 law/faith/generic 变体）
- ✅ **Phase 3 游戏化打磨**: 标题画面 + 6种结局 + MiniMap + 竞猜面板 + 排行榜 + 截图/GIF导出
- ✅ **Phase 4 开源准备**: Weather 粒子对象池 + 视口裁剪 + ASSET_CREDITS 106 个 runtime + source 资产条目 + 32 项新测试 + tsc 零错误
- ✅ **Phase 5 HUD 迁移**: 排行榜/竞猜面板从 Phaser canvas 迁移至 React HudOverlay.tsx，画布场景无遮挡
- ✅ 主模式 `gameplay_state` authority 第一段：`cards.usageLog` 已后端化，前端会基于远端 `usage_log` 重算导演点数、卡牌冷却、`most_used_card` 与反制轨迹摘要
- ✅ Safari 正式 smoke：`npm run e2e:safari` 已实跑通过，不再只是临时脚本
- ✅ 7 张原库存 sprite 已接入 runtime：`alchemist / assassin / bard / knight / monk / thief / witch`
- ✅ Theater 可读性修复：舞台优先布局、上下信息条压缩、气泡文字放大与清晰化

### 本轮已收口
- ✅ 完整 E2E 脚本与近期通过工件（本轮已重跑 main `full`、Debate `full`、Debate `430x932`）
- ✅ 前端代码分割优化（SimulationView 业务块已拆小）
- ✅ Theater / 截图链路第二轮懒加载收口：`PhaserGameLoader` 也已移到 Theater 动态边界；`useScreenCapture` 现只保留轻壳，真实 DOM capture / GIF 逻辑已拆到 `screenCaptureRuntime.ts`
- ✅ Docker Compose 一键部署（已完成真实容器 smoke）
- ✅ Director Campaign / 导演生涯最小闭环（A1 已落地，首页与结果页可见）
- ✅ 玩法契约统一（B2 已收口：shared gameplay contract 现覆盖卡牌规则、modal 输入契约、prompt 语义和后端 branching bonus；前后端不再各自维护第二份静态卡牌事实源）
- ✅ 12 个题材画像全量 E2E / 工件补齐（主 12 profile + 3 条 variant matrix + mobile 双证据）
- ✅ AI 辩论竞技场 MVP（独立 Debate domain + `/api/debate` / `/ws/debate/{id}` + live/result 页 + 结构化押注 + share + automation hooks + desktop/mobile E2E）
- ✅ Debate `counterplay` 最小闭环（可提示、可一键提交、后端显式返回到 live snapshot / result payload / WS、结果页与 share 会显示命中/未中；当前 payload 还会带 `phase_score / explanation`，并进入 replay digest 与 judge summary）
- ✅ LLM 治理与 provider policy 第一段收口（全局并发闸门 / pending 配额 / provider 熔断 + provider policy 贯通 createScenario / createDebate / social copy / scorePredictions）
- ✅ Director Campaign Lite 增量（`weekly-summary` API + 首页 `weekly challenge / director growth` + 结果页分享 challenge 链接）
- ✅ Debate Arena 文案增强（回合文案 `LLM 优先、deterministic fallback` + live `phase cue / feed focus` + 更具体的 judge summary）
- ✅ Debate Arena 裁决解释增强（结果 payload 现带 `judge_rationale / supporting_turns`；share copy 会带 1-2 条关键引文；`debate:desktop` 与 `debate:full` 黑盒现都会显式断言 `supporting_turns.length >= 1`）
- ✅ Portable replay 闭环（主模式 `ResultView / SimulationView` 与 Debate `DebateResultView` 现都有 replay 页面；主模式优先走后端 `ReplayArtifact` 短 `share id`，失败时回退 token；三条 replay 页当前都支持“导入为本地运行”）
- ✅ Debate 终局裁决升级（后端现会优先读取 judge analysis 里的 `adjudication` scorecard 做 `LLM hybrid` 混合裁决，结果 payload 会显式带 `adjudication_mode`；失败时退回 deterministic fallback）
- ✅ `scenarioMeta` 兼容层继续瘦身：`SimulationView` 不再把后端 authority 反向 apply 到 localStorage；`ResultView` 不再用本地 meta 回填后端 authority；`PredictionModal` 改为优先读取父层传入的当前 meta
- ✅ 本次 bundle / authority 收口回归已通过：`vitest` 定向 **32 passed**、`npx tsc --noEmit -p tsconfig.app.json` 通过、`npm run build` 通过，并已实跑：
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-corners/`
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-cross-browser/`
  - `frontend/output/e2e/20260319-post-bundle-scenariometa-debate-full/`

### 当前边界
- ℹ️ 当前交付形态仍是浏览器优先的 Web 应用；“跨平台”指桌面/移动浏览器响应式与视口 E2E，不代表原生 Windows/macOS/Linux/iOS/Android 客户端已交付
- ℹ️ `director goals / worldline commitment` 与主模式 `cards.usageLog / betting.bets / archive key moments / branch snapshots` 当前都已后端化到 `Scenario.director_state_json / gameplay_state_json`；`scenarioMeta` 仍存在，但本轮又去掉了 `ResultView` authority 回填与 `PredictionModal` 的本地直读，当前主要保留缓存/兼容、派生字段和 replay payload
- ℹ️ 主模式现已有 `e2e:cross-browser` 与 `e2e:safari` 正式 smoke 入口，并已实跑 Chromium/Chrome、Firefox、WebKit 与 Safari；Safari 若开启翻译插件，截图仍可能被浏览器/插件浮层污染
- ℹ️ asset provenance 当前是 `62/62` PNG 均有 sidecar；其中多数为诚实 backfill，表示 sidecar 补齐，不代表恢复了原始生成时间、模型或 prompt
- ℹ️ Debate `counterplay` 已经是后端优先的显式 payload，但仍是挂在 Debate 领域里的最小实现，不是完整独立子系统
- ℹ️ Debate 胜负 / `verdict_tone` / 分数核心当前已升级为 `LLM hybrid` 优先、deterministic fallback；结果 payload 会显式带 `adjudication_mode`
- ℹ️ `分享挑战` 仍然只是“分享开局配置”；但主模式 `ResultView / SimulationView` 与 Debate `DebateResultView` 当前已经有可复盘 replay 链路，并且支持把 replay 导入为本地真实运行

### 已完成 Sprint
- ✅ **Sprint 11 — 像素化可视化 Phase 1**: 事件映射 + 精灵分配 + 场景选择 + 卡牌事件, 7 Bug 修复, 225 新测试
- ✅ **Sprint 11.1 — Phase 1 Code Review 修复**: viz_push 死代码消除 + ending_type 3级映射 + Worker viz 事件 + EventBridge 单测, 4 问题修复, 22 新测试
- ✅ **Sprint 11.2 — Phase 2 推理可视化 + Phase 3 游戏化打磨**: 天气/昼夜 + 阵营 + 气泡变体 + 粒子 + 标题画面 + 6种结局 + Mini Map + 竞猜面板 + 排行榜 + 截图/GIF导出, 22 i18n keys × 2
- ✅ **Sprint 11.3 — Phase 1-3 Code Review 修复**: P0 WorldScene 内存泄漏 + P1 事件监听器泄漏 + P2 scene_selector 关键词优先级/卡牌概率偏差 + P3 stance clamp/zero guard, 7 修复 5 文件, 212 tests 回归通过
- ✅ **Sprint 11.4 — Phase 4 开源准备**: Weather 对象池(120) + 视口裁剪(40px) + ASSET_CREDITS(106 个 runtime + source 资产条目) + WorldScene.test.ts(18) + EndingScene.test.ts(14), tsc 零错误
- ✅ **Sprint 11.5 — Phase 5 HUD 迁移**: 排行榜/竞猜面板从 Phaser canvas → React HudOverlay.tsx, WorldScene.ts HUD 代码全删除, game.css 新增 hud-bar 样式

### 累计修复的 Bug
- 🔴 Critical: 13 个（+3 可视化）
- 🟡 High: 9 个（+1 Review: Worker viz 缺失）
- 🟠 Medium: 24 个（+2 可视化 +2 Review: ending_type + viz_push 死代码）
- 🟢 Low: 18 个（+2 可视化 +1 Review: EventBridge 无测试）
- 🔧 测试修复: 8 个
- **总计: 83 个问题全部已修复**（含 P0-P3 Code Review 5 个 + Phase 1 可视化 7 个 + Phase 1 Review 4 个 + Phase 1-3 Review 7 个）
