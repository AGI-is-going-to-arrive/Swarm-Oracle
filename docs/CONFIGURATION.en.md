English | [中文](CONFIGURATION.md)

# SwarmOracle Configuration

All configuration is provided through environment variables. There are two templates:

- **Local development**: copy `.env.example` to `backend/.env`, then edit `backend/.env`. Editing `.env.example` directly does not change your running app.
- **Docker deployment**: edit `.env.docker`; `docker compose` reads it automatically.

This page lists user-facing configuration. More tuning options are documented as comments in the template files.

Minimum browser: Chrome/Edge >= 111, Firefox >= 113, Safari/iOS >= 16.2 (modern browsers that support oklch / color-mix).

---

## 1. LLM Configuration (Required)

SwarmOracle works with any OpenAI-compatible API, including OpenAI, Google Gemini's OpenAI-compatible endpoint, compatible gateways, and local services such as Ollama. For Google Gemini, use `https://generativelanguage.googleapis.com/v1beta/openai` as the Base URL and provide a Gemini API key.
`response_format` support for xAI, OpenRouter, and SiliconFlow is still treated as an OpenAI-compatible assumption; the existing fail-soft fallback handles provider rejection. The Gemini OpenAI-compatible chat path does not inject native-search tools; search enhancement still follows the search provider settings below.

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

`GET /api/capabilities` returns a zero-cost field, `llm_configured: boolean`. It is the merged result of server static LLM config and local model-profile detection: `llm_static_configured` reports whether `.env` / Docker config is usable, and `llm_profile_configured` reports whether `FEATURE_MODEL_PROFILES=true` and the current user has at least one profile with an API key. If either is `true`, the home page and debate entry no longer treat LLM access as unconfigured. This check never calls `health_check()`, never performs an LLM or network request, and never echoes profile API keys.

Model profiles can also store RPM/TPM, a concurrency cap, and tri-state capability overrides for structured outputs / native search: auto-detect, force on, or force off. Auto-detect stores the field as `null` and follows the provider capability at runtime; only force on / force off stores an explicit boolean. These fields flow into LLM calls for main simulations, multi-run, debates, chambers, prediction scoring, social copy, generated headline cards, and report generation. Profile concurrency only tightens the effective cap; global concurrency, global pending, user pending, and purpose lanes still apply.

Automatic launch preflight uses a lightweight LLM connectivity check without provider parallelism probing; Test connection still runs ordinary LLM connectivity, the full provider probe, and a faster native-search probe side by side. The native-search probe only answers whether the tested model / upstream would enter the native web-search tool injection path. It is not the same as the server-default `web_search` hint from `/api/capabilities`, and it does not echo the Base URL or API key. Bare `/v1` entries on known official providers participate in native tool injection as the Responses form; the probe only echoes the effective API form, not the full derived URL. Local, proxy, or unknown providers fail closed to `estimated_parallelism=1` and `tested_parallelism=1` without extra fan-out probing. Local or custom Responses proxies still stay behind the proxy guard by default; only an explicit `xai_responses` or `openai_responses` upstream declaration lets the system use the matching official native-search adapter. During real LLM calls, if injected native-search tools are rejected by the proxy or upstream, the runtime retries once without native tools and returns ordinary LLM output; credential, quota, and rate-limit failures are not treated as this downgrade. `auto`, `off`, or an unset declaration do not release the proxy guard, and force-off native search still vetoes tool injection.

Scenarios that saved a `model_profile_id` try to recover the same profile for later LLM calls such as reports, replay / branch reruns, fork-title rewriting, social copy, and scoring. Recovery is limited to the current user's own profile; when user ownership is missing, id-only recovery is allowed only for a local single-user profile database. If the profile was deleted, belongs to another user, or cannot be verified safely, the backend fails closed and asks you to reselect the profile, or to provide API key, Base URL, and model together for this request. Social headline cards fall back to deterministic cards when safe profile recovery is unavailable, instead of calling the wrong provider.

Static config still follows the previous rule: `llm_static_configured=false` when the runtime still uses a placeholder URL (`http://127.0.0.1:8317/v1`, `http://localhost:8317/v1`, or `http://host.docker.internal:8317/v1`) and `LLM_API_KEY` is empty or still a placeholder such as `sk-12345678` / `your-api-key-here`. It is `true` when a real key is configured, or when the operator explicitly changes to another endpoint.

