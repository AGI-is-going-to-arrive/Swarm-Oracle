# Pixel Theater Overhaul — Claude Code `/ccg:team` 执行计划

> Status: **IMPLEMENTED IN CURRENT WORKTREE**.
> 本文件是 Claude Code team orchestration handoff，不是视觉蓝本复述。
> 设计蓝本来自 `/Users/yangjunjie/.agent/diagrams/pixel-theater-overhaul-plan.html`，但该 HTML 只作为方向输入；任何实现判断必须以当前 `llmdoc/`、源码、测试和浏览器实测为准。

## 0. 执行入口

以下是原 Claude team 编排入口。当前工作树已完成本计划的前端落地；除非要重新跑整套编排，不要把本节当待执行任务。

从仓库根目录执行：

```text
/ccg:team .claude/plan/pixel-theater-overhaul.md
```

如果当前 Claude Code 安装只暴露 `team-exec`：

```text
/ccg:team-exec .claude/plan/pixel-theater-overhaul.md
```

第一轮返回必须包含：

1. Gate 0 事实校准结果。
2. 执行 DAG、可并行组、串行写锁。
3. dirty tree 分类，尤其说明 `.claude/` 被 `.gitignore` 忽略。
4. Gemini / Codex 调用记录与 fallback 规则。
5. NO-GO 条件。

在这 5 项齐全前，不允许进入写模式。

## 1. 编排契约

### Claude 主 agent

- Claude 主 agent **只负责编排**：读取真值、拆 DAG、调度 agent teams、管理写锁、合并 gate 报告、做 GO/NO-GO 决策。
- Claude 主 agent 不直接改生产代码、测试、CSS、locale、脚本、迁移或文档。
- 安全可行时使用 agent teams 并行；同文件写入、locale JSON、package/script、Phaser runtime 关键路径和 Gate 决策必须串行。
- 每个大 Sprint / Phase / Gate 完成后，先完成 Codex 对抗式审查和浏览器实测，再修 bug，再做 Claude+Codex 交叉 review，通过后才进入下一阶段。

### Gemini 路由

前端 UI/UX、视觉设计、CSS、React 组件、a11y、响应式、i18n copy 和浏览器体验优先交给 Gemini，通过 CCG skills 的 `codeagent-wrapper` 调用：

```bash
~/.claude/bin/codeagent-wrapper --backend gemini "<bounded frontend task>" /Users/yangjunjie/Desktop/upgrade-test
```

如果 Gemini 返回 `429`、quota、resource exhausted 或同类容量失败：

- 记录 `gemini-429-fallback=claude`；
- 将同一 bounded frontend task 分配给 Claude frontend worker agent；
- Claude 主 agent 仍只负责编排，不直接改代码。

### Codex 路由

Codex 负责所有非前端 UI/UX 的实现/修复/review，也负责普通 review、对抗式 review、bug fix 和跨 review。必须通过本机 Claude Code 已安装的 `codex-plugin-cc` 调用，使用 Codex 默认模型：

```text
/codex:rescue --background --fresh <bounded implementation or bug-fix task>
/codex:review --background --scope working-tree
/codex:adversarial-review --background --scope working-tree <risk focus>
/codex:status
/codex:result
/codex:cancel
```

规则：

- 不传 `--model` 或 `--effort`，除非用户另有明确要求。
- 不要通过 `Skill(codex:review)` 或 `Skill(codex:adversarial-review)` 调用。
- 长任务默认 `--background`。
- 每个 Codex prompt 必须写明：在安全前提下尽可能使用 sub-agents / multi-agents，不限制安全可并行的 sub-agent 数量；只读或不冲突写集可并行，共享文件写入必须串行。

## 2. 当前真实基线

Gate 0 必须重新验证，不能把本节当永久真值。以下基线已按 2026-05-21 当前工作树同步。

