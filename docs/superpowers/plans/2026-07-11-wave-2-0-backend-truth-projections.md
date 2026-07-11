# Wave 2.0 Backend Truth Projections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent continuity, social projections, report lifecycle data, and shipped pack references truthful without a schema migration or public response-shape break.

**Architecture:** Keep canonical relational writes inside their existing transaction, but defer Chroma profile writes until that transaction is visible to other connections. Normalize multilingual emotion labels at the projection boundary, clamp persisted relation values, and make report generation use unambiguous non-terminal and terminal states. Preserve the existing likelihood object shape while using a `single_path` sentinel that clients can render without fake probability claims.

**Tech Stack:** Python 3.11+, FastAPI, SQLModel/SQLite, ChromaDB, Pydantic v2, pytest.

---

### Task 1: Persist L2 identity profiles after the canonical identity transaction

**Files:**
- Modify: `backend/tests/test_p0_wiring.py`
- Modify: `backend/app/services/agent_identity.py:148-242`
- Modify: `backend/app/api/helpers.py:1517-1795`

- [ ] **Step 1: Write the failing transaction-order regression test**

Add a test to `TestIdentityLifecycleHooks` which exercises the real parse handoff and patches the profile writer at both import sites:

```python
@pytest.mark.asyncio
async def test_parse_and_run_background_stores_l2_profile_only_after_identity_commit(
    self,
    monkeypatch,
):
    from app.api import helpers as helpers_api
    from app.config import settings

    observed_identity_ids: list[str] = []

    def assert_identity_is_committed(
        user_id: str,
        identity_id: str,
        role: str,
        persona: str | None,
    ) -> None:
        with Session(get_engine()) as independent_session:
            identity = independent_session.get(AgentIdentity, identity_id)
        assert identity is not None
        assert identity.user_id == user_id
        assert identity.role == role
        assert identity.persona == persona
        observed_identity_ids.append(identity_id)

    monkeypatch.setattr(
        "app.services.agent_identity.store_identity_profile",
        assert_identity_is_committed,
    )
    monkeypatch.setattr(
        "app.services.vector_store.store_identity_profile",
        assert_identity_is_committed,
    )
    engine = get_engine()
    with Session(engine) as session:
        scenario_id = _create_scenario(session, user_id="profile-after-commit")

    async def fake_parse_question(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "setting": {},
            "key_variable": "audit",
            "initial_title": "Audit",
            "agents": [{
                "name": "Trace Keeper",
                "role": "Auditor",
                "persona": "Tracks evidence",
                "tier": "IMPORTANT",
                "stance": "",
            }],
            "groups": [],
            "simulation_rounds": 1,
            "branch_sensitivity": 0.7,
        }

    async def fake_run_sim_background(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(helpers_api, "parse_question", fake_parse_question)
    monkeypatch.setattr(helpers_api, "run_sim_background", fake_run_sim_background)
    previous = settings.FEATURE_AGENT_IDENTITY
    settings.FEATURE_AGENT_IDENTITY = True
    try:
        await helpers_api.parse_and_run_background(
            scenario_id,
            question="Can every decision retain evidence?",
            num_agents=1,
            mode="blackboard",
            hierarchical=False,
            rounds=1,
            visualization_enabled=False,
            reasoning_effort=None,
            temperature=None,
            branch_sensitivity=None,
            fork_prompt_variant=None,
            fork_detector_active_branch_limit=None,
            user_id="profile-after-commit",
            llm_api_key=None,
            llm_base_url=None,
            llm_model=None,
            llm_requests_per_minute=None,
            llm_tokens_per_minute=None,
            disable_user_quota=None,
        )
    finally:
        settings.FEATURE_AGENT_IDENTITY = previous

    with Session(engine) as session:
        agents = session.exec(
            select(Agent).where(Agent.scenario_id == scenario_id)
        ).all()

    assert len(agents) == 1
    assert observed_identity_ids == [agents[0].agent_identity_id]
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_p0_wiring.py::TestIdentityLifecycleHooks::test_parse_and_run_background_stores_l2_profile_only_after_identity_commit
```

