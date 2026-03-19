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

If the backend runs in Docker but the LLM server runs on the host machine,
set `LLM_RESPONSES_URL=http://host.docker.internal:8318/v1/chat/completions`
in the root `.env` before `docker compose up --build`. On Linux, use an
actual host-reachable address instead of `host.docker.internal`.

## API Modules

| Module | File | Description |
|--------|------|-------------|
| Scenarios | `api/scenarios.py` | Core CRUD routes |
| Schemas | `api/schemas.py` | Pydantic request/response models (P0-1) |
| Helpers | `api/helpers.py` | Background tasks / utility functions (P0-1) |
| Interventions | `api/interventions.py` | Butterfly Effect intervention routes (P0-1) |
| Social | `api/social.py` | Social media copy generation routes (P0-1) |
| Campaign | `api/campaign.py` | Director campaign finalize / profile / mastery / badges / daily-status plus per-scenario `director-state` read/write (Track A / Phase A1 + A3) |
| Predictions | `api/predictions.py` | Prediction / leaderboard API (P3-B) |
| WebSocket | `api/ws.py` | Real-time simulation events |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | App info and process-level health endpoint |
| `POST` | `/api/health` | Server + LLM health check |
| `POST` | `/api/health/test` | BYOK-aware LLM connectivity test |
| `GET` | `/metrics` | Prometheus metrics (P3-9) |
| `POST` | `/api/scenario` | Create scenario (parse + start simulation); Theater mode returns a provisional `scene_theme` immediately |
| `GET` | `/api/scenario/{id}` | Get scenario status, agents, branches, `scene_theme`, and top-level `director_state` |
| `GET` | `/api/scenario/{id}/branches` | Branch tree |
| `GET` | `/api/scenario/{id}/story` | Completed branch stories |
| `GET` | `/api/scenario/{id}/agents` | Agent roster |
| `POST` | `/api/scenario/{id}/intervene` | Butterfly Effect intervention |
| `POST` | `/api/scenario/{id}/intervene/retrospective` | Retrospective intervention |
| `POST` | `/api/scenario/{id}/intervene/batch` | Batch intervention |
| `GET` | `/api/scenario/{id}/social/{platform}` | Social media copy generation |
| `GET` | `/api/scenarios` | List all scenarios |
| `DELETE` | `/api/scenario/{id}` | Delete scenario (cascade) |
| `GET` | `/api/scenario/{id}/export` | Export scenario as Markdown |
| `GET` | `/api/intervention-templates` | Preset intervention templates |
| `POST` | `/api/campaign/scenario/{scenario_id}/finalize` | Finalize director campaign progress for one completed scenario |
| `GET` | `/api/campaign/scenario/{scenario_id}/director-state` | Get per-scenario director goals / commitment authority state |
| `PUT` | `/api/campaign/scenario/{scenario_id}/director-state` | Persist per-scenario director goals / commitment authority state |
| `GET` | `/api/campaign/profile/{user_id}` | Director campaign profile summary |
| `GET` | `/api/campaign/profile/{user_id}/mastery` | Per-profile mastery list |
| `GET` | `/api/campaign/profile/{user_id}/badges` | Unlocked campaign badges |
| `GET` | `/api/campaign/profile/{user_id}/daily-status` | Daily challenge completion status for one profile on the caller's local day |
| `POST` | `/api/scenario/{id}/predict` | Submit prediction |
| `GET` | `/api/scenario/{id}/predictions` | List predictions for a scenario |
| `POST` | `/api/scenario/{id}/score-predictions` | Trigger LLM scoring |
| `GET` | `/api/leaderboard` | Global prediction leaderboard |
| `POST` | `/api/debate` | Create Debate Arena and return live snapshot immediately |
| `GET` | `/api/debate/{id}` | Get Debate live snapshot; now includes top-level `counterplay` when present |
| `GET` | `/api/debate/{id}/result` | Get Debate result payload; includes top-level `counterplay`, `predictions[]`, structured `judge_rationale`, and key `supporting_turns` used by the result UI / automation layer |
| `POST` | `/api/debate/{id}/predict` | Submit Debate structured bet; when `is_counterplay=true`, the backend now records dedicated counterplay metadata and keeps prediction scoring compatible |
| `WS` | `/ws/scenario/{scenario_id}` | Real-time simulation events |
| `WS` | `/ws/debate/{debate_id}` | Debate live events (`status / agent_speak / debate_phase_change / debate_score_update / debate_counterplay / debate_verdict`) |

## Testing

```bash
.venv/bin/python -m pytest tests/ -v
.venv/bin/python -m pytest tests/ -x -q
```

Historical recorded backend full regression: **798 passed, 2 warnings**
Command: `.venv/bin/python -m pytest tests/ -q`

Historical recorded backend scene/theme regression: **144 passed**
Command: `.venv/bin/python -m pytest tests/test_scene_selector.py -q`

Historical recorded campaign / gameplay contract regression: **151 passed**
Command: `.venv/bin/python -m pytest tests/test_campaign_service.py tests/test_campaign_api.py tests/test_scene_selector.py tests/test_gameplay_contract_sync.py -q`

Historical recorded Track C scene/theme + sample-matrix regression: **146 passed**
Command: `.venv/bin/python -m pytest tests/test_scene_selector.py tests/test_e2e_sample_matrix.py -q`

Historical recorded Debate counterplay backend regression: **11 passed**
Command: `.venv/bin/python -m pytest tests/test_debate_api.py tests/test_debate_service.py -q`

Latest verified director-state backendization regression in this session: **17 passed**
Command: `.venv/bin/python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py -q`

Latest verified Debate judge-rationale / supporting-turn regression in this session: **14 passed**
Command: `.venv/bin/python -m pytest tests/test_debate_prompts.py tests/test_debate_service.py tests/test_debate_api.py -q`

## Database Migrations (Alembic)

```bash
alembic revision --autogenerate -m "describe change"
alembic upgrade head
alembic current
alembic downgrade -1
```

## Environment Variables

See [`.env.example`](../.env.example) for all configuration options.
