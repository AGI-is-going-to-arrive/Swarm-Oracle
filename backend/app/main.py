"""SwarmOracle — FastAPI application entry point."""

from __future__ import annotations

import asyncio
import hmac
import logging
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
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
from app.api.experiments import router as experiments_router
from app.api.graphs import (
    pending_replay_branch_memory_cleanup_count,
    reconcile_pending_replay_branch_memory_cleanups,
)
from app.api.graphs import router as graphs_router
from app.api.interventions import router as interventions_router
from app.api.journal import router as journal_router
from app.api.model_profiles import router as model_profiles_router
from app.api.packs import router as packs_router
from app.api.predictions import router as predictions_router
from app.api.quota import router as quota_router
from app.api.replay_trace import router as replay_trace_router
from app.api.scenarios import router as scenarios_router
from app.api.social import router as social_router
from app.api.ws import router as ws_router
from app.config import settings, validate_secure_runtime_settings
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

_REPLAY_MEMORY_CLEANUP_RETRY_DELAYS_SECONDS = (1.0, 5.0, 30.0)


async def _retry_pending_replay_branch_memory_cleanups(
    *,
    delays: tuple[float, ...] = _REPLAY_MEMORY_CLEANUP_RETRY_DELAYS_SECONDS,
    reconcile: Callable[[], int] = reconcile_pending_replay_branch_memory_cleanups,
    pending_count: Callable[[], int] = pending_replay_branch_memory_cleanup_count,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
    stop_event: asyncio.Event | None = None,
) -> None:
    """Retry transient Chroma cleanup failures without blocking app startup."""
    for delay in delays:
        if stop_event is not None and stop_event.is_set():
            return
        try:
            if await asyncio.to_thread(pending_count) == 0:
                return
        except Exception:  # noqa: BLE001 - retry loop must remain non-fatal
            logging.getLogger(__name__).exception(
                "Replay-memory pending-count check failed (non-fatal)"
            )
        if stop_event is None:
            await sleep(delay)
        else:
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=delay)
            except TimeoutError:
                pass
            else:
                return
        try:
            cleaned = await asyncio.to_thread(reconcile)
            logging.getLogger(__name__).info(
                "Replay-memory retry sweep: %d pending branch cleanup(s) completed",
                cleaned,
            )
        except Exception:  # noqa: BLE001 - retry loop must remain non-fatal
            logging.getLogger(__name__).exception(
                "Replay-memory retry sweep failed (non-fatal)"
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup; graceful cleanup on shutdown."""
    validate_secure_runtime_settings(settings)
    init_db()
    from app.services.resource_deletion import (
        resource_worker_context,
        retry_pending_resource_deletions,
        stop_resource_writes,
        wait_for_resource_writers,
    )

    resource_cleanup_stop = asyncio.Event()
    resource_cleanup_task = asyncio.create_task(
        retry_pending_resource_deletions(resource_cleanup_stop),
        name="resource-deletion-cleanup",
        context=resource_worker_context(),
    )
    # Startup orphan sweep: finalize scenarios left SIMULATING/NARRATING by a process
    # that died mid-run (--reload, SIGKILL, crash, deploy). Wrapped so a sweep failure
    # never blocks startup. Single-worker uvicorn => no single-flight lock needed.
    try:
        from app.models.database import get_engine
        from app.services.simulator import reconcile_orphaned_running_scenarios

        orphaned_errored = reconcile_orphaned_running_scenarios(get_engine())
        logging.getLogger(__name__).info(
            "Startup orphan sweep: %d stale scenario(s) marked ERROR", orphaned_errored
        )
    except Exception:  # noqa: BLE001 - sweep is best-effort; never block startup
        logging.getLogger(__name__).exception("Startup orphan sweep failed (non-fatal)")
    try:
        from app.models.database import get_engine
        from app.services.debate import reconcile_orphaned_live_debates

        orphaned_debates = reconcile_orphaned_live_debates(get_engine())
        logging.getLogger(__name__).info(
            "Startup debate orphan sweep: %d stale debate(s) marked ERROR",
            orphaned_debates,
        )
    except Exception:  # noqa: BLE001 - sweep is best-effort; never block startup
        logging.getLogger(__name__).exception(
            "Startup debate orphan sweep failed (non-fatal)"
        )
    try:
        from app.services.runtime_lock import reconcile_orphaned_report_locks

        cleared_report_locks = reconcile_orphaned_report_locks()
        logging.getLogger(__name__).info(
            "Startup report-lock sweep: %d orphaned report lock(s) cleared",
            cleared_report_locks,
        )
    except Exception:  # noqa: BLE001 - sweep is best-effort; never block startup
        logging.getLogger(__name__).exception(
            "Startup report-lock sweep failed (non-fatal)"
        )
    replay_memory_cleanup_retry_task: asyncio.Task[None] | None = None
    replay_memory_cleanup_stop_event = asyncio.Event()
    try:
        cleaned_branch_memories = reconcile_pending_replay_branch_memory_cleanups()
        pending_branch_memories = pending_replay_branch_memory_cleanup_count()
        logging.getLogger(__name__).info(
            "Startup replay-memory sweep: %d completed, %d still pending",
            cleaned_branch_memories,
            pending_branch_memories,
        )
        if pending_branch_memories:
            replay_memory_cleanup_retry_task = asyncio.create_task(
                _retry_pending_replay_branch_memory_cleanups(
                    stop_event=replay_memory_cleanup_stop_event,
                ),
                name="replay-memory-cleanup-retry",
            )
    except Exception:  # noqa: BLE001 - sweep is best-effort; never block startup
        logging.getLogger(__name__).exception(
            "Startup replay-memory sweep failed (non-fatal)"
        )
        replay_memory_cleanup_retry_task = asyncio.create_task(
            _retry_pending_replay_branch_memory_cleanups(
                stop_event=replay_memory_cleanup_stop_event,
            ),
            name="replay-memory-cleanup-retry",
        )
    logging.getLogger(__name__).info(
        "SwarmOracle started — LLM: %s @ %s",
        settings.LLM_MODEL_NAME, settings.LLM_RESPONSES_URL,
    )
    yield
    stop_resource_writes()
    resource_cleanup_stop.set()
    done, _ = await asyncio.wait({resource_cleanup_task}, timeout=5.0)
    if not done:
        resource_cleanup_task.cancel()
        # The native writer retains its OS barrier until it actually returns.
        # A pending receipt survives and no late DB commit is admitted.
    await asyncio.to_thread(wait_for_resource_writers, 5.0)
    replay_memory_cleanup_stop_event.set()
    if replay_memory_cleanup_retry_task is not None:
        # asyncio cancellation cannot stop a running to_thread worker. Await the
        # cooperative task before disposing the DB so no cleanup can resurrect
        # the engine or mutate state after shutdown.
        await replay_memory_cleanup_retry_task
    # Graceful shutdown: cancel outstanding background tasks and dispose DB engine
    from app.api.helpers import shutdown_background_tasks
    await shutdown_background_tasks(reason="app_shutdown")
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


@app.middleware("http")
async def metrics_auth_middleware(request: Request, call_next):
    if request.url.path != "/metrics":
        return await call_next(request)

    configured_admin_token = settings.ADMIN_TOKEN.strip()
    provided_admin_token = request.headers.get("X-Admin-Token", "").strip()
    if configured_admin_token and hmac.compare_digest(
        provided_admin_token,
        configured_admin_token,
    ):
        return await call_next(request)

    if settings.SESSION_SECRET.strip():
        from app.api.helpers import verify_session

        try:
            await verify_session(request)
        except HTTPException as exc:
            return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
        return await call_next(request)

    if configured_admin_token:
        return JSONResponse(
            status_code=403,
            content={
                "detail": {
                    "code": "ADMIN_TOKEN_REQUIRED",
                    "message": "Metrics require a valid X-Admin-Token header",
                }
            },
        )

    return await call_next(request)

# Routes
app.include_router(scenarios_router)
app.include_router(interventions_router)
app.include_router(social_router)
app.include_router(campaign_router)
app.include_router(scenario_intervention_effects_router)
app.include_router(debate_router)
app.include_router(experiments_router)
app.include_router(debate_ws_router)
app.include_router(ending_rooms_router)
app.include_router(ending_rooms_ws_router)
app.include_router(predictions_router)
app.include_router(journal_router)
app.include_router(model_profiles_router)
app.include_router(packs_router)
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
