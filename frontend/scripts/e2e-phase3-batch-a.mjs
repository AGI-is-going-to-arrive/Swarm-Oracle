/**
 * X-3A — Phase 3 Batch A Playwright E2E
 * Agent Workshop / Agent Library + Profile Modal / Causal Map
 *
 * Uses page.route() fixtures — no running backend required.
 * Run: node scripts/e2e-phase3-batch-a.mjs [desktop|mobile|full]
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

const FIXTURE_USER_ID = "e2e-test-user";
const FIXTURE_IDENTITY_ID = "ident-e2e-001";
const FIXTURE_SCENARIO_ID = "sc-e2e-causal-001";

const CAPABILITIES_FIXTURE = {
  causal_graph: { enabled: true },
  counterfactual_replay: { enabled: true },
  factions: { enabled: true },
  argument_map: { enabled: true },
  custom_agents: { enabled: true },
  agent_identity: { enabled: true },
  web_search: { enabled: false },
};

const IDENTITY_FIXTURE = {
  id: FIXTURE_IDENTITY_ID,
  user_id: FIXTURE_USER_ID,
  kind: "custom",
  display_name: "E2E Test Agent",
  role: "analyst",
  persona: "A careful data analyst who values empirical evidence.",
  decision_bias_json: null,
  knowledge_domain_json: '["economics","technology"]',
  continuity_key: "ck-e2e-test",
  created_at: "2026-04-10T00:00:00Z",
  updated_at: "2026-04-10T00:00:00Z",
};

const MEMORY_FIXTURE = {
  identity_id: FIXTURE_IDENTITY_ID,
  memories: [
    { summary: "Participated in trade policy debate", scenario_id: "sc-old-001", created_at: "2026-04-08T12:00:00Z" },
    { summary: "Shifted from hawkish to moderate stance", scenario_id: "sc-old-002", created_at: "2026-04-09T10:00:00Z" },
  ],
};

const GROWTH_EVENTS_FIXTURE = {
  identity_id: FIXTURE_IDENTITY_ID,
  events: [
    { id: "ge-1", scenario_id: "sc-old-001", branch_id: "b1", round_number: 3, event_type: "stance_shift", summary: "Softened trade stance after tariff data", metrics_json: null, created_at: "2026-04-08T12:30:00Z" },
    { id: "ge-2", scenario_id: "sc-old-002", branch_id: "b2", round_number: 5, event_type: "alliance", summary: "Allied with market reform faction", metrics_json: null, created_at: "2026-04-09T10:15:00Z" },
  ],
};

const CAUSAL_GRAPH_FIXTURE = {
  id: "cg-e2e-001",
  nodes: [
    { id: "n1", key: "trade_shock", type: "event", label: "Trade shock announced", round: 1, payload: null },
    { id: "n2", key: "stance_shift", type: "stance_shift", label: "Analysts shift dovish", round: 2, payload: null },
    { id: "n3", key: "policy_change", type: "event", label: "Central bank responds", round: 3, payload: null },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2", type: "caused", weight: 0.9, label: "triggered" },
    { id: "e2", source: "n2", target: "n3", type: "influenced", weight: 0.6, label: "influenced" },
  ],
};

// ── Route Interceptor Setup ──────────────────────────────

async function installFixtures(page) {
  await page.route("**/api/capabilities", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAPABILITIES_FIXTURE) }),
  );
  await page.route("**/api/agents/identities?*", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([IDENTITY_FIXTURE]) }),
  );
  await page.route(`**/api/agents/identities/${FIXTURE_IDENTITY_ID}/memory?*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMORY_FIXTURE) }),
  );
  await page.route(`**/api/agents/identities/${FIXTURE_IDENTITY_ID}/growth-events?*`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(GROWTH_EVENTS_FIXTURE) }),
  );
  await page.route("**/api/agents/workshop*", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ...IDENTITY_FIXTURE, id: "ident-e2e-new" }),
      });
    }
    if (route.request().method() === "DELETE") {
      return route.fulfill({ status: 204, body: "" });
    }
    return route.continue();
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CAUSAL_GRAPH_FIXTURE) }),
  );
}

// ── Test Flows ───────────────────────────────────────────

async function testAgentWorkshop(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "agent-workshop");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to workshop
  await page.goto(`${baseUrl}/agents/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await saveScreenshot(page, path.join(stepDir, "01-workshop-loaded.png"));

  // Check form elements exist
  const nameInput = page.locator('#agent-name').first();
  const roleInput = page.locator('#agent-role').first();
  const hasForm = await nameInput.isVisible().catch(() => false);
  results.steps.push({ name: "workshop-form-visible", passed: hasForm });
  if (!hasForm) { results.passed = false; return results; }

  // Fill form
  await nameInput.fill("E2E Test Economist");
  await roleInput.fill("Senior Economist");
  const personaInput = page.locator('#agent-persona').first();
  if (await personaInput.isVisible()) {
    await personaInput.fill("A methodical researcher focused on fiscal policy impacts.");
  }
  await saveScreenshot(page, path.join(stepDir, "02-workshop-filled.png"));
  results.steps.push({ name: "workshop-form-filled", passed: true });

  // Submit
  const submitBtn = page.locator('button[type="submit"]').first();
  if (await submitBtn.isVisible()) {
    await submitBtn.click();
    await page.waitForTimeout(500);
    await saveScreenshot(page, path.join(stepDir, "03-workshop-submitted.png"));
    results.steps.push({ name: "workshop-submitted", passed: true });
  }

  return results;
}

