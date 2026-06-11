/**
 * Fixture-backed Result Report (full_report) browser regression.
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
import http from "node:http";
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

// probability_bar chart: 3 branches, one dominant.
const probabilityChart = {
  kind: "probability_bar",
  type: "probability_bar",
  data: {
    status: "available", reason: null,
    sort: ["branch-green-transition", "branch-slow-roll", "branch-status-quo"],
    branches: [
      { branch_id: "branch-green-transition", label: "Green Transition", probability: 0.64, dominant: true, status: "completed" },
      { branch_id: "branch-slow-roll", label: "Slow Roll", probability: 0.26, dominant: false, status: "completed" },
      { branch_id: "branch-status-quo", label: "Status Quo Lock-in", probability: 0.10, dominant: false, status: "completed" },
    ],
  },
};

// faction_share chart: 3 factions + footnote (avg_opposition present).
const factionChart = {
  kind: "faction_share",
  type: "faction_share",
  data: {
    status: "available", reason: null,
    factions: [
      { faction_key: "f-accel", label: "Accelerationists", member_count: 4, share: 0.5, stance_center: 0.8, confidence: 0.7 },
      { faction_key: "f-caution", label: "Cautious Incrementalists", member_count: 2, share: 0.25, stance_center: 0.1, confidence: 0.6 },
      { faction_key: "f-incumbent", label: "Incumbent Defenders", member_count: 2, share: 0.25, stance_center: -0.6, confidence: 0.65 },
    ],
    relation_edge_count: 7, avg_opposition: 0.42,
  },
};

// faction_share with avg_opposition=null → factionOppositionNone.
const factionChartNullOpp = {
  kind: "faction_share", type: "faction_share",
  data: {
    status: "available", reason: null,
    factions: [{ faction_key: "f-solo", label: "Sole Bloc", member_count: 3, share: 1.0, stance_center: 0.2, confidence: 0.5 }],
    relation_edge_count: 0, avg_opposition: null,
  },
};

// known type, empty data with reason → renders reason text.
const emptyChartWithReason = {
  kind: "faction_share", type: "faction_share",
  data: { status: "missing", reason: "no_faction_snapshots", factions: [], relation_edge_count: 0, avg_opposition: null },
};

// known type, empty data WITHOUT reason → renders chartEmpty i18n.
const emptyChartNoReason = {
  kind: "probability_bar", type: "probability_bar",
  data: { status: "missing", reason: null, sort: [], branches: [] },
};

// unknown chart type → chartUnavailable placeholder.
const unknownChart = { kind: "sankey", type: "sankey", data: { whatever: true, nodes: [], links: [] } };

function reportFixture(status = "complete") {
  return {
    version: "1.0",
    generated_at: "2026-06-08T00:00:00Z",
    generation_mode: "generation",
    target_branch_id: "branch-green-transition",
    target_branch_sort: ["probability_desc", "fork_round_asc", "id_asc"],
    language: "en",
    available_languages: ["zh", "en"],
    title: "Full report",
    title_i18n: { zh: "完整报告：可再生能源", en: "Full Report: Renewable Energy" },
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
        charts: [probabilityChart, factionChart, factionChartNullOpp, emptyChartWithReason, emptyChartNoReason, unknownChart],
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

// Local SSE server for report:generate.
function startToolTraceSseServer() {
  const sectionComplete = {
    event: "report_section_complete",
    section_id: "timeline",
    tool_trace: [
      { tool: "web_search", query: "renewable adoption timeline", item_count: 8, elapsed_ms: 1234 },
      { tool: "vector_lookup", query: "", item_count: 3, elapsed_ms: 56 },
    ],
  };
  const openSockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify({ event: "report_started", scenario_id: FIXTURE_SCENARIO_ID })}\n\n`);
    res.write(`data: ${JSON.stringify(sectionComplete)}\n\n`);
    // Intentionally hold open (safety close after 20s).
    const holdTimer = setTimeout(() => { try { res.end(); } catch { /* noop */ } }, 20000);
    res.on("close", () => clearTimeout(holdTimer));
  });
  server.on("connection", (sock) => {
    openSockets.add(sock);
    sock.on("close", () => openSockets.delete(sock));
  });
  const PORT = Number(process.env.SWARM_BACKEND_PORT || 18927);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => {
      resolve({
        port: PORT,
        close: () => new Promise((done) => {
          for (const s of openSockets) { try { s.destroy(); } catch { /* noop */ } }
          server.close(() => done());
        }),
      });
    });
  });
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
    const parsed = new URL(route.request().url());
    if (parsed.pathname.endsWith("/report:generate")) {
      if (options.passThroughReportGenerate) {
        return route.continue();
      }
      return route.fulfill(json({ detail: "no report stream fixture" }, 404));
    }
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
  const title = isZh ? "完整报告：可再生能源" : "Full Report: Renewable Energy";
  let titleOk = false;
  let titleText = title;
  if (LIVE_MODE) {
    const titleLocator = page.locator(".report-content h2, .report-panel-container h2, h2").first();
    await titleLocator.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    titleText = (await titleLocator.textContent().catch(() => "")) || "";
    titleOk = (await titleLocator.isVisible().catch(() => false)) && titleText.trim().length > 0;
  } else {
    const titleHeading = page.getByRole("heading", { name: title }).first();
    await titleHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    titleOk = await titleHeading.isVisible().catch(() => false);
  }
  steps.push(createStep(
    `report-localized-title-${isZh ? "zh" : "en"}`,
    titleOk,
    titleText,
  ));

  // Sections render (localized section heading).
  const sectionTitle = isZh ? "关键驱动力" : "Key Drivers";
  let sectionVisible = false;
  let sectionVal = sectionTitle;
  if (LIVE_MODE) {
    const sectionCount = await page.locator(".report-section").count().catch(() => 0);
    const firstSectionHeading = page.locator(".report-section h2, .report-section h3, .report-section h4").first();
    await firstSectionHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    const headingVisible = await firstSectionHeading.isVisible().catch(() => false);
    sectionVisible = sectionCount >= 1 && headingVisible;
    sectionVal = `count: ${sectionCount}, first heading visible: ${headingVisible}`;
  } else {
    const sectionHeading = page.getByRole("heading", { name: new RegExp(sectionTitle) }).first();
    await sectionHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    sectionVisible = await sectionHeading.isVisible().catch(() => false);
  }
  steps.push(createStep(
    `report-section-visible-${isZh ? "zh" : "en"}`,
    sectionVisible,
    sectionVal,
  ));

  // Confidence badge: localized level word (medium), NEVER the raw lowercase enum.
  const badge = page.locator(".report-confidence-badge");
  const badgeText = await badge.first().textContent().catch(() => "");
  const expectedLabel = isZh ? "分析置信度" : "Analytic Confidence";
  let levelOk = false;
  if (LIVE_MODE) {
    const levelWords = isZh ? ["高", "中", "低", "暂无"] : ["High", "Medium", "Low", "Not Available"];
    const hasLabel = (badgeText ?? "").includes(expectedLabel);
    const hasLevel = levelWords.some(word => (badgeText ?? "").includes(word));
    levelOk = hasLabel && hasLevel;
  } else {
    const expectedLevel = isZh ? "中" : "Medium";
    levelOk = (badgeText ?? "").includes(expectedLevel) && (badgeText ?? "").includes(expectedLabel);
  }
  steps.push(createStep(
    `confidence-badge-localized-level-${isZh ? "zh" : "en"}`,
    levelOk,
    badgeText,
  ));

  // WEP chip: localized word-estimate ("Likely" / "可能"), NEVER the raw snake_case enum.
  let wepOk = false;
  if (LIVE_MODE) {
    const hasSnakeCase = /\b[a-z]+_[a-z]+\b/.test(badgeText);
    const lowerEnums = ["likely", "unlikely", "almost_certain", "very_likely", "highly_unlikely", "even_chance", "very_unlikely", "almost_impossible", "not_available"];
    const hasRawEnum = lowerEnums.some(word => new RegExp(`\\b${word}\\b`).test(badgeText));
    wepOk = !hasSnakeCase && !hasRawEnum;
  } else {
    const expectedWep = isZh ? "可能" : "Likely";
    wepOk = (badgeText ?? "").includes(expectedWep) && !(badgeText ?? "").includes("likely");
  }
  steps.push(createStep(
    `confidence-badge-localized-wep-${isZh ? "zh" : "en"}`,
    wepOk,
    badgeText,
  ));

  // Indicators-to-watch section renders.
  const indicatorsHeading = isZh ? "后续观察指标" : "Indicators to Watch";
  steps.push(createStep(
    `report-indicators-visible-${isZh ? "zh" : "en"}`,
    await page.getByRole("heading", { name: new RegExp(indicatorsHeading) }).first().isVisible().catch(() => false),
    await page.locator(".report-indicators").first().textContent().catch(() => null),
  ));

  if (!LIVE_MODE) {
    await assertChartsRender(page, steps, isZh);
  }
}

