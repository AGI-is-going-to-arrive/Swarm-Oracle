# Wave 2.0 Backend Truth Projections Implementation Plan / Wave 2.0 后端真实状态投影实施计划

> **历史计划记录 / Historical plan record — 2026-07-11**
>
> 本文保留 2026-07-11 的设计与任务语境。任务、命令、行号和预期结果均属历史记录，不是当前操作指引；复选框和批准状态不代表当前实施或验证结果。代码示例及其中的注释、字符串保留原文，中英文共用。
>
> This document preserves the design and task context of 2026-07-11. Tasks, commands, line numbers, and expected results are historical records, not current operating instructions. Checkboxes and approval status do not establish current implementation or verification results. Both languages share the original code examples, including their comments and strings.
>
> 当前指南 / Current guides: [README](../../../README.md) · [使用指南 / Usage](../../USAGE.md) · [配置指南 / Configuration](../../CONFIGURATION.md).

![System architecture and evidence flow](../../illustrations/architecture.en.webp)

*Conceptual illustration: System architecture and evidence flow; it is not evidence that historical tasks were completed.*

<details>
<summary>中文图解</summary>

![系统架构与证据流](../../illustrations/architecture.zh.webp)

*概念配图：系统架构与证据流，不作为历史任务完成证据。*

</details>

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **面向自动化执行者（原计划要求）：** 必须使用子技能 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，逐项实施本计划。步骤使用复选框（`- [ ]`）语法跟踪。

**Goal:** Make Agent continuity, social projections, report lifecycle data, and shipped pack references truthful without a schema migration or public response-shape break.

**目标：** 在不迁移数据库 schema、不破坏公开响应结构的前提下，使 Agent 连续性、社交投影、报告生命周期数据和随附主题包引用如实反映实际状态。

**Architecture:** Keep canonical relational writes inside their existing transaction, but defer Chroma profile writes until that transaction is visible to other connections. Normalize multilingual emotion labels at the projection boundary, clamp persisted relation values, and make report generation use unambiguous non-terminal and terminal states. Preserve the existing likelihood object shape while using a `single_path` sentinel that clients can render without fake probability claims.

**架构：** 规范关系数据仍在现有事务中写入，但 Chroma 档案写入延后至其他连接能够看见该事务的提交结果。在投影边界规范化多语言情绪标签，对持久化关系值设限，并让报告生成使用含义明确的非终态与终态。保留现有 likelihood 对象结构，使用 `single_path` 标记，使客户端无需虚构概率即可展示。

**Tech Stack / 技术栈:** Python 3.11+, FastAPI, SQLModel/SQLite, ChromaDB, Pydantic v2, pytest.

---

### Task 1: Persist L2 identity profiles after the canonical identity transaction / 任务 1：在规范身份事务提交后持久化 L2 身份档案

**Files / 文件:**

- Modify / 修改: `backend/tests/test_p0_wiring.py`
- Modify / 修改: `backend/app/services/agent_identity.py:148-242`
- Modify / 修改: `backend/app/api/helpers.py:1517-1795`

- [ ] **Step 1: Write the failing transaction-order regression test / 步骤 1：编写预期失败的事务顺序回归测试**

Add a test to `TestIdentityLifecycleHooks` which exercises the real parse handoff and patches the profile writer at both import sites:

在 `TestIdentityLifecycleHooks` 中增加测试，覆盖真实解析交接流程，并在两个导入位置替换档案写入函数：

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

- [ ] **Step 2: Run the test and verify RED / 步骤 2：运行测试并确认 RED（预期失败）**

