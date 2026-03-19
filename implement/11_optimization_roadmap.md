# SwarmOracle — 优化路线图（归档收口版）

> 文档状态：这份文件已从“待开发 roadmap”切换为“路线图收口记录”。
> 适用时间：截至 `2026-03-19`。
> 用途：说明旧的 `P0-P9` 优化路线哪些已经落地，哪些不再属于待办，哪些只是新的增量改进方向。

---

## 1. 结论

原 `P0-P9` 路线已整体完成，不应再被当作当前项目的待开发清单。

这份文档过去的问题是：

- 顶部总表已经标记 `✅ 已完成`
- 但正文仍保留了早期“实施前方案”和“未完成”描述
- 其中最典型的误导是 `P1 Blackboard 模式集成`，总表已完成，但正文一度仍写 `simulator.py 集成未完成`

当前应以真实代码、测试、E2E 工件和 `implement/README.md` 的最新状态为准。

---

## 2. 路线图收口状态

### 2.1 核心能力

| 项 | 状态 | 说明 |
|----|------|------|
| P0 参数化 | ✅ 已完成 | Agent 数量 / 轮数 / mode 已进入真实产品链路 |
| P0 Docker | ✅ 已完成 | 已有真实容器 smoke |
| P1 Blackboard 集成 | ✅ 已完成 | `simulator.py` 已接 Blackboard / shared briefing / fork |
| P1 流式发言 | ✅ 已完成 | WebSocket 实时推送已在真实 UI 链路使用 |
| P2 向量记忆 | ✅ 已完成 | Chroma L2 已落地 |
| P2 干预增强 | ✅ 已完成 | retrospective / batch / templates 已存在 |
| P3 分层代理 | ✅ 已完成 | Leader-Worker 模式已接进模拟链路 |
| P3 竞猜排行 | ✅ 已完成 | prediction / scoring / leaderboard 已落地 |
| P4 场景管理 | ✅ 已完成 | list / delete / export 已落地 |
| P4 BYOK | ✅ 已完成 | provider policy 已贯通 createScenario / createDebate / social / score |
| P5 Fork 抑制与叙事 | ✅ 已完成 | narration / ending / fork 边界已收口 |
| P6 社交文案 | ✅ 已完成 | 小红书 / 微博 / 知乎 / Reddit / X 已落地 |
| P7 前端 UX | ✅ 已完成 | 可收起侧栏 / 分支卡 / Agent 过滤已落地 |
| P8 加固 | ✅ 已完成 | 代码审查项与 CSS 兼容问题已收口 |
| P9 多语言 | ✅ 已完成 | 语言检测 + 全局 EN/ZH 切换已落地 |
| P0-1 API 拆分 | ✅ 已完成 | scenarios API 已拆为多个模块 |
| P0-2 N+1 优化 | ✅ 已完成 | LEFT JOIN 已替代逐条查询 |
| P1-3 重试退避 | ✅ 已完成 | 429/5xx 重试已落地 |
| P1-4 Alembic | ✅ 已完成 | schema 迁移框架已落地 |
| P2-6 前端测试框架 | ✅ 已完成 | Vitest 已长期运行 |
| P2-7 批量删除 | ✅ 已完成 | 场景删除走批量 SQL |
| P2-8 概率归一化 | ✅ 已完成 | 单会话归一化已存在 |
| P3-9 可观测性 | ✅ 已完成 | `/metrics` 已落地 |

---

## 3. 已完成事实基线

当前仓库的真实状态已经超出最初这份 roadmap 的范围，至少还包括：

- Pixel Theater Phase 1-5 完成
- Director Campaign 最小闭环完成
- 主模式 `director_state / gameplay_state` authority 完成
- Portable replay / import 完成
- Debate Arena MVP 完成，并已扩到：
  - `counterplay`
  - `judge_rationale`
  - `supporting_turns`
  - `phase_insights`
  - `adjudication_mode`

因此，这份文件不再承担“未来实施方案”作用，而是作为旧 roadmap 的归档收口说明。

---

## 4. 需要停止继续引用的旧表述

以下口径已经过时，不应继续在项目内复用：

