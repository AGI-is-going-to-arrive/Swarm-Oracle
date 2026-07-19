"""Pure contracts for deterministic social-action opportunity snapshots."""

from __future__ import annotations

import hashlib
import inspect
import json
import random
import re
from dataclasses import replace

import app.services.action_opportunities as action_opportunities
from app.config import settings
from app.services.action_opportunities import (
    DomainOpportunityReasonCodeV1,
    OpportunityReceiptV1,
    OpportunitySnapshotV1,
    derive_opportunity_snapshots_v1,
    opportunity_snapshot_to_prompt_payload_v1,
    search_query_fingerprint_v1,
)
from app.services.social_world import (
    SocialComment,
    SocialPost,
    SocialReaction,
    SocialRefreshReceipt,
    SocialSearchReceipt,
    SocialTrendItem,
    SocialTrendReceipt,
    SocialWorldState,
)

_SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def _comment(
    action_id: str,
    post_id: str,
    author_id: str,
    sequence: int,
    content: str = "comment",
) -> SocialComment:
    return SocialComment(action_id, post_id, author_id, content, sequence)


def _reaction(
    action_id: str,
    post_id: str,
    author_id: str,
    sequence: int,
    kind: str = "LIKE",
) -> SocialReaction:
    return SocialReaction(action_id, post_id, author_id, kind, sequence)


def _post(
    action_id: str,
    author_id: str,
    sequence: int,
    *,
    content: str = "post",
    comments: tuple[SocialComment, ...] = (),
    reactions: tuple[SocialReaction, ...] = (),
    author_name_override: str | None = None,
    tags: tuple[str, ...] = (),
    activity_events: tuple[tuple[int, str], ...] | None = None,
) -> SocialPost:
    events = activity_events or (
        (sequence, author_id),
        *((item.sequence, item.author_id) for item in comments),
        *((item.sequence, item.author_id) for item in reactions),
    )
    return SocialPost(
        action_id=action_id,
        author_id=author_id,
        content=content,
        sequence=sequence,
        round_number=1,
        author_name_override=author_name_override,
        published_at=None,
        credibility_hint=None,
        tags=tags,
        comments=comments,
        reactions=reactions,
        activity_events=events,
    )


def _state(
    posts: tuple[SocialPost, ...] = (),
    *,
    following: dict[str, frozenset[str]] | None = None,
    muted: dict[str, frozenset[str]] | None = None,
    recent_searches: dict[str, tuple[SocialSearchReceipt, ...]] | None = None,
    trend_receipts: dict[str, tuple[SocialTrendReceipt, ...]] | None = None,
    refresh_receipts: dict[str, tuple[SocialRefreshReceipt, ...]] | None = None,
    last_seen: dict[str, int] | None = None,
    diagnostics: dict[str, int] | None = None,
) -> SocialWorldState:
    contributor_ids = {
        contributor
        for post in posts
        for contributor in (
            post.author_id,
            *(item.author_id for item in post.comments),
            *(item.author_id for item in post.reactions),
        )
    }
    return SocialWorldState(
        scenario_id="scenario",
        branch_id="branch",
        cutoff_round=4,
        agent_names={
            identifier: identifier.title() for identifier in sorted({"viewer", *contributor_ids})
        },
        posts=posts,
        following=following or {},
        muted=muted or {},
        recent_searches=recent_searches or {},
        trend_receipts=trend_receipts or {},
        refresh_receipts=refresh_receipts or {},
        last_seen=last_seen or {},
        trend_counts={post.action_id: len(post.activity_events) for post in posts},
        diagnostics=diagnostics or {},
    )


def _catalog(
    action_ids: tuple[str, ...] = (),
    agent_ids: tuple[str, ...] = (),
    *,
    source_ids: frozenset[str] = frozenset(),
) -> dict:
    return {
        "actions": [
            {
                "id": identifier,
                "kind": "post",
                "type": "POST",
                "agent_name": "target",
                "content": "target",
            }
            for identifier in action_ids
        ],
        "agents": [
            {
                "id": identifier,
                "name": identifier.title(),
                "kind": "source" if identifier in source_ids else "agent",
            }
            for identifier in agent_ids
        ],
    }


