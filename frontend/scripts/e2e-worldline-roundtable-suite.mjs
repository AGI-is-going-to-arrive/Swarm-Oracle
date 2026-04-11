import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";
import { closePlaywrightBrowser, closePlaywrightContext } from "./playwrightTeardown.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";

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
    backendUrl: DEFAULT_BACKEND_URL,
    outputDir: "",
    browser: "chromium",
    headless: process.env.HEADLESS === "1",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--backend-url" && next) {
      args.backendUrl = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = path.isAbsolute(next) ? next : path.join(FRONTEND_ROOT, next);
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-worldline-roundtable-suite.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--output-dir DIR] [--browser chromium|firefox|webkit] [--headless]");
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }

  return args;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getScenario(backendUrl, scenarioId) {
  return fetchJson(`${backendUrl}/api/scenario/${scenarioId}`);
}

function collectSummaryFiles(rootDir) {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name === "summary.json") {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function readPreferredScenarioIds() {
  const preferred = {
    desktop: null,
    mobile: null,
  };
  const summaryFiles = collectSummaryFiles(DEFAULT_OUTPUT_ROOT)
    .map((summaryPath) => ({
      summaryPath,
      mtimeMs: fs.statSync(summaryPath).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { summaryPath } of summaryFiles) {
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
      if (!preferred.desktop && typeof summary?.desktop?.scenarioId === "string") {
        preferred.desktop = summary.desktop.scenarioId.trim();
      }
      if (!preferred.mobile && typeof summary?.mobile?.scenarioId === "string") {
        preferred.mobile = summary.mobile.scenarioId.trim();
      }
      if (preferred.desktop && preferred.mobile) {
        break;
      }
    } catch {
      // Ignore malformed summary files.
    }
  }

  return preferred;
}

async function resolvePreferredScenarioId(backendUrl, scenarioId) {
  if (!scenarioId) {
    return null;
  }
  const scenario = await getScenario(backendUrl, scenarioId).catch(() => null);
  if ((scenario?.branches?.length ?? 0) >= 2) {
    return scenario.id;
  }
  return null;
}

async function findMultiEndingScenarioId(backendUrl) {
  const payload = await fetchJson(`${backendUrl}/api/scenarios?status=done&limit=120&offset=0`);
  const candidates = [];
  for (const item of payload.scenarios ?? []) {
    const scenario = await getScenario(backendUrl, item.id);
    const branchCount = scenario.branches?.length ?? 0;
    if (branchCount >= 2) {
      candidates.push({
        id: scenario.id,
        branchCount,
        createdAt: String(scenario.created_at ?? ""),
      });
    }
  }
  candidates.sort((left, right) => {
    if (right.branchCount !== left.branchCount) {
      return right.branchCount - left.branchCount;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  if (candidates[0]?.id) {
    return candidates[0].id;
  }
  throw new Error("No multi-ending DONE scenario is available for roundtable E2E");
}

async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") {
    return firefox.launch({ headless });
  }
  if (browserName === "webkit") {
    return webkit.launch({ headless });
  }
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return await chromium.launch({ headless });
  }
}

async function saveScreenshot(page, filePath) {
  await page.screenshot({
    path: filePath,
    type: "png",
    scale: "css",
    animations: "disabled",
    timeout: 0,
  });
}

async function fillComposerIfEditable(page, text) {
  const textarea = page.locator(".ending-chat-composer__input").last();
  const editable = await textarea.isEditable().catch(() => false);
  if (!editable) return false;
  await textarea.fill(text);
  return true;
}

async function clickActionable(locator, label) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.waitFor({ state: "visible", timeout: 10000 });
  try {
    await locator.click({ trial: true });
    await locator.click();
    return;
  } catch (error) {
    await locator.focus().catch(() => {});
    try {
      await locator.press("Enter");
      return;
    } catch {
      throw error;
    }
  }
}

async function tapLocator(page, locator, label) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.waitFor({ state: "visible", timeout: 10000 });
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error(`${label} has no tappable bounding box`);
  }
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function readComposerValue(page) {
  const textarea = page.locator(".ending-chat-composer__input").last();
  const visible = await textarea.isVisible().catch(() => false);
  if (!visible) return "";
  return textarea.inputValue().catch(() => "");
}

async function armClipboardCapture(page) {
  await page.evaluate(() => {
    const globalWindow = window;
    globalWindow.__swarmCopiedText = null;
    const writeText = async (text) => {
      globalWindow.__swarmCopiedText = text;
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });
  });
}

async function readCapturedClipboard(page) {
  return page.evaluate(() => window.__swarmCopiedText ?? null);
}

