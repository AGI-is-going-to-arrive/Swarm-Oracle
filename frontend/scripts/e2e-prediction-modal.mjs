#!/usr/bin/env node
/**
 * Phase 5 — E2E: PredictionModal (advanced fold + a11y)
 *
 * Validates the PredictionModal contract:
 * - Modal exposes role=dialog + aria-modal=true + labelled-by id.
 * - Advanced prediction options are folded by default (profile_resonance option
 *   not present until the advanced accordion is expanded).
 * - Toggling "show advanced" sets aria-expanded=true and reveals the
 *   profile_resonance option in the bet-kind <select>.
 * - Focus on mount lands inside the modal (textarea on desktop, close button
 *   otherwise — at least one focused element is inside the dialog).
 * - No mixed CJK + Latin words inside the same labelled control region.
 *
 * Defaults to fixture mode (page.route()); set SWARM_E2E_MODE=live to disable.
 *
 * Run:
 *   node scripts/e2e-prediction-modal.mjs [desktop|mobile|full]
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

const FIXTURE_SCENARIO_ID = "sc-e2e-prediction";

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
      "Usage: node scripts/e2e-prediction-modal.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
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

function installPageIssueGuards(page) {
  const issues = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
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
    if (status >= 400) {
      issues.push({ type: "response", url: response.url(), status });
    }
  });
  return issues;
}

async function installFixtures(page) {
  if (LIVE_MODE) return;
  await page.route(/\/api\/capabilities(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(CAPABILITIES_FIXTURE),
    }),
  );
}

async function isVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function openModalViaUrl(page, baseUrl) {
  const url = new URL("/__prediction_modal_preview", baseUrl);
  url.searchParams.set("scenario", FIXTURE_SCENARIO_ID);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page
    .locator(".prediction-modal, [role=\"dialog\"]")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

async function ensureRendered(page, baseUrl) {
  await openModalViaUrl(page, baseUrl);
  const live = await isVisible(page.locator(".prediction-modal").first());
  if (live) return "live";
  return "missing";
}

async function testDialogSemantics(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".prediction-modal").first();
    const role = await modal.getAttribute("role");
    const ariaModal = await modal.getAttribute("aria-modal");
    const labelledBy = await modal.getAttribute("aria-labelledby");
    pushStep(result, "role-dialog", role === "dialog", { role });
    pushStep(result, "aria-modal-true", ariaModal === "true", { ariaModal });
    pushStep(result, "aria-labelledby-present", Boolean(labelledBy), { labelledBy });
    if (labelledBy) {
      const labelTargetCount = await page
        .locator(`#${labelledBy.split(/\s+/)[0]}`)
        .count();
      pushStep(
        result,
        "aria-labelledby-resolves",
        labelTargetCount > 0,
        { labelledBy, labelTargetCount },
      );
    } else {
      pushStep(result, "aria-labelledby-resolves", false);
    }
  } catch (err) {
    pushStep(result, "dialog-semantics", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testAdvancedFoldedByDefault(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".prediction-modal").first();
    const toggle = modal.locator(".pred-advanced__toggle").first();
    pushStep(result, "advanced-toggle-visible", await isVisible(toggle));
    const expandedInitial = await toggle.getAttribute("aria-expanded");
    pushStep(
      result,
      "advanced-folded-by-default",
      expandedInitial === "false" || expandedInitial === null,
      { expandedInitial },
    );
    const betKindSelect = modal.locator("#pred-kind, select[name='bet_kind']").first();
    const initialProfileOption = await betKindSelect
      .locator("option[value='profile_resonance']")
      .count();
    pushStep(
      result,
      "profile-resonance-hidden-when-folded",
      initialProfileOption === 0,
      { initialProfileOption },
    );

    await toggle.click().catch(() => {});
    const expandedAfter = await toggle.getAttribute("aria-expanded");
    pushStep(result, "advanced-toggle-expanded-after-click", expandedAfter === "true", {
      expandedAfter,
    });
    const afterProfileOption = await betKindSelect
      .locator("option[value='profile_resonance']")
      .count();
    pushStep(
      result,
      "profile-resonance-revealed-after-expand",
      afterProfileOption > 0,
      { afterProfileOption },
    );
  } catch (err) {
    pushStep(result, "advanced-folded-default", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testInitialFocusInsideDialog(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".prediction-modal").first();
    const focusInside = await modal.evaluate((node) => {
      const active = node.ownerDocument?.activeElement;
      return Boolean(active) && (node === active || node.contains(active));
    });
    const activeElement = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active) return null;
      return {
        tagName: active.tagName,
        id: active.id,
        className: typeof active.className === "string" ? active.className : "",
      };
    });
    pushStep(result, "initial-focus-inside-dialog", focusInside, {
      focusInside,
      activeElement,
    });
  } catch (err) {
    pushStep(result, "initial-focus", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testLocaleSplit(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".prediction-modal").first();
    const proximityViolation = await modal.evaluate((root) => {
      const blocks = root.querySelectorAll("label, .pred-label, .pred-advanced__toggle, button");
      for (const el of blocks) {
        const txt = (el.textContent || "").trim();
        if (/[一-鿿]/.test(txt) && /\b[A-Za-z]{3,}\b/.test(txt)) {
          return true;
        }
      }
      return false;
    });
    pushStep(result, "no-mixed-locale-in-same-control-region", !proximityViolation, {
      proximityViolation,
    });
  } catch (err) {
    pushStep(result, "locale-split", false, {
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
        `prediction-modal-${timestampLabel()}-${mode}-${args.browser}`,
      );
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless, args.browser);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem("swarmoracle:language:v1", "en");
  });
  const pageIssues = installPageIssueGuards(page);
  await installFixtures(page);

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
    allResults.modalRenderMode = rendered;
    if (rendered === "missing") {
      allResults.tests.dialogSemantics = finalize(
        Object.assign(createTestResult(), {
          steps: [{ name: "modal-not-rendered", passed: false }],
        }),
      );
    } else {
      allResults.tests.dialogSemantics = await testDialogSemantics(page);
      allResults.tests.advancedFoldedDefault = await testAdvancedFoldedByDefault(page);
      allResults.tests.initialFocus = await testInitialFocusInsideDialog(page);
      allResults.tests.localeSplit = await testLocaleSplit(page);
    }
    allResults.tests.pageGuards = finalize(
      Object.assign(createTestResult(), {
        steps: [{
          name: "no-console-pageerror-requestfailure-or-http-error",
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
  console.log(JSON.stringify({ script: "e2e-prediction-modal", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
