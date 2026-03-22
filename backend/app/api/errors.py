"""Structured API error helpers."""

from __future__ import annotations

from fastapi import HTTPException


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    """Create a structured FastAPI HTTP error."""
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
        },
    )


def api_error_from_exception(status_code: int, code: str, exc: Exception) -> HTTPException:
    """Convert a domain exception into a structured API error."""
    return api_error(status_code, code, str(exc))
