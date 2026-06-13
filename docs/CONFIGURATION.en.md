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
`response_format` support for xAI, OpenRouter, and SiliconFlow is currently treated as an OpenAI-compatible assumption; the existing fail-soft fallback handles provider rejection, and F9 will move this to explicit per-profile capability.

| Variable | Meaning | Example |
|----------|---------|---------|
| `LLM_RESPONSES_URL` | LLM service URL | `https://api.openai.com/v1` |
| `LLM_API_KEY` | API key | `sk-...` |
| `LLM_MODEL_NAME` | Model name from your provider | `gpt-5.5` / `deepseek-v4-pro` / `gemini-3.5-flash` / `claude-opus-4-8` |
| `LLM_EXTRA_ALLOWED_HOSTS` | Extra request-level BYOK hosts, comma-separated | `llm.example.com,192.168.1.25` |
| `LLM_ALLOW_PRIVATE_BYOK_HOSTS` | Allows request-level BYOK to use extra private / LAN / loopback hosts | `false` by default |
| `LLM_ALLOW_LOCAL_BYOK_HOSTS` | Allows request-level BYOK to use built-in local aliases | `true` by default |

> Security note: `your-api-key-here` is only a placeholder. If `LLM_RESPONSES_URL` is not a local address, the backend refuses to start with a placeholder key. Replace it with your real key. If you use a local gateway such as Ollama, the placeholder is allowed.

Optional LLM tuning usually does not need changes: `LLM_REASONING_EFFORT` (`none/low/medium/high`), `LLM_REQUESTS_PER_MINUTE`, `LLM_TOKENS_PER_MINUTE` (`0` means unlimited), and `LLM_CONCURRENCY`.

Server defaults and request-level BYOK use different trust boundaries:

- Deployment-level `LLM_RESPONSES_URL` is configured by the server operator and is resolved through `_resolve_llm_api_url()` into an OpenAI-compatible endpoint. It does not pass through the request-level BYOK allowlist.
- Request-level `llm_base_url` comes from the user request, only affects that request, and must pass allowlist, scheme, and URL-shape validation. Business requests that send `llm_base_url` must send the API key separately instead of putting it in the URL.
- Request-level custom LLM base URLs are limited to allowed hosts. Hosted providers require `https`; existing local development aliases (`localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, `::1`) may use `http`.
- `LLM_EXTRA_ALLOWED_HOSTS` normalizes comma-separated hosts with IDNA + lowercase and merges them into the request-level allowlist. It accepts host names only, not URLs, ports, userinfo, query strings, or fragments.
- With `LLM_ALLOW_PRIVATE_BYOK_HOSTS=false`, private / LAN / loopback hosts added through `LLM_EXTRA_ALLOWED_HOSTS` are still rejected. Set it to `true` only for single-user local or trusted LAN deployments.
- `LLM_ALLOW_LOCAL_BYOK_HOSTS=true` keeps local development and Docker quickstarts working by default. Set it to `false` for multi-user, public, or LAN deployments so request-level BYOK rejects built-in local aliases and equivalent loopback / unspecified IP forms. Deployment-level `LLM_RESPONSES_URL` is not affected.
- Request-level BYOK URLs with `user:pass@host`, query strings, fragments, or path parameters are always rejected.

`GET /api/capabilities` returns a zero-cost static field, `llm_configured: boolean`. It is `false` when the runtime still uses a placeholder URL (`http://127.0.0.1:8317/v1`, `http://localhost:8317/v1`, or `http://host.docker.internal:8317/v1`) and `LLM_API_KEY` is empty or still a placeholder such as `sk-12345678` / `your-api-key-here`. It is `true` when a real key is configured, or when the operator explicitly changes to another endpoint. This field never calls `health_check()` and never performs an LLM or network request.

Known limitation: if your real local OpenAI-compatible gateway also uses `:8317/v1` and does not require an API key, `llm_configured` treats it as unconfigured. The home-page banner can be dismissed, and the diagnostics button can still confirm actual connectivity.

Recognized LLM provider failures on the main simulation / debate / chamber paths expose a stable machine code plus a short safe message. They never echo provider bodies, HTML, stack traces, Authorization headers, credential-bearing URLs, or API keys:

- `LLM_UNREACHABLE`: network, DNS, connection refused, timeout, and similar connection failures.
- `LLM_AUTH_FAILED`: HTTP `401` / `403`.
- `LLM_MODEL_NOT_FOUND`: HTTP `404`, or a provider body that clearly signals a missing model.
- `LLM_RATE_LIMITED`: HTTP `429`.

Other failures keep the existing generic error path.

---

## 2. Feature Flags

`.env.example` and the `.env.docker.example` template now enable the following user-visible features by default. You do not need to turn them on manually for local use.

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
| `FEATURE_PUBLIC_ARTIFACTS` | On | The share modal can export de-identified public artifact JSON or a single-file HTML gallery. |
| `FEATURE_PREDICTION_JOURNAL` | On | `/me/journal` can record predictions, mark outcomes, and show calibration. |
| `FEATURE_RESULT_VERDICT` | On | The result page tries to show a one-sentence verdict, confidence, and per-worldline answers. |
| `FEATURE_RESULT_REPORT` | On | The result page shows the full report entry, with a standalone view and retry path at `/result/:id/report`. |
| `FEATURE_MULTI_RUN` | On | The home page can start multi-run simulations, and result pages show run-group distributions and terminal histograms. |
| `FEATURE_YOU_VS_ORACLE` | On | The result page can compare the user's forecast against the Oracle result. |
| `FEATURE_SOCIAL_HEADLINES` | On | Result-page social feeds generate headline cards that can be downloaded or copied. |
| `FEATURE_DOCUMENT_SEED` | On | The home page can turn uploaded documents into scenario seed context. |
| `FEATURE_LOCAL_PACKS` | On | The home page can load local scenario packs and carry pack materials into simulations. |
| `FEATURE_MODEL_PROFILES` | On | The model profile page can manage local profiles and let simulations choose one at launch. |
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