- 项目当前有 `llmdoc/`；默认真值入口是 `llmdoc/index.md`、`overview/project.md`、`overview/frontend.md`、`overview/backend.md`、`overview/backlog.md`、`guides/development.md`。
- 交付目标是 **browser-first Web**，不是原生 Windows/macOS/Linux 桌面壳。
- 前端工具链是 `npm@11.12.1`，存在 `frontend/package-lock.json`；不要用 pnpm/yarn。
- `.claude/` 被 `.gitignore` 忽略；本计划不会出现在普通 `git status` 里，必须直接读文件。
- 当前 i18n key parity 实测：`en=2757`、`zh=2757`、缺失 key 为 0。
- `HudOverlay.tsx` 和 `HudOverlay.test.tsx` 已删除；`SimulationView.tsx` 不再包 `<HudOverlay>`；`EventBridge` 的 `viz:bet_update / viz:leaderboard_update` 死事件已清理。
- `SimulationView` 的 Theater 控制已拆到 `frontend/src/pages/sim/*`：`TheaterFloatingToolbar`、`TheaterCaptureControls`、`TheaterStatusChips`、`DirectorDrawer`。
- 当前 `PhaserGame.tsx` 按 `width * dpr` 与 `height * dpr` 初始化 canvas backing store，DPR capped at 3；`BootScene` 与 `WorldScene` 会读取 registry DPR 做 fallback texture / drawing unit 缩放。`pixelArt:true`、`roundPixels:true`、`antialias:false` 和 `Phaser.Scale.FIT` 仍保留。
- 当前 `.theater-panel` 不只是视觉 class：`useSimulationViewState.ts` 的 capture 仍依赖 `.theater-panel` 与 `.phaser-game-container` 选择器；本轮没有修改该 hook。
- React DOM bubble overlay 已落地并默认开启；`?domBubbles=0` 或 `?useDomBubbles=false` 可退回 Phaser bubble fallback。
- Light Theater 只改 Theater shell、toolbar、chips、drawer 与 DOM bubbles；Phaser 场景内部仍由 game runtime 渲染。
- 当前前端已经 self-host 字体；蓝本 HTML 里的 Google Fonts / CDN 只属于蓝本文档，不得引入生产前端。
- CI 当前主要是 Ubuntu；Windows/macOS 支持不能口头宣称，必须通过新增或外部 evidence 证明。

本轮真实验证：

- `cd frontend && npx tsc --noEmit -p tsconfig.app.json`：通过。
- `cd frontend && npm run lint`：通过。
- `cd frontend && npm run build`：通过，performance budgets `violations: []`。
- `cd frontend && npm test -- --run`：`202 files / 2243 tests passed`。
- i18n parity：`{ en: 2757, zh: 2757, missing_en: 0, missing_zh: 0 } PASS`。
- `git diff --check`：通过。
- Chrome DevTools MCP 复核完成态 `/sim/e1a41453-2cb2-43a1-a054-0d7cd04a6bf5`：toolbar 玩法卡入口可见，modal 以只读提示打开，console error 为 0，截图在本地忽略目录 `frontend/output/theater-gameplay-cards-toolbar-fix.png`。
- Playwright MCP 当时因本机 browser profile 已占用未使用，浏览器复核改用 Chrome DevTools MCP。

当前 Sprint 落地摘要：

- Sprint A：HUD 清理已完成，React `HudOverlay` 和死事件链路已移除。
- Sprint B：HiDPI canvas 已完成，DPR 上限为 3。
- Sprint C：Theater-first 布局已完成，控制面板拆成 `pages/sim/*` 子组件。
- Sprint D：React DOM bubble overlay 已完成，保留 query fallback。
- Sprint E：Light Theater 配色已完成在 Theater shell / toolbar / chips / drawer 层；canvas 场景仍由 Phaser 渲染。
- 追加修复：完成态 Theater 的原玩法卡入口恢复为 toolbar 只读回看。

后续章节保留原执行拆解，供回看任务边界和 gate，不再表示这些 Sprint 尚未开始。

## 3. Gate 0 — 事实校准，只读

Owner: Claude 主 agent 编排并行只读 agent teams。禁止写文件。

### 必读文件

```text
llmdoc/index.md
llmdoc/overview/project.md
llmdoc/overview/frontend.md
llmdoc/overview/backend.md
llmdoc/overview/backlog.md
llmdoc/guides/development.md
.claude/plan/pixel-theater-overhaul.md
/Users/yangjunjie/.agent/diagrams/pixel-theater-overhaul-plan.html
frontend/package.json
frontend/package-lock.json
frontend/src/pages/SimulationView.tsx
frontend/src/pages/SimulationView.css
frontend/src/hooks/useSimulationViewState.ts
frontend/src/game/PhaserGame.tsx
frontend/src/game/HudOverlay.tsx
frontend/src/game/HudOverlay.test.tsx
frontend/src/game/game.css
frontend/src/game/managers/EventBridge.ts
frontend/src/game/scenes/BootScene.ts
frontend/src/game/scenes/WorldScene.ts
frontend/src/i18n/locales/en.json
frontend/src/i18n/locales/zh.json
frontend/src/i18n/locales.test.ts
frontend/scripts/release-signoff.mjs
frontend/scripts/e2e-suite.mjs
.github/workflows/ci.yml
.github/workflows/release-signoff.yml
```

