"""Campaign progression service for Track A / Phase A1."""

from __future__ import annotations

import logging
import re
import time
from collections import Counter
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from sqlalchemy import func, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import Branch, Scenario, ScenarioStatus
from app.models.campaign import (
    DirectorBadgeUnlock,
    DirectorProfile,
    ProfileMastery,
    ScenarioCampaignLog,
)
from app.models.database import get_engine
from app.services.lang_detect import detect_language, get_anonymous_director_name
from app.services.runtime_lock import acquire_runtime_lock, release_runtime_lock

logger = logging.getLogger(__name__)

ARCHIVE_GRADE_ORDER = {"C": 0, "B": 1, "A": 2, "S": 3}
VALID_ARCHIVE_GRADES = set(ARCHIVE_GRADE_ORDER)
VALID_PROFILE_RESONANCES = {"signature", "aligned", "offbeat"}
VALID_COMMITMENT_OUTCOMES = {"hit", "miss", "pending"}
VALID_GAMEPLAY_BET_KINDS = {"branch_winner", "ending_tone", "profile_resonance"}
VALID_ENDING_TONES = {"order", "balance", "rupture"}
ENDING_TONE_OPTIONS = {
    "order": {"zh": "秩序收束", "en": "Order Consolidation"},
    "balance": {"zh": "平衡共治", "en": "Balanced Co-Governance"},
    "rupture": {"zh": "崩坏反噬", "en": "Rupture and Backlash"},
}
PROFILE_RESONANCE_OPTIONS = {
    "signature": {"zh": "命中题材核心", "en": "Signature Hit"},
    "aligned": {"zh": "方向基本吻合", "en": "Direction Aligned"},
    "offbeat": {"zh": "走出了题材支线", "en": "Unexpected Side Route"},
}
RUPTURE_KEYWORDS = (
    "崩", "裂", "战", "狂飙", "失控", "毁灭", "灾难", "反噬",
    "collapse", "rupture", "backlash", "war", "ruin", "chaos",
)
BALANCE_KEYWORDS = (
    "共治", "平衡", "自治", "和解", "协同", "联盟", "停火", "条约", "共议",
    "balance", "co-governance", "autonomy", "alliance", "truce", "treaty",
)
PROFILE_RESONANCE_KEYWORDS = {
    "governance": ("治理", "算法", "主权", "否决", "govern", "algorithm", "sovereignty", "veto"),
    "war": ("战争", "停火", "补给", "前线", "war", "ceasefire", "supply", "front"),
    "empire": ("帝国", "王朝", "行省", "军团", "empire", "dynasty", "province", "legion"),
    "industry": ("工业", "产能", "能源", "资源", "industrial", "throughput", "energy", "resource"),
    "trade": ("贸易", "关税", "商路", "港口", "trade", "tariff", "route", "port"),
    "law": ("法院", "判例", "合规", "宪章", "court", "ruling", "compliance", "charter"),
    "faith": ("神谕", "教会", "异端", "圣", "prophecy", "church", "heresy", "sacred"),
    "ecology": ("生态", "气候", "水源", "迁徙", "ecology", "climate", "water", "migration"),
    "frontier": ("边疆", "殖民", "轨道", "撤离", "frontier", "colony", "orbital", "evac"),
    "mythic": ("神谕", "魔法", "王国", "禁术", "prophecy", "magic", "kingdom", "ritual"),
    "survival": ("末日", "饥荒", "瘟疫", "避难", "survival", "collapse", "plague", "refuge"),
    "finance": ("金融", "信用", "做空", "挤兑", "finance", "credit", "short", "liquidity"),
    "scholar": ("学术", "学派", "范式", "论证", "academic", "paradigm", "thesis", "faculty"),
    "medical": ("医疗", "诊疗", "疫情", "病患", "medical", "triage", "pandemic", "clinical"),
    "technology": (
        "技术", "算力", "架构", "迭代", "technology", "compute", "architecture", "iteration",
    ),
    "entertainment": (
        "娱乐", "舆论", "流量", "叙事", "entertainment", "narrative", "audience", "viral",
    ),
    "diplomacy": ("外交", "条约", "谈判", "使节", "diplomacy", "treaty", "negotiation", "envoy"),
    "generic": ("冲突", "分歧", "转向", "证据", "conflict", "tension", "pivot", "evidence"),
}
# Phase 3 progression: non-linear levels — level = floor(sqrt(score / 2)),
# with a floor of 1 so finalize never surfaces level 0. Replaces the linear
# ``LEVEL_SCORE_STEP=5`` curve so each level demands more runs than the last.
# ``next_level_score = 2 * (level + 1) ** 2`` is the absolute score required
# to advance, mirrored in :func:`_next_level_score`. The legacy constant is
# kept exported so external callers can detect the regime change.
LEVEL_SCORE_STEP = 5
# Legacy Phase 1 badge ids (preserved for historical rows). Phase 3 replaces
# the static unlock loop with a registry-driven sweep in
# ``app.services.badge_registry``; the constant remains for compatibility.
BADGE_IDS = ("daily_challenge", "archive_record", "bet_winner")

DEFAULT_SCENARIO_DIRECTOR_STATE = {
    "revision": 0,
    "objectives": {
        "generated_for_question": None,
        "generated_for_profile": None,
        "goals": [],
        "last_updated_at": None,
    },
    "commitment": {
        "active": False,
        "branch_id": None,
        "branch_title": None,
        "committed_at_round": None,
        "committed_at": None,
        "outcome": None,
    },
}

DEFAULT_SCENARIO_GAMEPLAY_STATE = {
    "revision": 0,
    "cards": {
        "usage_log": [],
    },
    "betting": {
        "bets": [],
    },
    "archive": {
        "key_moments": [],
        "branch_snapshots": [],
    },
}


class CampaignError(Exception):
    """Base campaign error."""


class CampaignNotFoundError(CampaignError):
    """Raised when the target campaign resource does not exist."""


class CampaignStateError(CampaignError):
    """Raised when the scenario is not ready for finalization."""


class CampaignConflictError(CampaignError):
    """Raised when a scenario is finalized for a different profile."""


