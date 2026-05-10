"""Preflight checks for admin diagnostics."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal

from sqlalchemy import text
from sqlmodel import Session

from app.config import settings
from app.models.database import get_engine
from app.services.llm_client import LLMError, llm_call
from app.services.vector_store import get_vector_store

PreflightStatus = Literal["pass", "warn", "fail"]
_PLACEHOLDER_LLM_API_KEYS = {"", "sk-12345678"}


@dataclass(frozen=True)
class PreflightCheckResult:
    name: str
    status: PreflightStatus
    message: str


def _check_sqlite() -> PreflightCheckResult:
    try:
        with Session(get_engine()) as session:
            session.exec(text("SELECT 1")).one()
    except Exception as exc:
        return PreflightCheckResult("sqlite", "fail", f"SQLite connection failed: {exc}")
    return PreflightCheckResult("sqlite", "pass", "SQLite database is reachable")


def _check_chromadb() -> PreflightCheckResult:
    try:
        health = get_vector_store().health_check()
    except Exception as exc:
        return PreflightCheckResult("chromadb", "fail", f"ChromaDB check failed: {exc}")

    status = str(health.get("status", "")).lower()
    if status == "ok":
        return PreflightCheckResult("chromadb", "pass", "ChromaDB heartbeat succeeded")
    reason = str(health.get("reason") or health)
    return PreflightCheckResult("chromadb", "fail", f"ChromaDB is not reachable: {reason}")


async def _check_llm() -> PreflightCheckResult:
    api_key = settings.LLM_API_KEY.strip()
    if api_key in _PLACEHOLDER_LLM_API_KEYS:
        return PreflightCheckResult(
            "llm",
            "warn",
            "LLM API key is not configured; connectivity test skipped",
        )

    try:
        response = await llm_call("Respond with exactly: OK", reasoning_effort="low", timeout=8.0)
    except LLMError as exc:
        return PreflightCheckResult("llm", "fail", f"LLM connectivity failed: {exc}")
    except Exception as exc:
        return PreflightCheckResult("llm", "fail", f"LLM check failed: {exc}")

    if response.strip():
        return PreflightCheckResult("llm", "pass", "LLM API responded successfully")
    return PreflightCheckResult("llm", "warn", "LLM API returned an empty response")


def _check_web_search() -> PreflightCheckResult:
    provider = settings.WEB_SEARCH_PROVIDER
    if not settings.ENABLE_WEB_SEARCH:
        return PreflightCheckResult(
            "web_search",
            "warn",
            f"Web search is disabled; configured provider is {provider}",
        )

    if provider == "searxng":
        if settings.SEARXNG_URL.strip():
            return PreflightCheckResult(
                "web_search",
                "pass",
                f"Web search is enabled with searxng at {settings.SEARXNG_URL}",
            )
        return PreflightCheckResult("web_search", "fail", "SearXNG URL is not configured")

    if provider == "native":
        return PreflightCheckResult("web_search", "pass", "Web search is enabled with native")

    if settings.WEB_SEARCH_API_KEY.strip():
        return PreflightCheckResult(
            "web_search",
            "pass",
            f"Web search is enabled with {provider}",
        )
    return PreflightCheckResult(
        "web_search",
        "fail",
        f"Web search is enabled with {provider}, but WEB_SEARCH_API_KEY is missing",
    )


def _check_cors() -> PreflightCheckResult:
    origins = [origin for origin in settings.CORS_ORIGINS if origin.strip()]
    if not origins:
        return PreflightCheckResult("cors", "fail", "CORS_ORIGINS is empty")
    if "*" in origins:
        return PreflightCheckResult(
            "cors",
            "fail",
            "CORS_ORIGINS cannot use '*' while credentialed CORS is enabled",
        )
    return PreflightCheckResult("cors", "pass", f"CORS allows {len(origins)} explicit origin(s)")


def _sqlite_path_from_url(database_url: str) -> Path | None:
    prefix = "sqlite:///"
    if not database_url.startswith(prefix):
        return None
    path_part = database_url[len(prefix):]
    if not path_part or path_part == ":memory:" or path_part.startswith("file:"):
        return None
    return Path(path_part)


def _assert_writable_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path, prefix=".preflight-", suffix=".tmp", delete=True):
        pass


def _check_volume() -> PreflightCheckResult:
    paths: list[Path] = [Path(settings.CHROMA_PERSIST_DIR)]
    db_path = _sqlite_path_from_url(settings.DATABASE_URL)
    if db_path is not None:
        paths.append(db_path.parent)

    checked: list[str] = []
    for path in paths:
        try:
            _assert_writable_dir(path)
        except Exception as exc:
            return PreflightCheckResult(
                "volume",
                "fail",
                f"Data directory is not writable: {path}: {exc}",
            )
        checked.append(str(path))

    return PreflightCheckResult(
        "volume",
        "pass",
        f"Data directories are writable: {', '.join(checked)}",
    )


async def run_preflight() -> list[PreflightCheckResult]:
    """Run all admin preflight checks."""
    sqlite, chromadb, llm, web_search, cors, volume = await asyncio.gather(
        asyncio.to_thread(_check_sqlite),
        asyncio.to_thread(_check_chromadb),
        _check_llm(),
        asyncio.to_thread(_check_web_search),
        asyncio.to_thread(_check_cors),
        asyncio.to_thread(_check_volume),
    )
    return [sqlite, chromadb, llm, web_search, cors, volume]
