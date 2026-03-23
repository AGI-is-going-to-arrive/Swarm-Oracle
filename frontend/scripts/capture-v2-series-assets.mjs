import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

import {chromium} from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const VIDEO_ROOT = path.join(REPO_ROOT, "video");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const LANGUAGE_STORAGE_KEY = "swarmoracle:language:v1";
const DEFAULT_VIEWPORT = {width: 1600, height: 900};

const SERIES_CONFIG = {
  "blackboard-walkthrough": {
    clipKeys: ["hook", "board", "detail", "agent", "result"],
    screenshotKeys: ["hook", "board", "detail", "agent", "result", "story", "insight"],
    gifKeys: ["board", "detail"],
    minBranchCount: 3,
    attemptLimit: 3,
    sceneStrategy: "blackboard",
    languages: {
      zh: {
        versionName: "swarmoracle-blackboard-walkthrough-v1.zh",
        locale: "zh",
        question: "如果一档恋综允许观众实时改写约会规则，最后会变成真 CP 工厂，还是大型修罗场？",
        rounds: 5,
        numAgents: 5,
        visualizationEnabled: false,
        resultRounds: 3,
        resultNumAgents: 4,
      },
      en: {
        versionName: "swarmoracle-blackboard-walkthrough-v1.en",
        locale: "en",
        question: "What if a reality dating show let viewers rewrite the rules in real time?",
        rounds: 5,
        numAgents: 5,
        visualizationEnabled: false,
        resultRounds: 3,
        resultNumAgents: 4,
      },
    },
  },
  "gameplay-explainer": {
    clipKeys: ["hook", "board", "cards", "effect", "bet", "result", "share"],
    screenshotKeys: ["hook", "board", "cards", "effect", "bet", "result", "archive", "sharePrimary", "shareSecondary"],
    gifKeys: ["effect", "share"],
    minBranchCount: 3,
    attemptLimit: 3,
    resultTimeoutMs: 720000,
    sceneStrategy: "gameplay",
    languages: {
      zh: {
        versionName: "swarmoracle-gameplay-explainer-v1.zh",
        locale: "zh",
        question: "如果一档选秀节目让 AI 制作人、粉丝团和评委同时影响赛制，谁会一路晋级到最后？",
        rounds: 6,
        numAgents: 5,
        visualizationEnabled: true,
        sharePlatforms: ["小红书", "知乎"],
        predictionText: "我押这条世界线会把节目做成有互动但不失控的高留存综艺。",
      },
      en: {
        versionName: "swarmoracle-gameplay-explainer-v1.en",
        locale: "en",
        question: "What if every contestant in a talent competition had an AI strategy team behind them?",
        rounds: 6,
        numAgents: 5,
        visualizationEnabled: true,
        sharePlatforms: ["X", "Reddit"],
        predictionText: "I am betting this worldline turns the show into a replayable format instead of a chaos spiral.",
      },
    },
  },
  "longform-showcase": {
    clipKeys: ["hook", "board", "detail", "theater", "cards", "bet", "result", "share", "debate"],
    screenshotKeys: ["hook", "board", "detail", "theater", "cards", "bet", "result", "archive", "sharePrimary", "shareSecondary", "debateLive", "debateResult"],
    gifKeys: ["theater", "debate"],
    minBranchCount: 3,
    attemptLimit: 3,
    resultTimeoutMs: 720000,
    sceneStrategy: "longform",
    languages: {
      zh: {
        versionName: "swarmoracle-longform-showcase-v1.zh",
        locale: "zh",
        question: "如果一个大型主题乐园每天都让游客投票改写主线剧情，它会变成最沉浸的娱乐宇宙，还是最混乱的灾难现场？",
        rounds: 6,
        numAgents: 5,
        visualizationEnabled: true,
        sharePlatforms: ["小红书", "知乎"],
        predictionText: "我押这条世界线会把游客投票做成高沉浸但仍可控的主线玩法。",
        reusePromoDebateFrom: "swarmoracle-promo-v1.zh",
      },
      en: {
        versionName: "swarmoracle-longform-showcase-v1.en",
        locale: "en",
        question: "What if a theme park let guests steer the main story world every day?",
        rounds: 6,
        numAgents: 5,
        visualizationEnabled: true,
        sharePlatforms: ["X", "Reddit"],
        predictionText: "I am betting this worldline turns guest voting into a controllable story engine instead of a broken ride.",
        reusePromoDebateFrom: "swarmoracle-promo-v1.en",
      },
    },
  },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, {recursive: true});
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const seriesKey = argv[2] || "";
  const language = argv[3] || "";
  const args = {
    seriesKey,
    language,
    baseUrl: DEFAULT_BASE_URL,
    headless: true,
  };

  for (let index = 4; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (arg === "--headed") {
      args.headless = false;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!SERIES_CONFIG[seriesKey] || !SERIES_CONFIG[seriesKey].languages[language]) {
    throw new Error(
      "Usage: node scripts/capture-v2-series-assets.mjs <blackboard-walkthrough|gameplay-explainer|longform-showcase> <zh|en> [--url URL] [--headed]",
    );
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

function normalizeButtonLabel(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function clickSharePlatform(page, platform) {
  const buttons = page.locator(".share-platform-btn");
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const label = normalizeButtonLabel(await button.innerText());
    if (platform === "X") {
      if (/\bX\b/i.test(label)) {
        await button.click();
        return label;
      }
      continue;
    }
    if (label.toLowerCase().includes(platform.toLowerCase())) {
      await button.click();
      return label;
    }
  }
  throw new Error(`Unable to find share platform button for ${platform}`);
}

function buildLaunchCandidates(headless) {
  const softwareArgs = ["--use-gl=angle", "--use-angle=swiftshader"];
  const candidates = [
    {
      id: "chrome-channel",
      options: {channel: "chrome", headless},
    },
    {
      id: "chromium-default",
      options: {headless},
    },
    {
      id: "chromium-swiftshader",
      options: {headless, args: softwareArgs},
    },
  ];

  if (headless) {
    candidates.push(
      {
        id: "chrome-channel-headed-fallback",
        options: {channel: "chrome", headless: false},
      },
      {
        id: "chromium-headed-fallback",
        options: {headless: false},
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
        error: summarizeLaunchError(error),
      });
    }
  }

  throw new Error(`Failed to launch browser: ${attempts.map((item) => `${item.id}: ${item.error}`).join(" | ")}`);
}

async function withPage(browser, locale, runner) {
  const context = await browser.newContext({viewport: DEFAULT_VIEWPORT});
  await context.addInitScript(
    ({languageStorageKey, language}) => {
      window.localStorage.setItem(languageStorageKey, language);
    },
    {languageStorageKey: LANGUAGE_STORAGE_KEY, language: locale},
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  try {
    return await runner(page);
  } finally {
    await context.close();
  }
}

async function withRecordedPage(browser, locale, tempVideoDir, runner) {
  const context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    recordVideo: {
      dir: tempVideoDir,
      size: DEFAULT_VIEWPORT,
    },
  });
  await context.addInitScript(
    ({languageStorageKey, language}) => {
      window.localStorage.setItem(languageStorageKey, language);
    },
    {languageStorageKey: LANGUAGE_STORAGE_KEY, language: locale},
  );
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(60000);
  const video = page.video();
  try {
    const result = await runner(page);
    return {context, page, result, video};
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function finalizeRecordedPage(recording, destinationPath) {
  ensureDir(path.dirname(destinationPath));
  await recording.context.close();
  if (!recording.video) {
    throw new Error(`Missing Playwright video handle for ${destinationPath}`);
  }
  await recording.video.saveAs(destinationPath);
}

function runFfmpeg(args) {
  const result = spawnSync("ffmpeg", ["-y", ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${args.join(" ")}`);
  }
}

function createGifFromClip(inputPath, outputPath, startSeconds = 0.8) {
  ensureDir(path.dirname(outputPath));
  runFfmpeg([
    "-ss",
    `${startSeconds}`,
    "-t",
    "3.6",
    "-i",
    inputPath,
    "-vf",
    "fps=12,scale=960:-1:flags=lanczos",
    "-loop",
    "0",
    outputPath,
  ]);
}

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function waitForAutomation(page, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  let lastPayload = null;
  while (Date.now() - startedAt < timeoutMs) {
    const payload = await readAutomation(page);
    lastPayload = payload;
    if (payload && predicate(payload)) {
      return payload;
    }
    await page.waitForTimeout(250);
  }
  const lastSummary = lastPayload
    ? JSON.stringify({
        page: lastPayload.page?.kind ?? null,
        route: lastPayload.page?.route ?? null,
        viewMode: lastPayload.simulation?.viewMode ?? null,
        canToggle: lastPayload.page?.controls?.can_toggle_view_mode ?? null,
        activeModal: lastPayload.page?.controls?.active_modal ?? null,
      })
    : "null";
  throw new Error(`Timed out waiting for ${label}; last automation=${lastSummary}`);
}

async function saveScreenshot(page, filePath) {
  ensureDir(path.dirname(filePath));
  await page.screenshot({
    path: filePath,
    type: "png",
    scale: "css",
  });
}

async function saveElementScreenshot(page, selector, filePath) {
  ensureDir(path.dirname(filePath));
  await page.locator(selector).first().screenshot({
    path: filePath,
    type: "png",
  });
}

async function captureModalScreenshot(page, filePath) {
  const shot = await page.evaluate(async () => {
    if (typeof window.capture_game_screenshot !== "function") return null;
    return window.capture_game_screenshot("modal");
  });
  if (shot && typeof shot === "string" && shot.startsWith("data:")) {
    const [, base64 = ""] = shot.split(",", 2);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return true;
  }
  return false;
}

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event("input", {bubbles: true}));
    element.dispatchEvent(new Event("change", {bubbles: true}));
  }, value);
}

async function createScenarioViaApi(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to create scenario: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getScenarioViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function deleteScenarioViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw new Error(`Failed to delete scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
}

async function waitForScenario(baseUrl, scenarioId, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const scenario = await getScenarioViaApi(baseUrl, scenarioId);
    if (scenario.status === "error") {
      throw new Error(`Scenario ${scenarioId} entered error state while waiting for ${label}`);
    }
    if (predicate(scenario)) return scenario;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label} on scenario ${scenarioId}`);
}

async function waitForScenarioDone(baseUrl, scenarioId, timeoutMs) {
  return waitForScenario(baseUrl, scenarioId, (scenario) => scenario.status === "done", timeoutMs, "completed scenario");
}

function countNonPlaceholderBranches(scenario) {
  return (scenario.branches ?? []).filter((branch) => branch.title && branch.title !== "初始世界线" && branch.title !== "Initial Branch").length;
}

async function createScenarioWithRetries(baseUrl, config, spec) {
  const attempts = [];
  for (let attempt = 1; attempt <= spec.attemptLimit; attempt += 1) {
    const scenario = await createScenarioViaApi(baseUrl, {
      question: config.question,
      rounds: config.rounds,
      num_agents: config.numAgents,
      mode: "blackboard",
      visualization_enabled: Boolean(config.visualizationEnabled),
      reasoning_effort: "low",
      user_id: `${config.versionName}.branch.${attempt}`,
    });

    try {
      const branchReady = await waitForScenario(
        baseUrl,
        scenario.id,
        (state) => countNonPlaceholderBranches(state) >= spec.minBranchCount,
        240000,
        `branch_count>=${spec.minBranchCount}`,
      );
      attempts.push({
        attempt,
        scenarioId: scenario.id,
        accepted: true,
        branchCount: countNonPlaceholderBranches(branchReady),
        status: branchReady.status,
      });
      return {scenarioId: scenario.id, branchReady, attempts};
    } catch (error) {
      const fallbackState = await getScenarioViaApi(baseUrl, scenario.id).catch(() => null);
      attempts.push({
        attempt,
        scenarioId: scenario.id,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
        branchCount: fallbackState ? countNonPlaceholderBranches(fallbackState) : 0,
        status: fallbackState?.status ?? "unknown",
      });
    }
  }

  throw new Error(`Failed to get ${spec.minBranchCount}+ branches after ${spec.attemptLimit} attempts`);
}

async function createCompletedScenario(baseUrl, payload, timeoutMs = 360000, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const scenario = await createScenarioViaApi(baseUrl, {
      ...payload,
      user_id: payload.user_id ? `${payload.user_id}.attempt${attempt}` : undefined,
    });
    try {
      await waitForScenarioDone(baseUrl, scenario.id, timeoutMs);
      return scenario.id;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to create a completed scenario");
}

async function waitForClassicView(page) {
  return waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.simulation?.viewMode === "classic"
      && (
        payload.page?.controls?.can_toggle_view_mode === true
        || payload.simulation?.visualizationEnabled === false
      )
    ),
    45000,
    "classic simulation view",
  );
}

async function ensureClassicView(page) {
  await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && (
        payload.page?.controls?.can_toggle_view_mode === true
        || payload.simulation?.visualizationEnabled === false
      )
    ),
    60000,
    "classic toggle ready",
  );
  const toggle = page.locator(".view-mode-toggle");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const latest = await readAutomation(page);
    const latestClassicReady =
      latest?.page?.kind === "simulation"
      && latest.simulation?.viewMode === "classic"
      && (
        latest.page?.controls?.can_toggle_view_mode === true
        || latest.simulation?.visualizationEnabled === false
      );
    if (latestClassicReady) {
      await page.waitForTimeout(1200);
      const confirmed = await readAutomation(page);
      const confirmedClassic =
        confirmed?.page?.kind === "simulation"
        && confirmed.simulation?.viewMode === "classic"
        && (
          confirmed.page?.controls?.can_toggle_view_mode === true
          || confirmed.simulation?.visualizationEnabled === false
        );
      if (confirmedClassic) {
        return confirmed;
      }
    }
    if (await toggle.isDisabled()) {
      throw new Error("Classic view is not available on this scenario");
    }
    await toggle.click();
    await waitForClassicView(page);
  }
  throw new Error("Failed to lock classic view after 3 attempts");
}

async function ensureTheaterView(page) {
  const automation = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation",
    45000,
    "simulation shell",
  );
  if (automation?.simulation?.viewMode === "theater") {
    return automation;
  }
  await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation" && payload.page?.controls?.can_toggle_view_mode === true,
    60000,
    "theater toggle ready",
  );
  const latest = await readAutomation(page);
  if (latest?.page?.kind === "simulation" && latest.simulation?.viewMode === "theater") {
    return latest;
  }
  const toggle = page.locator(".view-mode-toggle");
  if (await toggle.isDisabled()) {
    throw new Error("Pixel Theater is not available on this scenario");
  }
  await toggle.click();
  return waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation" && payload.simulation?.viewMode === "theater",
    45000,
    "theater simulation view",
  );
}

async function waitForBranchNodes(page, count) {
  await page.waitForFunction(
    (minimum) => document.querySelectorAll(".branch-node").length >= minimum,
    count,
    {timeout: 240000},
  );
}

async function openBranchDetail(page) {
  await page.locator(".branch-node--active").first().click();
  await page.waitForSelector(".bdm-modal", {timeout: 30000});
}

async function openGameplayCards(page) {
  await page.getByRole("button", {name: /Gameplay Cards|玩法卡/i}).click();
  await page.waitForSelector(".gameplay-modal", {timeout: 30000});
}

async function openPredictionModal(page) {
  await page.getByRole("button", {name: /Predict|预测|押注/i}).click();
  await page.waitForSelector(".prediction-modal", {timeout: 30000});
}

async function openShareModal(page) {
  await page.getByRole("button", {name: /Generate Copy|生成文案/i}).click();
  await page.waitForSelector(".share-modal", {timeout: 30000});
}

async function waitForShareCopy(page) {
  await page.waitForFunction(
    () => {
      const target = document.querySelector(".share-result-text");
      return Boolean(target && target.textContent && target.textContent.trim().length > 0);
    },
    undefined,
    {timeout: 180000},
  );
}

async function captureHookClip(browser, config, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.route("**/api/scenario", async (route) => {
      const request = route.request();
      const payload = JSON.parse(request.postData() ?? "{}");
      await route.continue({
        postData: JSON.stringify({
          ...payload,
          question: config.question,
          rounds: 3,
          num_agents: 3,
          mode: "blackboard",
          visualization_enabled: false,
          reasoning_effort: "low",
          user_id: `${config.versionName}.hook`,
        }),
      });
    });
    await page.goto(`${config.baseUrl}/`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(page, (payload) => payload.page?.kind === "input", 30000, "input page");
    await page.locator("textarea.input--hero").fill(config.question);
    await setRangeValue(page, "input.rounds-slider", 3);
    await setRangeValue(page, "input.agents-slider", 3);
    await saveScreenshot(page, paths.screenshots.hook);
    await page.waitForTimeout(900);
    await page.locator(".input-view__submit-row .btn.btn-primary").click();
    await page.waitForURL(/\/sim\//, {timeout: 30000});
    await page.waitForTimeout(2400);
    return {hookScenarioId: page.url().split("/").pop() ?? null};
  });
  await finalizeRecordedPage(recording, paths.raw.hook);
  return recording.result;
}

async function captureBoardClip(browser, config, spec, scenarioId, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 45000, "simulation page");
    await ensureClassicView(page);
    await waitForBranchNodes(page, spec.minBranchCount);
    await page.waitForTimeout(2500);
    await saveScreenshot(page, paths.screenshots.board);
    await page.waitForTimeout(6500);
    return {
      scenarioId,
      branchNodeCount: await page.locator(".branch-node").count(),
    };
  });
  await finalizeRecordedPage(recording, paths.raw.board);
  if (paths.gifs.board) {
    createGifFromClip(paths.raw.board, paths.gifs.board, 0.9);
  }
  return recording.result;
}

async function captureDetailClip(browser, config, scenarioId, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForClassicView(page);
    await waitForBranchNodes(page, 2);
    await openBranchDetail(page);
    const modalSaved = await captureModalScreenshot(page, paths.screenshots.detail);
    if (!modalSaved) {
      await saveElementScreenshot(page, ".bdm-modal", paths.screenshots.detail);
    }
    await page.waitForTimeout(6500);
    return {scenarioId};
  });
  await finalizeRecordedPage(recording, paths.raw.detail);
  if (paths.gifs.detail) {
    createGifFromClip(paths.raw.detail, paths.gifs.detail, 0.8);
  }
  return recording.result;
}

async function captureAgentClip(browser, config, scenarioId, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForClassicView(page);
    await waitForBranchNodes(page, 2);
    const agentCards = page.locator(".agent-card");
    const count = await agentCards.count();
    if (count < 2) {
      throw new Error("Not enough agent cards to demonstrate filtering");
    }
    await agentCards.nth(1).click();
    await page.waitForTimeout(1200);
    await saveScreenshot(page, paths.screenshots.agent);
    await page.waitForTimeout(5200);
    return {
      scenarioId,
      filteredAgentIndex: 1,
    };
  });
  await finalizeRecordedPage(recording, paths.raw.agent);
  return recording.result;
}

async function captureResultClip(browser, config, scenarioId, paths, options = {}) {
  console.log(`[capture] ${config.versionName}: waiting for result scenario ${scenarioId}`);
  await waitForScenarioDone(config.baseUrl, scenarioId, options.waitTimeoutMs ?? 360000);
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    console.log(`[capture] ${config.versionName}: result clip loading ${scenarioId}`);
    await page.goto(`${config.baseUrl}/result/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
      45000,
      "result page",
    );
    console.log(`[capture] ${config.versionName}: result page ready ${scenarioId}`);
    if (await page.getByRole("button", {name: /Read Full Story|查看完整叙事|阅读全文/i}).count()) {
      await page.getByRole("button", {name: /Read Full Story|查看完整叙事|阅读全文/i}).first().click().catch(() => {});
      await page.waitForTimeout(500);
    }
    await saveScreenshot(page, paths.screenshots.result);
    if (paths.screenshots.story) {
      await saveElementScreenshot(page, ".story-section", paths.screenshots.story);
    }
    if (paths.screenshots.insight) {
      await saveElementScreenshot(page, ".insight-section", paths.screenshots.insight);
    }
    if (paths.screenshots.archive) {
      await saveElementScreenshot(page, ".result-archive", paths.screenshots.archive);
    }
    if (options.scrollArchive) {
      await page.locator(".result-archive").scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
    }
    console.log(`[capture] ${config.versionName}: result screenshots saved ${scenarioId}`);
    await page.waitForTimeout(6000);
    return {scenarioId};
  });
  await finalizeRecordedPage(recording, paths.raw.result);
  return recording.result;
}

