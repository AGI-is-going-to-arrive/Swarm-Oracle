English | [中文](README.md)

# 🔮 SwarmOracle

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker)](docker-compose.yml)

SwarmOracle is an open-source, self-hosted AI what-if playground. Ask “What if...?”, let a group of AI agents simulate several worldlines, then inspect the verdict, terminal probabilities, and follow-up paths.

![SwarmOracle home](docs/screenshots-en/01-home.png)

Static showcase (screenshots and video): https://agi-is-going-to-arrive.github.io/Swarm-Oracle/
Chinese intro video: https://www.bilibili.com/video/BV1Xh7168ECc

## What It Does

- Multi-branch simulation, Classic branch tree, and Pixel Theater
- A configurable initial world-event Feed and nine native social actions whose speech and action are bound by the same structured decision: `POST`, `COMMENT`, `REACTION`, `FOLLOW`, `MUTE`, `SEARCH`, `TREND`, `REFRESH`, and `IDLE`
- Gameplay Cards, prediction bets, worldline commitments, and a post-run Causal Archive
- Debate Arena, Ending Chambers, and Worldline Roundtable
- Counterfactual reruns, branch comparison, and Replay Trace
- Causal graph, knowledge graph, and timeline views
- In-run Agent profiles, branch-scoped memory, auditable decisions, replayable bounded domain state and cross-round records, Custom Agents, persona backups, ordered Agent Packs, prediction journal, and snapshots
- Bounded, atomic Local Pack imports with clickable Snapshot demos, plus result verdicts, transparent full reports whose complete/partial output passes through Claim–Evidence compilation, a redacted offline Gallery, and optional search augmentation

## W2.1 Visibility and Truth Boundaries

