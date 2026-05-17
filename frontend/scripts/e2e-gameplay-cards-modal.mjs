#!/usr/bin/env node
/**
 * Phase 5 — E2E: GameplayCardsModal (a11y + structure contract)
 *
 * Validates the v2 GameplayCardsModal contract:
 * - Recommended section is the first visible card group (no group toggle above it).
 * - At least one recommended card is visible without expanding any group.
 * - Group toggles render with stable aria-expanded state and are collapsed by default.
 * - Modal exposes dialog semantics (role=dialog, aria-modal=true, labelled-by id).
 * - Focus on mount lands inside the modal (textarea on desktop, close button otherwise).
 * - Submitting the apply card stamps a next-round marker via the active-marker chip.
 * - Language switch keeps a single locale per visible control region.
 *
 * Defaults to fixture mode (page.route()); set SWARM_E2E_MODE=live to disable fixtures.
 *
 * Run:
 *   node scripts/e2e-gameplay-cards-modal.mjs [desktop|mobile|full]
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

const FIXTURE_SCENARIO_ID = "sc-e2e-gameplay";
const FIXTURE_QUESTION = "What if a council of agents must vote on a long-tail risk?";

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
  gameplay_cards: { enabled: true },
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: FIXTURE_QUESTION,
  status: "done",
  created_at: "2026-05-17T00:00:00Z",
  scene_theme: "civic_council",
  agents: [
    { id: "a1", name: "Quorum Speaker", role: "facilitator", tier: "CORE", emotion: "calm" },
    { id: "a2", name: "Civic Auditor", role: "scrutiny", tier: "CORE", emotion: "neutral" },
  ],
  branches: [
    {
      id: "branch-1",
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: "",
      title: "Mainline worldline",
      summary: "",
      story: "",
      insight: "",
      key_moments: [],
      probability: 1,
      status: "ACTIVE",
    },
  ],
  messages: [],
  groups: [],
  hierarchical: false,
  director_state: null,
  gameplay_state: null,
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
      "Usage: node scripts/e2e-gameplay-cards-modal.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
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
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}(?:\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SCENARIO_FIXTURE),
    }),
  );
  await page.route(/\/api\/scenario\/[^/]+\/agents$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SCENARIO_FIXTURE.agents),
    }),
  );
  await page.route(/\/api\/scenario\/[^/]+\/intervene$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "applied",
        intervention_id: "e2e-intervention",
        branch_id: "branch-1",
        round: 2,
        pending_count: 1,
        queued_ahead: 0,
        gameplay_state: null,
      }),
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
  const url = new URL("/__gameplay_cards_modal_preview", baseUrl);
  url.searchParams.set("scenario", FIXTURE_SCENARIO_ID);
  await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page
    .locator(".gameplay-modal-v2, [role=\"dialog\"]")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
}

async function ensureGameplayModalRendered(page, baseUrl) {
  await openModalViaUrl(page, baseUrl);
  const visible = await isVisible(page.locator(".gameplay-modal-v2").first());
  if (visible) return "live";
  return "missing";
}

async function testRecommendedRowFirst(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".gameplay-modal-v2").first();
    const recommendedHeading = modal.locator("section :is(h2,h3)").filter({ hasText: /Recommended|推荐/i });
    pushStep(result, "recommended-heading-visible", await isVisible(recommendedHeading.first()));

    const recommendedCardCount = await modal
      .locator(".gameplay-card-v2--recommended, .gameplay-modal-v2__recommended-grid .gameplay-card-v2")
      .count();
    pushStep(result, "recommended-row-not-empty", recommendedCardCount > 0, { count: recommendedCardCount });

    const domOrder = await modal.evaluate((node) => {
      const recommendedSection = node.querySelector(".gameplay-modal-v2__section--primary");
      const firstRecommendedCard = node.querySelector(
        ".gameplay-modal-v2__recommended-grid .gameplay-card-v2, .gameplay-card-v2--recommended",
      );
      const firstToggle = node.querySelector(".gameplay-modal-v2__group-toggle");
      return {
        hasRecommendedSection: Boolean(recommendedSection),
        hasRecommendedCard: Boolean(firstRecommendedCard),
        hasFirstToggle: Boolean(firstToggle),
        cardInsideRecommended: Boolean(
          recommendedSection && firstRecommendedCard && recommendedSection.contains(firstRecommendedCard),
        ),
        recommendedBeforeFirstToggle: Boolean(
          recommendedSection &&
            firstToggle &&
            (recommendedSection.compareDocumentPosition(firstToggle) & Node.DOCUMENT_POSITION_FOLLOWING),
        ),
      };
    });
    pushStep(
      result,
      "recommended-section-before-collapsible-groups",
      domOrder.recommendedBeforeFirstToggle,
      domOrder,
    );
    pushStep(
      result,
      "recommended-card-contained-in-recommended-section",
      domOrder.cardInsideRecommended,
      domOrder,
    );

    const groupToggleCount = await modal.locator(".gameplay-modal-v2__group-toggle").count();
    pushStep(result, "more-section-collapsible-groups-present", groupToggleCount > 0, { count: groupToggleCount });

    const firstToggle = modal.locator(".gameplay-modal-v2__group-toggle").first();
    const firstExpanded = await firstToggle.getAttribute("aria-expanded");
    pushStep(
      result,
      "groups-collapsed-by-default",
      firstExpanded === "false" || firstExpanded === null,
      { firstExpanded },
    );
  } catch (err) {
    pushStep(result, "recommended-row-first", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testInitialFocusInsideDialog(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".gameplay-modal-v2").first();
    const focusState = await modal.evaluate((node) => {
      const active = node.ownerDocument?.activeElement;
      const win = node.ownerDocument?.defaultView;
      const expectedDirectiveFocus = Boolean(
        win &&
          win.innerWidth > 720 &&
          (typeof win.matchMedia !== "function" || win.matchMedia("(pointer: fine)").matches),
      );
      return {
        focusInside: Boolean(active) && (node === active || node.contains(active)),
        expectedDirectiveFocus,
        directiveFocused: Boolean(active?.matches?.(".gameplay-modal__textarea")),
        closeFocused: Boolean(active?.matches?.(".gameplay-modal-v2__footer .btn-ghost")),
        activeElement: active
          ? {
              tagName: active.tagName,
              id: active.id,
              className: typeof active.className === "string" ? active.className : "",
            }
          : null,
      };
    });
    pushStep(result, "initial-focus-inside-dialog", focusState.focusInside, focusState);
    pushStep(
      result,
      "initial-focus-target-matches-layout",
      focusState.expectedDirectiveFocus ? focusState.directiveFocused : focusState.closeFocused,
      focusState,
    );
  } catch (err) {
    pushStep(result, "initial-focus", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testDialogSemantics(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".gameplay-modal-v2").first();
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

async function testCardApplyMarker(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".gameplay-modal-v2").first();
    const applyButton = modal.locator(".gameplay-modal-v2__submit").first();
    pushStep(result, "apply-button-visible", await isVisible(applyButton));
    await applyButton.click({ trial: false }).catch(() => {});
    const marker = modal.locator(".gameplay-modal-v2__active-marker");
    const markerVisible = await marker.first().isVisible().catch(() => false);
    pushStep(result, "active-marker-rendered-after-apply", markerVisible, {
      markerCount: await marker.count(),
    });
  } catch (err) {
    pushStep(result, "card-apply-marker", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testLocaleSplit(page) {
  const result = createTestResult();
  try {
    const modal = page.locator(".gameplay-modal-v2").first();
    const visibleText = await modal.evaluate((node) => node.textContent || "");
    const hasCjk = /[一-鿿]/.test(visibleText);
    const hasLatin = /[A-Za-z]{2,}/.test(visibleText);
    const mixedSuspect = hasCjk && hasLatin;
    let proximityViolation = false;
    if (mixedSuspect) {
      proximityViolation = await modal.evaluate((root) => {
        const elements = root.querySelectorAll(
          ".gameplay-modal-v2__recommended-grid button, .gameplay-modal-v2__group-toggle",
        );
        for (const el of elements) {
          const txt = (el.textContent || "").trim();
          if (/[一-鿿]/.test(txt) && /\b[A-Za-z]{3,}\b/.test(txt)) {
            return true;
          }
        }
        return false;
      });
    }
    pushStep(result, "no-mixed-locale-in-same-control-region", !proximityViolation, {
      mixedSuspect,
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
        `gameplay-cards-modal-${timestampLabel()}-${mode}-${args.browser}`,
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
    const rendered = await ensureGameplayModalRendered(page, args.baseUrl);
    allResults.modalRenderMode = rendered;
    if (rendered === "missing") {
      allResults.tests.dialogSemantics = finalize(
        Object.assign(createTestResult(), {
          steps: [{ name: "modal-not-rendered", passed: false }],
        }),
      );
    } else {
      allResults.tests.recommendedRowFirst = await testRecommendedRowFirst(page);
      allResults.tests.dialogSemantics = await testDialogSemantics(page);
      allResults.tests.initialFocus = await testInitialFocusInsideDialog(page);
      allResults.tests.cardApplyMarker = await testCardApplyMarker(page);
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
  SCENARIO_FIXTURE,
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
  console.log(JSON.stringify({ script: "e2e-gameplay-cards-modal", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
