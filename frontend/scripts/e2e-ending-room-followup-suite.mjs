import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "",
    url: null,
    outputDir: "output/e2e/ending-room-followup",
    headless: true,
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.url = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--headless" && next) {
      args.headless = next !== "false" && next !== "0";
      i += 1;
    }
  }
  if (!args.url) {
    throw new Error("--url is required");
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-ending-room-followup-suite.mjs <desktop|mobile|full> [--url URL] [--output-dir DIR] [--headless]");
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function parseAutomationState(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function getAutomationState(page) {
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  return parseAutomationState(raw);
}

function anchorIdsEqual(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function resolveBackendUrl(frontendUrl) {
  const url = new URL(frontendUrl);
  const localDevPort = /^1892[89]$|^1893\d$/;
  if (url.hostname === "127.0.0.1" && localDevPort.test(url.port)) {
    return `${url.protocol}//127.0.0.1:18927`;
  }
  return url.origin;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function findScenarioIds(frontendUrl) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  const list = await fetchJson(`${backendUrl}/api/scenarios?status=done&limit=80&offset=0`);
  let multiId = null;
  let singleId = null;
  for (const scenario of list.scenarios ?? []) {
    if (multiId && singleId) break;
    const detail = await fetchJson(`${backendUrl}/api/scenario/${scenario.id}`);
    const branchCount = Array.isArray(detail.branches) ? detail.branches.length : 0;
    if (!multiId && branchCount > 1) {
      multiId = detail.id;
    }
    if (!singleId && branchCount === 1) {
      singleId = detail.id;
    }
  }
  if (!multiId || !singleId) {
    throw new Error("Could not find both multi-ending and single-ending done scenarios");
  }
  return { multiId, singleId };
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

async function openPicker(page, buttonRegex, index) {
  await page.getByRole("button", { name: buttonRegex }).nth(index).click();
  await page.waitForSelector(".ending-room-picker", { timeout: 10000 });
}

async function enterRoomFromPicker(page) {
  const cards = await page.locator(".ending-room-picker__card").allInnerTexts();
  await page.locator(".ending-room-picker__footer .btn").last().click();
  await page.waitForSelector(".ending-chat-modal", { timeout: 15000 });
  const automation = await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (!modalState?.room_id) return null;
      if (modalState.status === "loading") return null;
      if (!modalState.has_result && !modalState.can_send) return null;
      return current;
    },
    "ending-room modal usable state",
    20000,
  );
  return {
    cards,
    modalState: automation?.page?.controls?.modal_state ?? null,
  };
}

async function openGallery(page) {
  await page.getByRole("button", { name: /Crossline Gallery|异线旁听席/i }).first().click();
  await page.waitForSelector(".ending-chat-modal", { timeout: 15000 });
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (!modalState?.room_id) return null;
      if (modalState.room_type !== "crossline_gallery") return null;
      if (modalState.can_send !== false) return null;
      if (!modalState.has_result) return null;
      return current;
    },
    "crossline gallery usable state",
    20000,
  );
}

async function waitForModalSettled(page, label, timeout = 20000) {
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (!modalState?.room_id) return null;
      if (modalState.sending) return null;
      if ((modalState.pending_draft_count ?? 0) > 0) return null;
      return current;
    },
    label,
    timeout,
  );
}

async function createVerdictAnchoredThread(page, label) {
  const summaryThreadButton = page.locator(".ending-chat-sidebar").getByRole("button", {
    name: /Start anchored thread|另开线程/i,
  }).first();
  if (await summaryThreadButton.isVisible().catch(() => false)) {
    await summaryThreadButton.click();
  } else {
    await page.getByRole("button", { name: /Continue from verdict|沿着当前结局继续追问|继续追问当前结局|继续追问/i }).first().click();
    await page.getByRole("button", { name: /Start thread from current anchor|从当前锚点开始线程|从当前锚点发起线程/i }).click();
  }
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (
        modalState?.interaction_mode === "thread_followup"
        && (modalState?.thread_count ?? 0) >= 2
        && (modalState?.question_anchor_ids?.length ?? 0) > 0
        && modalState?.anchor_kind === "verdict"
      ) {
        return current;
      }
      return null;
    },
    label,
    20000,
  );
}

async function sendAnchoredFollowup(page, label) {
  const sendButton = page.getByRole("button", { name: /Send|发送追问/i });
  await sendButton.click();
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (
        modalState?.interaction_mode === "thread_followup"
        && (modalState?.turn_count ?? 0) > 0
        && (modalState?.question_anchor_ids?.length ?? 0) > 0
        && (modalState?.pending_question_anchor_ids?.length ?? 0) === 0
      ) {
        return current;
      }
      return null;
    },
    label,
    20000,
  );
}

