English | [中文](USAGE.md)

# SwarmOracle Usage Guide

This guide walks you through one complete simulation and explains how each mode works. Before first use, configure your LLM and start the backend and frontend by following the [README](../README.en.md). Local development uses backend port `18927` and frontend port `18928`; open `http://localhost:18928` in your browser.

For the per-feature catalog, see [FEATURES.en.md](FEATURES.en.md).

> Tip: in local development, the backend must be running on `18927` before you open the frontend, otherwise the page will keep waiting or show an error.

---

## First Simulation: 3 Steps

1. On the home page, type a "What if...?" question, for example, "What if Zhuge Liang had lived 10 more years?" You can also choose a Quick Start template, which fills in a question and suggested characters.
2. Optional: adjust **simulation rounds** and **Agent count**. More rounds and more characters produce richer endings, but also take longer. The home page estimates runtime as you adjust them.
3. Select **Start Simulation**, wait for the run to finish, then select **View Results**.

During the run you will see the **Agent list** on the left, the **branch tree** in the middle, and **live dialogue** on the right. Agents speak round by round and respond to each other.

---

## What You Can Do on the Result Page

After a simulation finishes, the result page shows:

- **Prediction verdict**: a direct answer to your original question, with confidence and uncertainty notes when available.
- **Worldline cards**: each ending has a title, probability, story, and answer to the original question.
- **Next-step entries**: depending on the data and server settings, the page shows Oracle Chambers, Roundtable, branch comparison, graph workbench, Knowledge Graph Explorer, Timeline Galaxy, Agent follow-up, and sharing entries.
- **Full report**: the result page shows a report entry with key conclusions, evidence, and uncertainty notes. The evidence drawer can jump back to the cited replay message; you can also open the report at `/result/:id/report` or retry generation there. The report disclaimer follows the current interface language.

Common buttons under an ending card:

- **Read Full Story**: expand the full narrative for that worldline.
- **Enter Chamber**: pick 1-3 participants from the current worldline and ask follow-up questions.
- **One Move Only**: focus on one turning point without rerunning the main simulation.
- **Other Worldline**: compare against another ending when multiple endings exist.

The result page also lets you export Markdown, generate sharing copy, copy a permalink, export a snapshot, open the causal graph, open the graph workbench, and view the leaderboard. The **What's Next** cards continue into branch comparison, the graph workbench, Knowledge Graph Explorer, Timeline Galaxy, Agent follow-up, and sharing.

---

## Six Play Modes

### 1. Multi-Branch Simulation

Type a question on the home page and select **Start Simulation**. One question splits into multiple worldlines. Each worldline includes character dialogue, probability, and an ending. Advanced settings can change input cleanup mode (Blackboard / Raw), display mode (Classic / Pixel Theater), reasoning effort, and simulation mode (Conservative / Balanced / Exploratory).

### 2. Debate Arena

After typing a question, select **Enter Debate Arena**. The app creates affirmative, opposing, and judge roles, then moves through debate phases. On the result page, select **Load map** to view claims, evidence, rebuttals, and rulings as a connected argument map.

### 3. Oracle Chambers

On a result card, select **Enter Chamber** and choose participants from that worldline. They answer using what already happened in that worldline, which works well for "Why did this happen?" and "What were you thinking then?"

### 4. Worldline Roundtable

When multiple endings are available, the result page shows **Start Roundtable**. You can choose the roundtable style and participants, then let representatives from different worldlines discuss the outcome. Single-ending results do not show the roundtable entry.

After the roundtable finishes, the **Deep Dive** workspace appears with three tabs: **1:1 Interview**, **Research Analyst**, and **Cross-Examine**. These are enabled by default. If the server disables a matching feature, the page shows an unavailable state. When you revisit the same completed roundtable later, the saved discussion result and Deep Dive load directly; the page does not send you back to the representative picker.

### 5. Counterfactual Comparison

From the graph workbench or participant analysis area, choose a real statement made by an Agent and rewrite it. The app creates a counterfactual worldline. When it finishes, open **Compare Branches** to see where the new and original worldlines first diverged.

### 6. Causal Graph and Knowledge Graph

Select **View Causal Graph** to see which events caused later events. Select **Graph Workbench** to switch between **Causal**, **Split**, and **Knowledge Graph** views. On narrow screens, Split view collapses to a single graph view, and graph pages keep zoom, search, and mobile navigation hints. When `FEATURE_KG_EXPLORER` is enabled, the result page also shows **Knowledge Graph Explorer** and **Timeline Galaxy** cards for filtering nodes, opening details, and asking node follow-up questions.

---

## Advanced Features Enabled by Default

- **Custom Agent Workshop**: select **Agents** on the home page to create, edit, favorite, export, or import Agents. Custom Agents can join simulations and debates.
- **Education templates**: select **Use template** on the home page to fill in a classroom-style question with suggested settings.
- **Prediction Journal**: open `/me/journal` to record your probability forecast, mark the outcome later, and review calibration.
- **Snapshot import / export**: import a scenario snapshot ZIP from the home page, or export the current scenario snapshot from the result page.
- **Replay Trace**: open `/replay/:id` to inspect where counterfactual and continuation branches came from.
- **Full report**: available by default on the result page and at `/result/:id/report`; generating, partial, failed, and oversized reports show explicit states. Retry generation uses the BYOK settings from the current tab. If the server disables `FEATURE_RESULT_REPORT`, the entry is hidden or shown as unavailable.

---

## Other Entries

- `/history`: browse past simulations, filter by status, reopen results, or delete local scenarios.
- `/leaderboard`: view the prediction leaderboard by scenario type, date, and Agent count.
- `/agents`: manage custom Agents, identity profiles, and backups.
- `/me/journal`: record and review your own predictions.

---

## Search-Enhanced Simulation (Optional)

The home page has a **Search-enhanced simulation** switch. When enabled, the app searches the web before simulation and injects relevant context into Agent prompts. This requires `ENABLE_WEB_SEARCH` and a configured search provider. See [CONFIGURATION.en.md](./CONFIGURATION.en.md). The recommended path does not require you to understand provider internals; follow the prompts and fill in the provider settings.

---

## Language Switch

Use the **EN / 中文** switch in the lower-right corner. Interface text changes immediately. Agent dialogue follows the language used when you asked the question.

---

## FAQ

- **Start Simulation does nothing?** Make sure the question box is not empty and, in local development, that the backend is running on `18927`.
- **Cannot see Causal Graph / Argument Map / Deep Dive / Knowledge Graph Explorer / Timeline Galaxy / Full report?** These entries are controlled by `/api/capabilities`; the templates enable them by default. If you edited `.env`, confirm the related `FEATURE_*` values are `true`, then restart the backend.
- **The result page says "No prediction verdict yet"?** The app could not produce a reliable single verdict for that run. The original question and worldline answers still remain visible.
- **The run stays on "generating narrative" for a long time?** With many branches, the app generates ending stories one by one. Waiting is normal.
- **Can I rely on the AI prediction?** No. SwarmOracle is for entertainment and exploration only. Do not use it for financial, medical, legal, or other real-world decisions.
