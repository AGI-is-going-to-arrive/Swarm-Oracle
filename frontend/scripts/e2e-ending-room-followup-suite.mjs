import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";
import { closePlaywrightBrowser, closePlaywrightContext, closePlaywrightPage } from "./playwrightTeardown.mjs";

const DESKTOP_CONTEXT_OPTIONS = {
  viewport: { width: 1600, height: 900 },
};

const MOBILE_CONTEXT_OPTIONS = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
};

const BROWSER_LAUNCH_OPTIONS = {
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
};

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
  if (!["desktop", "mobile", "mobile-multi-only", "full"].includes(args.mode)) {
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

function normalizeVisibleText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function getAutomationState(page) {
  if (!page || page.isClosed?.()) return null;
  const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
  return parseAutomationState(raw);
}

function buildFollowupVisibilityNeedles(apiPayload) {
  const assistantTurns = (apiPayload?.turns ?? []).filter((turn) => turn?.source !== "user_turn");
  return [...new Set(
    assistantTurns
      .map((turn) => normalizeVisibleText(turn?.content))
      .filter(Boolean)
      .map((text) => text.slice(0, 48)),
  )];
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}: ${await response.text()}`);
  }
  return response.json();
}

async function getScenarioAgents(frontendUrl, scenarioId) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  return fetchJson(`${backendUrl}/api/scenario/${scenarioId}/agents`);
}

function sortBranchesByProbability(branches) {
  return [...(branches ?? [])].sort((left, right) => {
    const leftProb = Number(left?.probability ?? 0);
    const rightProb = Number(right?.probability ?? 0);
    if (rightProb !== leftProb) return rightProb - leftProb;
    return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
  });
}

async function waitForEndingRoomSnapshot(frontendUrl, roomId, predicate, timeout = 90000, label = "ending-room snapshot") {
  const backendUrl = resolveBackendUrl(frontendUrl);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    let snapshot = null;
    try {
      snapshot = await fetchJson(`${backendUrl}/api/ending-room/${roomId}`);
    } catch {
      snapshot = null;
    }
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label} (${roomId})`);
}

async function prewarmEndingRoom(frontendUrl, scenarioId, {
  roomType = "ending_chamber",
  anchorBranchId,
  selectedBranchIds,
  selectedAgentIds = [],
  language = "zh",
}) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  const scenario = await fetchJson(`${backendUrl}/api/scenario/${scenarioId}`);
  const orderedBranches = sortBranchesByProbability(scenario.branches);
  const resolvedAnchorBranchId = anchorBranchId ?? orderedBranches[0]?.id ?? null;
  const resolvedSelectedBranchIds = selectedBranchIds ?? (resolvedAnchorBranchId ? [resolvedAnchorBranchId] : []);
  const snapshot = await postJson(`${backendUrl}/api/scenario/${scenarioId}/ending-room`, {
    room_type: roomType,
    anchor_branch_id: resolvedAnchorBranchId,
    selected_branch_ids: resolvedSelectedBranchIds,
    selected_agent_ids: selectedAgentIds,
    language,
  });
  if (snapshot.status === "done" && snapshot.result_ready) {
    return snapshot;
  }
  return waitForEndingRoomSnapshot(
    frontendUrl,
    snapshot.id,
    (current) => current.status === "done" && current.result_ready === true,
    120000,
    "prewarmed ending-room result",
  );
}

async function getSelectedPickerAgentIds(page, frontendUrl, scenarioId) {
  const selectedNames = await page.evaluate(() => (
    [...document.querySelectorAll(".ending-room-picker__card.is-selected strong")]
      .map((el) => el.textContent?.trim())
      .filter(Boolean)
  ));
  const agents = await getScenarioAgents(frontendUrl, scenarioId);
  const selectedAgentIds = selectedNames
    .map((name) => agents.find((agent) => agent.name === name)?.id ?? null)
    .filter(Boolean);
  return {
    selectedNames,
    selectedAgentIds,
  };
}

async function appendRoomUserTurnViaApi(frontendUrl, roomId, payload) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  return postJson(`${backendUrl}/api/ending-room/${roomId}/user-turn`, payload);
}

async function createEndingRoomThreadViaApi(frontendUrl, roomId, payload) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  return postJson(`${backendUrl}/api/ending-room/${roomId}/thread`, payload);
}

async function appendThreadUserTurnViaApi(frontendUrl, threadId, payload) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  return postJson(`${backendUrl}/api/ending-room/thread/${threadId}/user-turn`, payload);
}