async function waitForCapturedClipboardUrl(page, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const url = await readCapturedClipboard(page);
    if (typeof url === "string" && (url.includes("roomShare=") || url.includes("roomLocal="))) {
      return url;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function anchorIdsEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

async function waitForAutomation(page, predicate, timeout = 30000, label = "automation state") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await readAutomation(page);
    if (payload && predicate(payload)) {
      return payload;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitFor(page, predicate, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await predicate();
    if (result) return result;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function captureStreamLifecycle(page, {
  label,
  outputDir,
  filePrefix,
  timeout = 60000,
  isCommitState,
}) {
  const captures = {
    turn_start: null,
    turn_delta: null,
    turn_commit: null,
  };
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await readAutomation(page);
    const controls = payload?.page?.controls;
    if (!captures.turn_start && (controls?.pending_drafts?.length ?? 0) > 0 && controls?.stream_state === "turn_start") {
      captures.turn_start = controls;
      await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-start.png`));
      writeJson(path.join(outputDir, `${filePrefix}-turn-start.json`), payload);
    }
    if (!captures.turn_delta && (controls?.pending_drafts?.length ?? 0) > 0 && controls?.stream_state === "turn_delta") {
      captures.turn_delta = controls;
      await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-delta.png`));
      writeJson(path.join(outputDir, `${filePrefix}-turn-delta.json`), payload);
    }
    if (controls && isCommitState(controls, payload)) {
      if (!captures.turn_commit) {
        captures.turn_commit = controls;
        await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-commit.png`));
        writeJson(path.join(outputDir, `${filePrefix}-turn-commit.json`), payload);
      }
      return {
        payload,
        captures,
      };
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openRoundtable(page, baseUrl, scenarioId) {
  await page.goto(`${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Start Roundtable|发起圆桌/i }).click();
  const launchButton = page.getByRole("button", { name: /Open with selected representatives|Open this lineup|以当前代表开桌|按当前代表开桌|按这套代表开桌/i }).first();
  const start = Date.now();
  while (Date.now() - start < 45000) {
    const automation = await readAutomation(page);
    if (automation?.page?.kind === "worldline_roundtable" && automation?.page?.controls?.has_result === true) {
      return automation;
    }
    if (await launchButton.isVisible().catch(() => false)) {
      await launchButton.click().catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for roundtable ready");
}

async function sendComposer(page, prompt, modeText, options = {}) {
  const {
    expectThreadSwitch = false,
    expectedInteractionMode = null,
    outputDir = null,
    filePrefix = null,
    skipModeClick = false,
  } = options;
  if (!skipModeClick) {
    await page.getByRole("button", { name: modeText }).click();
  }
  const before = await readAutomation(page);
  const beforeTurns = before?.simulation?.messageCount ?? 0;
  const beforeThreadCount = before?.page?.controls?.thread_count ?? 0;
  const beforeActiveThreadId = before?.page?.controls?.active_thread_id ?? null;
  await waitFor(
    page,
    async () => {
      const editable = await fillComposerIfEditable(page, prompt).catch(() => false);
      if (editable) return "editable";
      const value = await readComposerValue(page);
      return value.trim() ? "prefilled" : null;
    },
    "roundtable composer ready",
    30000,
  );
  try {
    await waitFor(
      page,
      async () => {
        const sendButton = page.locator(".ending-chat-send").last();
        const enabled = await sendButton.isEnabled().catch(() => false);
        if (enabled) return "enabled";
        const visible = await sendButton.isVisible().catch(() => false);
        if (!visible) return null;
        const value = await readComposerValue(page);
        return value.trim() ? "force" : null;
      },
      "roundtable send button ready",
      60000,
    );
  } catch (error) {
    console.warn(`[roundtable] send button wait fell back to best-effort send: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sendButton = page.locator(".ending-chat-send").last();
  const sendVisible = await sendButton.isVisible().catch(() => false);
  const sendEnabled = await sendButton.isEnabled().catch(() => false);
  if (sendVisible && sendEnabled) {
    await clickActionable(sendButton, "roundtable send button");
  } else {
    const composer = page.locator(".ending-chat-composer__input").last();
    await composer.press("Enter").catch(() => {});
  }
  const isBaseSatisfied = (controls, payload) => {
    if (!controls || !payload) return false;
    if (expectedInteractionMode && controls.interaction_mode !== expectedInteractionMode) {
      return false;
    }
    if (expectThreadSwitch) {
      return (
        (controls.thread_count ?? 0) > beforeThreadCount
        || (controls.active_thread_id ?? null) !== beforeActiveThreadId
      );
    }
    return (
      (payload.simulation?.messageCount ?? 0) > beforeTurns
      || (controls.thread_count ?? 0) > beforeThreadCount
      || (controls.active_thread_id ?? null) !== beforeActiveThreadId
    );
  };
  if (outputDir && filePrefix) {
    let streamResult = null;
    let fallbackCaptures = null;
    try {
      streamResult = await captureStreamLifecycle(page, {
        label: `composer send ${modeText}`,
        outputDir,
        filePrefix,
        timeout: 60000,
        isCommitState: (controls, payload) => (
          isBaseSatisfied(controls, payload)
          && (controls?.pending_drafts?.length ?? 0) === 0
        ),
      });
    } catch (error) {
      fallbackCaptures = error?.captures ?? null;
      console.warn(
        `[roundtable] stream lifecycle fell back to settled wait for ${String(modeText)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (streamResult) {
      return streamResult;
    }
    const payload = await waitForAutomation(
      page,
      (payload) => (
        isBaseSatisfied(payload?.page?.controls, payload)
        && (payload?.page?.controls?.pending_drafts?.length ?? 0) === 0
      ),
      30000,
      `composer send ${modeText} settled fallback`,
    );
    return {
      payload,
      captures: fallbackCaptures,
    };
  }
  return waitForAutomation(
    page,
    (payload) => isBaseSatisfied(payload?.page?.controls, payload),
    15000,
    `composer send ${modeText}`,
  );
}

async function waitForDraftBubblesToSettle(page, label) {
  await page.waitForFunction(
    () => document.querySelectorAll(".ending-chat-bubble--draft").length === 0,
    { timeout: 60000 },
  ).catch(() => {
    throw new Error(`Timed out waiting for ${label}`);
  });
}

async function waitForTranscriptActionsReady(page, label, timeout = 60000) {
  await page.waitForFunction(
    () => document.querySelectorAll(".ending-chat-bubble__actions button").length > 0,
    { timeout },
  ).catch(() => {
    throw new Error(`Timed out waiting for ${label}`);
  });
}

async function createVerdictAnchoredThread(page, label) {
  await waitForDraftBubblesToSettle(page, `${label} draft settle`);
  await waitForTranscriptActionsReady(page, `${label} quote actions`);
  const firstBubbleActions = page.locator(".ending-chat-bubble__actions").first();
  const quoteFollowButton = firstBubbleActions.getByRole("button", {
    name: /Follow this quote|沿这句追问/i,
  });
  const quoteThreadButton = firstBubbleActions.getByRole("button", {
    name: /Start anchored thread|另开线程/i,
  });
  if (await quoteFollowButton.isVisible().catch(() => false)) {
    await quoteFollowButton.scrollIntoViewIfNeeded().catch(() => {});
    await clickActionable(quoteFollowButton, `${label} quote follow button`);
    await waitForAutomation(
      page,
      (payload) => (payload.page?.controls?.pending_question_anchor_ids?.length ?? 0) > 0,
      10000,
      `${label} quote anchor armed`,
    );
    await clickActionable(quoteThreadButton, `${label} quote thread button`);
  } else if (await quoteThreadButton.isVisible().catch(() => false)) {
    await clickActionable(quoteThreadButton, `${label} quote thread button`);
  } else {
    const globalQuoteThreadButton = page.getByRole("button", { name: /Start anchored thread|另开线程/i }).last();
    if (await globalQuoteThreadButton.isVisible().catch(() => false)) {
      await clickActionable(globalQuoteThreadButton, `${label} global quote thread button`);
    } else {
      await clickActionable(
        page.getByRole("button", { name: /Archive Verdict|档案总结|档案结论/i }).first(),
        `${label} archive verdict button`,
      );
      await clickActionable(
        page.getByRole("button", { name: /Start thread from current anchor|从当前锚点开始线程|从当前锚点发起线程/i }),
        `${label} current anchor thread button`,
      );
    }
  }
  return waitForAutomation(
    page,
    (payload) => {
      const controls = payload.page?.controls;
      if (!controls) return false;
      return (
        controls.interaction_mode === "thread_followup"
        && (controls.question_anchor_ids?.length ?? 0) > 0
        && Boolean(controls.active_thread_id)
      );
    },
    35000,
    label,
  );
}

async function sendAnchoredFollowup(page, label, options = {}) {
  const { outputDir = null, filePrefix = null } = options;
  await page.waitForFunction(() => {
    const input = document.querySelector(".ending-chat-composer__input");
    return input instanceof HTMLTextAreaElement && input.value.trim().length > 0;
  }, { timeout: 10000 });
  await page.waitForFunction(() => {
    const raw = window.render_game_to_text?.();
    if (!raw) return false;
    const payload = JSON.parse(raw);
    return payload.page?.controls?.can_send === true;
  }, { timeout: 10000 });
  await clickActionable(page.locator(".ending-chat-send"), `${label} anchored send button`);
  await waitForAutomation(
    page,
    (payload) => {
      const controls = payload.page?.controls;
      if (!controls || controls.interaction_mode !== "thread_followup") {
        return false;
      }
      return (
        controls.sending === true
        || (controls.pending_question_anchor_ids?.length ?? 0) === 0
        || (controls.question_anchor_ids?.length ?? 0) > 0
      );
    },
    20000,
    `${label} dispatch`,
  );
  const isCommitState = (controls) => (
    controls?.interaction_mode === "thread_followup"
    && (controls?.question_anchor_ids?.length ?? 0) > 0
    && (controls?.pending_question_anchor_ids?.length ?? 0) === 0
    && (controls?.pending_drafts?.length ?? 0) === 0
  );
  if (outputDir && filePrefix) {
    return captureStreamLifecycle(page, {
      label,
      outputDir,
      filePrefix,
      isCommitState,
    });
  }
  return waitForAutomation(
    page,
    (payload) => isCommitState(payload.page?.controls),
    60000,
    label,
  );
}

async function captureMobileFit(page) {
  const fit = await page.evaluate(() => {
    const shell = document.querySelector(".worldline-roundtable-shell");
    const rect = shell instanceof HTMLElement ? shell.getBoundingClientRect() : null;
    const languageSwitch = document.querySelector(".lang-switch--global");
    const topline = document.querySelector(".worldline-roundtable-hero__topline");
    const summaryCard = document.querySelector(".worldline-roundtable-card--summary");
    const transcriptHeader = document.querySelector(".worldline-roundtable-transcript-header");
    const transcriptList = document.querySelector(".worldline-roundtable-transcript-list");
    const composer = document.querySelector(".ending-chat-composer");
    const toRect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const value = node.getBoundingClientRect();
      if (value.width <= 0 || value.height <= 0) {
        return null;
      }
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const overlaps = (left, right) => {
      if (!left || !right) return null;
      return !(
        left.x + left.width <= right.x
        || right.x + right.width <= left.x
        || left.y + left.height <= right.y
        || right.y + right.height <= left.y
      );
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      canScrollY: document.documentElement.scrollHeight > window.innerHeight,
      languageSwitchRect: toRect(languageSwitch),
      heroToplineRect: toRect(topline),
      summaryCardRect: toRect(summaryCard),
      transcriptHeaderRect: toRect(transcriptHeader),
      transcriptListRect: toRect(transcriptList),
      composerRect: toRect(composer),
      languageSwitchOverlapsTopline: overlaps(toRect(languageSwitch), toRect(topline)),
      languageSwitchOverlapsComposer: overlaps(toRect(languageSwitch), toRect(composer)),
      summaryBeforeTranscript: (() => {
        const summaryRect = toRect(summaryCard);
        const transcriptRect = toRect(transcriptHeader);
        if (!summaryRect || !transcriptRect) return false;
        return summaryRect.y < transcriptRect.y;
      })(),
      composerOverlapsTranscript: overlaps(toRect(composer), toRect(transcriptList)),
    };
  });
  if (fit.languageSwitchOverlapsTopline) {
    throw new Error("Mobile roundtable language switch overlaps the hero topline");
  }
  if (fit.languageSwitchOverlapsComposer) {
    throw new Error("Mobile roundtable language switch overlaps the composer");
  }
  if (fit.summaryBeforeTranscript) {
    throw new Error("Mobile roundtable summary card appears before the transcript");
  }
  if (fit.composerOverlapsTranscript) {
    throw new Error("Mobile roundtable composer overlaps the transcript list");
  }
  return fit;
}

async function focusHotseatThread(page, expectedThreadId) {
  const hotseatChip = page.locator(".ending-chat-thread-chip.is-hotseat-thread").first();
  if (await hotseatChip.isVisible().catch(() => false)) {
    await hotseatChip.click();
  }
  if (!expectedThreadId) {
    await page.waitForTimeout(500);
    return;
  }
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_thread_id === expectedThreadId,
    10000,
    "hotseat thread focus",
  );
  await page.waitForTimeout(500);
}

async function reseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const manualShortlistButton = page.getByRole("button", { name: /Manual shortlist|手动短名单/i }).first();
  if (await manualShortlistButton.isVisible().catch(() => false)) {
    await manualShortlistButton.click();
  }

  const firstAlternative = page
    .locator(".worldline-roundtable-picker-branch.is-active")
    .first()
    .locator(".worldline-roundtable-picker-card:not(.is-selected)")
    .first();
  let nextRepresentative = null;
  if (await firstAlternative.isVisible().catch(() => false)) {
    nextRepresentative = (await firstAlternative.locator("strong").innerText()).trim();
    await firstAlternative.click();
  }
  const rebuildButton = page.getByRole("button", {
    name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup/i,
  });

  const start = Date.now();
  let reseated = null;
  while (Date.now() - start < 45000) {
    if (await rebuildButton.isVisible().catch(() => false)) {
      await rebuildButton.click().catch(() => {});
    }
    reseated = await readAutomation(page);
    if (
      reseated?.page?.kind === "worldline_roundtable"
      && reseated?.page?.controls?.has_result === true
      && reseated?.page?.controls?.showing_picker === false
      && Boolean(reseated?.scene?.room_id)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !reseated?.page?.kind
    || reseated.page.kind !== "worldline_roundtable"
    || reseated?.page?.controls?.has_result !== true
    || reseated?.page?.controls?.showing_picker !== false
    || !reseated?.scene?.room_id
  ) {
    throw new Error("Timed out waiting for reseated roundtable");
  }

  return {
    previousRoomId,
    nextRoomId: reseated?.scene?.room_id ?? null,
    nextRepresentative,
    selectionMode: reseated?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: reseated?.page?.controls?.selected_branch_count ?? null,
  };
}

async function dragReseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const sourceCard = page
    .locator(".worldline-roundtable-picker-branch.is-active")
    .first()
    .locator(".worldline-roundtable-picker-card:not(.is-selected)")
    .first();
  const targetSlot = page.locator('[data-testid^="roundtable-seat-slot-"]').first();
  await sourceCard.scrollIntoViewIfNeeded();
  await targetSlot.scrollIntoViewIfNeeded();

  const sourceName = ((await sourceCard.locator("strong").innerText().catch(() => "")) || "").trim();
  if (!sourceName) {
    throw new Error("Could not resolve drag source representative");
  }

  const dragOnce = async () => {
    const sourceBox = await sourceCard.boundingBox();
    const targetBox = await targetSlot.boundingBox();
    if (!sourceBox || !targetBox) {
      throw new Error("Could not resolve drag-and-drop bounds");
    }
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 18 });
    await page.mouse.up();
  };

  let slotName = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dragOnce();
    await page.waitForTimeout(350);
    slotName = ((await targetSlot.locator("strong").innerText().catch(() => "")) || "").trim();
    if (slotName === sourceName) {
      break;
    }
  }

  if (slotName !== sourceName) {
    throw new Error(`Desktop drag-and-drop did not update the seat occupant (expected ${sourceName}, got ${slotName || "empty"})`);
  }

  const reopenButton = page.getByRole("button", {
    name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup|Open this lineup/i,
  }).first();
  const start = Date.now();
  let reseated = null;
  while (Date.now() - start < 45000) {
    if (await reopenButton.isVisible().catch(() => false)) {
      await reopenButton.click().catch(() => {});
    }
    reseated = await readAutomation(page);
    if (
      reseated?.page?.kind === "worldline_roundtable"
      && reseated?.page?.controls?.has_result === true
      && reseated?.page?.controls?.showing_picker === false
      && Boolean(reseated?.scene?.room_id)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !reseated?.page?.kind
    || reseated.page.kind !== "worldline_roundtable"
    || reseated?.page?.controls?.has_result !== true
    || reseated?.page?.controls?.showing_picker !== false
    || !reseated?.scene?.room_id
  ) {
    throw new Error("Timed out waiting for drag-reseated roundtable");
  }

  return {
    previousRoomId,
    nextRoomId: reseated?.scene?.room_id ?? null,
    nextRepresentative: sourceName,
    selectionMode: reseated?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: reseated?.page?.controls?.selected_branch_count ?? null,
  };
}

async function clickReseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  let nextRepresentative = null;
  const branchCards = page.locator(
    ".worldline-roundtable-picker-card:not(.is-selected):not([disabled])"
  );
  const branchCardCount = await branchCards.count();
  for (let index = 0; index < branchCardCount; index += 1) {
    const card = branchCards.nth(index);
    await card.scrollIntoViewIfNeeded().catch(() => {});
    nextRepresentative = (await card.locator("strong").innerText()).trim();
    await tapLocator(page, card, "mobile click-to-seat card");
    break;
  }

  const seatSelector = '[data-testid^="roundtable-seat-slot-"] strong';
  const seatNames = await page.locator(seatSelector).allInnerTexts().catch(() => []);
  if (!nextRepresentative) {
    throw new Error("Mobile click-to-seat could not find a non-selected candidate");
  }
  if (!seatNames.some((name) => name.trim() === nextRepresentative)) {
    throw new Error(`Mobile click-to-seat did not update the seating board (expected ${nextRepresentative})`);
  }

  const reopenButton = page.getByRole("button", {
    name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup|Open this lineup/i,
  }).first();

  const start = Date.now();
  let reseated = null;
  while (Date.now() - start < 45000) {
    if (await reopenButton.isVisible().catch(() => false)) {
      await reopenButton.click().catch(() => {});
    }
    reseated = await readAutomation(page);
    if (
      reseated?.page?.kind === "worldline_roundtable"
      && reseated?.page?.controls?.has_result === true
      && reseated?.page?.controls?.showing_picker === false
      && Boolean(reseated?.scene?.room_id)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !reseated?.page?.kind
    || reseated.page.kind !== "worldline_roundtable"
    || reseated?.page?.controls?.has_result !== true
    || reseated?.page?.controls?.showing_picker !== false
    || !reseated?.scene?.room_id
  ) {
    throw new Error("Timed out waiting for click-reseated roundtable");
  }

  return {
    previousRoomId,
    nextRoomId: reseated?.scene?.room_id ?? null,
    nextRepresentative,
    selectionMode: reseated?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: reseated?.page?.controls?.selected_branch_count ?? null,
  };
}

async function keyboardReseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const sourceCard = page
    .locator(".worldline-roundtable-picker-branch.is-active .worldline-roundtable-picker-card:not(.is-selected):not([disabled])")
    .first();
  const targetSlot = page.locator('[data-testid^="roundtable-seat-slot-"]').first();

  if (!(await sourceCard.isVisible().catch(() => false))) {
    throw new Error("Keyboard reseat could not find a non-selected candidate");
  }

  const nextRepresentative = ((await sourceCard.locator("strong").innerText().catch(() => "")) || "").trim();
  if (!nextRepresentative) {
    throw new Error("Keyboard reseat could not resolve candidate name");
  }

  await sourceCard.scrollIntoViewIfNeeded().catch(() => {});
  await sourceCard.focus();
  await page.keyboard.press("Space");

  let overValid = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(60);
    overValid = await targetSlot.evaluate((node) => node.classList.contains("worldline-roundtable-seating-slot--over-valid")).catch(() => false);
    if (overValid) {
      break;
    }
  }

  if (!overValid) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new Error("Keyboard drag never reached a valid seat");
  }

  await page.keyboard.press("Space");
  await page.waitForTimeout(200);

  const slotName = ((await targetSlot.locator("strong").innerText().catch(() => "")) || "").trim();
  if (slotName !== nextRepresentative) {
    throw new Error(`Keyboard drag-and-drop did not update the seat occupant (expected ${nextRepresentative}, got ${slotName || "empty"})`);
  }

  const reopenButton = page.getByRole("button", {
    name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup|Open this lineup/i,
  }).first();
  const start = Date.now();
  let reseated = null;
  while (Date.now() - start < 45000) {
    if (await reopenButton.isVisible().catch(() => false)) {
      await reopenButton.click().catch(() => {});
    }
    reseated = await readAutomation(page);
    if (
      reseated?.page?.kind === "worldline_roundtable"
      && reseated?.page?.controls?.has_result === true
      && reseated?.page?.controls?.showing_picker === false
      && Boolean(reseated?.scene?.room_id)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !reseated?.page?.kind
    || reseated.page.kind !== "worldline_roundtable"
    || reseated?.page?.controls?.has_result !== true
    || reseated?.page?.controls?.showing_picker !== false
    || !reseated?.scene?.room_id
  ) {
    throw new Error("Timed out waiting for keyboard-reseated roundtable");
  }

  return {
    previousRoomId,
    nextRoomId: reseated?.scene?.room_id ?? null,
    nextRepresentative,
    selectionMode: reseated?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: reseated?.page?.controls?.selected_branch_count ?? null,
  };
}

async function addExpertWitness(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const expertWitnessButton = page.getByRole("button", { name: /Expert witness|专家证人/i }).first();
  if (await expertWitnessButton.isVisible().catch(() => false)) {
    await expertWitnessButton.click();
  }

  const witnessCards = page.locator(".worldline-roundtable-picker-witness .worldline-roundtable-picker-card");
  const witnessCardCount = await witnessCards.count();
  let witnessName = null;
  for (let index = 0; index < witnessCardCount; index += 1) {
    const witnessCard = witnessCards.nth(index);
    if (!(await witnessCard.isVisible().catch(() => false))) {
      continue;
    }
    witnessName = (await witnessCard.locator("strong").innerText()).trim();
    const enabled = await witnessCard.isEnabled().catch(() => false);
    if (enabled) {
      await witnessCard.click();
    }
    break;
  }

  const reopenButton = page.getByRole("button", {
    name: /Open this lineup|Reopen this lineup|按当前代表开桌|按当前阵容重开/i,
  }).first();

  const start = Date.now();
  let witnessState = null;
  while (Date.now() - start < 45000) {
    if (await reopenButton.isVisible().catch(() => false)) {
      await reopenButton.click().catch(() => {});
    }
    witnessState = await readAutomation(page);
    if (
      witnessState?.page?.kind === "worldline_roundtable"
      && witnessState?.page?.controls?.selection_mode === "expert_witness"
      && witnessState?.page?.controls?.has_result === true
      && witnessState?.page?.controls?.has_witness === true
      && Boolean(witnessState?.scene?.room_id)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !witnessState?.page?.kind
    || witnessState.page.kind !== "worldline_roundtable"
    || witnessState?.page?.controls?.selection_mode !== "expert_witness"
    || witnessState?.page?.controls?.has_result !== true
    || witnessState?.page?.controls?.has_witness !== true
    || !witnessState?.scene?.room_id
  ) {
    throw new Error("Timed out waiting for expert witness roundtable");
  }

  return {
    previousRoomId,
    nextRoomId: witnessState?.scene?.room_id ?? null,
    witnessName,
    selectionMode: witnessState?.page?.controls?.selection_mode ?? null,
    hasWitness: witnessState?.page?.controls?.has_witness ?? false,
  };
}

async function reopenWithSelectionMode(page, {
  modeButton,
  expectedMode,
  expectWitness = false,
  label,
}) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });
  await page.getByRole("button", { name: modeButton }).first().click();
  const reopenButton = page.getByRole("button", {
    name: /Open this lineup|Reopen this lineup|按当前代表开桌|按当前阵容重开/i,
  }).first();

  const start = Date.now();
  let state = null;
  while (Date.now() - start < 45000) {
    if (await reopenButton.isVisible().catch(() => false)) {
      await reopenButton.click().catch(() => {});
    }
    state = await readAutomation(page);
    if (
      state?.page?.kind === "worldline_roundtable"
      && state?.page?.controls?.selection_mode === expectedMode
      && state?.page?.controls?.has_result === true
      && state?.page?.controls?.showing_picker === false
      && Boolean(state?.scene?.room_id)
      && (!expectWitness || state?.page?.controls?.has_witness === true)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !state?.page?.kind
    || state.page.kind !== "worldline_roundtable"
    || state?.page?.controls?.selection_mode !== expectedMode
    || state?.page?.controls?.has_result !== true
    || state?.page?.controls?.showing_picker !== false
    || !state?.scene?.room_id
    || (expectWitness && state?.page?.controls?.has_witness !== true)
  ) {
    throw new Error(`Timed out waiting for ${label}`);
  }

  return {
    previousRoomId,
    nextRoomId: state?.scene?.room_id ?? null,
    selectionMode: state?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: state?.page?.controls?.selected_branch_count ?? null,
    hasWitness: state?.page?.controls?.has_witness ?? false,
  };
}

