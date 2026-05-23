import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";
import {
  ENDING_ROOM_COPY_REPLAY_PATTERN,
  ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN,
  ENDING_ROOM_SAVE_READONLY_COPY_PATTERN,
} from "../src/lib/endingRoomReplayAutomation.js";
import { assertReplayCoverage } from "../src/lib/e2eReplayGuards.js";
import {
  isLiveRoundtableAutomationPayload,
  isReadonlyRoundtableAutomationPayload,
} from "../src/lib/roundtableReplayAutomation.js";
import { closePlaywrightBrowser, closePlaywrightContext } from "./playwrightTeardown.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";
const VALID_BROWSERS = new Set(["chromium", "firefox", "webkit"]);
const VALID_LOCALES = new Set(["zh", "en"]);
const LANGUAGE_STORAGE_KEY = "swarmoracle:language:v1";
const ROUNDTABLE_READY_TIMEOUT_MS = 90000;
const ROUNDTABLE_USER_TURN_SETTLE_TIMEOUT_MS = 120000;
const RESEAT_REOPEN_BUTTON_PATTERN = /Reseat & restart|Reseat and reopen|换人重开|改选代表并重开/i;
const MORE_ACTIONS_BUTTON_PATTERN = /More actions|更多操作/i;
const MODE_MANUAL_SHORTLIST_PATTERN = /Hand-pick|Manual shortlist|手动挑选|手动短名单/i;
const MODE_EXPERT_WITNESS_PATTERN = /Invite expert|Expert witness|请专家|专家证人/i;
const MODE_TRAIT_MIX_PATTERN = /Clash mix|Trait mix|观点对冲|冲突人设混编/i;
const MODE_FAULT_LINE_FIRST_PATTERN = /Biggest split first|Fault line first|分歧优先|先看最大分歧/i;
const MODE_WITNESS_AUGMENTED_PATTERN = /Auto-fill|Witness augmented|自动补人|自动增补证人/i;
const HOTSEAT_MODE_PATTERN = /Question one rep|Representative hotseat|单独追问|点名代表|代表热座/i;
const NEW_THREAD_BUTTON_PATTERN = /Start anchored thread|New topic|另开线程|新开话题/i;
const CURRENT_ANCHOR_THREAD_BUTTON_PATTERN = /Start thread from current anchor|New topic from here|从当前锚点开始线程|从当前锚点发起线程|按当前锚点另开线程|就这个点新开话题/i;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeLocale(locale) {
  return String(locale ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

function resolveDocumentLanguage(locale) {
  return normalizeLocale(locale) === "zh" ? "zh-CN" : "en";
}

function resolveContextLocale(locale) {
  return normalizeLocale(locale) === "zh" ? "zh-CN" : "en-US";
}

async function configureLocaleContext(context, locale) {
  const normalizedLocale = normalizeLocale(locale);
  await context.addInitScript(
    ({ storageKey, nextLocale, documentLanguage }) => {
      try {
        window.localStorage.setItem(storageKey, nextLocale);
      } catch {
        // Ignore automation bootstrap storage failures.
      }
      document.documentElement.lang = documentLanguage;
    },
    {
      storageKey: LANGUAGE_STORAGE_KEY,
      nextLocale: normalizedLocale,
      documentLanguage: resolveDocumentLanguage(normalizedLocale),
    },
  );
}

async function readLocaleState(page) {
  return page.evaluate((storageKey) => ({
    document_language: document.documentElement.lang,
    stored_language: window.localStorage.getItem(storageKey),
  }), LANGUAGE_STORAGE_KEY);
}

async function openReseatEditor(page) {
  const directButton = page.getByRole("button", { name: RESEAT_REOPEN_BUTTON_PATTERN }).first();
  if (await directButton.isVisible().catch(() => false)) {
    await directButton.click();
    return;
  }

  const menuTrigger = page.getByRole("button", { name: MORE_ACTIONS_BUTTON_PATTERN }).first();
  if (await menuTrigger.isVisible().catch(() => false)) {
    await menuTrigger.click();
  } else {
    await page.locator(".roundtable-hero-action-menu__trigger").first().click();
  }

  await page.getByRole("button", { name: RESEAT_REOPEN_BUTTON_PATTERN }).first().click();
}

function assertUiLocaleState(localeState, locale, label) {
  const expectedLocale = normalizeLocale(locale);
  const expectedDocumentPrefix = expectedLocale === "zh" ? "zh" : "en";
  const actualDocumentLanguage = String(localeState?.document_language ?? "").toLowerCase();
  const actualStoredLanguage = normalizeLocale(localeState?.stored_language ?? "");
  if (!actualDocumentLanguage.startsWith(expectedDocumentPrefix)) {
    throw new Error(`${label} expected document.lang to start with ${expectedDocumentPrefix}, got ${localeState?.document_language ?? "null"}`);
  }
  if (actualStoredLanguage !== expectedLocale) {
    throw new Error(`${label} expected stored locale ${expectedLocale}, got ${localeState?.stored_language ?? "null"}`);
  }
  return localeState;
}

async function assertUiLocale(page, locale, label) {
  const localeState = await readLocaleState(page);
  return assertUiLocaleState(localeState, locale, label);
}

export function resolveRoundtableDragTargetTestId(sourceBranchId) {
  const branchId = String(sourceBranchId ?? "").trim();
  if (!branchId) {
    throw new Error("Missing source branch id for roundtable desktop drag target");
  }
  return `roundtable-seat-slot-${branchId}`;
}

function buildTestIdSelector(testId) {
  return `[data-testid="${String(testId).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}

async function readSeatOccupantName(targetSlot) {
  return ((await targetSlot.locator("strong").innerText().catch(() => "")) || "").trim();
}

async function waitForSeatOccupantName(page, targetTestId, expectedName, timeoutMs = 2500) {
  const selector = buildTestIdSelector(targetTestId);
  await page.waitForFunction(
    ({ seatSelector, name }) => {
      const text = document.querySelector(`${seatSelector} strong`)?.textContent?.trim() ?? "";
      return text === name;
    },
    { seatSelector: selector, name: expectedName },
    { timeout: timeoutMs },
  );
  return expectedName;
}

async function centerDragPairInViewport(page, sourceHandle, targetHandle) {
  await sourceHandle.evaluate((sourceNode, seatNode) => {
    const sourceRect = sourceNode.getBoundingClientRect();
    const seatRect = seatNode.getBoundingClientRect();
    const pairTop = Math.min(sourceRect.top, seatRect.top) + window.scrollY;
    const pairBottom = Math.max(sourceRect.bottom, seatRect.bottom) + window.scrollY;
    const pairCenter = pairTop + (pairBottom - pairTop) / 2;
    window.scrollTo({
      top: Math.max(0, pairCenter - window.innerHeight / 2),
      behavior: "auto",
    });
  }, targetHandle);
  await page.waitForTimeout(100);
}

async function collectDesktopDragDiagnostics(page, sourceHandle, targetSlot, targetTestId) {
  const sourceBox = await sourceHandle.boundingBox().catch(() => null);
  const targetBox = await targetSlot.boundingBox().catch(() => null);
  const sourceState = await sourceHandle.evaluate((node) => ({
    className: node.className,
    branchId: node.getAttribute("data-branch-id"),
    agentId: node.getAttribute("data-agent-id"),
    text: node.textContent?.trim() ?? "",
  })).catch((error) => ({ error: error.message }));
  const seats = await page.evaluate(() => (
    Array.from(document.querySelectorAll('[data-testid^="roundtable-seat-slot-"]')).map((node) => ({
      testId: node.getAttribute("data-testid"),
      className: node.className,
      text: node.textContent?.trim() ?? "",
    }))
  )).catch((error) => [{ error: error.message }]);
  return {
    targetTestId,
    sourceBox,
    targetBox,
    sourceState,
    seats,
  };
}

async function keyboardDropCandidateToSeat(page, sourceCard, targetSlot, expectedName, targetTestId) {
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
    throw new Error("Keyboard fallback drag never reached a valid seat");
  }

  await page.keyboard.press("Space");
  await waitForSeatOccupantName(page, targetTestId, expectedName).catch(() => null);
  return readSeatOccupantName(targetSlot);
}

async function clickSelectCandidateForSeat(page, sourceCard, targetSlot, expectedName, targetTestId) {
  await sourceCard.scrollIntoViewIfNeeded().catch(() => {});
  await clickActionable(sourceCard, "roundtable drag fallback candidate");
  await waitForSeatOccupantName(page, targetTestId, expectedName).catch(() => null);
  return readSeatOccupantName(targetSlot);
}

function getRoundtableArchivistPrompt(locale) {
  return normalizeLocale(locale) === "en"
    ? "Use only this table's scope: which worldline's first mistake was most fatal?"
    : "请只用本桌 scope 总结：哪条世界线的第一处失误最致命？";
}

function getRoundtableHotseatPrompt(locale) {
  return normalizeLocale(locale) === "en"
    ? "Stay on your own line only: if the key move slipped by one round, what breaks first?"
    : "只盯你这条线回答：如果把最关键的一步延后一轮，会先坏在哪里？";
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    backendUrl: DEFAULT_BACKEND_URL,
    outputDir: "",
    browser: "chromium",
    headless: process.env.HEADLESS === "1",
    locale: normalizeLocale(process.env.SWARM_E2E_LOCALE || "zh"),
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
    } else if (arg === "--locale" && next) {
      args.locale = normalizeLocale(next);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-worldline-roundtable-suite.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--output-dir DIR] [--browser chromium|firefox|webkit] [--locale en|zh] [--headless]");
  }
  if (!VALID_BROWSERS.has(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }
  if (!VALID_LOCALES.has(args.locale)) {
    throw new Error(`Unsupported locale: ${args.locale}`);
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

async function assertRoomLanguage(backendUrl, roomId, locale, label) {
  const snapshot = await fetchJson(`${backendUrl}/api/ending-room/${roomId}`);
  if (snapshot?.language !== locale) {
    throw new Error(`${label} expected room.language=${locale}, got ${snapshot?.language ?? "null"}`);
  }
  return snapshot.language;
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

function locateRoundtableHeaderAction(page, namePattern) {
  return page
    .locator(".worldline-roundtable-hero__actions button")
    .filter({ hasText: namePattern })
    .last();
}

async function waitForRoundtableHeaderAction(page, {
  label,
  namePattern,
  timeout = 30000,
} = {}) {
  let action = locateRoundtableHeaderAction(page, namePattern);
  if (!(await action.isVisible({ timeout: 500 }).catch(() => false))) {
    const menuTrigger = page.getByRole("button", { name: MORE_ACTIONS_BUTTON_PATTERN }).first();
    if (await menuTrigger.isVisible().catch(() => false)) {
      await menuTrigger.click();
    }
    action = locateRoundtableHeaderAction(page, namePattern);
  }
  await action.waitFor({ state: "visible", timeout });
  return action;
}

async function waitForLiveRoundtableReady(page, {
  expectedRoomId = null,
  expectedActiveThreadId = null,
  expectedQuestionAnchorIds = null,
  expectedAnchorKind = null,
  expectedInteractionMode = null,
  timeout = 10000,
  label = "roundtable live replay preflight",
} = {}) {
  return waitForAutomation(
    page,
    (payload) => isLiveRoundtableAutomationPayload(payload, {
      expectedRoomId,
      expectedActiveThreadId,
      expectedQuestionAnchorIds,
      expectedAnchorKind,
      expectedInteractionMode,
    }),
    timeout,
    label,
  );
}

async function waitForReadonlyRoundtableReplayVisible(page, {
  replayKind = "either",
  expectedActiveThreadId = null,
  expectedQuestionAnchorIds = null,
  expectedAnchorKind = null,
  expectedInteractionMode = null,
  timeout = 20000,
  label = "roundtable replay readonly state",
} = {}) {
  return waitForAutomation(
    page,
    (payload) => isReadonlyRoundtableAutomationPayload(payload, {
      replayUrl: page.url(),
      replayKind,
      expectedActiveThreadId,
      expectedQuestionAnchorIds,
      expectedAnchorKind,
      expectedInteractionMode,
    }),
    timeout,
    label,
  );
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

function isRetryableGotoError(error) {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError"
    || error.message.includes("page.goto: Timeout")
    || error.message.includes("ERR_HTTP_RESPONSE_CODE_FAILURE");
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

async function openRoundtable(page, baseUrl, backendUrl, scenarioId, outputDir, locale) {
  const resultUrl = `${baseUrl}/result/${scenarioId}`;
  const resultRoutePattern = new RegExp(`/result/${scenarioId}(?:[?#].*)?$`);
  const roundtableRoutePattern = new RegExp(`/roundtable/${scenarioId}(?:[/?#].*)?$`);
  await gotoWithRetry(page, resultUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  const entryButton = page.getByRole("button", {
    name: normalizeLocale(locale) === "en" ? /Start Roundtable/i : /Start Roundtable|开始圆桌|发起圆桌/i,
  }).first();
  await entryButton.waitFor({ state: "visible", timeout: 30000 });
  await clickActionable(entryButton, "roundtable entry CTA");
  const launchButton = page.getByRole("button", {
    name: normalizeLocale(locale) === "en"
      ? /Open with selected representatives|Open this lineup/i
      : /Open with selected representatives|Open this lineup|以当前代表开桌|按当前代表开桌|按这套代表开桌/i,
  }).first();
  const start = Date.now();
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
    const automation = await readAutomation(page);
    if (automation?.page?.kind === "worldline_roundtable" && automation?.page?.controls?.has_result === true) {
      return automation;
    }
    if (roundtableRoutePattern.test(page.url())) {
      if (await launchButton.isVisible().catch(() => false)) {
        await clickActionable(launchButton, "roundtable launch lineup").catch(() => {});
      }
    } else if (resultRoutePattern.test(page.url())) {
      if (await entryButton.isVisible().catch(() => false)) {
        await clickActionable(entryButton, "roundtable entry CTA retry").catch(() => {});
      }
    }
    await page.waitForTimeout(500);
  }
  const stalledAutomation = await readAutomation(page);
  const stalledRoomId = stalledAutomation?.scene?.room_id ?? null;
  const backendSnapshot = stalledRoomId
    ? await fetchJson(`${backendUrl}/api/ending-room/${stalledRoomId}`).catch(() => null)
    : null;
  writeJson(path.join(outputDir, "roundtable-entry-stall.json"), {
    url: page.url(),
    automation: stalledAutomation,
    backend_snapshot: backendSnapshot,
  });
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
      ROUNDTABLE_USER_TURN_SETTLE_TIMEOUT_MS,
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
    undefined,
    { timeout: ROUNDTABLE_USER_TURN_SETTLE_TIMEOUT_MS },
  ).catch(() => {
    throw new Error(`Timed out waiting for ${label}`);
  });
}

async function waitForTranscriptActionsReady(page, label, timeout = 60000) {
  await page.waitForFunction(
    () => document.querySelectorAll(".ending-chat-bubble__actions button").length > 0,
    undefined,
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
    name: NEW_THREAD_BUTTON_PATTERN,
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
    const globalQuoteThreadButton = page.getByRole("button", { name: NEW_THREAD_BUTTON_PATTERN }).last();
    if (await globalQuoteThreadButton.isVisible().catch(() => false)) {
      await clickActionable(globalQuoteThreadButton, `${label} global quote thread button`);
    } else {
      await clickActionable(
        page.getByRole("button", { name: /Archive Verdict|Final Verdict|Verdict|档案总结|档案结论|最终结论|最终裁定|裁决/i }).first(),
        `${label} archive verdict button`,
      );
      await clickActionable(
        page.getByRole("button", { name: CURRENT_ANCHOR_THREAD_BUTTON_PATTERN }),
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
  }, undefined, { timeout: 10000 });
  await page.waitForFunction(() => {
    const raw = window.render_game_to_text?.();
    if (!raw) return false;
    const payload = JSON.parse(raw);
    return payload.page?.controls?.can_send === true;
  }, undefined, { timeout: 10000 });
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
  await openReseatEditor(page);
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const manualShortlistButton = page.getByRole("button", { name: MODE_MANUAL_SHORTLIST_PATTERN }).first();
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
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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
  await openReseatEditor(page);
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const sourceCard = page
    .locator(".worldline-roundtable-picker-branch.is-active")
    .first()
    .locator(".worldline-roundtable-picker-card:not(.is-selected):not([disabled])")
    .first();
  await sourceCard.waitFor({ state: "visible", timeout: 10000 });

  const sourceName = ((await sourceCard.locator("strong").innerText().catch(() => "")) || "").trim();
  if (!sourceName) {
    throw new Error("Could not resolve drag source representative");
  }
  const sourceBranchId = await sourceCard.getAttribute("data-branch-id");
  const targetTestId = resolveRoundtableDragTargetTestId(sourceBranchId);
  const targetSlot = page.getByTestId(targetTestId).first();
  await targetSlot.waitFor({ state: "visible", timeout: 10000 });

  const sourceHandle = await sourceCard.elementHandle();
  const targetHandle = await targetSlot.elementHandle();
  if (!sourceHandle || !targetHandle) {
    throw new Error("Could not resolve drag-and-drop elements");
  }

  const dragOnce = async () => {
    await centerDragPairInViewport(page, sourceHandle, targetHandle);
    const sourceBox = await sourceHandle.boundingBox();
    const targetBox = await targetSlot.boundingBox();
    if (!sourceBox || !targetBox) {
      throw new Error("Could not resolve drag-and-drop bounds");
    }
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.waitForTimeout(80);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2 + Math.min(24, sourceBox.height / 3),
      { steps: 4 },
    );
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 32 });
    await page.waitForTimeout(120);
    await page.mouse.up();
  };

  let slotName = "";
  let dragMethod = "mouse";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dragOnce();
    await waitForSeatOccupantName(page, targetTestId, sourceName).catch(() => null);
    slotName = await readSeatOccupantName(targetSlot);
    if (slotName === sourceName) {
      break;
    }
  }

  if (slotName !== sourceName) {
    try {
      slotName = await keyboardDropCandidateToSeat(page, sourceCard, targetSlot, sourceName, targetTestId);
      dragMethod = "keyboard-after-mouse-miss";
    } catch {
      slotName = await clickSelectCandidateForSeat(page, sourceCard, targetSlot, sourceName, targetTestId);
      dragMethod = "click-after-mouse-keyboard-miss";
    }
  }

  if (slotName !== sourceName) {
    const diagnostics = await collectDesktopDragDiagnostics(page, sourceHandle, targetSlot, targetTestId);
    throw new Error(`Desktop drag-and-drop did not update the seat occupant (expected ${sourceName}, got ${slotName || "empty"}; diagnostics=${JSON.stringify(diagnostics)})`);
  }

  const reopenButton = page.getByRole("button", {
    name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup|Open this lineup/i,
  }).first();
  const start = Date.now();
  let reseated = null;
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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
    dragMethod,
    selectionMode: reseated?.page?.controls?.selection_mode ?? null,
    selectedBranchCount: reseated?.page?.controls?.selected_branch_count ?? null,
  };
}

