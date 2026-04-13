# Graph Visualization Upgrade — v6 Unified Executable Contract

> **Status**: IMPLEMENTED AND VERIFIED
> **Date**: 2026-04-13
> **Supersedes**: v1/v2/v3/v4/v5 + frontend-implementation-plan.md (all prior files are reference only)
> **This file is the SOLE execution contract.**

### Post-v6 Session Update (2026-04-13)

- `P0` production preview 白屏已修复：`Vite manualChunks` 不再拆出 `react-vendor`，graph / homepage preview 恢复正常。
- `P2` argument map enrichment 现已按整个 snapshot 重建 `supports / rebuts` 边，跨 turn 不再残留陈旧 `rebuts`。
- `B6` branch selector 当前以后端 `available_branches` 为准；带 `branch_id` 过滤时，兄弟分支与 fork child branch 仍可切换。
- `ArgumentMap` 当前补齐 filtered empty-state、`fitView()` 重算，以及 `rejected` 状态的前端兼容显示。
- 最新复验：
  - backend graph/debate 相关回归 `337 passed`
  - frontend graph 相关回归 `126 passed`
  - `phase3a` desktop/mobile `17/17`
  - `phase3b` desktop/mobile `14/14`

---

## v5 → v6 Corrections (3 findings + 2 open questions resolved)

| Finding | Fix |
|---------|-----|
| P1 A8 status=unaddressed but edge=rejected → dual semantics breaks frontend | **Eliminated `rejected` edge type from verdict edges.** All non-supporting verdict edges stay `unaddressed`. Frontend visual layer meanwhile keeps `rejected` status compatibility because backend model still exposes it as a legal `unit.status`. |
| P1 A7 node_key hash ≠ sentence order → rebuttal targets arbitrary claim | **Clarified as v1 heuristic.** Sort by round_number DESC + node_key ASC (lowest hash = stable tiebreak). Documented as approximation; cross-turn semantic matching deferred to LLM enrichment. |
| P2 B4 implicitly dropped, test counts inconsistent | **B4 explicitly marked SKIPPED (already TB).** Task count corrected to 8. Test descriptions aligned with tier count. |

### Open Questions — Resolved

**Q: Non-supporting units = rejected or unaddressed?**
A: verdict edge semantics stay `unaddressed`. Current judge_rationale only provides `supporting_turns`, not `rejected_turns`, so verdict rebuild still has no data source for an explicit `rejected` edge. Frontend visual compatibility for `unit.status="rejected"` is retained because the backend model still allows that value.

**Q: Rebuttal target = "latest claim" or "same turn most relevant"?**
A: V1 rule = **opponent's claim with highest round_number; same-round tiebreak = lowest node_key (ASC, stable arbitrary).** This is documented as a heuristic. More accurate cross-turn targeting requires LLM enrichment (ARGUMENT_MAP_LLM_ENRICHMENT flag, already scaffolded).

---

## v4 → v5 Corrections (5 findings, retained for audit trail)

| Finding | Severity | Fix |
|---------|----------|-----|
| Dependency order unsafe: A1/A2/A3/A5 share _safe_parse_payload, A6 depends on A5 | P1 | Strict sequential: tests → A5 → A1/A2/A3 → A6 → ... |
| A8 not truly idempotent: standing_units scope means re-call with changed supporting_turns won't re-evaluate | P1 | Re-query ALL units (not just standing), reset statuses, rebuild edges |
| A7 unstable sort: GraphNode.id is UUID, not time-ordered | P1 | Sort by round_number desc + node_key (semantic hash, deterministic) |
| Plan files diverged: v4 says "unchanged from v3" but frontend-plan adds FE-0/analyst-route/perf | P2 | Merged into this single file |
| Frontend naming inconsistency: setErrorType vs errorTier, missing load_failed i18n | P2 | Unified to errorTier, load_failed added |

---

## STRICT Execution Order

