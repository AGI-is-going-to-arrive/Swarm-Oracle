# Team Research: P1/P2 Graph-Playability Next Phase

## 增强后的需求

**目标**: 在 P0（bridge card + guide card + 5 状态修复）基础上，推进 P1/P2 改进——消除"半成品感"、借鉴 MiroFish 工作台感、补 Graphify 证据合约。

**范围边界**:
- P1: Pipeline 进度指示器、轻量问预言机、图谱分析服务、KG bug 修复、analysisBranch 统一、nodesDraggable 启用
- P2: 三视图布局切换、FactionTimeline 升级、工具调用链展示、ArgumentMap 拖拽+搜索、Tier C 评估
- 排除: GraphRAG/RAGAnything 接入、社区聚类替代阵营、图谱 diff 视图、完整 GraphRAG

> 2026-04-25 更新：P1 implementation 与 post-review hardening 已落到
> `2dabed9`。下面的依赖关系仍有参考价值，但 P1 状态以
> `p1-review-report.md`、`llmdoc/overview/*` 和当前代码为准。

**验收标准**: 约束集 + 成功判据覆盖全部 P1 项；零开放歧义残留

---

## P0 完成度验证（Playwright 浏览器实测 2026-04-24）

| P0 项 | 状态 | 浏览器证据 |
|--------|------|-----------|
| P0-1 Bridge Card | ✅ 通过 | ResultView "Explore Deeper" 含 Causal Graph / Replay Trace (disabled) / Compare Branches 三入口 |
| P0-2 Guide Card | ⚠️ 代码存在 | CausalReviewView 空态文案 OK ("No causal graph data available...")；guide panel (god nodes/stats) 代码已实现 (guideOpen state L341)，但需有数据场景才能端到端验证 |
| P0-3a Replay disabled | ✅ 通过 | 独立页面显示 "Replay trace is unavailable" + "This server has replay trace disabled" |
| P0-3b KGExplorer | ✅ 通过 | alert 区域显示 "Knowledge Graph is unavailable" + admin 提示 + Back to Home |
| P0-3c CompareDigest | ✅ 通过 | 双分支对比正常运作（Live stage + Standby mirror + round scrubber），typed `CompareErrorState` union |
| P0-3d FactionTimeline | ✅ 通过 | 解释性空态 "Factions need a longer run to form alliances and splits..." |
| P0-3e Source tooltip i18n | ✅ 通过 | EN: "This data source is not enabled on the server." / ZH: "此数据源未在服务器上启用。" |

**P0 结论**: 6/7 完全通过，P0-2 guide card 代码已实现但需新场景（含因果图数据）做端到端验证。

**Capabilities 当前口径**:
- `/api/capabilities` registry 现在包含：
  `web_search / custom_agents / agent_identity / causal_graph /
  counterfactual_replay / factions / argument_map / agent_conversation /
  kg_explorer / replay_trace / graph_analysis`
- `graph_analysis.enabled` 需要 `FEATURE_GRAPH_ANALYSIS=true` 且
  `FEATURE_CAUSAL_GRAPH=true`。
- 下方浏览器证据仍是 2026-04-24 本地环境实测，不代表所有 feature flag 默认开启。

---

## P1 前置修复状态（真实浏览器复核 2026-04-24）

| 前置项 | 当前状态 | 证据 |
|--------|----------|------|
| KGExplorer 主图 / search / minimap | ✅ 已修 | `/kg-explorer/dbac37a3-3578-42b2-99c0-06185caad147` 主图 canvas 非空；search 后图像变化；minimap 为真实 G6 minimap |
| KGExplorer node type | ✅ 已修 | 节点点击传业务 `kgType`、label、branch、round 到 `NodeConversationSheet` |
| CausalReview 拖拽 / 选择 | ✅ 已修 | `/sim/dbac37a3-3578-42b2-99c0-06185caad147/causal-map` 节点拖拽后 transform / box 坐标变化 |
| ReplayView i18n 模板串 | ✅ 已修 | `/replay/32728bd6-282c-42f1-a7da-493892fce32a` 显示 `帧: 1 / 3 · 分支: 2`，无 `{{count}}` |
| ResultView branch 语义 | ✅ 已修 | `/result/dbac37a3-3578-42b2-99c0-06185caad147` compare link 使用 `analysisBranch` 语义 |
| Conversation prompt 语境 | ✅ 已修 | prompt 注入 scenario question、branch、origin node、相邻关系摘要，并截断历史和 payload |
| GraphEdge evidence contract | ✅ 已落库/API | migration 024 已加 `confidence_tier / source_ref / source_round_number / evidence_json`；causal graph 与 debate argument-map 会返回 coarse evidence。`detail` 只是 `evidence_json` 预留透传，目前没有可信 detail 来源 |

