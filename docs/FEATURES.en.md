English | [中文](FEATURES.md)

# SwarmOracle Feature Index

This page groups the primary entries by capability instead of maintaining a per-item release checklist. See [USAGE.en.md](USAGE.en.md) for operation and [CONFIGURATION.en.md](CONFIGURATION.en.md) for defaults and flags. The running `/api/capabilities` response is authoritative for availability.

![Simulation and result](screenshots-en/21-simulation.png)

## Core Simulation

- **Question entry**: Quick Starts, education templates, Local Packs, and daily/weekly challenges carry a question and suggested settings into the home page. A Local Pack atomically replaces the question, language, suggested settings, and bounded world context. Its author prompt is untrusted reference evidence. The cast preview does not create or select persistent authoritative Agent identities, but bounded names, roles, and perspectives enter the run as untrusted world-context entities and can influence the simulation.
- **Document Seed**: upload source material to add world context and an Agent preview for the run; it does not fill in the question.
- **Initial world-event Feed**: configure up to 20 events for the run from the home page. Each event has a source and content, with optional publication time, credibility hint, and tags. Every field is treated as untrusted data rather than a system instruction, and credential-shaped content is rejected.
- **Multi-Agent worldlines**: configure Agent count, rounds, conservative/balanced/exploratory mode, multi-run, and branch probabilities.
- **Native social actions**: each live turn first generates and validates a bounded Decision Envelope, then uses that same decision to constrain both Agent speech and a `POST`, `COMMENT`, `REACTION`, `FOLLOW`, `MUTE`, `SEARCH`, `TREND`, `REFRESH`, or `IDLE` action. `IDLE` requires an explicit reason; the system does not manufacture activity through action quotas, random actions, or forced rotation. Source accounts from initial events can be followed or muted, and muted sources are excluded from later Feed, search, and trend projections. The Decision Envelope retains only auditable fields such as goals, verifiable observations, candidate and selected actions, constraints, and a short factual basis—never hidden chain-of-thought.
- **Cross-round state progression**: after actions persist, each Agent receives a status-bearing State Transition that distinguishes proposed, verified, and failed actions from simulated world consequences. When verifiable, it records prior-action outcomes, goal-progress changes, new information, obstacles, relationship changes, commitments, unresolved questions, world-state changes, and next-round pressure. The next decision reads these records; consecutive highly similar utterances trigger replanning instead of forcing an action. Unverifiable transitions degrade explicitly rather than inventing progress, relationships, or feedback.
- **Two views**: Classic shows the branch structure; Pixel Theater presents live runs with a stage, bubbles, and toolbar.
- **Live gameplay**: interventions, gameplay cards, prediction bets, and worldline commitments are writable only during live simulation. Endings show existing records read-only, and replay exposes no write entry.
- **Debate Arena**: proposition, opposition, and judge progress through phases; the result loads its argument map on demand.

Primary routes: `/`, `/sim/:id`, `/debate/:id`, `/debate/:id/result`.

## Results and Reports