```
Phase 0: Shared infrastructure
  FE-0: graphTokens.ts (frontend, no backend dependency)

Phase A: Backend (strict sequential, no parallelism)
  Step 1: Write/expand tests (test_causal_graph + test_debate_argument_map + test_contract_freeze + test_session_auth for causal-graph route auth/owner)
  Step 2: A5  — _safe_parse_payload + branch filter + build_snapshot safe parse
  Step 3: A1  — temporal edges (uses _safe_parse_payload from A5)
  Step 4: A2  — fork edge fix (uses _safe_parse_payload from A5)
  Step 5: A3  — stance shift (uses _safe_parse_payload from A5)
  Step 6: A6  — GET /causal-graph to_thread (depends on A5 making build_snapshot crash-safe)
  Step 7: A9  — argument map serialization fix + _safe_parse_json + update old test assertions
  Step 8: A10 — round_number from turn_sequence (parameter + caller)
  Step 9: A7  — same-turn edges (depends on A10 for round_number ordering)
  Step 10: A8 + A12 — verdict node (idempotent) + link_verdict to_thread (single commit)
  Step 11: A11 — argument map API fail-soft error indicator

  → Run graph-related backend tests
  → Run full backend regression

Phase B: Frontend P0+P1 (after all backend steps pass)
  B1: ArgumentMap adapter layer
  B2: ArgumentMap error differentiation (7-tier)
  B3: ArgumentMap container + position + CSS
  B5: CausalReviewView dagre + drag
  B6: CausalReviewView MiniMap + Legend + Branch selector + Fit View
  B7: ResultView Phase 3 CSS migration + inline causal preview
  B8: NodeDetailPanel Sheet migration + actions
  B9: CounterfactualPanel integer validation

  → Run frontend vitest + lint + build

Phase C: Visual upgrades (after Phase B)
  C1-C5: Icons, edges, highlight, tooltips, search/filter

  → Gemini final visual review
  → Full regression (backend + frontend)
```

---

## Phase A: Backend Tasks (11 tasks, corrected)

### A5: _safe_parse_payload + branch filter + build_snapshot safe parse [FIRST]

**File**: `backend/app/services/causal_graph.py`
**Rationale**: All subsequent causal tasks (A1/A2/A3) depend on this helper. A6 depends on build_snapshot being crash-safe.

**Changes**:
1. Add shared helper at module level:
```python
def _safe_parse_payload(s: str | None) -> dict[str, Any]:
    """Parse payload JSON safely; return empty dict on any failure."""
    if not s:
        return {}
    try:
        result = json.loads(s)
        return result if isinstance(result, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}
```

2. `build_snapshot()` L193-206 — fix fork filter:
```python
if n.node_type == "fork":
    fork_payload = _safe_parse_payload(n.payload_json)
    fork_branch = fork_payload.get("branch_id")
    fork_children = fork_payload.get("children", [])
    if fork_branch == branch_id or branch_id in fork_children:
        filtered.append(n)
    # parse failure or no match → excluded (no fallback include)
```

3. `build_snapshot()` L229 — safe payload serialization:
```python
"payload": _safe_parse_payload(n.payload_json),
```

4. Event node filter (L195-201) also use `_safe_parse_payload`:
```python
payload = _safe_parse_payload(n.payload_json)
if payload.get("branch_id") == branch_id:
    filtered.append(n)
    continue
```

**Tests**: test_build_snapshot_excludes_fork_on_invalid_json, test_build_snapshot_survives_corrupt_event_payload, test_build_snapshot_includes_fork_for_child_branch

### A1: Inter-round temporal edges [depends on A5]

**File**: `backend/app/services/causal_graph.py` → `append_round_nodes()` after L131
**Change**: Insert AFTER event node loop, BEFORE fork handling:
```python
if round_number > 1 and messages:
    prev_stmt = select(GraphNode).where(
        GraphNode.snapshot_id == snapshot.id,
        GraphNode.node_type == "event",
        GraphNode.round_number == round_number - 1,
    )
    prev_nodes = session.exec(prev_stmt).all()
    prev_by_agent: dict[str, str] = {}
    for pn in prev_nodes:
        payload = _safe_parse_payload(pn.payload_json)
        if payload.get("branch_id") == branch_id:
            prev_by_agent[payload.get("agent_id", "")] = pn.id

    for msg, nid in zip(messages, created_node_ids):
        aid = _getfield(msg, "agent_id", "unknown")
        if aid in prev_by_agent:
            session.add(GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=prev_by_agent[aid],
                target_node_id=nid,
                edge_type="temporal", weight=0.5,
            ))
```
**Tests**: temporal_edges_created, first_round_skip, single_agent_chain, multi_branch_isolation

### A2: Fork edge fix [depends on A5]

