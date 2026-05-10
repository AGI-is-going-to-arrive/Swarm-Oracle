# Team Plan: SwarmOracle 全面改进实施计划

> 基于 v4 Final Research + Codex 后端分析 + Gemini 前端分析 + 3 Explore Agent 深度分析
> 总编排: Claude | 后端: Claude+Codex | 前端: Claude+Gemini | 审查: 对抗式交叉 Review

---

## 概述

Sprint 0-6 / ~20-25 周完整改进计划。当前文件包含 35 个命名任务，其中 S0-2 已并入 S0-1，实际独立执行单元为 34 个。按文件范围隔离确保并行安全。每个 Sprint Gate 执行 Codex+Claude 对抗式审查 + Playwright 浏览器实测。

**跨平台要求**: 目标支持 Windows/macOS/Linux + Chrome/Firefox/Safari/Edge；当前自动化证据以 Chromium/Chrome channel where available + Firefox + WebKit 为准。Safari 需要 Safari/WebDriver opt-in；Edge 需要 msedge channel、BrowserStack/Sauce、或明确手工 Gate 才能声称覆盖。
**贯穿要求**: 去模板化只覆盖用户可见叙事/后端 fallback；前端 UI 文案统一走 i18n，不用 LLM 生成 UI copy

---

## Local Sprint 0-4 Progress / Sprint 5 Handoff

**更新时间**: 2026-05-11 (Sprint 4 review/fix 签收)
**对应代码状态**: Sprint 0-4 已完成本地审查、修复、全量测试与浏览器复测；下一轮从 Sprint 5 开始
**注意**: `.claude/` 被 `.gitignore` 忽略，本文件需要显式 `git add -f`。以后新增 `.claude/` 文件仍不会被普通 `git add` 自动收录。

### Sprint 0-4 当前状态

- Sprint 0 / 1 / 2 / 3 已完成并提交到 `origin/master`。Gate 3 已签收。
- Sprint 4 已在当前工作树完成本地 review/fix/full tests/browser rerun，等待本次文档同步后提交。
- 已落地能力：
  - `/admin/setup` 3 步 provider 设置向导
  - `/api/admin/preflight` 与 `/api/admin/test-llm`
  - root `Makefile` 的 `preflight / dev-backend / dev-frontend`
  - 本地 self-hosted fonts：`frontend/src/fonts.css` + `frontend/public/fonts/*.woff2`
  - backend 多阶段 Dockerfile、runtime import smoke、healthcheck
  - user-triggered simulation cancel：`cancelled` 终态、cancel token、task registry、`simulation_cancelled` WS 事件
  - shared Radix AlertDialog，覆盖 launch confirm 与 cancel confirm
  - InputView 首次 onboarding、安全提示与中英 i18n parity
  - ResultView Reader/Workbench mode，偏好写入 `uiPreferencesStore`
  - scenario-level Agent Conversation history：`GET /api/scenario/{id}/conversations`
  - `/api/quota/summary` 与前端 `QuotaBadge`
  - Agent Library generated/custom 分组、generated 禁用编辑/删除
  - 5 维 `decision_bias` schema + Agent Workshop slider
  - AgentProfileModal growth metrics 与 ArgumentMap 状态展示
  - S3-4 `HOPsAnimation` 已接入生产 `ResultView`
  - S4-1 backend KG realtime event contract：`GraphDelta` + `kg:delta` / `kg:snapshot_invalidated` + coalescer
  - S4-2 `ResultView` 拆到 `frontend/src/pages/result/` 的 9 个子组件 + `ResultContext`
  - S4-3 第一批 `isZh` 迁移：`CompareDigestView / InputView / DebateResultView / FactionTimeline` 与 25 个新 locale keys
  - S4-4 voice variant 从 13 扩到 18：`tech-visionary / journalist / educator / artist / entrepreneur`
  - S4-5 Phaser `EndingScene / TitleScene / WorldScene` reduced-motion guard
- 已同步文档：
  - `README.md`
  - `backend/README.md`
  - `frontend/README.md`
  - `llmdoc/overview/project.md`
  - `llmdoc/overview/backend.md`
  - `llmdoc/overview/frontend.md`
  - `llmdoc/reference/api.md`
  - `llmdoc/reference/config.md`
  - `llmdoc/guides/development.md`
- Sprint 3 已落地：
  - S3-1：`CounterfactualBrand` 已接到 `ResultView`，点击 fork point 会把 `CounterfactualPanel` 的 `initialRound` 同步到对应轮次。
  - S3-2：`AnalystStreamView` 已切到共享 `ReACTReasoningPanel`，展示 analyst 的工具调用、参数、结果摘要和最终回答。
  - S3-3：后端 `personality_drift.py`、`GET /api/scenario/{id}/personality-drift`、前端 `PersonalityDriftWarning` 已接线；当前使用 `FEATURE_AGENT_IDENTITY` gate，只做 warning，不 hard gate。
  - S3-5：`ShareModal` 已扩展预测卡片 PNG 下载 / 图片剪贴板复制、focus trap、Escape/关闭 abort；仍复用现有 `html2canvas` 动态导入。
  - S3-6：后端 snapshot ZIP export/import、`snapshot_export` capability、前端导出/导入弹窗、首页导入入口和结果页导出入口已接线；后端导入会校验 manifest/checksum、拒绝 ZIP traversal/symlink/zip bomb，并清空 imported `agent_identity_id`。
  - S3-4：`HOPsAnimation` 已接入 `ResultView.tsx`，在 endings-grid 前展示分支概率采样动画；`branches.length >= 2` 时可见，replay 模式下 `isPlaying=false`。

### Gate 3 签收记录 (2026-05-10)

- **S3-4 HOPs 生产接线**: 已完成。`HOPsAnimation` 接入 `ResultView`，传入 `branches` 数据，replay 模式 `isPlaying=false`。
- **Frontend 全量回归**: `179 files / 1922 tests / 0 failed`（高于 baseline 177/1904）
- **静态检查**: tsc pass, lint pass, build pass, i18n parity `2151=2151`
- **HOPs 单元测试**: 8/8 passed（组件渲染、< 2 分支隐藏、概率百分比、play/pause、i18n、mobile overflow）
- **浏览器实测**:
  - fixture e2e `13/13` (desktop + mobile chromium)
  - Sprint 3 组件探测 `9/10` (HOPs 可见、snapshot export 按钮+弹窗、无水平溢出、无 console 错误；1 FAIL 是测试脚本错误 selector，已修复)
  - 无 horizontal overflow（desktop 1440=1440, mobile 390=390）
- **跨 OS ZIP 兼容性**: 代码审查确认全部 PASS
  - UTF-8 filenames: YES（所有成员名 ASCII）
  - Path separator: YES（PurePosixPath + backslash 拒绝）
  - LF 换行: YES（`"\n"` 拼接，`splitlines()` 读取）
  - ZIP64: YES（Python 默认启用，50MB 上限使其不可触发）
  - Checksum: YES（SHA-256 + size 双重校验）
  - 真实跨 OS 证据: macOS 本地验证通过；Windows/Linux 未实测（无 CI 环境），但代码分析无平台依赖路径
- **安全审查**（Claude 独立 + Codex 对抗式）:
  - 0 Critical / 0 High
  - 1 Medium 已修复：edge `payload_json`/`evidence_json` 走 `_remap_payload_json`
  - 1 Low 已修复：新增 `MAX_ZIP_MEMBER_COUNT=256` 上限
  - 后端修复验证：`snapshot_export.py` 34 tests passed + ruff clean
- **Backend Sprint 3 窄测**: `46 passed`（snapshot_export + personality_drift）

### Sprint 4 签收记录 (2026-05-11)

- **Review 修复**:
  - KG realtime coalescer 串行 flush、broadcast timeout 与 pending drain 已补。
  - snapshot ZIP import 改按物理 member 计数并拒绝重复 member name。
  - voice variant 去掉过宽的 `medium / scale` 误分类路径，并补齐现代 variant hook/brief 覆盖。
  - Phaser reduced-motion 补 Ending / Title / World 的入口动画、camera fade、bubble typewriter 等路径。
  - `ResultView` 的 HOPs 生产挂载已恢复；Gate 3 probe 最终通过。
- **Backend 全量**: `cd backend && source .venv/bin/activate && pytest -x -q`：`2581 passed, 3 skipped, 9 warnings`。
  - 9 个 warning 来自 `tests/test_web_context_integration.py` 的 `_noop_background` ResourceWarning，未阻塞本次 Sprint 4。
- **Frontend 全量**: `cd frontend && npx vitest run`：`179 files / 1926 tests / 0 failed`。
- **静态与构建**: `tsc --noEmit`、`eslint src/game/scenes --max-warnings=0`、`npm run build` 全部通过；build performance budget 无 violations。
- **i18n parity**: `en:2159 zh:2159`，missing/mismatch 均为空。
- **浏览器实测**: `e2e-gate3-sprint3-probe.mjs` 最终 rerun 为 desktop `10/10`、mobile `10/10`，工件位于 `frontend/output/e2e/codex-review/overall-rerun/`。
- **跨平台边界**: 本轮真实 browser rerun 是 Chromium desktop/mobile；没有新增 Windows/Linux/Edge/Safari 实测证据，后续不能写成这些平台已 PASS。
- **剩余 follow-up**:
  - `frontend/src/pages/result/ResultContext.tsx` 仍是宽 context；如果 Sprint 5 继续改结果页，优先评估 selector / useMemo 收窄，避免无关子组件重渲染。
  - backend `_noop_background` ResourceWarning 可单独收口，但当前不是失败项。
  - 若 Sprint 5 需要前端实时 KG 增量消费，先验 `useScenarioGraph` 是否已消费 `kg:delta`；本轮代码只确认 backend event contract 和 coalescer。

### 下次执行方式

1. 不要重跑 Sprint 0-4。Gate 3 与 Sprint 4 Gate 已签收。
2. 先处理上面的 Sprint 4 follow-up（如果本轮 Sprint 5 会触碰同一区域），再进入 `Sprint 5: 高级功能`。
3. 每个 Sprint / Phase / Gate 后继续执行 Claude+Codex 对抗式审查、修复非误判项、真实浏览器复测和 Claude+Codex 交叉 review；未实测的平台只能写 blocked / not verified。

---

## Verdict

**CONDITIONAL GO** — 可以交给 Claude Code 的 `ccg:team-exec` 执行，但必须先完成本节的 Baseline Gate 0 只读预检，并严格按本文件的 owner、并行边界、Codex/Gemini 调用方式和每个 Gate 的审查要求推进。任何 Gate 出现 Critical/High、工具不可用、测试不可复现、或真实代码与本计划冲突时，必须暂停并修正计划或代码，不能继续套模板执行。

### Execution Contract for `ccg:team-exec`

在 Claude Code 中从仓库根目录执行：

```text
/ccg:team-exec .claude/team-plan/comprehensive-improvement-plan.md
```

执行器必须遵守：

1. **主编排**：Claude 负责总编排、上下文裁剪、agent teams 调度和 Gate 决策；主 agent 不直接吞下所有上下文，优先把独立读写任务拆给 agent teams。
2. **Codex 路径**：所有非前端设计的代码实现、修复、普通 review、对抗式 review，优先通过 Claude Code 已安装的 `codex-plugin-cc` 直接 slash command 调用：

   ```text
   /codex:rescue --background --fresh <bounded implementation or bug-fix task>
   /codex:review --background --scope working-tree
   /codex:adversarial-review --background --scope working-tree <risk focus>
   /codex:status
   /codex:result
   /codex:cancel
   ```

   不要用 `Skill(codex:review)` / `Skill(codex:adversarial-review)` 调用；不要传 `--model` 或 `--effort`，除非用户另行指定，让 Codex 使用默认模型。独立实现任务用 `--fresh`，同一个 Codex 线程的后续修复才用 `--resume`。长任务默认 `--background`，只有 Gate 需要阻塞收敛时才用 `--wait`。