### 必跑命令

```bash
pwd
git status --short
git check-ignore -v .claude/plan/pixel-theater-overhaul.md || true
node -e "console.log(require('./frontend/package.json').packageManager)"
test -f frontend/package-lock.json
test ! -f pnpm-lock.yaml
rg -n "HudOverlay|viz:bet_update|viz:leaderboard_update|theater-panel|capture-mode-toggle|btn--capture" frontend/src
rg -n "render_game_to_text|advanceTime|capture_game_screenshot|\\.theater-panel|\\.phaser-game-container" frontend/src frontend/scripts
rg -n "devicePixelRatio|ResizeObserver|Phaser.Scale|pixelArt|roundPixels|antialias|resolution" frontend/src/game frontend/src/hooks
rg -n "prefers-reduced-motion|forced-colors|100dvh|backdrop-filter|inert|isComposing" frontend/src
node -e "const fs=require('fs');function flat(o,p=''){let r={};for(const [k,v] of Object.entries(o)){const n=p?p+'.'+k:k;if(v&&typeof v==='object'&&!Array.isArray(v))Object.assign(r,flat(v,n));else r[n]=v;}return r;}const en=flat(JSON.parse(fs.readFileSync('frontend/src/i18n/locales/en.json','utf8')));const zh=flat(JSON.parse(fs.readFileSync('frontend/src/i18n/locales/zh.json','utf8')));const missEn=Object.keys(zh).filter(k=>!(k in en));const missZh=Object.keys(en).filter(k=>!(k in zh));console.log({en:Object.keys(en).length,zh:Object.keys(zh).length,missing_en:missEn.length,missing_zh:missZh.length}); if(missEn.length||missZh.length) process.exit(1);"
```

### Gate 0 输出

Gate 0 必须把蓝本主张分成四类：

- `confirmed`: 当前源码确实支持。
- `stale`: 蓝本或旧计划已过时。
- `risky`: 方向可能对，但需要实验或拆小。
- `rejected`: 与当前产品边界、实现或测试契约冲突。

必须特别判断：

- 是否保留 `.theater-panel` 作为 capture 兼容 selector，或同步迁移 capture hook 与 E2E。
- DPR 修复采用 `Scale.RESIZE`、`Scale.NONE + manual resize` 还是保守 `FIT + resolution`，不得直接套蓝本代码。
- React bubble overlay 是立即迁移，还是先做可回退实验 flag。
- Light Theater 只改 Theater shell，不能破坏 Phaser 场景内部暗色主题、右侧 Agent 面板和现有 self-host font 约束。
- Windows/macOS/Linux 的验证口径和缺口。

## 4. Sprint A — 安全清理与兼容基座

Owner: Codex for non-UI cleanup and contract-safe fixes; Gemini only reviews visible UI impact. Claude 主 agent 只编排。

### 目标

移除确认无生产者的 HUD 死链路，同时保护截图、replay 和 prediction 入口。

### 可并行任务

- Codex worker A1: `HudOverlay` 引用、测试和 EventBridge 死事件清理。
- Codex worker A2: `game.css` HUD-only CSS 清理，保留 Theater 容器、loading、reduced-motion 相关规则。
- Codex worker A3: i18n key 清理，仅删除 `game.*` 下 HudOverlay 专属 key，不碰 PredictionModal / Debate / Gameplay betting 文案。
- Gemini reviewer A4: 审查删除后是否仍有唯一、清晰的预测入口。

共享写锁：

- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh.json`
- `frontend/src/pages/SimulationView.tsx`
- `frontend/src/game/game.css`

### 必须保留

- 顶栏或 Theater 内仍要有可发现的 Prediction / 预测入口。
- `capture_game_screenshot()` 不得失效。
- replay 模式和 live 模式都不能因为删除 `<HudOverlay>` wrapper 白屏。

### 验证

```bash
cd frontend
npm test -- --run src/game/HudOverlay.test.tsx src/pages/SimulationView.test.tsx src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
```

Gate A 还必须跑浏览器 smoke：

- Chromium desktop：进入 `/sim/:id` Theater，确认无赔率条、无底部重复下注按钮。
- Chromium mobile 390x844：预测入口可触达，无横向溢出。
- `capture_game_screenshot('panel')` 和 `capture_game_screenshot('canvas')` 至少一个成功；如果 plan 同步迁移 selector，两个都要成功。

通过条件：Codex adversarial review + Codex review 无 blocker，Gemini/Claude frontend review 无 Critical。

## 5. Sprint B — DPR / Resize 视觉保真

Owner: Codex for Phaser runtime mechanics; Gemini for visual review; Claude 主 agent 编排。

### 目标

修复 Retina/HiDPI 模糊和 resize 行为，但不一次性重写 Theater 布局。

### 必须先做 Spike

在写生产改动前，Codex 必须做一个小实验或最小 patch，并用浏览器像素证据回答：

- `Phaser.Scale.FIT + resolution`
- `Phaser.Scale.RESIZE`
- `Phaser.Scale.NONE + ResizeObserver manual resize`

比较维度：

- canvas CSS 尺寸与 backing store 尺寸。
- `WorldScene` sprite 坐标是否漂移。
- replay `advanceTime()` 是否仍可推进。
- screenshot/capture 是否仍输出非空图。
- Playwright WebKit 下是否白屏或只渲染一角；真实 Safari 只有在 `e2e:safari` + WebDriver 可用时才单独声明。

### 实现约束

- 不得直接把 `pixelArt:false` 作为默认，除非已证明 sprite 不模糊且 BootScene/WorldScene texture filter 已正确处理。
- 若引入 `ResizeObserver`，必须有无 `ResizeObserver` fallback。
- 若监听 DPR 变化，必须处理外接显示器拖动窗口，不可无限重建 Phaser game。
- `preserveDrawingBuffer` 仍要满足截图链路。
- `window.advanceTime`、`window.__swarmGetSceneAutomation`、`render_game_to_text` 等自动化 hook 不得丢失。

### 验证

```bash
cd frontend
npm test -- --run src/game/PhaserGame.test.ts src/game/scenes/WorldScene.test.ts src/pages/SimulationView.test.tsx
npx tsc --noEmit -p tsconfig.app.json
npm run build
```

浏览器证据：

- Chromium desktop DPR 1 与 DPR 2。
- Playwright WebKit desktop；真实 Safari 需要单独 WebDriver evidence。
- Firefox desktop。
- viewport resize、DevTools dock、移动端 390x844。
- 截图工件必须包含 canvas 非空、scene automation JSON、console error=0。

## 6. Sprint C — Theater-First 布局

Owner: Gemini frontend implementation first; Claude frontend worker fallback on Gemini 429; Codex reviews. Claude 主 agent 不改代码。

### 目标

以蓝本 Theater-First 为方向，但保守分步落地：

1. 先把常驻 capture/status/director/filter 区域拆成小组件。
2. 再改成浮动 toolbar + drawer。
3. 最后再调 Light Theater shell。

### 建议组件边界

```text
frontend/src/pages/sim/TheaterFloatingToolbar.tsx
frontend/src/pages/sim/DirectorDrawer.tsx
frontend/src/pages/sim/TheaterStatusChips.tsx
frontend/src/pages/sim/TheaterCaptureControls.tsx
```

不要一开始删除所有 `.theater-panel__*` CSS。先保留兼容层，等 capture / E2E 全部迁移后再清理。

### UX / i18n 约束

- desktop toolbar 可以显示短文案；mobile `<520px` 必须 icon-only + tooltip/aria-label。
- 中文、英文和长插值不能撑破按钮；按钮 hit target ≥44px。
- Drawer 使用 Radix Dialog/Sheet 时必须处理 focus trap、Escape、return focus、`aria-labelledby`/`aria-describedby`。
- 不要用 visible 文本解释“如何使用功能”；只保留自然的控件标签。
- 浮动层不能遮挡 Phaser 关键交互、气泡或 mobile safe area。

### 验证

```bash
cd frontend
npm test -- --run src/pages/SimulationView.test.tsx src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
```

浏览器必须覆盖：

- Chromium desktop 1440x900。
- Chromium mobile 390x844 与 430x932。
- Firefox desktop。
- Playwright WebKit desktop；真实 Safari 需要单独 WebDriver evidence。
- 语言切换 EN / 中文。
- `prefers-reduced-motion`。
- forced-colors 或高对比 fallback，至少用 CSS/DOM evidence；Windows Edge 实机/CI 若不可用，必须标明缺口。

## 7. Sprint D — React Bubble Overlay 与 Agent Sheet

Owner: Gemini frontend implementation first; Codex reviews Phaser/EventBridge contract and performance.

### 先决条件

只有 Sprint B/C 通过且 browser evidence 证明坐标稳定后，才允许进入本 Sprint。

### 实现策略

必须使用 feature flag 或 runtime fallback：

```text
useDomBubbles=false -> 保留现有 Phaser bubble
useDomBubbles=true  -> React overlay 渲染，Phaser 只保留 sprite/halo
```

首版不允许一次性删除 `WorldScene` 现有 bubble slot 算法。先复用或桥接：

- sprite id -> screen coordinate
- camera scroll/zoom
- canvas CSS rect / backing store ratio
- mobile compact max visible
- replay / live 不同 linger timing

### a11y / i18n

- overlay 容器需要 `role="log"`、`aria-live="polite"`、`aria-relevant="additions"`。
- sr-only transcript 必须保留完整消息，不能只保留截断版。
- CJK、emoji、RTL 混合文本按 DOM 原生排版；长词和 500+ 字消息必须有截断/展开规则。
- 键盘 `[` / `]` / Enter 是增强能力，不得拦截输入框、select、textarea 或 IME composition。

### 性能

- 每帧位置同步不能触发 React setState 全树重渲染；使用 ref + `transform: translate3d()`。
- 最多可见气泡必须有上限，长消息必须排队。
- reduced-motion 下 typewriter 立即显示全文。
- 页面 hidden / unmount / route change 必须停止 RAF、timer 和 EventBridge listener。

### AgentInfoSheet

如果实现 Agent sheet：

- 只展示当前 scenario 已有 agent 数据，不新增后端 API。
- persona / role / recent messages 都按文本节点渲染。
- focus trap、Escape、return focus、mobile bottom sheet 必须完整。

## 8. Sprint E — Light Theater 外壳与跨平台收口

Owner: Gemini for visual design/CSS; Codex for compatibility scripts/reviews.

### 视觉边界

- Light Theater 只先作用于 Theater shell：`SimulationView` theater mode 外壳、浮动 toolbar、drawer、status chips。
- Phaser canvas 内部场景保持暗色游戏画面，避免破坏既有主题系统。
- 右侧 Agent panel 继续复用经典模式，除非 Gate 0/后续 review 证明必须改。
- 不引入 Google Fonts、外部 CDN 或远程字体；沿用 self-host `/fonts/*.woff2`。
- 不让 UI 读成单一粉紫主题；品牌色 `#c61583` 只能作为 accent，不可主导整页。

### CSS / 浏览器要求

- `backdrop-filter` 必须有 `-webkit-backdrop-filter` 与 solid fallback。
- `@media (prefers-reduced-motion: reduce)` 覆盖 CSS transition、typewriter、Phaser tween/flash。
- `@media (forced-colors: active)` 使用 system colors；点阵背景、vignette、glass 必须降级。
- `100dvh` 要保留 fallback，避免 iOS Safari viewport 问题。
- Linux WebGL 风险不能只靠 `failIfMajorPerformanceCaveat` 文案；必须实测或保留明确 fallback UI。

### 跨 OS 支持

本项目的运行目标是浏览器 Web。Windows/macOS/Linux 支持的验收方式：

- macOS: 本机 Chromium / Firefox / Playwright WebKit browser evidence；真实 Safari 只有跑过 `e2e:safari` / WebDriver 才能声明。
- Linux: GitHub Actions Ubuntu 或本地 Linux worker，至少跑 frontend build、targeted vitest、Playwright Chromium/WebKit/Firefox fixture。
- Windows: 若无现有 CI matrix，必须新增临时或持久 Windows job/worker 计划，至少验证 npm install/build、i18n parity、targeted vitest；forced-colors 最好用 Windows Edge/Chromium 实机或 Playwright + CSS evidence 辅助。没有证据时最终报告只能写 `Windows not fully verified`，不能写已支持。

## 9. Release Gate

Final GO 必须同时满足：

1. Gate 0 到 E 的 gate report 都已记录。
2. 所有 confirmed Critical/High 已修复。
3. `npm` 工具链正确，未引入 pnpm/yarn。
4. i18n key 和 placeholder parity 通过。
5. TypeScript、lint、build 通过。
6. Theater 相关 targeted vitest 通过。
7. 关键 browser evidence 覆盖 Chromium desktop/mobile、Firefox desktop、Playwright WebKit desktop；真实 Safari 若未跑 WebDriver，只能列为未验证。
8. screenshot/GIF/capture automation 仍可用，`render_game_to_text()` / `advanceTime()` 未回归。
9. `corners / mobile / cross-browser / safari(若可用)` 或 release-signoff 等价路径通过；不能把 `e2e:full` 写成 Chrome+Firefox+Safari 全覆盖。
10. Codex adversarial review + Codex review 无 unresolved blocker。
11. Gemini frontend review 通过，或记录 `gemini-429-fallback=claude` 且 Claude frontend worker review 通过。
12. Windows/macOS/Linux support 只报告实际验证范围。

推荐最终验证命令：

```bash
cd frontend
npm test -- --run src/pages/SimulationView.test.tsx src/game/PhaserGame.test.ts src/game/scenes/WorldScene.test.ts src/i18n/locales.test.ts
npx tsc --noEmit -p tsconfig.app.json
npm run lint
npm run build
```

浏览器 / E2E 需要先分别启动 backend 与 preview；`release:signoff` 不会代启动服务：

```bash
# terminal 1
cd backend
source .venv/bin/activate
uvicorn --app-dir /Users/yangjunjie/Desktop/upgrade-test/backend app.main:app --host 127.0.0.1 --port 18927

# terminal 2
cd frontend
SWARM_BACKEND_URL=http://127.0.0.1:18927 npm run preview -- --host 127.0.0.1 --port 18930

# terminal 3
cd frontend
node scripts/e2e-suite.mjs corners --url http://127.0.0.1:18930 --headless --output-dir output/e2e/pixel-corners
node scripts/e2e-suite.mjs mobile --url http://127.0.0.1:18930 --headless --output-dir output/e2e/pixel-mobile
node scripts/e2e-suite.mjs cross-browser --url http://127.0.0.1:18930 --headless --output-dir output/e2e/pixel-cross-browser
node scripts/e2e-suite.mjs safari --url http://127.0.0.1:18930 --webdriver-url http://127.0.0.1:4444 --output-dir output/e2e/pixel-safari
npm run release:signoff -- --url http://127.0.0.1:18930 --backend-url http://127.0.0.1:18927 --headless
```

如涉及后端 contract 或 gameplay authority，再追加：

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_gameplay_contract.py tests/test_card_events.py tests/test_visualization_events.py -q
ruff check app/ tests/
```

## 10. Gate Report 模板

Claude 主 agent 每个阶段必须用以下格式汇总：

```text
Phase <name> Gate Report

Owner:
Workers:
Parallel groups:
Serialized write locks:
Files changed:
Commands run:
Browser evidence:
Gemini result:
Codex adversarial review:
Codex review:
Claude x Codex cross-review:
Confirmed fixed:
Warnings:
  confirmed:
  deferred:
  false positive:
OS/browser scope:
Decision: GO | CONDITIONAL GO | NO GO
Reason:
Next phase allowed: yes | no
```

## 11. NO-GO 条件

出现任一情况必须停在当前 gate：

- Theater 页面白屏、canvas blank、console error 未解释。
- `capture_game_screenshot()`、`advanceTime()` 或 `render_game_to_text()` 失效。
- i18n key/placeholder parity 失败。
- mobile 390x844 出现横向溢出或关键按钮不可达。
- WebKit desktop 无法进入 Theater 或截图链路失败。
- forced-colors 下文本/按钮不可辨认。
- 删除 HudOverlay 后没有可发现的预测入口。
- React overlay 导致每帧 React 重渲染或明显掉帧。
- Codex adversarial review 有未解决 blocker。
- Gemini 429 fallback 没有被记录且前端任务无人复核。

## 12. 文档更新门

不要自动更新 `llmdoc/`、README、CLAUDE.md 或项目文档。

最终决策步骤必须包含以下选项：

```text
使用 recorder agent 更新项目文档
```

只有用户明确确认该选项后，才调用 recorder agent，并在 prompt 中说明实际改动、真实测试命令和浏览器证据。
