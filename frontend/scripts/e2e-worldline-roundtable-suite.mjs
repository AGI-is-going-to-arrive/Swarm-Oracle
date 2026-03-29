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
  for (const item of payload.scenarios ?? []) {
    const scenario = await getScenario(backendUrl, item.id);
    if ((scenario.branches?.length ?? 0) >= 2) {
      return scenario.id;
    }
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

async function sendComposer(page, prompt, modeText) {
  await page.getByRole("button", { name: modeText }).click();
  const before = await readAutomation(page);
  const beforeTurns = before?.simulation?.messageCount ?? 0;
  const beforeThreadCount = before?.page?.controls?.thread_count ?? 0;
  const beforeActiveThreadId = before?.page?.controls?.active_thread_id ?? null;
  await page.locator(".ending-chat-composer__input").fill(prompt);
  await page.locator(".ending-chat-send").click();
  return waitForAutomation(
    page,
    (payload) => (
      (payload.simulation?.messageCount ?? 0) > beforeTurns
      || (payload.page?.controls?.thread_count ?? 0) > beforeThreadCount
      || (payload.page?.controls?.active_thread_id ?? null) !== beforeActiveThreadId
    ),
    15000,
    `composer send ${modeText}`,
  );
}

async function reseatRoundtable(page) {
  const before = await readAutomation(page);
  const previousRoomId = before?.scene?.room_id ?? null;
  await page.getByRole("button", { name: /Reseat and reopen|改选代表并重开/i }).first().click();
  await page.waitForSelector(".worldline-roundtable-card--picker", { timeout: 15000 });

  const firstAlternative = page
    .locator(".worldline-roundtable-picker-branch")
    .first()
    .locator(".worldline-roundtable-picker-card:not(.is-selected)")
    .first();
  const nextRepresentative = (await firstAlternative.locator("strong").innerText()).trim();
  await firstAlternative.click();
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
  };
}

async function runDesktop(context, baseUrl, backendUrl, outputDir) {
  const page = await context.newPage();
  const scenarioId = await findMultiEndingScenarioId(backendUrl);
  const ready = await openRoundtable(page, baseUrl, scenarioId);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-ready.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-ready.json"), ready);

  const reseated = await reseatRoundtable(page);
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-reseated.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-reseated.json"), reseated);

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
  );
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-hotseat.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-hotseat.json"), hotseat);

  await page.getByRole("button", { name: /Save(?:d)? (local )?read-only copy|Read-only copy saved|保存本地只读副本|已保存本地只读副本|保存只读副本|只读副本已保存/i }).click();
  await page.waitForURL(/\/roundtable\/replay\?roomLocal=/, { timeout: 15000 });
  const replayReadonly = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "worldline_roundtable"
      && payload.page?.controls?.is_read_only === true
      && payload.page?.controls?.can_send === false,
    15000,
    "roundtable replay readonly state",
  );
  await saveScreenshot(page, path.join(outputDir, "desktop-roundtable-replay-readonly.png"));
  writeJson(path.join(outputDir, "desktop-roundtable-replay-readonly.json"), replayReadonly);

  return {
    scenarioId,
    ready,
    reseated,
    archivist,
    hotseat,
    replayReadonly,
  };
}

async function runMobile(browser, baseUrl, backendUrl, outputDir) {
  const scenarioId = await findMultiEndingScenarioId(backendUrl);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const ready = await openRoundtable(page, baseUrl, scenarioId);
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
  await saveScreenshot(page, path.join(outputDir, "mobile-roundtable-ready.png"));
  writeJson(path.join(outputDir, "mobile-roundtable-ready.json"), { ready, fit });
  await context.close();
  return { scenarioId, ready, fit };
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-worldline-roundtable`);
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless);
  try {
    const summary = {};
    if (args.mode === "desktop" || args.mode === "full") {
      const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
      summary.desktop = await runDesktop(context, args.baseUrl, args.backendUrl, outputDir);
      await context.close();
    }
    if (args.mode === "mobile" || args.mode === "full") {
      summary.mobile = await runMobile(browser, args.baseUrl, args.backendUrl, outputDir);
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
