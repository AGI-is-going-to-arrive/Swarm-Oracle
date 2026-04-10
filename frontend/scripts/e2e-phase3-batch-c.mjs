/**
 * X-3C — Phase 3 Batch C Playwright E2E
 * Resume Panel (P1-9)
 *
 * Uses page.route() fixtures — no running backend required.
 * Run: node scripts/e2e-phase3-batch-c.mjs [desktop|mobile|full]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";

// ── Utilities ────────────────────────────────────────────

function ensureDir(dirPath) { fs.mkdirSync(dirPath, { recursive: true }); }
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
async function saveScreenshot(page, filePath) {
  await page.screenshot({ path: filePath, fullPage: true }).catch(() => {});
}
function createTestResult() {
  return { steps: [], passed: false };
}
function finalizeTestResult(result) {
  result.passed = result.steps.length > 0 && result.steps.every((step) => step.passed);
  return result;
}
function summarizeResults(tests, fatalError = null) {
  let totalSteps = 0;
  let passedSteps = 0;

  for (const test of Object.values(tests)) {
    for (const step of test.steps) {
      totalSteps += 1;
      if (step.passed) {
        passedSteps += 1;
      }
    }
  }

  return {
    totalSteps,
    passedSteps,
    allPassed: !fatalError && totalSteps > 0 && passedSteps === totalSteps,
  };
}

// ── Fixtures ─────────────────────────────────────────────

const FIXTURE_SCENARIO_ID = "sc-e2e-resume";
const FIXTURE_BRANCH_A = "branch-a";
const FIXTURE_BRANCH_B = "branch-b";
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
      story: "Early adoption drives a rapid shift in global energy markets.",
      insight: "Timing of adoption is the primary driver.",
      key_moments: ["Solar breakthrough"],
      parent_branch_id: null,
      fork_reason: "",
    },
    {
      id: FIXTURE_BRANCH_B,
      title: "Fossil Resistance",
      probability: 0.35,
      status: "COMPLETED",
      story: "Lobbying delays adoption for decades.",
      insight: "Incumbent interests resist structural change.",
      key_moments: ["Oil lobby summit"],
      parent_branch_id: null,
      fork_reason: "",
    },
  ],
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: "What if renewable energy was adopted 50 years earlier?",
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

const RESULT_AGENTS_FIXTURE = [
  { id: "agent-1", name: "Climate Scientist", role: "Researcher", tier: "CORE", emotion: "hopeful" },
  { id: "agent-2", name: "Oil Exec", role: "Lobbyist", tier: "IMPORTANT", emotion: "anxious" },
];

const CAMPAIGN_SUMMARY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID, profile_id: "governance",
  archive_grade: "B", profile_resonance: "aligned", betting_hit: null,
  most_used_card: null, completed_daily_challenge: false,
  objective_completed_count: 0, objective_total_count: 0, commitment_outcome: null,
  campaign_score_delta: 3, finalized_at: "2026-04-10T00:00:00Z",
};

const CAMPAIGN_PROFILE_FIXTURE = {
  user_id: FIXTURE_DIRECTOR_ID, user_name: "Local Director",
  total_runs: 1, completed_challenges: 0, total_bets: 0, hit_bets: 0,
  highest_archive_grade: "B", created_at: "2026-04-10T00:00:00Z", updated_at: "2026-04-10T00:00:00Z",
};

// ── Route Interceptor Setup ──────────────────────────────

async function installFixtures(page, overrides = {}) {
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
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/faction-timeline*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/checkpoints*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}`, (route) => {
    if (route.request().url().includes("/story") || route.request().url().includes("/agents")
        || route.request().url().includes("/predictions") || route.request().url().includes("/faction")
        || route.request().url().includes("/checkpoint") || route.request().url().includes("/resume")) {
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SCENARIO_FIXTURE) });
  });
  await page.route(`**/api/campaign/scenario/${FIXTURE_SCENARIO_ID}/summary`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_SUMMARY_FIXTURE) }),
  );
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_PROFILE_FIXTURE) }),
  );
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}/mastery`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}/badges`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );

  // Resume endpoint — default success, overridable for error tests
  const resumeStatus = overrides.resumeStatus ?? 201;
  const resumeBody = overrides.resumeBody ?? { branch_id: "resume-e2e-1", message: "ok" };
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/resume`, async (route) => {
    if (typeof overrides.onResumeRequest === "function") {
      let parsedBody = null;
      try {
        parsedBody = route.request().postDataJSON();
      } catch {
        parsedBody = null;
      }
      await overrides.onResumeRequest(parsedBody, route.request());
    }
    return route.fulfill({ status: resumeStatus, contentType: "application/json", body: JSON.stringify(resumeBody) });
  });
}

// ── Test Flows ───────────────────────────────────────────

