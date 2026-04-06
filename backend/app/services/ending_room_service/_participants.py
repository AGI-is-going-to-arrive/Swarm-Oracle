"""Participant selection, representative management, and sorting."""

from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from app.models import (
    AgentMessage,
    Branch,
    EndingRoomParticipant,
    EndingRoomRoleSlot,
    EndingRoomType,
    Round,
    Scenario,
)

from ._utils import (
    EndingRoomServiceError,
    _branch_lookup,
    _impact_score,
    _parse_key_moments,
    _short_persona,
    _speaker_lookup,
    _tier_rank,
)


def _visible_branch_agents(
    session: Session,
    scenario_id: str,
    branch_id: str,
    *,
    language: str,
) -> list[dict[str, Any]]:
    branch = session.get(Branch, branch_id)
    if branch is None:
        return []

    speakers = _speaker_lookup(session, scenario_id)
    unknown_name = "未知角色" if language == "zh" else "Unknown speaker"
    rows = session.exec(
        select(Round.round_number, AgentMessage.agent_id, AgentMessage.content)
        .join(AgentMessage, AgentMessage.round_id == Round.id)
        .where(Round.branch_id == branch_id)
        .order_by(Round.round_number, AgentMessage.id)
    ).all()
    stats_by_agent_id: dict[str, dict[str, Any]] = {}
    key_moments = [item.lower() for item in _parse_key_moments(branch.key_moments) if item]
    for round_number, agent_id, content in rows:
        normalized_agent_id = str(agent_id or "").strip()
        if not normalized_agent_id:
            continue
        stats = stats_by_agent_id.setdefault(
            normalized_agent_id,
            {
                "turn_count": 0,
                "key_moment_hits": 0,
                "last_round_spoken": 0,
            },
        )
        stats["turn_count"] += 1
        stats["last_round_spoken"] = max(stats["last_round_spoken"], int(round_number or 0))
        normalized_content = str(content or "").lower()
        if key_moments and any(moment in normalized_content for moment in key_moments):
            stats["key_moment_hits"] += 1

    candidates: list[dict[str, Any]] = []
    raw_scores: list[float] = []
    if stats_by_agent_id:
        for agent_id, stats in stats_by_agent_id.items():
            agent = speakers.get(agent_id)
            tier = getattr(agent.tier, "value", "CROWD") if agent is not None else "CROWD"
            raw_score = (
                float(stats["turn_count"]) * 1.1
                + float(stats["key_moment_hits"]) * 1.6
                + float(stats["last_round_spoken"]) * 0.35
                + float(_tier_rank(tier)) * 0.8
            )
            raw_scores.append(raw_score)
            candidates.append(
                {
                    "source_agent_id": agent_id,
                    "display_name": agent.name if agent is not None else unknown_name,
                    "agent_role": agent.role if agent is not None else "",
                    "agent_persona": agent.persona if agent is not None else "",
                    "bio_short": _short_persona(agent.persona if agent is not None else None),
                    "tier": tier,
                    "turn_count": int(stats["turn_count"]),
                    "key_moment_hits": int(stats["key_moment_hits"]),
                    "last_round_spoken": int(stats["last_round_spoken"]),
                    "fallback_cast": False,
                    "selection_reason": "top_impact",
                    "_raw_score": raw_score,
                }
            )
    else:
        fallback_agents = sorted(
            speakers.values(),
            key=lambda item: (-_tier_rank(getattr(item.tier, "value", item.tier)), item.name.lower(), item.id),  # noqa: E501
        )
        for index, agent in enumerate(fallback_agents):
            raw_score = float(
                _tier_rank(getattr(agent.tier, "value", agent.tier))) + max(0.0, 0.2 - index * 0.03
            )
            raw_scores.append(raw_score)
            candidates.append(
                {
                    "source_agent_id": agent.id,
                    "display_name": agent.name,
                    "agent_role": agent.role,
                    "agent_persona": agent.persona,
                    "bio_short": _short_persona(agent.persona),
                    "tier": getattr(agent.tier, "value", agent.tier),
                    "turn_count": 0,
                    "key_moment_hits": 0,
                    "last_round_spoken": 0,
                    "fallback_cast": True,
                    "selection_reason": "fallback",
                    "_raw_score": raw_score,
                }
            )

    max_score = max(raw_scores, default=0.0)
    ordered = sorted(
        candidates,
        key=lambda item: (
            -float(item["_raw_score"]),
            -int(item["turn_count"]),
            -int(item["last_round_spoken"]),
            str(item["display_name"]).lower(),
            str(item["source_agent_id"]),
        ),
    )
    for item in ordered:
        item["impact_score"] = _impact_score(float(item.pop("_raw_score")), max_score)
    return ordered


