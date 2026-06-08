"""Tests for structured logging helpers."""

from __future__ import annotations

import io
import json
import logging
import sys

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
