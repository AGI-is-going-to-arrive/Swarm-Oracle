"""Durable compatibility contract for optional Agent message metadata.

``AgentMessage`` predates an explicit metadata-status column.  Until a schema
change is justified, a namespaced value in the existing ``emotion`` field is
the durable marker for a Pass-2 extraction failure.  Public projections must
decode the marker; it is never a real emotion.
"""

from __future__ import annotations

import re
from typing import Any

METADATA_UNAVAILABLE_EMOTION_PREFIX = "__swarmoracle_metadata_unavailable__:"
_FAILURE_CODE_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _field(value: object, key: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def normalize_metadata_failure_code(code: object) -> str:
    normalized = str(code or "").strip().upper()
    return normalized if _FAILURE_CODE_RE.fullmatch(normalized) else "LLM_FAILED"


def encode_metadata_unavailable_emotion(code: object) -> str:
    return METADATA_UNAVAILABLE_EMOTION_PREFIX + normalize_metadata_failure_code(code)


def metadata_failure_code_from_emotion(emotion: object) -> str | None:
    value = str(emotion or "").strip()
    if not value.startswith(METADATA_UNAVAILABLE_EMOTION_PREFIX):
        return None
    return normalize_metadata_failure_code(
        value.removeprefix(METADATA_UNAVAILABLE_EMOTION_PREFIX)
    )


def message_metadata_failure_code(message: object) -> str | None:
    private_code = _field(message, "_metadata_failure_code")
    if str(private_code or "").strip():
        return normalize_metadata_failure_code(private_code)

    public_status = str(
        _field(message, "emotion_metadata_status", "") or ""
    ).strip().lower()
    public_code = _field(message, "emotion_metadata_failure_code")
    if public_status == "unavailable" and str(public_code or "").strip():
        return normalize_metadata_failure_code(public_code)

    return metadata_failure_code_from_emotion(_field(message, "emotion", ""))


def message_emotion_if_available(message: object) -> str | None:
    if message_metadata_failure_code(message) is not None:
        return None
    value = str(_field(message, "emotion", "") or "").strip()
    return value or None


def public_emotion_metadata(message: object) -> dict[str, Any]:
    failure_code = message_metadata_failure_code(message)
    if failure_code is not None:
        return {
            "emotion": "",
            "emotion_metadata_status": "unavailable",
            "emotion_metadata_failure_code": failure_code,
        }
    return {"emotion": message_emotion_if_available(message) or ""}


def persisted_emotion_from_public_message(
    message: object,
    *,
    default: str = "neutral",
) -> str:
    failure_code = message_metadata_failure_code(message)
    if failure_code is not None:
        return encode_metadata_unavailable_emotion(failure_code)
    value = message_emotion_if_available(message)
    return value if value is not None else default
