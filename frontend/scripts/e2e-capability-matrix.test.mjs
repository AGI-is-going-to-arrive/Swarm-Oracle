import assert from "node:assert/strict";
import test from "node:test";

import { __test__ } from "./e2e-capability-matrix.mjs";

test("capability fixture includes every current capability key", () => {
  const payload = __test__.buildCapabilityPayload(__test__.ALL_GATED_KEYS);

  for (const key of [
    "custom_agents",
    "agent_identity",
    "causal_graph",
    "counterfactual_replay",
    "factions",
    "argument_map",
    "agent_conversation",
    "kg_explorer",
    "replay_trace",
    "graph_analysis",
    "roundtable_survey",
    "roundtable_analyst",
    "snapshot_export",
    "education_templates",
    "persona_export",
    "prediction_journal",
  ]) {
    assert.ok(payload[key], `missing capability key: ${key}`);
  }
});

test("web search fixture mirrors provider capability shape", () => {
  const payload = __test__.buildCapabilityPayload(["web_search"]);

  assert.equal(payload.web_search.scope, "server");
  assert.equal(payload.web_search.provider_capability.supports_domain_filter, true);
  assert.equal(payload.web_search.providers.polymarket.configured_host, "us");
  assert.equal(
    payload.web_search.providers.news_deep.capability.domain_filter_mode,
    "query",
  );
});

test("parseArgs accepts output directory for release artifacts", () => {
  const args = __test__.parseArgs([
    "node",
    "script",
    "--url",
    "http://127.0.0.1:19030",
    "--browser",
    "webkit",
    "--output-dir",
    "output/e2e/capability-matrix",
    "--headless",
  ]);

  assert.equal(args.baseUrl, "http://127.0.0.1:19030");
  assert.equal(args.browser, "webkit");
  assert.equal(args.outputDir, "output/e2e/capability-matrix");
  assert.equal(args.headless, true);
});

test("KG Explorer disabled checkpoint verifies current user-visible copy", () => {
  const page = __test__.PAGES.find((entry) => entry.name === "KGExplorerView");

  assert.equal(page?.disabledSurfaceSelector, undefined);
  assert.equal(
    page?.disabledCopy,
    "Knowledge graph view is turned off on this server. Ask the admin to enable it.",
  );
});