Expected: FAIL because `resolve_identity(..., session=session)` calls the profile writer before `helpers.py` commits, so the independent session cannot read the new identity.

- [ ] **Step 3: Defer only external-session profile writes**

In `resolve_identity`, centralize profile persistence without changing the return type:

```python
def _store_profile_if_transaction_owned(
    *,
    own_session: bool,
    user_id: str,
    identity_id: str,
    role: str,
    persona: str | None,
) -> None:
    if own_session:
        store_identity_profile(user_id, identity_id, role, persona)
```

Replace all three direct calls in the exact-match, legacy-match, and create paths with this helper. The self-owned path still commits and stores immediately; an externally owned transaction leaves profile scheduling to its caller.

In `parse_and_run_background`, collect a de-duplicated list while resolving generated identities:

```python
pending_identity_profiles: dict[str, tuple[str, str, str | None]] = {}

# After a generated identity id is resolved:
pending_identity_profiles[identity_id] = (user_id, role, persona)
```

After `session.commit()` and after leaving the `with Session(engine)` block, persist best-effort profiles:

```python
if pending_identity_profiles:
    from app.services.vector_store import store_identity_profile

    for identity_id, (profile_user_id, role, persona) in pending_identity_profiles.items():
        store_identity_profile(profile_user_id, identity_id, role, persona)
```

Do not change the canonical identity if Chroma is unavailable.

- [ ] **Step 4: Verify GREEN and the existing identity suite**

Run one pytest process:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_p0_wiring.py::TestIdentityLifecycleHooks::test_parse_and_run_background_stores_l2_profile_only_after_identity_commit \
  tests/test_agent_identity.py
```

Expected: PASS; profile callbacks see a committed identity and all L1/L2 identity tests stay green.

- [ ] **Step 5: Commit the identity fix**

```bash
git add backend/app/services/agent_identity.py backend/app/api/helpers.py \
  backend/tests/test_p0_wiring.py
git commit -m "fix(identity): persist fuzzy profiles after commit"
```

### Task 2: Normalize multilingual stance signals and bound relation edges

**Files:**
- Modify: `backend/tests/test_causal_graph.py:106-170`
- Modify: `backend/tests/test_factions.py`
- Modify: `backend/app/services/causal_graph.py:969-993`
- Modify: `backend/app/services/factions.py:48-79`

- [ ] **Step 1: Write failing multilingual and extreme-relation tests**

Add focused cases:

```python
@pytest.mark.parametrize(
    ("emotion", "expected"),
    [
        ("忧虑", -0.3),
        ("worried", -0.3),
        ("坚定", 0.7),
        ("resolute", 0.7),
        ("冷静", 0.1),
        (" calm ", 0.1),
    ],
)
def test_multilingual_prompt_emotions_are_normalized(self, emotion, expected):
    assert derive_stance_score(MockMessage(emotion=emotion)) == pytest.approx(expected)

def test_mixed_emotion_label_uses_known_token(self):
    assert derive_stance_score(MockMessage(emotion="坚定 / resolute")) == pytest.approx(0.7)
```

Add a `TestProcessRound` regression using four messages that include `aggressive` and `confident`, then read every persisted `AgentRelationEdge`:

```python
def test_persisted_relation_scores_are_bounded_for_extreme_stances(self):
    result = process_round("bounded-relations", "branch-1", 1, extreme_messages)
    assert result is not None
    with Session(get_engine()) as session:
        edges = session.exec(
            select(AgentRelationEdge).where(
                AgentRelationEdge.scenario_id == "bounded-relations"
            )
        ).all()
    assert edges
    for edge in edges:
        assert 0.0 <= edge.trust_score <= 1.0
        assert 0.0 <= edge.opposition_score <= 1.0
        assert edge.trust_score + edge.opposition_score == pytest.approx(1.0)
