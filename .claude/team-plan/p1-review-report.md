# P1 Implementation Review Report

> Date: 2026-04-24
> Reviewers: Claude (Lead) + Codex (Backend) + Gemini (Frontend)
> Scope: P1 implementation plan + post-review hardening

---

## 1. 审查范围总览

本报告只记录当前代码已经能证明的状态。根目录 `package.json` / `package-lock.json`
仍按工具噪音处理，不纳入 commit 范围。

### 4 个 Track

| Track | 范围 | 状态 |
|-------|------|------|
| A: PipelineStepper | 前端全局 pipeline 进度条 | 已实现，并补 error 状态 `aria-valuenow` 回归 |
| B: ResultConversationWidget | 结果页对话入口 | 已实现；replay 模式下不再暴露 live conversation |
| C: Graph Analysis Service | 后端图分析服务 + API | 已实现；补双 gate、top-N 硬上限、大图截断和 branch-aware 预检 |
| D: GraphEdge Evidence Contract | 边证据数据契约 | 已落库；causal graph 与 debate argument-map API 都会返回 evidence |

---

## 2. 已修复项

### Fix 1: `god_nodes` 无分页 -> 加硬上限 [Critical -> Fixed]

**文件**: `backend/app/services/graph_analysis.py`

**问题**: `analyze_graph()` 返回全部节点的 `god_nodes` 数组，大图时 payload 过大。

**修复**:
- 新增 `_GOD_NODES_MAX = 50`
- `analyze_graph()` 新增 `top_n` 参数，默认 50
- `top_n` 会用 `min(top_n, _GOD_NODES_MAX)` 钳住，不能通过传大值绕过
- `summary` 仍按全量节点统计，不受 cap 影响

### Fix 2: Migration 024 SQL 注入防护 [Critical -> Fixed]

**文件**: `backend/alembic/versions/024_graph_edge_evidence_contract.py`

**问题**: `_existing_columns()` 需要拼 SQLite `PRAGMA table_info(...)`，不能参数化。

**修复**:
- 新增 `_ALLOWED_TABLES = frozenset({"graph_edge"})`
- `_existing_columns()` 先校验表名白名单，再执行 PRAGMA

### Fix 3: `graph-analysis` feature gate 绕过 [Warning -> Fixed]

**文件**: `backend/app/api/graphs.py`, `backend/app/api/scenarios.py`

**问题**: `graph-analysis` 只检查 `FEATURE_GRAPH_ANALYSIS`，因果图 API 关闭时仍可能读图。

**修复**:
- `GET /api/scenario/{id}/graph-analysis` 同时要求 `FEATURE_GRAPH_ANALYSIS` 和 `FEATURE_CAUSAL_GRAPH`
- `/api/capabilities` 中 `graph_analysis.enabled` 也改成双 gate 结果

### Fix 4: `graph-analysis` 测试未同步双 gate [Critical -> Fixed]

**文件**: `backend/tests/test_graph_analysis.py`

**问题**: 双 gate 加入后，原测试只打开 `FEATURE_GRAPH_ANALYSIS`，隔离运行会失败。

**修复**:
- 200 路径和 branch 校验测试同时打开 `FEATURE_CAUSAL_GRAPH`
- 新增 `FEATURE_GRAPH_ANALYSIS=true` 但 `FEATURE_CAUSAL_GRAPH=false` 的 404 回归

### Fix 5: 大图资源上限 [Critical -> Fixed]

**文件**: `backend/app/services/graph_analysis.py`

**问题**: 初版会先 `build_snapshot()` 再判断大小，超大图仍可能先打爆内存。

**修复**:
- 新增 `_MAX_ANALYZABLE_NODES = 5000`
- 新增 `_MAX_ANALYZABLE_EDGES = 20000`
- 先用最新 snapshot 的 node/edge count 做 SQL 预检，超限直接返回 `truncated: true`
- `build_snapshot()` 后再做一次大小检查，覆盖构图期间数据变化的 race

### Fix 6: CausalReviewView stale `serverAnalysis` [Warning -> Fixed]

**文件**: `frontend/src/pages/CausalReviewView.tsx`, `frontend/src/pages/CausalReviewView.test.tsx`

**问题**: 切换分支/场景时旧的 server analysis 可能残留显示。

**修复**:
- 请求 effect 开头先 `setServerAnalysis(null)`
- 补了分支切换时清空旧分析结果的测试

### Fix 7: 旧 SQLite 无 `alembic_version` 时缺 GraphEdge evidence 列 [Critical -> Fixed]

**文件**: `backend/app/models/database.py`, `backend/tests/test_fallback_migrations.py`

**问题**: lightweight bootstrap / `SQLModel.metadata.create_all()` 建出的旧库如果没有
`alembic_version`，直接 stamp 到 head 后可能缺 `graph_edge` 新增列。

