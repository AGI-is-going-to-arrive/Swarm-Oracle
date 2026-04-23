# P0-1 / P0-2 最终审查报告

> 审查日期: 2026-04-24
> 基线 commit: `0d1ef9f`
> 相关前端代码范围: 9 files, +1021/-59 lines
> 当前真值口径: 以当前 worktree、当前 session 实测结果、真实浏览器复核为准

---

## Phase 1: 基线验证

| 检查项 | 状态 | 数据 |
|--------|------|------|
| git diff | PASS | 9 files, +1021/-59 lines |
| 定向 vitest | **PASS** | 3 files / 124 passed |
| 全量 vitest | **PASS** | 142 files / 1365 passed |
| ESLint (目标文件) | **PASS** | `ResultView / CausalReviewView / locales.test.ts` 零新增问题 |
| TypeScript | **PASS** | `tsc --noEmit -p tsconfig.app.json` clean |
| Build | **PASS** | `vite build` + `perf:budgets:check` clean |
| Playwright 浏览器复核 | **PASS** | ResultView bridge / CausalReview guide，console clean |

---

## Phase 2: 当前真值复核

### Findings 复核结论

| # | 原发现 | 当前状态 | 说明 |
|---|--------|----------|------|
| **F1** | Disabled bridge card `<a>` 无 `href` 语义问题 | **已收口** | disabled bridge 当前改为 `<div role="link" aria-disabled="true">`，不再渲染无 `href` 的 `<a>` |
| **F2** | Guide panel close button 缺 `aria-expanded={true}` + `aria-controls` | **已收口** | close / show 两个按钮现在都带完整 disclosure 语义 |
| **F3** | Guide panel `#666/#777` 对比度不达标 | **已收口** | guide / empty-state 文案当前改走 `CAUSAL_COLORS`，正文色达到 AA 口径 |
| **F4** | `causalGuideKeys` 漏 `empty_guide` | **已收口** | `locales.test.ts` 已补 parity 覆盖 |
| **F5** | Disabled bridge `opacity: 0.65` 拉低文字对比度 | **已收口** | disabled 卡片不再用整卡 opacity，改为 dashed border + icon grayscale，文字颜色单独保持可读 |
| **F6** | `capLoading=true` 时 bridge 隐藏行为未覆盖 | **已收口** | `ResultView.test.tsx` 已补 loading 态不渲染 bridge 的测试 |
| **F7** | Guide close 测试未断言 aria 状态 | **已收口** | `CausalReviewView.test.tsx` 已补 `aria-expanded / aria-controls` 断言 |
| **F8** | `factionTimelineLead` 用 `isZh` 三元而非 `t()` | **已收口** | faction timeline lead 已改为 i18n key + `{{title}}` 插值 |
| **F9** | Header CTA 与 bridge card URL 编码不一致 | **已收口** | ResultView 现有 causal / compare CTA 与 bridge 链接都已统一 `encodeURIComponent()` |
| **F10** | `guideStats` 内部 `.find()` 为 O(K*N) | **已收口** | `guideStats` 已改为 `nodeById` Map，避免在 key-node 映射里重复线性查找 |

### 当前残留说明

- 这轮 `CausalReviewView` 的颜色已经集中到组件内 `CAUSAL_COLORS`。
- 目前没有新的 bridge / guide 阻塞项。
- `CAUSAL_COLORS` 仍是组件内局部 palette，不是全局 design token，这属于后续统一设计系统工作，不是本轮阻塞。

---

## Phase 3: 浏览器复核

| 测试项 | 结果 | 详情 |
|--------|:----:|------|
| **ResultView bridge card 渲染** | PASS | H2 `Explore Deeper` 可见，3 张卡片都正常渲染 |
| **Disabled bridge 卡片语义** | PASS | disabled 卡片为 `DIV role="link" aria-disabled="true"`，不是无 `href` 的 `<a>` |
| **Disabled bridge 样式** | PASS | dashed border、生效的 `not-allowed` cursor、icon grayscale；整卡不再走 opacity 压低文本对比度 |
| **FactionTimeline 文案** | PASS | 实际显示 `t()` 结果，分支标题通过 `{{title}}` 正常插值 |
| **CausalReview guide disclosure** | PASS | close / show 两个按钮都带正确的 `aria-expanded / aria-controls` |
| **CausalReview guide 可读性** | PASS | guide / empty-state 提示文案使用新的 token 色，浏览器复核通过 |
| **Console errors** | PASS | 真实浏览器 fixture 复核无意外 console 错误 |

**浏览器复核工件**

- `frontend/output/playwright/p0-result-bridge-faction.png`
- `frontend/output/playwright/p0-causal-guide.png`

---

## 修复结果清单

| 文件 | 变更 |
|------|------|
| `frontend/src/pages/ResultView.tsx` | disabled bridge 语义修正；Result CTA / compare 链接统一编码；FactionTimeline 文案改走 i18n 插值 |
| `frontend/src/pages/ResultView.css` | disabled bridge 改为 dashed border + icon grayscale；文字对比不再依赖整卡 opacity |
| `frontend/src/pages/CausalReviewView.tsx` | 新增 `CAUSAL_COLORS`；guide / empty-state 文案颜色和 disclosure 语义收口；`guideStats` 查找改为 Map |
| `frontend/src/i18n/locales/en.json` / `zh.json` | 新增 faction timeline 相关 key，en/zh 口径一致 |
| `frontend/src/pages/ResultView.test.tsx` | 补 capLoading、URL encode、disabled card 语义回归 |
| `frontend/src/pages/CausalReviewView.test.tsx` | 补 guide aria 状态和空态引导文案回归 |
| `frontend/src/i18n/locales.test.ts` | bridge / guide / faction timeline locale parity 收口 |

---

## Phase 6: 最终签收表

| 检查项 | 状态 | 备注 |
|--------|:----:|------|
| 定向 vitest | **PASS** | 124 passed |
| 全量 vitest | **PASS** | 1365 passed |
| ESLint (目标文件) | **PASS** | 零新增问题 |
| TypeScript | **PASS** | clean |
| Build + perf budget | **PASS** | clean |
| Playwright 浏览器复核 | **PASS** | bridge / guide DOM、样式、文案、console 全部通过 |
| **本轮 findings 全部收口** | **YES** | bridge / guide / i18n / encode / test gap 均已落地 |

### 结论

这轮 P0-1 / P0-2 相关问题已经收口，可以和当前代码一起提交。

---

## 修复后验证命令

```bash
cd frontend
npm test -- --run src/pages/ResultView.test.tsx src/pages/CausalReviewView.test.tsx src/i18n/locales.test.ts
npm test
npm exec -- eslint src/pages/ResultView.tsx src/pages/ResultView.test.tsx src/pages/CausalReviewView.tsx src/pages/CausalReviewView.test.tsx src/i18n/locales.test.ts
npm exec -- tsc --noEmit -p tsconfig.app.json
npm run build
```