def _sort_selected_representatives(
    selected_representatives: list[dict[str, str]],
    selected_branch_ids: list[str],
) -> list[dict[str, str]]:
    branch_order = {
        branch_id: index
        for index, branch_id in enumerate(selected_branch_ids)
    }
    return sorted(
        selected_representatives,
        key=lambda item: (
            branch_order.get(item["branch_id"], len(branch_order)),
            item["agent_id"],
        ),
    )


def _roundtable_representative_def(
    session: Session,
    *,
    scenario_id: str,
    branch: Branch,
    selected_branch_ids: list[str],
    selected_agent_id: str | None,
    selection_reason_override: str | None,
    language: str,
) -> dict[str, Any]:
    branch_agents = _visible_branch_agents(
        session,
        scenario_id,
        branch.id,
        language=language,
    )
    branch_agents_by_id = {
        str(agent["source_agent_id"]): agent
        for agent in branch_agents
        if agent.get("source_agent_id")
    }
    speaker: dict[str, Any] | None
    if selected_agent_id is not None:
        speaker = branch_agents_by_id.get(selected_agent_id)
        if speaker is None:
            raise EndingRoomServiceError(
                422,
                "ENDING_ROOM_AGENT_NOT_VISIBLE",
                "selected_representatives must belong to the target worldline roster",
            )
        speaker = {
            **speaker,
            "selection_reason": selection_reason_override or "user_selected",
        }
    else:
        speaker = branch_agents[0] if branch_agents else None
    persona_snapshot = {
        "branch_title": branch.title,
        "branch_probability": branch.probability,
    }
    if speaker is not None:
        persona_snapshot.update(
            {
                "agent_role": speaker.get("agent_role") or "",
                "agent_persona": speaker.get("agent_persona") or "",
                "bio_short": speaker.get("bio_short"),
                "impact_score": speaker.get("impact_score"),
                "turn_count": speaker.get("turn_count"),
                "key_moment_hits": speaker.get("key_moment_hits"),
                "last_round_spoken": speaker.get("last_round_spoken"),
                "selection_reason": speaker.get("selection_reason"),
                "fallback_cast": speaker.get("fallback_cast", False),
                "tier": speaker.get("tier"),
            }
        )
    return {
        "role_slot": EndingRoomRoleSlot.REPRESENTATIVE.value,
        "display_name": f"{speaker['display_name']} · {branch.title}" if speaker else branch.title,
        "source_branch_id": branch.id,
        "source_agent_id": speaker["source_agent_id"] if speaker else None,
        "persona_snapshot_json": persona_snapshot,
        "visibility_scope_json": {
            "fulltext_branch_ids": [branch.id],
            "summary_branch_ids": [item for item in selected_branch_ids if item != branch.id],
        },
    }