Run / 运行:

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_p0_wiring.py::TestIdentityLifecycleHooks::test_parse_and_run_background_stores_l2_profile_only_after_identity_commit
```

Expected: FAIL because `resolve_identity(..., session=session)` calls the profile writer before `helpers.py` commits, so the independent session cannot read the new identity.

预期：FAIL；`resolve_identity(..., session=session)` 在 `helpers.py` 提交之前调用档案写入函数，因此独立会话读不到新身份。

- [ ] **Step 3: Defer only external-session profile writes / 步骤 3：仅延后由外部会话管理的档案写入**

In `resolve_identity`, centralize profile persistence without changing the return type:

在 `resolve_identity` 中集中处理档案持久化，不改变返回类型：

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

用此辅助函数替换精确匹配、旧数据匹配和创建路径中的三处直接调用。自行管理会话的路径仍立即提交并存储；外部管理的事务由调用者负责安排档案写入。

In `parse_and_run_background`, collect a de-duplicated list while resolving generated identities:

在 `parse_and_run_background` 解析生成身份时，收集去重后的列表：

```python
pending_identity_profiles: dict[str, tuple[str, str, str | None]] = {}

# After a generated identity id is resolved:
pending_identity_profiles[identity_id] = (user_id, role, persona)
```

After `session.commit()` and after leaving the `with Session(engine)` block, persist best-effort profiles:

执行 `session.commit()` 并离开 `with Session(engine)` 代码块后，以尽力而为的方式持久化档案：

```python
if pending_identity_profiles:
    from app.services.vector_store import store_identity_profile

    for identity_id, (profile_user_id, role, persona) in pending_identity_profiles.items():
        store_identity_profile(profile_user_id, identity_id, role, persona)
```

Do not change the canonical identity if Chroma is unavailable.

Chroma 不可用时，不改变规范身份数据。

- [ ] **Step 4: Verify GREEN and the existing identity suite / 步骤 4：确认 GREEN（测试通过）并验证现有身份测试集**

Run one pytest process:

仅运行一个 pytest 进程：

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_p0_wiring.py::TestIdentityLifecycleHooks::test_parse_and_run_background_stores_l2_profile_only_after_identity_commit \
  tests/test_agent_identity.py
```

Expected: PASS; profile callbacks see a committed identity and all L1/L2 identity tests stay green.

预期：PASS；档案回调能够看到已提交身份，所有 L1/L2 身份测试继续通过。

- [ ] **Step 5: Commit the identity fix / 步骤 5：提交身份修复**

```bash
git add backend/app/services/agent_identity.py backend/app/api/helpers.py \
  backend/tests/test_p0_wiring.py
git commit -m "fix(identity): persist fuzzy profiles after commit"
```

### Task 2: Normalize multilingual stance signals and bound relation edges / 任务 2：规范化多语言立场信号，并约束关系边的数值范围

**Files / 文件:**

- Modify / 修改: `backend/tests/test_causal_graph.py:106-170`
- Modify / 修改: `backend/tests/test_factions.py`
- Modify / 修改: `backend/app/services/causal_graph.py:969-993`
- Modify / 修改: `backend/app/services/factions.py:48-79`

**Evidence refinement (2026-07-11):** The simulation prompt emits 21 paired
Chinese/English emotion labels.  The original draft covered only 12 Chinese and
5 English labels, so it would still silently map most real outputs to zero.
Cover the complete prompt vocabulary and its bilingual aliases.  This remains a
documented provisional **emotion-derived interaction proxy**, not a claim that
emotion is a topic-grounded political stance.  A real evidence-anchored stance
extractor is a separate Wave 2.1 design task.

**证据补充（2026-07-11）：** 推演提示词会输出 21 组成对的中英文情绪标签。初稿只覆盖 12 个中文和 5 个英文标签，仍会将大部分实际输出静默映射为零。应覆盖完整提示词词表及其中英别名。这仍是已明确说明的临时**情绪衍生互动代理指标**，不意味着情绪就是基于具体议题的政治立场。真正以证据为依据的立场提取器属于独立的 Wave 2.1 设计任务。

- [ ] **Step 1: Write failing multilingual and extreme-relation tests / 步骤 1：编写预期失败的多语言与极端关系测试**

Add focused cases:

增加定向用例：

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

在 `TestProcessRound` 中增加回归，使用包含 `aggressive` 和 `confident` 的四条消息，再读取所有持久化的 `AgentRelationEdge`：

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

- [ ] **Step 2: Run the tests and verify RED / 步骤 2：运行测试并确认 RED（预期失败）**

Run one pytest process:

