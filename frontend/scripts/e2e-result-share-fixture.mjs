/**
 * Fixture-backed ResultView + ShareModal browser regression.
 *
 * This script verifies a real completed scenario surface instead of a missing
 * `/result/test-id` graceful-error route. It stubs backend JSON endpoints with
 * deterministic fixtures, then checks ResultView rendering, ShareModal social
 * generation, console cleanliness, and mobile horizontal overflow.
 *
 * Run:
 *   node scripts/e2e-result-share-fixture.mjs [desktop|mobile|full] [--url URL] [--browser chromium|firefox|webkit] [--headless]
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
const FIXTURE_SCENARIO_ID = "sc-e2e-result-share";
const FIXTURE_BRANCH_A = "branch-green-transition";
const FIXTURE_BRANCH_B = "branch-fossil-resistance";

const { defaultBrowserType: _unusedDefaultBrowserType, ...MOBILE_CONTEXT_DEFAULTS } = devices["iPhone 13"];

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

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "desktop",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    headless: process.env.HEADLESS === "1",
    outputDir: "",
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
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.isAbsolute(next) ? next : path.join(FRONTEND_ROOT, next);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-result-share-fixture.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--output-dir DIR] [--headless]");
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
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

function buildContextOptions(mode, browserName) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };

  return {
    ...MOBILE_CONTEXT_DEFAULTS,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_CONTEXT_DEFAULTS.userAgent,
    deviceScaleFactor: MOBILE_CONTEXT_DEFAULTS.deviceScaleFactor,
    ...(browserName === "firefox" ? { screen: MOBILE_CONTEXT_DEFAULTS.screen } : {}),
  };
}

function buildSurfaceRuns(args) {
  const run = (mode, browser) => ({
    mode,
    browser,
    context: buildContextOptions(mode, browser),
  });

  if (args.mode === "desktop") return [run("desktop", args.browser)];
  if (args.mode === "mobile") return [run("mobile", args.browser)];
  if (args.browserExplicitlySet) return [run("desktop", args.browser), run("mobile", args.browser)];
  return [run("desktop", "chromium"), run("mobile", "chromium")];
}

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function waitForAutomation(page, predicate, timeout = 15000, label = "automation state") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await readAutomation(page);
    if (payload && predicate(payload)) return payload;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

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
    replay_trace: off,
    graph_analysis: off,
    roundtable_survey: off,
    roundtable_analyst: off,
    snapshot_export: { ...off, enabled: true },
  };
}

const STORY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  question: "What if renewable energy was adopted 50 years earlier?",
  status: "done",
  branches: [
    {
      id: FIXTURE_BRANCH_A,
      title: "Green Transition",
      probability: 0.65,
      status: "COMPLETED",
      story: "Early adoption accelerates storage, grid standards, and civic air-quality policy.",
      insight: "Timing of adoption is the primary driver.",
      key_moments: ["Solar breakthrough", "Grid standard pact"],
      parent_branch_id: null,
      fork_reason: "",
    },
    {
      id: FIXTURE_BRANCH_B,
      title: "Fossil Resistance",
      probability: 0.35,
      status: "COMPLETED",
      story: "Incumbent lobbying slows adoption, but city coalitions keep pressure on the market.",
      insight: "Incumbent interests resist structural change.",
      key_moments: ["Oil lobby summit", "City procurement compact"],
      parent_branch_id: null,
      fork_reason: "",
    },
  ],
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: STORY_FIXTURE.question,
  status: "done",
  created_at: "2026-04-10T00:00:00Z",
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

const AGENTS_FIXTURE = [
  { id: "agent-1", name: "Climate Scientist", role: "Researcher", tier: "CORE", emotion: "hopeful" },
  { id: "agent-2", name: "Grid Operator", role: "Infrastructure Planner", tier: "IMPORTANT", emotion: "focused" },
  { id: "agent-3", name: "Oil Executive", role: "Lobbyist", tier: "CROWD", emotion: "defensive" },
];

const PREDICTIONS_FIXTURE = [
  {
    id: "prediction-1",
    scenario_id: FIXTURE_SCENARIO_ID,
    user_name: "Fixture Analyst",
    prediction_text: "The green transition branch will become dominant.",
    confidence: 0.72,
    score: 84,
    score_reason: "Matched dominant branch.",
    created_at: "2026-04-10T00:10:00Z",
  },
];

const CAMPAIGN_SUMMARY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  profile_id: "governance",
  archive_grade: "B",
  profile_resonance: "aligned",
  betting_hit: true,
  most_used_card: null,
  completed_daily_challenge: false,
  objective_completed_count: 1,
  objective_total_count: 1,
  commitment_outcome: null,
  campaign_score_delta: 4,
  finalized_at: "2026-04-10T00:00:00Z",
};

const CAMPAIGN_PROFILE_FIXTURE = {
  user_id: "fixture-director",
  user_name: "Fixture Director",
  total_runs: 3,
  completed_challenges: 1,
  total_bets: 2,
  hit_bets: 1,
  highest_archive_grade: "B",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
};

async function installFixtures(page, state) {
  const json = (body, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    state.unhandledApiRequests.push({
      method: route.request().method(),
      url: route.request().url(),
    });
    return route.fulfill(json({ detail: "Unhandled fixture API request" }, 404));
  });
  await page.route("**/api/capabilities", (route) => route.fulfill(json(capabilitiesFixture())));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/story`, (route) => route.fulfill(json(STORY_FIXTURE)));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/agents`, (route) => route.fulfill(json(AGENTS_FIXTURE)));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/predictions`, (route) => route.fulfill(json(PREDICTIONS_FIXTURE)));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/score-predictions`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill(json({
      attempted: 0,
      scored: 0,
      failed: 0,
      all_failed: false,
      results: [],
    }));
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/checkpoints*`, (route) => route.fulfill(json([])));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/faction-timeline*`, (route) => route.fulfill(json([])));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/export`, (route) => (
    route.fulfill({
      status: 200,
      contentType: "text/markdown",
      body: "# Fixture result\n\nGreen Transition wins.",
    })
  ));
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/social/xiaohongshu`, (route) => {
    state.socialRequests.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    return route.fulfill(json({
      platform: "xiaohongshu",
      platform_name: "小红书",
      copy: "Fixture share copy: Green Transition wins because storage and grid standards arrived early.",
    }));
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) => {
    const url = route.request().url();
    if (/\/(story|agents|predictions|score-predictions|checkpoints|faction-timeline|export|social)(?:[/?]|$)/u.test(url)) {
      return route.fallback();
    }
    return route.fulfill(json(SCENARIO_FIXTURE));
  });
  await page.route("**/api/replay-artifact", (route) => {
    state.replayArtifactRequests.push(route.request().postDataJSON());
    return route.fulfill(json({
      id: "fixture-replay-artifact",
      kind: "scenario_result_v1",
      created_at: "2026-04-10T00:20:00Z",
    }, 201));
  });
  await page.route(`**/api/campaign/scenario/${FIXTURE_SCENARIO_ID}/summary`, (route) => (
    route.fulfill(json(CAMPAIGN_SUMMARY_FIXTURE))
  ));
  await page.route("**/api/campaign/profile/*/mastery", (route) => route.fulfill(json([])));
  await page.route("**/api/campaign/profile/*/badges", (route) => route.fulfill(json([])));
  await page.route("**/api/campaign/profile/*/weekly-summary*", (route) => route.fulfill(json({})));
  await page.route("**/api/campaign/profile/*", (route) => route.fulfill(json(CAMPAIGN_PROFILE_FIXTURE)));
  await page.route("**/api/quota/summary*", (route) => route.fulfill(json({ conversation: null, replay: null })));
}

