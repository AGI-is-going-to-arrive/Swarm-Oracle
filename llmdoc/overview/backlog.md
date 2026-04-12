# Phase 3 Backlog — 当前真值

> 最后更新：2026-04-13
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
- P1-9：resume_from_round — POST /resume + Blackboard export/from_snapshot + checkpoint bug fix + agent in-memory restore + runtime lock guard + ResultView `ResumePanel` / `resumeFromRound()` 前端接线 + `ResumePanel.test.tsx / ResultView.test.tsx / i18n/locales.test.ts` + `e2e-phase3-batch-c.mjs` smoke 覆盖 (16 BE tests)
- P1-12：Identity memory compaction — FEATURE_IDENTITY_COMPACTION + LLM 摘要 + source_ids_hash 幂等 + FIFO raw-first eviction + format_untrusted_text_block 防注入 (15 BE tests)
- P1-10：Continuity Key L2/L3 匹配 — `POST /api/agents/identities/preflight` + InputView confirm dialog + `continuity_overrides`；`create_new` 可跳过 L2 fuzzy reuse，`reuse_existing` 会校验 identity 归属；`resolve_identity()` 已改为可复用外层 session，避免 scenario parse 路径撞到 SQLite `database is locked`
- P1-11：LLM enrichment (stance/argument) — debate argument map 继续保留 rule-based 抽取，同时默认追加每个 debate turn 一次 fire-and-forget LLM enrichment；provider 失败时自动回退纯规则结果

## 剩余项

当前无 active Phase 3 backlog。

## 架构级已知限制

| 问题 | 说明 |
|------|------|
| auth/ownership 仍非最终方案 | 当前已有 signed principal token 与局部 owner 收口；本轮又补了 `scenario WS` owner 校验、compare branch 归属校验与 scenario 删除时的 artifact 清理，但还不是完整 JWT/OAuth2 + per-resource authorization 方案 |
| Oracle / Roundtable 严格 replay 自动化稳定性仍待继续收口 | replay coverage 现在按 fail-closed 收口；readonly replay / reload restore / import 关键字段缺失会直接失败，不再 best-effort 保 `summary.json`。基础 ending-room suite full 已通过，但 ending-room follow-up `full / mobile` 的慢路径仍可能 fallback、超时或挂起；roundtable desktop replay restore 已通过，roundtable `full` 的移动端链路本轮仍可能卡在 result 页面 goto timeout |
| test_p0_wiring.py 覆盖定位 | 定向回归保护，非全链路端到端入口验证 |