async function captureEndingRoomFit(page) {
  return page.evaluate(() => {
    const modal = document.querySelector(".ending-chat-modal");
    if (!(modal instanceof HTMLElement)) return null;
    const rect = modal.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      fitsHorizontally: rect.left >= 0 && rect.right <= window.innerWidth,
      fitsVertically: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
}

async function runMultiDesktop(context, frontendUrl, outputDir, scenarioIds) {
  const page = await context.newPage();
  const { multiId } = scenarioIds;
  const resultUrl = `${new URL(frontendUrl).origin}/result/${multiId}`;
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await saveScreenshot(page, path.join(outputDir, "multi-result-initial.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-result-initial.json"),
    JSON.stringify(await getAutomationState(page), null, 2),
  );

  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  const pickerA = await enterRoomFromPicker(page);
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-initial.png"));
  fs.writeFileSync(path.join(outputDir, "multi-picker-A.json"), JSON.stringify(pickerA, null, 2));
  fs.writeFileSync(
    path.join(outputDir, "multi-chamber-A-initial.json"),
    JSON.stringify(await getAutomationState(page), null, 2),
  );

  const beforeHotseat = await getAutomationState(page);
  await page.locator(".ending-chat-mode-pill").filter({ hasText: /Question one role|Hotseat|点名角色|角色热座/i }).click();
  await page.locator("textarea").last().fill("请点名说明，这条世界线最早的失控点在哪里？");
  await page.getByRole("button", { name: /Send|发送/i }).click();
  const hotseatState = await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (
        modalState?.interaction_mode === "hotseat"
        && (modalState?.thread_count ?? 0) >= ((beforeHotseat?.page?.controls?.modal_state?.thread_count ?? 0))
        && (modalState?.active_thread_id ?? null) !== (beforeHotseat?.page?.controls?.modal_state?.active_thread_id ?? null)
      ) {
        return current;
      }
      return null;
    },
    "hotseat follow-up state",
  );
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-hotseat.png"));
  fs.writeFileSync(path.join(outputDir, "multi-chamber-A-hotseat.json"), JSON.stringify(hotseatState, null, 2));

  await page.locator(".ending-chat-mode-pill").filter({ hasText: /Current lineup responds|Everyone responds|All present|当前阵容回应|全员回应|当前全员回应/i }).click();
  await page.locator("textarea").last().fill("如果让当前阵容都回应一次，他们会如何分工？");
  await page.getByRole("button", { name: /Send|发送/i }).click();
  const allPresentState = await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (
        modalState?.interaction_mode === "all_present"
        && (modalState?.turn_count ?? 0) > (beforeHotseat?.page?.controls?.modal_state?.turn_count ?? 0)
      ) {
        return current;
      }
      return null;
    },
    "all-present follow-up state",
  );
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-all-present.png"));
  fs.writeFileSync(path.join(outputDir, "multi-chamber-A-all-present.json"), JSON.stringify(allPresentState, null, 2));

  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);

  await openPicker(page, /One Move Only|只改一步/i, 1);
  const pickerB = await enterRoomFromPicker(page);
  const oneMoveState = await getAutomationState(page);
  await saveScreenshot(page, path.join(outputDir, "multi-one-move-B.png"));
  fs.writeFileSync(path.join(outputDir, "multi-picker-B-one-move.json"), JSON.stringify(pickerB, null, 2));
  fs.writeFileSync(path.join(outputDir, "multi-one-move-B.json"), JSON.stringify(oneMoveState, null, 2));

  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);

  const galleryState = await openGallery(page);
  await saveScreenshot(page, path.join(outputDir, "multi-crossline-gallery.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-crossline-gallery.json"),
    JSON.stringify(galleryState, null, 2),
  );

  await armClipboardCapture(page);
  await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
  const shareReplayUrl = await waitForCapturedClipboardUrl(page, "ending-room copied share permalink");
  const sharePage = await page.context().newPage();
  await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
  const artifactReadonly = await waitFor(
    sharePage,
    async () => {
      const current = await getAutomationState(sharePage);
      const modalState = current?.page?.controls?.modal_state;
      if (modalState?.read_only === true && modalState?.can_import_replay === true) {
        return current;
      }
      return null;
    },
    "ending-room artifact replay readonly state",
    20000,
  );
  await saveScreenshot(sharePage, path.join(outputDir, "multi-ending-room-replay-artifact.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-ending-room-replay-artifact.json"),
    JSON.stringify(artifactReadonly, null, 2),
  );
  await sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
    hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
  }).last().click();
  await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
  const artifactImportedUrl = sharePage.url();

  await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
  await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
  const replayReadonly = await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (modalState?.read_only === true && modalState?.can_send === false) {
        return current;
      }
      return null;
    },
    "ending-room replay readonly state",
  );
  await saveScreenshot(page, path.join(outputDir, "multi-ending-room-replay-readonly.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-ending-room-replay-readonly.json"),
    JSON.stringify(replayReadonly, null, 2),
  );

  await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
    hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
  }).last().click();
  await page.waitForURL(/\/sim\//, { timeout: 15000 });
  const importedUrl = page.url();

  return {
    resultUrl,
    pickerA,
    hotseatState: hotseatState?.page?.controls?.modal_state ?? null,
    allPresentState: allPresentState?.page?.controls?.modal_state ?? null,
    pickerB,
    oneMoveState: oneMoveState?.page?.controls?.modal_state ?? null,
    galleryState: galleryState?.page?.controls?.modal_state ?? null,
    artifactReadonly: artifactReadonly?.page?.controls?.modal_state ?? null,
    artifactImportedUrl,
    replayReadonly: replayReadonly?.page?.controls?.modal_state ?? null,
    importedUrl,
  };
}

