"""Tests for structured logging helpers."""

from __future__ import annotations

import io
import json
import logging
import sys

import pytest

from app.log_sanitize import _scrub_sensitive_text
from app.logging_utils import JsonLogFormatter, SensitiveLogFilter, configure_logging


def test_json_log_formatter_outputs_structured_payload():
    logger = logging.getLogger("test.logging")
    record = logger.makeRecord(
        name="test.logging",
        level=logging.INFO,
        fn=__file__,
        lno=42,
        msg="hello %s",
        args=("world",),
        exc_info=None,
        extra={"request_id": "req-1"},
    )

    payload = json.loads(JsonLogFormatter().format(record))

    assert payload["level"] == "INFO"
    assert payload["logger"] == "test.logging"
    assert payload["message"] == "hello world"
    assert payload["line"] == 42
    assert payload["extra"]["request_id"] == "req-1"


def test_json_log_formatter_includes_exception_text():
    logger = logging.getLogger("test.logging")
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        record = logger.makeRecord(
            name="test.logging",
            level=logging.ERROR,
            fn=__file__,
            lno=99,
            msg="failed",
            args=(),
            exc_info=sys.exc_info(),
        )

    payload = json.loads(JsonLogFormatter().format(record))

    assert payload["level"] == "ERROR"
    assert payload["message"] == "failed"
    assert "RuntimeError: boom" in payload["exception"]


def test_json_log_formatter_scrubs_message_and_exception_secrets():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonLogFormatter())
    handler.addFilter(SensitiveLogFilter())
    logger = logging.getLogger("test.logging.sensitive")
    old_handlers = list(logger.handlers)
    old_level = logger.level
    old_propagate = logger.propagate
    raw_key = "sk-sensitive-abcdef123456"
    raw_bearer = "Bearer abcdefghijklmnopqrstuvwxyz0123456789"
    raw_url = "https://user:pass@example.test/v1"
    raw_secret = "QWxhZGRpbjpvcGVuIHNlc2FtZTEyMzQ1Njc4OTA="
    try:
        logger.handlers = [handler]
        logger.setLevel(logging.ERROR)
        logger.propagate = False

        try:
            raise RuntimeError(
                f"upstream failed api_key={raw_key} Authorization: {raw_bearer} "
                f"{raw_url} token={raw_secret}"
            )
        except RuntimeError:
            logger.error(
                "request failed api_key=%s Authorization: %s url=%s secret=%s",
                raw_key,
                raw_bearer,
                raw_url,
                raw_secret,
                exc_info=True,
            )
    finally:
        logger.handlers = old_handlers
        logger.setLevel(old_level)
        logger.propagate = old_propagate

    output = stream.getvalue()
    payload = json.loads(output)

    for raw in (raw_key, raw_bearer, raw_url, raw_secret):
        assert raw not in output
    assert "RuntimeError" in payload["exception"]
    assert "api key [redacted]" in payload["message"]
    assert "[redacted-bearer]" in payload["message"]
    assert "https://example.test/v1" in payload["message"]
    assert "[redacted-secret]" in payload["message"]
    assert "api key [redacted]" in payload["exception"]
    assert "[redacted-bearer]" in payload["exception"]
    assert "https://example.test/v1" in payload["exception"]
    assert "[redacted-secret]" in payload["exception"]


def test_json_log_formatter_scrubs_nested_sensitive_extra_values():
    secrets = {
        "access_token": "abc123secret",
        "password": "hunter2",
        "api_key": "tiny-key",
        "Authorization": "Basic dXNlcjpwYXNz",
    }
    logger = logging.getLogger("test.logging.structured-secrets")
    record = logger.makeRecord(
        name=logger.name,
        level=logging.ERROR,
        fn=__file__,
        lno=112,
        msg="provider failed",
        args=(),
        exc_info=None,
        extra={
            "provider": {**secrets, "safe_label": "keep-me"},
            "refresh_token": "top-level-secret",
        },
    )

    output = JsonLogFormatter().format(record)
    payload = json.loads(output)

    for secret in secrets.values():
        assert secret not in output
    assert "top-level-secret" not in output
    assert payload["extra"]["refresh_token"] == "[redacted-credential]"
    assert payload["extra"]["provider"]["safe_label"] == "keep-me"
    assert set(payload["extra"]["provider"].values()) == {
        "[redacted-credential]",
        "keep-me",
    }