async function runDesktop(context, baseUrl, backendUrl, outputDir, scenarioId) {
  const page = await context.newPage();
  const ready = await openRoundtable(page, baseUrl, scenarioId);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-ready.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-ready.json"), ready);

  const dragReseated = await dragReseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-drag-reseated.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-drag-reseated.json"), dragReseated);

  const keyboardReseated = await keyboardReseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-keyboard-reseated.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-keyboard-reseated.json"), keyboardReseated);

  const reseated = await reseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-reseated.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-reseated.json"), reseated);

  const expertWitness = await addExpertWitness(page);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-expert-witness.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-expert-witness.json"), expertWitness);

  const traitMix = await reopenWithSelectionMode(page, {
    modeButton: /Trait mix|冲突人设混编/i,
    expectedMode: "trait_mix",
    label: "trait mix roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-trait-mix.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-trait-mix.json"), traitMix);

  const faultLineFirst = await reopenWithSelectionMode(page, {
    modeButton: /Fault line first|先看最大分歧/i,
    expectedMode: "fault_line_first",
    label: "fault line first roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-fault-line-first.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-fault-line-first.json"), faultLineFirst);

  const witnessAugmented = await reopenWithSelectionMode(page, {
    modeButton: /Witness augmented|自动增补证人/i,
    expectedMode: "witness_augmented",
    label: "witness augmented roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-witness-augmented.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-witness-augmented.json"), witnessAugmented);

  const archivist = await sendComposer(
    page,
    "请只用本桌 scope 总结：哪条世界线的第一处失误最致命？",
    /Archivist lead|Archivist-guided|Archivist route|档案官主持|档案官引导|档案官路由/i,
  );
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-archivist.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-archivist.json"), archivist);
  await waitForDraftBubblesToSettle(page, "desktop archivist draft settle");

  await page.getByRole("button", { name: /Question one rep|Representative hotseat|点名代表|代表热座/i }).click();
  const hotseatTargets = await page.locator(".ending-chat-hotseat-pill").count();
  if (hotseatTargets > 0) {
    await page.locator(".ending-chat-hotseat-pill").first().click();
  }
  const hotseat = await sendComposer(
    page,
    "只盯你这条线回答：如果把最关键的一步延后一轮，会先坏在哪里？",
    /Question one rep|Representative hotseat|点名代表|代表热座/i,
    {
      expectThreadSwitch: true,
      expectedInteractionMode: "hotseat",
      outputDir,
      filePrefix: "desktop-roundtable-hotseat-stream",
      skipModeClick: true,
    },
  );
  const hotseatState = hotseat.payload;
  await waitForDraftBubblesToSettle(page, "desktop hotseat draft settle");
  await waitForTranscriptActionsReady(page, "desktop hotseat quote actions");
  const hotseatSettled = await readAutomation(page);
  await focusHotseatThread(page, hotseatState?.page?.controls?.active_thread_id ?? null);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-hotseat.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-hotseat.json"), {
    state: hotseatSettled ?? hotseatState,
    stream_lifecycle: hotseat.captures,
  });
  await createVerdictAnchoredThread(page, "desktop verdict anchored thread");
  const anchoredThreadLifecycle = await sendAnchoredFollowup(page, "desktop anchored follow-up commit", {
    outputDir,
    filePrefix: "desktop-roundtable-anchored-thread-stream",
  });
  const anchoredThread = anchoredThreadLifecycle.payload;
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-anchored-thread.json"), {
    state: anchoredThread,
    stream_lifecycle: anchoredThreadLifecycle.captures,
  });

  await armClipboardCapture(page);
  await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
  const shareReplayUrl = await waitForCapturedClipboardUrl(page, "roundtable copied share permalink");
  const sharePage = await context.newPage();
  await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
  const artifactReadonly = await waitForAutomation(
    sharePage,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.is_read_only === true
      && payload.page?.controls?.can_send === false
      && payload.page?.controls?.active_thread_id === anchoredThreadId
      && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
      && payload.page?.controls?.anchor_kind === "quote",
    15000,
    "roundtable artifact replay readonly state",
  );
  await saveScreenshot(sharePage, path.join(outputDir, "desktop-roundtable-replay-artifact.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-artifact.json"), artifactReadonly);
  await sharePage.getByRole("button", { name: /Import local run|导入本地运行/i }).click();
  await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
  const artifactImportedUrl = sharePage.url();

  await page.getByRole("button", { name: /Save(?:d)? (local )?read-only copy|Read-only copy saved|保存本地只读副本|已保存本地只读副本|保存只读副本|只读副本已保存/i }).click();
  await page.waitForURL(/\/roundtable\/replay\?roomLocal=/, { timeout: 15000 });
  const replayReadonly = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.is_read_only === true
      && payload.page?.controls?.can_send === false
      && payload.page?.controls?.active_thread_id === anchoredThreadId
      && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
      && payload.page?.controls?.anchor_kind === "quote",
    15000,
    "roundtable replay readonly state",
  );
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-replay-readonly.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-readonly.json"), replayReadonly);

  return {
    scenarioId,
    ready,
    dragReseated,
    keyboardReseated,
    reseated,
    expertWitness,
    traitMix,
    faultLineFirst,
    witnessAugmented,
    archivist,
    hotseat: hotseatState,
    hotseatStreamLifecycle: hotseat.captures,
    anchoredThread,
    anchoredThreadStreamLifecycle: anchoredThreadLifecycle.captures,
    artifactReadonly,
    artifactImportedUrl,
    replayReadonly,
  };
}