3. **Gemini 路径**：前端设计方案、UX 取舍、视觉一致性评审优先通过 CCG skills 的 `codeagent-wrapper` 调用 Gemini：

   ```bash
   ~/.claude/bin/codeagent-wrapper --backend gemini "<frontend design/review task>" /Users/yangjunjie/Desktop/upgrade-test
   ```

   如果 Gemini 返回 429 / quota / resource exhausted，记录 `gemini-429-fallback=claude`，由 Claude 扮演前端设计评审角色兜底；不要把 429 当成任务通过。
4. **前端分工**：Gemini 只给设计方案和评审；前端代码实现仍由 Claude agent teams 执行，并由 Codex 做 review / adversarial review。
5. **Codex 并行**：Codex 在安全情况下尽量使用 sub-agents / multi-agents；共享写入文件必须串行，包括 `frontend/package-lock.json`、locale JSON、`frontend/src/api/client.ts`、`backend/app/main.py`、`backend/app/api/agents.py`、`frontend/src/pages/ResultView.tsx` 及其拆分目标。
6. **工具链**：本仓库使用 `npm`，因为 `frontend/package.json` 声明 `packageManager: npm@11.12.1` 且存在 `frontend/package-lock.json`。不得改用 pnpm/yarn。
7. **`.claude/` 事实**：`.claude/` 被 `.gitignore` 忽略，`ccg:team-exec` 必须直接读取本计划路径；不要依赖 git diff 发现该计划文件。
8. **文档更新门**：执行功能任务后不得自动更新 llmdoc/project docs。若需要同步文档，最终决策必须显式给出并等待用户确认：`使用 recorder agent 更新项目文档`。
9. **首轮输出**：Claude Code 执行器开始当前 Sprint 前，必须先输出本计划的 DAG 摘要、每个 Layer 的并行组、共享文件串行点、当前 owner、Gate 0 命令结果和 NO-GO 条件；缺任一项则不得进入写操作。

### Baseline Gate 0: Read-only Baseline Verification

`ccg:team-exec` 开始任何写操作前，必须先运行并记录这些只读命令：

```bash
pwd
sed -n '1,160p' llmdoc/index.md
find llmdoc/overview -maxdepth 1 -type f -name '*.md' -print | sort
git status --short
git check-ignore -v .claude/team-plan/comprehensive-improvement-plan.md || true
node -e "console.log(require('./frontend/package.json').packageManager)"
test -f frontend/package-lock.json
test ! -f pnpm-lock.yaml
test -f backend/Dockerfile
test -f frontend/vite.config.ts
test -f backend/app/main.py
test -f backend/app/api/conversation.py
test -f backend/app/services/ending_room_service/_content.py
```

Baseline Gate 0 通过条件：

- 已读 `llmdoc/index.md` 和 `llmdoc/overview/*.md`，并以当前代码为准。
- 确认 package manager 为 npm，不使用 pnpm/yarn。
- 确认 `.claude/team-plan/comprehensive-improvement-plan.md` 是 ignored local plan，执行器仍能直接读取。
- 确认后端/前端关键文件存在；不存在则先把缺失本身作为 finding，不得臆造。
- 确认当前 dirty worktree，后续只改本计划覆盖的文件，不能回滚用户无关改动。

---

## 当前代码真值校准

- `.claude/` 当前被 `.gitignore:3` 忽略；本计划是本地执行契约，不会自然出现在 git diff 中。
- 前端工具链当前是 npm：`frontend/package.json` 声明 `npm@11.12.1`，且存在 `frontend/package-lock.json`；前端任务不得触碰 root `package-lock.json`，root lockfile 只服务本机 Claude/Codex CLI 依赖。
- `frontend/index.html` 已移除 Google Fonts CDN link；字体当前由 `frontend/src/fonts.css` 与 `frontend/public/fonts/*.woff2` 本地提供，当前字体分片数为 200。S0-3 已完成。
- `backend/Dockerfile` 当前已是多阶段构建；runtime 阶段不再保留编译工具链，并带 import smoke 与 `/` healthcheck。S0-4 已完成。
- 当前已有 root `Makefile`、`backend/app/services/preflight.py`、`backend/app/api/admin.py`、`backend/scripts/preflight.py`；S0-1/S0-5 已完成。
- 当前已有 `@radix-ui/react-alert-dialog` 依赖与 `frontend/src/components/ui/alert-dialog.tsx` 封装；InputView launch confirm 和 Simulation cancel confirm 都已迁移到 shared AlertDialog。S1-3 对应依赖步骤已完成。
- `backend/app/api/conversation.py` 保留单 conversation GET/turn/start/active-cancel；scenario-level conversation list 已在 `backend/app/api/scenarios.py` 落地，路径为 `GET /api/scenario/{id}/conversations`。S2-1 已完成。
- 当前已有用户触发的 simulation cancel 状态/事件；runtime lock-loss 仍保持独立 error/lock-loss 语义，不能和 user cancel 混用。S1-1 已完成。
- 当前已有 `backend/app/api/quota.py` 与 `GET /api/quota/summary`；conversation/replay quota 显示由前端 `QuotaBadge` 消费。S2-3 已完成。
- 当前已有 generated/custom Agent Library 展示、generated edit/delete disabled、5 维 decision_bias 校验与 slider、AgentProfileModal growth metrics 和 ArgumentMap 状态样式。S2-2/S2-4/S2-5 已完成。
- `backend/app/services/causal_graph.py` 的 `append_round_nodes()` 当前已返回 `GraphDelta`；`backend/app/services/kg_realtime.py` 负责合并、限频和过大 payload invalidation；`backend/app/api/ws.py` 已注册 typed `kg:delta` / `kg:snapshot_invalidated` 事件。
- `frontend/src/pages/ResultView.tsx` 当前仍是 orchestrator，但已从 3194 行降到约 1900 行；新增拆分文件位于 `frontend/src/pages/result/`。`ResultContext` 仍偏宽，后续触碰结果页时优先评估 selector / useMemo。
- `HOPsAnimation` 已挂到生产 `ResultView`；不要再按“组件存在但未接线”处理。
- Sprint 4 i18n 第一批只覆盖 `CompareDigestView / InputView / DebateResultView / FactionTimeline` 及相关 25 个 keys；剩余 `isZh` 不要在 Sprint 5 里按旧估算直接批量替换，先刷新真实计数。
- LLM 去模板化主路径已经存在于 debate/oracle/narrator；本计划只继续处理用户可见 fallback、错误态、zh-only 文案和新能力中的可见叙事，不重写 prompt instruction 或 import/query 逻辑。
- 前端已有 Playwright Chromium/Firefox/WebKit 脚本和 legacy browser targets；legacy target 不等于实测通过。当前没有 BrowserStack/Sauce 或 Edge channel 全平台签收；Windows/macOS/Linux + Chrome/Firefox/Safari/Edge 需要按本计划逐 Gate 补足可运行证据。不能用 Vite target 代替浏览器证据，CI 现状也不能代表 Windows/macOS 全签收。

---

## Codex 分析摘要（已按 Sprint 4 当前代码校准）

1. **S0 已完成**：多阶段 Dockerfile、self-hosted fonts、admin setup、preflight CLI 和 root Makefile 已随 `a1a628a` 落地；后续只做回归修复，不再重做 S0。
2. **S1 已完成**：user-initiated cancel token / cancelled terminal state / cancel endpoint / WS event 已落地；lock-loss 仍是独立 error/lock-loss 语义。
3. **S2 已完成**：scenario-level conversation list、quota summary、generated Agent 展示、decision_bias schema/slider、growth metrics 和 argument-map 状态展示已落地。
4. **S3 snapshot 已落地并过 Gate 3**：当前导出 `scenario / branches / agents / messages / causal_graph / manifest / checksums`，导入会重建 scenario、branch、agent、message、graph 主键并 remap FK；导入安全校验已补重复物理 member、member 数、checksum、路径与压缩比防护。跨 OS ZIP 互通仍只能写代码审查结果，不能写 Windows/Linux 实测 PASS。
5. **S4 GraphDelta / KG realtime backend contract 已完成**：append_round_nodes() 返回 `GraphDelta`，coalescer 做 4Hz 合并、payload 上限、串行 flush 和 timeout；后续如果要前端增量消费，单独验 `useScenarioGraph`。
6. **S5 Brier score 需新 journal 模型**：不能直接塞进现有 leaderboard
7. **S6 无 PDF 库**：需新增 pypdf，chunk 入 SQLite+Chroma
8. **去模板化范围修正**：debate/oracle/narrator 主路径已 LLM 化；本计划只处理 fallback 与 zh-only 用户可见文本，不处理 prompt instruction 或 import/query 逻辑
9. **跨平台关注**：SQLite file: URI Windows 兼容、Docker volume bind mount 路径转义、UTF-8+LF 统一

## Gemini 分析摘要（已按 Sprint 4 当前代码校准）

1. **S0 已完成**：Setup Wizard 使用 provider preset card 与连接测试状态；self-hosted fonts 已替换 Google Fonts CDN。
2. **S1 已完成**：AlertDialog、Reader/Workbench、cancel confirm 和 onboarding carousel 已落地。
3. **S3 前端当前状态**：CounterfactualBrand、ReACTReasoningPanel、ShareModal 预测卡片、snapshot import/export dialog、PersonalityDriftWarning 和 HOPsAnimation 都已接线。
4. **S4**：ResultView 已按当前实现拆到小写 `frontend/src/pages/result/`；第一批 isZh 已覆盖 CompareDigestView / InputView / DebateResultView / FactionTimeline；Phaser reduced-motion 已覆盖 EndingScene / TitleScene / WorldScene 的本轮触碰路径。
5. **S5**：3 列 bento-box journal 布局，SVG 校准曲线
6. **跨浏览器**：补 raw OKLCH 的 sRGB / `@supports` fallback；验证现有服务端 heartbeat consume/reconnect 行为，而不是新增 client keepalive；Firefox 重点检查 `min-width:0` 与 overflow
7. **性能**：html2canvas ~200KB 动态 import，IntersectionObserver 延迟 Phaser 初始化
8. **A11y**：sr-only list 镜像图谱节点，Radix Dialog.Portal focus trap

---

## 技术方案

### 架构决策

