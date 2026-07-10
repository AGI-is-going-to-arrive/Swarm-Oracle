English | [中文](FEATURES.md)

# SwarmOracle Feature Index

This page groups the primary entries by capability instead of maintaining a per-item release checklist. See [USAGE.en.md](USAGE.en.md) for operation and [CONFIGURATION.en.md](CONFIGURATION.en.md) for defaults and flags. The running `/api/capabilities` response is authoritative for availability.

![Simulation and result](screenshots-en/21-simulation.png)

## Core Simulation

- **Question entry**: Quick Starts, education templates, Local Packs, and daily/weekly challenges carry a question and suggested settings into the home page.
- **Document Seed**: upload source material to add world context and an Agent preview for the run; it does not fill in the question.
- **Multi-Agent worldlines**: configure Agent count, rounds, conservative/balanced/exploratory mode, multi-run, and branch probabilities.
- **Two views**: Classic shows the branch structure; Pixel Theater presents live runs with a stage, bubbles, and toolbar.
- **Interventions and gameplay cards**: writable only during live simulation; narration, completed runs, and replay are read-only.
- **Debate Arena**: proposition, opposition, and judge progress through phases; the result loads its argument map on demand.

Primary routes: `/`, `/sim/:id`, `/debate/:id`, `/debate/:id/result`.

## Results and Reports

- **Terminal worldlines**: show verdict, confidence, per-leaf answers, probabilities, and stories; fork parents do not enter the terminal distribution.
- **Full report**: `/result/:id/report` shows sections, evidence, uncertainty, watch signals, and available charts; partial / failed / truncated states remain explicit.
- **Review**: causal archive, director debrief, user-prediction comparison, run-group distribution, and faction timeline.
- **Export**: Markdown, snapshots, permalinks, prediction cards, and redacted public artifacts.

Primary routes: `/result/:id`, `/result/:id/report`.

## Chambers and Roundtable

- **Ending Chamber**: question participants from one worldline, use One Move Only, anchored threads, evidence cards, and a three-turn epilogue.
- **Worldline Roundtable**: representatives from multiple endings discuss with selectable format and cast.
- **Deep Dive**: after completion, use 1:1 Interview, Research Analyst, or Cross-Examine.
- **Model choice**: chambers can select a model profile in their own Advanced settings; leaving it blank uses the global default.

Primary route: `/roundtable/:id`; chambers open from `/result/:id`.

## Counterfactual, Replay, and Graphs

- **Counterfactual and resume**: rewrite a real message or continue from a checkpoint to create a branch with provenance.
- **Branch comparison**: inspect the original and new branches side by side.
- **Replay Trace**: trace the origin of counterfactual and resumed branches.
- **Graph Workbench**: Causal, Split, and Knowledge Graph views, plus standalone Knowledge Graph Explorer and Timeline Galaxy.
- **Node follow-up**: start contextual conversation from supported graph nodes.

Primary routes: `/result/:id/compare`, `/replay/:id`, `/workbench/:id`, `/kg-explorer/:id`, `/timeline-galaxy/:id`.

## Agents and Personal Data

- **Agent Library / Workshop**: create, edit, and favorite custom Agents, including generation from PDF.
- **Identity and memory**: profiles show persona, memory, and growth events; custom Agents can join simulations and debates.
- **Persona backups**: import creates a new identity instead of overwriting an existing Agent.
- **Prediction Journal**: record probabilities, resolve outcomes, and review calibration.
- **History and leaderboard**: inspect local runs by state and filter prediction scores.

Primary routes: `/agents`, `/agents/new`, `/me/journal`, `/history`, `/leaderboard`.

## Snapshot Demo and Live Generation

- **Snapshot demo**: without a real LLM, import `samples/snapshots/*.swarm` to inspect saved results and replay.
- **Live generation**: new simulations, debates, chambers, and reports need a server-default model, model profile with a key, or per-run BYOK.
- **Model management**: `/admin/setup` tests and saves connections; `/model-profiles` manages profiles.
- **UI boundary**: Advanced Settings and BYOK are separate home-page disclosures.

## Optional Search

Search augmentation, source-family filters, and source-query optimization are off by default and require an external provider. App-layer search and model-native search are separate paths. The unified source feed shows only snippets and citations actually returned. See [CONFIGURATION.en.md](CONFIGURATION.en.md).

## Capability Boundaries

Feature entries vary with flags, data state, and replay/live mode. Older snapshots may lack newer fields; the UI degrades to read-only, partial, or unavailable states instead of inventing results. All generated content is for entertainment and exploration.
