import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";
import { closePlaywrightBrowser, closePlaywrightContext } from "./playwrightTeardown.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_MATRIX_PATH = path.join(DEFAULT_OUTPUT_ROOT, "sample_matrix.json");
const DEFAULT_SAFARI_WEBDRIVER_URL = process.env.SAFARI_WEBDRIVER_URL || "http://127.0.0.1:4444";
const DEFAULT_DIRECTOR_STATE_SCENARIO_ID = "72ae364d-3ea1-4959-939c-8fe1dbeca1c9";
const SAFARI_PANEL_CAPTURE_ENABLED = process.env.SWARM_SAFARI_PANEL_CAPTURE === "1";
const FIXTURE_MODE = process.env.SWARM_E2E_FIXTURE_MODE === "1";
const SHARE_COPY_WAIT_TIMEOUT_MS = 90000;
const MATRIX_SCENARIO_FALLBACKS = {
  governance: { question: "如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？", rounds: 1, numAgents: 3 },
  law: { question: "如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？", rounds: 1, numAgents: 3 },
  law_grand_tribunal: { question: "What if every constitutional dispute had to be retried in a grand tribunal archive chamber before enforcement?", rounds: 1, numAgents: 3 },
  trade: { question: "如果全球最关键的海峡被一个海上商团永久垄断，会发生什么？", rounds: 1, numAgents: 3 },
  ecology: { question: "如果跨大陆淡水供应在十年内枯竭，会发生什么？", rounds: 1, numAgents: 3 },
  war: { question: "如果世界大战在高度自动化军备时代再次爆发，会发生什么？", rounds: 1, numAgents: 3 },
  faith: { question: "如果一则神谕成为整个王国唯一合法的统治依据，会发生什么？", rounds: 1, numAgents: 3 },
  faith_council: { question: "What if a sacred council had to settle a clerical schism before every prophecy could become law?", rounds: 1, numAgents: 3 },
  industry: { question: "如果一座跨大陆熔炉联合体遭遇产能瓶颈，会发生什么？", rounds: 1, numAgents: 3 },
  frontier: { question: "如果一座前哨殖民地被迫以自治城邦的形式自救，会发生什么？", rounds: 1, numAgents: 3 },
  mythic: { question: "如果一群法师在秘法圣所中试图改写巨龙契约，会发生什么？", rounds: 1, numAgents: 3 },
  survival: { question: "如果最后一座避难城只能再维持三十天供电，会发生什么？", rounds: 1, numAgents: 3 },
  generic: { question: "如果所有大型组织都必须每周随机交换一次负责人，会发生什么？", rounds: 1, numAgents: 3 },
  generic_review_chamber: { question: "What if every emergency review had to pass through a rotating review chamber before execution?", rounds: 1, numAgents: 3 },
  governance_surveillance: { question: "如果一个平台国家依靠社会信用哨卡治理整座城市，会发生什么？", rounds: 1, numAgents: 3 },
  empire_palace: { question: "如果一场继承危机在王朝宫廷内部突然爆发，会发生什么？", rounds: 1, numAgents: 3 },
  industry_grid: { question: "如果大陆级电网枢纽发生连锁停电，会发生什么？", rounds: 1, numAgents: 3 },
  war_logistics: { question: "如果坚固补给枢纽的补给线突然崩塌，会发生什么？", rounds: 1, numAgents: 3 },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeDataUrlFile(filePath, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new Error(`Expected a data URL for ${filePath}`);
  }
  const [, base64 = ""] = dataUrl.split(",", 2);
  if (!base64) {
    throw new Error(`Data URL for ${filePath} is missing base64 payload`);
  }
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
}

function getDataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return 0;
  const [, base64 = ""] = dataUrl.split(",", 2);
  return base64 ? Buffer.from(base64, "base64").length : 0;
}