```

- [ ] **Step 2: Run the tests and verify RED**

Run one pytest process:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_causal_graph.py::TestDeriveStanceScore::test_multilingual_prompt_emotions_are_normalized \
  tests/test_causal_graph.py::TestDeriveStanceScore::test_mixed_emotion_label_uses_known_token \
  tests/test_factions.py::TestProcessRound::test_persisted_relation_scores_are_bounded_for_extreme_stances
```

Expected: Chinese and current prompt vocabulary resolve to zero; at least one edge persists `trust=-0.4` and `opposition=1.4`.

- [ ] **Step 3: Implement controlled normalization and clamping**

Add `unicodedata` and keep the vocabulary explicit:

```python
_EMOTION_STANCE_SCORES = {
    "aggressive": -0.7, "angry": -0.5, "worried": -0.3,
    "anxious": -0.3, "fearful": -0.2, "cautious": 0.0,
    "calm": 0.1, "hopeful": 0.3, "cooperative": 0.5,
    "confident": 0.7, "resolute": 0.7, "neutral": 0.0,
    "激动": 0.3, "忧虑": -0.3, "冷静": 0.1, "愤怒": -0.5,
    "期待": 0.3, "释然": 0.1, "坚定": 0.7, "犹豫": -0.1,
    "警觉": -0.1, "振奋": 0.3, "焦躁": -0.3, "沉痛": -0.3,
}

def _normalized_emotion_tokens(value: object) -> list[str]:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return [token.strip() for token in re.split(r"[/|,，;；]+", normalized) if token.strip()]
```

Use the first recognized token and retain neutral fallback. Preserve the existing diverge blend and clamp the returned score to `[-1.0, 1.0]`.

Before constructing each relation edge:

```python
opposition = min(max(abs(stance_a - stance_b), 0.0), 1.0)
trust = 1.0 - opposition
```

- [ ] **Step 4: Verify GREEN and related projections**

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_causal_graph.py tests/test_factions.py \
  tests/test_result_report_reducer.py
```

Expected: PASS in one pytest process; stored, queried, and reported relation values remain in `[0, 1]`.

- [ ] **Step 5: Commit the social-projection fix**

```bash
git add backend/app/services/causal_graph.py backend/app/services/factions.py \
  backend/tests/test_causal_graph.py backend/tests/test_factions.py
git commit -m "fix(factions): normalize multilingual stance signals"
```

### Task 3: Remove report lifecycle ambiguity and single-path statistical overclaiming

**Files:**
- Modify: `backend/tests/test_result_report_reducer.py`
- Modify: `backend/tests/test_result_report_builder.py`
- Modify: `backend/tests/test_result_report_contract.py`
- Modify: `backend/app/services/result_report/reducer.py:801-815`
- Modify: `backend/app/services/result_report/schema.py:443-461`
- Modify: `backend/app/services/result_report/builder.py:480-674`
- Modify: `backend/app/api/scenarios.py:2439-2453`

- [ ] **Step 1: Write failing report-truth tests**

In `test_reduce_handles_empty_single_and_missing_snapshot_cases`, replace the assertion that blesses `(0.95, 1.0)` with:

```python
assert single_result.likelihood.probability == 1.0
assert single_result.likelihood.interval == (1.0, 1.0)
assert single_result.likelihood.wep == "single_path"
```

Extend `test_build_report_initial_persist_marks_report_generating` so it observes the payload after the first of two sections:

```python
scenario_id = _seed_report_scenario()
fake_llm = QueuedLlm([
    _outline_payload(["timeline", "sources"]),
    _section_payload("timeline"),
    _section_payload("sources"),
])
monkeypatch.setattr(builder, "llm_call_json", fake_llm)
original_generate = builder.generate_section_react
observed_statuses: list[str] = []

async def observe_between_sections(*args: Any, **kwargs: Any):
    if args[1].section_id == "sources":
        observed_statuses.append(_persisted_report(scenario_id)["status"])
    return await original_generate(*args, **kwargs)

monkeypatch.setattr(builder, "generate_section_react", observe_between_sections)
report = await builder.build_report(scenario_id, "branch-a", overrides=None)

