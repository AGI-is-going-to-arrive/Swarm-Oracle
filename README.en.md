English | [中文](README.md)

# 🔮 SwarmOracle

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml/badge.svg)](https://github.com/AGI-is-going-to-arrive/Swarm-Oracle/actions/workflows/ci.yml)
[![Docker Compose](https://img.shields.io/badge/Docker%20Compose-ready-2496ED?logo=docker)](docker-compose.yml)
[![GHCR](https://img.shields.io/badge/GHCR-workflow-24292f?logo=github)](.github/workflows/ghcr.yml)

> AI "What-If" Prediction Playground - SwarmOracle

SwarmOracle lets you ask hypothetical questions ("What if...?"). A group of AI agents simulates multiple storylines and shows different possible outcomes. The flagship example scenario is: **What if Zheng He discovered the Americas before Columbus**.

![SwarmOracle home](docs/screenshots-en/01-home.png)

The social preview should use existing repository screenshots and the live intro page assets. No hero GIF is linked yet; the browser lane should capture one first and only then add a real file reference.

## Live Demo

Open it for the full screenshots and a short intro video: **https://agi-is-going-to-arrive.github.io/Swarm-Oracle/**

Chinese intro video on Bilibili: **https://www.bilibili.com/video/BV1Xh7168ECc**

## Features

- **Multi-branch simulation**: One question, multiple storylines, different endings.
- **Pixel Theater + director/gameplay cards**: Watch the run in the pixel-stage view and use 14 director/gameplay cards to change the current worldline rhythm.
- **Debate Arena**: AI affirmative and opposing sides debate so you can see both sides of an issue.
- **Oracle Chambers**: Talk in depth with AI characters from the current worldline and ask follow-up questions.
- **Worldline Roundtable**: Representatives from multiple sides discuss around a table. After it finishes, you can return to the saved result and continue Deep Dive.
- **Counterfactual comparison**: "If that sentence had been said differently, how would the worldline change?"
- **Causal graph + knowledge graph**: Enter the graph workbench, knowledge graph explorer, and timeline galaxy from the result page.
- **Custom Agents**: Create, import, and export your own characters in the Agent Workshop.
- **Prediction journal and leaderboard**: Record predictions, review calibration, and view the global leaderboard.
- **Snapshot import / export**: Package one simulation run, save it, and import it later for review.
- **Full report and evidence replay**: Generate a standalone report from the result page, jump evidence back to replay, and render table-friendly Markdown.
- **Model profiles and bring your own LLM**: Compatible with any OpenAI-format API, with saved profiles carrying rate limits, concurrency, and capability overrides selectable from the home page.

> For concrete usage of each mode, see **[Usage Guide docs/USAGE.en.md](docs/USAGE.en.md)**; for the per-feature catalog, see **[FEATURES.en.md](docs/FEATURES.en.md)**. Most default features work out of the box. Search enhancement and source checkboxes require extra configuration. See **[Configuration docs/CONFIGURATION.en.md](docs/CONFIGURATION.en.md)**.

## What It Looks Like

Ask a question, watch a group of AI agents simulate several storylines, get a verdict, then walk into the rooms to dig deeper.

| Simulating: branches grow live | Result: it answers your question |
|:---:|:---:|
| ![Simulating](docs/screenshots-en/21-simulation.png) | ![Result page](docs/screenshots-en/02-result.png) |
| **Debate Arena: two sides argue** | **Causal Graph: see how it got there** |
| ![Debate Arena](docs/screenshots-en/20-debate-arena.png) | ![Causal Graph](docs/screenshots-en/06-causal-map.png) |

## Install Tiers

### Tier 1: Public Gallery

Placeholder entry. It will be activated after F1. For now, use the live intro page for screenshots and video, or use Tier 2 / Tier 3 locally.

### Tier 2: Keyless Demo

Import a sanitized snapshot from `samples/snapshots/` to view an offline demo with no LLM API. The sample scenarios include **What if Zheng He discovered the Americas before Columbus**. Current sample files use the `samples/snapshots/*.swarm` convention; load them through the Snapshot import entry in the app.

### Tier 3: BYOK Full Run

Configure your own OpenAI-compatible LLM service and run full simulations. Docker and local development use the same core configuration keys; you can also save a model profile from `/admin/setup` with its Base URL, model, key, rate limits, concurrency, and structured-output / native-search capability overrides. The home page treats profiles with a key as configured LLM access. If later LLM-backed paths cannot recover the original profile, they ask you to reselect it or provide a complete key / Base URL / model instead of silently switching credentials.

## Quick Start

### Requirements

Minimum browser: Chrome/Edge >= 111, Firefox >= 113, Safari/iOS >= 16.2 (modern browsers that support oklch / color-mix).

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

   If the deployment is reachable beyond your own machine, also set `SESSION_SECRET` and `ADMIN_TOKEN`. `SESSION_SECRET` protects normal REST / WebSocket access, and `ADMIN_TOKEN` protects `/api/admin/*` diagnostics through the `X-Admin-Token` header.

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

Docker maps the frontend to `18928` and the backend to `18927` by default. After GHCR images are published, Compose uses the backend/frontend images from `image:` first and keeps `build:` as the local fallback. To force a source build, run `docker compose up --build -d`.

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
| `LLM_MODEL_NAME` | Model name | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |
| `ENABLE_WEB_SEARCH` | Search enhancement (optional) | `false` |
| `WEB_SEARCH_PROVIDER` | Search provider (when search is enabled) | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` |

For the full configuration list, feature flags, and search enhancement notes, see **[Configuration docs/CONFIGURATION.en.md](docs/CONFIGURATION.en.md)**. Custom Agents, cross-scenario identity, causal graph, graph analysis, faction relations, argument map, knowledge graph explorer, timeline galaxy, replay trace, Roundtable Deep Dive, snapshot, prediction journal, education templates, persona backup, and the full report are enabled by default in the template. `ENABLE_WEB_SEARCH`, `FEATURE_NEW_SOURCES`, and `FEATURE_FAMILY_QUERY_OPTIMIZATION` are disabled by default because they require a search provider and matching configuration.

Docker Compose reads `.env.docker` if present and stores the database and Chroma data in the `/data` volume. Standard local development reads `backend/.env`.

## Migration Strategy

The database migration owner remains backend `init_db()`. FastAPI lifespan stamps/upgrades to head during startup; image entrypoints, Compose commands, and release scripts must not add `alembic upgrade head`. Entrypoint Alembic stays frozen unless a later migration-owner change is explicitly approved.

## Project Structure

```text
SwarmOracle/
├── backend/          # FastAPI backend (Python)
├── frontend/         # React + Phaser frontend (TypeScript)
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
