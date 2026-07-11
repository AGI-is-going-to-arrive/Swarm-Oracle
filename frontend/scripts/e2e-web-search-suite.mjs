import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { closePlaywrightBrowser } from "./playwrightTeardown.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_PROVIDER = process.env.SWARM_WEB_SEARCH_PROVIDER || "tavily";
const DEFAULT_API_KEY = process.env.SWARM_WEB_SEARCH_API_KEY || "web-search-e2e-dummy-key";
const INTENSITY_VALUES = new Set(["light", "standard", "deep"]);
const DEFAULT_INTENSITY = normalizeWebSearchIntensity(process.env.SWARM_WEB_SEARCH_INTENSITY || "standard");
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

const SENSITIVE_KEY_FIELDS = new Set([
  "web_search_api_key",
  "api_key",
  "apiKey",
  "llm_api_key",
  "llmApiKey",
]);

function redactSensitiveValue(value) {
  if (typeof value !== "string" || value.length === 0) return "[REDACTED]";
  if (value.length <= 4) return "[REDACTED]";
  return `***${value.slice(-4)}`;
}

function redactScenarioRequest(payload) {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map((item) => redactScenarioRequest(item));
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (SENSITIVE_KEY_FIELDS.has(key)) {
      out[key] = redactSensitiveValue(value);
    } else if (value && typeof value === "object") {
      out[key] = redactScenarioRequest(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeWebSearchIntensity(value) {
  const normalized = String(value || "standard").trim().toLowerCase();
  if (!INTENSITY_VALUES.has(normalized)) {
    throw new Error(`Unsupported web search intensity: ${value}`);
  }
  return normalized;
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    question: DEFAULT_QUESTION,
    provider: DEFAULT_PROVIDER,
    apiKey: DEFAULT_API_KEY,
    baseUrlOverride: "",
    intensity: DEFAULT_INTENSITY,
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
    } else if (arg === "--intensity" && next) {
      args.intensity = normalizeWebSearchIntensity(next);
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
    case "firecrawl":
      return "https://api.firecrawl.dev/v2/search";
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

function attachPageIssueMonitor(page) {
  const issues = [];
  page.on("pageerror", (error) => {
    issues.push({ type: "pageerror", message: error.message });
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    if (failure === "cancelled" && /\/fonts\/.*\.woff2(?:\?.*)?$/u.test(request.url())) {
      return;
    }
    if (failure === "net::ERR_ABORTED" && /\/api\/campaign\/profile\//u.test(request.url())) {
      return;
    }
    issues.push({ type: "requestfailed", url: request.url(), failure });
  });
  return issues;
}

async function confirmLaunchIfPresent(page) {
  const dialog = page.locator('[role="alertdialog"], [role="dialog"]')
    .filter({ hasText: /Confirm Simulation Launch|确认推演|确认|Launch/i })
    .first();
  try {
    await dialog.waitFor({ state: "visible", timeout: 2000 });
  } catch {
    return false;
  }
  await dialog.getByRole("button", { name: /开始推演|Start Simulation/i }).click();
  return true;
}

async function dismissWelcomeDialogIfPresent(page) {
  const dialog = page.getByRole("dialog").first();
  try {
    await dialog.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    return false;
  }
  const dismissButton = dialog.locator("button").filter({ hasText: /Skip|跳过|Close|关闭/i }).first();
  if ((await dismissButton.count()) === 0) return false;
  await dismissButton.click();
  await dialog.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  return true;
}

async function setRangeValue(page, selector, value) {
  const locator = page.locator(selector);
  if (await locator.count() === 0) return false;
  await locator.evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  return true;
}

async function runWebSearchFlow(args) {
  const outputDir = args.outputDir || path.join(DEFAULT_OUTPUT_ROOT, `web-search-${timestampLabel()}`);
  ensureDir(outputDir);

  let capturedScenarioRequest = null;
  const browser = await launchBrowser(args.headless);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1180 } });
    const page = await context.newPage();
    const browserIssues = attachPageIssueMonitor(page);

    const resolvedBaseUrl = args.baseUrlOverride || defaultProviderBaseUrl(args.provider);
    await page.route("**/api/agents/identities/preflight", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needs_confirmation: false,
          matches: [],
          summary: {
            agent_count: 0,
            exact_match_count: 0,
            candidate_count: 0,
            new_identity_count: 0,
          },
        }),
      });
    });
    await page.route("**/api/scenario", async (route) => {
      const request = route.request();
      try {
        capturedScenarioRequest = request.postDataJSON();
      } catch {
        capturedScenarioRequest = null;
      }
      const minimizedPayload = capturedScenarioRequest && typeof capturedScenarioRequest === "object"
        ? {
            ...capturedScenarioRequest,
            rounds: 1,
            num_agents: 3,
            web_search_enabled: false,
            web_search_families: undefined,
            web_search_provider: undefined,
            web_search_api_key: undefined,
            web_search_base_url: undefined,
            web_search_intensity: undefined,
          }
        : capturedScenarioRequest;
      await route.continue({
        headers: {
          ...request.headers(),
          "content-type": "application/json",
        },
        postData: JSON.stringify(minimizedPayload),
      });
    });

    await page.goto(`${args.baseUrl}/`, { waitUntil: "domcontentloaded" });
    await dismissWelcomeDialogIfPresent(page);
    await waitForAutomation(page, (payload) => payload.page?.kind === "input", 10000, "input page");
    await dismissWelcomeDialogIfPresent(page);

    await page.locator("textarea.input--hero").fill(args.question);
    await setRangeValue(page, "input.rounds-slider", 3);
    await setRangeValue(page, "input.agents-slider", 3);
    await page.getByLabel(/搜索增强推演|Search-Augmented Simulation/i).check();
    const advancedTrigger = page.locator(".iv-advanced__trigger").first();
    if ((await advancedTrigger.count()) > 0 && (await advancedTrigger.getAttribute("aria-expanded")) !== "true") {
      await advancedTrigger.click();
    }
    await page.getByTestId(`web-search-intensity-${args.intensity}`).click();
    const changeProviderButton = page
      .getByRole("button", { name: /Use my provider for this run|本轮改用我的搜索服务/i })
      .first();
    if ((await changeProviderButton.count()) > 0 && (await changeProviderButton.isVisible())) {
      await changeProviderButton.click();
    } else {
      await page.locator(".web-search-mode-switch .web-search-mode-btn").nth(1).click();
    }
    await page.locator("#web-search-provider").waitFor({ state: "visible" });
    await page.locator("#web-search-provider").selectOption(args.provider);

    const apiKeyInput = page.locator("#web-search-api-key");
    if ((await apiKeyInput.count()) > 0 && await apiKeyInput.isVisible()) {
      await apiKeyInput.fill(args.apiKey);
    }

    const baseUrlInput = page.locator("#web-search-base-url");
    if ((await baseUrlInput.count()) === 0 || !(await baseUrlInput.isVisible())) {
      await page.locator(".web-search-secondary-btn--inline").first().click();
    }
    await page.locator("#web-search-base-url").fill(resolvedBaseUrl);

    const submitButton = page.getByRole("button", { name: /开始推演|Start Simulation/i });
    await submitButton.click();
    await confirmLaunchIfPresent(page);

    await page.waitForFunction(() => {
      return Boolean(document.querySelector(".loading-overlay")) || /\/sim\//.test(window.location.pathname);
    }, { timeout: 10000 });

    await page.waitForFunction(() => /\/sim\//.test(window.location.pathname), { timeout: 90000 });
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
    if (args.provider === "searxng") {
      if (capturedScenarioRequest.web_search_api_key) {
        throw new Error("SearXNG scenario request unexpectedly included web_search_api_key");
      }
    } else if (capturedScenarioRequest.web_search_api_key !== args.apiKey) {
      throw new Error("Captured scenario request did not include the expected web_search_api_key");
    }
    if (capturedScenarioRequest.web_search_base_url !== resolvedBaseUrl) {
      throw new Error(`Expected web_search_base_url=${resolvedBaseUrl}, got ${capturedScenarioRequest.web_search_base_url}`);
    }
    if (capturedScenarioRequest.web_search_intensity !== args.intensity) {
      throw new Error(`Expected web_search_intensity=${args.intensity}, got ${capturedScenarioRequest.web_search_intensity}`);
    }

    await page.screenshot({ path: path.join(outputDir, "web-search-custom-simulation.png"), type: "png" });

    const summary = {
      mode: "web-search",
      provider: args.provider,
      intensity: args.intensity,
      baseUrl: resolvedBaseUrl,
      question: args.question,
      finalUrl: page.url(),
      simulationStatus: simulationPayload?.scenario?.status ?? simulationPayload?.scenario?.phase ?? "unknown",
      capturedScenarioRequest: redactScenarioRequest(capturedScenarioRequest),
      browserIssues,
      outputDir,
    };
    writeJson(path.join(outputDir, "summary.json"), summary);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await closePlaywrightBrowser(browser, "e2e-web-search-suite");
  }
}

export const __test__ = {
  defaultProviderBaseUrl,
  parseArgs,
  redactScenarioRequest,
  redactSensitiveValue,
  resolveFrontendPath,
};

if (IS_MAIN_MODULE) {
  runWebSearchFlow(parseArgs(process.argv)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
