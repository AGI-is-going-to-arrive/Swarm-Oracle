English | [中文](CONFIGURATION.md)

# SwarmOracle Configuration

## 1. Sources and Precedence

- Local development: copy `.env.example` to `backend/.env`, then edit `backend/.env`.
- Docker: copy `.env.docker.example` to `.env.docker`; Compose reads it automatically.
- `.env.example` is authoritative for public defaults. A developer's `backend/.env` is not a public default.
- For runtime and report tuning not listed here, use the template comments and `backend/app/config.py`.

Restart the backend after environment changes. The frontend reads effective capabilities from `/api/capabilities`.

## 2. Runtime Paths

| Path | Real LLM required | Purpose |
|---|---:|---|
| Snapshot demo | No | Import `samples/snapshots/*.swarm` and inspect a saved result and replay |
| Live generation | Yes | New simulations, debates, chambers, reports, and other LLM features |
| Local Docker deployment | Depends | Publishes only to `127.0.0.1:18927` / `127.0.0.1:18928` by default |
| Production or public deployment | Yes | Also requires production security gates |

The placeholder endpoint and key can boot the Snapshot demo, but they leave `llm_static_configured=false`. Live generation is unavailable only when there is also no model profile with a key and the current run provides no BYOK connection.

## 3. LLM Configuration

Current public template values:

| Variable | `.env.example` default | Meaning |
|---|---|---|
| `LLM_RESPONSES_URL` | `http://127.0.0.1:8317/v1` | OpenAI-compatible Base URL |
| `LLM_API_KEY` | `your-api-key-here` | Placeholder; non-local endpoints require a real key |
| `LLM_MODEL_NAME` | `gpt-5.4-mini` | Actual model ID supported by the provider |
| `LLM_REASONING_EFFORT` | `none` | `none/low/medium/high` |
| `LLM_REQUESTS_PER_MINUTE` | `0` | `0` means no RPM cap |
| `LLM_TOKENS_PER_MINUTE` | `0` | `0` means no TPM cap |
| `LLM_CONCURRENCY` | `5` | Global concurrency cap; `0` disables this cap |
| `LLM_MAX_PENDING` | `24` | Global pending-queue cap; `0` disables this guard |
| `LLM_USER_MAX_PENDING` | `4` | Per-user pending cap; `0` disables this guard |

These variables define the server-default model. Do not publish a temporary model, endpoint, or key from one machine as the project default. The model ID must exist at your provider.

## 4. Model Profiles and BYOK

Use `/admin/setup` to test a connection and save a model profile. Use `/model-profiles` to manage provider, Base URL, model, key, rate limits, concurrency, and capability overrides. A profile with a key contributes to the `llm_configured` check.

**Advanced Settings** and **BYOK** are separate home-page disclosures. BYOK overrides the current request; Advanced Settings controls simulation, display, Local Packs, and search. A request-level Base URL must be submitted with an API key, and credentials must not appear in the URL.

Request-level BYOK host controls:

- `LLM_EXTRA_ALLOWED_HOSTS`: extra host allowlist; accepts hosts, not full URLs.
- `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false`: rejects private/LAN hosts added through the extra allowlist by default; it does not control built-in local aliases.
- `LLM_ALLOW_LOCAL_BYOK_HOSTS=true`: controls built-in local aliases such as `localhost` and loopback addresses; set it to `false` for multi-user, LAN, or public deployments.

See [SECURITY.md](../SECURITY.md) for the full SSRF and credential boundary.

## 5. Search Augmentation

App-layer search is off by default:

| Variable | Default | Meaning |
|---|---:|---|
| `ENABLE_WEB_SEARCH` | `false` | External search master switch |
| `WEB_SEARCH_PROVIDER` | `tavily` | `tavily/exa/firecrawl/xai/searxng` |
| `WEB_SEARCH_API_KEY` | Empty | Key for hosted providers |
| `SEARXNG_URL` | `http://localhost:8888` | Self-hosted SearXNG URL |
| `FEATURE_NEW_SOURCES` | `false` | Source-family filters |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | `false` | Source-query optimization |

Model-native search belongs to the model-profile / Responses-adapter path. It is not enabled with `WEB_SEARCH_PROVIDER=native`. Result pages show citations only when a provider returns real sources.

## 6. Feature Flags

`.env.example` enables the main user-facing features by default, including:

- Agents and identity: `FEATURE_CUSTOM_AGENTS`, `FEATURE_AGENT_IDENTITY`, `FEATURE_PERSONA_EXPORT`
- Graphs and replay: `FEATURE_CAUSAL_GRAPH`, `FEATURE_GRAPH_ANALYSIS`, `FEATURE_COUNTERFACTUAL_REPLAY`, `FEATURE_KG_EXPLORER`, `FEATURE_REPLAY_TRACE`
- Results and collaboration: `FEATURE_RESULT_VERDICT`, `FEATURE_RESULT_REPORT`, `FEATURE_AGENT_CONVERSATION`, `FEATURE_ROUNDTABLE_SURVEY`, `FEATURE_ROUNDTABLE_ANALYST`
- Other entries: `FEATURE_SNAPSHOT_EXPORT`, `FEATURE_PREDICTION_JOURNAL`, `FEATURE_EDUCATION_TEMPLATES`, `FEATURE_LOCAL_PACKS`, `FEATURE_MODEL_PROFILES`, `FEATURE_MULTI_RUN`

See [FEATURES.en.md](FEATURES.en.md) for categories and routes. When defaults change, `.env.example` and the running `/api/capabilities` response are authoritative.

## 7. Server and Data

| Variable | Default | Meaning |
|---|---|---|
| `ENV` | `development` | `production/prod` enables production fail-fast |
| `HOST` | `127.0.0.1` | Backend bind address |
| `PORT` | `18927` | Backend port |
| `DATABASE_URL` | `sqlite:///./swarmoracle.db` | SQLite |
| `CHROMA_PERSIST_DIR` | `./chroma_data` | Vector data |
| `CORS_ORIGINS` | Template list | Allowed frontend origins |

The frontend dev server uses `18928` and proxies `/api` and `/ws` to `http://127.0.0.1:18927` by default. Override it with `SWARM_BACKEND_URL`. Docker stores SQLite and ChromaDB data in the `/data` volume.

## 8. Production Deployment

Docker Compose binds to loopback by default. Before binding to a LAN or public interface:

```bash
openssl rand -hex 32
```

Generate and set a unique `SESSION_SECRET` and `ADMIN_TOKEN`, and set `ENV=production`. Production startup fails if either secret is empty. Do not reuse examples or place secrets in logs, docs, URLs, or shared artifacts.

[SECURITY.md](../SECURITY.md) is authoritative for `SESSION_SECRET`, `ADMIN_TOKEN`, admin endpoints, `/metrics`, and multi-user limitations.

## 9. Advanced Tuning

This page does not duplicate simulation limits, memory settings, runtime-lock and stall timeouts, report budgets, or `REPORT_*` variables. Read the comments in `.env.example` before tuning them, then run `make preflight`.