function getSceneThemeMismatch(sample, resolvedScenario) {
  if (!sample.scene_theme) return null;
  if (!resolvedScenario.sceneTheme) return null;
  if (sample.scene_theme === resolvedScenario.sceneTheme) return null;
  return `scene_theme mismatch: expected ${sample.scene_theme}, got ${resolvedScenario.sceneTheme}`;
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveFrontendPath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;

  const normalized = inputPath.replace(/^\.\/+/, "");
  if (normalized === "frontend" || normalized.startsWith(`frontend${path.sep}`) || normalized.startsWith("frontend/")) {
    return path.join(path.dirname(FRONTEND_ROOT), normalized);
  }
  return path.join(FRONTEND_ROOT, normalized);
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    sampleMatrixPath: DEFAULT_MATRIX_PATH,
    outputDir: "",
    scenarioId: process.env.SWARM_SCENARIO_ID || DEFAULT_DIRECTOR_STATE_SCENARIO_ID,
    webdriverUrl: DEFAULT_SAFARI_WEBDRIVER_URL,
    browsers: [],
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
      args.sampleMatrixPath = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--themes" && next) {
      args.themes = next.split(",").map((theme) => theme.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--scenario-id" && next) {
      args.scenarioId = next;
      i += 1;
    } else if (arg === "--webdriver-url" && next) {
      args.webdriverUrl = next;
      i += 1;
    } else if (arg === "--browsers" && next) {
      args.browsers = next.split(",").map((browser) => browser.trim()).filter(Boolean);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["matrix", "corners", "mobile", "cross-browser", "safari", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-suite.mjs <matrix|corners|mobile|cross-browser|safari|full> [--url URL] [--sample-matrix PATH] [--output-dir DIR] [--themes governance,law] [--scenario-id ID] [--browsers firefox,webkit] [--webdriver-url URL] [--headless]");
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

function getBrowserType(browserName) {
  if (browserName === "chromium") return chromium;
  if (browserName === "firefox") return firefox;
  if (browserName === "webkit") return webkit;
  throw new Error(`Unsupported Playwright browser: ${browserName}`);
}

function buildBrowserLaunchCandidates(browserName, headless) {
  if (browserName === "firefox") {
    return [
      {
        id: "firefox-default",
        options: { headless },
      },
    ];
  }

  if (browserName === "webkit") {
    return [
      {
        id: "webkit-default",
        options: { headless },
      },
    ];
  }

  return buildLaunchCandidates(headless);
}

async function launchBrowser(headless, browserName = "chromium") {
  const browserType = getBrowserType(browserName);
  const attempts = [];
  for (const candidate of buildBrowserLaunchCandidates(browserName, headless)) {
    try {
      const browser = await browserType.launch(candidate.options);
      return {
        browser,
        launchProfile: {
          browserName,
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
        browserName,
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

function isRetryableGotoError(error) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("ERR_HTTP_RESPONSE_CODE_FAILURE");
}

async function gotoWithRetry(page, url, options = {}, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      await page.goto(url, options);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableGotoError(error) || attempt === retries) {
        throw error;
      }
      await page.waitForTimeout(500 * attempt);
    }
  }
  throw lastError ?? new Error(`Failed to navigate to ${url}`);
}

async function captureGameScreenshotWithRetry(page, mode, retries = 4) {
  let lastShot = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    lastShot = await page.evaluate(async (captureMode) => (
      await window.capture_game_screenshot?.(captureMode) ?? null
    ), mode);
    if (lastShot) {
      return lastShot;
    }
    if (attempt < retries) {
      await advanceAutomationTime(page, 125);
      await page.waitForTimeout(150);
    }
  }
  return lastShot;
}

async function readTheaterHookStatus(page) {
  return page.evaluate(() => ({
    hasRender: typeof window.render_game_to_text === "function",
    hasAdvance: typeof window.advanceTime === "function",
    hasCapture: typeof window.capture_game_screenshot === "function",
  }));
}

async function waitForCompletedReplayAutomationReady(page, timeout = 20000) {
  const start = Date.now();
  let lastPayload = null;
  let lastHookStatus = null;

  while (Date.now() - start < timeout) {
    lastPayload = await readAutomation(page);
    lastHookStatus = await readTheaterHookStatus(page);

    if (
      lastPayload?.page?.kind === "simulation"
      && lastPayload?.simulation?.viewMode === "theater"
      && lastPayload.page?.replay_state?.available === true
      && lastHookStatus?.hasAdvance === true
      && lastHookStatus?.hasCapture === true
      && lastHookStatus?.hasRender === true
      && typeof lastPayload?.scene?.scene === "string"
    ) {
      return {
        payload: lastPayload,
        hookStatus: lastHookStatus,
      };
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for completed replay automation hooks; last kind=${lastPayload?.page?.kind ?? null}, viewMode=${lastPayload?.simulation?.viewMode ?? null}, scene=${JSON.stringify(lastPayload?.scene ?? null)}, replay_state=${JSON.stringify(lastPayload?.page?.replay_state ?? null)}, hooks=${JSON.stringify(lastHookStatus)}`,
  );
}

async function advanceAutomationTime(page, ms) {
  await page.evaluate(async (deltaMs) => {
    if (typeof window.advanceTime === "function") {
      await window.advanceTime(deltaMs);
    }
  }, ms);
}

function isCompletedReplayTheaterReady(payload) {
  if (
    payload?.page?.kind !== "simulation"
    || payload?.page?.replay_state?.available !== true
  ) {
    return false;
  }

  if (payload.page?.replay_state?.theater_ready === true) {
    return true;
  }

  return Boolean(
    payload.scene?.scene
    && payload.scene.scene !== "BootScene"
    && payload.scene.scene !== "TitleScene",
  );
}

async function saveScreenshot(page, filePath, options = {}) {
  const browserName = page.context().browser()?.browserType().name() ?? "chromium";
  try {
    await page.screenshot({
      path: filePath,
      type: "png",
      scale: "css",
      timeout: 15_000,
      ...options,
    });
  } catch (error) {
    if (browserName !== "chromium") {
      throw error;
    }
    const primaryError = error instanceof Error ? error.message : String(error);
    console.warn(`[screenshot] falling back to CDP capture for ${path.basename(filePath)}: ${primaryError}`);
    try {
      const cdpSession = await page.context().newCDPSession(page);
      const { data } = await cdpSession.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
    } catch (fallbackError) {
      const fallbackDetail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `Failed to capture screenshot for ${filePath}: primary=${primaryError}; fallback=${fallbackDetail}`,
      );
    }
  }
}

async function saveLocatorScreenshot(locator, filePath) {
  await locator.screenshot({
    path: filePath,
    type: "png",
    timeout: 15_000,
  });
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
  mode = "blackboard",
}) {
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      rounds,
      num_agents: numAgents,
      mode,
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

async function findScenarioViaApi(baseUrl, scenarioId) {
  if (!scenarioId) return null;
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to get scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function findScenarioViaApiWithRetry(baseUrl, scenarioId, attempts = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await findScenarioViaApi(baseUrl, scenarioId);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/ 5\d\d /.test(message) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error(`Failed to get scenario ${scenarioId}`);
}

async function deleteScenarioViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/scenario/${scenarioId}`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`Failed to delete scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getScenarioDirectorStateViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/campaign/scenario/${scenarioId}/director-state`);
  if (!response.ok) {
    throw new Error(`Failed to get director state for ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getScenarioGameplayStateViaApi(baseUrl, scenarioId) {
  const response = await fetch(`${baseUrl}/api/campaign/scenario/${scenarioId}/gameplay-state`);
  if (!response.ok) {
    throw new Error(`Failed to get gameplay state for ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function putScenarioDirectorStateViaApi(baseUrl, scenarioId, directorState) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentState = await getScenarioDirectorStateViaApi(baseUrl, scenarioId);
    const response = await fetch(`${baseUrl}/api/campaign/scenario/${scenarioId}/director-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...directorState,
        revision: currentState.revision ?? 0,
      }),
    });
    if (response.ok) {
      return response.json();
    }

    const body = await response.text();
    if (response.status === 409 && attempt === 0) {
      continue;
    }
    throw new Error(`Failed to save director state for ${scenarioId}: ${response.status} ${body}`);
  }
}

async function putScenarioGameplayStateViaApi(baseUrl, scenarioId, gameplayState) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentState = await getScenarioGameplayStateViaApi(baseUrl, scenarioId);
    const response = await fetch(`${baseUrl}/api/campaign/scenario/${scenarioId}/gameplay-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...gameplayState,
        revision: currentState.revision ?? 0,
      }),
    });
    if (response.ok) {
      return response.json();
    }

    const body = await response.text();
    if (response.status === 409 && attempt === 0) {
      continue;
    }
    throw new Error(`Failed to save gameplay state for ${scenarioId}: ${response.status} ${body}`);
  }
}

async function waitForScenarioStatus(baseUrl, scenarioId, predicate, timeout = 60000, label = "scenario status") {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeout) {
    try {
      const scenario = await getScenarioViaApi(baseUrl, scenarioId);
      lastError = null;
      if (predicate(scenario)) return scenario;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message;
      if (!message.includes(" 500 ")) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (lastError) {
    throw new Error(`Timed out waiting for ${label} on scenario ${scenarioId}; last error: ${lastError}`);
  }
  throw new Error(`Timed out waiting for ${label} on scenario ${scenarioId}`);
}

async function clearOriginStorage(page, baseUrl) {
  await gotoWithRetry(page, baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    if ("indexedDB" in window && typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      await Promise.all(
        databases
          .map((db) => db?.name)
          .filter(Boolean)
          .map((name) => new Promise((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          })),
      );
    }
  });
  await page.context().clearCookies();
}

async function extractResultArchiveCards(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll(".archive-summary-card"));
    return cards.map((card) => {
      const label = card.querySelector(".archive-summary-card__label")?.textContent?.trim() ?? null;
      const value = card.querySelector("strong")?.textContent?.trim() ?? null;
      const detail = card.querySelector("small")?.textContent?.trim() ?? null;
      return { label, value, detail };
    });
  });
}

async function resolveMatrixScenario(baseUrl, sample) {
  const requestedScenarioId = sample.scenario_id ?? null;
  const fallbackConfig = MATRIX_SCENARIO_FALLBACKS[sample.theme] ?? null;
  const fallbackQuestion = sample.question ?? fallbackConfig?.question ?? null;
  let scenario = null;
  if (requestedScenarioId) {
    scenario = await findScenarioViaApiWithRetry(baseUrl, requestedScenarioId);
  }
  let scenarioId = requestedScenarioId;
  let createdAtRuntime = false;

  if (!scenario) {
    if (!fallbackQuestion) {
      throw new Error(
        `Matrix sample ${sample.theme} is missing scenario ${requestedScenarioId ?? "(none)"} and has no fallback question.`,
      );
    }
    const created = await createScenarioViaApi(baseUrl, {
      question: fallbackQuestion,
      rounds: sample.rounds ?? fallbackConfig?.rounds ?? 1,
      numAgents: sample.num_agents ?? fallbackConfig?.numAgents ?? 3,
      mode: sample.mode ?? "blackboard",
      visualizationEnabled: sample.visualization_enabled ?? true,
    });
    scenarioId = created.id;
    createdAtRuntime = true;
  }

  scenario = await waitForScenarioStatus(
    baseUrl,
    scenarioId,
    (candidate) => candidate.status === "done" || candidate.status === "error",
    createdAtRuntime ? 180000 : 60000,
    createdAtRuntime ? "runtime-created matrix scenario" : "matrix scenario readiness",
  );

  if (scenario.status !== "done") {
    throw new Error(
      `Matrix sample ${sample.theme} resolved to scenario ${scenarioId} but finished with status=${scenario.status}.`,
    );
  }

  return {
    requestedScenarioId,
    scenarioId,
    createdAtRuntime,
    sceneTheme: scenario.scene_theme ?? sample.scene_theme ?? null,
    question: scenario.question ?? fallbackQuestion,
  };
}

async function createRuntimeMatrixScenario(baseUrl, sample) {
  const fallbackConfig = MATRIX_SCENARIO_FALLBACKS[sample.theme] ?? null;
  const fallbackQuestion = sample.question ?? fallbackConfig?.question ?? null;
  if (!fallbackQuestion) {
    throw new Error(`Matrix sample ${sample.theme} has no fallback question for runtime creation.`);
  }

  const created = await createScenarioViaApi(baseUrl, {
    question: fallbackQuestion,
    rounds: sample.rounds ?? fallbackConfig?.rounds ?? 1,
    numAgents: sample.num_agents ?? fallbackConfig?.numAgents ?? 3,
    mode: sample.mode ?? "blackboard",
    visualizationEnabled: sample.visualization_enabled ?? true,
  });

  const scenario = await waitForScenarioStatus(
    baseUrl,
    created.id,
    (candidate) => candidate.status === "done" || candidate.status === "error",
    180000,
    "runtime fallback matrix scenario",
  );

  if (scenario.status !== "done") {
    throw new Error(
      `Runtime fallback scenario ${created.id} for ${sample.theme} finished with status=${scenario.status}.`,
    );
  }

  if (sample.scene_theme && scenario.scene_theme && sample.scene_theme !== scenario.scene_theme) {
    throw new Error(
      `Runtime fallback scenario ${created.id} for ${sample.theme} still mismatched scene_theme: expected ${sample.scene_theme}, got ${scenario.scene_theme}.`,
    );
  }

  return {
    requestedScenarioId: sample.scenario_id ?? null,
    scenarioId: scenario.id,
    createdAtRuntime: true,
    sceneTheme: scenario.scene_theme ?? sample.scene_theme ?? null,
    question: scenario.question ?? fallbackQuestion,
  };
}

