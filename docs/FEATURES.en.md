English | [中文](FEATURES.md)

# SwarmOracle Feature Index

This page groups the primary entries by capability instead of maintaining a per-item release checklist. See [USAGE.en.md](USAGE.en.md) for operation and [CONFIGURATION.en.md](CONFIGURATION.en.md) for defaults and flags. The running `/api/capabilities` response is authoritative for availability.

![Simulation and result](screenshots-en/21-simulation.png)

## Core Simulation

- **Question entry**: Quick Starts, education templates, Local Packs, and daily/weekly challenges carry a question and suggested settings into the home page. A Local Pack atomically replaces the question, language, suggested settings, and bounded world context. Its author prompt is untrusted reference evidence. The cast preview does not create or select persistent authoritative Agent identities, but bounded names, roles, and perspectives enter the run as untrusted world-context entities and can influence the simulation.
- **Document Seed**: upload source material to add world context and an Agent preview for the run; it does not fill in the question.
- **Multi-Agent worldlines**: configure Agent count, rounds, conservative/balanced/exploratory mode, multi-run, and branch probabilities.
- **Two views**: Classic shows the branch structure; Pixel Theater presents live runs with a stage, bubbles, and toolbar.
- **Live gameplay**: interventions, gameplay cards, prediction bets, and worldline commitments are writable only during live simulation. Endings show existing records read-only, and replay exposes no write entry.
- **Debate Arena**: proposition, opposition, and judge progress through phases; the result loads its argument map on demand.

Primary routes: `/`, `/sim/:id`, `/debate/:id`, `/debate/:id/result`.

## Results and Reports

- **Terminal worldlines**: show verdict, confidence, per-leaf answers, probabilities, and stories. Likelihood and analytic confidence count only completed terminal leaves as branch samples and use evidence counts; fork parents do not count, and signed affect-convergence proxies do not raise analytic confidence.
- **Full report**: `/result/:id/report` shows sections, evidence, uncertainty, watch signals, and available charts. Generating, partial, failed, cancelled, skipped, stalled, and truncated outer states stay explicit, without erasing saved sections.
- **Report-process transparency**: saved sections are marked generated, rewritten, or static fallback, with a degradation reason when applicable, and evidence links back to replay coordinates. The bounded tool trace actually executed for each section persists with successful or static-fallback output and is restored after refresh, polling, or reopen; the manual stream's live section progress and “current position” remain transient and are not replayed after refresh. “Interviews” are model-synthesized excerpts based on simulation history and labeled with branch/round coordinates; they are neither verbatim source evidence nor new live interviews.
- **Causal archive and review**: gameplay cards, prediction bets, worldline commitments, and final settlement share one traceable record, alongside director debrief, user-prediction comparison, run-group distribution, and faction timeline.
- **Export**: Markdown, snapshots, permalinks, prediction cards, and redacted public artifacts. Public replays omit local identities, persona, credentials, and live-only connection data.

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
- **Narrow-screen controls**: counterfactual Agent and round controls wrap and shrink on phone widths, so a long Agent name cannot push the panel outside the viewport.
- **Replay Trace**: trace the origin of counterfactual and resumed branches. Messages, Agent state, and memory stay within the selected lineage and round cutoff instead of leaking sibling or post-fork future data.
- **Graph Workbench**: Causal, Split, and Knowledge Graph views, plus standalone Knowledge Graph Explorer and Timeline Galaxy.
- **Causal and faction semantics**: legacy `stance` / `trust` / `opposition` fields are affect proxies derived from model-generated `emotion` / `diverge`, not verified stance, trust, relationships, or causal evidence. Causal and faction responses cover only the selected branch segment and do not merge pre-fork ancestor rounds.
- **Node follow-up**: start contextual conversation from supported graph nodes.

Primary routes: `/result/:id/compare`, `/replay/:id`, `/workbench/:id`, `/kg-explorer/:id`, `/timeline-galaxy/:id`.

## Agents and Personal Data

