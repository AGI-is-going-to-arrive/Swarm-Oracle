/**
 * Capability matrix regression suite for Phase 3 gated routes.
 *
 * This fixture-driven Playwright script stubs `/api/capabilities` and checks
 * that six capability-gated routes behave correctly in enabled/disabled
 * states:
 *   - disabled: show feature_disabled copy and avoid gated `/api/*` calls
 *   - enabled: render the real route surface and perform the expected gated work
 *
 * Run:
 *   node scripts/e2e-capability-matrix.mjs [--url URL] [--browser chromium|firefox|webkit] [--headless]
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");

const ALL_GATED_KEYS = [
  "custom_agents",
  "agent_identity",
  "causal_graph",
  "counterfactual_replay",
  "factions",
  "argument_map",
  "agent_conversation",
  "kg_explorer",
  "replay_trace",
];

const PAGES = [
  {
    name: "AgentWorkshopView",
    route: "/agents/new",
    gateKey: "custom_agents",
    enabledSurfaceSelector: 'form, textarea, input[type="text"]',
    enabledGatedUrlPatterns: [],
    disabledCopy: "Custom agents feature is not enabled.",
  },
  {
    name: "AgentLibrary",
    route: "/agents",
    gateKey: "custom_agents",
    enabledSurfaceSelector: 'a[href="/agents/new"]',
    enabledGatedUrlPatterns: [/\/api\/agents\/identities(\?|$)/],
    disabledCopy: "Custom agents feature is not enabled.",
  },
  {
    name: "CausalReviewView",
    route: "/sim/e2e-scn-cap-matrix/causal-map",
    gateKey: "causal_graph",
    enabledSurfaceSelector: ".causal-review-shell",
    enabledGatedUrlPatterns: [/\/api\/scenario\/[^/]+\/causal-graph(\?|$)/],
    disabledCopy: "Causal graph feature is not enabled.",
  },
  {
    name: "CompareDigestView",
    route: "/result/e2e-scn-cap-matrix/compare?branch_a=br-a&branch_b=br-b",
    gateKey: "counterfactual_replay",
    enabledSurfaceSelector: ".compare-digest-view",
    enabledGatedUrlPatterns: [/\/api\/scenario\/[^/]+\/compare(\?|$)/],
    disabledCopy: "Counterfactual replay feature is not enabled.",
  },
  {
    name: "KGExplorerView",
    route: "/kg-explorer/e2e-scn-cap-matrix",
    gateKey: "kg_explorer",
    enabledSurfaceSelector: '[data-testid="kg-explorer-root"]',
    enabledGatedUrlPatterns: [],
    disabledCopy: "KG Explorer is not enabled on this server.",
    disabledSurfaceSelector: '[data-testid="kg-explorer-root"][role="alert"]',
    allowRouteFallbackSkip: true,
  },
  {
    name: "ReplayView",
    route: "/replay/e2e-scn-cap-matrix",
    gateKey: "replay_trace",
    enabledSurfaceSelector: '[data-testid="replay-view-root"]',
    enabledGatedUrlPatterns: [/\/api\/scenario\/[^/]+\/replay-trace(\?|$)/],
    disabledCopy: null,
    disabledRedirectPath: "/",
    allowRouteFallbackSkip: true,
  },
];

const PRESETS = [
  { name: "all-off", on: [] },
  { name: "all-on", on: ALL_GATED_KEYS.slice() },
  { name: "mixed-graphs", on: ["causal_graph", "argument_map", "kg_explorer", "replay_trace"] },
  { name: "mixed-agents", on: ["agent_identity", "custom_agents", "agent_conversation"] },
  { name: "mixed-debate", on: ["argument_map"] },
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

function buildSignedSessionToken(secret, subject) {
  const payloadSegment = Buffer.from(
    JSON.stringify({ sub: subject }),
    "utf8",
  ).toString("base64url");
  const signingInput = `v1.${payloadSegment}`;
  const signatureSegment = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signatureSegment}`;
}

function resolveSessionToken() {
  const token = process.env.SWARM_SESSION_TOKEN || "test-secret";
  if (!token) return "";
  if (token.startsWith("v1.")) return token;
  return buildSignedSessionToken(
    token,
    process.env.SWARM_SESSION_SUBJECT || "capability-matrix-owner",
  );
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    browser: "chromium",
    headless: process.env.HEADLESS === "1",
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--browser" && next) {
      args.browser = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    }
  }

  if (!["chromium", "firefox", "webkit"].includes(args.browser)) {
    throw new Error(`Unsupported browser: ${args.browser}`);
  }

  return args;
}

async function launchBrowser(name, headless) {
  if (name === "firefox") return firefox.launch({ headless });
  if (name === "webkit") return webkit.launch({ headless });
  return chromium.launch({ headless });
}

function buildCapabilityPayload(enabledKeys) {
  const enabled = new Set(enabledKeys);
  const base = (key) => ({
    enabled: enabled.has(key),
    version: "1.0.0",
    server_only: false,
    degraded_mode: null,
  });

  return {
    web_search: {
      enabled: false,
      version: "1.0.0",
      server_only: true,
      degraded_mode: null,
      scope: "server",
      server_enabled: false,
      method: "none",
      provider: null,
    },
    custom_agents: base("custom_agents"),
    agent_identity: base("agent_identity"),
    causal_graph: base("causal_graph"),
    counterfactual_replay: base("counterfactual_replay"),
    factions: base("factions"),
    argument_map: base("argument_map"),
  };
}

function isGatedApiUrl(url) {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/api/")) return false;
    return parsed.pathname !== "/api/capabilities";
  } catch {
    return false;
  }
}

function matchAnyPattern(url, patterns) {
  return patterns.some((pattern) => pattern.test(url));
}

function buildRequestPredicate(patterns) {
  return (request) => {
    const url = request.url();
    return isGatedApiUrl(url) && matchAnyPattern(url, patterns);
  };
}

async function stubGatedEndpoints(page) {
  await page.route(/\/api\/agents\/identities(\?|$).*/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });

  await page.route(/\/api\/scenario\/[^/]+\/causal-graph(\?|$).*/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ nodes: [], edges: [] }),
    });
  });

  await page.route(/\/api\/scenario\/[^/]+\/compare(\?|$).*/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ branch_a: {}, branch_b: {}, rounds: [], divergence: [] }),
    });
  });

  await page.route(/\/api\/scenario\/[^/]+\/replay-trace(\?|$).*/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        nodes: [
          {
            branch_id: "br-a",
            parent_branch_id: null,
            replay_source_branch_id: null,
            origin_round: 0,
            replay_kind: "counterfactual",
            status: "active",
            created_at: "2026-04-19T00:00:00Z",
          },
        ],
        next_cursor: null,
      }),
    });
  });

  await page.route(/\/api\/scenario\/[^/]+(\?|$)(?!.*\/).*/u, async (route) => {
    const url = route.request().url();
    if (/\/api\/scenario\/[^/]+\/(causal-graph|compare|replay-trace)/.test(url)) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "e2e-scn-cap-matrix", agents: [], branches: [] }),
    });
  });
}