仅运行一个 pytest 进程：

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_causal_graph.py::TestDeriveStanceScore::test_multilingual_prompt_emotions_are_normalized \
  tests/test_causal_graph.py::TestDeriveStanceScore::test_mixed_emotion_label_uses_known_token \
  tests/test_factions.py::TestProcessRound::test_persisted_relation_scores_are_bounded_for_extreme_stances
```

Expected: Chinese and current prompt vocabulary resolve to zero; at least one edge persists `trust=-0.4` and `opposition=1.4`.

预期：中文及当前提示词词表被解析为零；至少一条边持久化为 `trust=-0.4`、`opposition=1.4`。

- [ ] **Step 3: Implement controlled normalization and clamping / 步骤 3：实现受控的规范化与限幅**

Add `unicodedata` and keep the vocabulary explicit:

增加 `unicodedata`，并保持词表明确可查：

```python
_EMOTION_STANCE_SCORES = {
    "aggressive": -0.7, "anxious": -0.3, "fearful": -0.2,
    "cautious": 0.0, "cooperative": 0.5, "confident": 0.7,
    "neutral": 0.0,
    "激动": 0.3, "excited": 0.3,
    "忧虑": -0.3, "worried": -0.3,
    "冷静": 0.1, "calm": 0.1,
    "愤怒": -0.5, "angry": -0.5,
    "期待": 0.3, "hopeful": 0.3,
    "释然": 0.1, "relieved": 0.1,
    "讽刺": -0.2, "sardonic": -0.2,
    "无奈": -0.2, "resigned": -0.2,
    "坚定": 0.7, "resolute": 0.7,
    "犹豫": -0.1, "hesitant": -0.1,
    "警觉": -0.1, "alert": -0.1,
    "心寒": -0.3, "chilled": -0.3,
    "振奋": 0.3, "energized": 0.3,
    "焦躁": -0.3, "restless": -0.3,
    "沉痛": -0.3, "grieving": -0.3,
    "嘲弄": -0.3, "mocking": -0.3,
    "恳切": 0.2, "earnest": 0.2,
    "疲倦": -0.2, "weary": -0.2,
    "隐忍": -0.1, "restraining": -0.1,
    "得意": 0.2, "smug": 0.2,
    "不屑": -0.2, "dismissive": -0.2,
}

def _normalized_emotion_tokens(value: object) -> list[str]:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold().strip()
    return [token.strip() for token in re.split(r"[/|,，;；]+", normalized) if token.strip()]
```

Use the first recognized token and retain neutral fallback. Preserve the existing diverge blend and clamp the returned score to `[-1.0, 1.0]`.

采用第一个可识别的词元，保留中性回退。保留现有 diverge 混合逻辑，将返回分数限制在 `[-1.0, 1.0]`。

Before constructing each relation edge:

构造每条关系边之前：

```python
opposition = min(max(abs(stance_a - stance_b), 0.0), 1.0)
trust = 1.0 - opposition
```

- [ ] **Step 4: Verify GREEN and related projections / 步骤 4：确认 GREEN 并验证相关投影**

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_causal_graph.py tests/test_factions.py \
  tests/test_result_report_reducer.py
```

Expected: PASS in one pytest process; stored, queried, and reported relation values remain in `[0, 1]`.

预期：单个 pytest 进程通过；存储、查询和报告中的关系值均保持在 `[0, 1]`。

- [ ] **Step 5: Commit the social-projection fix / 步骤 5：提交社交投影修复**

```bash
git add backend/app/services/causal_graph.py backend/app/services/factions.py \
  backend/tests/test_causal_graph.py backend/tests/test_factions.py
git commit -m "fix(factions): normalize multilingual stance signals"
```

### Task 2b: Enforce the documented maximum faction stance range / 任务 2b：落实文档规定的阵营立场最大跨度

**Files / 文件:** Modify / 修改 `backend/app/services/factions.py` and / 及
`backend/tests/test_factions.py`.

- [ ] Add a chain regression whose adjacent deltas are below `0.3` but whose
  first-to-last span is greater than `0.3`.  The old adjacent-link algorithm
  must fail by merging the whole chain.

  增加链式回归：相邻差值小于 `0.3`，但首尾跨度大于 `0.3`。旧的相邻连接算法会错误地合并整条链，因此该测试应先失败。