async function runResultShareSurface({ mode, browserName, contextOptions, args }) {
  const outputDir = args.outputDir
    ? path.join(args.outputDir, `${mode}-${browserName}`)
    : path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-result-share-${mode}-${browserName}`);
  ensureDir(outputDir);

  const browser = await launchBrowser(browserName, args.headless);
  const context = await browser.newContext({ ...contextOptions, locale: "en-US", reducedMotion: mode === "mobile" ? "reduce" : "no-preference" });
  const page = await context.newPage();
  const state = {
    apiRequests: [],
    socialRequests: [],
    replayArtifactRequests: [],
    unhandledApiRequests: [],
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
  };
  const steps = [];
  let fatalError = null;

  page.on("console", (msg) => {
    if (msg.type() === "error") state.consoleErrors.push(msg.text());
  });
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

  try {
    await installFixtures(page, state);
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, { waitUntil: "domcontentloaded" });

    const initial = await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "result"
        && payload.page?.loading === false
        && payload.page?.route === `/result/${FIXTURE_SCENARIO_ID}`
        && (payload.page?.branches?.length ?? 0) >= 2
      ),
      15000,
      "fixture-backed result page",
    );
    writeJson(path.join(outputDir, "01-result-initial.json"), initial);
    await saveScreenshot(page, path.join(outputDir, "01-result-initial.png"));

    steps.push(createStep(
      "result-fixture-renders-real-branches",
      initial.page?.branch_titles?.includes("Green Transition")
        && initial.page?.branch_titles?.includes("Fossil Resistance"),
      initial.page?.branch_titles ?? null,
    ));
    steps.push(createStep(
      "replay-artifact-not-created-before-explicit-share",
      state.replayArtifactRequests.length === 0,
      [...state.replayArtifactRequests],
    ));

    const shareButton = page.getByRole("button", { name: /生成文案|Generate Copy/i }).first();
    steps.push(createStep("share-button-visible", await shareButton.isVisible().catch(() => false)));
    steps.push(createStep("share-button-enabled", await shareButton.isEnabled().catch(() => false)));
    const replayArtifactResponsePromise = page.waitForResponse((response) => {
      const request = response.request();
      if (request.method() !== "POST") return false;
      if (new URL(request.url()).pathname !== "/api/replay-artifact") return false;
      return request.postDataJSON()?.kind === "scenario_result_v1";
    }, { timeout: 15000 }).catch(() => null);
    await shareButton.click();
    const replayArtifactResponse = await replayArtifactResponsePromise;
    const replayArtifactRequests = [...state.replayArtifactRequests];
    steps.push(createStep(
      "replay-artifact-created-after-explicit-share",
      replayArtifactResponse?.status() === 201
        && replayArtifactRequests.length === 1
        && replayArtifactRequests[0]?.kind === "scenario_result_v1",
      replayArtifactRequests,
    ));

    const open = await waitForAutomation(
      page,
      (payload) => payload.page?.controls?.active_modal === "share",
      10000,
      "share modal open",
    );
    writeJson(path.join(outputDir, "02-share-open.json"), open);
    await saveScreenshot(page, path.join(outputDir, "02-share-open.png"));
    steps.push(createStep(
      "share-modal-receives-fixture-context",
      open.page?.controls?.modal_state?.share_context?.dominantBranchTitle === "Green Transition",
      open.page?.controls?.modal_state?.share_context ?? null,
    ));

    await page.getByRole("button", { name: /小红书|xiaohongshu/i }).click();
    const generated = await waitForAutomation(
      page,
      (payload) => (
        payload.page?.controls?.active_modal === "share"
        && payload.page?.controls?.modal_state?.loading === false
        && payload.page?.controls?.modal_state?.has_copy === true
      ),
      10000,
      "share copy generation",
    );
    writeJson(path.join(outputDir, "03-share-generated.json"), generated);
    await saveScreenshot(page, path.join(outputDir, "03-share-generated.png"));

    const copyText = await page.locator(".share-result-text").textContent().catch(() => "");
    steps.push(createStep(
      "share-social-endpoint-called",
      state.socialRequests.length === 1 && state.socialRequests[0]?.method === "POST",
      state.socialRequests,
    ));
    steps.push(createStep(
      "share-copy-visible",
      /Green Transition wins/u.test(copyText ?? ""),
      copyText,
    ));

    const layout = await page.evaluate(() => {
      const offenders = Array.from(document.body.querySelectorAll("*"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === "string" ? element.className : "",
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
          };
        })
        .filter((rect) => rect.left < -1 || rect.right > window.innerWidth + 1)
        .slice(0, 8);
      return {
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        dialogOpen: Boolean(document.querySelector(".share-modal[role='dialog']")),
        offenders,
      };
    });
    steps.push(createStep("no-horizontal-overflow", !layout.horizontalOverflow, layout));
    steps.push(createStep("share-dialog-open-after-generation", layout.dialogOpen, layout));
    steps.push(createStep("no-unhandled-api-requests", state.unhandledApiRequests.length === 0, state.unhandledApiRequests));
    steps.push(createStep("no-page-errors", state.pageErrors.length === 0, state.pageErrors));
    steps.push(createStep("no-console-errors", state.consoleErrors.length === 0, state.consoleErrors));
    steps.push(createStep("no-request-failures", state.requestFailures.length === 0, state.requestFailures));
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
    steps.push(createStep("fatal-error", false, {
      message: fatalError,
      apiRequests: state.apiRequests,
      socialRequests: state.socialRequests,
      unhandledApiRequests: state.unhandledApiRequests,
      consoleErrors: state.consoleErrors,
      pageErrors: state.pageErrors,
      requestFailures: state.requestFailures,
    }));
    await saveScreenshot(page, path.join(outputDir, "crash.png"));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const result = {
    mode,
    browser: browserName,
    route: `/result/${FIXTURE_SCENARIO_ID}`,
    error: fatalError,
    diagnostics: {
      apiRequests: state.apiRequests,
      socialRequests: state.socialRequests,
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
    const result = await runResultShareSurface({
      mode: surface.mode,
      browserName: surface.browser,
      contextOptions: surface.context,
      args,
    });
    results.push(result);
    if (!result.summary.allPassed) process.exitCode = 1;
  }

  console.log(JSON.stringify({
    overall: {
      mode: args.mode,
      browser: args.browser,
      allPassed: results.length > 0 && results.every((result) => result.summary.allPassed),
      surfaces: results.map((result) => ({
        mode: result.mode,
        browser: result.browser,
        allPassed: result.summary.allPassed,
      })),
    },
  }));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