async function testResumePanelVisible(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "resume-visible");
  ensureDir(stepDir);
  const results = createTestResult();

  await page.goto(`${baseUrl}/result/${FIXTURE_SCENARIO_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, path.join(stepDir, "01-result-loaded.png"));

  const title = page.getByText(/Resume Simulation|续跑模拟/).first();
  const hasTitle = await title.isVisible({ timeout: 5000 }).catch(() => false);
  results.steps.push({ name: "resume-panel-title-visible", passed: hasTitle });

  const branchSelect = page.locator("#resume-branch");
  const hasSelect = await branchSelect.isVisible().catch(() => false);
  results.steps.push({ name: "branch-select-visible", passed: hasSelect });

  const roundInput = page.locator("#resume-round");
  const hasRound = await roundInput.isVisible().catch(() => false);
  results.steps.push({ name: "round-input-visible", passed: hasRound });

  const submitBtn = page.getByRole("button", { name: /Resume|续跑/ });
  const hasBtn = await submitBtn.isVisible().catch(() => false);
  results.steps.push({ name: "submit-button-visible", passed: hasBtn });

  await saveScreenshot(page, path.join(stepDir, "02-resume-panel.png"));
  return finalizeTestResult(results);
}

async function testResumeSubmitSuccess(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "resume-submit");
  ensureDir(stepDir);
  const results = createTestResult();
  const resumeRequests = [];

  await page.unroute(`**/api/scenario/${FIXTURE_SCENARIO_ID}/resume`).catch(() => {});
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/resume`, async (route) => {
    resumeRequests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ branch_id: "resume-e2e-1", message: "ok" }),
    });
  });

  await page.goto(`${baseUrl}/result/${FIXTURE_SCENARIO_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Select branch
  const select = page.locator("#resume-branch");
  await select.selectOption(FIXTURE_BRANCH_A);
  await saveScreenshot(page, path.join(stepDir, "01-branch-selected.png"));

  // Set round
  const roundInput = page.locator("#resume-round");
  await roundInput.fill("2");

  // Click submit
  const submitBtn = page.getByRole("button", { name: /Resume|续跑/ });
  await submitBtn.click();
  await page.waitForTimeout(300);
  await saveScreenshot(page, path.join(stepDir, "02-submitted.png"));

  // Check success message
  const successMsg = page.getByText(/Resume branch created|续跑分支已创建/);
  const hasSuccess = await successMsg.isVisible({ timeout: 3000 }).catch(() => false);
  results.steps.push({ name: "success-message-visible", passed: hasSuccess });

  const latestResumeRequest = resumeRequests.at(-1);
  const hasExpectedRequestBody = (
    resumeRequests.length === 1
    && latestResumeRequest?.source_branch_id === FIXTURE_BRANCH_A
    && latestResumeRequest?.round_number === 2
  );
  results.steps.push({
    name: "resume-request-body-valid",
    passed: hasExpectedRequestBody,
    details: latestResumeRequest ?? null,
  });

  // Check redirect
  try {
    await page.waitForURL(`**/sim/${FIXTURE_SCENARIO_ID}`, { timeout: 3000 });
    results.steps.push({ name: "redirect-to-sim", passed: true });
  } catch {
    results.steps.push({ name: "redirect-to-sim", passed: false });
  }

  await saveScreenshot(page, path.join(stepDir, "03-redirected.png"));
  return finalizeTestResult(results);
}

async function testResume429Error(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "resume-429");
  ensureDir(stepDir);
  const results = createTestResult();

  // Override resume route to return 429
  await page.unrouteAll();
  await installFixtures(page, {
    resumeStatus: 429,
    resumeBody: { detail: "limit reached" },
  });

  await page.goto(`${baseUrl}/result/${FIXTURE_SCENARIO_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // Select branch and submit
  const select = page.locator("#resume-branch");
  await select.selectOption(FIXTURE_BRANCH_A);

  const submitBtn = page.getByRole("button", { name: /Resume|续跑/ });
  await submitBtn.click();
  await page.waitForTimeout(500);
  await saveScreenshot(page, path.join(stepDir, "01-429-submitted.png"));

  // Check error message
  const errorMsg = page.getByText(/Maximum 3 replay|最多 3 条/).first();
  const hasError = await errorMsg.isVisible({ timeout: 3000 }).catch(() => false);
  results.steps.push({ name: "429-error-message-visible", passed: hasError });

  return finalizeTestResult(results);
}

// ── Surface Runner ───────────────────────────────────────

async function runSurface(mode, viewport) {
  const baseUrl = DEFAULT_BASE_URL;
  const outputDir = path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-phase3c-${mode}`);
  ensureDir(outputDir);

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await installFixtures(page);

  const allResults = { mode, viewport, tests: {}, error: null };

  try {
    allResults.tests.resumeVisible = await testResumePanelVisible(page, baseUrl, outputDir);
    allResults.tests.resumeSubmit = await testResumeSubmitSuccess(page, baseUrl, outputDir);
    allResults.tests.resume429 = await testResume429Error(page, baseUrl, outputDir);
  } catch (err) {
    allResults.error = err instanceof Error ? err.message : String(err);
    allResults.tests.fatal = finalizeTestResult({
      steps: [
        {
          name: "fatal-error",
          passed: false,
          details: allResults.error,
        },
      ],
      passed: false,
    });
    await saveScreenshot(page, path.join(outputDir, "crash.png"));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  allResults.summary = summarizeResults(allResults.tests, allResults.error);

  writeJson(path.join(outputDir, "result.json"), allResults);
  console.log(JSON.stringify(allResults.summary));
  return allResults;
}

// ── Main ─────────────────────────────────────────────────

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function main() {
  const mode = process.argv[2] || "desktop";

  if (mode === "desktop" || mode === "full") {
    const r = await runSurface("desktop", DESKTOP_VIEWPORT);
    if (!r.summary.allPassed) process.exitCode = 1;
  }
  if (mode === "mobile" || mode === "full") {
    const r = await runSurface("mobile", MOBILE_VIEWPORT);
    if (!r.summary.allPassed) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
