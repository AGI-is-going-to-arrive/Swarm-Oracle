English | [中文](CONFIGURATION.md)

# SwarmOracle Configuration

All configuration is provided through environment variables. There are two templates:

- **Local development**: copy `.env.example` to `backend/.env`, then edit `backend/.env`. Editing `.env.example` directly does not change your running app.
- **Docker deployment**: edit `.env.docker`; `docker compose` reads it automatically.

This page lists user-facing configuration. More tuning options are documented as comments in the template files.

Minimum browser: Chrome/Edge >= 111, Firefox >= 113, Safari/iOS >= 16.2 (modern browsers that support oklch / color-mix).

---

## 1. LLM Configuration (Required)

SwarmOracle works with any OpenAI-compatible API, including OpenAI, compatible gateways, and local services such as Ollama.

| Variable | Meaning | Example |
|----------|---------|---------|
| `LLM_RESPONSES_URL` | LLM service URL | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API key | `sk-...` |
| `LLM_MODEL_NAME` | Model name from your provider | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |

> Security note: `your-api-key-here` is only a placeholder. If `LLM_RESPONSES_URL` is not a local address, the backend refuses to start with a placeholder key. Replace it with your real key. If you use a local gateway such as Ollama, the placeholder is allowed.

Optional LLM tuning usually does not need changes: `LLM_REASONING_EFFORT` (`none/low/medium/high`), `LLM_REQUESTS_PER_MINUTE`, `LLM_TOKENS_PER_MINUTE` (`0` means unlimited), and `LLM_CONCURRENCY`.

Custom LLM base URLs are limited to allowed hosts: hosted providers require `https`, local development hosts may use `http`, and URLs with `user:pass@host`, query strings, fragments, or path parameters are rejected. If a business request sends `llm_base_url`, send the API key separately instead of putting it in the URL.

---

## 2. Feature Flags

`.env.example` and `.env.docker` now enable the following user-visible features by default. You do not need to turn them on manually for local use.

| Flag | Default | What you will see |
|------|---------|-------------------|
| `FEATURE_CUSTOM_AGENTS` | On | Agent Library and Agent Workshop on the home page; custom Agents can join simulations and debates. |
| `FEATURE_AGENT_IDENTITY` | On | Agents keep cross-scenario identity, memory, growth records, and profile pages. |
| `FEATURE_CAUSAL_GRAPH` | On | The result page can open a causal graph showing events, forks, and endings. |
| `FEATURE_GRAPH_ANALYSIS` | On | Graph pages can show key nodes, connection density, and cross-branch relationships. |
| `FEATURE_COUNTERFACTUAL_REPLAY` | On | Rewrite one real Agent statement and compare the resulting worldline. |
| `FEATURE_FACTIONS` | On | Results and roundtables show faction changes, alliances, and opposition. |
| `FEATURE_ARGUMENT_MAP` | On | Debate results can load an argument map connecting claims, evidence, rebuttals, and rulings. |
| `FEATURE_KG_EXPLORER` | On | The graph workbench can switch to Knowledge Graph; the result page shows Knowledge Graph Explorer and Timeline Galaxy cards. |
| `FEATURE_REPLAY_TRACE` | On | Replay Trace pages show where counterfactual and continuation branches came from. |
| `FEATURE_AGENT_CONVERSATION` | On | Roundtable Deep Dive can run 1:1 interviews; graph nodes can start follow-up questions. |
| `FEATURE_ROUNDTABLE_SURVEY` | On | Roundtable Deep Dive can send one question to multiple representatives and compare answers. |
| `FEATURE_ROUNDTABLE_ANALYST` | On | Roundtable Deep Dive can ask a research analyst to synthesize graph, memory, and evidence context. |
| `FEATURE_SNAPSHOT_EXPORT` | On | The home page can import scenario snapshots; the result page can export a ZIP snapshot. |
| `FEATURE_PREDICTION_JOURNAL` | On | `/me/journal` can record predictions, mark outcomes, and show calibration. |
| `FEATURE_RESULT_VERDICT` | On | The result page tries to show a one-sentence verdict, confidence, and per-worldline answers. |
| `FEATURE_RESULT_REPORT` | On | The result page shows the full report entry, with a standalone view and retry path at `/result/:id/report`. |
| `FEATURE_EDUCATION_TEMPLATES` | On | The home page shows education templates for classroom-style prompts. |
| `FEATURE_PERSONA_EXPORT` | On | Agent Library can export persona backups and create Agents from backups. |

