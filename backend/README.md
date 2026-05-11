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
- `docker compose` 读取仓库根目录 `.env.docker`。
- 若后端在容器内、LLM 服务在宿主机，`LLM_RESPONSES_URL` 应指向宿主机可达地址。

## API Modules

| Module | File | Description |
|--------|------|-------------|
| Scenarios | `app/api/scenarios.py` | Core CRUD, story, export, replay artifact, replay import, snapshot export/import |
| Admin | `app/api/admin.py` | Preflight diagnostics and `/admin/setup` LLM connection test endpoints |
| Agents | `app/api/agents.py` | custom Agent library/workshop, favorites, identity inspector, document import, persona export/import |
| Quota | `app/api/quota.py` | Conversation and replay quota summary |
| Campaign | `app/api/campaign.py` | finalize, profile, mastery, badges, daily-status, weekly-summary, `director-state`, `gameplay-state`, scenario summary |
| Conversation | `app/api/conversation.py` | Node conversation thread/start/get/turn/abort with SSE assistant streaming |
| Debate | `app/api/debate.py` | Debate live/result/import-replay/predict + Debate WebSocket |
| Ending Room | `app/api/ending_rooms.py` | Oracle Chambers / roundtable room、thread、user-turn、result 与 ending-room WebSocket |
| Journal | `app/api/journal.py` | Personal prediction journal create/list/resolve and calibration data |
| Predictions | `app/api/predictions.py` | Scenario prediction and leaderboard |
| Interventions | `app/api/interventions.py` | Standard / retrospective / batch intervention |
| Social | `app/api/social.py` | Social media copy generation |
| WebSocket | `app/api/ws.py` | Scenario real-time events + thread-scoped agent-conversation WebSocket |

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Root info / process-level health |
| `GET` | `/metrics` | Prometheus text metrics or minimal fallback text |
| `POST` | `/api/scenario` | Create scenario and return placeholder state immediately |
| `GET` | `/api/scenario/{id}` | Scenario details with top-level `director_state` and `gameplay_state` |
| `POST` | `/api/scenario/{id}/cancel` | Request cancellation for a parsing/simulating/narrating scenario |
| `GET` | `/api/scenario/{id}/conversations` | List scenario conversation thread summaries with cursor pagination |
| `POST` | `/api/scenario/import-replay` | Import scenario replay as local run |
| `GET` | `/api/scenario/{id}/snapshot` | Export a feature-gated scenario ZIP snapshot |
| `POST` | `/api/scenario/import-snapshot` | Import a checked ZIP snapshot as a new local run |
| `GET` | `/api/scenario/{id}/personality-drift` | Return feature-gated personality drift warning data |
| `GET` | `/api/quota/summary` | Conversation/replay quota summary for UI quota badges |
| `GET` | `/api/admin/preflight` | SQLite/ChromaDB/LLM/web search/CORS/volume diagnostics |
| `POST` | `/api/admin/test-llm` | Request-scoped LLM connection test for setup wizard |
| `GET` | `/api/agents/identities` | List generated/custom Agent identities visible to the current user |
| `POST` | `/api/agents/workshop` | Create a custom Agent with persona, domains, tier and decision bias |
| `POST` | `/api/agents/from-document` | Create custom Agents from a bounded PDF upload |
| `POST` | `/api/agents/import` | Import persona JSON as a new custom Agent |
| `GET` | `/api/agents/identities/{id}/memories` | Read-only identity memory inspector |
| `POST` | `/api/replay-artifact` | Persist replay payload and return short share id |
| `GET` | `/api/replay-artifact/{id}` | Load replay payload |
| `GET/POST` | `/api/me/journal` | List or create personal prediction journal entries |
| `PATCH` | `/api/me/journal/{entry_id}/resolve` | Resolve one owned journal entry |
| `GET` | `/api/me/calibration` | Return current-user calibration data |
| `POST` | `/api/campaign/scenario/{id}/finalize` | Finalize campaign progress |
| `GET/PUT` | `/api/campaign/scenario/{id}/director-state` | Per-scenario director authority with `revision`-based optimistic concurrency |
| `GET/PUT` | `/api/campaign/scenario/{id}/gameplay-state` | Per-scenario gameplay authority with `revision`-based optimistic concurrency |
| `GET` | `/api/campaign/scenario/{id}/summary` | Scenario campaign summary |
| `GET` | `/api/campaign/profile/{user_id}/weekly-summary` | Weekly campaign summary |
| `POST` | `/api/debate` | Create debate |
| `GET` | `/api/debate/{id}` | Debate live snapshot |
| `GET` | `/api/debate/{id}/result` | Debate result payload |
| `POST` | `/api/debate/import-replay` | Import debate replay as local run and preserve imported `phase_insights` / `adjudication_mode` |
| `POST` | `/api/conversation/start` | Create a node conversation thread with the first user turn plus a reserved assistant turn |
| `POST` | `/api/conversation/{thread_id}/turn` | Claim or append an assistant turn and stream it back over SSE |
| `WS` | `/ws/agent-conversation/{thread_id}` | Thread-scoped node conversation events with the shared first-frame auth contract |
| `WS` | `/ws/scenario/{scenario_id}` | Scenario events |
| `WS` | `/ws/debate/{debate_id}` | Debate events |

