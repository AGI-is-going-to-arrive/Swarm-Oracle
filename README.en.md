English | [中文](README.md)

# 🔮 SwarmOracle

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker)](docker-compose.yml)
[![GHCR](https://img.shields.io/badge/GHCR-workflow-24292f?logo=github)](.github/workflows/ghcr.yml)

> AI "What-If" Prediction Playground - SwarmOracle

SwarmOracle lets you ask hypothetical questions ("What if...?"). A group of AI agents simulates multiple storylines and shows different possible outcomes. The flagship example scenario is: **What if Zheng He discovered the Americas before Columbus**.

![SwarmOracle home](docs/screenshots-en/01-home.png)

## Live Demo

Open it for the full screenshots and a short intro video: **https://agi-is-going-to-arrive.github.io/Swarm-Oracle/**

Chinese intro video on Bilibili: **https://www.bilibili.com/video/BV1Xh7168ECc**

## Features

- **Multi-branch simulation**: One question, multiple storylines; the simulation page shows rounds, speaking progress, and ETA live, slow models show elapsed time, and interrupted branches are clearly marked; the result page reports normalized probabilities for terminal worldlines.
- **Pixel Theater + director/gameplay cards**: Watch the run in the pixel-stage view, where 14 director/gameplay cards can change the current worldline rhythm.
- **Debate Arena**: AI affirmative and opposing sides debate so you can see both sides of an issue.
- **Oracle Chambers**: Talk in depth with AI characters from the current worldline and ask follow-up questions.
- **Worldline Roundtable**: Representatives from multiple sides discuss around a table. After it finishes, you can return to the saved result and continue Deep Dive.
- **Counterfactual comparison**: "If that sentence had been said differently, how would the worldline change?"
- **Causal graph + knowledge graph**: Enter the graph workbench, knowledge graph explorer, and timeline galaxy from the result page.
- **Custom Agents**: Create, import, and export your own characters in the Agent Workshop; in simulations, their persona, memory, and concrete prior-round points shape their voice and what they respond to.
- **Education templates and Local Packs**: Start from classroom templates or repo-local `packs/` presets; Local Packs support genre segments, search, preview, and one-click import.
- **Prediction journal and leaderboard**: Record predictions, review calibration, and view the global leaderboard.
- **Snapshot import / export**: Package one simulation run, save it, and import it later for review.
- **Full report and evidence replay**: The result page shows a digest and section links first; the standalone report opens verdicts, evidence, indicators, probability bands, and charts. Statistical bands only appear when anchored to an answer-bearing branch, and evidence jumps back to the replay.
- **Model profiles and bring your own LLM**: Compatible with any OpenAI-format API; save several model profiles (URL, key, rate limits, concurrency and more) and select one from the home page, Debate Arena, or result-page Oracle Chambers.

> For concrete usage of each mode, see **[Usage Guide docs/USAGE.en.md](docs/USAGE.en.md)**; for the per-feature catalog, see **[FEATURES.en.md](docs/FEATURES.en.md)**. Most default features work out of the box. Search enhancement and source checkboxes require extra configuration. See **[Configuration docs/CONFIGURATION.en.md](docs/CONFIGURATION.en.md)**.

## What It Looks Like

Ask a question, watch a group of AI agents simulate several storylines, get a verdict, then walk into the rooms to dig deeper.

| Simulating: progress and branches grow live | Result: terminal probabilities answer your question |
|:---:|:---:|
| ![Simulating](docs/screenshots-en/21-simulation.png) | ![Result page](docs/screenshots-en/02-result.png) |
| **Debate Arena: two sides argue** | **Causal Graph: see how it got there** |
| ![Debate Arena](docs/screenshots-en/20-debate-arena.png) | ![Causal Graph](docs/screenshots-en/06-causal-map.png) |

## Install Tiers

### Tier 1: Public Gallery

A public online gallery is not yet available. For now, use the live intro page for screenshots and video, or run it locally via Tier 2 / Tier 3 below.

### Tier 2: Keyless Demo

Start the backend and frontend first via Quick Start below (this step needs no real LLM key), then load a sanitized snapshot (a `*.swarm` file) from `samples/snapshots/` through the Snapshot import entry on the home page to view an offline demo. The sample scenarios include **What if Zheng He discovered the Americas before Columbus**.

### Tier 3: BYOK Full Run

Run full simulations with your own OpenAI-compatible LLM service. Pick either setup path:

1. Fill `LLM_RESPONSES_URL` / `LLM_API_KEY` / `LLM_MODEL_NAME` in `.env` (local development) or `.env.docker` (Docker);
2. After startup, open `/admin/setup`, test the connection, and save a model profile with a key. The home page, Debate Arena, and result-page Oracle Chambers can then select that profile directly.

Advanced behavior such as proxy forwarding and native-search upstream declarations is covered in **[Configuration docs/CONFIGURATION.en.md](docs/CONFIGURATION.en.md)**.

## Quick Start

### Requirements

Minimum browser: Chrome/Edge >= 111, Firefox >= 113, Safari/iOS >= 16.2 (modern browsers that support oklch / color-mix). On Safari/iOS 16.2-16.3, GFM tables and strikethrough degrade to plain Markdown while safe rendering stays enabled.

### One-command Docker deployment (recommended)

1. Copy the Docker configuration template:

   macOS / Linux:
   ```bash
   cp .env.docker.example .env.docker
   ```

   Windows PowerShell:
   ```powershell
   Copy-Item .env.docker.example .env.docker
   ```

2. Edit `.env.docker` and fill in your LLM API information. If `.env.docker` is absent, Compose still starts from the service defaults in `docker-compose.yml`; LLM settings fall back to the backend built-in defaults:

   macOS / Linux:
   ```bash
   ${EDITOR:-vi} .env.docker
   ```

   Windows PowerShell:
   ```powershell
   notepad .env.docker
   ```

   Docker Compose binds both frontend and backend ports to `127.0.0.1` by default. If the deployment must be reachable beyond your own machine, explicitly change the `ports` bindings in `docker-compose.yml` (for example, change the frontend publish to `18928:80`) and set `ENV=production`, `SESSION_SECRET`, and `ADMIN_TOKEN` in `.env.docker`. `SESSION_SECRET` protects normal REST / WebSocket access; `ADMIN_TOKEN` protects `/api/admin/*`; `/metrics` accepts `X-Admin-Token` when `ADMIN_TOKEN` is set and also accepts `X-Session-Token` when `SESSION_SECRET` is set.

3. Start:

   macOS / Linux:
   ```bash
   docker compose up -d
   ```

   Windows PowerShell:
   ```powershell
   docker compose up -d
   ```

4. Open http://localhost:18928 in your browser.

Docker maps the frontend to `127.0.0.1:18928` and the backend to `127.0.0.1:18927` by default. The frontend container proxies `/api` and `/ws` to the backend, so public deployments must not expose only the frontend port while leaving auth secrets empty. After GHCR images are published, Compose uses the backend/frontend images from `image:` first and keeps `build:` as the local fallback. To force a source build, run `docker compose up --build -d`.

### Local Development

Backend (Python 3.11+, macOS/Linux):

macOS / Linux:
```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Windows PowerShell:
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
Copy-Item ..\.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

The `your-api-key-here` value in `.env.example` is only a placeholder. If `LLM_RESPONSES_URL` is not a local address, the backend refuses to keep using the placeholder key.

Frontend (Node.js 20+):

macOS / Linux:
```bash
cd frontend
npm install
npm run dev
```

Windows PowerShell:
```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:18928 to use it.

> Prerequisite: during local development, make sure the backend is already running on 18927 first. The frontend forwards `/api` and `/ws` requests to it. Otherwise, the page will keep waiting or show errors.

## Configuration

Core configuration lives in `.env.example` for local development or `.env.docker` for Docker deployment:

| Configuration item | Description | Example |
|--------|------|------|
| `LLM_RESPONSES_URL` | LLM service URL | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API key | `sk-...` |
| `LLM_MODEL_NAME` | Model name | `gpt-5.4-mini` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |
| `ENABLE_WEB_SEARCH` | Search enhancement (optional) | `false` |
| `WEB_SEARCH_PROVIDER` | Search provider (when search is enabled) | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` |

For the full configuration list, feature flags, and search enhancement notes, see **[Configuration docs/CONFIGURATION.en.md](docs/CONFIGURATION.en.md)**. Custom Agents, cross-scenario identity, causal graph, graph analysis, faction relations, argument map, knowledge graph explorer, timeline galaxy, replay trace, Roundtable Deep Dive, snapshot, prediction journal, education templates, Local Packs, persona backup, and the full report are enabled by default in the template. `ENABLE_WEB_SEARCH`, `FEATURE_NEW_SOURCES`, and `FEATURE_FAMILY_QUERY_OPTIMIZATION` are disabled by default because they require a search provider and matching configuration.

Docker Compose reads `.env.docker` if present and stores the database and Chroma data in the `/data` volume. Standard local development reads `backend/.env`.

Home-page scenario questions, debate questions, shared challenges, and template / local-pack import paths are bounded to 2000 characters. The frontend clamps or limits controlled entries, and backend schemas still reject oversized requests.

## Migration Strategy

The database migration owner remains backend `init_db()`. FastAPI lifespan stamps/upgrades to head during startup; image entrypoints, Compose commands, and release scripts must not add `alembic upgrade head`. Entrypoint Alembic stays frozen unless a later migration-owner change is explicitly approved.

## Project Structure

```text
SwarmOracle/
├── backend/          # FastAPI backend (Python)
├── frontend/         # React + Phaser frontend (TypeScript)
├── docs/             # Usage guide / feature catalog / configuration
├── packs/            # Local packs (bilingual preset scenarios)
├── samples/          # Keyless demo snapshots
├── docker-compose.yml
├── .env.example      # Local development configuration template
└── .env.docker       # Local Docker deployment config, not committed by default
```

## Contributing and Content Policy

Contribution flow, test gates, and content policy are in **[CONTRIBUTING.md](CONTRIBUTING.md)**. SwarmOracle is for AI-generated hypothetical simulations and speculative fiction. Do not use it for real-person defamation, harassment, privacy leakage, impersonation, unlawful instructions, or presenting generated content as factual news.

## Tech Stack

- **Backend**: FastAPI + SQLite + ChromaDB
- **Frontend**: React 19 + TypeScript + Phaser 3
- **Deployment**: Docker Compose + GHCR images (release workflow)

## Acknowledgements

Thanks to the [Linux.do](https://linux.do/) community for feedback and support.

## License

SwarmOracle is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**.
