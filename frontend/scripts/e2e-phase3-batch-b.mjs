/**
 * X-3B — Phase 3 Batch B Playwright E2E
 * Argument Map / Factions / Counterfactual
 *
 * Uses page.route() fixtures — no running backend required.
 * Run: node scripts/e2e-phase3-batch-b.mjs [desktop|mobile|full]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

import { validateSvgDownloadArtifact } from "./lib/exportValidation.mjs";
import {
  assertFrontendRoutesReady,
  buildPhase3BatchBPreflightPaths,
} from "./lib/frontendPreflight.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const E2E_LOCALE = process.env.SWARM_E2E_LOCALE || "en-US";
const E2E_APP_LANGUAGE = E2E_LOCALE.toLowerCase().startsWith("zh") ? "zh" : "en";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

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
    headless: process.env.HEADLESS === "1",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-phase3-batch-b.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--headless]");
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

async function triggerArgumentMapLoad(page) {
  const sectionHeading = page.getByRole("heading", { name: /Argument Map|论证图谱/i }).first();
  const sectionReady = await sectionHeading.isVisible({ timeout: 10000 }).catch(() => false);
  if (!sectionReady) {
    return { hasLoadButton: false, sawResponse: false };
  }

  const loadButton = page.getByRole("button", { name: /Load map|加载图谱/i }).first();
  const hasLoadButton = await loadButton.isVisible({ timeout: 10000 }).catch(() => false);
  if (!hasLoadButton) {
    return { hasLoadButton: false, sawResponse: false };
  }

  const sawResponse = await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes(`/api/debate/${FIXTURE_DEBATE_ID}/argument-map`),
      { timeout: 10000 },
    ).then(() => true).catch(() => false),
    loadButton.click(),
  ]).then(([didRespond]) => didRespond);

  return { hasLoadButton: true, sawResponse };
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

async function hasVisibleMatch(locator) {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const isVisible = await locator.nth(index).isVisible().catch(() => false);
    if (isVisible) return true;
  }
  return false;
}

const IGNORED_REQUEST_FAILURE_TEXT_PATTERNS = [
  /net::ERR_ABORTED/i,
  /NS_BINDING_ABORTED/i,
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

function mergeBrowserIssues(target, source) {
  target.consoleErrors.push(...source.consoleErrors);
  target.pageErrors.push(...source.pageErrors);
  target.requestFailures.push(...source.requestFailures);
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

const FIXTURE_SCENARIO_ID = "sc-e2e-batch-b";
const FIXTURE_DEBATE_ID = "debate-e2e-batch-b";
const FIXTURE_BRANCH_A = "branch-a";
const FIXTURE_BRANCH_B = "branch-b";
const PREFLIGHT_ROUTE_PATHS = buildPhase3BatchBPreflightPaths({
  scenarioId: FIXTURE_SCENARIO_ID,
  debateId: FIXTURE_DEBATE_ID,
  branchA: FIXTURE_BRANCH_A,
  branchB: FIXTURE_BRANCH_B,
});
const FIXTURE_DIRECTOR_ID = "director-1";

const CAPABILITIES_FIXTURE = {
  causal_graph: { enabled: true },
  counterfactual_replay: { enabled: true },
  factions: { enabled: true },
  argument_map: { enabled: true },
  custom_agents: { enabled: true },
  agent_identity: { enabled: true },
  web_search: { enabled: false },
};

const ARGUMENT_MAP_FIXTURE = {
  snapshot_id: "snap-e2e-001",
  nodes: [
    { id: "n1", key: "claim-1", type: "claim", label: "Trade deficits are self-correcting", round: 1, payload: null },
    { id: "n2", key: "evidence-1", type: "evidence", label: "Historical data from 2008-2020 shows mean reversion", round: 1, payload: null },
    { id: "n3", key: "rebuttal-1", type: "rebuttal", label: "Selection bias — only stable economies sampled", round: 2, payload: null },
    {
      id: "n4",
      key: `verdict_${FIXTURE_DEBATE_ID}`,
      type: "verdict",
      label: "order",
      round: null,
      payload: { winner: "proposition", verdict_tone: "order" },
    },
  ],
  edges: [
    { id: "e1", source: "n2", target: "n1", type: "supports", weight: 0.8, label: null },
    { id: "e2", source: "n3", target: "n1", type: "rebuts", weight: 0.7, label: null },
    { id: "e3", source: "n4", target: "n1", type: "accepted", weight: 1, label: null },
    { id: "e4", source: "n4", target: "n2", type: "accepted", weight: 1, label: null },
    { id: "e5", source: "n4", target: "n3", type: "unaddressed", weight: 1, label: null },
  ],
  units: [
    { id: "u1", type: "claim", status: "accepted", text: "Trade deficits are self-correcting", turn_id: "turn-1", node_id: "n1" },
    { id: "u2", type: "evidence", status: "accepted", text: "Historical data from 2008-2020 shows mean reversion", turn_id: "turn-1", node_id: "n2" },
    { id: "u3", type: "rebuttal", status: "unaddressed", text: "Selection bias — only stable economies sampled", turn_id: "turn-2", node_id: "n3" },
  ],
};

const FACTION_TIMELINE_FIXTURE = [
  {
    round: 1,
    factions: [
      { key: "hawks", label: "Trade Hawks", members: ["agent-1", "agent-2"], stance_center: 0.8, confidence: 0.9 },
      { key: "doves", label: "Free Traders", members: ["agent-3", "agent-4"], stance_center: -0.6, confidence: 0.7 },
    ],
    events: [],
  },
  {
    round: 2,
    factions: [
      { key: "hawks", label: "Trade Hawks", members: ["agent-1"], stance_center: 0.9, confidence: 0.85 },
      { key: "doves", label: "Free Traders", members: ["agent-2", "agent-3", "agent-4"], stance_center: -0.5, confidence: 0.75 },
    ],
    events: [{ event_type: "betrayal", actor_agent_id: "agent-2", faction_key: "hawks" }],
  },
];

const COMPARE_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  branch_a: FIXTURE_BRANCH_A,
  branch_b: FIXTURE_BRANCH_B,
  rounds: [
    {
      round: 1,
      branch_a_summary: "Port ledgers calm markets before tariffs escalate.",
      branch_b_summary: "Opaque ledgers fuel rumors and price spikes.",
      divergence_score: 0.4,
    },
    {
      round: 2,
      branch_a_summary: "Analysts cohere around a negotiated settlement.",
      branch_b_summary: "Negotiations fracture and hawks dominate the chamber.",
      divergence_score: 0.8,
    },
  ],
};

const STORY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  question: "What if trade ports published tariff ledgers?",
  status: "done",
  branches: [
    {
      id: FIXTURE_BRANCH_A,
      title: "Ledger Branch",
      probability: 0.58,
      status: "COMPLETED",
      story: "Transparent ledgers stabilize commodity pricing.",
      insight: "Transparency reduces rumor-driven volatility.",
      key_moments: ["Ledger published"],
      parent_branch_id: null,
      fork_reason: "",
    },
    {
      id: FIXTURE_BRANCH_B,
      title: "Opaque Branch",
      probability: 0.42,
      status: "COMPLETED",
      story: "Opaque ledgers amplify mistrust and retaliation.",
      insight: "Opacity compounds coalition fractures.",
      key_moments: ["Ledger hidden"],
      parent_branch_id: null,
      fork_reason: "",
    },
  ],
};

const COMPARE_SCENARIO_AGENTS = [
  { id: "agent-1", name: "Trade Hawk", role: "Negotiator", tier: "CORE", emotion: "focused" },
  { id: "agent-2", name: "Free Trader", role: "Analyst", tier: "IMPORTANT", emotion: "calm" },
];

const COMPARE_SCENARIO_MESSAGES = [
  {
    agent: "Trade Hawk",
    agent_id: "agent-1",
    message: "Ledger publication steadies the port docket.",
    emotion: "focused",
    diverge: null,
    branch: FIXTURE_BRANCH_A,
    branch_title: "Ledger Branch",
    round: 1,
  },
  {
    agent: "Free Trader",
    agent_id: "agent-2",
    message: "Opaque ledgers trigger a rumor spiral.",
    emotion: "anxious",
    diverge: null,
    branch: FIXTURE_BRANCH_B,
    branch_title: "Opaque Branch",
    round: 1,
  },
  {
    agent: "Trade Hawk",
    agent_id: "agent-1",
    message: "Negotiators converge on an auditable settlement.",
    emotion: "confident",
    diverge: null,
    branch: FIXTURE_BRANCH_A,
    branch_title: "Ledger Branch",
    round: 2,
  },
  {
    agent: "Free Trader",
    agent_id: "agent-2",
    message: "Hawks seize the chamber as trust evaporates.",
    emotion: "aggressive",
    diverge: null,
    branch: FIXTURE_BRANCH_B,
    branch_title: "Opaque Branch",
    round: 2,
  },
];

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: "What if trade ports published tariff ledgers?",
  status: "done",
  created_at: "2026-04-10T00:00:00Z",
  scene_theme: "law_court",
  total_rounds: 5,
  mode: "blackboard",
  visualization_enabled: true,
  agents: COMPARE_SCENARIO_AGENTS,
  branches: STORY_FIXTURE.branches,
  messages: COMPARE_SCENARIO_MESSAGES,
  groups: [],
  hierarchical: false,
  director_state: {
    objectives: {
      generated_for_question: null,
      generated_for_profile: null,
      goals: [],
      last_updated_at: null,
    },
    commitment: {
      active: false,
      branch_id: null,
      branch_title: null,
      committed_at_round: null,
      committed_at: null,
      outcome: null,
    },
  },
  gameplay_state: null,
};

const RESULT_AGENTS_FIXTURE = COMPARE_SCENARIO_AGENTS;

const CAMPAIGN_SUMMARY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  profile_id: "law",
  archive_grade: "A",
  profile_resonance: "aligned",
  betting_hit: null,
  most_used_card: null,
  completed_daily_challenge: false,
  objective_completed_count: 0,
  objective_total_count: 0,
  commitment_outcome: null,
  campaign_score_delta: 5,
  finalized_at: "2026-04-10T00:00:00Z",
};

const CAMPAIGN_PROFILE_FIXTURE = {
  user_id: FIXTURE_DIRECTOR_ID,
  user_name: "Local Director",
  total_runs: 3,
  completed_challenges: 1,
  total_bets: 2,
  hit_bets: 1,
  highest_archive_grade: "A",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
};

const CAMPAIGN_MASTERY_FIXTURE = [
  {
    profile_id: "law",
    runs: 3,
    challenge_completions: 1,
    signature_hits: 0,
    aligned_hits: 2,
    campaign_score: 12,
    level: 2,
    best_archive_grade: "A",
    favorite_card_id: null,
    next_level_score: 20,
    score_to_next_level: 8,
  },
];

const DEBATE_SNAPSHOT_FIXTURE = {
  id: FIXTURE_DEBATE_ID,
  status: "done",
  question: "Should trade ports publish tariff ledgers?",
  proposition: { name: "ProBot", role: "proposition" },
  opposition: { name: "ConBot", role: "opposition" },
  judge: { name: "Judge", role: "judge" },
  turns: [
    { phase: "opening", speaker_side: "proposition", content: "Open markets require transparency.", score_delta: 5 },
    { phase: "opening", speaker_side: "opposition", content: "Over-disclosure harms competitive advantage.", score_delta: -3 },
  ],
  score: { proposition: 52, opposition: 48 },
  participants: [],
  phase_insights: [],
  counterplay: null,
};

const DEBATE_RESULT_FIXTURE = {
  id: FIXTURE_DEBATE_ID,
  question: "Should trade ports publish tariff ledgers?",
  motion: "Ports should publish tariff ledgers.",
  language: "en",
  profile_id: "law",
  scene_theme: "civic_chamber",
  status: "done",
  current_phase: "verdict",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
  participants: [
    { side: "proposition", name: "ProBot", role: "proposition" },
    { side: "opposition", name: "ConBot", role: "opposition" },
    { side: "judge", name: "Judge", role: "judge" },
  ],
  score: { proposition: 58, opposition: 42, audience_meter: 16 },
  turns: [
    {
      id: "turn-1",
      phase: "opening",
      speaker_side: "proposition",
      speaker_name: "ProBot",
      content: "Open markets require transparency.",
      quote: "Open markets require transparency.",
      why_it_matters: "Sets the transparency frame.",
    },
    {
      id: "turn-2",
      phase: "opening",
      speaker_side: "opposition",
      speaker_name: "ConBot",
      content: "Over-disclosure harms competitive advantage.",
      quote: "Over-disclosure harms competitive advantage.",
      why_it_matters: "Sets the secrecy frame.",
    },
  ],
  available_prediction_options: {
    winner: ["proposition", "opposition"],
    verdict_tone: ["order", "balance", "rupture"],
  },
  phase_insights: [
    {
      phase: "opening",
      stakes: "Transparency versus secrecy.",
      judge_focus: "Whether ledgers improve accountability.",
      commentary: "Transparency carried the opening.",
      pressure_side: "proposition",
      pressure_margin: 6,
      turn_count: 2,
      confidence_drift: {
        direction: "proposition",
        phase_margin: 6,
        cumulative_margin: 6,
      },
    },
  ],
  result_ready: true,
  result: {
    winner: "proposition",
    verdict_tone: "order",
    score: { proposition: 58, opposition: 42, audience_meter: 16 },
    breakdown: {
      coherence: { proposition: 4, opposition: 3 },
    },
    adjudication_mode: "llm_hybrid",
    best_argument: "Open markets require transparency for efficient price discovery.",
    best_rebuttal: "Over-disclosure harms competitive advantage.",
    judge_summary: "Transparency arguments were better supported.",
    judge_rationale: {
      winner_reason: "The transparency case stayed executable from claim to consequence.",
      loser_gap: "The secrecy case never overcame the accountability challenge.",
      swing_factor: "The opening frame held through verdict.",
      closing_note: "The judge preferred the more auditable policy path.",
      dimension_rationales: {
        coherence: "The proposition maintained the cleaner institutional chain.",
      },
      supporting_turns: [
        {
          id: "turn-1",
          phase: "opening",
          speaker_side: "proposition",
          speaker_name: "ProBot",
          quote: "Open markets require transparency.",
          why_it_matters: "This established the winning executable hinge.",
        },
      ],
    },
    replay: [],
  },
  counterplay: null,
  predictions: [],
};

const ARGUMENT_MAP_FAILSOFT_FIXTURE = {
  snapshot_id: null,
  nodes: [],
  edges: [],
  units: [],
  error: "ARGUMENT_MAP_LOAD_FAILED",
};

// ── Route Interceptor Setup ──────────────────────────────

async function installFixtures(page) {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAPABILITIES_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/story`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STORY_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/agents`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(RESULT_AGENTS_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/predictions`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) => {
    if (route.request().url().includes("/story") || route.request().url().includes("/agents")) {
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SCENARIO_FIXTURE) });
  });
  await page.route(`**/api/campaign/scenario/${FIXTURE_SCENARIO_ID}/summary`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_SUMMARY_FIXTURE) }),
  );
  await page.route(/\/api\/campaign\/profile\/[^/?]+(?:\/mastery|\/badges)?(?:\?.*)?$/, (route) => {
    const url = route.request().url();
    if (url.includes("/mastery")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_MASTERY_FIXTURE) });
    }
    if (url.includes("/badges")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_PROFILE_FIXTURE) });
  });
  await page.route(`**/api/debate/${FIXTURE_DEBATE_ID}/argument-map`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ARGUMENT_MAP_FIXTURE) }),
  );
  await page.route(`**/api/debate/${FIXTURE_DEBATE_ID}`, (route) => {
    if (route.request().url().includes("argument-map")) return route.continue();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DEBATE_SNAPSHOT_FIXTURE) });
  });
  await page.route(`**/api/debate/${FIXTURE_DEBATE_ID}/result`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DEBATE_RESULT_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/faction-timeline*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FACTION_TIMELINE_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/compare*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(COMPARE_FIXTURE) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/checkpoints*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route("**/api/replay-artifact", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "artifact-e2e-phase3b",
        kind: "scenario_result_v1",
        created_at: "2026-04-10T00:00:00Z",
      }),
    }),
  );
}

// ── Test Flows ───────────────────────────────────────────

async function testArgumentMap(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "argument-map");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };
  const isCompactViewport = (page.viewportSize()?.width ?? 0) <= 768;

  // Navigate to debate result and explicitly load the deferred argument map.
  await page.goto(`${baseUrl}/debate/${FIXTURE_DEBATE_ID}/result`, { waitUntil: "domcontentloaded" });
  await saveScreenshot(page, path.join(stepDir, "01-debate-result-loaded.png"));
  const { hasLoadButton, sawResponse } = await triggerArgumentMapLoad(page);
  results.steps.push({ name: "argument-map-load-button-visible", passed: hasLoadButton });
  results.steps.push({ name: "argument-map-load-request-fired", passed: sawResponse });
  if (sawResponse) {
    await page.locator(".react-flow").first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  }

  // Check argument map section exists (ReactFlow container)
  const reactFlowEl = page.locator('.react-flow').first();
  const hasReactFlow = await reactFlowEl.isVisible({ timeout: 5000 }).catch(() => false);
  results.steps.push({ name: "argument-map-reactflow-visible", passed: hasReactFlow });

  const controls = page.locator('.argument-map-container .react-flow__controls').first();
  const controlsCount = await page.locator('.argument-map-container .react-flow__controls').count().catch(() => 0);
  const hasControls = controlsCount > 0
    ? await controls.isVisible().catch(() => false)
    : false;
  results.steps.push({
    name: isCompactViewport ? "argument-map-controls-visible-on-compact-viewport" : "argument-map-controls-visible-on-desktop",
    passed: hasControls,
  });

  if (isCompactViewport) {
    const mobileHint = page.getByText(/Drag to pan\. Pinch or use the graph controls to zoom\.|可拖动画布；双指缩放或使用图谱控件调整视图。/).first();
    const hasMobileHint = await mobileHint.isVisible().catch(() => false);
    results.steps.push({ name: "argument-map-compact-hint-visible", passed: hasMobileHint });
  }

  // Check strength distribution summary
  const meter = page.locator('[role="list"][aria-label="Argument strength distribution"], [role="list"][aria-label="论证强度分布"]').first();
  const hasMeter = await meter.isVisible().catch(() => false);
  results.steps.push({ name: "strength-meter-visible", passed: hasMeter });

  // Check legend
  const legend = page.getByText(/units|单元/).first();
  const hasLegend = await legend.isVisible().catch(() => false);
  results.steps.push({ name: "legend-visible", passed: hasLegend });

  const verdictNode = page.getByRole("button", { name: /Verdict.*order|裁决.*order/i }).first();
  const hasVerdictNode = await verdictNode.isVisible().catch(() => false);
  results.steps.push({ name: "argument-map-verdict-node-visible", passed: hasVerdictNode });

  // Check empty state doesn't appear
  const emptyMsg = page.getByText(/No argument map available|暂无论证图谱/);
  const hasEmpty = await emptyMsg.isVisible().catch(() => false);
  results.steps.push({ name: "no-empty-state", passed: !hasEmpty });

  const exportPanel = page.getByTestId("export-panel").first();
  const hasExportPanel = await exportPanel.isVisible().catch(() => false);
  results.steps.push({ name: "argument-map-export-panel-visible", passed: hasExportPanel });

  const exportSvgButton = page.getByRole("button", { name: /Export SVG|导出 SVG/i }).first();
  const hasExportSvgButton = await exportSvgButton.isVisible().catch(() => false);
  results.steps.push({ name: "argument-map-export-svg-visible", passed: hasExportSvgButton });
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
        expectedPrefix: "argument-map_",
      });
      svgDownloadPassed = true;
      await saveScreenshot(page, path.join(stepDir, "02-argument-map-exported.png"));
    } catch {
      svgDownloadPassed = false;
    }
    results.steps.push({ name: "argument-map-export-svg-download-succeeds", passed: svgDownloadPassed });
  }

  const firstNode = page.getByRole("button", { name: /Trade deficits are self-correcting/i }).first();
  const hasFirstNode = await firstNode.isVisible().catch(() => false);
  results.steps.push({ name: "argument-map-node-visible", passed: hasFirstNode });
  if (hasFirstNode) {
    await firstNode.click();
    const detailPanel = page.getByTestId("node-detail-panel");
    const hasDetailPanel = await detailPanel.isVisible({ timeout: 3000 }).catch(() => false);
    results.steps.push({ name: "argument-map-node-detail-opens", passed: hasDetailPanel });

    const hasUnitText = hasDetailPanel
      ? await detailPanel.textContent().then((text) => text?.includes("Trade deficits are self-correcting") ?? false).catch(() => false)
      : false;
    results.steps.push({ name: "argument-map-node-detail-text-visible", passed: hasUnitText });

    const hasAcceptedStatus = hasDetailPanel
      ? await detailPanel.textContent().then((text) => /Accepted|已采纳/i.test(text ?? "")).catch(() => false)
      : false;
    results.steps.push({ name: "argument-map-node-detail-status-visible", passed: hasAcceptedStatus });

    const closeBtn = hasDetailPanel
      ? detailPanel.getByRole("button", { name: /Close|关闭/i }).first()
      : null;
    const hasCloseBtn = closeBtn ? await closeBtn.isVisible().catch(() => false) : false;
    results.steps.push({ name: "argument-map-node-detail-close-visible", passed: hasCloseBtn });
    if (closeBtn && hasCloseBtn) {
      await closeBtn.click();
      const panelClosed = await detailPanel.isHidden().catch(() => false);
      await saveScreenshot(page, path.join(stepDir, "03-argument-map-detail-closed.png"));
      results.steps.push({ name: "argument-map-node-detail-closes", passed: panelClosed });
    }
  }

  const rejectedFilter = page.getByRole("button", { name: /Rejected|驳回|拒绝/i }).first();
  const hasRejectedFilter = await rejectedFilter.isVisible().catch(() => false);
  results.steps.push({ name: "status-filter-visible", passed: hasRejectedFilter });
  if (hasRejectedFilter) {
    await rejectedFilter.click();
    const filterEmptyState = page.getByText(/No argument units match the selected filters|当前筛选条件下没有匹配的论证单元/i).first();
    const hasFilterEmptyState = await filterEmptyState.isVisible({ timeout: 3000 }).catch(() => false);
    await saveScreenshot(page, path.join(stepDir, "04-argument-map-filter-empty.png"));
    results.steps.push({ name: "status-filter-empty-state-visible", passed: hasFilterEmptyState });

    const clearBtn = page.getByRole("button", { name: /Clear|清除/i }).first();
    const hasClearBtn = await clearBtn.isVisible().catch(() => false);
    results.steps.push({ name: "status-filter-clear-visible", passed: hasClearBtn });
    if (hasClearBtn) {
      await clearBtn.click();
      const mapRestored = await reactFlowEl.isVisible({ timeout: 3000 }).catch(() => false);
      await saveScreenshot(page, path.join(stepDir, "05-argument-map-filter-cleared.png"));
      results.steps.push({ name: "status-filter-clear-restores-map", passed: mapRestored });
    }
  }

  return results;
}

async function testArgumentMapLoadFailed(page, baseUrl, outputDir, aggregateIssues) {
  const stepDir = path.join(outputDir, "argument-map-load-failed");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };
  const failSoftPage = await page.context().newPage();
  const localIssues = attachBrowserIssueMonitor(failSoftPage);

  try {
    await installFixtures(failSoftPage);
    await failSoftPage.unroute(`**/api/debate/${FIXTURE_DEBATE_ID}/argument-map`);
    await failSoftPage.route(`**/api/debate/${FIXTURE_DEBATE_ID}/argument-map`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ARGUMENT_MAP_FAILSOFT_FIXTURE) }),
    );
    const resultResponse = failSoftPage.waitForResponse(
      (response) => response.url().includes(`/api/debate/${FIXTURE_DEBATE_ID}/result`),
      { timeout: 10000 },
    ).then(() => true).catch(() => false);
    await failSoftPage.goto(`${baseUrl}/debate/${FIXTURE_DEBATE_ID}/result`, { waitUntil: "domcontentloaded" });
    await resultResponse;
    const { hasLoadButton, sawResponse: sawFailSoftResponse } = await triggerArgumentMapLoad(failSoftPage);
    results.steps.push({ name: "argument-map-load-failed-button-visible", passed: hasLoadButton });
    results.steps.push({ name: "argument-map-load-failed-request-fired", passed: sawFailSoftResponse });
    const retryButtons = failSoftPage.getByRole("button", { name: /Retry|重试/i });
    const hasRetryButton = sawFailSoftResponse
      ? await hasVisibleMatch(retryButtons)
      : false;
    const hasLoadFailedMessage = sawFailSoftResponse
      ? await failSoftPage.getByText(/Failed to load argument map|Load failed|论证图谱加载失败/i).first().isVisible({ timeout: 5000 }).catch(() => false)
      : false;
    await saveScreenshot(failSoftPage, path.join(stepDir, "01-argument-map-load-failed.png"));
    results.steps.push({ name: "argument-map-load-failed-message-visible", passed: hasLoadFailedMessage });
    results.steps.push({ name: "argument-map-load-failed-retry-visible", passed: hasRetryButton });

    const reactFlowEl = failSoftPage.locator('.react-flow').first();
    const hasReactFlow = await reactFlowEl.isVisible().catch(() => false);
    results.steps.push({ name: "argument-map-load-failed-hides-graph", passed: !hasReactFlow });

    const exportPanel = failSoftPage.getByTestId("export-panel").first();
    const hasExportPanel = await exportPanel.isVisible().catch(() => false);
    results.steps.push({ name: "argument-map-load-failed-hides-export", passed: !hasExportPanel });

    const emptyState = failSoftPage.getByText(/No argument map available|暂无论证图谱/i).first();
    const showsEmptyState = await emptyState.isVisible().catch(() => false);
    results.steps.push({ name: "argument-map-load-failed-not-empty-state", passed: !showsEmptyState });
  } finally {
    mergeBrowserIssues(aggregateIssues, localIssues);
    await failSoftPage.close();
  }

  return results;
}

async function testFactionTimeline(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "faction-timeline");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  await page.goto(`${baseUrl}/result/${FIXTURE_SCENARIO_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, path.join(stepDir, "01-result-loaded.png"));

  const title = page.getByText(/Faction Timeline|阵营时间线/).first();
  results.steps.push({ name: "faction-timeline-title-visible", passed: await title.isVisible().catch(() => false) });

  const roundOne = page.getByText(/Round 1|第 ?1 ?轮/).first();
  results.steps.push({ name: "round-1-visible", passed: await roundOne.isVisible().catch(() => false) });

  const hawksChip = page.getByText("Trade Hawks (2)").first();
  results.steps.push({ name: "trade-hawks-chip-visible", passed: await hawksChip.isVisible().catch(() => false) });

  const betrayalText = page.getByText(/betrayal/i).first();
  results.steps.push({ name: "betrayal-event-visible", passed: await betrayalText.isVisible().catch(() => false) });

  const emptyMsg = page.getByText(/No faction data available|暂无阵营数据/).first();
  results.steps.push({ name: "no-faction-empty-state", passed: !(await emptyMsg.isVisible().catch(() => false)) });

  return results;
}