async function runMobile(browser, baseUrl, backendUrl, outputDir, scenarioId) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const ready = await openRoundtable(page, baseUrl, scenarioId);
  const fit = await captureMobileFit(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-ready.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-ready.json"), { ready, fit });

  const clickReseated = await clickReseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-click-reseated.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-click-reseated.json"), clickReseated);

  const traitMix = await reopenWithSelectionMode(page, {
    modeButton: /Trait mix|冲突人设混编/i,
    expectedMode: "trait_mix",
    label: "mobile trait mix roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-trait-mix.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-trait-mix.json"), traitMix);

  const faultLineFirst = await reopenWithSelectionMode(page, {
    modeButton: /Fault line first|先看最大分歧/i,
    expectedMode: "fault_line_first",
    label: "mobile fault line first roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-fault-line-first.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-fault-line-first.json"), faultLineFirst);

  const witnessAugmented = await reopenWithSelectionMode(page, {
    modeButton: /Witness augmented|自动增补证人/i,
    expectedMode: "witness_augmented",
    label: "mobile witness augmented roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-witness-augmented.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-witness-augmented.json"), witnessAugmented);

  await page.getByRole("button", { name: /Question one rep|Representative hotseat|点名代表|代表热座/i }).click();
  const hotseatTargets = await page.locator(".ending-chat-hotseat-pill").count();
  if (hotseatTargets > 0) {
    await page.locator(".ending-chat-hotseat-pill").first().click();
  }
  const hotseat = await sendComposer(
    page,
    "只盯你这条线回答：如果把最关键的一步延后一轮，会先坏在哪里？",
    /Question one rep|Representative hotseat|点名代表|代表热座/i,
    {
      expectThreadSwitch: true,
      expectedInteractionMode: "hotseat",
      outputDir,
      filePrefix: "mobile-roundtable-hotseat-stream",
      skipModeClick: true,
    },
  );
  const hotseatState = hotseat.payload;
  const hotseatThreadId = hotseatState?.page?.controls?.active_thread_id ?? null;
  await waitForDraftBubblesToSettle(page, "mobile hotseat draft settle");
  await focusHotseatThread(page, hotseatThreadId);
  await waitForTranscriptActionsReady(page, "mobile hotseat quote actions");
  const hotseatSettled = await readAutomation(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-hotseat.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-hotseat.json"), {
    state: hotseatSettled ?? hotseatState,
    stream_lifecycle: hotseat.captures,
  });
  await createVerdictAnchoredThread(page, "mobile verdict anchored thread");
  const anchoredThreadLifecycle = await sendAnchoredFollowup(page, "mobile anchored follow-up commit", {
    outputDir,
    filePrefix: "mobile-roundtable-anchored-thread-stream",
  });
  const anchoredThread = anchoredThreadLifecycle.payload;
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-anchored-thread.json"), {
    state: anchoredThread,
    stream_lifecycle: anchoredThreadLifecycle.captures,
  });

  await armClipboardCapture(page);
  let artifactReadonly = null;
  let artifactReloaded = null;
  let artifactImportedUrl = null;
  let replayReadonly = null;
  let replayReloaded = null;
  let replayCoverageError = null;
  try {
    await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "mobile roundtable copied share permalink");
    const sharePage = await context.newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitForAutomation(
      sharePage,
      (payload) => payload.page?.kind === "worldline_roundtable"
        && payload.page?.controls?.is_read_only === true
        && payload.page?.controls?.can_send === false
        && payload.page?.controls?.interaction_mode === "thread_followup"
        && payload.page?.controls?.active_thread_id === anchoredThreadId
        && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
        && payload.page?.controls?.anchor_kind === "quote",
      20000,
      "mobile roundtable artifact replay readonly state",
    );
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-roundtable-replay-artifact.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-artifact.json"), artifactReadonly);
    await sharePage.reload({ waitUntil: "domcontentloaded" });
    artifactReloaded = await waitForAutomation(
      sharePage,
      (payload) => payload.page?.kind === "worldline_roundtable"
        && payload.page?.controls?.is_read_only === true
        && payload.page?.controls?.interaction_mode === "thread_followup"
        && payload.page?.controls?.active_thread_id === anchoredThreadId
        && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
        && payload.page?.controls?.anchor_kind === "quote",
      20000,
      "mobile roundtable artifact readonly restore",
    );
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-roundtable-replay-artifact-reloaded.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-artifact-reloaded.json"), artifactReloaded);
    await sharePage.getByRole("button", { name: /Import local run|导入本地运行/i }).click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();

    await page.getByRole("button", { name: /Save(?:d)? (local )?read-only copy|Read-only copy saved|保存本地只读副本|已保存本地只读副本|保存只读副本|只读副本已保存/i }).click();
    await page.waitForURL(/\/roundtable\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "worldline_roundtable"
        && payload.page?.controls?.is_read_only === true
        && payload.page?.controls?.can_send === false
        && payload.page?.controls?.interaction_mode === "thread_followup"
        && payload.page?.controls?.active_thread_id === anchoredThreadId
        && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
        && payload.page?.controls?.anchor_kind === "quote",
      20000,
      "mobile roundtable replay readonly state",
    );
    await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-replay-readonly.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-readonly.json"), replayReadonly);
    await page.reload({ waitUntil: "domcontentloaded" });
    replayReloaded = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "worldline_roundtable"
        && payload.page?.controls?.is_read_only === true
        && payload.page?.controls?.interaction_mode === "thread_followup"
        && payload.page?.controls?.active_thread_id === anchoredThreadId
        && anchorIdsEqual(payload.page?.controls?.question_anchor_ids, anchoredAnchorIds)
        && payload.page?.controls?.anchor_kind === "quote",
      20000,
      "mobile roundtable readonly restore",
    );
    await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-replay-readonly-reloaded.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-readonly-reloaded.json"), replayReloaded);
  } catch (error) {
    replayCoverageError = String(error);
    writeJson(path.join(outputDir, "mobile-roundtable-replay-coverage-error.json"), { error: replayCoverageError });
  }

  await closePlaywrightContext(context, "roundtable-mobile-context", 15000);
  return {
    scenarioId,
    ready,
    fit,
    clickReseated,
    traitMix,
    faultLineFirst,
    witnessAugmented,
    hotseat: hotseatState,
    hotseatStreamLifecycle: hotseat.captures,
    anchoredThread,
    anchoredThreadStreamLifecycle: anchoredThreadLifecycle.captures,
    artifactReadonly,
    artifactReloaded,
    artifactImportedUrl,
    replayReadonly,
    replayReloaded,
    replayCoverageError,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-worldline-roundtable`);
  ensureDir(outputDir);

  const preferredScenarioIds = readPreferredScenarioIds();
  const fallbackScenarioId = await findMultiEndingScenarioId(args.backendUrl);
  const desktopScenarioId = await resolvePreferredScenarioId(args.backendUrl, preferredScenarioIds.desktop)
    ?? fallbackScenarioId;
  const mobileScenarioId = await resolvePreferredScenarioId(args.backendUrl, preferredScenarioIds.mobile)
    ?? desktopScenarioId;
  const summary = {};

  if (args.mode === "desktop" || args.mode === "full") {
    const desktopBrowser = await launchBrowser(args.headless, args.browser);
    try {
      const context = await desktopBrowser.newContext({ viewport: { width: 1600, height: 900 } });
      summary.desktop = await runDesktop(context, args.baseUrl, args.backendUrl, outputDir, desktopScenarioId);
      await closePlaywrightContext(context, "roundtable-desktop-context", 15000);
    } finally {
      await closePlaywrightBrowser(desktopBrowser, "roundtable-desktop-browser", 20000);
    }
  }

  if (args.mode === "mobile" || args.mode === "full") {
    const mobileBrowser = await launchBrowser(args.headless, args.browser);
    try {
      summary.mobile = await runMobile(mobileBrowser, args.baseUrl, args.backendUrl, outputDir, mobileScenarioId);
    } finally {
      await closePlaywrightBrowser(mobileBrowser, "roundtable-mobile-browser", 20000);
    }
  }

  writeJson(path.join(outputDir, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .then(() => {
    // Playwright can leave lingering handles even after best-effort teardown.
    // This script is CLI-only, so exit explicitly once all artifacts are written.
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