def _derive(
    state: SocialWorldState,
    catalog: dict | None = None,
    receipt: OpportunityReceiptV1 | None = None,
    *,
    actor_id: str = "viewer",
    domain_opportunities: dict | None = None,
) -> OpportunitySnapshotV1:
    return derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor={actor_id: catalog or _catalog()},
        prior_receipts_by_actor={actor_id: receipt},
        domain_opportunities=domain_opportunities,
    )[actor_id]


def _receipt(
    snapshot: OpportunitySnapshotV1,
    *,
    corpus_revision: str | None = None,
    history: list[str] | None = None,
    history_complete: bool = True,
    last_trend_signature: str | None = None,
    domain_state_revision: str | None = None,
    allowed_rule_ids: list[str] | None = None,
) -> OpportunityReceiptV1:
    return {
        "version": 1,
        "as_of_round": snapshot.as_of_round,
        "social_state_revision": snapshot.social_state_revision,
        "domain_state_revision": domain_state_revision,
        "allowed_rule_ids": allowed_rule_ids or [],
        "requested_action_type": "IDLE",
        "effective_action_type": "IDLE",
        "available": True,
        "grounded": True,
        "reason_codes": ["IDLE_ALWAYS_AVAILABLE"],
        "eligible_target_count": 0,
        "selected_target_eligible": None,
        "parameter_eligible": None,
        "corpus_revision": corpus_revision,
        "query_fingerprint": None,
        "search_history_complete": history_complete,
        "recent_query_fingerprints": history or [],
        "current_trend_signature": snapshot.actions["TREND"]["current_trend_signature"],
        "last_trend_signature": last_trend_signature,
        "idle_reason_code": "IDLE_NO_ACTION_NEEDED",
        "failure_code": None,
        "compatibility_mode": "live",
    }


def test_snapshot_order_hash_and_prompt_payload_are_canonical():
    state = _state((_post("post-1", "author", 1),), diagnostics={"ignored": 1})
    snapshots = derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor={"zeta": _catalog(), "alpha": _catalog()},
        prior_receipts_by_actor={},
    )

    assert list(snapshots) == ["alpha", "zeta"]
    snapshot = snapshots["alpha"]
    assert snapshot.version == 1
    assert snapshot.as_of_round == 4
    assert snapshot.domain_state_revision is None
    assert snapshot.allowed_rule_ids == ()
    assert _SHA256_RE.fullmatch(snapshot.social_state_revision)
    assert list(snapshot.actions) == [
        "IDLE",
        "POST",
        "COMMENT",
        "REACTION",
        "FOLLOW",
        "MUTE",
        "SEARCH",
        "TREND",
        "REFRESH",
    ]
    without_diagnostic_change = _derive(replace(state, diagnostics={"other": 99}))
    semantic_change = _derive(replace(state, last_seen={"viewer": 1}))
    assert without_diagnostic_change.social_state_revision == snapshot.social_state_revision
    assert semantic_change.social_state_revision != snapshot.social_state_revision

    payload = opportunity_snapshot_to_prompt_payload_v1(snapshot)
    assert list(payload) == [
        "version",
        "actor_id",
        "as_of_round",
        "social_state_revision",
        "domain_state_revision",
        "allowed_rule_ids",
        "actions",
    ]
    assert payload["allowed_rule_ids"] == []
    assert payload["actions"]["IDLE"]["reason_codes"] == ["IDLE_ALWAYS_AVAILABLE"]
    assert all(gate["domain_reason_codes"] == () for gate in snapshot.actions.values())
    assert all(gate["domain_reason_codes"] == [] for gate in payload["actions"].values())
    assert "opportunity_receipt" not in payload


