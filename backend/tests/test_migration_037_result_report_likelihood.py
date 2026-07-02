"""Regression tests for result-report likelihood cleanup migration."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from tests.test_result_report_contract import _legal_full_report


def _load_migration_module():
    backend_root = Path(__file__).resolve().parents[1]
    migration_path = (
        backend_root
        / "alembic"
        / "versions"
        / "037_clean_result_report_likelihood.py"
    )
    spec = importlib.util.spec_from_file_location(
        "migration_037_clean_result_report_likelihood",
        migration_path,
    )
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_037_helper_clamps_dirty_likelihood_and_preserves_context_keys():
    migration = _load_migration_module()
    report = _legal_full_report()
    report["verdict"]["likelihood"]["probability"] = 1.95
    report["verdict"]["likelihood"]["interval"] = [1.95, 1.0]
    parsed_context = {
        "full_report": report,
        "result_quality": {"verdict": "kept"},
        "branch_question_answers": [{"branch_id": "branch-1", "answer": "kept"}],
    }

    normalized, changed = migration._normalize_parsed_context(parsed_context)

    assert changed is True
    assert normalized["result_quality"] == {"verdict": "kept"}
    assert normalized["branch_question_answers"] == [
        {"branch_id": "branch-1", "answer": "kept"}
    ]
    assert normalized["full_report"]["verdict"]["likelihood"] == {
        "probability": 1.0,
        "interval": [1.0, 1.0],
        "wep": "likely",
    }


def test_037_helper_backfills_legacy_likelihood_without_wep():
    migration = _load_migration_module()
    report = _legal_full_report()
    del report["verdict"]["likelihood"]["wep"]
    parsed_context = {"full_report": report, "result_quality": {"kept": True}}

    normalized, changed = migration._normalize_parsed_context(parsed_context)

    assert changed is True
    assert normalized["full_report"]["verdict"]["likelihood"] == {
        "probability": 0.68,
        "interval": [0.55, 0.76],
        "wep": "likely",
    }
    assert normalized["result_quality"] == {"kept": True}


def test_037_helper_preserves_oversized_legal_report_after_likelihood_clamp(monkeypatch):
    from app.config import settings

    migration = _load_migration_module()
    monkeypatch.setattr(settings, "REPORT_FULL_REPORT_MAX_BYTES", 10)
    report = _legal_full_report()
    report["verdict"]["likelihood"]["probability"] = 1.95
    report["verdict"]["likelihood"]["interval"] = [1.95, 1.0]
    parsed_context = {"full_report": report, "result_quality": {"kept": True}}

    normalized, changed = migration._normalize_parsed_context(parsed_context)

    assert changed is True
    assert normalized["full_report"] is not None
    assert normalized["full_report"]["verdict"]["likelihood"] == {
        "probability": 1.0,
        "interval": [1.0, 1.0],
        "wep": "likely",
    }
    assert normalized["result_quality"] == {"kept": True}


def test_037_helper_accepts_json_string_context_and_is_idempotent_when_clean():
    migration = _load_migration_module()
    parsed_context = {"full_report": _legal_full_report(), "result_quality": {"kept": True}}

    normalized, changed = migration._normalize_parsed_context(
        json.dumps(parsed_context, ensure_ascii=False)
    )

    assert changed is False
    assert normalized == parsed_context


def test_037_helper_accepts_json_string_full_report_and_clamps_likelihood():
    migration = _load_migration_module()
    report = _legal_full_report()
    report["verdict"]["likelihood"]["probability"] = 1.95
    report["verdict"]["likelihood"]["interval"] = [1.95, 1.0]
    parsed_context = {
        "full_report": json.dumps(report, ensure_ascii=False),
        "result_quality": {"kept": True},
    }

    normalized, changed = migration._normalize_parsed_context(parsed_context)

    assert changed is True
    assert normalized["full_report"]["verdict"]["likelihood"] == {
        "probability": 1.0,
        "interval": [1.0, 1.0],
        "wep": "likely",
    }
    assert normalized["result_quality"] == {"kept": True}


def test_037_helper_nulls_report_only_when_it_still_fails_validation():
    migration = _load_migration_module()
    report = _legal_full_report()
    report["target_branch_sort"] = ["id_asc"]
    report["verdict"]["likelihood"]["probability"] = 1.95
    report["verdict"]["likelihood"]["interval"] = [1.95, 1.0]
    parsed_context = {"full_report": report, "result_quality": {"kept": True}}

    normalized, changed = migration._normalize_parsed_context(parsed_context)

    assert changed is True
    assert normalized["full_report"] is None
    assert normalized["result_quality"] == {"kept": True}
