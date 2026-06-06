English | [中文](FEATURES.md)

# SwarmOracle Feature Catalog

This catalog covers the 40 user-visible features checked for release prep. Entry points and default flags match the current code, usage guide, and configuration docs. The three search-related features are off by default and need configuration first.

## Core Simulation

### F01 Home Question Box and Start Simulation
Type a "What if...?" question on the home page and start the main simulation. You confirm the question and run settings before the multi-Agent run begins.
Entry: `/` home -> question box -> `Start Simulation`
![Home question box](screenshots-en/01-home.png)

### F02 Debate Arena
The home page can start Debate Arena directly. It creates proposition, opposition, and judge roles, then runs a shorter staged debate.
Entry: `/` home -> `Start Debate Arena`; live page: `/debate/:id`
![Debate Arena](screenshots-en/20-debate-arena.png)

### F03 Education Templates
Education templates fill the home page with a classroom-style question plus suggested rounds and Agent count. You can still edit the question and settings before launch.
Entry: `/` home -> `Use Template`
![Education template entry](screenshots-en/01-home.png)

### F04 Simulation Mode
Simulation Mode offers Conservative, Balanced, and Exploratory settings for main-simulation branching. Debate Arena uses its own phase rules and does not follow this setting.
Entry: `/` home -> `Simulation Mode`
![Simulation Mode](screenshots-en/01-home.png)

### F05 Simulation Rounds and Agent Count
The two sliders control run length and how many Agents join the main simulation. The page estimates runtime as you adjust them.
Entry: `/` home -> `Simulation Rounds` / `Agent Count`
![Rounds and Agent sliders](screenshots-en/01-home.png)

### F06 Daily Challenge and Weekly Theme
The home page shows today's challenge and the active weekly theme when available. Launching from these cards attaches campaign context, then the result page shows progress from the run.
Entry: `/` home -> daily challenge / weekly theme cards
![Daily challenge and weekly theme](screenshots-en/01-home.png)

### F07 Prediction Verdict
The result page tries to answer the original question in one sentence with confidence. If the verdict is missing or the scenario is old, the page keeps the original question and shows the unavailable state.
Entry: `/result/:id` -> page header
![Prediction verdict](screenshots-en/02-result.png)

### F08 Worldline Cards
Each ending has a title, probability, story summary, and answer to the original question. Expanding a card opens the full story and follow-up entries.
Entry: `/result/:id` -> worldline cards
![Worldline cards](screenshots-en/02-result.png)

### F09 Next-Step Entries
The result page shows next-step cards based on available data and capability flags, such as graphs, replay, comparison, Agent follow-up, and sharing. Unavailable entries keep a visible reason instead of disappearing silently.
Entry: `/result/:id` -> `What's Next`
![Next-step entries](screenshots-en/02-result.png)

## Deep Chat and Roundtable

### F10 Ending Chamber / Oracle Chamber
Enter a chamber from one worldline to ask its participants follow-up questions. They answer from what already happened in that worldline.
Entry: `/result/:id` -> ending card -> `Enter Chamber`
![Ending Chamber](screenshots-en/17-ending-chamber.png)

### F11 One Move Only
One Move Only focuses on one turning point without rerunning the whole main simulation. Use it when you want to ask what changes if a single move changes.
Entry: `/result/:id` -> ending card -> `One Move Only`
![One Move Only](screenshots-en/17-ending-chamber.png)

### F12 Crossline Gallery
Crossline Gallery places another worldline's summary beside the current discussion so you can compare differences. It shows summaries and key quotes, not full transcripts.
Entry: `/result/:id` -> multi-ending result -> `Other Worldline` / `Crossline Gallery`
![Crossline Gallery](screenshots-en/22-crossline-gallery.png)

### F13 Worldline Roundtable
When multiple endings exist, Worldline Roundtable seats representatives from different worldlines at one table. A completed table restores its saved discussion and Deep Dive when you revisit it.
Entry: `/result/:id` -> `Start Roundtable`; roundtable page: `/roundtable/:id`
![Worldline Roundtable](screenshots-en/14-roundtable.png)

### F14 Format, Cast, and Representatives
Roundtable supports Deep Dive, Quick Review, and Clash Mode, with auto cast or custom cast. The representative list shows which worldline each person comes from, and completed rooms can be reseated and restarted.
Entry: `/roundtable/:id` -> format controls / representative list
![Roundtable representatives](screenshots-en/14-roundtable.png)

