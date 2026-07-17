"""Deterministic, replayable social-world state derived from durable actions."""

from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from sqlmodel import Session, select

from app.log_sanitize import _scrub_sensitive_text
from app.models import Agent
from app.models.simulation_action import (
    SimulationAction,
    SimulationActionStatus,
    SimulationActionType,
)
from app.services.branch_lineage import resolve_branch_lineage
from app.services.simulation_actions import REACTION_KINDS

_MAX_RECENT_SEARCHES = 5
_MAX_TREND_RECEIPTS = 3
_MAX_FEED_POSTS = 8
_MAX_SEARCH_RESULTS = 5
_MAX_TREND_RESULTS = 5
_TREND_RECENCY_WINDOW = 64
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


@dataclass(frozen=True)
class SocialComment:
    action_id: str
    post_id: str
    author_id: str
    content: str
    sequence: int


@dataclass(frozen=True)
class SocialReaction:
    action_id: str
    post_id: str
    author_id: str
    kind: str
    sequence: int


@dataclass(frozen=True)
class SocialPost:
    action_id: str
    author_id: str
    content: str
    sequence: int
    round_number: int
    author_name_override: str | None
    published_at: str | None
    credibility_hint: str | None
    tags: tuple[str, ...]
    comments: tuple[SocialComment, ...]
    reactions: tuple[SocialReaction, ...]
    activity_events: tuple[tuple[int, str], ...]


@dataclass(frozen=True)
class SocialSearchReceipt:
    query: str
    result_post_ids: tuple[str, ...]
    sequence: int


@dataclass(frozen=True)
class SocialTrendItem:
    post_id: str
    activity_count: int
    score: int


@dataclass(frozen=True)
class SocialTrendReceipt:
    items: tuple[SocialTrendItem, ...]
    sequence: int


@dataclass(frozen=True)
class SocialRefreshReceipt:
    post_ids: tuple[str, ...]
    new_count: int
    sequence: int


@dataclass(frozen=True)
class SocialWorldState:
    scenario_id: str
    branch_id: str
    cutoff_round: int
    agent_names: dict[str, str]
    posts: tuple[SocialPost, ...]
    following: dict[str, frozenset[str]]
    muted: dict[str, frozenset[str]]
    recent_searches: dict[str, tuple[SocialSearchReceipt, ...]]
    trend_receipts: dict[str, tuple[SocialTrendReceipt, ...]]
    refresh_receipts: dict[str, tuple[SocialRefreshReceipt, ...]]
    last_seen: dict[str, int]
    trend_counts: dict[str, int]
    diagnostics: dict[str, int]


@dataclass
class _PostBuilder:
    action_id: str
    author_id: str
    content: str
    sequence: int
    round_number: int
    author_name_override: str | None
    published_at: str | None
    credibility_hint: str | None
    tags: tuple[str, ...]
    comments: list[SocialComment]
    reactions: dict[str, SocialReaction]
    activity_events: list[tuple[int, str]]


def _enum_value(value: object) -> str:
    return str(getattr(value, "value", value))


