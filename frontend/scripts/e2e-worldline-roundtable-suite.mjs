import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

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
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-worldline-roundtable-suite.mjs <desktop|mobile|full> [--url URL] [--backend-url URL] [--output-dir DIR] [--headless]");
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

async function findMultiEndingScenarioId(backendUrl) {
  const payload = await fetchJson(`${backendUrl}/api/scenarios?status=done&limit=120&offset=0`);
  let bestScenarioId = null;
  let bestBranchCount = 0;
  for (const item of payload.scenarios ?? []) {
    const scenario = await getScenario(backendUrl, item.id);
    const branchCount = scenario.branches?.length ?? 0;
    if (branchCount >= 2 && branchCount > bestBranchCount) {
      bestScenarioId = scenario.id;
      bestBranchCount = branchCount;
    }
  }
  if (bestScenarioId) {
    return bestScenarioId;
  }
  throw new Error("No multi-ending DONE scenario is available for roundtable E2E");
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
  } = options;
  await page.getByRole("button", { name: modeText }).click();
  const before = await readAutomation(page);
  const beforeTurns = before?.simulation?.messageCount ?? 0;
  const beforeThreadCount = before?.page?.controls?.thread_count ?? 0;
  const beforeActiveThreadId = before?.page?.controls?.active_thread_id ?? null;
  await page.locator(".ending-chat-composer__input").fill(prompt);
  await page.locator(".ending-chat-send").click();
  return waitForAutomation(
    page,
    (payload) => {
      const controls = payload.page?.controls;
      if (!controls) return false;
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
    },
    15000,
    `composer send ${modeText}`,
  );
}

async function createVerdictAnchoredThread(page, label) {
  const before = await readAutomation(page);
  const beforeThreadCount = before?.page?.controls?.thread_count ?? 0;
  const beforeThreadId = before?.page?.controls?.active_thread_id ?? null;
  const quoteThreadButton = page
    .locator(".ending-chat-bubble__actions")
    .first()
    .getByRole("button", { name: /Start anchored thread|另开线程/i });
  if (await quoteThreadButton.isVisible().catch(() => false)) {
    await quoteThreadButton.click();
  } else {
    const globalQuoteThreadButton = page.getByRole("button", { name: /Start anchored thread|另开线程/i }).last();
    if (await globalQuoteThreadButton.isVisible().catch(() => false)) {
      await globalQuoteThreadButton.click();
    } else {
      await page.getByRole("button", { name: /Archive Verdict|档案总结|档案结论/i }).first().click();
      await page.getByRole("button", { name: /Start thread from current anchor|从当前锚点开始线程|从当前锚点发起线程/i }).click();
    }
  }
  return waitForAutomation(
    page,
    (payload) => {
      const controls = payload.page?.controls;
      if (!controls) return false;
      return (
        controls.interaction_mode === "thread_followup"
        && (
          (controls.thread_count ?? 0) > beforeThreadCount
          || (controls.active_thread_id ?? null) !== beforeThreadId
        )
      );
    },
    20000,
    label,
  );
}

async function sendAnchoredFollowup(page, label) {
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
  await page.locator(".ending-chat-send").click({ force: true });
  await page.waitForFunction(() => {
    const input = document.querySelector(".ending-chat-composer__input");
    return input instanceof HTMLTextAreaElement && input.value.trim().length === 0;
  }, { timeout: 10000 });
  return waitForAutomation(
    page,
    (payload) => {
      const controls = payload.page?.controls;
      if (!controls) return false;
      return (
        controls.interaction_mode === "thread_followup"
        && (controls.question_anchor_ids?.length ?? 0) > 0
        && (controls.pending_question_anchor_ids?.length ?? 0) === 0
      );
    },
    20000,
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
  await page.getByRole("button", { name: /Rebuild the roundtable with this seating|按当前改选重建圆桌|按当前阵容重开|Reopen this lineup/i }).click();

  const reseated = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.has_result === true
      && payload.page?.controls?.showing_picker === false
      && payload.scene?.room_id
      && payload.scene.room_id !== previousRoomId,
    20000,
    "reseated roundtable",
  );

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

  const witnessCard = page.locator(".worldline-roundtable-picker-witness .worldline-roundtable-picker-card").first();
  let witnessName = null;
  if (await witnessCard.isVisible().catch(() => false)) {
    witnessName = (await witnessCard.locator("strong").innerText()).trim();
    await witnessCard.click();
  }

  await page.getByRole("button", { name: /Open this lineup|Reopen this lineup|按当前代表开桌|按当前阵容重开/i }).first().click();

  const witnessState = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.selection_mode === "expert_witness"
      && payload.page?.controls?.has_result === true
      && payload.page?.controls?.has_witness === true
      && payload.scene?.room_id
      && payload.scene.room_id !== previousRoomId,
    20000,
    "expert witness roundtable",
  );

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
  await page.getByRole("button", { name: /Open this lineup|Reopen this lineup|按当前代表开桌|按当前阵容重开/i }).first().click();

  const state = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.selection_mode === expectedMode
      && payload.page?.controls?.has_result === true
      && payload.scene?.room_id
      && payload.scene.room_id !== previousRoomId
      && (!expectWitness || payload.page?.controls?.has_witness === true),
    20000,
    label,
  );

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
    expectWitness: true,
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
    },
  );
  await focusHotseatThread(page, hotseat?.page?.controls?.active_thread_id ?? null);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-hotseat.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-hotseat.json"), hotseat);
  await createVerdictAnchoredThread(page, "desktop verdict anchored thread");
  const anchoredThread = await sendAnchoredFollowup(page, "desktop anchored follow-up commit");
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-anchored-thread.json"), anchoredThread);

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
    reseated,
    expertWitness,
    traitMix,
    faultLineFirst,
    witnessAugmented,
    archivist,
    hotseat,
    anchoredThread,
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
    expectWitness: true,
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
    },
  );
  const hotseatThreadId = hotseat?.page?.controls?.active_thread_id ?? null;
  await focusHotseatThread(page, hotseatThreadId);
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-hotseat.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-hotseat.json"), hotseat);
  await createVerdictAnchoredThread(page, "mobile verdict anchored thread");
  const anchoredThread = await sendAnchoredFollowup(page, "mobile anchored follow-up commit");
  const anchoredThreadId = anchoredThread?.page?.controls?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredThread?.page?.controls?.question_anchor_ids ?? [];
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-anchored-thread.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-anchored-thread.json"), anchoredThread);

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

  await context.close();
  return {
    scenarioId,
    ready,
    fit,
    traitMix,
    faultLineFirst,
    witnessAugmented,
    hotseat,
    anchoredThread,
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

  const browser = await launchBrowser(args.headless);
  try {
    const scenarioId = await findMultiEndingScenarioId(args.backendUrl);
    const summary = {};
    if (args.mode === "desktop" || args.mode === "full") {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      summary.desktop = await runDesktop(context, args.baseUrl, args.backendUrl, outputDir, scenarioId);
      await context.close();
    }
    if (args.mode === "mobile" || args.mode === "full") {
      summary.mobile = await runMobile(browser, args.baseUrl, args.backendUrl, outputDir, scenarioId);
    }
    writeJson(path.join(outputDir, "summary.json"), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