- [ ] Sort deterministically by `(stance, agent_id)` and compare each candidate
  against the current group's minimum/anchor, so every faction's total range is
  below the documented threshold.  Preserve the strict boundary behavior.

  按 `(stance, agent_id)` 确定性排序，并将每个候选者与当前组的最小值／锚点比较，使每个阵营的总跨度低于文档阈值。保留严格边界行为。
- [ ] Keep relation persistence and public payload shape unchanged; run the
  complete faction suite and commit independently.

  保持关系持久化方式及公开载荷结构不变；运行完整阵营测试集，并独立提交。

### Task 2c: Preserve signed stance information in report probabilities / 任务 2c：在报告概率中保留带符号的立场信息

**Files / 文件:** Modify / 修改 `backend/app/services/result_report/reducer.py` and / 及
`backend/tests/test_result_report_reducer.py`.

- [ ] RED: faction centers `-1`, `0`, and `1` must project to `0`, `0.5`, and
  `1`; negative factions must not all collapse to zero.

  RED：阵营中心 `-1`、`0`、`1` 必须映射为 `0`、`0.5`、`1`；负立场阵营不能全部压为零。
- [ ] Map signed centers with `(stance + 1) / 2` before the existing finite
  probability clamp.  Do not change schema or field names.

  先用 `(stance + 1) / 2` 映射带符号中心，再执行现有有限概率限幅。不改变 schema 或字段名。
- [ ] Verify distribution, uncertainty, and legacy non-finite guards, then
  commit independently.

  验证分布、不确定性及原有非有限值保护，然后独立提交。

### Task 2d: Push faction read limits into SQLite without changing graph semantics / 任务 2d：将阵营读取限额下推至 SQLite，不改变图语义

**Files / 文件:** Modify / 修改 `backend/app/services/factions.py`,
`backend/tests/test_factions.py`, and / 及 `backend/tests/test_wave1_agent_state.py`.

- [ ] For relation API reads, use `ROW_NUMBER() OVER (PARTITION BY round_number)`
  with the exact current weight/tie ordering and fetch at most `top_k + 1` per
  round; preserve raw-count, threshold, round limit, relation type, and
  `truncated` semantics.

  关系 API 读取使用 `ROW_NUMBER() OVER (PARTITION BY round_number)`，严格沿用现有权重及并列排序，每轮最多取 `top_k + 1` 条；保留原始计数、阈值、轮次限额、关系类型和 `truncated` 语义。
- [ ] For previous-round prompt context, push the per-Agent strongest-edge
  limit into one SQL window query while preserving runtime alias ordering,
  bidirectional views, unknown-peer fallback, and input Agent order.

  上一轮提示词上下文使用一个 SQL 窗口查询限制每个 Agent 的最强关系边，同时保留运行时别名排序、双向视图、未知对端回退和输入 Agent 顺序。
- [ ] Replace betrayal faction membership scans with one first-write-wins map.
  Assert the service query counts and bounded loaded-row counts rather than a
  brittle wall-clock threshold.

  将背叛相关的阵营成员扫描替换为首次写入生效的单一映射。断言服务查询次数和加载行数上限，不依赖脆弱的实际耗时阈值。

**Not authorized by this task:** replacing dense relation writes with a sampled
graph.  At 1500 Agents the current writer emits 1,124,250 edges per round, but
sampling changes report statistics, prompts, and graph coverage.  It requires
an explicit product decision plus `sampled/possible_pair_count/coverage_ratio`
transparency fields; do not silently ship it as a mere optimization.

**此任务未授权：** 将稠密关系写入替换为采样图。当时的写入器在 1500 个 Agent 时每轮产生 1,124,250 条边，但采样会改变报告统计、提示词与图覆盖率。这需要明确的产品决策，以及 `sampled/possible_pair_count/coverage_ratio` 透明度字段，不能当作普通优化静默发布。

### Task 3: Remove report lifecycle ambiguity and single-path statistical overclaiming / 任务 3：消除报告生命周期歧义及单路径统计夸大

**Files / 文件:**