class CampaignBetValidationError(CampaignError):
    """Raised when a gameplay-state bet entry fails strict target validation."""

    def __init__(self, code: str, message: str, *, bet_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.bet_id = bet_id


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _normalize_utc_datetime(value: datetime) -> datetime:
    """SQLite can round-trip aware UTC timestamps back as naive datetimes."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _serialize_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _normalize_utc_datetime(value).isoformat()


def _normalize_archive_grade(archive_grade: str | None) -> str:
    normalized = (archive_grade or "C").strip().upper()
    if normalized not in VALID_ARCHIVE_GRADES:
        raise CampaignError(f"Unsupported archive_grade: {archive_grade}")
    return normalized


def _normalize_profile_resonance(profile_resonance: str | None) -> str:
    normalized = (profile_resonance or "offbeat").strip().lower()
    if normalized not in VALID_PROFILE_RESONANCES:
        raise CampaignError(f"Unsupported profile_resonance: {profile_resonance}")
    return normalized


def _has_resolved_bet(bet_count: int, betting_hit: bool | None) -> bool:
    return bet_count > 0 or betting_hit is not None


def _resolve_finalize_betting_inputs(
    *,
    scenario: Scenario,
    bet_count: int,
    betting_hit: bool | None,
) -> tuple[int, bool | None]:
    effective_bet_count = max(bet_count, _scenario_bet_count(scenario.gameplay_state_json))
    if effective_bet_count > 0 and betting_hit is None:
        raise CampaignError("betting_hit is required when the scenario has bets")
    return effective_bet_count, betting_hit


def _normalize_objective_counts(
    objective_completed_count: int,
    objective_total_count: int,
) -> tuple[int, int]:
    if objective_completed_count < 0 or objective_total_count < 0:
        raise CampaignError("objective counts must be >= 0")
    if objective_completed_count > objective_total_count:
        raise CampaignError("objective_completed_count cannot exceed objective_total_count")
    return objective_completed_count, objective_total_count


def _normalize_commitment_outcome(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized not in VALID_COMMITMENT_OUTCOMES:
        raise CampaignError(
            f"Unsupported commitment_outcome: {value}"
        )
    return normalized


def get_default_scenario_director_state() -> dict[str, Any]:
    return deepcopy(DEFAULT_SCENARIO_DIRECTOR_STATE)


def _normalize_state_revision(payload: dict[str, Any] | None) -> int:
    if not isinstance(payload, dict):
        return 0
    try:
        revision = int(payload.get("revision", 0))
    except (TypeError, ValueError):
        revision = 0
    return max(0, revision)


def _with_state_revision(payload: dict[str, Any], revision: int) -> dict[str, Any]:
    next_payload = deepcopy(payload)
    next_payload["revision"] = max(0, revision)
    return next_payload


def normalize_scenario_director_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = get_default_scenario_director_state()
    if not isinstance(payload, dict):
        return state
    state["revision"] = _normalize_state_revision(payload)

    raw_objectives = payload.get("objectives")
    if isinstance(raw_objectives, dict):
        goals: list[dict[str, Any]] = []
        for goal in raw_objectives.get("goals") or []:
            if not isinstance(goal, dict):
                continue
            goals.append(
                {
                    "id": str(goal.get("id", "")).strip(),
                    "kind": str(goal.get("kind", "")).strip(),
                    "target_card_id": (
                        str(goal["target_card_id"]).strip()
                        if goal.get("target_card_id") is not None
                        else None
                    ),
                    "reward_label": (
                        str(goal["reward_label"]).strip()
                        if goal.get("reward_label") is not None
                        else None
                    ),
                    "created_at": str(goal.get("created_at", "")).strip(),
                }
            )
        state["objectives"] = {
            "generated_for_question": raw_objectives.get("generated_for_question"),
            "generated_for_profile": raw_objectives.get("generated_for_profile"),
            "goals": goals,
            "last_updated_at": raw_objectives.get("last_updated_at"),
        }

    raw_commitment = payload.get("commitment")
    if not isinstance(raw_commitment, dict):
        return state

    active = bool(raw_commitment.get("active"))
    branch_id = (
        str(raw_commitment["branch_id"]).strip()
        if raw_commitment.get("branch_id") is not None
        else None
    )
    branch_title = (
        str(raw_commitment["branch_title"]).strip()
        if raw_commitment.get("branch_title") is not None
        else None
    )
    if not active or not branch_id or not branch_title:
        return state

    committed_at_round = raw_commitment.get("committed_at_round")
    if committed_at_round is not None:
        try:
            committed_at_round = int(committed_at_round)
        except (TypeError, ValueError):
            committed_at_round = None

    outcome = raw_commitment.get("outcome")
    state["commitment"] = {
        "active": True,
        "branch_id": branch_id,
        "branch_title": branch_title,
        "committed_at_round": committed_at_round,
        "committed_at": raw_commitment.get("committed_at"),
        "outcome": _normalize_commitment_outcome(str(outcome) if outcome is not None else None),
    }
    return state


def get_default_scenario_gameplay_state() -> dict[str, Any]:
    return deepcopy(DEFAULT_SCENARIO_GAMEPLAY_STATE)


def _normalize_usage_log_entry(entry: dict[str, Any]) -> dict[str, Any] | None:
    card_id = str(entry.get("card_id", "")).strip()
    profile_id = str(entry.get("profile_id", "")).strip()
    branch_id = str(entry.get("branch_id", "")).strip()
    branch_title = str(entry.get("branch_title", "")).strip()
    directive = str(entry.get("directive", "")).strip()
    used_at = str(entry.get("used_at", "")).strip()

    if not card_id or not profile_id or not branch_id or not branch_title or not used_at:
        return None

    try:
        round_number = max(1, int(entry.get("round", 1)))
    except (TypeError, ValueError):
        round_number = 1

    try:
        cost = max(0, int(entry.get("cost", 0)))
    except (TypeError, ValueError):
        cost = 0

    return {
        "card_id": card_id,
        "profile_id": profile_id,
        "branch_id": branch_id,
        "branch_title": branch_title,
        "round": round_number,
        "cost": cost,
        "directive": directive,
        "used_at": used_at,
    }


def _normalize_bet_entry(
    entry: dict[str, Any],
    *,
    strict: bool = False,
    valid_branch_ids: set[str] | None = None,
) -> dict[str, Any] | None:
    bet_id = str(entry.get("bet_id", "")).strip()
    kind = str(entry.get("kind", "")).strip()
    target_label = str(entry.get("target_label", "")).strip()
    placed_at = str(entry.get("placed_at", "")).strip()

    if not bet_id or not target_label or not placed_at or kind not in VALID_GAMEPLAY_BET_KINDS:
        if strict:
            raise CampaignBetValidationError(
                "GAMEPLAY_BET_INVALID_KIND",
                f"Bet entry missing required fields or kind not supported: {kind!r}",
                bet_id=bet_id or None,
            )
        return None

    target_id = (
        str(entry["target_id"]).strip()
        if entry.get("target_id") is not None
        else None
    ) or None
    user_name = (
        str(entry["user_name"]).strip()
        if entry.get("user_name") is not None
        else None
    ) or None

    try:
        confidence = float(entry.get("confidence", 0))
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))

    try:
        placed_at_round = max(1, int(entry.get("placed_at_round", 1)))
    except (TypeError, ValueError):
        placed_at_round = 1

    if strict:
        if kind == "ending_tone":
            if target_id is None or target_id not in VALID_ENDING_TONES:
                raise CampaignBetValidationError(
                    "GAMEPLAY_BET_INVALID_ENDING_TONE",
                    f"ending_tone bet target_id must be one of "
                    f"{sorted(VALID_ENDING_TONES)}, got {target_id!r}",
                    bet_id=bet_id,
                )
        elif kind == "profile_resonance":
            if target_id is None or target_id not in VALID_PROFILE_RESONANCES:
                raise CampaignBetValidationError(
                    "GAMEPLAY_BET_INVALID_PROFILE_RESONANCE",
                    f"profile_resonance bet target_id must be one of "
                    f"{sorted(VALID_PROFILE_RESONANCES)}, got {target_id!r}",
                    bet_id=bet_id,
                )
        elif kind == "branch_winner":
            if target_id is None:
                raise CampaignBetValidationError(
                    "GAMEPLAY_BET_MISSING_BRANCH_TARGET",
                    "branch_winner bet target_id is required",
                    bet_id=bet_id,
                )
            if valid_branch_ids is not None and target_id not in valid_branch_ids:
                raise CampaignBetValidationError(
                    "GAMEPLAY_BET_INVALID_BRANCH_TARGET",
                    f"branch_winner bet target_id must belong to current scenario "
                    f"branches, got {target_id!r}",
                    bet_id=bet_id,
                )

    return {
        "bet_id": bet_id,
        "kind": kind,
        "target_id": target_id,
        "target_label": target_label,
        "confidence": confidence,
        "user_name": user_name,
        "placed_at_round": placed_at_round,
        "placed_at": placed_at,
        "resolved": bool(entry.get("resolved")),
    }


def _normalize_archive_state(payload: dict[str, Any] | None) -> dict[str, Any]:
    state = deepcopy(DEFAULT_SCENARIO_GAMEPLAY_STATE["archive"])
    if not isinstance(payload, dict):
        return state

    key_moments: list[str] = []
    seen_key_moments: set[str] = set()
    for moment in payload.get("key_moments") or []:
        if not isinstance(moment, str):
            continue
        trimmed = moment.strip()
        if not trimmed or trimmed in seen_key_moments:
            continue
        seen_key_moments.add(trimmed)
        key_moments.append(trimmed)

    branch_snapshots: list[dict[str, Any]] = []
    seen_branch_ids: dict[str, int] = {}
    for raw_snapshot in payload.get("branch_snapshots") or []:
        if not isinstance(raw_snapshot, dict):
            continue
        branch_id = str(raw_snapshot.get("branch_id", "")).strip()
        title = str(raw_snapshot.get("title", "")).strip()
        if not branch_id or not title:
            continue
        try:
            probability = float(raw_snapshot.get("probability", 0))
        except (TypeError, ValueError):
            probability = 0.0
        snapshot = {
            "branch_id": branch_id,
            "title": title,
            "probability": max(0.0, probability),
        }
        if branch_id in seen_branch_ids:
            branch_snapshots[seen_branch_ids[branch_id]] = snapshot
            continue
        seen_branch_ids[branch_id] = len(branch_snapshots)
        branch_snapshots.append(snapshot)

    branch_snapshots.sort(
        key=lambda item: (-item["probability"], item["title"], item["branch_id"])
    )

    state["key_moments"] = key_moments
    state["branch_snapshots"] = branch_snapshots
    return state


def normalize_scenario_gameplay_state(
    payload: dict[str, Any] | None,
    *,
    strict: bool = False,
    valid_branch_ids: set[str] | None = None,
) -> dict[str, Any]:
    state = get_default_scenario_gameplay_state()
    if not isinstance(payload, dict):
        return state
    state["revision"] = _normalize_state_revision(payload)

    raw_cards = payload.get("cards")
    if isinstance(raw_cards, dict):
        usage_log: list[dict[str, Any]] = []
        for entry in raw_cards.get("usage_log") or []:
            if not isinstance(entry, dict):
                continue
            normalized = _normalize_usage_log_entry(entry)
            if normalized is None:
                continue
            usage_log.append(normalized)

        usage_log.sort(key=lambda item: (item["round"], item["used_at"], item["card_id"]))
        state["cards"] = {
            "usage_log": usage_log,
        }

    raw_betting = payload.get("betting")
    if isinstance(raw_betting, dict):
        bets: list[dict[str, Any]] = []
        for entry in raw_betting.get("bets") or []:
            if not isinstance(entry, dict):
                continue
            normalized = _normalize_bet_entry(
                entry,
                strict=strict,
                valid_branch_ids=valid_branch_ids,
            )
            if normalized is None:
                continue
            bets.append(normalized)

        bets.sort(key=lambda item: (item["placed_at_round"], item["placed_at"], item["bet_id"]))
        state["betting"] = {
            "bets": bets,
        }

    state["archive"] = _normalize_archive_state(payload.get("archive"))
    return state


def calculate_campaign_score_delta(
    *,
    archive_grade: str,
    profile_resonance: str,
    completed_daily_challenge: bool,
    bet_count: int,
    betting_hit: bool | None,
    objective_completed_count: int = 0,
    objective_total_count: int = 0,
    commitment_outcome: str | None = None,
) -> int:
    """Apply the Phase A1 campaign score rules."""
    score = 1  # completed run

    if completed_daily_challenge:
        score += 1

    if profile_resonance == "signature":
        score += 2
    elif profile_resonance == "aligned":
        score += 1

    if _has_resolved_bet(bet_count, betting_hit):
        score += 1
    if betting_hit is True:
        score += 2

    if archive_grade == "S":
        score += 2
    elif archive_grade == "A":
        score += 1

    if objective_total_count > 0 and objective_completed_count >= objective_total_count:
        score += 1

    if commitment_outcome == "hit":
        score += 1
    elif commitment_outcome == "miss":
        score -= 1
    return max(1, score)


def build_campaign_score_breakdown(
    *,
    archive_grade: str,
    profile_resonance: str,
    completed_daily_challenge: bool,
    bet_count: int,
    betting_hit: bool | None,
    objective_completed_count: int = 0,
    objective_total_count: int = 0,
    commitment_outcome: str | None = None,
    already_counted_daily_challenge: bool = False,
    weekly_bonus_delta: int = 0,
) -> list[dict[str, Any]]:
    """Return the authoritative itemized score factors for campaign finalize.

    ``already_counted_daily_challenge`` reflects Campaign Phase 1 daily-dedupe:
    when the same ``(director, challenge_local_date, challenge_id)`` has been
    finalized earlier today the daily point does not stack, and we surface a
    dedicated breakdown row so the client can render an explanation.

    ``weekly_bonus_delta`` is the durable weekly-track bonus computed at
    finalize time (only applied when ``week_key`` + ``weekly_track_id`` are
    present in the scenario's campaign context).
    """
    normalized_grade = _normalize_archive_grade(archive_grade)
    normalized_resonance = _normalize_profile_resonance(profile_resonance)
    normalized_completed_count, normalized_total_count = _normalize_objective_counts(
        objective_completed_count,
        objective_total_count,
    )
    normalized_commitment_outcome = _normalize_commitment_outcome(commitment_outcome)

    items: list[dict[str, Any]] = []

    def add(
        item_id: str,
        points: int,
        applied: bool,
        *,
        label_key: str | None = None,
    ) -> None:
        items.append(
            {
                "id": item_id,
                "label_key": label_key or f"result.director_score_{item_id}",
                "points": points,
                "applied": applied,
            }
        )

    add("completed_run", 1, True)
    add("daily_challenge", 1, completed_daily_challenge)
    if already_counted_daily_challenge:
        add("already_counted_daily_challenge", 0, False)

    add("profile_signature", 2, normalized_resonance == "signature")
    add("profile_aligned", 1, normalized_resonance == "aligned")
    add("profile_offbeat", 0, normalized_resonance == "offbeat")

    has_resolved_bet = _has_resolved_bet(bet_count, betting_hit)
    add("bet_placed", 1, has_resolved_bet)
    add("bet_hit", 2, betting_hit is True)
    add("bet_miss", 0, betting_hit is False)
    add("bet_none", 0, not has_resolved_bet)

    add("archive_s", 2, normalized_grade == "S")
    add("archive_a", 1, normalized_grade == "A")
    add("archive_lower", 0, normalized_grade not in {"S", "A"})

    objectives_complete = (
        normalized_total_count > 0
        and normalized_completed_count >= normalized_total_count
    )
    add("objectives_complete", 1, objectives_complete)
    add("objectives_incomplete", 0, normalized_total_count > 0 and not objectives_complete)

    add("commitment_hit", 1, normalized_commitment_outcome == "hit")
    add("commitment_miss", -1, normalized_commitment_outcome == "miss")
    add("commitment_pending", 0, normalized_commitment_outcome == "pending")
    add("commitment_none", 0, normalized_commitment_outcome is None)

    if weekly_bonus_delta:
        # Phase 2b: keep the historical label_key so frontends that consumed
        # ``result.director_score_weekly_track_bonus`` continue to render;
        # the row id is renamed to ``weekly_theme_bonus`` to match the new
        # contract.
        add(
            "weekly_theme_bonus",
            int(weekly_bonus_delta),
            True,
            label_key="result.director_score_weekly_track_bonus",
        )

    return items


def calculate_mastery_level(campaign_score: int) -> int:
    """Return the mastery level for ``campaign_score`` (Phase 3 curve).

    Non-linear progression: ``level = floor(sqrt(score / 2))``, clamped to a
    minimum of 1 so the finalize summary never surfaces level 0 (the legacy
    contract guaranteed ``level >= 1``). The implied score thresholds are
    Level 1 ≥ 2, Level 2 ≥ 8, Level 3 ≥ 18, Level 4 ≥ 32, Level 5 ≥ 50, ...
    """
    if campaign_score < 0:
        campaign_score = 0
    raw_level = int((campaign_score // 2) ** 0.5)
    # Integer square root via float ** 0.5 is well-defined for the score
    # range we use (<10^9); we still verify by re-squaring the candidate +1
    # in case floating-point rounding lands one short.
    candidate = raw_level
    while 2 * (candidate + 1) ** 2 <= campaign_score:
        candidate += 1
    while candidate > 0 and 2 * candidate**2 > campaign_score:
        candidate -= 1
    return max(1, candidate)


def _next_level_score(level: int) -> int:
    """Score required to reach ``level + 1`` (Phase 3 curve)."""
    next_level = max(level, 0) + 1
    return 2 * next_level**2


def _better_archive_grade(current: str | None, candidate: str | None) -> str | None:
    if candidate is None:
        return current
    if current is None:
        return candidate
    if ARCHIVE_GRADE_ORDER[candidate] > ARCHIVE_GRADE_ORDER[current]:
        return candidate
    return current


def _get_director_profile(session: Session, user_id: str) -> DirectorProfile | None:
    return session.exec(
        select(DirectorProfile).where(DirectorProfile.user_id == user_id)
    ).first()


def _get_or_create_director_profile(
    session: Session,
    *,
    user_id: str,
    user_name: str,
) -> DirectorProfile:
    profile = _get_director_profile(session, user_id)
    if profile is None:
        profile = DirectorProfile(
            user_id=user_id,
            user_name=user_name or get_anonymous_director_name(),
        )
        session.add(profile)
        session.flush()
        return profile

    if user_name:
        profile.user_name = user_name
    return profile


def _get_or_create_profile_mastery(
    session: Session,
    *,
    director_profile_id: str,
    profile_id: str,
) -> ProfileMastery:
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == director_profile_id,
            ProfileMastery.profile_id == profile_id,
        )
    ).first()
    if mastery is None:
        mastery = ProfileMastery(
            director_profile_id=director_profile_id,
            profile_id=profile_id,
        )
        session.add(mastery)
        session.flush()
    return mastery


def _refresh_favorite_card(session: Session, mastery: ProfileMastery) -> None:
    logs = list(session.exec(
        select(ScenarioCampaignLog).where(
            ScenarioCampaignLog.director_profile_id == mastery.director_profile_id,
            ScenarioCampaignLog.profile_id == mastery.profile_id,
        )
    ).all())
    cards = [log.most_used_card for log in logs if log.most_used_card]
    if not cards:
        mastery.favorite_card_id = None
        return

    counts = Counter(cards)
    mastery.favorite_card_id = sorted(
        counts.items(),
        key=lambda item: (-item[1], item[0]),
    )[0][0]


def _scenario_bet_count(gameplay_state_json: dict[str, Any] | None) -> int:
    state = normalize_scenario_gameplay_state(gameplay_state_json)
    return len(state["betting"]["bets"])


def _has_meaningful_gameplay_state(state: dict[str, Any]) -> bool:
    return bool(
        state["cards"]["usage_log"]
        or state["archive"]["key_moments"]
        or state["archive"]["branch_snapshots"]
    )


def _has_meaningful_director_state(state: dict[str, Any]) -> bool:
    commitment = state["commitment"]
    return bool(
        state["objectives"]["goals"]
        or commitment["active"]
        or commitment["outcome"]
    )


def _normalize_archive_bet_value(value: str | None) -> str:
    normalized = (value or "").lower()
    normalized = re.sub(r"[^\w]+", " ", normalized, flags=re.UNICODE)
    return re.sub(r"\s+", " ", normalized).strip()


def _matches_archive_bet_option(
    target_id: str | None,
    target_label: str,
    option_id: str,
    option: dict[str, str],
) -> bool:
    normalized_target_id = _normalize_archive_bet_value(target_id)
    if normalized_target_id == option_id:
        return True

    normalized_target_label = _normalize_archive_bet_value(target_label)
    return bool(
        normalized_target_label
        and (
            normalized_target_label == option_id
            or normalized_target_label == _normalize_archive_bet_value(option["zh"])
            or normalized_target_label == _normalize_archive_bet_value(option["en"])
        )
    )


def _scenario_archive_branches(
    session: Session,
    *,
    scenario_id: str,
    gameplay_state: dict[str, Any],
) -> list[dict[str, Any]]:
    rows = list(session.exec(select(Branch).where(Branch.scenario_id == scenario_id)).all())
    rows_by_id = {row.id: row for row in rows}

    snapshot_branches: list[dict[str, Any]] = []
    for snapshot in gameplay_state["archive"]["branch_snapshots"]:
        branch_id = snapshot["branch_id"]
        row = rows_by_id.get(branch_id)
        snapshot_branches.append(
            {
                "id": branch_id,
                "title": snapshot["title"] or (row.title if row else ""),
                "story": row.story if row else "",
                "insight": row.insight if row else "",
                "probability": float(snapshot["probability"]),
            }
        )

    if snapshot_branches:
        return sorted(
            snapshot_branches,
            key=lambda item: (-item["probability"], item["title"], item["id"]),
        )

    return sorted(
        [
            {
                "id": row.id,
                "title": row.title,
                "story": row.story,
                "insight": row.insight,
                "probability": float(row.probability),
            }
            for row in rows
        ],
        key=lambda item: (-item["probability"], item["title"], item["id"]),
    )


def _pick_dominant_archive_branch(
    branches: list[dict[str, Any]],
) -> dict[str, Any] | None:
    return branches[0] if branches else None


def _infer_dominant_tone(branch: dict[str, Any] | None) -> str | None:
    if branch is None:
        return None
    corpus = f"{branch['title']} {branch['story']} {branch['insight']}".lower()
    if any(keyword in corpus for keyword in BALANCE_KEYWORDS):
        return "balance"
    if re.search(r"秩序|统一|帝国|稳定|整顿|order|consolid|empire|stability|control", corpus):
        return "order"
    if any(keyword in corpus for keyword in RUPTURE_KEYWORDS):
        return "rupture"
    return None


def _resolve_archive_profile_resonance(
    profile_id: str,
    dominant_branch: dict[str, Any] | None,
) -> str:
    if dominant_branch is None:
        return "offbeat"
    corpus = (
        f"{dominant_branch['title']} {dominant_branch['story']} "
        f"{dominant_branch['insight']}"
    ).lower()
    keywords = PROFILE_RESONANCE_KEYWORDS.get(
        profile_id,
        PROFILE_RESONANCE_KEYWORDS["generic"],
    )
    hits = sum(1 for keyword in keywords if keyword.lower() in corpus)
    if hits >= 2:
        return "signature"
    if hits >= 1:
        return "aligned"
    return "offbeat"


def _resolve_archive_betting_hit(
    bets: list[dict[str, Any]],
    *,
    dominant_branch: dict[str, Any] | None,
    dominant_tone: str | None,
    profile_resonance: str,
) -> bool | None:
    if not bets:
        return None

    for bet in bets:
        if bet["kind"] == "branch_winner":
            if dominant_branch and (
                bet["target_id"] == dominant_branch["id"]
                or bet["target_label"] == dominant_branch["title"]
            ):
                return True
            continue

        if bet["kind"] == "profile_resonance":
            if _matches_archive_bet_option(
                bet["target_id"],
                bet["target_label"],
                profile_resonance,
                PROFILE_RESONANCE_OPTIONS[profile_resonance],
            ):
                return True
            continue

        if dominant_tone and _matches_archive_bet_option(
            bet["target_id"],
            bet["target_label"],
            dominant_tone,
            ENDING_TONE_OPTIONS[dominant_tone],
        ):
            return True

    return False


def _pick_most_used_card_from_state(gameplay_state: dict[str, Any]) -> str | None:
    cards = [usage["card_id"] for usage in gameplay_state["cards"]["usage_log"]]
    if not cards:
        return None
    counts = Counter(cards)
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))[0][0]


def _resolve_commitment_outcome_from_state(
    director_state: dict[str, Any],
    dominant_branch: dict[str, Any] | None,
) -> str | None:
    commitment = director_state["commitment"]
    if not commitment["active"]:
        return None
    if dominant_branch is None:
        return _normalize_commitment_outcome(commitment["outcome"]) or "pending"
    return "hit" if dominant_branch["id"] == commitment["branch_id"] else "miss"


def _evaluate_objective_counts_from_state(
    *,
    director_state: dict[str, Any],
    gameplay_state: dict[str, Any],
    dominant_branch: dict[str, Any] | None,
) -> tuple[int, int]:
    goals = director_state["objectives"]["goals"]
    completed = 0
    used_card_ids = {
        usage["card_id"]
        for usage in gameplay_state["cards"]["usage_log"]
    }
    commitment = director_state["commitment"]

    for goal in goals:
        if goal["kind"] == "signature_arc_step":
            target_card_id = goal.get("target_card_id")
            if target_card_id and target_card_id in used_card_ids:
                completed += 1
        elif (
            goal["kind"] == "branch_commitment"
            and commitment["active"]
            and dominant_branch is not None
            and commitment["branch_id"] == dominant_branch["id"]
        ):
            completed += 1

    return completed, len(goals)


def _resolve_authoritative_archive_grade(
    *,
    usage_count: int,
    bet_count: int,
    betting_hit: bool | None,
    branch_count: int,
    key_moment_count: int,
    completed_daily_challenge: bool,
    profile_resonance: str,
    objective_completed_count: int,
    commitment_outcome: str | None,
) -> str:
    score = 0
    if usage_count >= 3:
        score += 3
    elif usage_count >= 1:
        score += 1

    if bet_count > 0:
        score += 1
    if betting_hit:
        score += 2
    if branch_count >= 5:
        score += 1
    if key_moment_count >= 4:
        score += 1
    if completed_daily_challenge:
        score += 1
    if profile_resonance == "signature":
        score += 2
    elif profile_resonance == "aligned":
        score += 1
    if objective_completed_count >= 2:
        score += 2
    elif objective_completed_count >= 1:
        score += 1
    if commitment_outcome == "hit":
        score += 1

    if score >= 6:
        return "S"
    if score >= 5:
        return "A"
    if score >= 3:
        return "B"
    return "C"


def _resolve_finalize_authority_inputs(
    session: Session,
    *,
    scenario: Scenario,
    profile_id: str,
    finalize_context: dict[str, Any],
    archive_grade: str,
    profile_resonance: str,
    betting_hit: bool | None,
    bet_count: int,
    most_used_card: str | None,
    objective_completed_count: int,
    objective_total_count: int,
    commitment_outcome: str | None,
) -> dict[str, Any]:
    gameplay_state = normalize_scenario_gameplay_state(scenario.gameplay_state_json)
    director_state = normalize_scenario_director_state(scenario.director_state_json)
    has_authority = (
        _has_meaningful_gameplay_state(gameplay_state)
        or _has_meaningful_director_state(director_state)
    )

    if not has_authority:
        effective_bet_count, effective_betting_hit = _resolve_finalize_betting_inputs(
            scenario=scenario,
            bet_count=bet_count,
            betting_hit=betting_hit,
        )
        return {
            "archive_grade": archive_grade,
            "profile_resonance": profile_resonance,
            "bet_count": effective_bet_count,
            "betting_hit": effective_betting_hit,
            "most_used_card": (most_used_card or "").strip() or None,
            "objective_completed_count": objective_completed_count,
            "objective_total_count": objective_total_count,
            "commitment_outcome": commitment_outcome,
        }

    branches = _scenario_archive_branches(
        session,
        scenario_id=scenario.id,
        gameplay_state=gameplay_state,
    )
    dominant_branch = _pick_dominant_archive_branch(branches)
    dominant_tone = _infer_dominant_tone(dominant_branch)
    effective_profile_resonance = _resolve_archive_profile_resonance(
        profile_id,
        dominant_branch,
    )
    effective_bet_count = len(gameplay_state["betting"]["bets"])
    effective_betting_hit = _resolve_archive_betting_hit(
        gameplay_state["betting"]["bets"],
        dominant_branch=dominant_branch,
        dominant_tone=dominant_tone,
        profile_resonance=effective_profile_resonance,
    )
    effective_completed_count, effective_total_count = _evaluate_objective_counts_from_state(
        director_state=director_state,
        gameplay_state=gameplay_state,
        dominant_branch=dominant_branch,
    )
    effective_commitment_outcome = _resolve_commitment_outcome_from_state(
        director_state,
        dominant_branch,
    )
    effective_archive_grade = _resolve_authoritative_archive_grade(
        usage_count=len(gameplay_state["cards"]["usage_log"]),
        bet_count=effective_bet_count,
        betting_hit=effective_betting_hit,
        branch_count=len(branches),
        key_moment_count=len(gameplay_state["archive"]["key_moments"]),
        completed_daily_challenge=bool(
            finalize_context.get("completed_daily_challenge_intent")
        ),
        profile_resonance=effective_profile_resonance,
        objective_completed_count=effective_completed_count,
        commitment_outcome=effective_commitment_outcome,
    )

    return {
        "archive_grade": effective_archive_grade,
        "profile_resonance": effective_profile_resonance,
        "bet_count": effective_bet_count,
        "betting_hit": effective_betting_hit,
        "most_used_card": _pick_most_used_card_from_state(gameplay_state),
        "objective_completed_count": effective_completed_count,
        "objective_total_count": effective_total_count,
        "commitment_outcome": effective_commitment_outcome,
    }


def _recompute_director_profile(session: Session, director_profile: DirectorProfile) -> None:
    logs = list(
        session.exec(
            select(ScenarioCampaignLog).where(
                ScenarioCampaignLog.director_profile_id == director_profile.id
            )
        ).all()
    )
    scenario_ids = [log.scenario_id for log in logs]
    scenarios_by_id = {
        item.id: item
        for item in session.exec(select(Scenario).where(Scenario.id.in_(scenario_ids))).all()
    } if scenario_ids else {}

    highest_archive_grade: str | None = None
    total_bets = 0
    for log in logs:
        highest_archive_grade = _better_archive_grade(highest_archive_grade, log.archive_grade)
        scenario = scenarios_by_id.get(log.scenario_id)
        total_bets += _scenario_bet_count(
            scenario.gameplay_state_json if scenario is not None else None
        )

    director_profile.total_runs = len(logs)
    director_profile.completed_challenges = sum(
        int(log.completed_daily_challenge) for log in logs
    )
    director_profile.total_bets = total_bets
    director_profile.hit_bets = sum(int(log.betting_hit is True) for log in logs)
    director_profile.highest_archive_grade = highest_archive_grade
    director_profile.updated_at = _now()
    session.add(director_profile)


def _recompute_profile_mastery(session: Session, mastery: ProfileMastery) -> None:
    logs = list(
        session.exec(
            select(ScenarioCampaignLog).where(
                ScenarioCampaignLog.director_profile_id == mastery.director_profile_id,
                ScenarioCampaignLog.profile_id == mastery.profile_id,
            )
        ).all()
    )

    best_archive_grade: str | None = None
    for log in logs:
        best_archive_grade = _better_archive_grade(best_archive_grade, log.archive_grade)

    mastery.runs = len(logs)
    mastery.challenge_completions = sum(int(log.completed_daily_challenge) for log in logs)
    mastery.signature_hits = sum(int(log.profile_resonance == "signature") for log in logs)
    mastery.aligned_hits = sum(int(log.profile_resonance == "aligned") for log in logs)
    mastery.campaign_score = sum(log.campaign_score_delta for log in logs)
    mastery.level = calculate_mastery_level(mastery.campaign_score) if logs else 1
    mastery.best_archive_grade = best_archive_grade
    mastery.updated_at = _now()
    _refresh_favorite_card(session, mastery)
    session.add(mastery)


def remove_scenario_campaign_artifacts(session: Session, scenario: Scenario) -> None:
    """Drop one scenario's campaign provenance and refresh derived aggregates."""
    log = session.exec(
        select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario.id)
    ).first()
    if log is None:
        return

    director_profile = session.get(DirectorProfile, log.director_profile_id)
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == log.director_profile_id,
            ProfileMastery.profile_id == log.profile_id,
        )
    ).first()

    session.delete(log)
    for badge in session.exec(
        select(DirectorBadgeUnlock).where(DirectorBadgeUnlock.source_scenario_id == scenario.id)
    ).all():
        badge.source_scenario_id = None
        session.add(badge)

    session.flush()

    if director_profile is not None:
        _recompute_director_profile(session, director_profile)
    if mastery is not None:
        _recompute_profile_mastery(session, mastery)


