/**
 * Sprint 3 Gate 3 component-presence probe.
 *
 * Re-uses fixture endpoints similar to e2e-result-share-fixture.mjs but checks
 * the new Sprint 3 surface in ResultView:
 *   - HOPsAnimation (.hops)
 *   - Snapshot export button ([data-testid="result-snapshot-export-btn"])
 *   - CounterfactualBrand (.cf-brand) (best-effort, depends on counterfactual cap)
 *   - No console errors / no horizontal overflow on desktop + iPhone 13.
 *
 * Run:
 *   node scripts/e2e-gate3-sprint3-probe.mjs --url http://127.0.0.1:18928 --headless
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const SCENARIO_ID = "sc-e2e-result-share";
const BRANCH_A = "branch-green-transition";
const BRANCH_B = "branch-fossil-resistance";

const { defaultBrowserType: _u, ...MOBILE_CONTEXT_DEFAULTS } = devices["iPhone 13"];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, headless: process.env.HEADLESS === "1", outputDir: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (a === "--output-dir" && next) {
      args.outputDir = path.isAbsolute(next) ? next : path.join(FRONTEND_ROOT, next);
      i += 1;
    } else if (a === "--headless") {
      args.headless = true;
    }
  }
  return args;
}

function capabilitiesFixture() {
  const off = { enabled: false, version: "1.0.0", server_only: false, degraded_mode: null };
  const on = { enabled: true, version: "1.0.0", server_only: false, degraded_mode: null };
  return {
    web_search: {
      enabled: false, version: "1.0.0", server_only: true, degraded_mode: null,
      scope: "server", server_enabled: false, method: "none", provider: null,
    },
    custom_agents: off,
    agent_identity: off,
    causal_graph: off,
    counterfactual_replay: on,
    factions: off,
    argument_map: off,
    agent_conversation: off,
    kg_explorer: off,
    replay_trace: off,
    graph_analysis: off,
    roundtable_survey: off,
    roundtable_analyst: off,
    snapshot_export: on,
  };
}

const STORY_FIXTURE = {
  scenario_id: SCENARIO_ID,
  question: "What if renewable energy was adopted 50 years earlier?",
  status: "done",
  branches: [
    {
      id: BRANCH_A, title: "Green Transition", probability: 0.65, status: "COMPLETED",
      story: "Early adoption accelerates storage, grid standards.",
      insight: "Timing of adoption is the primary driver.",
      key_moments: ["Solar breakthrough"], parent_branch_id: null, fork_reason: "",
    },
    {
      id: BRANCH_B, title: "Fossil Resistance", probability: 0.35, status: "COMPLETED",
      story: "Incumbent lobbying slows adoption.",
      insight: "Incumbent interests resist structural change.",
      key_moments: ["Oil lobby summit"], parent_branch_id: null, fork_reason: "",
    },
  ],
};

const SCENARIO_FIXTURE = {
  id: SCENARIO_ID, question: STORY_FIXTURE.question, status: "done",
  created_at: "2026-04-10T00:00:00Z", scene_theme: "civic_chamber", total_rounds: 5,
  mode: "blackboard", visualization_enabled: false, agents: [], branches: [], messages: [],
  groups: [], hierarchical: false,
  director_state: {
    objectives: { generated_for_question: null, generated_for_profile: null, goals: [], last_updated_at: null },
    commitment: { active: false, branch_id: null, branch_title: null, committed_at_round: null, committed_at: null, outcome: null },
  },
  gameplay_state: null,
};

const AGENTS_FIXTURE = [
  { id: "agent-1", name: "Climate Scientist", role: "Researcher", tier: "CORE", emotion: "hopeful" },
  { id: "agent-2", name: "Grid Operator", role: "Infrastructure Planner", tier: "IMPORTANT", emotion: "focused" },
];

const PREDICTIONS_FIXTURE = [
  {
    id: "p1", scenario_id: SCENARIO_ID, user_name: "Fixture Analyst",
    prediction_text: "Green transition wins.", confidence: 0.72, score: 84,
    score_reason: "Matched dominant branch.", created_at: "2026-04-10T00:10:00Z",
  },
];

const CAMPAIGN_SUMMARY = {
  scenario_id: SCENARIO_ID, profile_id: "governance", archive_grade: "B", profile_resonance: "aligned",
  betting_hit: true, most_used_card: null, completed_daily_challenge: false,
  objective_completed_count: 1, objective_total_count: 1, commitment_outcome: null,
  campaign_score_delta: 4, finalized_at: "2026-04-10T00:00:00Z",
};

const CAMPAIGN_PROFILE = {
  user_id: "fixture-director", user_name: "Fixture Director", total_runs: 3,
  completed_challenges: 1, total_bets: 2, hit_bets: 1, highest_archive_grade: "B",
  campaign_score: 0, level: 1, dominant_profile_id: "governance", aligned_resonance_count: 0,
  off_axis_resonance_count: 0, betraying_resonance_count: 0, badges: [],
  weekly_summary: null, daily_challenge_status: null,
  created_at: "2026-04-10T00:00:00Z", updated_at: "2026-04-10T00:00:00Z",
};

async function installFixtures(page, state) {
  const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b) });

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => {
    state.unhandled.push({ method: route.request().method(), url: route.request().url() });
    return route.fulfill(json({ detail: "Unhandled fixture API request" }, 404));
  });
  await page.route("**/api/capabilities", (route) => route.fulfill(json(capabilitiesFixture())));
  await page.route(`**/api/scenario/${SCENARIO_ID}/story`, (route) => route.fulfill(json(STORY_FIXTURE)));
  await page.route(`**/api/scenario/${SCENARIO_ID}/agents`, (route) => route.fulfill(json(AGENTS_FIXTURE)));
  await page.route(`**/api/scenario/${SCENARIO_ID}/predictions`, (route) => route.fulfill(json(PREDICTIONS_FIXTURE)));
  await page.route(`**/api/scenario/${SCENARIO_ID}/checkpoints*`, (route) => route.fulfill(json([])));
  await page.route(`**/api/scenario/${SCENARIO_ID}/faction-timeline*`, (route) => route.fulfill(json([])));
  await page.route(`**/api/scenario/${SCENARIO_ID}/export`, (route) =>
    route.fulfill({ status: 200, contentType: "text/markdown", body: "# Fixture\n" }));
  await page.route(`**/api/scenario/${SCENARIO_ID}`, (route) => {
    const url = route.request().url();
    if (/\/(story|agents|predictions|checkpoints|faction-timeline|export|social)(?:[/?]|$)/u.test(url)) {
      return route.fallback();
    }
    return route.fulfill(json(SCENARIO_FIXTURE));
  });
  await page.route("**/api/replay-artifact", (route) =>
    route.fulfill(json({ id: "fx-art", kind: "scenario_result_v1", created_at: "2026-04-10T00:20:00Z" }, 201)));
  await page.route(`**/api/campaign/scenario/${SCENARIO_ID}/summary`, (route) =>
    route.fulfill(json(CAMPAIGN_SUMMARY)));
  await page.route("**/api/campaign/profile/*/mastery", (route) => route.fulfill(json([])));
  await page.route("**/api/campaign/profile/*/badges", (route) => route.fulfill(json([])));
  await page.route("**/api/campaign/profile/*/weekly-summary*", (route) => route.fulfill(json({})));
  await page.route("**/api/campaign/profile/*", (route) => route.fulfill(json(CAMPAIGN_PROFILE)));
  await page.route("**/api/quota/summary*", (route) => route.fulfill(json({ conversation: null, replay: null })));
}

