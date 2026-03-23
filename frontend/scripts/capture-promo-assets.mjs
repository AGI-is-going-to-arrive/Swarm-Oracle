import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const VIDEO_ROOT = path.join(REPO_ROOT, "video");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const LANGUAGE_STORAGE_KEY = "swarmoracle:language:v1";
const DEFAULT_VIEWPORT = { width: 1600, height: 900 };

const PASS_CONFIG = {
  zh: {
    versionName: "swarmoracle-promo-v1.zh",
    locale: "zh",
    question: "如果所有法院都必须公开解释每一次紧急禁令，制度会更稳吗？",
    debateQuestion: "如果所有法院都必须公开解释每一次紧急禁令，制度会更稳吗？",
  },
  en: {
    versionName: "swarmoracle-promo-v1.en",
    locale: "en",
    question: "Would the system become more stable if every court had to publicly justify each emergency injunction?",
    debateQuestion: "Should every emergency court injunction be publicly justified in full detail?",
  },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const args = {
    language: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    headless: true,
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--headed") {
      args.headless = false;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["zh", "en"].includes(args.language)) {
    throw new Error("Usage: node scripts/capture-promo-assets.mjs <zh|en> [--url URL] [--headed]");
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

  if (headless) {
    candidates.push(
      {
        id: "chrome-channel-headed-fallback",
        options: { channel: "chrome", headless: false },
      },
      {
        id: "chromium-headed-fallback",
        options: { headless: false },
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

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function waitForAutomation(page, predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const payload = await readAutomation(page);
    if (payload && predicate(payload)) {
      return payload;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function captureHookScreenshot(page, mode) {
  return page.evaluate(async (requestedMode) => {
    if (typeof window.capture_game_screenshot !== "function") return null;
    return window.capture_game_screenshot(requestedMode);
  }, mode);
}

function writeDataUrlFile(filePath, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new Error(`Expected data URL for ${filePath}`);
  }
  const [, base64 = ""] = dataUrl.split(",", 2);
  fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
}

async function saveScreenshot(page, filePath) {
  ensureDir(path.dirname(filePath));
  await page.screenshot({
    path: filePath,
    type: "png",
    scale: "css",
  });
}

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((el, nextValue) => {
    el.value = String(nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function createScenarioViaApi(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: payload.question,
      rounds: payload.rounds,
      num_agents: payload.numAgents,
      mode: payload.mode ?? "blackboard",
      visualization_enabled: Boolean(payload.visualizationEnabled),
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
    throw new Error(`Failed to fetch scenario ${scenarioId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForScenarioStatus(baseUrl, scenarioId, predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scenario = await getScenarioViaApi(baseUrl, scenarioId);
    if (scenario.status === "error") {
      throw new Error(`Scenario ${scenarioId} entered error state while waiting for ${label}`);
    }
    if (predicate(scenario)) return scenario;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label} on scenario ${scenarioId}`);
}

async function createDebateViaApi(baseUrl, payload) {
  const response = await fetch(`${baseUrl}/api/debate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: payload.question,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create debate: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getDebateViaApi(baseUrl, debateId) {
  const response = await fetch(`${baseUrl}/api/debate/${debateId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch debate ${debateId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForDebateResult(baseUrl, debateId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const debate = await getDebateViaApi(baseUrl, debateId);
    if (debate.status === "error") {
      throw new Error(`Debate ${debateId} entered error state before result`);
    }
    if (debate.result_ready || debate.status === "done") {
      return debate;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for debate result ${debateId}`);
}

async function withPage(browser, locale, runner) {
  const context = await browser.newContext({ viewport: DEFAULT_VIEWPORT });
  await context.addInitScript(({ languageStorageKey, language }) => {
    window.localStorage.setItem(languageStorageKey, language);
  }, { languageStorageKey: LANGUAGE_STORAGE_KEY, language: locale });
  const page = await context.newPage();
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
  await context.addInitScript(({ languageStorageKey, language }) => {
    window.localStorage.setItem(languageStorageKey, language);
  }, { languageStorageKey: LANGUAGE_STORAGE_KEY, language: locale });
  const page = await context.newPage();
  const video = page.video();
  try {
    const result = await runner(page);
    return { result, video, context };
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
    "3",
    "-i",
    inputPath,
    "-vf",
    "fps=12,scale=960:-1:flags=lanczos",
    "-loop",
    "0",
    outputPath,
  ]);
}

async function captureHookClip(browser, config, paths) {
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(page, (payload) => payload.page?.kind === "input", 15_000, "input page");
    await page.locator("textarea.input--hero").fill(config.question);
    await setRangeValue(page, "input.rounds-slider", 3);
    await setRangeValue(page, "input.agents-slider", 3);
    await saveScreenshot(page, paths.screenshots.hook);
    await page.waitForTimeout(1_000);
    await page.locator(".input-view__submit-row .btn.btn-primary").click();
    await page.waitForURL(/\/sim\//, { timeout: 20_000 });
    await page.waitForTimeout(1_500);
    return { scenarioId: page.url().split("/").pop() ?? null };
  });
  await finalizeRecordedPage(recording, paths.raw.hook);
  return recording.result;
}

async function captureSimulationClip(browser, config, paths) {
  const scenario = await createScenarioViaApi(config.baseUrl, {
    question: config.question,
    rounds: 2,
    numAgents: 4,
    visualizationEnabled: false,
  });
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
    const payload = await waitForAutomation(
      page,
      (state) => state.page?.kind === "simulation" && state.simulation?.viewMode === "classic",
      20_000,
      "classic simulation view",
    );
    await page.waitForTimeout(4_000);
    await saveScreenshot(page, paths.screenshots.simulation);
    await page.waitForTimeout(2_500);
    return {
      scenarioId: scenario.id,
      simulation: payload.simulation ?? null,
    };
  });
  await finalizeRecordedPage(recording, paths.raw.simulation);
  return recording.result;
}

async function ensureTheaterView(page) {
  const automation = await readAutomation(page);
  if (automation?.simulation?.viewMode === "theater") {
    return automation;
  }
  await page.locator(".view-mode-toggle").click();
  return waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation" && payload.simulation?.viewMode === "theater",
    20_000,
    "theater view",
  );
}

async function captureTheaterClip(browser, config, paths) {
  const scenario = await createScenarioViaApi(config.baseUrl, {
    question: config.question,
    rounds: 2,
    numAgents: 4,
    visualizationEnabled: true,
  });
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenario.id}`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 20_000, "simulation shell");
    const theaterPayload = await ensureTheaterView(page);
    await waitForAutomation(
      page,
      (payload) => (
        payload.page?.kind === "simulation"
        && payload.simulation?.viewMode === "theater"
        && payload.page?.controls?.can_preview_gameplay_cards
        && payload.scene?.scene
        && payload.scene.scene !== "BootScene"
        && payload.scene.scene !== "TitleScene"
        && Number(payload.scene.agent_count ?? 0) > 0
      ),
      45_000,
      "capture-ready theater",
    );
    await page.waitForTimeout(4_000);
    const panelShot = await captureHookScreenshot(page, "panel");
    if (panelShot) {
      writeDataUrlFile(paths.screenshots.theater, panelShot);
      fs.copyFileSync(paths.screenshots.theater, paths.screenshots.cta);
    } else {
      await saveScreenshot(page, paths.screenshots.theater);
      fs.copyFileSync(paths.screenshots.theater, paths.screenshots.cta);
    }
    await page.waitForTimeout(5_500);
    await page.getByRole("button", { name: /Gameplay Cards|玩法卡/i }).click();
    await waitForAutomation(
      page,
      (payload) => payload.page?.controls?.active_modal === "gameplay_cards",
      10_000,
      "embedded gameplay cards modal",
    );
    const modalShot = await captureHookScreenshot(page, "modal");
    if (modalShot) {
      writeDataUrlFile(paths.screenshots.director, modalShot);
    } else {
      await saveScreenshot(page, paths.screenshots.director);
    }
    return {
      scenarioId: scenario.id,
      theater: theaterPayload.simulation ?? null,
    };
  });
  await finalizeRecordedPage(recording, paths.raw.theater);
  return {
    ...recording.result,
    scenarioId: scenario.id,
  };
}

async function captureDirectorStill(browser, config, scenarioId, paths) {
  return withPage(browser, config.locale, async (page) => {
    await page.goto(`${config.baseUrl}/sim/${scenarioId}`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(page, (payload) => payload.page?.kind === "simulation", 20_000, "simulation shell");
    await ensureTheaterView(page);
    await waitForAutomation(
      page,
      (payload) => payload.page?.controls?.can_preview_gameplay_cards === true,
      20_000,
      "gameplay cards CTA",
    );
    await page.getByRole("button", { name: /Gameplay Cards|玩法卡/i }).click();
    await waitForAutomation(
      page,
      (payload) => payload.page?.controls?.active_modal === "gameplay_cards",
      10_000,
      "gameplay cards modal",
    );
    const modalShot = await captureHookScreenshot(page, "modal");
    if (modalShot) {
      writeDataUrlFile(paths.screenshots.director, modalShot);
    } else {
      await saveScreenshot(page, paths.screenshots.director);
    }
    return { scenarioId };
  });
}

async function captureResultStill(browser, config, scenarioId, paths) {
  await waitForScenarioStatus(
    config.baseUrl,
    scenarioId,
    (scenario) => scenario.status === "done",
    180_000,
    "completed scenario",
  );
  return withPage(browser, config.locale, async (page) => {
    await page.goto(`${config.baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
      30_000,
      "result page",
    );
    await page.evaluate(() => window.scrollTo({ top: window.innerHeight * 0.5, behavior: "instant" }));
    await page.waitForTimeout(400);
    await saveScreenshot(page, paths.screenshots.result);
    return { scenarioId };
  });
}

async function fastForwardDebate(page) {
  for (let i = 0; i < 6; i += 1) {
    const advanced = await page.evaluate(async () => {
      if (typeof window.advanceTime !== "function") return false;
      await window.advanceTime(30_000);
      return true;
    });
    if (!advanced) break;
    await page.waitForTimeout(500);
  }
}

async function captureDebateAssets(browser, config, paths) {
  const debate = await createDebateViaApi(config.baseUrl, { question: config.debateQuestion });
  const recording = await withRecordedPage(browser, config.locale, paths.tempVideoDir, async (page) => {
    await page.goto(`${config.baseUrl}/debate/${debate.id}`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "debate" && payload.page?.controls?.can_open_prediction === true,
      20_000,
      "debate live page",
    );
    await page.waitForTimeout(2_500);
    await saveScreenshot(page, paths.screenshots.debateLive);
    await fastForwardDebate(page);
    await waitForDebateResult(config.baseUrl, debate.id, 180_000);
    await page.goto(`${config.baseUrl}/debate/${debate.id}/result`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "debate_result" && payload.page?.loading === false,
      30_000,
      "debate result page",
    );
    await saveScreenshot(page, paths.screenshots.debateResult);
    await page.waitForTimeout(2_500);
    return { debateId: debate.id };
  });
  await finalizeRecordedPage(recording, paths.raw.debate);
  return recording.result;
}

function buildPaths(versionName) {
  const tempVideoDir = path.join(VIDEO_ROOT, "tmp", "playwright-video");
  const rawRoot = path.join(VIDEO_ROOT, "assets", "raw");
  const screenshotRoot = path.join(VIDEO_ROOT, "assets", "screenshots");
  const gifRoot = path.join(VIDEO_ROOT, "assets", "gifs");
  const outputRoot = path.join(VIDEO_ROOT, "output");
  return {
    tempVideoDir,
    manifest: path.join(outputRoot, `${versionName}.capture-manifest.json`),
    raw: {
      hook: path.join(rawRoot, `${versionName}.hook.webm`),
      simulation: path.join(rawRoot, `${versionName}.simulation.webm`),
      theater: path.join(rawRoot, `${versionName}.theater.webm`),
      debate: path.join(rawRoot, `${versionName}.debate.webm`),
    },
    screenshots: {
      hook: path.join(screenshotRoot, `${versionName}.hook.png`),
      simulation: path.join(screenshotRoot, `${versionName}.simulation.png`),
      theater: path.join(screenshotRoot, `${versionName}.theater.png`),
      director: path.join(screenshotRoot, `${versionName}.director.png`),
      result: path.join(screenshotRoot, `${versionName}.result.png`),
      debateLive: path.join(screenshotRoot, `${versionName}.debate-live.png`),
      debateResult: path.join(screenshotRoot, `${versionName}.debate-result.png`),
      cta: path.join(screenshotRoot, `${versionName}.cta.png`),
    },
    gifs: {
      theater: path.join(gifRoot, `${versionName}.theater.gif`),
      debate: path.join(gifRoot, `${versionName}.debate.gif`),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const pass = PASS_CONFIG[args.language];
  const config = {
    ...pass,
    baseUrl: args.baseUrl,
  };
  const paths = buildPaths(pass.versionName);
  ensureDir(paths.tempVideoDir);

  const { browser, launchProfile } = await launchBrowser(args.headless);
  try {
    const hook = await captureHookClip(browser, config, paths);
    const simulation = await captureSimulationClip(browser, config, paths);
    const theater = await captureTheaterClip(browser, config, paths);
    const director = fs.existsSync(paths.screenshots.director)
      ? { scenarioId: theater.scenarioId, source: "embedded-theater-pass" }
      : await captureDirectorStill(browser, config, theater.scenarioId, paths);
    const result = await captureResultStill(browser, config, theater.scenarioId, paths);
    const debate = await captureDebateAssets(browser, config, paths);

    createGifFromClip(paths.raw.theater, paths.gifs.theater, 1.1);
    createGifFromClip(paths.raw.debate, paths.gifs.debate, 0.6);

    const manifest = {
      language: args.language,
      versionName: pass.versionName,
      baseUrl: args.baseUrl,
      launchProfile,
      raw: paths.raw,
      screenshots: paths.screenshots,
      gifs: paths.gifs,
      hook,
      simulation,
      theater,
      director,
      result,
      debate,
    };

    writeJson(paths.manifest, manifest);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    await browser.close();
  }
}

await main();