def test_query_fingerprint_uses_exact_normalization_and_corpus_binding():
    corpus = "sha256:" + "1" * 64
    fingerprint = search_query_fingerprint_v1("  Straße\n  Alpha  ", corpus_revision=corpus)
    encoded = json.dumps(
        {
            "kind": "search_query_fingerprint_v1",
            "payload": {
                "corpus_revision": corpus,
                "normalized_query": "strasse alpha",
            },
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    assert fingerprint == f"sha256:{hashlib.sha256(encoded).hexdigest()}"
    assert search_query_fingerprint_v1(" \n\t ", corpus_revision=corpus) is None
    assert search_query_fingerprint_v1(0, corpus_revision=corpus) is None
    assert search_query_fingerprint_v1("alpha", corpus_revision="other") != fingerprint


def test_empty_world_has_only_idle_and_post_available_without_selection():
    snapshot = _derive(_state())

    assert [name for name, gate in snapshot.actions.items() if gate["available"]] == [
        "IDLE",
        "POST",
    ]
    assert snapshot.actions["SEARCH"]["reason_codes"] == ("SEARCH_CORPUS_EMPTY",)
    assert snapshot.actions["TREND"]["current_trend_signature"] is None
    assert all("selected_action" not in gate for gate in snapshot.actions.values())


def test_comment_follow_and_reaction_gates_use_visible_state_and_catalog_order():
    comments = (_comment("comment-carol", "post-bob", "carol", 5),)
    reactions = (
        _reaction("reaction-viewer", "post-bob", "viewer", 6, "LIKE"),
        _reaction("reaction-dave", "post-bob", "dave", 7, "WOW"),
    )
    state = _state(
        (
            _post("post-self", "viewer", 1),
            _post("post-muted", "muted", 2),
            _post("post-dave", "dave", 3),
            _post("post-bob", "bob", 4, comments=comments, reactions=reactions),
        ),
        following={"viewer": frozenset({"bob"})},
        muted={"viewer": frozenset({"muted"})},
    )
    catalog = _catalog(
        (
            "comment-carol",
            "post-muted",
            "post-bob",
            "reaction-dave",
            "reaction-viewer",
            "post-bob",
            "unknown",
        ),
        ("bob", "dave", "muted", "viewer", "carol"),
    )
    actions = _derive(state, catalog).actions

    expected_targets = ("comment-carol", "post-bob", "reaction-dave")
    assert actions["COMMENT"]["eligible_target_ids"] == expected_targets
    assert actions["REACTION"]["eligible_target_ids"] == expected_targets
    assert actions["FOLLOW"]["eligible_target_ids"] == ("dave",)
    reaction_kinds = actions["REACTION"]["eligible_reaction_kinds_by_target"]
    for target_id in expected_targets:
        assert "LIKE" not in reaction_kinds[target_id]
        assert "LOVE" in reaction_kinds[target_id]
    assert actions["REACTION"]["eligible_reaction_kinds_by_target"]["post-bob"] == (
        "LOVE",
        "LAUGH",
        "WOW",
        "SAD",
        "ANGRY",
        "SUPPORT",
        "OPPOSE",
    )


def test_mute_accepts_only_presented_nonself_unmuted_contributors():
    presented = _post(
        "post-source",
        "source",
        1,
        comments=(
            _comment("commenter", "post-source", "commenter", 2),
            _comment("self-comment", "post-source", "viewer", 3),
            _comment("muted-comment", "post-source", "muted", 4),
        ),
        reactions=(
            _reaction("reactor", "post-source", "reactor", 5),
            _reaction("muted-reaction", "post-source", "muted", 6),
        ),
    )
    state = _state(
        (presented, _post("post-outside", "outside", 7)),
        muted={"viewer": frozenset({"muted"})},
        refresh_receipts={
            "viewer": (SocialRefreshReceipt(("post-source",), 1, 8),)
        },
    )
    catalog = _catalog(
        ("post-source",),
        ("outside", "source", "commenter", "reactor", "viewer", "muted"),
        source_ids=frozenset({"source"}),
    )

    mute = _derive(state, catalog).actions["MUTE"]
    assert mute["available"] is True
    assert mute["grounded"] is True
    assert mute["reason_codes"] == ("MUTE_FILTER_EFFECT_AVAILABLE",)
    assert mute["eligible_target_ids"] == ("source", "commenter", "reactor")


def test_mute_default_feed_excludes_visible_contributor_below_four_cards():
    posts = tuple(_post(f"post-{index}", f"author-{index}", index) for index in range(1, 6))
    catalog = _catalog(agent_ids=tuple(f"author-{index}" for index in range(1, 6)))

    mute = _derive(_state(posts), catalog).actions["MUTE"]
    assert mute["eligible_target_ids"] == (
        "author-2",
        "author-3",
        "author-4",
        "author-5",
    )
    assert "author-1" not in mute["eligible_target_ids"]


def test_reliability_spam_and_waiting_text_have_zero_gate_influence():
    catalog = _catalog(("post-author",), ("author",))
    noisy = _derive(
        _state((_post("post-author", "author", 2, content="spam unreliable waiting"),)),
        catalog,
    )
    neutral = _derive(
        _state((_post("post-author", "author", 2, content="ordinary update"),)),
        catalog,
    )

    for action_type in noisy.actions:
        assert noisy.actions[action_type]["available"] == neutral.actions[action_type]["available"]
        assert noisy.actions[action_type]["grounded"] == neutral.actions[action_type]["grounded"]
        assert (
            noisy.actions[action_type]["eligible_target_ids"]
            == neutral.actions[action_type]["eligible_target_ids"]
        )


def test_refresh_counts_all_visible_root_posts_only():
    old_post_with_new_comment = _post(
        "old",
        "author",
        4,
        comments=(_comment("new-comment", "old", "commenter", 99),),
    )
    state = _state(
        (
            old_post_with_new_comment,
            _post("new-visible", "visible", 10),
            _post("new-muted", "muted", 20),
        ),
        muted={"viewer": frozenset({"muted"})},
        last_seen={"viewer": 4},
    )
    assert _derive(state).actions["REFRESH"]["available"] is True

    caught_up = replace(state, last_seen={"viewer": 10})
    refresh = _derive(caught_up).actions["REFRESH"]
    assert refresh["available"] is False
    assert refresh["reason_codes"] == ("REFRESH_NO_UNSEEN_POSTS",)


def test_trend_receipt_consumes_signature_and_visible_activity_reopens_it():
    state = _state((_post("post-a", "a", 1), _post("post-b", "b", 2)))
    initial = _derive(state)
    trend = initial.actions["TREND"]
    assert trend["available"] is True
    assert trend["reason_codes"] == ("TREND_INITIAL_VOLUME_AVAILABLE",)
    assert _SHA256_RE.fullmatch(trend["current_trend_signature"] or "")

    consumed = _receipt(initial, last_trend_signature=trend["current_trend_signature"])
    closed = _derive(state, receipt=consumed).actions["TREND"]
    assert closed["available"] is False
    assert closed["reason_codes"] == ("TREND_NO_NEW_ACTIVITY",)

    changed_post = _post(
        "post-b",
        "b",
        2,
        comments=(_comment("comment-c", "post-b", "c", 3),),
    )
    changed = _derive(
        replace(state, posts=(state.posts[0], changed_post)),
        receipt=consumed,
    ).actions["TREND"]
    assert changed["available"] is True
    assert changed["reason_codes"] == ("TREND_SIGNATURE_CHANGED",)

    one_with_interaction = _derive(_state((changed_post,))).actions["TREND"]
    assert one_with_interaction["reason_codes"] == ("TREND_INITIAL_INTERACTION_AVAILABLE",)


def test_search_history_is_complete_beyond_five_and_resets_on_corpus_revision():
    state = _state((_post("post-a", "a", 1, content="alpha"),))
    initial = _derive(state)
    corpus = initial.actions["SEARCH"]["corpus_revision"]
    history = [
        search_query_fingerprint_v1(f"query {index}", corpus_revision=corpus)
        for index in range(6)
    ]
    assert all(history)
    receipt = _receipt(initial, corpus_revision=corpus, history=history)

    unchanged = _derive(state, receipt=receipt).actions["SEARCH"]
    assert unchanged["available"] is True
    assert unchanged["search_history_complete"] is True
    assert unchanged["recent_query_fingerprints"] == tuple(history)
    assert search_query_fingerprint_v1("query 0", corpus_revision=corpus) in history

    changed_state = _state((_post("post-a", "a", 1, content="alpha revised"),))
    changed = _derive(changed_state, receipt=receipt).actions["SEARCH"]
    assert changed["corpus_revision"] != corpus
    assert changed["recent_query_fingerprints"] == ()
    assert changed["search_history_complete"] is True


def test_search_invalid_or_incomplete_history_fails_closed_until_revision_change(monkeypatch):
    monkeypatch.setattr(settings, "MAX_ROUNDS", 5)
    state = _state(
        (_post("post-a", "a", 1, content="alpha"),),
        recent_searches={"viewer": (SocialSearchReceipt("alpha", ("post-a",), 2),)},
    )
    initial = _derive(state)
    corpus = initial.actions["SEARCH"]["corpus_revision"]
    over_limit = [
        search_query_fingerprint_v1(f"query {index}", corpus_revision=corpus)
        for index in range(6)
    ]
    invalid_receipt = _receipt(initial, corpus_revision=corpus, history=over_limit)

    invalid = _derive(state, receipt=invalid_receipt).actions["SEARCH"]
    assert invalid["available"] is False
    assert invalid["search_history_complete"] is False
    assert invalid["reason_codes"] == ("SEARCH_HISTORY_UNAVAILABLE",)

    incomplete_receipt = _receipt(
        initial,
        corpus_revision=corpus,
        history_complete=False,
    )
    incomplete = _derive(state, receipt=incomplete_receipt).actions["SEARCH"]
    assert incomplete["reason_codes"] == ("SEARCH_HISTORY_UNAVAILABLE",)

    revised_state = _state(
        (_post("post-a", "a", 1, content="different corpus"),),
        recent_searches=state.recent_searches,
    )
    reset = _derive(revised_state, receipt=incomplete_receipt).actions["SEARCH"]
    assert reset["available"] is True
    assert reset["search_history_complete"] is True
    assert reset["recent_query_fingerprints"] == ()


def test_missing_trusted_trend_receipt_uses_durable_state_conservative_fallback():
    state = _state(
        (_post("post-a", "a", 1), _post("post-b", "b", 2)),
        trend_receipts={
            "viewer": (
                SocialTrendReceipt(
                    items=(SocialTrendItem("post-a", 1, 64),),
                    sequence=3,
                ),
            )
        },
    )
    trend = _derive(state).actions["TREND"]
    assert trend["last_trend_signature"] == trend["current_trend_signature"]
    assert trend["available"] is False
    assert trend["reason_codes"] == ("TREND_NO_NEW_ACTIVITY",)


_DOMAIN_REVISION = "sha256:" + "b" * 64


def _evaluated_rule(rule_id: str, action_type: object, *, met: bool = True, **changes) -> dict:
    predicate = {
        "variable_id": "balance", "comparator": "eq",
        "expected_value": "1" if met else "2", "actual_value": "1",
        "unit": "count", "met": met,
    }
    predicate.update(changes)
    return {
        "rule_id": rule_id, "variable_id": "balance", "action_type": action_type,
        "preconditions_met": met, "preconditions": (predicate,),
    }


def _domain_evaluation(*rules: dict, **changes) -> dict:
    value = {
        "version": 1, "schema_hash": "sha256:" + "a" * 64,
        "input_state_revision": _DOMAIN_REVISION, "as_of_round": 4, "rules": rules,
    }
    value.update(changes)
    return value


def _rich_domain_fixture() -> tuple[SocialWorldState, dict]:
    return _state(
        (_post("post-a", "alice", 1), _post("post-b", "bob", 2)),
        muted={"closed": frozenset({"alice", "bob"})},
    ), _catalog(("post-a", "post-b"), ("alice", "bob"))


def test_domain_exact_set_oracle_conjoins_all_eight_actions_per_actor():
    assert DomainOpportunityReasonCodeV1.__args__ == (
        "OPPORTUNITY_DOMAIN_RULE_ALLOWED", "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",
        "OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED",
    )
    state, catalog = _rich_domain_fixture()
    action_types = ("COMMENT", "FOLLOW", "MUTE", "POST", "REACTION", "REFRESH", "SEARCH", "TREND")
    evaluation = _domain_evaluation(*(
        _evaluated_rule(f"allow_{action.lower()}", action) for action in action_types
    ))
    opened = _derive(state, catalog, domain_opportunities=evaluation)
    closed = _derive(state, catalog, actor_id="closed", domain_opportunities=evaluation)
    assert opened.allowed_rule_ids == (
        "allow_comment", "allow_follow", "allow_mute", "allow_post",
        "allow_reaction", "allow_refresh", "allow_search", "allow_trend",
    )
    assert closed.allowed_rule_ids == ("allow_post",)
    assert opened.domain_state_revision == _DOMAIN_REVISION
    assert all(opened.actions[action]["domain_reason_codes"] == (
        "OPPORTUNITY_DOMAIN_RULE_ALLOWED",
    ) for action in action_types)
    assert all(closed.actions[action]["domain_reason_codes"] == (
        "OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED",
    ) for action in action_types if action != "POST")
    assert closed.actions["IDLE"]["domain_reason_codes"] == ()
    for action, baseline in _derive(state, catalog).actions.items():
        assert {key: value for key, value in opened.actions[action].items()
                if key != "domain_reason_codes"} == {
            key: value for key, value in baseline.items() if key != "domain_reason_codes"
        }


def test_domain_false_mixed_and_empty_evaluations_have_exact_reasons():
    state, catalog = _rich_domain_fixture()
    snapshot = _derive(state, catalog, domain_opportunities=_domain_evaluation(
        _evaluated_rule("a_false", "POST", met=False), _evaluated_rule("b_true", "POST"),
        _evaluated_rule("c_false", "COMMENT", met=False),
    ))
    assert snapshot.allowed_rule_ids == ("b_true",)
    assert snapshot.actions["POST"]["domain_reason_codes"] == (
        "OPPORTUNITY_DOMAIN_RULE_ALLOWED",
    )
    assert snapshot.actions["COMMENT"]["domain_reason_codes"] == (
        "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",
    )
    assert snapshot.actions["FOLLOW"]["domain_reason_codes"] == ()
    empty = _derive(state, catalog, domain_opportunities=_domain_evaluation())
    assert (empty.domain_state_revision, empty.allowed_rule_ids) == (_DOMAIN_REVISION, ())
    assert all(gate["domain_reason_codes"] == () for gate in empty.actions.values())


def test_invalid_domain_evaluation_is_atomic_and_valid_caps_are_retained():
    state, catalog = _rich_domain_fixture()
    valid, wrong_met = _domain_evaluation(_evaluated_rule("a_rule", "POST")), _evaluated_rule(
        "a_rule", "POST"
    )
    wrong_met["preconditions_met"] = False
    invalid_action = _evaluated_rule("a_rule", [])
    conflicting = _evaluated_rule("b_rule", "POST", expected_value="2", actual_value="2")
    invalid = (
        *(_domain_evaluation(**change) for change in (
            {"version": 2}, {"schema_hash": "invalid"}, {"input_state_revision": "invalid"},
            {"as_of_round": 3}, {"rules": list(valid["rules"])},
        )),
        _domain_evaluation(_evaluated_rule("b_rule", "POST"), _evaluated_rule("a_rule", "POST")),
        _domain_evaluation(_evaluated_rule("a_rule", "POST"), _evaluated_rule("a_rule", "POST")),
        _domain_evaluation(_evaluated_rule("a_rule", "IDLE")), _domain_evaluation(wrong_met),
        _domain_evaluation(_evaluated_rule("a_rule", "POST", expected_value="banana",
                                          actual_value="banana")),
        _domain_evaluation(_evaluated_rule("a_rule", "POST", unit="unitless",
                                          expected_value="1.0", actual_value="1.00")),
        _domain_evaluation(_evaluated_rule("a_rule", "POST", unit="unitless",
                                          expected_value="1.0000000", actual_value="1.0000000")),
        _domain_evaluation(_evaluated_rule("a_rule", "POST", comparator=[])),
        _domain_evaluation(invalid_action),
        _domain_evaluation(_evaluated_rule("a_rule", "POST", expected_value="1" * 29,
                                          actual_value="1" * 29)),
        _domain_evaluation(_evaluated_rule("a_rule", "POST"), conflicting),
        _domain_evaluation(*(_evaluated_rule(f"rule_{index:02d}", "POST") for index in range(17))),
    )
    baseline = _derive(state, catalog)
    assert all(_derive(state, catalog, domain_opportunities=row) == baseline for row in invalid)
    sixteen = _domain_evaluation(*(
        _evaluated_rule(f"rule_{index:02d}", "POST") for index in range(16)
    ))
    assert _derive(state, catalog, domain_opportunities=sixteen).allowed_rule_ids == tuple(
        f"rule_{index:02d}" for index in range(16)
    )
    custom = _evaluated_rule(
        "custom_rule", "POST", unit="custom_count:score",
        expected_value="1.00", actual_value="1.00",
    )
    custom_snapshot = _derive(state, catalog, domain_opportunities=_domain_evaluation(custom))
    assert custom_snapshot.allowed_rule_ids == ("custom_rule",)


def test_receipt_domain_fields_validate_but_never_grant_current_permission():
    state, catalog = _rich_domain_fixture()
    initial, digest = _derive(state, catalog), "sha256:" + "c" * 64
    receipt = _receipt(initial)
    valid_cases = ((None, []), (digest, []), (digest, [f"rule_{i:02d}" for i in range(16)]))
    invalid_cases = (
        (None, ["rule_a"]), ("sha256:" + "A" * 64, []), (digest, ["rule_b", "rule_a"]),
        (digest, ["rule_a", "rule_a"]), (digest, ["Bad"]),
        (digest, [f"rule_{i:02d}" for i in range(17)]),
    )
    for expected, cases in ((True, valid_cases), (False, invalid_cases)):
        for revision, rule_ids in cases:
            assert action_opportunities._receipt_is_valid({
                **receipt, "domain_state_revision": revision, "allowed_rule_ids": rule_ids,
            }) is expected
    current = _domain_evaluation(_evaluated_rule("current_rule", "POST"))
    populated = _receipt(initial, domain_state_revision=digest, allowed_rule_ids=["prior_rule"])
    assert _derive(state, catalog, populated, domain_opportunities=current) == _derive(
        state, catalog, receipt, domain_opportunities=current
    )


def test_catalog_prose_mutation_is_byte_invariant_for_domain_derivation():
    state, catalog = _rich_domain_fixture()
    changed = {
        "actions": [{**row, "agent_name": "Changed", "content": "Unrelated prose"}
                    for row in catalog["actions"]],
        "agents": [{**row, "name": "Different name"} for row in catalog["agents"]],
    }
    evaluation = _domain_evaluation(_evaluated_rule("allow_post", "POST"))
    payloads = [opportunity_snapshot_to_prompt_payload_v1(
        _derive(state, value, domain_opportunities=evaluation)
    ) for value in (catalog, changed)]
    assert json.dumps(payloads[0], sort_keys=True, separators=(",", ":")) == json.dumps(
        payloads[1], sort_keys=True, separators=(",", ":")
    )
    assert set(inspect.signature(derive_opportunity_snapshots_v1).parameters) == {
        "social_state", "target_catalogs_by_actor", "prior_receipts_by_actor",
        "domain_opportunities",
    }


def test_equivalent_visibility_cache_preserves_per_actor_semantics_and_permutation():
    post = _post(
        "post-shared",
        "author",
        3,
        reactions=(
            _reaction("reaction-alpha", "post-shared", "alpha", 4, "LOVE"),
            _reaction("reaction-beta", "post-shared", "beta", 5, "WOW"),
        ),
    )
    state = _state(
        (post, _post("post-other", "other", 7)),
        recent_searches={
            "beta": (SocialSearchReceipt("query", ("post-shared",), 8),),
        },
        refresh_receipts={
            "alpha": (SocialRefreshReceipt(("post-shared",), 1, 9),),
        },
        last_seen={"alpha": 0, "beta": 7},
    )
    catalogs = {
        "alpha": _catalog(("post-shared",), ("author", "other")),
        "beta": _catalog(("post-shared",), ("other", "author")),
    }
    receipts = {"alpha": None, "beta": None}

    combined = derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor=catalogs,
        prior_receipts_by_actor=receipts,
    )
    permuted = derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor=dict(reversed(tuple(catalogs.items()))),
        prior_receipts_by_actor=dict(reversed(tuple(receipts.items()))),
    )

    assert combined == permuted
    for actor_id in catalogs:
        isolated = derive_opportunity_snapshots_v1(
            social_state=state,
            target_catalogs_by_actor={actor_id: catalogs[actor_id]},
            prior_receipts_by_actor={actor_id: receipts[actor_id]},
        )
        assert combined[actor_id] == isolated[actor_id]
    assert "LOVE" not in combined["alpha"].actions["REACTION"][
        "eligible_reaction_kinds_by_target"
    ]["post-shared"]
    assert "WOW" not in combined["beta"].actions["REACTION"][
        "eligible_reaction_kinds_by_target"
    ]["post-shared"]
    assert combined["alpha"].actions["REFRESH"]["available"] is True
    assert combined["beta"].actions["REFRESH"]["available"] is False
    assert combined["alpha"].actions["SEARCH"]["available"] is True
    assert combined["beta"].actions["SEARCH"]["available"] is False