async function testCompareDigest(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "compare-digest");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to compare view
  const compareUrl = `${baseUrl}/result/${FIXTURE_SCENARIO_ID}/compare?branch_a=${FIXTURE_BRANCH_A}&branch_b=${FIXTURE_BRANCH_B}`;
  await page.goto(compareUrl, { waitUntil: "domcontentloaded" });
  await page.getByText(/Counterfactual|反事实/i).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await saveScreenshot(page, path.join(stepDir, "01-compare-loaded.png"));

  // Check title
  const title = page.getByText(/Counterfactual|反事实/).first();
  const hasTitle = await title.isVisible().catch(() => false);
  results.steps.push({ name: "compare-title-visible", passed: hasTitle });

  const roundOne = page.getByText(/Round 1|第 ?1 ?轮/).first();
  results.steps.push({ name: "compare-round-1-visible", passed: await roundOne.isVisible().catch(() => false) });

  const divergence = page.getByText("40%").first();
  results.steps.push({ name: "divergence-percentage-visible", passed: await divergence.isVisible().catch(() => false) });

  const branchSummary = page.getByText("Port ledgers calm markets before tariffs escalate.").first();
  results.steps.push({ name: "branch-summary-visible", passed: await branchSummary.isVisible().catch(() => false) });

  // Check that it doesn't show feature disabled (since capability is enabled)
  const disabled = page.getByText(/not enabled|未启用/).first();
  const showsDisabled = await disabled.isVisible().catch(() => false);
  results.steps.push({ name: "no-feature-disabled-message", passed: !showsDisabled });

  const compareAutomationReady = await page.waitForFunction(() => {
    try {
      const raw = window.render_game_to_text?.();
      if (!raw) return false;
      const payload = JSON.parse(raw);
      return Number(payload?.scene?.agent_count ?? 0) > 0;
    } catch {
      return false;
    }
  }, { timeout: 5000 }).then(() => true).catch(() => false);
  results.steps.push({ name: "compare-theater-agent-count-positive", passed: compareAutomationReady });

  const compareAutomation = compareAutomationReady
    ? await page.evaluate(() => {
        try {
          const raw = window.render_game_to_text?.();
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })
    : null;
  results.steps.push({
    name: "compare-theater-message-count-positive",
    passed: Number(compareAutomation?.simulation?.messageCount ?? 0) > 0,
  });
  results.steps.push({
    name: "compare-theater-bubble-count-positive",
    passed: Number(compareAutomation?.scene?.displayed_bubble_count ?? 0) > 0,
  });

  return results;
}