def _roundtable_witness_def(
    session: Session,
    *,
    scenario_id: str,
    branch: Branch,
    selected_branch_ids: list[str],
    selected_agent_id: str,
    selected_representative_by_branch: dict[str, str],
    selection_reason: str,
    language: str,
) -> dict[str, Any]:
    branch_agents = _visible_branch_agents(
        session,
        scenario_id,
        branch.id,
        language=language,
    )
    branch_agents_by_id = {
        str(agent["source_agent_id"]): agent
        for agent in branch_agents
        if agent.get("source_agent_id")
    }
    speaker = branch_agents_by_id.get(selected_agent_id)
    if speaker is None:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must belong to the target worldline roster",
        )
    if selected_representative_by_branch.get(branch.id) == selected_agent_id:
        raise EndingRoomServiceError(
            422,
            "ENDING_ROOM_WITNESS_SELECTION_INVALID",
            "selected_witness must be different from the seated representative on the same worldline",  # noqa: E501
        )
    return {
        "role_slot": EndingRoomRoleSlot.CRITIC.value,
        "display_name": speaker["display_name"],
        "source_branch_id": branch.id,
        "source_agent_id": str(speaker["source_agent_id"]),
        "persona_snapshot_json": {
            "agent_role": speaker.get("agent_role") or "",
            "agent_persona": speaker.get("agent_persona") or "",
            "bio_short": speaker.get("bio_short"),
            "impact_score": speaker.get("impact_score"),
            "turn_count": speaker.get("turn_count"),
            "key_moment_hits": speaker.get("key_moment_hits"),
            "last_round_spoken": speaker.get("last_round_spoken"),
            "selection_reason": selection_reason,
            "fallback_cast": speaker.get("fallback_cast", False),
            "tier": speaker.get("tier"),
            "witness_branch_title": branch.title,
        },
        "visibility_scope_json": {
            "fulltext_branch_ids": [branch.id],
            "summary_branch_ids": [item for item in selected_branch_ids if item != branch.id],
        },
    }


