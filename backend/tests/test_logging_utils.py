"""Tests for structured logging helpers."""

from __future__ import annotations

import json
import logging
import sys

from app.logging_utils import JsonLogFormatter, configure_logging


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


def test_configure_logging_uses_requested_formatter():
    root = logging.getLogger()
    uvicorn_loggers = [
        logging.getLogger("uvicorn"),
        logging.getLogger("uvicorn.error"),
        logging.getLogger("uvicorn.access"),
    ]
    old_handlers = list(root.handlers)
    old_level = root.level
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
        for logger in uvicorn_loggers:
            assert logger.handlers == []
            assert logger.propagate is True
            assert logger.level == logging.DEBUG
    finally:
        root.handlers = old_handlers
        root.setLevel(old_level)
        for logger, (handlers, level, propagate) in zip(uvicorn_loggers, old_uvicorn_states):
            logger.handlers = handlers
            logger.setLevel(level)
            logger.propagate = propagate
