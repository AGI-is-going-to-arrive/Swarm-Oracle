# SwarmOracle — Pretext 接入计划

> 文档类型：active archive
> 当前真值：否，作为独立接入计划使用；当前产品真值仍以 `README.md` 与 `llmdoc/*` 为准
> 当前时间：2026-03-30
> 状态：P0 / P1 minimal spike 已完成；P2-P5 尚未启动

> 状态更新（2026-03-30，最新）：
> - `@chenglou/pretext@0.0.3` 已安装进 `frontend/`
> - `frontend/src/lib/textLayout/pretext.ts` 与 `textOverflowPredictor.ts` 已落地
> - `ResultView / EndingChatModal / WorldlineRoundtableView` 的只读文本 contract 已接入测试层
> - 当前还没有把 `pretext` 接进运行时 transcript 布局；也没有提前推进 `P2-P5`

---

## 0. 一句话结论

`pretext` 可以接入当前项目，但不适合被当作“全面优化整个前端”的核心方案。

它更适合作为：

- `文本测量 / 预布局 / 溢出预测` 的基础设施
- `Oracle transcript / result card / share copy` 这类文本密集界面的稳定器
- `Canvas / SVG / server-side` 文本排版的可选支撑层

它不适合作为：

- 动画框架
- 流式对话框架
- 通用前端性能框架
- Oracle / Roundtable / Debate 的主交互改造手段

---

## 0.1 官方事实（核验基线）

以下结论来自官方源：