- Agent profiles separate configured stance from observed emotion. Every growth event shows scenario, branch, round, and `event_type` coordinates; it is labeled “Current · selected branch segment” only when it matches both the routed scenario and an explicitly selected branch. Other classifiable events are labeled “Past.”
- If an Agent's speech succeeds but the second-pass structured-metadata parse fails, the real speech is preserved while emotion, stance, and relationship observations are explicitly unavailable with a bounded error code. Live views, Replay, Snapshots, and Pixel Theater never invent `neutral` metadata.
- Legacy `stance` / `trust` / `opposition` fields in causal and faction views are affect proxies derived from model-generated `emotion` / `diverge`, not verified stance, trust, relationships, or causal evidence. Branch-scoped causal, faction, report, Replay, and compare paths now use one effective root-to-leaf lineage: eligible pre-fork ancestor rounds are included up to the round cutoff, while parent post-fork future data, siblings, and post-cutoff data are excluded. A self-contained Replay stops at its own Replay boundary.
- Report likelihood and analytic confidence count only completed terminal leaves as branch samples and use persisted evidence-item counts; fork parents do not count, and signed affect-convergence proxies do not raise analytic confidence. Bounded per-section tool traces remain available after generated, rewritten, or static-fallback sections and survive refresh/reopen. Structured premortem analysis keeps a separate evidence chain and uncertainty for each failure mode; the live “current section” cursor remains transient.
- Local Pack refresh reloads details even when the selected pack keeps the same ID, clears old details and actions before switching, and isolates late responses. Pack `demo_snapshots` are clickable, catalog-whitelisted, validated against the Snapshot contract, and directly importable. Definite failures are retryable; when the outcome cannot be confirmed, the UI asks you to check History before another attempt.
- Agent Packs atomically import or export Agents in library selection order without identity IDs, owner data, memories, growth history, conversations, or separately stored credentials, and redact common credential patterns. Public Artifacts can be exported as redacted JSON, single-file HTML, or an offline Gallery hash link, while `gallery.html` can open a local file. This is not a hosted registry, community index, or marketplace.
- The initial Feed accepts at most 20 world events with a source, content, optional publication time, credibility hint, and tags. These fields remain untrusted data, never system instructions. Agents can follow or mute source accounts, and muting affects later Feed, search, and trend projections. The Action Ledger panel in Causal Review shows branch-scoped native actions, targets, states, and domain adjudications; a separate evidence-ledger API projects Agent utterances, context observations, and derived consequences, with hashed memory references and source-scenario coordinates rather than memory text. Older runs without the corresponding evidence are explicitly `unavailable` instead of receiving invented history.
- A live Agent turn first generates and validates a bounded Decision Envelope, then uses the same result to constrain both speech and the native action. COMMENT, REACTION, FOLLOW, MUTE, SEARCH, TREND, and REFRESH open only when the previous round provides a real social opportunity; an action bound to a domain rule must also match the same frozen schema, state revision, and threshold. `IDLE` requires an explicit reason, but the system does not manufacture activity through action quotas, random actions, or forced rotation.
- The parser may ask the model to propose bounded domain variables and rules for budgets, footfall, capacity, commitments, and similar state, but only a `domain_world_v1` schema that passes fixed type, unit, precision, bounds, and credential checks is frozen. Every complete round deterministically adjudicates changes from durable verified actions only. The live and result pages show branch state strips, threshold tooltips, domain-gated IDLE attribution, and world outcomes with source coordinates; Compare also shows domain differences. State Transitions continue to carry prior outcomes, goal progress, obstacles, relationship changes, and next-round pressure. Unverifiable or legacy data is explicitly `unavailable`. These values are in-simulation assumptions or bounded estimates, not real-world measurements or causal proof.
- Verified-memory promotion is a default-off backend core with no capability, REST, or UI entry today; it becomes effective only when both `FEATURE_AGENT_IDENTITY=true` and `FEATURE_MEMORY_PROMOTION=true`. Once enabled, it writes only results exactly bound to a verified action, domain adjudication, and actual delta into a versioned Chroma namespace, then offers stable hashed refs to later Decisions. Disabling either gate makes the reader ignore that version without deleting physical records. V1 retention is append-only; explicit user-wide purge is only a service-level, bounded point-in-time best effort, with no production caller, continuation/completion cursor, or terminal purge-wins guarantee today. Old refs carried by Snapshot/import/clone are opaque history only.
- Before a complete/partial report is saved, its conclusions are compiled into Claims with Agent, message, action, branch, and round coordinates. Verbatim quotations must match the same speaker's same utterance, and role and temporal coverage are checked. Insufficient evidence removes unsafe quotation marks, lowers confidence, or rewrites the conclusion as an “Evidence-limited hypothesis.” When a compiled report is available, the result-page headline and report analytic confidence use the same authority. Outer states such as generating, failed, cancelled, skipped, stalled, and truncated do not claim completed Claim validation; model-synthesized interviews and simulated changes are not real-world evidence.

See the [feature index](docs/FEATURES.en.md) for capability groups and routes, and the [usage guide](docs/USAGE.en.md) for operation.

## Two Ways to Use It

### Built-in Official Samples and Snapshot Demo

The backend and frontend can start without a real LLM. The home page offers three bundled official samples: no API key, file selection, or model call is needed, and any sample opens as a complete imported run with results, replay, and related views. You can also keep importing sanitized `*.swarm` files from `samples/snapshots/`. Built-in samples and Snapshot imports cannot generate a new live run.

### Live LLM Runs

New simulations, debates, chambers, and reports need a working OpenAI-compatible LLM. You can:

- configure the server default in `backend/.env` or `.env.docker`; or
- open `/admin/setup` after startup, test a connection, and save a model profile; or
- provide connection details for one run in the separate **BYOK** disclosure on the home page.