def _strict_payload(row: SimulationAction) -> dict[str, Any] | None:
    try:
        value = json.loads(row.payload_json or "{}")
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _resolves_to_post(
    row: SimulationAction,
    posts: dict[str, _PostBuilder],
    action_to_post: dict[str, str],
) -> str | None:
    target_type = str(row.target_type or "").lower()
    target_id = str(row.target_id or "")
    candidates = [
        target_id if target_type in {"action", "post"} else "",
        str(row.parent_action_id or ""),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if candidate in posts:
            return candidate
        post_id = action_to_post.get(candidate)
        if post_id in posts:
            return post_id
    return None


def _visible_posts(
    posts: dict[str, _PostBuilder],
    *,
    agent_id: str,
    following: dict[str, set[str]],
    muted: dict[str, set[str]],
) -> list[_PostBuilder]:
    hidden_authors = muted.get(agent_id, set())
    followed_authors = following.get(agent_id, set())
    visible = [post for post in posts.values() if post.author_id not in hidden_authors]

    def latest_visible_activity(post: _PostBuilder) -> int:
        return max(
            (
                sequence
                for sequence, actor_id in post.activity_events
                if actor_id not in hidden_authors
            ),
            default=post.sequence,
        )

    visible.sort(
        key=lambda post: (
            post.author_id in followed_authors,
            latest_visible_activity(post),
            post.sequence,
            post.action_id,
        ),
        reverse=True,
    )
    return visible


def _search_posts(
    posts: dict[str, _PostBuilder],
    *,
    query: str,
    agent_id: str,
    agent_names: dict[str, str],
    following: dict[str, set[str]],
    muted: dict[str, set[str]],
) -> tuple[str, ...]:
    needle = query.casefold().strip()
    if not needle:
        return ()
    matches: list[str] = []
    hidden_authors = muted.get(agent_id, set())
    for post in _visible_posts(
        posts,
        agent_id=agent_id,
        following=following,
        muted=muted,
    ):
        haystack = "\n".join(
            [
                post.content,
                post.author_name_override or agent_names.get(post.author_id, ""),
                " ".join(post.tags),
                *(
                    comment.content
                    for comment in post.comments
                    if comment.author_id not in hidden_authors
                ),
            ]
        ).casefold()
        if needle in haystack:
            matches.append(post.action_id)
        if len(matches) >= _MAX_SEARCH_RESULTS:
            break
    return tuple(matches)


def _trend_snapshot(
    posts: dict[str, _PostBuilder],
    *,
    agent_id: str,
    current_sequence: int,
    following: dict[str, set[str]],
    muted: dict[str, set[str]],
) -> tuple[SocialTrendItem, ...]:
    ranked: list[tuple[int, int, int, str]] = []
    hidden_authors = muted.get(agent_id, set())
    for post in _visible_posts(
        posts,
        agent_id=agent_id,
        following=following,
        muted=muted,
    ):
        visible_events = [
            sequence
            for sequence, actor_id in post.activity_events
            if actor_id not in hidden_authors
        ]
        score = sum(
            max(1, _TREND_RECENCY_WINDOW - max(0, current_sequence - sequence))
            for sequence in visible_events
        )
        ranked.append(
            (
                score,
                len(visible_events),
                max(visible_events, default=post.sequence),
                post.action_id,
            )
        )
    ranked.sort(reverse=True)
    return tuple(
        SocialTrendItem(post_id=post_id, activity_count=count, score=score)
        for score, count, _latest, post_id in ranked[:_MAX_TREND_RESULTS]
    )


def reduce_social_world_state(
    session: Session,
    *,
    scenario_id: str,
    branch_id: str,
    cutoff_round: int,
) -> SocialWorldState:
    """Replay verified actions visible at ``cutoff_round`` into deterministic state."""
    cutoff = max(0, int(cutoff_round))
    lineage = resolve_branch_lineage(
        session,
        scenario_id=scenario_id,
        branch_id=branch_id,
        requested_cutoff=cutoff,
    )
    segment_by_branch = {segment.branch_id: segment for segment in lineage.segments}
    agents = session.exec(
        select(Agent).where(Agent.scenario_id == scenario_id).order_by(Agent.id)
    ).all()
    agent_names = {agent.id: str(agent.name or "") for agent in agents}
    actions = session.exec(
        select(SimulationAction)
        .where(
            SimulationAction.scenario_id == scenario_id,
            SimulationAction.branch_id.in_(tuple(segment_by_branch)),
            SimulationAction.status == SimulationActionStatus.VERIFIED,
        )
        .order_by(SimulationAction.sequence, SimulationAction.id)
    ).all()

    posts: dict[str, _PostBuilder] = {}
    action_to_post: dict[str, str] = {}
    following: dict[str, set[str]] = defaultdict(set)
    muted: dict[str, set[str]] = defaultdict(set)
    searches: dict[str, list[SocialSearchReceipt]] = defaultdict(list)
    trend_receipts: dict[str, list[SocialTrendReceipt]] = defaultdict(list)
    refresh_receipts: dict[str, list[SocialRefreshReceipt]] = defaultdict(list)
    last_seen: dict[str, int] = defaultdict(int)
    diagnostics: Counter[str] = Counter()

    agent_by_id = {agent.id: agent for agent in agents}
    from app.services.initial_social_feed import is_bootstrap_post

    for row in actions:
        segment = segment_by_branch.get(row.branch_id)
        bootstrap = is_bootstrap_post(row, agent_by_id.get(str(row.agent_id or "")))
        if segment is None or (not bootstrap and row.round_number < segment.round_min):
            continue
        if (
            not bootstrap
            and segment.round_max is not None
            and row.round_number > segment.round_max
        ):
            continue
        action_type = _enum_value(row.action_type).upper()
        actor_id = str(row.agent_id or "")
        if actor_id not in agent_names:
            diagnostics["INVALID_AGENT"] += 1
            continue

        if action_type == SimulationActionType.POST.value:
            content = str(row.content or "").strip()
            payload = _strict_payload(row) or {}
            source_name = None
            if bootstrap:
                source_name = str(payload.get("source_name") or "").strip()[:80]
                if not source_name:
                    diagnostics["INVALID_BOOTSTRAP_POST"] += 1
                    continue
            if not content or row.parent_action_id or row.target_type or row.target_id:
                diagnostics["INVALID_POST"] += 1
                continue
            posts[row.id] = _PostBuilder(
                action_id=row.id,
                author_id=actor_id,
                content=content,
                sequence=row.sequence,
                round_number=row.round_number,
                author_name_override=source_name,
                published_at=(
                    str(payload.get("published_at") or "").strip()[:64] or None
                    if bootstrap
                    else None
                ),
                credibility_hint=(
                    str(payload.get("credibility_hint") or "").strip()[:300] or None
                    if bootstrap
                    else None
                ),
                tags=(
                    tuple(str(item).strip()[:40] for item in payload.get("tags", [])[:8])
                    if bootstrap and isinstance(payload.get("tags"), list)
                    else ()
                ),
                comments=[],
                reactions={},
                activity_events=[(row.sequence, actor_id)],
            )
            action_to_post[row.id] = row.id
            continue

        if action_type == SimulationActionType.COMMENT.value:
            content = str(row.content or "").strip()
            post_id = _resolves_to_post(row, posts, action_to_post)
            if not content or post_id is None:
                diagnostics["INVALID_COMMENT"] += 1
                continue
            comment = SocialComment(
                action_id=row.id,
                post_id=post_id,
                author_id=actor_id,
                content=content,
                sequence=row.sequence,
            )
            posts[post_id].comments.append(comment)
            posts[post_id].activity_events.append((row.sequence, actor_id))
            action_to_post[row.id] = post_id
            continue

        if action_type == SimulationActionType.REACTION.value:
            post_id = _resolves_to_post(row, posts, action_to_post)
            payload = _strict_payload(row)
            reaction_kind = str((payload or {}).get("reaction") or "").upper().strip()
            if post_id is None or reaction_kind not in REACTION_KINDS:
                diagnostics["INVALID_REACTION"] += 1
                continue
            reaction = SocialReaction(
                action_id=row.id,
                post_id=post_id,
                author_id=actor_id,
                kind=reaction_kind,
                sequence=row.sequence,
            )
            posts[post_id].reactions[actor_id] = reaction
            posts[post_id].activity_events.append((row.sequence, actor_id))
            action_to_post[row.id] = post_id
            continue

        if action_type in {SimulationActionType.FOLLOW.value, SimulationActionType.MUTE.value}:
            target_id = str(row.target_id or "")
            if (
                str(row.target_type or "").lower() != "agent"
                or target_id not in agent_names
                or target_id == actor_id
                or row.content
                or row.parent_action_id
            ):
                diagnostics[f"INVALID_{action_type}"] += 1
                continue
            target_set = following if action_type == SimulationActionType.FOLLOW.value else muted
            target_set[actor_id].add(target_id)
            continue

        if action_type == SimulationActionType.SEARCH.value:
            query = str(row.content or "").strip()
            if (
                not query
                or row.parent_action_id
                or str(row.target_type or "").lower() not in {"", "query"}
            ):
                diagnostics["INVALID_SEARCH"] += 1
                continue
            searches[actor_id].append(
                SocialSearchReceipt(
                    query=query,
                    result_post_ids=_search_posts(
                        posts,
                        query=query,
                        agent_id=actor_id,
                        agent_names=agent_names,
                        following=following,
                        muted=muted,
                    ),
                    sequence=row.sequence,
                )
            )
            searches[actor_id] = searches[actor_id][-_MAX_RECENT_SEARCHES:]
            continue

        if action_type == SimulationActionType.TREND.value:
            if row.content or row.parent_action_id or row.target_type or row.target_id:
                diagnostics["INVALID_TREND"] += 1
                continue
            trend_receipts[actor_id].append(
                SocialTrendReceipt(
                    items=_trend_snapshot(
                        posts,
                        agent_id=actor_id,
                        current_sequence=row.sequence,
                        following=following,
                        muted=muted,
                    ),
                    sequence=row.sequence,
                )
            )
            trend_receipts[actor_id] = trend_receipts[actor_id][-_MAX_TREND_RECEIPTS:]
            continue

        if action_type == SimulationActionType.REFRESH.value:
            if row.content or row.parent_action_id or row.target_type or row.target_id:
                diagnostics["INVALID_REFRESH"] += 1
                continue
            visible = _visible_posts(
                posts,
                agent_id=actor_id,
                following=following,
                muted=muted,
            )[:_MAX_FEED_POSTS]
            previous_seen = last_seen[actor_id]
            latest_post_sequence = max(
                (post.sequence for post in posts.values()),
                default=previous_seen,
            )
            refresh_receipts[actor_id].append(
                SocialRefreshReceipt(
                    post_ids=tuple(post.action_id for post in visible),
                    new_count=sum(post.sequence > previous_seen for post in visible),
                    sequence=row.sequence,
                )
            )
            refresh_receipts[actor_id] = refresh_receipts[actor_id][-1:]
            last_seen[actor_id] = latest_post_sequence
            continue

        if action_type == SimulationActionType.IDLE.value:
            if row.content or row.parent_action_id or row.target_type or row.target_id:
                diagnostics["INVALID_IDLE"] += 1
            continue

        diagnostics["INVALID_ACTION_TYPE"] += 1

    final_posts = tuple(
        SocialPost(
            action_id=post.action_id,
            author_id=post.author_id,
            content=post.content,
            sequence=post.sequence,
            round_number=post.round_number,
            author_name_override=post.author_name_override,
            published_at=post.published_at,
            credibility_hint=post.credibility_hint,
            tags=post.tags,
            comments=tuple(sorted(post.comments, key=lambda item: (item.sequence, item.action_id))),
            reactions=tuple(
                sorted(post.reactions.values(), key=lambda item: (item.sequence, item.action_id))
            ),
            activity_events=tuple(post.activity_events),
        )
        for post in sorted(posts.values(), key=lambda item: (item.sequence, item.action_id))
    )
    return SocialWorldState(
        scenario_id=scenario_id,
        branch_id=branch_id,
        cutoff_round=cutoff,
        agent_names=agent_names,
        posts=final_posts,
        following={agent_id: frozenset(targets) for agent_id, targets in following.items()},
        muted={agent_id: frozenset(targets) for agent_id, targets in muted.items()},
        recent_searches={agent_id: tuple(items) for agent_id, items in searches.items()},
        trend_receipts={agent_id: tuple(items) for agent_id, items in trend_receipts.items()},
        refresh_receipts={agent_id: tuple(items) for agent_id, items in refresh_receipts.items()},
        last_seen=dict(last_seen),
        trend_counts={
            post.action_id: len(post.activity_events)
            for post in final_posts
        },
        diagnostics=dict(sorted(diagnostics.items())),
    )


def _safe_text(value: object, max_chars: int) -> str:
    cleaned = _scrub_sensitive_text(str(value or ""))
    cleaned = _CONTROL_RE.sub("", cleaned).replace("```", "` ` `").strip()
    return cleaned[:max_chars] + ("…" if len(cleaned) > max_chars else "")


def render_social_world_context(
    state: SocialWorldState,
    *,
    agent_id: str,
    language: str = "Chinese",
) -> str:
    """Return a bounded, credential-scrubbed observation for one agent."""
    posts_by_id = {post.action_id: post for post in state.posts}
    muted = state.muted.get(agent_id, frozenset())

    def post_card(post_id: str, *, include_score: SocialTrendItem | None = None) -> dict[str, Any]:
        post = posts_by_id[post_id]
        reaction_counts = Counter(
            reaction.kind for reaction in post.reactions if reaction.author_id not in muted
        )
        card: dict[str, Any] = {
            "author": _safe_text(
                post.author_name_override
                or state.agent_names.get(post.author_id, "Unknown"),
                80,
            ),
            "content": _safe_text(post.content, 160),
            "comments": sum(comment.author_id not in muted for comment in post.comments),
            "reactions": dict(sorted(reaction_counts.items())),
        }
        if post.author_name_override is not None:
            card["published_at"] = _safe_text(post.published_at, 64) if post.published_at else None
            card["credibility_hint"] = (
                _safe_text(post.credibility_hint, 300) if post.credibility_hint else None
            )
            card["tags"] = [_safe_text(tag, 40) for tag in post.tags[:8] if tag]
        if include_score is not None:
            card["activity_count"] = include_score.activity_count
            card["trend_score"] = include_score.score
        return card

    followed = state.following.get(agent_id, frozenset())
    visible_posts = [post for post in state.posts if post.author_id not in muted]

    def latest_visible_activity(post: SocialPost) -> int:
        return max(
            (
                sequence
                for sequence, actor_id in post.activity_events
                if actor_id not in muted
            ),
            default=post.sequence,
        )

    default_feed_posts = sorted(
        visible_posts,
        key=lambda post: (
            post.author_id in followed,
            latest_visible_activity(post),
            post.sequence,
            post.action_id,
        ),
        reverse=True,
    )

    def search_receipt_still_matches(post_id: str, query: str) -> bool:
        post = posts_by_id.get(post_id)
        if post is None or post.author_id in muted:
            return False
        needle = query.casefold().strip()
        if not needle:
            return False
        haystack = "\n".join(
            [
                post.content,
                post.author_name_override or state.agent_names.get(post.author_id, ""),
                " ".join(post.tags),
                *(comment.content for comment in post.comments if comment.author_id not in muted),
            ]
        ).casefold()
        return needle in haystack

    def current_trend_item(item: SocialTrendItem, receipt_sequence: int) -> SocialTrendItem | None:
        post = posts_by_id.get(item.post_id)
        if post is None or post.author_id in muted:
            return None
        visible_sequences = [post.sequence]
        visible_sequences.extend(
            comment.sequence for comment in post.comments if comment.author_id not in muted
        )
        visible_sequences.extend(
            reaction.sequence for reaction in post.reactions if reaction.author_id not in muted
        )
        score = sum(
            max(1, _TREND_RECENCY_WINDOW - max(0, receipt_sequence - sequence))
            for sequence in visible_sequences
        )
        return SocialTrendItem(
            post_id=post.action_id,
            activity_count=len(visible_sequences),
            score=score,
        )

    searches = state.recent_searches.get(agent_id, ())[-2:]
    latest_trend = state.trend_receipts.get(agent_id, ())[-1:]
    latest_refresh = state.refresh_receipts.get(agent_id, ())[-1:]
    payload: dict[str, Any] = {
        "as_of_round": state.cutoff_round,
        "world_counts": {
            "visible_posts": len(visible_posts),
            "comments": sum(
                comment.author_id not in muted
                for post in visible_posts
                for comment in post.comments
            ),
            "reactions": sum(
                reaction.author_id not in muted
                for post in visible_posts
                for reaction in post.reactions
            ),
        },
        "following": [
            _safe_text(state.agent_names.get(target, "Unknown"), 80)
            for target in sorted(state.following.get(agent_id, frozenset()))
        ][:12],
        "muted": [
            _safe_text(state.agent_names.get(target, "Unknown"), 80)
            for target in sorted(muted)
        ][:12],
        "recent_searches": [
            {
                "query": _safe_text(receipt.query, 120),
                "matches": [
                    post_card(post_id)
                    for post_id in receipt.result_post_ids[:3]
                    if search_receipt_still_matches(post_id, receipt.query)
                ],
            }
            for receipt in searches
        ],
        "trends": (
            [
                post_card(item.post_id, include_score=current_item)
                for item in latest_trend[0].items[:4]
                if (current_item := current_trend_item(item, latest_trend[0].sequence))
                is not None
            ]
            if latest_trend
            else []
        ),
        "feed": (
            [
                post_card(post_id)
                for post_id in latest_refresh[0].post_ids[:4]
                if post_id in posts_by_id and posts_by_id[post_id].author_id not in muted
            ]
            if latest_refresh
            else [
                post_card(post.action_id)
                for post in default_feed_posts[:4]
            ]
        ),
        "refresh": {
            "performed": bool(latest_refresh),
            "new_posts": latest_refresh[0].new_count if latest_refresh else 0,
            "last_seen_sequence": state.last_seen.get(agent_id, 0),
        },
    }
    if state.diagnostics:
        payload["ignored_verified_rows"] = state.diagnostics
    empty_feed_guidance = not visible_posts
    if str(language or "").lower().startswith(("zh", "chinese", "中文")):
        payload["semantics"] = (
            "这是截至上一轮的可重放社交观察；静音优先于关注。当前信息流为空，"
            "搜索、趋势和刷新会返回空结果。这不强制任何角色首发，也不按轮次或角色"
            "安排动作；如果角色此刻自然地公开提出新方案、公布数据或事实、发出警示"
            "或号召、向公众提出问题，可以 POST；否则 IDLE 仍然合法。COMMENT/REACTION "
            "只有出现可见旧帖后才可用。"
            if empty_feed_guidance
            else "这是截至上一轮的可重放社交观察；静音优先于关注。"
        )
    else:
        payload["semantics"] = (
            "Replayable social observations through the previous round; mute overrides follow. "
            "The feed is empty, so search, trends, and refresh return no results. This does not "
            "force any character to publish first or schedule actions by round or role. If the "
            "character naturally makes a new public proposal, releases data or facts, issues a "
            "warning or call to action, or asks the public a question now, POST is available; "
            "otherwise IDLE remains valid. COMMENT/REACTION become available only after a prior "
            "visible post exists."
            if empty_feed_guidance
            else "Replayable social observations through the previous round; mute overrides follow."
        )
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