| 决策 | 方案 | 理由 |
|------|------|------|
| Cancel state machine | 保留 `_running_simulations: set[str]` 防重入；新增 `_cancel_registry: dict[str, SimulationCancelToken]` + task registry | user cancel 与 runtime lock-loss 是不同终态，不能复用 error 路径 |
| KG 实时推送 | `kg:delta` WS 事件 + `GraphDelta(added, updated, deleted, version, snapshot_invalidated)` + REST snapshot fallback | append 会更新/删除旧节点，客户端不能只处理 added |
| ResultView 拆分 | Context Provider + 小写 `components/result/` 子组件 | 共享状态通过 Context，局部状态封装，避免 macOS/Linux 大小写漂移 |
| isZh 迁移 | AST codemod + 手工校验 | jscodeshift transform 批量处理 |
| 字体本地化 | 子集化 woff2 + @font-face | 消除 CDN 依赖，支持离线/内网 |
| Docker 优化 | builder + runtime 双阶段 | runtime 不含 gcc/g++，镜像 ~400MB |
| Snapshot 导出 | ZIP(manifest.json + *.json + checksums.sha256) | 自包含可移植 |
| Journal | 新 SQLModel 表 + Brier score 计算 | 与 leaderboard 分离 |
| 人格漂移 | deterministic score + LLM adjudication | 先 warning 不 hard gate |
| PDF 解析 | pypdf (低依赖) + pdfminer.six fallback | 限页/限字节/隔离注入 |
| 新 router | 新建 `admin.py` / `quota.py` / `journal.py` 必须同步改 `backend/app/main.py` + route smoke test | FastAPI 只导入文件不会自动挂载路由 |

### 去模板化范围（修正版）

```
Oracle / Ending Room fallback → generation-first LLM
  ↓ empty / invalid
  → LLM rewrite of static anchor
    ↓ empty / boilerplate-only
    → plain-text LLM retry
      ↓ failed
      → deterministic/static i18n fallback

Narrator fallback → existing LLM text generation + stream-first JSON extraction
  ↓ failed
  → deterministic fallback

Debate turn fallback → existing plain-text LLM retry path
  ↓ failed
  → anchor fallback

前端 UI 文案 → t('key') / locale JSON
```

- **不纳入 LLM 去模板化**：
  - `backend/app/services/memory.py:124-202`：这是发给 LLM 的 prompt/context 文案，不是直接 UI/API 输出；会影响 LLM 输出，但不能把它当成用户可见模板去 LLM 生成，否则会形成递归。
  - `backend/app/api/scenarios.py:810-873` 与 `1085-1104`：只是 import/query 逻辑，不是模板热点。
  - `backend/app/services/web_context.py`：搜索增强和 `[REAL_WORLD_CONTEXT]` prompt block，不是直接用户可见模板。
  - `backend/app/config.py`：配置校验/错误边界，不是叙事生成 surface。
- **必须纳入 i18n bug 修复**：
  - `backend/app/services/simulator.py:1263-1271`, `1513-1516`, `1925-1930`：zh-only 用户可见文本，修为 i18n/static fallback，不用 LLM 生成。
  - `frontend/src/components/AppErrorBoundary.tsx`：当前 zh-only。
  - `frontend/src/components/QuickStartCards.tsx`：10+ hardcoded zh questions。
  - `frontend/src/game/scenes/*.ts`：Phaser 场景内用户可见文本。
- **已有 LLM 主路径**：debate / oracle / narrator 主路径不重做，只检查 fallback、错误态和静态兜底。不要把 Oracle-style generation→rewrite 链机械套到 debate/narrator：debate turn 当前是 plain-text LLM retry，不是 `{content}` JSON 提取；narrator 已有 LLM 文本生成 + stream-first JSON extraction。
- **Oracle/Ending Room 回归要求**：generation empty 且 JSON rewrite empty/boilerplate-only 时，必须继续 plain-text retry；plain-text retry 失败后才允许返回 anchor fallback。新增或更新 `backend/tests/test_ending_room_service.py` 覆盖该路径。

---

## 子任务列表

### Sprint 0: 部署体验 (Week 1-2)

**状态**: 已完成并提交于 `a1a628a`；本节保留历史任务拆分，不作为下次待办入口。

#### Layer 0A (并行 — 3 个独立任务)

##### Task S0-3: Google Fonts 本地化
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **文件范围**:
  - `frontend/index.html` (移除 CDN link)
  - `frontend/public/fonts/` (新建目录，放置 woff2)
  - `frontend/src/index.css` (新增 @font-face)
- **依赖**: 无
- **实施步骤**:
  1. 下载 4 字体族子集化 woff2：Cormorant Garamond (ital+roman 300-700)、Instrument Sans (ital+roman 400-700)、Noto Sans SC (400-700)、Noto Serif SC (300-700)
  2. 记录字体来源、license 和生成命令；不得提交来历不明或无法复现的 font binary
  3. 放入 `frontend/public/fonts/`，按 `{family}-{weight}.woff2` 命名
  4. `index.css` 顶部添加 `@font-face` 声明，`font-display: swap`
  5. `index.html` 移除 3 行 Google Fonts `<link>` (preconnect × 2 + css2)
  6. 跨浏览器验证：Chromium/Chrome channel where available + Firefox + WebKit 字体渲染一致性；Safari/Edge 只在本机或远端浏览器可用时声明 PASS
  7. 跨平台验证：Windows ClearType / macOS 抗锯齿 / Linux FreeType 差异
- **验收标准**: 断网后字体正常渲染；无 CDN 请求；4 浏览器字体一致

##### Task S0-4: 后端多阶段 Dockerfile
- **类型**: 后端 (Codex 实现)
- **文件范围**:
  - `backend/Dockerfile`
  - `.dockerignore` (如需更新)
- **依赖**: 无
- **实施步骤**:
  1. 拆为 builder stage (python:3.13-slim + gcc/g++) + runtime stage (python:3.13-slim)
  2. builder: `pip install --no-cache-dir .`，编译 chromadb/uvloop/httptools wheels
  3. runtime: 只 COPY `--from=builder /usr/local/lib/python3.13/site-packages` + `/usr/local/bin` + app source
  4. 移除 runtime 中 gcc/g++/build-essential
  5. 确保 `docker compose build && docker compose up` 验证通过
  6. Linux/macOS/Windows Docker Desktop 验证
- **验收标准**: 镜像 < 500MB；`docker compose up` 启动成功；healthcheck 通过

##### Task S0-6: 安全提示
- **类型**: 前端 (Claude 实现)
- **文件范围**:
  - `frontend/src/pages/InputView.tsx` (底部安全提示)
  - `frontend/src/i18n/locales/en.json` (+1 key)
  - `frontend/src/i18n/locales/zh.json` (+1 key)
- **依赖**: 无
- **实施步骤**:
  1. InputView 底部添加小字安全提示 (`<p className="iv-security-notice">`)
  2. i18n key: `home.security_notice`
  3. 移动端验证不被截断
- **验收标准**: 首页底部可见安全提示；中英文切换正确

#### Layer 0B (串行子链 — S0-5 依赖 S0-1 后端)

##### Task S0-1: 设置向导页面
- **类型**: 全栈 (Gemini 设计 → Claude 前端 → Codex 后端)
- **文件范围**:
  - `frontend/src/pages/SetupWizardView.tsx` (新建)
  - `frontend/src/pages/SetupWizardView.css` (新建)
  - `frontend/src/components/Setup/ProviderPresetCard.tsx` (新建)
  - `frontend/src/components/Setup/ConnectionTester.tsx` (新建)
  - `frontend/src/App.tsx` (添加 /admin/setup 路由)
  - `frontend/src/lib/llmProviderPolicy.ts` (新增供应商预设数据)
  - `backend/app/services/preflight.py` (新建 — preflight 检查服务)
  - `backend/app/api/admin.py` (新建 — /api/admin/preflight 端点)
  - `backend/app/main.py` (挂载 admin router)
  - `backend/tests/test_admin_routes.py` (新增 route reachability smoke)
  - `frontend/src/i18n/locales/en.json` (+setup.* keys)
  - `frontend/src/i18n/locales/zh.json` (+setup.* keys)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** 新建 `preflight.py`：`PreflightCheckResult` dataclass + `run_preflight()` 异步函数，检查 SQLite/Chroma/LLM/WebSearch/CORS/volume 写入
  2. **[BE-Codex]** 新建 `admin.py` router: `GET /api/admin/preflight` 返回检查结果 + `POST /api/admin/test-llm` 连通性测试
  3. **[BE-Codex]** `main.py` import + `app.include_router(admin_router)`，新增 smoke test 证明 `/api/admin/preflight` 可达
  4. **[FE-Gemini→Claude]** SetupWizardView: 3 步向导（供应商选择 → API key 填写 → 连接测试）
  5. **[FE]** ProviderPresetCard: CSS Grid 卡片（OpenAI/Anthropic/DeepSeek/Ollama/LM Studio/自定义），带 logo + base_url 自动填充
  6. **[FE]** ConnectionTester: 调用 `/api/admin/test-llm`，状态点（灰→黄→绿/红）
  7. **[FE]** App.tsx 添加 lazy route `/admin/setup`
  8. **[FE]** InputView 检测无有效 LLM 配置时，顶部横幅链接到 `/admin/setup`
  9. **[i18n]** 向导文案按供应商使用 locale key + 参数插值，前端不调用 LLM 生成 UI 文案
- **验收标准**: 首次启动无 LLM 配置时自动引导；供应商选择→填写→测试全流程；mobile 375px + desktop 1440px 响应式

##### Task S0-5: Docker preflight 检查
- **类型**: 后端 (Codex 实现)
- **文件范围**:
  - `backend/scripts/preflight.py` (新建 CLI)
  - `Makefile` (新建 root Makefile，并添加 preflight target；当前仓库根目录无 Makefile)
- **依赖**: S0-1 (复用 preflight.py service)
- **实施步骤**:
  1. 新建 `scripts/preflight.py` CLI 入口，调用 `preflight.py` service
  2. 检查：端口占用(18927/18928)、磁盘空间(>500MB)、volume 权限、LLM 连通性
  3. Canonical 入口必须是 `python backend/scripts/preflight.py`；root `Makefile` 只做便利包装，Windows 不要求安装 make
  4. Makefile 添加 `make preflight` target，内部调用 canonical Python CLI
  5. 跨平台端口检测：Linux 优先 `ss`，macOS 优先 `lsof`，Windows 优先 PowerShell `Get-NetTCPConnection`；三者都不可用时 fallback 到 Python `socket.bind` 探测
  6. Docker 内可读取 `/proc/net/tcp` 时使用它；不可读取时回退 Python socket 探测
- **验收标准**: `python backend/scripts/preflight.py` 和 `make preflight` 均输出 PASS/WARN/FAIL 清单；Windows/macOS/Linux 与 Docker 内外均可运行

##### Task S0-2: 供应商预设卡片 (包含在 S0-1)
- **说明**: 已合并入 S0-1 的 ProviderPresetCard 组件

#### Sprint 0 Gate: Review + Test
- **Codex adversarial review**: Docker 安全、preflight 完整性、路由权限
- **Playwright 测试**: `/admin/setup` 全流程、字体离线渲染、Docker `docker compose up`
- **跨平台**: Windows Docker Desktop + macOS + Linux 验证
- **通过标准**: 0 Critical / 0 High；全部 Playwright 用例 PASS

---

### Sprint 1: 基础体验修复 (Week 2-4)

**状态**: 已完成并提交于 `a1a628a`；本节保留历史任务拆分，不作为下次待办入口。

#### Layer 1A (依赖预备 + 并行 — 4 个任务)