async function clickReseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await openReseatEditor(page);
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
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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
  await openReseatEditor(page);
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
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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
  await openReseatEditor(page);
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const expertWitnessButton = page.getByRole("button", { name: MODE_EXPERT_WITNESS_PATTERN }).first();
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
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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
  await openReseatEditor(page);
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });
  await page.getByRole("button", { name: modeButton }).first().click();
  const reopenButton = page.getByRole("button", {
    name: /Open this lineup|Reopen this lineup|按当前代表开桌|按当前阵容重开/i,
  }).first();

  const start = Date.now();
  let state = null;
  while (Date.now() - start < ROUNDTABLE_READY_TIMEOUT_MS) {
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

async function runDesktop(context, baseUrl, backendUrl, outputDir, scenarioId, locale) {
  const page = await context.newPage();
  const ready = await openRoundtable(page, baseUrl, backendUrl, scenarioId, outputDir, locale);
  const uiLocale = await assertUiLocale(page, locale, "roundtable desktop ui");
  const roomLanguage = await assertRoomLanguage(backendUrl, ready?.scene?.room_id, locale, "roundtable desktop room");
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-ready.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-ready.json"), { ready, uiLocale, roomLanguage });

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
    modeButton: MODE_TRAIT_MIX_PATTERN,
    expectedMode: "trait_mix",
    label: "trait mix roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-trait-mix.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-trait-mix.json"), traitMix);

  const faultLineFirst = await reopenWithSelectionMode(page, {
    modeButton: MODE_FAULT_LINE_FIRST_PATTERN,
    expectedMode: "fault_line_first",
    label: "fault line first roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-fault-line-first.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-fault-line-first.json"), faultLineFirst);

  const witnessAugmented = await reopenWithSelectionMode(page, {
    modeButton: MODE_WITNESS_AUGMENTED_PATTERN,
    expectedMode: "witness_augmented",
    label: "witness augmented roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-witness-augmented.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-witness-augmented.json"), witnessAugmented);

  const archivist = await sendComposer(
    page,
    getRoundtableArchivistPrompt(locale),
    /Archivist lead|Archivist-guided|Archivist route|档案官主持|档案官引导|档案官路由/i,
    { skipModeClick: true },
  );
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-archivist.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-archivist.json"), archivist);
  await waitForDraftBubblesToSettle(page, "desktop archivist draft settle");

  await page.getByRole("button", { name: HOTSEAT_MODE_PATTERN }).click();
  const hotseatTargets = await page.locator(".ending-chat-hotseat-pill").count();
  if (hotseatTargets > 0) {
    await page.locator(".ending-chat-hotseat-pill").first().click();
  }
  const hotseat = await sendComposer(
    page,
    getRoundtableHotseatPrompt(locale),
    HOTSEAT_MODE_PATTERN,
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
  const anchoredRoomId = anchoredThread?.scene?.room_id ?? null;
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-anchored-thread.json"), {
    state: anchoredThread,
    stream_lifecycle: anchoredThreadLifecycle.captures,
  });

  await waitForLiveRoundtableReady(page, {
    expectedRoomId: anchoredRoomId,
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    expectedInteractionMode: "thread_followup",
    timeout: 15000,
    label: "desktop roundtable replay preflight",
  });
  await armClipboardCapture(page);
  await clickActionable(await waitForRoundtableHeaderAction(page, {
    label: "desktop roundtable copy replay",
    namePattern: ENDING_ROOM_COPY_REPLAY_PATTERN,
    timeout: 30000,
  }), "desktop roundtable copy replay");
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
  await assertUiLocale(sharePage, locale, "roundtable desktop artifact replay ui");
  await saveScreenshot(sharePage, path.join(outputDir, "desktop-roundtable-replay-artifact.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-artifact.json"), artifactReadonly);
  await sharePage.reload({ waitUntil: "domcontentloaded" });
  const artifactReloaded = await waitForReadonlyRoundtableReplayVisible(sharePage, {
    replayKind: "share",
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    expectedInteractionMode: "thread_followup",
    timeout: 15000,
    label: "desktop roundtable artifact readonly restore",
  });
  await assertUiLocale(sharePage, locale, "roundtable desktop artifact replay restore ui");
  await saveScreenshot(sharePage, path.join(outputDir, "desktop-roundtable-replay-artifact-reloaded.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-artifact-reloaded.json"), artifactReloaded);
  await clickActionable(await waitForRoundtableHeaderAction(sharePage, {
    label: "desktop roundtable artifact import",
    namePattern: ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN,
    timeout: 30000,
  }), "desktop roundtable artifact import");
  await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
  const artifactImportedUrl = sharePage.url();

  await waitForLiveRoundtableReady(page, {
    expectedRoomId: anchoredRoomId,
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    expectedInteractionMode: "thread_followup",
    timeout: 15000,
    label: "desktop roundtable readonly save preflight",
  });
  await clickActionable(await waitForRoundtableHeaderAction(page, {
    label: "desktop roundtable save readonly copy",
    namePattern: ENDING_ROOM_SAVE_READONLY_COPY_PATTERN,
    timeout: 30000,
  }), "desktop roundtable save readonly copy");
  await page.waitForURL(/\/roundtable\/replay\?roomLocal=/, { timeout: 15000 });
  const replayReadonly = await waitForReadonlyRoundtableReplayVisible(page, {
    replayKind: "local",
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    timeout: 15000,
    label: "roundtable replay readonly state",
  });
  await assertUiLocale(page, locale, "roundtable desktop readonly replay ui");
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-replay-readonly.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-readonly.json"), replayReadonly);
  await page.reload({ waitUntil: "domcontentloaded" });
  const replayReloaded = await waitForReadonlyRoundtableReplayVisible(page, {
    replayKind: "local",
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    expectedInteractionMode: "thread_followup",
    timeout: 15000,
    label: "desktop roundtable readonly restore",
  });
  await assertUiLocale(page, locale, "roundtable desktop readonly replay restore ui");
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-replay-readonly-reloaded.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-readonly-reloaded.json"), replayReloaded);

  assertReplayCoverage(
    {
      replayCoverageError: null,
      artifactReadonly,
      artifactReloaded,
      artifactImportedUrl,
      replayReadonly,
      replayReloaded,
    },
    {
      label: "roundtable desktop replay coverage",
      requiredFields: [
        "artifactReadonly",
        "artifactReloaded",
        "artifactImportedUrl",
        "replayReadonly",
        "replayReloaded",
      ],
    },
  );

  return {
    locale,
    uiLocale,
    roomLanguage,
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
    artifactReloaded,
    artifactImportedUrl,
    replayReadonly,
    replayReloaded,
  };
}

