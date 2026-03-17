"""SwarmOracle — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.scenarios import router as scenarios_router
from app.api.interventions import router as interventions_router
from app.api.social import router as social_router
from app.api.campaign import router as campaign_router
from app.api.predictions import router as predictions_router
from app.api.ws import router as ws_router
from app.config import settings
from app.models import init_db
from app.models.database import dispose_engine

# ── Logging ──────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
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
    dispose_engine()
    logging.getLogger(__name__).info("SwarmOracle shut down gracefully.")

# ── App ──────────────────────────────────────────────────

app = FastAPI(
    title="SwarmOracle",
    description="群体预言机 — AI 'What-If' Prediction Playground",
    version="0.1.0",
    lifespan=lifespan,
)


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
app.include_router(predictions_router)
app.include_router(ws_router)

# P3-9: Prometheus metrics (GET /metrics)
try:
    from prometheus_fastapi_instrumentator import Instrumentator
    Instrumentator().instrument(app).expose(app)
except ImportError:
    logging.getLogger(__name__).warning(
        "prometheus-fastapi-instrumentator not installed — /metrics disabled"
    )


@app.get("/")
async def root():
    return {
        "name": "SwarmOracle",
        "version": "0.1.0",
        "description": "群体预言机 — AI 'What-If' Prediction Playground",
    }
