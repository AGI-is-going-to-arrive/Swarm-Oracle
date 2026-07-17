/**
 * X-3A — Phase 3 Batch A Playwright E2E
 * Agent Workshop / Agent Library + Profile Modal / Causal Map
 *
 * Uses page.route() fixtures — no running backend required.
 * Run: node scripts/e2e-phase3-batch-a.mjs [desktop|mobile|full]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";
import { closePlaywrightBrowser } from "./playwrightTeardown.mjs";

import { validateSvgDownloadArtifact } from "./lib/exportValidation.mjs";
import {
  assertFrontendRoutesReady,
  buildPhase3BatchAPreflightPaths,
} from "./lib/frontendPreflight.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const E2E_LOCALE = process.env.SWARM_E2E_LOCALE || "en-US";
const E2E_APP_LANGUAGE = E2E_LOCALE.toLowerCase().startsWith("zh") ? "zh" : "en";
const COMPACT_GRAPH_MAX_WIDTH = 768;
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const REQUIRED_GRAPH_INTERACTION_STEPS = [
  "graph-pan-drag-changes-viewport",
  "graph-zoom-controls-change-scale",
  "graph-fit-view-resets-viewport",
];

// ── Utilities ────────────────────────────────────────────

function ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "desktop",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    headless: process.env.HEADLESS === "1",
    outputDir: null,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      args.browserExplicitlySet = true;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-phase3-batch-a.mjs <desktop|mobile|full> [--url URL] [--output-dir DIR] [--browser chromium|firefox|webkit] [--headless]");
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }

  return args;
}

async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") {
    return firefox.launch({ headless });
  }
  if (browserName === "webkit") {
    return webkit.launch({ headless });
  }
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

async function saveScreenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
}

function parseViewportTransform(transform) {
  if (!transform || transform === "none") {
    return { scale: 1, translateX: 0, translateY: 0 };
  }

  const matrix3dMatch = transform.match(/^matrix3d\((.+)\)$/);
  if (matrix3dMatch) {
    const values = matrix3dMatch[1].split(",").map((value) => Number.parseFloat(value.trim()));
    return {
      scale: Number.isFinite(values[0]) ? values[0] : 1,
      translateX: Number.isFinite(values[12]) ? values[12] : 0,
      translateY: Number.isFinite(values[13]) ? values[13] : 0,
    };
  }

  const matrixMatch = transform.match(/^matrix\((.+)\)$/);
  if (matrixMatch) {
    const values = matrixMatch[1].split(",").map((value) => Number.parseFloat(value.trim()));
    return {
      scale: Number.isFinite(values[0]) ? values[0] : 1,
      translateX: Number.isFinite(values[4]) ? values[4] : 0,
      translateY: Number.isFinite(values[5]) ? values[5] : 0,
    };
  }

  const numberPattern = String.raw`[-+]?\d*\.?\d+(?:e[-+]?\d+)?`;
  const translate3dMatch = transform.match(new RegExp(String.raw`translate3d\(\s*(${numberPattern})px\s*,\s*(${numberPattern})px\s*,\s*(${numberPattern})px\s*\)`, "i"));
  const translateMatch = transform.match(new RegExp(String.raw`translate\(\s*(${numberPattern})px(?:\s*,\s*(${numberPattern})px)?\s*\)`, "i"));
  const scaleMatch = transform.match(new RegExp(String.raw`scale\(\s*(${numberPattern})`, "i"));
  const translateX = translate3dMatch
    ? Number.parseFloat(translate3dMatch[1])
    : translateMatch
      ? Number.parseFloat(translateMatch[1])
      : 0;
  const translateY = translate3dMatch
    ? Number.parseFloat(translate3dMatch[2])
    : translateMatch?.[2]
      ? Number.parseFloat(translateMatch[2])
      : 0;
  const scale = scaleMatch ? Number.parseFloat(scaleMatch[1]) : 1;

  if ([scale, translateX, translateY].every((value) => Number.isFinite(value))) {
    return { scale, translateX, translateY };
  }

  return { scale: 1, translateX: 0, translateY: 0 };
}

async function readViewportTransform(page, containerSelector = ".react-flow") {
  const viewport = page.locator(`${containerSelector} .react-flow__viewport`).first();
  const transform = await viewport.evaluate((element) => {
    const computed = window.getComputedStyle(element).transform;
    return computed && computed !== "none" ? computed : element.getAttribute("transform") ?? element.style.transform ?? "none";
  }).catch(() => "none");
  return parseViewportTransform(transform);
}

async function resolvePanAnchor(page, paneBox) {
  const candidateOffsets = [
    [0.14, 0.18],
    [0.14, 0.82],
    [0.86, 0.18],
    [0.86, 0.82],
    [0.08, 0.5],
    [0.92, 0.5],
  ];
  const candidates = candidateOffsets.map(([xRatio, yRatio]) => ({
    x: paneBox.x + paneBox.width * xRatio,
    y: paneBox.y + paneBox.height * yRatio,
  }));

  return page.evaluate((points) => {
    for (const point of points) {
      const el = document.elementFromPoint(point.x, point.y);
      if (!el) continue;
      if (el.closest(".react-flow__node, .react-flow__controls, .react-flow__minimap, .nodrag, .nopan, button")) continue;
      return point;
    }
    return points[0];
  }, candidates);
}

function didViewportPan(before, after) {
  if (!before || !after) return false;
  return Math.abs(after.translateX - before.translateX) > 8 || Math.abs(after.translateY - before.translateY) > 8;
}

function didViewportScaleChange(before, after) {
  if (!before || !after) return false;
  return Math.abs(after.scale - before.scale) > 0.03;
}

function isNearBaselineTransform(baseline, candidate) {
  if (!baseline || !candidate) return false;
  return (
    Math.abs(candidate.scale - baseline.scale) <= 0.08
    && Math.abs(candidate.translateX - baseline.translateX) <= 24
    && Math.abs(candidate.translateY - baseline.translateY) <= 24
  );
}

async function runGraphViewportInteractions(page, {
  containerSelector = ".react-flow",
  paneSelector = ".react-flow__pane",
  prefix = "graph",
} = {}) {
  const steps = [];
  const pane = page.locator(paneSelector).first();
  const controls = page.locator(`${containerSelector} .react-flow__controls`).first();
  const zoomInButton = controls.getByRole("button", { name: /Zoom in|放大/i }).first();
  const fitViewButton = controls.getByRole("button", { name: /Fit view|适配视图/i }).first();
  const hasZoomInButton = await zoomInButton.isVisible().catch(() => false);
  const hasFitViewButton = await fitViewButton.isVisible().catch(() => false);

  if (hasFitViewButton) {
    await fitViewButton.click();
    await page.waitForTimeout(250);
  }
  const baseline = await readViewportTransform(page, containerSelector);

  const paneBox = await pane.boundingBox().catch(() => null);
  if (paneBox) {
    const anchor = await resolvePanAnchor(page, paneBox);
    const target = {
      x: Math.max(paneBox.x + 24, anchor.x - paneBox.width * 0.18),
      y: Math.min(paneBox.y + paneBox.height - 24, anchor.y + paneBox.height * 0.16),
    };
    await page.mouse.move(anchor.x, anchor.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.mouse.up();
  }
  await page.waitForTimeout(150);
  const afterPan = await readViewportTransform(page, containerSelector);
  steps.push({
    name: `${prefix}-pan-drag-changes-viewport`,
    passed: paneBox != null && didViewportPan(baseline, afterPan),
  });

  if (hasZoomInButton) {
    await zoomInButton.click();
  }
  await page.waitForTimeout(250);
  const afterZoom = await readViewportTransform(page, containerSelector);
  steps.push({
    name: `${prefix}-zoom-controls-change-scale`,
    passed: hasZoomInButton && didViewportScaleChange(afterPan, afterZoom),
  });

  if (hasFitViewButton) {
    await fitViewButton.click();
  }
  await page.waitForTimeout(250);
  const afterFitView = await readViewportTransform(page, containerSelector);
  steps.push({
    name: `${prefix}-fit-view-resets-viewport`,
    passed: hasFitViewButton && isNearBaselineTransform(baseline, afterFitView),
  });

  return steps;
}

function toErrorMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function runNamedTest(testName, page, outputDir, runner) {
  try {
    const result = await runner();
    const steps = Array.isArray(result?.steps) ? result.steps : [];
    const hasExplicitFailure = result?.passed === false || Boolean(result?.error);
    const stepsPassed = steps.every((step) => step?.passed);
    const derivedPassed = steps.length > 0 ? stepsPassed : (result?.passed ?? true);
    return {
      steps,
      passed: !hasExplicitFailure && derivedPassed,
      error: result?.error ?? null,
    };
  } catch (err) {
    const message = toErrorMessage(err);
    await saveScreenshot(page, path.join(outputDir, `${testName}-crash.png`));
    return {
      steps: [{ name: "unhandled-error", passed: false, error: message }],
      passed: false,
      error: message,
    };
  }
}

function summarizeRun(allResults) {
  let totalSteps = 0;
  let passedSteps = 0;
  const failedTests = [];

  for (const [testName, test] of Object.entries(allResults.tests)) {
    const steps = Array.isArray(test?.steps) ? test.steps : [];
    for (const step of steps) {
      totalSteps++;
      if (step?.passed) {
        passedSteps++;
      }
    }
    if (test?.passed === false || test?.error || steps.some((step) => !step?.passed)) {
      failedTests.push(testName);
    }
  }

  return {
    totalSteps,
    passedSteps,
    failedSteps: totalSteps - passedSteps,
    failedTests,
    runError: allResults.error ?? null,
    allPassed: totalSteps > 0 && failedTests.length === 0 && !allResults.error && passedSteps === totalSteps,
  };
}

const IGNORED_REQUEST_FAILURE_TEXT_PATTERNS = [
  /net::ERR_ABORTED/i,
  /NS_BINDING_ABORTED/i,
];
const IGNORED_CONSOLE_ERROR_TEXT_PATTERNS = [
  /Cross-Origin Request Blocked: .*fonts\.gstatic\.com/i,
  /downloadable font: download failed .*fonts\.gstatic\.com/i,
];
const ALLOWED_EXTERNAL_RESOURCE_URL_PATTERNS = [
  /^https:\/\/fonts\.googleapis\.com\//i,
  /^https:\/\/fonts\.gstatic\.com\//i,
];

function matchesAllowedExternalResource(url) {
  return ALLOWED_EXTERNAL_RESOURCE_URL_PATTERNS.some((pattern) => pattern.test(url));
}

function shouldCaptureConsoleMessage(message) {
  const type = message.type();
  if (type !== "error" && type !== "assert") return false;
  if (IGNORED_CONSOLE_ERROR_TEXT_PATTERNS.some((pattern) => pattern.test(message.text()))) return false;
  const locationUrl = message.location()?.url ?? "";
  if (locationUrl && matchesAllowedExternalResource(locationUrl)) return false;
  return message.text().trim().length > 0;
}

function shouldIgnoreRequestFailure(request) {
  const url = request.url();
  if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return true;
  if (matchesAllowedExternalResource(url)) {
    return request.resourceType() === "stylesheet" || request.resourceType() === "font";
  }
  const errorText = request.failure()?.errorText ?? "";
  return IGNORED_REQUEST_FAILURE_TEXT_PATTERNS.some((pattern) => pattern.test(errorText));
}

function attachBrowserIssueMonitor(page) {
  const issues = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };

  page.on("console", (message) => {
    if (!shouldCaptureConsoleMessage(message)) return;
    issues.consoleErrors.push({
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on("pageerror", (error) => {
    issues.pageErrors.push({
      name: error.name,
      text: error.message,
      stack: error.stack ?? null,
    });
  });
  page.on("requestfailed", (request) => {
    if (shouldIgnoreRequestFailure(request)) return;
    issues.requestFailures.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      errorText: request.failure()?.errorText ?? "requestfailed",
    });
  });

  return issues;
}

function buildBrowserRuntimeResult(issues) {
  const snapshot = {
    consoleErrors: [...issues.consoleErrors],
    pageErrors: [...issues.pageErrors],
    requestFailures: [...issues.requestFailures],
  };
  const steps = [
    {
      name: "browser-page-errors-absent",
      passed: snapshot.pageErrors.length === 0,
      error: snapshot.pageErrors.length > 0 ? JSON.stringify(snapshot.pageErrors, null, 2) : null,
    },
    {
      name: "browser-request-failures-absent",
      passed: snapshot.requestFailures.length === 0,
      error: snapshot.requestFailures.length > 0 ? JSON.stringify(snapshot.requestFailures, null, 2) : null,
    },
    {
      name: "browser-console-errors-absent",
      passed: snapshot.consoleErrors.length === 0,
      error: snapshot.consoleErrors.length > 0 ? JSON.stringify(snapshot.consoleErrors, null, 2) : null,
    },
  ];
  const failedBuckets = [];
  if (snapshot.pageErrors.length > 0) failedBuckets.push("pageerror");
  if (snapshot.requestFailures.length > 0) failedBuckets.push("requestfailed");
  if (snapshot.consoleErrors.length > 0) failedBuckets.push("console-error");

  return {
    steps,
    passed: steps.every((step) => step.passed),
    error: failedBuckets.length > 0
      ? `Unexpected browser-side failures detected: ${failedBuckets.join(", ")}`
      : null,
    issues: snapshot,
  };
}

// ── Fixtures ─────────────────────────────────────────────

const FIXTURE_USER_ID = "e2e-test-user";
const FIXTURE_IDENTITY_ID = "ident-e2e-001";
const FIXTURE_SCENARIO_ID = "sc-e2e-causal-001";
const PREFLIGHT_ROUTE_PATHS = buildPhase3BatchAPreflightPaths(FIXTURE_SCENARIO_ID);
const SR_FALLBACK_LIST_TEST_ID = "causal-events-list";

const CAPABILITIES_FIXTURE = {
  causal_graph: { enabled: true },
  counterfactual_replay: { enabled: true },
  factions: { enabled: true },
  argument_map: { enabled: true },
  custom_agents: { enabled: true },
  agent_identity: { enabled: true },
  web_search: { enabled: false },
};

const IDENTITY_FIXTURE = {
  id: FIXTURE_IDENTITY_ID,
  user_id: FIXTURE_USER_ID,
  kind: "custom",
  display_name: "E2E Test Agent",
  role: "analyst",
  persona: "A careful data analyst who values empirical evidence.",
  decision_bias_json: null,
  knowledge_domain_json: '["economics","technology"]',
  continuity_key: "ck-e2e-test",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
};

const MEMORY_FIXTURE = {
  identity_id: FIXTURE_IDENTITY_ID,
  memories: [
    { summary: "Participated in trade policy debate", scenario_id: "sc-old-001", created_at: "2026-04-08T12:00:00Z" },
    { summary: "Shifted from hawkish to moderate stance", scenario_id: "sc-old-002", created_at: "2026-04-09T10:00:00Z" },
  ],
};

const GROWTH_EVENTS_FIXTURE = {
  identity_id: FIXTURE_IDENTITY_ID,
  events: [
    { id: "ge-1", scenario_id: "sc-old-001", branch_id: "b1", round_number: 3, event_type: "stance_shift", summary: "Softened trade stance after tariff data", metrics_json: null, created_at: "2026-04-08T12:30:00Z" },
    { id: "ge-2", scenario_id: "sc-old-002", branch_id: "b2", round_number: 5, event_type: "alliance", summary: "Allied with market reform faction", metrics_json: null, created_at: "2026-04-09T10:15:00Z" },
  ],
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  branches: [
    { id: "branch-root", title: "Baseline track", probability: 0.63 },
    { id: "branch-child", title: "Intervention branch", probability: 0.37 },
  ],
};

const CAUSAL_GRAPH_FIXTURE = {
  id: "cg-e2e-001",
  available_branches: ["branch-root", "branch-child"],
  nodes: [
    {
      id: "n1",
      key: "trade_shock",
      type: "event",
      label: "Trade shock announced",
      round: 1,
      payload: { agent_id: "macro-desk", emotion: "alert", stance_score: -0.2, branch_id: "branch-root" },
    },
    {
      id: "n2",
      key: "stance_shift",
      type: "stance_shift",
      label: "Analysts shift dovish",
      round: 2,
      payload: { agent_id: "macro-desk", emotion: "cautious", stance_score: -0.45, branch_id: "branch-root" },
    },
    {
      id: "n3",
      key: "policy_change",
      type: "event",
      label: "Central bank responds",
      round: 3,
      payload: { agent_id: "policy-board", emotion: "decisive", stance_score: 0.6, branch_id: "branch-child" },
    },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", type: "caused", weight: 0.9, label: "triggered" },
    { id: "e2", source: "n2", target: "n3", type: "influenced", weight: 0.6, label: "influenced" },
  ],
};

const CAUSAL_GRAPH_FILTERED_FIXTURES = {
  "branch-child": {
    id: "cg-e2e-001",
    available_branches: ["branch-root", "branch-child"],
    nodes: [
      {
        id: "n2",
        key: "stance_shift",
        type: "stance_shift",
        label: "Analysts shift dovish",
        round: 2,
        payload: { agent_id: "macro-desk", emotion: "cautious", stance_score: -0.45, branch_id: "branch-root" },
      },
      {
        id: "n3",
        key: "policy_change",
        type: "event",
        label: "Central bank responds",
        round: 3,
        payload: { agent_id: "policy-board", emotion: "decisive", stance_score: 0.6, branch_id: "branch-child" },
      },
    ],
    edges: [
      { id: "e2", source: "n2", target: "n3", type: "influenced", weight: 0.6, label: "influenced" },
    ],
  },
};

// ── Route Interceptor Setup ──────────────────────────────

const ACTION_FIXTURE_QUERY_KEYS = new Set([
  "branch_id",
  "agent_id",
  "action_type",
  "round",
  "status",
  "cursor",
  "limit",
]);

function isValidActionFixtureRequest(rawUrl, method) {
  if (String(method ?? "").toUpperCase() !== "GET") return false;
  try {
    const url = new URL(rawUrl);
    if (url.pathname !== `/api/scenario/${FIXTURE_SCENARIO_ID}/actions`) return false;
    if (url.searchParams.getAll("limit").length !== 1 || url.searchParams.get("limit") !== "100") {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (!ACTION_FIXTURE_QUERY_KEYS.has(key)) return false;
      if (url.searchParams.getAll(key).length !== 1) return false;
    }
    for (const key of ["branch_id", "agent_id", "action_type", "status", "cursor"]) {
      if (url.searchParams.has(key) && !url.searchParams.get(key)?.trim()) return false;
    }
    if (url.searchParams.has("round") && !/^[1-9]\d*$/u.test(url.searchParams.get("round") ?? "")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function installFixtures(page) {
  // Playwright evaluates the most recently registered matching route first.
  // Register this guard before the specific fixtures so any unmatched API call
  // falls through to an explicit abort instead of silently hitting live state.
  await page.route("**/api/**", (route) => route.abort("blockedbyclient"));
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAPABILITIES_FIXTURE) }),
  );
  await page.route("**/api/agents/identities/favorites?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route("**/api/agents/identities?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([IDENTITY_FIXTURE]) }),
  );
  await page.route(`**/api/agents/identities/${FIXTURE_IDENTITY_ID}/memory?*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMORY_FIXTURE) }),
  );
  await page.route(`**/api/agents/identities/${FIXTURE_IDENTITY_ID}/growth-events?*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GROWTH_EVENTS_FIXTURE) }),
  );
  await page.route("**/api/agents/workshop**", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ...IDENTITY_FIXTURE, id: "ident-e2e-new" }),
      });
    }
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph*`, (route) => {
    const url = new URL(route.request().url());
    const branchId = url.searchParams.get("branch_id");
    const fixture = branchId ? (CAUSAL_GRAPH_FILTERED_FIXTURES[branchId] ?? CAUSAL_GRAPH_FIXTURE) : CAUSAL_GRAPH_FIXTURE;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fixture) });
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/actions*`, (route) => {
    if (!isValidActionFixtureRequest(route.request().url(), route.request().method())) {
      return route.abort("blockedbyclient");
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scenario_id: FIXTURE_SCENARIO_ID,
        next_cursor: null,
        has_more: false,
        items: [{
          id: "action:ledger-1",
          sequence: 1,
          branch_id: "branch-root",
          round: 1,
          agent: { id: "agent-ledger-1", name: "Policy Analyst" },
          action_type: "POST",
          status: "verified",
          target: { kind: "topic", id: "evacuation-window" },
          parent_action_id: null,
          content: "Publish the verified evacuation window.",
          payload: {},
          failure_code: null,
          created_at: "2026-07-14T01:02:03Z",
        }],
      }),
    });
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SCENARIO_FIXTURE) }),
  );
}

