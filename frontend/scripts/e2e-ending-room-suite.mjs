import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { isLiveEndingRoomModalState } from "../src/lib/endingRoomReplayAutomation.js";
import {
  isEndingRoomModalUiReady,
  openEndingRoomModalFromPicker,
} from "../src/lib/endingRoomPickerAutomation.js";

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
    backendUrl: DEFAULT_BACKEND_URL,
    outputDir: "",
    fixture: "single",
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
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--fixture" && next) {
      args.fixture = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-ending-room-suite.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--output-dir DIR] [--fixture single|multi-ending] [--headless]");
  }
  if (!["single", "multi-ending"].includes(args.fixture)) {
    throw new Error("--fixture must be single or multi-ending");
  }

  return args;
}

async function launchBrowser(headless) {
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

async function readAutomation(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
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

async function waitForLiveEndingRoomModalReady(page, {
  expectedRoomType = null,
  timeout = 30000,
  label = "ending-room live modal ready",
} = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await readAutomation(page);
    const modalState = payload?.page?.controls?.modal_state;
    if (
      payload?.page?.controls?.active_modal === "ending_room"
      && modalState
      && modalState.kind === "ending_room_modal"
      && modalState.read_only !== true
      && (!expectedRoomType || !modalState.room_type || modalState.room_type === expectedRoomType)
      && modalState.room_id
      && isLiveEndingRoomModalState(modalState, {
        expectedRoomType,
      })
    ) {
      return payload;
    }

    const uiReady = await page.evaluate(() => {
      const modal = document.querySelector(".ending-chat-modal");
      if (!(modal instanceof HTMLElement)) {
        return null;
      }
      const text = modal.innerText || "";
      const composer = modal.querySelector("textarea.ending-chat-composer__input");
      const hasComposer = composer instanceof HTMLTextAreaElement;
      const hasModePill = modal.querySelector(".ending-chat-mode-pill") instanceof HTMLElement;
      const hasCloseButton = modal.querySelector(".ending-chat-close") instanceof HTMLElement;
      return {
        text,
        hasComposer,
        hasModePill,
        hasCloseButton,
      };
    });
    if (isEndingRoomModalUiReady(uiReady ?? undefined)) {
      return {
        page: {
          controls: {
            active_modal: "ending_room",
            modal_state: {
              kind: "ending_room_modal",
              room_id: modalState?.room_id ?? null,
              room_type: modalState?.room_type ?? expectedRoomType ?? null,
              read_only: false,
              status: modalState?.status ?? "done",
              has_result: modalState?.has_result ?? true,
              can_send: modalState?.can_send ?? true,
              turn_count: modalState?.turn_count ?? 0,
              thread_count: modalState?.thread_count ?? 0,
              active_thread_id: modalState?.active_thread_id ?? null,
            },
          },
        },
      };
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listDoneScenarios(backendUrl) {
  const payload = await fetchJson(`${backendUrl}/api/scenarios?status=done&limit=200&offset=0`);
  return payload.scenarios ?? [];
}

async function getScenario(backendUrl, scenarioId) {
  return fetchJson(`${backendUrl}/api/scenario/${scenarioId}`);
}

async function resolveScenarioId(backendUrl, fixture) {
  const scenarios = await listDoneScenarios(backendUrl);
  for (const item of scenarios) {
    const scenario = await getScenario(backendUrl, item.id);
    const branchCount = scenario.branches?.length ?? 0;
    const agentCount = scenario.agents?.length ?? 0;
    if (fixture === "single" && branchCount === 1 && agentCount >= 2) {
      return scenario.id;
    }
    if (fixture === "multi-ending" && branchCount >= 2) {
      return scenario.id;
    }
  }
  throw new Error(`No DONE scenario found for fixture=${fixture}`);
}

async function collectPickerState(page) {
  return page.evaluate(() => ({
    title: document.querySelector("#ending-room-picker-title")?.textContent?.trim() ?? null,
    candidates: [...document.querySelectorAll(".ending-room-picker__card strong")].map((el) => el.textContent?.trim()),
    selected: [...document.querySelectorAll(".ending-room-picker__card.is-selected strong")].map((el) => el.textContent?.trim()),
    fallbackNotice: document.querySelector(".ending-room-picker__empty")?.textContent?.trim() ?? null,
  }));
}

async function collectModalDetails(page) {
  const automation = await readAutomation(page);
  const details = await page.evaluate(() => ({
    threads: [...document.querySelectorAll(".ending-chat-thread-chip")].map((el) => el.textContent?.trim()),
    activeThreads: [...document.querySelectorAll(".ending-chat-thread-chip.is-active")].map((el) => el.textContent?.trim()),
    participants: [...document.querySelectorAll(".ending-chat-participant-card strong")].map((el) => el.textContent?.trim()),
    hotseatTargets: [...document.querySelectorAll(".ending-chat-hotseat-pill")].map((el) => ({
      label: el.textContent?.trim(),
      active: el.classList.contains("is-active"),
    })),
    lastTurns: [...document.querySelectorAll(".ending-chat-bubble")].slice(-6).map((bubble) => ({
      header: bubble.querySelector("header")?.textContent?.replace(/\s+/g, " ").trim(),
      text: bubble.querySelector("p")?.textContent?.trim(),
    })),
  }));
  return {
    automation: automation?.page?.controls?.modal_state ?? null,
    details,
  };
}

async function openResult(page, baseUrl, scenarioId) {
  await page.goto(`${baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  return waitForAutomation(page, (payload) => payload.page?.kind === "result" && !payload.page?.loading, 30000, "result page");
}

async function openPicker(page, branchIndex, roomButtonIndex, outputDir, label) {
  await page.locator(".ending-room-actions").nth(branchIndex).locator("button").nth(roomButtonIndex).click();
  await page.locator(".ending-room-picker").waitFor({ state: "visible", timeout: 10000 });
  const picker = await collectPickerState(page);
  await saveScreenshot(page, path.join(outputDir, `${label}-picker.png`));
  writeJson(path.join(outputDir, `${label}-picker.json`), picker);
  return picker;
}

async function confirmPicker(page, outputDir, label) {
  await openEndingRoomModalFromPicker(page, {
    buttonSelector: ".ending-room-picker__footer button",
  });
  const payload = await waitForLiveEndingRoomModalReady(page, {
    timeout: 30000,
    label: `${label} modal ready`,
  });
  const modal = await collectModalDetails(page);
  await saveScreenshot(page, path.join(outputDir, `${label}-modal.png`));
  writeJson(path.join(outputDir, `${label}-modal.json`), { automation: payload.page.controls.modal_state, ...modal });
  return modal;
}

async function sendFollowup(page, outputDir, label, { modeIndex, hotseatIndex = 0, prompt }) {
  await waitForLiveEndingRoomModalReady(page, {
    timeout: 10000,
    label: `${label} live modal preflight`,
  });
  await page.locator(".ending-chat-mode-pill").nth(modeIndex).click();
  if (modeIndex === 1) {
    const hotseatPills = page.locator(".ending-chat-hotseat-pill");
    const count = await hotseatPills.count();
    if (count === 0) {
      throw new Error(`No hotseat targets available for ${label}`);
    }
    await hotseatPills.nth(Math.min(hotseatIndex, count - 1)).click();
  }
  const before = await readAutomation(page);
  const beforeTurns = before?.page?.controls?.modal_state?.turn_count ?? 0;
  const beforeThreads = before?.page?.controls?.modal_state?.thread_count ?? 0;
  const beforeActiveThreadId = before?.page?.controls?.modal_state?.active_thread_id ?? null;
  const beforeBubbleCount = await page.locator(".ending-chat-bubble").count();
  await page.locator(".ending-chat-composer__input").fill(prompt);
  await page.locator(".ending-chat-send").click();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const current = await readAutomation(page);
    const modalState = current?.page?.controls?.modal_state;
    const bubbleCount = await page.locator(".ending-chat-bubble").count();
    const settled = modeIndex === 1
      ? (
        modalState?.thread_count > beforeThreads
        || modalState?.active_thread_id !== beforeActiveThreadId
        || bubbleCount > beforeBubbleCount
      )
      : (
        modalState?.turn_count > beforeTurns
        || bubbleCount > beforeBubbleCount
      );
    if (settled) {
      break;
    }
    await page.waitForTimeout(250);
  }
  const modal = await collectModalDetails(page);
  await saveScreenshot(page, path.join(outputDir, `${label}.png`));
  writeJson(path.join(outputDir, `${label}.json`), modal);
  return modal;
}

async function closeModal(page) {
  await waitForLiveEndingRoomModalReady(page, {
    timeout: 10000,
    label: "ending-room close modal preflight",
  });
  await page.locator(".ending-chat-close").click();
  await page.locator(".ending-chat-modal").waitFor({ state: "hidden", timeout: 10000 });
}

async function runSingleEndingFlow(page, { baseUrl, backendUrl, outputDir }) {
  const scenarioId = await resolveScenarioId(backendUrl, "single");
  const resultPayload = await openResult(page, baseUrl, scenarioId);
  await saveScreenshot(page, path.join(outputDir, "result-initial.png"));
  writeJson(path.join(outputDir, "result-initial.json"), resultPayload);

  const picker = await openPicker(page, 0, 0, outputDir, "ending-chamber");
  const chamber = await confirmPicker(page, outputDir, "ending-chamber");
  const hotseat = await sendFollowup(page, outputDir, "hotseat", {
    modeIndex: 1,
    hotseatIndex: 0,
    prompt: "如果由你来改这一手，你会先改哪一步？",
  });
  const allPresent = await sendFollowup(page, outputDir, "all-present", {
    modeIndex: 2,
    prompt: "如果让当前阵容都回应一次，他们会怎么分工？",
  });
  await closeModal(page);

  await openPicker(page, 0, 1, outputDir, "one-move-only");
  const oneMove = await confirmPicker(page, outputDir, "one-move-only");

  return {
    scenarioId,
    branchCount: resultPayload?.page?.branches?.length ?? 0,
    picker,
    chamber,
    hotseat,
    allPresent,
    oneMove,
  };
}

async function runMultiEndingCheck(page, { baseUrl, backendUrl, outputDir }) {
  const scenarioId = await resolveScenarioId(backendUrl, "multi-ending");
  const resultPayload = await openResult(page, baseUrl, scenarioId);
  const branchCount = resultPayload?.page?.branches?.length ?? 0;
  if (branchCount < 2) {
    throw new Error(`Scenario ${scenarioId} is not multi-ending`);
  }

  const firstPicker = await openPicker(page, 0, 0, outputDir, "multi-a");
  await page.locator(".ending-room-picker__close").click();
  await page.locator(".ending-room-picker").waitFor({ state: "hidden", timeout: 10000 });

  const secondPicker = await openPicker(page, 1, 0, outputDir, "multi-b");
  const secondModal = await confirmPicker(page, outputDir, "multi-b");

  return {
    scenarioId,
    branchCount,
    firstPicker,
    secondPicker,
    secondModal,
  };
}

async function runViewportCase({ browser, baseUrl, backendUrl, outputDir, mobile, fixture }) {
  ensureDir(outputDir);
  const consoleMessages = [];
  const context = await browser.newContext(
    mobile
      ? {
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
        }
      : {
          viewport: { width: 1600, height: 900 },
        },
  );
  const page = await context.newPage();
  page.on("console", (message) => {
    consoleMessages.push({
      type: message.type(),
      text: message.text(),
    });
  });
  page.on("pageerror", (error) => {
    consoleMessages.push({
      type: "pageerror",
      text: error.message,
    });
  });

  const summary = fixture === "multi-ending"
    ? await runMultiEndingCheck(page, { baseUrl, backendUrl, outputDir })
    : await runSingleEndingFlow(page, { baseUrl, backendUrl, outputDir });

  writeJson(path.join(outputDir, "console.json"), consoleMessages);
  await context.close();
  return {
    viewport: mobile ? { width: 390, height: 844, mobile: true } : { width: 1600, height: 900, mobile: false },
    fixture,
    consoleMessages,
    summary,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-ending-room`);
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless);
  const summary = {
    mode: args.mode,
    baseUrl: args.baseUrl,
    backendUrl: args.backendUrl,
    fixture: args.fixture,
    results: {},
  };

  try {
    if (args.mode === "desktop" || args.mode === "full") {
      summary.results.desktop = await runViewportCase({
        browser,
        baseUrl: args.baseUrl,
        backendUrl: args.backendUrl,
        outputDir: path.join(outputDir, "desktop"),
        mobile: false,
        fixture: args.fixture,
      });
    }

    if (args.mode === "mobile" || args.mode === "full") {
      summary.results.mobile = await runViewportCase({
        browser,
        baseUrl: args.baseUrl,
        backendUrl: args.backendUrl,
        outputDir: path.join(outputDir, "mobile"),
        mobile: true,
        fixture: args.fixture,
      });
    }
  } finally {
    await browser.close();
  }

  writeJson(path.join(outputDir, "summary.json"), summary);
  console.log(JSON.stringify({ status: "ok", outputDir }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