### F15 Discussion Thread, Phase Flow, and Synthesis
The main roundtable area shows the discussion thread, phase flow, and final synthesis. Phase content starts collapsed on the timeline, then expands when you need the context.
Entry: `/roundtable/:id` -> discussion / phase flow / discussion result
![Roundtable discussion](screenshots-en/14-roundtable.png)

### F16 Deep Dive: 1-on-1 Interview
After a roundtable finishes, the 1-on-1 Interview tab lets you question one representative. The page carries that representative's worldline, stance, and recent quote into the conversation.
Entry: `/roundtable/:id` -> `Deep Dive` -> `1-on-1 Interview`
![Deep Dive interview](screenshots-en/14-roundtable.png)

### F17 Deep Dive: Research Analyst
Research Analyst can inspect the causal graph, participant memories, and web evidence before answering. You can see which tools it used and the final answer.
Entry: `/roundtable/:id` -> `Deep Dive` -> `Research Analyst`
![Research Analyst](screenshots-en/14-roundtable.png)

### F18 Deep Dive: Cross-Examine
Cross-Examine sends the same question to multiple representatives and streams their replies. It works best when you want to compare how different worldlines explain one decision.
Entry: `/roundtable/:id` -> `Deep Dive` -> `Cross-Examine`
![Cross-Examine](screenshots-en/14-roundtable.png)

### F19 Evidence Card
Evidence Card submits a summary from another worldline into the current chamber or roundtable. The backend verifies it belongs to the same scenario before the host or Archivist explains the difference.
Entry: chamber or roundtable discussion -> `Submit evidence card` / `Submit evidence`
![Evidence Card](screenshots-en/18-evidence-card.png)

### F20 Epilogue
Epilogue continues the ending discussion for three short narrative turns without restarting the main simulation. Use it for a quick look at what may happen next in that worldline.
Entry: chamber or roundtable discussion -> `Three-turn epilogue` / `Three more rounds`
![Epilogue](screenshots-en/19-epilogue.png)

## Graph Visualization

### F21 Causal Graph
Causal Graph connects events, forks, and outcomes into a directed graph. Use it to trace which events triggered later changes.
Entry: `/result/:id` -> `View Causal Graph`; page: `/sim/:id/causal-map`
![Causal Graph](screenshots-en/06-causal-map.png)

### F22 Graph Workbench
Graph Workbench groups Causal, Split, and Knowledge Graph views in one place. On narrow screens, Split collapses to a single graph view to avoid horizontal squeeze.
Entry: `/result/:id` -> `Open Graph Workbench`; page: `/workbench/:id`
![Graph Workbench](screenshots-en/07-workbench.png)

### F23 Knowledge Graph Explorer
Knowledge Graph Explorer organizes result data as entities, events, and claims. You can filter nodes, open details, and ask follow-up questions from a node.
Entry: `/result/:id` -> `Knowledge Graph Explorer`; page: `/kg-explorer/:id`
![Knowledge Graph Explorer](screenshots-en/08-kg-explorer.png)

### F24 Timeline Galaxy
Timeline Galaxy places multiple worldlines on one timeline view. It helps you compare which nodes repeat across different outcomes.
Entry: `/result/:id` -> `Timeline Galaxy`; page: `/timeline-galaxy/:id`
![Timeline Galaxy](screenshots-en/09-timeline-galaxy.png)

### F25 Counterfactual Compare
Counterfactual Compare shows the original branch beside the rewritten branch. When no comparison data exists yet, the page shows the correct empty state instead of inventing a branch.
Entry: `/result/:id/compare?branch_a=...&branch_b=...`
![Counterfactual Compare](screenshots-en/13-compare.png)

### F26 Replay Trace
Replay Trace shows where counterfactual and continuation branches came from. When a scenario has no replay branch, the page shows the on-demand empty state.
Entry: `/replay/:id`
![Replay Trace empty state](screenshots-en/12-replay.png)

### F27 Debate Result and Argument Map
The debate result page shows scores, personas, and the judge's verdict. Load the argument map when you want to connect claims, evidence, rebuttals, and rulings.
Entry: `/debate/:id/result`
![Debate result](screenshots-en/15-debate.png)