- `simulator.py 集成 Blackboard 未完成`
- `Docker Compose 仍待补 frontend service`
- `P0-P9 仍是未来路线`
- 任何把这份文档正文中的旧 checklist 当成当前待办的读法

如果需要判断“现在还差什么”，应查看：

- `implement/README.md`
- `progress.md`
- 根 `README.md`
- `llmdoc/overview/*.md`

---

## 5. 当前真正还值得做的增量优化

这些不是旧 `P0-P9` 的尾项，而是新一轮工程优化：

1. 前端包体与加载时机继续优化。
   本 session 已补上第二层边界：
   - `PhaserGameLoader` 本身也已移到 Theater 动态边界
   - `useScreenCapture` 已拆成轻壳 + `screenCaptureRuntime.ts`
   - `html2canvas / gif.js / gif.worker` 继续保持 capture 时才加载
   本 session 又补了一层首页首包收口：
   - 首页题材 `label / hooks / badge` 改走轻量摘要 helper
   - `InputView` 不再直接 runtime 引完整玩法策略表
   当前 `phaser` 仍是大体积引擎 chunk，`capture-vendor` 也仍是独立 chunk；首页首包这条线已经继续收紧，后续若继续做，主要目标仍是 Theater 引擎和更深层的异步 chunk，而不是把首页题材摘要重新当成“尚未开工”。

2. 文档真值持续收口。
   需要避免“总表已完成、正文仍停留在计划态”的文档漂移再次出现。

3. 发版 clean-room 验证。
   本 session 已实跑：
   - `release:signoff --headless`
   - `release:signoff --headless --include-safari`
   - 首页首包收口后的 `release:signoff --headless`
   工件位于：
   - `frontend/output/e2e/2026-03-19T15-20-32-479Z-release-signoff/`
   - `frontend/output/e2e/2026-03-19T15-25-24-398Z-release-signoff/`
   - `frontend/output/e2e/2026-03-19T15-35-24-820Z-release-signoff/`
   本次 session 又补了这条线的收口基础设施：
   - `release:signoff` 现在会在 output root 增量写 `summary.json`
   - `release:signoff` 当前还会额外检查 backend `/metrics`
   - Debate `result_ready / result CTA` 等待改成 progress-aware，并支持 `SWARM_DEBATE_RESULT_TIMEOUT_MS / SWARM_DEBATE_STALL_TIMEOUT_MS / SWARM_DEBATE_RESULT_CTA_TIMEOUT_MS`
   - `.github/workflows/ci.yml` 新增 `release-signoff-dry-run` 与 deterministic `debate-signoff-smoke`
   本次真实验证为：
   - backend targeted `pytest`：**81 passed**
   - frontend targeted `vitest`：**79 passed**
   - `frontend/output/e2e/post-fix-debate-desktop/`：Debate desktop 黑盒通过
   - `frontend/output/e2e/release-signoff-summary-dry-run/summary.json`：`summary.json` 落盘通过
   - `frontend/output/e2e/post-fix-release-signoff/summary.json`：已确认会按步骤增量更新；这次没有等待整条链路跑完，所以不要把这次复跑写成“通过”
   本次 session 又补了一轮当前工作树收口：
   - backend targeted `pytest`（含 `tests/test_metrics.py`）：**82 passed**
   - live `/metrics`：`200 text/plain`
   - `frontend/output/e2e/current-audit-signoff-dry-run-v4/summary.json`：dry-run 通过
   - `frontend/output/e2e/current-audit-release-signoff-v2/summary.json`：真实 full signoff 通过
   后续若做 release signoff，仍建议在更干净的工作区再复跑一次：
   - `release:signoff --headless`
   - 如需要 Safari 证据，再追加 `--include-safari`

4. 继续明确产品边界。
   当前交付是浏览器优先 Web，不是原生桌面或原生移动客户端。

---

## 6. 归档说明

这份文档保留文件名是为了不打断 `implement/README.md` 既有索引，但其语义已经变成：

- 旧 roadmap 的收口记录
- 不是当前执行计划
- 不是待办清单

后续如需再写新的优化路线，应新开文档，而不是在这份旧 roadmap 上继续叠加“未完成”段落。