##### Task S1-1: 模拟取消 (全栈)
- **类型**: 全栈 (Codex 后端 → Claude 前端)
- **文件范围**:
  - `backend/app/services/simulation_cancel.py` (新建)
  - `backend/app/services/simulator.py` (主循环 + LLM 调用注入 cancel check)
  - `backend/app/api/helpers.py` (保留 `_running_simulations: set[str]`；新增 task/cancel registry 接线)
  - `backend/app/api/scenarios.py` (新增 POST /api/scenario/{id}/cancel)
  - `backend/app/api/ws.py` (新增 simulation_cancelled 事件类型)
  - `frontend/src/hooks/useSimulationWS.ts` (处理 simulation_cancelled，不重连)
  - `frontend/src/stores/simulationStore.ts` (cancelled 状态)
  - `frontend/src/pages/SimulationView.tsx` (cancel 按钮 + 确认 Dialog)
  - `frontend/src/i18n/locales/en.json` (+simulation.cancel_* keys)
  - `frontend/src/i18n/locales/zh.json` (+simulation.cancel_* keys)
  - `frontend/src/types.ts` (Scenario.status + WSEvent union 新增 cancelled/cancel 事件)
- **依赖**: S1-3 的 AlertDialog dependency step（`frontend/package.json` / lockfile 只由 S1-3 修改一次）
- **实施步骤**:
  1. **[BE-Codex]** 新建 `simulation_cancel.py`:
     - `SimulationCancelToken(scenario_id, event: asyncio.Event, reason)`
     - `_cancel_registry: dict[str, SimulationCancelToken]`
     - `get_cancel_token()`, `request_cancel()`, `clear_cancel_token()`
  2. **[BE-Codex]** `helpers.py`: 不把 `_running_simulations` 直接改成单一 task dict；保留 set 作为运行防重入 truth，另建 `dict[str, asyncio.Task]` task registry 仅用于 `Task.cancel()`
  3. **[BE-Codex]** cancel propagation 覆盖所有 async path：round loop、branch loop、`_gather_agent_messages()`、LLM fan-out task、narration、graph append (`asyncio.to_thread`) 前后、checkpoint 前后
  4. **[BE-Codex]** 对正在等待的 LLM/narration child task 调用 `asyncio.Task.cancel()`；对 `asyncio.to_thread` 不假设能中断线程，只在提交前和返回后做 token/terminal guard，禁止取消后落库或广播 stale graph/checkpoint
  5. **[BE-Codex]** `scenarios.py`: `POST /api/scenario/{id}/cancel` 端点，调用 `request_cancel()` 并触发独立 terminal event
  6. **[BE-Codex]** `Scenario.status` 后端/前端契约新增 `"cancelled"`，user cancel 终态写入 `cancelled`；runtime lock-loss 继续是独立 lock-loss/error 语义，不能复用 cancel
  7. **[BE-Codex]** `ws.py`: 广播 `{"type": "simulation_cancelled", "reason": "user_cancelled"}`，不同于 lock-loss/error 事件
  8. **[FE-Claude]** `frontend/src/types.ts`: `Scenario.status` union 与 `WSEvent` union 增加 cancelled/cancel event
  9. **[FE-Claude]** `useSimulationWS.ts`: 处理 `simulation_cancelled` 后关闭连接并 suppress reconnect；不要把 cancelled 当 1006 异常重连
  10. **[FE-Claude]** `simulationStore.ts`: status enum/action 新增 `cancelled`，reconnect/resync 时不把 cancelled 回退成 error/simulating
  11. **[FE-Claude]** `SimulationView.tsx`: 红色 cancel 按钮 + Radix AlertDialog 双确认
  12. **[FE-Claude]** i18n；AlertDialog 依赖由 S1-3 统一添加，避免 package lock 并行冲突
- **验收标准**: 推演中点击取消→确认→所有后台 child task 停止或被 terminal guard 屏蔽→状态显示已取消；WS 不重连；lock-loss 仍走独立 error/lock-loss 终态；可重新开始新推演

##### Task S1-3: 5 个 Critical Bug 修复
- **类型**: 前端 (Claude 实现)
- **文件范围**:
  - `frontend/src/pages/InputView.tsx` (C1 confirm→Radix AlertDialog)
  - `frontend/package.json` / `frontend/package-lock.json` (新增 `@radix-ui/react-alert-dialog`)
  - `frontend/src/api/client.ts` (C2 ordinary JSON REST fetch audit + client migration)
  - `frontend/src/components/` (C4 aria-label 缺失组件)
  - `frontend/src/components/EndingChatModal.tsx` (H1 焦点陷阱)
  - `frontend/src/lib/` (H5 surrogate-pair 截断修复)
- **依赖**: 无
- **实施步骤**:
  1. **C1**: 先新增 `@radix-ui/react-alert-dialog` 依赖；只新增 AlertDialog，Dialog/Sheet/ToggleGroup/Slider 复用现有 `frontend/src/components/ui/*` 封装。InputView 当前是自定义 `<div className="confirm-launch">`，不是 `window.confirm()`，迁移为 Radix AlertDialog
  2. **C2**: 排查 production 代码中绕过 `client.ts` 的普通 JSON REST fetch；迁移可共享端点的错误处理/token 注入。保留必须使用 AbortController、streaming/SSE、专用 cleanup、或局部 graph loader 的 fetch，但补齐脱敏错误处理、session headers、abort guard 和测试
  3. **C2 allowlist**: 迁移候选包括 AgentWorkshop/CausalReview/Replay 等普通 JSON REST；保留或单独封装 useRoundtableSseStream / useNodeConversationTransport 等 streaming/SSE fetch。提交时必须附 direct-fetch allowlist
  4. **C4**: 扫描所有交互元素缺失 aria-label，补齐
  5. **H1**: focus trap 覆盖 InputView confirm dialog、InputView identity-continuity dialog、EndingChatModal 顶层 dialog、WorldlineRoundtable mobile roster dialog；EndingChatModal 使用 Radix Dialog.Portal 或等价 focus trap 确保正确挂载
  6. **H5**: 只修用户可见字符串截断；新增 `truncateCodepoints` helper 并用 `Array.from()` 处理 surrogate pair。不得机械改数组切片、hex/UUID/token、测试 fixture、非用户可见 parser 逻辑
  7. 跨浏览器验证每个修复
- **验收标准**: 5 个 bug 全部修复；无回归；Playwright keyboard/focus assertions PASS；axe/Lighthouse snapshot 或等价手工 a11y checklist 0 new critical violations；direct-fetch allowlist 已记录

##### Task S1-4: Reader/Workbench 模式切换
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **文件范围**:
  - `frontend/src/pages/ResultView.tsx` (顶部 toggle + 条件渲染)
  - `frontend/src/pages/ResultView.css` (模式切换样式)
  - `frontend/src/stores/uiPreferencesStore.ts` (新建 — localStorage 持久化)
  - `frontend/src/i18n/locales/en.json` (+result.mode_* keys)
  - `frontend/src/i18n/locales/zh.json` (+result.mode_* keys)
- **依赖**: 无
- **实施步骤**:
  1. **[FE-Gemini]** 设计 Reader/Workbench 两种模式布局方案
  2. **[FE-Claude]** 新建 `uiPreferencesStore.ts`: `resultViewMode: 'reader' | 'workbench'`，localStorage 持久化
  3. **[FE-Claude]** ResultView 顶部 Radix ToggleGroup 切换
  4. **[FE-Claude]** Reader 模式隐藏：图谱/工作台入口/HookSummary/Phase3 集成/AgentRoster
  5. **[FE-Claude]** Reader 模式突出：摘要 + 世界线 + 预测
  6. 模式切换引导文案使用 i18n key + 参数插值；前端 UI 不调用 LLM 生成 copy
- **验收标准**: toggle 切换 Reader↔Workbench；Reader 默认；localStorage 持久化；mobile 响应式

##### Task S1-5: 首次玩法引导
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **文件范围**:
  - `frontend/src/components/Onboarding/OnboardingGuide.tsx` (新建)
  - `frontend/src/components/Onboarding/OnboardingGuide.css` (新建)
  - `frontend/src/hooks/useOnboardingState.ts` (新建 — localStorage gate)
  - `frontend/src/i18n/locales/en.json` (+onboarding.* keys)
  - `frontend/src/i18n/locales/zh.json` (+onboarding.* keys)
- **依赖**: 无
- **实施步骤**:
  1. **[FE-Gemini]** 设计 5 步引导内容（4 种玩法 + 高级功能概览）
  2. **[FE-Claude]** Radix Dialog modal carousel，dot indicators，skip/next/done
  3. **[FE-Claude]** `useOnboardingState`: `localStorage.getItem('onboarding_completed')` gate
  4. **[FE-Claude]** 检测 feature flags 动态裁剪步骤（如 FEATURE_CUSTOM_AGENTS=false 则跳过 Agent 工坊步骤）
  5. 引导文案根据 feature flags 选择 i18n key；前端 UI 不调用 LLM 生成 copy
  6. prefers-reduced-motion guard 入场动画
- **验收标准**: 首次访问弹出引导；完成后不再弹出；可手动从设置重新触发

#### Sprint 1 Gate: Review + Test
- **Codex adversarial review**: cancel token 竞态、user cancel vs lock-loss 终态分离、WS 事件序列、bug 修复回归
- **Playwright 测试**: cancel 全流程、5 bug 复现→修复验证、Reader/Workbench 切换、引导全流程
- **跨浏览器**: Chromium/Chrome + Firefox + WebKit cancel 按钮 + 引导 Dialog；Safari/Edge 需本机/远端可用性证据或明确 blocked reason
- **通过标准**: 0 Critical / 0 High；backend 测试 0 failed；frontend 测试 0 failed

---

### Sprint 2: 差距弥合 (Week 4-7)

**状态**: 已完成并提交于 `a1a628a`；本节保留历史任务拆分，不作为下次待办入口。

#### Layer 2A (Round A 并行 + Round B 串行配额)

##### Task S2-1: 对话线程重加载
- **类型**: 全栈 (Codex 后端 → Claude 前端)
- **文件范围**:
  - `backend/app/api/scenarios.py` (新增 GET /api/scenario/{id}/conversations 列表端点，走 `/api/scenario` prefix)
  - `backend/app/api/conversation.py` (复用现有 `/api/conversation/{thread_id}` 单线程读取，不新增 scenario prefix 路由)
  - `frontend/src/components/EndingChatModal.tsx` (thread reload UI)
  - `frontend/src/pages/RoundtableAgentChat.tsx` (thread reload UI)
  - `frontend/src/components/kg/NodeConversationSheet.tsx` (thread reload UI)
  - `frontend/src/api/client.ts` (新增 getConversations, getConversation API)
- **依赖**: 无；S2-3 依赖本任务完成后再改 `client.ts`
- **实施步骤**:
  1. **[BE-Codex]** 在 `scenarios.py` 新增 `GET /api/scenario/{id}/conversations` 列表端点（分页 + 排序），不要放进 `conversation.py`，因为该 router prefix 是 `/api/conversation`
  2. **[BE-Codex]** endpoint 必须 gated by `FEATURE_AGENT_CONVERSATION`，并沿用 scenario/session ownership 校验
  3. **[FE-Claude]** `client.ts` 新增 `getScenarioConversations(scenarioId, cursor)` 与 `getConversation(threadId)`；单线程读取路径必须是 `/api/conversation/{thread_id}`，不是裸 `/conversation/{thread_id}`
  4. **[FE-Claude]** 3 个消费组件添加 "加载历史对话" 按钮
  5. **[FE-Claude]** 虚拟化列表 + skeleton 加载态
- **验收标准**: 刷新页面后对话历史可重载；3 个组件统一体验

##### Task S2-2: 生成型 Agent 展示
- **类型**: 前端 (Claude 实现)
- **文件范围**:
  - `frontend/src/pages/AgentLibrary.tsx` (放开 kind 过滤 + 生成型分组)
  - `frontend/src/i18n/locales/en.json` (+agent_library.generated_* keys)
  - `frontend/src/i18n/locales/zh.json` (+agent_library.generated_* keys)