// ── Surface Runner ───────────────────────────────────────

async function runSurface(mode, viewport, args) {
  const baseUrl = args.baseUrl;
  const outputDir = path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-phase3b-${mode}-${args.browser}`);
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless, args.browser);
  const context = await browser.newContext({ viewport, acceptDownloads: true, locale: E2E_LOCALE });
  await context.addInitScript(({ storageKey, language }) => {
    window.localStorage.setItem(storageKey, language);
  }, { storageKey: "swarmoracle:language:v1", language: E2E_APP_LANGUAGE });
  const page = await context.newPage();
  const browserIssues = attachBrowserIssueMonitor(page);

  await installFixtures(page);

  const allResults = { mode, viewport, tests: {} };

  try {
    allResults.tests.argumentMap = await runNamedTest(
      "argument-map",
      page,
      outputDir,
      () => testArgumentMap(page, baseUrl, outputDir),
    );
    allResults.tests.argumentMapLoadFailed = await runNamedTest(
      "argument-map-load-failed",
      page,
      outputDir,
      () => testArgumentMapLoadFailed(page, baseUrl, outputDir, browserIssues),
    );
    allResults.tests.factionTimeline = await runNamedTest(
      "faction-timeline",
      page,
      outputDir,
      () => testFactionTimeline(page, baseUrl, outputDir),
    );
    allResults.tests.compareDigest = await runNamedTest(
      "compare-digest",
      page,
      outputDir,
      () => testCompareDigest(page, baseUrl, outputDir),
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
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  allResults.summary = summarizeRun(allResults);

  writeJson(path.join(outputDir, "result.json"), allResults);
  console.log(JSON.stringify(allResults.summary));
  return allResults;
}

export const __test__ = {
  preflightRoutePaths: PREFLIGHT_ROUTE_PATHS,
  runNamedTest,
  summarizeRun,
};

// ── Main ─────────────────────────────────────────────────

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function main() {
  const args = parseArgs(process.argv);
  const { mode } = args;
  const surfaceResults = [];

  await assertFrontendRoutesReady({
    baseUrl: args.baseUrl,
    routePaths: PREFLIGHT_ROUTE_PATHS,
    label: "phase3-batch-b preflight",
  });

  if (mode === "desktop" || mode === "full") {
    const r = await runSurface("desktop", DESKTOP_VIEWPORT, args);
    surfaceResults.push(r);
  }
  if (mode === "mobile" || mode === "full") {
    const r = await runSurface("mobile", MOBILE_VIEWPORT, args);
    surfaceResults.push(r);
  }

  const overallSummary = {
    mode,
    browser: args.browser,
    surfaces: surfaceResults.map((result) => ({
      mode: result.mode,
      allPassed: result.summary.allPassed,
      failedTests: result.summary.failedTests,
      runError: result.summary.runError,
    })),
    allPassed: surfaceResults.length > 0 && surfaceResults.every((result) => result.summary.allPassed),
  };
  console.log(JSON.stringify({ overall: overallSummary }));
  if (!overallSummary.allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