// ── Test Flows ───────────────────────────────────────────

async function testAgentWorkshop(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "agent-workshop");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to workshop
  await page.goto(`${baseUrl}/agents/new`, { waitUntil: "domcontentloaded" });
  const nameInput = page.locator('#agent-name').first();
  const roleInput = page.locator('#agent-role').first();
  await nameInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await saveScreenshot(page, path.join(stepDir, "01-workshop-loaded.png"));

  // Check form elements exist
  const hasForm = await nameInput.isVisible().catch(() => false);
  results.steps.push({ name: "workshop-form-visible", passed: hasForm });
  if (!hasForm) { results.passed = false; return results; }

  // Fill form
  await nameInput.fill("E2E Test Economist");
  await roleInput.fill("Senior Economist");
  const personaInput = page.locator('#agent-persona').first();
  if (await personaInput.isVisible()) {
    await personaInput.fill("A methodical researcher focused on fiscal policy impacts.");
  }
  await saveScreenshot(page, path.join(stepDir, "02-workshop-filled.png"));
  results.steps.push({ name: "workshop-form-filled", passed: true });

  // Submit
  const submitBtn = page.locator('button[type="submit"]').first();
  if (await submitBtn.isVisible()) {
    await submitBtn.click();
    await page.waitForTimeout(500);
    await saveScreenshot(page, path.join(stepDir, "03-workshop-submitted.png"));
    results.steps.push({ name: "workshop-submitted", passed: true });
  }

  return results;
}