- **Terminal worldlines**: show verdict, confidence, per-leaf answers, probabilities, and stories. Likelihood and analytic confidence count only completed terminal leaves as branch samples and use evidence counts; fork parents do not count, and signed affect-convergence proxies do not raise analytic confidence.
- **Full report**: `/result/:id/report` shows sections, evidence, uncertainty, watch signals, and available charts. Generating, partial, failed, cancelled, skipped, stalled, and truncated outer states stay explicit, without erasing saved sections.
- **Claim–Evidence compilation**: only complete/partial reports compile conclusions into structured Claims before persistence, binding Agent, message, action, branch, and round coordinates while checking same-speaker/same-utterance verbatim quotations, stance attribution, role coverage, and early/middle/late temporal coverage. Insufficient evidence removes unsafe quotation marks, lowers confidence, or rewrites the conclusion as an “Evidence-limited hypothesis”; an unsupported Claim cannot become a high-confidence conclusion. When a compiled report is available, the result-page headline and report analytic confidence also use the same authority. This does not mean other report states completed Claim validation or that every Claim field has a dedicated UI.
- **Report-process transparency**: saved sections are marked generated, rewritten, or static fallback, with a degradation reason when applicable, and evidence links back to replay coordinates. The bounded tool trace actually executed for each section persists with successful or static-fallback output and is restored after refresh, polling, or reopen; the manual stream's live section progress and “current position” remain transient and are not replayed after refresh. “Interviews” are model-synthesized excerpts based on simulation history and labeled with branch/round coordinates; they are neither verbatim source evidence nor new live interviews.
- **Structured premortem**: the full report shows available, partial, or missing failure modes with mechanisms, early warnings, and uncertainty. Each failure mode has its own evidence chain into report evidence coordinates rather than treating ordinary section prose as the chain, and simulation evidence is never presented as real-world proof.
- **Causal archive and review**: gameplay cards, prediction bets, worldline commitments, and final settlement share one traceable record, alongside director debrief, user-prediction comparison, run-group distribution, and faction timeline.
- **Export**: Markdown, snapshots, permalinks, prediction cards, and redacted public artifacts. A Public Artifact can be downloaded as JSON or single-file HTML, copied into an offline Gallery hash link, or opened as a local JSON file by `gallery.html`; this is not a hosted registry or online community. Public replays omit local identities, persona, credentials, and live-only connection data.

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
- **Replay Trace**: trace the origin of counterfactual and resumed branches. Messages, Agent state, and memory stay within the selected effective lineage and round cutoff, including eligible pre-fork ancestor rounds without leaking siblings, parent post-fork future data, or post-cutoff data. A self-contained replay stops at its own boundary.
- **Graph Workbench**: Causal, Split, and Knowledge Graph views, plus standalone Knowledge Graph Explorer and Timeline Galaxy.
- **Action Ledger**: the Causal Review panel shows persisted native actions, targets, and states for the current scenario and effective branch lineage; a separate evidence-ledger API projects Agent utterances, context observations, and derived consequences. Memory evidence exposes only hashed references and source-scenario coordinates, not memory text. Older data without the corresponding evidence is `unavailable` rather than inferred.
- **Causal and faction semantics**: legacy `stance` / `trust` / `opposition` fields are affect proxies derived from model-generated `emotion` / `diverge`, not verified stance, trust, relationships, or causal evidence. Branch-scoped causal, faction, report, Replay, and compare paths use one effective root-to-leaf lineage and branch cutoff, including eligible pre-fork ancestor rounds while excluding siblings and parent post-fork future data.
- **Node follow-up**: start contextual conversation from supported graph nodes.

Primary routes: `/result/:id/compare`, `/replay/:id`, `/workbench/:id`, `/kg-explorer/:id`, `/timeline-galaxy/:id`.

## Agents and Personal Data

- **Agent Library / Workshop**: create, edit, and favorite custom Agents, including generation from PDF.
- **In-run profiles**: open a profile from the Agent list to separate configured stance from observed emotion. Growth events show scenario, branch, round, and `event_type`; an event is labeled “Current · selected branch segment” only when it matches both the routed scenario and an explicitly selected branch, while other classifiable events are “Past.”
- **No invented metadata after failure**: Agent speech and structured emotion/stance parsing are separate passes. If the second pass fails, the real speech remains and the observation is explicitly unavailable with a bounded error code; live views, Replay, Snapshots, import/export, and Pixel Theater do not backfill a fake `neutral` value.
- **Identity, memory, and growth**: persistent identity profiles show persona, knowledge domains, decision style, memory, and growth events. Simulation memory is isolated by Agent, branch lineage, and round scope.
- **Observation and relationship boundary**: Results select Agent observations only from the chosen effective lineage; replay additionally applies the selected round cutoff. A faction timeline uses materialized rounds from the named lineage, including eligible pre-fork ancestors within the cutoff. Relationship signals injected into the next Agent round come only from the previous round of the same scenario and branch, with bounded rows, text, and evidence summaries.
- **Persona backups and Agent Packs**: a single-persona backup import creates a new identity instead of overwriting an existing Agent. Agent Pack v1 exports a group in library selection order and imports it atomically. Identity IDs, owner data, memories, growth history, conversations, and separately stored credentials are excluded, common credential patterns are redacted, and user-authored persona text should still be reviewed before sharing.
- **Prediction Journal**: record probabilities, resolve outcomes, and review calibration.
- **History and leaderboard**: inspect local runs by state and filter prediction scores.