**修复**:
- `_LIGHTWEIGHT_ADDITIVE_COLUMNS` 补入 `graph_edge.confidence_tier / source_ref / source_round_number / evidence_json`
- bootstrap schema 判断前会先做 additive column repair
- 新增 no-version bootstrap 回归测试

### Fix 8: Migration 020 duplicate snapshot 处理会合并 stale 边 [Warning -> Fixed]

**文件**: `backend/alembic/versions/020_harden_graph_snapshot_and_state_frame_constraints.py`

**问题**: 旧逻辑把重复 snapshot 的 node/edge 移到 canonical snapshot，可能把 stale 图数据合进当前图。

**修复**:
- 重复 snapshot 现在保留最新一份，直接删除旧 snapshot 及其 node/edge
- SQLite latest tiebreaker 改为 `created_at DESC, rowid DESC`，和运行时“最新行”语义一致
- 补 duplicate snapshot 删除和 SQLite rowid tiebreaker 测试

### Fix 9: ResultView replay 模式暴露 live conversation [Warning -> Fixed]

**文件**: `frontend/src/pages/ResultView.tsx`, `frontend/src/pages/ResultView.test.tsx`

**问题**: replay 结果页仍可能显示结果追问入口，触发 live conversation 语义。

**修复**:
- replay 模式下不渲染 `ResultActionCard` 的 conversation action
- replay 模式下不渲染 `ResultConversationWidget`
- 补 replay payload + `agent_conversation=true` 的测试断言

### Fix 10: Evidence tier 原始值泄漏到图谱文案 [Warning -> Fixed]

**文件**:
- `frontend/src/pages/CausalReviewView.tsx`
- `frontend/src/components/ArgumentMap.tsx`
- `frontend/src/pages/CausalReviewView.test.tsx`
- `frontend/src/components/ArgumentMap.test.tsx`

**问题**: edge evidence tier 可能以 `[medium]` 这类原始枚举显示。

**修复**:
- causal graph 和 argument map 的 edge label / relation list 都走 locale key
- 补中文 tier 文案回归

### Fix 11: PipelineStepper error 状态 `aria-valuenow=-1` [Warning -> Fixed]

**文件**: `frontend/src/components/PipelineStepper.tsx`, `frontend/src/components/PipelineStepper.test.tsx`

**问题**: `status="error"` 时 `getStageIndex()` 返回 `-1`，不适合作为 progressbar 当前值。

**修复**:
- 渲染给 ARIA 的值改为 `Math.max(0, currentIndex)`
- 补 error 状态无障碍测试

### Fix 12: 结果追问空态文案沿用节点语境 [Info -> Fixed]