assert observed_statuses == ["generating"]
assert report.status == "complete"
```

In `test_plan_failure_uses_fallback_outline_and_section_failure_isolated`, keep the existing setup and change the terminal assertions:

```python
assert report.status == "failed"
assert [section.id for section in report.sections] == ["timeline"]
assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"
```

In `test_story_full_report_downgrades_stale_generating_without_runtime_lease`, keep the existing setup and change only the status assertion:

```python
assert result["full_report"]["status"] == "failed"
assert result["full_report"]["version"] == "1.0"
```

Clone that story test with an inactive legacy full report whose status is `partial`:

```python
@pytest.mark.asyncio
async def test_story_full_report_downgrades_stale_partial_without_runtime_lease(
    monkeypatch,
):
    import app.api.scenarios as scenarios_api

    payload = _legal_full_report()
    payload["status"] = "partial"
    sid = _seed_scenario_with_branch(full_report=payload)
    monkeypatch.setattr(scenarios_api.settings, "FEATURE_RESULT_REPORT", True)
    monkeypatch.setattr(
        scenarios_api.result_report_builder,
        "report_generation_is_active",
        lambda _scenario_id: False,
        raising=False,
    )

    result = await scenarios_api.get_story(sid, principal=None)

    assert result["full_report"]["status"] == "failed"
    assert result["full_report"]["version"] == "1.0"
```

In `test_oversize_report_truncates_fail_closed`, require the bounded full report to use a terminal status:

```python
assert report.status == "failed"
assert utf8_json_size_bytes(payload) <= 3600
assert validate_full_report_payload(payload, max_bytes=3600).status == "failed"
```

Extend the existing SSE contract test so section progress exposes only bounded observability fields:

```python
event = ResultReportSSEEvent(
    event="report_section_complete",
    data={
        "report_id": "scenario-1",
        "section_id": "timeline",
        "status": "complete",
        "tier": "rewrite",
        "failure_reason": "timeout",
        "tool_trace": [],
    },
)
assert event.data.tier == "rewrite"
assert event.data.failure_reason == "timeout"
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_result_report_reducer.py::test_reduce_handles_empty_single_and_missing_snapshot_cases \
  tests/test_result_report_builder.py::test_build_report_initial_persist_marks_report_generating \
  tests/test_result_report_builder.py::test_plan_failure_uses_fallback_outline_and_section_failure_isolated \
  tests/test_result_report_contract.py::test_story_full_report_downgrades_stale_generating_without_runtime_lease \
  tests/test_result_report_contract.py::test_story_full_report_downgrades_stale_partial_without_runtime_lease \
  tests/test_result_report_builder.py::test_oversize_report_truncates_fail_closed
```

Expected: the reducer emits `almost_certain` plus an invented spread, intermediate persistence uses `partial`, and stale generation becomes terminal `partial`.

- [ ] **Step 3: Implement backward-compatible report semantics**

Keep `Likelihood.probability` and `Likelihood.interval` present for response compatibility. Change only the single-path semantic sentinel:

```python
def _derive_likelihood(probability: float, branch_count: int) -> Likelihood:
    probability = _clamp_probability(probability)
    if branch_count <= 1:
        return Likelihood(
            probability=probability,
            interval=(probability, probability),
            wep="single_path",
        )
    spread = 0.10
    return Likelihood(
        probability=probability,
        interval=(
            round(max(0.0, probability - spread), 4),
            round(min(1.0, probability + spread), 4),
        ),
        wep=derive_likelihood_label(probability),
    )
```

During the section loop always persist `status="generating"`. At final assembly, define terminal state explicitly:

```python
final_status: ReportStatus = (
    "complete"
    if failed_sections == 0 and len(completed_sections) >= len(outline.sections)
    else "failed"
)
```

Add backward-compatible optional progress metadata to `ResultReportSSEData`:

```python
class ResultReportSSEData(_StrictModel):
    report_id: str | None = None
    section_id: str | None = None
    status: ResultReportSSEStatus
    message: str | None = None
    tool_trace: list[ToolTraceSummary] = Field(default_factory=list)
    error_code: str | None = None
    tier: SectionTier | None = None
    failure_reason: SectionFailureReason | None = None