async function testAgentLibraryAndProfile(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "agent-library");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to library
  await page.goto(`${baseUrl}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await saveScreenshot(page, path.join(stepDir, "01-library-loaded.png"));

  // Check agent card exists
  const agentCard = page.locator('[data-testid="agent-card"], article, .agent-card').filter({ hasText: "E2E Test Agent" }).first();
  const hasCard = await agentCard.isVisible().catch(() => false);
  results.steps.push({ name: "agent-card-visible", passed: hasCard });
  if (!hasCard) { results.passed = false; return results; }

  // Click card to open profile modal
  const detailsButton = agentCard.getByRole("button", { name: /View details|查看详情/i }).first();
  if (await detailsButton.isVisible().catch(() => false)) {
    await detailsButton.click();
  } else {
    await agentCard.click();
  }
  await page.waitForTimeout(1000);
  await saveScreenshot(page, path.join(stepDir, "02-profile-modal-open.png"));

  // Check modal content
  const modalTitle = page.locator('dialog h2').first();
  const hasModal = await modalTitle.isVisible().catch(() => false);
  results.steps.push({ name: "profile-modal-visible", passed: hasModal });

  if (hasModal) {
    const titleText = await modalTitle.textContent();
    results.steps.push({ name: "profile-title-correct", passed: titleText === "E2E Test Agent" });

    // Check timeline section
    const timeline = page.locator('dialog [role="list"]').first();
    const hasTimeline = await timeline.isVisible().catch(() => false);
    results.steps.push({ name: "timeline-visible", passed: hasTimeline });

    // Check memory/event entries rendered
    const memoryText = page.locator('dialog').getByText("trade policy debate");
    const hasMemory = await memoryText.isVisible().catch(() => false);
    results.steps.push({ name: "memory-entry-visible", passed: hasMemory });

    const eventText = page.locator('dialog').getByText("Softened trade stance");
    const hasEvent = await eventText.isVisible().catch(() => false);
    results.steps.push({ name: "growth-event-visible", passed: hasEvent });

    // Close modal
    const closeBtn = page.locator('dialog button[aria-label="Close"], dialog button[aria-label="关闭"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(300);
    }
    await saveScreenshot(page, path.join(stepDir, "03-profile-modal-closed.png"));
  }

  // Check delete button doesn't open modal (stopPropagation fix)
  const deleteBtn = page.locator('button').filter({ hasText: /Delete|删除/ }).first();
  const hasDelete = await deleteBtn.isVisible().catch(() => false);
  results.steps.push({ name: "delete-button-exists", passed: hasDelete });
  if (hasDelete) {
    page.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await deleteBtn.click();
    await page.waitForTimeout(500);
    const openDialogCount = await page.locator("dialog[open]").count();
    results.steps.push({ name: "delete-click-does-not-reopen-profile-modal", passed: openDialogCount === 0 });
  }

  return results;
}

async function testCausalMap(page, baseUrl, outputDir, viewport) {
  const stepDir = path.join(outputDir, "causal-map");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };
  const isCompactViewport = viewport.width <= COMPACT_GRAPH_MAX_WIDTH;

  // Navigate to causal map
  await page.goto(`${baseUrl}/sim/${FIXTURE_SCENARIO_ID}/causal-map`, { waitUntil: "domcontentloaded" });
  await page.getByText(/Causal Graph|因果图谱/i).waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await saveScreenshot(page, path.join(stepDir, "01-causal-map-loaded.png"));

  // Check ReactFlow container rendered
  const reactFlowEl = page.locator('.react-flow').first();
  const hasReactFlow = await reactFlowEl.isVisible().catch(() => false);
  results.steps.push({ name: "reactflow-container-visible", passed: hasReactFlow });
  const ledgerPanel = page.getByTestId("action-ledger-panel");
  const ledgerToggle = ledgerPanel.locator(".action-ledger__toggle");
  if (await ledgerToggle.getAttribute("aria-expanded") !== "true") {
    await ledgerToggle.click();
  }
  const ledgerBody = ledgerPanel.locator(".action-ledger__body").first();
  await ledgerBody.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const hasLedger = await ledgerPanel.isVisible().catch(() => false)
    && await ledgerPanel.getByText("Publish the verified evacuation window.").isVisible().catch(() => false);
  results.steps.push({ name: "action-ledger-visible-with-durable-entry", passed: hasLedger });
  const ledgerTextContrast = await ledgerBody.evaluate((target) => {
    const color = getComputedStyle(target).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    return color.length === 3 && color.reduce((sum, channel) => sum + channel, 0) >= 600;
  }).catch(() => false);
  results.steps.push({ name: "action-ledger-text-readable-on-dark-surface", passed: ledgerTextContrast });

  // Check graph chrome follows the same viewport policy as the product.
  const controls = page.locator('.react-flow__controls').first();
  const controlsCount = await page.locator('.react-flow__controls').count().catch(() => 0);
  const hasControls = controlsCount > 0
    ? await controls.isVisible().catch(() => false)
    : false;
  results.steps.push({
    name: isCompactViewport ? "controls-visible-on-compact-viewport" : "controls-visible-on-desktop",
    passed: hasControls,
  });

  const minimap = page.locator('.react-flow__minimap').first();
  const minimapCount = await page.locator('.react-flow__minimap').count().catch(() => 0);
  const hasMinimap = minimapCount > 0
    ? await minimap.isVisible().catch(() => false)
    : false;
  results.steps.push({
    name: isCompactViewport ? "minimap-hidden-on-compact-viewport" : "minimap-visible-on-desktop",
    passed: isCompactViewport ? minimapCount === 0 || !hasMinimap : hasMinimap,
  });
  if (isCompactViewport) {
    const mobileHint = page.getByText(/Drag to pan\. Pinch or use the graph controls to zoom\.|可拖动画布；双指缩放或使用图谱控件调整视图。/).first();
    const hasMobileHint = await mobileHint.isVisible().catch(() => false);
    results.steps.push({ name: "compact-viewport-hint-visible", passed: hasMobileHint });
  }

  // Check node count label
  const pageText = await page.locator("body").innerText().catch(() => "");
  const hasNodeCount = /3\s*(nodes|节点)/i.test(pageText);
  results.steps.push({ name: "node-count-correct", passed: hasNodeCount });

  // Check edge count label
  const hasEdgeCount = /2\s*(edges|连线)/i.test(pageText);
  results.steps.push({ name: "edge-count-correct", passed: hasEdgeCount });

  const exportPanel = page.getByTestId("export-panel");
  const hasExportPanel = await exportPanel.isVisible().catch(() => false);
  results.steps.push({ name: "export-panel-visible", passed: hasExportPanel });

  const exportSvgButton = page.getByRole("button", { name: /Export SVG|导出 SVG/i }).first();
  const hasExportSvgButton = await exportSvgButton.isVisible().catch(() => false);
  results.steps.push({ name: "export-svg-button-visible", passed: hasExportSvgButton });
  if (hasExportSvgButton) {
    let svgDownloadPassed = false;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 5000 }),
        exportSvgButton.click(),
      ]);
      const filename = download.suggestedFilename();
      let filePath = await download.path().catch(() => null);
      if (!filePath) {
        filePath = path.join(stepDir, filename);
        await download.saveAs(filePath);
      }
      await validateSvgDownloadArtifact({
        filePath,
        filename,
        expectedPrefix: "causal-graph_",
      });
      svgDownloadPassed = true;
      await saveScreenshot(page, path.join(stepDir, "02-causal-map-exported.png"));
    } catch {
      svgDownloadPassed = false;
    }
    results.steps.push({ name: "export-svg-download-succeeds", passed: svgDownloadPassed });
  }

  if (hasReactFlow && hasControls) {
    results.steps.push(
      ...(await runGraphViewportInteractions(page, {
        containerSelector: ".react-flow",
        paneSelector: ".react-flow__pane",
        prefix: "graph",
      })),
    );
    await saveScreenshot(page, path.join(stepDir, "02b-causal-map-interactions.png"));
  }

  const firstNode = page.getByRole("button", { name: "Trade shock announced" }).first();
  const hasFirstNode = await firstNode.isVisible().catch(() => false);
  results.steps.push({ name: "graph-node-visible", passed: hasFirstNode });
  if (hasFirstNode) {
    await firstNode.click();
    const detailSheet = page.getByTestId("node-conversation-sheet");
    const hasDetailSheet = await detailSheet.isVisible({ timeout: 3000 }).catch(() => false);
    results.steps.push({ name: "node-conversation-sheet-opens", passed: hasDetailSheet });

    const hasPayloadDetails = hasDetailSheet
      ? await detailSheet.getByText(/macro-desk|Graph analyst|Trade shock announced/i).first().isVisible().catch(() => false)
      : false;
    results.steps.push({ name: "node-conversation-context-visible", passed: hasPayloadDetails });

    if (hasDetailSheet) {
      await page.keyboard.press("Escape");
      await detailSheet.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
      const sheetClosed = await detailSheet.isHidden().catch(() => false);
      await saveScreenshot(page, path.join(stepDir, "03-causal-map-detail-closed.png"));
      results.steps.push({ name: "node-conversation-sheet-closes", passed: sheetClosed });
    }
  }

  // Check back link
  const backLink = page.getByText(/Back to Result|返回结果/);
  const hasBack = await backLink.isVisible().catch(() => false);
  results.steps.push({ name: "back-link-visible", passed: hasBack });

  // Check a11y screen-reader list
  const srList = page.getByTestId(SR_FALLBACK_LIST_TEST_ID).first();
  const hasSrList = await srList.count().then((count) => count > 0).catch(() => false);
  results.steps.push({ name: "sr-fallback-list-exists", passed: hasSrList });
  if (hasSrList) {
    const srItemCount = await srList.locator('[role="listitem"]').count().catch(() => 0);
    results.steps.push({ name: "sr-fallback-list-has-items", passed: srItemCount > 0 });
  }

  const branchSelect = page.getByLabel(/Select branch|选择分支/i).first();
  const hasBranchSelect = await branchSelect.isVisible().catch(() => false);
  results.steps.push({ name: "branch-selector-visible", passed: hasBranchSelect });
  if (hasBranchSelect) {
    const hasReadableBranchOptions = await branchSelect.evaluate((element) => {
      const options = Array.from((element).querySelectorAll("option"));
      const labels = options.map((option) => option.textContent?.trim() ?? "");
      return labels.includes("Baseline track · 63.0%") && labels.includes("Intervention branch · 37.0%");
    }).catch(() => false);
    results.steps.push({ name: "branch-selector-shows-readable-options", passed: hasReadableBranchOptions });
    const branchResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph?branch_id=branch-child`),
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    await branchSelect.selectOption("branch-child");
    const branchQueryApplied = await page.waitForURL(
      (url) => url.searchParams.get("branch_id") === "branch-child",
      { timeout: 5000 },
    ).then(() => true).catch(() => false);
    results.steps.push({ name: "branch-selector-updates-url", passed: branchQueryApplied });
    const branchResponseSeen = await branchResponsePromise;
    const filteredCountVisible = branchResponseSeen
      ? await page.waitForFunction(
        () => document.querySelectorAll(".react-flow__node").length === 2,
        undefined,
        { timeout: 5000 },
      ).then(() => true).catch(() => false)
      : false;
    results.steps.push({ name: "branch-filtered-count-visible", passed: filteredCountVisible });
    results.steps.push({
      name: "branch-filter-request-sent",
      passed: branchResponseSeen,
    });
  }

  return results;
}