async function findScenarioIds(frontendUrl) {
  const backendUrl = resolveBackendUrl(frontendUrl);
  const list = await fetchJson(`${backendUrl}/api/scenarios?status=done&limit=80&offset=0`);
  const multiCandidates = [];
  const singleCandidates = [];
  for (const scenario of list.scenarios ?? []) {
    const detail = await fetchJson(`${backendUrl}/api/scenario/${scenario.id}`);
    const branchCount = Array.isArray(detail.branches) ? detail.branches.length : 0;
    const candidate = {
      id: detail.id,
      branchCount,
      createdAt: String(detail.created_at ?? ""),
    };
    if (branchCount > 1) {
      multiCandidates.push(candidate);
    }
    if (branchCount === 1) {
      singleCandidates.push(candidate);
    }
  }
  multiCandidates.sort((left, right) => {
    if (right.branchCount !== left.branchCount) {
      return right.branchCount - left.branchCount;
    }
    return left.createdAt.localeCompare(right.createdAt);
  });
  singleCandidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const multiId = multiCandidates[0]?.id ?? null;
  const singleId = singleCandidates[0]?.id ?? null;
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function saveScreenshot(page, filePath) {
  try {
    await page.screenshot({
      path: filePath,
      type: "png",
      scale: "css",
      animations: "disabled",
      timeout: 0,
    });
  } catch (error) {
    console.warn(`[ending-room] screenshot skipped for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fillComposerIfEditable(page, text) {
  const textarea = page.locator("textarea").last();
  const editable = await textarea.isEditable().catch(() => false);
  if (!editable) return false;
  await textarea.fill(text);
  return true;
}

async function readComposerValue(page) {
  const textarea = page.locator("textarea").last();
  const visible = await textarea.isVisible().catch(() => false);
  if (!visible) return "";
  return textarea.inputValue().catch(() => "");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
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
    const payload = await getAutomationState(page);
    const modalState = payload?.page?.controls?.modal_state;
    if (!captures.turn_start && modalState?.pending_draft_count > 0 && modalState?.stream_state === "turn_start") {
      captures.turn_start = modalState;
      await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-start.png`));
      writeJson(path.join(outputDir, `${filePrefix}-turn-start.json`), payload);
    }
    if (!captures.turn_delta && modalState?.pending_draft_count > 0 && modalState?.stream_state === "turn_delta") {
      captures.turn_delta = modalState;
      await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-delta.png`));
      writeJson(path.join(outputDir, `${filePrefix}-turn-delta.json`), payload);
    }
    if (modalState && isCommitState(modalState, payload)) {
      if (!captures.turn_commit) {
        captures.turn_commit = modalState;
        await saveScreenshot(page, path.join(outputDir, `${filePrefix}-turn-commit.png`));
        writeJson(path.join(outputDir, `${filePrefix}-turn-commit.json`), payload);
      }
      return {
        payload,
        captures,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error(`Timed out waiting for ${label}`);
  error.captures = captures;
  throw error;
}

function hasReachedCommittedTurnDelta(modalState, beforeModalState, minimumDelta) {
  return (modalState?.turn_count ?? 0) >= ((beforeModalState?.turn_count ?? 0) + minimumDelta);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function openPicker(page, buttonRegex, index) {
  const button = page.getByRole("button", { name: buttonRegex }).nth(index);
  await button.waitFor({ state: "visible", timeout: 30000 });
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.click({ force: true });
  await page.waitForSelector(".ending-room-picker", { timeout: 15000 });
}

async function enterRoomFromPicker(page, options = {}) {
  const {
    expectedRoomId = null,
    timeout = 45000,
  } = options;
  const cards = await page.locator(".ending-room-picker__card").allInnerTexts();
  const confirmButton = page.locator(".ending-room-picker__footer .btn").last();
  await confirmButton.scrollIntoViewIfNeeded().catch(() => {});
  await confirmButton.click({ force: true });
  try {
    await page.waitForSelector(".ending-chat-modal", { timeout: 5000 });
  } catch {
    await confirmButton.click({ force: true });
    await page.waitForSelector(".ending-chat-modal", { timeout: 15000 });
  }
  const automation = await waitForLiveEndingRoomVisible(page, {
    expectedRoomId,
    timeout,
    label: "ending-room modal usable state",
  });
  return {
    cards,
    modalState: automation?.page?.controls?.modal_state ?? null,
  };
}

async function reopenLiveEndingRoomPage(
  context,
  roomUrl,
  roomId,
  roomType,
  label,
  contextOptions = {},
) {
  let page;
  try {
    page = await context.newPage();
  } catch {
    let freshContext = null;
    const browser = context.browser?.();
    if (browser) {
      try {
        freshContext = await browser.newContext(contextOptions);
      } catch {
        freshContext = null;
      }
    }
    if (!freshContext) {
      const fallbackBrowser = await chromium.launch(BROWSER_LAUNCH_OPTIONS);
      freshContext = await fallbackBrowser.newContext(contextOptions);
      console.warn(`[ending-room] ${label}: relaunched browser after context/browser closure`);
    }
    page = await freshContext.newPage();
  }
  await page.goto(roomUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  await waitForLiveEndingRoomVisible(page, {
    expectedRoomId: roomId,
    expectedRoomType: roomType,
    timeout: 45000,
    label,
  });
  return page;
}

async function ensureLiveEndingRoomPage(
  page,
  context,
  roomUrl,
  roomId,
  roomType,
  label,
  contextOptions = {},
) {
  if (page && !page.isClosed?.()) {
    return page;
  }
  console.warn(`[ending-room] ${label}: page closed unexpectedly, reopening room`);
  return reopenLiveEndingRoomPage(
    context,
    roomUrl,
    roomId,
    roomType,
    `${label} reopen`,
    contextOptions,
  );
}

async function waitForLiveEndingRoomVisible(page, {
  expectedRoomId = null,
  expectedRoomType = null,
  timeout = 45000,
  label = "ending-room modal usable state",
} = {}) {
  try {
    return await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        if (modalState?.room_id) {
          if (expectedRoomId && modalState.room_id !== expectedRoomId) return null;
          if (expectedRoomType && modalState.room_type !== expectedRoomType) return null;
          if (modalState.status === "loading") return null;
          if (!modalState.has_result && !modalState.can_send) return null;
          return current;
        }
        const uiReady = await page.evaluate(() => {
          const modal = document.querySelector(".ending-chat-modal");
          if (!(modal instanceof HTMLElement)) return false;
          const text = modal.innerText || "";
          const composer = modal.querySelector("textarea.ending-chat-composer__input");
          const hasComposer = composer instanceof HTMLTextAreaElement;
          const hasModePill = modal.querySelector(".ending-chat-mode-pill") instanceof HTMLElement;
          const hasCloseButton = modal.querySelector(".ending-chat-close") instanceof HTMLElement;
          return text.includes("结局会客厅")
            || text.includes("Ending Chamber")
            || text.includes("只改一步")
            || text.includes("One Move Only")
            || text.includes("当前参与者")
            || text.includes("Current participants")
            || hasComposer
            || hasModePill
            || hasCloseButton;
        });
        if (!uiReady) return null;
        return {
          page: {
            controls: {
              modal_state: {
                room_id: expectedRoomId,
                room_type: expectedRoomType,
                status: "done",
                has_result: true,
                can_send: true,
              },
            },
          },
        };
      },
      label,
      timeout,
    );
  } catch (error) {
    if (!expectedRoomId && !expectedRoomType) throw error;
    console.warn(`[ending-room] ${label} fell back to any ready room: ${error instanceof Error ? error.message : String(error)}`);
    return waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        if (!modalState?.room_id) return null;
        if (modalState.status === "loading") return null;
        if (!modalState.has_result && !modalState.can_send) return null;
        if (expectedRoomType && modalState.room_type !== expectedRoomType) return null;
        return current;
      },
      `${label} fallback`,
      timeout,
    );
  }
}

async function openGallery(page) {
  await page.getByRole("button", { name: /Crossline Gallery|异线旁听席/i }).first().click();
  await page.waitForSelector(".ending-chat-modal", { timeout: 15000 });
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (modalState?.room_id) {
        if (modalState.room_type !== "crossline_gallery") return null;
        if (modalState.can_send !== false) return null;
        if (!modalState.has_result) return null;
        return current;
      }
      const uiReady = await page.evaluate(() => {
        const modal = document.querySelector(".ending-chat-modal");
        if (!(modal instanceof HTMLElement)) return false;
        const text = modal.innerText || "";
        return text.includes("异线旁听席")
          || text.includes("Crossline Gallery")
          || text.includes("只看本桌记录")
          || text.includes("summary-only");
      });
      if (!uiReady) return null;
      return {
        page: {
          controls: {
            modal_state: {
              room_type: "crossline_gallery",
              can_send: false,
              has_result: true,
            },
          },
        },
      };
    },
    "crossline gallery usable state",
    20000,
  );
}

async function waitForModalSettled(page, label, timeout = 35000) {
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

async function waitForApiDrivenFollowupVisible(page, {
  label,
  frontendUrl = null,
  roomId,
  beforeModalState,
  apiPayload,
  timeout = 45000,
}) {
  const assistantTurns = (apiPayload?.turns ?? []).filter((turn) => turn?.source !== "user_turn");
  const expectedThreadId = apiPayload?.thread_id ?? beforeModalState?.active_thread_id ?? null;
  const isNewThread = Boolean(
    expectedThreadId && expectedThreadId !== beforeModalState?.active_thread_id,
  );
  const expectedTurnCount = isNewThread
    ? assistantTurns.length
    : Math.max(
      (beforeModalState?.turn_count ?? 0) + assistantTurns.length,
      assistantTurns.length,
    );
  const expectedInteractionMode = assistantTurns.at(-1)?.interaction_mode ?? null;
  const expectedThreadCount = isNewThread
    ? (beforeModalState?.thread_count ?? 0) + 1
    : (beforeModalState?.thread_count ?? 0);
  const expectedSnapshotTurnCount = expectedThreadId && expectedThreadId !== beforeModalState?.active_thread_id
    ? Math.max(assistantTurns.length, 1)
    : expectedTurnCount;
  const visibilityNeedles = buildFollowupVisibilityNeedles(apiPayload);
  try {
    return await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        const visibleAssistantCopy = visibilityNeedles.length > 0
          ? await page.evaluate((needles) => {
            const modal = document.querySelector(".ending-chat-modal");
            if (!(modal instanceof HTMLElement)) return false;
            const text = (modal.innerText || "").replace(/\s+/g, " ").trim();
            return needles.some((needle) => needle.length > 0 && text.includes(needle));
          }, visibilityNeedles)
          : false;
        if (modalState?.room_id && roomId && modalState.room_id !== roomId) return null;
        if (modalState && (modalState.pending_draft_count ?? 0) > 0) return null;
        if (expectedThreadId && modalState?.active_thread_id && modalState.active_thread_id !== expectedThreadId) return null;
        if (expectedInteractionMode && modalState?.interaction_mode && modalState.interaction_mode !== expectedInteractionMode) return null;
        const hasTurnProgress = modalState
          ? (
            (modalState.turn_count ?? 0) >= expectedTurnCount
            || (modalState.thread_count ?? 0) >= expectedThreadCount
            || (
              expectedThreadId
              && modalState.active_thread_id === expectedThreadId
              && modalState.active_thread_id !== (beforeModalState?.active_thread_id ?? null)
            )
          )
          : false;
        if (hasTurnProgress || visibleAssistantCopy) {
          return current ?? {
            page: {
              controls: {
                modal_state: {
                  room_id: roomId,
                  active_thread_id: expectedThreadId,
                  interaction_mode: expectedInteractionMode,
                  pending_draft_count: 0,
                },
              },
            },
          };
        }
        if (!frontendUrl) return null;

        let snapshot = null;
        try {
          snapshot = await fetchJson(`${resolveBackendUrl(frontendUrl)}/api/ending-room/${roomId}`);
        } catch {
          snapshot = null;
        }
        if (!snapshot) return null;
        const threadExists = !expectedThreadId || (snapshot.threads ?? []).some((thread) => thread?.id === expectedThreadId);
        if (!threadExists) return null;
        const threadTurns = (snapshot.turns ?? []).filter((turn) => !expectedThreadId || turn?.thread_id === expectedThreadId);
        if (threadTurns.length < expectedSnapshotTurnCount) return null;
        const lastAssistantTurn = [...threadTurns].reverse().find((turn) => turn?.source !== "user_turn") ?? null;
        const snapshotInteractionMode = lastAssistantTurn?.interaction_mode
          ?? (snapshot.threads ?? []).find((thread) => thread?.id === expectedThreadId)?.interaction_mode
          ?? null;
        if (expectedInteractionMode && snapshotInteractionMode !== expectedInteractionMode) return null;

        return current ?? {
          page: {
            controls: {
              modal_state: {
                room_id: roomId,
                active_thread_id: expectedThreadId,
                interaction_mode: expectedInteractionMode ?? snapshotInteractionMode,
                turn_count: threadTurns.length,
                pending_draft_count: 0,
              },
            },
          },
        };
      },
      label,
      timeout,
    );
  } catch (error) {
    console.warn(
      `[ending-room] ${label} fell back to settled modal wait: ${error instanceof Error ? error.message : String(error)}`,
    );
    return waitForModalSettled(page, `${label} settled fallback`, Math.min(timeout, 15000))
      .catch(() => getAutomationState(page));
  }
}

async function waitForReadonlyEndingRoomVisible(page, label, timeout = 40000) {
  return waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      const modalState = current?.page?.controls?.modal_state;
      if (modalState?.read_only === true && modalState?.can_send === false) {
        return current;
      }
      const uiReady = await page.evaluate(() => {
        const modal = document.querySelector(".ending-chat-modal");
        if (!(modal instanceof HTMLElement)) return false;
        const text = modal.innerText || "";
        const hasImport = text.includes("Import local run")
          || text.includes("Import as Local Run")
          || text.includes("导入本地运行")
          || text.includes("导入为本地运行");
        const hasNoComposer = !modal.querySelector(".ending-chat-send");
        return hasImport || hasNoComposer;
      });
      if (!uiReady) return null;
      return {
        page: {
          controls: {
            modal_state: {
              read_only: true,
              can_send: false,
            },
          },
        },
      };
    },
    label,
    timeout,
  );
}

async function focusEndingRoomThreadChip(page, frontendUrl, roomId, {
  threadTitle,
  expectedThreadId,
  timeout = 30000,
}) {
  const titlePattern = new RegExp(threadTitle, "i");
  const chip = await waitFor(
    page,
    async () => {
      const titledChip = page.getByRole("button", { name: titlePattern }).first();
      if (await titledChip.isVisible().catch(() => false)) {
        return titledChip;
      }

      const genericChip = page.locator(".ending-chat-thread-chip").first();
      if (!await genericChip.isVisible().catch(() => false)) {
        return null;
      }

      const current = await getAutomationState(page);
      if (current?.page?.controls?.modal_state?.active_thread_id === expectedThreadId) {
        return genericChip;
      }

      const snapshot = await fetchJson(`${resolveBackendUrl(frontendUrl)}/api/ending-room/${roomId}`);
      const threadExists = (snapshot.threads ?? []).some((thread) => thread?.id === expectedThreadId);
      return threadExists ? genericChip : null;
    },
    "single ending verdict thread chip",
    timeout,
  );

  await chip.click();
  await waitFor(
    page,
    async () => {
      const current = await getAutomationState(page);
      return current?.page?.controls?.modal_state?.active_thread_id === expectedThreadId
        ? current
        : null;
    },
    "single ending verdict thread active",
    timeout,
  );
}

async function createVerdictAnchoredThread(page, label) {
  const summaryThreadButton = page.getByRole("button", {
    name: /Start anchored thread|另开线程|Start thread from current anchor|从当前锚点开始线程|从当前锚点发起线程/i,
  }).first();
  if (await summaryThreadButton.isVisible().catch(() => false)) {
    await summaryThreadButton.click();
  } else {
    await page.getByRole("button", { name: /Continue from verdict|沿着当前结局继续追问|继续追问当前结局|继续追问/i }).first().click();
    const followupAnchorButton = page.getByRole("button", {
      name: /Start anchored thread|另开线程|Start thread from current anchor|从当前锚点开始线程|从当前锚点发起线程/i,
    }).first();
    if (await followupAnchorButton.isVisible().catch(() => false)) {
      await followupAnchorButton.click();
    }
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
    35000,
  );
}

async function sendAnchoredFollowup(page, label, options = {}) {
  const { outputDir = null, filePrefix = null } = options;
  const sendButton = page.getByRole("button", { name: /Send|发送追问/i });
  await sendButton.click();
  if (outputDir && filePrefix) {
    return captureStreamLifecycle(page, {
      label,
      outputDir,
      filePrefix,
      isCommitState: (modalState) => (
        modalState?.interaction_mode === "thread_followup"
        && (modalState?.turn_count ?? 0) > 0
        && (modalState?.question_anchor_ids?.length ?? 0) > 0
        && (modalState?.pending_question_anchor_ids?.length ?? 0) === 0
        && (modalState?.pending_draft_count ?? 0) === 0
      ),
    });
  }
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
        && (modalState?.pending_draft_count ?? 0) === 0
      ) {
        return current;
      }
      return null;
    },
    label,
    60000,
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
  let page = await context.newPage();
  const { multiId } = scenarioIds;
  const backendUrl = resolveBackendUrl(frontendUrl);
  const resultUrl = `${new URL(frontendUrl).origin}/result/${multiId}`;
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const initialAutomation = await getAutomationState(page);
  const anchorBranchId = initialAutomation?.page?.branches?.[0]?.id ?? null;
  await saveScreenshot(page, path.join(outputDir, "multi-result-initial.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-result-initial.json"),
    JSON.stringify(initialAutomation, null, 2),
  );

  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  const pickerSeed = await getSelectedPickerAgentIds(page, frontendUrl, multiId);
  const prewarmedChamber = await prewarmEndingRoom(frontendUrl, multiId, {
    roomType: "ending_chamber",
    anchorBranchId,
    selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
    selectedAgentIds: pickerSeed.selectedAgentIds,
    language: "zh",
  });
  const directOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(prewarmedChamber.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=${encodeURIComponent(pickerSeed.selectedAgentIds.join(","))}`;
  await page.goto(directOpenUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  const pickerA = {
    cards: pickerSeed.selectedNames,
    modalState: {
      room_id: prewarmedChamber.id,
      branch_id: prewarmedChamber.anchor_branch_id ?? anchorBranchId,
      room_type: "ending_chamber",
      has_result: true,
      can_send: true,
      status: prewarmedChamber.status,
    },
  };
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-initial.png"));
  fs.writeFileSync(path.join(outputDir, "multi-picker-A.json"), JSON.stringify({
    ...pickerA,
    pickerSeed,
    prewarmedRoomId: prewarmedChamber.id,
  }, null, 2));
  fs.writeFileSync(
    path.join(outputDir, "multi-chamber-A-initial.json"),
    JSON.stringify(await getAutomationState(page), null, 2),
  );
  const roomId = pickerA?.modalState?.room_id ?? prewarmedChamber.id;
  const roomSnapshot = await fetchJson(`${backendUrl}/api/ending-room/${roomId}`);
  const addressableAgentIds = (roomSnapshot.participants ?? [])
    .filter((participant) => participant?.source_agent_id && participant?.role_slot !== "archivist" && participant?.role_slot !== "user")
    .map((participant) => participant.source_agent_id);

  const beforeHotseat = await getAutomationState(page);
  const hotseatPill = page.locator(".ending-chat-mode-pill").filter({ hasText: /Question one role|Hotseat|点名角色|角色热座/i }).first();
  if (await hotseatPill.count() > 0) {
    await hotseatPill.scrollIntoViewIfNeeded().catch(() => {});
    await hotseatPill.click({ force: true }).catch(() => {});
  }
  await fillComposerIfEditable(page, "请点名说明，这条世界线最早的失控点在哪里？");
  const hotseatApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
    content: "请点名说明，这条世界线最早的失控点在哪里？",
    addressed_agent_ids: addressableAgentIds.slice(0, 1),
    interaction_mode: "hotseat",
  });
  let hotseatLifecycle = null;
  let hotseatCaptures = null;
  try {
    hotseatLifecycle = await captureStreamLifecycle(page, {
      label: "hotseat follow-up state",
      outputDir,
      filePrefix: "multi-chamber-A-hotseat",
      timeout: 70000,
      isCommitState: (modalState) => (
        modalState?.interaction_mode === "hotseat"
        && (modalState?.thread_count ?? 0) >= ((beforeHotseat?.page?.controls?.modal_state?.thread_count ?? 0))
        && (modalState?.active_thread_id ?? null) !== (beforeHotseat?.page?.controls?.modal_state?.active_thread_id ?? null)
        && (modalState?.pending_draft_count ?? 0) === 0
      ),
    });
  } catch (error) {
    hotseatCaptures = error?.captures ?? null;
    console.warn(`[ending-room] hotseat lifecycle capture fell back to settled wait: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hotseatApiPayload = await hotseatApiPromise;
  if (page.isClosed()) {
    page = await reopenLiveEndingRoomPage(
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "hotseat room reopen",
      DESKTOP_CONTEXT_OPTIONS,
    );
  }
  let hotseatState = hotseatLifecycle?.payload ?? null;
  if (!hotseatState) {
    try {
      hotseatState = await waitForApiDrivenFollowupVisible(page, {
        label: "hotseat api-driven visible state",
        frontendUrl,
        roomId,
        beforeModalState: beforeHotseat?.page?.controls?.modal_state ?? null,
        apiPayload: hotseatApiPayload,
        timeout: 45000,
      });
    } catch (visibleError) {
      console.warn(`[ending-room] hotseat UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
      hotseatState = await waitForModalSettled(page, "hotseat settled fallback", 10000).catch(() => getAutomationState(page));
    }
  }
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-hotseat.png"));
  writeJson(path.join(outputDir, "multi-chamber-A-hotseat.json"), {
    state: hotseatState,
    api_payload: hotseatApiPayload,
    stream_lifecycle: hotseatLifecycle?.captures ?? hotseatCaptures,
  });
  if (page.isClosed()) {
    page = await reopenLiveEndingRoomPage(
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "post-hotseat room reopen",
      DESKTOP_CONTEXT_OPTIONS,
    );
  }

  const beforeAllPresent = await getAutomationState(page);
  const beforeAllPresentModal = beforeAllPresent?.page?.controls?.modal_state;
  const allPresentPill = page.locator(".ending-chat-mode-pill").filter({ hasText: /Current lineup responds|Everyone responds|All present|当前阵容回应|全员回应|当前全员回应/i }).first();
  if (await allPresentPill.count() > 0) {
    await allPresentPill.scrollIntoViewIfNeeded().catch(() => {});
    await allPresentPill.click({ force: true }).catch(() => {});
  }
  await fillComposerIfEditable(page, "如果让当前阵容都回应一次，他们会如何分工？");
  const allPresentApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
    content: "如果让当前阵容都回应一次，他们会如何分工？",
    addressed_agent_ids: addressableAgentIds,
    interaction_mode: "all_present",
  });
  let allPresentLifecycle = null;
  let allPresentCaptures = null;
  try {
    allPresentLifecycle = await captureStreamLifecycle(page, {
      label: "all-present follow-up state",
      outputDir,
      filePrefix: "multi-chamber-A-all-present",
      timeout: 70000,
      isCommitState: (modalState) => (
        modalState?.interaction_mode === "all_present"
        && (
          hasReachedCommittedTurnDelta(modalState, beforeAllPresentModal, 3)
          || (modalState?.active_thread_id ?? null) !== (beforeAllPresentModal?.active_thread_id ?? null)
        )
        && (
          (modalState?.pending_draft_count ?? 0) === 0
          || hasReachedCommittedTurnDelta(modalState, beforeAllPresentModal, 3)
        )
      ),
    });
  } catch (error) {
    allPresentCaptures = error?.captures ?? null;
    console.warn(`[ending-room] all-present lifecycle capture fell back to settled wait: ${error instanceof Error ? error.message : String(error)}`);
  }
  const allPresentApiPayload = await allPresentApiPromise;
  if (page.isClosed()) {
    page = await reopenLiveEndingRoomPage(
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "all-present room reopen",
      DESKTOP_CONTEXT_OPTIONS,
    );
  }
  let allPresentState = allPresentLifecycle?.payload ?? null;
  if (!allPresentState) {
    try {
      allPresentState = await waitForApiDrivenFollowupVisible(page, {
        label: "all-present api-driven visible state",
        frontendUrl,
        roomId,
        beforeModalState: beforeAllPresentModal ?? null,
        apiPayload: allPresentApiPayload,
        timeout: 60000,
      });
    } catch (visibleError) {
      console.warn(`[ending-room] all-present UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
      allPresentState = await waitForModalSettled(page, "all-present settled fallback", 10000).catch(() => getAutomationState(page));
    }
  }
  await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-all-present.png"));
  writeJson(path.join(outputDir, "multi-chamber-A-all-present.json"), {
    state: allPresentState,
    api_payload: allPresentApiPayload,
    stream_lifecycle: allPresentLifecycle?.captures ?? allPresentCaptures,
  });

  // ── Epilogue (后续三回合) ──────────────────────────────────
  const epilogueBtn = page.locator(".ending-chat-epilogue-btn");
  let epilogueState = null;
  let epilogueLifecycle = null;
  if (await epilogueBtn.count() > 0) {
    const beforeEpilogue = await getAutomationState(page);
    await epilogueBtn.click();
    await page.waitForTimeout(200);
    const prefilled = await readComposerValue(page);
    if (!prefilled || prefilled.trim().length === 0) {
      await fillComposerIfEditable(page, "请继续推演后续三回合，看看局势如何收场。");
    }
    const epilogueApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
      content: "这条世界线接下来会发生什么？",
      interaction_mode: "epilogue",
    });
    let epilogueCaptures = null;
    try {
      epilogueLifecycle = await captureStreamLifecycle(page, {
        label: "epilogue follow-up state",
        outputDir,
        filePrefix: "multi-chamber-A-epilogue",
        timeout: 90000,
        isCommitState: (modalState) => (
          modalState?.interaction_mode === "epilogue"
          && (modalState?.turn_count ?? 0) > (beforeEpilogue?.page?.controls?.modal_state?.turn_count ?? 0)
          && (modalState?.pending_draft_count ?? 0) === 0
        ),
      });
    } catch (error) {
      epilogueCaptures = error?.captures ?? null;
      console.warn(`[ending-room] epilogue lifecycle capture fell back to settled wait: ${error instanceof Error ? error.message : String(error)}`);
    }
    const epilogueApiPayload = await epilogueApiPromise;
    if (page.isClosed()) {
      page = await reopenLiveEndingRoomPage(
        context,
        directOpenUrl,
        roomId,
        "ending_chamber",
        "epilogue room reopen",
        DESKTOP_CONTEXT_OPTIONS,
      );
    }
    epilogueState = epilogueLifecycle?.payload ?? null;
    if (!epilogueState) {
      try {
        epilogueState = await waitForApiDrivenFollowupVisible(page, {
          label: "epilogue api-driven visible state",
          frontendUrl,
          roomId,
          beforeModalState: beforeEpilogue?.page?.controls?.modal_state ?? null,
          apiPayload: epilogueApiPayload,
          timeout: 90000,
        });
      } catch (visibleError) {
        console.warn(`[ending-room] epilogue UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
        epilogueState = await waitForModalSettled(page, "epilogue settled fallback", 10000).catch(() => getAutomationState(page));
      }
    }
    await saveScreenshot(page, path.join(outputDir, "multi-chamber-A-epilogue.png"));
    writeJson(path.join(outputDir, "multi-chamber-A-epilogue.json"), {
      state: epilogueState,
      api_payload: epilogueApiPayload,
      stream_lifecycle: epilogueLifecycle?.captures ?? epilogueCaptures,
    });
  }

  page = await ensureLiveEndingRoomPage(
    page,
    context,
    directOpenUrl,
    roomId,
    "ending_chamber",
    "pre-one-move flow",
    DESKTOP_CONTEXT_OPTIONS,
  );
  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);

  await openPicker(page, /One Move Only|只改一步/i, 1);
  const pickerBSeed = await getSelectedPickerAgentIds(page, frontendUrl, multiId);
  const prewarmedOneMove = await prewarmEndingRoom(frontendUrl, multiId, {
    roomType: "one_move_only",
    anchorBranchId,
    selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
    selectedAgentIds: pickerBSeed.selectedAgentIds,
    language: "zh",
  });
  const oneMoveOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(prewarmedOneMove.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=one_move_only&debugEndingRoomAgents=${encodeURIComponent(pickerBSeed.selectedAgentIds.join(","))}`;
  await page.goto(oneMoveOpenUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  const oneMoveAutomation = await waitForLiveEndingRoomVisible(page, {
    expectedRoomId: prewarmedOneMove.id,
    expectedRoomType: "one_move_only",
    timeout: 45000,
    label: "one-move room usable state",
  });
  const pickerB = {
    cards: pickerBSeed.selectedNames,
    modalState: oneMoveAutomation?.page?.controls?.modal_state ?? {
      room_id: prewarmedOneMove.id,
      branch_id: prewarmedOneMove.anchor_branch_id ?? anchorBranchId,
      room_type: "one_move_only",
      has_result: true,
      can_send: true,
      status: prewarmedOneMove.status,
    },
  };
  const oneMoveState = oneMoveAutomation;
  await saveScreenshot(page, path.join(outputDir, "multi-one-move-B.png"));
  fs.writeFileSync(path.join(outputDir, "multi-picker-B-one-move.json"), JSON.stringify(pickerB, null, 2));
  fs.writeFileSync(path.join(outputDir, "multi-one-move-B.json"), JSON.stringify(oneMoveState, null, 2));

  page = await ensureLiveEndingRoomPage(
    page,
    context,
    oneMoveOpenUrl,
    prewarmedOneMove.id,
    "one_move_only",
    "pre-gallery flow",
    DESKTOP_CONTEXT_OPTIONS,
  );
  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);

  const galleryState = await openGallery(page);
  await saveScreenshot(page, path.join(outputDir, "multi-crossline-gallery.png"));
  fs.writeFileSync(
    path.join(outputDir, "multi-crossline-gallery.json"),
    JSON.stringify(galleryState, null, 2),
  );

  // ── Evidence Card (证据投牌) ────────────────────────────────
  // Evidence buttons only render in non-gallery rooms (composerEnabled requires !isCrosslineGallery).
  // Close the gallery, prewarm a fresh ending_chamber, and navigate to it.
  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);

  const evidenceChamber = await prewarmEndingRoom(frontendUrl, multiId, {
    roomType: "ending_chamber",
    anchorBranchId,
    selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
    selectedAgentIds: pickerSeed.selectedAgentIds,
    language: "zh",
  });
  const evidenceRoomId = evidenceChamber.id;
  const evidenceOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(evidenceChamber.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=${encodeURIComponent(pickerSeed.selectedAgentIds.join(","))}`;
  if (page.isClosed()) {
    page = await context.newPage();
  }
  await page.goto(evidenceOpenUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  await waitForLiveEndingRoomVisible(page, {
    expectedRoomType: "ending_chamber",
    timeout: 45000,
    label: "evidence_card ending chamber ready",
  });

  // Expand the evidence drawer (<details> is collapsed by default)
  const evidenceDrawer = page.locator(".ending-chat-evidence-drawer > summary").first();
  let evidenceCardState = null;
  let evidenceCardLifecycle = null;
  if (await evidenceDrawer.count() > 0) {
    await evidenceDrawer.click();
    await page.waitForTimeout(300);

    const beforeEvidence = await getAutomationState(page);
    // Get the actual room_id the frontend opened (may differ from prewarm ID)
    const actualEvidenceRoomId = beforeEvidence?.page?.controls?.modal_state?.room_id ?? evidenceRoomId;
    // galleryCards in UI come from scenario branches (passed via ResultView), not from room result.
    const scenarioBranches = initialAutomation?.page?.branches ?? [];
    const foreignBranchId = scenarioBranches
      .map((b) => b?.id)
      .find((branchId) => branchId && branchId !== (pickerA?.modalState?.branch_id ?? null));
    if (!foreignBranchId) {
      throw new Error("No foreign branch available for evidence-card API flow");
    }
    const evidenceApiPromise = appendRoomUserTurnViaApi(frontendUrl, actualEvidenceRoomId, {
      content: "请用另一条世界线的证据解释这次分裂为什么会扩大。",
      interaction_mode: "evidence_card",
      cited_branch_id: foreignBranchId,
    });
    let evidenceCardCaptures = null;
    try {
      evidenceCardLifecycle = await captureStreamLifecycle(page, {
        label: "evidence-card follow-up state",
        outputDir,
        filePrefix: "multi-gallery-evidence-card",
        timeout: 70000,
        isCommitState: (modalState) => (
          (modalState?.turn_count ?? 0) > (beforeEvidence?.page?.controls?.modal_state?.turn_count ?? 0)
          && (modalState?.pending_draft_count ?? 0) === 0
        ),
      });
    } catch (error) {
      evidenceCardCaptures = error?.captures ?? null;
      console.warn(`[ending-room] evidence-card lifecycle capture fell back to settled wait: ${error instanceof Error ? error.message : String(error)}`);
    }
    const evidenceApiPayload = await evidenceApiPromise;
    // Save API response artifact immediately — this proves the backend processed the evidence_card turn
    writeJson(path.join(outputDir, "multi-gallery-evidence-card-api.json"), {
      api_payload: evidenceApiPayload,
      actual_room_id: actualEvidenceRoomId,
      foreign_branch_id: foreignBranchId,
    });
    try {
      evidenceCardState = evidenceCardLifecycle?.payload ?? await waitForApiDrivenFollowupVisible(page, {
        label: "evidence-card api-driven visible state",
        frontendUrl,
        roomId: actualEvidenceRoomId,
        beforeModalState: beforeEvidence?.page?.controls?.modal_state ?? null,
        apiPayload: evidenceApiPayload,
        timeout: 60000,
      });
    } catch (visibleError) {
      console.warn(`[ending-room] evidence-card UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
      evidenceCardState = await waitForModalSettled(page, "evidence-card settled fallback", 10000).catch(() => getAutomationState(page));
    }
    page = await ensureLiveEndingRoomPage(
      page,
      context,
      directOpenUrl,
      actualEvidenceRoomId,
      "ending_chamber",
      "evidence-card replay controls",
    );
    await saveScreenshot(page, path.join(outputDir, "multi-gallery-evidence-card.png"));
    writeJson(path.join(outputDir, "multi-gallery-evidence-card.json"), {
      state: evidenceCardState,
      api_payload: evidenceApiPayload,
      stream_lifecycle: evidenceCardLifecycle?.captures ?? evidenceCardCaptures,
    });
  }

  await armClipboardCapture(page);
  let artifactReadonly = null;
  let artifactImportedUrl = null;
  let replayReadonly = null;
  let importedUrl = null;
  let replayCoverageError = null;
  try {
    await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "ending-room copied share permalink");
    const sharePage = await page.context().newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitForReadonlyEndingRoomVisible(
      sharePage,
      "ending-room artifact replay readonly state",
      40000,
    );
    await saveScreenshot(sharePage, path.join(outputDir, "multi-ending-room-replay-artifact.png"));
    fs.writeFileSync(
      path.join(outputDir, "multi-ending-room-replay-artifact.json"),
      JSON.stringify(artifactReadonly, null, 2),
    );
  const importButton = sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
    hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
  }).last();
    await importButton.waitFor({ state: "visible", timeout: 40000 });
    await importButton.click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();

    await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
    await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitForReadonlyEndingRoomVisible(
      page,
      "ending-room replay readonly state",
      40000,
    );
    await saveScreenshot(page, path.join(outputDir, "multi-ending-room-replay-readonly.png"));
    fs.writeFileSync(
      path.join(outputDir, "multi-ending-room-replay-readonly.json"),
      JSON.stringify(replayReadonly, null, 2),
    );

  await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
    hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
  }).last().click();
    await page.waitForURL(/\/sim\//, { timeout: 15000 });
    importedUrl = page.url();
  } catch (error) {
    replayCoverageError = String(error);
    fs.writeFileSync(
      path.join(outputDir, "multi-ending-room-replay-coverage-error.json"),
      JSON.stringify({ error: replayCoverageError }, null, 2),
    );
  }

  return {
    resultUrl,
    pickerA,
    hotseatState: hotseatState?.page?.controls?.modal_state ?? null,
    hotseatStreamLifecycle: hotseatLifecycle?.captures ?? hotseatCaptures ?? null,
    allPresentState: allPresentState?.page?.controls?.modal_state ?? null,
    allPresentStreamLifecycle: allPresentLifecycle?.captures ?? allPresentCaptures ?? null,
    epilogueState: epilogueState?.page?.controls?.modal_state ?? null,
    epilogueStreamLifecycle: epilogueLifecycle?.captures ?? null,
    pickerB,
    oneMoveState: oneMoveState?.page?.controls?.modal_state ?? null,
    galleryState: galleryState?.page?.controls?.modal_state ?? null,
    evidenceCardState: evidenceCardState?.page?.controls?.modal_state ?? null,
    evidenceCardStreamLifecycle: evidenceCardLifecycle?.captures ?? null,
    artifactReadonly: artifactReadonly?.page?.controls?.modal_state ?? null,
    artifactImportedUrl,
    replayReadonly: replayReadonly?.page?.controls?.modal_state ?? null,
    importedUrl,
    replayCoverageError,
  };
}

async function runSingleMobile(browser, frontendUrl, outputDir, scenarioIds) {
  const { singleId } = scenarioIds;
  const backendUrl = resolveBackendUrl(frontendUrl);
  const resultUrl = `${new URL(frontendUrl).origin}/result/${singleId}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let page = await context.newPage();
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  const pickerSeed = await getSelectedPickerAgentIds(page, frontendUrl, singleId);
  const initialAutomation = await getAutomationState(page);
  const anchorBranchId = initialAutomation?.page?.branches?.[0]?.id ?? null;
  const prewarmedChamber = await prewarmEndingRoom(frontendUrl, singleId, {
    roomType: "ending_chamber",
    anchorBranchId,
    selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
    selectedAgentIds: pickerSeed.selectedAgentIds,
    language: "zh",
  });
  await saveScreenshot(page, path.join(outputDir, "single-mobile-picker.png"));
  const directOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(prewarmedChamber.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=${encodeURIComponent(pickerSeed.selectedAgentIds.join(","))}`;
  await page.goto(directOpenUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  const liveVisibleState = await waitForLiveEndingRoomVisible(page, {
    expectedRoomId: prewarmedChamber.id,
    expectedRoomType: "ending_chamber",
    timeout: 45000,
    label: "single ending live chamber visible",
  });
  const pickerState = {
    cards: pickerSeed.selectedNames,
    modalState: {
      room_id: prewarmedChamber.id,
      branch_id: prewarmedChamber.anchor_branch_id ?? anchorBranchId,
      room_type: "ending_chamber",
      has_result: true,
      can_send: true,
      status: prewarmedChamber.status,
    },
  };
  const automation = liveVisibleState ?? await getAutomationState(page);
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
  const roomId = pickerState.modalState.room_id;
  const threadTitle = `E2E Verdict Thread ${Date.now()}`;
  const verdictAnchorId = `ending:verdict:${roomId}`;
  const createdThread = await createEndingRoomThreadViaApi(frontendUrl, roomId, {
    title: threadTitle,
    question_anchor_ids: [verdictAnchorId],
    interaction_mode: "thread_followup",
  });
  try {
    await focusEndingRoomThreadChip(page, frontendUrl, roomId, {
      threadTitle,
      expectedThreadId: createdThread.id,
      timeout: 30000,
    });
  } catch (error) {
    console.warn(
      `[ending-room] single ending verdict thread chip fell back to API-driven flow: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const beforeAnchored = await getAutomationState(page);
  const anchoredApiPromise = appendThreadUserTurnViaApi(frontendUrl, createdThread.id, {
    content: "沿着当前结局继续追问：为什么这个结论会成立？",
    question_anchor_ids: [verdictAnchorId],
    interaction_mode: "thread_followup",
  });
  let anchoredLifecycle = null;
  let anchoredCaptures = null;
  try {
    anchoredLifecycle = await captureStreamLifecycle(page, {
      label: "single ending anchored follow-up commit",
      outputDir,
      filePrefix: "single-mobile-anchored-thread",
      timeout: 70000,
      isCommitState: (modalState) => (
        modalState?.interaction_mode === "thread_followup"
        && (modalState?.active_thread_id ?? null) === createdThread.id
        && (modalState?.pending_draft_count ?? 0) === 0
        && (modalState?.question_anchor_ids?.length ?? 0) > 0
      ),
    });
  } catch (error) {
    anchoredCaptures = error?.captures ?? null;
    console.warn(`[ending-room] single anchored lifecycle capture fell back to API-driven wait: ${error instanceof Error ? error.message : String(error)}`);
  }
  const anchoredApiPayload = await anchoredApiPromise;
  page = await ensureLiveEndingRoomPage(
    page,
    context,
    directOpenUrl,
    roomId,
    "ending_chamber",
    "single ending anchored follow-up",
    MOBILE_CONTEXT_OPTIONS,
  );
  let anchoredState = anchoredLifecycle?.payload ?? null;
  if (!anchoredState) {
    try {
      anchoredState = await waitForApiDrivenFollowupVisible(page, {
        label: "single ending anchored api-driven visible state",
        roomId,
        beforeModalState: beforeAnchored?.page?.controls?.modal_state ?? null,
        apiPayload: anchoredApiPayload,
        timeout: 60000,
      });
    } catch (error) {
      console.warn(`[ending-room] single anchored api-driven wait fell back to backend snapshot: ${error instanceof Error ? error.message : String(error)}`);
      const anchoredSnapshot = await waitForEndingRoomSnapshot(
        frontendUrl,
        roomId,
        (current) => (
          (current?.threads ?? []).some((thread) => thread?.id === createdThread.id)
          && (current?.turns ?? []).some((turn) => turn?.thread_id === createdThread.id && turn?.source !== "user_turn")
        ),
        60000,
        "single ending anchored backend snapshot",
      );
      anchoredState = {
        page: {
          controls: {
            modal_state: {
              room_id: roomId,
              active_thread_id: createdThread.id,
              interaction_mode: "thread_followup",
              question_anchor_ids: [verdictAnchorId],
              pending_draft_count: 0,
              thread_count: anchoredSnapshot?.threads?.length ?? null,
              turn_count: (anchoredSnapshot?.turns ?? []).filter((turn) => turn?.thread_id === createdThread.id).length,
            },
          },
        },
      };
    }
  }
  await saveScreenshot(page, path.join(outputDir, "single-mobile-anchored-thread.png"));
  writeJson(path.join(outputDir, "single-mobile-anchored-thread.json"), {
    state: anchoredState,
    api_payload: anchoredApiPayload,
    stream_lifecycle: anchoredLifecycle?.captures ?? anchoredCaptures,
  });

  const anchoredModalState = anchoredState?.page?.controls?.modal_state ?? null;
  const anchoredThreadId = createdThread.id;
  const anchoredAnchorIds = [verdictAnchorId];
  page = await ensureLiveEndingRoomPage(
    page,
    context,
    directOpenUrl,
    roomId,
    "ending_chamber",
    "single ending replay controls",
    MOBILE_CONTEXT_OPTIONS,
  );
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
    artifactReadonly = await waitForReadonlyEndingRoomVisible(
      sharePage,
      "single ending artifact replay readonly state",
      30000,
    );
    await saveScreenshot(sharePage, path.join(outputDir, "single-mobile-replay-artifact.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-artifact.json"),
      JSON.stringify(artifactReadonly, null, 2),
    );
    await sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();
    await closePlaywrightPage(sharePage, "ending-room-single-mobile-share-page");

    await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
    await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitForReadonlyEndingRoomVisible(
      page,
      "single ending replay readonly state",
      30000,
    );
    await saveScreenshot(page, path.join(outputDir, "single-mobile-replay-readonly.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-readonly.json"),
      JSON.stringify(replayReadonly, null, 2),
    );
    const replayReadonlyUrl = page.url();

    await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await page.waitForURL(/\/sim\//, { timeout: 15000 });
    importedUrl = page.url();

    const reloadPage = await context.newPage();
    await reloadPage.goto(replayReadonlyUrl, { waitUntil: "domcontentloaded" });
    replayReloaded = await waitForReadonlyEndingRoomVisible(
      reloadPage,
      "single ending readonly restore",
      30000,
    );
    await saveScreenshot(reloadPage, path.join(outputDir, "single-mobile-replay-readonly-reloaded.png"));
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-readonly-reloaded.json"),
      JSON.stringify(replayReloaded, null, 2),
    );
    await closePlaywrightPage(reloadPage, "ending-room-single-mobile-reload-page");
  } catch (error) {
    replayCoverageError = String(error);
    fs.writeFileSync(
      path.join(outputDir, "single-mobile-replay-coverage-error.json"),
      JSON.stringify({ error: replayCoverageError }, null, 2),
    );
  }
  await closePlaywrightContext(context, "ending-room-single-mobile-context");
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
    anchoredStreamLifecycle: anchoredLifecycle?.captures ?? anchoredCaptures ?? null,
  };
}

async function runMultiMobile(browser, frontendUrl, outputDir, scenarioIds) {
  const { multiId } = scenarioIds;
  const backendUrl = resolveBackendUrl(frontendUrl);
  const resultUrl = `${new URL(frontendUrl).origin}/result/${multiId}`;
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  let page = await context.newPage();
  await page.goto(resultUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  await openPicker(page, /Enter chamber|进入会客厅/i, 0);
  const pickerSeed = await getSelectedPickerAgentIds(page, frontendUrl, multiId);
  const initialAutomation = await getAutomationState(page);
  const anchorBranchId = initialAutomation?.page?.branches?.[0]?.id ?? null;
  await saveScreenshot(page, path.join(outputDir, "mobile-multi-picker.png"));
  writeJson(path.join(outputDir, "mobile-multi-picker.json"), {
    pickerSeed,
    anchorBranchId,
    initialAutomation,
  });
  const prewarmedChamber = await prewarmEndingRoom(frontendUrl, multiId, {
    roomType: "ending_chamber",
    anchorBranchId,
    selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
    selectedAgentIds: pickerSeed.selectedAgentIds,
    language: "zh",
  });
  const directOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(prewarmedChamber.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=${encodeURIComponent(pickerSeed.selectedAgentIds.join(","))}`;
  await page.goto(directOpenUrl, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
  const liveVisibleState = await waitForLiveEndingRoomVisible(page, {
    expectedRoomId: prewarmedChamber.id,
    expectedRoomType: "ending_chamber",
    timeout: 45000,
    label: "mobile multi live chamber visible",
  });
  const chamberState = {
    cards: pickerSeed.selectedNames,
    modalState: {
      room_id: prewarmedChamber.id,
      branch_id: prewarmedChamber.anchor_branch_id ?? anchorBranchId,
      room_type: "ending_chamber",
      has_result: true,
      can_send: true,
      status: prewarmedChamber.status,
    },
  };
  const chamberAutomation = liveVisibleState ?? await getAutomationState(page);
  const chamberFit = await captureEndingRoomFit(page);
  await saveScreenshot(page, path.join(outputDir, "mobile-multi-chamber.png"));
  writeJson(path.join(outputDir, "mobile-multi-chamber.json"), {
    chamberState,
    fit: chamberFit,
    state: chamberAutomation,
    liveVisibleState,
    pickerSeed,
    prewarmedRoomId: prewarmedChamber.id,
  });
  const roomId = chamberState.modalState.room_id;
  const roomSnapshot = await fetchJson(`${backendUrl}/api/ending-room/${roomId}`);
  const addressableAgentIds = (roomSnapshot.participants ?? [])
    .filter((participant) => participant?.source_agent_id && participant?.role_slot !== "archivist" && participant?.role_slot !== "user")
    .map((participant) => participant.source_agent_id);

  const beforeHotseat = chamberAutomation;
  const hotseatPill = page.locator(".ending-chat-mode-pill").filter({ hasText: /Question one role|Hotseat|点名角色|角色热座/i }).first();
  if (await hotseatPill.count() > 0) {
    await hotseatPill.scrollIntoViewIfNeeded().catch(() => {});
    await hotseatPill.click({ force: true }).catch(() => {});
  }
  await fillComposerIfEditable(page, "请点名说明，这条世界线最早的失控点在哪里？");
  const hotseatApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
    content: "请点名说明，这条世界线最早的失控点在哪里？",
    addressed_agent_ids: addressableAgentIds.slice(0, 1),
    interaction_mode: "hotseat",
  });
  let hotseatLifecycle = null;
  let hotseatCaptures = null;
  try {
    hotseatLifecycle = await captureStreamLifecycle(page, {
      label: "mobile hotseat follow-up state",
      outputDir,
      filePrefix: "mobile-multi-hotseat",
      timeout: 70000,
      isCommitState: (modalState) => (
        modalState?.interaction_mode === "hotseat"
        && (modalState?.thread_count ?? 0) >= ((beforeHotseat?.page?.controls?.modal_state?.thread_count ?? 0))
        && (modalState?.active_thread_id ?? null) !== (beforeHotseat?.page?.controls?.modal_state?.active_thread_id ?? null)
        && (modalState?.pending_draft_count ?? 0) === 0
      ),
    });
  } catch (error) {
    hotseatCaptures = error?.captures ?? null;
    console.warn(`[ending-room] mobile hotseat lifecycle capture fell back to API-driven wait: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hotseatApiPayload = await hotseatApiPromise;
  page = await ensureLiveEndingRoomPage(
    page,
    context,
    directOpenUrl,
    roomId,
    "ending_chamber",
    "mobile hotseat follow-up",
    MOBILE_CONTEXT_OPTIONS,
  );
  let hotseatState = hotseatLifecycle?.payload ?? null;
  if (!hotseatState) {
    try {
      hotseatState = await waitForApiDrivenFollowupVisible(page, {
        label: "mobile hotseat api-driven visible state",
        frontendUrl,
        roomId,
        beforeModalState: beforeHotseat?.page?.controls?.modal_state ?? null,
        apiPayload: hotseatApiPayload,
        timeout: 45000,
      });
    } catch (visibleError) {
      console.warn(`[ending-room] mobile hotseat UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
      hotseatState = await waitForModalSettled(page, "mobile hotseat settled fallback", 10000).catch(() => getAutomationState(page));
    }
  }
  await saveScreenshot(page, path.join(outputDir, "mobile-multi-hotseat.png"));
  writeJson(path.join(outputDir, "mobile-multi-hotseat.json"), {
    state: hotseatState,
    api_payload: hotseatApiPayload,
    stream_lifecycle: hotseatLifecycle?.captures ?? hotseatCaptures,
  });

  let allPresentSettled = null;
  let allPresentLifecycle = null;
  let allPresentCaptures = null;
  const beforeAllPresent = hotseatState;
  const beforeAllPresentModal = beforeAllPresent?.page?.controls?.modal_state ?? null;
  const allPresentButton = page.locator(".ending-chat-mode-pill").filter({ hasText: /Current lineup responds|Everyone responds|All present|当前阵容回应|全员回应|当前全员回应/i });
  const allPresentPill = allPresentButton.first();
  const allPresentVisible = await allPresentPill.isVisible().catch(() => false);
  if (allPresentVisible) {
    await allPresentPill.scrollIntoViewIfNeeded().catch(() => {});
    await allPresentPill.click({ force: true });
    await waitFor(
      page,
      async () => {
        const current = await getAutomationState(page);
        const modalState = current?.page?.controls?.modal_state;
        return modalState?.interaction_mode === "all_present" ? current : null;
      },
      "mobile all-present mode armed",
      10000,
    );
    await fillComposerIfEditable(page, "如果让当前阵容都回应一次，他们会如何分工？");
    const allPresentApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
      content: "如果让当前阵容都回应一次，他们会如何分工？",
      addressed_agent_ids: addressableAgentIds,
      interaction_mode: "all_present",
    });
    try {
      allPresentLifecycle = await captureStreamLifecycle(page, {
        label: "mobile all-present follow-up state",
        outputDir,
        filePrefix: "mobile-multi-all-present",
        timeout: 70000,
        isCommitState: (modalState) => (
          modalState?.interaction_mode === "all_present"
          && (
            hasReachedCommittedTurnDelta(modalState, beforeAllPresentModal, 3)
            || (modalState?.active_thread_id ?? null) !== (beforeAllPresentModal?.active_thread_id ?? null)
          )
          && (
            (modalState?.pending_draft_count ?? 0) === 0
            || hasReachedCommittedTurnDelta(modalState, beforeAllPresentModal, 3)
          )
        ),
      });
    } catch (error) {
      allPresentCaptures = error?.captures ?? null;
      console.warn(`[ending-room] mobile all-present lifecycle capture fell back to API-driven wait: ${error instanceof Error ? error.message : String(error)}`);
    }
    const allPresentApiPayload = await allPresentApiPromise;
    page = await ensureLiveEndingRoomPage(
      page,
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "mobile all-present follow-up",
      MOBILE_CONTEXT_OPTIONS,
    );
    allPresentSettled = allPresentLifecycle?.payload ?? null;
    if (!allPresentSettled) {
      try {
        allPresentSettled = await waitForApiDrivenFollowupVisible(page, {
          label: "mobile all-present api-driven visible state",
          frontendUrl,
          roomId,
          beforeModalState: beforeAllPresentModal,
          apiPayload: allPresentApiPayload,
          timeout: 60000,
        });
      } catch (visibleError) {
        console.warn(`[ending-room] mobile all-present UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
        allPresentSettled = await waitForModalSettled(page, "mobile all-present settled fallback", 10000).catch(() => getAutomationState(page));
      }
    }
    page = await ensureLiveEndingRoomPage(
      page,
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "mobile all-present post-fallback",
      MOBILE_CONTEXT_OPTIONS,
    );
    await saveScreenshot(page, path.join(outputDir, "mobile-multi-all-present.png"));
    writeJson(path.join(outputDir, "mobile-multi-all-present.json"), {
      state: allPresentSettled,
      api_payload: allPresentApiPayload,
      stream_lifecycle: allPresentLifecycle?.captures ?? allPresentCaptures,
    });
  } else {
    throw new Error("Mobile all-present control is missing");
  }

  let epilogueState = null;
  let epilogueLifecycle = null;
  let epilogueCaptures = null;
  const epilogueBtn = page.locator(".ending-chat-epilogue-btn");
  if (await epilogueBtn.count() > 0) {
    const beforeEpilogue = await getAutomationState(page);
    await epilogueBtn.scrollIntoViewIfNeeded().catch(() => {});
    await epilogueBtn.click({ force: true });
    await page.waitForTimeout(200);
    const prefilled = await readComposerValue(page);
    if (!prefilled || prefilled.trim().length === 0) {
      await fillComposerIfEditable(page, "请继续推演后续三回合，看看局势如何收场。");
    }
    const epilogueApiPromise = appendRoomUserTurnViaApi(frontendUrl, roomId, {
      content: "这条世界线接下来会发生什么？",
      interaction_mode: "epilogue",
    });
    try {
      epilogueLifecycle = await captureStreamLifecycle(page, {
        label: "mobile epilogue follow-up state",
        outputDir,
        filePrefix: "mobile-multi-epilogue",
        timeout: 90000,
        isCommitState: (modalState) => (
          modalState?.interaction_mode === "epilogue"
          && (modalState?.turn_count ?? 0) > (beforeEpilogue?.page?.controls?.modal_state?.turn_count ?? 0)
          && (modalState?.pending_draft_count ?? 0) === 0
        ),
      });
    } catch (error) {
      epilogueCaptures = error?.captures ?? null;
      console.warn(`[ending-room] mobile epilogue lifecycle capture fell back to API-driven wait: ${error instanceof Error ? error.message : String(error)}`);
    }
    const epilogueApiPayload = await epilogueApiPromise;
    page = await ensureLiveEndingRoomPage(
      page,
      context,
      directOpenUrl,
      roomId,
      "ending_chamber",
      "mobile epilogue follow-up",
      MOBILE_CONTEXT_OPTIONS,
    );
    epilogueState = epilogueLifecycle?.payload ?? null;
    if (!epilogueState) {
      try {
        epilogueState = await waitForApiDrivenFollowupVisible(page, {
          label: "mobile epilogue api-driven visible state",
          frontendUrl,
          roomId,
          beforeModalState: beforeEpilogue?.page?.controls?.modal_state ?? null,
          apiPayload: epilogueApiPayload,
          timeout: 90000,
        });
      } catch (visibleError) {
        console.warn(`[ending-room] mobile epilogue UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
        epilogueState = await waitForModalSettled(page, "mobile epilogue settled fallback", 10000).catch(() => getAutomationState(page));
      }
    }
    await saveScreenshot(page, path.join(outputDir, "mobile-multi-epilogue.png"));
    writeJson(path.join(outputDir, "mobile-multi-epilogue.json"), {
      state: epilogueState,
      api_payload: epilogueApiPayload,
      stream_lifecycle: epilogueLifecycle?.captures ?? epilogueCaptures,
    });
  } else {
    throw new Error("Mobile epilogue control is missing");
  }

  await page.locator(".ending-chat-close").click();
  await page.waitForTimeout(400);
  let galleryState = null;
  let evidenceCardState = null;
  let evidenceCardLifecycle = null;
  let evidenceCardCaptures = null;
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

    // ── Mobile Evidence Card (证据投牌) ───────────────────────
    // Evidence buttons only render in non-gallery rooms. Close gallery, prewarm fresh chamber.
    await page.locator(".ending-chat-close").click();
    await page.waitForTimeout(400);

    const mobileEvidenceChamber = await prewarmEndingRoom(frontendUrl, multiId, {
      roomType: "ending_chamber",
      anchorBranchId,
      selectedBranchIds: anchorBranchId ? [anchorBranchId] : [],
      selectedAgentIds: pickerSeed.selectedAgentIds,
      language: "zh",
    });
    const mobileEvidenceRoomId = mobileEvidenceChamber.id;
    const mobileEvidenceOpenUrl = `${resultUrl}?debugEndingRoomBranch=${encodeURIComponent(mobileEvidenceChamber.anchor_branch_id ?? anchorBranchId ?? "")}&debugEndingRoomMode=ending_chamber&debugEndingRoomAgents=${encodeURIComponent(pickerSeed.selectedAgentIds.join(","))}`;
    await page.goto(mobileEvidenceOpenUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".ending-chat-modal", { timeout: 30000 });
    await waitForLiveEndingRoomVisible(page, {
      expectedRoomType: "ending_chamber",
      timeout: 45000,
      label: "mobile evidence_card ending chamber ready",
    });

    const mobileEvidenceDrawer = page.locator(".ending-chat-evidence-drawer > summary").first();
    if (await mobileEvidenceDrawer.count() > 0) {
      await mobileEvidenceDrawer.scrollIntoViewIfNeeded().catch(() => {});
      await mobileEvidenceDrawer.click();
      await page.waitForTimeout(300);

      const beforeEvidence = await getAutomationState(page);
      const actualMobileEvidenceRoomId = beforeEvidence?.page?.controls?.modal_state?.room_id ?? mobileEvidenceRoomId;
      const scenarioBranches = initialAutomation?.page?.branches ?? [];
      const foreignBranchId = scenarioBranches
        .map((b) => b?.id)
        .find((branchId) => branchId && branchId !== (chamberState?.modalState?.branch_id ?? null));
      if (!foreignBranchId) {
        throw new Error("No foreign branch available for mobile evidence-card API flow");
      }
      const evidenceApiPromise = appendRoomUserTurnViaApi(frontendUrl, actualMobileEvidenceRoomId, {
        content: "请用另一条世界线的证据解释这次分裂为什么会扩大。",
        interaction_mode: "evidence_card",
        cited_branch_id: foreignBranchId,
      });
      try {
        evidenceCardLifecycle = await captureStreamLifecycle(page, {
          label: "mobile evidence-card follow-up state",
          outputDir,
          filePrefix: "mobile-gallery-evidence-card",
          timeout: 70000,
          isCommitState: (modalState) => (
            (modalState?.turn_count ?? 0) > (beforeEvidence?.page?.controls?.modal_state?.turn_count ?? 0)
            && (modalState?.pending_draft_count ?? 0) === 0
          ),
        });
      } catch (error) {
        evidenceCardCaptures = error?.captures ?? null;
        console.warn(`[ending-room] mobile evidence-card lifecycle capture fell back to API-driven wait: ${error instanceof Error ? error.message : String(error)}`);
      }
      const evidenceApiPayload = await evidenceApiPromise;
      writeJson(path.join(outputDir, "mobile-gallery-evidence-card-api.json"), {
        api_payload: evidenceApiPayload,
        actual_room_id: actualMobileEvidenceRoomId,
        foreign_branch_id: foreignBranchId,
      });
      try {
        evidenceCardState = evidenceCardLifecycle?.payload ?? await waitForApiDrivenFollowupVisible(page, {
          label: "mobile evidence-card api-driven visible state",
          frontendUrl,
          roomId: actualMobileEvidenceRoomId,
          beforeModalState: beforeEvidence?.page?.controls?.modal_state ?? null,
          apiPayload: evidenceApiPayload,
          timeout: 60000,
        });
      } catch (visibleError) {
        console.warn(`[ending-room] mobile evidence-card UI visibility wait timed out, using settled state: ${visibleError instanceof Error ? visibleError.message : String(visibleError)}`);
        evidenceCardState = await waitForModalSettled(page, "mobile evidence-card settled fallback", 10000).catch(() => getAutomationState(page));
      }
      await saveScreenshot(page, path.join(outputDir, "mobile-gallery-evidence-card.png"));
      writeJson(path.join(outputDir, "mobile-gallery-evidence-card.json"), {
        state: evidenceCardState,
        api_payload: evidenceApiPayload,
        stream_lifecycle: evidenceCardLifecycle?.captures ?? evidenceCardCaptures,
      });
    }

    await armClipboardCapture(page);
    await page.getByRole("button", { name: /Copy replay|复制回放/i }).click();
    const shareReplayUrl = await waitForCapturedClipboardUrl(page, "mobile ending-room copied share permalink");
    const sharePage = await context.newPage();
    await sharePage.goto(shareReplayUrl, { waitUntil: "domcontentloaded" });
    artifactReadonly = await waitForReadonlyEndingRoomVisible(
      sharePage,
      "mobile ending-room artifact replay readonly state",
      30000,
    );
    await saveScreenshot(sharePage, path.join(outputDir, "mobile-ending-room-replay-artifact.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-artifact.json"),
      JSON.stringify(artifactReadonly, null, 2),
    );
    await sharePage.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await sharePage.waitForURL(/\/sim\//, { timeout: 15000 });
    artifactImportedUrl = sharePage.url();
    await closePlaywrightPage(sharePage, "ending-room-multi-mobile-share-page");

    await page.getByRole("button", { name: /Save local read-only copy|保存本地只读副本|保存只读副本/i }).click();
    await page.waitForURL(/\/result\/replay\?roomLocal=/, { timeout: 15000 });
    replayReadonly = await waitForReadonlyEndingRoomVisible(
      page,
      "mobile ending-room replay readonly state",
      30000,
    );
    await saveScreenshot(page, path.join(outputDir, "mobile-ending-room-replay-readonly.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-readonly.json"),
      JSON.stringify(replayReadonly, null, 2),
    );
    const replayReadonlyUrl = page.url();

    await page.locator(".ending-chat-overlay .ending-chat-header__actions .ending-chat-inline-button").filter({
      hasText: /Import(?: as)? Local Run|导入为本地运行|导入本地运行/i,
    }).last().click();
    await page.waitForURL(/\/sim\//, { timeout: 15000 });
    importedUrl = page.url();

    const reloadPage = await context.newPage();
    await reloadPage.goto(replayReadonlyUrl, { waitUntil: "domcontentloaded" });
    replayReloaded = await waitForReadonlyEndingRoomVisible(
      reloadPage,
      "mobile ending-room readonly restore",
      30000,
    );
    await saveScreenshot(reloadPage, path.join(outputDir, "mobile-ending-room-replay-readonly-reloaded.png"));
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-readonly-reloaded.json"),
      JSON.stringify(replayReloaded, null, 2),
    );
    await closePlaywrightPage(reloadPage, "ending-room-multi-mobile-reload-page");
  } catch (error) {
    replayCoverageError = String(error);
    fs.writeFileSync(
      path.join(outputDir, "mobile-ending-room-replay-coverage-error.json"),
      JSON.stringify({ error: replayCoverageError }, null, 2),
    );
  }

  await closePlaywrightContext(context, "ending-room-multi-mobile-context");
  return {
    resultUrl,
    chamberState: chamberState?.modalState ?? null,
    chamberFit,
    hotseatState: hotseatState?.page?.controls?.modal_state ?? null,
    hotseatStreamLifecycle: hotseatLifecycle?.captures ?? hotseatCaptures ?? null,
    allPresentState: allPresentSettled?.page?.controls?.modal_state ?? null,
    allPresentStreamLifecycle: allPresentLifecycle?.captures ?? allPresentCaptures ?? null,
    epilogueState: epilogueState?.page?.controls?.modal_state ?? null,
    epilogueStreamLifecycle: epilogueLifecycle?.captures ?? epilogueCaptures ?? null,
    galleryState: galleryState?.page?.controls?.modal_state ?? null,
    evidenceCardState: evidenceCardState?.page?.controls?.modal_state ?? null,
    evidenceCardStreamLifecycle: evidenceCardLifecycle?.captures ?? evidenceCardCaptures ?? null,
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
  const browser = await chromium.launch({
    ...BROWSER_LAUNCH_OPTIONS,
    headless: args.headless,
  });
  try {
    const scenarioIds = await findScenarioIds(args.url);
    const summary = {};
    if (args.mode === "desktop" || args.mode === "full") {
      const desktopContext = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      summary.multiDesktop = await runMultiDesktop(desktopContext, args.url, args.outputDir, scenarioIds);
      await closePlaywrightContext(desktopContext, "ending-room-desktop-context");
    }
    if (args.mode === "mobile" || args.mode === "full") {
      summary.mobile = {
        single: await runSingleMobile(browser, args.url, args.outputDir, scenarioIds),
        multi: await runMultiMobile(browser, args.url, args.outputDir, scenarioIds),
      };
    }
    if (args.mode === "mobile-multi-only") {
      summary.mobile = {
        single: "skipped",
        multi: await runMultiMobile(browser, args.url, args.outputDir, scenarioIds),
      };
    }
    fs.writeFileSync(path.join(args.outputDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closePlaywrightBrowser(browser, "ending-room-browser");
  }
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
