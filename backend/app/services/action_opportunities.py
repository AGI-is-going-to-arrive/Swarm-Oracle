"""Deterministic N-1 social-action opportunities for one simulation round."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, fields, is_dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal, TypedDict

from app.config import settings
from app.services.domain_world import (
    _NUMERIC_RE,
    MAX_DECIMAL_SCALE,
    DomainOpportunityEvaluationV1,
    _canonical_numeric,
    _exact_mapping,
    _normalize_identifier,
    _normalize_unit,
)
from app.services.social_world import SocialWorldState

ActionTypeV1 = Literal[
    "IDLE", "POST", "COMMENT", "REACTION", "FOLLOW", "MUTE", "SEARCH", "TREND", "REFRESH"
]
ReactionKindV1 = Literal[
    "LIKE", "LOVE", "LAUGH", "WOW", "SAD", "ANGRY", "SUPPORT", "OPPOSE"
]
OpportunityReasonCodeV1 = Literal[
    "IDLE_ALWAYS_AVAILABLE", "POST_ALWAYS_AVAILABLE",
    "COMMENT_ELIGIBLE_TARGET_AVAILABLE", "COMMENT_NO_ELIGIBLE_TARGET",
    "FOLLOW_ELIGIBLE_TARGET_AVAILABLE", "FOLLOW_NO_ELIGIBLE_TARGET",
    "REACTION_ELIGIBLE_TARGET_AVAILABLE", "REACTION_NO_ELIGIBLE_TARGET",
    "MUTE_FILTER_EFFECT_AVAILABLE", "MUTE_NO_FILTER_EFFECT",
    "REFRESH_UNSEEN_POSTS_AVAILABLE", "REFRESH_NO_UNSEEN_POSTS",
    "TREND_INITIAL_VOLUME_AVAILABLE", "TREND_INITIAL_INTERACTION_AVAILABLE",
    "TREND_SIGNATURE_CHANGED", "TREND_NO_NEW_ACTIVITY",
    "SEARCH_CORPUS_AVAILABLE", "SEARCH_CORPUS_EMPTY", "SEARCH_HISTORY_UNAVAILABLE",
    "OPPORTUNITY_SNAPSHOT_UNAVAILABLE",
]
DecisionFailureCodeV1 = Literal[
    "DECISION_INVALID_SHAPE", "DECISION_FORBIDDEN_FIELD", "DECISION_UNAVAILABLE",
    "DECISION_INVALID_ACTION_TYPE", "DECISION_SELECTED_ACTION_NOT_CANDIDATE",
    "DECISION_IDLE_REASON_REQUIRED", "DECISION_INVALID_IDLE_REASON_CODE",
    "DECISION_INVALID_ACTION_TARGET", "DECISION_INVALID_ACTION_PARAMETER",
    "DECISION_TARGET_NOT_IN_CATALOG", "DECISION_TARGET_NOT_ELIGIBLE",
    "DECISION_OPPORTUNITY_UNAVAILABLE", "DECISION_REACTION_NO_OP",
    "DECISION_SEARCH_NO_OP",
]
DomainOpportunityReasonCodeV1 = Literal[
    "OPPORTUNITY_DOMAIN_RULE_ALLOWED",
    "OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",
    "OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED",
]
IdleReasonCodeV1 = Literal[
    "IDLE_NO_ACTION_NEEDED", "IDLE_INSUFFICIENT_EVIDENCE",
    "IDLE_WAITING_FOR_NEW_INFORMATION", "IDLE_CONSTRAINT_BLOCKED",
    "IDLE_STRATEGIC_HOLD", "IDLE_OPPORTUNITY_UNAVAILABLE",
    "IDLE_DECISION_UNAVAILABLE", "IDLE_LEGACY_UNSPECIFIED",
]
CompatibilityModeV1 = Literal["live", "legacy_import"]


class CatalogActionTargetV1(TypedDict):
    id: str
    kind: Literal["post", "action"]
    type: Literal["POST", "COMMENT", "REACTION"]
    agent_name: str
    content: str


class CatalogAgentTargetV1(TypedDict):
    id: str
    name: str
    kind: Literal["agent", "source"]


class ActionTargetCatalogV1(TypedDict):
    actions: list[CatalogActionTargetV1]
    agents: list[CatalogAgentTargetV1]


class ActionOpportunityV1(TypedDict):
    available: bool
    grounded: bool
    reason_codes: tuple[OpportunityReasonCodeV1, ...]
    domain_reason_codes: tuple[DomainOpportunityReasonCodeV1, ...]
    eligible_target_ids: tuple[str, ...]


class ReactionOpportunityV1(ActionOpportunityV1):
    eligible_reaction_kinds_by_target: dict[str, tuple[ReactionKindV1, ...]]


class SearchOpportunityV1(ActionOpportunityV1):
    corpus_revision: str
    search_history_complete: bool
    recent_query_fingerprints: tuple[str, ...]


class TrendOpportunityV1(ActionOpportunityV1):
    current_trend_signature: str | None
    last_trend_signature: str | None


class OpportunityActionsV1(TypedDict):
    IDLE: ActionOpportunityV1
    POST: ActionOpportunityV1
    COMMENT: ActionOpportunityV1
    REACTION: ReactionOpportunityV1
    FOLLOW: ActionOpportunityV1
    MUTE: ActionOpportunityV1
    SEARCH: SearchOpportunityV1
    TREND: TrendOpportunityV1
    REFRESH: ActionOpportunityV1


@dataclass(frozen=True, slots=True)
class OpportunitySnapshotV1:
    version: Literal[1]
    actor_id: str
    as_of_round: int
    social_state_revision: str
    domain_state_revision: str | None
    allowed_rule_ids: tuple[str, ...]
    actions: OpportunityActionsV1


class OpportunityReceiptV1(TypedDict):
    version: Literal[1]
    as_of_round: int
    social_state_revision: str | None
    domain_state_revision: str | None
    allowed_rule_ids: list[str]
    requested_action_type: ActionTypeV1 | None
    effective_action_type: ActionTypeV1
    available: bool
    grounded: bool
    reason_codes: list[OpportunityReasonCodeV1]
    eligible_target_count: int
    selected_target_eligible: bool | None
    parameter_eligible: bool | None
    corpus_revision: str | None
    query_fingerprint: str | None
    search_history_complete: bool
    recent_query_fingerprints: list[str]
    current_trend_signature: str | None
    last_trend_signature: str | None
    idle_reason_code: IdleReasonCodeV1 | None
    failure_code: DecisionFailureCodeV1 | None
    compatibility_mode: CompatibilityModeV1


_ACTION_TYPES: tuple[ActionTypeV1, ...] = ActionTypeV1.__args__
_REACTION_KINDS: tuple[ReactionKindV1, ...] = ReactionKindV1.__args__
_REASON_CODES = frozenset(OpportunityReasonCodeV1.__args__)
_FAILURE_CODES = frozenset(DecisionFailureCodeV1.__args__)
_IDLE_REASON_CODES = frozenset(IdleReasonCodeV1.__args__)
_RECEIPT_FIELDS = frozenset(OpportunityReceiptV1.__required_keys__)
_TREND_RECENCY_WINDOW = 64
_DOMAIN_ACTION_TYPES = frozenset(_ACTION_TYPES[1:])
_DOMAIN_EVALUATION_FIELDS = frozenset(
    {"version", "schema_hash", "input_state_revision", "as_of_round", "rules"}
)
_DOMAIN_RULE_FIELDS = frozenset(
    {"rule_id", "variable_id", "action_type", "preconditions_met", "preconditions"}
)
_DOMAIN_PREDICATE_FIELDS = frozenset(
    {"variable_id", "comparator", "expected_value", "actual_value", "unit", "met"}
)


def _digest(kind: str, payload: object) -> str:
    encoded = json.dumps(
        {"kind": kind, "payload": payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _is_digest(value: object) -> bool:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith("sha256:"):
        return False
    return all(character in "0123456789abcdef" for character in value[7:])


def _is_optional_digest(value: object) -> bool:
    return value is None or _is_digest(value)


def _is_optional_bool(value: object) -> bool:
    return value is None or type(value) is bool


def _is_domain_id(value: object) -> bool:
    try:
        return _normalize_identifier(value) == value
    except ValueError:
        return False


def _domain_predicate_fact(value: object) -> tuple[str, tuple[str, str, int, object]] | None:
    try:
        row = _exact_mapping(value, _DOMAIN_PREDICATE_FIELDS)
        variable_id = _normalize_identifier(row["variable_id"])
        comparator, expected, actual = (
            row["comparator"], row["expected_value"], row["actual_value"]
        )
        unit = _normalize_unit(row["unit"])
        if (
            type(comparator) is not str
            or comparator not in {"eq", "ne", "lt", "lte", "gt", "gte"}
            or type(row["met"]) is not bool
            or type(expected) is not type(actual)
            or type(expected) not in {str, bool}
        ):
            raise ValueError
        if type(actual) is bool:
            if comparator not in {"eq", "ne"} or unit != "unitless":
                raise ValueError
            left, right, kind, scale = actual, expected, "boolean", 0
        else:
            actual_match = _NUMERIC_RE.fullmatch(actual)
            expected_match = _NUMERIC_RE.fullmatch(expected)
            if unit != "unitless" or actual_match or expected_match:
                if actual_match is None or expected_match is None:
                    raise ValueError
                scale, expected_scale = len(actual_match.group(3) or ""), len(
                    expected_match.group(3) or ""
                )
                if scale != expected_scale or scale > MAX_DECIMAL_SCALE:
                    raise ValueError
                scale_zero_unit = unit in {"count", "basis_point", "second"} or unit.startswith(
                    "currency:"
                )
                if scale_zero_unit and scale:
                    raise ValueError
                if (
                    _canonical_numeric(actual, scale) != actual
                    or _canonical_numeric(expected, scale) != expected
                ):
                    raise ValueError
                left, right, kind = Decimal(actual), Decimal(expected), "numeric"
            else:
                if comparator not in {"eq", "ne"}:
                    raise ValueError
                left, right, kind, scale = (
                    _normalize_identifier(actual), _normalize_identifier(expected), "enum", 0
                )
        calculated = {
            "eq": left == right, "ne": left != right, "lt": left < right,
            "lte": left <= right, "gt": left > right, "gte": left >= right,
        }[comparator]
        if row["met"] is not calculated:
            raise ValueError
        return variable_id, (kind, unit, scale, actual)
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return None


def _valid_domain_opportunities(
    value: object,
    *,
    as_of_round: int,
) -> DomainOpportunityEvaluationV1 | None:
    try:
        row = _exact_mapping(value, _DOMAIN_EVALUATION_FIELDS)
        rules = row["rules"]
        if (
            type(row["version"]) is not int or row["version"] != 1
            or not _is_digest(row["schema_hash"])
            or not _is_digest(row["input_state_revision"])
            or type(row["as_of_round"]) is not int or row["as_of_round"] != as_of_round
            or not isinstance(rules, tuple) or len(rules) > 16
        ):
            raise ValueError
        rule_ids: list[str] = []
        state_facts: dict[str, tuple[str, str, int, object]] = {}
        for raw_rule in rules:
            rule = _exact_mapping(raw_rule, _DOMAIN_RULE_FIELDS)
            rule_id, action_type, predicates = (
                _normalize_identifier(rule["rule_id"]), rule["action_type"], rule["preconditions"]
            )
            _normalize_identifier(rule["variable_id"])
            if (
                type(action_type) is not str or action_type not in _DOMAIN_ACTION_TYPES
                or type(rule["preconditions_met"]) is not bool
                or not isinstance(predicates, tuple) or len(predicates) > 4
                or rule["preconditions_met"] is not all(item["met"] for item in predicates)
            ):
                raise ValueError
            for predicate in predicates:
                fact = _domain_predicate_fact(predicate)
                if fact is None or state_facts.setdefault(fact[0], fact[1]) != fact[1]:
                    raise ValueError
            rule_ids.append(rule_id)
        if rule_ids != sorted(set(rule_ids)):
            raise ValueError
        return value
    except (KeyError, TypeError, ValueError):
        return None


def _domain_receipt_fields_are_valid(revision: object, rule_ids: object) -> bool:
    if (
        not isinstance(rule_ids, list)
        or len(rule_ids) > 16
        or any(not _is_domain_id(item) for item in rule_ids)
        or rule_ids != sorted(set(rule_ids))
    ):
        return False
    return (revision is None and not rule_ids) or _is_digest(revision)


def _canonical(value: object) -> object:
    if is_dataclass(value):
        return {field.name: _canonical(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Mapping):
        return {str(key): _canonical(value[key]) for key in sorted(value)}
    if isinstance(value, (set, frozenset)):
        return sorted(_canonical(item) for item in value)
    if isinstance(value, tuple):
        return [_canonical(item) for item in value]
    return value


def _state_revision(state: SocialWorldState) -> str:
    payload = {
        field.name: _canonical(getattr(state, field.name))
        for field in fields(state)
        if field.name != "diagnostics"
    }
    return _digest("social_state_revision_v1", payload)


def _visible_posts(state: SocialWorldState, actor_id: str) -> list[object]:
    muted = state.muted.get(actor_id, frozenset())
    followed = state.following.get(actor_id, frozenset())
    visible = [post for post in state.posts if post.author_id not in muted]

    def latest_activity(post: object) -> int:
        return max(
            (
                sequence
                for sequence, contributor in post.activity_events
                if contributor not in muted
            ),
            default=post.sequence,
        )

    return sorted(
        visible,
        key=lambda post: (
            post.author_id in followed,
            latest_activity(post),
            post.sequence,
            post.action_id,
        ),
        reverse=True,
    )


def _catalog_ids(rows: object) -> tuple[str, ...]:
    if not isinstance(rows, list):
        return ()
    seen: set[str] = set()
    ordered: list[str] = []
    for row in rows:
        identifier = str(row.get("id") or "") if isinstance(row, Mapping) else ""
        if identifier and identifier not in seen:
            seen.add(identifier)
            ordered.append(identifier)
    return tuple(ordered)


def _target_index(state: SocialWorldState) -> dict[str, tuple[object, str]]:
    targets: dict[str, tuple[object, str]] = {}
    for post in state.posts:
        targets.setdefault(post.action_id, (post, post.author_id))
        for comment in post.comments:
            targets.setdefault(comment.action_id, (post, comment.author_id))
        for reaction in post.reactions:
            targets.setdefault(reaction.action_id, (post, reaction.author_id))
    return targets


def _corpus_revision(state: SocialWorldState, actor_id: str, visible: list[object]) -> str:
    muted = state.muted.get(actor_id, frozenset())
    relevant_agent_ids = {
        post.author_id for post in visible if post.author_name_override is None
    }
    payload = {
        "posts": [
            {
                "id": post.action_id,
                "author_id": post.author_id,
                "content": post.content,
                "source_display": post.author_name_override,
                "tags": list(post.tags),
                "sequence": post.sequence,
                "comments": [
                    {
                        "id": comment.action_id,
                        "author_id": comment.author_id,
                        "content": comment.content,
                        "sequence": comment.sequence,
                    }
                    for comment in post.comments
                    if comment.author_id not in muted
                ],
            }
            for post in visible
        ],
        "agent_names": {
            identifier: state.agent_names.get(identifier, "")
            for identifier in sorted(relevant_agent_ids)
        },
        "following": sorted(state.following.get(actor_id, frozenset())),
        "muted": sorted(muted),
    }
    return _digest("search_corpus_revision_v1", payload)


def _trend_state(
    state: SocialWorldState,
    actor_id: str,
    visible: list[object],
) -> tuple[str | None, bool, bool]:
    if not visible:
        return None, False, False
    muted = state.muted.get(actor_id, frozenset())
    sequences_by_post = {
        post.action_id: tuple(
            sequence
            for sequence, contributor in post.activity_events
            if contributor not in muted
        )
        or (post.sequence,)
        for post in visible
    }
    reference_sequence = max(
        sequence for sequences in sequences_by_post.values() for sequence in sequences
    )
    ranked: list[tuple[int, int, int, str]] = []
    for post in visible:
        sequences = sequences_by_post[post.action_id]
        score = sum(
            max(1, _TREND_RECENCY_WINDOW - max(0, reference_sequence - sequence))
            for sequence in sequences
        )
        ranked.append((score, len(sequences), max(sequences), post.action_id))
    ranked.sort(reverse=True)
    rows = [
        [post_id, activity_count, score, latest_sequence]
        for score, activity_count, latest_sequence, post_id in ranked[:5]
    ]
    has_volume = len(visible) >= 2
    has_interaction = len(visible) == 1 and ranked[0][1] >= 2
    return _digest("trend_signature_v1", rows), has_volume, has_interaction


def _receipt_is_valid(receipt: object) -> bool:
    if not isinstance(receipt, Mapping) or set(receipt) != _RECEIPT_FIELDS:
        return False
    fingerprints = receipt.get("recent_query_fingerprints")
    max_history = max(0, int(settings.MAX_ROUNDS))
    return bool(
        receipt.get("version") == 1
        and type(receipt.get("as_of_round")) is int
        and receipt["as_of_round"] >= 0
        and _is_optional_digest(receipt.get("social_state_revision"))
        and _domain_receipt_fields_are_valid(
            receipt.get("domain_state_revision"), receipt.get("allowed_rule_ids")
        )
        and receipt.get("requested_action_type") in (*_ACTION_TYPES, None)
        and receipt.get("effective_action_type") in _ACTION_TYPES
        and type(receipt.get("available")) is bool
        and type(receipt.get("grounded")) is bool
        and isinstance(receipt.get("reason_codes"), list)
        and len(receipt["reason_codes"]) == 1
        and isinstance(receipt["reason_codes"][0], str)
        and receipt["reason_codes"][0] in _REASON_CODES
        and type(receipt.get("eligible_target_count")) is int
        and receipt["eligible_target_count"] >= 0
        and _is_optional_bool(receipt.get("selected_target_eligible"))
        and _is_optional_bool(receipt.get("parameter_eligible"))
        and _is_optional_digest(receipt.get("corpus_revision"))
        and _is_optional_digest(receipt.get("query_fingerprint"))
        and type(receipt.get("search_history_complete")) is bool
        and isinstance(fingerprints, list)
        and len(fingerprints) <= max_history
        and all(_is_digest(item) for item in fingerprints)
        and len(fingerprints) == len(set(fingerprints))
        and _is_optional_digest(receipt.get("current_trend_signature"))
        and _is_optional_digest(receipt.get("last_trend_signature"))
        and (
            receipt.get("idle_reason_code") is None
            or (
                isinstance(receipt.get("idle_reason_code"), str)
                and receipt.get("idle_reason_code") in _IDLE_REASON_CODES
            )
        )
        and (
            receipt.get("failure_code") is None
            or (
                isinstance(receipt.get("failure_code"), str)
                and receipt.get("failure_code") in _FAILURE_CODES
            )
        )
        and receipt.get("compatibility_mode") in ("live", "legacy_import")
    )


def _opportunity(
    available: bool,
    reason: OpportunityReasonCodeV1,
    targets: tuple[str, ...] = (),
) -> ActionOpportunityV1:
    return {
        "available": available,
        "grounded": available,
        "reason_codes": (reason,),
        "domain_reason_codes": (),
        "eligible_target_ids": targets,
    }


def _target_opportunity(
    targets: tuple[str, ...],
    available_reason: OpportunityReasonCodeV1,
    unavailable_reason: OpportunityReasonCodeV1,
) -> ActionOpportunityV1:
    return _opportunity(
        bool(targets), available_reason if targets else unavailable_reason, targets
    )


def derive_opportunity_snapshots_v1(
    *,
    social_state: SocialWorldState,
    target_catalogs_by_actor: Mapping[str, ActionTargetCatalogV1],
    prior_receipts_by_actor: Mapping[str, OpportunityReceiptV1 | None],
    domain_opportunities: DomainOpportunityEvaluationV1 | None = None,
) -> dict[str, OpportunitySnapshotV1]:
    """Derive exactly one immutable N-1 snapshot per actor before gather tasks."""
    social_revision = _state_revision(social_state)
    target_index = _target_index(social_state)
    valid_domain = _valid_domain_opportunities(
        domain_opportunities,
        as_of_round=social_state.cutoff_round,
    )
    snapshots: dict[str, OpportunitySnapshotV1] = {}
    for actor_id in sorted(target_catalogs_by_actor):
        catalog = target_catalogs_by_actor[actor_id]
        muted = social_state.muted.get(actor_id, frozenset())
        visible = _visible_posts(social_state, actor_id)
        visible_post_ids = {post.action_id for post in visible}
        action_ids = _catalog_ids(catalog.get("actions"))
        agent_ids = _catalog_ids(catalog.get("agents"))

        eligible_actions = tuple(
            target_id
            for target_id in action_ids
            if target_id in target_index
            and target_index[target_id][0].action_id in visible_post_ids
            and target_index[target_id][1] not in {actor_id, *muted}
        )
        comment = _target_opportunity(
            eligible_actions,
            "COMMENT_ELIGIBLE_TARGET_AVAILABLE",
            "COMMENT_NO_ELIGIBLE_TARGET",
        )
        reaction_kinds: dict[str, tuple[ReactionKindV1, ...]] = {}
        for target_id in eligible_actions:
            root_post = target_index[target_id][0]
            current_kind = next(
                (
                    reaction.kind
                    for reaction in root_post.reactions
                    if reaction.author_id == actor_id
                ),
                None,
            )
            reaction_kinds[target_id] = tuple(
                kind for kind in _REACTION_KINDS if kind != current_kind
            )
        reaction: ReactionOpportunityV1 = {
            **_target_opportunity(
                eligible_actions,
                "REACTION_ELIGIBLE_TARGET_AVAILABLE",
                "REACTION_NO_ELIGIBLE_TARGET",
            ),
            "eligible_reaction_kinds_by_target": reaction_kinds,
        }

        visible_authors = {post.author_id for post in visible}
        following = social_state.following.get(actor_id, frozenset())
        follow_ids = tuple(
            target_id
            for target_id in agent_ids
            if target_id in visible_authors
            and target_id != actor_id
            and target_id not in muted
            and target_id not in following
        )
        follow = _target_opportunity(
            follow_ids,
            "FOLLOW_ELIGIBLE_TARGET_AVAILABLE",
            "FOLLOW_NO_ELIGIBLE_TARGET",
        )

        refreshes = social_state.refresh_receipts.get(actor_id, ())
        if refreshes:
            posts_by_id = {post.action_id: post for post in visible}
            presented = [
                posts_by_id[post_id]
                for post_id in refreshes[-1].post_ids[:4]
                if post_id in posts_by_id
            ]
        else:
            presented = visible[:4]
        contributors = {
            contributor
            for post in presented
            for contributor in (
                post.author_id,
                *(item.author_id for item in post.comments if item.author_id not in muted),
                *(item.author_id for item in post.reactions if item.author_id not in muted),
            )
        }
        mute_ids = tuple(
            target_id
            for target_id in agent_ids
            if target_id in contributors and target_id != actor_id and target_id not in muted
        )
        mute = _target_opportunity(
            mute_ids,
            "MUTE_FILTER_EFFECT_AVAILABLE",
            "MUTE_NO_FILTER_EFFECT",
        )

        unseen_count = sum(
            post.sequence > social_state.last_seen.get(actor_id, 0) for post in visible
        )
        refresh = _opportunity(
            unseen_count > 0,
            "REFRESH_UNSEEN_POSTS_AVAILABLE" if unseen_count else "REFRESH_NO_UNSEEN_POSTS",
        )

        corpus_revision = _corpus_revision(social_state, actor_id, visible)
        prior = prior_receipts_by_actor.get(actor_id)
        valid_prior = prior if _receipt_is_valid(prior) else None
        durable_search_exists = bool(social_state.recent_searches.get(actor_id))
        if valid_prior is not None and valid_prior["corpus_revision"] == corpus_revision:
            history = tuple(valid_prior["recent_query_fingerprints"])
            history_complete = valid_prior["search_history_complete"]
        elif valid_prior is not None and valid_prior["corpus_revision"] is not None:
            history = ()
            history_complete = True
        else:
            history = ()
            history_complete = not durable_search_exists
        search_available = bool(visible) and history_complete
        search_reason: OpportunityReasonCodeV1
        if not visible:
            search_reason = "SEARCH_CORPUS_EMPTY"
        elif not history_complete:
            search_reason = "SEARCH_HISTORY_UNAVAILABLE"
        else:
            search_reason = "SEARCH_CORPUS_AVAILABLE"
        search: SearchOpportunityV1 = {
            **_opportunity(search_available, search_reason),
            "corpus_revision": corpus_revision,
            "search_history_complete": history_complete,
            "recent_query_fingerprints": history,
        }

        trend_signature, has_volume, has_interaction = _trend_state(
            social_state, actor_id, visible
        )
        if valid_prior is not None:
            last_trend_signature = valid_prior["last_trend_signature"]
        elif social_state.trend_receipts.get(actor_id):
            last_trend_signature = trend_signature
        else:
            last_trend_signature = None
        if last_trend_signature is None and has_volume:
            trend_available = True
            trend_reason: OpportunityReasonCodeV1 = "TREND_INITIAL_VOLUME_AVAILABLE"
        elif last_trend_signature is None and has_interaction:
            trend_available = True
            trend_reason = "TREND_INITIAL_INTERACTION_AVAILABLE"
        elif (
            last_trend_signature is not None
            and trend_signature != last_trend_signature
            and (has_volume or has_interaction)
        ):
            trend_available = True
            trend_reason = "TREND_SIGNATURE_CHANGED"
        else:
            trend_available = False
            trend_reason = "TREND_NO_NEW_ACTIVITY"
        trend: TrendOpportunityV1 = {
            **_opportunity(trend_available, trend_reason),
            "current_trend_signature": trend_signature,
            "last_trend_signature": last_trend_signature,
        }

        actions: OpportunityActionsV1 = {
            "IDLE": _opportunity(True, "IDLE_ALWAYS_AVAILABLE"),
            "POST": _opportunity(True, "POST_ALWAYS_AVAILABLE"),
            "COMMENT": comment,
            "REACTION": reaction,
            "FOLLOW": follow,
            "MUTE": mute,
            "SEARCH": search,
            "TREND": trend,
            "REFRESH": refresh,
        }
        domain_revision: str | None = None
        allowed_rule_ids: tuple[str, ...] = ()
        if valid_domain is not None:
            domain_revision = valid_domain["input_state_revision"]
            contributed: set[str] = set()
            for action_type in _ACTION_TYPES[1:]:
                bound = tuple(
                    rule for rule in valid_domain["rules"]
                    if rule["action_type"] == action_type
                )
                threshold_met = tuple(rule for rule in bound if rule["preconditions_met"])
                socially_open = (
                    actions[action_type]["available"] and actions[action_type]["grounded"]
                )
                if not bound:
                    reason: tuple[DomainOpportunityReasonCodeV1, ...] = ()
                elif threshold_met and socially_open:
                    reason = ("OPPORTUNITY_DOMAIN_RULE_ALLOWED",)
                    contributed.update(rule["rule_id"] for rule in threshold_met)
                elif threshold_met:
                    reason = ("OPPORTUNITY_DOMAIN_SOCIAL_GATE_CLOSED",)
                else:
                    reason = ("OPPORTUNITY_DOMAIN_PRECONDITION_NOT_MET",)
                actions[action_type]["domain_reason_codes"] = reason
            allowed_rule_ids = tuple(sorted(contributed))
        snapshots[actor_id] = OpportunitySnapshotV1(
            version=1,
            actor_id=actor_id,
            as_of_round=social_state.cutoff_round,
            social_state_revision=social_revision,
            domain_state_revision=domain_revision,
            allowed_rule_ids=allowed_rule_ids,
            actions=actions,
        )
    return snapshots


def opportunity_snapshot_to_prompt_payload_v1(
    snapshot: OpportunitySnapshotV1,
) -> dict[str, object]:
    """Return JSON-ready prompt data; full target allowlists remain ephemeral."""

    def json_ready(value: object) -> object:
        if isinstance(value, tuple):
            return [json_ready(item) for item in value]
        if isinstance(value, Mapping):
            return {str(key): json_ready(item) for key, item in value.items()}
        return value

    return {
        "version": snapshot.version,
        "actor_id": snapshot.actor_id,
        "as_of_round": snapshot.as_of_round,
        "social_state_revision": snapshot.social_state_revision,
        "domain_state_revision": snapshot.domain_state_revision,
        "allowed_rule_ids": json_ready(snapshot.allowed_rule_ids),
        "actions": json_ready(snapshot.actions),
    }


def search_query_fingerprint_v1(
    query: object,
    *,
    corpus_revision: str,
) -> str | None:
    """Normalize a non-empty query and bind it to one corpus revision."""
    normalized_query = " ".join(str(query or "").casefold().split())
    if not normalized_query:
        return None
    return _digest(
        "search_query_fingerprint_v1",
        {"corpus_revision": corpus_revision, "normalized_query": normalized_query},
    )


__all__ = (
    "ActionOpportunityV1",
    "ActionTargetCatalogV1",
    "ActionTypeV1",
    "CatalogActionTargetV1",
    "CatalogAgentTargetV1",
    "CompatibilityModeV1",
    "DecisionFailureCodeV1",
    "DomainOpportunityReasonCodeV1",
    "IdleReasonCodeV1",
    "OpportunityActionsV1",
    "OpportunityReasonCodeV1",
    "OpportunityReceiptV1",
    "OpportunitySnapshotV1",
    "ReactionKindV1",
    "ReactionOpportunityV1",
    "SearchOpportunityV1",
    "TrendOpportunityV1",
    "derive_opportunity_snapshots_v1",
    "opportunity_snapshot_to_prompt_payload_v1",
    "search_query_fingerprint_v1",
)