**文件**:
- `frontend/src/components/kg/EmptyStateQuickQuestions.tsx`
- `frontend/src/components/kg/NodeConversationSheet.tsx`
- `frontend/src/components/kg/NodeConversationSheet.test.tsx`
- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh.json`

**问题**: Result conversation 复用节点对话空态，文案仍像“选中一个节点”。

**修复**:
- `EmptyStateQuickQuestions` 增加 `variant="result"`
- `NodeConversationSheet` 在 result context 下使用结果追问标题、说明和问题模板

### Fix 13: Capability matrix fixture 未覆盖新 capability keys [Warning -> Fixed]

**文件**: `frontend/scripts/e2e-capability-matrix.mjs`

**问题**: fixture payload 缺 `agent_conversation / kg_explorer / replay_trace` 时，E2E 不能完整覆盖当前 capability registry。

**修复**:
- `ALL_GATED_KEYS` 和 fixture payload 补齐三项
- Replay disabled 断言保持显式 unavailable surface 口径

### Fix 14: Debate argument-map API 未返回 edge evidence [Warning -> Fixed]

**文件**: `backend/app/services/debate_argument_map.py`, `backend/tests/test_debate_argument_map.py`

**问题**: debate argument-map 边已经写入 `confidence_tier / source_ref`，但
`get_argument_map()` 只返回 `source / target / type / weight / label`，前端拿不到证据元数据。

**修复**:
- `edges[]` 增加可选 `evidence: { confidence_tier, source_ref, source_round_number, detail }`
- 无证据边仍返回 `evidence: null`
- 补 `get_argument_map()` 序列化回归测试

### Fix 15: graph-analysis 大场景小分支被保守截断 [Warning -> Fixed]

**文件**: `backend/app/services/graph_analysis.py`, `backend/tests/test_graph_analysis.py`

**问题**: 大图 SQL 预检只按 scenario 最新 snapshot 全量计数，带 `branch_id` 的小分支查询也可能提前返回 `truncated: true`。

**修复**:
- `_latest_snapshot_size()` 增加 `branch_id` 参数
- `branch_id` 查询按 `build_snapshot()` 的 branch 可见语义计算节点/边数
- 未带 `branch_id` 时仍按全图预检
- 补“大 scenario、小 branch 不截断”的回归测试

### Fix 16: Causal graph 旧 edge 不回填 evidence [Warning -> Fixed]

**文件**: `backend/app/services/causal_graph.py`, `backend/tests/test_causal_graph.py`

**问题**: `_add_edge_if_missing()` 命中旧 edge 后直接返回，重放轮次时不会把新 evidence 元数据补到旧边上。

**修复**:
- 旧 edge 命中时只补当前为 `None` 的 evidence 字段
- 不覆盖已有非空 `confidence_tier / source_ref / source_round_number / evidence_json`
- 保留旧迁移版本库缺 evidence 列时的基础列查询兼容
- 补 legacy temporal edge backfill 回归测试

### Fix 17: Migration 024 SQLite downgrade 缺少专项回归 [Info -> Fixed]

**文件**: `backend/tests/test_migration_022.py`

**问题**: `024` 的 SQLite downgrade 依赖 Alembic `batch_alter_table` 删除列，原测试只覆盖
022/023 roundtrip，没有持久化覆盖 `graph_edge` evidence 列的 downgrade/upgrade 行为。

**修复**:
- 新增 `024 -> 023 -> 024` roundtrip 测试
- downgrade 后断言四个 evidence 列已删除、edge 行仍保留、`PRAGMA foreign_key_check` 为空
- re-upgrade 后断言四个 evidence 列恢复、edge 行仍保留、FK 检查仍为空

---

## 3. 仍未修复 / 未展开项

### 3.1 后端

| # | 文件 | 当前状态 | 风险 |
|---|------|----------|------|
| W4 | `graph.py` | `evidence_json` 已落库但当前仍没有真实填充值；当 edge evidence 对象存在时会作为 `detail` 透出 | Low |
| W7 | `causal_graph.py` | `_scenario_locks` 仍无界；这是 P1 前已有的长期运行维护项 | Low |

### 3.2 前端

| # | 文件 | 当前状态 | 风险 |
|---|------|----------|------|
| W6 | `ResultView.tsx` | 仍有少量历史 `isZh ?` 三元文案，不是本次 P1 新增主路径 | Low |
| W9 | `CausalReviewView.test.tsx` | `NoopWS` 测试桩仍重复；维护性问题，不影响运行时 | None |
| W10 | `ResultView.tsx` | 文件仍很大，拆分需要单独专项 | None |

### 3.3 工具文件

| 文件 | 当前处理 |
|------|----------|
| `package.json` (根目录) | 工具自动生成，不纳入 commit |
| `package-lock.json` (根目录) | 工具自动生成，不纳入 commit |

---

## 4. 误报 / 已关闭判断

| 项 | 结论 | 依据 |
|----|------|------|
| “020 duplicate snapshot 只是预存问题无需处理” | 已不再沿用这个判断 | 当前迁移已改为删除旧 snapshot，不再合并 stale node/edge |
| “024 no-version SQLite 不需要额外修” | 不是误报 | 已补 lightweight additive repair 和回归测试 |
| W5 SQLite downgrade 需要迁移代码修 | 暂不成立 | 持久化 regression 覆盖了 `024 -> 023 -> 024`，列删除/恢复、edge 行保留、FK 检查均正常；本轮未改迁移代码 |

---

## 5. 本轮验证矩阵

这些是本 session 实际复跑并读过结果的命令。

| 验证步骤 | 结果 |
|----------|------|
| Backend graph/evidence 定向 pytest | `tests/test_debate_argument_map.py tests/test_graph_analysis.py tests/test_causal_graph.py -q` -> `124 passed` |
| Backend ruff check | `ruff check app/services/debate_argument_map.py app/services/graph_analysis.py app/services/causal_graph.py tests/test_debate_argument_map.py tests/test_graph_analysis.py tests/test_causal_graph.py` -> Passed |
| Migration 024 downgrade roundtrip pytest | `tests/test_migration_022.py::test_024_graph_edge_evidence_columns_downgrade_roundtrip_preserves_edges -q` -> `1 passed` |
| Migration test ruff check | `ruff check tests/test_migration_022.py` -> Passed |
| Frontend ArgumentMap vitest | `npm test -- --run src/components/ArgumentMap.test.tsx` -> `50 passed` |
| TypeScript noEmit | `npx tsc --noEmit -p tsconfig.app.json` -> Passed |

未在本 session 复跑全量 backend pytest / 全量 frontend vitest；旧基线不能当作这轮 fresh 结果写入。

---

## 6. Commit 建议

纳入 commit：

- `backend/`
- `.claude/team-plan/p1-review-report.md`
- `llmdoc/` 中和当前真值相关的文档更新

排除：

- 根目录 `package.json`
- 根目录 `package-lock.json`
