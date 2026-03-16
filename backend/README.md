# SwarmOracle Backend

FastAPI + SQLModel backend for the SwarmOracle "What-If" prediction engine.

## Stack

- **FastAPI** — REST API + WebSocket
- **SQLModel** (SQLite) — ORM / persistence
- **ChromaDB** — agent memory vector store (L2)
- **Alembic** — database migrations
- **Prometheus** — observability metrics
- **OpenAI-compatible LLM** — scenario parsing, agent simulation, narration
- **Semantic scene selection** — question-first theme routing for Pixel Theater backgrounds

## Quick Start

```bash
# Create venv
python -m venv .venv && source .venv/bin/activate

# Install deps
pip install -e ".[dev]"

# Copy env
cp ../.env.example ../.env  # edit LLM_RESPONSES_URL / LLM_API_KEY

# Run
uvicorn app.main:app --reload --host 0.0.0.0 --port 18927
```

## API Modules

| Module | File | Description |
|--------|------|-------------|
| Scenarios | `api/scenarios.py` | Core CRUD routes |
| Schemas | `api/schemas.py` | Pydantic request/response models (P0-1) |
| Helpers | `api/helpers.py` | Background tasks / utility functions (P0-1) |
| Interventions | `api/interventions.py` | Butterfly Effect intervention routes (P0-1) |
| Social | `api/social.py` | Social media copy generation routes (P0-1) |
| Predictions | `api/predictions.py` | Prediction / leaderboard API (P3-B) |
| WebSocket | `api/ws.py` | Real-time simulation events |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | App info |
| `GET` | `/health` | Server + LLM health check |
| `GET` | `/metrics` | Prometheus metrics (P3-9) |
| `POST` | `/api/scenario` | Create scenario (parse + start simulation); Theater mode returns a provisional `scene_theme` immediately |
| `GET` | `/api/scenario/{id}` | Get scenario status, agents, branches, and `scene_theme` |
| `GET` | `/api/scenario/{id}/branches` | Branch tree |
| `GET` | `/api/scenario/{id}/story` | Completed branch stories |
| `GET` | `/api/scenario/{id}/agents` | Agent roster |
| `POST` | `/api/scenario/{id}/intervene` | Butterfly Effect intervention |
| `POST` | `/api/scenario/{id}/intervene/retrospective` | Retrospective intervention |
| `POST` | `/api/scenario/{id}/intervene/batch` | Batch intervention |
| `GET` | `/api/scenario/{id}/social/{platform}` | Social media copy generation |
| `GET` | `/scenarios` | List all scenarios |
| `DELETE` | `/api/scenario/{id}` | Delete scenario (cascade) |
| `GET` | `/api/scenario/{id}/export` | Export scenario as Markdown |
| `GET` | `/intervention-templates` | Preset intervention templates |
| `POST` | `/scenario/{id}/predict` | Submit prediction |
| `POST` | `/scenario/{id}/score-predictions` | Trigger LLM scoring |
| `GET` | `/leaderboard` | Global prediction leaderboard |
| `WS` | `/ws/{scenario_id}` | Real-time simulation events |

## Testing

```bash
.venv/bin/python -m pytest tests/ -v
.venv/bin/python -m pytest tests/ -x -q
```

Latest verified backend full regression: **777 passed, 2 warnings**
Command: `.venv/bin/python -m pytest tests/ -q`

Latest verified backend scene/theme regression: **201 passed**
Command: `.venv/bin/python -m pytest tests/test_scene_selector.py tests/test_simulator_viz_integration.py -q`

## Database Migrations (Alembic)

```bash
alembic revision --autogenerate -m "describe change"
alembic upgrade head
alembic current
alembic downgrade -1
```

## Environment Variables

See [`.env.example`](../.env.example) for all configuration options.
