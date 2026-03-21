# SwarmOracle Backend

> 文档类型：active reference
> 当前真值：否。产品范围以仓库根 `README.md` 为准；开发与签收命令以 `llmdoc/guides/development.md` 为准。

FastAPI + SQLModel backend for SwarmOracle.

## Stack

- FastAPI
- SQLModel + SQLite
- ChromaDB
- Alembic
- Prometheus text metrics
- OpenAI-compatible LLM

## Quick Start

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 18927
```

- 本地直接启动 backend 时读取 `backend/.env`。
- `docker compose` 读取仓库根目录 `.env`。
- 若后端在容器内、LLM 服务在宿主机，`LLM_RESPONSES_URL` 应指向宿主机可达地址。

## API Modules

| Module | File | Description |
|--------|------|-------------|
| Scenarios | `app/api/scenarios.py` | Core CRUD, story, export, replay artifact, replay import |
| Campaign | `app/api/campaign.py` | finalize, profile, mastery, badges, daily-status, weekly-summary, `director-state`, `gameplay-state`, scenario summary |
| Debate | `app/api/debate.py` | Debate live/result/import-replay/predict + Debate WebSocket |
| Predictions | `app/api/predictions.py` | Scenario prediction and leaderboard |
| Interventions | `app/api/interventions.py` | Standard / retrospective / batch intervention |
| Social | `app/api/social.py` | Social media copy generation |
| WebSocket | `app/api/ws.py` | Scenario real-time events |

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Root info / process-level health |
| `GET` | `/metrics` | Prometheus text metrics or minimal fallback text |
| `POST` | `/api/scenario` | Create scenario and return placeholder state immediately |
| `GET` | `/api/scenario/{id}` | Scenario details with top-level `director_state` and `gameplay_state` |
| `POST` | `/api/scenario/import-replay` | Import scenario replay as local run |
| `POST` | `/api/replay-artifact` | Persist replay payload and return short share id |
| `GET` | `/api/replay-artifact/{id}` | Load replay payload |
| `POST` | `/api/campaign/scenario/{id}/finalize` | Finalize campaign progress |
| `GET/PUT` | `/api/campaign/scenario/{id}/director-state` | Per-scenario director authority with `revision`-based optimistic concurrency |
| `GET/PUT` | `/api/campaign/scenario/{id}/gameplay-state` | Per-scenario gameplay authority with `revision`-based optimistic concurrency |
| `GET` | `/api/campaign/scenario/{id}/summary` | Scenario campaign summary |
| `GET` | `/api/campaign/profile/{user_id}/weekly-summary` | Weekly campaign summary |
| `POST` | `/api/debate` | Create debate |
| `GET` | `/api/debate/{id}` | Debate live snapshot |
| `GET` | `/api/debate/{id}/result` | Debate result payload |
| `POST` | `/api/debate/import-replay` | Import debate replay as local run and preserve imported `phase_insights` / `adjudication_mode` |
| `WS` | `/ws/scenario/{scenario_id}` | Scenario events |
| `WS` | `/ws/debate/{debate_id}` | Debate events |

## Validation

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_campaign_api.py tests/test_campaign_service.py tests/test_debate_api.py tests/test_debate_service.py tests/test_config.py tests/test_predictions.py tests/test_card_events.py tests/test_gameplay_contract_sync.py tests/test_metrics.py -q
```

- Historical full baseline: `815 passed`.
- Current signoff backend set: `90 passed`.
- Current session backend regression pack: `269 passed`.
- Current release judgment uses targeted backend checks plus `/metrics`; detailed contract lives in `llmdoc/guides/development.md`.

## Runtime Notes

- `parser.py` uses low reasoning effort during scenario creation to shorten time-to-first-worldline.
- If parse-stage LLM JSON is still unrecoverably broken, backend now falls back to a deterministic minimal parse result instead of failing the whole scenario bootstrap immediately; fallback rounds also honor the caller-provided default round count instead of hardcoding `10`.
- `memory.py` now rolls the previous structured briefing forward into the next compression window, while keeping the current raw window verbatim.
- `social.py` now selects wrapper / prompt language by scenario language, so English scenarios no longer receive Chinese wrapper text.
- `llm_client.py` now shares pending/quota accounting across processes through SQLite when they point at the same `DATABASE_URL`, while keeping the in-process semaphore and circuit breaker.
- `shared/gameplay_contract.v1.json` now uses an mtime-aware cache and reloads after file updates without requiring a backend restart.

## Environment Variables

See `../.env.example` for the full list.