```

Populate `tier` and `failure_reason` from each `SectionBuildResult` in `report_section_complete`; use `failure_reason="other"` for a section that exhausts both generation attempts. Do not put raw exception text into SSE.

Preserve successfully generated sections in a failed report and keep failure reasons visible. `_fit_report_to_byte_cap` must also keep a bounded, pruned full report terminal as `failed` instead of reintroducing terminal `partial`. In `/story`, convert stale `generating` or legacy full-report `partial` payloads with no active runtime lock to `failed`; guard the intentionally distinct `{status: "partial", truncated: true}` response-size marker so it remains a marker rather than a full report.

- [ ] **Step 4: Verify GREEN and report compatibility**

Run one pytest process:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_result_report_reducer.py \
  tests/test_result_report_builder.py \
  tests/test_result_report_contract.py \
  tests/test_result_report_indicators.py
```

Expected: PASS; full reports use `generating → complete|failed`, legacy payload validation still accepts `partial`, and the truncated marker remains distinguishable.

- [ ] **Step 5: Commit the report-truth fix**

```bash
git add backend/app/services/result_report/reducer.py \
  backend/app/services/result_report/schema.py backend/app/services/result_report/builder.py \
  backend/app/api/scenarios.py \
  backend/tests/test_result_report_reducer.py \
  backend/tests/test_result_report_builder.py \
  backend/tests/test_result_report_contract.py
git commit -m "fix(report): make progress and single-path claims truthful"
```

### Task 4: Stop shipped packs from advertising nonexistent demo snapshots

**Files:**
- Modify: `backend/tests/test_local_packs.py`
- Modify: `packs/civic-food-futures.json`
- Modify: `packs/cooperative-ai-foundry.json`
- Modify: `packs/island-library-radio.json`
- Modify: `packs/neighborhood-carbon-ledger.json`
- Modify: `packs/public-clockwork.json`
- Modify: `packs/river-city-sponge-grid.json`
- Modify: `packs/silk-road-press.json`
- Modify: `packs/spice-port-mutuals.json`
- Modify: `packs/zheng-he.json`

- [ ] **Step 1: Add a failing shipped-content existence test**

```python
def test_shipped_pack_demo_snapshots_exist():
    registry = load_local_packs(settings.PACKS_DIR)
    snapshot_dir = settings.SAMPLES_DIR / "snapshots"
    missing = [
        f"{pack.id}:{demo.filename}"
        for pack in registry.packs
        for demo in pack.demo_snapshots
        if not (snapshot_dir / demo.filename).is_file()
    ]
    assert missing == []
```

- [ ] **Step 2: Run the test and verify RED**

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_local_packs.py::test_shipped_pack_demo_snapshots_exist
```

Expected: FAIL listing nine nonexistent `.json` filenames.

- [ ] **Step 3: Remove false references and retain only semantically matching real demos**

Remove `demo_snapshots` from packs that have no real demo. Replace only the two verified matching entries:

```json
// packs/zheng-he.json
"demo_snapshots": [
  {
    "id": "zheng-he-americas",
    "label": { "zh": "郑和抵达美洲", "en": "Zheng He Reaches the Americas" },
    "filename": "zheng-he-americas.swarm"
  }
]
```

```json
// packs/river-city-sponge-grid.json
"demo_snapshots": [
  {
    "id": "river-city-pact",
    "label": { "zh": "河城协定", "en": "The River City Pact" },
    "filename": "river-city-pact.swarm"
  }
]
```

Do not create placeholder snapshots or relabel unrelated samples.

- [ ] **Step 4: Verify GREEN and all pack contracts**

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_local_packs.py tests/test_sample_snapshots.py
```

Expected: PASS; every advertised filename exists and all JSON remains bilingual and schema-valid.

- [ ] **Step 5: Commit the content-truth fix**

```bash
git add backend/tests/test_local_packs.py packs/*.json
git commit -m "fix(packs): remove nonexistent demo references"
```