- Modify / 修改: `backend/tests/test_result_report_reducer.py`
- Modify / 修改: `backend/tests/test_result_report_builder.py`
- Modify / 修改: `backend/tests/test_result_report_contract.py`
- Modify / 修改: `backend/app/services/result_report/reducer.py:801-815`
- Modify / 修改: `backend/app/services/result_report/schema.py:443-461`
- Modify / 修改: `backend/app/services/result_report/builder.py:480-674`
- Modify / 修改: `backend/app/api/scenarios.py:2439-2453`

- [ ] **Step 1: Write failing report-truth tests / 步骤 1：编写预期失败的报告真实性测试**

In `test_reduce_handles_empty_single_and_missing_snapshot_cases`, replace the assertion that blesses `(0.95, 1.0)` with:

在 `test_reduce_handles_empty_single_and_missing_snapshot_cases` 中，将认可 `(0.95, 1.0)` 的断言替换为：

```python
assert single_result.likelihood.probability == 1.0
assert single_result.likelihood.interval == (1.0, 1.0)
assert single_result.likelihood.wep == "single_path"
```

Extend `test_build_report_initial_persist_marks_report_generating` so it observes the payload after the first of two sections:

扩展 `test_build_report_initial_persist_marks_report_generating`，观察两个章节中第一个完成后的载荷：

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

在 `test_plan_failure_uses_fallback_outline_and_section_failure_isolated` 中保留现有准备逻辑，并修改终态断言：

```python
assert report.status == "failed"
assert [section.id for section in report.sections] == ["timeline"]
assert validate_full_report_payload(_persisted_report(scenario_id)).status == "failed"
```

In `test_story_full_report_downgrades_stale_generating_without_runtime_lease`, keep the existing setup and change only the status assertion:

在 `test_story_full_report_downgrades_stale_generating_without_runtime_lease` 中保留现有准备逻辑，仅修改状态断言：

```python
assert result["full_report"]["status"] == "failed"
assert result["full_report"]["version"] == "1.0"
```

Clone that story test with an inactive legacy full report whose status is `partial`:

复制该 story 测试，使用状态为 `partial`、已无活动生成的旧版完整报告：

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

在 `test_oversize_report_truncates_fail_closed` 中，要求受大小限制的完整报告使用终态：

```python
assert report.status == "failed"
assert utf8_json_size_bytes(payload) <= 3600
assert validate_full_report_payload(payload, max_bytes=3600).status == "failed"
```

Extend the existing SSE contract test so section progress exposes only bounded observability fields:

扩展现有 SSE 合同测试，使章节进度只暴露受限的可观测字段：

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

- [ ] **Step 2: Run the tests and verify RED / 步骤 2：运行测试并确认 RED（预期失败）**

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

预期：reducer 输出 `almost_certain` 和虚构的分布范围；中间持久化使用 `partial`；过期生成也变成终态 `partial`。

- [ ] **Step 3: Implement backward-compatible report semantics / 步骤 3：实现向后兼容的报告语义**

Keep `Likelihood.probability` and `Likelihood.interval` present for response compatibility. Change only the single-path semantic sentinel:

保留 `Likelihood.probability` 和 `Likelihood.interval` 以兼容响应，只修改单路径语义标记：

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

章节循环期间始终持久化 `status="generating"`，在最终组装时明确终态：

```python
final_status: ReportStatus = (
    "complete"
    if failed_sections == 0 and len(completed_sections) >= len(outline.sections)
    else "failed"
)
```

Add backward-compatible optional progress metadata to `ResultReportSSEData`:

向 `ResultReportSSEData` 增加向后兼容的可选进度元数据：

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

在 `report_section_complete` 中从每个 `SectionBuildResult` 填充 `tier` 和 `failure_reason`；章节两次生成尝试均耗尽时使用 `failure_reason="other"`。SSE 不应包含原始异常文本。

Preserve successfully generated sections in a failed report and keep failure reasons visible. `_fit_report_to_byte_cap` must also keep a bounded, pruned full report terminal as `failed` instead of reintroducing terminal `partial`. In `/story`, convert stale `generating` or legacy full-report `partial` payloads with no active runtime lock to `failed`; guard the intentionally distinct `{status: "partial", truncated: true}` response-size marker so it remains a marker rather than a full report.