async function runSingleMobile(browser, frontendUrl, outputDir, scenarioIds) {
  const { singleId } = scenarioIds;
  const resultUrl = `${new URL(frontendUrl).origin}/result/${singleId}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  await saveScreenshot(page, path.join(outputDir, "single-mobile-picker.png"));
  const pickerState = await enterRoomFromPicker(page);
  const automation = await getAutomationState(page);
  const fit = await page.evaluate(() => {
    const modal = document.querySelector(".ending-chat-modal");
    if (!(modal instanceof HTMLElement)) return null;
    const rect = modal.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      fitsHorizontally: rect.left >= 0 && rect.right <= window.innerWidth,
      fitsVertically: rect.top >= 0 && rect.bottom <= window.innerHeight,
    };
  });
  await saveScreenshot(page, path.join(outputDir, "single-mobile-chamber.png"));
  fs.writeFileSync(
    path.join(outputDir, "single-mobile-chamber.json"),
    JSON.stringify({ pickerState, state: automation, fit }, null, 2),
  );
  await createVerdictAnchoredThread(page, "single ending verdict-anchored thread");
  const anchoredState = await sendAnchoredFollowup(page, "single ending anchored follow-up commit");
  await saveScreenshot(page, path.join(outputDir, "single-mobile-anchored-thread.png"));
  fs.writeFileSync(
    path.join(outputDir, "single-mobile-anchored-thread.json"),
    JSON.stringify(anchoredState, null, 2),
  );

  const anchoredModalState = anchoredState?.page?.controls?.modal_state ?? null;
  const anchoredThreadId = anchoredModalState?.active_thread_id ?? null;
  const anchoredAnchorIds = anchoredModalState?.question_anchor_ids ?? [];
  await armClipboardCapture(page);
  let artifactReadonly = null;
  let artifactImportedUrl = null;
  let replayReadonly = null;
  let replayReloaded = null;
  let importedUrl = null;
  let replayCoverageError = null;
  try {
    await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "single ending copied share permalink");
    const sharePage = await context.newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitFor(
      sharePage,
      async () => {
        const current = await getAutomationState(sharePage);
        const modalState = current?.page?.controls?.modal_state;
        if (
          modalState?.read_only === true
          && modalState?.can_import_replay === true
          && (modalState?.active_thread_id ?? null) === anchoredThreadId
          && anchorIdsEqual(modalState?.question_anchor_ids, anchoredAnchorIds)
          && modalState?.anchor_kind === "verdict"
        ) {
          return current;
        }
        return null;
      },
      "single ending artifact replay readonly state",
      20000,
    );
    await saveScreenshot(sharePage, path.join(outputDir, "single-mobile-replay-artifact.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-artifact.json"),
      JSON.stringify(artifactReadonly, null, 2),
    );
    await sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();

    await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
    await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        if (
          modalState?.read_only === true
          && modalState?.can_send === false
          && (modalState?.active_thread_id ?? null) === anchoredThreadId
          && anchorIdsEqual(modalState?.question_anchor_ids, anchoredAnchorIds)
          && modalState?.anchor_kind === "verdict"
        ) {
          return current;
        }
        return null;
      },
      "single ending replay readonly state",
      20000,
    );
    await saveScreenshot(page, path.join(outputDir, "single-mobile-replay-readonly.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-readonly.json"),
      JSON.stringify(replayReadonly, null, 2),
    );
    const replayReadonlyUrl = page.url();

    await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await page.waitForURL(/\/sim\//, { timeout: 15000 });
    importedUrl = page.url();

    const reloadPage = await context.newPage();
    await reloadPage.goto(replayReadonlyUrl, { waitUntil: "domcontentloaded" });
    replayReloaded = await waitFor(
      reloadPage,
      async () => {
        const current = await getAutomationState(reloadPage);
        const modalState = current?.page?.controls?.modal_state;
        if (
          modalState?.read_only === true
          && modalState?.can_send === false
          && (modalState?.active_thread_id ?? null) === anchoredThreadId
          && anchorIdsEqual(modalState?.question_anchor_ids, anchoredAnchorIds)
          && modalState?.anchor_kind === "verdict"
        ) {
          return current;
        }
        return null;
      },
      "single ending readonly restore",
      20000,
    );
    await saveScreenshot(reloadPage, path.join(outputDir, "single-mobile-replay-readonly-reloaded.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-readonly-reloaded.json"),
      JSON.stringify(replayReloaded, null, 2),
    );
    await reloadPage.close();
  } catch (error) {
    replayCoverageError = String(error);
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-coverage-error.json"),
      JSON.stringify({ error: replayCoverageError }, null, 2),
    );
  }
  await context.close();
  return {
    resultUrl,
    pickerState,
    modalState: automation?.page?.controls?.modal_state ?? null,
    anchoredState: anchoredModalState,
    artifactReadonly: artifactReadonly?.page?.controls?.modal_state ?? null,
    artifactImportedUrl,
    replayReadonly: replayReadonly?.page?.controls?.modal_state ?? null,
    replayReloaded: replayReloaded?.page?.controls?.modal_state ?? null,
    importedUrl,
    replayCoverageError,
    fit,
  };
}

async function runMultiMobile(browser, frontendUrl, outputDir, scenarioIds) {
  const { multiId } = scenarioIds;
  const resultUrl = `${new URL(frontendUrl).origin}/result/${multiId}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  const chamberState = await enterRoomFromPicker(page);
  const chamberFit = await captureEndingRoomFit(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-multi-chamber.png"));
  fs.writeFileSync(
    path.join(outputDir, "mobile-multi-chamber.json"),
    JSON.stringify({ chamberState, fit: chamberFit }, null, 2),
  );

  const beforeHotseat = await getAutomationState(page);
  await page.locator(".ending-chat-mode-pill").filter({ hasText: /Question one role|Hotseat|点名角色|角色热座/i }).click();
  await page.locator("textarea").last().fill("请点名说明，这条世界线最早的失控点在哪里？");
  await page.getByRole("button", { name: /Send|发送/i }).click();
  const hotseatState = await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (
        modalState?.interaction_mode === "hotseat"
        && (modalState?.thread_count ?? 0) >= ((beforeHotseat?.page?.controls?.modal_state?.thread_count ?? 0))
        && (modalState?.active_thread_id ?? null) !== (beforeHotseat?.page?.controls?.modal_state?.active_thread_id ?? null)
      ) {
        return current;
      }
      return null;
    },
    "mobile hotseat follow-up state",
    20000,
  );
  const hotseatSettled = await waitForModalSettled(page, "mobile hotseat settled");
  await saveScreenshot(page, path.join(outputDir, "mobile-multi-hotseat.png"));
  fs.writeFileSync(path.join(outputDir, "mobile-multi-hotseat.json"), JSON.stringify(hotseatSettled, null, 2));

  let allPresentSettled = null;
  const beforeAllPresent = hotseatSettled;
  const allPresentButton = page.locator(".ending-chat-mode-pill").filter({ hasText: /Current lineup responds|Everyone responds|All present|当前阵容回应|全员回应|当前全员回应/i });
  const allPresentVisible = await allPresentButton.first().isVisible().catch(() => false);
  if (allPresentVisible) {
    await allPresentButton.click();
    await page.locator("textarea").last().fill("如果让当前阵容都回应一次，他们会如何分工？");
    await page.getByRole("button", { name: /Send|发送/i }).click();
    const allPresentState = await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        if (
          modalState?.interaction_mode === "all_present"
          && (modalState?.turn_count ?? 0) > (beforeAllPresent?.page?.controls?.modal_state?.turn_count ?? 0)
        ) {
          return current;
        }
        return null;
      },
      "mobile all-present follow-up state",
      20000,
    );
    allPresentSettled = await waitForModalSettled(page, "mobile all-present settled");
    await saveScreenshot(page, path.join(outputDir, "mobile-multi-all-present.png"));
    fs.writeFileSync(path.join(outputDir, "mobile-multi-all-present.json"), JSON.stringify(allPresentSettled ?? allPresentState, null, 2));
  } else {
    await saveScreenshot(page, path.join(outputDir, "mobile-multi-all-present-missing.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-multi-all-present.json"),
      JSON.stringify({ available: false, reason: "control_missing_on_mobile" }, null, 2),
    );
  }

  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);
  let galleryState = null;
  let artifactReadonly = null;
  let artifactImportedUrl = null;
  let replayReadonly = null;
  let replayReloaded = null;
  let importedUrl = null;
  let replayCoverageError = null;
  try {
    galleryState = await openGallery(page);
    await saveScreenshot(page, path.join(outputDir, "mobile-multi-crossline-gallery.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-multi-crossline-gallery.json"),
      JSON.stringify(galleryState, null, 2),
    );

    await armClipboardCapture(page);
    await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "mobile ending-room copied share permalink");
    const sharePage = await context.newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitFor(
      sharePage,
      async () => {
        const current = await getAutomationState(sharePage);
        const modalState = current?.page?.controls?.modal_state;
        if (modalState?.read_only === true && modalState?.can_import_replay === true) {
          return current;
        }
        return null;
      },
      "mobile ending-room artifact replay readonly state",
      20000,
    );
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-ending-room-replay-artifact.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-artifact.json"),
      JSON.stringify(artifactReadonly, null, 2),
    );
    await sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();

    await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
    await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        if (modalState?.read_only === true && modalState?.can_send === false) {
          return current;
        }
        return null;
      },
      "mobile ending-room replay readonly state",
      20000,
    );
    await saveScreenshot(page, path.join(outputDir, "mobile-ending-room-replay-readonly.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-readonly.json"),
      JSON.stringify(replayReadonly, null, 2),
    );
    const replayReadonlyUrl = page.url();

    await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import as Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await page.waitForURL(/\/sim\//, { timeout: 15000 });
    importedUrl = page.url();

    const reloadPage = await context.newPage();
    await reloadPage.goto(replayReadonlyUrl, { waitUntil: "domcontentloaded" });
    replayReloaded = await waitFor(
      reloadPage,
      async () => {
        const current = await getAutomationState(reloadPage);
        const modalState = current?.page?.controls?.modal_state;
        if (
          modalState?.read_only === true
          && modalState?.can_send === false
          && (modalState?.active_thread_id ?? null) === (replayReadonly?.page?.controls?.modal_state?.active_thread_id ?? null)
        ) {
          return current;
        }
        return null;
      },
      "mobile ending-room readonly restore",
      20000,
    );
    await saveScreenshot(reloadPage, path.join(outputDir, "mobile-ending-room-replay-readonly-reloaded.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-readonly-reloaded.json"),
      JSON.stringify(replayReloaded, null, 2),
    );
    await reloadPage.close();
  } catch (error) {
    replayCoverageError = String(error);
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-coverage-error.json"),
      JSON.stringify({ error: replayCoverageError }, null, 2),
    );
  }

  await context.close();
  return {
    resultUrl,
    chamberState: chamberState?.modalState ?? null,
    chamberFit,
    hotseatState: hotseatSettled?.page?.controls?.modal_state ?? null,
    allPresentState: allPresentSettled?.page?.controls?.modal_state ?? null,
    galleryState: galleryState?.page?.controls?.modal_state ?? null,
    artifactReadonly: artifactReadonly?.page?.controls?.modal_state ?? null,
    artifactImportedUrl,
    replayReadonly: replayReadonly?.page?.controls?.modal_state ?? null,
    replayReloaded: replayReloaded?.page?.controls?.modal_state ?? null,
    importedUrl,
    replayCoverageError,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  ensureDir(args.outputDir);
  const browser = await chromium.launch({ headless: args.headless, channel: "chrome" });
  try {
    const scenarioIds = await findScenarioIds(args.url);
    const summary = {};
    if (args.mode === "desktop" || args.mode === "full") {
      const desktopContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      summary.multiDesktop = await runMultiDesktop(desktopContext, args.url, args.outputDir, scenarioIds);
      await desktopContext.close();
    }
    if (args.mode === "mobile" || args.mode === "full") {
      summary.mobile = {
        single: await runSingleMobile(browser, args.url, args.outputDir, scenarioIds),
        multi: await runMultiMobile(browser, args.url, args.outputDir, scenarioIds),
      };
    }
    fs.writeFileSync(path.join(args.outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
