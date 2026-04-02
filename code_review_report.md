# SwarmOracle 全面代码审查 & E2E 测试报告

**日期**: 2026-04-01
**审查范围**: 前端 (React/Phaser) + 后端 (FastAPI) + E2E 全流程

---

## 1. 测试结果总览

| 测试类别 | 状态 | 详情 |
|---------|------|------|
| 后端 pytest | 1237 passed, 4 failed | 3 个需要 LLM 服务(环境), 1 个 rate limit bug 已修复 |
| 前端 vitest | 71 files, 656 tests passed | 全部通过 |
| TypeScript 类型检查 | 通过 | 无错误 |
| E2E 首页 | 通过 | 所有控件、每日挑战、快速开始正常 |
| E2E 推演 | 通过 | 3 Agent x 3 轮, 100% 完成, 0 error |
| E2E 结果页 | 通过 | 因果档案、导演生涯、Agent 列表正常 |
| E2E Oracle Chamber | **已修复** | 无限 re-render 循环 -> 修复后 0 error |
| E2E 辩论竞技场 | 通过 | 5 阶段完整流程, 评委判词, 0 error |
| E2E 历史页 | 通过 | 134 页分页, 过滤器正常, 0 error |
| E2E 排行榜 | 通过 | 预言家排名正常显示, 0 error |

---

## 2. 已修复的 Bug

### Critical: Oracle Chamber 无限 Re-render 循环
- **文件**: `frontend/src/components/EndingChatModal.tsx`, `frontend/src/pages/ResultView.tsx`
- **症状**: 打开 Oracle Chamber 后产生 190+ "Maximum update depth exceeded" error
- **根因**: `EndingChatModal` 的 automation effect (line 650-717) 每次 deps 变化都调用 `setEndingRoomAutomation({...})`, 创建新对象触发 ResultView re-render, 形成 store -> effect -> setState -> re-render -> store 循环
- **修复**:
  1. ResultView 中将 `endingRoomAutomation` 从 `useState` 改为 `useRef` (不触发 re-render)
  2. EndingChatModal 中添加 JSON 序列化去重, 仅在状态实际变化时调用 callback

### Major: LLM Request-Scoped Rate Limits 未生效
- **文件**: `backend/app/services/llm_client.py:1151`
- **症状**: `llm_request_scope(requests_per_minute=1, ...)` 设置后, 第二个请求未被拒绝而是等待窗口重置后成功
- **根因**: 当 scope 限制触发 `LLMRateLimitWindowError` 时, 代码进入等待重试而非立即拒绝
- **修复**: 检测到 scope overrides 时立即 raise `LLMBackpressureError`, 不等待

---

## 3. 美术素材审计

| 类别 | 数量 | 覆盖率 |
|------|------|--------|
| 场景背景 | 76 PNG (33+ 场景 + 变体) | 100% |
| 角色精灵 | 25 (alchemist -> witch) | 100% |
| 特效动画 | 14 (分支/辩论/地震等) | 100% |
| 结局场景 | 6 (peace/prosperity/revolution/ruin/tyranny/war) | 100% |
| UI 核心 | 10 (按钮/面板/对话框等) | 100% |
| UI 生成 | 98 (卡框/徽章/面板等) | 100% |
| 玩法画像卡框 | 18/18 | 100% |
| 辩论 UI | 6/6 (横幅/计分/徽章等) | 100% |
| Oracle/Roundtable UI | 15/15 | 100% |

**结论**: 美术素材覆盖充足, 所有 ASSET_MANIFEST 引用的资源均存在。18 个 gameplay profile 全部有专属卡框。

---

## 4. 功能实现验证

| 功能 | 状态 | 验证方式 |
|------|------|---------|
| 主推演 (黑板/原始模式) | 实现 | E2E + unit |
| 像素剧场 | 实现 | E2E 截图可见小地图 |
| 辩论竞技场 | 实现 | E2E 完整 5 阶段 |
| Oracle Chamber (结局会客厅) | 实现 | E2E + bug 修复 |
| Worldline Roundtable | 实现 | 路由 + 组件存在 |
| Crossline Gallery | 实现 | 代码 + 测试 |
| One Move Only | 实现 | 代码 + 测试 |
| Follow-up 追问线程 | 实现 | 单元测试 |
| 导演生涯进展 | 实现 | E2E 截图 |
| 每日挑战 | 实现 | 首页 UI + 代码 |
| 排行榜 | 实现 | E2E |
| 历史记录 | 实现 | E2E |
| 预测下注 | 实现 | 单元测试 |
| 分享/回放/导入 | 实现 | 单元测试 |
| i18n (中/英) | 实现 | E2E 语言切换 |
| Pretext P0-P5 | 实现 | 单元测试 |
| 后续三回合 (epilogue) | 实现 | 代码存在 |
| 证据投牌 (evidence_card) | 实现 | 代码存在 |
| 混合流式 (stream probe + fallback) | 实现 | 代码 + 测试 |

---

## 5. Console Error 分析

| 错误 | 严重性 | 说明 |
|------|--------|------|
| 409 director-state | Low | 推演刚创建时导演状态未就绪, 前端已有 fallback |
| 404 summary | Low | 需要 LLM 生成叙事摘要, 无 LLM 时使用简化摘要 |

---

## 6. 修改文件清单

1. `backend/app/services/llm_client.py` -- rate limit scope 立即拒绝
2. `frontend/src/components/EndingChatModal.tsx` -- automation effect 去重 + ref guard
3. `frontend/src/pages/ResultView.tsx` -- endingRoomAutomation useState -> useRef
4. `backend/app/api/ending_rooms.py` -- 列表/字符串字段添加 max_length 防 DOS

## 7. 深度审查代理发现 (未修复 - 建议跟进)

### 后端 (Major)
- simulator.py run_simulation() 缺少顶层 try-except (CRITICAL)
- LLM streaming 响应无大小限制 (MAJOR)
- SQLite 隔离级别未显式设置 (MAJOR)

### 前端 (Major)
- PhaserGame.tsx useEffect 依赖数组可能缺失变量 (需验证)
- API client 缺少 AbortController 支持 (MAJOR)
- 路由参数无 UUID 格式验证 (MAJOR)
- z-index 无统一管理系统 (MINOR)
- 部分交互元素缺少 ARIA 标签 (MINOR)
