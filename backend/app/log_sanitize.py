"""Central log/output sanitization helpers for provider credentials."""

from __future__ import annotations

import re

_BEARER_TOKEN_RE = re.compile(r"\bbearer\s+[A-Za-z0-9._~+/=-]+", re.IGNORECASE)
_BASIC_AUTH_RE = re.compile(
    r"\bauthorization\s*[:=]\s*basic\s+[A-Za-z0-9+/=_-]+",
    re.IGNORECASE,
)
_CREDENTIAL_VALUE_PATTERN = (
    r'(?:"(?:\\.|[^"\\\r\n])*"|'
    r"'(?:\\.|[^'\\\r\n])*'|"
    r"\[redacted(?:-[a-z-]+)?\]|\*{4}|[^\s,;)}\]]+)"
)
_API_KEY_ASSIGNMENT_RE = re.compile(
    rf"(?P<label>[\"']?\bapi[-_ ]?key[\"']?\s*[:=]\s*)"
    rf"(?P<value>{_CREDENTIAL_VALUE_PATTERN})",
    re.IGNORECASE,
)
_LABELED_CREDENTIAL_ASSIGNMENT_RE = re.compile(
    r"(?P<label>[\"']?\b(?:access[_-]?token|refresh[_-]?token|token|password|passwd|"
    r"client[_-]?secret|private[_-]?key|secret)[\"']?\s*[:=]\s*)"
    rf"(?P<value>{_CREDENTIAL_VALUE_PATTERN})",
    re.IGNORECASE,
)
_PROVIDER_KEY_RE = re.compile(
    r"\b(?:sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|xai-[A-Za-z0-9_-]{6,})\b"
)
_UNLABELLED_CREDENTIAL_RE = re.compile(
    r"(?<![A-Za-z0-9_])(?:gh[pous]_[A-Za-z0-9_]{20,}|"
    r"github_pat_[A-Za-z0-9_]{20,})(?![A-Za-z0-9_])|"
    r"\bAKIA[0-9A-Z]{16}\b|"
    r"(?<![A-Za-z0-9-])xox[bp]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])|"
    r"(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])|"
    r"(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])"
)
_LONG_SECRET_RE = re.compile(
    r"(?<![A-Za-z0-9+/=_-])"
    r"(?=[A-Za-z0-9+/=_-]{32,})"
    r"(?=(?:[A-Za-z0-9_-]*[+/=])|"
    r"(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[0-9]))"
    r"[A-Za-z0-9+/=_-]{32,}"
    r"(?![A-Za-z0-9+/=_-])"
)
_API_KEY_MARKER_RE = re.compile(r"\bapi[-_ ]?key\b", re.IGNORECASE)
_REDACTED_CREDENTIAL_VALUE_RE = re.compile(
    r"(?:\*{4}|\[redacted(?:-[a-z-]+)?\])",
    re.IGNORECASE,
)
_URL_USERINFO_RE = re.compile(
    r"\b(https?://)(?:[^/?#\s@]+@)([^/?#\s]+)",
    re.IGNORECASE,
)


def _scrub_unlabelled_credentials(value: str) -> str:
    return _UNLABELLED_CREDENTIAL_RE.sub("[redacted-key]", value)


def _credential_value_is_already_redacted(value: str) -> bool:
    candidate = value.strip()
    if len(candidate) >= 2 and candidate[0] == candidate[-1] and candidate[0] in "\"'":
        candidate = candidate[1:-1]
    return _REDACTED_CREDENTIAL_VALUE_RE.fullmatch(candidate) is not None


def _redact_labeled_credential(match: re.Match[str]) -> str:
    if _credential_value_is_already_redacted(match.group("value")):
        return match.group(0)
    return f"{match.group('label')}[redacted]"


def _redact_api_key_assignment(match: re.Match[str]) -> str:
    if _credential_value_is_already_redacted(match.group("value")):
        return match.group(0)
    return "api key [redacted]"


def _scrub_labeled_credentials(value: str) -> str:
    return _LABELED_CREDENTIAL_ASSIGNMENT_RE.sub(_redact_labeled_credential, value)


def _scrub_basic_auth_credentials(value: str) -> str:
    return _BASIC_AUTH_RE.sub("[redacted-basic-auth]", value)


def _scrub_sensitive_text(value: str | None) -> str:
    cleaned = str(value or "")
    cleaned = _URL_USERINFO_RE.sub(r"\1\2", cleaned)
    cleaned = _BEARER_TOKEN_RE.sub("[redacted-bearer]", cleaned)
    cleaned = _scrub_basic_auth_credentials(cleaned)
    cleaned = _API_KEY_ASSIGNMENT_RE.sub(_redact_api_key_assignment, cleaned)
    cleaned = _PROVIDER_KEY_RE.sub("[redacted-key]", cleaned)
    cleaned = _scrub_unlabelled_credentials(cleaned)
    cleaned = _LONG_SECRET_RE.sub("[redacted-secret]", cleaned)
    cleaned = _scrub_labeled_credentials(cleaned)
    return _API_KEY_MARKER_RE.sub("api key", cleaned)