async function assertChartsRender(page, steps, isZh) {
  const locale = isZh ? "zh" : "en";

  // 1. probability_bar
  const probChart = page.locator(".probability-bar-chart").first();
  await probChart.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const probVisible = await probChart.isVisible().catch(() => false);
  steps.push(createStep(`${locale}-probability-chart-visible`, probVisible));

  if (probVisible) {
    const probText = await probChart.textContent().catch(() => "") || "";
    const expectedTitle = isZh ? "分支概率" : "Branch likelihoods";
    steps.push(createStep(`${locale}-probability-title`, probText.includes(expectedTitle), probText));
    steps.push(createStep(`${locale}-probability-label-green`, probText.includes("Green Transition"), probText));
    steps.push(createStep(`${locale}-probability-pct-64`, probText.includes("64%"), probText));
    steps.push(createStep(`${locale}-probability-pct-26`, probText.includes("26%"), probText));

    // dominant ★ + sr-only
    const dominantBadge = probChart.locator(".dominant-badge").first();
    const badgeVisible = await dominantBadge.isVisible().catch(() => false);
    steps.push(createStep(`${locale}-probability-dominant-badge`, badgeVisible));

    const expectedDominantSr = isZh ? "最可能的结果" : "Most likely outcome";
    const badgeText = await dominantBadge.textContent().catch(() => "") || "";
    steps.push(createStep(`${locale}-probability-dominant-sr`, badgeText.includes(expectedDominantSr), badgeText));

    // bar role=img aria-label
    const barImg = probChart.locator("[role='img']").first();
    const barAria = await barImg.getAttribute("aria-label").catch(() => "") || "";
    steps.push(createStep(`${locale}-probability-bar-aria`, /Green Transition/.test(barAria) && /64%/.test(barAria), barAria));
  } else {
    steps.push(createStep(`${locale}-probability-title`, false));
    steps.push(createStep(`${locale}-probability-label-green`, false));
    steps.push(createStep(`${locale}-probability-pct-64`, false));
    steps.push(createStep(`${locale}-probability-pct-26`, false));
    steps.push(createStep(`${locale}-probability-dominant-badge`, false));
    steps.push(createStep(`${locale}-probability-dominant-sr`, false));
    steps.push(createStep(`${locale}-probability-bar-aria`, false));
  }

  // 2. faction_share
  const facChart = page.locator(".faction-share-chart").first();
  await facChart.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
  const facVisible = await facChart.isVisible().catch(() => false);
  steps.push(createStep(`${locale}-faction-chart-visible`, facVisible));

  if (facVisible) {
    const facText = await facChart.textContent().catch(() => "") || "";
    const expectedTitle = isZh ? "阵营占比" : "Faction shares";
    steps.push(createStep(`${locale}-faction-title`, facText.includes(expectedTitle), facText));
    steps.push(createStep(`${locale}-faction-label`, facText.includes("Accelerationists"), facText));

    const expectedMembers = isZh ? "4 名成员" : "4 members";
    steps.push(createStep(`${locale}-faction-members`, facText.includes(expectedMembers), facText));

    const expectedRelations = isZh ? "关系连接：7" : "Relationship links: 7";
    steps.push(createStep(`${locale}-faction-relations`, facText.includes(expectedRelations), facText));

    const expectedOpposition = isZh ? "平均对立度：0.42" : "Avg. opposition: 0.42";
    steps.push(createStep(`${locale}-faction-opposition`, facText.includes(expectedOpposition), facText));
  } else {
    steps.push(createStep(`${locale}-faction-title`, false));
    steps.push(createStep(`${locale}-faction-label`, false));
    steps.push(createStep(`${locale}-faction-members`, false));
    steps.push(createStep(`${locale}-faction-relations`, false));
    steps.push(createStep(`${locale}-faction-opposition`, false));
  }

  // 3. factionOppositionNone copy
  const pageText = await page.locator(".report-panel-container").first().textContent().catch(() => "") || "";
  const expectedOppNone = isZh ? "平均对立度：暂无" : "Avg. opposition: n/a";
  steps.push(createStep(`${locale}-faction-opposition-none`, pageText.includes(expectedOppNone), pageText));

  // 4. empty-data with reason
  const expectedReasonText = isZh ? "本次推演未捕获阵营快照。" : "No faction snapshots were captured for this run.";
  const hasReasonText = pageText.includes(expectedReasonText);
  const rawCodeAbsent = !pageText.includes("no_faction_snapshots");
  steps.push(createStep(`${locale}-empty-reason-text`, hasReasonText && rawCodeAbsent, { hasReasonText, rawCodeAbsent }));

  // 5. empty-data without reason
  const expectedEmptyText = isZh ? "该图表暂无数据。" : "No data available for this chart yet.";
  steps.push(createStep(`${locale}-empty-chartEmpty`, pageText.includes(expectedEmptyText), pageText));

  // 6. unknown type -> chartUnavailable placeholder
  const unavailable = page.locator(".chart-unavailable").first();
  const unavailableVisible = await unavailable.isVisible().catch(() => false);
  const expectedUnavailableText = isZh ? "图表暂不可用。" : "Chart not available yet.";
  const unavailableText = await unavailable.textContent().catch(() => "") || "";
  steps.push(createStep(
    `${locale}-unknown-chartUnavailable`,
    unavailableVisible && unavailableText.includes(expectedUnavailableText),
    { unavailableVisible, unavailableText }
  ));
}

