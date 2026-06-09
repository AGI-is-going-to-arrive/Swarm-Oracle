/**
 * Fixture-backed Result Report (full_report deep-read) browser regression.
 *
 * Verifies the S5 Result Report surface on the standalone `/result/:id/report`
 * route (ResultReportView → ResultReportPanel, variant="standalone"), which only
 * needs `/api/capabilities`, `/api/scenario/:id` and `/api/scenario/:id/story`.
 *
 * Coverage (per surface = mode × browser):
 *   - report renders: localized title + sections + confidence badge (localized level, no raw enum)
 *   - partial report: renders sections + a non-blocking retry banner on top
 *   - failed report: shows the retry/failure card (no sections)
 *   - indicators-to-watch render
 *   - evidence drawer opens and the deep-link navigates to /replay/...
 *   - zh + en localization (badge label/level, banner copy)
 *   - forced-colors + reduced-motion smoke (no crash, panel still visible)
 *
 * FIXTURE mode is the default (page.route() stubs). LIVE mode is opt-in via
 * SWARM_E2E_MODE=live (skips fixtures and hits the running backend).
 *
 * Run:
 *   node scripts/e2e-result-report-suite.mjs [desktop|mobile|full] [--url URL] [--browser chromium|firefox|webkit] [--output-dir DIR] [--mobile-width WIDTH] [--mobile-height HEIGHT] [--headless]
 *   SWARM_E2E_MODE=live node scripts/e2e-result-report-suite.mjs full --url http://127.0.0.1:18928
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, devices, firefox, webkit } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const LIVE_MODE = process.env.SWARM_E2E_MODE === "live";

const FIXTURE_SCENARIO_ID = process.env.SWARM_E2E_SCENARIO_ID || "sc-e2e-result-report";

const {
  defaultBrowserType: _unusedDefaultBrowserType,
  isMobile: _unusedIsMobile,
  ...MOBILE_CONTEXT_DEFAULTS
} = devices["iPhone 13"];
const VALID_BROWSERS = new Set(["chromium", "firefox", "webkit"]);

// ── Generic helpers (mirror sibling fixture suites) ───────────

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function saveScreenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
}

function createStep(name, passed, details = null) {
  return { name, passed: Boolean(passed), details };
}

function summarize(steps, fatalError = null) {
  const passedSteps = steps.filter((step) => step.passed).length;
  return {
    totalSteps: steps.length,
    passedSteps,
    allPassed: !fatalError && steps.length > 0 && passedSteps === steps.length,
  };
}

function parseViewportDimension(rawValue, flagName, { min, max }) {
  const raw = String(rawValue ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flagName} must be an integer between ${min} and ${max}; got ${rawValue ?? "empty"}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flagName} must be an integer between ${min} and ${max}; got ${raw}`);
  }
  return value;
}

function requireOptionValue(argv, index, flagName) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flagName} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "desktop",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    headless: process.env.HEADLESS === "1",
    outputDir: "",
    mobileWidth: MOBILE_CONTEXT_DEFAULTS.viewport.width,
    mobileHeight: MOBILE_CONTEXT_DEFAULTS.viewport.height,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--url") {
      const next = requireOptionValue(argv, i, arg);
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--browser") {
      const next = requireOptionValue(argv, i, arg);
      args.browser = next;
      args.browserExplicitlySet = true;
      i += 1;
    } else if (arg === "--output-dir") {
      const next = requireOptionValue(argv, i, arg);
      args.outputDir = path.isAbsolute(next) ? next : path.join(FRONTEND_ROOT, next);
      i += 1;
    } else if (arg === "--mobile-width") {
      const next = requireOptionValue(argv, i, arg);
      args.mobileWidth = parseViewportDimension(next, "--mobile-width", { min: 240, max: 2560 });
      i += 1;
    } else if (arg === "--mobile-height") {
      const next = requireOptionValue(argv, i, arg);
      args.mobileHeight = parseViewportDimension(next, "--mobile-height", { min: 320, max: 4096 });
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-result-report-suite.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--output-dir DIR] [--mobile-width WIDTH] [--mobile-height HEIGHT] [--headless]");
  }
  if (!VALID_BROWSERS.has(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }

  return args;
}

async function launchBrowser(browserName, headless) {
  if (browserName === "firefox") return firefox.launch({ headless });
  if (browserName === "webkit") return webkit.launch({ headless });
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

function buildContextOptions(mode, browserName, args) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  const viewport = { width: args.mobileWidth, height: args.mobileHeight };

  return {
    ...MOBILE_CONTEXT_DEFAULTS,
    viewport,
    screen: viewport,
    ...(browserName === "firefox" ? {} : { isMobile: true }),
    hasTouch: true,
    userAgent: MOBILE_CONTEXT_DEFAULTS.userAgent,
    deviceScaleFactor: MOBILE_CONTEXT_DEFAULTS.deviceScaleFactor,
    ...(browserName === "firefox" ? { screen: viewport } : {}),
  };
}

function buildSurfaceRuns(args) {
  const run = (mode, browser) => ({
    mode,
    browser,
    context: buildContextOptions(mode, browser, args),
  });

  if (args.mode === "desktop") return [run("desktop", args.browser)];
  if (args.mode === "mobile") return [run("mobile", args.browser)];
  if (args.browserExplicitlySet) return [run("desktop", args.browser), run("mobile", args.browser)];
  return Array.from(VALID_BROWSERS).flatMap((browser) => [run("desktop", browser), run("mobile", browser)]);
}

// ── Fixtures ──────────────────────────────────────────────────

function capabilitiesFixture() {
  const off = { enabled: false, version: "1.0.0", server_only: false, degraded_mode: null };
  return {
    web_search: {
      enabled: false,
      version: "1.0.0",
      server_only: true,
      degraded_mode: null,
      scope: "server",
      server_enabled: false,
      method: "none",
      provider: null,
    },
    custom_agents: off,
    agent_identity: off,
    causal_graph: off,
    counterfactual_replay: off,
    factions: off,
    argument_map: off,
    agent_conversation: off,
    kg_explorer: off,
    replay_trace: { ...off, enabled: true },
    graph_analysis: off,
    roundtable_survey: off,
    roundtable_analyst: off,
    result_verdict: { ...off, enabled: true },
    // The Result Report feature under test.
    result_report: { ...off, enabled: true },
    snapshot_export: { ...off, enabled: true },
  };
}

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: "What if renewable energy was adopted 50 years earlier?",
  status: "done",
  created_at: "2026-06-08T00:00:00Z",
  scene_theme: "civic_chamber",
  total_rounds: 5,
  mode: "blackboard",
  visualization_enabled: false,
  agents: [],
  branches: [],
  messages: [],
  groups: [],
  hierarchical: false,
  director_state: {
    objectives: { generated_for_question: null, generated_for_profile: null, goals: [], last_updated_at: null },
    commitment: { active: false, branch_id: null, branch_title: null, committed_at_round: null, committed_at: null, outcome: null },
  },
  gameplay_state: null,
};

const STORY_BRANCHES = [
  {
    id: "branch-green-transition",
    title: "Green Transition",
    probability: 0.65,
    status: "COMPLETED",
    story: "Early adoption accelerates storage and grid standards.",
    insight: "Timing of adoption is the primary driver.",
    key_moments: ["Solar breakthrough"],
    parent_branch_id: null,
    fork_reason: "",
  },
];

const REPLAY_TRACE_FIXTURE = {
  nodes: [
    {
      branch_id: "branch-green-transition",
      parent_branch_id: null,
      replay_source_branch_id: null,
      origin_round: 3,
      replay_kind: "result-report-evidence",
      status: "active",
      created_at: "2026-06-08T00:00:00Z",
    },
  ],
  next_cursor: null,
};

const CAUSAL_GRAPH_FIXTURE = {
  id: "graph-e2e-result-report",
  nodes: [
    {
      id: "graph-msg-42",
      key: "graph-msg-42",
      type: "utterance",
      label: "Storage costs collapse once the standard is set.",
      round: 3,
      payload: {
        agent_id: "agent-1",
        agent_name: "Climate Scientist",
        branch_id: "branch-green-transition",
        message_id: "msg-42",
        content: "Storage costs collapse once the standard is set.",
      },
    },
  ],
  edges: [],
};

function reportFixture(status = "complete") {
  return {
    version: "1.0",
    generated_at: "2026-06-08T00:00:00Z",
    generation_mode: "generation",
    target_branch_id: "branch-green-transition",
    target_branch_sort: ["probability_desc", "fork_round_asc", "id_asc"],
    language: "en",
    available_languages: ["zh", "en"],
    title: "Deep-Read Report",
    title_i18n: { zh: "深读报告：可再生能源", en: "Deep-Read Report: Renewable Energy" },
    summary: "Renewable energy adoption 50 years earlier reshapes the grid.",
    summary_i18n: { zh: "提前推广深刻改变电网。", en: "Earlier adoption reshapes the grid." },
    status,
    tier: "generation",
    verdict: {
      headline_answer: "Yes — earlier adoption shifts the dominant worldline.",
      // Backend emits the snake_case word-estimate enum; the badge localizes it via result.report.wep.*.
      likelihood: { probability: 0.64, interval: [0.5, 0.78], wep: "likely" },
      analytic_confidence: { level: "medium", basis: "Based on 12 evidence items and multi-branch convergence." },
      disclaimer: "This is a narrative simulation probability, not a real-world forecast.",
    },
    sections: [
      {
        id: "drivers",
        title: "Key Drivers",
        title_i18n: { zh: "关键驱动力", en: "Key Drivers" },
        intent: "Explain the primary causal drivers.",
        body_md_i18n: {
          zh: "储能与电网标准是主要驱动力。",
          en: "Storage economics and grid standards are the primary drivers.",
        },
        evidence_refs: ["ev-1"],
        charts: [],
      },
      {
        id: "risks",
        title: "Risks",
        title_i18n: { zh: "风险", en: "Risks" },
        intent: "Surface the downside risks.",
        body_md_i18n: {
          zh: "既得利益者的游说会拖慢进程。",
          en: "Incumbent lobbying slows the transition.",
        },
        evidence_refs: [],
        charts: [],
      },
    ],
    evidence: [
      {
        id: "ev-1",
        agent_id: "agent-1",
        agent_name: "Climate Scientist",
        message_id: "msg-42",
        round_id: "round-3",
        round_number: 3,
        quote: "Storage costs collapse once the standard is set.",
        kind: "utterance",
        branch_id: "branch-green-transition",
      },
    ],
    indicators_to_watch: [
      {
        signal: "Battery cost per kWh",
        direction: "down",
        note: "Watch for sub-$50/kWh cells.",
        threshold: "$50/kWh",
        observation: "Cells trending cheaper each quarter.",
        time_horizon: "12 months",
        rationale: "Cost is the dominant adoption lever.",
        evidence_refs: ["ev-1"],
      },
    ],
    dissenting: null,
    key_participants: [{ agent_name: "Climate Scientist", impact_score: 0.8, key_moment_hits: 3 }],
    follow_ups: ["What if storage lagged?"],
    limitations: "Single dominant branch.",
    interview_evidence: [],
    premortem: [],
    language_status: { zh: "available", en: "available" },
  };
}

function partialReportFixture() {
  // Partial but renderable: status=partial, still has sections + verdict.
  const report = reportFixture("partial");
  return report;
}

function failedReportFixture() {
  // Failed: no sections to show → failure/retry card.
  const report = reportFixture("failed");
  report.sections = [];
  report.evidence = [];
  report.indicators_to_watch = [];
  return report;
}

function storyWithReport(report) {
  return {
    scenario_id: FIXTURE_SCENARIO_ID,
    question: SCENARIO_FIXTURE.question,
    status: "done",
    branches: STORY_BRANCHES,
    verdict: "Earlier adoption shifts the dominant worldline.",
    verdict_confidence: "medium",
    full_report: report,
  };
}

async function installFixtures(page, state, report, options = {}) {
  const json = (body, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  const recordDisabledScenarioRequest = (route) => {
    const requestUrl = new URL(route.request().url());
    state.disabledScenarioApiRequests.push({
      method: route.request().method(),
      path: requestUrl.pathname,
    });
    return route.fulfill(json({ detail: "Scenario API disabled by fixture" }, 500));
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    state.unhandledApiRequests.push({
      method: route.request().method(),
      url: route.request().url(),
    });
    return route.fulfill(json({ detail: "Unhandled fixture API request" }, 404));
  });
  const capabilityBody = options.capabilities ?? capabilitiesFixture();
  const capabilityStatus = options.capabilitiesStatus ?? 200;
  await page.route("**/api/capabilities", (route) => (
    route.fulfill(json(capabilityBody, capabilityStatus))
  ));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/story`, (route) => {
    if (options.forbidScenarioDataFetch) {
      return recordDisabledScenarioRequest(route);
    }
    return route.fulfill(json(storyWithReport(report)));
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/replay-trace**`, (route) => (
    route.fulfill(json(REPLAY_TRACE_FIXTURE))
  ));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph**`, (route) => (
    route.fulfill(json(CAUSAL_GRAPH_FIXTURE))
  ));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) => {
    const url = route.request().url();
    if (/\/(story|agents|predictions|checkpoints|faction-timeline|export|social|report)(?:[/?]|$)/u.test(url)) {
      return route.fallback();
    }
    if (options.forbidScenarioDataFetch) {
      return recordDisabledScenarioRequest(route);
    }
    return route.fulfill(json(SCENARIO_FIXTURE));
  });
}

// ── Per-locale report assertions ──────────────────────────────

async function assertReportRenders(page, steps, isZh) {
  const title = isZh ? "深读报告：可再生能源" : "Deep-Read Report: Renewable Energy";
  const titleHeading = page.getByRole("heading", { name: title }).first();
  await titleHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  steps.push(createStep(
    `report-localized-title-${isZh ? "zh" : "en"}`,
    await titleHeading.isVisible().catch(() => false),
    title,
  ));

  // Sections render (localized section heading).
  const sectionTitle = isZh ? "关键驱动力" : "Key Drivers";
  const sectionHeading = page.getByRole("heading", { name: new RegExp(sectionTitle) }).first();
  await sectionHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  steps.push(createStep(
    `report-section-visible-${isZh ? "zh" : "en"}`,
    await sectionHeading.isVisible().catch(() => false),
    sectionTitle,
  ));

  // Confidence badge: localized level word (medium), NEVER the raw lowercase enum.
  const badge = page.locator(".report-confidence-badge");
  const badgeText = await badge.first().textContent().catch(() => "");
  const expectedLevel = isZh ? "中" : "Medium";
  const expectedLabel = isZh ? "分析置信度" : "Analytic Confidence";
  steps.push(createStep(
    `confidence-badge-localized-level-${isZh ? "zh" : "en"}`,
    (badgeText ?? "").includes(expectedLevel) && (badgeText ?? "").includes(expectedLabel),
    badgeText,
  ));

  // WEP chip: localized word-estimate ("Likely" / "可能"), NEVER the raw snake_case enum.
  const expectedWep = isZh ? "可能" : "Likely";
  steps.push(createStep(
    `confidence-badge-localized-wep-${isZh ? "zh" : "en"}`,
    (badgeText ?? "").includes(expectedWep) && !(badgeText ?? "").includes("likely"),
    badgeText,
  ));

  // Indicators-to-watch section renders.
  const indicatorsHeading = isZh ? "后续观察指标" : "Indicators to Watch";
  steps.push(createStep(
    `report-indicators-visible-${isZh ? "zh" : "en"}`,
    await page.getByRole("heading", { name: new RegExp(indicatorsHeading) }).first().isVisible().catch(() => false),
    await page.locator(".report-indicators").first().textContent().catch(() => null),
  ));
}

async function runEvidenceDeepLink(page, steps) {
  // Open the evidence drawer via the section "View Evidence" button.
  const viewEvidence = page.getByRole("button", {
    name: /查看引用的证据|查看证据|View cited evidence|View Evidence/i,
  }).first();
  await viewEvidence.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  steps.push(createStep("evidence-view-button-visible", await viewEvidence.isVisible().catch(() => false)));
  await viewEvidence.click().catch(() => {});

  const drawer = page.locator("[role='dialog']").filter({ hasText: /Cited Evidence|引用证据/ }).first();
  steps.push(createStep(
    "evidence-drawer-open",
    await drawer.isVisible().catch(() => false),
  ));

  // Click "View Context" → navigates to /replay/{id}?branch=...&message=...#t=turn_N
  const viewContext = page.getByRole("button", { name: /查看上下文|View in replay for/i }).first();
  const replayTraceSettled = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith(
      `/api/scenario/${FIXTURE_SCENARIO_ID}/replay-trace`,
    ),
    { timeout: 8000 },
  ).catch(() => null);
  const causalGraphSettled = page.waitForResponse(
    (response) => new URL(response.url()).pathname.endsWith(
      `/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph`,
    ),
    { timeout: 8000 },
  ).catch(() => null);
  await viewContext.click().catch(() => {});
  await page.waitForURL(/\/replay\//u, { timeout: 8000 }).catch(() => {});
  const url = page.url();
  await page.getByTestId("replay-view-root").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  await Promise.all([replayTraceSettled, causalGraphSettled]);
  steps.push(createStep(
    "evidence-deeplink-navigates-to-replay",
    /\/replay\//u.test(url) && /branch=/u.test(url) && /message=/u.test(url) && /round=/u.test(url),
    url,
  ));
}

async function runForcedColorsReducedMotionSmoke(page, steps) {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" }).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  const panel = page.locator(".report-panel-container").first();
  await panel.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  steps.push(createStep(
    "forced-colors-reduced-motion-panel-visible",
    await panel.isVisible().catch(() => false),
  ));
  await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" }).catch(() => {});
}

async function assertNoHorizontalOverflow(page, steps, label) {
  const metrics = await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    documentClientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    windowInnerWidth: window.innerWidth,
  }));
  steps.push(createStep(
    `no-horizontal-overflow-${label}`,
    metrics.documentScrollWidth <= metrics.documentClientWidth + 1
      && metrics.bodyScrollWidth <= metrics.windowInnerWidth + 1,
    metrics,
  ));
}

// ── One surface run ───────────────────────────────────────────

async function runResultReportSurface({ mode, browserName, contextOptions, args }) {
  const outputDir = args.outputDir
    ? path.join(args.outputDir, `${mode}-${browserName}`)
    : path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-result-report-${mode}-${browserName}`);
  ensureDir(outputDir);

  const browser = await launchBrowser(browserName, args.headless);
  const state = {
    apiRequests: [],
    unhandledApiRequests: [],
    disabledScenarioApiRequests: [],
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };
  const steps = [];
  let fatalError = null;
  let context = null;
  let page = null;

  try {
    // ── Locale loop: complete report in en, then zh ──
    for (const locale of ["en", "zh"]) {
      const isZh = locale === "zh";
      context = await browser.newContext({
        ...contextOptions,
        locale: isZh ? "zh-CN" : "en-US",
        reducedMotion: mode === "mobile" ? "reduce" : "no-preference",
      });
      page = await context.newPage();
      page.on("console", (msg) => { if (msg.type() === "error") state.consoleErrors.push(msg.text()); });
      page.on("pageerror", (err) => state.pageErrors.push(err.message));
      page.on("requestfailed", (request) => {
        const failure = request.failure();
        state.requestFailures.push({ url: request.url(), errorText: failure?.errorText ?? null });
      });
      page.on("request", (request) => {
        const parsed = new URL(request.url());
        if (parsed.pathname.startsWith("/api/")) {
          state.apiRequests.push({ method: request.method(), path: parsed.pathname });
        }
      });

      if (!LIVE_MODE) await installFixtures(page, state, reportFixture("complete"));
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      await page.locator(".report-panel-container").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

      await assertReportRenders(page, steps, isZh);
      await assertNoHorizontalOverflow(page, steps, `${mode}-${locale}`);
      writeJson(path.join(outputDir, `report-${locale}.json`), { locale, url: page.url() });
      await saveScreenshot(page, path.join(outputDir, `report-${locale}.png`));

      if (locale === "en") {
        // Evidence deep-link + forced-colors/reduced-motion smoke (en surface only — cheap + deterministic).
        await runEvidenceDeepLink(page, steps);
        // Reset back to the report page for the forced-colors smoke.
        if (!LIVE_MODE) await installFixtures(page, state, reportFixture("complete"));
        await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
        await page.locator(".report-panel-container").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
        await runForcedColorsReducedMotionSmoke(page, steps);
      }

      await page.close().catch(() => {});
      await context.close().catch(() => {});
      page = null;
      context = null;
    }

    // ── Partial report: sections + non-blocking retry banner ──
    context = await browser.newContext({ ...contextOptions, locale: "en-US" });
      page = await context.newPage();
      if (!LIVE_MODE) await installFixtures(page, state, partialReportFixture());
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      await page.locator(".report-panel-container").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      if (!LIVE_MODE) {
        const sectionHeading = page.getByRole("heading", { name: /Key Drivers/ }).first();
        const retryButton = page.getByRole("button", { name: /Retry Generation/i }).first();
        await sectionHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        await retryButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        steps.push(createStep(
          "partial-report-renders-sections",
          await sectionHeading.isVisible().catch(() => false),
        ));
        steps.push(createStep(
          "partial-report-shows-retry-banner",
          await page.locator(".report-partial-banner").first().isVisible().catch(() => false)
          && await retryButton.isVisible().catch(() => false),
        ));
      }
    await saveScreenshot(page, path.join(outputDir, "report-partial.png"));
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    page = null;
    context = null;

    // ── Failed report: retry/failure card, no sections ──
    context = await browser.newContext({ ...contextOptions, locale: "en-US" });
    page = await context.newPage();
    if (!LIVE_MODE) await installFixtures(page, state, failedReportFixture());
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      await page.locator(".report-panel-container").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      if (!LIVE_MODE) {
        const retryButton = page.getByRole("button", { name: /Retry Generation/i }).first();
        await retryButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        steps.push(createStep(
          "failed-report-shows-retry-card",
          await retryButton.isVisible().catch(() => false),
        ));
      steps.push(createStep(
        "failed-report-hides-sections",
        !(await page.getByRole("heading", { name: /Key Drivers/ }).first().isVisible().catch(() => false)),
      ));
    }
    await saveScreenshot(page, path.join(outputDir, "report-failed.png"));
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    page = null;
    context = null;

    // ── Capability disabled/error gates (fixture mode only) ──
    if (!LIVE_MODE) {
      context = await browser.newContext({ ...contextOptions, locale: "en-US" });
      page = await context.newPage();
      const disabledCapabilities = capabilitiesFixture();
      disabledCapabilities.result_report = { ...disabledCapabilities.result_report, enabled: false };
      const disabledScenarioStart = state.disabledScenarioApiRequests.length;
      await installFixtures(page, state, reportFixture("complete"), {
        capabilities: disabledCapabilities,
        forbidScenarioDataFetch: true,
      });
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      const disabledPanel = page.locator(".report-panel-container").first();
      await disabledPanel.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

      const sectionHeading = page.getByRole("heading", { name: /Key Drivers/ }).first();
      const confidenceBadge = page.locator(".report-confidence-badge").first();
      const featureNotEnabledHeader = page.getByRole("heading", { name: /Feature Not Enabled/i }).first();
      const backToOverviewButton = page.getByRole("button", { name: /Back to Result Overview/i }).first();

      const contentAbsent = !(await sectionHeading.isVisible().catch(() => false)) && !(await confidenceBadge.isVisible().catch(() => false));
      const unavailableSurfaceVisible = await featureNotEnabledHeader.isVisible().catch(() => false) || await backToOverviewButton.isVisible().catch(() => false);

      steps.push(createStep(
        "capability-disabled-shows-unavailable-surface",
        contentAbsent && unavailableSurfaceVisible,
      ));
      const disabledScenarioRequests = state.disabledScenarioApiRequests.slice(disabledScenarioStart);
      steps.push(createStep(
        "capability-disabled-does-not-fetch-scenario",
        disabledScenarioRequests.length === 0,
        disabledScenarioRequests,
      ));
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      page = null;
      context = null;

      context = await browser.newContext({ ...contextOptions, locale: "en-US" });
      page = await context.newPage();
      await installFixtures(page, state, reportFixture("complete"), { capabilitiesStatus: 500 });
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      const retryButton = page.getByRole("button", { name: /Retry/i }).first();
      await retryButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      steps.push(createStep(
        "capability-error-shows-retry",
        await retryButton.isVisible().catch(() => false),
      ));
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      page = null;
      context = null;
    }

    steps.push(createStep("no-page-errors", state.pageErrors.length === 0, state.pageErrors));
    steps.push(createStep("no-console-errors", state.consoleErrors.length === 0, state.consoleErrors));
    steps.push(createStep("no-request-failures", state.requestFailures.length === 0, state.requestFailures));
    if (!LIVE_MODE) {
      steps.push(createStep("no-unhandled-api-requests", state.unhandledApiRequests.length === 0, state.unhandledApiRequests));
    }
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
    steps.push(createStep("fatal-error", false, {
      message: fatalError,
      apiRequests: state.apiRequests,
      unhandledApiRequests: state.unhandledApiRequests,
      consoleErrors: state.consoleErrors,
      pageErrors: state.pageErrors,
    }));
    if (page) await saveScreenshot(page, path.join(outputDir, "crash.png"));
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const result = {
    mode,
    browser: browserName,
    route: `/result/${FIXTURE_SCENARIO_ID}/report`,
    live: LIVE_MODE,
    error: fatalError,
    diagnostics: {
      apiRequests: state.apiRequests,
      unhandledApiRequests: state.unhandledApiRequests,
      consoleErrors: state.consoleErrors,
      pageErrors: state.pageErrors,
      requestFailures: state.requestFailures,
    },
    steps,
    summary: summarize(steps, fatalError),
  };
  writeJson(path.join(outputDir, "result.json"), result);
  console.log(JSON.stringify({
    mode: result.mode,
    browser: result.browser,
    live: result.live,
    allPassed: result.summary.allPassed,
    passedSteps: result.summary.passedSteps,
    totalSteps: result.summary.totalSteps,
    outputDir,
  }));
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const results = [];

  for (const surface of buildSurfaceRuns(args)) {
    const result = await runResultReportSurface({
      mode: surface.mode,
      browserName: surface.browser,
      contextOptions: surface.context,
      args,
    });
    results.push(result);
    if (!result.summary.allPassed) process.exitCode = 1;
  }

  const passedSurfaces = results.filter((result) => result.summary.allPassed).length;
  const overall = {
    mode: args.mode,
    browser: args.browser,
    live: LIVE_MODE,
    allPassed: results.length > 0 && results.every((result) => result.summary.allPassed),
    totalSurfaces: results.length,
    passedSurfaces,
    failedSurfaces: results.length - passedSurfaces,
    surfaces: results.map((result) => ({
      mode: result.mode,
      browser: result.browser,
      allPassed: result.summary.allPassed,
      passedSteps: result.summary.passedSteps,
      totalSteps: result.summary.totalSteps,
      error: result.error,
    })),
  };

  // Aggregate root `result.json` — release-signoff points at this file (it expects a single
  // root result, while each surface also writes its own `${mode}-${browser}/result.json`).
  if (args.outputDir) {
    ensureDir(args.outputDir);
    writeJson(path.join(args.outputDir, "result.json"), {
      suite: "result-report",
      generated_at: new Date().toISOString(),
      ...overall,
      // Mirror the per-surface summary shape so generic consumers can read pass/fail uniformly.
      summary: {
        totalSteps: results.reduce((sum, r) => sum + r.summary.totalSteps, 0),
        passedSteps: results.reduce((sum, r) => sum + r.summary.passedSteps, 0),
        allPassed: overall.allPassed,
      },
    });
  }

  console.log(JSON.stringify({ overall }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
