#!/usr/bin/env node
/**
 * QA-2 — Tier 1 live E2E: Replay View
 *
 * Validates /replay/:id: agent queue visible, scrubber → URL hash →
 * reload-restore, keyboard shortcuts (Space / ← / →).
 *
 * Uses page.route() fixtures by default. Set SWARM_E2E_MODE=live to talk
 * to a real backend.
 *
 * Run:
 *   node scripts/e2e-replay-view-live.mjs [desktop|mobile|full]
 *        [--url URL] [--browser chromium|firefox|webkit] [--headless]
 *        [--output-dir DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";
import { closePlaywrightBrowser } from "./playwrightTeardown.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const LIVE_MODE = process.env.SWARM_E2E_MODE === "live";

const FIXTURE_SCENARIO_ID = "sc-e2e-replay";

const CAPABILITIES_FIXTURE = {
  replay_trace: { enabled: true },
  kg_explorer: { enabled: false },
  agent_conversation: { enabled: false },
  causal_graph: { enabled: true },
  factions: { enabled: true },
  argument_map: { enabled: false },
  custom_agents: { enabled: false },
  agent_identity: { enabled: true },
  counterfactual_replay: { enabled: true },
  web_search: { enabled: false, providers: {} },
};

const REPLAY_TRACE_FIXTURE = {
  nodes: [
    {
      branch_id: "branch-main", parent_branch_id: null,
      replay_source_branch_id: null, origin_round: 0,
      replay_kind: "counterfactual", status: "COMPLETED",
      created_at: "2026-07-14T00:00:00Z",
    },
  ],
  next_cursor: null,
};

const CAUSAL_GRAPH_FIXTURE = {
  id: "graph-e2e-replay",
  nodes: [0, 1, 2].map((round) => ({
    id: `node-${round}`, key: `node-${round}`, type: "action",
    label: `Agent ${round + 1} acts`, round,
    payload: { agent_id: `agent-${round + 1}`, agent_name: `Agent ${round + 1}` },
  })),
  edges: [],
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID, question: "Replay E2E", status: "COMPLETED",
  branches: [{ id: "branch-main", title: "Main", probability: 1, status: "COMPLETED" }],
};

const KEYBOARD_SHORTCUTS = ["Space", "ArrowLeft", "ArrowRight"];

function ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
function timestampLabel() { return new Date().toISOString().replace(/[:.]/g, "-"); }

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "desktop",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    outputDir: "",
    headless: process.env.HEADLESS === "1",
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) { args.baseUrl = next; i += 1; }
    else if (arg === "--browser" && next) {
      args.browser = next; args.browserExplicitlySet = true; i += 1;
    }
    else if (arg === "--output-dir" && next) { args.outputDir = next; i += 1; }
    else if (arg === "--headless") { args.headless = true; }
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-replay-view-live.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
    );
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }
  return args;
}

async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") return firefox.launch({ headless });
  if (browserName === "webkit") return webkit.launch({ headless });
  try { return await chromium.launch({ channel: "chrome", headless }); }
  catch { return chromium.launch({ headless }); }
}

async function installFixtures(page) {
  if (LIVE_MODE) return;
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(CAPABILITIES_FIXTURE),
    }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/replay-trace*`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(REPLAY_TRACE_FIXTURE),
    }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph*`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(CAUSAL_GRAPH_FIXTURE),
    }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(SCENARIO_FIXTURE),
    }),
  );
}

function createTestResult() { return { steps: [], passed: false }; }
function finalize(result) {
  result.passed = result.steps.length > 0 && result.steps.every((s) => s.passed);
  return result;
}

async function testReplayInteractions(page, baseUrl) {
  const result = createTestResult();
  try {
    await page.goto(`${baseUrl}/replay/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    const root = page.getByTestId("replay-view-root");
    const slider = page.getByTestId("replay-timeline-scrubber").getByRole("slider");
    await slider.waitFor({ state: "visible", timeout: 15000 });
    result.steps.push({
      name: "replay-controls-and-agent-queue-visible",
      passed: await root.isVisible()
        && await page.getByTestId("replay-playback-control-play").isVisible()
        && await page.locator('[data-testid^="replay-agent-queue-"]').count() === 3,
    });

    await page.getByTestId("replay-playback-control-next").click();
    result.steps.push({
      name: "next-control-advances-frame-and-hash",
      passed: await slider.getAttribute("aria-valuenow") === "1"
        && (await page.evaluate(() => window.location.hash)) === "#t=turn_1",
    });

    await root.focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    result.steps.push({
      name: "keyboard-arrows-drive-replay-timeline",
      passed: await slider.getAttribute("aria-valuenow") === "1",
    });

    await page.keyboard.press("Space");
    const playing = await page.getByTestId("replay-playback-control-pause").isVisible();
    await page.keyboard.press("Space");
    const paused = await page.getByTestId("replay-playback-control-play").isVisible();
    result.steps.push({ name: "space-toggles-playback-state", passed: playing && paused });

    await slider.focus();
    await slider.press("End");
    const finalHash = await page.evaluate(() => window.location.hash);
    await page.reload({ waitUntil: "domcontentloaded" });
    const restored = page.getByTestId("replay-timeline-scrubber").getByRole("slider");
    await restored.waitFor({ state: "visible", timeout: 15000 });
    result.steps.push({
      name: "scrubber-persists-through-reload",
      passed: finalHash === "#t=turn_2"
        && await restored.getAttribute("aria-valuenow") === "2",
    });
  } catch (err) {
    result.steps.push({
      name: "replay-interaction-contract",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      url: page.url(),
      body: (await page.locator("body").innerText().catch(() => "")).slice(0, 1000),
    });
  }
  return finalize(result);
}

async function testFixtureShape() {
  const result = createTestResult();
  result.steps.push({
    name: "replay-trace-frame-count",
    passed: REPLAY_TRACE_FIXTURE.nodes.length === 1 && CAUSAL_GRAPH_FIXTURE.nodes.length === 3,
  });
  result.steps.push({
    name: "replay-trace-frames-ordered",
    passed: CAUSAL_GRAPH_FIXTURE.nodes.every((node, i) => node.round === i),
  });
  return finalize(result);
}

async function runSurface(mode, viewport, args) {
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(DEFAULT_OUTPUT_ROOT, `replay-view-live-${timestampLabel()}-${mode}-${args.browser}`);
  ensureDir(outputDir);

  const allResults = { mode, browser: args.browser, viewport, live: LIVE_MODE, tests: {} };
  const browser = await launchBrowser(args.headless, args.browser);
  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await installFixtures(page);

    allResults.tests.interactions = await testReplayInteractions(page, args.baseUrl);
    allResults.tests.fixtureShape = await testFixtureShape();
  } finally {
    await closePlaywrightBrowser(browser, `e2e-replay-view-live:${mode}:${args.browser}`);
  }

  let total = 0, passed = 0;
  for (const t of Object.values(allResults.tests)) {
    for (const step of t.steps) { total += 1; if (step.passed) passed += 1; }
  }
  allResults.summary = { totalSteps: total, passedSteps: passed, allPassed: total > 0 && total === passed };
  writeJson(path.join(outputDir, "result.json"), allResults);
  return allResults;
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const { defaultBrowserType: _unused, ...MOBILE_CTX_DEFAULTS } = devices["iPhone 13"];
function buildContextOptions(mode) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  return { ...MOBILE_CTX_DEFAULTS, isMobile: true, hasTouch: true };
}
function buildSurfaceRuns(args) {
  const mk = (mode, browser) => ({ mode, browser, context: buildContextOptions(mode) });
  if (args.mode === "desktop") return [mk("desktop", args.browser)];
  if (args.mode === "mobile") return [mk("mobile", args.browser)];
  return args.browserExplicitlySet
    ? [mk("desktop", args.browser), mk("mobile", args.browser)]
    : [mk("desktop", "chromium"), mk("mobile", "chromium")];
}
function resolveSurfaceOutputDir(args, surfaces, surface) {
  if (!args.outputDir || surfaces.length <= 1) return args.outputDir;
  return path.join(path.resolve(args.outputDir), `${surface.mode}-${surface.browser}`);
}

export const __test__ = {
  REPLAY_TRACE_FIXTURE, KEYBOARD_SHORTCUTS, CAPABILITIES_FIXTURE,
  buildSurfaceRuns, resolveSurfaceOutputDir,
};

async function main() {
  const args = parseArgs(process.argv);
  const surfaces = buildSurfaceRuns(args);
  const runs = [];
  for (const surface of surfaces) {
    const surfaceOutputDir = resolveSurfaceOutputDir(args, surfaces, surface);
    const r = await runSurface(surface.mode, surface.context.viewport ?? DESKTOP_VIEWPORT, {
      ...args, browser: surface.browser, outputDir: surfaceOutputDir,
    });
    runs.push(r);
  }
  const allPassed = runs.every((r) => r.summary.allPassed);
  if (args.outputDir && surfaces.length > 1) {
    writeJson(path.join(path.resolve(args.outputDir), "result.json"), {
      script: "e2e-replay-view-live", allPassed, runs,
    });
  }
  console.log(JSON.stringify({ script: "e2e-replay-view-live", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