async function runMobile(browser, baseUrl, backendUrl, outputDir, scenarioId, browserName, locale) {
  const contextOptions = {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    locale: resolveContextLocale(locale),
  };
  if (browserName !== "firefox") {
    contextOptions.isMobile = true;
  }
  const context = await browser.newContext(contextOptions);
  await configureLocaleContext(context, locale);
  const page = await context.newPage();
  const ready = await openRoundtable(page, baseUrl, backendUrl, scenarioId, outputDir, locale);
  const uiLocale = await assertUiLocale(page, locale, "roundtable mobile ui");
  const roomLanguage = await assertRoomLanguage(backendUrl, ready?.scene?.room_id, locale, "roundtable mobile room");
  const fit = await captureMobileFit(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-ready.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-ready.json"), { ready, fit, uiLocale, roomLanguage });

  const clickReseated = await clickReseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-click-reseated.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-click-reseated.json"), clickReseated);

  const traitMix = await reopenWithSelectionMode(page, {
    modeButton: MODE_TRAIT_MIX_PATTERN,
    expectedMode: "trait_mix",
    label: "mobile trait mix roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-trait-mix.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-trait-mix.json"), traitMix);

  const faultLineFirst = await reopenWithSelectionMode(page, {
    modeButton: MODE_FAULT_LINE_FIRST_PATTERN,
    expectedMode: "fault_line_first",
    label: "mobile fault line first roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-fault-line-first.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-fault-line-first.json"), faultLineFirst);

  const witnessAugmented = await reopenWithSelectionMode(page, {
    modeButton: MODE_WITNESS_AUGMENTED_PATTERN,
    expectedMode: "witness_augmented",
    label: "mobile witness augmented roundtable",
  });
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-witness-augmented.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-witness-augmented.json"), witnessAugmented);

  await page.getByRole("button", { name: HOTSEAT_MODE_PATTERN }).click();
  const hotseatTargets = await page.locator(".ending-chat-hotseat-pill").count();
  if (hotseatTargets > 0) {
    await page.locator(".ending-chat-hotseat-pill").first().click();
  }
  const hotseat = await sendComposer(
    page,
    getRoundtableHotseatPrompt(locale),
    HOTSEAT_MODE_PATTERN,
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
  const anchoredRoomId = anchoredThread?.scene?.room_id ?? null;
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-anchored-thread.json"), {
    state: anchoredThread,
    stream_lifecycle: anchoredThreadLifecycle.captures,
  });

  await waitForLiveRoundtableReady(page, {
    expectedRoomId: anchoredRoomId,
    expectedActiveThreadId: anchoredThreadId,
    expectedQuestionAnchorIds: anchoredAnchorIds,
    expectedAnchorKind: "quote",
    expectedInteractionMode: "thread_followup",
    timeout: 15000,
    label: "mobile roundtable replay preflight",
  });
  await armClipboardCapture(page);
  let artifactReadonly = null;
  let artifactReloaded = null;
  let artifactImportedUrl = null;
  let replayReadonly = null;
  let replayReloaded = null;
  let replayCoverageError = null;
  try {
    await clickActionable(await waitForRoundtableHeaderAction(page, {
      label: "mobile roundtable copy replay",
      namePattern: ENDING_ROOM_COPY_REPLAY_PATTERN,
      timeout: 30000,
    }), "mobile roundtable copy replay");
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "mobile roundtable copied share permalink");
    const sharePage = await context.newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitForReadonlyRoundtableReplayVisible(sharePage, {
      replayKind: "share",
      expectedActiveThreadId: anchoredThreadId,
      expectedQuestionAnchorIds: anchoredAnchorIds,
      expectedAnchorKind: "quote",
      expectedInteractionMode: "thread_followup",
      timeout: 20000,
      label: "mobile roundtable artifact replay readonly state",
    });
    await assertUiLocale(sharePage, locale, "roundtable mobile artifact replay ui");
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-roundtable-replay-artifact.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-artifact.json"), artifactReadonly);
    await sharePage.reload({ waitUntil: "domcontentloaded" });
    artifactReloaded = await waitForReadonlyRoundtableReplayVisible(sharePage, {
      replayKind: "share",
      expectedActiveThreadId: anchoredThreadId,
      expectedQuestionAnchorIds: anchoredAnchorIds,
      expectedAnchorKind: "quote",
      expectedInteractionMode: "thread_followup",
      timeout: 20000,
      label: "mobile roundtable artifact readonly restore",
    });
    await assertUiLocale(sharePage, locale, "roundtable mobile artifact replay restore ui");
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-roundtable-replay-artifact-reloaded.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-artifact-reloaded.json"), artifactReloaded);
    await clickActionable(await waitForRoundtableHeaderAction(sharePage, {
      label: "mobile roundtable artifact import",
      namePattern: ENDING_ROOM_IMPORT_LOCAL_RUN_PATTERN,
      timeout: 30000,
    }), "mobile roundtable artifact import");
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();

    await waitForLiveRoundtableReady(page, {
      expectedRoomId: anchoredRoomId,
      expectedActiveThreadId: anchoredThreadId,
      expectedQuestionAnchorIds: anchoredAnchorIds,
      expectedAnchorKind: "quote",
      expectedInteractionMode: "thread_followup",
      timeout: 15000,
      label: "mobile roundtable readonly save preflight",
    });
    await clickActionable(await waitForRoundtableHeaderAction(page, {
      label: "mobile roundtable save readonly copy",
      namePattern: ENDING_ROOM_SAVE_READONLY_COPY_PATTERN,
      timeout: 30000,
    }), "mobile roundtable save readonly copy");
    await page.waitForURL(/\/roundtable\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitForReadonlyRoundtableReplayVisible(page, {
      replayKind: "local",
      expectedActiveThreadId: anchoredThreadId,
      expectedQuestionAnchorIds: anchoredAnchorIds,
      expectedAnchorKind: "quote",
      expectedInteractionMode: "thread_followup",
      timeout: 20000,
      label: "mobile roundtable replay readonly state",
    });
    await assertUiLocale(page, locale, "roundtable mobile readonly replay ui");
    await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-replay-readonly.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-readonly.json"), replayReadonly);
    await page.reload({ waitUntil: "domcontentloaded" });
    replayReloaded = await waitForReadonlyRoundtableReplayVisible(page, {
      replayKind: "local",
      expectedActiveThreadId: anchoredThreadId,
      expectedQuestionAnchorIds: anchoredAnchorIds,
      expectedAnchorKind: "quote",
      expectedInteractionMode: "thread_followup",
      timeout: 20000,
      label: "mobile roundtable readonly restore",
    });
    await assertUiLocale(page, locale, "roundtable mobile readonly replay restore ui");
    await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-replay-readonly-reloaded.png"));
    writeJson(path.join(outputDir, "mobile-roundtable-replay-readonly-reloaded.json"), replayReloaded);
  } catch (error) {
    replayCoverageError = String(error);
    writeJson(path.join(outputDir, "mobile-roundtable-replay-coverage-error.json"), { error: replayCoverageError });
  }

  assertReplayCoverage(
    {
      replayCoverageError,
      artifactReadonly,
      artifactReloaded,
      artifactImportedUrl,
      replayReadonly,
      replayReloaded,
    },
    {
      label: "roundtable mobile replay coverage",
      requiredFields: [
        "artifactReadonly",
        "artifactReloaded",
        "artifactImportedUrl",
        "replayReadonly",
        "replayReloaded",
      ],
    },
  );

  await closePlaywrightContext(context, "roundtable-mobile-context", 15000);
  return {
    locale,
    uiLocale,
    roomLanguage,
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
  const summary = {
    locale: args.locale,
  };

  if (args.mode === "desktop" || args.mode === "full") {
    const desktopBrowser = await launchBrowser(args.headless, args.browser);
    try {
      const context = await desktopBrowser.newContext({ viewport: { width: 1600, height: 900 } });
      await configureLocaleContext(context, args.locale);
      summary.desktop = await runDesktop(context, args.baseUrl, args.backendUrl, outputDir, desktopScenarioId, args.locale);
      await closePlaywrightContext(context, "roundtable-desktop-context", 15000);
    } finally {
      await closePlaywrightBrowser(desktopBrowser, "roundtable-desktop-browser", 20000);
    }
  }

  if (args.mode === "mobile" || args.mode === "full") {
    const mobileBrowser = await launchBrowser(args.headless, args.browser);
    try {
      summary.mobile = await runMobile(
        mobileBrowser,
        args.baseUrl,
        args.backendUrl,
        outputDir,
        mobileScenarioId,
        args.browser,
        args.locale,
      );
    } finally {
      await closePlaywrightBrowser(mobileBrowser, "roundtable-mobile-browser", 20000);
    }
  }

  writeJson(path.join(outputDir, "summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
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
}
