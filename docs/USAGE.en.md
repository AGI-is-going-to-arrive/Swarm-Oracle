English | [中文](USAGE.md)

# SwarmOracle Usage Guide

## Before You Start

Local development uses backend port `18927` and frontend port `18928`. Open http://127.0.0.1:18928 . See the [README](../README.en.md) for startup commands.

- **Offline demo**: no real LLM is required. Start both services, then open any of three complete official samples with one click or import a `.swarm` file from `samples/snapshots/` or your own machine.
- **Live generation**: new simulations, debates, chambers, and reports need a working LLM. Configure the server default, save a model profile with a key at `/admin/setup`, or use the separate **BYOK** disclosure on the home page.

Agent count and rounds are sliders in the main home-page form. **Advanced Settings** and **BYOK** are separate disclosures: Advanced Settings controls mode, display, Local Packs, and search; BYOK controls the LLM connection for this run. See [Configuration](CONFIGURATION.en.md) for variables.

## Start a Live Simulation

1. Enter a “What if...?” question on the home page, or choose a Quick Start, education template, or Local Pack.
2. Set Agent count, rounds, and mode. Use Advanced Settings for Classic / Pixel Theater, search augmentation, and related options. Open BYOK separately when this run needs another LLM connection.
3. Select **Start Simulation** and confirm the settings. If launch is unavailable, the page states whether the question is empty, LLM access is unconfigured, or the run is budget-blocked.

Multi-run opens a waiting panel first. The first run can open live `/sim/:id`; after every run finishes, the result page summarizes the distribution.

## During a Run

- The header shows round, in-round speaking progress, overall progress, and ETA. Slow models show elapsed time.
- Classic renders the branch tree; Pixel Theater renders the stage and toolbar.
- Interventions, gameplay-card use, prediction bets, and worldline commitments are writable only while the run is live. Endings show existing records read-only (including card preview), and replay exposes no write entry.
- Open a profile from the Agent list to separate configured stance from observed emotion and see the matching worldline and round. A linked persistent identity also shows memory and growth events.
- Interrupted, cancelled, and failed runs settle into explicit terminal states. Unfinished branches are not presented as successful outcomes.

## Result Page

`/result/:id` starts with the original question, prediction verdict, and terminal worldlines. Probabilities normalize only across completed terminal leaves; fork parents do not count as final endings.

Common actions:

- Expand a worldline story, inspect the causal archive and director debrief, or open the full report at `/result/:id/report`. The causal archive compares gameplay cards, prediction bets, worldline commitments, and final settlement.
- Enter a chamber, use One Move Only, or start a Worldline Roundtable. Crossline and roundtable entries require multiple endings.
- Create a counterfactual branch from a real message, or continue from a checkpoint.
- Open Graph Workbench, Knowledge Graph, Timeline, Replay Trace, or Agent follow-up.
- Export Markdown, a snapshot, a share link, or a prediction card. Review the question and endings before publishing them.

When a report, verdict, or graph is unavailable, the page shows an unavailable / partial / failed state. Failure of these enhancements does not erase existing worldline results.

## Modes and Workspaces

- **Debate Arena**: start it from home; live route `/debate/:id`; load the argument map on demand from the result.
- **Ending Chamber**: enter from a worldline. Its model-profile selector lives in the chamber's own Advanced settings; leaving it blank uses the global default.
- **Worldline Roundtable**: available with multiple endings; choose format and cast, then use 1:1 Interview, Research Analyst, or Cross-Examine after completion.
- **Counterfactual, resume, and replay**: rewrite a real message or choose a checkpoint to create a new branch with provenance. Replay messages, Agent state, and memory read only the selected lineage up to its round cutoff.
- **Graphs**: `/workbench/:id` combines Causal, Split, and Knowledge Graph; `/kg-explorer/:id` and `/timeline-galaxy/:id` provide standalone views.
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

- **The app opens, but a new run cannot start?** Snapshot demo access does not mean an LLM is configured. Check `/admin/setup`, a model profile, or the server `LLM_*` settings.
- **The frontend keeps waiting?** Confirm the backend is running at http://127.0.0.1:18927; the frontend depends on the `/api` and `/ws` proxies.
- **A feature entry is missing?** The UI distinguishes loading, error, disabled, and enabled capability states, with retry on error. After confirming it is disabled, inspect `/api/capabilities` and the matching `FEATURE_*` value. Restart the backend after environment changes.
- **An older snapshot has no Agent emotion source?** The UI labels it as a snapshot or no matching observation instead of inventing a worldline and round.
- **Can I treat the prediction as fact?** No. Do not use it for financial, medical, legal, or other real-world decisions.
