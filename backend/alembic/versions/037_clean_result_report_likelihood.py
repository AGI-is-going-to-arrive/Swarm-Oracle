"""Clean persisted result-report likelihood values.

Revision ID: 037_clean_result_report_likelihood
Revises: 036_model_profile_native_search_upstream
Create Date: 2026-06-21
"""

from __future__ import annotations

import copy
import json
import logging
import math
from typing import Any, Sequence, Union

import sqlalchemy as sa
from pydantic import ValidationError

from alembic import context, op

revision: str = "037_clean_result_report_likelihood"
down_revision: Union[str, None] = "036_model_profile_native_search_upstream"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

log = logging.getLogger(__name__)

_BATCH_SIZE = 500


def _finite_float_or_none(value: Any) -> float | None:
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _normalize_probability(value: Any) -> float:
    number = _finite_float_or_none(value)
    if number is None:
        return 0.0
    return _clamp01(number)


def _normalize_interval(value: Any) -> list[float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return [0.0, 1.0]

    first = _finite_float_or_none(value[0])
    second = _finite_float_or_none(value[1])
    if first is None and second is None:
        return [0.0, 1.0]
    if first is None:
        first = second
    if second is None:
        second = first

    low = _clamp01(first if first is not None else 0.0)
    high = _clamp01(second if second is not None else 1.0)
    return [low, high] if low <= high else [high, low]


def _json_string_to_object(raw: str) -> dict[str, Any] | None:
    current: Any = raw
    for _attempt in range(2):
        try:
            current = json.loads(current)
        except (TypeError, json.JSONDecodeError):
            return None
        if isinstance(current, dict):
            return current
        if not isinstance(current, str):
            return None
    return None


def _context_object(raw_context: Any) -> dict[str, Any] | None:
    if isinstance(raw_context, dict):
        return copy.deepcopy(raw_context)
    if isinstance(raw_context, str):
        return _json_string_to_object(raw_context)
    return None


def _normalize_likelihood(full_report: dict[str, Any]) -> bool:
    verdict = full_report.get("verdict")
    if not isinstance(verdict, dict):
        return False
    likelihood = verdict.get("likelihood")
    if not isinstance(likelihood, dict):
        return False

    changed = False
    if "probability" in likelihood:
        normalized_probability = _normalize_probability(likelihood.get("probability"))
        if likelihood.get("probability") != normalized_probability:
            likelihood["probability"] = normalized_probability
            changed = True
    if "interval" in likelihood:
        normalized_interval = _normalize_interval(likelihood.get("interval"))
        if likelihood.get("interval") != normalized_interval:
            likelihood["interval"] = normalized_interval
            changed = True
    return changed


def _normalize_parsed_context(raw_context: Any) -> tuple[dict[str, Any] | None, bool]:
    parsed_context = _context_object(raw_context)
    if parsed_context is None or "full_report" not in parsed_context:
        return parsed_context, False

    full_report = parsed_context.get("full_report")
    if full_report is None:
        return parsed_context, False

    changed = False
    if isinstance(full_report, str):
        decoded_report = _json_string_to_object(full_report)
        if decoded_report is None:
            parsed_context["full_report"] = None
            return parsed_context, True
        full_report = decoded_report
        parsed_context["full_report"] = full_report
        changed = True
    elif not isinstance(full_report, dict):
        parsed_context["full_report"] = None
        return parsed_context, True

    changed = _normalize_likelihood(full_report) or changed

    from app.services.result_report.schema import (
        ResultReportTooLargeError,
        validate_full_report_payload,
    )

    try:
        validate_full_report_payload(full_report)
    except ResultReportTooLargeError:
        pass
    except (TypeError, ValueError, ValidationError):
        parsed_context["full_report"] = None
        changed = True

    return parsed_context, changed


def upgrade() -> None:
    if context.is_offline_mode():
        log.info("037 result-report likelihood cleanup skipped in offline SQL mode")
        return

    bind = op.get_bind()
    last_id = ""
    total_updates = 0
    while True:
        rows = bind.execute(
            sa.text(
                """
                SELECT id, parsed_context
                FROM scenario
                WHERE parsed_context IS NOT NULL
                  AND id > :last_id
                ORDER BY id
                LIMIT :limit
                """
            ),
            {"last_id": last_id, "limit": _BATCH_SIZE},
        ).mappings().all()
        if not rows:
            break

        updates: list[tuple[str, str]] = []
        for row in rows:
            scenario_id = str(row["id"])
            last_id = scenario_id
            normalized, changed = _normalize_parsed_context(row["parsed_context"])
            if not changed or normalized is None:
                continue
            updates.append(
                (
                    scenario_id,
                    json.dumps(normalized, ensure_ascii=False, separators=(",", ":")),
                )
            )

        for scenario_id, payload_json in updates:
            bind.execute(
                sa.text(
                    """
                    UPDATE scenario
                    SET parsed_context = :payload
                    WHERE id = :scenario_id
                    """
                ),
                {"scenario_id": scenario_id, "payload": payload_json},
            )
        total_updates += len(updates)

    log.info("037 result-report likelihood cleanup updated %d scenario rows", total_updates)


def downgrade() -> None:
    # Data cleanup is not reversible: the original dirty probability/interval
    # values are intentionally discarded or nulled when the report is invalid.
    pass