def _get_last_daily_challenge_log(
    session: Session,
    director_profile_id: str,
) -> ScenarioCampaignLog | None:
    return session.exec(
        select(ScenarioCampaignLog)
        .where(
            ScenarioCampaignLog.director_profile_id == director_profile_id,
            ScenarioCampaignLog.completed_daily_challenge.is_(True),
        )
        .order_by(ScenarioCampaignLog.created_at.desc())
    ).first()


def _build_profile_summary(
    profile: DirectorProfile,
    *,
    last_daily_log: ScenarioCampaignLog | None,
) -> dict[str, Any]:
    return {
        "id": profile.id,
        "user_id": profile.user_id,
        "user_name": profile.user_name,
        "total_runs": profile.total_runs,
        "completed_challenges": profile.completed_challenges,
        "total_bets": profile.total_bets,
        "hit_bets": profile.hit_bets,
        "highest_archive_grade": profile.highest_archive_grade,
        "created_at": _serialize_datetime(profile.created_at),
        "updated_at": _serialize_datetime(profile.updated_at),
        "last_daily_challenge_completed_at": _serialize_datetime(
            last_daily_log.created_at if last_daily_log else None
        ),
        "last_daily_challenge_profile_id": last_daily_log.profile_id if last_daily_log else None,
        "last_daily_challenge_scenario_id": last_daily_log.scenario_id if last_daily_log else None,
    }