async function ensureResultMatrixScenario(page, baseUrl, sample, resolvedScenario) {
  try {
    await gotoWithRetry(page, `${baseUrl}/result/${resolvedScenario.scenarioId}`, { waitUntil: "domcontentloaded" });
    const payload = await waitForAutomation(
      page,
      (state) => state.page?.kind === "result" && state.page?.loading === false,
      40000,
      "result scenario preflight",
    );
    if (!payload.page?.error && (payload.page?.branch_titles?.length ?? 0) > 0) {
      return resolvedScenario;
    }
    console.warn(
      `[corners] result preflight failed for ${resolvedScenario.scenarioId}; `
      + `error=${payload.page?.error?.code ?? "none"} branchCount=${payload.page?.branch_titles?.length ?? 0}. `
      + "Falling back to a runtime-created matrix scenario.",
    );
  } catch (error) {
    console.warn(
      `[corners] result preflight threw for ${resolvedScenario.scenarioId}: ${summarizeLaunchError(error)}. `
      + "Falling back to a runtime-created matrix scenario.",
    );
  }
  return createRuntimeMatrixScenario(baseUrl, sample);
}

async function runReplayFlow(page, {
  baseUrl,
  scenarioId,
  outputDir,
  replayScreenshotPath,
}) {
  ensureDir(outputDir);
  let settledPayload = null;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
    const automationReady = await waitForCompletedReplayAutomationReady(page, 20000);
    const replayStart = Date.now();
    let payload = automationReady.payload;
    while (Date.now() - replayStart < 60000) {
      await advanceAutomationTime(page, 500);
      payload = await readAutomation(page);
      if (isCompletedReplayTheaterReady(payload)) {
        break;
      }
      await page.waitForTimeout(250);
    }

    if (isCompletedReplayTheaterReady(payload)) {
      await advanceAutomationTime(page, 600);
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.scrollTo(0, 0));
      settledPayload = await readAutomation(page) ?? payload;
      break;
    }

    lastError = new Error(
      `Timed out waiting for completed replay scene bootstrap for ${scenarioId}; theater_ready=${payload?.page?.replay_state?.theater_ready ?? null}, last scene=${payload?.scene?.scene ?? "unknown"}, hooks=${JSON.stringify(automationReady.hookStatus)} (attempt ${attempt}/2)`,
    );
    if (attempt < 2) {
      console.warn(`[replay] ${lastError.message} — retrying with a fresh page load`);
    }
  }

  if (!settledPayload) {
    throw lastError ?? new Error(`Replay flow failed for ${scenarioId}`);
  }

  writeJson(path.join(outputDir, "state-0.json"), settledPayload);
  await saveScreenshot(page, path.join(outputDir, "shot-0.png"));
  if (replayScreenshotPath) {
    await saveScreenshot(page, replayScreenshotPath);
  }

  return {
    scenarioId,
    replayState: settledPayload.page?.replay_state ?? null,
    director: settledPayload.page?.director ?? null,
    scene: settledPayload.scene?.scene ?? null,
    theme: settledPayload.scene?.theme ?? null,
  };
}

async function runResultFlow(page, {
  baseUrl,
  scenarioId,
  outputDir,
  shareCopyOverride = null,
}) {
  ensureDir(outputDir);
  const routePattern = `**/api/scenario/${scenarioId}/social/xiaohongshu`;
  if (shareCopyOverride) {
    await page.route(routePattern, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(shareCopyOverride),
      });
    });
  }
  try {
    await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
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
      (payload) => (
        payload.page?.controls?.active_modal === "share"
        && payload.page?.controls?.modal_state?.active_platform === "xiaohongshu"
        && payload.page?.controls?.modal_state?.loading === false
        && payload.page?.controls?.modal_state?.has_copy === true
      ),
      SHARE_COPY_WAIT_TIMEOUT_MS,
      "share generation",
    );
    writeJson(path.join(outputDir, "share-generated.json"), generated);
    await saveScreenshot(page, path.join(outputDir, "share-generated.png"));

    const finalPayload = await readAutomation(page);
    writeJson(path.join(outputDir, "result-final.json"), finalPayload);
    await saveScreenshot(page, path.join(outputDir, "result-final.png"));
    const archiveCards = await extractResultArchiveCards(page);
    writeJson(path.join(outputDir, "archive-cards.json"), archiveCards);
    return {
      scenarioId,
      branchTitles: finalPayload?.page?.branch_titles ?? [],
      archiveSummary: finalPayload?.page?.archive_summary ?? null,
      archiveCards,
      shareContext: generated?.page?.controls?.modal_state?.share_context ?? null,
    };
  } finally {
    if (shareCopyOverride) {
      await page.unroute(routePattern);
    }
  }
}

async function runDirectorStateRoundtripCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  const scenario = await getScenarioViaApi(baseUrl, scenarioId);
  const dominantBranch = [...(scenario.branches ?? [])]
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0] ?? null;
  if (!dominantBranch?.id || !dominantBranch?.title) {
    throw new Error(`Scenario ${scenarioId} does not expose a dominant branch for director-state smoke`);
  }

  const directorState = {
    objectives: {
      generated_for_question: scenario.question,
      generated_for_profile: "governance",
      goals: [
        {
          id: "e2e-director-goal-signature",
          kind: "signature_arc_step",
          target_card_id: "public_hearing",
          reward_label: "director_point",
          created_at: "2026-03-19T00:00:00Z",
        },
        {
          id: "e2e-director-goal-commitment",
          kind: "branch_commitment",
          target_card_id: null,
          reward_label: "archive_grade",
          created_at: "2026-03-19T00:00:00Z",
        },
      ],
      last_updated_at: "2026-03-19T00:00:00Z",
    },
    commitment: {
      active: true,
      branch_id: dominantBranch.id,
      branch_title: dominantBranch.title,
      committed_at_round: 2,
      committed_at: "2026-03-19T00:02:00Z",
      outcome: "pending",
    },
  };

  await putScenarioDirectorStateViaApi(baseUrl, scenarioId, directorState);

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const simulation = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.page?.director?.objective_count === 2
      && payload.page?.director?.commitment?.active === true
      && payload.page?.director?.commitment?.branch_title === dominantBranch.title
    ),
    30000,
    "director state simulation readback",
  );
  writeJson(path.join(outputDir, "simulation.json"), simulation);
  await saveScreenshot(page, path.join(outputDir, "simulation.png"));

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const result = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "result"
      && payload.page?.loading === false
      && payload.page?.archive_summary?.dominant_branch_title === dominantBranch.title
      && payload.page?.archive_summary?.commitment_outcome === "hit"
    ),
    40000,
    "director state result readback",
  );
  const archiveCards = await extractResultArchiveCards(page);
  writeJson(path.join(outputDir, "result.json"), result);
  writeJson(path.join(outputDir, "archive-cards.json"), archiveCards);
  await saveScreenshot(page, path.join(outputDir, "result.png"));

  const directorGoalsCard = archiveCards.find((card) => /director goals|导演目标/i.test(card.label ?? ""));
  const commitmentCard = archiveCards.find((card) => /worldline commitment|世界线承诺/i.test(card.label ?? ""));

  return {
    scenarioId,
    dominantBranchTitle: dominantBranch.title,
    simulationDirector: simulation.page?.director ?? null,
    resultArchiveSummary: result.page?.archive_summary ?? null,
    directorGoalsCard: directorGoalsCard ?? null,
    commitmentCard: commitmentCard ?? null,
  };
}

async function runGameplayStateRoundtripCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  const gameplayState = {
    cards: {
      usage_log: [
        {
          card_id: "public_hearing",
          profile_id: "governance",
          branch_id: "gameplay-branch-1",
          branch_title: "算法接管",
          round: 1,
          cost: 1,
          directive: "Force a public audit trail for the ruling stack.",
          used_at: "2026-03-19T02:00:00Z",
        },
        {
          card_id: "public_hearing",
          profile_id: "governance",
          branch_id: "gameplay-branch-1",
          branch_title: "算法接管",
          round: 2,
          cost: 1,
          directive: "Re-open the legality hearing before emergency powers expand.",
          used_at: "2026-03-19T02:01:00Z",
        },
        {
          card_id: "audit_reckoning",
          profile_id: "governance",
          branch_id: "gameplay-branch-1",
          branch_title: "算法接管",
          round: 3,
          cost: 1,
          directive: "Trigger a full audit against exception chains.",
          used_at: "2026-03-19T02:02:00Z",
        },
      ],
    },
    betting: {
      bets: [
        {
          bet_id: "bet-1",
          kind: "branch_winner",
          target_id: "gameplay-branch-1",
          target_label: "算法接管",
          confidence: 0.78,
          user_name: "E2E Bet One",
          placed_at_round: 2,
          placed_at: "2026-03-19T02:01:30Z",
          resolved: false,
        },
        {
          bet_id: "bet-2",
          kind: "ending_tone",
          target_id: "order",
          target_label: "秩序整合",
          confidence: 0.64,
          user_name: "E2E Bet Two",
          placed_at_round: 3,
          placed_at: "2026-03-19T02:02:30Z",
          resolved: false,
        },
      ],
    },
    archive: {
      key_moments: [
        "Round 1 public oversight opens.",
        "Round 3 audit reckoning lands.",
      ],
      branch_snapshots: [
        {
          branch_id: "gameplay-branch-1",
          title: "算法接管",
          probability: 0.72,
        },
        {
          branch_id: "gameplay-branch-2",
          title: "法庭回摆",
          probability: 0.28,
        },
      ],
    },
  };

  await putScenarioGameplayStateViaApi(baseUrl, scenarioId, gameplayState);

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const simulation = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.page?.director?.system_tracks?.risk_value === 1
      && payload.page?.director?.system_tracks?.resource_value === 3
      && payload.page?.betting?.bet_count === 2
      && payload.page?.betting?.key_moment_count >= 2
    ),
    30000,
    "gameplay state simulation readback",
  );
  writeJson(path.join(outputDir, "simulation.json"), simulation);
  await saveScreenshot(page, path.join(outputDir, "simulation.png"));

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const result = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "result"
      && payload.page?.loading === false
      && payload.page?.archive_summary?.most_used_card === "public_hearing"
      && payload.page?.archive_summary?.counterplay_card_count === 3
      && payload.page?.archive_summary?.last_counterplay_card === "audit_reckoning"
      && (payload.page?.result_bet_list?.length ?? 0) === 2
      && (payload.page?.result_key_moments?.length ?? 0) >= 2
      && (payload.page?.result_branch_snapshots?.length ?? 0) >= 2
    ),
    40000,
    "gameplay state result readback",
  );
  const archiveCards = await extractResultArchiveCards(page);
  writeJson(path.join(outputDir, "result.json"), result);
  writeJson(path.join(outputDir, "archive-cards.json"), archiveCards);
  await saveScreenshot(page, path.join(outputDir, "result.png"));

  const mostUsedCard = archiveCards.find((card) => /most used card|最常用玩法卡/i.test(card.label ?? ""));
  const counterplayCard = archiveCards.find((card) => /counterplay|反制轨迹/i.test(card.label ?? ""));

  return {
    scenarioId,
    simulationDirector: simulation.page?.director ?? null,
    simulationBetting: simulation.page?.betting ?? null,
    resultArchiveSummary: result.page?.archive_summary ?? null,
    resultBetList: result.page?.result_bet_list ?? [],
    resultKeyMoments: result.page?.result_key_moments ?? [],
    resultBranchSnapshots: result.page?.result_branch_snapshots ?? [],
    mostUsedCard: mostUsedCard ?? null,
    counterplayCard: counterplayCard ?? null,
  };
}

function getDirectorStateScenarioSample(args) {
  return {
    theme: "governance",
    scenario_id: args.scenarioId || DEFAULT_DIRECTOR_STATE_SCENARIO_ID,
    question: MATRIX_SCENARIO_FALLBACKS.governance.question,
  };
}

async function runDirectorStateBrowserReadback(page, {
  baseUrl,
  scenarioId,
  outputDir,
  browserName,
}) {
  ensureDir(outputDir);

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const simulation = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.page?.director?.objective_count === 2
      && payload.page?.director?.commitment?.active === true
    ),
    30000,
    `${browserName} simulation director state`,
  );
  await saveScreenshot(page, path.join(outputDir, `${browserName}-sim.png`), { fullPage: true });

  await clearOriginStorage(page, baseUrl);
  await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const result = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "result"
      && payload.page?.loading === false
      && payload.page?.archive_summary?.commitment_outcome === "hit"
    ),
    40000,
    `${browserName} result director state`,
  );
  await saveLocatorScreenshot(
    page.locator(".result-archive"),
    path.join(outputDir, `${browserName}-archive.png`),
  );

  const summary = {
    simulationDirector: simulation.page?.director ?? null,
    resultArchiveSummary: result.page?.archive_summary ?? null,
  };
  writeJson(path.join(outputDir, `${browserName}.json`), summary);
  return summary;
}

async function runCrossBrowserDirectorStateSuite(args) {
  const browsers = args.browsers.length > 0
    ? args.browsers
    : ["firefox", "webkit"];
  const supportedBrowsers = browsers.filter((browserName) => ["firefox", "webkit"].includes(browserName));
  if (supportedBrowsers.length === 0) {
    throw new Error("cross-browser mode requires at least one of: firefox, webkit");
  }

  const sample = await resolveMatrixScenario(args.baseUrl, getDirectorStateScenarioSample(args));
  const runs = {};

  for (const browserName of supportedBrowsers) {
    const { browser, launchProfile } = await launchBrowser(args.headless, browserName);
    writeJson(path.join(args.outputDir, `${browserName}-browser-launch.json`), launchProfile);
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    try {
      runs[browserName] = await runDirectorStateBrowserReadback(page, {
        baseUrl: args.baseUrl,
        scenarioId: sample.scenarioId,
        outputDir: args.outputDir,
        browserName,
      });
    } finally {
      await closePlaywrightContext(context, `cross-browser-${browserName}-context`);
      await closePlaywrightBrowser(browser, `cross-browser-${browserName}-browser`);
    }
  }

  return {
    mode: "cross-browser",
    scenarioId: sample.scenarioId,
    requestedScenarioId: sample.requestedScenarioId,
    browsers: runs,
  };
}

async function wdRequest(webdriverUrl, pathname, init) {
  const response = await fetch(`${webdriverUrl}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`WebDriver ${response.status}: ${text}`);
  }
  if (data?.value?.error) {
    throw new Error(`WebDriver session error: ${data.value.message || data.value.error}`);
  }
  return data?.value;
}

async function createSafariSession(webdriverUrl) {
  const value = await wdRequest(webdriverUrl, "/session", {
    method: "POST",
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: {
          browserName: "safari",
          "safari:automaticInspection": false,
        },
      },
    }),
  });
  return {
    sessionId: value.sessionId || value["sessionId"] || value.capabilities?.sessionId || null,
    capabilities: value.capabilities ?? null,
  };
}

async function deleteSafariSession(webdriverUrl, sessionId) {
  try {
    await fetch(`${webdriverUrl}/session/${sessionId}`, { method: "DELETE" });
  } catch {
    // Ignore cleanup failures.
  }
}

async function executeSafariScript(webdriverUrl, sessionId, script, args = []) {
  return wdRequest(webdriverUrl, `/session/${sessionId}/execute/sync`, {
    method: "POST",
    body: JSON.stringify({ script, args }),
  });
}

async function executeSafariAsyncScript(webdriverUrl, sessionId, script, args = []) {
  return wdRequest(webdriverUrl, `/session/${sessionId}/execute/async`, {
    method: "POST",
    body: JSON.stringify({ script, args }),
  });
}

async function navigateSafari(webdriverUrl, sessionId, url) {
  await wdRequest(webdriverUrl, `/session/${sessionId}/url`, {
    method: "POST",
    body: JSON.stringify({ url }),
  });
}

async function saveSafariSessionScreenshot(webdriverUrl, sessionId, filePath) {
  const base64 = await wdRequest(webdriverUrl, `/session/${sessionId}/screenshot`, { method: "GET" });
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
}

async function saveSafariPanelScreenshot(webdriverUrl, sessionId, filePath) {
  try {
    const dataUrl = await executeSafariAsyncScript(
      webdriverUrl,
      sessionId,
      `
        const done = arguments[arguments.length - 1];
        if (typeof window.capture_game_screenshot !== 'function') {
          done(null);
          return;
        }
        window.capture_game_screenshot('panel')
          .then((value) => done(value))
          .catch(() => done(null));
      `,
    );

    if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      writeDataUrlFile(filePath, dataUrl);
      return true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[safari] panel capture fallback for ${path.basename(filePath)}: ${message}`);
  }
  return false;
}

async function clearSafariOriginStorage(webdriverUrl, sessionId, baseUrl) {
  await navigateSafari(webdriverUrl, sessionId, baseUrl);
  await executeSafariScript(
    webdriverUrl,
    sessionId,
    `
      window.localStorage.clear();
      window.sessionStorage.clear();
      return true;
    `,
  );
}