def test_global_visibility_transformations_run_once_per_equivalent_view(monkeypatch):
    state = _state(
        (_post("post-a", "a", 1), _post("post-b", "b", 2)),
        following={"followed": frozenset({"a"})},
        muted={"muted": frozenset({"b"})},
    )
    catalogs = {
        actor_id: _catalog()
        for actor_id in ("plain-a", "plain-b", "followed", "muted")
    }
    counts = {
        "muted": 0,
        "partition": 0,
        "corpus": 0,
        "trend": 0,
        "contributors": 0,
    }

    def counted(name, original):
        def wrapper(*args, **kwargs):
            counts[name] += 1
            return original(*args, **kwargs)

        return wrapper

    for name, helper_name in (
        ("muted", "_muted_visibility_projection"),
        ("partition", "_stable_followed_partition"),
        ("corpus", "_corpus_revision"),
        ("trend", "_trend_state"),
        ("contributors", "_presented_contributors"),
    ):
        monkeypatch.setattr(
            action_opportunities,
            helper_name,
            counted(name, getattr(action_opportunities, helper_name)),
        )

    snapshots = derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor=catalogs,
        prior_receipts_by_actor=dict.fromkeys(catalogs),
    )

    assert set(snapshots) == set(catalogs)
    assert counts == {
        "muted": 2,
        "partition": 3,
        "corpus": 3,
        "trend": 2,
        "contributors": 3,
    }