def _build_empty_profile_summary(user_id: str, *, language: str | None = None) -> dict[str, Any]:
    now = _now().isoformat()
    return {
        "id": user_id,
        "user_id": user_id,
        "user_name": get_anonymous_director_name(language),
        "total_runs": 0,
        "completed_challenges": 0,
        "total_bets": 0,
        "hit_bets": 0,
        "highest_archive_grade": None,
        "created_at": now,
        "updated_at": now,
        "last_daily_challenge_completed_at": None,
        "last_daily_challenge_profile_id": None,
        "last_daily_challenge_scenario_id": None,
    }


def _build_mastery_summary(mastery: ProfileMastery) -> dict[str, Any]:
    effective_level = calculate_mastery_level(mastery.campaign_score)
    next_level_score = _next_level_score(effective_level)
    return {
        "id": mastery.id,
        "director_profile_id": mastery.director_profile_id,
        "profile_id": mastery.profile_id,
        "runs": mastery.runs,
        "challenge_completions": mastery.challenge_completions,
        "signature_hits": mastery.signature_hits,
        "aligned_hits": mastery.aligned_hits,
        "campaign_score": mastery.campaign_score,
        "level": effective_level,
        "best_archive_grade": mastery.best_archive_grade,
        "favorite_card_id": mastery.favorite_card_id,
        "updated_at": _serialize_datetime(mastery.updated_at),
        "next_level_score": next_level_score,
        "score_to_next_level": max(0, next_level_score - mastery.campaign_score),
    }


def _build_badge_summary(badge: DirectorBadgeUnlock) -> dict[str, Any]:
    return {
        "id": badge.id,
        "badge_id": badge.badge_id,
        "unlocked_at": _serialize_datetime(badge.unlocked_at),
        "source_profile_id": badge.source_profile_id,
        "source_scenario_id": badge.source_scenario_id,
    }


def _build_scenario_campaign_summary(
    log: ScenarioCampaignLog,
    *,
    bet_count: int | None = None,
) -> dict[str, Any]:
    weekly_bonus_delta = int(getattr(log, "weekly_bonus_delta", 0) or 0)
    stable_bet_count = int(log.betting_hit is not None) if bet_count is None else bet_count
    return {
        "scenario_id": log.scenario_id,
        "profile_id": log.profile_id,
        "archive_grade": log.archive_grade,
        "profile_resonance": log.profile_resonance,
        "betting_hit": log.betting_hit,
        "most_used_card": log.most_used_card,
        "completed_daily_challenge": log.completed_daily_challenge,
        "objective_completed_count": log.objective_completed_count,
        "objective_total_count": log.objective_total_count,
        "commitment_outcome": log.commitment_outcome,
        "campaign_score_delta": log.campaign_score_delta,
        "score_breakdown": build_campaign_score_breakdown(
            archive_grade=log.archive_grade,
            profile_resonance=log.profile_resonance,
            completed_daily_challenge=log.completed_daily_challenge,
            bet_count=stable_bet_count,
            betting_hit=log.betting_hit,
            objective_completed_count=log.objective_completed_count,
            objective_total_count=log.objective_total_count,
            commitment_outcome=log.commitment_outcome,
            weekly_bonus_delta=weekly_bonus_delta,
        ),
        "finalized_at": _serialize_datetime(log.created_at),
        "challenge_id": log.challenge_id,
        "challenge_local_date": log.challenge_local_date,
        "week_key": log.week_key,
        "weekly_track_id": log.weekly_track_id,
        "difficulty_tier": log.difficulty_tier,
        "weekly_bonus_delta": weekly_bonus_delta,
        "streak_after": log.streak_after,
        "campaign_context_source": log.campaign_context_source,
    }


def _parse_local_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise CampaignError(f"Unsupported local_date: {value}") from exc


def _build_local_timezone(offset_minutes: int) -> timezone:
    if offset_minutes < -14 * 60 or offset_minutes > 14 * 60:
        raise CampaignError("timezone_offset_minutes out of range")
    return timezone(timedelta(minutes=-offset_minutes))


def _build_local_date_utc_window(
    start_date: date,
    end_date: date,
    *,
    local_timezone: timezone,
) -> tuple[datetime, datetime]:
    local_start = datetime(
        start_date.year,
        start_date.month,
        start_date.day,
        tzinfo=local_timezone,
    )
    next_local_start = datetime(
        end_date.year,
        end_date.month,
        end_date.day,
        tzinfo=local_timezone,
    ) + timedelta(days=1)
    return (
        local_start.astimezone(timezone.utc),
        next_local_start.astimezone(timezone.utc),
    )


def _extract_campaign_context(scenario: Scenario | None) -> dict[str, Any] | None:
    """Read the authoritative campaign context attached at scenario creation."""
    if scenario is None or not isinstance(scenario.parsed_context, dict):
        return None
    raw = scenario.parsed_context.get("campaign_context")
    if raw is None:
        return None
    if not isinstance(raw, dict):
        # M-3: scenario.parsed_context is normally guarded by the
        # ``CampaignContext`` Pydantic model on the create path, so a
        # non-dict shape here means either a hand-edited row or a future
        # contract change that hasn't propagated. Log so observability can
        # flag it rather than silently downgrade to the legacy_bool path.
        logger.warning(
            "campaign_context in scenario.parsed_context is not a dict; "
            "falling back to legacy_bool source",
            extra={
                "scenario_id": getattr(scenario, "id", None),
                "campaign_context_type": type(raw).__name__,
            },
        )
        return None
    return raw


def _log_campaign_context_drift(
    *,
    scenario_id: str,
    existing_log: ScenarioCampaignLog,
    finalize_context: dict[str, Any],
) -> None:
    """Warn if the persisted log disagrees with the freshly resolved context.

    Triggered only from the ``already_finalized`` re-finalize path. We never
    rewrite the ledger — the row from the first finalize is the source of
    truth — but stakeholders deserve a breadcrumb when scenario.parsed_context
    was rewritten or arrived with a different challenge identity than the one
    used at first finalize.
    """
    persisted = {
        "challenge_id": existing_log.challenge_id,
        "challenge_local_date": existing_log.challenge_local_date,
        "week_key": existing_log.week_key,
        "weekly_track_id": existing_log.weekly_track_id,
        "difficulty_tier": existing_log.difficulty_tier,
        "campaign_context_source": existing_log.campaign_context_source,
    }
    current = {
        "challenge_id": finalize_context.get("challenge_id"),
        "challenge_local_date": finalize_context.get("challenge_local_date"),
        "week_key": finalize_context.get("week_key"),
        "weekly_track_id": finalize_context.get("weekly_track_id"),
        "difficulty_tier": finalize_context.get("difficulty_tier"),
        "campaign_context_source": finalize_context.get("campaign_context_source"),
    }
    if persisted == current:
        return
    logger.warning(
        "campaign_context drift detected on re-finalize",
        extra={
            "scenario_id": scenario_id,
            "persisted": persisted,
            "current": current,
            "campaign_context_source_persisted": existing_log.campaign_context_source,
            "campaign_context_source_current": finalize_context.get(
                "campaign_context_source"
            ),
        },
    )


def _resolve_finalize_campaign_context(
    scenario: Scenario | None,
    *,
    legacy_completed_daily_challenge: bool,
) -> dict[str, Any]:
    """Collapse scenario context + legacy boolean into a single finalize record.

    Returns a dict with the keys ``finalize_scenario_campaign`` needs to thread
    into the ledger and breakdown — including ``effective_completed_daily``
    (after dedupe in callers), ``challenge_id``/``challenge_local_date``/
    ``week_key``/``weekly_track_id``/``difficulty_tier`` and the provenance
    label ``campaign_context_source``.
    """
    context = _extract_campaign_context(scenario)
    if context is not None:
        is_daily = bool(context.get("is_daily_challenge"))
        is_weekly = bool(context.get("is_weekly_track"))
        return {
            "context_present": True,
            "campaign_context_source": "scenario_context",
            "challenge_id": context.get("challenge_id"),
            "challenge_local_date": context.get("challenge_local_date"),
            "week_key": context.get("week_key"),
            "weekly_track_id": context.get("weekly_track_id"),
            "profile_id": context.get("profile_id"),
            "difficulty_tier": context.get("difficulty_tier"),
            "is_daily_challenge": is_daily,
            "is_weekly_track": is_weekly,
            "completed_daily_challenge_intent": is_daily,
        }

    return {
        "context_present": False,
        "campaign_context_source": (
            "legacy_bool" if legacy_completed_daily_challenge else None
        ),
        "challenge_id": None,
        "challenge_local_date": None,
        "week_key": None,
        "weekly_track_id": None,
        "profile_id": None,
        "difficulty_tier": None,
        "is_daily_challenge": legacy_completed_daily_challenge,
        "is_weekly_track": False,
        "completed_daily_challenge_intent": legacy_completed_daily_challenge,
    }