async function captureGameplayCardsClip(browser, config, scenarioId, paths, {previewCounterplay = false, showTheater = false} = {}) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    console.log(`[capture] ${config.versionName}: cards clip loading ${scenarioId}`);
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 45000, "simulation page");
    if (showTheater) {
      await ensureTheaterView(page);
      await waitForAutomation(
        page,
        (payload) => payload.page?.kind === "simulation" && payload.page?.controls?.can_open_gameplay_cards === true,
        90000,
        "gameplay cards ready in theater",
      );
      console.log(`[capture] ${config.versionName}: cards clip theater ready ${scenarioId}`);
    } else {
      await ensureClassicView(page);
      await waitForBranchNodes(page, 2);
      console.log(`[capture] ${config.versionName}: cards clip classic ready ${scenarioId}`);
    }
    await openGameplayCards(page);
    console.log(`[capture] ${config.versionName}: cards modal opened ${scenarioId}`);
    await page.waitForTimeout(900);
    if (previewCounterplay) {
      const counterplayCard = page.locator(".gameplay-card", {hasText: /Counter|反制/}).first();
      if (await counterplayCard.count()) {
        await counterplayCard.click();
        await page.waitForTimeout(700);
      }
      await page.locator(".gameplay-card").first().click();
      await page.waitForTimeout(700);
    }
    console.log(`[capture] ${config.versionName}: cards selected ${scenarioId}`);
    const modalSaved = await captureModalScreenshot(page, paths.screenshots.cards);
    if (!modalSaved) {
      await saveElementScreenshot(page, ".gameplay-modal", paths.screenshots.cards);
    }
    console.log(`[capture] ${config.versionName}: cards screenshot saved ${scenarioId}`);
    const injectButton = page.locator(".modal-footer .btn.btn-primary");
    if (await injectButton.count()) {
      await injectButton.first().click();
    } else {
      await page.getByRole("button", {name: /Inject Gameplay Card|注入玩法卡/i}).click();
    }
    console.log(`[capture] ${config.versionName}: cards injected ${scenarioId}`);
    await page.waitForTimeout(4200);
    return {scenarioId};
  });
  await finalizeRecordedPage(recording, paths.raw.cards);
  return recording.result;
}

