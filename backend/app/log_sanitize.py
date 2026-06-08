"""Central log/output sanitization helpers for provider credentials."""

from __future__ import annotations

import re

_BEARER_TOKEN_RE = re.compile(r"\bbearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_API_KEY_ASSIGNMENT_RE = re.compile(
    r"[\"']?\bapi[_-]?key[\"']?\s*[:=]\s*[\"']?[^\"'\s,;)}\]]+",
    re.IGNORECASE,
)
_PROVIDER_KEY_RE = re.compile(
    r"\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})\b"
)
_LONG_SECRET_RE = re.compile(
    r"(?<![A-Za-z0-9+/=_-])"
    r"(?=[A-Za-z0-9+/=_-]{32,})"
    r"(?=(?:[A-Za-z0-9_-]*[+/=])|"
    r"(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9]))"
    r"[A-Za-z0-9+/=_-]{32,}"
    r"(?![A-Za-z0-9+/=_-])"
)
_API_KEY_MARKER_RE = re.compile(r"\bapi[_-]?key\b", re.IGNORECASE)
_URL_USERINFO_RE = re.compile(
    r"\b(https?://)(?:[^/?#\s@]+@)([^/?#\s]+)",
    re.IGNORECASE,
)


def _scrub_sensitive_text(value: str | None) -> str:
    cleaned = str(value or "")
    cleaned = _URL_USERINFO_RE.sub(r"\1\2", cleaned)
    cleaned = _BEARER_TOKEN_RE.sub("[redacted-bearer]", cleaned)
    cleaned = _API_KEY_ASSIGNMENT_RE.sub("api key [redacted]", cleaned)
    cleaned = _PROVIDER_KEY_RE.sub("[redacted-key]", cleaned)
    cleaned = _LONG_SECRET_RE.sub("[redacted-secret]", cleaned)
    return _API_KEY_MARKER_RE.sub("api key", cleaned)
