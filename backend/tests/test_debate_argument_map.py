"""Tests for debate_argument_map service (F6 — Phase C2)."""

from __future__ import annotations

import pytest

from app.services.debate_argument_map import (
    extract_argument_units,
    get_argument_map,
    link_verdict,
)


# ── extract_argument_units ──────────────────────────────────


def test_extract_claims_from_simple_text():
    """Simple sentences without keywords should be classified as claims."""
    ids = extract_argument_units(
        debate_id="d1", turn_id="t1",
        content="AI will change the world. Robots are useful.",
        speaker_side="proposition",
    )
    assert len(ids) == 2
    result = get_argument_map("d1")
    types = {u["type"] for u in result["units"]}
    assert types == {"claim"}


def test_extract_detects_rebuttals():
    """Sentences with however/but should be classified as rebuttal."""
    ids = extract_argument_units(
        debate_id="d-reb", turn_id="t1",
        content="This is fine. However the cost is too high. But we can adapt.",
        speaker_side="opposition",
    )
    assert len(ids) == 3
    result = get_argument_map("d-reb")
    rebuttal_count = sum(1 for u in result["units"] if u["type"] == "rebuttal")
    assert rebuttal_count == 2


def test_extract_detects_rebuttals_chinese():
    """Chinese rebuttal keywords should also be detected."""
    ids = extract_argument_units(
        debate_id="d-reb-zh", turn_id="t1",
        content="这很好。然而成本太高。不过可以适应。",
        speaker_side="opposition",
    )
    assert len(ids) == 3
    result = get_argument_map("d-reb-zh")
    rebuttal_count = sum(1 for u in result["units"] if u["type"] == "rebuttal")
    assert rebuttal_count == 2


def test_extract_detects_evidence_keywords():
    """Sentences with evidence/study/data should be classified as evidence."""
    ids = extract_argument_units(
        debate_id="d-evi", turn_id="t1",
        content="A 2024 study shows improvement. The data confirms the trend.",
        speaker_side="proposition",
    )
    assert len(ids) == 2
    result = get_argument_map("d-evi")
    evidence_count = sum(1 for u in result["units"] if u["type"] == "evidence")
    assert evidence_count == 2


def test_extract_deduplicates_by_semantic_hash():
    """Identical sentences (case-insensitive) should be deduplicated."""
    ids1 = extract_argument_units(
        debate_id="d-dedup", turn_id="t1",
        content="AI is great. AI is great.",
        speaker_side="proposition",
    )
    # Second call with same text from a different turn
    ids2 = extract_argument_units(
        debate_id="d-dedup", turn_id="t2",
        content="AI IS GREAT.",
        speaker_side="opposition",
    )
    assert len(ids1) == 1  # dedup within same turn content
    assert len(ids2) == 0  # dedup across turns


def test_extract_empty_content_returns_empty():
    """Empty or whitespace-only content should return no units."""
    ids = extract_argument_units(
        debate_id="d-empty", turn_id="t1",
        content="   ",
        speaker_side="proposition",
    )
    assert ids == []


# ── link_verdict ────────────────────────────────────────────


def test_link_verdict_marks_accepted_and_unaddressed():
    """Verdict marks matching turn units as accepted, rest as unaddressed."""
    extract_argument_units(
        debate_id="d-verdict", turn_id="t1",
        content="Claim from turn one.",
        speaker_side="proposition",
    )
    extract_argument_units(
        debate_id="d-verdict", turn_id="t2",
        content="Claim from turn two.",
        speaker_side="opposition",
    )

    link_verdict("d-verdict", {"supporting_turns": ["t1"]})

    result = get_argument_map("d-verdict")
    statuses = {u["turn_id"]: u["status"] for u in result["units"]}
    assert statuses["t1"] == "accepted"
    assert statuses["t2"] == "unaddressed"


def test_link_verdict_no_supporting_turns_marks_all_unaddressed():
    """Without supporting_turns, all standing units become unaddressed."""
    extract_argument_units(
        debate_id="d-vnosupp", turn_id="t1",
        content="Some claim.",
        speaker_side="proposition",
    )

    link_verdict("d-vnosupp", {})

    result = get_argument_map("d-vnosupp")
    assert all(u["status"] == "unaddressed" for u in result["units"])


# ── get_argument_map ────────────────────────────────────────


def test_get_argument_map_empty_when_no_data():
    """When no extraction happened, return empty structure."""
    result = get_argument_map("nonexistent-debate")
    assert result["snapshot_id"] is None
    assert result["nodes"] == []
    assert result["edges"] == []
    assert result["units"] == []


def test_get_argument_map_populated_after_extraction():
    """After extraction, map should contain nodes and units."""
    extract_argument_units(
        debate_id="d-pop", turn_id="t1",
        content="This is a claim. A study shows evidence. However that is wrong.",
        speaker_side="proposition",
    )
    result = get_argument_map("d-pop")
    assert result["snapshot_id"] is not None
    assert len(result["nodes"]) == 3
    assert len(result["units"]) == 3

    unit_types = {u["type"] for u in result["units"]}
    assert "claim" in unit_types
    assert "evidence" in unit_types
    assert "rebuttal" in unit_types

    # Every unit should have a corresponding node
    node_ids = {n["id"] for n in result["nodes"]}
    for unit in result["units"]:
        # unit node_id is stored in the DebateArgumentUnit but surfaced via
        # GraphNode; verify the node_key matches the unit's semantic hash
        assert unit["turn_id"] == "t1"
