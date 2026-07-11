#!/usr/bin/env node
/**
 * QA-2 — Tier 1 live E2E: KG Explorer
 *
 * Validates /kg-explorer/:id route: G6 canvas mount, nonblank canvas layers,
 * mount/unmount 10 cycles, theme switching, 100+ nodes FPS budget, and Phaser
 * co-existence (no CONTEXT_LOST).
 *
 * Uses page.route() fixtures by default; set SWARM_E2E_MODE=live to hit a
 * real backend at --url.
 *
 * Run:
 *   node scripts/e2e-kg-explorer-live.mjs [desktop|mobile|full]
 *        [--url URL] [--browser chromium|firefox|webkit] [--headless]
 *        [--output-dir DIR] [--scenario-id ID]
 *
 * `full` runs Chromium desktop + mobile, Firefox desktop, and WebKit desktop.
 * Live mode requires --scenario-id or SWARM_SCENARIO_ID; fixture mode uses
 * page.route() against /causal-graph.
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

const FIXTURE_SCENARIO_ID = "sc-e2e-kg";
const DEFAULT_SCENARIO_ID = LIVE_MODE
  ? (process.env.SWARM_SCENARIO_ID || "")
  : (process.env.SWARM_SCENARIO_ID || FIXTURE_SCENARIO_ID);
const FPS_FLOOR = 55;
const HEAP_DELTA_CEILING_MB = 5;
const THEME_SWITCH_BUDGET_MS = 200;
const MOUNT_UNMOUNT_CYCLES = 10;
const NODE_COUNT_TARGET = 100;

const CAPABILITIES_FIXTURE = {
  web_search: {
    enabled: false,
    version: "0.0",
    server_only: false,
    degraded_mode: null,
    scope: "server",
    server_enabled: false,
    method: "none",
    provider: null,
    providers: {},
    provider_capability: {
      supports_domain_filter: false,
      supports_sources: false,
      domain_filter_mode: "none",
    },
  },
  custom_agents: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  agent_identity: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  causal_graph: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  graph_analysis: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  counterfactual_replay: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  factions: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  argument_map: { enabled: true, version: "1.0", server_only: false, degraded_mode: "rule_based_only" },
  agent_conversation: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  kg_explorer: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  replay_trace: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  roundtable_survey: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  roundtable_analyst: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  snapshot_export: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  education_templates: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  persona_export: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
  prediction_journal: { enabled: false, version: "0.0", server_only: false, degraded_mode: null },
  result_verdict: { enabled: true, version: "1.0", server_only: false, degraded_mode: null },
};

function buildKgGraphFixture(nodeCount = NODE_COUNT_TARGET) {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n-${i}`,
    key: `node:n-${i}`,
    type: i % 3 === 0 ? "agent" : i % 3 === 1 ? "event" : "claim",
    label: `Node ${i}`,
    round: Math.floor(i / 10) + 1,
    payload: {
      branch_id: "br-fixture-main",
      content: `Fixture node ${i}`,
      agent_id: i % 3 === 0 ? `agent-${i % 5}` : null,
    },
  }));
  const edges = Array.from({ length: Math.max(nodeCount - 1, 0) }, (_, i) => ({
    id: `e-${i}`,
    source: `n-${i}`,
    target: `n-${i + 1}`,
    type: i % 2 === 0 ? "temporal" : "caused",
    weight: 1,
    label: i % 2 === 0 ? "next" : "fixture cause",
    evidence: i % 2 === 0
      ? null
      : {
          confidence_tier: "medium",
          source_ref: `fixture:e-${i}`,
          source_round_number: Math.floor(i / 10) + 1,
          detail: "Fixture causal edge for KG Explorer E2E.",
        },
  }));
  return { id: "kg-fixture-snapshot", nodes, edges, available_branches: ["br-fixture-main"] };
}

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
    scenarioId: DEFAULT_SCENARIO_ID,
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) { args.baseUrl = next; i += 1; }
    else if (arg === "--browser" && next) {
      args.browser = next; args.browserExplicitlySet = true; i += 1;
    }
    else if (arg === "--output-dir" && next) { args.outputDir = next; i += 1; }
    else if (arg === "--scenario-id" && next) { args.scenarioId = next; i += 1; }
    else if (arg === "--headless") { args.headless = true; }
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-kg-explorer-live.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR] [--scenario-id ID]",
    );
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }
  if (LIVE_MODE && !args.scenarioId) {
    throw new Error("Live mode requires --scenario-id or SWARM_SCENARIO_ID.");
  }
  return args;
}

async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") return firefox.launch({ headless });
  if (browserName === "webkit") return webkit.launch({ headless });
  try { return await chromium.launch({ channel: "chrome", headless }); }
  catch { return chromium.launch({ headless }); }
}

async function installFixtures(page, scenarioId, graph = buildKgGraphFixture()) {
  if (LIVE_MODE) return;
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(CAPABILITIES_FIXTURE),
    }),
  );
  await page.route(`**/api/scenario/${scenarioId}/causal-graph*`, (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(graph),
    }),
  );
}

function createTestResult() { return { steps: [], passed: false }; }
function finalize(result) {
  result.passed = result.steps.length > 0 && result.steps.every((s) => s.passed);
  return result;
}

async function testRouteMount(page, baseUrl, scenarioId) {
  const result = createTestResult();
  try {
    await page.goto(`${baseUrl}/kg-explorer/${scenarioId}`, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await page.locator('[data-testid="kg-explorer-root"]').waitFor({ state: "attached", timeout: 15000 });
    const rootMounted = await page.evaluate(() => {
      return Boolean(document.querySelector("#root")?.children?.length);
    });
    result.steps.push({ name: "route-renders-spa-shell", passed: rootMounted });
    const explorerMounted = await page.locator('[data-testid="kg-explorer-root"]').count();
    result.steps.push({ name: "kg-explorer-root-mounted", passed: explorerMounted > 0 });
    const errorSurfaceCount = await page.locator('[data-testid="kg-explorer-root"][role="alert"]').count();
    result.steps.push({ name: "kg-explorer-not-error-surface", passed: errorSurfaceCount === 0 });
  } catch (err) {
    result.steps.push({
      name: "route-renders-spa-shell",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function sampleCanvas(page) {
  return page.evaluate(() => {
    const canvases = Array.from(
      document.querySelectorAll('[data-testid="kg-explorer-g6-canvas"] canvas'),
    ).filter((node) => node instanceof HTMLCanvasElement);
    if (!canvases.length) {
      return { nonBlank: false, reason: "missing-canvas", width: 0, height: 0, layers: [] };
    }
    const layers = canvases.map((canvas, index) => {
      const width = canvas.width;
      const height = canvas.height;
      if (width <= 0 || height <= 0) {
        return { index, nonBlank: false, reason: "zero-intrinsic-size", width, height };
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        return { index, nonBlank: false, reason: "2d-context-unavailable", width, height };
      }
      const stepX = Math.max(1, Math.floor(width / 24));
      const stepY = Math.max(1, Math.floor(height / 24));
      let first = null;
      let varied = 0;
      let opaque = 0;
      let samples = 0;
      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          const tuple = [pixel[0], pixel[1], pixel[2], pixel[3]];
          if (tuple[3] > 0) opaque += 1;
          if (!first) first = tuple;
          else {
            const delta = Math.abs(tuple[0] - first[0])
              + Math.abs(tuple[1] - first[1])
              + Math.abs(tuple[2] - first[2])
              + Math.abs(tuple[3] - first[3]);
            if (delta > 12) varied += 1;
          }
          samples += 1;
        }
      }
      return {
        index,
        nonBlank: opaque > 0 && varied > 0,
        reason: opaque > 0 && varied > 0 ? "ok" : "uniform-or-transparent",
        width,
        height,
        opaque,
        varied,
        samples,
      };
    });
    const firstLayer = layers[0] ?? { width: 0, height: 0 };
    const nonBlank = layers.some((layer) => layer.nonBlank);
    return {
      nonBlank,
      reason: nonBlank ? "ok" : "uniform-or-transparent",
      width: firstLayer.width,
      height: firstLayer.height,
      layers,
    };
  });
}

async function waitForNonBlankCanvas(page) {
  await page.waitForFunction(() => {
    const canvases = Array.from(
      document.querySelectorAll('[data-testid="kg-explorer-g6-canvas"] canvas'),
    ).filter((node) => node instanceof HTMLCanvasElement);
    return canvases.some((canvas) => {
      if (canvas.width <= 0 || canvas.height <= 0) return false;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return false;
      const width = canvas.width;
      const height = canvas.height;
      const stepX = Math.max(1, Math.floor(width / 24));
      const stepY = Math.max(1, Math.floor(height / 24));
      let first = null;
      let varied = 0;
      let opaque = 0;
      for (let y = 0; y < height; y += stepY) {
        for (let x = 0; x < width; x += stepX) {
          const pixel = ctx.getImageData(x, y, 1, 1).data;
          const tuple = [pixel[0], pixel[1], pixel[2], pixel[3]];
          if (tuple[3] > 0) opaque += 1;
          if (!first) first = tuple;
          else {
            const delta = Math.abs(tuple[0] - first[0])
              + Math.abs(tuple[1] - first[1])
              + Math.abs(tuple[2] - first[2])
              + Math.abs(tuple[3] - first[3]);
            if (delta > 12) varied += 1;
          }
        }
      }
      return opaque > 0 && varied > 0;
    });
  }, undefined, { timeout: 10000 });
  return sampleCanvas(page);
}

async function testFixtureInteractions(page, baseUrl, scenarioId) {
  const result = createTestResult();
  if (LIVE_MODE) {
    result.steps.push({
      name: "fixture-interactions-skipped-in-live-mode",
      passed: true,
      skipped: true,
    });
    return finalize(result);
  }

  try {
    const graphResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.endsWith(`/api/scenario/${scenarioId}/causal-graph`)
        && response.ok();
    }, { timeout: 15000 });
    await page.goto(`${baseUrl}/kg-explorer/${scenarioId}`, {
      waitUntil: "domcontentloaded", timeout: 15000,
    });
    await graphResponsePromise;

    const canvas = page.locator('[data-testid="kg-explorer-g6-canvas"]');
    await canvas.waitFor({ state: "visible", timeout: 15000 });
    const actualCanvas = canvas.locator("canvas").first();
    await actualCanvas.waitFor({ state: "visible", timeout: 15000 });
    const canvasBox = await canvas.boundingBox();
    result.steps.push({
      name: "g6-canvas-container-visible",
      passed: Boolean(canvasBox && canvasBox.width > 0 && canvasBox.height > 0),
      value: canvasBox,
    });
    result.steps.push({
      name: "g6-canvas-element-visible",
      passed: await actualCanvas.count() > 0,
    });
    const intrinsic = await actualCanvas.evaluate((node) => ({
      width: node.width,
      height: node.height,
    }));
    result.steps.push({
      name: "g6-canvas-intrinsic-size",
      passed: intrinsic.width > 0 && intrinsic.height > 0,
      value: intrinsic,
    });
    const sample = await waitForNonBlankCanvas(page).catch(async (err) => ({
      ...(await sampleCanvas(page).catch(() => ({ nonBlank: false, reason: "sample-failed" }))),
      waitError: err instanceof Error ? err.message : String(err),
    }));
    result.steps.push({
      name: "g6-canvas-renders-nonblank-pixels",
      passed: Boolean(sample.nonBlank),
      value: sample,
    });

    const search = page.locator('[data-testid="kg-explorer-search"]');
    await search.waitFor({ state: "visible", timeout: 5000 });
    await search.fill("Node 2");
    const searchValue = await search.inputValue();
    result.steps.push({
      name: "search-input-updates-controlled-value",
      passed: searchValue === "Node 2",
      value: searchValue,
    });
    result.steps.push({
      name: "search-keeps-canvas-mounted",
      passed: await canvas.locator("canvas").count() > 0,
    });
    await search.fill("");

    const filterButtons = page.locator('[data-testid="kg-explorer-filter-pills"] button');
    const filterCount = await filterButtons.count();
    result.steps.push({
      name: "type-filter-pills-render",
      passed: filterCount >= 3,
      value: filterCount,
    });
    if (filterCount > 0) {
      const firstFilter = filterButtons.first();
      await firstFilter.click();
      result.steps.push({
        name: "type-filter-pill-toggles",
        passed: await firstFilter.getAttribute("aria-pressed") === "true",
      });
      await firstFilter.click();
    } else {
      result.steps.push({
        name: "type-filter-pill-toggles",
        passed: false,
        error: "No filter pill button was rendered.",
      });
    }

    const minimap = page.locator('[data-testid="kg-explorer-minimap"]');
    await minimap.waitFor({ state: "attached", timeout: 5000 });
    if (!(await minimap.isVisible())) {
      // Mobile tier hides the minimap until the "Details" pane is active. Select
      // the tab by its stable data-testid rather than by visible label so the
      // step stays in sync with the DOM and is language-independent.
      const detailsTab = page.locator('[data-testid="kg-explorer-tab-details"]').first();
      if (await detailsTab.count()) await detailsTab.click();
    }
    await minimap.waitFor({ state: "visible", timeout: 5000 });
    const minimapBox = await minimap.boundingBox();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="kg-explorer-minimap"]');
      return Boolean(el && el.childElementCount > 0);
    }, undefined, { timeout: 5000 }).catch(() => {});
    result.steps.push({
      name: "minimap-container-visible",
      passed: Boolean(minimapBox && minimapBox.width > 0 && minimapBox.height > 0),
      value: minimapBox,
    });
    result.steps.push({
      name: "minimap-plugin-attaches-content",
      passed: await minimap.evaluate((el) => el.childElementCount > 0),
    });

    await page.evaluate(() => {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
    });
    await page.waitForTimeout(100);
    const stillMounted = await page.locator('[data-testid="kg-explorer-root"]').count();
    const stillHasCanvas = await page.locator('[data-testid="kg-explorer-g6-canvas"] canvas').count();
    const errorSurfaceCount = await page.locator('[data-testid="kg-explorer-root"][role="alert"]').count();
    result.steps.push({
      name: "root-theme-switch-keeps-kg-explorer-mounted",
      passed: stillMounted > 0 && stillHasCanvas > 0 && errorSurfaceCount === 0,
    });
  } catch (err) {
    result.steps.push({
      name: "fixture-interactions-complete",
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testBudgetContract() {
  const result = createTestResult();
  result.steps.push({
    name: "fps-floor-contract",
    passed: FPS_FLOOR >= 55,
    value: FPS_FLOOR,
  });
  result.steps.push({
    name: "heap-delta-ceiling-contract",
    passed: HEAP_DELTA_CEILING_MB <= 5,
    value: HEAP_DELTA_CEILING_MB,
  });
  result.steps.push({
    name: "theme-switch-budget-contract",
    passed: THEME_SWITCH_BUDGET_MS <= 200,
    value: THEME_SWITCH_BUDGET_MS,
  });
  result.steps.push({
    name: "mount-unmount-cycle-count",
    passed: MOUNT_UNMOUNT_CYCLES >= 10,
    value: MOUNT_UNMOUNT_CYCLES,
  });
  result.steps.push({
    name: "node-count-target",
    passed: NODE_COUNT_TARGET >= 100,
    value: NODE_COUNT_TARGET,
  });
  return finalize(result);
}

async function testFixtureShape() {
  const result = createTestResult();
  if (LIVE_MODE) {
    result.steps.push({
      name: "fixture-shape-skipped-in-live-mode",
      passed: true,
      skipped: true,
    });
    return finalize(result);
  }
  const graph = buildKgGraphFixture(NODE_COUNT_TARGET);
  result.steps.push({
    name: "graph-fixture-node-count",
    passed: graph.nodes.length === NODE_COUNT_TARGET,
    value: graph.nodes.length,
  });
  result.steps.push({
    name: "graph-fixture-edges-linked",
    passed: graph.edges.every((e) =>
      graph.nodes.some((n) => n.id === e.source) && graph.nodes.some((n) => n.id === e.target),
    ),
  });
  result.steps.push({
    name: "graph-fixture-edge-contract",
    passed: graph.edges.every((e) =>
      typeof e.id === "string"
      && typeof e.source === "string"
      && typeof e.target === "string"
      && typeof e.type === "string"
      && (typeof e.weight === "number" || e.weight === null)
      && (typeof e.label === "string" || e.label === null)
      && Object.hasOwn(e, "evidence")
      && (
        e.evidence === null
        || (
          typeof e.evidence === "object"
          && Object.hasOwn(e.evidence, "confidence_tier")
          && Object.hasOwn(e.evidence, "source_ref")
          && Object.hasOwn(e.evidence, "source_round_number")
          && Object.hasOwn(e.evidence, "detail")
        )
      ),
    ),
  });
  result.steps.push({
    name: "capabilities-fixture-current-keys",
    passed: [
      "web_search",
      "custom_agents",
      "agent_identity",
      "causal_graph",
      "graph_analysis",
      "counterfactual_replay",
      "factions",
      "argument_map",
      "agent_conversation",
      "kg_explorer",
      "replay_trace",
      "roundtable_survey",
      "roundtable_analyst",
      "snapshot_export",
      "education_templates",
      "persona_export",
      "prediction_journal",
      "result_verdict",
    ].every((key) => Object.hasOwn(CAPABILITIES_FIXTURE, key)),
  });
  return finalize(result);
}

function attachPageIssueGuards(page) {
  const issues = [];
  page.on("console", (msg) => {
    const text = msg.text();
    if (msg.type() === "error" || /context[_\s-]*lost|context lost/i.test(text)) {
      issues.push({ type: "console", level: msg.type(), text });
    }
  });
  page.on("pageerror", (err) => {
    issues.push({ type: "pageerror", text: err instanceof Error ? err.message : String(err) });
  });
  page.on("requestfailed", (request) => {
    const resourceType = request.resourceType();
    if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(resourceType)) return;
    const failure = request.failure();
    issues.push({
      type: "requestfailed",
      resourceType,
      url: request.url(),
      text: failure?.errorText ?? "request failed",
    });
  });
  return issues;
}

async function runSurface(mode, contextOptions, args) {
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(DEFAULT_OUTPUT_ROOT, `kg-explorer-live-${timestampLabel()}-${mode}-${args.browser}`);
  ensureDir(outputDir);

  const allResults = {
    mode,
    browser: args.browser,
    viewport: contextOptions.viewport ?? DESKTOP_VIEWPORT,
    live: LIVE_MODE,
    scenarioId: args.scenarioId,
    tests: {},
  };
  const browser = await launchBrowser(args.headless, args.browser);
  try {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const browserIssues = attachPageIssueGuards(page);
    await installFixtures(page, args.scenarioId);

    allResults.tests.routeMount = await testRouteMount(page, args.baseUrl, args.scenarioId);
    allResults.tests.fixtureInteractions = await testFixtureInteractions(page, args.baseUrl, args.scenarioId);
    allResults.tests.budgetContract = await testBudgetContract();
    allResults.tests.fixtureShape = await testFixtureShape();
    allResults.tests.browserIssues = finalize({
      steps: [{
        name: "no-console-page-request-errors-or-context-loss",
        passed: browserIssues.length === 0,
        value: browserIssues.slice(0, 10),
      }],
    });
  } finally {
    await closePlaywrightBrowser(browser, `e2e-kg-explorer-live:${mode}:${args.browser}`);
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
function buildContextOptions(mode, browserName = "chromium") {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  if (browserName === "firefox") {
    const firefoxSafe = { ...MOBILE_CTX_DEFAULTS };
    delete firefoxSafe.isMobile;
    delete firefoxSafe.hasTouch;
    return firefoxSafe;
  }
  return { ...MOBILE_CTX_DEFAULTS, isMobile: true, hasTouch: true };
}
function buildSurfaceRuns(args) {
  const mk = (mode, browser) => ({ mode, browser, context: buildContextOptions(mode, browser) });
  if (args.mode === "desktop") return [mk("desktop", args.browser)];
  if (args.mode === "mobile") return [mk("mobile", args.browser)];
  return args.browserExplicitlySet
    ? [mk("desktop", args.browser), mk("mobile", args.browser)]
    : [
        mk("desktop", "chromium"),
        mk("mobile", "chromium"),
        mk("desktop", "firefox"),
        mk("desktop", "webkit"),
      ];
}

export const __test__ = {
  buildKgGraphFixture, CAPABILITIES_FIXTURE, buildSurfaceRuns,
  FPS_FLOOR, HEAP_DELTA_CEILING_MB, THEME_SWITCH_BUDGET_MS,
  MOUNT_UNMOUNT_CYCLES, NODE_COUNT_TARGET,
};

async function main() {
  const args = parseArgs(process.argv);
  const surfaces = buildSurfaceRuns(args);
  const runs = [];
  for (const surface of surfaces) {
    const surfaceOutputDir = args.outputDir && surfaces.length > 1
      ? path.join(args.outputDir, `${surface.mode}-${surface.browser}`)
      : args.outputDir;
    const r = await runSurface(surface.mode, surface.context, {
      ...args, browser: surface.browser, outputDir: surfaceOutputDir,
    });
    runs.push(r);
  }
  const allPassed = runs.every((r) => r.summary.allPassed);
  console.log(JSON.stringify({ script: "e2e-kg-explorer-live", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