**File**: `backend/app/services/causal_graph.py` L148-159
**Change**: Replace L149:
```python
trigger_ids = list(fork_event.get("trigger_node_ids") or [])
if not trigger_ids:
    same_round_stmt = select(GraphNode).where(
        GraphNode.snapshot_id == snapshot.id,
        GraphNode.node_type == "event",
        GraphNode.round_number == round_number,
    )
    same_round_nodes = session.exec(same_round_stmt).all()
    trigger_ids = [
        n.id for n in same_round_nodes
        if _safe_parse_payload(n.payload_json).get("branch_id") == branch_id
    ]
for src_id in trigger_ids:
    session.add(GraphEdge(
        snapshot_id=snapshot.id,
        source_node_id=src_id,
        target_node_id=fork_node.id,
        edge_type="caused", weight=1.0,
        label="triggered fork",
    ))
```
**Tests**: fork_edges_fallback_query, fork_empty_messages_no_same_round

### A3: Stance shift detection [depends on A5]

**File**: `backend/app/services/causal_graph.py` after A1 block
**Tests**: above_threshold, below_threshold, payload_contains_scores

### A6: GET /causal-graph to_thread [depends on A5]

**File**: `backend/app/api/graphs.py` L59
**Change**: `graph = await asyncio.to_thread(build_snapshot, scenario_id, branch_id=branch_id)`
**Import**: `import asyncio`

### A9: Argument map serialization fix

**File**: `backend/app/services/debate_argument_map.py` → `get_argument_map()` L483-517
**Change**: nodes→`key/type/round/payload`, edges→`source/target/type`, units→add `node_id`
**New helper**:
```python
def _safe_parse_json(s: str | None):
    if not s:
        return None
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        return None
```
**Must also**: Update existing test assertions in `test_debate_argument_map.py` that use old field names (`node_type`, `payload_json`, `source_node_id` etc.)

### A10: round_number from turn sequence [before A7]

**File**: `backend/app/services/debate_argument_map.py` L226
**Change**: Add `turn_sequence: int | None = None` param. Set `round_number=turn_sequence` on GraphNode at L265.
**Callers** (debate.py):
- L1552: `turn_sequence=persisted_turn["sequence"]`
- L1661: `turn_sequence=persisted_turn["sequence"]`

### A7: Same-turn edges [depends on A10] — CORRECTED SORT

**File**: `backend/app/services/debate_argument_map.py`

**_find_opponent_last_claim — v6 CORRECTED** (v5 used node_key DESC which has no positional meaning):
```python
def _find_opponent_last_claim(
    session: Session, snapshot_id, current_side: str,
) -> str | None:
    """Find most recent opposing claim. V1 heuristic.

    Strategy: highest round_number wins (= most recent turn).
    Same-round tiebreak: lowest node_key ASC (stable arbitrary;
    node_key is SHA-256 hash of sentence text, deterministic but
    NOT positional — documented as v1 approximation).

    Accurate cross-turn semantic matching is deferred to
    ARGUMENT_MAP_LLM_ENRICHMENT (already scaffolded, off by default).
    """
    stmt = (
        select(GraphNode)
        .where(
            GraphNode.snapshot_id == snapshot_id,
            GraphNode.node_type == "claim",
        )
        .order_by(
            GraphNode.round_number.desc().nulls_last(),
            GraphNode.node_key.asc(),  # stable tiebreak, NOT positional
        )
    )
    for node in session.exec(stmt).all():
        payload = _safe_parse_json(node.payload_json)
        if payload and payload.get("side") and payload["side"] != current_side:
            return node.id
    return None
```

**Limitations (explicit)**:
- Same-round, multiple opponent claims → picks hash-lowest, not sentence-order-last.
- This is acceptable for v1: all claims in the same turn are equally valid rebuttal targets.
- Future: LLM enrichment can re-link with semantic relevance scoring.

**Edge generation** (same as v4, in extract_argument_units before commit):
```python
turn_nodes: list[tuple[str, str]] = []
# ... append (node.id, unit_type) during creation ...

last_claim_id = None
for nid, utype in turn_nodes:
    if utype == "claim":
        last_claim_id = nid
    elif utype == "evidence" and last_claim_id is not None:
        session.add(GraphEdge(
            snapshot_id=snapshot.id, source_node_id=nid,
            target_node_id=last_claim_id, edge_type="supports", weight=0.7,
        ))
    elif utype == "rebuttal":
        opp_claim = _find_opponent_last_claim(session, snapshot.id, speaker_side)
        if opp_claim:
            session.add(GraphEdge(
                snapshot_id=snapshot.id, source_node_id=nid,
                target_node_id=opp_claim, edge_type="rebuts", weight=0.8,
            ))
```

