import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_PROVIDER = process.env.SWARM_WEB_SEARCH_PROVIDER || "tavily";
const DEFAULT_API_KEY = process.env.SWARM_WEB_SEARCH_API_KEY || "web-search-e2e-dummy-key";
const DEFAULT_QUESTION = process.env.SWARM_WEB_SEARCH_QUESTION || "What happens if Melbourne bans all private cars for one year?";

function resolveFrontendPath(inputPath) {
  if (!inputPath) return inputPath;
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

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    question: DEFAULT_QUESTION,
    provider: DEFAULT_PROVIDER,
    apiKey: DEFAULT_API_KEY,
    baseUrlOverride: "",
    outputDir: "",
    headless: process.env.HEADLESS === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--question" && next) {
      args.question = next;
      i += 1;
    } else if (arg === "--provider" && next) {
      args.provider = next;
      i += 1;
    } else if (arg === "--api-key" && next) {
      args.apiKey = next;
      i += 1;
    } else if (arg === "--base-url" && next) {
      args.baseUrlOverride = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  return args;
}

function defaultProviderBaseUrl(provider) {
  switch (provider) {
    case "exa":
      return "https://api.exa.ai/search";
    case "xai":
      return "https://api.x.ai/v1/responses";
    case "searxng":
      return "http://localhost:8888";
    case "tavily":
    default:
      return "https://api.tavily.com/search";
  }
}

async function launchBrowser(headless) {
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return await chromium.launch({ headless });
  }
}

async function waitForAutomation(page, predicate, timeout = 30000, label = "automation state") {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const raw = await page.evaluate(() => window.render_game_to_text?.() ?? null);
    if (raw) {
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (predicate(payload)) return payload;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function runWebSearchFlow(args) {
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `web-search-${timestampLabel()}`);
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1180 } });
  const page = await context.newPage();
  let capturedScenarioRequest = null;

  try {
    const resolvedBaseUrl = args.baseUrlOverride || defaultProviderBaseUrl(args.provider);
    await page.route("**/api/scenario", async (route) => {
      const request = route.request();
      try {
        capturedScenarioRequest = request.postDataJSON();
      } catch {
        capturedScenarioRequest = null;
      }
      await route.continue();
    });

    await page.goto(`${args.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await waitForAutomation(page, (payload) => payload.page?.kind === "input", 10000, "input page");

    await page.locator("textarea.input--hero").fill(args.question);
    await page.getByLabel(/搜索增强推演|Search-Augmented Simulation/i).check();
    await page.getByRole("button", { name: /自定义覆盖|Custom override/i }).click();
    await page.locator("#web-search-provider").selectOption(args.provider);
    await page.locator("#web-search-api-key").fill(args.apiKey);
    await page.locator("#web-search-base-url").fill(resolvedBaseUrl);

    await page.screenshot({ path: path.join(outputDir, "web-search-custom-before-submit.png"), type: "png" });

    const submitButton = page.getByRole("button", { name: /开始推演|Start Simulation/i });
    await submitButton.click();

    await page.waitForFunction(() => {
      return Boolean(document.querySelector(".loading-overlay")) || /\/sim\//.test(window.location.pathname);
    }, { timeout: 10000 });

    await page.waitForURL(/\/sim\//, { timeout: 45000 });
    const simulationPayload = await waitForAutomation(
      page,
      (payload) => payload.page?.kind === "simulation",
      15000,
      "simulation page",
    );

    if (!capturedScenarioRequest) {
      throw new Error("Scenario request payload was not captured during E2E run");
    }
    if (capturedScenarioRequest.web_search_enabled !== true) {
      throw new Error(`Expected web_search_enabled=true, got ${capturedScenarioRequest.web_search_enabled}`);
    }
    if (capturedScenarioRequest.web_search_provider !== args.provider) {
      throw new Error(`Expected web_search_provider=${args.provider}, got ${capturedScenarioRequest.web_search_provider}`);
    }
    if (capturedScenarioRequest.web_search_api_key !== args.apiKey) {
      throw new Error("Captured scenario request did not include the expected web_search_api_key");
    }
    if (capturedScenarioRequest.web_search_base_url !== resolvedBaseUrl) {
      throw new Error(`Expected web_search_base_url=${resolvedBaseUrl}, got ${capturedScenarioRequest.web_search_base_url}`);
    }

    await page.screenshot({ path: path.join(outputDir, "web-search-custom-simulation.png"), type: "png" });

    const summary = {
      mode: "web-search",
      provider: args.provider,
      baseUrl: resolvedBaseUrl,
      question: args.question,
      finalUrl: page.url(),
      simulationStatus: simulationPayload?.scenario?.status ?? simulationPayload?.scenario?.phase ?? "unknown",
      capturedScenarioRequest,
      outputDir,
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

runWebSearchFlow(parseArgs(process.argv)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