def _participant_defs(
    session: Session,
    *,
    scenario: Scenario,
    room_type: EndingRoomType,
    anchor_branch_id: str | None,
    selected_branch_ids: list[str],
    selected_agent_ids: list[str],
    selected_representatives: list[dict[str, str]],
    selected_witness: dict[str, str] | None,
    selection_recipe: str | None,
    language: str,
) -> list[dict[str, Any]]:
    participants: list[dict[str, Any]] = []
    used_agent_ids: set[str] = set()
    branch_map = _branch_lookup(session, scenario.id)
    if room_type == EndingRoomType.WORLDLINE_ROUNDTABLE:
        selected_representative_by_branch = {
            item["branch_id"]: item["agent_id"]
            for item in selected_representatives
        }
        representative_selection_reason = (
            selection_recipe
            if selection_recipe in {"trait_mix", "fault_line_first", "witness_augmented"}
            else None
        )
        for branch_id in selected_branch_ids:
            branch = branch_map[branch_id]
            participants.append(
                _roundtable_representative_def(
                    session,
                    scenario_id=scenario.id,
                    branch=branch,
                    selected_branch_ids=selected_branch_ids,
                    selected_agent_id=selected_representative_by_branch.get(branch_id),
                    selection_reason_override=representative_selection_reason,
                    language=language,
                )
            )
        if selected_witness is not None:
            witness_branch = branch_map.get(selected_witness["branch_id"])
            if witness_branch is None:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_WITNESS_SELECTION_INVALID",
                    "selected_witness must target a selected worldline",
                )
            participants.append(
                _roundtable_witness_def(
                    session,
                    scenario_id=scenario.id,
                    branch=witness_branch,
                    selected_branch_ids=selected_branch_ids,
                    selected_agent_id=selected_witness["agent_id"],
                    selected_representative_by_branch=selected_representative_by_branch,
                    selection_reason=(
                        "witness_augmented"
                        if selection_recipe == "witness_augmented"
                        else "expert_witness"
                    ),
                    language=language,
                )
            )
    elif room_type != EndingRoomType.CROSSLINE_GALLERY:
        assert anchor_branch_id is not None
        branch_agents = _visible_branch_agents(
            session,
            scenario.id,
            anchor_branch_id,
            language=language,
        )
        branch_agents_by_id = {
            str(agent["source_agent_id"]): agent
            for agent in branch_agents
            if agent.get("source_agent_id")
        }
        if selected_agent_ids:
            missing_agent_ids = [
                agent_id
                for agent_id in selected_agent_ids
                if agent_id not in branch_agents_by_id
            ]
            if missing_agent_ids:
                raise EndingRoomServiceError(
                    422,
                    "ENDING_ROOM_AGENT_NOT_VISIBLE",
                    "selected_agent_ids must belong to the current worldline roster",
                )
            ordered_agents = [
                {
                    **branch_agents_by_id[agent_id],
                    "selection_reason": "user_selected",
                }
                for agent_id in selected_agent_ids
            ]
        else:
            limit = 1 if room_type == EndingRoomType.ONE_MOVE_ONLY else 2
            ordered_agents = branch_agents[:limit]

        for speaker in ordered_agents:
            speaker_id = str(speaker["source_agent_id"])
            if speaker_id in used_agent_ids:
                continue
            used_agent_ids.add(speaker_id)
            participants.append(
                {
                    "role_slot": EndingRoomRoleSlot.AGENT.value,
                    "display_name": speaker["display_name"],
                    "source_branch_id": anchor_branch_id,
                    "source_agent_id": speaker_id,
                    "persona_snapshot_json": {
                        "agent_role": speaker.get("agent_role") or "",
                        "agent_persona": speaker.get("agent_persona") or "",
                        "bio_short": speaker.get("bio_short"),
                        "impact_score": speaker.get("impact_score"),
                        "turn_count": speaker.get("turn_count"),
                        "key_moment_hits": speaker.get("key_moment_hits"),
                        "last_round_spoken": speaker.get("last_round_spoken"),
                        "selection_reason": speaker.get("selection_reason"),
                        "fallback_cast": speaker.get("fallback_cast", False),
                        "tier": speaker.get("tier"),
                    },
                    "visibility_scope_json": {
                        "fulltext_branch_ids": [anchor_branch_id],
                        "summary_branch_ids": [],
                    },
                }
            )

    participants.append(
        {
            "role_slot": EndingRoomRoleSlot.ARCHIVIST.value,
            "display_name": "档案官" if language == "zh" else "Archivist",
            "source_branch_id": None,
            "source_agent_id": None,
            "persona_snapshot_json": {"role": "archivist"},
            "visibility_scope_json": {
                "fulltext_branch_ids": [anchor_branch_id] if room_type == EndingRoomType.ENDING_CHAMBER and anchor_branch_id else [],  # noqa: E501
                "summary_branch_ids": selected_branch_ids,
            },
        }
    )
    return participants


def _sort_room_participants(
    participants: list[EndingRoomParticipant],
    selected_branch_ids: list[str],
    selected_agent_ids: list[str] | None = None,
) -> list[EndingRoomParticipant]:
    branch_order = {
        branch_id: index
        for index, branch_id in enumerate(selected_branch_ids)
    }
    agent_order = {
        agent_id: index
        for index, agent_id in enumerate(selected_agent_ids or [])
    }
    role_order = {
        EndingRoomRoleSlot.AGENT: 0,
        EndingRoomRoleSlot.REPRESENTATIVE: 1,
        EndingRoomRoleSlot.ARCHIVIST: 2,
        EndingRoomRoleSlot.CRITIC: 3,
        EndingRoomRoleSlot.OBSERVER: 4,
        EndingRoomRoleSlot.USER: 5,
    }
    return sorted(
        participants,
        key=lambda participant: (
            role_order.get(participant.role_slot, 99),
            branch_order.get(participant.source_branch_id or "", len(branch_order)),
            agent_order.get(participant.source_agent_id or "", len(agent_order)),
            participant.display_name.lower(),
            participant.id,
        ),
    )