`graph_analysis` is a combined ability: `FEATURE_GRAPH_ANALYSIS=true` is not enough by itself. `FEATURE_CAUSAL_GRAPH=true` must also be enabled before the frontend treats graph analysis as available.

On narrow screens, the graph workbench collapses Split view into a single graph view. Knowledge Graph Explorer and Timeline Galaxy keep mobile hints or accessible list fallbacks.

These backend-internal or experimental flags remain off by default and are not ordinary user entries: `FEATURE_ROUNDTABLE_INSIGHT_LLM`, `FEATURE_HALLUCINATION_GATE`, and `FEATURE_IDENTITY_COMPACTION`.

`FEATURE_RESULT_REPORT` is on by default. When enabled, the result page shows the full report entry, the backend stores the report in `Scenario.parsed_context.full_report`, and `POST /api/scenario/{id}/report:generate` generates or retries it over HTTP SSE. Report evidence keeps round / branch / agent / message coordinates so the evidence drawer can jump back into replay; failed, partial, and byte-truncated reports have visible states and do not block the original result page. Retry uses the current tab's BYOK provider policy; `llm_requests_per_minute / llm_tokens_per_minute` set to `0` means no per-request RPM/TPM cap. Section count, per-section tool-call cap, timeouts, evidence excerpt length, and the full-report byte cap are controlled by the `REPORT_*` settings in `.env.example`; set it to `false` and restart the backend if you need the plain verdict + story result page.

> Restart the backend after changing feature flags. The frontend reads `/api/capabilities` and hides disabled entries or shows unavailable states instead of failing.

### Search Features That Need Extra Setup

The following features stay off by default because they require an external search service. Hosted providers usually need `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY`. If you use `searxng`, provide a reachable `SEARXNG_URL`; SearXNG itself does not require an API key.

| Flag | Default | When to enable it |
|------|---------|-------------------|
| `ENABLE_WEB_SEARCH` | Off | Enable this when you want the app to search the web before simulation. A working search provider is required. |
| `FEATURE_NEW_SOURCES` | Off | Enable this to show four source checkboxes in advanced settings: Prediction markets (`polymarket`), Finance (`finance`), Academic (`academic`), and Investigative (`news_deep`). They only take effect when search is enabled and the provider supports domain filtering. |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | Off | Enable this after using source checkboxes if you want the app to generate better search terms for each source family. |

---

## 3. Search-Enhanced Simulation (Optional)

When enabled, the app searches the web before simulation and injects context into Agent prompts so the run can reflect current information.

| Variable | Meaning | Example |
|----------|---------|---------|
| `ENABLE_WEB_SEARCH` | Main switch | `false` by default |
| `WEB_SEARCH_PROVIDER` | Search provider | `tavily` / `exa` / `firecrawl` / `xai` / `searxng` |
| `WEB_SEARCH_API_KEY` | Search provider key; not needed for `searxng` | - |
| `SEARXNG_URL` | Self-hosted SearXNG URL, only for `searxng` | `http://localhost:8888` |

---

## 4. Server and Database

| Variable | Meaning | Default |
|----------|---------|---------|
| `PORT` | Backend port | `18927` |
| `DATABASE_URL` | SQLite database path | `sqlite:///./swarmoracle.db` |
| `CHROMA_PERSIST_DIR` | Vector store directory for Agent memory | `./chroma_data` |
| `CORS_ORIGINS` | Allowed frontend origins | Includes `http://localhost:18928` |

Docker Compose stores the database and Chroma data in the `/data` volume so they persist across container restarts.

---

## 5. Session Gate and Admin Endpoints (Optional, Advanced)

`SESSION_SECRET` is empty by default, which means local development has no auth gate. When set, REST requests need an `X-Session-Token` header and WebSocket connections need first-frame authentication. This is a temporary coarse-grained demo gate, not a complete multi-user permission system.

`ADMIN_TOKEN` is also empty by default, which leaves `/api/admin/*` diagnostics open for local development. When set, admin endpoints require the `X-Admin-Token` request header. If the Docker deployment is reachable beyond your own machine, set both `SESSION_SECRET` and `ADMIN_TOKEN`.

---

For additional tuning options such as simulation limits and memory compaction budgets, read the comments in `.env.example`.