def _find_existing_daily_log(
    session: Session,
    *,
    director_profile_id: str,
    challenge_id: str | None,
    challenge_local_date: str | None,
) -> ScenarioCampaignLog | None:
    """Return any prior log for the same ``(director, day, challenge)`` triple."""
    if not challenge_id or not challenge_local_date:
        return None
    return session.exec(
        select(ScenarioCampaignLog).where(
            ScenarioCampaignLog.director_profile_id == director_profile_id,
            ScenarioCampaignLog.challenge_id == challenge_id,
            ScenarioCampaignLog.challenge_local_date == challenge_local_date,
        )
    ).first()


def _find_existing_legacy_daily_log_today(
    session: Session,
    *,
    director_profile_id: str,
) -> ScenarioCampaignLog | None:
    """Return any legacy daily=True log finalized in today's UTC window.

    Restores the pre-Phase-1 anti-spam check for callers that have not yet
    migrated to ``campaign_context``: the daily point cannot stack for the same
    director within the same UTC day.
    """
    now_utc = datetime.now(timezone.utc)
    day_start_utc = now_utc.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end_utc = day_start_utc + timedelta(days=1)
    return session.exec(
        select(ScenarioCampaignLog).where(
            ScenarioCampaignLog.director_profile_id == director_profile_id,
            ScenarioCampaignLog.completed_daily_challenge.is_(True),
            ScenarioCampaignLog.created_at >= day_start_utc,
            ScenarioCampaignLog.created_at < day_end_utc,
        )
    ).first()


def _compute_streak_after(
    session: Session,
    *,
    director_profile_id: str,
    challenge_local_date: str | None,
    include_target_as_completed: bool = True,
) -> int | None:
    """Count consecutive completed challenge days ending on ``challenge_local_date``.

    By default the target day counts as day 1 — this is the finalize path,
    where the caller is recording today's completion. When invoked from a
    read-only path (e.g. ``get_daily_challenge_summary``) callers should pass
    ``include_target_as_completed=False`` so the streak reflects ONLY what
    is already persisted; an incomplete target day no longer inflates the
    count from 0 to 1.

    Only durable-date rows participate; legacy rows without
    ``challenge_local_date`` contribute nothing.
    """
    if not challenge_local_date:
        return None
    try:
        target_date = date.fromisoformat(challenge_local_date)
    except ValueError:
        return None

    completed_dates = set(
        session.exec(
            select(ScenarioCampaignLog.challenge_local_date).where(
                ScenarioCampaignLog.director_profile_id == director_profile_id,
                ScenarioCampaignLog.challenge_local_date.is_not(None),
                ScenarioCampaignLog.challenge_id.is_not(None),
                ScenarioCampaignLog.completed_daily_challenge.is_(True),
            )
        ).all()
    )
    if include_target_as_completed:
        completed_dates.add(challenge_local_date)

    streak = 0
    cursor = target_date
    while cursor.isoformat() in completed_dates:
        streak += 1
        cursor = cursor - timedelta(days=1)
    return streak


def _count_recent_daily_completion_days(
    session: Session,
    *,
    director_profile_id: str,
    anchor_date: date,
    window_days: int = 30,
) -> int:
    """Count unique completed daily-challenge dates within the last ``window_days``.

    The window is inclusive of ``anchor_date`` and walks ``window_days - 1``
    days backwards. Only durable-date rows participate; legacy rows without
    ``challenge_local_date`` are ignored (the legacy boolean path can't
    distinguish "today" from "next finalize this hour", so it would inflate
    the count).
    """
    earliest = (anchor_date - timedelta(days=max(window_days - 1, 0))).isoformat()
    latest = anchor_date.isoformat()
    rows = session.exec(
        select(ScenarioCampaignLog.challenge_local_date).where(
            ScenarioCampaignLog.director_profile_id == director_profile_id,
            ScenarioCampaignLog.completed_daily_challenge.is_(True),
            ScenarioCampaignLog.challenge_local_date.is_not(None),
            ScenarioCampaignLog.challenge_local_date >= earliest,
            ScenarioCampaignLog.challenge_local_date <= latest,
        )
    ).all()
    return len({row for row in rows if row is not None})


WEEKLY_BONUS_PER_TRACK_CAP = 3
WEEKLY_BONUS_LOCK_LEASE_SECONDS = 15.0
WEEKLY_BONUS_LOCK_WAIT_SECONDS = 2.0
WEEKLY_BONUS_LOCK_POLL_SECONDS = 0.05


def _acquire_weekly_bonus_cap_lock(
    *,
    lock_subject_id: str,
    week_key: str | None,
    weekly_track_id: str | None,
    effective_completed_daily: bool,
):
    if not week_key or not weekly_track_id or not effective_completed_daily:
        return None
    lock_key = f"campaign-weekly-bonus:{lock_subject_id}:{week_key}:{weekly_track_id}"
    deadline = time.monotonic() + WEEKLY_BONUS_LOCK_WAIT_SECONDS
    while True:
        lease = acquire_runtime_lock(
            lock_key,
            lease_seconds=WEEKLY_BONUS_LOCK_LEASE_SECONDS,
        )
        if lease is not None:
            return lease
        if time.monotonic() >= deadline:
            raise CampaignConflictError("Weekly campaign bonus finalize is busy")
        time.sleep(WEEKLY_BONUS_LOCK_POLL_SECONDS)


def _compute_weekly_bonus_delta(
    session: Session | None = None,
    *,
    director_profile_id: str | None = None,
    week_key: str | None,
    weekly_track_id: str | None,
    effective_completed_daily: bool,
) -> int:
    """Award +1 weekly-track bonus when the run finalizes a daily on-track.

    The bonus is capped at :data:`WEEKLY_BONUS_PER_TRACK_CAP` hits per
    ``(director_profile_id, week_key, weekly_track_id)`` so a single weekly
    track cannot mint unbounded score.

    The cap is only enforced when ``session`` and ``director_profile_id`` are
    supplied; legacy callers that don't pass them remain on the unbounded
    behavior (used only in unit tests and the deprecated direct-call path).
    """
    if not week_key or not weekly_track_id:
        return 0
    if not effective_completed_daily:
        return 0
    if session is not None and director_profile_id is not None:
        already_awarded = session.exec(
            select(func.count(ScenarioCampaignLog.id)).where(
                ScenarioCampaignLog.director_profile_id == director_profile_id,
                ScenarioCampaignLog.week_key == week_key,
                ScenarioCampaignLog.weekly_track_id == weekly_track_id,
                ScenarioCampaignLog.weekly_bonus_delta > 0,
            )
        ).one()
        if isinstance(already_awarded, tuple):
            already_awarded = already_awarded[0]
        if already_awarded is not None and int(already_awarded) >= WEEKLY_BONUS_PER_TRACK_CAP:
            return 0
    return 1


def _build_daily_challenge_summary(
    *,
    user_id: str,
    profile_id: str,
    local_date: str,
    completed: bool,
    log: ScenarioCampaignLog | None = None,
    timezone_offset_minutes: int,
    current_streak: int = 0,
    recent_daily_completion_days: int = 0,
    next_refresh_at: str | None = None,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "profile_id": profile_id,
        "local_date": local_date,
        "timezone_offset_minutes": timezone_offset_minutes,
        "completed": completed,
        "scenario_id": log.scenario_id if log else None,
        "completed_at": _serialize_datetime(log.created_at if log else None),
        "most_used_card": log.most_used_card if log else None,
        "betting_hit": log.betting_hit if log else None,
        "profile_resonance": log.profile_resonance if log else None,
        "campaign_score_delta": log.campaign_score_delta if log else None,
        "challenge_id": log.challenge_id if log else None,
        "challenge_local_date": log.challenge_local_date if log else None,
        "difficulty_tier": log.difficulty_tier if log else None,
        "streak_after": log.streak_after if log else None,
        "campaign_context_source": log.campaign_context_source if log else None,
        # Phase 2a: streak / activity envelope
        "current_streak": int(current_streak),
        "recent_daily_completion_days": int(recent_daily_completion_days),
        "next_refresh_at": next_refresh_at,
    }


def _build_weekly_campaign_summary(
    *,
    user_id: str,
    week_start: date,
    week_end: date,
    timezone_offset_minutes: int,
    total_runs: int,
    completed_daily_challenges: int,
    hit_bets: int,
    campaign_score_delta: int,
    best_archive_grade: str | None,
    top_profile_id: str | None,
    profile_runs: dict[str, int],
    weekly_bonus_total: int = 0,
    week_key: str | None = None,
    weekly_track_runs: dict[str, int] | None = None,
    weekly_track_id: str | None = None,
    rank: int | None = None,
    leaderboard_entries: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "timezone_offset_minutes": timezone_offset_minutes,
        "total_runs": total_runs,
        "completed_daily_challenges": completed_daily_challenges,
        "hit_bets": hit_bets,
        "campaign_score_delta": campaign_score_delta,
        "best_archive_grade": best_archive_grade,
        "top_profile_id": top_profile_id,
        "profile_runs": profile_runs,
        "weekly_bonus_total": weekly_bonus_total,
        "week_key": week_key,
        "weekly_track_runs": weekly_track_runs or {},
        # Phase 2b: active track + leaderboard preview
        "weekly_track_id": weekly_track_id,
        "rank": rank,
        "leaderboard_entries": leaderboard_entries or [],
    }


def _mask_display_name(name: str | None) -> str:
    """Privacy-by-design display name for leaderboard rows.

    Returns the first 3 characters of the original name with three asterisks
    appended (e.g. ``"Dee***"``). Empty / None falls back to a stable
    anonymous placeholder.
    """
    if not name:
        return "Anon***"
    stripped = name.strip()
    if not stripped:
        return "Anon***"
    head = stripped[:3]
    return f"{head}***"


def _compute_weekly_leaderboard(
    session: Session,
    *,
    week_key: str,
    weekly_track_id: str | None,
    self_director_profile_id: str | None,
    limit: int = 10,
) -> tuple[list[dict[str, Any]], int | None]:
    """Aggregate weekly scores per director and return (top-N, self-rank).

    Scope: rows tied to the ``week_key`` (and ``weekly_track_id`` when one is
    active). Score = ``SUM(campaign_score_delta)`` for the matching slice.
    Ranks are 1-indexed; self-rank is computed across the FULL leaderboard
    even when the caller is outside the top-N preview.
    """
    if not week_key:
        return [], None

    filters = [
        ScenarioCampaignLog.week_key == week_key,
    ]
    if weekly_track_id is not None:
        filters.append(ScenarioCampaignLog.weekly_track_id == weekly_track_id)

    rows = session.exec(
        select(
            ScenarioCampaignLog.director_profile_id,
            func.sum(ScenarioCampaignLog.campaign_score_delta),
        )
        .where(*filters)
        .group_by(ScenarioCampaignLog.director_profile_id)
    ).all()

    leaderboard: list[tuple[str, int]] = []
    for row in rows:
        director_id, score = row if isinstance(row, tuple) else (row[0], row[1])
        if director_id is None:
            continue
        leaderboard.append((director_id, int(score or 0)))

    # Stable order: highest score first, ties broken by director_profile_id.
    leaderboard.sort(key=lambda entry: (-entry[1], entry[0]))

    self_rank: int | None = None
    for index, (director_id, _score) in enumerate(leaderboard, start=1):
        if director_id == self_director_profile_id:
            self_rank = index
            break

    entries: list[dict[str, Any]] = []
    if not leaderboard:
        return entries, self_rank

    director_ids = [director_id for director_id, _score in leaderboard[:limit]]
    profiles_by_id: dict[str, DirectorProfile] = {}
    if director_ids:
        for profile in session.exec(
            select(DirectorProfile).where(DirectorProfile.id.in_(director_ids))
        ).all():
            profiles_by_id[profile.id] = profile

    for index, (director_id, score) in enumerate(leaderboard[:limit], start=1):
        profile = profiles_by_id.get(director_id)
        entries.append(
            {
                "rank": index,
                "user_name": _mask_display_name(profile.user_name if profile else None),
                "score": int(score),
            }
        )
    return entries, self_rank


def _list_badge_unlocks(session: Session, director_profile_id: str) -> list[DirectorBadgeUnlock]:
    return list(session.exec(
        select(DirectorBadgeUnlock)
        .where(DirectorBadgeUnlock.director_profile_id == director_profile_id)
        .order_by(DirectorBadgeUnlock.unlocked_at.asc())
    ).all())


