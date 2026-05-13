#!/usr/bin/env node
/**
 * Native Search Citations — Fixture-mode E2E suite
 *
 * Validates the `WebSourcesSection` native-citations sub-region rendered on
 * `/result/:id` when `scenario.web_search_context.native_citations` is set:
 *
 * 1. native_citations_render          — legal https citations appear (count = 2)
 * 2. native_citations_filter_unsafe   — javascript: / ftp: citations are filtered out
 * 3. native_citations_a11y            — region has role + aria-label, trigger has aria-controls
 * 4. native_citations_focus_visible   — keyboard Tab reaches a citation link with focus outline
 * 5. native_citations_empty           — empty array means the native region is not rendered
 *
 * Fixture mode only (no `--live`). All API responses are stubbed via `page.route`.
 *
 * Run:
 *   node scripts/e2e-native-search-suite.mjs [desktop|mobile|full]
 *        [--url URL] [--browser chromium|firefox|webkit] [--headless]
 *        [--output-dir DIR]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e", "native-search");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

const FIXTURE_SCENARIO_ID = "test-id";
const FIXTURE_QUESTION = "Native citations contract verification";
const FIXTURE_PROVIDER = "xai";

const SAFE_CITATION_A = {
  text: "Safe citation A — published primary source",
  source_url: "https://primary.example.com/article/native-a",
};
const SAFE_CITATION_B = {
  text: "Safe citation B — secondary source corroboration",
  source_url: "https://secondary.example.com/research/native-b",
};
const UNSAFE_JS_CITATION = {
  text: "Unsafe javascript: pseudo URL — must be filtered",
  source_url: "javascript:alert('xss')",
};
const UNSAFE_FTP_CITATION = {
  text: "Unsafe ftp: scheme citation — must be filtered",
  source_url: "ftp://legacy.example.com/files/old",
};

const CAPABILITIES_FIXTURE = {
  web_search: {
    enabled: true,
    server_enabled: true,
    scope: "server",
    method: "responses_api",
    provider: FIXTURE_PROVIDER,
    provider_capability: {
      supports_domain_filter: true,
      supports_sources: true,
      domain_filter_mode: "api",
      native_search: true,
    },
    providers: {
      polymarket: { enabled: false, degraded: false, configured_host: "us" },
      finance: { enabled: false, degraded: false },
      academic: { enabled: false, degraded: false },
      news_deep: { enabled: false, degraded: false },
    },
  },
  kg_explorer: { enabled: false },
  agent_conversation: { enabled: false },
  replay_trace: { enabled: false },
  causal_graph: { enabled: false },
  factions: { enabled: false },
  argument_map: { enabled: false },
  custom_agents: { enabled: false },
  agent_identity: { enabled: false },
  counterfactual_replay: { enabled: false },
};

const WEB_SEARCH_CONTEXT_FULL = {
  query: FIXTURE_QUESTION,
  provider: FIXTURE_PROVIDER,
  cached: false,
  timestamp: "2026-05-14T00:00:00Z",
  snippets: [
    {
      text: "Proxy snippet provided alongside native citations",
      source_url: "https://proxy.example.com/snippet/one",
    },
  ],
  native_citations: [
    SAFE_CITATION_A,
    UNSAFE_JS_CITATION,
    SAFE_CITATION_B,
    UNSAFE_FTP_CITATION,
  ],
};

const WEB_SEARCH_CONTEXT_EMPTY = {
  query: FIXTURE_QUESTION,
  provider: FIXTURE_PROVIDER,
  cached: false,
  timestamp: "2026-05-14T00:00:00Z",
  snippets: [
    {
      text: "Proxy snippet without any native citations",
      source_url: "https://proxy.example.com/snippet/only",
    },
  ],
  native_citations: [],
};

function buildScenarioFixture(webContext) {
  return {
    id: FIXTURE_SCENARIO_ID,
    question: FIXTURE_QUESTION,
    status: "done",
    created_at: "2026-05-14T00:00:00Z",
    scene_theme: "law_court",
    agents: [
      {
        id: "agent-1",
        name: "Archivist",
        role: "Recorder",
        tier: "CORE",
        emotion: "calm",
      },
    ],
    branches: [
      {
        id: "branch-1",
        title: "Native Citation Branch",
        probability: 1,
        status: "COMPLETED",
        story: "Branch story for native citation verification.",
        insight: "Native citation rendering must be safe by default.",
        key_moments: ["Native citations rendered"],
        parent_branch_id: null,
        fork_reason: "",
      },
    ],
    messages: [],
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
    web_search_context: webContext,
  };
}

const STORY_FIXTURE = {
  scenario_id: FIXTURE_SCENARIO_ID,
  question: FIXTURE_QUESTION,
  status: "done",
  branches: [
    {
      id: "branch-1",
      title: "Native Citation Branch",
      probability: 1,
      status: "COMPLETED",
      story: "Branch story for native citation verification.",
      insight: "Native citation rendering must be safe by default.",
      key_moments: ["Native citations rendered"],
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
  },
];

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
    mode: argv[2] && !argv[2].startsWith("--") ? argv[2] : "full",
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    browserExplicitlySet: false,
    outputDir: "",
    headless: process.env.HEADLESS === "1",
  };
  const startIdx = args.mode === "full" && (!argv[2] || argv[2].startsWith("--")) ? 2 : 3;
  for (let i = startIdx; i < argv.length; i += 1) {
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
    } else if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    }
  }
  if (!["desktop", "mobile", "full"].includes(args.mode)) {
    throw new Error(
      "Usage: node scripts/e2e-native-search-suite.mjs <desktop|mobile|full> [--url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]",
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
  return { steps: [], passed: false };
}

function pushStep(result, name, passed, extra = {}) {
  result.steps.push({ name, passed, ...extra });
}

function finalize(result) {
  result.passed = result.steps.length > 0 && result.steps.every((step) => step.passed);
  return result;
}

async function isVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function installFixtures(page, scenarioFixture, capabilities = CAPABILITIES_FIXTURE) {
  // Playwright page.route uses LIFO priority: register catch-all guards FIRST
  // (lowest priority), then specific routes LAST (highest priority).
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/[^/]+`), (route) => {
    route.fulfill({ status: 404, contentType: "application/json", body: "{}" }).catch(() => {});
  });
  await page.route(
    new RegExp(`/api/campaign/scenario/${FIXTURE_SCENARIO_ID}/summary$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "null",
      }),
  );
  await page.route(
    new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/web-context(?:\\?.*)?$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(scenarioFixture.web_search_context ?? {}),
      }),
  );
  await page.route(
    new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/predictions(?:\\?.*)?$`),
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/agents$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(AGENTS_FIXTURE),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}/story$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(STORY_FIXTURE),
    }),
  );
  await page.route(new RegExp(`/api/scenario/${FIXTURE_SCENARIO_ID}$`), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(scenarioFixture),
    }),
  );
  await page.route(/\/api\/capabilities(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(capabilities),
    }),
  );
}

async function openNativeSection(page) {
  const trigger = page.locator("button.result-web-sources__trigger");
  await trigger.waitFor({ state: "visible", timeout: 10_000 });
  const expanded = await trigger.getAttribute("aria-expanded");
  if (expanded !== "true") {
    await trigger.click();
  }
  return trigger;
}

async function testNativeCitationsRender(page, args, outputDir) {
  const result = createTestResult();
  try {
    await installFixtures(page, buildScenarioFixture(WEB_SEARCH_CONTEXT_FULL));
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await openNativeSection(page);

    const nativeRegion = page.locator(".result-web-sources__native");
    await nativeRegion.waitFor({ state: "visible", timeout: 10_000 });
    pushStep(result, "native-region-visible", await isVisible(nativeRegion));

    const heading = page.locator(".result-web-sources__native-heading");
    pushStep(result, "native-heading-visible", await isVisible(heading));
    const headingText = (await heading.textContent())?.trim() ?? "";
    pushStep(result, "native-heading-non-empty", headingText.length > 0, {
      headingText,
    });

    const safeItems = nativeRegion.locator(".result-web-sources__item--native");
    const safeCount = await safeItems.count();
    pushStep(result, "native-citation-count-equals-2", safeCount === 2, {
      observed: safeCount,
    });

    // Verify both expected citation texts and URLs are present
    const aText = await isVisible(
      nativeRegion.locator(".result-web-sources__item-text", { hasText: SAFE_CITATION_A.text }),
    );
    pushStep(result, "native-citation-a-text-visible", aText);
    const bText = await isVisible(
      nativeRegion.locator(".result-web-sources__item-text", { hasText: SAFE_CITATION_B.text }),
    );
    pushStep(result, "native-citation-b-text-visible", bText);

    const aUrl = await isVisible(
      nativeRegion.locator(".result-web-sources__item-url", { hasText: SAFE_CITATION_A.source_url }),
    );
    pushStep(result, "native-citation-a-url-visible", aUrl);
    const bUrl = await isVisible(
      nativeRegion.locator(".result-web-sources__item-url", { hasText: SAFE_CITATION_B.source_url }),
    );
    pushStep(result, "native-citation-b-url-visible", bUrl);

    // rel="noopener noreferrer" + target="_blank" sanity
    const firstLink = nativeRegion.locator(".result-web-sources__item-url").first();
    const rel = await firstLink.getAttribute("rel");
    const target = await firstLink.getAttribute("target");
    pushStep(result, "native-citation-link-rel", rel === "noopener noreferrer", { rel });
    pushStep(result, "native-citation-link-target", target === "_blank", { target });

    await page.screenshot({
      path: path.join(outputDir, `native_citations_render-${args.browser}.png`),
      type: "png",
    });
  } catch (err) {
    pushStep(result, "native-citations-render", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testNativeCitationsFilterUnsafe(page, args, outputDir) {
  const result = createTestResult();
  try {
    await installFixtures(page, buildScenarioFixture(WEB_SEARCH_CONTEXT_FULL));
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await openNativeSection(page);

    const nativeRegion = page.locator(".result-web-sources__native");
    await nativeRegion.waitFor({ state: "visible", timeout: 10_000 });

    // Citation text bodies for unsafe URLs must NOT be rendered (filtered by getSafeHttpUrl).
    const jsTextVisible = await isVisible(
      nativeRegion.locator(".result-web-sources__item-text", { hasText: UNSAFE_JS_CITATION.text }),
    );
    pushStep(result, "javascript-citation-text-not-rendered", !jsTextVisible);

    const ftpTextVisible = await isVisible(
      nativeRegion.locator(".result-web-sources__item-text", { hasText: UNSAFE_FTP_CITATION.text }),
    );
    pushStep(result, "ftp-citation-text-not-rendered", !ftpTextVisible);

    // No anchor inside native region may have a non-http(s) href.
    const linkHrefs = await nativeRegion
      .locator(".result-web-sources__item-url")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") || ""));
    const unsafeFound = linkHrefs.find((h) => !/^https?:\/\//i.test(h));
    pushStep(result, "no-unsafe-scheme-link-in-native-region", !unsafeFound, {
      hrefs: linkHrefs,
    });

    // Total rendered native citations must be exactly 2 (drop js+ftp from 4 input items).
    const count = await nativeRegion.locator(".result-web-sources__item--native").count();
    pushStep(result, "filtered-citation-count-equals-2", count === 2, { observed: count });

    await page.screenshot({
      path: path.join(outputDir, `native_citations_filter_unsafe-${args.browser}.png`),
      type: "png",
    });
  } catch (err) {
    pushStep(result, "native-citations-filter-unsafe", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testNativeCitationsA11y(page, args, outputDir) {
  const result = createTestResult();
  try {
    await installFixtures(page, buildScenarioFixture(WEB_SEARCH_CONTEXT_FULL));
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    const trigger = await openNativeSection(page);

    // Trigger must wire aria-controls -> body id.
    const ariaControls = await trigger.getAttribute("aria-controls");
    pushStep(
      result,
      "trigger-has-aria-controls",
      typeof ariaControls === "string" && ariaControls.length > 0,
      { aria_controls: ariaControls },
    );
    const ariaExpanded = await trigger.getAttribute("aria-expanded");
    pushStep(result, "trigger-aria-expanded-true", ariaExpanded === "true");

    // Controlled body should exist with matching id (check DOM presence, not visibility,
    // because grid-template-rows animation timing varies across browsers).
    if (ariaControls) {
      const bodyCount = await page.locator(`#${ariaControls}`).count();
      pushStep(result, "aria-controls-target-exists", bodyCount > 0);
    }

    const nativeRegion = page.locator(".result-web-sources__native");
    await nativeRegion.waitFor({ state: "visible", timeout: 10_000 });

    const role = await nativeRegion.getAttribute("role");
    pushStep(result, "native-region-has-role-region", role === "region", { role });

    const ariaLabel = await nativeRegion.getAttribute("aria-label");
    pushStep(
      result,
      "native-region-has-aria-label",
      typeof ariaLabel === "string" && ariaLabel.length > 0,
      { aria_label: ariaLabel },
    );

    await page.screenshot({
      path: path.join(outputDir, `native_citations_a11y-${args.browser}.png`),
      type: "png",
    });
  } catch (err) {
    pushStep(result, "native-citations-a11y", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testNativeCitationsFocusVisible(page, args, outputDir) {
  const result = createTestResult();
  try {
    await installFixtures(page, buildScenarioFixture(WEB_SEARCH_CONTEXT_FULL));
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    await openNativeSection(page);

    const nativeRegion = page.locator(".result-web-sources__native");
    await nativeRegion.waitFor({ state: "visible", timeout: 10_000 });

    const firstLink = nativeRegion.locator(".result-web-sources__item-url").first();
    await firstLink.waitFor({ state: "visible", timeout: 5_000 });

    // Use keyboard Tab to reach the link (triggers :focus-visible, unlike .focus()).
    const trigger = page.locator("button.result-web-sources__trigger");
    await trigger.focus();
    let focusReachedLink = false;
    for (let tabAttempt = 0; tabAttempt < 15; tabAttempt += 1) {
      await page.keyboard.press("Tab");
      const isOnNativeLink = await page.evaluate(() => {
        const el = document.activeElement;
        return (
          el?.tagName?.toLowerCase() === "a" &&
          el.classList.contains("result-web-sources__item-url") &&
          el.closest(".result-web-sources__item--native") !== null
        );
      });
      if (isOnNativeLink) {
        focusReachedLink = true;
        break;
      }
    }
    pushStep(result, "tab-reaches-native-link", focusReachedLink);

    const matchesFocusVisible = focusReachedLink
      ? await page.evaluate(() => {
          try {
            return document.activeElement?.matches(":focus-visible") ?? false;
          } catch {
            return false;
          }
        })
      : false;
    pushStep(result, "first-link-matches-focus-visible", matchesFocusVisible === true);

    const outlineInfo = focusReachedLink
      ? await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return { outlineStyle: "none", outlineWidth: "0px" };
          const style = window.getComputedStyle(el);
          return {
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor,
          };
        })
      : { outlineStyle: "none", outlineWidth: "0px" };

    const hasOutline =
      outlineInfo.outlineStyle !== "none" &&
      outlineInfo.outlineWidth !== "0px";
    pushStep(
      result,
      "first-link-focus-indicator-present",
      hasOutline,
      outlineInfo,
    );

    // Tab reachability already verified above via focusReachedLink.
    pushStep(result, "tab-reaches-first-native-link", focusReachedLink);

    await page.screenshot({
      path: path.join(outputDir, `native_citations_focus_visible-${args.browser}.png`),
      type: "png",
    });
  } catch (err) {
    pushStep(result, "native-citations-focus-visible", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function testNativeCitationsEmpty(page, args, outputDir) {
  const result = createTestResult();
  try {
    await installFixtures(page, buildScenarioFixture(WEB_SEARCH_CONTEXT_EMPTY));
    await page.goto(`${args.baseUrl}/result/${FIXTURE_SCENARIO_ID}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    // Open the web sources panel — the proxy section should still render.
    await openNativeSection(page);

    // Allow time for any race; the native sub-region must remain absent.
    const nativeRegion = page.locator(".result-web-sources__native");
    const exists = (await nativeRegion.count()) > 0;
    pushStep(result, "native-region-not-rendered-when-empty", !exists);

    // Sanity: the proxy snippet is still visible (panel itself rendered).
    const proxySnippet = page.locator(".result-web-sources__item-text", {
      hasText: "Proxy snippet without any native citations",
    });
    pushStep(result, "proxy-snippet-still-visible", await isVisible(proxySnippet));

    await page.screenshot({
      path: path.join(outputDir, `native_citations_empty-${args.browser}.png`),
      type: "png",
    });
  } catch (err) {
    pushStep(result, "native-citations-empty", false, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return finalize(result);
}

async function runSurface(mode, contextOptions, args) {
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(
        DEFAULT_OUTPUT_ROOT,
        `${timestampLabel()}-${mode}-${args.browser}`,
      );
  ensureDir(outputDir);

  const browser = await launchBrowser(args.headless, args.browser);
  const context = await browser.newContext(contextOptions);

  const allResults = {
    suite: "native-search",
    mode,
    browser: args.browser,
    viewport: contextOptions.viewport ?? null,
    baseUrl: args.baseUrl,
    tests: {},
  };

  try {
    // Each test gets its own page so route fixtures stay isolated.
    const tests = [
      ["native_citations_render", testNativeCitationsRender],
      ["native_citations_filter_unsafe", testNativeCitationsFilterUnsafe],
      ["native_citations_a11y", testNativeCitationsA11y],
      ["native_citations_focus_visible", testNativeCitationsFocusVisible],
      ["native_citations_empty", testNativeCitationsEmpty],
    ];
    for (const [name, runner] of tests) {
      const page = await context.newPage();
      try {
        allResults.tests[name] = await runner(page, args, outputDir);
      } finally {
        await page.close().catch(() => {});
      }
    }
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
    perTest: Object.fromEntries(
      Object.entries(allResults.tests).map(([name, r]) => [name, r.passed]),
    ),
  };
  writeJson(path.join(outputDir, "result.json"), allResults);
  return allResults;
}

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };
const { defaultBrowserType: _unused, ...MOBILE_CTX_DEFAULTS } = devices["iPhone 13"];

function buildContextOptions(mode) {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT };
  // Hand-rolled mobile viewport (375x812) per task spec; keep userAgent + touch
  // characteristics from iPhone 13 for realism without overriding viewport.
  return {
    ...MOBILE_CTX_DEFAULTS,
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  };
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
  CAPABILITIES_FIXTURE,
  WEB_SEARCH_CONTEXT_FULL,
  WEB_SEARCH_CONTEXT_EMPTY,
  SAFE_CITATION_A,
  SAFE_CITATION_B,
  UNSAFE_JS_CITATION,
  UNSAFE_FTP_CITATION,
  buildSurfaceRuns,
  buildScenarioFixture,
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
  console.log(
    JSON.stringify({
      script: "e2e-native-search-suite",
      runs: runs.length,
      allPassed,
      summaries: runs.map((r) => ({
        mode: r.mode,
        browser: r.browser,
        ...r.summary,
      })),
    }),
  );
  process.exit(allPassed ? 0 : 1);
}

if (IS_MAIN_MODULE) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