async function probeSurface({ mode, args, outputRoot }) {
  const dir = path.join(outputRoot, `${mode}-chromium`);
  ensureDir(dir);

  const browser = await chromium.launch({ headless: args.headless });
  const ctx = await browser.newContext(
    mode === "mobile"
      ? { ...MOBILE_CONTEXT_DEFAULTS, isMobile: true, hasTouch: true, locale: "en-US", reducedMotion: "reduce" }
      : { viewport: DESKTOP_VIEWPORT, locale: "en-US" },
  );
  const page = await ctx.newPage();

  const state = { unhandled: [], consoleErrors: [], pageErrors: [], requestFailures: [] };
  page.on("console", (m) => { if (m.type() === "error") state.consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => state.pageErrors.push(e.message));
  page.on("requestfailed", (r) => state.requestFailures.push({ url: r.url(), error: r.failure()?.errorText ?? null }));

  await installFixtures(page, state);

  const steps = [];
  const step = (name, passed, details = null) => steps.push({ name, passed: !!passed, details });

  let fatal = null;
  try {
    await page.goto(`${args.baseUrl}/result/${SCENARIO_ID}`, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector("text=Green Transition", { timeout: 15000 });

    const branches = await page.$$eval(".ending-card", (n) => n.length).catch(() => 0);
    step("result-branch-cards-rendered", branches >= 1, { count: branches });

    // HOPsAnimation presence
    const hopsCount = await page.$$eval(".hops", (n) => n.length).catch(() => 0);
    const hopsList = await page.$$eval(".hops__row", (n) => n.length).catch(() => 0);
    step("hops-animation-section-visible", hopsCount >= 1, { rootCount: hopsCount, rowCount: hopsList });

    // Snapshot export button
    const snapBtn = await page.$('[data-testid="result-snapshot-export-btn"]');
    step("snapshot-export-button-present", !!snapBtn, snapBtn ? { found: true } : { found: false });

    // CounterfactualBrand (best-effort, depends on counterfactual cap + branches with fork data)
    const cfBrand = await page.$('.cf-brand');
    step("counterfactual-brand-best-effort", true, { found: !!cfBrand });

    // Take screenshots
    await page.screenshot({ path: path.join(dir, "01-result-page.png"), fullPage: true });

    // Click snapshot export to verify wizard opens
    if (snapBtn) {
      await snapBtn.click();
      await page.waitForTimeout(500);
      const overlay = await page.$('[data-testid="snapshot-export-overlay"]');
      step("snapshot-export-overlay-opens", !!overlay);
      if (overlay) {
        await page.screenshot({ path: path.join(dir, "02-snapshot-export-overlay.png"), fullPage: true });
        // Close overlay
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(300);
      }
    } else {
      step("snapshot-export-overlay-opens", false, { reason: "button not found" });
    }

    // Horizontal overflow
    const overflow = await page.evaluate(() => {
      const root = document.documentElement;
      return {
        scrollWidth: root.scrollWidth,
        innerWidth: window.innerWidth,
        horizontalOverflow: root.scrollWidth > window.innerWidth + 1,
      };
    });
    step("no-horizontal-overflow", !overflow.horizontalOverflow, overflow);

    step("no-console-errors", state.consoleErrors.length === 0, state.consoleErrors);
    step("no-page-errors", state.pageErrors.length === 0, state.pageErrors);
    step("no-unhandled-api-requests", state.unhandled.length === 0, state.unhandled);
    step("no-request-failures", state.requestFailures.length === 0, state.requestFailures);
  } catch (err) {
    fatal = err.message ?? String(err);
  } finally {
    await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  const passed = steps.filter((s) => s.passed).length;
  const result = {
    mode, fatal, total: steps.length, passed,
    allPassed: !fatal && passed === steps.length && steps.length > 0,
    steps, diagnostics: state,
  };
  fs.writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const outputRoot = args.outputDir || path.join(FRONTEND_ROOT, "output", "e2e", "gate3-sprint3-probe");
  ensureDir(outputRoot);

  const results = [];
  for (const mode of ["desktop", "mobile"]) {
    const r = await probeSurface({ mode, args, outputRoot });
    console.log(JSON.stringify({ mode, allPassed: r.allPassed, passed: r.passed, total: r.total, fatal: r.fatal }));
    results.push(r);
  }
  const overall = {
    allPassed: results.every((r) => r.allPassed),
    surfaces: results.map((r) => ({ mode: r.mode, allPassed: r.allPassed, passed: r.passed, total: r.total })),
  };
  fs.writeFileSync(path.join(outputRoot, "overall.json"), `${JSON.stringify(overall, null, 2)}\n`);
  console.log(JSON.stringify({ overall }));
  if (!overall.allPassed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