async function runToolTraceE2ETest(page, steps, isZh, state, locale) {
  const chipTriggerSel = "#report-tool-trace-trigger";

  // Before retry: no tool-trace chip.
  const beforeCount = await page.locator(chipTriggerSel).count().catch(() => 0);
  steps.push(createStep(`tooltrace-absent-before-retry-${locale}`, beforeCount === 0, beforeCount));

  // Click Retry
  const expectedRetryName = isZh ? "重试生成" : "Retry Generation";
  const retryBtn = page.getByRole("button", { name: new RegExp(expectedRetryName, "i") }).first();
  const retryVisible = await retryBtn.isVisible().catch(() => false);
  steps.push(createStep(`tooltrace-retry-button-visible-${locale}`, retryVisible));

  if (retryVisible) {
    await retryBtn.click().catch(() => {});

    // Chip should appear once the SSE tool_trace frame is read
    const chipTrigger = page.locator(chipTriggerSel).first();
    await chipTrigger.waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
    const chipAppeared = await chipTrigger.isVisible().catch(() => false);
    steps.push(createStep(`tooltrace-chip-appears-${locale}`, chipAppeared));

    const chipText = await chipTrigger.textContent().catch(() => "") || "";
    const expectedLabel = isZh ? "工具活动（2）" : "Tool activity (2)";
    steps.push(createStep(`tooltrace-chip-label-${locale}`, chipText.includes(expectedLabel), chipText));

    // Default collapsed
    steps.push(createStep(`tooltrace-default-collapsed-${locale}`, (await chipTrigger.getAttribute("aria-expanded").catch(() => "")) === "false"));

    // Collapsed state has no dangling aria-controls target (Approach B: aria-controls should be absent).
    const ariaControlsVal = await chipTrigger.getAttribute("aria-controls").catch(() => null);
    steps.push(createStep(`tooltrace-collapsed-no-aria-controls-${locale}`, !ariaControlsVal, ariaControlsVal));
    steps.push(createStep(`tooltrace-region-hidden-collapsed-${locale}`, (await page.locator("#report-tool-trace-details").count().catch(() => 0)) === 0));

    // Click → expand
    const expectedExpandLabel = isZh ? "显示工具活动详情" : "Show tool activity details";
    const ariaLabelBeforeClick = await chipTrigger.getAttribute("aria-label").catch(() => "");
    steps.push(createStep(`tooltrace-aria-label-expand-${locale}`, ariaLabelBeforeClick === expectedExpandLabel, ariaLabelBeforeClick));

    await chipTrigger.click().catch(() => {});
    await page.locator("#report-tool-trace-details").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    steps.push(createStep(`tooltrace-expanded-after-click-${locale}`, (await chipTrigger.getAttribute("aria-expanded").catch(() => "")) === "true"));

    // Expanded state should have aria-controls referencing the region which is in DOM
    const ariaControlsAfterClick = await chipTrigger.getAttribute("aria-controls").catch(() => null);
    steps.push(createStep(`tooltrace-expanded-has-aria-controls-${locale}`, ariaControlsAfterClick === "report-tool-trace-details", ariaControlsAfterClick));
    steps.push(createStep(`tooltrace-region-visible-expanded-${locale}`, (await page.locator("#report-tool-trace-details").count().catch(() => 0)) === 1));

    const expectedCollapseLabel = isZh ? "隐藏工具活动详情" : "Hide tool activity details";
    const ariaLabelAfterClick = await chipTrigger.getAttribute("aria-label").catch(() => "");
    steps.push(createStep(`tooltrace-aria-label-collapse-${locale}`, ariaLabelAfterClick === expectedCollapseLabel, ariaLabelAfterClick));

    const regionText = await page.locator("#report-tool-trace-details").first().textContent().catch(() => "") || "";
    steps.push(createStep(`tooltrace-tool-row-web_search-${locale}`, regionText.includes("web_search"), regionText));
    steps.push(createStep(`tooltrace-tool-row-vector-${locale}`, regionText.includes("vector_lookup"), regionText));

    const expectedElapsed = isZh ? "1234 毫秒" : "1234 ms";
    steps.push(createStep(`tooltrace-elapsed-ms-${locale}`, regionText.includes(expectedElapsed), regionText));

    const expectedItemCount = isZh ? "8 条结果" : "8 items";
    steps.push(createStep(`tooltrace-item-count-${locale}`, regionText.includes(expectedItemCount), regionText));

    const expectedEmptyQuery = isZh ? "（无查询）" : "(no query)";
    steps.push(createStep(`tooltrace-empty-query-${locale}`, regionText.includes(expectedEmptyQuery), regionText));

    // Keyboard: focus trigger, press Enter to collapse, Space to expand.
    await chipTrigger.focus().catch(() => {});
    await page.keyboard.press("Enter").catch(() => {});
    await page.waitForTimeout(200);
    steps.push(createStep(`tooltrace-keyboard-enter-collapse-${locale}`, (await chipTrigger.getAttribute("aria-expanded").catch(() => "")) === "false"));

    await page.keyboard.press("Space").catch(() => {});
    await page.waitForTimeout(200);
    steps.push(createStep(`tooltrace-keyboard-space-expand-${locale}`, (await chipTrigger.getAttribute("aria-expanded").catch(() => "")) === "true"));
  } else {
    // push dummy steps
    steps.push(createStep(`tooltrace-chip-appears-${locale}`, false));
    steps.push(createStep(`tooltrace-chip-label-${locale}`, false));
    steps.push(createStep(`tooltrace-default-collapsed-${locale}`, false));
    steps.push(createStep(`tooltrace-collapsed-no-aria-controls-${locale}`, false));
    steps.push(createStep(`tooltrace-region-hidden-collapsed-${locale}`, false));
    steps.push(createStep(`tooltrace-aria-label-expand-${locale}`, false));
    steps.push(createStep(`tooltrace-expanded-after-click-${locale}`, false));
    steps.push(createStep(`tooltrace-expanded-has-aria-controls-${locale}`, false));
    steps.push(createStep(`tooltrace-region-visible-expanded-${locale}`, false));
    steps.push(createStep(`tooltrace-aria-label-collapse-${locale}`, false));
    steps.push(createStep(`tooltrace-tool-row-web_search-${locale}`, false));
    steps.push(createStep(`tooltrace-tool-row-vector-${locale}`, false));
    steps.push(createStep(`tooltrace-elapsed-ms-${locale}`, false));
    steps.push(createStep(`tooltrace-item-count-${locale}`, false));
    steps.push(createStep(`tooltrace-empty-query-${locale}`, false));
    steps.push(createStep(`tooltrace-keyboard-enter-collapse-${locale}`, false));
    steps.push(createStep(`tooltrace-keyboard-space-expand-${locale}`, false));
  }
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
  const probVisible = await page.locator(".probability-bar-chart").first().isVisible().catch(() => false);
  const factionVisible = await page.locator(".faction-share-chart").first().isVisible().catch(() => false);
  steps.push(createStep(
    "forced-colors-reduced-motion-charts-visible",
    probVisible && factionVisible
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
  let sseServer = null;

  try {
    if (!LIVE_MODE) {
      sseServer = await startToolTraceSseServer();
    }
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
        const resourceType = request.resourceType();
        if (!["document", "script", "stylesheet", "xhr", "fetch"].includes(resourceType)) return;
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
    for (const locale of ["en", "zh"]) {
      const isZh = locale === "zh";
      context = await browser.newContext({ ...contextOptions, locale: isZh ? "zh-CN" : "en-US" });
      page = await context.newPage();
      page.on("console", (msg) => { if (msg.type() === "error") state.consoleErrors.push(msg.text()); });
      page.on("pageerror", (err) => state.pageErrors.push(err.message));

      if (!LIVE_MODE) await installFixtures(page, state, partialReportFixture(), { passThroughReportGenerate: true });
      await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}/report`, { waitUntil: "domcontentloaded" });
      await page.locator(".report-panel-container").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
      if (!LIVE_MODE) {
        const sectionHeading = page.getByRole("heading", { name: isZh ? /关键驱动力/ : /Key Drivers/ }).first();
        const retryButton = page.getByRole("button", { name: isZh ? /重试生成/i : /Retry Generation/i }).first();
        await sectionHeading.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        await retryButton.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
        steps.push(createStep(
          `partial-report-renders-sections-${locale}`,
          await sectionHeading.isVisible().catch(() => false),
        ));
        steps.push(createStep(
          `partial-report-shows-retry-banner-${locale}`,
          await page.locator(".report-partial-banner").first().isVisible().catch(() => false)
            && await retryButton.isVisible().catch(() => false),
        ));

        await runToolTraceE2ETest(page, steps, isZh, state, locale);
      }
      await saveScreenshot(page, path.join(outputDir, `report-partial-${locale}.png`));
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      page = null;
      context = null;
    }

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
    if (sseServer) {
      await sseServer.close().catch(() => {});
    }
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