@pytest.mark.parametrize(
    "raw_token",
    [
        "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890abcd",
        "github_pat_" + "11abcdefghijklmnopqrstuvwxyzABCDE12345",
        "AKIA" + "1234567890ABCDEF",
        "xoxb-" + "123456789012-abcdefghijklmnop",
        "glpat-" + "abcdefghijklmnopqrst",
        "AIza" + ("A" * 35),
    ],
)
def test_scrub_sensitive_text_redacts_unlabelled_provider_credentials(raw_token):
    cleaned = _scrub_sensitive_text(f"upstream rejected {raw_token} during probe")

    assert raw_token not in cleaned
    assert "[redacted-key]" in cleaned


@pytest.mark.parametrize(
    "safe_text",
    [
        "ghprevious and github_patience are ordinary prose.",
        "akiapola and AKIA-short labels should stay readable.",
        "xoxb-team and xoxp-user are short labels, not tokens.",
        "glpat-lab is a mnemonic in this sentence.",
        "Aizawa wrote that AIza is only a prefix here.",
    ],
)
def test_scrub_sensitive_text_preserves_credential_prefix_near_misses(safe_text):
    assert _scrub_sensitive_text(safe_text) == safe_text


@pytest.mark.parametrize(
    "credential",
    [
        "access_token=abc123secret",
        "refresh-token: short-refresh",
        "password=hunter2",
        "client_secret='tiny-secret'",
    ],
)
def test_scrub_sensitive_text_redacts_short_labeled_credentials(credential):
    cleaned = _scrub_sensitive_text(f"provider returned {credential}")

    assert credential.split("=", 1)[-1].split(":", 1)[-1].strip(" '") not in cleaned
    assert "redacted" in cleaned


@pytest.mark.parametrize(
    ("credential", "secret"),
    [
        ('password="two words, still secret"', "two words, still secret"),
        ("client_secret='tiny secret,with comma'", "tiny secret,with comma"),
    ],
)
def test_scrub_sensitive_text_redacts_complete_quoted_credentials(
    credential,
    secret,
):
    cleaned = _scrub_sensitive_text(f"provider returned {credential}")

    assert secret not in cleaned
    assert "redacted" in cleaned


@pytest.mark.parametrize(
    ("credential", "secret"),
    [
        ("token=abc123secret", "abc123secret"),
        ("API key=abc123secret", "abc123secret"),
        ("Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"),
    ],
)
def test_scrub_sensitive_text_redacts_short_generic_auth_credentials(
    credential, secret
):
    cleaned = _scrub_sensitive_text(f"provider returned {credential}")

    assert secret not in cleaned
    assert "redacted" in cleaned


def test_scrub_sensitive_text_preserves_basic_authentication_prose():
    message = "Basic authentication is disabled for this provider."

    assert _scrub_sensitive_text(message) == message


def test_json_log_formatter_preserves_benign_hex_request_id():
    logger = logging.getLogger("test.logging")
    request_id = "a15e3132869f4616b736d0d20b3c6ab7"
    record = logger.makeRecord(
        name="test.logging",
        level=logging.INFO,
        fn=__file__,
        lno=101,
        msg="request %s",
        args=(request_id,),
        exc_info=None,
        extra={"request_id": request_id},
    )

    payload = json.loads(JsonLogFormatter().format(record))

    assert payload["message"] == f"request {request_id}"
    assert payload["extra"]["request_id"] == request_id


def test_configure_logging_uses_requested_formatter():
    root = logging.getLogger()
    uvicorn_loggers = [
        logging.getLogger("uvicorn"),
        logging.getLogger("uvicorn.error"),
        logging.getLogger("uvicorn.access"),
    ]
    old_handlers = list(root.handlers)
    old_level = root.level
    old_factory = logging.getLogRecordFactory()
    old_uvicorn_states = [
        (list(logger.handlers), logger.level, logger.propagate)
        for logger in uvicorn_loggers
    ]
    try:
        for logger in uvicorn_loggers:
            logger.handlers = [logging.NullHandler()]
            logger.propagate = False
            logger.setLevel(logging.WARNING)

        configure_logging(level_name="DEBUG", log_format="json")
        assert root.level == logging.DEBUG
        assert isinstance(root.handlers[0].formatter, JsonLogFormatter)
        assert any(isinstance(item, SensitiveLogFilter) for item in root.handlers[0].filters)
        for logger in uvicorn_loggers:
            assert logger.handlers == []
            assert logger.propagate is True
            assert logger.level == logging.DEBUG
    finally:
        root.handlers = old_handlers
        root.setLevel(old_level)
        logging.setLogRecordFactory(old_factory)
        for logger, (handlers, level, propagate) in zip(uvicorn_loggers, old_uvicorn_states):
            logger.handlers = handlers
            logger.setLevel(level)
            logger.propagate = propagate