Known limitation: if your real local OpenAI-compatible gateway also uses `:8317/v1` and does not require an API key, static config detection treats it as unconfigured; saving a model profile with a key still makes `llm_configured` become `true`. The home-page banner can be dismissed, and the diagnostics button can still confirm actual connectivity.

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
| `FEATURE_RESULT_REPORT` | On | The result page shows the report digest entry, with the full standalone view and retry path at `/result/:id/report`. |
| `FEATURE_MULTI_RUN` | On | The home page can start multi-run simulations; the waiting panel lists each worldline, and result pages show run-group distributions and terminal histograms. |
| `FEATURE_YOU_VS_ORACLE` | On | The result page can compare the user's forecast against the Oracle result. |
| `FEATURE_SOCIAL_HEADLINES` | On | Result-page social feeds generate headline cards that can be downloaded or copied. |
| `FEATURE_DOCUMENT_SEED` | On | The home page can turn uploaded documents into scenario seed context. |
| `FEATURE_LOCAL_PACKS` | On | The home page can load local scenario packs; the picker filters by genre segments plus one search box, folds tags into search, previews the selection, and carries the question / suggested settings into simulations. |
| `FEATURE_MODEL_PROFILES` | On | The model profile page and `/admin/setup` can manage local profiles; profiles with a key make the home page and debate entry treat LLM access as configured and can be selected when launching a simulation, debate, or result-page chamber. Chambers keep the selector inside collapsed-by-default Advanced settings, and leaving it blank uses the global default. Profiles can store rate limits, concurrency, structured-output / native-search capability overrides, and native-search upstream declarations. |
| `FEATURE_EDUCATION_TEMPLATES` | On | The home page shows education templates for classroom-style prompts. |
| `FEATURE_PERSONA_EXPORT` | On | Agent Library can export persona backups and create Agents from backups. |

`graph_analysis` is a combined ability: `FEATURE_GRAPH_ANALYSIS=true` is not enough by itself. `FEATURE_CAUSAL_GRAPH=true` must also be enabled before the frontend treats graph analysis as available.

On narrow screens, the graph workbench collapses Split view into a single graph view. Knowledge Graph Explorer and Timeline Galaxy keep mobile hints or accessible list fallbacks.

These backend-internal or experimental flags remain off by default and are not ordinary user entries: `FEATURE_ROUNDTABLE_INSIGHT_LLM`, `FEATURE_HALLUCINATION_GATE`, and `FEATURE_IDENTITY_COMPACTION`.

`FEATURE_RESULT_REPORT` is on by default. When enabled, the result page shows the report digest entry, the backend stores the report in `Scenario.parsed_context.full_report`, and `POST /api/scenario/{id}/report:generate` generates or retries it over HTTP SSE. Report evidence keeps round / branch / agent / message coordinates so the evidence drawer can jump back into replay; failed, partial, and byte-truncated reports have visible states and do not block the original result page. Complete inline reports show only confidence, real-field-derived takeaways, section links, and a standalone report link; the full sections render at `/result/:id/report`, and replay mode does not expose live generation / retry. Report body Markdown is rendered through the safe renderer, with GFM tables and strikethrough enabled and images still disallowed; report verdict / confidence / evidence / dissent / probability charts anchor to the terminal answer leaf, and indicators / watch-list entries are generated from report evidence by the LLM with filler filtered out. Reports that provide `probability_bar` / `faction_share` data render probability and faction charts. Probability and interval values are shown only when they are legally renderable; invalid values are normalized by the backend or degraded to qualitative frontend copy. Retry uses the current tab's BYOK provider policy and refreshes only the report data instead of hard-reloading the whole page; `llm_requests_per_minute / llm_tokens_per_minute` set to `0` means no per-request RPM/TPM cap. Section count, per-section tool-call cap, timeouts, evidence excerpt length, and the full-report byte cap are controlled by the `REPORT_*` settings in `.env.example`; set it to `false` and restart the backend if you need the plain verdict + story result page.

Common report-generation settings:

| Variable | Meaning | Default |
|----------|---------|---------|
| `REPORT_MAX_SECTIONS` / `REPORT_MIN_SECTIONS` | Upper and lower bounds for full-report sections | `5` / `2` |
| `REPORT_MAX_TOOL_CALLS_PER_SECTION` / `REPORT_MIN_TOOL_CALLS_PER_SECTION` | Per-section ReACT tool-call bounds; no-progress sections converge early | `3` / `2` |
| `REPORT_SECTION_TIMEOUT_SECONDS` | LLM-call timeout for one section, interview, or indicator step | `120` |
| `REPORT_RUNTIME_LOCK_LEASE_SECONDS` | Result-report runtime-lock lease; live generation refreshes it, and a killed worker blocks retries for at most this TTL | `120` |

> Restart the backend after changing feature flags. The frontend reads `/api/capabilities` and hides disabled entries or shows unavailable states instead of failing.

### Search Features That Need Extra Setup