def _unlock_badges(
    session: Session,
    *,
    director_profile: DirectorProfile,
    mastery: ProfileMastery,
    log: ScenarioCampaignLog,
    streak_after: int | None,
) -> list[DirectorBadgeUnlock]:
    """Award every badge whose registry predicate fires for ``log``.

    Phase 3 refactor: replaces the static three-entry rules table with a
    registry-driven sweep over :mod:`app.services.badge_registry`. The DB
    layer's unique constraint on ``(director_profile_id, badge_id)`` still
    enforces the one-time-only contract; we additionally short-circuit on
    rowcount==0 so we never emit a duplicate ``DirectorBadgeUnlock`` row for
    badges this director has already earned.
    """
    from app.services.badge_registry import (
        BadgeUnlockContext,
        evaluate_unlocks,
        get_badge_definition,
    )

    mastery_level = calculate_mastery_level(mastery.campaign_score)
    profiles_above_level_3 = _count_director_profiles_at_or_above_level(
        session,
        director_profile_id=director_profile.id,
        level_threshold=3,
        current_mastery=mastery,
    )

    context = BadgeUnlockContext(
        director_profile=director_profile,
        mastery=mastery,
        log=log,
        streak_after=int(streak_after or 0),
        total_profiles_at_or_above_level_3=profiles_above_level_3,
        mastery_level=mastery_level,
    )

    candidate_ids = evaluate_unlocks(context)
    unlocked: list[DirectorBadgeUnlock] = []
    for badge_id in candidate_ids:
        if get_badge_definition(badge_id) is None:
            # Defensive: registry mutated between evaluate + insert.
            continue
        stmt = sqlite_insert(DirectorBadgeUnlock).values(
            id=str(uuid4()),
            director_profile_id=director_profile.id,
            badge_id=badge_id,
            unlocked_at=_now(),
            source_profile_id=log.profile_id,
            source_scenario_id=log.scenario_id,
        ).on_conflict_do_nothing(
            index_elements=["director_profile_id", "badge_id"],
        )
        result = session.execute(stmt)
        if not result.rowcount:
            continue

        unlock = session.exec(
            select(DirectorBadgeUnlock).where(
                DirectorBadgeUnlock.director_profile_id == director_profile.id,
                DirectorBadgeUnlock.badge_id == badge_id,
            )
        ).first()
        if unlock is not None:
            unlocked.append(unlock)

    return unlocked


def _count_director_profiles_at_or_above_level(
    session: Session,
    *,
    director_profile_id: str,
    level_threshold: int,
    current_mastery: ProfileMastery,
) -> int:
    """How many of this director's masteries already reached ``level_threshold``?

    ``current_mastery`` is in the same session and may not yet be flushed; we
    count it once if its in-memory state qualifies, then add the other rows
    that match independently. This avoids both double-counting and a missed
    count for the row we are about to commit.
    """
    rows = session.exec(
        select(ProfileMastery.profile_id, ProfileMastery.campaign_score).where(
            ProfileMastery.director_profile_id == director_profile_id,
            ProfileMastery.profile_id != current_mastery.profile_id,
        )
    ).all()
    qualifying = sum(
        1 for _, score in rows if calculate_mastery_level(int(score or 0)) >= level_threshold
    )
    if calculate_mastery_level(int(current_mastery.campaign_score or 0)) >= level_threshold:
        qualifying += 1
    return qualifying


def _build_finalize_summary(
    session: Session,
    *,
    log: ScenarioCampaignLog,
    director_profile: DirectorProfile,
    already_finalized: bool,
    newly_unlocked_badges: list[DirectorBadgeUnlock],
    already_counted_daily_challenge: bool = False,
) -> dict[str, Any]:
    mastery = session.exec(
        select(ProfileMastery).where(
            ProfileMastery.director_profile_id == director_profile.id,
            ProfileMastery.profile_id == log.profile_id,
        )
    ).first()
    if mastery is None:
        raise CampaignNotFoundError("Profile mastery not found")

    badges = _list_badge_unlocks(session, director_profile.id)
    last_daily_log = _get_last_daily_challenge_log(session, director_profile.id)
    summary_bet_count = int(log.betting_hit is not None)
    weekly_bonus_delta = int(getattr(log, "weekly_bonus_delta", 0) or 0)
    score_breakdown = build_campaign_score_breakdown(
        archive_grade=log.archive_grade,
        profile_resonance=log.profile_resonance,
        completed_daily_challenge=log.completed_daily_challenge,
        bet_count=summary_bet_count,
        betting_hit=log.betting_hit,
        objective_completed_count=log.objective_completed_count,
        objective_total_count=log.objective_total_count,
        commitment_outcome=log.commitment_outcome,
        already_counted_daily_challenge=already_counted_daily_challenge,
        weekly_bonus_delta=weekly_bonus_delta,
    )

    return {
        "scenario_id": log.scenario_id,
        "already_finalized": already_finalized,
        "campaign_score_delta": log.campaign_score_delta,
        "score_breakdown": score_breakdown,
        "profile": _build_profile_summary(director_profile, last_daily_log=last_daily_log),
        "mastery": _build_mastery_summary(mastery),
        "badges": [_build_badge_summary(badge) for badge in badges],
        "newly_unlocked_badges": [
            _build_badge_summary(badge)
            for badge in newly_unlocked_badges
        ],
        "campaign_context_source": log.campaign_context_source,
        "challenge_id": log.challenge_id,
        "challenge_local_date": log.challenge_local_date,
        "week_key": log.week_key,
        "weekly_track_id": log.weekly_track_id,
        "difficulty_tier": log.difficulty_tier,
        "weekly_bonus_delta": weekly_bonus_delta,
        "streak_after": log.streak_after,
        "already_counted_daily_challenge": already_counted_daily_challenge,
    }


def _retry_finalize_after_dedupe_race(
    session: Session,
    *,
    user_id: str,
    user_name: str,
    scenario_language: str,
    scenario_id: str,
    profile_id: str,
    normalized_grade: str,
    normalized_resonance: str,
    effective_betting_hit: bool | None,
    effective_bet_count: int,
    most_used_card: str | None,
    normalized_completed_count: int,
    normalized_total_count: int,
    normalized_commitment_outcome: str | None,
    finalize_context: dict[str, Any],
) -> dict[str, Any]:
    """Retry the finalize insert once after a daily-dedupe-index race.

    A concurrent finalize call for the same
    ``(director_profile_id, challenge_local_date, challenge_id)`` triple raced
    us to the partial unique index. The recovery contract is:

    * the daily-challenge point does NOT stack for this run (race winner
      already claimed it),
    * the streak does NOT advance,
    * no weekly-track bonus is awarded for this run,
    * the inserted ledger row carries ``challenge_id=NULL`` (so the partial
      unique index is no longer a barrier) and
      ``campaign_context_source="scenario_context_dedup"`` so the loss is
      auditable.
    """
    director_profile = _get_or_create_director_profile(
        session,
        user_id=user_id,
        user_name=user_name.strip() or get_anonymous_director_name(scenario_language),
    )
    mastery = _get_or_create_profile_mastery(
        session,
        director_profile_id=director_profile.id,
        profile_id=profile_id,
    )

    score_delta = calculate_campaign_score_delta(
        archive_grade=normalized_grade,
        profile_resonance=normalized_resonance,
        completed_daily_challenge=False,
        bet_count=effective_bet_count,
        betting_hit=effective_betting_hit,
        objective_completed_count=normalized_completed_count,
        objective_total_count=normalized_total_count,
        commitment_outcome=normalized_commitment_outcome,
    )

    director_profile.total_runs += 1
    director_profile.total_bets += max(
        effective_bet_count,
        int(_has_resolved_bet(effective_bet_count, effective_betting_hit)),
    )
    director_profile.hit_bets += int(effective_betting_hit is True)
    director_profile.highest_archive_grade = _better_archive_grade(
        director_profile.highest_archive_grade,
        normalized_grade,
    )
    director_profile.updated_at = _now()

    mastery.runs += 1
    mastery.signature_hits += int(normalized_resonance == "signature")
    mastery.aligned_hits += int(normalized_resonance == "aligned")
    mastery.campaign_score += score_delta
    mastery.level = calculate_mastery_level(mastery.campaign_score)
    mastery.best_archive_grade = _better_archive_grade(
        mastery.best_archive_grade,
        normalized_grade,
    )
    mastery.updated_at = _now()

    log = ScenarioCampaignLog(
        scenario_id=scenario_id,
        director_profile_id=director_profile.id,
        profile_id=mastery.profile_id,
        archive_grade=normalized_grade,
        profile_resonance=normalized_resonance,
        betting_hit=effective_betting_hit,
        most_used_card=(most_used_card or "").strip() or None,
        completed_daily_challenge=False,
        objective_completed_count=normalized_completed_count,
        objective_total_count=normalized_total_count,
        commitment_outcome=normalized_commitment_outcome,
        campaign_score_delta=score_delta,
        # challenge_id intentionally nulled to bypass the partial unique index.
        challenge_id=None,
        challenge_local_date=finalize_context.get("challenge_local_date"),
        week_key=finalize_context.get("week_key"),
        weekly_track_id=finalize_context.get("weekly_track_id"),
        difficulty_tier=finalize_context.get("difficulty_tier"),
        weekly_bonus_delta=0,
        streak_after=None,
        campaign_context_source="scenario_context_dedup",
    )
    session.add(log)
    # Phase 3: registry-driven unlock sweep. The retry path never restores the
    # daily streak, so we pass streak_after=None — daily/streak-based badges
    # cannot fire on a deduped retry by design.
    newly_unlocked_badges = _unlock_badges(
        session,
        director_profile=director_profile,
        mastery=mastery,
        log=log,
        streak_after=None,
    )
    session.flush()
    _refresh_favorite_card(session, mastery)
    session.commit()
    session.refresh(director_profile)
    session.refresh(mastery)
    session.refresh(log)
    return _build_finalize_summary(
        session,
        log=log,
        director_profile=director_profile,
        already_finalized=False,
        newly_unlocked_badges=newly_unlocked_badges,
        already_counted_daily_challenge=True,
    )


