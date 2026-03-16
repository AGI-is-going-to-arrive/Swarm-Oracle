import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_MATRIX_PATH = path.join(DEFAULT_OUTPUT_ROOT, "sample_matrix.json");

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
    mode: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    sampleMatrixPath: DEFAULT_MATRIX_PATH,
    outputDir: "",
    themes: [],
    headless: process.env.HEADLESS === "1",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--sample-matrix" && next) {
      args.sampleMatrixPath = path.resolve(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.resolve(next);
      i += 1;
    } else if (arg === "--themes" && next) {
      args.themes = next.split(",").map((theme) => theme.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["matrix", "corners", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-suite.mjs <matrix|corners|full> [--url URL] [--sample-matrix PATH] [--output-dir DIR] [--themes governance,law] [--headless]");
  }

  return args;
}

function summarizeLaunchError(error) {
  if (!(error instanceof Error)) return String(error);
  return error.message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
}

function buildLaunchCandidates(headless) {
  const softwareArgs = ["--use-gl=angle", "--use-angle=swiftshader"];
  const candidates = [
    {
      id: "chrome-channel",
      options: { channel: "chrome", headless },
    },
    {
      id: "chromium-default",
      options: { headless },
    },
    {
      id: "chromium-swiftshader",
      options: { headless, args: softwareArgs },
    },
  ];

  if (headless && process.env.SWARM_E2E_DISABLE_HEADED_FALLBACK !== "1") {
    candidates.push(
      {
        id: "chrome-channel-headed-fallback",
        options: { channel: "chrome", headless: false },
      },
      {
        id: "chromium-headed-fallback",
        options: { headless: false },
      },
      {
        id: "chromium-swiftshader-headed-fallback",
        options: { headless: false, args: softwareArgs },
      },
    );
  }

  return candidates;
}

async function launchBrowser(headless) {
  const attempts = [];
  for (const candidate of buildLaunchCandidates(headless)) {
    try {
      const browser = await chromium.launch(candidate.options);
      return {
        browser,
        launchProfile: {
          id: candidate.id,
          requestedHeadless: headless,
          actualHeadless: candidate.options.headless !== false,
          channel: candidate.options.channel ?? null,
          usedSwiftShader: Boolean(candidate.options.args?.includes("--use-angle=swiftshader")),
          attempts,
        },
      };
    } catch (error) {
      attempts.push({
        id: candidate.id,
        actualHeadless: candidate.options.headless !== false,
        channel: candidate.options.channel ?? null,
        usedSwiftShader: Boolean(candidate.options.args?.includes("--use-angle=swiftshader")),
        error: summarizeLaunchError(error),
      });
    }
  }

  const detail = attempts.map((attempt) => `${attempt.id}: ${attempt.error}`).join("\n");
  throw new Error(`Failed to launch Playwright browser after fallbacks.\n${detail}`);
}

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

async function waitForAutomation(page, predicate, timeout = 30000, label = "automation state") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await readAutomation(page);
    if (payload && predicate(payload)) return payload;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function advanceAutomationTime(page, ms) {
  await page.evaluate(async (deltaMs) => {
    if (typeof window.advanceTime === "function") {
      await window.advanceTime(deltaMs);
    }
  }, ms);
}

async function saveScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, type: "png", scale: "css" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("waiting for fonts to load")) {
      throw error;
    }

    const cdpSession = await page.context().newCDPSession(page);
    const { data } = await cdpSession.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.writeFileSync(filePath, Buffer.from(data, "base64"));
  }
}

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((el, nextValue) => {
    el.value = String(nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function createScenarioViaApi(baseUrl, {
  question,
  rounds = 3,
  numAgents = 3,
  visualizationEnabled = false,
}) {
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      rounds,
      num_agents: numAgents,
      visualization_enabled: visualizationEnabled,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create scenario: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getScenarioViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`);
  if (!response.ok) {
    throw new Error(`Failed to get scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function deleteScenarioViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Failed to delete scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForScenarioStatus(baseUrl, scenarioId, predicate, timeout = 60000, label = "scenario status") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const scenario = await getScenarioViaApi(baseUrl, scenarioId);
    if (predicate(scenario)) return scenario;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label} on scenario ${scenarioId}`);
}

async function runReplayFlow(page, {
  baseUrl,
  scenarioId,
  outputDir,
  replayScreenshotPath,
}) {
  ensureDir(outputDir);
  await page.goto(`${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const replayStart = Date.now();
  let payload = null;
  while (Date.now() - replayStart < 40000) {
    await advanceAutomationTime(page, 500);
    payload = await readAutomation(page);
    if (
      payload?.page?.kind === "simulation"
      && payload.page?.replay_state?.available
      && payload.scene?.scene
      && payload.scene.scene !== "BootScene"
      && payload.scene.scene !== "TitleScene"
    ) {
      break;
    }
    await page.waitForTimeout(250);
  }
  if (
    !payload?.page?.kind
    || !payload.page?.replay_state?.available
    || !payload.scene?.scene
    || payload.scene.scene === "BootScene"
    || payload.scene.scene === "TitleScene"
  ) {
    throw new Error(
      `Timed out waiting for completed replay state for ${scenarioId}; last scene=${payload?.scene?.scene ?? "unknown"}`,
    );
  }
  await advanceAutomationTime(page, 600);
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  const settledPayload = await readAutomation(page) ?? payload;
  writeJson(path.join(outputDir, "state-0.json"), settledPayload);
  await saveScreenshot(page, path.join(outputDir, "shot-0.png"));
  if (replayScreenshotPath) {
    await saveScreenshot(page, replayScreenshotPath);
  }

  return {
    scenarioId,
    replayState: settledPayload.page?.replay_state ?? null,
    scene: settledPayload.scene?.scene ?? null,
    theme: settledPayload.scene?.theme ?? null,
  };
}

async function runResultFlow(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  await page.goto(`${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const initial = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
    40000,
    "result page",
  );
  writeJson(path.join(outputDir, "result-initial.json"), initial);
  await saveScreenshot(page, path.join(outputDir, "result-initial.png"));

  const firstExpandButton = page.locator("button.expand-btn").first();
  if (await firstExpandButton.count()) {
    await firstExpandButton.click();
    await page.waitForTimeout(300);
  }

  await page.getByRole("button", { name: /生成文案|share/i }).click();
  const shareOpen = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "share",
    10000,
    "share modal",
  );
  writeJson(path.join(outputDir, "share-modal-open.json"), shareOpen);
  await saveScreenshot(page, path.join(outputDir, "share-modal-open.png"));

  await page.getByRole("button", { name: /小红书|xiaohongshu/i }).click();
  const generated = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "share" && payload.page?.controls?.modal_state?.loading === false,
    40000,
    "share generation",
  );
  writeJson(path.join(outputDir, "share-generated.json"), generated);
  await saveScreenshot(page, path.join(outputDir, "share-generated.png"));

  const finalPayload = await readAutomation(page);
  writeJson(path.join(outputDir, "result-final.json"), finalPayload);
  await saveScreenshot(page, path.join(outputDir, "result-final.png"));
  return {
    scenarioId,
    branchTitles: finalPayload?.page?.branch_titles ?? [],
    shareContext: generated?.page?.controls?.modal_state?.share_context ?? null,
  };
}

async function runPredictionVariant(page, {
  baseUrl,
  outputDir,
  question,
  betKind,
  targetValue,
  rationale,
  userName,
}) {
  ensureDir(outputDir);
  const scenario = await createScenarioViaApi(baseUrl, {
    question,
    rounds: 3,
    numAgents: 3,
    visualizationEnabled: false,
  });

  await page.goto(`${baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation" && payload.page?.controls?.can_open_prediction,
    30000,
    "prediction CTA",
  );
  await page.getByRole("button", { name: /预测|predict/i }).click();
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "prediction",
    10000,
    "prediction modal",
  );

  await page.locator("#pred-kind").selectOption(betKind);
  if (betKind === "branch_winner") {
    if (targetValue) await page.locator("#pred-branch").selectOption(targetValue);
  } else if (betKind === "ending_tone") {
    await page.locator("#pred-tone").selectOption(targetValue);
  } else {
    await page.locator("#pred-resonance").selectOption(targetValue);
  }
  await page.locator("#pred-text").fill(rationale);
  await page.locator("#pred-name").fill(userName);
  await page.getByRole("button", { name: /提交预测|submit/i }).click();

  const submitted = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.modal_state?.status === "success",
    20000,
    `${betKind} prediction success`,
  );
  writeJson(path.join(outputDir, "result.json"), submitted);
  await saveScreenshot(page, path.join(outputDir, "submitted.png"));

  return {
    scenarioId: scenario.id,
    betKind,
    modalState: submitted?.page?.controls?.modal_state ?? null,
  };
}

async function runPredictionFailureCase(page, {
  baseUrl,
  outputDir,
  question,
}) {
  ensureDir(outputDir);
  const scenario = await createScenarioViaApi(baseUrl, {
    question,
    rounds: 3,
    numAgents: 3,
    visualizationEnabled: false,
  });
  const routePattern = `**/api/scenario/${scenario.id}/predict`;
  await page.route(routePattern, async (route) => {
    await route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "forced prediction failure",
    });
  });

  await page.goto(`${baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.can_open_prediction,
    30000,
    "prediction CTA",
  );
  await page.getByRole("button", { name: /预测|predict/i }).click();
  await page.locator("#pred-text").fill("这次我要验证失败态不会假成功。");
  await page.locator("#pred-name").fill("Predict Fail");
  await page.getByRole("button", { name: /提交预测|submit/i }).click();
  const failed = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "prediction" && payload.page?.controls?.modal_state?.status === "error",
    15000,
    "prediction failure state",
  );
  await page.unroute(routePattern);
  writeJson(path.join(outputDir, "prediction-failure.json"), failed);
  await saveScreenshot(page, path.join(outputDir, "prediction-failure.png"));

  return {
    scenarioId: scenario.id,
    modalState: failed.page?.controls?.modal_state ?? null,
  };
}

async function runReplayCornerCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  await page.goto(`${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(
    page,
    (payload) => payload.page?.replay_state?.available === true,
    30000,
    "replay state",
  );

  await page.getByRole("button", { name: /跳到最新/ }).click();
  const skipped = await waitForAutomation(
    page,
    (payload) => payload.page?.replay_state?.playback_mode === "skip",
    10000,
    "skip mode",
  );

  const branchSelect = page.locator('.theater-panel__filters select').nth(0);
  const branchOptions = await branchSelect.locator('option').count();
  if (branchOptions > 1) {
    const targetBranch = await branchSelect.locator('option').nth(1).getAttribute('value');
    if (targetBranch) await branchSelect.selectOption(targetBranch);
  }

  const roundButtons = page.locator('button[aria-label^=\"Jump to replay round\"]');
  const roundButtonCount = await roundButtons.count();
  if (roundButtonCount > 1) {
    await roundButtons.nth(roundButtonCount - 1).click();
  }

  const replayed = await waitForAutomation(
    page,
    (payload) => payload.page?.replay_state?.playback_mode === "replay",
    10000,
    "replay mode restore",
  );
  writeJson(path.join(outputDir, "replay-corner.json"), {
    skipped: skipped.page?.replay_state ?? null,
    replayed: replayed.page?.replay_state ?? null,
  });
  await saveScreenshot(page, path.join(outputDir, "replay-corner.png"));

  return {
    skipped: skipped.page?.replay_state ?? null,
    replayed: replayed.page?.replay_state ?? null,
  };
}

async function runResultLoadingGateCase(page, {
  baseUrl,
  outputDir,
  question,
}) {
  ensureDir(outputDir);
  const scenarioId = "mock-result-loading-gate";
  let phase = "simulating";
  const scenarioPattern = `**/api/scenario/${scenarioId}`;
  const storyPattern = `**/api/scenario/${scenarioId}/story`;
  const agentsPattern = `**/api/scenario/${scenarioId}/agents`;

  await page.route(scenarioPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: scenarioId,
        question,
        status: phase,
        created_at: new Date().toISOString(),
        total_rounds: 3,
        mode: "blackboard",
        agents: [],
        branches: [],
        groups: [],
        hierarchical: false,
      }),
    });
  });

  await page.route(storyPattern, async (route) => {
    const doneBranch = {
      id: "branch-1",
      title: "法庭接管阈值",
      probability: 1,
      status: phase === "done" ? "COMPLETED" : "ACTIVE",
      story: phase === "done" ? "法院完成了终审复核，故事文本已经齐备。" : "",
      insight: phase === "done" ? "只在 narration 完成后展示结果页。" : "",
      key_moments: phase === "done" ? ["先 loading，再展示完整故事"] : [],
      parent_branch_id: null,
      fork_reason: "",
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scenario_id: scenarioId,
        question,
        status: phase,
        branches: [doneBranch],
      }),
    });
  });

  await page.route(agentsPattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { id: "a1", name: "测试法官", role: "法官", tier: "CORE", emotion: "neutral" },
      ]),
    });
  });

  try {
    await page.goto(`${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);
    phase = "done";

    const loadingState = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === true,
      10000,
      "result loading gate",
    );

    const finalState = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === false && payload.page?.branch_titles?.length > 0,
      10000,
      "narrated result",
    );

    writeJson(path.join(outputDir, "loading-gate.json"), {
      initial: loadingState.page,
      final: finalState.page,
    });
    await saveScreenshot(page, path.join(outputDir, "result-loaded.png"));

    return {
      scenarioId,
      initialLoading: loadingState.page?.loading ?? null,
      finalBranchCount: finalState.page?.branch_titles?.length ?? 0,
    };
  } finally {
    await page.unroute(scenarioPattern);
    await page.unroute(storyPattern);
    await page.unroute(agentsPattern);
  }
}

async function runShareContextCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  const result = await runResultFlow(page, { baseUrl, scenarioId, outputDir });
  const shareContext = result.shareContext;
  return {
    scenarioId,
    profileLabel: shareContext?.profileLabel ?? null,
    hooksCount: shareContext?.profileHooks?.length ?? 0,
    dominantBranchTitle: shareContext?.dominantBranchTitle ?? null,
  };
}

async function runShareRetryCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  let firstAttempt = true;
  const routePattern = `**/api/scenario/${scenarioId}/social/xiaohongshu`;
  await page.route(routePattern, async (route) => {
    if (firstAttempt) {
      firstAttempt = false;
      await route.fulfill({
        status: 500,
        contentType: "text/plain",
        body: "forced share failure",
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
    40000,
    "result page",
  );
  await page.getByRole("button", { name: /生成文案|share/i }).click();
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "share",
    10000,
    "share modal",
  );
  await page.getByRole("button", { name: /小红书|xiaohongshu/i }).click();
  const errored = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.modal_state?.error,
    15000,
    "share failure state",
  );
  await page.getByRole("button", { name: /重试|retry/i }).click();
  const recovered = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.modal_state?.has_copy === true && payload.page?.controls?.modal_state?.loading === false,
    30000,
    "share retry success",
  );
  await page.unroute(routePattern);
  writeJson(path.join(outputDir, "share-retry.json"), {
    errored: errored.page?.controls?.modal_state ?? null,
    recovered: recovered.page?.controls?.modal_state ?? null,
  });
  await saveScreenshot(page, path.join(outputDir, "share-retry.png"));

  return {
    scenarioId,
    firstError: errored.page?.controls?.modal_state?.error ?? null,
    recoveredCopyLength: recovered.page?.controls?.modal_state?.copy_length ?? 0,
  };
}

async function runHistoryLeaderboardCase(page, {
  baseUrl,
  outputDir,
}) {
  ensureDir(outputDir);
  await page.goto(`${baseUrl}/history`, { waitUntil: "domcontentloaded" });
  const history = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "history" && payload.page?.loading === false,
    10000,
    "history page",
  );
  const filterButtons = page.locator(".filter-btn");
  if (await filterButtons.count()) {
    await filterButtons.nth(2).click();
    await page.waitForTimeout(500);
  }
  const filteredHistory = await readAutomation(page);
  await saveScreenshot(page, path.join(outputDir, "history.png"));

  await page.goto(`${baseUrl}/leaderboard`, { waitUntil: "domcontentloaded" });
  const leaderboard = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "leaderboard" && payload.page?.loading === false,
    10000,
    "leaderboard page",
  );
  await saveScreenshot(page, path.join(outputDir, "leaderboard.png"));
  writeJson(path.join(outputDir, "history-leaderboard.json"), {
    history: filteredHistory?.page ?? history.page,
    leaderboard: leaderboard.page,
  });

  return {
    historyFilter: filteredHistory?.page?.filter ?? history.page?.filter ?? null,
    historyCount: filteredHistory?.page?.scenario_count ?? history.page?.scenario_count ?? 0,
    leaderboardCount: leaderboard.page?.entry_count ?? 0,
  };
}

async function runHistoryDeleteLastPageCase(page, {
  baseUrl,
  outputDir,
}) {
  ensureDir(outputDir);
  let disposableScenarios = Array.from({ length: 13 }, (_, index) => ({
    id: `disposable-history-${index + 1}`,
    question: `Disposable history regression ${index + 1}`,
    status: "done",
    created_at: new Date(Date.now() - index * 60_000).toISOString(),
    agent_count: 3,
  }));

  const listRoutePattern = "**/api/scenarios?*";
  const deleteRoutePattern = "**/api/scenario/*";

  await page.route(listRoutePattern, async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit") ?? 12);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const status = url.searchParams.get("status");
    const filtered = status && status !== "all"
      ? disposableScenarios.filter((scenario) => scenario.status === status)
      : disposableScenarios;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: filtered.length,
        limit,
        offset,
        scenarios: filtered.slice(offset, offset + limit),
      }),
    });
  });

  await page.route(deleteRoutePattern, async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    const scenarioId = route.request().url().split("/").pop();
    disposableScenarios = disposableScenarios.filter((scenario) => scenario.id !== scenarioId);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "deleted",
        scenario_id: scenarioId,
      }),
    });
  });

  try {
    await page.goto(`${baseUrl}/history`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "history" && payload.page?.loading === false,
      10000,
      "history page",
    );

    await page.getByRole("button", { name: /已完成|Completed/ }).click();
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "history" && payload.page?.filter === "done" && payload.page?.current_page === 1,
      10000,
      "history done page 1",
    );

    await page.locator(".history-pagination .btn").nth(1).click();
    const lastPage = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "history" && payload.page?.current_page === 2 && payload.page?.scenario_count === 1,
      10000,
      "history last page with one item",
    );

    await page.locator(".history-card__delete").click();
    await page.locator(".history-delete-modal .btn-danger").click();

    const afterDelete = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "history" && payload.page?.current_page === 1 && payload.page?.total === 12,
      10000,
      "history pagination fallback after delete",
    );

    writeJson(path.join(outputDir, "history-delete-last-page.json"), {
      beforeDelete: lastPage.page,
      afterDelete: afterDelete.page,
    });
    await saveScreenshot(page, path.join(outputDir, "history-delete-last-page.png"));

    return {
      beforeDelete: {
        currentPage: lastPage.page?.current_page ?? null,
        scenarioCount: lastPage.page?.scenario_count ?? null,
        total: lastPage.page?.total ?? null,
      },
      afterDelete: {
        currentPage: afterDelete.page?.current_page ?? null,
        scenarioCount: afterDelete.page?.scenario_count ?? null,
        total: afterDelete.page?.total ?? null,
      },
    };
  } finally {
    await page.unroute(listRoutePattern);
    await page.unroute(deleteRoutePattern);
  }
}

async function runMatrixSuite(args) {
  const matrix = JSON.parse(fs.readFileSync(args.sampleMatrixPath, "utf8"));
  const samples = (matrix.samples ?? []).filter((sample) => (
    args.themes.length === 0 || args.themes.includes(sample.theme)
  ));
  const { browser, launchProfile } = await launchBrowser(args.headless);
  writeJson(path.join(args.outputDir, "browser-launch.json"), launchProfile);
  try {
    const summaries = [];
    for (const sample of samples) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const replayDir = path.join(DEFAULT_OUTPUT_ROOT, `${sample.theme}-replay-proof`);
      const replayShot = path.join(DEFAULT_OUTPUT_ROOT, `${sample.theme}-replay-headed.png`);
      const resultDir = path.join(DEFAULT_OUTPUT_ROOT, `${sample.theme}-result-headed`);
      try {
        const replay = await runReplayFlow(page, {
          baseUrl: args.baseUrl,
          scenarioId: sample.scenario_id,
          outputDir: replayDir,
          replayScreenshotPath: replayShot,
        });
        const result = await runResultFlow(page, {
          baseUrl: args.baseUrl,
          scenarioId: sample.scenario_id,
          outputDir: resultDir,
        });
        summaries.push({
          theme: sample.theme,
          scenarioId: sample.scenario_id,
          replay,
          result,
        });
      } finally {
        await page.close();
      }
    }
    return {
      mode: "matrix",
      launchProfile,
      sampleCount: summaries.length,
      themes: summaries.map((entry) => entry.theme),
      samples: summaries,
    };
  } finally {
    await browser.close();
  }
}

async function runCornersSuite(args) {
  const { browser, launchProfile } = await launchBrowser(args.headless);
  writeJson(path.join(args.outputDir, "browser-launch.json"), launchProfile);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    const outputDir = args.outputDir;
    const cases = {};

    cases.branch_prediction = await runPredictionVariant(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "branch-prediction"),
      question: "如果互联网从未被发明？",
      betKind: "branch_winner",
      targetValue: "",
      rationale: "我押这条世界线会成为主线。",
      userName: "Corner Branch",
    });

    cases.ending_tone_prediction = await runPredictionVariant(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "ending-tone-prediction"),
      question: "如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？",
      betKind: "ending_tone",
      targetValue: "balance",
      rationale: "我押这局最后会走向平衡共治。",
      userName: "Corner Tone",
    });

    cases.profile_resonance_prediction = await runPredictionVariant(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "profile-resonance-prediction"),
      question: "如果最高法院拥有算法社会的最终紧急复核权，会发生什么？",
      betKind: "profile_resonance",
      targetValue: "signature",
      rationale: "我押这局会精准命中题材核心。",
      userName: "Corner Resonance",
    });

    cases.prediction_failure_guard = await runPredictionFailureCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "prediction-failure-guard"),
      question: "如果算法裁决系统在高压治理中失手，会发生什么？",
    });

    cases.result_loading_gate = await runResultLoadingGateCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "result-loading-gate"),
      question: "如果最高法院拥有算法社会的最终紧急复核权，会发生什么？",
    });

    cases.replay_skip_switch = await runReplayCornerCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: "72ae364d-3ea1-4959-939c-8fe1dbeca1c9",
      outputDir: path.join(outputDir, "replay-skip-switch"),
    });

    cases.share_context = await runShareContextCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: "1e4eb90d-95d5-4851-8141-c571dc0dd9ab",
      outputDir: path.join(outputDir, "share-context"),
    });

    cases.share_retry = await runShareRetryCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: "1e4eb90d-95d5-4851-8141-c571dc0dd9ab",
      outputDir: path.join(outputDir, "share-retry"),
    });

    cases.history_leaderboard = await runHistoryLeaderboardCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "history-leaderboard"),
    });

    cases.history_delete_last_page = await runHistoryDeleteLastPageCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "history-delete-last-page"),
    });

    return {
      mode: "corners",
      launchProfile,
      cases,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-${args.mode}`);
  ensureDir(outputDir);
  args.outputDir = outputDir;

  let result;
  if (args.mode === "matrix") {
    result = await runMatrixSuite(args);
  } else if (args.mode === "corners") {
    result = await runCornersSuite(args);
  } else {
    const matrixDir = path.join(outputDir, "matrix");
    const cornersDir = path.join(outputDir, "corners");
    ensureDir(matrixDir);
    ensureDir(cornersDir);
    result = {
      mode: "full",
      matrix: await runMatrixSuite({ ...args, outputDir: matrixDir }),
      corners: await runCornersSuite({ ...args, outputDir: cornersDir }),
    };
  }

  writeJson(path.join(outputDir, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`artifacts: ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