async function captureGameplayEffectClip(browser, config, scenarioId, paths, {showTheater = false} = {}) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 45000, "simulation page");
    if (showTheater) {
      await ensureTheaterView(page);
      await page.waitForTimeout(3000);
    } else {
      await ensureClassicView(page);
      await waitForBranchNodes(page, 2);
    }
    await saveScreenshot(page, paths.screenshots.effect);
    await page.waitForTimeout(6200);
    return {scenarioId, viewMode: showTheater ? "theater" : "classic"};
  });
  await finalizeRecordedPage(recording, paths.raw.effect);
  if (paths.gifs.effect) {
    createGifFromClip(paths.raw.effect, paths.gifs.effect, 0.8);
  }
  return recording.result;
}

async function capturePredictionClip(browser, config, scenarioId, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    console.log(`[capture] ${config.versionName}: prediction clip loading ${scenarioId}`);
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.page?.controls?.can_open_prediction === true
      ),
      90000,
      "prediction ready",
    );
    console.log(`[capture] ${config.versionName}: prediction ready ${scenarioId}`);
    await openPredictionModal(page);
    console.log(`[capture] ${config.versionName}: prediction modal opened ${scenarioId}`);
    const predictionField = page.getByRole("textbox", {name: /你的预测|Your Prediction/i});
    const nameField = page.getByRole("textbox", {name: /你的名字|Your Name/i});
    const confidenceSlider = page.getByRole("slider", {name: /自信度|Confidence/i});
    await predictionField.fill(config.predictionText);
    await nameField.fill(config.locale === "zh" ? "视频导演" : "Video Director");
    await confidenceSlider.evaluate((element) => {
      element.value = "0.7";
      element.dispatchEvent(new Event("input", {bubbles: true}));
      element.dispatchEvent(new Event("change", {bubbles: true}));
    });
    await saveElementScreenshot(page, ".prediction-modal", paths.screenshots.bet);
    await page.getByRole("button", {name: /Submit Prediction|提交预测/i}).click();
    console.log(`[capture] ${config.versionName}: prediction submitted ${scenarioId}`);
    await page.waitForTimeout(2600);
    return {scenarioId};
  });
  await finalizeRecordedPage(recording, paths.raw.bet);
  return recording.result;
}

