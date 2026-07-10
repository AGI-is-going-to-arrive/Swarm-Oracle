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
- Gameplay Cards, prediction bets, worldline commitments, and a post-run Causal Archive
- Debate Arena, Ending Chambers, and Worldline Roundtable
- Counterfactual reruns, branch comparison, and Replay Trace
- Causal graph, knowledge graph, and timeline views
- In-run Agent profiles, branch-scoped memory, Custom Agents, persona backups, prediction journal, and snapshots
- Result verdicts, full reports, share cards, and optional search augmentation

In-run Agent profiles separate configured stance from observed emotion and identify the worldline and round behind that observation; replay explicitly says when no matching observation exists.

See the [feature index](docs/FEATURES.en.md) for capability groups and routes, and the [usage guide](docs/USAGE.en.md) for operation.

## Two Ways to Use It

### Built-in Official Samples and Snapshot Demo

The backend and frontend can start without a real LLM. The home page offers three bundled official samples: no API key, file selection, or model call is needed, and any sample opens as a complete imported run with results, replay, and related views. You can also keep importing sanitized `*.swarm` files from `samples/snapshots/`. Built-in samples and Snapshot imports cannot generate a new live run.

### Live LLM Runs

New simulations, debates, chambers, and reports need a working OpenAI-compatible LLM. You can:

- configure the server default in `backend/.env` or `.env.docker`; or
- open `/admin/setup` after startup, test a connection, and save a model profile with a key; or
- provide connection details for one run in the separate **BYOK** disclosure on the home page.

**Advanced Settings** and **BYOK** are separate disclosures. Public defaults come from [`.env.example`](.env.example), not from any developer's local `backend/.env`.

## Quick Start

### Docker Compose

```bash
cp .env.docker.example .env.docker
docker compose up -d
```

Open http://127.0.0.1:18928 . Ports publish to loopback by default: frontend `18928`, backend `18927`. The backend image bundles `packs/` and `samples/`, so Local Packs and official samples are available inside the container. To rebuild the images from source, run `docker compose up --build -d`.

### Local Development

Backend (Python 3.11+):

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
cp ../.env.example .env
uvicorn app.main:app --host 127.0.0.1 --port 18927 --reload
```

Start the frontend in another terminal (Node.js 20.19+ or 22.12+, npm):

```bash
cd frontend
npm install
npm run dev
```

Open http://127.0.0.1:18928 . The frontend proxies `/api` and `/ws` to http://127.0.0.1:18927 .

## Public Deployment

Docker Compose is loopback-only by default. Before binding it to a LAN or public interface, set `ENV=production`, a unique `SESSION_SECRET`, and a unique `ADMIN_TOKEN`; production startup fails if either secret is empty. [SECURITY.md](SECURITY.md) is authoritative for BYOK, SSRF, and admin boundaries. See [Configuration](docs/CONFIGURATION.en.md) for deployment variables.

## Documentation

- [Usage Guide](docs/USAGE.en.md): operation from home page to results
- [Configuration](docs/CONFIGURATION.en.md): environment variables, deployment, and feature flags
- [Feature Index](docs/FEATURES.en.md): capability groups and primary routes
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## Stack and License

Backend: FastAPI, SQLModel, SQLite, and ChromaDB. Frontend: React 19, TypeScript, Phaser 3, and Vite. Backend `init_db()` owns startup database migrations.

SwarmOracle is licensed under the [GNU Affero General Public License v3.0](LICENSE). Generated output is for entertainment and exploration, not financial, medical, legal, or factual decision-making.