- **Agent Library / Workshop**: create, edit, and favorite custom Agents, including generation from PDF.
- **In-run profiles**: open a profile from the Agent list to separate configured stance from observed emotion. Growth events show scenario, branch, round, and `event_type`; an event is labeled “Current · selected branch segment” only when it matches both the routed scenario and an explicitly selected branch, while other classifiable events are “Past.”
- **No invented metadata after failure**: Agent speech and structured emotion/stance parsing are separate passes. If the second pass fails, the real speech remains and the observation is explicitly unavailable with a bounded error code; live views, Replay, Snapshots, import/export, and Pixel Theater do not backfill a fake `neutral` value.
- **Identity, memory, and growth**: persistent identity profiles show persona, knowledge domains, decision style, memory, and growth events. Simulation memory is isolated by Agent, branch lineage, and round scope.
- **Observation and relationship boundary**: Results select Agent observations only from the chosen branch lineage; replay additionally applies the selected round cutoff. A faction timeline analyzes recorded rounds for its named branch segment only and does not yet stitch pre-fork ancestors. Relationship signals injected into the next Agent round come only from the previous round of the same scenario and branch, with bounded rows, text, and evidence summaries.
- **Persona backups**: import creates a new identity instead of overwriting an existing Agent.
- **Prediction Journal**: record probabilities, resolve outcomes, and review calibration.
- **History and leaderboard**: inspect local runs by state and filter prediction scores.

Primary routes: `/agents`, `/agents/new`, `/me/journal`, `/history`, `/leaderboard`.

## Snapshot Demo and Live Generation

- **Official samples**: without a real LLM, import any of three complete built-in simulations with one click and inspect its result, causal archive, and replay.
- **Local snapshots**: import your own `.swarm` file from the home page; repository samples live under `samples/snapshots/`.
- **Live generation**: new simulations, debates, chambers, and reports need a server-default model, usable model profile, or per-run BYOK. Exact local hosts may be keyless; remote endpoints still require a key.
- **Model management**: `/admin/setup` tests and saves connections; the current combination must pass verification or be explicitly accepted as unverified before the wizard can finish. `/model-profiles` manages profiles. An unchanged profile is not copied into a keyless session override; changing its remote endpoint or model requires the complete connection, detaches the old profile, and clears its rate/capability policy.
- **Pack refresh and demo references**: refresh reloads detail even when the selected pack keeps the same ID; switching clears old detail, template, and actions, and late responses cannot overwrite the new selection. Shipped packs list only real Snapshots, while `demo_snapshots` currently expose read-only label and filename metadata and are not clickable or directly importable.
- **UI boundary**: Advanced Settings and BYOK are separate home-page disclosures.

## Optional Search

Search augmentation, source-family filters, and source-query optimization are off by default and require an external provider. App-layer search and model-native search are separate paths. The unified source feed shows only snippets and citations actually returned. See [CONFIGURATION.en.md](CONFIGURATION.en.md).

## Release Integrity

GHCR backend/frontend images are built from the exact commit that passed CI, first under immutable tags for the same SHA and then promoted as a pair only after both builds succeed. If either promotion fails, restoration of both previous tags is triggered and verified; an incomplete rollback fails the job explicitly. Version tags additionally require an executed release signoff for the same SHA. A stale edge build cannot overwrite a newer `main`, release dry-runs are recorded as planned rather than passed, and browser teardown failures fail E2E instead of being swallowed.

## Capability Boundaries

Feature entries vary with flags, data state, and replay/live mode. Capability checks distinguish loading, error, disabled, and enabled states; failures offer retry instead of being reported as disabled. If an older snapshot lacks observation provenance, the UI labels it as a snapshot or no matching observation instead of inventing a worldline and round. Local Pack context is cleared when switching to another entry such as Quick Start, so it cannot leak into the next launch. W2.1 has not yet delivered ancestor-lineage stitching or interactive, directly importable `demo_snapshots`. Other missing fields degrade to read-only, partial, or unavailable states. All probabilities, relationships, and statements are simulated and are for entertainment and exploration.
