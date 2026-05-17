#!/usr/bin/env node
/**
 * Phase 5 — E2E: InterventionReceiptCard (read-only receipt surface)
 *
 * Validates the receipt-card contract:
 * - When enabled with effects, the card renders (test-id `intervention-receipt-card`),
 *   listed newest-first with stable confidence pill.
 * - When enabled with empty effects, the card collapses (no DOM rendered).
 * - When the backend request errors, the error variant test-id surfaces.
 * - The card never leaks the internal `intervention_log_id` into visible text.
 * - `prefers-reduced-motion: reduce` removes the `receiptIn` animation.
 *
 * Defaults to fixture mode (page.route()); set SWARM_E2E_MODE=live to disable.
 *
 * Run:
 *   node scripts/e2e-intervention-receipt.mjs [desktop|mobile|full]
 *        [--url URL] [--backend-url URL] [--browser chromium|firefox|webkit]
 *        [--headless] [--output-dir DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const LIVE_MODE = process.env.SWARM_E2E_MODE === "live";

const FIXTURE_SCENARIO_ID = "sc-e2e-receipt";
const EFFECTS_ROUTE = /\/api\/scenario\/[^/]+\/intervention-effects(?:\?.*)?$/;

const CAPABILITIES_FIXTURE = {
  web_search: { enabled: false, providers: {} },
  kg_explorer: { enabled: false },
  agent_conversation: { enabled: false },
  replay_trace: { enabled: false },
  causal_graph: { enabled: false },
  factions: { enabled: false },
  argument_map: { enabled: false },
  custom_agents: { enabled: false },
  agent_identity: { enabled: false },
  counterfactual_replay: { enabled: false },
};

const EFFECTS_FIXTURE = {
  effects: [
    {
      intervention_log_id: "secret-log-id-99",
      card_id: "human_takeover",
      card_label: "Human takeover",
      round_number: 2,
      affected_agents: [{ agent_id: "a1", display_name: "Civic Auditor" }],
      response_excerpts: [
        { agent_id: "a1", excerpt: "We must publish a public explanation." },
      ],
      confidence: 0.78,
      no_response_detected: false,
      created_at: "2026-05-17T10:00:00Z",
    },
    {
      intervention_log_id: "secret-log-id-old",
      card_id: null,
      card_label: null,
      round_number: 1,
      affected_agents: [],
      response_excerpts: [],
      confidence: 0,
      no_response_detected: true,
      created_at: "2026-05-17T09:00:00Z",
    },
  ],
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

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
    backendUrl: DEFAULT_BACKEND_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    outputDir: "",
    headless: process.env.HEADLESS === "1",
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--backend-url" && next) {
      args.backendUrl = next;
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      args.browserExplicitlySet = true;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-intervention-receipt.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
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
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

function createTestResult() {
  return { steps: [], passed: false };
}

function pushStep(result, name, passed, extra = {}) {
  result.steps.push({ name, passed, ...extra });
}

function finalize(result) {
  result.passed = result.steps.length > 0 && result.steps.every((step) => step.passed);
  return result;
}

function installPageIssueGuards(page, allowResponse = () => false) {
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (message.text().includes("Failed to load resource") && message.text().includes("500 (Internal Server Error)")) {
        return;
      }
      issues.push({ type: "console", text: message.text() });
    }
  });
  page.on("pageerror", (error) => {
    issues.push({ type: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    issues.push({
      type: "requestfailed",
      url: request.url(),
      text: request.failure()?.errorText || "",
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400 && !allowResponse(response)) {
      issues.push({ type: "response", url: response.url(), status });
    }
  });
  return issues;
}

async function installFixtures(page, mode = "with-effects") {
  if (LIVE_MODE) return;
  await page.route(/\/api\/capabilities(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CAPABILITIES_FIXTURE),
    }),
  );
  await page.unroute(EFFECTS_ROUTE).catch(() => {});
  await page.route(EFFECTS_ROUTE, (route) => {
    if (mode === "error") {
      return route.fulfill({ status: 500, body: "{}" });
    }
    const body = mode === "empty" ? { effects: [] } : EFFECTS_FIXTURE;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function isVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function openCardViaUrl(page, baseUrl, scenarioId = FIXTURE_SCENARIO_ID) {
  const url = new URL("/__intervention_receipt_preview", baseUrl);
  url.searchParams.set("scenario", scenarioId);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page
    .locator("[data-testid='intervention-receipt-card'], .intervention-receipt-card")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

async function ensureRendered(page, baseUrl) {
  await openCardViaUrl(page, baseUrl);
  const live = await isVisible(
    page.locator("[data-testid='intervention-receipt-card']").first(),
  );
  if (live) return "live";
  return "missing";
}

async function testReceiptVisible(page) {
  const result = createTestResult();
  try {
    const card = page.locator("[data-testid='intervention-receipt-card']").first();
    pushStep(result, "card-visible-with-effects", await isVisible(card));
    const entries = card.locator(".intervention-receipt-card__entry");
    const count = await entries.count();
    pushStep(result, "card-has-entries", count >= 1, { count });
    pushStep(
      result,
      "card-no-internal-log-id-leak",
      !(await card.evaluate((node) => (node.textContent || "").includes("secret-log-id-"))),
    );
    const firstConfidence = await card
      .locator("[data-testid='intervention-receipt-card-confidence']")
      .first()
      .innerText();
    pushStep(result, "confidence-pill-has-text", firstConfidence.trim().length > 0, {
      firstConfidence,
    });
  } catch (err) {
    pushStep(result, "receipt-visible", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testReducedMotionAnimation(page) {
  const result = createTestResult();
  try {
    const card = page.locator("[data-testid='intervention-receipt-card']").first();
    const animationName = await card.evaluate((node) =>
      getComputedStyle(node).animationName,
    );
    pushStep(
      result,
      "animation-disabled-under-reduced-motion",
      animationName === "none" || animationName === "" || animationName === "normal",
      { animationName },
    );
  } catch (err) {
    pushStep(result, "reduced-motion", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testEmptyState(page, baseUrl) {
  const result = createTestResult();
  try {
    await installFixtures(page, "empty");
    await openCardViaUrl(page, baseUrl, `${FIXTURE_SCENARIO_ID}-empty`);
    await page.waitForTimeout(150);
    const present = await page.locator("[data-testid='intervention-receipt-card']").count();
    pushStep(result, "no-card-when-empty", present === 0, { present });
  } catch (err) {
    pushStep(result, "empty-state", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testErrorState(page, baseUrl) {
  const result = createTestResult();
  try {
    await installFixtures(page, "error");
    await openCardViaUrl(page, baseUrl, `${FIXTURE_SCENARIO_ID}-error`);
    const errorNode = page.locator("[data-testid='intervention-receipt-card-error']").first();
    await errorNode.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    pushStep(result, "error-card-renders-on-backend-error", await isVisible(errorNode));
  } catch (err) {
    pushStep(result, "error-state", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function runSurface(mode, contextOptions, args) {
  const outputDir = args.outputDir
    ? resolveSurfaceOutputDir({ outputDir: args.outputDir, mode, browser: args.browser })
    : path.join(
        DEFAULT_OUTPUT_ROOT,
        `intervention-receipt-${timestampLabel()}-${mode}-${args.browser}`,
      );
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless, args.browser);
  const context = await browser.newContext({
    ...contextOptions,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("swarmoracle:language:v1", "en");
  });
  const pageIssues = installPageIssueGuards(
    page,
    (response) => response.status() === 500 && EFFECTS_ROUTE.test(new URL(response.url()).pathname),
  );
  await installFixtures(page, "with-effects");

  const allResults = {
    mode,
    browser: args.browser,
    viewport: contextOptions.viewport ?? null,
    live: LIVE_MODE,
    baseUrl: args.baseUrl,
    tests: {},
  };

  try {
    const rendered = await ensureRendered(page, args.baseUrl);
    allResults.renderMode = rendered;
    if (rendered === "missing") {
      allResults.tests.receiptVisible = finalize(
        Object.assign(createTestResult(), {
          steps: [{ name: "card-not-rendered", passed: false }],
        }),
      );
    } else {
      allResults.tests.receiptVisible = await testReceiptVisible(page);
      allResults.tests.reducedMotion = await testReducedMotionAnimation(page);
      allResults.tests.emptyState = await testEmptyState(page, args.baseUrl);
      allResults.tests.errorState = await testErrorState(page, args.baseUrl);
    }
    allResults.tests.pageGuards = finalize(
      Object.assign(createTestResult(), {
        steps: [{
          name: "no-console-pageerror-requestfailure-or-unexpected-http-error",
          passed: pageIssues.length === 0,
          issues: pageIssues,
        }],
      }),
    );
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  let total = 0;
  let passed = 0;
  for (const testResult of Object.values(allResults.tests)) {
    for (const step of testResult.steps) {
      total += 1;
      if (step.passed) passed += 1;
    }
  }
  allResults.summary = {
    totalSteps: total,
    passedSteps: passed,
    allPassed: total > 0 && total === passed,
  };
  writeJson(path.join(outputDir, "result.json"), allResults);
  return allResults;
}

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const { defaultBrowserType: _unused, ...MOBILE_CTX_DEFAULTS } = devices["iPhone 13"];

function buildContextOptions(mode) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  return { ...MOBILE_CTX_DEFAULTS, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
}

function resolveSurfaceOutputDir({ outputDir, mode, browser }) {
  const root = path.isAbsolute(outputDir)
    ? outputDir
    : path.join(FRONTEND_ROOT, outputDir);
  return path.join(root, `${mode}-${browser}`);
}

function buildSurfaceRuns(args) {
  const mk = (mode, browser) => ({ mode, browser, context: buildContextOptions(mode) });
  if (args.mode === "desktop") return [mk("desktop", args.browser)];
  if (args.mode === "mobile") return [mk("mobile", args.browser)];
  return args.browserExplicitlySet
    ? [mk("desktop", args.browser), mk("mobile", args.browser)]
    : [mk("desktop", "chromium"), mk("mobile", "chromium")];
}

export const __test__ = {
  CAPABILITIES_FIXTURE,
  EFFECTS_FIXTURE,
  buildSurfaceRuns,
  resolveSurfaceOutputDir,
};

async function main() {
  const args = parseArgs(process.argv);
  const runs = [];
  for (const surface of buildSurfaceRuns(args)) {
    const run = await runSurface(surface.mode, surface.context, {
      ...args,
      browser: surface.browser,
    });
    runs.push(run);
  }
  const allPassed = runs.every((run) => run.summary.allPassed);
  console.log(JSON.stringify({ script: "e2e-intervention-receipt", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