## Validation

```bash
cd backend
source .venv/bin/activate
python -m pytest tests/test_session_auth.py tests/test_ending_room_service.py tests/test_llm_client.py tests/test_web_context.py tests/test_api.py -q
```

- Latest local backend verification for the current Sprint 5-6 hardening:
  - `ruff check app tests`: pass
  - `python -m pytest -q --tb=short`: `2749 passed, 2 skipped`
  - touched-file backend rerun: `314 passed`
  - cancel / journal / snapshot / leaderboard segment focused rerun: `84 passed`
  - prediction API regression rerun: `48 passed`
  - new red-to-green finding tests: `12 passed`
- Current release judgment still lives in `llmdoc/guides/development.md`; this file only keeps the latest backend headline.

## Runtime Notes

- `parser.py` uses low reasoning effort during scenario creation to shorten time-to-first-worldline.
- If parse-stage LLM JSON is unrecoverably broken, or the model returns a structurally incomplete payload, backend now falls back to a deterministic minimal parse result instead of failing the whole scenario bootstrap immediately; fallback rounds also honor the caller-provided default round count instead of hardcoding `10`.
- `memory.py` now uses a two-stage rolling compaction path: long windows first summarize older dialogue into a bounded overflow briefing, then merge that briefing with the most recent raw window for the final summary. The older slice now also keeps high-signal lines first (`CORE/LEADER`, `emotion/diverge`, intervention / gameplay card / betting / fork / result markers) instead of relying on naive head-tail truncation.
- `memory.py` and `narrator.py` now honor in-memory BYOK overrides from the simulation pipeline; credentials still stay in memory and are not persisted into scenario records.
- `narrator.py` now wraps branch title / participant summary / raw rounds in the same untrusted-data guardrail style already used by other prompt builders.
- `social.py` now selects wrapper / prompt language by scenario language, so English scenarios no longer receive Chinese wrapper text.
- `social.py` still exposes both `GET` and `POST`, but provider overrides now must be sent in the `POST` body; `GET` query overrides are rejected to avoid leaking them into URLs.
- `llm_client.py` now shares pending/quota accounting across processes through SQLite when they point at the same `DATABASE_URL`, while keeping the in-process semaphore and circuit breaker.
- Backend logging now defaults to structured JSON; `uvicorn`, `uvicorn.error`, and `uvicorn.access` are aligned to the same root formatter. `LOG_LEVEL` and `LOG_FORMAT` control the behavior.
- Admin diagnostics still use the session gate. When `ADMIN_TOKEN` is set, `/api/admin/*` also requires a matching `X-Admin-Token`; in `ENV=production`, `/api/admin/test-llm` rejects local LLM base URLs.
- The backend Docker image now runs as non-root `appuser`; the runtime healthcheck uses stdlib `http.client` instead of importing `httpx` every probe.
- Scenario JSON authority fields now use mutable JSON columns, so in-place updates to `parsed_context / director_state_json / gameplay_state_json` can persist correctly.
- `shared/gameplay_contract.v1.json` now uses an mtime-aware cache and reloads after file updates without requiring a backend restart.
- `shared/gameplay_contract.v1.json` missing at boot now raises a clear runtime error instead of failing later with a raw file-stat exception.
- `scoring.py` now persists prediction scores and leaderboard materialization in one transaction, so a leaderboard failure does not leave scored predictions half-written.
- Segment-filtered leaderboard responses recompute `total_predictions`, `avg_score`, `best_score`, and `win_streak` from matching scored predictions; the no-filter path still returns the materialized legacy array.
- `predictions.py` now enforces one prediction per `scenario_id + user_id` at both layers: API pre-check plus SQLite unique index, and duplicate races still collapse to `409 PREDICTION_ALREADY_SUBMITTED`.
- `runtime_lock_is_active()` now uses a read-only existence check for active leases instead of taking `BEGIN IMMEDIATE` on the shared lock table.
- `vector_store.py` now treats the shared Chroma write lease as best-effort; if another worker already owns the same scenario lock, the write is skipped instead of busy-waiting in the caller.
- Agent identity L2 profiles now live in a dedicated `identity_profile_{user_id}` Chroma collection; custom agent create/update/delete 会同步 profile，旧的 shared-collection profile 文档会在后续写入时自动清理。
- Ending-room WebSocket 现在只走共享的首帧 auth 协议；HTTP `verify_session` 继续只服务 REST，不再误包住 ending-room WS 路由。
- Scenario WebSocket capacity is now enforced against `registered + pending-auth` connections together, and the pending slot is reserved before `accept()`, so concurrent handshakes can no longer oversell `MAX_WS_PER_SCENARIO`.
- `app/api/ws.py` now also exposes `/ws/agent-conversation/{thread_id}`; it reuses the shared first-frame auth / pending-auth budget path, returns `4404` when the feature is off or the thread is missing, and keeps capacity scoped to the owning scenario instead of multiplying by thread count.
- `scenario_deletion.py` + `conversation_service.py` now mark active node-conversation turns as `scenario_deleted` inside the delete transaction, stage the affected turn ids in `session.info`, and let the delete endpoint drain that list only after commit; rollback no longer leaks a fake terminal delete event to the client.
- `scenario_deletion.py` now keeps personal journal history when a scenario is hard-deleted by setting matching journal `scenario_id` values to `NULL`; prediction rows are still deleted with the scenario.
- `DELETE /api/conversation/{thread_id}/active` now prefers waking the live stream task before falling back to direct CAS, so already-streamed partial text is not dropped by a route-level race.
- Bootstrap-preclaimed node conversation turns now re-check the row status and cancel flag before the first `turn_started`; if the turn was already aborted they stay silent, and if the scenario was deleted they emit the final `SCENARIO_DELETED` error directly instead of leaking a stale start event.
- Conversation SSE terminal fallback now emits `turn_error(code=LLM_5XX)` for generic provider-side failures instead of the older `STREAM_FAILED` bucket.
- Ending-room background generation now also holds a runtime-lock heartbeat; a lost lease, a refresh error, or an expired local lease fails closed and marks the room as `error` instead of continuing to write turns/results after the lock is gone.
- `POST /api/debate/{id}/predict` now treats counterplay WebSocket broadcast as best-effort after persistence; a broadcast failure logs a warning but does not turn a saved prediction into a fake `500`.
- BYOK `llm_base_url` and official `web_search_base_url` endpoints now require `https`; plain `http` is kept only for local/self-hosted development hosts on the allowlist.
- `POST /api/scenario` now rejects out-of-range `rounds` at schema level, `import-replay` no longer repeatedly scans agents when it falls back by name, and `GET /api/scenario/{id}/groups` now batch-loads leader/member data.
- `AgentGroup.scenario_id` now has an index, with both `init_db()` lightweight migration coverage and Alembic revision `011_add_agent_group_scenario_index`.
- Scenario cancellation now has an explicit `cancelled` terminal state. `done / error` scenarios are not demoted by cancel requests, DB `cancelled` is still observed when a worker already has a local token, and late WebSocket events are not meant to restart the live UI.
- `decision_bias` is a fixed five-key schema: `caution / optimism / conservatism / risk_tolerance / creativity`. Missing keys default to `0.5`; unknown keys are rejected; numeric strings are accepted; booleans, invalid numbers, and out-of-range values are rejected.
- Workshop update/delete only applies to custom identities. Generated identities are visible in the library/profile flows but are not editable through workshop endpoints.
- Conversation origins are scoped to the same scenario; a cross-scenario `origin_branch_id` is treated as not found instead of leaking another scenario's transcript into the prompt context.
- Snapshot export/import is guarded by `FEATURE_SNAPSHOT_EXPORT`. Export omits private owner data by default and strips common secret field variants, including JSON-string payloads such as branch key moments; import rejects non-UTF-8 JSON/JSONL, oversized JSONL rows, path traversal, symlinks, suspicious compression ratios, checksum mismatches, and files over the 50 MB upload cap.
- Personality drift is guarded by `FEATURE_AGENT_IDENTITY`. It is deterministic warning data for the UI, not a verdict gate.
- Persona import/export is guarded by `FEATURE_PERSONA_EXPORT`. Exported persona text is unwrapped from the local untrusted-data wrapper; import creates a new custom identity for the caller and re-enters the normal custom-Agent creation path.
- Prediction Journal is guarded by `FEATURE_PREDICTION_JOURNAL`. Entries are scoped to the current user; scenario-linked entries require scenario ownership and hide missing, foreign, or ownerless legacy scenarios as `404`; resolve hides foreign entries as `404`, uses a conditional update so stale or repeated resolves return `409`, and calibration reads use the `user_id / resolved_at / actual_outcome` index from Alembic `029`.
- Hallucination Gate is guarded by `FEATURE_HALLUCINATION_GATE`. It stays warning-only, writes verdict metadata when enabled, and its contradiction check now handles common Chinese negators without treating neutral compounds like `无论 / 无疑` as contradictions.
- Debate result payloads expose stored `hallucination_gate` metadata when verdict post-processing wrote it into `score_breakdown.metadata`.

## Environment Variables

See `../.env.example` for the full list.

Memory compression tuning now includes developer-only backend knobs:

- `MEMORY_COMPRESS_MAX_RAW_WINDOW_CHARS`
- `MEMORY_COMPRESS_RECENT_RAW_WINDOW_CHARS`
- `MEMORY_COMPRESS_OVERFLOW_SUMMARY_SOURCE_CHARS`
- `MEMORY_CORE_MAX_RECENT`
- `MEMORY_IMPORTANT_MAX_RECENT`
- `MEMORY_CROWD_MAX_RECENT`
- `MEMORY_CORE_CONTEXT_MAX_CHARS`
- `MEMORY_IMPORTANT_CONTEXT_MAX_CHARS`

These values only affect backend prompt budgeting and context retention. They are
not exposed to frontend users and should be tuned by developers/operators only.
