import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";

const DESKTOP_CASE = {
  id: "desktop-en-trade",
  locale: "en",
  question: "Should every trade port publish its tariff ledger before any reroute?",
  sharePlatform: "Xiaohongshu",
  betKindIndex: 1,
  betTargetIndex: 1,
  sharePlatformIndex: 0,
};

const MOBILE_CASE = {
  id: "mobile-zh-law",
  locale: "zh",
  question: "如果所有法院都必须公开解释每一次紧急禁令，制度会更稳吗？",
  sharePlatform: "小红书",
  betKindIndex: 1,
  betTargetIndex: 1,
  sharePlatformIndex: 0,
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveFrontendPath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;

  const normalized = inputPath.replace(/^\.\/+/, "");
  if (
    normalized === "frontend"
    || normalized.startsWith(`frontend${path.sep}`)
    || normalized.startsWith("frontend/")
  ) {
    return path.join(path.dirname(FRONTEND_ROOT), normalized);
  }
  return path.join(FRONTEND_ROOT, normalized);
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    outputDir: "",
    headless: process.env.HEADLESS === "1",
    width: null,
    height: null,
    question: "",
    profileHint: "",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--width" && next) {
      args.width = Number(next);
      i += 1;
    } else if (arg === "--height" && next) {
      args.height = Number(next);
      i += 1;
    } else if (arg === "--question" && next) {
      args.question = next;
      i += 1;
    } else if (arg === "--profile-hint" && next) {
      args.profileHint = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-debate-suite.mjs <desktop|mobile|full> [--url URL] [--output-dir DIR] [--headless]",
    );
  }

  if ((args.width != null && !Number.isFinite(args.width)) || (args.height != null && !Number.isFinite(args.height))) {
    throw new Error("--width/--height must be numeric when provided");
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
      id: "chromium-default",
      options: { headless },
    },
    {
      id: "chromium-swiftshader",
      options: { headless, args: softwareArgs },
    },
    {
      id: "chrome-channel",
      options: { channel: "chrome", headless },
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

async function createDebateViaApi(baseUrl, {
  question,
  profileHint,
}) {
  const response = await fetch(`${baseUrl}/api/debate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      ...(profileHint ? { profile_hint: profileHint } : {}),
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
    throw new Error(`Failed to get debate ${debateId}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForDebateResultReady(baseUrl, debateId, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const debate = await getDebateViaApi(baseUrl, debateId);
    if (debate?.result_ready) return debate;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for debate ${debateId} to become result_ready`);
}

async function setLanguage(page, baseUrl, locale) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  const targetName = locale === "zh" ? "中文" : "En";
  const button = page.getByRole("button", { name: targetName });
  await button.click();
}

async function captureDebateBetModal(page) {
  return page.evaluate(() => {
    const modal = document.querySelector(".debate-modal");
    if (!modal) return null;

    const groups = Array.from(modal.querySelectorAll(".debate-modal__group"));
    const selectedKind = groups[0]?.querySelector(".mode-btn--active")?.textContent?.trim() ?? null;
    const selectedTarget = groups[1]?.querySelector(".mode-btn--active")?.textContent?.trim() ?? null;
    const confidenceInput = modal.querySelector("#debate-confidence");
    const confidence = confidenceInput && "value" in confidenceInput ? confidenceInput.value : null;
    const error = modal.querySelector(".debate-modal__error")?.textContent?.trim() ?? null;

    return {
      selected_kind: selectedKind,
      selected_target: selectedTarget,
      confidence,
      error,
    };
  });
}

async function captureDebateShareModal(page) {
  return page.evaluate(() => {
    const modal = document.querySelector(".debate-modal--share");
    if (!modal) return null;

    const activePlatform = modal.querySelector(".mode-btn--active")?.textContent?.trim() ?? null;
    const copy = modal.querySelector(".debate-share-modal__copy")?.textContent ?? "";
    const copyButton = modal.querySelector(".btn.btn-primary")?.textContent?.trim() ?? null;

    return {
      active_platform: activePlatform,
      copy_length: copy.length,
      has_copy: Boolean(copy.trim()),
      copy_button_label: copyButton,
    };
  });
}

async function probeDebateAutomationHooks(page, modes = []) {
  return page.evaluate(async (requestedModes) => {
    const result = {
      has_render_game_to_text: typeof window.render_game_to_text === "function",
      has_advance_time: typeof window.advanceTime === "function",
      has_capture_game_screenshot: typeof window.capture_game_screenshot === "function",
      advance_time_ok: false,
      captures: {},
    };

    if (typeof window.advanceTime === "function") {
      try {
        await window.advanceTime(16);
        result.advance_time_ok = true;
      } catch (error) {
        result.advance_time_error = error instanceof Error ? error.message : String(error);
      }
    }

    if (typeof window.capture_game_screenshot === "function") {
      for (const mode of requestedModes) {
        try {
          const value = await window.capture_game_screenshot(mode);
          result.captures[mode] = {
            is_null: value == null,
            is_data_url: typeof value === "string" && value.startsWith("data:image/"),
            length: typeof value === "string" ? value.length : 0,
          };
        } catch (error) {
          result.captures[mode] = {
            is_null: false,
            is_data_url: false,
            length: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    return result;
  }, modes);
}

function assertDebateAutomationHooks(label, hooks, expectations = {}) {
  if (!hooks?.has_render_game_to_text) {
    throw new Error(`${label}: missing render_game_to_text()`);
  }
  if (!hooks?.has_advance_time || hooks?.advance_time_ok !== true) {
    throw new Error(`${label}: advanceTime() unavailable or failed`);
  }
  if (!hooks?.has_capture_game_screenshot) {
    throw new Error(`${label}: missing capture_game_screenshot()`);
  }

  for (const [mode, expected] of Object.entries(expectations)) {
    const capture = hooks?.captures?.[mode];
    if (!capture) {
      throw new Error(`${label}: missing capture probe for mode=${mode}`);
    }
    if (expected === "data_url" && capture.is_data_url !== true) {
      throw new Error(`${label}: expected ${mode} capture to return data URL, got ${JSON.stringify(capture)}`);
    }
    if (expected === "null" && capture.is_null !== true) {
      throw new Error(`${label}: expected ${mode} capture to return null, got ${JSON.stringify(capture)}`);
    }
  }
}

function buildSurfaceConfig(args, mode) {
  const baseCase = mode === "mobile" ? MOBILE_CASE : DESKTOP_CASE;
  const caseConfig = {
    ...baseCase,
    question: args.question || baseCase.question,
    ...(args.profileHint ? { profileHint: args.profileHint } : {}),
  };

  if (mode === "mobile") {
    return {
      viewport: {
        width: args.width ?? 390,
        height: args.height ?? 844,
      },
      isMobile: true,
      hasTouch: true,
      caseConfig,
    };
  }

  return {
    viewport: {
      width: args.width ?? 1440,
      height: args.height ?? 960,
    },
    isMobile: false,
    hasTouch: false,
    caseConfig,
  };
}

async function clickVisibleEnabledButton(page, pattern, {
  scopeSelector,
  timeout = 10000,
} = {}) {
  await page.waitForFunction(
    ({ pattern, scopeSelector }) => {
      const regex = new RegExp(pattern, "i");
      const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
      if (!scope) return false;
      return Array.from(scope.querySelectorAll("button")).some((button) => {
        const text = button.textContent?.trim() ?? "";
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        const visible =
          style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
        return visible && !button.disabled && regex.test(text);
      });
    },
    { pattern, scopeSelector },
    { timeout },
  );

  const clicked = await page.evaluate(({ pattern, scopeSelector }) => {
    const regex = new RegExp(pattern, "i");
    const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
    if (!scope) return false;
    const button = Array.from(scope.querySelectorAll("button")).find((candidate) => {
      const text = candidate.textContent?.trim() ?? "";
      const rect = candidate.getBoundingClientRect();
      const style = window.getComputedStyle(candidate);
      const visible =
        style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
      return visible && !candidate.disabled && regex.test(text);
    });
    if (!button) return false;
    button.click();
    return true;
  }, { pattern, scopeSelector });

  if (!clicked) {
    throw new Error(`Failed to click visible enabled button: ${pattern}`);
  }
}

async function openBet(page, mode, locale) {
  if (mode === "mobile") {
    const railClicked = await page.evaluate(() => {
      const button = document.querySelector(".debate-mobile-rail .btn");
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    });
    if (railClicked) {
      await page.waitForTimeout(250);
      if (await hasSelector(page, ".debate-modal")) {
        return;
      }
    }

    const heroClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll(".debate-hero__bottom .debate-controls .btn"));
      const button = buttons[1];
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    });
    if (!heroClicked) {
      throw new Error("Failed to click mobile debate bet button");
    }
    return;
  }

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".debate-hero__bottom .debate-controls .btn"));
    const button = buttons[1];
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  if (!clicked) {
    throw new Error("Failed to click desktop debate bet button");
  }
}

async function openResult(page, mode, locale) {
  if (mode === "mobile") {
    const railClicked = await page.evaluate(() => {
      const button = document.querySelector(".debate-mobile-rail .btn");
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    });
    if (railClicked) {
      await page.waitForTimeout(250);
      const payload = await readAutomation(page);
      if (payload?.page?.kind === "debate_result") {
        return;
      }
    }

    const heroClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll(".debate-hero__bottom .debate-controls .btn"));
      const button = buttons.at(-1);
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      button.click();
      return true;
    });
    if (!heroClicked) {
      throw new Error("Failed to click mobile debate result button");
    }
    return;
  }

  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll(".debate-hero__bottom .debate-controls .btn"));
    const button = buttons.at(-1);
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  if (!clicked) {
    throw new Error("Failed to click desktop debate result button");
  }
}

async function disableAutoReveal(page) {
  const payload = await readAutomation(page);
  if (payload?.page?.controls?.auto_reveal !== true) {
    return;
  }
  await clickVisibleEnabledButton(page, "Auto\\s*reveal:\\s*On|自动揭示:\\s*开启", {
    timeout: 5000,
  });
}

async function fastForwardDebate(page) {
  const advanced = await page.evaluate(async () => {
    if (typeof window.advanceTime !== "function") return false;
    await window.advanceTime(30_000);
    return true;
  });
  if (advanced) return;

  await clickVisibleEnabledButton(page, "Skip\\s*to\\s*verdict|直接看判词", {
    timeout: 5000,
  });
}

async function waitForModal(page, selector, timeout = 5000) {
  await page.waitForFunction(
    ({ selector }) => Boolean(document.querySelector(selector)),
    { selector },
    { timeout },
  );
}

async function hasSelector(page, selector) {
  return page.evaluate((selector) => Boolean(document.querySelector(selector)), selector);
}

async function clickDebateBetOption(page, groupIndex, optionIndex) {
  const clicked = await page.evaluate(({ groupIndex, optionIndex }) => {
    const groups = Array.from(document.querySelectorAll(".debate-modal .debate-modal__group"));
    const targetGroup = groups[groupIndex];
    if (!targetGroup) return false;
    const buttons = Array.from(targetGroup.querySelectorAll("button"));
    const button = buttons[optionIndex];
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, { groupIndex, optionIndex });

  if (!clicked) {
    throw new Error(`Failed to click debate bet option group=${groupIndex} option=${optionIndex}`);
  }
}

async function readHookCaptureState(page, modes) {
  return page.evaluate(async (requestedModes) => {
    if (typeof window.capture_game_screenshot !== "function") {
      return {
        available: false,
        results: Object.fromEntries(requestedModes.map((mode) => [mode, false])),
      };
    }
    const entries = await Promise.all(requestedModes.map(async (mode) => {
      const shot = await window.capture_game_screenshot(mode);
      return [mode, typeof shot === "string" && shot.startsWith("data:image/")];
    }));
    return {
      available: true,
      results: Object.fromEntries(entries),
    };
  }, modes);
}

async function submitDebateBet(page) {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector(".debate-modal__footer .btn.btn-primary");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });

  if (!clicked) {
    throw new Error("Failed to submit debate bet");
  }
}

async function clickDebateSharePlatform(page, platformIndex) {
  const clicked = await page.evaluate(({ platformIndex }) => {
    const buttons = Array.from(document.querySelectorAll(".debate-modal--share .debate-modal__options .mode-btn"));
    const button = buttons[platformIndex];
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }, { platformIndex });

  if (!clicked) {
    throw new Error(`Failed to click debate share platform index=${platformIndex}`);
  }
}

async function runDebateFlow(page, {
  baseUrl,
  outputDir,
  mode,
  surfaceConfig,
}) {
  ensureDir(outputDir);

  const { caseConfig } = surfaceConfig;
  await setLanguage(page, baseUrl, caseConfig.locale);

  const created = await createDebateViaApi(baseUrl, {
    question: caseConfig.question,
    profileHint: caseConfig.profileHint,
  });
  const debateId = created.id;

  await page.goto(`${baseUrl}/debate/${debateId}`, { waitUntil: "domcontentloaded" });
  const live = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "debate" && payload.page?.controls?.can_open_prediction === true,
    10000,
    "debate live betting window",
  );
  await disableAutoReveal(page);
  const liveHooks = await probeDebateAutomationHooks(page, ["panel"]);
  assertDebateAutomationHooks("debate live hooks", liveHooks, { panel: "data_url" });
  writeJson(path.join(outputDir, "live.json"), live);
  writeJson(path.join(outputDir, "live-hooks.json"), liveHooks);
  if (mode === "mobile") {
    await openBet(page, mode, caseConfig.locale);
    await waitForModal(page, ".debate-modal", 5000);
    await saveScreenshot(page, path.join(outputDir, "live.png"));
  } else {
    await saveScreenshot(page, path.join(outputDir, "live.png"));
    await openBet(page, mode, caseConfig.locale);
    await waitForModal(page, ".debate-modal", 5000);
  }
  const betHookCapture = await readHookCaptureState(page, ["panel", "modal"]);
  const betOpenPayload = await readAutomation(page);
  const betModalState = await captureDebateBetModal(page);
  writeJson(path.join(outputDir, "bet-open.json"), {
    automation: betOpenPayload,
    hook_capture: betHookCapture,
    modal_state: betModalState,
  });
  await saveScreenshot(page, path.join(outputDir, "bet-open.png"));

  await clickDebateBetOption(page, 0, caseConfig.betKindIndex);
  await clickDebateBetOption(page, 1, caseConfig.betTargetIndex);
  await submitDebateBet(page);
  await page.waitForTimeout(300);
  const betSubmittedPayload = await readAutomation(page);
  writeJson(path.join(outputDir, "bet-submitted.json"), {
    automation: betSubmittedPayload,
    modal_state: await captureDebateBetModal(page),
  });
  await saveScreenshot(page, path.join(outputDir, "bet-submitted.png"));

  await fastForwardDebate(page);
  await waitForDebateResultReady(baseUrl, debateId, 20000);
  const resultReadyPayload = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "debate" && payload.page?.controls?.can_view_result === true,
    20000,
    "debate result CTA",
  );
  writeJson(path.join(outputDir, "result-ready.json"), resultReadyPayload);
  await saveScreenshot(page, path.join(outputDir, "result-ready.png"));

  await openResult(page, mode, caseConfig.locale);
  const resultInitial = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "debate_result" && payload.page?.loading === false,
    10000,
    "debate result page",
  );
  const resultHooksBeforeShare = await probeDebateAutomationHooks(page, ["panel", "modal"]);
  assertDebateAutomationHooks("debate result hooks before share", resultHooksBeforeShare, {
    panel: "data_url",
    modal: "null",
  });
  writeJson(path.join(outputDir, "result-initial.json"), resultInitial);
  writeJson(path.join(outputDir, "result-hooks-before-share.json"), resultHooksBeforeShare);
  await saveScreenshot(page, path.join(outputDir, "result-initial.png"));

  await clickVisibleEnabledButton(page, "分享结果|Share\\s*Result", {
    timeout: 5000,
  });
  await waitForModal(page, ".debate-modal--share", 5000);
  const shareOpenPayload = await readAutomation(page);
  const resultHooksWithShare = await probeDebateAutomationHooks(page, ["panel", "modal"]);
  if (shareOpenPayload?.page?.controls?.active_modal !== "share") {
    throw new Error(`debate share modal automation state missing active_modal=share: ${JSON.stringify(shareOpenPayload?.page?.controls ?? null)}`);
  }
  if (shareOpenPayload?.page?.controls?.modal_state?.kind !== "debate_share_modal") {
    throw new Error(`debate share modal automation state missing modal_state.kind: ${JSON.stringify(shareOpenPayload?.page?.controls ?? null)}`);
  }
  assertDebateAutomationHooks("debate result hooks with share", resultHooksWithShare, {
    panel: "data_url",
    modal: "data_url",
  });
  writeJson(path.join(outputDir, "share-open.json"), {
    automation: shareOpenPayload,
    modal_state: await captureDebateShareModal(page),
    hooks: resultHooksWithShare,
  });
  await saveScreenshot(page, path.join(outputDir, "share-open.png"));

  await clickDebateSharePlatform(page, caseConfig.sharePlatformIndex);
  const sharePlatformPayload = await readAutomation(page);
  const shareModalState = await captureDebateShareModal(page);
  writeJson(path.join(outputDir, "share-generated.json"), {
    automation: sharePlatformPayload,
    modal_state: shareModalState,
  });
  await saveScreenshot(page, path.join(outputDir, "share-generated.png"));

  return {
    mode,
    locale: caseConfig.locale,
    debateId,
    live: {
      route: live?.page?.route ?? null,
      canOpenPrediction: live?.page?.controls?.can_open_prediction ?? false,
      scene: live?.scene?.theme ?? null,
    },
    result: {
      route: resultInitial?.page?.route ?? null,
      winner: resultInitial?.page?.result?.winner ?? null,
      verdictTone: resultInitial?.page?.result?.verdict_tone ?? null,
      predictionCount: resultInitial?.page?.result?.prediction_count ?? null,
    },
    automationHooks: {
      live: liveHooks,
      resultBeforeShare: resultHooksBeforeShare,
      resultWithShare: resultHooksWithShare,
    },
    share: shareModalState,
  };
}

async function runSurface(args, mode) {
  const { browser, launchProfile } = await launchBrowser(args.headless);
  const outputDir = args.outputDir;
  ensureDir(outputDir);
  writeJson(path.join(outputDir, "browser-launch.json"), launchProfile);

  const surfaceConfig = buildSurfaceConfig(args, mode);
  const page = await browser.newPage({
    viewport: surfaceConfig.viewport,
    isMobile: surfaceConfig.isMobile,
    hasTouch: surfaceConfig.hasTouch,
  });

  try {
    const result = await runDebateFlow(page, {
      baseUrl: args.baseUrl,
      outputDir,
      mode,
      surfaceConfig,
    });
    return {
      launchProfile,
      viewport: surfaceConfig.viewport,
      ...result,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-debate-${args.mode}`);
  ensureDir(outputDir);

  let result;
  if (args.mode === "full") {
    const desktopDir = path.join(outputDir, "desktop");
    const mobileDir = path.join(outputDir, "mobile");
    ensureDir(desktopDir);
    ensureDir(mobileDir);
    result = {
      mode: "full",
      desktop: await runSurface({ ...args, outputDir: desktopDir }, "desktop"),
      mobile: await runSurface({ ...args, outputDir: mobileDir }, "mobile"),
    };
  } else {
    result = await runSurface({ ...args, outputDir }, args.mode);
  }

  writeJson(path.join(outputDir, "result.json"), result);
  console.log(JSON.stringify(result, null, 2));
  console.log(`artifacts: ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