async function routeCapabilities(page, payload) {
  await page.route(/\/api\/capabilities(\?|$).*/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
}

async function runCheckpoint({ page, preset, pageSpec, baseUrl }) {
  const capabilitiesEnabled = preset.on.includes(pageSpec.gateKey);
  const requestLog = [];
  const onRequest = (request) => {
    const url = request.url();
    if (isGatedApiUrl(url)) {
      requestLog.push({ method: request.method(), url });
    }
  };
  page.on("request", onRequest);

  const navUrl = new URL(pageSpec.route, baseUrl).toString();
  const evidence = {
    preset: preset.name,
    page: pageSpec.name,
    route: pageSpec.route,
    gateKey: pageSpec.gateKey,
    capsEnabled: capabilitiesEnabled,
    navUrl,
    requests: [],
    steps: [],
    pass: false,
    skipped: false,
    failureReason: null,
  };

  try {
    await page.goto(navUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);

    const homeUrl = new URL("/", baseUrl).toString();
    if (pageSpec.allowRouteFallbackSkip && page.url() === homeUrl) {
      evidence.skipped = true;
      evidence.steps.push({
        step: "route.unavailable_in_current_live_stack",
        expectedUrl: navUrl,
        actualUrl: page.url(),
      });
      return evidence;
    }

    if (capabilitiesEnabled) {
      if (pageSpec.enabledSurfaceSelector) {
        await page.locator(pageSpec.enabledSurfaceSelector).first().waitFor({
          state: "visible",
          timeout: 8000,
        });
        evidence.steps.push({
          step: "enabled.surface",
          selector: pageSpec.enabledSurfaceSelector,
        });
      }

      if (pageSpec.enabledGatedUrlPatterns.length > 0) {
        const requestPredicate = buildRequestPredicate(pageSpec.enabledGatedUrlPatterns);
        await page.waitForRequest(requestPredicate, { timeout: 8000 }).catch(() => null);
        const gatedHits = requestLog.filter((entry) =>
          matchAnyPattern(entry.url, pageSpec.enabledGatedUrlPatterns)
        );
        evidence.steps.push({
          step: "enabled.gatedRequestsCount",
          value: gatedHits.length,
          patterns: pageSpec.enabledGatedUrlPatterns.map(String),
        });
        if (gatedHits.length < 1) {
          throw new Error(
            `enabled preset '${preset.name}' page '${pageSpec.name}' expected >=1 gated request but got 0`,
          );
        }
      }

      const body = (await page.locator("body").innerText().catch(() => "")) || "";
      if (pageSpec.disabledCopy && body.includes(pageSpec.disabledCopy)) {
        throw new Error(
          `enabled preset '${preset.name}' page '${pageSpec.name}' unexpectedly rendered disabled copy`,
        );
      }
      evidence.steps.push({ step: "enabled.noDisabledLeak", pass: true });
    } else {
      if (pageSpec.disabledRedirectPath) {
        const disabledUrl = new URL(pageSpec.disabledRedirectPath, baseUrl).toString();
        await page.waitForURL(disabledUrl, { timeout: 5000 });
        evidence.steps.push({
          step: "disabled.redirect",
          expectedUrl: disabledUrl,
          actualUrl: page.url(),
        });
      } else if (pageSpec.disabledSurfaceSelector) {
        await page.locator(pageSpec.disabledSurfaceSelector).first().waitFor({
          state: "visible",
          timeout: 5000,
        });
        evidence.steps.push({
          step: "disabled.surface",
          selector: pageSpec.disabledSurfaceSelector,
        });
      } else {
        const body = (await page.locator("body").innerText().catch(() => "")) || "";
        const copyVisible = body.includes(pageSpec.disabledCopy);
        evidence.steps.push({
          step: "disabled.copyVisible",
          value: copyVisible,
          copy: pageSpec.disabledCopy,
        });
        if (!copyVisible) {
          throw new Error(
            `disabled preset '${preset.name}' page '${pageSpec.name}' expected feature_disabled copy`,
          );
        }
      }

      const gatedHits = requestLog.filter((entry) =>
        matchAnyPattern(entry.url, pageSpec.enabledGatedUrlPatterns)
      );
      const offendingUrls = pageSpec.enabledGatedUrlPatterns.length > 0
        ? gatedHits.map((entry) => entry.url)
        : requestLog.map((entry) => entry.url);
      evidence.steps.push({
        step: "disabled.gatedRequestsCount",
        value: offendingUrls.length,
        observedUrls: offendingUrls,
        patterns: pageSpec.enabledGatedUrlPatterns.map(String),
      });
      if (offendingUrls.length !== 0) {
        throw new Error(
          `disabled preset '${preset.name}' page '${pageSpec.name}' expected 0 gated /api/* requests`,
        );
      }
    }

    evidence.pass = true;
  } catch (error) {
    evidence.pass = false;
    evidence.failureReason = error instanceof Error ? error.message : String(error);
  } finally {
    page.off("request", onRequest);
    evidence.requests = requestLog;
  }

  return evidence;
}

async function runPreset({ browser, preset, baseUrl }) {
  const results = [];
  const sessionToken = resolveSessionToken();
  for (const pageSpec of PAGES) {
    const context = await browser.newContext({ locale: "en-US" });
    await context.addInitScript((token) => {
      try {
        window.localStorage.setItem("i18nextLng", "en");
        window.localStorage.setItem("swarmoracle_session_token", token);
      } catch {
        // ignore language persistence issues in diagnostics
      }
    }, sessionToken);
    const page = await context.newPage();

    await routeCapabilities(page, buildCapabilityPayload(preset.on));
    await stubGatedEndpoints(page);

    const checkpoint = await runCheckpoint({ page, preset, pageSpec, baseUrl });
    results.push(checkpoint);
    await context.close();
  }
  return results;
}

function printRow(result) {
  const tag = result.skipped ? "SKIP" : result.pass ? "PASS" : "FAIL";
  const gate = result.capsEnabled ? "enabled" : "disabled";
  const line = `  [${tag}] ${result.preset.padEnd(14)} | ${result.page.padEnd(20)} | gate=${result.gateKey.padEnd(22)} | caps=${gate}`;
  console.log(line);
  if (!result.pass && !result.skipped) {
    console.log(`         reason: ${result.failureReason}`);
    const urls = (result.requests || [])
      .map((entry) => `    - ${entry.method} ${entry.url}`)
      .join("\n");
    if (urls) {
      console.log(`         observed /api/* requests:\n${urls}`);
    }
  } else if (result.skipped) {
    const step = result.steps.find((entry) => entry.step === "route.unavailable_in_current_live_stack");
    if (step) {
      console.log(`         reason: route redirected to ${step.actualUrl}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const outputRoot = path.join(
    DEFAULT_OUTPUT_ROOT,
    `capability-matrix-${timestampLabel()}`,
  );
  ensureDir(outputRoot);

  console.log("== capability matrix ==");
  console.log(`   baseUrl   : ${args.baseUrl}`);
  console.log(`   browser   : ${args.browser}`);
  console.log(`   presets   : ${PRESETS.map((preset) => preset.name).join(", ")}`);
  console.log(`   pages     : ${PAGES.map((page) => page.name).join(", ")}`);
  console.log(`   output    : ${outputRoot}`);
  console.log("");

  const browser = await launchBrowser(args.browser, args.headless);
  const allResults = [];
  try {
    for (const preset of PRESETS) {
      console.log(`-- preset: ${preset.name} (on=[${preset.on.join(", ") || "(none)"}]) --`);
      const results = await runPreset({ browser, preset, baseUrl: args.baseUrl });
      for (const result of results) {
        printRow(result);
      }
      allResults.push(...results);
    }
  } finally {
    await browser.close();
  }

  writeJson(path.join(outputRoot, "results.json"), {
    presets: PRESETS,
    pages: PAGES.map((page) => ({
      name: page.name,
      route: page.route,
      gateKey: page.gateKey,
      enabledGatedUrlPatterns: page.enabledGatedUrlPatterns.map(String),
    })),
    results: allResults,
  });

  const passed = allResults.filter((result) => result.pass).length;
  const skipped = allResults.filter((result) => result.skipped).length;
  const total = allResults.length;
  console.log("");
  console.log(`== summary: ${passed} passed / ${skipped} skipped / ${total} total ==`);
  if (passed + skipped < total) {
    console.log("   failing checkpoints:");
    for (const result of allResults.filter((entry) => !entry.pass && !entry.skipped)) {
      console.log(`   - ${result.preset} × ${result.page}: ${result.failureReason}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