### A8 + A12: Verdict node (truly idempotent) + link_verdict to_thread — v6 CORRECTED

**File**: `backend/app/services/debate_argument_map.py` → `link_verdict()`

**v6 semantic decision**: Verdict edges only use `accepted` and `unaddressed`.
Judge rationale still has no `rejected_turns` data source, so verdict rebuild does not emit a `rejected` edge.
`unit.status` may still expose `rejected` as a legal backend/model value; frontend graph surfaces now keep that compatibility explicitly.
Frontend renders by unit.status for node borders; edge_type matches, no dual semantics.

```python
def link_verdict(debate_id: str, verdict_data: dict) -> None:
    rationale = verdict_data.get("judge_rationale") or verdict_data
    raw_turns = rationale.get("supporting_turns", [])
    supporting_turn_ids: set[str] = set()
    for item in raw_turns:
        if isinstance(item, dict):
            supporting_turn_ids.add(item.get("id", ""))
        elif isinstance(item, str):
            supporting_turn_ids.add(item)

    with Session(get_engine()) as session:
        # Step 1: Re-query ALL units (not just standing) for full re-evaluation
        all_units_stmt = select(DebateArgumentUnit).where(
            DebateArgumentUnit.debate_id == debate_id,
        )
        all_units = session.exec(all_units_stmt).all()

        # Step 2: Reset ALL unit statuses — aligned with edge types below
        for unit in all_units:
            if unit.turn_id in supporting_turn_ids:
                unit.status = "accepted"
            else:
                unit.status = "unaddressed"
            session.add(unit)

        # Step 3: Idempotent verdict node (reuse by fixed node_key)
        snapshot = _get_or_create_snapshot(session, debate_id)
        verdict_key = f"verdict_{debate_id}"
        existing_verdict = session.exec(
            select(GraphNode).where(
                GraphNode.snapshot_id == snapshot.id,
                GraphNode.node_key == verdict_key,
            )
        ).first()

        if existing_verdict:
            verdict_node = existing_verdict
            # Clear ALL old verdict edges before rebuild
            old_edges = session.exec(
                select(GraphEdge).where(
                    GraphEdge.snapshot_id == snapshot.id,
                    GraphEdge.source_node_id == verdict_node.id,
                    GraphEdge.edge_type.in_(["accepted", "unaddressed"]),
                )
            ).all()
            for oe in old_edges:
                session.delete(oe)
            session.flush()
        else:
            verdict_label = verdict_data.get("verdict_tone", "Verdict")
            verdict_node = GraphNode(
                snapshot_id=snapshot.id,
                node_key=verdict_key,
                node_type="verdict",
                label=str(verdict_label)[:120],
                payload_json=json.dumps({
                    "winner": verdict_data.get("winner"),
                    "verdict_tone": verdict_data.get("verdict_tone"),
                }),
            )
            session.add(verdict_node)
            session.flush()

        # Step 4: Rebuild edges — edge_type MATCHES unit.status (no dual semantics)
        for unit in all_units:
            if not unit.node_id:
                continue
            edge_type = "accepted" if unit.turn_id in supporting_turn_ids else "unaddressed"
            session.add(GraphEdge(
                snapshot_id=snapshot.id,
                source_node_id=verdict_node.id,
                target_node_id=unit.node_id,
                edge_type=edge_type, weight=1.0,
            ))

        session.commit()
```

**Why truly idempotent**:
- Re-queries ALL units, not just `standing` → changed supporting_turns fully re-evaluated
- Clears ALL old verdict edges (accepted + unaddressed) before rebuild
- Verdict node reused by fixed node_key
- unit.status and edge_type always aligned → no frontend dual-semantics bug

**A12** (debate.py caller):
```python
await asyncio.to_thread(_argmap_link_verdict, debate_id, finalized_summary)
```

### A11: Argument map API fail-soft

**File**: `backend/app/api/debate.py` L956-968
```python
except Exception as exc:
    logger.warning("argument_map load failed debate=%s: %s", debate_id, exc, exc_info=True)
    return {"snapshot_id": None, "nodes": [], "edges": [], "units": [], "error": "ARGUMENT_MAP_LOAD_FAILED"}
```

