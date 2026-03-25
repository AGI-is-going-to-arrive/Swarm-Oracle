import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_QUESTION = "如果互联网从未被发明？";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");

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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function saveScreenshot(page, filePath) {
  await page.screenshot({ path: filePath, type: "png" });
}

function parseArgs(argv) {
  const args = {
    mode: argv[2] || "",
    baseUrl: DEFAULT_BASE_URL,
    scenarioId: "",
    question: DEFAULT_QUESTION,
    headless: process.env.HEADLESS === "1",
    outputDir: "",
  };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--scenario-id" && next) {
      args.scenarioId = next;
      i += 1;
    } else if (arg === "--question" && next) {
      args.question = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["predict", "result", "health"].includes(args.mode)) {
    throw new Error("Usage: node scripts/e2e-automation.mjs <predict|result|health> [--url URL] [--scenario-id ID] [--question TEXT] [--output-dir DIR] [--headless]");
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

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((el, nextValue) => {
    el.value = String(nextValue);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function createScenario(page, { baseUrl, question, theater = false }) {
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await waitForAutomation(page, (payload) => payload.page?.kind === "input", 10000, "input page");

  await page.locator("textarea.input--hero").fill(question);
  await setRangeValue(page, "input.rounds-slider", 3);
  await setRangeValue(page, "input.agents-slider", 3);

  if (theater) {
    await page.getByRole("button", { name: /像素剧场|Pixel Theater/ }).click();
  }

  await page.getByRole("button", { name: /开始推演|submit/i }).click();
  await page.waitForFunction(() => {
    const href = window.location.href;
    if (/\/sim\//.test(href)) return true;

    if (typeof window.render_game_to_text !== "function") return false;
    try {
      const payload = JSON.parse(window.render_game_to_text());
      return payload?.page?.kind === "simulation";
    } catch {
      return false;
    }
  }, { timeout: 45000 });

  if (!/\/sim\//.test(page.url())) {
    await page.waitForURL(/\/sim\//, { timeout: 10000 });
  }
  return page.url().split("/").pop();
}

async function pickDoneScenarioFromHistory(page, baseUrl) {
  await page.goto(`${baseUrl}/history`, { waitUntil: "domcontentloaded" });
  const payload = await waitForAutomation(page, (state) => state.page?.kind === "history" && !state.page?.loading, 10000, "history page");
  const done = (payload.page?.scenarios || []).find((scenario) => scenario.status === "done");
  if (!done) throw new Error("No DONE scenario found on the first history page");
  return done.id;
}

async function runPredictFlow(page, args) {
  const artifactDir = args.outputDir;
  const scenarioId = await createScenario(page, {
    baseUrl: args.baseUrl,
    question: args.question,
    theater: false,
  });

  await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation",
    15000,
    "simulation page",
  );

  const predictButton = page.getByRole("button", { name: /预测|predict/i });
  await predictButton.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.some((button) => {
      const text = button.textContent?.trim() ?? "";
      return /预测|predict/i.test(text) && !button.hasAttribute("disabled");
    });
  }, { timeout: 30000 });

  const simPayload = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "simulation" && payload.page?.controls?.can_open_prediction,
    30000,
    "simulation page with prediction button",
  );

  await predictButton.click();

  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "prediction",
    10000,
    "prediction modal",
  );

  await page.locator("textarea.pred-textarea").fill("自动化脚本预测：区域性强国会更稳固，全球协作会更慢。");
  await page.locator("input.pred-input").fill("E2E Bot");
  await page.locator("input.pred-slider").evaluate((el) => {
    el.value = "0.7";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const modalFilled = await readAutomation(page);
  writeJson(path.join(artifactDir, "predict-modal-filled.json"), modalFilled);
  await saveScreenshot(page, path.join(artifactDir, "predict-modal-filled.png"));

  await page.getByRole("button", { name: /提交预测|submit/i }).click();

  const submitted = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "prediction" && payload.page?.controls?.modal_state?.status === "success",
    10000,
    "prediction success",
  );
  writeJson(path.join(artifactDir, "predict-submitted.json"), submitted);
  await saveScreenshot(page, path.join(artifactDir, "predict-submitted.png"));

  return {
    mode: "predict",
    scenarioId,
    beforeSubmit: modalFilled?.page?.controls?.modal_state ?? null,
    afterSubmit: submitted?.page?.controls?.modal_state ?? null,
    canOpenPrediction: simPayload?.page?.controls?.can_open_prediction ?? false,
  };
}

async function runResultFlow(page, args) {
  const artifactDir = args.outputDir;
  const scenarioId = args.scenarioId || await pickDoneScenarioFromHistory(page, args.baseUrl);

  await page.goto(`${args.baseUrl}/result/${scenarioId}`, { waitUntil: "domcontentloaded" });
  const initial = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "result" && payload.page?.loading === false,
    10000,
    "result page",
  );
  writeJson(path.join(artifactDir, "result-initial.json"), initial);
  await saveScreenshot(page, path.join(artifactDir, "result-initial.png"));

  if ((initial?.page?.branches || []).some((branch) => branch.can_expand_story)) {
    const expandButton = page.locator("button.expand-btn").first();
    if (await expandButton.count()) {
      await expandButton.click();
    }
  }

  if (initial?.page?.controls?.can_export_markdown) {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /导出 Markdown|export/i }).click();
    const download = await downloadPromise;
    await download.cancel().catch(() => {});
  }

  await page.getByRole("button", { name: /生成文案|share/i }).click();
  await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "share",
    10000,
    "share modal",
  );
  writeJson(path.join(artifactDir, "share-modal-open.json"), await readAutomation(page));
  await saveScreenshot(page, path.join(artifactDir, "share-modal-open.png"));

  await page.getByRole("button", { name: /小红书|xiaohongshu/i }).click();
  const generated = await waitForAutomation(
    page,
    (payload) => payload.page?.controls?.active_modal === "share" && payload.page?.controls?.modal_state?.loading === false,
    30000,
    "share generation",
  );
  writeJson(path.join(artifactDir, "share-generated.json"), generated);
  await saveScreenshot(page, path.join(artifactDir, "share-generated.png"));

  if (generated?.page?.controls?.modal_state?.has_copy) {
    const copyButton = page.locator(".share-copy-btn");
    if (await copyButton.count()) {
      await copyButton.first().click();
    }
  }

  const finalPayload = await readAutomation(page);
  writeJson(path.join(artifactDir, "result-final.json"), finalPayload);
  await saveScreenshot(page, path.join(artifactDir, "result-final.png"));
  return {
    mode: "result",
    scenarioId,
    branchTitles: finalPayload?.page?.branch_titles ?? [],
    controls: finalPayload?.page?.controls ?? null,
  };
}