截图目录：`frontend/output/e2e/20260424-p1-preflight-fixes/`

---

## 约束集

### 硬约束

#### 前端

| ID | 约束 | 影响 | 来源 |
|----|------|------|------|
| FE-HC-1 | `NodeConversationSheet` 有 4 个触发源 (ArgumentMap/CausalReview/FactionTimeline/KGExplorer)，ResultView (2799行) 未引入 | P1-B | frontend-explorer |
| FE-HC-2 | NodeConversationSheet 需 `scenarioId` + `origin` (nodeId/nodeType/excerpt) props，ResultView 已有 `activeScenarioId` | P1-B | frontend-explorer |
| FE-HC-3 | SSE transport 是 fetch-based (`useNodeConversationTransport`)，独立于 WebSocket，可直接复用 | P1-B | frontend-explorer |
| FE-HC-4 | ✅ 已修：CausalReviewView 当前 `nodesDraggable` 与 `elementsSelectable` 已开启；拖拽位置不会被普通 rerender 重置 | P1-E | p1-preflight-fixes |
| FE-HC-5 | ✅ 已修：`PipelineStepper` 已挂到 App 壳，按当前 simulation/result 语义显示 | P1-A | p1-review-report |
| FE-HC-6 | `simulationStore.status` 有 `idle\|parsing\|simulating\|narrating\|done\|error` 6 态，可映射 Pipeline 阶段 | P1-A | frontend-explorer |
| FE-HC-7 | ResultView 仍很大（当前约 2730 行）；新增 UI 仍应优先抽子组件，本轮已把 finance source card 抽出 | P1-B / P2 | p1-review-report |

#### 后端

| ID | 约束 | 影响 | 来源 |
|----|------|------|------|
| BE-HC-1 | ✅ 已修：`graph_analysis.py` 已存在，`/api/scenario/{id}/graph-analysis` 已接入 | P1-3 | p1-review-report |
| BE-HC-2 | ✅ 已修：`GraphEdge` 已有 evidence 字段和 024 migration；限制是没有真实 detail 填充来源 | P1-4 / P2-5 | p1-review-report |
| BE-HC-3 | `FEATURE_AGENT_CONVERSATION=False` 默认关闭，oracle chat 需开启 | P1-B | backend-explorer |
| BE-HC-4 | ✅ 已修：`_build_prompt()` 当前注入轻量 worldline-local scenario / branch / node / relation context，并做明确截断 | P1-B | p1-preflight-fixes |
| BE-HC-5 | ✅ 已修：`graph_analysis` capability key 已加入 registry，enabled 还要求 `FEATURE_CAUSAL_GRAPH=true` | P1-3 | p1-review-report |
| BE-HC-6 | `build_snapshot()` 返回完整 nodes/edges，度数分析 O(n) 可直接计算；God Nodes / 跨分支连接 / 社区均可无迁移实现 | P1-3 | backend-explorer |
| BE-HC-7 | Conversation quota 系统已就绪 (500 turns/user/day, 50 turns/thread, 10 threads/scenario)，oracle chat 自动受限 | P1-B | backend-explorer |

### 软约束