def finalize_scenario_campaign(
    scenario_id: str,
    *,
    user_id: str,
    user_name: str,
    profile_id: str,
    archive_grade: str,
    profile_resonance: str,
    betting_hit: bool | None = None,
    bet_count: int = 0,
    most_used_card: str | None = None,
    completed_daily_challenge: bool = False,
    objective_completed_count: int = 0,
    objective_total_count: int = 0,
    commitment_outcome: str | None = None,
) -> dict[str, Any]:
    """Finalize campaign progression for one completed scenario."""
    if not user_id.strip():
        raise CampaignError("user_id cannot be empty")
    if not profile_id.strip():
        raise CampaignError("profile_id cannot be empty")
    if bet_count < 0:
        raise CampaignError("bet_count cannot be negative")

    normalized_grade = _normalize_archive_grade(archive_grade)
    normalized_resonance = _normalize_profile_resonance(profile_resonance)
    normalized_completed_count, normalized_total_count = _normalize_objective_counts(
        objective_completed_count,
        objective_total_count,
    )
    normalized_commitment_outcome = _normalize_commitment_outcome(commitment_outcome)

    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        if scenario.status != ScenarioStatus.DONE:
            raise CampaignStateError("Scenario not yet completed")
        scenario_language = (
            scenario.parsed_context.get("_language")
            if isinstance(scenario.parsed_context, dict)
            else None
        ) or detect_language(scenario.question)
        # Campaign Phase 1: collapse scenario.parsed_context.campaign_context with
        # the legacy ``completed_daily_challenge`` boolean into a single context
        # record so daily-dedupe / streak / weekly bonus can share inputs.
        finalize_context = _resolve_finalize_campaign_context(
            scenario,
            legacy_completed_daily_challenge=completed_daily_challenge,
        )
        context_profile_id = str(finalize_context.get("profile_id") or "").strip()
        if context_profile_id and context_profile_id != profile_id.strip():
            raise CampaignError("profile_id must match scenario campaign_context.profile_id")

        authority_inputs = _resolve_finalize_authority_inputs(
            session,
            scenario=scenario,
            profile_id=profile_id.strip(),
            finalize_context=finalize_context,
            archive_grade=normalized_grade,
            profile_resonance=normalized_resonance,
            betting_hit=betting_hit,
            bet_count=bet_count,
            most_used_card=most_used_card,
            objective_completed_count=normalized_completed_count,
            objective_total_count=normalized_total_count,
            commitment_outcome=normalized_commitment_outcome,
        )
        normalized_grade = authority_inputs["archive_grade"]
        normalized_resonance = authority_inputs["profile_resonance"]
        effective_bet_count = authority_inputs["bet_count"]
        effective_betting_hit = authority_inputs["betting_hit"]
        effective_most_used_card = authority_inputs["most_used_card"]
        normalized_completed_count = authority_inputs["objective_completed_count"]
        normalized_total_count = authority_inputs["objective_total_count"]
        normalized_commitment_outcome = authority_inputs["commitment_outcome"]

        intent_completed_daily = bool(
            finalize_context.get("completed_daily_challenge_intent")
        )
        # Serialize potential weekly bonus awards before the write transaction
        # begins. Acquiring the SQLite-backed runtime lock inside an already
        # active Session transaction can deadlock against SQLite's coarse write
        # lock, so release the read transaction first when a weekly award may
        # be minted.
        if (
            intent_completed_daily
            and finalize_context.get("week_key")
            and finalize_context.get("weekly_track_id")
        ):
            session.rollback()
        weekly_bonus_lock_lease = _acquire_weekly_bonus_cap_lock(
            lock_subject_id=user_id.strip(),
            week_key=finalize_context.get("week_key"),
            weekly_track_id=finalize_context.get("weekly_track_id"),
            effective_completed_daily=intent_completed_daily,
        )

        existing_log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()
        if existing_log is not None:
            existing_profile = session.get(DirectorProfile, existing_log.director_profile_id)
            if existing_profile is None:
                release_runtime_lock(weekly_bonus_lock_lease)
                raise CampaignNotFoundError("Director profile not found")
            if existing_profile.user_id != user_id:
                release_runtime_lock(weekly_bonus_lock_lease)
                raise CampaignConflictError(
                    "Scenario already finalized for a different director profile"
                )
            # H-1: detect drift between the persisted ledger snapshot and the
            # campaign_context currently attached to the scenario. We never
            # mutate the cached log (it is the source of truth for replay), but
            # surface a warning so observability can flag stale or rewritten
            # scenario.parsed_context.
            _log_campaign_context_drift(
                scenario_id=scenario_id,
                existing_log=existing_log,
                finalize_context=finalize_context,
            )
            result = _build_finalize_summary(
                session,
                log=existing_log,
                director_profile=existing_profile,
                already_finalized=True,
                newly_unlocked_badges=[],
            )
            release_runtime_lock(weekly_bonus_lock_lease)
            return result

        director_profile = _get_or_create_director_profile(
            session,
            user_id=user_id.strip(),
            user_name=user_name.strip() or get_anonymous_director_name(scenario_language),
        )
        mastery = _get_or_create_profile_mastery(
            session,
            director_profile_id=director_profile.id,
            profile_id=profile_id.strip(),
        )

        # Daily dedupe: if the same (director, day, challenge) has already
        # finalized today, the daily point does not stack and the streak does
        # not advance. For context-driven finalizes the durable
        # ``(director_profile_id, challenge_local_date, challenge_id)`` triple
        # is the authoritative key; for legacy callers (no campaign_context,
        # ``completed_daily_challenge=True``) we restore the pre-Phase-1
        # behavior by querying ``completed_daily_challenge=True`` rows in
        # today's UTC window so callers cannot spam daily points.
        existing_daily_log = _find_existing_daily_log(
            session,
            director_profile_id=director_profile.id,
            challenge_id=finalize_context.get("challenge_id"),
            challenge_local_date=finalize_context.get("challenge_local_date"),
        )
        already_counted_daily = bool(existing_daily_log) and intent_completed_daily

        # H-2: legacy_bool path — only checked when no campaign_context is
        # present, so the durable triple cannot be used.
        if (
            not already_counted_daily
            and intent_completed_daily
            and finalize_context.get("campaign_context_source") == "legacy_bool"
        ):
            existing_legacy_daily = _find_existing_legacy_daily_log_today(
                session,
                director_profile_id=director_profile.id,
            )
            if existing_legacy_daily is not None:
                already_counted_daily = True

        effective_completed_daily = intent_completed_daily and not already_counted_daily

        weekly_bonus_delta = _compute_weekly_bonus_delta(
            session,
            director_profile_id=director_profile.id,
            week_key=finalize_context.get("week_key"),
            weekly_track_id=finalize_context.get("weekly_track_id"),
            effective_completed_daily=effective_completed_daily,
        )

        base_score_delta = calculate_campaign_score_delta(
            archive_grade=normalized_grade,
            profile_resonance=normalized_resonance,
            completed_daily_challenge=effective_completed_daily,
            bet_count=effective_bet_count,
            betting_hit=effective_betting_hit,
            objective_completed_count=normalized_completed_count,
            objective_total_count=normalized_total_count,
            commitment_outcome=normalized_commitment_outcome,
        )
        score_delta = base_score_delta + weekly_bonus_delta

        director_profile.total_runs += 1
        director_profile.completed_challenges += int(effective_completed_daily)
        director_profile.total_bets += max(
            effective_bet_count,
            int(_has_resolved_bet(effective_bet_count, effective_betting_hit)),
        )
        director_profile.hit_bets += int(effective_betting_hit is True)
        director_profile.highest_archive_grade = _better_archive_grade(
            director_profile.highest_archive_grade,
            normalized_grade,
        )
        director_profile.updated_at = _now()

        mastery.runs += 1
        mastery.challenge_completions += int(effective_completed_daily)
        mastery.signature_hits += int(normalized_resonance == "signature")
        mastery.aligned_hits += int(normalized_resonance == "aligned")
        mastery.campaign_score += score_delta
        mastery.level = calculate_mastery_level(mastery.campaign_score)
        mastery.best_archive_grade = _better_archive_grade(
            mastery.best_archive_grade,
            normalized_grade,
        )
        mastery.updated_at = _now()

        # Streak: count consecutive completed days ending on the target day.
        # When dedupe trips, the streak does NOT advance (we re-count without
        # adding today's row, which is already present in completed dates).
        streak_after: int | None = None
        if effective_completed_daily and finalize_context.get("challenge_local_date"):
            streak_after = _compute_streak_after(
                session,
                director_profile_id=director_profile.id,
                challenge_local_date=finalize_context.get("challenge_local_date"),
            )

        # When daily-dedupe trips, drop ``challenge_id`` on the inserted row so
        # the partial unique index ``ix_campaign_log_daily_dedupe`` remains
        # honoured (the index keys ``(director_profile_id, challenge_local_date,
        # challenge_id)``; a NULL challenge_id is exempt). The dedupe state is
        # still recoverable via ``campaign_context_source='scenario_context_dedup'``
        # and ``challenge_local_date``/``week_key``/``weekly_track_id`` continue
        # to support weekly aggregates.
        ledger_challenge_id = finalize_context.get("challenge_id")
        ledger_source = finalize_context.get("campaign_context_source")
        if already_counted_daily:
            ledger_challenge_id = None
            ledger_source = "scenario_context_dedup"

        log = ScenarioCampaignLog(
            scenario_id=scenario_id,
            director_profile_id=director_profile.id,
            profile_id=mastery.profile_id,
            archive_grade=normalized_grade,
            profile_resonance=normalized_resonance,
            betting_hit=effective_betting_hit,
            most_used_card=effective_most_used_card,
            completed_daily_challenge=effective_completed_daily,
            objective_completed_count=normalized_completed_count,
            objective_total_count=normalized_total_count,
            commitment_outcome=normalized_commitment_outcome,
            campaign_score_delta=score_delta,
            challenge_id=ledger_challenge_id,
            challenge_local_date=finalize_context.get("challenge_local_date"),
            week_key=finalize_context.get("week_key"),
            weekly_track_id=finalize_context.get("weekly_track_id"),
            difficulty_tier=finalize_context.get("difficulty_tier"),
            weekly_bonus_delta=weekly_bonus_delta,
            streak_after=streak_after,
            campaign_context_source=ledger_source,
        )
        session.add(log)

        # Phase 3: registry-driven unlock sweep. Streak, mastery level, and
        # cross-profile aggregates are derived inside the helper from the
        # in-memory session state so the badge context stays consistent with
        # the row we are about to flush.
        newly_unlocked_badges = _unlock_badges(
            session,
            director_profile=director_profile,
            mastery=mastery,
            log=log,
            streak_after=streak_after,
        )

        try:
            session.flush()
            _refresh_favorite_card(session, mastery)
            session.commit()
        except IntegrityError:
            session.rollback()
            release_runtime_lock(weekly_bonus_lock_lease)
            existing_log = session.exec(
                select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
            ).first()
            if existing_log is None:
                # C-3 / M-4: the integrity violation was not on the
                # ``uq_scenario_campaign_log_scenario_id`` constraint — the
                # likeliest culprit is the partial unique daily-dedupe index
                # ``ix_campaign_log_daily_dedupe``, fired by a concurrent
                # finalize racing on the same
                # ``(director_profile_id, challenge_local_date, challenge_id)``.
                # Recover by retrying exactly once with ``challenge_id=None``
                # and ``campaign_context_source="scenario_context_dedup"``.
                if (
                    finalize_context.get("challenge_id") is not None
                    and finalize_context.get("challenge_local_date") is not None
                ):
                    logger.warning(
                        "campaign finalize hit daily dedupe race; retrying with "
                        "nulled challenge_id and dedup source",
                        extra={
                            "scenario_id": scenario_id,
                            "challenge_id": finalize_context.get("challenge_id"),
                            "challenge_local_date": finalize_context.get(
                                "challenge_local_date"
                            ),
                        },
                    )
                    return _retry_finalize_after_dedupe_race(
                        session,
                        user_id=user_id.strip(),
                        user_name=user_name,
                        scenario_language=scenario_language,
                        scenario_id=scenario_id,
                        profile_id=profile_id.strip(),
                        normalized_grade=normalized_grade,
                        normalized_resonance=normalized_resonance,
                        effective_betting_hit=effective_betting_hit,
                        effective_bet_count=effective_bet_count,
                        most_used_card=effective_most_used_card,
                        normalized_completed_count=normalized_completed_count,
                        normalized_total_count=normalized_total_count,
                        normalized_commitment_outcome=normalized_commitment_outcome,
                        finalize_context=finalize_context,
                    )
                raise

            existing_profile = session.get(DirectorProfile, existing_log.director_profile_id)
            if existing_profile is None:
                raise CampaignNotFoundError("Director profile not found")
            if existing_profile.user_id != user_id:
                raise CampaignConflictError(
                    "Scenario already finalized for a different director profile"
                )
            return _build_finalize_summary(
                session,
                log=existing_log,
                director_profile=existing_profile,
                already_finalized=True,
                newly_unlocked_badges=[],
            )
        except Exception:
            session.rollback()
            release_runtime_lock(weekly_bonus_lock_lease)
            raise

        session.refresh(director_profile)
        session.refresh(mastery)
        session.refresh(log)
        result = _build_finalize_summary(
            session,
            log=log,
            director_profile=director_profile,
            already_finalized=False,
            newly_unlocked_badges=newly_unlocked_badges,
            already_counted_daily_challenge=already_counted_daily,
        )
        release_runtime_lock(weekly_bonus_lock_lease)
        return result


def get_campaign_profile_summary(user_id: str) -> dict[str, Any] | None:
    """Return the director profile summary for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return _build_empty_profile_summary(user_id)
        last_daily_log = _get_last_daily_challenge_log(session, profile.id)
        return _build_profile_summary(profile, last_daily_log=last_daily_log)


def get_scenario_director_state(scenario_id: str) -> dict[str, Any]:
    """Return the persisted per-scenario director state or a safe default."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_director_state(scenario.director_state_json)


def save_scenario_director_state(
    scenario_id: str,
    director_state: dict[str, Any],
) -> dict[str, Any]:
    """Persist the authoritative per-scenario director state."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")

        current_state = normalize_scenario_director_state(scenario.director_state_json)
        expected_revision = _normalize_state_revision(director_state)
        if expected_revision != current_state["revision"]:
            raise CampaignConflictError("Director state revision mismatch")

        next_state = normalize_scenario_director_state(
            _with_state_revision(director_state, current_state["revision"] + 1)
        )
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .where(
                func.coalesce(
                    func.json_extract(Scenario.director_state_json, "$.revision"),
                    0,
                )
                == current_state["revision"]
            )
            .values(director_state_json=next_state)
        )
        if result.rowcount != 1:
            session.rollback()
            raise CampaignConflictError("Director state revision mismatch")
        session.commit()
        session.expire_all()
        persisted = session.get(Scenario, scenario_id)
        if persisted is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_director_state(persisted.director_state_json)


def get_scenario_gameplay_state(scenario_id: str) -> dict[str, Any]:
    """Return the persisted per-scenario gameplay state or a safe default."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_gameplay_state(scenario.gameplay_state_json)


