English | [中文](USAGE.md)

# SwarmOracle Usage Guide

## Before You Start

Local development uses backend port `18927` and frontend port `18928`. Open http://127.0.0.1:18928 . See the [README](../README.en.md) for startup commands.

- **Offline demo**: no real LLM is required. Start both services, then open any of three complete official samples with one click or import a `.swarm` file from `samples/snapshots/` or your own machine.
- **Live generation**: new simulations, debates, chambers, and reports need a working LLM. Configure the server default, save a usable model profile at `/admin/setup`, or use the separate **BYOK** disclosure on the home page. Explicitly configured exact local hosts may omit the key; remote endpoints still require one. The shipped default endpoint plus empty/placeholder key is only an “unconfigured” sentinel.

Agent count and rounds are sliders in the main home-page form. **Advanced Settings** and **BYOK** are separate disclosures: Advanced Settings controls mode, display, Local Packs, and search; BYOK controls the LLM connection for this run. See [Configuration](CONFIGURATION.en.md) for variables.

On first setup, `/admin/setup` tests the exact Base URL/key/model combination. The wizard can finish only after that test succeeds or you check the explicit “unverified and may not work” acceptance. Editing any connection field clears the previous verification and acceptance. Keyless local access applies only to the exact hosts `localhost`, `127.0.0.1`, `0.0.0.0`, `host.docker.internal`, and `[::1]`.

## Start a Live Simulation

1. Enter a “What if...?” question on the home page, or choose a Quick Start, education template, or Local Pack. Importing a pack replaces the question, language, Agent count, rounds, mode, world context, stakes, and cast preview together, within bounded field and list sizes.
2. Set Agent count, rounds, and mode. Use Advanced Settings for Classic / Pixel Theater, search augmentation, and related options. Open BYOK separately when this run needs another LLM connection. When you use a saved profile unchanged, result pages recover it from the scenario; changing its endpoint or model clears the old profile's model, key, and RPM/TPM, so enter a complete new binding (an exact-local endpoint may still omit the key).
3. Select **Start Simulation** and confirm the settings. If launch is unavailable, the page states whether the question is empty, LLM access is unconfigured, or the run is budget-blocked.

A pack author prompt is labeled as an “Untrusted local pack author note” and remains ordinary reference evidence, never a system instruction. The cast preview does not create or select persistent authoritative Agent identities, but bounded names, roles, and perspectives enter the run as untrusted world-context entities and can influence the simulation. **Refresh Packs** reloads detail even when the current pack keeps the same ID; switching clears the old detail, template, and actions first, and a late response cannot overwrite the new selection. Choosing another pack replaces all old pack material; switching to Quick Start, an education template, or a challenge clears it so it cannot leak into the next run. Pack `demo_snapshots` currently show label and filename metadata only and are not clickable or directly importable; open real files through the home-page official-sample or Snapshot-import entry.

Multi-run opens a waiting panel first. The first run can open live `/sim/:id`; after every run finishes, the result page summarizes the distribution.

## During a Run

- The header shows round, in-round speaking progress, overall progress, and ETA. Slow models show elapsed time.
- Classic renders the branch tree; Pixel Theater renders the stage and toolbar.
- Interventions, gameplay-card use, prediction bets, and worldline commitments are writable only while the run is live. Endings show existing records read-only (including card preview), and replay exposes no write entry.
- Open a profile from the Agent list to separate configured stance from observed emotion and see the matching worldline and round. Replay searches only the selected lineage and round cutoff and explicitly says when no matching observation exists. A linked persistent identity also shows existing memory and growth events; each event includes scenario, branch, round, and `event_type`, and is labeled “Current · selected branch segment” only when it matches both the routed scenario and an explicitly selected branch. Other classifiable events are “Past.”
- If speech succeeds but emotion/stance metadata parsing fails, the speech still appears. Agent profiles, Replay, and Pixel Theater mark the observation unavailable with a bounded error code instead of interpreting it as neutral; the status also survives Snapshot restore or import.
- Interrupted, cancelled, and failed runs settle into explicit terminal states. Unfinished branches are not presented as successful outcomes.

## Result Page

`/result/:id` starts with the original question, prediction verdict, and terminal worldlines. Probabilities normalize only across completed terminal leaves; fork parents do not count as final endings. Report likelihood and analytic confidence likewise use only completed terminal leaves as branch samples plus evidence counts; signed affect-convergence proxies do not raise analytic confidence.

Common actions:

