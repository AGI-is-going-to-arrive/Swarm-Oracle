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

// ── Fixtures ─────────────────────────────────────────────

const FIXTURE_SCENARIO_ID = "sc-e2e-batch-b";
const FIXTURE_DEBATE_ID = "debate-e2e-batch-b";
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

const ARGUMENT_MAP_FIXTURE = {
  snapshot_id: "snap-e2e-001",
  nodes: [
    { id: "n1", key: "claim-1", type: "claim", label: "Trade deficits are self-correcting", round: 1, payload: null },
    { id: "n2", key: "evidence-1", type: "evidence", label: "Historical data from 2008-2020 shows mean reversion", round: 1, payload: null },
    { id: "n3", key: "rebuttal-1", type: "rebuttal", label: "Selection bias — only stable economies sampled", round: 2, payload: null },
  ],
  edges: [
    { id: "e1", source: "n2", target: "n1", type: "supports", weight: 0.8, label: "supports" },
    { id: "e2", source: "n3", target: "n1", type: "attacks", weight: 0.7, label: "attacks" },
  ],
  units: [
    { id: "u1", type: "claim", status: "standing", text: "Trade deficits are self-correcting", turn_id: "t1", node_id: "n1" },
    { id: "u2", type: "evidence", status: "accepted", text: "Historical data from 2008-2020 shows mean reversion", turn_id: "t1", node_id: "n2" },
    { id: "u3", type: "rebuttal", status: "rebutted", text: "Selection bias — only stable economies sampled", turn_id: "t2", node_id: "n3" },
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

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: "What if trade ports published tariff ledgers?",
  status: "done",
  created_at: "2026-04-10T00:00:00Z",
  scene_theme: "law_court",
  total_rounds: 5,
  mode: "blackboard",
  visualization_enabled: false,
  agents: [],
  branches: [],
  messages: [],
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

const RESULT_AGENTS_FIXTURE = [
  { id: "agent-1", name: "Trade Hawk", role: "Negotiator", tier: "CORE", emotion: "focused" },
  { id: "agent-2", name: "Free Trader", role: "Analyst", tier: "IMPORTANT", emotion: "calm" },
];

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
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_PROFILE_FIXTURE) }),
  );
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}/mastery`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAMPAIGN_MASTERY_FIXTURE) }),
  );
  await page.route(`**/api/campaign/profile/${FIXTURE_DIRECTOR_ID}/badges`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([]) }),
  );
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
}

// ── Test Flows ───────────────────────────────────────────

async function testArgumentMap(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "argument-map");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to debate result with argument map
  await page.goto(`${baseUrl}/debate/${FIXTURE_DEBATE_ID}/result`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await saveScreenshot(page, path.join(stepDir, "01-debate-result-loaded.png"));

  // Check argument map section exists (ReactFlow container)
  const reactFlowEl = page.locator('.react-flow').first();
  const hasReactFlow = await reactFlowEl.isVisible({ timeout: 5000 }).catch(() => false);
  results.steps.push({ name: "argument-map-reactflow-visible", passed: hasReactFlow });

  // Check strength meter
  const meter = page.locator('[role="meter"]').first();
  const hasMeter = await meter.isVisible().catch(() => false);
  results.steps.push({ name: "strength-meter-visible", passed: hasMeter });

  // Check legend
  const legend = page.getByText(/units|单元/).first();
  const hasLegend = await legend.isVisible().catch(() => false);
  results.steps.push({ name: "legend-visible", passed: hasLegend });

  // Check empty state doesn't appear
  const emptyMsg = page.getByText(/No argument map available|暂无论证图谱/);
  const hasEmpty = await emptyMsg.isVisible().catch(() => false);
  results.steps.push({ name: "no-empty-state", passed: !hasEmpty });

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

  const roundOne = page.getByText("Round 1").first();
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
  await page.waitForTimeout(1500);
  await saveScreenshot(page, path.join(stepDir, "01-compare-loaded.png"));

  // Check title
  const title = page.getByText(/Counterfactual|反事实/).first();
  const hasTitle = await title.isVisible().catch(() => false);
  results.steps.push({ name: "compare-title-visible", passed: hasTitle });

  const roundOne = page.getByText("Round 1").first();
  results.steps.push({ name: "compare-round-1-visible", passed: await roundOne.isVisible().catch(() => false) });

  const divergence = page.getByText("40%").first();
  results.steps.push({ name: "divergence-percentage-visible", passed: await divergence.isVisible().catch(() => false) });

  const branchSummary = page.getByText("Port ledgers calm markets before tariffs escalate.").first();
  results.steps.push({ name: "branch-summary-visible", passed: await branchSummary.isVisible().catch(() => false) });

  // Check that it doesn't show feature disabled (since capability is enabled)
  const disabled = page.getByText(/not enabled|未启用/).first();
  const showsDisabled = await disabled.isVisible().catch(() => false);
  results.steps.push({ name: "no-feature-disabled-message", passed: !showsDisabled });

  return results;
}

// ── Surface Runner ───────────────────────────────────────

async function runSurface(mode, viewport) {
  const baseUrl = DEFAULT_BASE_URL;
  const outputDir = path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-phase3b-${mode}`);
  ensureDir(outputDir);

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await installFixtures(page);

  const allResults = { mode, viewport, tests: {} };

  try {
    allResults.tests.argumentMap = await testArgumentMap(page, baseUrl, outputDir);
    allResults.tests.factionTimeline = await testFactionTimeline(page, baseUrl, outputDir);
    allResults.tests.compareDigest = await testCompareDigest(page, baseUrl, outputDir);
  } catch (err) {
    allResults.error = err.message;
    await saveScreenshot(page, path.join(outputDir, "crash.png"));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  let totalSteps = 0;
  let passedSteps = 0;
  for (const test of Object.values(allResults.tests)) {
    for (const step of test.steps) {
      totalSteps++;
      if (step.passed) passedSteps++;
    }
  }
  allResults.summary = { totalSteps, passedSteps, allPassed: passedSteps === totalSteps };

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