def save_scenario_gameplay_state(
    scenario_id: str,
    gameplay_state: dict[str, Any],
) -> dict[str, Any]:
    """Persist the authoritative per-scenario gameplay state."""
    engine = get_engine()
    with Session(engine) as session:
        scenario = session.get(Scenario, scenario_id)
        if scenario is None:
            raise CampaignNotFoundError("Scenario not found")

        current_state = normalize_scenario_gameplay_state(scenario.gameplay_state_json)
        expected_revision = _normalize_state_revision(gameplay_state)
        if expected_revision != current_state["revision"]:
            raise CampaignConflictError("Gameplay state revision mismatch")

        scenario_branch_ids: set[str] = set(
            session.exec(
                select(Branch.id).where(Branch.scenario_id == scenario_id)
            ).all()
        )
        next_state = normalize_scenario_gameplay_state(
            _with_state_revision(gameplay_state, current_state["revision"] + 1),
            strict=True,
            valid_branch_ids=scenario_branch_ids,
        )
        result = session.exec(
            update(Scenario)
            .where(Scenario.id == scenario_id)
            .where(
                func.coalesce(
                    func.json_extract(Scenario.gameplay_state_json, "$.revision"),
                    0,
                )
                == current_state["revision"]
            )
            .values(gameplay_state_json=next_state)
        )
        if result.rowcount != 1:
            session.rollback()
            raise CampaignConflictError("Gameplay state revision mismatch")
        session.commit()
        session.expire_all()
        persisted = session.get(Scenario, scenario_id)
        if persisted is None:
            raise CampaignNotFoundError("Scenario not found")
        return normalize_scenario_gameplay_state(persisted.gameplay_state_json)


def get_scenario_campaign_summary(scenario_id: str) -> dict[str, Any]:
    """Return the finalized campaign summary for one scenario."""
    engine = get_engine()
    with Session(engine) as session:
        log = session.exec(
            select(ScenarioCampaignLog).where(ScenarioCampaignLog.scenario_id == scenario_id)
        ).first()
        if log is None:
            raise CampaignNotFoundError("Scenario campaign summary not found")
        return _build_scenario_campaign_summary(log)


def list_campaign_mastery_summaries(user_id: str) -> list[dict[str, Any]] | None:
    """Return all mastery rows for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return []

        masteries = list(session.exec(
            select(ProfileMastery)
            .where(ProfileMastery.director_profile_id == profile.id)
            .order_by(ProfileMastery.campaign_score.desc(), ProfileMastery.updated_at.desc())
        ).all())
        return [_build_mastery_summary(mastery) for mastery in masteries]


def list_campaign_badge_summaries(user_id: str) -> list[dict[str, Any]] | None:
    """Return all badge unlocks for a user."""
    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return []
        badges = _list_badge_unlocks(session, profile.id)
        return [_build_badge_summary(badge) for badge in badges]


def get_daily_challenge_summary(
    user_id: str,
    *,
    profile_id: str,
    local_date: str,
    timezone_offset_minutes: int,
) -> dict[str, Any] | None:
    """Return whether the target daily challenge was completed on the caller's local day."""
    normalized_profile_id = profile_id.strip()
    if not normalized_profile_id:
        raise CampaignError("profile_id cannot be empty")

    target_date = _parse_local_date(local_date)
    local_timezone = _build_local_timezone(timezone_offset_minutes)
    day_start_utc, day_end_utc = _build_local_date_utc_window(
        target_date,
        target_date,
        local_timezone=local_timezone,
    )

    # Phase 2a: ``next_refresh_at`` is server-clock relative and unaffected by
    # the caller's timezone — the durable challenge_local_date already lives
    # in server-UTC space (see ``create_scenario``).
    from app.services.daily_challenges import _next_utc_midnight_iso

    next_refresh_at = _next_utc_midnight_iso()

    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        if profile is None:
            return _build_daily_challenge_summary(
                user_id=user_id,
                profile_id=normalized_profile_id,
                local_date=target_date.isoformat(),
                timezone_offset_minutes=timezone_offset_minutes,
                completed=False,
                log=None,
                current_streak=0,
                recent_daily_completion_days=0,
                next_refresh_at=next_refresh_at,
            )

        # Campaign Phase 1: prefer the durable ``challenge_local_date`` column
        # over the legacy ``created_at`` window — fixed-date challenge identity
        # decouples completion from finalize wall-clock and avoids ambiguity
        # when a daily run spans the local-midnight boundary. Legacy rows
        # without durable date fall back to the original UTC window query.
        target_iso = target_date.isoformat()
        durable_log = session.exec(
            select(ScenarioCampaignLog)
            .where(
                ScenarioCampaignLog.director_profile_id == profile.id,
                ScenarioCampaignLog.profile_id == normalized_profile_id,
                ScenarioCampaignLog.completed_daily_challenge.is_(True),
                ScenarioCampaignLog.challenge_local_date == target_iso,
            )
            .order_by(ScenarioCampaignLog.created_at.desc())
        ).first()

        matching_log: ScenarioCampaignLog | None = durable_log
        if matching_log is None:
            legacy_logs = list(
                session.exec(
                    select(ScenarioCampaignLog)
                    .where(
                        ScenarioCampaignLog.director_profile_id == profile.id,
                        ScenarioCampaignLog.profile_id == normalized_profile_id,
                        ScenarioCampaignLog.completed_daily_challenge.is_(True),
                        ScenarioCampaignLog.challenge_local_date.is_(None),
                        ScenarioCampaignLog.created_at >= day_start_utc,
                        ScenarioCampaignLog.created_at < day_end_utc,
                    )
                    .order_by(ScenarioCampaignLog.created_at.desc())
                ).all()
            )
            matching_log = next(
                (
                    log
                    for log in legacy_logs
                    if _normalize_utc_datetime(log.created_at).astimezone(local_timezone).date()
                    == target_date
                ),
                None,
            )

        current_streak = _compute_streak_after(
            session,
            director_profile_id=profile.id,
            challenge_local_date=target_iso,
            include_target_as_completed=False,
        ) or 0
        recent_daily_completion_days = _count_recent_daily_completion_days(
            session,
            director_profile_id=profile.id,
            anchor_date=target_date,
            window_days=30,
        )

        return _build_daily_challenge_summary(
            user_id=profile.user_id,
            profile_id=normalized_profile_id,
            local_date=target_date.isoformat(),
            timezone_offset_minutes=timezone_offset_minutes,
            completed=matching_log is not None,
            log=matching_log,
            current_streak=int(current_streak),
            recent_daily_completion_days=recent_daily_completion_days,
            next_refresh_at=next_refresh_at,
        )


def get_weekly_campaign_summary(
    user_id: str,
    *,
    local_date: str,
    timezone_offset_minutes: int,
) -> dict[str, Any]:
    """Return a lightweight local-week progression summary without schema changes."""
    target_date = _parse_local_date(local_date)
    local_timezone = _build_local_timezone(timezone_offset_minutes)
    week_start = target_date - timedelta(days=target_date.weekday())
    week_end = week_start + timedelta(days=6)
    week_start_utc, week_end_utc = _build_local_date_utc_window(
        week_start,
        week_end,
        local_timezone=local_timezone,
    )

    # Phase 2b: ``weekly_track`` rotation is shared with the rotation endpoint.
    from app.services.daily_challenges import get_current_weekly_track

    active_track = get_current_weekly_track(local_date)
    active_track_id = active_track["id"]

    engine = get_engine()
    with Session(engine) as session:
        profile = _get_director_profile(session, user_id)
        # Phase 2b: derived week_key needed even for the empty-profile path.
        iso_year, iso_week, _ = target_date.isocalendar()
        derived_week_key = f"{iso_year:04d}-W{iso_week:02d}"
        if profile is None:
            leaderboard_preview, _ = _compute_weekly_leaderboard(
                session,
                week_key=derived_week_key,
                weekly_track_id=active_track_id,
                self_director_profile_id=None,
                limit=10,
            )
            return _build_weekly_campaign_summary(
                user_id=user_id,
                week_start=week_start,
                week_end=week_end,
                timezone_offset_minutes=timezone_offset_minutes,
                total_runs=0,
                completed_daily_challenges=0,
                hit_bets=0,
                campaign_score_delta=0,
                best_archive_grade=None,
                top_profile_id=None,
                profile_runs={},
                week_key=derived_week_key,
                weekly_track_id=active_track_id,
                rank=None,
                leaderboard_entries=leaderboard_preview,
            )

        durable_logs = list(
            session.exec(
                select(ScenarioCampaignLog)
                .where(
                    ScenarioCampaignLog.director_profile_id == profile.id,
                    ScenarioCampaignLog.week_key == derived_week_key,
                )
                .order_by(ScenarioCampaignLog.created_at.desc())
            ).all()
        )
        legacy_window_logs = list(
            session.exec(
                select(ScenarioCampaignLog)
                .where(
                    ScenarioCampaignLog.director_profile_id == profile.id,
                    ScenarioCampaignLog.week_key.is_(None),
                    ScenarioCampaignLog.created_at >= week_start_utc,
                    ScenarioCampaignLog.created_at < week_end_utc,
                )
                .order_by(ScenarioCampaignLog.created_at.desc())
            ).all()
        )

        matching_logs: list[ScenarioCampaignLog] = list(durable_logs) + [
            log
            for log in legacy_window_logs
            if week_start
            <= _normalize_utc_datetime(log.created_at).astimezone(local_timezone).date()
            <= week_end
        ]

        if not matching_logs:
            empty_preview, empty_rank = _compute_weekly_leaderboard(
                session,
                week_key=derived_week_key,
                weekly_track_id=active_track_id,
                self_director_profile_id=profile.id,
                limit=10,
            )
            return _build_weekly_campaign_summary(
                user_id=profile.user_id,
                week_start=week_start,
                week_end=week_end,
                timezone_offset_minutes=timezone_offset_minutes,
                total_runs=0,
                completed_daily_challenges=0,
                hit_bets=0,
                campaign_score_delta=0,
                best_archive_grade=None,
                top_profile_id=None,
                profile_runs={},
                weekly_bonus_total=0,
                week_key=derived_week_key,
                weekly_track_runs={},
                weekly_track_id=active_track_id,
                rank=empty_rank,
                leaderboard_entries=empty_preview,
            )

        profile_counter = Counter(log.profile_id for log in matching_logs)
        top_profile_id = sorted(
            profile_counter.items(),
            key=lambda item: (-item[1], item[0]),
        )[0][0]

        best_archive_grade = None
        for log in matching_logs:
            best_archive_grade = _better_archive_grade(best_archive_grade, log.archive_grade)

        track_runs: Counter[str] = Counter(
            log.weekly_track_id
            for log in matching_logs
            if log.weekly_track_id
        )
        weekly_bonus_total = sum(
            int(getattr(log, "weekly_bonus_delta", 0) or 0) for log in matching_logs
        )

        leaderboard_preview, self_rank = _compute_weekly_leaderboard(
            session,
            week_key=derived_week_key,
            weekly_track_id=active_track_id,
            self_director_profile_id=profile.id,
            limit=10,
        )

        return _build_weekly_campaign_summary(
            user_id=profile.user_id,
            week_start=week_start,
            week_end=week_end,
            timezone_offset_minutes=timezone_offset_minutes,
            total_runs=len(matching_logs),
            completed_daily_challenges=sum(1 for log in matching_logs if log.completed_daily_challenge),  # noqa: E501
            hit_bets=sum(1 for log in matching_logs if log.betting_hit is True),
            campaign_score_delta=sum(log.campaign_score_delta for log in matching_logs),
            best_archive_grade=best_archive_grade,
            top_profile_id=top_profile_id,
            profile_runs=dict(sorted(profile_counter.items())),
            weekly_bonus_total=weekly_bonus_total,
            week_key=derived_week_key,
            weekly_track_runs=dict(sorted(track_runs.items())),
            weekly_track_id=active_track_id,
            rank=self_rank,
            leaderboard_entries=leaderboard_preview,
        )