The following features stay off by default because they require an external search service. Hosted providers usually need `WEB_SEARCH_PROVIDER` and `WEB_SEARCH_API_KEY`. If you use `searxng`, provide a reachable `SEARXNG_URL`; SearXNG itself does not require an API key.

This search enhancement is app-layer external retrieval: the system calls Tavily / Exa / Firecrawl / xAI / SearXNG first, then injects the results into the prompt. Model-native search is a separate LLM native path controlled by model profiles, official Responses-form detection, and runtime source-family domains. It is not enabled through `WEB_SEARCH_PROVIDER=native`.

| Flag | Default | When to enable it |
|------|---------|-------------------|
| `ENABLE_WEB_SEARCH` | Off | Enable this when you want the app to search the web before simulation. A working search provider is required. |
| `FEATURE_NEW_SOURCES` | Off | Enable this to show four source checkboxes in advanced settings: Prediction markets (`polymarket`), Finance (`finance`), Academic (`academic`), and Investigative (`news_deep`). They only take effect when search is enabled and the provider supports domain filtering. |
| `FEATURE_FAMILY_QUERY_OPTIMIZATION` | Off | Enable this after using source checkboxes if you want the app to generate better search terms for each source family. |

---

## 3. Search-Augmented Simulation (Optional)

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
| `ENV` | Runtime environment; `production` / `prod` requires security secrets | `development` |
| `HOST` | Backend bind address | `127.0.0.1` |
| `PORT` | Backend port | `18927` |
| `DATABASE_URL` | SQLite database path | `sqlite:///./swarmoracle.db` |
| `CHROMA_PERSIST_DIR` | Vector store directory for Agent memory | `./chroma_data` |
| `CORS_ORIGINS` | Allowed frontend origins | Includes `http://localhost:18928` |

Docker Compose stores the database and Chroma data in the `/data` volume so they persist across container restarts.

---

## 5. Simulation Runtime and Recovery

| Variable | Meaning | Default |
|----------|---------|---------|
| `SIMULATION_LOCK_LEASE_SECONDS` | Runtime-lock lease for the main simulation background task; live tasks refresh it periodically | `120` |
| `SIMULATION_STALL_TIMEOUT_SECONDS` | Seconds without content, progress, or durable activity before the background task converges as stalled | `900` |
| `SIMULATION_STALE_ACTIVITY_LIMIT_SECONDS` | Stale-activity window used by polling reads and startup recovery | `900` |

These values drive background simulation liveness. A running simulation holds and refreshes a runtime lock; as long as WebSocket content frames, round / turn progress, checkpoints, or other durable activity continue, a slow LLM is not killed just because total wall-clock time is long. Only a run with no activity past the stall timeout converges to an error terminal state. Polling reads also avoid fail-forwarding newly created runs or runs that still hold an active lock, so slow parse and first-round warmup are not mistaken for interruption.

---

## 6. Session Gate and Admin Endpoints (Optional, Advanced)

`SESSION_SECRET` is empty by default, which means local development has no auth gate. When set, REST requests need an `X-Session-Token` header, WebSocket connections need first-frame authentication, and `/metrics` can also be accessed with the same session token. This is a temporary coarse-grained demo gate, not a complete multi-user permission system.

`ADMIN_TOKEN` is also empty by default, which leaves `/api/admin/*` diagnostics and `/metrics` open for local development. When set, admin endpoints and `/metrics` accept the `X-Admin-Token` request header; when `SESSION_SECRET` is also set, `/metrics` also accepts a valid `X-Session-Token`. With `ENV=production` / `prod`, empty `SESSION_SECRET` or `ADMIN_TOKEN` fails startup. Docker Compose binds both frontend and backend ports to `127.0.0.1` by default; whenever you change `ports` so the app is reachable beyond your own machine, set `ENV=production`, `SESSION_SECRET`, and `ADMIN_TOKEN` together.

Scenario questions and debate questions have a public 2000-character input limit. Controlled frontend entries clamp or limit input, and backend schemas still hard-reject oversized requests.

---

## 7. Development Test Only

`SWARM_E2E_FIXTURE_MODE=1` enables the frontend offline fixture harness, mainly for release / E2E signoff. When paired with a blackhole backend such as `SWARM_BACKEND_URL=http://127.0.0.1:9`, uncovered `/api`, node-side backend calls, and same-origin `/ws/**` fail closed and fail the test. This mode validates zero fixture escape from the frontend harness; it does not validate real backend business logic.

---

For additional tuning options such as simulation limits and memory compaction budgets, read the comments in `.env.example`. The effective memory compaction cadence still comes from `MEMORY_COMPRESS_INTERVAL`; short-branch fields are kept as compatibility settings.