| ID | 约束 | 影响 | 来源 |
|----|------|------|------|
| SC-1 | `useCapabilityCheck` 模块级缓存 (singleton)，无 TTL，仅 reload() 刷新 | P1-A, P1-B | frontend-explorer |
| SC-2 | `analysisBranch` 在 ResultView L1859 是 local derived state，未存入 Zustand store | P1-D | frontend-explorer |
| SC-3 | ✅ 已修：KGExplorer 主图、search/filter、真实 minimap、业务 `kgType` 点击语义已完成；raw fetch error 仍走本地化错误态 | P1-C | p1-preflight-fixes |
| SC-4 | `_build_prompt()` 可扩展 (追加行)，但注入场景摘要可增加 500-1000 tokens/次 LLM 成本 | P1-B | backend-explorer |
| SC-5 | Pipeline stepper 若仅映射现有 `ScenarioStatus`，则纯前端实现，无需后端变更 | P1-A | backend-explorer |
| SC-6 | ✅ 已修：`CounterfactualPanel` 和 compare link 复用 `analysisBranch`，不再固定拿 `branches[0]` | P1-D | p1-preflight-fixes |
| SC-7 | 轻量问预言机已有最小产品设计：ResultView 底部浮条 → 滑出 Sheet → 3 轮后提示进入会客厅 | P1-B | final-summary Q6 |

### 依赖关系

| From → To | 原因 |
|-----------|------|
| P1-A (Pipeline stepper) → 无 | 已完成 |
| P1-B (Oracle chat) → BE-HC-3 + UI 入口 | Result conversation widget 已接入；仍受 `agent_conversation` capability gate 控制 |
| P1-3 (Graph analysis) → BE-HC-1 + BE-HC-5 | 已完成 |
| P1-4 (Evidence contract) → BE-HC-2 | 已完成 coarse evidence contract；detail 仍无可信来源 |
| P1-4 → P1-3 | 已不再是阻塞项；graph analysis 不依赖 detail |
| P1-C (KG bugs) → 已完成 | 已用本地 `FEATURE_KG_EXPLORER=true` 浏览器复核 |
| P1-D → 已完成 | compare / counterfactual 已跟随 `analysisBranch` |
| P1-E → 已完成 | CausalReview 节点已可拖拽 / 可选择 |
| P2-1 (三视图) → P1-A | P1-A 已完成；进入前仍需单独定三视图 UX 边界 |
| P2-2 (FactionTimeline) → factions 数据验证 | 需有真实阵营数据 |
| P2-5 (Tier C 定向检索) → P1-4 | coarse evidence 已有；如果要做 detail 级检索，仍需先找到真实 detail 来源 |

### 风险

| ID | 风险 | 严重度 | 缓解策略 |
|----|------|--------|----------|
| RISK-1 | ResultView 仍很大（当前约 2730 行），继续加 UI 会加剧维护负担 | 中 | 新增功能必须抽独立组件；本轮已把 finance source card 抽出 |
| RISK-2 | Pipeline stepper layout wrapper 改变所有 18 路由渲染树 | 中 | 使用 portal 或条件渲染，idle 时不挂载 |
| RISK-3 | Oracle chat prompt 长度膨胀 (注入场景摘要) | 中 | 上限 top-3 分支洞见 + 5 关键时刻，总增 <1000 tokens |
| RISK-4 | `build_snapshot()` 全量加载大场景 (1500 agent × 40 rounds) | 低 | 度数计算 O(edges)，可按 snapshot.id 缓存 |
| RISK-5 | 启用 FEATURE_CAUSAL_GRAPH 增加模拟时间 (hook per round) | 低 | Hook 已有 asyncio.to_thread + per-scenario 锁 |
| RISK-6 | Migration 024 on SQLite | 低 | nullable ALTER TABLE ADD COLUMN 是 O(1) |

---

## P1 已完成前置项

| 项目 | 状态 | 验证 |
|------|------|------|
| P1-E nodesDraggable 启用 | ✅ 已完成 | 浏览器拖拽前后 position / transform 变化 |
| P1-D analysisBranch 统一 | ✅ 已完成 | ResultView compare / counterfactual 使用 `analysisBranch` |
| P1-C KGExplorer 3 bug 修复 | ✅ 已完成 | 主图非空、search 生效、真实 minimap、业务 `kgType` |
| P1-B prompt context 前置 | ✅ 已完成 | conversation prompt 带 scenario / branch / node / graph context |
| P1-A Pipeline stepper | ✅ 已完成 | `PipelineStepper` 已接 App 壳，error 状态 ARIA 已补回归 |
| P1-3 Graph analysis service | ✅ 已完成 | 双 feature gate、top-N cap、大图截断、branch-aware 预检已补测试 |
| P1-B 轻量问预言机 UI 入口 | ✅ 已完成 | `ResultConversationWidget` 已接 ResultView；replay 模式不暴露 live conversation |
| P1-4 Evidence contract | ✅ 已完成 | GraphEdge evidence 字段、024 migration、causal/debate API evidence 返回已落地；detail 仍只是预留透传 |