- Expand a worldline story, inspect the causal archive and director debrief, or open the full report at `/result/:id/report`. The causal archive compares gameplay cards, prediction bets, worldline commitments, and final settlement.
- The full report exposes its outer lifecycle, saved sections' generated/rewritten/static-fallback tier, fallback reason, and evidence coordinates. The bounded tool trace actually executed by a generated, rewritten, or static-fallback section after both model tiers fail is persisted and restored after refresh, polling, or reopen; the manual stream's live section progress and “current position” remain transient and are not replayed. Historical excerpts are synthesized by the model from simulation history and labeled with branch/round positions; they are not verbatim source evidence, new interviews, or real persons' words. Branch shares are always labeled as simulation weights, not real-world probabilities.
- Enter a chamber, use One Move Only, or start a Worldline Roundtable. Crossline and roundtable entries require multiple endings.
- Create a counterfactual branch from a real message, or continue from a checkpoint.
- Open Graph Workbench, Knowledge Graph, Timeline, Replay Trace, or Agent follow-up.
- Export Markdown, a snapshot, a share link, or a prediction card. Review the question and endings before publishing them.

When a report, verdict, or graph is unavailable, the page shows an unavailable / partial / failed state. Reports additionally distinguish generating / cancelled / skipped / stalled / truncated. Failure of these enhancements does not erase existing worldline results or saved report sections.

## Modes and Workspaces

- **Debate Arena**: start it from home; live route `/debate/:id`; load the argument map on demand from the result.
- **Ending Chamber**: enter from a worldline. Its model-profile selector lives in the chamber's own Advanced settings; leaving it blank uses the global default.
- **Worldline Roundtable**: available with multiple endings; choose format and cast, then use 1:1 Interview, Research Analyst, or Cross-Examine after completion.
- **Counterfactual, resume, and replay**: rewrite a real message or choose a checkpoint to create a new branch with provenance. Replay messages, Agent state, and memory read only the selected lineage up to its round cutoff. Agent and round selectors wrap on narrow phones instead of requiring horizontal scrolling.
- **Graphs**: `/workbench/:id` combines Causal, Split, and Knowledge Graph; `/kg-explorer/:id` and `/timeline-galaxy/:id` provide standalone views. Legacy causal `stance` nodes and edges are displayed only as affect proxies, not verified stance or causal evidence.
- **Faction timeline**: the result page names the worldline currently being analyzed. Legacy `stance` / `trust` / `opposition` fields are affect proxies derived from model-generated `emotion` / `diverge`; Agent prompts receive only bounded evidence summaries from the previous round of the same scenario and branch. Current causal and faction responses cover only the selected branch segment, do not merge pre-fork ancestor rounds, and never claim every ending or real-world relationships.
- **Custom Agents**: manage Agents at `/agents`, create them manually or from PDF at `/agents/new`; backup import creates a new identity instead of overwriting one.

## Other Routes

- `/history`: simulation history
- `/leaderboard`: prediction leaderboard
- `/me/journal`: personal predictions and calibration
- `/replay/:id`: replay-branch provenance; public replay omits local identities, persona, credentials, and live-only connection data
- `/model-profiles`: model connection profiles

## Search Augmentation

Search augmentation is optional app-layer retrieval. A run can reuse the server search configuration or provide a search provider in the home-page search controls. Model-native search is a separate model-profile capability path. Both show citations only when a provider returns real sources. See [CONFIGURATION.en.md](CONFIGURATION.en.md).

## FAQ

Explicit W2.0 boundary: ancestor-round lineage stitching and clickable, directly importable Local Pack `demo_snapshots` are not implemented yet; both remain W2.1 work.

- **The app opens, but a new run cannot start?** Snapshot demo access does not mean an LLM is configured. Check `/admin/setup`, a model profile, or the server `LLM_*` settings.
- **My local model has no API key?** Use one of the exact local hosts above and provide a model ID; keyless requests send no `Authorization` header. The shipped `127.0.0.1:8317 + empty/placeholder key` combination is an “unconfigured” sentinel, so replace it with your real endpoint or explicitly save that connection in Setup. Lookalike subdomains, numeric/hex loopback forms, and other remote addresses are not treated as local and still require a key.
- **The frontend keeps waiting?** Confirm the backend is running at http://127.0.0.1:18927; the frontend depends on the `/api` and `/ws` proxies.
- **A feature entry is missing?** The UI distinguishes loading, error, disabled, and enabled capability states, with retry on error. After confirming it is disabled, inspect `/api/capabilities` and the matching `FEATURE_*` value. Restart the backend after environment changes.
- **An older snapshot has no Agent emotion source?** The UI labels it as a snapshot or no matching observation instead of inventing a worldline and round.
- **Can I treat the prediction as fact?** No. Do not use it for financial, medical, legal, or other real-world decisions.
