# SwarmOracle Frontend — 全面代码审查报告

> 对应会话: 前端 Bug 修复 (416d832a)

**范围**: 全部 27 个前端源文件（Week 1–4），覆盖 types, stores, hooks, animations, API, i18n, pages, components.

**构建状态**: ✅ TypeScript `--noEmit` 通过 | ✅ Vite production build 通过

---

## 🔴 Critical Bugs (3)

### C-1: 14 个未定义 CSS 变量被引用

Impeccable 重设计删除了旧变量，但组件 CSS 未更新。

| 缺失变量 | 使用位置 | 修复 |
|---|---|---|
| `--bg-deep` | SimulationView, BranchTree, BranchNode, AgentPanel | → `var(--bg-base)` |
| `--glass-bg` | BranchNode | → `var(--bg-surface)` |
| `--glass-border` | BranchNode | → `var(--border-default)` |
| `--glow-primary` | BranchNode | → `var(--shadow-elevated)` |
| `--text-bright` | BranchNode | → `var(--text-primary)` |
| `--color-accent` | BranchNode, AgentPanel | → `var(--color-primary-dim)` |
| `--color-primary-glow` | BranchNode, AgentPanel, TimelineBar | → `oklch(55% 0.22 350 / 0.1)` |

**影响**: 分支节点、边、时间轴、Agent 面板的文字/背景/边框全部透明不可见。

**修复**: 在 `index.css` 中添加 7 个兼容性别名。

### C-2: 缺少 `@keyframes glowPulse`

**修复**: 在 `index.css` 中定义微妙的 opacity 脉冲动画。

### C-3: 缺少 `@keyframes breathe`

**修复**: 在 `index.css` 中定义微妙的 opacity 呼吸动画。

---

## 🟡 Medium Bugs (6)

| ID | 问题 | 文件 | 修复 |
|----|------|------|------|
| M-1 | Typewriter 效果闭包陈旧 | `InputView.tsx` | 低严重度，切换语言时短暂闪烁 |
| M-2 | StrictMode 下 `animateNodeAppear` 不执行 | `BranchNode.tsx` | cleanup 中重置 `animated.current = false` |
| M-3 | `handleWSEvent` Selector 稳定性 | `useSimulationWS.ts` | Zustand v5 返回稳定引用，已安全 |
| M-4 | WS 事件在 REST 完成前到达 | `SimulationView.tsx` | 短暂显示 agent ID 而非名字，自行修正 |
| M-5 | `healthCheck` 使用 POST 而非 GET | `client.ts` | 后端问题 |
| M-6 | Status badge 逻辑不完整 | `SimulationView.tsx` | 只有 `done` → completed，其它 → running |

---

## 🟢 Low / Style Issues (11)

| ID | 问题 | 修复 |
|----|------|------|
| L-1 | `.btn-ghost` 类缺失 | 在 `index.css` 中添加 |
| L-2 | `branchAnimations.ts` 硬编码赛博朋克色 | 替换为中性灰 |
| L-3 | `BranchEdge.tsx` 硬编码霓虹色 | 替换为编辑风灰色调 |
| L-4 | MiniMap 硬编码颜色 | 替换为 `#444`/`#888`/`#ccc` |
| L-5 | QuickStartCards 赛博朋克渐变 | 切换为 OKLCH 微妙色调 |
| L-6 | Error 背景硬编码 rgba | 使用 OKLCH danger 颜色 |
| L-7 | HTML `<title>` 为 "frontend" | 改为 "SwarmOracle" |
| L-9 | 无 404 路由 | 添加 `<Route path="*">` 重定向到首页 |
| L-10 | `.emotion-badge` 类缺失 | 需定义 |
| L-11 | `@keyframes spin` 重复定义 | 冗余但无害 |
| — | 缺少 badge 工具类 | 添加 `.badge`, `.badge-active`, `.badge-pruned` |

---

## 验证

- ✅ TypeScript: `tsc --noEmit` → 0 errors
- ✅ Vite Build: 635 kB JS (gzip 214 kB), 32 kB CSS (gzip 6.4 kB)
- ✅ 首页加载 Impeccable 编辑风美学
- ✅ 打字机动画流畅
- ✅ 6 张 QuickStartCards 渲染正确
- ✅ 中英文切换实时生效
- ✅ 404 路由重定向到首页