- 官方仓库：
  - [chenglou/pretext](https://github.com/chenglou/pretext)
- 官方 README：
  - [README.md](https://github.com/chenglou/pretext/blob/main/README.md)
- npm 包：
  - [@chenglou/pretext](https://www.npmjs.com/package/@chenglou/pretext)

截至本轮调研（2026-03-30）：

1. `pretext` 是一个 `Pure JavaScript/TypeScript library for multiline text measurement & layout`
2. 目标能力是：
   - 多行文本高度测量
   - 分行布局
   - DOM / Canvas / SVG / future server-side 渲染支撑
3. 它显式强调的价值是：
   - 避免 `getBoundingClientRect` / `offsetHeight` 等会触发 reflow 的 DOM 测量
   - 用浏览器字体引擎做 ground truth，再走纯算术布局
4. 当前 npm 版本：
   - `0.0.3`
5. 包导出形状：
   - 主入口 `./dist/layout.js`
   - 类型入口 `./dist/layout.d.ts`
6. README 当前主 API：
   - `prepare()`
   - `layout()`
   - `prepareWithSegments()`
   - `layoutWithLines()`
   - `walkLineRanges()`
   - `layoutNextLine()`

明确边界：

- 它不是 GSAP、Framer Motion 一类动画库
- 它不是 ProseMirror / TipTap 一类编辑器内核
- 它不是 React 组件库
- 它不会自动改善 WebSocket、流式 draft、speaker 高亮、状态机或跨端布局问题

## 0.2 当前项目里的真实观察基线

本计划不是凭空写的，下面这些现象已经通过本地 E2E / Playwright 观察确认：

1. `ResultView`
   - 多结局中文问题 + 结果卡 + action buttons 在桌面态可稳定显示
   - 长标题、长 story、长 insight 已经是明确存在的文本密集面
2. `EndingChatModal`
   - mobile 下 transcript、participant card、mode pills、composer 同屏压力很大
   - `draft -> commit` 与长文本换行仍然是最值得做稳定化的文本面
3. `WorldlineRoundtableView`
   - `live room` 与 `picker` 必须分开看
   - `live room` 可以做到首屏无页面级纵向滚动
   - `picker` 仍允许滚动，这不是同一类问题
4. `Oracle transcript`
   - 当前项目里真正高价值的文本稳定性问题集中在：
     - transcript bubble
     - draft bubble
     - result card
     - share/replay 文案

这意味着 `pretext` 的最小高价值切入点非常明确：

- 先不碰动画
- 先不碰 WS
- 先不碰全站
- 先盯住 `ResultView + EndingChatModal + WorldlineRoundtableView`

---

## 1. 当前项目适配判断

## 1.1 当前代码里真正可能受益的地方

结合当前仓库真实代码，`pretext` 最可能产生价值的地方有：

1. `Oracle transcript` 的预布局稳定
   - `frontend/src/components/EndingChatModal.tsx`
   - `frontend/src/pages/WorldlineRoundtableView.tsx`
   - 目标：在 draft -> commit、长中英混排、窄屏换行时减少抖动与意外溢出
2. `结果页` 与 `分享文案` 的溢出预测
   - `frontend/src/pages/ResultView.tsx`
   - 目标：在不改结构的前提下，提前知道哪些标题 / insight / share copy 会换行或超高
3. `输入面` 的文本高度预测
   - `frontend/src/pages/InputView.tsx`
   - 当前这里仍依赖 `scrollHeight`
   - 若后续输入区继续复杂化，`pretext` 可以替代一部分测量逻辑
4. `Phaser / Canvas` 文本排版（可选，后置）
   - `frontend/src/game/scenes/WorldScene.ts`
   - 若现有 `measureText / getBounds` 真成瓶颈，可以考虑迁移一部分布局逻辑

## 1.2 当前代码里不适合先接的地方

以下区域不应优先接 `pretext`：

1. `主模式 live 推演状态机`
   - 真正复杂的是 WS、authority、branch 状态，不是文本测量
2. `Oracle / Debate 的流式交互链路`
   - 关键问题在 `delta/commit` 时序、draft 管理、自动滚动，而不是文字测量本身
3. `speaker glow / avatar focus / atmosphere`
   - 这属于视觉层，`pretext` 不解决
4. `全站统一接管 DOM 文本布局`
   - 当前没有足够证据表明项目整体存在系统性文本测量瓶颈

## 1.3 当前结论

建议把 `pretext` 定位为：

`文本布局基础设施支线`

而不是：

`全站性能/动效主线`

## 1.4 按页面状态拆分的适配判断

为了避免“同一页面不同状态混为一谈”，这里把 `pretext` 适配面按真实 UI 状态拆开：

1. `ResultView / 结果页静态阅读态`
   - 适合
   - 原因：
     - 标题、insight、share copy、按钮标签都属于多行文本布局问题
     - 这里不牵涉 live stream contract
2. `EndingChatModal / WorldlineRoundtableView` 的 `live transcript`
   - 最适合
   - 原因：
     - draft -> commit 时更容易出现高度变化、滚动锚点漂移、长中英换行不稳定
3. `Oracle picker / reseat picker`
   - 中等适合
   - 原因：
     - 主要是卡片文案溢出和列表高度问题
     - 但它不是最值钱的痛点，优先级低于 live transcript
4. `replay readonly`
   - 适合
   - 原因：
     - 布局稳定性要求高
     - 行数/高度预测价值高
5. `mobile live-room first screen`
   - 适合，但要明确只针对 `live room`
   - 当前真实观察表明：
     - `roundtable live room` 可做到首屏无页面级纵向滚动
     - `picker` 状态依然允许滚动，这是可接受的，不应混入同一验收口径

这意味着：

- `pretext` 第一阶段优先服务 `static result + live transcript + replay readonly`
- 不应把 `picker` 或 `主模式 simulation` 当成先行接入点

---

## 2. 与当前主线的关系

当前项目推荐推进顺序已经明确：

1. `Phase G`
   - persona vocabulary / theme atmosphere 深化
2. `replay / share / import`
   - Oracle 最终签收
3. `trait_mix / fault_line_first / witness_augmented`
   - 作为 roundtable 扩展桌型继续推进

`pretext` 接入不应打断上面这条主线。

正确定位是：

- `P0 / P1` 可以作为并行调研支线
- 真正需要更深接入时，再插入到 `replay/share/import` 之后
- 不应先于 Oracle 主链签收去大范围重构文本层

推荐排序：

1. 完成 `Phase G`
2. 完成 `replay / share / import`
3. 做 `pretext P0 / P1`
4. 若 `P1` 证明有收益，再做 `P2`
5. 最后继续 `trait_mix / fault_line_first / witness_augmented`

本轮实际执行结果：

1. `Phase G`
   - 已完成
2. `replay / share / import`
   - 已完成专项签收
3. `pretext P0 / P1`
   - 已完成最小 spike
4. `P2-P5`
   - 尚未启动

---

## 3. 分阶段接入计划

## P0 — Research Spike

> 当前状态：已完成

### 目标

验证 `pretext` 在当前仓库里是否能稳定跑起来，以及它与现有字体/line-height 契约是否可对齐。

### 范围

- 安装 `@chenglou/pretext`
- 新增一个轻量封装：
  - `frontend/src/lib/textLayout/pretext.ts`
- 不接入业务 UI，只做本地实验

### 开发前提

在真正安装依赖前，先锁定下面三件事：

1. 包管理器策略
   - 当前 `frontend/` 有 npm scripts，但没有 lockfile
   - 在正式接入前，先统一本仓库这条线用哪一个包管理器，不要混着写
2. 字体契约
   - `font`
   - `line-height`
   - `white-space`
   这三项必须和真实 CSS 一致，否则测量结果不可信
3. 状态边界
   - P0 只验证 `静态文本` 与 `纯预测`
   - 不碰 `WS / store / live contract`

### 输出

- 基础封装：
  - `prepareText()`
  - `measureParagraph()`
  - `clearPretextCache()`
- 最小实验页面或脚本：
  - 中文
  - 英文
  - emoji
  - mixed bidi
  - `pre-wrap`

### 验收

- 运行稳定
- 与浏览器真实渲染高度误差可接受
- 明确字体同步规则：
  - font shorthand
  - line-height
  - white-space

### 风险

- 当前版本仍早期（`0.0.3`）
- `system-ui` 在 macOS 上官方明确标记为 unsafe

---

## P1 — Read-Only 预测层接入

> 当前状态：已完成

### 目标

让 `pretext` 先进入“只读预测层”，不直接接管渲染。

### 范围

优先接入：

1. `ResultView`
   - 预测 title / insight / share copy 是否会过高或超多行
2. `EndingChatModal`
   - 预测 draft / committed bubble 的理论高度
3. `WorldlineRoundtableView`
   - 预测 transcript item 的换行数量和滚动锚点变化

### 方式

- 先只做：
  - debug 数据
  - test helper
  - overflow contract
- 不直接替换现有 DOM 样式计算

### 输出

- `frontend/src/lib/textLayout/textOverflowPredictor.ts`
- 若干测试辅助：
  - `estimateBubbleHeight(...)`
  - `estimateLineCount(...)`

### 验收

- 不改变现有视觉与行为
- 测试里能稳定捕捉高风险溢出
- i18n 长文案在 CI 里有可执行 contract

---

## P2 — Oracle Transcript 稳定化

> 当前状态：已完成（Oracle transcript scoped）

### 目标

把 `pretext` 的收益用到 Oracle 最值钱的文本面：`transcript` 与 `draft bubble`。

### 范围

- `frontend/src/components/EndingChatModal.tsx`
- `frontend/src/pages/WorldlineRoundtableView.tsx`

### 做法

1. 在 draft 产生时先用 `pretext` 估算高度
2. 为 transcript list 提供更稳定的滚动锚点
3. 在长文本情况下减少 layout jump
4. 把 transcript layout telemetry 直接落到 automation payload / E2E summary，方便签收

### 不做的事

- 不改成 Canvas transcript
- 不取代现有 DOM 渲染
- 不重写 store / WS contract
- 不改变 speaker glow / avatar emphasis / active speaker 视觉结构

### 验收

- draft -> commit 过程中布局抖动下降
- 中英长文本换行更稳定
- 自动滚动更少出现“刚滚到底又被顶起”的体感问题
- `ending-room / roundtable` 的签收工件里可以直接看到 `transcript_layout`

### 当前落地说明

- 已落范围：
  - `frontend/src/components/EndingChatModal.tsx`
  - `frontend/src/pages/WorldlineRoundtableView.tsx`
  - `frontend/src/lib/textLayout/oracleTranscriptLayout.ts`
- 已落签收工件：
  - `frontend/output/e2e/20260331-codex-p2-signoff-ending-room/summary.json`
  - `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-desktop/summary.json`
  - `frontend/output/e2e/20260331-codex-p2-signoff-roundtable-mobile/summary.json`
- 未扩范围：
  - `InputView`
  - `WorldScene / Theater`

---

## P3 — Input / Authoring 面

> 当前状态：未开始

### 目标

降低输入文本面依赖 `scrollHeight` 的程度。

### 范围

- `frontend/src/pages/InputView.tsx`
- 可能的分享文案编辑框

### 做法

- 用 `pretext` 预测 textarea 高度
- 只在预测不可靠时再回退 DOM 测量

### 验收

- 长输入不会频繁抖动
- 中英切换时 autosize 更稳

### 优先级

低于 `P2`

---

## P4 — Canvas / Theater 可选桥接

> 当前状态：未开始

### 目标

只在证明 Phaser 文本布局是实际瓶颈时，再把 `pretext` 引入 Canvas 文本面。

### 范围

- `frontend/src/game/scenes/WorldScene.ts`

### 适用场景

- 气泡文本排版
- 复杂多语言文本边界
- 减少 `measureText/getBounds` 的重复调用

### 风险

- 集成复杂度高
- 字体同步困难
- 视觉一致性风险高

### 结论

默认不做，除非前面阶段已经证明收益非常明确。

---

## P5 — QA / CI 文本契约

> 当前状态：未开始

### 目标

把 `pretext` 变成质量门，而不只是运行时工具。

### 范围

- 组件测试
- i18n 溢出检查
- 关键按钮 / 卡片标题 / quote 的最大行数契约

### 价值

这一步和当前项目最契合，因为它直接服务于：

- 中英双语正确
- 移动端可玩
- replay/share 文案不破版

### 输出

- 文本 contract 测试
- 高风险文案清单
- 失败时给出具体组件/文案路径

---

## 4. 建议接入点清单

## 4.1 第一批（推荐）

- `frontend/src/lib/textLayout/pretext.ts`
- `frontend/src/lib/textLayout/textOverflowPredictor.ts`
- `frontend/src/components/EndingChatModal.tsx`
- `frontend/src/pages/WorldlineRoundtableView.tsx`
- `frontend/src/pages/ResultView.tsx`

## 4.2 第二批（可选）

- `frontend/src/pages/InputView.tsx`
- `frontend/src/components/ShareModal.tsx`

## 4.3 第三批（后置）

- `frontend/src/game/scenes/WorldScene.ts`

---

## 5. 非目标

以下内容不属于 `pretext` 接入任务：

1. 重写 Oracle / Debate 视觉系统
2. 替代 GSAP 或现有 CSS animation
3. 解决 WS 时序与状态同步问题
4. 直接提升 Oracle persona 质量
5. 替代 replay/share/import 主链签收

---

## 6. 开发 / Review / 测试合同

## 6.1 开发原则

1. 先接 `lib`，再接页面
   - `pretext` 封装必须先稳定成纯函数 helper
2. 先读预测，后读写影响
   - 第一阶段只允许影响：
     - debug 信息
     - overflow contract
     - 高度预估
   - 不允许直接改现有 store 口径
3. 同一个文本面，先加“比对模式”
   - 先保留 DOM 真实渲染
   - 再叠加 `pretext estimate`
   - 二者偏差可观测后，才能进一步放大接入

## 6.2 Code Review Checklist

每次推进 `pretext` 接入时，review 至少覆盖：

1. 是否只改了文本测量/预布局，而没有顺手改业务状态机
2. 是否把 `font / line-height / white-space` 明确绑定在同一处
3. 是否把 `prepare()` 和 `layout()` 的职责分离，避免热路径重复 prepare
4. 是否对：
   - 中文
   - 英文
   - emoji
   - mixed bidi
   - `pre-wrap`
   都有测试
5. 是否提供回退逻辑
   - `pretext` 估算失败时，页面仍能正常按现有 DOM 路径工作
6. 是否避免把 `pretext` 误扩展到：
   - speaker animation
   - WS stream logic
   - Oracle 文案生成

## 6.3 单元 / 集成测试矩阵

### 单元测试

- `frontend/src/lib/textLayout/pretext.test.ts`
  - API smoke
  - locale / cache
  - multiline height
  - `pre-wrap`
- `frontend/src/lib/textLayout/textOverflowPredictor.test.ts`
  - title / chip / quote / bubble 预测

### 页面级测试

- `frontend/src/pages/ResultView.test.tsx`
  - 长标题 / 长 insight / share copy 是否进入预警或预测分支
- `frontend/src/components/EndingChatModal.test.tsx`
  - draft / committed bubble 的预估高度与滚动锚点
- `frontend/src/pages/WorldlineRoundtableView.test.tsx`
  - transcript item、高亮状态、mobile live-room first screen

## 6.4 E2E 计划

当前仓库已经有现成的高价值脚本，应直接复用：

```bash
cd frontend
node scripts/e2e-ending-room-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/pretext-ending-room-full --headless
node scripts/e2e-ending-room-followup-suite.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/pretext-ending-room-followup-full --headless
node scripts/e2e-worldline-roundtable-suite.mjs full --url http://127.0.0.1:18928 --backend-url http://127.0.0.1:18927 --output-dir output/e2e/pretext-roundtable-full --headless
node scripts/e2e-suite.mjs cross-browser --url http://127.0.0.1:18928 --output-dir output/e2e/pretext-cross-browser --headless
```

E2E 必测状态：

1. `ResultView`
   - 长问题
   - 长 branch title
   - 长 insight
2. `EndingChatModal`
   - live
   - hotseat
   - all_present
   - replay readonly
3. `WorldlineRoundtableView`
   - picker
   - live room
   - replay readonly
   - mobile first screen

## 6.5 Playwright Interactive / CLI 观察口径

除了项目脚本，建议每轮至少补两种人工观察：

1. `Playwright CLI`
   - 用于抓当前页面 snapshot
   - 检查长标题、按钮标签、结局卡和 insight 的真实文本分布
2. `playwright-interactive`
   - 用于长期持有桌面 / 移动端页面
   - 观察：
     - draft -> commit 是否跳动
     - mobile live-room 首屏 composer 是否可见
     - 中英切换后按钮/标签是否出现新溢出

这两层人工观察应直接写回 `progress.md` 和 E2E 工件目录。

---

## 6. 风险与约束

## 6.1 技术风险

1. 当前 npm 版本较早
2. 字体 shorthand 若与真实 CSS 不一致，会导致测量漂移
3. 官方已明确：
   - `system-ui` 在 macOS 上对 `layout()` 不安全
4. 项目若继续大量使用 DOM 自动流式布局，`pretext` 的收益会被削弱

## 6.2 产品风险

1. 误把 `pretext` 当“全站优化银弹”
2. 为了接入 `pretext` 提前重写大量文本组件
3. 在主链未签收前开启大面积文本层改造

---

## 7. 推荐执行顺序

推荐真正执行时，按下面顺序走：

1. `Phase G` 完整收口
2. `replay / share / import` 最终签收
3. `pretext P0`
4. `pretext P1`
5. 若 `P1` 证明收益明确，再做 `P2`
6. 继续 `trait_mix / fault_line_first / witness_augmented`

---

## 8. 立即可执行的下一步

如果下一轮要正式开始 `pretext`，建议只做下面这个最小切片：

### Step 1

新增：

```text
frontend/src/lib/textLayout/pretext.ts
frontend/src/lib/textLayout/pretext.test.ts
```

### Step 2

在测试中验证：

- 中文长句
- 英文长句
- emoji
- `whiteSpace: pre-wrap`

### Step 3

把它只接到：

- `EndingChatModal` 的 transcript 高度预测 helper

而不是先碰全站

### Step 4

直接复用当前 E2E/Playwright 口径采证：

- `output/e2e/pretext-ending-room-full`
- `output/e2e/pretext-roundtable-full`
- `output/playwright/`

把以下证据都留档：

1. 同一条 transcript 在：
   - 中文
   - 英文
   - 长文本
   - draft 中
   的高度预测结果
2. DOM 实际高度与 `pretext` 预测高度的偏差
3. 偏差超过阈值时的具体组件与字体设置

---

## 9. 最终建议

`pretext` 值得接，但应该被当作：

`文本布局与 QA 的基础设施支线`

而不是：

`当前主线产品优化的总方案`

当前主线仍然应当是：

- Oracle persona / atmosphere
- replay/share/import 最终签收
- 后续扩展桌型

在这条主线稳定后，再让 `pretext` 去增强文本稳定性与 i18n 质量门，收益最高、返工最少。