---

## Phase FE-0: Shared Frontend Infrastructure

### FE-0: graphTokens.ts (NEW file)

**File**: `frontend/src/lib/graphTokens.ts`
**Content**: OKLCH node/edge colors, lucide icon names, status colors.
**Imported by**: ArgumentMap, CausalReviewView, NodeDetailPanel (replacing 3 duplicated color maps).
**This is the ONLY frontend task with no backend dependency.**

---

## Phase B: Frontend P0+P1 (8 tasks; B4 SKIPPED — already correct)

### B1: ArgumentMap — Backend adapter

**File**: `frontend/src/components/ArgumentMap.tsx`
**Changes**:
1. Add `mapBackendNode()`, `mapBackendEdge()`, `mapBackendUnit()` adapters with try/catch safe parse
2. Add `safeParsePayload(v: unknown)` with try/catch (not bare JSON.parse)
3. Handle `error` field from fail-soft response: `if (json.error) setErrorTier('load_failed');`
**Naming**: State is `errorTier` / `setErrorTier` (type `ErrorTier`) — unified, no `setErrorType` alias

### B2: ArgumentMap — Error differentiation (7-tier)

**File**: `frontend/src/components/ArgumentMap.tsx`
**Error type**:
```ts
type ErrorTier = 'unauthorized' | 'disabled' | 'not_found' | 'server_error' | 'network' | 'too_large' | 'load_failed' | null;
```
**i18n keys** (7 total, all under `argument.error.*`):
- `argument.error.unauthorized` — "无权限查看" / "No permission"
- `argument.error.disabled` — "功能未启用" / "Feature not enabled"
- `argument.error.not_found` — "未找到数据" / "Data not found"
- `argument.error.server` — "服务器错误" / "Server error"
- `argument.error.network` — "网络连接失败" / "Network error"
- `argument.error.too_large` — "数据量过大" / "Too many nodes"
- `argument.error.load_failed` — "加载失败" / "Load failed"

**Rendering**: Each tier renders a distinct lucide icon + i18n message + optional action button (retry/back).

### B3: ArgumentMap — Container + position + CSS

**Changes**: Height `min(50vh, 480px)`. Move in DebateResultView to after verdict, before transcript.
**New file**: `ArgumentMap.css` with OKLCH tokens.

### ~~B4: ArgumentMap TB layout~~ [SKIPPED — already correct]
**Reason**: Code scan confirmed `ArgumentMap.tsx` L154 already uses `rankdir: 'TB'`. No change needed.

### B5: CausalReviewView — Real dagre + drag

**Changes**: Replace manual grid with dagre `rankdir: 'LR'`. Enable `useNodesState`/`useEdgesState`.
**New file**: `CausalReviewView.css`.
**Preserve**: Standalone `/sim/:id/causal-map` route remains as analyst mode.

### B6: CausalReviewView — MiniMap + Legend + Branch selector + Fit View + perf guard

**Changes**: Add MiniMap, collapsible legend, branch dropdown, Fit View FAB.
**Performance**: If nodes > 150, disable edge animation + tooltips. If > 500, text-only fallback.
**Branch URL sync**: `?branch_id=xxx` query parameter.
**i18n**: 8 new keys under `causal.*`.

### B7: ResultView Phase 3 — CSS + inline causal preview

**Changes**:
1. Migrate inline styles → CSS classes with OKLCH tokens
2. Add expandable causal graph preview section (collapsible, retaining standalone route link)
**Preserve**: Standalone analyst route `/sim/:id/causal-map` is NOT removed.

### B8: NodeDetailPanel — Sheet + semantic payload + actions

**Changes**:
1. Replace absolute overlay with shadcn `Sheet` (side="right" desktop, side="bottom" mobile)
2. Semantic payload rendering (agent name, emotion, stance as labeled fields — NOT raw JSON.stringify)
3. Action buttons: Focus Neighbors, Copy Reference
4. **Copy Reference source field is fixed to `node.id`** (stable and always present in current NodeDetail contract; do NOT derive from optional `key` / `ref_id`)
5. Import colors from `graphTokens.ts` (remove duplicated constants)
**Breakpoint**: 768px via `window.matchMedia`

### B9: CounterfactualPanel — Integer validation