- **依赖**: 无
- **实施步骤**:
  1. AgentLibrary 放开 kind 过滤，显示 generated agents
  2. 新增 "系统生成" 分组标题 + kind badge
  3. 生成型 Agent 禁用编辑/删除按钮（disabled + tooltip 说明）
- **验收标准**: 生成型 Agent 可见；不可编辑/删除；badge 显示

##### Task S2-3: 对话配额 + 重播余量显示
- **类型**: 全栈 (Codex → Claude)
- **文件范围**:
  - `backend/app/api/quota.py` (新建 router，prefix `/api/quota`，新增 GET /summary)
  - `backend/app/main.py` (挂载 quota router)
  - `backend/app/api/graphs.py` (读取 `MAX_REPLAY_BRANCHES=3` / replay branch limit source)
  - `backend/tests/test_quota_routes.py` (新增 route reachability + aggregation smoke)
  - `frontend/src/components/shared/QuotaBadge.tsx` (新建)
  - `frontend/src/pages/ResultView.tsx` (集成 QuotaBadge)
  - `frontend/src/api/client.ts` (新增 quota API；必须在 S2-1 之后串行修改)
- **依赖**: S2-1 (`client.ts` 串行，避免同文件并行冲突)
- **实施步骤**:
  1. **[BE-Codex]** 新建 `quota.py` router: `GET /api/quota/summary`，不要放进 `conversation.py`（否则会变成 `/api/conversation/...`）
  2. **[BE-Codex]** `main.py` import + `app.include_router(quota_router)`，新增 route reachability smoke
  3. **[BE-Codex]** summary 聚合 conversation quota ledger 与 replay branch count；`replay_branch_remaining = MAX_REPLAY_BRANCHES - current_replay_branch_count`，其中 `MAX_REPLAY_BRANCHES` 当前来自 `graphs.py:48`，值为 3
  4. **[FE-Claude]** QuotaBadge: 圆形 pill "剩余 N 次" + tooltip 详情
  5. **[FE-Claude]** 集成到 ResultView header 区域
- **验收标准**: 配额正确显示；0 配额时 disabled 状态 + 提示

##### Task S2-4: decision_bias 编辑器
- **类型**: 全栈 (Codex → Gemini 设计 → Claude 实现)
- **文件范围**:
  - `backend/app/services/persona_workshop.py` (新增 decision_bias schema 校验)
  - `backend/app/api/agents.py` (PATCH 端点支持 decision_bias)
  - `frontend/src/pages/AgentWorkshopView.tsx` (集成 slider 编辑器)
  - `frontend/src/components/Controls/DecisionBiasSlider.tsx` (新建)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** persona_workshop: 校验 5 键 decision_bias schema（caution/optimism/conservatism/risk_tolerance/creativity，0-1 范围）
  2. **[FE-Gemini]** 设计 slider UX（色彩渐变反馈：cool blue → warm amber）
  3. **[FE-Claude]** DecisionBiasSlider: 5 个 Radix Slider + 实时预览
  4. **[FE-Claude]** AgentWorkshopView 集成
- **验收标准**: 5 个 slider 可调；值正确保存到后端；视觉反馈

##### Task S2-5: 成长指标 + 论证图谱状态
- **类型**: 前端 (Claude 实现)
- **文件范围**:
  - `frontend/src/components/AgentProfileModal.tsx` (metrics_json 渲染)
  - `frontend/src/components/ArgumentMap.tsx` (standing/rebutted 视觉状态)
  - `frontend/src/components/ArgumentMap.css` (新增状态样式)
- **依赖**: 无
- **实施步骤**:
  1. AgentProfileModal: 渲染 metrics_json（场景参与数/立场偏移次数/成长事件）
  2. 成长指标描述使用 i18n 模板 + 参数插值（"这个 Agent 在 {{count}} 个场景中立场偏移了 {{shifts}} 次"），前端不调用 LLM 生成 copy
  3. ArgumentMap: standing 节点绿色边框 + rebutted 节点红色删除线 + tooltip
- **验收标准**: 成长指标可读；ArgumentMap 状态可区分

#### Sprint 2 Gate: Review + Test
- **Codex adversarial review**: 配额防绕过、对话权限校验、bias schema 校验
- **Playwright 测试**: 对话重载、Agent 展示、quota badge、bias slider
- **通过标准**: 0 Critical / 0 High

---

### Sprint 3: 核心体验增强 (Week 7-10)

**状态**: 已完成并过 Gate 3。S3-1 / S3-2 / S3-3 / S3-4 / S3-5 / S3-6 都已接线。

#### Layer 3A (并行 — 3 个独立任务)

##### Task S3-1: "时钟倒拨"品牌化
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **当前状态**: 已接线到 `ResultView`；`CounterfactualPanel` 已支持 `initialRound`，点击 fork point 会同步轮次。
- **文件范围**:
  - `frontend/src/pages/ResultView.tsx` (counterfactual 入口区域)
  - `frontend/src/components/CounterfactualPanel.tsx` (先评估现有入口，不重复造一套 counterfactual UI)
  - `frontend/src/components/result/CounterfactualBrand.tsx` (新建)
  - `frontend/src/components/result/CounterfactualBrand.css` (新建)
- **依赖**: 无
- **实施步骤**:
  1. **[FE-Gemini]** 设计品牌化卡片："如果在第 N 轮做不同选择？"
  2. **[FE-Claude]** GSAP timeline sepia/glitch 过渡效果 + prefers-reduced-motion guard
  3. 分叉描述只消费后端已生成的 branch/counterfactual narrative；前端不新增 LLM copy 生成
  4. 分叉对比卡片导出（复用 html2canvas）
- **验收标准**: 醒目入口；动画流畅；mobile 适配

##### Task S3-2: ReACT 推理透明化
- **类型**: 前端 (Claude 实现)
- **当前状态**: 已接线到 `AnalystStreamView`；共享 `ReACTReasoningPanel` 会展示工具类型、参数、结果摘要、最终回答和停止原因。
- **文件范围**:
  - `frontend/src/pages/AnalystStreamView.tsx` (Analyst stream 增强；`PostVerdictStreams.tsx` 不存在)
  - `frontend/src/pages/SurveyStreamView.tsx` (如需展示 survey source/tool chip，复用同一展示规则)
  - `frontend/src/components/ReACTReasoningPanel.tsx` (新建)
  - `frontend/src/components/ReACTReasoningPanel.css` (新建)
- **依赖**: 无
- **实施步骤**:
  1. AnalystStreamView 展示完整推理链：工具调用参数 + 迭代轮次 + 证据来源
  2. 品牌色图标："因果探针"(causal) / "记忆考古"(memory) / "全景扫描"(web)
  3. 工具结果摘要只展示后端 stream payload 中已有 summary/source/tool 字段；前端不新增 LLM 生成层
- **验收标准**: 推理过程完全可见；工具图标可区分

##### Task S3-5: 可分享预测卡片
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **当前状态**: 已扩展 `ShareModal`；预测卡片支持 PNG 下载，图片剪贴板按钮按浏览器能力探测显示，社交文案请求支持 abort。
- **文件范围**:
  - `frontend/src/components/ShareArtifact.tsx` (已有 1200×630 PNG 导出基础设施，优先复用)
  - `frontend/src/components/ShareModal.tsx` (已有分享入口，先评估是否扩展)
  - `frontend/src/hooks/screenCaptureHtmlVendor.ts` (已有 html2canvas 动态 import 封装)
  - `frontend/src/components/result/ShareablePredictionCard.tsx` (新建)
  - `frontend/src/components/result/ShareablePredictionCard.css` (新建)
  - `frontend/src/lib/cardExport.ts` (只有在复用现有封装仍无法表达预测卡导出时才新建)
- **依赖**: 无
- **实施步骤**:
  1. **[FE-Gemini]** 设计 1200×630 预测卡布局（问题 + 概率 + 关键洞察 + QR/链接）
  2. **[FE-Claude]** 复用现有 html2canvas dependency 和动态 import；不要重复新增依赖或第二套导出 runtime
  3. **[FE-Claude]** 导出为 PNG + 复制到剪贴板
  4. 高对比文本确保导出可读
  5. 跨浏览器 html2canvas 兼容性验证
- **验收标准**: 卡片可导出 PNG；文字可读；mobile 可用

#### Layer 3B (依赖 Layer 3A 无，但相对独立)

##### Task S3-3: 人格忠诚度门控
- **类型**: 全栈 (Codex 后端 → Claude 前端)
- **当前状态**: 已接线。后端 deterministic Big Five drift endpoint 受 `FEATURE_AGENT_IDENTITY` gate 保护；前端 warning 只展示 medium/high，不阻断 verdict。
- **文件范围**:
  - `backend/app/services/personality_drift.py` (新建)
  - `backend/app/api/graphs.py` (新增 drift 检测端点)
  - `frontend/src/components/PersonalityDriftWarning.tsx` (新建)
  - `frontend/src/pages/WorldlineRoundtableView.tsx` (集成 warning)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** `personality_drift.py`: Big Five 维度漂移检测（基于 AgentIdentity 成长事件 + AgentStateFrame）
  2. **[BE-Codex]** 当前只做 deterministic score；不新增 LLM adjudication，也不把漂移当 hard gate
  3. **[BE-Codex]** 新增 `GET /api/scenario/{id}/personality-drift` 端点
  4. **[FE-Claude]** PersonalityDriftWarning: verdict 前展示漂移警告（⚠️ 图标 + 漂移维度 + 幅度）
  5. 阈值先 warning 不 hard gate
- **验收标准**: 漂移检测可工作；warning 显示正确；不阻断 verdict

##### Task S3-6: 自包含快照导出
- **类型**: 全栈 (Codex 后端 → Claude 前端)
- **当前状态**: 已接线。后端 endpoint 受 `FEATURE_SNAPSHOT_EXPORT` gate 保护；前端首页导入、结果页导出和 dialog 流程已接入。
- **文件范围**:
  - `backend/app/services/snapshot_export.py` (新建)
  - `backend/app/api/scenarios.py` (新增 GET /api/scenario/{id}/snapshot；扩展现有 import-replay/import-snapshot 路径)
  - `backend/app/models/graph.py` (读取现有 GraphSnapshot/GraphNode/GraphEdge)
  - `backend/app/services/causal_graph.py` (本轮未改；snapshot export/import 消费已持久化图)
  - `frontend/src/components/Export/SnapshotExportWizard.tsx` (新建)
  - `frontend/src/components/Export/SnapshotImportDialog.tsx` (新建)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** `snapshot_export.py`:
     - `build_snapshot_manifest()`: scenario + branches + agents + causal_graph + `manifest.json`
     - `iter_snapshot_files()`: 生成 ZIP 内文件流
     - ZIP 含 `manifest.json` + `scenario.json` + `branches.jsonl` + `agents.jsonl` + `messages.jsonl` + `causal_graph.json` + `checksums.sha256`
  2. **[BE-Codex]** 图谱必须导出/import `GraphSnapshot` / `GraphNode` / `GraphEdge`；当前 import-replay 不会导入这些表，不能只导 scenario/branch/message
  3. **[BE-Codex]** export 会保留已有 graph node 的 `ref_model / ref_id`，manifest 记录 graph schema version；本轮没有改 `build_snapshot()`
  4. **[BE-Codex]** import 时执行 Graph old-id → new-id remap，重建 edge FK (`source_node_id` / `target_node_id` / snapshot FK)，并校验孤边/跨 snapshot edge
  5. **[BE-Codex]** privacy model：export 默认 redact BYOK `base_url`、`user_id`、`web_search_api_key`、session/token 类字段；只有显式私有导出才包含允许字段
  6. **[BE-Codex]** checksum schema：manifest 声明每个 payload 文件 sha256 + size；导入前逐项验证，失败即拒绝
  7. **[BE-Codex]** `GET /api/scenario/{id}/snapshot` 端点：StreamingResponse ZIP
  8. **[BE-Codex]** `POST /api/scenario/import-snapshot` 端点：解析 ZIP + 创建 scenario + graph remap
  9. **[FE-Claude]** SnapshotExportWizard: 选择导出范围（默认不含私有数据） + 进度
  10. **[FE-Claude]** SnapshotImportDialog: 拖拽上传 ZIP + 预览 manifest + 确认导入
  11. 跨平台：UTF-8+LF 统一；Windows 路径转义
