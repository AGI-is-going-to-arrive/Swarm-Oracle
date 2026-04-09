# Phase 3 Backlog — 当前真值

> 最后更新：2026-04-10 (af5ba40 + cfd2d44 后)
> 维护规则：只记"还没做完的事"，完成后删除对应行。不要追加历史流水。

## 已完成的基座

以下阶段已全部交付，不再是 backlog：

- A0-E + Wiring Remediation：核心阶段全部 DONE
- P0 全部 (P0-1~P0-5)：接线到生产路径
- X-5：ownership 校验（局部改进，非完整 IDOR）
- X-2 + P1-13：i18n gate 消息补全
- X-1：Campaign API endpoints（已成型，有完整路由 + 测试）

## 剩余项

### Review follow-up

| # | 问题 | 风险 | 现状 |
|---|------|------|------|
| M-2 | `factions.process_round()` 同步 DB I/O 在 async event loop 中 | 中 | 预存问题，`simulator.py:1140` → `factions.py:32`。应移到 `asyncio.to_thread` 或拆异步持久化 |
| M-4 | WorldScene faction tween budget 用局部计数 | 低 | `WorldScene.ts:890` 局部 `tweenCount`，非全局 `getTweens().length`。每轮只触发一次，实际低风险 |

### 缺 UX/可视化壳（底层已有实现）

这些功能的后端服务和数据模型已就绪，缺的是前端 UX 壳或可视化增强。

| # | 项目 | 已有底座 | 缺什么 |
|---|------|---------|--------|
| P1-1 | AgentProfileModal | `agent_identity.py` 服务 + `/api/agents/identities/{id}/memory` 端点 + `agentStore` | 弹窗组件（展示单个 agent 跨场景记忆时间线） |
| P1-2 | MemoryTimeline | 同 P1-1 底座 | 按场景分段的垂直时间线组件 |
| P1-5 | LiveArgumentMap | `debate_argument_map.py` 服务 + ArgumentMap 组件 + rule-based extraction | DebateArenaView 实时侧边面板（当前仅在 DebateResultView 展示） |
| P1-6 | @xyflow/react 替代 ArgumentMap | ArgumentMap HTML tree 已可用 | 用 @xyflow DAG 可视化替代当前 HTML tree 渲染 |
| P1-7 | ArgumentStrengthMeter | argument unit 有 status 字段 | 节点内进度条组件 |
| P1-8 | TranscriptFactionOverlay | FactionTimeline 组件 + `factions.py` 服务 + WS 事件 | Roundtable/密室发言旁阵营色标叠加 |

### 缺 Playwright E2E

| # | 项目 | 现状 |
|---|------|------|
| X-3 | Phase 3 六大功能缺 Playwright E2E | 已有单测 + 契约测试覆盖，但无端到端浏览器级场景脚本 |
| X-4 | 旧 replay import 空状态 | 旧 replay 无 graph/faction/argument 数据时前端 empty state 需人工验证 |

### 长期增强（零代码）

| # | 项目 | 说明 |
|---|------|------|
| P1-3 | Graph 导出图片 | CausalReviewView 导出 PNG/SVG（ExportPanel） |
| P1-4 | Graph 节点点击展开 | 因果图节点详情面板 |
| P1-9 | `resume_from_round` 参数 | simulator 从中间轮次恢复（当前仅 clone+re-run） |
| P1-10 | Continuity Key L2/L3 匹配 | L2 ChromaDB embedding cosine > 0.85 + L3 前端确认（当前仅 L1 hash） |
| P1-11 | LLM enrichment (stance/argument) | rule-based → LLM 可选增强 |
| P1-12 | Identity memory compaction | 每 10 场景摘要压缩同一 identity 的记忆 |

### v1.1 延后

| # | 项目 | 延后理由 |
|---|------|---------|
| P2-1 | @dnd-kit/core 拖拽注入 Agent | 当前走 selectable attach |
| P2-2 | 双 Phaser split-screen compare | 当前走文本 diff，双实例内存翻倍 |
| P2-3 | LLM scheduling isolation | 需独立 semaphore refactor |

## 架构级已知限制

| 问题 | 说明 |
|------|------|
| 无服务端 auth principal | ownership guard 仍依赖客户端自报 `user_id`，非完整 IDOR 修复。待独立 auth 重构 |
| test_p0_wiring.py 覆盖定位 | 定向回归保护，非全链路端到端入口验证 |