失败报告保留成功生成的章节，并显示失败原因。`_fit_report_to_byte_cap` 也必须让裁剪后、符合大小上限的完整报告保持 `failed` 终态，不重新引入终态 `partial`。在 `/story` 中，把没有活动运行锁的过期 `generating` 或旧版完整报告 `partial` 载荷转换为 `failed`；保护含义不同的响应大小标记 `{status: "partial", truncated: true}`，使其继续作为标记而不是完整报告。

- [ ] **Step 4: Verify GREEN and report compatibility / 步骤 4：确认 GREEN 并验证报告兼容性**

Run one pytest process:

仅运行一个 pytest 进程：

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_result_report_reducer.py \
  tests/test_result_report_builder.py \
  tests/test_result_report_contract.py \
  tests/test_result_report_indicators.py
```

Expected: PASS; full reports use `generating → complete|failed`, legacy payload validation still accepts `partial`, and the truncated marker remains distinguishable.

预期：PASS；完整报告遵循 `generating → complete|failed`，旧载荷校验仍接受 `partial`，截断标记仍可区分。

- [ ] **Step 5: Commit the report-truth fix / 步骤 5：提交报告真实性修复**

```bash
git add backend/app/services/result_report/reducer.py \
  backend/app/services/result_report/schema.py backend/app/services/result_report/builder.py \
  backend/app/api/scenarios.py \
  backend/tests/test_result_report_reducer.py \
  backend/tests/test_result_report_builder.py \
  backend/tests/test_result_report_contract.py
git commit -m "fix(report): make progress and single-path claims truthful"
```

### Task 4: Stop shipped packs from advertising nonexistent demo snapshots / 任务 4：停止在随附主题包中声明不存在的演示快照

**Files / 文件:**

- Modify / 修改: `backend/tests/test_local_packs.py`
- Modify / 修改: `packs/civic-food-futures.json`
- Modify / 修改: `packs/cooperative-ai-foundry.json`
- Modify / 修改: `packs/island-library-radio.json`
- Modify / 修改: `packs/neighborhood-carbon-ledger.json`
- Modify / 修改: `packs/public-clockwork.json`
- Modify / 修改: `packs/river-city-sponge-grid.json`
- Modify / 修改: `packs/silk-road-press.json`
- Modify / 修改: `packs/spice-port-mutuals.json`
- Modify / 修改: `packs/zheng-he.json`

- [ ] **Step 1: Add a failing shipped-content existence test / 步骤 1：增加预期失败的随附内容存在性测试**

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

- [ ] **Step 2: Run the test and verify RED / 步骤 2：运行测试并确认 RED（预期失败）**

```bash
cd backend
.venv/bin/python -m pytest -q \
  tests/test_local_packs.py::test_shipped_pack_demo_snapshots_exist
```

Expected: FAIL listing nine nonexistent `.json` filenames.

预期：FAIL，并列出九个不存在的 `.json` 文件名。

- [ ] **Step 3: Remove false references and retain only semantically matching real demos / 步骤 3：删除虚假引用，仅保留语义匹配的真实演示**

Remove `demo_snapshots` from packs that have no real demo. Replace only the two verified matching entries:

从没有真实演示的主题包中删除 `demo_snapshots`。仅替换以下两个已核验匹配的条目：

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

不要创建占位快照，也不要给无关样例换标签。

- [ ] **Step 4: Verify GREEN and all pack contracts / 步骤 4：确认 GREEN 并验证所有主题包合同**

```bash
cd backend
.venv/bin/python -m pytest -q tests/test_local_packs.py tests/test_sample_snapshots.py
```

Expected: PASS; every advertised filename exists and all JSON remains bilingual and schema-valid.

预期：PASS；每个声明的文件名均存在，所有 JSON 保持中英双语并符合 schema。

- [ ] **Step 5: Commit the content-truth fix / 步骤 5：提交内容真实性修复**

```bash
git add backend/tests/test_local_packs.py packs/*.json
git commit -m "fix(packs): remove nonexistent demo references"
```