- **验收标准**: 导出 ZIP 可在另一实例导入；manifest 校验通过；checksums 匹配

##### Task S3-4: HOPs 动画分支循环
- **类型**: 前端 (Gemini 设计 → Claude 实现)
- **当前状态**: 已完成。`HOPsAnimation` 已挂到 `ResultView`，多分支结果页可见；replay 模式下不播放。
- **文件范围**:
  - `frontend/src/components/result/HOPsAnimation.tsx` (新建)
  - `frontend/src/components/result/HOPsAnimation.css` (新建)
- **依赖**: 无
- **实施步骤**:
  1. **[FE-Gemini]** 设计 HOPs 可视化方案（SVG 路径 + CSS animation 循环）
  2. **[FE-Claude]** 实现分支概率循环动画
  3. prefers-reduced-motion: 静态显示所有分支叠加
  4. mobile: 简化为条形图替代
- **验收标准**: 动画流畅 60fps；reduced-motion 降级；mobile 适配

#### Sprint 3 Gate: Review + Test
- **当前状态**: 已签收。Gate 3 已覆盖 HOPs 生产入口、snapshot/share 相关窄测和 ResultView fixture browser；Sprint 4 复测中 Gate 3 probe 最终 desktop/mobile `10/10`。
- **Codex adversarial review**: snapshot 安全（ZIP bomb 防护、manifest 校验、untrusted 数据隔离）、drift 阈值合理性
- **Playwright 测试**: 导出→导入全流程、drift warning 展示、卡片导出、HOPs 生产入口
- **跨平台**: snapshot ZIP 在 Windows/macOS/Linux 间互通
- **通过标准**: 0 Critical / 0 High

---

### Sprint 4: 品质提升 (Week 10-14)

**状态**: 已完成并经过本地 review/fix/full tests/browser rerun。后续只保留 Sprint 4 follow-up，不重做本节任务。

#### Layer 4A (并行 + ResultView→isZh 串行子链)

##### Task S4-1: 实时 KG WS 推送
- **类型**: 全栈 (Codex 后端 → Claude 前端)
- **当前状态**: backend event contract 已完成。当前代码已实现 `GraphDelta`、KG realtime coalescer、`kg:delta` / `kg:snapshot_invalidated` typed WS events；前端实时增量消费不是本轮已验证事实，后续需要时单独验收。
- **文件范围**:
  - `backend/app/services/causal_graph.py` (append_round_nodes 返回完整 GraphDelta)
  - `backend/app/services/kg_realtime.py` (新建 — coalescer + WS push)
  - `backend/app/api/ws.py` (新增 kg:delta 事件类型)
  - 后续如需前端增量消费，再单独评估 `frontend/src/hooks/useScenarioGraph.ts` 与相关图谱页面
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** `causal_graph.py`: `append_round_nodes()` 返回 `GraphDelta(added, updated, deleted, version, snapshot_invalidated)`，不能只返回 `nodes_added`
  2. **[BE-Codex]** delta 必须覆盖 stale node/edge delete 与 existing node/edge update；当前 append 会删除 stale nodes、更新 existing nodes，客户端需要同步删除/更新
  3. **[BE-Codex]** delta key 必须幂等：同一 `scenario_id + snapshot_id + node_key/edge_key + version` 重放不重复插入
  4. **[BE-Codex]** `kg_realtime.py`: 4Hz coalescer + 64KB 阈值（超限发 `kg:snapshot_invalidated`）
  5. **[BE-Codex]** `ws.py`: typed `kg:delta` / `kg:snapshot_invalidated` 事件注册
  6. **[FE-Claude]** `frontend/src/types.ts`: WSEvent union 新增 typed KG events
  7. **[FE-Claude]** `useScenarioGraph.ts`: 监听 `kg:delta`，按 added/updated/deleted 幂等合并；检测 version gap/out-of-sync 时调用 REST snapshot fallback (`GET /api/scenario/{id}/causal-graph`)
  8. **[FE-Claude]** CausalReviewView + WorkbenchView: 新节点 fade-in 动画；deleted 节点/边从 UI 移除；updated 节点保留布局位置
- **验收标准**: 推演中图谱实时更新；删除/更新不会留下 stale nodes；out-of-sync client 会拉 REST snapshot 修复；不阻塞 UI；4Hz 限频

##### Task S4-2: ResultView 拆分
- **类型**: 前端 (Claude 实现)
- **当前状态**: 已完成第一阶段拆分。`ResultView.tsx` 从约 3194 行降到约 1900 行，已新增 9 个子组件和 `ResultContext`；`ResultContext` 宽 context 是后续 follow-up。
- **文件范围**:
  - `frontend/src/pages/ResultView.tsx` (拆分为 orchestrator ~200 行)
  - `frontend/src/pages/result/ResultHeader.tsx` (新建)
  - `frontend/src/pages/result/EndingCardsGrid.tsx` (新建)
  - `frontend/src/pages/result/ExploreDeeperBridge.tsx` (新建)
  - `frontend/src/pages/result/WebSourcesSection.tsx` (新建)
  - `frontend/src/pages/result/PredictionsSection.tsx` (新建)
  - `frontend/src/pages/result/DirectorNotebook.tsx` (新建)
  - `frontend/src/components/result/DirectorDebriefPanel.tsx` (现有组件，接线范围 L2608-2660)
  - `frontend/src/pages/result/AgentRoster.tsx` (新建)
  - `frontend/src/pages/result/ResultModals.tsx` (新建)
  - `frontend/src/pages/result/ResultContext.tsx` (新建 — shared state Context)
  - `frontend/src/pages/ResultView.test.tsx` (先抽共享 harness，再按行为域拆分)
- **依赖**: 无
- **实施步骤**:
  1. 新建 `ResultContext.tsx`: Context Provider 封装共享状态 (~20 个 state)
  2. 路径必须使用现有小写 `frontend/src/components/result/` 约定，不创建 `pages/Result/` 或 `Result/` 大写目录，避免 macOS/Linux case sensitivity 问题
  3. 按上方真实行号范围提取子组件；不要把 HookSummaryPanel / WebSources / Predictions 并入 ExploreDeeperBridge，也不要把 Phase3Integration 并入 AgentRoster
  4. 保留/复用现有 `DirectorDebriefPanel.tsx`，把 L2608-2660 的接线和 props 显式归属到该组件
  5. ResultView.tsx 变为 ~200 行 orchestrator：hooks + Context Provider + 子组件组合
  6. 测试先抽共享 render harness/fixture builder，再按行为域拆分（header/endings/bridge/sources/predictions/debrief/modals），避免复制 4000+ 行测试设置
  7. 确保 0 功能回归
- **验收标准**: ResultView < 300 行；小写 result 子组件独立可测；测试 harness 复用；0 回归

##### Task S4-3: isZh 迁移第一批 (~200 个)
- **类型**: 前端 (Claude 实现)
- **当前状态**: 已完成本轮第一批。实际覆盖 `CompareDigestView / InputView / DebateResultView / FactionTimeline`，新增/同步 25 个 locale keys，parity 为 `en:2159 zh:2159`。
- **文件范围**:
  - `frontend/src/pages/CompareDigestView.tsx`
  - `frontend/src/pages/InputView.tsx`
  - `frontend/src/pages/DebateResultView.tsx`
  - `frontend/src/components/FactionTimeline.tsx`
  - `frontend/src/i18n/locales/en.json`
  - `frontend/src/i18n/locales/zh.json`
- **依赖**: S4-2 (ResultView 拆分后 isZh 分散到子组件)
- **实施步骤**:
  1. 先运行 count refresh：`rg -n "isZh" frontend/src/...`，记录每个文件当前真实数量；不要沿用旧 38/47 计数
  2. 编写 jscodeshift codemod 脚本：`isZh ? '中文' : 'English'` → `t('key')`
  3. 对前 5 个最频繁文件运行 codemod
  4. 手工校验每个替换的上下文正确性
  5. 新增 ~200 个 i18n keys（en + zh），locale JSON 写入由一个 i18n owner 串行执行
  6. en/zh parity 检查
- **验收标准**: 迁移文件中 isZh 清零；i18n parity 保持

#### Layer 4B (依赖 Layer 4A 无)

##### Task S4-4: Voice variant 扩展
- **类型**: 后端 (Codex 实现)
- **当前状态**: 已完成。voice variant 从 13 种扩展到 18 种，并补了 `medium` / `scale` 误分类回归。
- **文件范围**:
  - `backend/app/services/ending_room_service/_content.py` (新增 5 variant)
  - `backend/tests/test_voice_variant.py` (扩展现有测试)
- **依赖**: 无
- **实施步骤**:
  1. 在当前已覆盖的 13 个 voice variants 基础上新增 5 个现代角色 variant: tech-visionary/journalist/educator/artist/entrepreneur
  2. 每个 variant: 关键词列表 + 词汇偏好 + persona 提示
  3. 测试覆盖
- **验收标准**: 13 → 18 variants；分类准确；测试通过

##### Task S4-5: Phaser reduced-motion
- **类型**: 前端 (Claude 实现)
- **当前状态**: 已完成本轮触碰范围。`EndingScene / TitleScene / WorldScene` 的 tween、camera fade、typewriter 等本轮路径已补 reduced-motion guard 和测试。
- **文件范围**:
  - `frontend/src/game/scenes/EndingScene.ts`
  - `frontend/src/game/scenes/TitleScene.ts`
  - `frontend/src/game/scenes/WorldScene.ts`
- **依赖**: 无
- **实施步骤**:
  1. 扫描 `game/` 目录所有 tween/animation
  2. 添加 `prefers-reduced-motion` guard：reduced-motion 时 tween duration=0 或 skip
  3. 确保 game 功能不受影响（位置跳转代替动画）
- **验收标准**: game/ 零未 guard 的 tween；reduced-motion 下功能完整

#### Sprint 4 Gate: Review + Test
- **当前状态**: 已签收。Codex/Claude review 发现的真实问题已修复，并已完成全量 backend/frontend 测试、静态检查、build、i18n parity 和 browser rerun。
- **Codex adversarial review**: KG WS 竞态、ResultView 拆分完整性、isZh 迁移正确性
- **Playwright 测试**: KG 增量渲染、ResultView 各子组件、isZh 切换
- **验证结果**:
  - backend `pytest -x -q`：`2581 passed, 3 skipped, 9 warnings`
  - frontend `npx vitest run`：`179 files / 1926 tests / 0 failed`
  - `tsc --noEmit`、`eslint src/game/scenes --max-warnings=0`、`npm run build`：通过
  - i18n parity：`en:2159 zh:2159`
  - browser probe final rerun：desktop `10/10`、mobile `10/10`
