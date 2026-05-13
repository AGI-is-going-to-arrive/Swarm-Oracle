#!/usr/bin/env node
/**
 * QA-2 — Tier 1 live E2E: New Source Ingestion (FE-5 + BE-5)
 *
 * Validates current runtime source families (`polymarket` / `finance` /
 * `academic` / `news_deep`) through real DOM contracts:
 * - InputView renders 4 source toggles and they are interactive
 * - submit navigates to SimulationView successfully
 * - ResultView renders the current source surface on `/result/:id`
 * - ResultView exposes web-search snippets from `web_search_context`
 * - Polymarket non-US capability renders the geo-gated placeholder
 * - GlobalOfflineBanner appears on offline transition and hides on reconnect
 *
 * Uses page.route() fixtures by default. Set SWARM_E2E_MODE=live to talk
 * to a real backend.
 *
 * Live mode supports optional custom web-search overrides via:
 * - SWARM_E2E_WEB_SEARCH_PROVIDER
 * - SWARM_E2E_WEB_SEARCH_API_KEY
 * - SWARM_E2E_WEB_SEARCH_BASE_URL
 *
 * Run:
 *   node scripts/e2e-new-source-ingestion-live.mjs [desktop|mobile|full]
 *        [--url URL] [--browser chromium|firefox|webkit] [--headless]
 *        [--output-dir DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const LIVE_MODE = process.env.SWARM_E2E_MODE === "live";
const LIVE_WEB_SEARCH_PROVIDER = process.env.SWARM_E2E_WEB_SEARCH_PROVIDER || "";
const LIVE_WEB_SEARCH_API_KEY = process.env.SWARM_E2E_WEB_SEARCH_API_KEY || "";
const LIVE_WEB_SEARCH_BASE_URL = process.env.SWARM_E2E_WEB_SEARCH_BASE_URL || "";

const FIXTURE_SCENARIO_ID = "sc-e2e-sources";
const FIXTURE_QUESTION = "How should live source contracts surface in the UI?";
const SOURCE_FAMILIES = ["polymarket", "finance", "academic", "news_deep"];
const ACCEPTED_LIVE_SOURCE_STATES = new Set([
  "ready",
  "empty",
  "failed",
  "search_skipped",
  "unsupported_provider",
  "fallback_unconstrained",
]);
const WEB_SNIPPET_TEXT = "Live source snippet for ResultView";
const WEB_SNIPPET_URL = "https://news.example/live-source";

const CAPABILITIES_FIXTURE = {
  web_search: {
    enabled: true,
    providers: {
      polymarket: { enabled: true, degraded: false, configured_host: "us" },
      finance: { enabled: true, degraded: false },
      academic: { enabled: true, degraded: false },
      news_deep: { enabled: true, degraded: false },
    },
  },
  kg_explorer: { enabled: false },
  agent_conversation: { enabled: true },
  replay_trace: { enabled: false },
  causal_graph: { enabled: true },
  factions: { enabled: true },
  argument_map: { enabled: false },
  custom_agents: { enabled: false },
  agent_identity: { enabled: false },
  counterfactual_replay: { enabled: false },
};

const NON_US_CAPABILITIES_FIXTURE = {
  ...CAPABILITIES_FIXTURE,
  web_search: {
    ...CAPABILITIES_FIXTURE.web_search,
    providers: {
      ...CAPABILITIES_FIXTURE.web_search.providers,
      polymarket: { enabled: true, degraded: true, configured_host: "non-us" },
    },
  },
};

const WEB_CONTEXT_FIXTURE = {
  polymarket: [{ market: "m-1", title: "Market", probability: 0.55, configured_host: "us" }],
  finance: [{ id: "fin-1", title: "Fed minutes priced in", url: "https://finance.example/a" }],
  academic: [{ id: "paper-1", title: "Forecasting under uncertainty", url: "https://academic.example/a" }],
  news_deep: [{ title: "news-1", url: WEB_SNIPPET_URL, snippet: WEB_SNIPPET_TEXT }],
};

const SCENARIO_FIXTURE = {
  id: FIXTURE_SCENARIO_ID,
  question: FIXTURE_QUESTION,
  status: "done",
  created_at: "2026-04-19T00:00:00Z",
  scene_theme: "law_court",
  agents: [],
  branches: [],
  messages: [
    {
      id: "message-1",
      agent: "Archivist",
      agent_id: "agent-1",
      message: "Sources are visible and ready for audit.",
      emotion: "calm",
      branch: "branch-1",
      round: 1,
    },
  ],
  groups: [],
  hierarchical: false,
  director_state: {
    objectives: {
      generated_for_question: null,
      generated_for_profile: null,
      goals: [],
      last_updated_at: null,
    },
    commitment: {
      active: false,
      branch_id: null,
      branch_title: null,
      committed_at_round: null,
      committed_at: null,
      outcome: null,
    },
  },
  gameplay_state: null,
  web_search_context: {
    query: "live source audit",
    provider: "news_deep",
    cached: false,
    snippets: [{ text: WEB_SNIPPET_TEXT, source_url: WEB_SNIPPET_URL }],
    family_context: {
      polymarket: {
        state: "ready",
        configured_host: "us",
        items: [
          {
            id: "pm-1",
            question: "Will live source cards render?",
            url: "https://polymarket.example/contract",
          },
        ],
      },
      finance: {
        state: "ready",
        items: [
          {
            id: "fin-1",
            title: "Macro indicators reprice quickly",
            summary: "Live finance card content.",
            source: "finance.example",
            url: "https://finance.example/card",
          },
        ],
      },
      academic: {
        state: "ready",
        items: [
          {
            id: "paper-1",
            title: "Forecasting under uncertainty",
            abstract: "Live academic card content.",
            url: "https://academic.example/paper",
          },
        ],
      },
      news_deep: {
        state: "ready",
        items: [
          {
            id: "news-1",
            title: "Live source family coverage verified",
            description: WEB_SNIPPET_TEXT,
            source: "news.example",
            url: WEB_SNIPPET_URL,
          },
        ],
      },
    },
  },
};

const STORY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  question: FIXTURE_QUESTION,
  status: "done",
  branches: [
    {
      id: "branch-1",
      title: "Audit Branch",
      probability: 1,
      status: "COMPLETED",
      story: "A single deterministic branch for source-surface validation.",
      insight: "Source cards should reflect capability truth.",
      key_moments: ["Source grid rendered"],
      parent_branch_id: null,
      fork_reason: "",
    },
  ],
};

const AGENTS_FIXTURE = [
  {
    id: "agent-1",
    name: "Archivist",
    role: "Recorder",
    tier: "CORE",
    emotion: "calm",
    agent_identity_id: "identity-archivist",
  },
];

const NON_US_SCENARIO_FIXTURE = {
  ...SCENARIO_FIXTURE,
  web_search_context: {
    ...SCENARIO_FIXTURE.web_search_context,
    family_context: {
      ...SCENARIO_FIXTURE.web_search_context.family_context,
      polymarket: {
        ...SCENARIO_FIXTURE.web_search_context.family_context.polymarket,
        configured_host: "non-us",
        items: [],
      },
    },
  },
};

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
    mode: argv[2] || "desktop",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    outputDir: "",
    headless: process.env.HEADLESS === "1",
  };
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      args.browserExplicitlySet = true;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-new-source-ingestion-live.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
    );
  }
  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }
  return args;
}

async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") return firefox.launch({ headless });
  if (browserName === "webkit") return webkit.launch({ headless });
  try {
    return await chromium.launch({ channel: "chrome", headless });
  } catch {
    return chromium.launch({ headless });
  }
}

function createTestResult() {
  return { steps: [], passed: false, scenarioId: null };
}

function pushStep(result, name, passed, extra = {}) {
  result.steps.push({ name, passed, ...extra });
}

function finalize(result) {
  result.passed = result.steps.length > 0 && result.steps.every((step) => step.passed);
  return result;
}

function createScenarioFixture(overrides = {}) {
  return {
    ...SCENARIO_FIXTURE,
    ...overrides,
    web_search_context: overrides.web_search_context ?? SCENARIO_FIXTURE.web_search_context,
  };
}

async function installFixtures(page, overrides = {}) {
  if (LIVE_MODE) return;

  const caps = overrides.capabilities ?? CAPABILITIES_FIXTURE;
  const scenarioFixture = overrides.scenario ?? createScenarioFixture();
  const storyFixture = overrides.story ?? STORY_FIXTURE;
  const agentsFixture = overrides.agents ?? AGENTS_FIXTURE;
  const webContextFixture = overrides.webContextBody ?? WEB_CONTEXT_FIXTURE;

  await page.route(/\/api\/capabilities(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(caps),
    }),
  );
  await page.route(/\/api\/scenario$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenarioFixture),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenarioFixture),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/story$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(storyFixture),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/agents$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(agentsFixture),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/predictions(?:\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    }),
  );
  await page.route(new RegExp(`/api/campaign/scenario/${FIXTURE_SCENARIO_ID}/summary$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: "null",
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/web-context(?:\\?.*)?$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(webContextFixture),
    }),
  );
}

async function installLivePreflightBypass(page) {
  if (!LIVE_MODE) return;
  await page.route(/\/api\/agents\/identities\/preflight(?:\?.*)?$/, (route) =>
    route.fulfill({
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
    }),
  );
}

async function isVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function waitForVisible(page, selector, timeout = 10_000) {
  await page.locator(selector).waitFor({ state: "visible", timeout });
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

async function setRangeValue(page, selector, value) {
  await page.locator(selector).evaluate((element, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function readCapabilities(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/capabilities", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    return response.json();
  });
}

async function waitForLiveWebContext(page, scenarioId, timeout = 90_000) {
  if (!LIVE_MODE) return null;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const payload = await page.evaluate(async (activeScenarioId) => {
      const response = await fetch(`/api/scenario/${activeScenarioId}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      return response.json();
    }, scenarioId).catch(() => null);
    const snippets = payload?.web_search_context?.snippets;
    if (Array.isArray(snippets) && snippets.length > 0) {
      return payload;
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function configureLiveWebSearch(page) {
  const caps = await readCapabilities(page);
  const serverSearchReady = caps?.web_search?.server_enabled === true;
  const needsCustomOverride = Boolean(
    LIVE_WEB_SEARCH_PROVIDER || LIVE_WEB_SEARCH_API_KEY || LIVE_WEB_SEARCH_BASE_URL,
  );
  if (!serverSearchReady && !needsCustomOverride) {
    throw new Error(
      "Live mode requires either server_enabled web search or SWARM_E2E_WEB_SEARCH_PROVIDER/SWARM_E2E_WEB_SEARCH_BASE_URL overrides.",
    );
  }

  const mainToggle = page.locator(".web-search-toggle input[type=\"checkbox\"]");
  await mainToggle.waitFor({ state: "visible", timeout: 15_000 });
  if (!(await mainToggle.isChecked())) {
    await mainToggle.check();
  }

  if (!needsCustomOverride) {
    return {
      expectedProvider: caps?.web_search?.provider ?? null,
      polymarketConfiguredHost: caps?.web_search?.providers?.polymarket?.configured_host ?? null,
      usingCustomOverride: false,
    };
  }

  await page.locator(".web-search-mode-switch .web-search-mode-btn").nth(1).click();
  if (LIVE_WEB_SEARCH_PROVIDER) {
    await page.locator("#web-search-provider").selectOption(LIVE_WEB_SEARCH_PROVIDER);
  }
  if (LIVE_WEB_SEARCH_API_KEY) {
    await page.locator("#web-search-api-key").fill(LIVE_WEB_SEARCH_API_KEY);
  }
  if (LIVE_WEB_SEARCH_BASE_URL) {
    await page.locator("#web-search-base-url").fill(LIVE_WEB_SEARCH_BASE_URL);
  }
  return {
    expectedProvider: LIVE_WEB_SEARCH_PROVIDER || null,
    polymarketConfiguredHost: caps?.web_search?.providers?.polymarket?.configured_host ?? null,
    usingCustomOverride: true,
  };
}

async function ensureWebSearchEnabled(page) {
  const mainToggle = page.locator(".web-search-toggle input[type=\"checkbox\"]");
  await mainToggle.waitFor({ state: "visible", timeout: 15_000 });
  if (!(await mainToggle.isChecked())) {
    await mainToggle.check();
  }
}

function sourceCardTestId(family, mode) {
  return mode === "mobile"
    ? `result-sources-mobile-${family}`
    : `result-sources-${family}`;
}

function sourceCardSelector(family, mode) {
  return `[data-testid="${sourceCardTestId(family, mode)}"]`;
}

async function assertSourceCardsVisible(container, result, mode, expectGeoGatedPolymarket = false) {
  const selectors = SOURCE_FAMILIES.map((family) => sourceCardSelector(family, mode));
  for (const selector of selectors) {
    if (selector.includes("polymarket") && expectGeoGatedPolymarket) {
      continue;
    }
    const locator = container.locator(selector);
    pushStep(result, `visible:${selector}`, await isVisible(locator));
  }
  if (expectGeoGatedPolymarket) {
    pushStep(
      result,
      "visible:[data-testid=\"result-source-polymarket-geo-gated\"]",
      await isVisible(container.getByTestId("result-source-polymarket-geo-gated")),
    );
  }
}

async function assertSourceCardsHaveLiveData(container, result, mode, expectGeoGatedPolymarket = false) {
  async function assertLiveState(card, family) {
    const state = await card.getAttribute("data-state");
    pushStep(result, `${family}-live-state-known`, ACCEPTED_LIVE_SOURCE_STATES.has(state));
    if (state === "ready") {
      pushStep(result, `${family}-live-item-visible`, await isVisible(card.locator("li").first()));
    } else {
      pushStep(result, `${family}-live-nonready-state-surfaced`, typeof state === "string" && state.length > 0, {
        state,
      });
    }
  }

  if (expectGeoGatedPolymarket) {
    const placeholder = container.getByTestId("result-source-polymarket-geo-gated");
    pushStep(
      result,
      "polymarket-geo-gated-placeholder-visible",
      await isVisible(placeholder),
    );
    pushStep(
      result,
      "polymarket-card-hidden-when-geo-gated",
      !(await isVisible(container.getByTestId(sourceCardTestId("polymarket", mode)))),
    );
  } else {
    const polymarketCard = container.getByTestId(sourceCardTestId("polymarket", mode));
    if (LIVE_MODE) {
      await assertLiveState(polymarketCard, "polymarket");
    } else {
      pushStep(
        result,
        "polymarket-live-state-ready",
        (await polymarketCard.getAttribute("data-state")) === "ready",
      );
      pushStep(
        result,
        "polymarket-live-item-visible",
        await isVisible(polymarketCard.locator("li").first()),
      );
    }
  }

  for (const [family, selector] of [
    ["finance", sourceCardSelector("finance", mode)],
    ["academic", sourceCardSelector("academic", mode)],
    ["news_deep", sourceCardSelector("news_deep", mode)],
  ]) {
    const card = container.locator(selector);
    if (LIVE_MODE) {
      await assertLiveState(card, family);
    } else {
      pushStep(
        result,
        `${family}-live-state-ready`,
        (await card.getAttribute("data-state")) === "ready",
      );
      pushStep(
        result,
        `${family}-live-item-visible`,
        await isVisible(card.locator("li").first()),
      );
    }
  }
}

function extractScenarioIdFromLocation(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const match = url.pathname.match(/\/sim\/([^/?#]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function testInputAndResultContracts(page, baseUrl, mode) {
  const result = createTestResult();
  try {
    await page.goto(`${baseUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await dismissWelcomeDialogIfPresent(page);
    await waitForVisible(page, "textarea.input--hero");
    await dismissWelcomeDialogIfPresent(page);

    let liveWebSearchConfig = null;
    if (LIVE_MODE) {
      liveWebSearchConfig = await configureLiveWebSearch(page);
      pushStep(result, "live-web-search-toggle-enabled", true, liveWebSearchConfig);
    } else {
      await ensureWebSearchEnabled(page);
      pushStep(result, "fixture-web-search-toggle-enabled", true);
    }

    for (const family of SOURCE_FAMILIES) {
      const toggle = page.getByTestId(`input-source-toggle-${family}`);
      const input = toggle.locator('input[type="checkbox"]');
      await toggle.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, `input-toggle-visible:${family}`, await isVisible(toggle));
      pushStep(result, `input-toggle-enabled:${family}`, !(await input.isDisabled()));
      await toggle.evaluate((element) => element.click());
      await input.waitFor({ state: "attached", timeout: 1000 });
      pushStep(result, `input-toggle-interactive:${family}`, await input.isChecked());
    }

    let liveScenarioPayloadPromise = null;
    if (LIVE_MODE) {
      await setRangeValue(page, "input.agents-slider", 3);
      liveScenarioPayloadPromise = new Promise((resolve) => {
        page.route(/\/api\/scenario(?:\?.*)?$/, async (route) => {
          const originalPayload = route.request().postDataJSON();
          resolve(originalPayload);
          await route.continue({
            headers: {
              ...route.request().headers(),
              "content-type": "application/json",
            },
            postData: JSON.stringify({
              ...originalPayload,
              num_agents: 3,
              rounds: 1,
            }),
          });
        }).catch(() => {});
      });
      pushStep(result, "live-simulation-budget-minimized", true, { rounds: 1, agents: 3 });
    }

    await page.locator("textarea.input--hero").fill(FIXTURE_QUESTION);
    const scenarioRequestPromise = LIVE_MODE ? null : page.waitForRequest((request) => (
      request.method() === "POST" && /\/api\/scenario(?:\?.*)?$/.test(request.url())
    ));
    await page.locator("button.btn-primary.btn--submit").click();
    await confirmLaunchIfPresent(page);
    if (LIVE_MODE) {
      const scenarioPayload = await liveScenarioPayloadPromise;
      pushStep(
        result,
        "scenario-request-web-search-enabled",
        scenarioPayload?.web_search_enabled === true,
      );
      pushStep(
        result,
        "scenario-request-web-search-families-set",
        JSON.stringify(scenarioPayload?.web_search_families ?? []) === JSON.stringify(SOURCE_FAMILIES),
      );
      if (liveWebSearchConfig?.usingCustomOverride && LIVE_WEB_SEARCH_API_KEY) {
        pushStep(
          result,
          "scenario-request-web-search-api-key-set",
          scenarioPayload?.web_search_api_key === LIVE_WEB_SEARCH_API_KEY,
        );
      }
      if (liveWebSearchConfig?.usingCustomOverride && LIVE_WEB_SEARCH_BASE_URL) {
        pushStep(
          result,
          "scenario-request-web-search-base-url-set",
          scenarioPayload?.web_search_base_url === LIVE_WEB_SEARCH_BASE_URL,
        );
      }
      if (liveWebSearchConfig?.expectedProvider) {
        pushStep(
          result,
          "scenario-request-web-search-provider-set",
          scenarioPayload?.web_search_provider === liveWebSearchConfig.expectedProvider
            || (liveWebSearchConfig.usingCustomOverride === false
              && typeof scenarioPayload?.web_search_provider === "undefined"),
        );
      }
    }
    const scenarioRequest = LIVE_MODE ? null : await scenarioRequestPromise;
    const scenarioUrlPattern = LIVE_MODE
      ? /\/sim\/[^/?#]+$/
      : new RegExp(`/sim/${FIXTURE_SCENARIO_ID}$`);
    await page.waitForURL(scenarioUrlPattern, { timeout: 15_000 });
    const scenarioId = LIVE_MODE
      ? extractScenarioIdFromLocation(page.url())
      : FIXTURE_SCENARIO_ID;
    if (!scenarioId) {
      throw new Error(`Could not resolve scenario id from URL: ${page.url()}`);
    }
    result.scenarioId = scenarioId;
    pushStep(result, "input-submit-navigates-to-simulation", true);

    await page.goto(`${baseUrl}/result/${scenarioId}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    const liveScenarioWithWebContext = await waitForLiveWebContext(page, scenarioId);
    if (LIVE_MODE) {
      pushStep(result, "live-web-context-available", liveScenarioWithWebContext != null);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    }

    const webSourcesTrigger = page.locator("button.result-web-sources__trigger");
    await webSourcesTrigger.waitFor({ state: "visible", timeout: LIVE_MODE ? 90_000 : 10_000 });
    await webSourcesTrigger.click();
    if (LIVE_MODE) {
      const snippet = page.locator(".result-web-sources__item-text").first();
      await snippet.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "web-search-snippet-visible", await isVisible(snippet));
      const sourceUrl = page.locator(".result-web-sources__item-url").first();
      pushStep(result, "web-search-url-visible", await isVisible(sourceUrl));
      const queryMeta = page.locator(".result-web-sources__meta", { hasText: FIXTURE_QUESTION });
      pushStep(result, "web-search-query-visible", await isVisible(queryMeta));
      if (liveWebSearchConfig?.expectedProvider) {
        const providerMeta = page.locator(".result-web-sources__meta", {
          hasText: liveWebSearchConfig.expectedProvider,
        });
        pushStep(result, "web-search-provider-visible", await isVisible(providerMeta));
      }
    } else {
      const snippet = page.locator(".result-web-sources__item-text", { hasText: WEB_SNIPPET_TEXT });
      pushStep(result, "web-search-snippet-visible", await isVisible(snippet));
      pushStep(
        result,
        "web-search-url-visible",
        await isVisible(page.locator(".result-web-sources__item-url", { hasText: WEB_SNIPPET_URL })),
      );
    }

    if (mode === "mobile") {
      const trigger = page.getByTestId("result-mobile-sources-trigger");
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "mobile-source-trigger-visible", await isVisible(trigger));
      await trigger.click();
      const sheet = page.getByTestId("mobile-source-sheet");
      await sheet.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "mobile-source-sheet-visible", await isVisible(sheet));
      await assertSourceCardsVisible(
        sheet,
        result,
        mode,
        liveWebSearchConfig?.polymarketConfiguredHost === "non-us",
      );
      await assertSourceCardsHaveLiveData(
        sheet,
        result,
        mode,
        liveWebSearchConfig?.polymarketConfiguredHost === "non-us",
      );
    } else {
      const grid = page.getByTestId("result-source-grid-desktop");
      await grid.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "desktop-source-grid-visible", await isVisible(grid));
      await assertSourceCardsVisible(
        grid,
        result,
        mode,
        liveWebSearchConfig?.polymarketConfiguredHost === "non-us",
      );
      await assertSourceCardsHaveLiveData(
        grid,
        result,
        mode,
        liveWebSearchConfig?.polymarketConfiguredHost === "non-us",
      );
    }
  } catch (err) {
    pushStep(result, "input-and-result-contracts", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testGeoGatedContract(context, baseUrl, mode, scenarioId = FIXTURE_SCENARIO_ID) {
  const result = createTestResult();
  const page = await context.newPage();
  try {
    if (!LIVE_MODE) {
      await installFixtures(page, {
        capabilities: NON_US_CAPABILITIES_FIXTURE,
        scenario: NON_US_SCENARIO_FIXTURE,
      });
    }
    await page.goto(`${baseUrl}/result/${scenarioId}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    let expectGeoGated = true;
    if (LIVE_MODE) {
      const liveScenario = await page.evaluate(async (activeScenarioId) => {
        const response = await fetch(`/api/scenario/${activeScenarioId}`, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return null;
        return response.json();
      }, scenarioId);
      const configuredHost = liveScenario?.web_search_context?.family_context?.polymarket?.configured_host ?? null;
      expectGeoGated = configuredHost === "non-us";
      pushStep(result, "live-polymarket-configured-host-detected", typeof configuredHost === "string", {
        configured_host: configuredHost,
      });
    }

    let container;
    if (mode === "mobile") {
      const trigger = page.getByTestId("result-mobile-sources-trigger");
      await trigger.waitFor({ state: "visible", timeout: 10_000 });
      await trigger.click();
      const mobileSheet = page.getByTestId("mobile-source-sheet");
      await mobileSheet.waitFor({ state: "visible", timeout: 10_000 });
      container = mobileSheet;
    } else {
      container = page.getByTestId("result-source-grid-desktop");
    }
    await container.waitFor({ state: "visible", timeout: 10_000 });

    if (expectGeoGated) {
      const placeholder = container.getByTestId("result-source-polymarket-geo-gated");
      await placeholder.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "polymarket-geo-gated-placeholder-visible", await isVisible(placeholder));
      pushStep(
        result,
        "polymarket-card-hidden-when-geo-gated",
        !(await isVisible(container.getByTestId(sourceCardTestId("polymarket", mode)))),
      );
    } else {
      const card = container.getByTestId(sourceCardTestId("polymarket", mode));
      await card.waitFor({ state: "visible", timeout: 10_000 });
      pushStep(result, "polymarket-card-visible-when-not-geo-gated", await isVisible(card));
      const state = await card.getAttribute("data-state");
      if (LIVE_MODE) {
        pushStep(result, "polymarket-live-state-known-when-not-geo-gated", ACCEPTED_LIVE_SOURCE_STATES.has(state));
        if (state === "ready") {
          pushStep(result, "polymarket-live-item-visible-when-not-geo-gated", await isVisible(card.locator("li").first()));
        }
      } else {
        pushStep(result, "polymarket-live-item-visible-when-not-geo-gated", await isVisible(card.locator("li").first()));
      }
    }
  } catch (err) {
    pushStep(result, "geo-gated-contract", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await page.close().catch(() => {});
  }
  return finalize(result);
}

async function testOfflineBannerContract(page, baseUrl) {
  const result = createTestResult();
  try {
    await page.goto(`${baseUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await dismissWelcomeDialogIfPresent(page);
    await waitForVisible(page, "textarea.input--hero");
    await dismissWelcomeDialogIfPresent(page);
    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    const banner = page.getByTestId("global-offline-banner");
    await banner.waitFor({ state: "visible", timeout: 10_000 });
    pushStep(result, "global-offline-banner-visible", await isVisible(banner));
    pushStep(
      result,
      "global-offline-banner-retry-visible",
      await isVisible(banner.getByRole("button")),
    );

    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await banner.waitFor({ state: "hidden", timeout: 10_000 });
    pushStep(result, "global-offline-banner-hides-after-reconnect", !(await isVisible(banner)));
  } catch (err) {
    await page.context().setOffline(false).catch(() => {});
    pushStep(result, "offline-banner-contract", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function runSurface(mode, contextOptions, args) {
  const outputDir = args.outputDir
    ? resolveSurfaceOutputDir({ outputDir: args.outputDir, mode, browser: args.browser })
    : path.join(
      DEFAULT_OUTPUT_ROOT,
      `new-source-ingestion-live-${timestampLabel()}-${mode}-${args.browser}`,
    );
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless, args.browser);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  await installFixtures(page);
  await installLivePreflightBypass(page);

  const allResults = {
    mode,
    browser: args.browser,
    viewport: contextOptions.viewport ?? null,
    live: LIVE_MODE,
    baseUrl: args.baseUrl,
    tests: {},
  };
  try {
    allResults.tests.inputAndResultContracts = await testInputAndResultContracts(page, args.baseUrl, mode);
    allResults.tests.geoGatedContract = await testGeoGatedContract(
      context,
      args.baseUrl,
      mode,
      allResults.tests.inputAndResultContracts.scenarioId ?? FIXTURE_SCENARIO_ID,
    );
    allResults.tests.offlineBannerContract = await testOfflineBannerContract(page, args.baseUrl);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  let total = 0;
  let passed = 0;
  for (const testResult of Object.values(allResults.tests)) {
    for (const step of testResult.steps) {
      total += 1;
      if (step.passed) passed += 1;
    }
  }
  allResults.summary = {
    totalSteps: total,
    passedSteps: passed,
    allPassed: total > 0 && total === passed,
  };
  writeJson(path.join(outputDir, "result.json"), allResults);
  return allResults;
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const { defaultBrowserType: _unused, ...MOBILE_CTX_DEFAULTS } = devices["iPhone 13"];

function buildContextOptions(mode) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  return { ...MOBILE_CTX_DEFAULTS, isMobile: true, hasTouch: true };
}

function resolveSurfaceOutputDir({ outputDir, mode, browser }) {
  return path.join(path.resolve(outputDir), `${mode}-${browser}`);
}

function buildSurfaceRuns(args) {
  const mk = (mode, browser) => ({ mode, browser, context: buildContextOptions(mode) });
  if (args.mode === "desktop") return [mk("desktop", args.browser)];
  if (args.mode === "mobile") return [mk("mobile", args.browser)];
  return args.browserExplicitlySet
    ? [mk("desktop", args.browser), mk("mobile", args.browser)]
    : [mk("desktop", "chromium"), mk("mobile", "chromium")];
}

export const __test__ = {
  SOURCE_FAMILIES,
  WEB_CONTEXT_FIXTURE,
  CAPABILITIES_FIXTURE,
  NON_US_CAPABILITIES_FIXTURE,
  buildSurfaceRuns,
  resolveSurfaceOutputDir,
  sourceCardTestId,
};

async function main() {
  const args = parseArgs(process.argv);
  const runs = [];
  for (const surface of buildSurfaceRuns(args)) {
    const run = await runSurface(surface.mode, surface.context, {
      ...args,
      browser: surface.browser,
    });
    runs.push(run);
  }
  const allPassed = runs.every((run) => run.summary.allPassed);
  console.log(JSON.stringify({ script: "e2e-new-source-ingestion-live", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
