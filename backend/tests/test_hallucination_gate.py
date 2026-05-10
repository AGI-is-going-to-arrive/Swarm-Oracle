"""Tests for the warning-only debate hallucination verification gate."""

from __future__ import annotations

from unittest.mock import patch

from app.services.hallucination_gate import (
    apply_hallucination_gate,
    extract_verifiable_claims,
    verify_claims,
)


def test_extract_verifiable_claims_detects_statistical_claim():
    claims = extract_verifiable_claims("公司增长了 300%。")

    assert len(claims) == 1
    assert claims[0]["claim_type"] == "statistical"
    assert claims[0]["text"] == "公司增长了 300%"


def test_extract_verifiable_claims_detects_causal_claim():
    claims = extract_verifiable_claims("X because Y.")

    assert len(claims) == 1
    assert claims[0]["claim_type"] == "causal"


def test_extract_verifiable_claims_skips_question_only_verdict():
    assert extract_verifiable_claims("Is this true? 为什么会这样？") == []


def test_extract_verifiable_claims_skips_hedged_sentence():
    assert extract_verifiable_claims("公司可能增长了 300%。Maybe revenue grew 20%.") == []


def test_verify_claims_containment_in_graph_evidence_verifies_claim():
    claim = {
        "text": "Company revenue grew 20%",
        "source_sentence": "Company revenue grew 20%",
        "claim_type": "statistical",
    }

    evidence = [{"text": "Company revenue grew 20%", "source": "graph:a"}]
    verified = verify_claims([claim], evidence, [])

    assert verified[0]["verified"] is True
    assert verified[0]["confidence"] >= 0.75
    assert verified[0]["evidence_sources"]


def test_verify_claims_detects_negation_contradiction():
    claim = {
        "text": "Company revenue grew 20%",
        "source_sentence": "Company revenue grew 20%",
        "claim_type": "statistical",
    }

    verified = verify_claims(
        [claim],
        [{"text": "Company revenue did not grow 20%", "source": "graph:negative"}],
        [],
    )

    assert verified[0]["contradiction_found"] is True
    assert verified[0]["verified"] is False


def test_verify_claims_without_matching_evidence_stays_unverified():
    claim = {
        "text": "Company revenue grew 20%",
        "source_sentence": "Company revenue grew 20%",
        "claim_type": "statistical",
    }

    verified = verify_claims([claim], [{"text": "Weather stayed calm", "source": "graph:a"}], [])

    assert verified[0]["verified"] is False
    assert verified[0]["confidence"] < 0.5


def test_verify_claims_both_graph_and_web_sources_raise_confidence():
    claim = {
        "text": "Company revenue grew 20%",
        "source_sentence": "Company revenue grew 20%",
        "claim_type": "statistical",
    }

    single = verify_claims(
        [claim],
        [{"text": "Company revenue grew 20%", "source": "graph:a"}],
        [],
    )[0]
    dual = verify_claims(
        [claim],
        [{"text": "Company revenue grew 20%", "source": "graph:a"}],
        [{"text": "Company revenue grew 20%", "source": "web:a"}],
    )[0]

    assert len(dual["evidence_sources"]) >= 2
    assert dual["confidence"] >= single["confidence"]


def test_apply_hallucination_gate_passes_high_confidence_verdict():
    result = apply_hallucination_gate(
        "Company revenue grew 20%.",
        [{"text": "Company revenue grew 20%", "source": "graph:a"}],
        [],
    )

    assert result["gate_passed"] is True
    assert result["warnings"] == []


def test_apply_hallucination_gate_warns_on_low_confidence_verdict():
    result = apply_hallucination_gate(
        "Company revenue grew 20%.",
        [{"text": "Weather stayed calm", "source": "graph:a"}],
        [],
    )

    assert result["gate_passed"] is False
    assert result["warnings"]


def test_apply_hallucination_gate_empty_verdict():
    result = apply_hallucination_gate("", [], [])

    assert result["claims"] == []
    assert result["gate_passed"] is False
    assert "empty_verdict" in result["warnings"]


def test_feature_flag_disabled_skips_debate_gate(monkeypatch):
    import app.services.debate as debate_module

    monkeypatch.setattr(debate_module.settings, "FEATURE_HALLUCINATION_GATE", False)
    breakdown = {"dimensions": {"coherence": {"proposition": 5}}, "metadata": {}}

    with patch("app.services.hallucination_gate.apply_hallucination_gate") as mocked_gate:
        result = debate_module._apply_hallucination_gate_metadata(
            breakdown_json=breakdown,
            verdict_text="Company revenue grew 20%.",
            graph_evidence=[{"text": "Company revenue grew 20%"}],
            web_evidence=[],
        )

    mocked_gate.assert_not_called()
    assert result == breakdown


def test_debate_gate_failure_isolation_keeps_breakdown_intact(monkeypatch):
    import app.services.debate as debate_module

    monkeypatch.setattr(debate_module.settings, "FEATURE_HALLUCINATION_GATE", True)
    breakdown = {
        "dimensions": {"coherence": {"proposition": 5, "opposition": 3}},
        "metadata": {"adjudication_mode": "deterministic"},
    }

    with patch(
        "app.services.hallucination_gate.apply_hallucination_gate",
        side_effect=RuntimeError("gate failed"),
    ):
        result = debate_module._apply_hallucination_gate_metadata(
            breakdown_json=breakdown,
            verdict_text="Company revenue grew 20%.",
            graph_evidence=[{"text": "Company revenue grew 20%"}],
            web_evidence=[],
        )

    assert result["dimensions"] == breakdown["dimensions"]
    assert result["metadata"]["adjudication_mode"] == "deterministic"
    assert "hallucination_gate" not in result["metadata"]


def test_contradiction_reduces_confidence():
    claim = {
        "text": "Company revenue grew 20%",
        "source_sentence": "Company revenue grew 20%",
        "claim_type": "statistical",
    }

    positive = verify_claims(
        [claim],
        [{"text": "Company revenue grew 20%", "source": "graph:positive"}],
        [],
    )[0]
    contradicted = verify_claims(
        [claim],
        [{"text": "Company revenue did not grow 20%", "source": "graph:negative"}],
        [],
    )[0]

    assert contradicted["confidence"] < positive["confidence"]