def test_muted_cache_and_follow_partition_match_randomized_legacy_oracle():
    rng = random.Random(0x5A17)
    authors = ("a", "b", "c", "Ω", "作者")
    for case in range(80):
        posts = []
        for index in range(rng.randrange(0, 25)):
            author = rng.choice(authors)
            sequence = rng.randrange(0, 65)
            commenters = tuple(rng.sample(authors, rng.randrange(0, 3)))
            comments = tuple(
                _comment(
                    f"comment-{case}-{index}-{offset}",
                    f"post-{case}-{index}",
                    commenter,
                    rng.randrange(0, 65),
                    content=f"回复-{offset}-```json",
                )
                for offset, commenter in enumerate(commenters)
            )
            events = tuple(
                (rng.randrange(0, 65), rng.choice(authors))
                for _ in range(rng.randrange(1, 8))
            )
            posts.append(
                _post(
                    f"post-{case}-{index}",
                    author,
                    sequence,
                    content=f"内容-{case}-{index}-🌐",
                    comments=comments,
                    activity_events=events,
                )
            )
        muted = frozenset(author for author in authors if rng.randrange(2))
        following = frozenset(author for author in authors if rng.randrange(2))
        state = _state(
            tuple(posts),
            following={"viewer": following},
            muted={"viewer": muted},
        )

        legacy_visible = action_opportunities._visible_posts(state, "viewer")
        muted_projection = action_opportunities._muted_visibility_projection(state, muted)
        optimized_visible = list(
            action_opportunities._stable_followed_partition(
                muted_projection.base_posts,
                following,
            )
        )

        assert optimized_visible == legacy_visible
        assert muted_projection.trend_state == action_opportunities._trend_state(
            state,
            "viewer",
            legacy_visible,
        )
        assert action_opportunities._corpus_revision(
            state,
            "viewer",
            optimized_visible,
            muted_projection=muted_projection,
        ) == action_opportunities._corpus_revision(state, "viewer", legacy_visible)