Local Base URLs whose host is exactly `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, or `[::1]` may omit the API key; those keyless requests send no `Authorization` header. Every other custom or remote Base URL still requires a key. Credentials, endpoint, and model are bound to one provider: an unchanged profile is recovered by scenario on the backend and leaves no keyless session mirror; changing its remote endpoint or model requires a complete key/Base URL/model tuple, while partial overrides are rejected and the old profile, rate limits, and capability policy are detached. Setup can finish only after the current combination passes its test or you explicitly accept saving it unverified. The shipped `127.0.0.1:8317 + empty/placeholder key` combination remains an “unconfigured” sentinel; replace it with your actual local service or explicitly save that connection in Setup.

**Advanced Settings** and **BYOK** are separate disclosures. Public defaults come from [`.env.example`](.env.example), not from any developer's local `backend/.env`.

Protocol truth boundary: connection checks, provider probes, and core generation that requires text succeed only with a supported terminal signal and visible text; error envelopes, explicit non-terminal responses, and truncated streams fail. General Responses calls still accept completed native-tool or reasoning-only results without text, but that exception cannot make a connection check or provider probe pass. With LLM generation enabled, generation failure in a required Debate turn or judge output, or in the Ending Room initial core plan, is reported as an error instead of silently switching to template copy; the deterministic mode remains when the corresponding LLM feature is explicitly disabled. Ending Room follow-ups remain best-effort. With a BYOK key, the automatic pre-launch check stays lightweight and does not run parallel fanout.

## Quick Start

### Docker Compose

Use Docker Desktop in Linux-container mode on Windows/macOS, or Docker Engine with the Compose plugin on Linux. Run these commands from the repository root.

macOS / Linux:

```bash
test -f .env.docker || cp .env.docker.example .env.docker
docker compose config --quiet
docker compose up -d
```

Windows PowerShell:

```powershell
if (-not (Test-Path .env.docker)) { Copy-Item .env.docker.example .env.docker }
docker compose config --quiet
docker compose up -d
```

Open http://127.0.0.1:18928 . Ports publish to loopback by default: frontend `18928`, backend `18927`. The backend image bundles `packs/` and `samples/`, so Local Packs and official samples are available inside the container; bundled pack `demo_snapshots` reference only Snapshots that actually exist and can be imported directly from pack details. To rebuild the images from source, run `docker compose up --build -d`.

When upgrading from an older root-run container, existing data volumes keep their ownership. Complete the [stopped-backend backup and legacy-volume upgrade](deploy/README.md#legacy-data-volume-upgrade) before starting the new version. Fresh volumes do not need that step.

### Local Development

Backend (Python 3.11+), macOS / Linux:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
test -f .env || cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell uses the virtual environment's interpreter directly; no execution-policy change is needed:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
if (-not (Test-Path .env)) { Copy-Item ..\.env.example .env }
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Start the frontend in another terminal (Node.js 20.19+ within 20.x, or ≥22.12; npm version in `frontend/package.json`). macOS / Linux:

```bash
cd frontend
npm ci
npm run dev
```

Windows PowerShell:

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

Open http://127.0.0.1:18928 . The frontend proxies `/api` and `/ws` to http://127.0.0.1:18927 .

Before starting services, run preflight from the repository root: `backend/.venv/bin/python backend/scripts/preflight.py` on macOS/Linux, or `.\backend\.venv\Scripts\python.exe backend/scripts/preflight.py` in PowerShell. Preflight probes the configured LLM connection. The `make` targets are conveniences for POSIX terminals.

## Public Deployment

Docker Compose is loopback-only by default. Before binding it to a LAN or public interface, set `ENV=production`, a unique `SESSION_SECRET`, and a unique `ADMIN_TOKEN`; production startup fails if either secret is empty. [SECURITY.md](SECURITY.md) is authoritative for BYOK, SSRF, and admin boundaries. See [Configuration](docs/CONFIGURATION.en.md) for deployment variables.

Published backend/frontend images are built only from the exact commit that passed CI, first under immutable SHA tags and then promoted as a pair. If either promotion fails, rollback of both tags is triggered and verified; an incomplete rollback fails the job explicitly. Version tags additionally require an executed release signoff for that exact SHA. `--dry-run` records planned steps and is never reported as passed.

## Documentation

- [Usage Guide](docs/USAGE.en.md): operation from home page to results
- [Configuration](docs/CONFIGURATION.en.md): environment variables, deployment, and feature flags
- [Feature Index](docs/FEATURES.en.md): capability groups and primary routes
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Stack and License

Backend: FastAPI, SQLModel, SQLite, and ChromaDB. Frontend: React 19, TypeScript, Phaser 3, and Vite. Backend `init_db()` owns startup database migrations.

SwarmOracle is licensed under the [GNU Affero General Public License v3.0](LICENSE). Generated output is for entertainment and exploration, not financial, medical, legal, or factual decision-making.