## P1 原推荐执行顺序（已完成）

| 序号 | 项目 | 当前状态 | 仍需记住的边界 |
|------|------|----------|----------------|
| 1 | **P1-A Pipeline stepper** | 已完成 | 仍按当前 route/status 语义显示，不代表所有页面都有 stepper |
| 2 | **P1-3 Graph analysis service (Tier A)** | 已完成 | endpoint enabled 需要 `FEATURE_GRAPH_ANALYSIS=true` 且 `FEATURE_CAUSAL_GRAPH=true` |
| 3 | **P1-B 轻量问预言机 UI 入口** | 已完成 | live conversation 仍受 capability gate 控制；replay 结果页不显示 |
| 4 | **P1-4 Evidence contract (Tier B)** | 已完成 coarse contract | 不把 `detail` 当真实解释文本，当前没有可信 detail 来源 |

原最小安全顺序已执行完毕，后续不要再把这段当待办：

```
P1-A → P1-3 / P1-B → P1-4 → post-review hardening
```

## P2 项清单（下一迭代）

| 项目 | 估时 | 依赖 |
|------|------|------|
| P2-1 三视图布局切换 (graph/split/workbench) | 3 天 | P1-A 已满足；开始前先定 graph/split/workbench 的状态边界 |
| P2-2 FactionTimeline 升级 (力导向小图) | 2 天 | 仍需要真实阵营数据样本，不要只靠空态做验收 |
| P2-3 工具调用链展示 (ResultView hooks 摘要) | 2 天 | 可开始；新增 UI 必须抽组件，避免继续膨胀 ResultView |
| P2-4 ArgumentMap 拖拽 + 图内文本搜索 | 1 天 | 可开始；需保留现有 a11y relation list 与筛选空态 |
| P2-5 定向图检索层 (Tier C) 评估 | 评估 | 只适合先做评估；当前没有可信 detail 来源，不能直接承诺 detail 级检索 |

---

## 明确排除项

| 项目 | 排除理由 |
|------|----------|
| GraphRAG / RAGAnything 接入 | 与 SQLite-only 架构冲突，6-8 周工作量 |
| 社区聚类替代阵营 | 破坏 stance_score 语义和 timeline 可比性 |
| 图谱 diff 视图 | 需 append-only 多版本 GraphSnapshot 重设计 |
| 完整 MiroFish 工作流复刻 | 偏离 SwarmOracle "What-If" 叙事推演定位 |
| FactionTimeline 图谱化 (P2) | 需新可视化组件，不属于 P1 |

---

## 关键组件清单（可复用）

| 组件 | 路径 | 行数 | P1 复用 |
|------|------|------|---------|
| NodeConversationSheet | `frontend/src/components/kg/NodeConversationSheet.tsx` | 528 | P1-B 第 5 触发源 |
| useNodeConversationTransport | `frontend/src/hooks/useNodeConversationTransport.ts` | 218 | P1-B 直接复用 |
| conversationStateMachine | `frontend/src/lib/conversationStateMachine.ts` | 148 | P1-B 纯 reducer |
| useCapabilityCheck | `frontend/src/hooks/useCapabilityCheck.ts` | 124 | P1-A/B capability gate |
| simulationStore | `frontend/src/stores/simulationStore.ts` | 590 | P1-A status 来源 |
| EmptyStateQuickQuestions | `frontend/src/components/kg/EmptyStateQuickQuestions.tsx` | — | P1-B 推荐问题 |
| conversation_service.py | `backend/app/services/conversation_service.py` | 1600+ | P1-B 全链路复用 |
| causal_graph.py | `backend/app/services/causal_graph.py` | 1000+ | P1-3 build_snapshot() |

---

## 成功判据