def test_shared_muted_129_posts_65_unique_following_views_reuse_expensive_work(
    monkeypatch,
):
    posts = tuple(
        _post(
            f"post-{index:03d}",
            f"author-{index:03d}",
            index,
            activity_events=(
                (index, f"author-{index:03d}"),
                (128 + index, f"contributor-{index:03d}"),
            ),
        )
        for index in range(129)
    )
    actor_ids = tuple(f"viewer-{index:03d}" for index in range(65))
    state = _state(
        posts,
        following={
            actor_id: frozenset(f"author-{post_index:03d}" for post_index in range(index))
            for index, actor_id in enumerate(actor_ids)
        },
    )
    counts = {"muted": 0, "partition": 0, "trend": 0, "corpus": 0}

    def counted(name, original):
        def wrapper(*args, **kwargs):
            counts[name] += 1
            return original(*args, **kwargs)

        return wrapper

    for name, helper_name in (
        ("muted", "_muted_visibility_projection"),
        ("partition", "_stable_followed_partition"),
        ("trend", "_trend_state"),
        ("corpus", "_corpus_revision"),
    ):
        monkeypatch.setattr(
            action_opportunities,
            helper_name,
            counted(name, getattr(action_opportunities, helper_name)),
        )

    snapshots = derive_opportunity_snapshots_v1(
        social_state=state,
        target_catalogs_by_actor={actor_id: _catalog() for actor_id in actor_ids},
        prior_receipts_by_actor=dict.fromkeys(actor_ids),
    )

    assert len(snapshots) == 65
    assert counts == {"muted": 1, "partition": 65, "trend": 1, "corpus": 65}