**Changes**: Add `Number.isInteger` check, clamp, `aria-invalid`.
**i18n**: 1 new key `counterfactual.invalid_round`.

---

## Phase C: Visual Upgrades (5 tasks)

### C1: Node icons + OKLCH cards
Node type → lucide icon + OKLCH background from graphTokens.ts.

### C2: Edge styling
Edge type → stroke/dash/arrow/animation from EDGE_STYLES in graphTokens.ts.
- temporal: thin dashed muted
- caused/supports: solid neutral/green
- rebuts: dashed danger
  - unaddressed: thin muted dotted (from verdict only)

### C3: Neighbor highlight
On node click: non-neighbors → `opacity: 0.2; filter: grayscale(100%)`. Background click resets.

### C4: Tooltips
Radix Tooltip on truncated node labels. **Disabled when nodes > 150** (perf guard).

### C5: Search/filter
Causal: agent name search. Argument: phase/side/status filter. ExportPanel fidelity preserved.

---

## Test Summary

### Backend (≥28 new tests)
| File | New Tests |
|------|-----------|
| test_causal_graph.py | 12 (temporal, fork, stance_shift, branch filter, safe parse) |
| test_debate_argument_map.py | 12 (supports, rebuts, verdict idempotent, serialization, round_number) + migrate old assertions |
| test_contract_freeze.py | 2 (causal happy path, argmap fail-soft) |
| test_session_auth.py | 2 (causal-graph signed principal required, causal-graph owner isolation) |
| debate flow | 2 (A10 caller, A12 to_thread) |

### Frontend (≥18 new tests)
| File | New Tests | Detail |
|------|-----------|--------|
| ArgumentMap.test.tsx | 11 | adapter with backend field names (2), adapter with legacy fields (1), 7 error tiers (7), container sizing (1) |
| CausalReviewView.test.tsx | 4 | dagre positions non-zero (1), MiniMap renders (1), branch selector changes URL (1), perf guard >500 shows fallback (1) |
| NodeDetailPanel.test.tsx | 3 | Sheet renders on mobile matchMedia (1), Sheet side=right on desktop (1), copy button calls clipboard (1) |
| CounterfactualPanel tests | 2 | float input rejected (1), over-max clamped (1) |

### Regression
```bash
cd backend && python -m pytest tests/test_causal_graph.py tests/test_debate_argument_map.py tests/test_contract_freeze.py tests/test_session_auth.py -v
cd backend && python -m pytest --tb=short
cd frontend && npm test && npm run lint && npm run build
cd frontend && node scripts/e2e-phase3-batch-a.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/phase3a-full --headless
cd frontend && node scripts/e2e-phase3-batch-b.mjs full --url http://127.0.0.1:18928 --output-dir output/e2e/phase3b-full --headless
cd frontend && node scripts/release-signoff.mjs --dry-run --headless --output-root output/e2e/release-dry-run
```

---

## Risk Matrix (v5 final)

| Risk | Status | Mitigation |
|------|--------|-----------|
| A8 verdict not idempotent | **FIXED v5+v6** | Re-query ALL units, reset ALL statuses, clear+rebuild edges |
| A8 status/edge dual semantics | **FIXED v6** | Eliminated `rejected` edge type; only `accepted`/`unaddressed` — aligned with unit.status |
| A7 unstable UUID sort | **FIXED v5** | Sort by round_number DESC + node_key ASC (stable deterministic) |
| A7 hash ≠ sentence order | **ACCEPTED v6** | Documented as v1 heuristic; same-round claims equally valid; LLM enrichment deferred |
| Parallel execution conflict | **FIXED v5** | Strict sequential order, no parallelism in Phase A |
| Plan files diverged | **FIXED v5+v6** | This file is sole execution contract (B4 SKIPPED explicit, counts aligned) |
| Frontend error naming | **FIXED v5+v6** | Unified to errorTier/setErrorTier, load_failed i18n added, no setErrorType alias |
| A9 breaks old test assertions | Medium | Step 7 explicitly includes test migration |
| build_snapshot crash on bad JSON | **FIXED A5** | _safe_parse_payload, executed first |
| link_verdict blocks event loop | **FIXED A12** | asyncio.to_thread |

---

## SESSION_ID
- CODEX_SESSION: 019d84f3-39b7-7d91-9a69-2aeaa8cae12e
- GEMINI_SESSION: 6eac7c55-6717-4572-9eb7-0ef88152987d