| ID | 判据 | 验证方法 |
|----|------|----------|
| OK-1 | Pipeline stepper 在 InputView → Simulating → ResultView 全程可见 | Playwright E2E |
| OK-2 | ResultView 底部 chat widget 可发送问题并收到 SSE 流式回复 | Playwright + 后端集成测试 |
| OK-3 | Graph analysis endpoint 返回 god_nodes + degree_distribution + cross_branch_edges | curl + pytest |
| OK-4 | ✅ CausalReviewView nodesDraggable 可拖拽节点 | 浏览器拖拽测试 + `CausalReviewView.test.tsx` |
| OK-5 | ✅ analysisBranch 在 CounterfactualPanel 和 compare CTA 统一使用 | `ResultView.test.tsx` + 浏览器 compare link |
| OK-6 | ✅ KGExplorer 3 bug 修复后主图 / search / minimap / node type 可用 | `KGExplorerView.test.tsx` + 浏览器截图 |
| OK-7 | Evidence contract migration up/down 可逆 | alembic upgrade/downgrade |
| OK-8 | 回归必须以当轮实际 rerun 为准，不复用旧测试数字当门禁 | CI 或本地 fresh run |

---

## 开放问题（全部已解决 2026-04-24）

| # | 问题 | 用户决策 | 转化约束 |
|---|------|---------|----------|
| Q1 | P1-C KGExplorer bug 修复：是否启用 `FEATURE_KG_EXPLORER`？ | ✅ 现在启用，直接修 bug | → [HC-NEW] P1-C 从条件执行改为必做项，需同步开启 `FEATURE_KG_EXPLORER=true` |
| Q2 | P0-2 Guide Card 端到端验证：是否跑新场景？ | ✅ 同意 | → P1-3 完成后用新场景自然验证 guide card 有数据态 |
| Q3 | P1-B Oracle chat 轮次限制策略？ | ✅ 方案 B：软提示 | → 不限轮次，第 3 轮后非阻塞提示"想更深入？可进入会客厅/发起圆桌"，用户可忽略继续聊 |

---

## 证据索引

| 类型 | 来源 | 内容 |
|------|------|------|
| Playwright | p0-verify/01-homepage-snapshot.yml | InputView 4 source disabled tooltips (EN/ZH) |
| Playwright | p0-verify/03-resultview-snapshot.yml | ResultView bridge card + FactionTimeline 空态 |
| Playwright | p0-verify/04-causal-review-snapshot.yml | CausalReview 空态 (0 nodes, 0 edges) |
| Playwright | p0-verify/05-kgexplorer-snapshot.yml | KGExplorer "unavailable" alert |
| Playwright | p0-verify/06-compare-digest-snapshot.yml | CompareDigest 双分支对比 |
| Playwright | ReplayView snapshot (inline) | "Replay trace is unavailable" |
| API | `/api/capabilities` | 当前 registry 11 个 key；`graph_analysis` 受双 feature gate 控制 |
| Agent | frontend-explorer (25+ files, 37 tool uses) | 前端约束集 + 组件清单 |
| Agent | backend-explorer (17+ files, 50 tool uses) | 后端约束集 + API 合约 |
| Plan | final-summary-and-test-recommendations.md | P1/P2 优先级 + 排除项 |
| Plan | p0-implementation-plan.md §7 | 明确排除项定义 |
| Plan | graphify-mirofish-p0-status-research.md | P0 完成确认 + P1 五项建议 |
| Plan | deep-playthrough-round3-improvement-research.md | 4-Tier 架构 + MiroFish 借鉴 |
| Plan | codex-playthrough-evaluation.md | Codex 审计代码问题 |
| Plan | graph-ux-benchmark-research.md | 对比矩阵 + 借鉴清单 |
| Browser | `frontend/output/e2e/20260424-p1-preflight-fixes/` | KGExplorer / CausalReview / ReplayView / ResultView 四条指定 URL 截图 |
| Test | P1 preflight targeted | frontend 151 tests passed；backend conversation tests 78 passed；typecheck、frontend preflight、build 通过 |
| Test | P1 post-review follow-up | `p1-review-report.md` 记录的 backend graph/evidence `125 passed`、frontend targeted `126 passed`、ruff/eslint/typecheck 通过 |