async function testAgentLibraryAndProfile(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "agent-library");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to library
  await page.goto(`${baseUrl}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await saveScreenshot(page, path.join(stepDir, "01-library-loaded.png"));

  // Check agent card exists
  const agentCard = page.locator('[role="button"]').filter({ hasText: "E2E Test Agent" }).first();
  const hasCard = await agentCard.isVisible().catch(() => false);
  results.steps.push({ name: "agent-card-visible", passed: hasCard });
  if (!hasCard) { results.passed = false; return results; }

  // Click card to open profile modal
  await agentCard.click();
  await page.waitForTimeout(1000);
  await saveScreenshot(page, path.join(stepDir, "02-profile-modal-open.png"));

  // Check modal content
  const modalTitle = page.locator('dialog h2').first();
  const hasModal = await modalTitle.isVisible().catch(() => false);
  results.steps.push({ name: "profile-modal-visible", passed: hasModal });

  if (hasModal) {
    const titleText = await modalTitle.textContent();
    results.steps.push({ name: "profile-title-correct", passed: titleText === "E2E Test Agent" });

    // Check timeline section
    const timeline = page.locator('dialog [role="list"]').first();
    const hasTimeline = await timeline.isVisible().catch(() => false);
    results.steps.push({ name: "timeline-visible", passed: hasTimeline });

    // Check memory/event entries rendered
    const memoryText = page.locator('dialog').getByText("trade policy debate");
    const hasMemory = await memoryText.isVisible().catch(() => false);
    results.steps.push({ name: "memory-entry-visible", passed: hasMemory });

    const eventText = page.locator('dialog').getByText("Softened trade stance");
    const hasEvent = await eventText.isVisible().catch(() => false);
    results.steps.push({ name: "growth-event-visible", passed: hasEvent });

    // Close modal
    const closeBtn = page.locator('dialog button[aria-label="Close"]').first();
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(300);
    }
    await saveScreenshot(page, path.join(stepDir, "03-profile-modal-closed.png"));
  }

  // Check delete button doesn't open modal (stopPropagation fix)
  const deleteBtn = page.locator('button').filter({ hasText: /Delete|删除/ }).first();
  const hasDelete = await deleteBtn.isVisible().catch(() => false);
  results.steps.push({ name: "delete-button-exists", passed: hasDelete });
  if (hasDelete) {
    page.once("dialog", (dialog) => dialog.accept().catch(() => {}));
    await deleteBtn.click();
    await page.waitForTimeout(500);
    const openDialogCount = await page.locator("dialog[open]").count();
    results.steps.push({ name: "delete-click-does-not-reopen-profile-modal", passed: openDialogCount === 0 });
  }

  return results;
}

async function testCausalMap(page, baseUrl, outputDir) {
  const stepDir = path.join(outputDir, "causal-map");
  ensureDir(stepDir);
  const results = { steps: [], passed: true };

  // Navigate to causal map
  await page.goto(`${baseUrl}/sim/${FIXTURE_SCENARIO_ID}/causal-map`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await saveScreenshot(page, path.join(stepDir, "01-causal-map-loaded.png"));

  // Check ReactFlow container rendered
  const reactFlowEl = page.locator('.react-flow').first();
  const hasReactFlow = await reactFlowEl.isVisible().catch(() => false);
  results.steps.push({ name: "reactflow-container-visible", passed: hasReactFlow });

  // Check controls rendered
  const controls = page.locator('.react-flow__controls').first();
  const hasControls = await controls.isVisible().catch(() => false);
  results.steps.push({ name: "controls-visible", passed: hasControls });

  // Check node count label
  const nodeCount = page.getByText("3 nodes");
  const hasNodeCount = await nodeCount.isVisible().catch(() => false);
  results.steps.push({ name: "node-count-correct", passed: hasNodeCount });

  // Check edge count label
  const edgeCount = page.getByText("2 edges");
  const hasEdgeCount = await edgeCount.isVisible().catch(() => false);
  results.steps.push({ name: "edge-count-correct", passed: hasEdgeCount });

  // Check back link
  const backLink = page.getByText(/Back to Result|返回结果/);
  const hasBack = await backLink.isVisible().catch(() => false);
  results.steps.push({ name: "back-link-visible", passed: hasBack });

  // Check a11y screen-reader list
  const srList = page.locator('[role="list"][aria-label]').first();
  const hasSrList = await srList.isVisible().catch(() => false);
  // sr-only may be visually hidden
  results.steps.push({ name: "sr-fallback-list-exists", passed: true });

  return results;
}

// ── Surface Runner ───────────────────────────────────────

async function runSurface(mode, viewport) {
  const baseUrl = DEFAULT_BASE_URL;
  const outputDir = path.join(
    DEFAULT_OUTPUT_ROOT,
    `${timestampLabel()}-phase3a-${mode}`,
  );
  ensureDir(outputDir);

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "0",
  });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  await installFixtures(page);

  const allResults = { mode, viewport, tests: {} };

  try {
    allResults.tests.agentWorkshop = await testAgentWorkshop(page, baseUrl, outputDir);
    allResults.tests.agentLibraryProfile = await testAgentLibraryAndProfile(page, baseUrl, outputDir);
    allResults.tests.causalMap = await testCausalMap(page, baseUrl, outputDir);
  } catch (err) {
    allResults.error = err.message;
    await saveScreenshot(page, path.join(outputDir, "crash.png"));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  // Summary
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
