"""Logging helpers for backend runtime configuration."""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timezone
from decimal import Decimal
from enum import Enum
from typing import Any

from app.log_sanitize import _scrub_sensitive_text

_PLAIN_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")
_TRACE_FORMATTER = logging.Formatter()
_ORIGINAL_LOG_RECORD_FACTORY = logging.getLogRecordFactory()
_STANDARD_LOG_RECORD_FIELDS = {
    "args",
    "asctime",
    "created",
    "exc_info",
    "exc_text",
    "filename",
    "funcName",
    "levelname",
    "levelno",
    "lineno",
    "module",
    "msecs",
    "message",
    "msg",
    "name",
    "pathname",
    "process",
    "processName",
    "relativeCreated",
    "stack_info",
    "thread",
    "threadName",
    "taskName",
}


def _normalize_json_value(value: Any) -> Any:
    # Check for opaque/secret wrappers before plain str to prevent key leakage
    if hasattr(value, "__opaque__"):
        return "***"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _scrub_sensitive_text(value)
    if isinstance(value, (datetime, date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {
            _scrub_sensitive_text(str(key)): _normalize_json_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_normalize_json_value(item) for item in value]
    return _scrub_sensitive_text(repr(value))


def _sanitize_log_record(record: logging.LogRecord) -> logging.LogRecord:
    if getattr(record, "_sensitive_log_sanitized", False):
        return record

    try:
        message = record.getMessage()
    except Exception:  # pragma: no cover - defensive logging fallback
        message = str(record.msg)
    record.msg = _scrub_sensitive_text(message)
    record.args = ()

    if record.exc_info:
        try:
            record.exc_text = _scrub_sensitive_text(
                _TRACE_FORMATTER.formatException(record.exc_info)
            )
        except Exception:  # pragma: no cover - defensive logging fallback
            record.exc_text = _scrub_sensitive_text(str(record.exc_info[1]))
        record.exc_info = None
    elif record.exc_text:
        record.exc_text = _scrub_sensitive_text(record.exc_text)

    if record.stack_info:
        record.stack_info = _scrub_sensitive_text(record.stack_info)

    record._sensitive_log_sanitized = True
    return record


class SensitiveLogFilter(logging.Filter):
    """Scrub secrets from records before any handler renders them."""

    def filter(self, record: logging.LogRecord) -> bool:
        _sanitize_log_record(record)
        return True


def _sanitizing_log_record_factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
    record = _ORIGINAL_LOG_RECORD_FACTORY(*args, **kwargs)
    return _sanitize_log_record(record)


def _install_log_record_sanitizer() -> None:
    if logging.getLogRecordFactory() is not _sanitizing_log_record_factory:
        logging.setLogRecordFactory(_sanitizing_log_record_factory)


class JsonLogFormatter(logging.Formatter):
    """Emit log records as JSON for structured ingestion."""

    def format(self, record: logging.LogRecord) -> str:
        message = _scrub_sensitive_text(record.getMessage())
        payload: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": message,
            "module": record.module,
            "function": record.funcName,
            "line": record.lineno,
        }

        extras = {
            key: _normalize_json_value(value)
            for key, value in record.__dict__.items()
            if key not in _STANDARD_LOG_RECORD_FIELDS and not key.startswith("_")
        }
        if extras:
            payload["extra"] = extras

        if record.exc_info:
            payload["exception"] = _scrub_sensitive_text(
                self.formatException(record.exc_info)
            )
        elif record.exc_text:
            payload["exception"] = _scrub_sensitive_text(record.exc_text)
        if record.stack_info:
            payload["stack"] = _scrub_sensitive_text(self.formatStack(record.stack_info))

        return json.dumps(payload, ensure_ascii=False)


def configure_logging(*, level_name: str, log_format: str) -> None:
    """Configure root logging for the backend process."""
    level = getattr(logging, level_name.upper(), logging.INFO)
    _install_log_record_sanitizer()
    handler = logging.StreamHandler()
    handler.addFilter(SensitiveLogFilter())
    if log_format == "json":
        handler.setFormatter(JsonLogFormatter())
    else:
        handler.setFormatter(logging.Formatter(_PLAIN_LOG_FORMAT))

    logging.basicConfig(level=level, handlers=[handler], force=True)

    for logger_name in _UVICORN_LOGGERS:
        logger = logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(level)