## Agents and Identity

### F28 Agent Identity Library
Agent Identity Library lets you view, favorite, edit, and delete custom Agents. It also opens profiles, exports backups, and creates new Agents from backups.
Entry: `/agents`
![Agent Identity Library](screenshots-en/03-agent-library.png)

### F29 Custom Agent Workshop
Workshop creates and edits custom Agents manually, and can also generate Agents from a PDF document. For long documents, it keeps successfully created Agents and reports any failed count.
Entry: `/agents/new` or `/agents/edit/:id`
![Custom Agent Workshop](screenshots-en/04-agent-workshop.png)

### F30 Agent Profile Card
Agent Profile Card shows persona, memory, growth events, and source type. Generated Agents can continue into conversation from the card; replay Agents stay read-only.
Entry: result-page Agent entry or `/agents#agent_profile=<id>&tab=memory`
![Agent Profile Card](screenshots-en/16-agent-profile.png)

### F31 Custom Agents in Simulations and Debates
The home page shows a quick selector for custom Agents, and selected Agents can join the main simulation. When you create a debate, the first two selected custom Agents can fill the proposition and opposition slots.
Entry: `/` home -> `Agents` / custom Agent selector
![Custom Agent selector](screenshots-en/01-home.png)

### F32 Persona Backup Import / Export
Agent Library and Workshop provide persona backup import and export. Import creates a new custom Agent and does not overwrite an existing identity.
Entry: `/agents` or `/agents/new` -> backup tools
![Persona backup](screenshots-en/03-agent-library.png)

## Review and Sharing

### F33 Prediction Journal
Prediction Journal records your probability forecast, then lets you resolve the outcome and review calibration. When an entry links to a scenario, visibility is checked against the current user.
Entry: `/me/journal`
![Prediction Journal](screenshots-en/05-journal.png)

### F34 History
History lists past simulations, with status filters and links back into results. Deleting a scenario does not delete prediction journal history.
Entry: `/history`
![History](screenshots-en/11-history.png)

### F35 Leaderboard
Leaderboard shows prediction scores and supports filters by scenario type, date, and Agent count. Filter state syncs to the URL so the current view can be shared.
Entry: `/leaderboard`
![Leaderboard](screenshots-en/10-leaderboard.png)

### F36 Snapshot Import / Export
The home page can import a scenario snapshot ZIP, and the result page can export the current scenario. Export removes keys, tokens, and local provider configuration.
Entry: `/` home -> `Import snapshot`; `/result/:id` -> `Export snapshot`
![Snapshot import and export](screenshots-en/02-result.png)

### F37 Sharing and Prediction Card
The result page can generate sharing copy, copy a permalink, and export a 1200x630 prediction card. The card includes the question, dominant ending, visible sources, and the first few Agent names.
Entry: `/result/:id` -> sharing entry
![Sharing and prediction card](screenshots-en/02-result.png)

## Advanced Optional

### F38 Search-Augmented Simulation
**Requires configuration, see [CONFIGURATION](CONFIGURATION.en.md).** When enabled, the app searches before simulation and injects relevant snippets into Agent prompts. The recommended path uses configured server search first; the advanced path lets you use your own provider for one run.
Entry: `/` home -> `Search-Augmented Simulation`
![Search-Augmented Simulation](screenshots-en/01-home.png)

### F39 Source Family Checkboxes
**Requires configuration, see [CONFIGURATION](CONFIGURATION.en.md).** With `FEATURE_NEW_SOURCES` enabled, advanced settings show four source families: prediction markets, finance, academic, and investigative. They only take effect when search is enabled and the provider supports domain filtering.
Entry: `/` home -> search settings -> source checkboxes
The screenshot package's home image shows the main search-enhancement entry. Source checkboxes appear only after configuration and expanding advanced settings.

### F40 Family Query Optimization
**Requires configuration, see [CONFIGURATION](CONFIGURATION.en.md).** With `FEATURE_FAMILY_QUERY_OPTIMIZATION` enabled, the system generates better search terms for each selected source family. It has no separate button; it changes the current search run when source checkboxes and the provider are both available.
Entry: configure `FEATURE_FAMILY_QUERY_OPTIMIZATION=true`, then use the home-page source checkboxes
This is backend search behavior and has no separate UI or standalone screenshot.