- **通过标准**: 0 Critical / 0 High；isZh parity 完整；未实测平台不宣称 PASS

---

### Sprint 5: 高级功能 (Week 14-18)

#### Layer 5A (Round A 并行 + S5-3→S5-6 串行子链)

##### Task S5-1: 个人预测日志 `/me/journal`
- **类型**: 全栈 (Codex → Gemini 设计 → Claude 前端)
- **文件范围**:
  - `backend/app/models/prediction_journal.py` (新建)
  - `backend/app/services/journal_service.py` (新建)
  - `backend/app/api/journal.py` (新建)
  - `backend/app/main.py` (挂载 journal router)
  - `backend/alembic/versions/027_prediction_journal.py` (新建迁移；若执行时已有 027，则先读取 `backend/alembic/versions/` 并使用下一个连续编号)
  - `backend/tests/test_journal_routes.py` (新增 route reachability + auth/feature smoke)
  - `frontend/src/pages/PersonalJournalView.tsx` (新建)
  - `frontend/src/pages/PersonalJournalView.css` (新建)
  - `frontend/src/components/Journal/CalibrationCurveChart.tsx` (新建)
  - `frontend/src/components/Journal/AgentRosterPanel.tsx` (新建)
  - `frontend/src/components/Journal/WorldlineMapMini.tsx` (新建)
  - `frontend/src/App.tsx` (添加 /me/journal 路由)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** PredictionJournalEntry model + Brier score 计算
  2. **[BE-Codex]** journal_service: CRUD + 校准曲线数据 + 按类别聚合
  3. **[BE-Codex]** API: GET /api/me/journal + GET /api/me/calibration
  4. **[BE-Codex]** `main.py` import + `app.include_router(journal_router)`，新增 route reachability smoke
  5. **[FE-Gemini]** 3 列 bento-box 布局设计
  6. **[FE-Claude]** PersonalJournalView: 3 区域（Forecast Lab / Agent Roster / Worldline Map）
  7. **[FE-Claude]** CalibrationCurveChart: SVG 线图（轻量，无 D3 依赖）
  8. **[FE-Claude]** AgentRosterPanel: 成长时间线
  9. **[FE-Claude]** WorldlineMapMini: 分支空间缩略图（IntersectionObserver 延迟渲染）
  10. 校准评语由后端 journal summary 字段或 i18n 模板渲染；前端不新增 LLM 生成层
- **验收标准**: 3 区域完整渲染；Brier score 正确；mobile 单列降级

##### Task S5-2: DPD 幻觉验证门控
- **类型**: 后端 (Codex 实现)
- **文件范围**:
  - `backend/app/services/hallucination_gate.py` (新建)
  - `backend/app/services/debate.py` (verdict 前集成)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** `extract_verifiable_claims()`: 从 verdict 文本提取可验证声明
  2. **[BE-Codex]** `verify_claims()`: 用图谱 evidence + web evidence 交叉验证
  3. **[BE-Codex]** `apply_hallucination_gate()`: 阈值 0.75，低于则标注警告
  4. **[BE-Codex]** debate.py `_finalize_debate()` 集成
- **验收标准**: 可验证声明被标注；低可信度有警告；不阻断 verdict

##### Task S5-3: Agent 角色卡收藏
- **类型**: 全栈 (Codex → Claude)
- **文件范围**:
  - `backend/app/api/agents.py` (新增 favorite 端点)
  - `frontend/src/pages/AgentLibrary.tsx` (收藏 Gallery 视图)
  - `frontend/src/components/AgentCard.tsx` (新建 — 角色卡组件)
- **依赖**: 无；S5-6 依赖本任务完成后再改 `backend/app/api/agents.py`
- **实施步骤**:
  1. **[BE-Codex]** 在 agent identity persistence 层补 favorite 字段或关联表；不得把收藏状态只存在前端 localStorage
  2. **[BE-Codex]** 在 `agents.py` 增加 list favorite / mark favorite / unmark favorite 端点，校验 ownership 和 feature flag
  3. **[FE-Gemini]** 设计 gallery card density、空状态和 mobile 单列布局
  4. **[FE-Claude]** 新建 `AgentCard`，展示 name、profile tier、bias summary、favorite toggle 和导入来源
  5. **[FE-Claude]** `AgentLibrary` 接入 favorite filter/search/sort；所有 UI 文案走 i18n
  6. 添加 backend route/auth tests + frontend render/toggle tests
- **验收标准**: 收藏状态跨刷新持久化；跨用户不可见；mobile/desktop Gallery 可用；测试覆盖 favorite toggle 和权限

##### Task S5-4: isZh 迁移第二批 (~258 个)
- **类型**: 前端 (Claude 实现)
- **文件范围**:
  - 剩余 15+ 文件中的 isZh 表达式
  - `frontend/src/i18n/locales/en.json` (+~258 keys)
  - `frontend/src/i18n/locales/zh.json` (+~258 keys)
- **依赖**: S4-3 (第一批迁移经验)
- **实施步骤**: 同 S4-3 流程，覆盖剩余文件

##### Task S5-5: 排行榜分段
- **类型**: 全栈 (Codex → Claude)
- **文件范围**:
  - `backend/app/api/campaign.py` (筛选参数；真实文件是单数 `campaign.py`)
  - `frontend/src/pages/LeaderboardView.tsx` (筛选 UI)
- **依赖**: 无
- **实施步骤**:
  1. **[BE-Codex]** 读取现有 leaderboard query 和 indexes，确认筛选字段来自已持久化数据，不新增昂贵运行时 recompute
  2. **[BE-Codex]** 增加 segment 参数：scenario type、date range、agent count、locale、model/provider bucket；所有参数有 allowlist 和默认值
  3. **[BE-Codex]** 返回 active segment metadata，便于前端显示当前过滤条件
  4. **[FE-Gemini]** 设计 compact segmented controls；避免卡片套卡片
  5. **[FE-Claude]** `LeaderboardView` 增加筛选 UI、empty state、URL query sync
  6. 添加 API 参数测试、frontend URL/query 测试和 mobile overflow 检查
- **验收标准**: 每个 segment 可独立筛选；默认结果与旧 leaderboard 一致；URL 可分享；无横向溢出

##### Task S5-6: 身份记忆检查器
- **类型**: 全栈 (Codex → Claude)
- **文件范围**:
  - `backend/app/api/agents.py` (新增 GET /api/agents/identities/{id}/memories)
  - `frontend/src/pages/IdentityInspectorView.tsx` (新建)
- **依赖**: S5-3 (`backend/app/api/agents.py` 串行，避免同文件并行冲突)
- **实施步骤**:
  1. **[BE-Codex]** 在 `agents.py` 暴露 identity memory read-only endpoint，按 identity owner 做 404 concealment
  2. **[BE-Codex]** 返回 memory entries、source scenario、timestamp、confidence、redaction marker；不得泄漏 BYOK/session/token 字段
  3. **[FE-Gemini]** 设计 inspector：timeline + source chips + confidence legend
  4. **[FE-Claude]** `IdentityInspectorView` 实现只读检查器，支持 empty/error/loading 状态
  5. 添加 endpoint auth tests、redaction tests、frontend loading/error tests
- **验收标准**: 可查看身份记忆来源和可信度；跨用户访问被隐藏；无敏感字段泄漏；S5-3 favorite 端点无回归

#### Sprint 5 Gate: Review + Test
- **Codex adversarial review**: journal schema/Brier score、hallucination gate 误伤、agents.py 串行修改、leaderboard query 成本、memory redaction
- **Playwright 测试**: `/me/journal`、Agent Library favorite、Leaderboard segment、Identity Inspector mobile/desktop
- **验证命令**:
  - Backend targeted pytest: journal / hallucination / agents / campaign tests
  - Frontend targeted vitest: journal / agent card / leaderboard / inspector tests
  - `npm exec -- tsc --noEmit -p tsconfig.app.json`
  - `npm run e2e:cross-browser`
- **通过标准**: 0 Critical / 0 High；所有新端点 route smoke PASS；跨用户权限测试 PASS；browser evidence 已保存

---

### Sprint 6: 战略功能 (Week 18-22+)

#### Layer 6A (串行 — 高复杂度)

##### Task S6-1: 文档驱动 Agent 生成
- **类型**: 全栈 (Codex 后端 → Gemini 设计 → Claude 前端)
- **文件范围**:
  - `backend/app/services/document_ingestion.py` (新建)
  - `backend/app/api/agents.py` (新增 POST /api/agents/from-document)
  - `backend/pyproject.toml` (新增 pypdf 依赖)
  - `frontend/src/pages/AgentWorkshop/DocumentUploader.tsx` (新建)
  - `frontend/src/pages/AgentWorkshop/EntityExtractionProgress.tsx` (新建)
- **依赖**: S5-3 (Agent 基础设施)
- **实施步骤**:
  1. **[BE-Codex]** pyproject.toml 新增 `pypdf>=4.0`
  2. **[BE-Codex]** `document_ingestion.py`:
     - `extract_pdf_text(max_pages=200, max_bytes=25MB)`
     - `chunk_document(target_chars=2500, overlap=300)`
     - `extract_entities()`: LLM 实体提取 → MBTI 人设生成
  3. **[BE-Codex]** 安全：PDF 文本按 untrusted input，LLM 抽实体禁执行指令
  4. **[FE-Gemini]** Dropzone 上传 + 进度环设计
  5. **[FE-Claude]** DocumentUploader + EntityExtractionProgress 实现
- **验收标准**: PDF 上传→实体提取→Agent 生成；安全防护完整

##### Task S6-2: 教育场景预设（非叙事模板）
- **类型**: 全栈
- **文件范围**:
  - `backend/app/services/education_templates.py` (新建)
  - `frontend/src/components/EducationTemplatePicker.tsx` (新建)
- **依赖**: S6-1 (文档驱动 Agent schema 稳定后)
- **去模板化约束**:
  - 这里的 “template” 只能表示结构化场景预设、字段默认值和 i18n UI label，不能新增用户可见静态叙事模板。
  - 任何教学解说、agent 观点、场景总结、反馈语必须走 LLM generation-first；失败时按本文件“去模板化范围”使用 LLM rewrite，再失败才进入 deterministic/static i18n fallback。
  - 前端 picker 文案只走 locale key + 参数插值，不调用 LLM 生成 UI copy。
- **实施步骤**:
  1. **[BE-Codex]** 定义 education preset schema：domain、age band、learning goal、role constraints、safety flags；不包含静态剧情段落
  2. **[BE-Codex]** preset 转 scenario seed 时调用 LLM dynamic generator 生成可见叙事，并把 preset 字段作为 structured input
  3. **[FE-Gemini]** 设计 preset picker 分类、搜索、预览和 disabled state
  4. **[FE-Claude]** `EducationTemplatePicker` 实现结构化选择器；所有 label 走 i18n
  5. 添加 service tests：preset 不含可见叙事模板、LLM generation-first、fallback 顺序正确
- **验收标准**: preset 只提供结构化约束；生成出的场景可见文案来自 LLM 主路径；fallback 可测；UI 无硬编码长叙事

##### Task S6-3: Agent 人设导出/导入
- **类型**: 全栈
- **文件范围**:
  - `backend/app/api/agents.py` (导出/导入端点)
  - `frontend/src/components/AgentWorkshop/PersonaExportMenu.tsx` (新建)