async function waitForSafariAutomation(webdriverUrl, sessionId, predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const raw = await executeSafariScript(
      webdriverUrl,
      sessionId,
      "return window.render_game_to_text ? window.render_game_to_text() : null;",
    );
    const payload = raw ? JSON.parse(raw) : null;
    if (payload && predicate(payload)) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runSafariDirectorStateSuite(args) {
  const sample = await resolveMatrixScenario(args.baseUrl, getDirectorStateScenarioSample(args));
  const created = await createSafariSession(args.webdriverUrl);
  const sessionId = created.sessionId;
  if (!sessionId) {
    throw new Error("Safari WebDriver did not return a session id");
  }

  try {
    await clearSafariOriginStorage(args.webdriverUrl, sessionId, args.baseUrl);
    await navigateSafari(args.webdriverUrl, sessionId, `${args.baseUrl}/sim/${sample.scenarioId}`);
    const simulation = await waitForSafariAutomation(
      args.webdriverUrl,
      sessionId,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.page?.director?.objective_count === 2
        && payload.page?.director?.commitment?.active === true
      ),
      30000,
      "Safari simulation director state",
    );
    if (
      !SAFARI_PANEL_CAPTURE_ENABLED
      || !(await saveSafariPanelScreenshot(
        args.webdriverUrl,
        sessionId,
        path.join(args.outputDir, "safari-sim.png"),
      ))
    ) {
      await saveSafariSessionScreenshot(
        args.webdriverUrl,
        sessionId,
        path.join(args.outputDir, "safari-sim.png"),
      );
    }

    await clearSafariOriginStorage(args.webdriverUrl, sessionId, args.baseUrl);
    await navigateSafari(args.webdriverUrl, sessionId, `${args.baseUrl}/result/${sample.scenarioId}`);
    const result = await waitForSafariAutomation(
      args.webdriverUrl,
      sessionId,
      (payload) => (
        payload.page?.kind === "result"
        && payload.page?.loading === false
        && payload.page?.archive_summary?.commitment_outcome === "hit"
      ),
      40000,
      "Safari result director state",
    );
    await executeSafariScript(
      args.webdriverUrl,
      sessionId,
      `
        const archive = document.querySelector('.result-archive');
        if (archive) archive.scrollIntoView({ block: 'start' });
        return true;
      `,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    await saveSafariSessionScreenshot(
      args.webdriverUrl,
      sessionId,
      path.join(args.outputDir, "safari-result.png"),
    );

    return {
      mode: "safari",
      scenarioId: sample.scenarioId,
      requestedScenarioId: sample.requestedScenarioId,
      webdriverUrl: args.webdriverUrl,
      capabilities: created.capabilities,
      simulationDirector: simulation.page?.director ?? null,
      resultArchiveSummary: result.page?.archive_summary ?? null,
    };
  } finally {
    await deleteSafariSession(args.webdriverUrl, sessionId);
  }
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
    rounds: FIXTURE_MODE ? 5 : 3,
    numAgents: 3,
    visualizationEnabled: false,
  });

  await gotoWithRetry(page, `${baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
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
  await page.waitForSelector("#pred-kind", { timeout: 10000 });

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
    rounds: FIXTURE_MODE ? 5 : 3,
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

  await gotoWithRetry(page, `${baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
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
  await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
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
  let replayModeTriggered = false;
  if (branchOptions > 1) {
    const targetBranch = await branchSelect.locator('option').nth(1).getAttribute('value');
    if (targetBranch) {
      await branchSelect.selectOption(targetBranch);
      replayModeTriggered = true;
    }
  }

  const roundButtons = page.locator('button[aria-label^=\"Jump to replay round\"]');
  const roundButtonCount = await roundButtons.count();
  if (roundButtonCount > 1) {
    await roundButtons.nth(roundButtonCount - 1).click();
    replayModeTriggered = true;
  }

  if (!replayModeTriggered) {
    await page.getByRole("button", { name: /重播|Replay/ }).click();
  }

  const replayed = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.replay_state?.playback_mode === "replay"
      && payload.page?.replay_state?.theater_ready === true
    ),
    15000,
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

async function runReplaySpeedSwitchCase(page, {
  baseUrl,
  scenarioId,
  outputDir,
}) {
  ensureDir(outputDir);
  await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });

  const baseline = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.page?.replay_state?.available === true
    ),
    30000,
    "replay speed replay-ready baseline",
  );

  if (baseline.simulation?.viewMode !== "theater") {
    const theaterToggle = page.locator(".view-mode-toggle");
    if (await theaterToggle.count() === 0) {
      throw new Error(`Replay speed baseline could not find the theater toggle for ${scenarioId}`);
    }
    await theaterToggle.first().click();
  }

  const initial = await waitForAutomation(
    page,
    (payload) => (
      payload.page?.kind === "simulation"
      && payload.page?.replay_state?.available === true
      && isCompletedReplayTheaterReady(payload)
      && payload.simulation?.viewMode === "theater"
    ),
    20000,
    "replay speed baseline",
  );

  const before = await page.evaluate(() => {
    const raw = window.render_game_to_text?.() ?? null;
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    const canvas = document.querySelector("canvas");
    window.__swarmReplaySpeedCanvas = canvas;
    return {
      replayState: payload?.page?.replay_state ?? null,
      scene: payload?.scene ?? null,
      hasCanvas: Boolean(canvas),
      sameCanvas: true,
    };
  });

  if (!before.hasCanvas || typeof before.replayState?.replay_speed !== "number") {
    throw new Error(`Replay speed baseline missing canvas or replay state for ${scenarioId}`);
  }

  const speedButton = page.locator("button").filter({ hasText: "⚡" }).first();
  if (await speedButton.count() === 0) {
    throw new Error(`Replay speed button not found for ${scenarioId}`);
  }

  await speedButton.click();
  const expectedReplaySpeed = before.replayState.replay_speed === 1 ? 2 : 1;

  await waitForAutomation(
    page,
    (payload) => payload.page?.replay_state?.replay_speed === expectedReplaySpeed,
    10000,
    "replay speed switch",
  );

  await advanceAutomationTime(page, 400);
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => {
    const raw = window.render_game_to_text?.() ?? null;
    const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
    const canvas = document.querySelector("canvas");
    return {
      replayState: payload?.page?.replay_state ?? null,
      scene: payload?.scene ?? null,
      hasCanvas: Boolean(canvas),
      sameCanvas: window.__swarmReplaySpeedCanvas === canvas,
    };
  });

  if (!after.hasCanvas || after.sameCanvas !== true) {
    throw new Error(`Replay speed switch remounted or lost the canvas for ${scenarioId}`);
  }
  if (after.scene?.scene !== before.scene?.scene) {
    throw new Error(
      `Replay speed switch unexpectedly changed scene for ${scenarioId}: ${before.scene?.scene} -> ${after.scene?.scene}`,
    );
  }

  writeJson(path.join(outputDir, "replay-speed-switch.json"), { before, after });
  await saveScreenshot(page, path.join(outputDir, "replay-speed-switch.png"));

  return {
    before: before.replayState ?? null,
    after: after.replayState ?? null,
    sameCanvas: after.sameCanvas,
    scene: after.scene?.scene ?? null,
  };
}