async function runHealthFlow(page, args) {
  const artifactDir = args.outputDir;
  await page.goto(`${args.baseUrl}/history`, { waitUntil: "domcontentloaded" });
  const history = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "history" && payload.page?.loading === false,
    10000,
    "history summary",
  );
  writeJson(path.join(artifactDir, "history.json"), history);
  await saveScreenshot(page, path.join(artifactDir, "history.png"));

  await page.goto(`${args.baseUrl}/leaderboard`, { waitUntil: "domcontentloaded" });
  const leaderboard = await waitForAutomation(
    page,
    (payload) => payload.page?.kind === "leaderboard" && payload.page?.loading === false,
    10000,
    "leaderboard summary",
  );
  writeJson(path.join(artifactDir, "leaderboard.json"), leaderboard);
  await saveScreenshot(page, path.join(artifactDir, "leaderboard.png"));

  return {
    mode: "health",
    history: history?.page ?? null,
    leaderboard: leaderboard?.page ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-${args.mode}`);
  ensureDir(outputDir);
  args.outputDir = outputDir;
  const browser = await launchBrowser(args.headless);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    let result;
    if (args.mode === "predict") {
      result = await runPredictFlow(page, args);
    } else if (args.mode === "result") {
      result = await runResultFlow(page, args);
    } else {
      result = await runHealthFlow(page, args);
    }

    writeJson(path.join(outputDir, "result.json"), result);
    console.log(JSON.stringify(result, null, 2));
    console.log(`artifacts: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
