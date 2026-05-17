"""SwarmOracle — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

# Phase 3: new API routers
from app.api.admin import router as admin_router
from app.api.agents import router as agents_router
from app.api.campaign import router as campaign_router
from app.api.campaign import scenario_intervention_effects_router
from app.api.conversation import router as conversation_router
from app.api.debate import router as debate_router
from app.api.debate import ws_router as debate_ws_router
from app.api.ending_rooms import (
    router as ending_rooms_router,
)
from app.api.ending_rooms import (
    ws_router as ending_rooms_ws_router,
)
from app.api.graphs import router as graphs_router
from app.api.interventions import router as interventions_router
from app.api.journal import router as journal_router
from app.api.predictions import router as predictions_router
from app.api.quota import router as quota_router
from app.api.replay_trace import router as replay_trace_router
from app.api.scenarios import router as scenarios_router
from app.api.social import router as social_router
from app.api.ws import router as ws_router
from app.config import settings
from app.logging_utils import configure_logging
from app.middleware.observability import ObservabilityMiddleware
from app.models import init_db
from app.models.database import dispose_engine
from app.services.llm_client import close_shared_async_client

# ── Logging ──────────────────────────────────────────────

configure_logging(
    level_name=settings.LOG_LEVEL,
    log_format=settings.LOG_FORMAT,
)

# ── Lifespan ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup; graceful cleanup on shutdown."""
    init_db()
    logging.getLogger(__name__).info(
        "SwarmOracle started — LLM: %s @ %s",
        settings.LLM_MODEL_NAME, settings.LLM_RESPONSES_URL,
    )
    yield
    # Graceful shutdown: cancel outstanding background tasks and dispose DB engine
    from app.api.helpers import _background_tasks
    for task in list(_background_tasks):
        task.cancel()
    await close_shared_async_client()
    dispose_engine()
    logging.getLogger(__name__).info("SwarmOracle shut down gracefully.")

# ── App ──────────────────────────────────────────────────

app = FastAPI(
    title="SwarmOracle",
    description="群体预言机 — AI 'What-If' Prediction Playground",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.EXPOSE_API_DOCS else None,
    redoc_url="/redoc" if settings.EXPOSE_API_DOCS else None,
    openapi_url="/openapi.json" if settings.EXPOSE_API_DOCS else None,
)


@app.exception_handler(Exception)
async def internal_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    logging.getLogger(__name__).exception("Unhandled application error", exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={
            "detail": {
                "code": "INTERNAL_ERROR",
                "message": "Internal server error",
            }
        },
    )


# Observability middleware (OB-1): request_id contextvar + structured JSON log.
# Must be registered BEFORE CORS so correlation spans the full request lifecycle.
app.add_middleware(ObservabilityMiddleware)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routes
app.include_router(scenarios_router)
app.include_router(interventions_router)
app.include_router(social_router)
app.include_router(campaign_router)
app.include_router(scenario_intervention_effects_router)
app.include_router(debate_router)
app.include_router(debate_ws_router)
app.include_router(ending_rooms_router)
app.include_router(ending_rooms_ws_router)
app.include_router(predictions_router)
app.include_router(journal_router)
app.include_router(ws_router)
# Phase 3
app.include_router(agents_router)
app.include_router(graphs_router)
# Layer 3: BE-3 conversation + BE-4 replay-trace (OB-1 merge hand-off)
app.include_router(conversation_router)
app.include_router(quota_router)
app.include_router(replay_trace_router)
app.include_router(admin_router)

# P3-9: Prometheus metrics (GET /metrics)
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator().instrument(app).expose(app)
except ImportError:
    logging.getLogger(__name__).warning(
        "prometheus-fastapi-instrumentator not installed — /metrics disabled"
    )

    @app.get("/metrics", include_in_schema=False)
    async def metrics_fallback():
        return PlainTextResponse(
            "\n".join([
                "# HELP swarmoracle_metrics_enabled Whether full Prometheus instrumentation is enabled.",  # noqa: E501
                "# TYPE swarmoracle_metrics_enabled gauge",
                "swarmoracle_metrics_enabled 0",
                "# HELP swarmoracle_metrics_dependency_missing Whether the optional metrics dependency is unavailable.",  # noqa: E501
                "# TYPE swarmoracle_metrics_dependency_missing gauge",
                "swarmoracle_metrics_dependency_missing 1",
                "",
            ])
        )


@app.get("/")
async def root():
    return {
        "name": "SwarmOracle",
        "version": "0.1.0",
        "description": "群体预言机 — AI 'What-If' Prediction Playground",
    }