// ── Surface Runner ───────────────────────────────────────

async function runSurface(mode, viewport, args, outputDir) {
  const baseUrl = args.baseUrl;
  ensureDir(outputDir);

  const allResults = { mode, browser: args.browser, viewport, tests: {} };
  const browser = await launchBrowser(args.headless, args.browser);
  try {
    const context = await browser.newContext({ ...buildContextOptions(mode, args.browser), acceptDownloads: true, locale: E2E_LOCALE });
    await context.addInitScript(({ storageKey, language }) => {
      window.localStorage.setItem(storageKey, language);
    }, { storageKey: "swarmoracle:language:v1", language: E2E_APP_LANGUAGE });
    const page = await context.newPage();
    const browserIssues = attachBrowserIssueMonitor(page);
    await installFixtures(page);

    try {
      allResults.tests.agentWorkshop = await runNamedTest(
        "agent-workshop",
        page,
        outputDir,
        () => testAgentWorkshop(page, baseUrl, outputDir),
      );
      allResults.tests.agentLibraryProfile = await runNamedTest(
        "agent-library-profile",
        page,
        outputDir,
        () => testAgentLibraryAndProfile(page, baseUrl, outputDir),
      );
      allResults.tests.causalMap = await runNamedTest(
        "causal-map",
        page,
        outputDir,
        () => testCausalMap(page, baseUrl, outputDir, viewport),
      );
    } catch (err) {
      allResults.error = toErrorMessage(err);
      await saveScreenshot(page, path.join(outputDir, "crash.png"));
    } finally {
      const browserRuntime = buildBrowserRuntimeResult(browserIssues);
      allResults.tests.browserRuntime = {
        steps: browserRuntime.steps,
        passed: browserRuntime.passed,
        error: browserRuntime.error,
      };
      allResults.browserIssues = browserRuntime.issues;
      writeJson(path.join(outputDir, "browser-issues.json"), browserRuntime.issues);
      if (!browserRuntime.passed) {
        await saveScreenshot(page, path.join(outputDir, "browser-runtime-errors.png"));
      }
    }
  } finally {
    await closePlaywrightBrowser(browser, `e2e-phase3-batch-a:${mode}:${args.browser}`);
  }

  allResults.summary = summarizeRun(allResults);

  writeJson(path.join(outputDir, "result.json"), allResults);
  console.log(JSON.stringify(allResults.summary));
  return allResults;
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const {
  defaultBrowserType: _unusedDefaultBrowserType,
  ...MOBILE_CONTEXT_DEFAULTS
} = devices["iPhone 13"];

function buildContextOptions(mode, browserName) {
  if (mode !== "mobile") {
    return { viewport: DESKTOP_VIEWPORT };
  }

  const options = {
    ...MOBILE_CONTEXT_DEFAULTS,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_CONTEXT_DEFAULTS.userAgent,
    deviceScaleFactor: MOBILE_CONTEXT_DEFAULTS.deviceScaleFactor,
    ...(browserName === "firefox" ? { screen: MOBILE_CONTEXT_DEFAULTS.screen } : {}),
  };
  // Playwright's Firefox backend rejects the Chromium/WebKit-only isMobile
  // context flag. Touch, viewport, screen and user agent still provide the
  // bounded mobile surface contract for Firefox.
  if (browserName === "firefox") delete options.isMobile;
  return options;
}

function buildSurfaceRuns(args) {
  const buildRun = (mode, browser) => ({
    mode,
    browser,
    context: buildContextOptions(mode, browser),
  });

  if (args.mode === "desktop") {
    return [buildRun("desktop", args.browser)];
  }
  if (args.mode === "mobile") {
    return [buildRun("mobile", args.browser)];
  }
  if (args.browserExplicitlySet) {
    return [
      buildRun("desktop", args.browser),
      buildRun("mobile", args.browser),
    ];
  }

  return [
    buildRun("desktop", "chromium"),
    buildRun("mobile", "chromium"),
    buildRun("desktop", "firefox"),
    buildRun("desktop", "webkit"),
  ];
}

export const __test__ = {
  buildSurfaceRuns,
  mobileContextDefaults: MOBILE_CONTEXT_DEFAULTS,
  preflightRoutePaths: PREFLIGHT_ROUTE_PATHS,
  parseViewportTransform,
  requiredGraphInteractionSteps: REQUIRED_GRAPH_INTERACTION_STEPS,
  srFallbackListTestId: SR_FALLBACK_LIST_TEST_ID,
  isValidActionFixtureRequest,
  installFixtures,
  runNamedTest,
  summarizeRun,
};

// ── Main ─────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const surfaceResults = [];
  const rootOutputDir = args.outputDir
    ?? path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-phase3a-${args.mode}-${args.browser}`);
  ensureDir(rootOutputDir);

  await assertFrontendRoutesReady({
    baseUrl: args.baseUrl,
    routePaths: PREFLIGHT_ROUTE_PATHS,
    label: "phase3-batch-a preflight",
  });

  const surfaceRuns = buildSurfaceRuns(args);
  for (const surface of surfaceRuns) {
    const surfaceOutputDir = surfaceRuns.length === 1
      ? rootOutputDir
      : path.join(rootOutputDir, `${surface.mode}-${surface.browser}`);
    const r = await runSurface(surface.mode, surface.context.viewport ?? DESKTOP_VIEWPORT, {
      ...args,
      browser: surface.browser,
    }, surfaceOutputDir);
    surfaceResults.push(r);
  }

  const overallSummary = {
    mode: args.mode,
    browser: args.browser,
    surfaces: surfaceResults.map((result) => ({
      mode: result.mode,
      browser: result.browser,
      allPassed: result.summary.allPassed,
      failedTests: result.summary.failedTests,
      runError: result.summary.runError,
    })),
    allPassed: surfaceResults.length > 0 && surfaceResults.every((result) => result.summary.allPassed),
  };
  writeJson(path.join(rootOutputDir, "result.json"), {
    overall: overallSummary,
    surfaces: surfaceResults,
  });
  console.log(JSON.stringify({ overall: overallSummary }));
  if (!overallSummary.allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