- **依赖**: S6-1 + S6-2
- **实施步骤**:
  1. **[BE-Codex]** 设计 persona export manifest：schema_version、identity fields、bias profile、source metadata、checksums
  2. **[BE-Codex]** 导出默认 redact private fields；导入校验 schema_version、checksum、size limit、ownership
  3. **[BE-Codex]** import path 使用新 identity，不覆盖已有 identity；冲突 name 自动 suffix
  4. **[FE-Gemini]** 设计 export/import menu、confirmation copy 和 import preview
  5. **[FE-Claude]** `PersonaExportMenu` 支持导出、导入预览、确认、错误态
  6. 添加 manifest validation tests、redaction tests、frontend import preview tests
- **验收标准**: persona 可导出并在另一实例导入；manifest/checksum 校验失败会拒绝；不会泄漏私有字段；不会覆盖已有 identity

#### Sprint 6 Gate: Review + Test
- **Codex adversarial review**: PDF prompt-injection、document size limits、education preset 去模板化、persona import/export redaction、agents.py 多任务串行冲突
- **Playwright 测试**: Document uploader、education preset picker、persona export/import，覆盖 desktop/mobile 和 Firefox/WebKit
- **最终验证**:
  - `cd backend && source .venv/bin/activate && python -m pytest -q`
  - `cd backend && source .venv/bin/activate && python -m ruff check app tests`
  - `cd frontend && npm test -- --run`
  - `cd frontend && npm exec -- tsc --noEmit -p tsconfig.app.json`
  - `cd frontend && npm run lint`
  - `cd frontend && npm run build`
  - `cd frontend && npm run e2e:cross-browser`
  - `cd frontend && npm run e2e:full`
  - `cd frontend && npm run e2e:safari` when available
- **通过标准**: 0 Critical / 0 High；full backend/frontend test PASS；Chromium/Firefox/WebKit browser evidence PASS；Safari/Edge 可用性已实测或明确记录 blocked reason

---

## 文件冲突检查

### Task Ownership Rule

- 每个 task 的 **文件范围** 就是该 task 的 allowed files；执行 agent 不得写出该范围之外的文件。
- 如果实现时确实需要新增/修改范围外文件，必须先暂停并更新本计划的文件范围、owner 和冲突矩阵，再继续。
- 同一个文件同一时间只能有一个 writer owner；跨 task 共享文件按下方矩阵串行。
- locale JSON、package lock、router mount、API client、large view split 必须由主 Claude 编排串行合并，不能让多个 agent 同时写。

### 高风险文件（多任务触及）

| 文件 | 触及任务 | 冲突解决 |
|------|---------|---------|
| `frontend/src/pages/ResultView.tsx` | S1-4, S3-1, S4-2, S4-3 | S4-2 拆分前，S1-4/S3-1 在原文件工作；S4-3 在拆分后 |
| `frontend/src/i18n/locales/en.json` | 几乎所有任务 | 同一 Layer 内设一个 i18n owner 串行写 locale JSON；任务只提交 namespace patch，不并行直接写 |
| `frontend/src/i18n/locales/zh.json` | 同上 | 同上；必须执行 en/zh parity check |
| `frontend/src/App.tsx` | S0-1, S5-1, S5-6 | 不同 Sprint，串行无冲突 |
| `frontend/src/api/client.ts` | S2-1, S2-3 | S2-3 必须依赖 S2-1，串行修改 client API |
| `frontend/package.json` / `frontend/package-lock.json` | S1-3, S1-1 | S1-3 统一添加 `@radix-ui/react-alert-dialog`，S1-1 只消费依赖 |
| `backend/app/main.py` | S0-1, S2-3, S5-1 | 新 router 挂载点；按 Sprint 串行，并为每个新 router 加 reachability smoke |
| `backend/app/api/scenarios.py` | S1-1, S3-6 | S1-1 加 cancel 端点；S3-6 加 snapshot 端点；不同函数 |
| `backend/app/api/agents.py` | S2-4, S5-3, S5-6, S6-1, S6-3 | 按 Sprint 串行；S5-6 必须依赖 S5-3；函数级隔离 |

### 冲突状态
⚠️ **同 Layer 内存在显式序列化点** — S1-3 dependency step→S1-1 (`package-lock`)、S2-1→S2-3 (`client.ts`)、S5-3→S5-6 (`agents.py`)、locale JSON owner 串行
⚠️ **跨 Sprint 有共享文件** — 已通过 Sprint 串行 + 函数级隔离解决；新 router 必须同步 `main.py`

---

## 并行分组

### Sprint 0 (2 Layer)
- **状态**: 已完成于 `a1a628a`
- **Layer 0A** (历史): S0-3 字体 | S0-4 Docker | S0-6 安全提示
- **Layer 0B** (历史): Round A 执行 S0-1 设置向导；Round B 执行 S0-5 preflight（依赖 S0-1 后端 service）

### Sprint 1 (1 Layer)
- **状态**: 已完成于 `a1a628a`
- **Layer 1A** (历史): 先执行 S1-3 dependency step（AlertDialog package + lockfile）；随后并行 S1-1 取消 | S1-3 剩余 Bug修复 | S1-4 Reader模式 | S1-5 引导

### Sprint 2 (1 Layer)
- **状态**: 已完成于 `a1a628a`
- **Layer 2A** (历史): Round A 并行 S2-1 对话重载 | S2-2 Agent展示 | S2-4 bias编辑 | S2-5 成长指标；Round B 串行 S2-3 配额（依赖 S2-1 的 `client.ts` 改动）

### Sprint 3 (2 Layer)
- **状态**: 已完成并过 Gate 3
- **Layer 3A** (历史): S3-1 时钟倒拨 | S3-2 ReACT | S3-5 分享卡
- **Layer 3B** (历史): S3-4 HOPs 生产接线 | S3-3 人格门控 | S3-6 快照导出
- **Gate 3**: 已签收；后续不重跑

### Sprint 4 (2 Layer)
- **状态**: 已完成并过 Gate 4
- **Layer 4A** (历史): S4-1 KG WS backend contract | S4-2 ResultView 拆分 | S4-3 isZh 第一批
- **Layer 4B** (历史): S4-4 voice variants | S4-5 Phaser reduced-motion
- **Gate 4**: 已完成 Codex+Claude 对抗式审查、修复、全量测试、build、i18n parity 与 Chromium desktop/mobile browser rerun

### Sprint 5 (1 Layer)
- **状态**: 下一执行点。先确认 Sprint 4 follow-up 是否影响当前任务文件，再开写。
- **Layer 5A**: Round A 并行 S5-1 Journal | S5-2 幻觉门控 | S5-3 角色卡 | S5-4 isZh第二批 | S5-5 排行榜；Round B 串行 S5-6 记忆检查（依赖 S5-3 的 `agents.py` 改动）
- **Gate 5**: Codex+Claude 对抗式审查 + Playwright

### Sprint 6 (1 Layer — 串行)
- S6-1 文档Agent → S6-2 教育场景预设 → S6-3 人设导出
- **Gate 6**: 最终 Codex+Claude 全量审查 + 全平台 Playwright

---

## 执行规则

### 多模型分工
| 角色 | 模型 | 职责 |
|------|------|------|
| 总编排 | Claude | 调度 agent teams，上下文管理，综合决策 |
| 后端实现 | Codex (via codex-plugin-cc) | 服务/模型/迁移/API 实现，sub-agents 并行 |
| 前端设计 | Gemini (via codeagent-wrapper) | UI/UX 方案，组件布局，交互设计 |
| 前端实现 | Claude agent teams | 组件代码，样式，测试 |
| 对抗式审查 | Codex + Claude 交叉 | 每个 Gate 双模型独立 review |
| 浏览器实测 | Playwright | Chromium/Chrome channel where available 桌面/移动 + Firefox/WebKit 桌面；Safari 用 WebDriver opt-in；Edge 需 msedge channel/BrowserStack/Sauce/手工 Gate |

### 调用细则

- Codex 只通过 `codex-plugin-cc` 直接 slash command 调用：`/codex:rescue`、`/codex:review`、`/codex:adversarial-review`、`/codex:status`、`/codex:result`、`/codex:cancel`。
- `/codex:review` 和 `/codex:adversarial-review` 是只读审查；Gate 默认审查当前工作树：`/codex:review --background --scope working-tree` 与 `/codex:adversarial-review --background --scope working-tree <focus>`。
- 修复任务用 `/codex:rescue --background --fresh <bounded task>`；同一个 Codex rescue 线程的后续修复才用 `--resume`。
- 不要把 `codex:review` 当 Skill 调用；这会触发 `disable-model-invocation` 类错误。
- Gemini 只通过 `~/.claude/bin/codeagent-wrapper --backend gemini "<task>" /Users/yangjunjie/Desktop/upgrade-test` 调用；429/quota/resource exhausted 时记录 `gemini-429-fallback=claude` 并由 Claude 兜底设计评审。
- 每个 Sprint Gate 顺序固定：实现完成 → targeted tests → browser smoke → `/codex:adversarial-review --background --scope working-tree <focus>` → 修复非误判项 → `/codex:review --background --scope working-tree` + Claude cross-review → 进入下一 Sprint。

### Gate 通过标准
- 0 Critical / 0 High 级别问题
- backend 测试 0 failed
- frontend 测试 0 failed
- tsc 0 errors
- ruff 0 errors (backend)
- eslint 0 errors (frontend)
- vite build 0 violations
- i18n en/zh parity 完整
- Playwright Chromium/Chrome channel where available 桌面 1440px + mobile 375px PASS
- Playwright Firefox desktop PASS
- Playwright WebKit desktop PASS
- Safari 只有在 Safari/WebDriver 可用并运行 opt-in 命令后才能声明 PASS；不可用时记录 blocked reason
- Edge 只有在 msedge channel、本机手工证据、或 BrowserStack/Sauce 等远端矩阵可用并运行后才能声明 PASS；不可用时记录 blocked reason
- 所有新 router 的 `main.py` 挂载 smoke test PASS

### 验证命令阶梯

先跑最小相关验证，再扩展到 Gate 级验证；不得只跑 smoke 后宣称全量通过。

```bash
# backend targeted
cd backend
source .venv/bin/activate
python -m pytest <changed-test-files> -q
python -m ruff check app tests

# frontend targeted
cd frontend
npm ci
npm test -- --run <changed-test-files>
npm exec -- tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build

# browser gate
cd frontend
npm run e2e:cross-browser
npm run e2e:full
npm run release:signoff -- --headless
npm run release:signoff -- --headless --include-safari --webdriver-url http://127.0.0.1:4444  # only with Safari WebDriver
npm run e2e:safari  # only when Safari/WebDriver environment is available
```

### 安全红线
- 所有进入 LLM prompt 的用户输入、agent 输出、搜索结果、PDF 文本必须经 `format_untrusted_text_block()` 或等价 untrusted-text wrapper 防注入
- LLM 输出展示/持久化前必须做 schema、长度、语言和 HTML/Markdown 安全校验
- PDF 文本全部按 untrusted input
- 新增端点必须有 feature flag gate + 权限校验
- 新增 router 必须在 `backend/app/main.py` 挂载，否则不算完成
- snapshot 导入必须校验 manifest + checksums
- quota 必须防绕过（server-side enforcement）
- user cancel 必须写入独立 cancelled 终态，不得复用 runtime lock-loss/error 终态
