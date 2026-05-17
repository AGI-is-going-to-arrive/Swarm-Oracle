"""Shared gameplay contract loader."""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[3] / "shared" / "gameplay_contract.v1.json"
_CONTRACT_CACHE: tuple[int, dict[str, Any]] | None = None
_CONTRACT_CACHE_LOCK = Lock()
_DIRECTIVE_FORBIDDEN_MARKERS = (
    "director override",
    "high-priority gameplay event",
    "prompt_lines",
    "card_id",
    "profile_id",
    "高优先级玩法卡事件",
)


def load_gameplay_contract() -> dict[str, Any]:
    global _CONTRACT_CACHE

    with _CONTRACT_CACHE_LOCK:
        try:
            with CONTRACT_PATH.open("r", encoding="utf-8") as handle:
                mtime_ns = os.fstat(handle.fileno()).st_mtime_ns
                if _CONTRACT_CACHE is not None and _CONTRACT_CACHE[0] == mtime_ns:
                    return _CONTRACT_CACHE[1]

                contract = json.load(handle)
        except FileNotFoundError as exc:
            raise RuntimeError(
                f"Gameplay contract file is missing: {CONTRACT_PATH}. "
                "Restore shared/gameplay_contract.v1.json before starting the backend."
            ) from exc

        _CONTRACT_CACHE = (mtime_ns, contract)
        return contract


def _localized(value: dict[str, Any], language: str) -> str:
    key = "en" if language.lower().startswith("en") else "zh"
    fallback_key = "zh" if key == "en" else "en"
    return str(value.get(key) or value.get(fallback_key) or "").strip()


def _find_contract_entry(entries: list[Any], entry_id: str, kind: str) -> dict[str, Any]:
    for entry in entries:
        if isinstance(entry, dict) and entry.get("id") == entry_id:
            return entry
    raise ValueError(f"Unknown gameplay {kind}: {entry_id}")


def _agent_line(
    language: str,
    primary_agent_name: str | None,
    secondary_agent_name: str | None,
) -> str | None:
    primary = (primary_agent_name or "").strip()
    secondary = (secondary_agent_name or "").strip()
    if primary and secondary:
        return (
            f"受影响角色：{primary}、{secondary}"
            if not language.lower().startswith("en")
            else f"Affected agents: {primary}, {secondary}"
        )
    if primary:
        return (
            f"受影响角色：{primary}"
            if not language.lower().startswith("en")
            else f"Affected agent: {primary}"
        )
    return None


def _sanitize_custom_directive(value: str) -> str:
    cleaned_lines: list[str] = []
    for raw_line in value.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        normalized = line.lower()
        if any(marker in normalized for marker in _DIRECTIVE_FORBIDDEN_MARKERS):
            continue
        cleaned = (
            line
            .replace("{", "")
            .replace("}", "")
            .replace("[", "")
            .replace("]", "")
        ).strip()
        if cleaned:
            cleaned_lines.append(cleaned)
    return " ".join(cleaned_lines).strip()[:800]


def resolve_server_card_directive(
    card_id: str,
    profile_id: str,
    custom_directive: str | None = None,
    language: str = "zh",
) -> str:
    contract = load_gameplay_contract()
    card = _find_contract_entry(contract.get("cards", []), card_id, "card")
    profile = _find_contract_entry(contract.get("profiles", []), profile_id, "profile")
    is_en = language.lower().startswith("en")

    directive = (custom_directive or "").strip()
    if directive:
        safe_directive = _sanitize_custom_directive(directive)
        if safe_directive:
            return safe_directive
    return _localized(
        profile.get("default_directives", {}).get(card_id, {}),
        "en" if is_en else "zh",
    ) or _localized(card.get("descriptions", {}), "en" if is_en else "zh")


def build_server_card_prompt(
    card_id: str,
    profile_id: str,
    custom_directive: str | None = None,
    language: str = "zh",
    target_branch_title: str | None = None,
    primary_agent_name: str | None = None,
    secondary_agent_name: str | None = None,
) -> str:
    """Build the backend-owned intervention text for gameplay cards.

    This is deliberately display-readable and model-facing. It avoids exposing
    frontend prompt templates or internal contract field names.
    """
    contract = load_gameplay_contract()
    card = _find_contract_entry(contract.get("cards", []), card_id, "card")
    profile = _find_contract_entry(contract.get("profiles", []), profile_id, "profile")
    is_en = language.lower().startswith("en")

    card_label = _localized(card.get("labels", {}), "en" if is_en else "zh")
    profile_label = _localized(profile.get("labels", {}), "en" if is_en else "zh")
    directive = resolve_server_card_directive(
        card_id,
        profile_id,
        custom_directive,
        language,
    )

    branch = (target_branch_title or "").strip()
    agent_line = _agent_line("en" if is_en else "zh", primary_agent_name, secondary_agent_name)

    if is_en:
        lines = [
            f"Gameplay card: {card_label}",
            f"Profile: {profile_label}",
        ]
        if branch:
            lines.append(f"Target branch: {branch}")
        if agent_line:
            lines.append(agent_line)
        lines.extend([
            f"Player directive: {directive}",
            (
                "In the next round, treat this as a concrete event that has "
                "just happened in the target worldline."
            ),
            (
                "The affected agents must respond to it directly, and the rest "
                "of the table should show how it changes their stance, "
                "alliances, priorities, or risk model."
            ),
            (
                "Continue carrying the consequences in later rounds until "
                "another event, evidence, or branch decision changes the situation."
            ),
        ])
        return "\n".join(lines)

    lines = [
        f"玩法卡：{card_label}",
        f"题材档案：{profile_label}",
    ]
    if branch:
        lines.append(f"目标分支：{branch}")
    if agent_line:
        lines.append(agent_line)
    lines.extend([
        f"玩家指令：{directive}",
        "下一轮：把这件事当作目标世界线里刚刚发生的具体事件处理。",
        "受影响角色必须直接回应，其余角色也要表现出它如何改变立场、联盟、优先级或风险判断。",
        "后续轮次要继续承接这次干预的后果，直到新的事件、证据或分支决定改变局势。",
    ])
    return "\n".join(lines)