async function runLiveForkMarkerFixtureCase(page, {
  baseUrl,
  outputDir,
}) {
  ensureDir(outputDir);

  const scenarioId = "fixture-live-fork-marker";
  const rootBranchId = "fixture-root";
  const childBranchId = "fixture-child-r1";
  const rootBranchTitle = "历史拐点";
  const childBranchTitle = "R1 分裂支线";

  const scenarioPayload = {
    id: scenarioId,
    question: "如果每一项重大决策都必须交给轮值外部评审团重新裁决，会发生什么？",
    status: "simulating",
    created_at: new Date().toISOString(),
    total_rounds: 3,
    mode: "blackboard",
    agents: [
      { id: "fixture-agent-1", name: "外审议长", role: "裁决者", tier: "CORE", emotion: "focused" },
    ],
    branches: [
      {
        id: rootBranchId,
        parent_branch_id: null,
        fork_round: 0,
        fork_reason: "",
        title: rootBranchTitle,
        description: "",
        summary: "",
        story: "",
        insight: "",
        key_moments: [],
        probability: 1,
        status: "ACTIVE",
      },
    ],
    groups: [],
    hierarchical: false,
    messages: [],
    visualization_enabled: true,
    scene_theme: "law_court_variant",
    director_state: {
      revision: 0,
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
    gameplay_state: {
      revision: 0,
      cards: { usage_log: [] },
      betting: { bets: [] },
      archive: { key_moments: [], branch_snapshots: [] },
    },
    fork_debug: null,
  };

  const directorStatePayload = {
    scenario_id: scenarioId,
    revision: 0,
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
  };

  const gameplayStatePayload = {
    scenario_id: scenarioId,
    revision: 0,
    cards: { usage_log: [] },
    betting: { bets: [] },
    archive: { key_moments: [], branch_snapshots: [] },
  };

  const scenarioRoutePattern = `**/api/scenario/${scenarioId}`;
  const directorRoutePattern = `**/api/campaign/scenario/${scenarioId}/director-state`;
  const gameplayRoutePattern = `**/api/campaign/scenario/${scenarioId}/gameplay-state`;

  await page.addInitScript(({ fixtureScenarioId, fixtureRootBranchId, fixtureChildBranchId, fixtureRootBranchTitle, fixtureChildBranchTitle }) => {
    const NativeWebSocket = window.WebSocket;

    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url, protocols) {
        this.url = String(url);
        this.protocol = "";
        this.extensions = "";
        this.readyState = FixtureWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.binaryType = "blob";
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this._listeners = new Map();
        this._timers = [];

        if (!this.url.endsWith(`/ws/scenario/${fixtureScenarioId}`)) {
          return new NativeWebSocket(url, protocols);
        }

        this._schedule(() => {
          this.readyState = FixtureWebSocket.OPEN;
          this._emit("open", new Event("open"));
        }, 20);

        const events = [
          {
            type: "status",
            data: { status: "simulating", hierarchical: false },
          },
          {
            type: "agent_speak_start",
            data: {
              agent: "外审议长",
              agent_id: "fixture-agent-1",
              branch: fixtureRootBranchId,
              round: 1,
            },
          },
          {
            type: "agent_speak",
            data: {
              agent: "外审议长",
              agent_id: "fixture-agent-1",
              message: "把最终裁决权交给外审，会立刻分裂出不同制度轨道。",
              emotion: "focused",
              branch: fixtureRootBranchId,
              round: 1,
            },
          },
          {
            type: "round_summary",
            data: {
              branch_id: fixtureRootBranchId,
              round: 1,
              summary: "Round 1 complete, 1 message",
            },
          },
          {
            type: "branch_fork",
            data: {
              parent: fixtureRootBranchId,
              reason: "外部评审团是否拥有最终裁决权，导致世界线在 R1 分裂。",
              children: [
                {
                  id: fixtureChildBranchId,
                  title: fixtureChildBranchTitle,
                  description: "R1 forced fork child",
                  fork_round: 1,
                  probability: 0.42,
                },
              ],
            },
          },
          {
            type: "simulation_done",
          },
        ];
        const eventDelays = [60, 180, 480, 660, 840, 1020];

        events.forEach((payload, index) => {
          this._schedule(() => {
            if (this.readyState !== FixtureWebSocket.OPEN) return;
            this._emit(
              "message",
              new MessageEvent("message", {
                data: JSON.stringify({
                  ...payload,
                  meta: {
                    stream_id: fixtureScenarioId,
                    sequence: index + 1,
                    event_id: `${fixtureScenarioId}:${index + 1}`,
                    manager_instance_id: "fixture-live-fork",
                    emitted_at: new Date().toISOString(),
                  },
                }),
              }),
            );
          }, eventDelays[index] ?? (180 * (index + 1)));
        });
      }

      _schedule(fn, delay) {
        const timer = window.setTimeout(fn, delay);
        this._timers.push(timer);
      }

      _emit(type, event) {
        const handler = this[`on${type}`];
        if (typeof handler === "function") {
          handler.call(this, event);
        }
        const listeners = this._listeners.get(type) || [];
        for (const listener of listeners) {
          listener.call(this, event);
        }
      }

      addEventListener(type, listener) {
        const list = this._listeners.get(type) || [];
        list.push(listener);
        this._listeners.set(type, list);
      }

      removeEventListener(type, listener) {
        const list = this._listeners.get(type) || [];
        this._listeners.set(type, list.filter((entry) => entry !== listener));
      }

      send() {}

      close(code = 1000, reason = "fixture closed") {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSING;
        for (const timer of this._timers) {
          window.clearTimeout(timer);
        }
        this._timers = [];
        this.readyState = FixtureWebSocket.CLOSED;
        this._emit("close", new CloseEvent("close", { code, reason, wasClean: true }));
      }
    }

    window.WebSocket = FixtureWebSocket;
  }, {
    fixtureScenarioId: scenarioId,
    fixtureRootBranchId: rootBranchId,
    fixtureChildBranchId: childBranchId,
    fixtureRootBranchTitle: rootBranchTitle,
    fixtureChildBranchTitle: childBranchTitle,
  });

  await page.route(scenarioRoutePattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenarioPayload),
    });
  });

  await page.route(directorRoutePattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(directorStatePayload),
    });
  });

  await page.route(gameplayRoutePattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(gameplayStatePayload),
    });
  });

  try {
    await gotoWithRetry(page, `${baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
    const thinkingState = await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.simulation?.thinkingAgentCount === 1
        && Array.isArray(payload.simulation?.thinkingAgents)
        && payload.simulation.thinkingAgents[0]?.agent_id === "fixture-agent-1"
      ),
      10000,
      "live fork fixture thinking state",
    );
    writeJson(path.join(outputDir, "live-fork-marker-thinking.json"), thinkingState);
    await saveScreenshot(page, path.join(outputDir, "live-fork-marker-thinking.png"));

    const fixtureState = await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.simulation?.currentRound === 1
        && payload.simulation?.isSimulationComplete === true
        && payload.page?.replay_state?.available === true
        && payload.page?.branches?.some((branch) => branch.id === childBranchId)
      ),
      15000,
      "live fork fixture state",
    );

    const roundOneMarker = page.locator('.timeline-round[title="R1 · fork 1"]');
    await roundOneMarker.waitFor({ state: "visible", timeout: 10000 });
    const roundTwoMarkerCount = await page.locator('.timeline-round[title="R2 · fork 1"]').count();

    const markerTitles = await page.locator('.timeline-round[title]').evaluateAll((nodes) => (
      nodes.map((node) => ({
        title: node.getAttribute("title") || "",
        text: node.textContent?.replace(/\s+/g, " ").trim() || "",
      }))
    ));

    writeJson(path.join(outputDir, "live-fork-marker.json"), {
      fixtureState,
      markerTitles,
    });
    await saveScreenshot(page, path.join(outputDir, "live-fork-marker.png"));

    return {
      scenarioId,
      thinkingState: {
        thinkingAgentCount: thinkingState.simulation?.thinkingAgentCount ?? null,
        thinkingAgents: thinkingState.simulation?.thinkingAgents ?? [],
      },
      currentRound: fixtureState.simulation?.currentRound ?? null,
      branchCount: fixtureState.simulation?.branchCount ?? null,
      replayState: fixtureState.page?.replay_state ?? null,
      roundOneMarkerVisible: true,
      roundTwoMarkerCount,
      markerTitles,
    };
  } finally {
    await page.unroute(scenarioRoutePattern);
    await page.unroute(directorRoutePattern);
    await page.unroute(gameplayRoutePattern);
  }
}

async function runCaptureModesCase(page, {
  baseUrl,
  outputDir,
  question,
}) {
  ensureDir(outputDir);
  const scenario = await createScenarioViaApi(baseUrl, {
    question,
    // Keep this case in a live, capture-ready theater state long enough for
    // prediction/gameplay modal probes before the scenario auto-completes.
    rounds: FIXTURE_MODE ? 4 : 2,
    numAgents: 3,
    visualizationEnabled: true,
  });

  await gotoWithRetry(page, `${baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation",
    60000,
    "capture simulation shell",
  );

  const settleStart = Date.now();
  let simulation = null;
  while (Date.now() - settleStart < 30000) {
    await advanceAutomationTime(page, 500);
    simulation = await readAutomation(page);
    if (
      simulation?.page?.kind === "simulation"
      && simulation.page?.controls?.can_open_prediction
      && simulation.page?.controls?.can_preview_gameplay_cards
      && simulation.scene?.scene
      && simulation.scene.scene !== "BootScene"
      && simulation.scene.scene !== "TitleScene"
    ) {
      break;
    }
    await page.waitForTimeout(250);
  }

  if (
    simulation?.page?.kind !== "simulation"
    || !simulation.page?.controls?.can_open_prediction
    || !simulation.page?.controls?.can_preview_gameplay_cards
    || !simulation.scene?.scene
    || simulation.scene.scene === "BootScene"
    || simulation.scene.scene === "TitleScene"
  ) {
    throw new Error(`Timed out waiting for capture-ready Theater scene for ${scenario.id}`);
  }

  const beforeOpen = await page.evaluate(async () => ({
    panel: await window.capture_game_screenshot?.("panel") ?? null,
    canvas: await window.capture_game_screenshot?.("canvas") ?? null,
    modal: await window.capture_game_screenshot?.("modal") ?? null,
    automation: window.render_game_to_text?.() ?? null,
  }));

  if (!beforeOpen.panel || !beforeOpen.canvas || beforeOpen.modal !== null) {
    throw new Error(`Capture hooks did not return expected panel/canvas/modal values for ${scenario.id}`);
  }

  writeDataUrlFile(path.join(outputDir, "panel.png"), beforeOpen.panel);
  writeDataUrlFile(path.join(outputDir, "canvas.png"), beforeOpen.canvas);

  await page.getByRole("button", { name: /预测|predict/i }).click();
  const predictionOpen = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "prediction",
    10000,
    "prediction modal for capture",
  );
  await advanceAutomationTime(page, 250);
  await page.waitForTimeout(300);
  const predictionModalShot = await captureGameScreenshotWithRetry(page, "modal");

  if (!predictionModalShot) {
    throw new Error(`Modal capture returned null after opening prediction modal for ${scenario.id}`);
  }

  writeDataUrlFile(path.join(outputDir, "prediction-modal.png"), predictionModalShot);
  await saveScreenshot(page, path.join(outputDir, "prediction-modal-open.png"));
  writeJson(path.join(outputDir, "prediction-modal-open.json"), predictionOpen);

  await page.keyboard.press("Escape");
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === null,
    10000,
    "prediction modal close",
  );

  await page.getByRole("button", { name: /Gameplay Cards|玩法卡/i }).click();
  const gameplayOpen = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "gameplay_cards",
    10000,
    "gameplay cards modal for capture",
  );
  await advanceAutomationTime(page, 250);
  await page.waitForTimeout(300);
  const gameplayModalShot = await captureGameScreenshotWithRetry(page, "modal");

  if (!gameplayModalShot) {
    throw new Error(`Modal capture returned null after opening gameplay cards modal for ${scenario.id}`);
  }

  writeDataUrlFile(path.join(outputDir, "gameplay-modal.png"), gameplayModalShot);
  await saveScreenshot(page, path.join(outputDir, "gameplay-modal-open.png"));
  writeJson(path.join(outputDir, "gameplay-modal-open.json"), gameplayOpen);
  await saveScreenshot(page, path.join(outputDir, "capture-ui.png"));
  writeJson(path.join(outputDir, "capture-modes.json"), {
    scenarioId: scenario.id,
    beforeOpen: {
      panelBytes: getDataUrlByteLength(beforeOpen.panel),
      canvasBytes: getDataUrlByteLength(beforeOpen.canvas),
      modal: beforeOpen.modal,
      automation: beforeOpen.automation ? JSON.parse(beforeOpen.automation) : null,
    },
    predictionModal: {
      modalBytes: getDataUrlByteLength(predictionModalShot),
      controls: predictionOpen.page?.controls ?? null,
    },
    gameplayModal: {
      modalBytes: getDataUrlByteLength(gameplayModalShot),
      controls: gameplayOpen.page?.controls ?? null,
    },
  });

  return {
    scenarioId: scenario.id,
    panelBytes: getDataUrlByteLength(beforeOpen.panel),
    canvasBytes: getDataUrlByteLength(beforeOpen.canvas),
    predictionModalBytes: getDataUrlByteLength(predictionModalShot),
    gameplayModalBytes: getDataUrlByteLength(gameplayModalShot),
    activeModal: gameplayOpen.page?.controls?.active_modal ?? null,
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
    await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
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
  const result = await runResultFlow(page, {
    baseUrl,
    scenarioId,
    outputDir,
    shareCopyOverride: {
      copy: "用于 share-context 回归的稳定小红书文案。",
      platform_name: "小红书",
    },
  });
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
  let attemptCount = 0;
  const routePattern = `**/api/scenario/${scenarioId}/social/xiaohongshu`;
  await page.route(routePattern, async (route) => {
    attemptCount += 1;
    if (attemptCount === 1) {
      await route.fulfill({
        status: 500,
        contentType: "text/plain",
        body: "forced share failure",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        copy: "恢复后的分享文案：这一轮重试已经成功，最危险的转折点也被重新钉住。",
        platform_name: "小红书",
      }),
    });
  });

  await gotoWithRetry(page, `${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
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
    SHARE_COPY_WAIT_TIMEOUT_MS,
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
  await gotoWithRetry(page, `${baseUrl}/history`, { waitUntil: "domcontentloaded" });
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

  await gotoWithRetry(page, `${baseUrl}/leaderboard`, { waitUntil: "domcontentloaded" });
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
    await gotoWithRetry(page, `${baseUrl}/history`, { waitUntil: "domcontentloaded" });
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
    await page.locator(".history-delete-modal").waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);

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
      const sampleDir = path.join(args.outputDir, sample.theme);
      const replayDir = path.join(sampleDir, "replay");
      const replayShot = path.join(sampleDir, "replay.png");
      const resultDir = path.join(sampleDir, "result");
      ensureDir(sampleDir);
      let page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      console.log(`[matrix] starting ${sample.theme}`);
      try {
        let resolvedScenario = await resolveMatrixScenario(args.baseUrl, sample);
        let replay;
        let result;
        let recovery = null;
        const themeMismatchReason = getSceneThemeMismatch(sample, resolvedScenario);
        if (themeMismatchReason) {
          console.warn(
            `[matrix] ${sample.theme} sample ${resolvedScenario.scenarioId} ${themeMismatchReason}; recreating runtime fallback scenario.`,
          );
          resolvedScenario = await createRuntimeMatrixScenario(args.baseUrl, sample);
          if (!page.isClosed()) {
            await page.close().catch(() => {});
          }
          page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
          recovery = {
            fromScenarioId: sample.scenario_id ?? null,
            reason: themeMismatchReason,
            strategy: "runtime_created_fallback",
          };
        }
        try {
          replay = await runReplayFlow(page, {
            baseUrl: args.baseUrl,
            scenarioId: resolvedScenario.scenarioId,
            outputDir: replayDir,
            replayScreenshotPath: replayShot,
          });
          result = await runResultFlow(page, {
            baseUrl: args.baseUrl,
            scenarioId: resolvedScenario.scenarioId,
            outputDir: resultDir,
          });
        } catch (error) {
          if (resolvedScenario.createdAtRuntime) {
            throw error;
          }

          const originalMessage = error instanceof Error ? error.message : String(error);
          console.warn(
            `[matrix] ${sample.theme} sample ${resolvedScenario.scenarioId} failed (${originalMessage}); retrying with a runtime-created fallback scenario.`,
          );
          resolvedScenario = await createRuntimeMatrixScenario(args.baseUrl, sample);
          if (!page.isClosed()) {
            await page.close().catch(() => {});
          }
          page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
          recovery = {
            fromScenarioId: sample.scenario_id ?? null,
            reason: originalMessage,
            strategy: "runtime_created_fallback",
          };

          replay = await runReplayFlow(page, {
            baseUrl: args.baseUrl,
            scenarioId: resolvedScenario.scenarioId,
            outputDir: replayDir,
            replayScreenshotPath: replayShot,
          });
          result = await runResultFlow(page, {
            baseUrl: args.baseUrl,
            scenarioId: resolvedScenario.scenarioId,
            outputDir: resultDir,
          });
        }

        console.log(
          `[matrix] completed ${sample.theme} -> ${resolvedScenario.scenarioId} (${resolvedScenario.createdAtRuntime ? "runtime" : "existing"})`,
        );
        summaries.push({
          theme: sample.theme,
          scenarioId: resolvedScenario.scenarioId,
          requestedScenarioId: resolvedScenario.requestedScenarioId,
          createdAtRuntime: resolvedScenario.createdAtRuntime,
          question: resolvedScenario.question,
          expectedSceneTheme: sample.scene_theme ?? null,
          recovery,
          replay,
          result,
        });
      } finally {
        if (!page.isClosed()) {
          await page.close().catch(() => {});
        }
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
    await closePlaywrightBrowser(browser, "matrix-browser");
  }
}

async function runCornersSuite(args) {
  const { browser, launchProfile } = await launchBrowser(args.headless);
  writeJson(path.join(args.outputDir, "browser-launch.json"), launchProfile);
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  try {
    const outputDir = args.outputDir;
    const cases = {};
    const governanceReplaySample = await resolveMatrixScenario(args.baseUrl, {
      theme: "governance",
      scenario_id: "72ae364d-3ea1-4959-939c-8fe1dbeca1c9",
    });
    const lawShareSampleSeed = {
      theme: "law",
      scenario_id: "ded5cdd5-251d-4606-8ee3-8e1418d31cbb",
    };
    let lawShareSample = await resolveMatrixScenario(args.baseUrl, lawShareSampleSeed);
    lawShareSample = await ensureResultMatrixScenario(page, args.baseUrl, lawShareSampleSeed, lawShareSample);

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

    cases.live_fork_marker = await runLiveForkMarkerFixtureCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "live-fork-marker"),
    });

    cases.replay_skip_switch = await runReplayCornerCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: governanceReplaySample.scenarioId,
      outputDir: path.join(outputDir, "replay-skip-switch"),
    });

    cases.replay_speed_switch = await runReplaySpeedSwitchCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: governanceReplaySample.scenarioId,
      outputDir: path.join(outputDir, "replay-speed-switch"),
    });

    cases.director_state_roundtrip = await runDirectorStateRoundtripCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: governanceReplaySample.scenarioId,
      outputDir: path.join(outputDir, "director-state-roundtrip"),
    });

    cases.gameplay_state_roundtrip = await runGameplayStateRoundtripCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: governanceReplaySample.scenarioId,
      outputDir: path.join(outputDir, "gameplay-state-roundtrip"),
    });

    cases.capture_modes = await runCaptureModesCase(page, {
      baseUrl: args.baseUrl,
      outputDir: path.join(outputDir, "capture-modes"),
      question: "如果算法治理城市的 Theater 推演正在进行，截图面板、画布和预测弹窗会分别呈现什么？",
    });

    cases.share_context = await runShareContextCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: lawShareSample.scenarioId,
      outputDir: path.join(outputDir, "share-context"),
    });

    cases.share_retry = await runShareRetryCase(page, {
      baseUrl: args.baseUrl,
      scenarioId: lawShareSample.scenarioId,
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
    await closePlaywrightBrowser(browser, "corners-browser");
  }
}

async function runMobileSuite(args) {
  const { browser, launchProfile } = await launchBrowser(args.headless);
  writeJson(path.join(args.outputDir, "browser-launch.json"), launchProfile);
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  try {
    const governanceSample = await resolveMatrixScenario(args.baseUrl, {
      theme: "governance",
      scenario_id: "72ae364d-3ea1-4959-939c-8fe1dbeca1c9",
      question: MATRIX_SCENARIO_FALLBACKS.governance.question,
    });

    await gotoWithRetry(page, `${args.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "input",
      10000,
      "mobile homepage",
    );
    await page.waitForFunction(
      () => (
        Boolean(document.querySelector(".daily-challenge-card"))
        && document.querySelectorAll(".weekly-challenge-card").length >= 2
        && Boolean(document.querySelector(".weekly-challenge-card--growth"))
      ),
      { timeout: 10000 },
    );
    const homepageSurface = await page.evaluate(() => ({
      hasDailyChallengeCard: Boolean(document.querySelector(".daily-challenge-card")),
      weeklyChallengeCardCount: document.querySelectorAll(".weekly-challenge-card").length,
      hasGrowthCard: Boolean(document.querySelector(".weekly-challenge-card--growth")),
    }));
    if (!homepageSurface.hasDailyChallengeCard) {
      throw new Error(`mobile homepage missing daily challenge card: ${JSON.stringify(homepageSurface)}`);
    }
    if (homepageSurface.weeklyChallengeCardCount < 2 || !homepageSurface.hasGrowthCard) {
      throw new Error(`mobile homepage missing weekly/growth cards: ${JSON.stringify(homepageSurface)}`);
    }
    const homepage = await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "input"
        && Boolean(payload.page?.daily_challenge?.challenge_id)
        && (payload.page?.daily_challenge?.hook_count ?? 0) >= 1
        && (payload.page?.weekly_challenge?.challenge_count ?? 0) >= 3
        && (payload.page?.weekly_challenge?.entries?.length ?? 0) >= 3
        && payload.page?.director_growth?.badge_count != null
        && payload.page?.director_growth?.total_runs != null
      ),
      10000,
      "mobile homepage summaries",
    );
    if (!homepage.page?.daily_challenge?.challenge_id || homepage.page.daily_challenge.hook_count < 1) {
      throw new Error(`mobile homepage daily challenge summary missing: ${JSON.stringify(homepage.page?.daily_challenge ?? null)}`);
    }
    if ((homepage.page?.weekly_challenge?.challenge_count ?? 0) < 3) {
      throw new Error(`mobile homepage weekly challenge summary missing: ${JSON.stringify(homepage.page?.weekly_challenge ?? null)}`);
    }
    if ((homepage.page?.weekly_challenge?.entries?.length ?? 0) < 3) {
      throw new Error(`mobile homepage weekly challenge entries missing: ${JSON.stringify(homepage.page?.weekly_challenge ?? null)}`);
    }
    if (homepage.page?.director_growth?.badge_count == null || homepage.page?.director_growth?.total_runs == null) {
      throw new Error(`mobile homepage director growth summary missing: ${JSON.stringify(homepage.page?.director_growth ?? null)}`);
    }
    writeJson(path.join(args.outputDir, "mobile-home.json"), homepage);
    writeJson(path.join(args.outputDir, "mobile-home-surface.json"), homepageSurface);
    await saveScreenshot(page, path.join(args.outputDir, "mobile-home.png"));

    await gotoWithRetry(page, `${args.baseUrl}/sim/${governanceSample.scenarioId}`, { waitUntil: "domcontentloaded" });
    await waitForCompletedReplayAutomationReady(page, 20000);
    let theater = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "simulation",
      60000,
      "mobile Theater shell",
    );
    let lastSceneName = theater?.scene?.scene ?? null;
    let mobileTheaterReady = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const settleStart = Date.now();
      while (Date.now() - settleStart < 30000) {
        await advanceAutomationTime(page, 500);
        theater = await readAutomation(page);
        lastSceneName = theater?.scene?.scene ?? null;
        if (
          theater?.page?.kind === "simulation"
          && theater.scene?.scene
          && theater.scene.scene !== "BootScene"
          && theater.scene.scene !== "TitleScene"
          && typeof theater.scene.agent_count === "number"
          && theater.scene.agent_count > 0
        ) {
          mobileTheaterReady = true;
          break;
        }
        await page.waitForTimeout(250);
      }
      if (mobileTheaterReady) break;
      if (attempt < 2) {
        console.warn(`[mobile] scene not ready (last=${lastSceneName ?? "null"}) — retrying with fresh page load`);
        await gotoWithRetry(page, `${args.baseUrl}/sim/${governanceSample.scenarioId}`, { waitUntil: "domcontentloaded" });
        await waitForCompletedReplayAutomationReady(page, 20000);
        theater = await waitForAutomation(
          page,
          (payload) => payload.page?.kind === "simulation",
          60000,
          "mobile Theater shell retry",
        );
      }
    }
    if (
      theater?.page?.kind !== "simulation"
      || !theater.scene?.scene
      || theater.scene.scene === "BootScene"
      || theater.scene.scene === "TitleScene"
      || typeof theater.scene.agent_count !== "number"
      || theater.scene.agent_count <= 0
    ) {
      throw new Error(
        `Timed out waiting for mobile Theater scene for ${governanceSample.scenarioId}; last scene=${lastSceneName ?? "null"}, agent_count=${theater?.scene?.agent_count ?? "null"}`,
      );
    }
    writeJson(path.join(args.outputDir, "mobile-theater.json"), theater);
    await saveScreenshot(page, path.join(args.outputDir, "mobile-theater.png"));

    await gotoWithRetry(page, `${args.baseUrl}/result/${governanceSample.scenarioId}`, { waitUntil: "domcontentloaded" });
    const result = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
      40000,
      "mobile result",
    );
    writeJson(path.join(args.outputDir, "mobile-result.json"), result);
    await saveScreenshot(page, path.join(args.outputDir, "mobile-result.png"));

    return {
      mode: "mobile",
      launchProfile,
      scenarioId: governanceSample.scenarioId,
      homepage: {
        ...(homepage.page ?? {}),
        surface: homepageSurface,
      },
      theater: {
        replayState: theater.page?.replay_state ?? null,
        scene: theater.scene ?? null,
      },
      result: result.page ?? null,
    };
  } finally {
    await closePlaywrightBrowser(browser, "mobile-browser");
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
  } else if (args.mode === "mobile") {
    result = await runMobileSuite(args);
  } else if (args.mode === "cross-browser") {
    result = await runCrossBrowserDirectorStateSuite(args);
  } else if (args.mode === "safari") {
    result = await runSafariDirectorStateSuite(args);
  } else {
    const matrixDir = path.join(outputDir, "matrix");
    const cornersDir = path.join(outputDir, "corners");
    const mobileDir = path.join(outputDir, "mobile");
    ensureDir(matrixDir);
    ensureDir(cornersDir);
    ensureDir(mobileDir);
    result = {
      mode: "full",
      matrix: await runMatrixSuite({ ...args, outputDir: matrixDir }),
      corners: await runCornersSuite({ ...args, outputDir: cornersDir }),
      mobile: await runMobileSuite({ ...args, outputDir: mobileDir }),
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
