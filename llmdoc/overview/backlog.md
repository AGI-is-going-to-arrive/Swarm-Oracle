# Phase 3 Backlog — 当前真值

> 最后更新：2026-04-10 (P1-3/P1-4 交付后)
> 维护规则：只记"还没做完的事"，完成后删除对应行。不要追加历史流水。

## 已完成的基座

以下阶段已全部交付，不再是 backlog：

- A0-E + Wiring Remediation：核心阶段全部 DONE
- P0 全部 (P0-1~P0-5)：接线到生产路径
- X-5：ownership 校验（局部改进，非完整 IDOR）
- X-2 + P1-13：i18n gate 消息补全
- X-1：Campaign API endpoints（已成型，有完整路由 + 测试）
- M-2：factions/causal_graph/checkpoint hooks 已迁移到 asyncio.to_thread (20 tests)
- M-4：WorldScene tween budget 已改用全局 getTweens().length
- P1-1/P1-2：AgentProfileModal + MemoryTimeline (dialog + timeline + 新 growth-events 端点)
- P1-5：LiveArgumentMap (DebateArenaView collapsible sidebar, auto-refresh on turn)
- P1-6：ArgumentMap 升级为 @xyflow/react DAG (ReactFlow + dagre layout)
- P1-7：ArgumentStrengthMeter (status distribution stacked bar)
- P1-8：TranscriptFactionOverlay (FactionBadge + useFactionOverlay hook, integrated in RoundtableTranscriptList + EndingChatModal)
- X-3：Phase 3 六大功能 Playwright E2E（Batch A/B 脚本）
- X-4：旧 replay import 空状态回归测试
- P1-3：Graph 导出图片 — ExportPanel (PNG html2canvas + SVG foreignObject clone)，集成 CausalReviewView + ArgumentMap
- P1-4：Graph 节点点击展开 — NodeDetailPanel (type/round/payload/unit details)，onNodeClick + selectedNode reset on re-fetch

## 剩余项

### 长期增强

| # | 项目 | 说明 |
|---|------|------|
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