async function captureShareClip(browser, config, scenarioId, paths) {
  const [primaryPlatform, secondaryPlatform] = config.sharePlatforms;
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    console.log(`[capture] ${config.versionName}: share clip loading ${scenarioId}`);
    await page.goto(`${config.baseUrl}/result/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
      45000,
      "result page",
    );
    await openShareModal(page);
    console.log(`[capture] ${config.versionName}: share modal opened ${scenarioId}`);
    await clickSharePlatform(page, primaryPlatform);
    await waitForShareCopy(page);
    await saveElementScreenshot(page, ".share-modal", paths.screenshots.sharePrimary);
    console.log(`[capture] ${config.versionName}: share primary ready ${scenarioId}`);
    await page.waitForTimeout(1200);
    await clickSharePlatform(page, secondaryPlatform);
    await waitForShareCopy(page);
    await saveElementScreenshot(page, ".share-modal", paths.screenshots.shareSecondary);
    console.log(`[capture] ${config.versionName}: share secondary ready ${scenarioId}`);
    await page.waitForTimeout(4200);
    return {
      scenarioId,
      sharePlatforms: config.sharePlatforms,
    };
  });
  await finalizeRecordedPage(recording, paths.raw.share);
  if (paths.gifs.share) {
    createGifFromClip(paths.raw.share, paths.gifs.share, 0.7);
  }
  return recording.result;
}

async function captureTheaterClip(browser, config, scenarioId, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, {waitUntil: "domcontentloaded"});
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 45000, "simulation page");
    await ensureTheaterView(page);
    await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.simulation?.viewMode === "theater"
        && payload.page?.controls?.can_capture_screenshot
      ),
      90000,
      "capture-ready theater",
    );
    await page.waitForTimeout(3200);
    await saveScreenshot(page, paths.screenshots.theater);
    await page.waitForTimeout(7200);
    return {scenarioId};
  });
  await finalizeRecordedPage(recording, paths.raw.theater);
  if (paths.gifs.theater) {
    createGifFromClip(paths.raw.theater, paths.gifs.theater, 1.1);
  }
  return recording.result;
}

function copyPromoDebateAssets(config, paths) {
  const sourceVersion = config.reusePromoDebateFrom;
  const rawSource = path.join(VIDEO_ROOT, "assets", "raw", `${sourceVersion}.debate.webm`);
  const gifSource = path.join(VIDEO_ROOT, "assets", "gifs", `${sourceVersion}.debate.gif`);
  const liveSource = path.join(VIDEO_ROOT, "assets", "screenshots", `${sourceVersion}.debate-live.png`);
  const resultSource = path.join(VIDEO_ROOT, "assets", "screenshots", `${sourceVersion}.debate-result.png`);

  if (!fs.existsSync(rawSource) || !fs.existsSync(gifSource) || !fs.existsSync(liveSource) || !fs.existsSync(resultSource)) {
    throw new Error(`Missing reusable promo debate assets for ${sourceVersion}`);
  }

  ensureDir(path.dirname(paths.raw.debate));
  ensureDir(path.dirname(paths.gifs.debate));
  ensureDir(path.dirname(paths.screenshots.debateLive));
  fs.copyFileSync(rawSource, paths.raw.debate);
  fs.copyFileSync(gifSource, paths.gifs.debate);
  fs.copyFileSync(liveSource, paths.screenshots.debateLive);
  fs.copyFileSync(resultSource, paths.screenshots.debateResult);

  return {
    sourceVersion,
    rawSource,
    gifSource,
    liveSource,
    resultSource,
  };
}

function buildPaths(versionName, clipKeys, screenshotKeys, gifKeys) {
  const tempVideoDir = path.join(VIDEO_ROOT, "tmp", "playwright-video");
  const rawRoot = path.join(VIDEO_ROOT, "assets", "raw");
  const screenshotRoot = path.join(VIDEO_ROOT, "assets", "screenshots");
  const gifRoot = path.join(VIDEO_ROOT, "assets", "gifs");
  const outputRoot = path.join(VIDEO_ROOT, "output");

  const raw = Object.fromEntries(
    clipKeys.map((key) => [key, path.join(rawRoot, `${versionName}.${key}.webm`)]),
  );
  const screenshots = Object.fromEntries(
    screenshotKeys.map((key) => [key, path.join(screenshotRoot, `${versionName}.${key}.png`)]),
  );
  const gifs = Object.fromEntries(
    gifKeys.map((key) => [key, path.join(gifRoot, `${versionName}.${key}.gif`)]),
  );

  return {
    tempVideoDir,
    raw,
    screenshots,
    gifs,
    manifest: path.join(outputRoot, `${versionName}.capture-manifest.json`),
  };
}

async function captureBlackboardSeries(browser, config, spec, paths) {
  console.log(`[capture] ${config.versionName}: hook`);
  const hook = await captureHookClip(browser, config, paths);
  if (hook.hookScenarioId) {
    await deleteScenarioViaApi(config.baseUrl, hook.hookScenarioId).catch(() => {});
  }
  console.log(`[capture] ${config.versionName}: branching scenario`);
  const scenario = await createScenarioWithRetries(config.baseUrl, config, spec);
  console.log(`[capture] ${config.versionName}: board/detail/agent on ${scenario.scenarioId}`);
  const board = await captureBoardClip(browser, config, spec, scenario.scenarioId, paths);
  const detail = await captureDetailClip(browser, config, scenario.scenarioId, paths);
  const agent = await captureAgentClip(browser, config, scenario.scenarioId, paths);
  console.log(`[capture] ${config.versionName}: dedicated result scenario`);
  const resultScenarioId = await createCompletedScenario(config.baseUrl, {
    question: config.question,
    rounds: config.resultRounds ?? 3,
    num_agents: config.resultNumAgents ?? 4,
    mode: "blackboard",
    visualization_enabled: false,
    reasoning_effort: "low",
    user_id: `${config.versionName}.result`,
  });
  const result = await captureResultClip(browser, config, resultScenarioId, paths);
  return {
    hook,
    scenario,
    board,
    detail,
    agent,
    resultScenarioId,
    result,
  };
}

async function captureGameplaySeries(browser, config, spec, paths) {
  console.log(`[capture] ${config.versionName}: hook`);
  const hook = await captureHookClip(browser, config, paths);
  if (hook.hookScenarioId) {
    await deleteScenarioViaApi(config.baseUrl, hook.hookScenarioId).catch(() => {});
  }
  const boardConfig = {
    ...config,
    visualizationEnabled: false,
  };
  console.log(`[capture] ${config.versionName}: board scenario`);
  const boardScenario = await createScenarioWithRetries(config.baseUrl, boardConfig, spec);
  console.log(`[capture] ${config.versionName}: interaction scenario`);
  const interactionScenario = await createScenarioWithRetries(config.baseUrl, config, spec);
  console.log(`[capture] ${config.versionName}: board on ${boardScenario.scenarioId}`);
  const board = await captureBoardClip(browser, boardConfig, spec, boardScenario.scenarioId, paths);
  console.log(`[capture] ${config.versionName}: cards/effect/bet/result/share on ${interactionScenario.scenarioId}`);
  const cards = await captureGameplayCardsClip(browser, config, interactionScenario.scenarioId, paths, {previewCounterplay: true, showTheater: true});
  const bet = await capturePredictionClip(browser, config, interactionScenario.scenarioId, paths);
  const effect = await captureGameplayEffectClip(browser, config, interactionScenario.scenarioId, paths, {showTheater: true});
  const result = await captureResultClip(browser, config, interactionScenario.scenarioId, paths, {
    scrollArchive: true,
    waitTimeoutMs: spec.resultTimeoutMs,
  });
  const share = await captureShareClip(browser, config, interactionScenario.scenarioId, paths);
  return {
    hook,
    boardScenario,
    interactionScenario,
    board,
    cards,
    effect,
    bet,
    result,
    share,
  };
}

async function captureLongformSeries(browser, config, spec, paths) {
  console.log(`[capture] ${config.versionName}: hook`);
  const hook = await captureHookClip(browser, config, paths);
  if (hook.hookScenarioId) {
    await deleteScenarioViaApi(config.baseUrl, hook.hookScenarioId).catch(() => {});
  }
  console.log(`[capture] ${config.versionName}: blackboard scenario`);
  const boardScenario = await createScenarioWithRetries(config.baseUrl, {
    ...config,
    visualizationEnabled: false,
  }, spec);
  console.log(`[capture] ${config.versionName}: theater scenario`);
  const theaterScenario = await createScenarioWithRetries(config.baseUrl, config, spec);

  console.log(`[capture] ${config.versionName}: board/detail on ${boardScenario.scenarioId}`);
  const board = await captureBoardClip(browser, {...config, visualizationEnabled: false}, spec, boardScenario.scenarioId, paths);
  const detail = await captureDetailClip(browser, {...config, visualizationEnabled: false}, boardScenario.scenarioId, paths);
  console.log(`[capture] ${config.versionName}: theater/cards/bet/result/share on ${theaterScenario.scenarioId}`);
  const theater = await captureTheaterClip(browser, config, theaterScenario.scenarioId, paths);
  const cards = await captureGameplayCardsClip(browser, config, theaterScenario.scenarioId, paths, {
    previewCounterplay: true,
    showTheater: true,
  });
  const bet = await capturePredictionClip(browser, config, theaterScenario.scenarioId, paths);
  const result = await captureResultClip(browser, config, theaterScenario.scenarioId, paths, {
    scrollArchive: true,
    waitTimeoutMs: spec.resultTimeoutMs,
  });
  const share = await captureShareClip(browser, config, theaterScenario.scenarioId, paths);
  const debate = copyPromoDebateAssets(config, paths);

  return {
    hook,
    boardScenario,
    theaterScenario,
    board,
    detail,
    theater,
    cards,
    bet,
    result,
    share,
    debate,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const spec = SERIES_CONFIG[args.seriesKey];
  const config = {
    ...spec.languages[args.language],
    baseUrl: args.baseUrl,
  };
  const paths = buildPaths(config.versionName, spec.clipKeys, spec.screenshotKeys, spec.gifKeys);
  ensureDir(paths.tempVideoDir);

  const {browser, launchProfile} = await launchBrowser(args.headless);
  try {
    let result;
    if (spec.sceneStrategy === "blackboard") {
      result = await captureBlackboardSeries(browser, config, spec, paths);
    } else if (spec.sceneStrategy === "gameplay") {
      result = await captureGameplaySeries(browser, config, spec, paths);
    } else {
      result = await captureLongformSeries(browser, config, spec, paths);
    }

    const manifest = {
      series: args.seriesKey,
      language: args.language,
      versionName: config.versionName,
      baseUrl: args.baseUrl,
      launchProfile,
      question: config.question,
      raw: paths.raw,
      screenshots: paths.screenshots,
      gifs: paths.gifs,
      result,
    };

    writeJson(paths.manifest, manifest);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