Primary routes: `/agents`, `/agents/new`, `/me/journal`, `/history`, `/leaderboard`.

## Snapshot Demo and Live Generation

- **Official samples**: without a real LLM, import any of three complete built-in simulations with one click and inspect its result, causal archive, and replay.
- **Local snapshots**: import your own `.swarm` file from the home page; repository samples live under `samples/snapshots/`. Before the first database write, import rejects duplicate Agent, Message, or Graph Node source IDs and one Round source ID mapped to conflicting coordinates.
- **Replayable Feed, actions, and runtime**: initial Feed entries, source accounts, native actions, Decision Envelopes, and State Transitions are preserved in Snapshots; import remaps and revalidates branch, Agent, message, and action coordinates. Replay restores the same action and runtime history within the effective lineage and cutoff, while branch Compare includes structured transitions in its diff when they exist. A counterfactual replacement does not fabricate a new decision: it marks the replaced coordinate unavailable and requires later replanning. Legacy data without runtime remains `unavailable` instead of inferring actions, decisions, or state changes from prose.
- **Live generation**: new simulations, debates, chambers, and reports need a server-default model, usable model profile, or per-run BYOK. Exact local hosts may be keyless; remote endpoints still require a key. With LLM mode enabled, required Debate turns and the judge result fail explicitly after exhausted retries or unusable output instead of being replaced by deterministic copy. The initial core plan for an Ending Room has the same fail-closed boundary, while follow-up remains best-effort and may use an anchor. Deterministic content is allowed when the corresponding LLM mode is explicitly disabled.
- **Model management**: `/admin/setup` tests and saves connections; the current combination must pass verification or be explicitly accepted as unverified before the wizard can finish. `/model-profiles` manages profiles. An unchanged profile is not copied into a keyless session override; changing its remote endpoint or model requires the complete connection, detaches the old profile, and clears its rate/capability policy.
- **Pack refresh and demo references**: refresh reloads detail even when the selected pack keeps the same ID; switching clears old detail, template, and actions, and late responses cannot overwrite the new selection. Shipped packs list only real Snapshots. Their `demo_snapshots` are clickable, catalog-whitelisted, validated against the Snapshot contract, and directly importable. Definite failures can be retried; if the outcome cannot be confirmed, the UI asks you to check History before another attempt.
- **UI boundary**: Advanced Settings and BYOK are separate home-page disclosures.

## Optional Search

Search augmentation, source-family filters, and source-query optimization are off by default and require an external provider. App-layer search and model-native search are separate paths. The unified source feed shows only snippets and citations actually returned. See [CONFIGURATION.en.md](CONFIGURATION.en.md).

## Release Integrity

GHCR backend/frontend images are built from the exact commit that passed CI, first under immutable tags for the same SHA and then promoted as a pair only after both builds succeed. If either promotion fails, restoration of both previous tags is triggered and verified; an incomplete rollback fails the job explicitly. Version tags additionally require an executed release signoff for the same SHA. A stale edge build cannot overwrite a newer `main`, release dry-runs are recorded as planned rather than passed, and browser teardown failures fail E2E instead of being swallowed.

## Capability Boundaries

Feature entries vary with flags, data state, and replay/live mode. Capability checks distinguish loading, error, disabled, and enabled states; failures offer retry instead of being reported as disabled. If an older snapshot lacks observation provenance or structured runtime, the UI labels it as a snapshot, no matching observation, or `unavailable` instead of inventing a worldline, round, decision, or state change. Local Pack context is cleared when switching to another entry such as Quick Start, so it cannot leak into the next launch. Gallery and Agent Pack are local, offline file workflows rather than hosted registries, online publishing, or community indexes. Other missing fields degrade to read-only, partial, or unavailable states. Decision Envelopes, State Transitions, and Claims are auditable records inside a simulation, not a complete domain world model or real-world proof; `memory_write_candidates` remain candidates rather than evidence of stored or recallable memory. All probabilities, relationships, and statements are simulated and are for entertainment and exploration.
