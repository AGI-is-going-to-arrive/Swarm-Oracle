import assert from "node:assert/strict";
import test from "node:test";

import { __test__ as batchATest } from "./e2e-phase3-batch-a.mjs";
import { __test__ as batchBTest } from "./e2e-phase3-batch-b.mjs";
import { __test__ as batchCTest } from "./e2e-phase3-batch-c.mjs";
import { __test__ as releaseSignoffTest } from "./release-signoff.mjs";
import {
  assertFrontendRoutesReady,
  buildPhase3BatchAPreflightPaths,
  buildPhase3BatchBPreflightPaths,
} from "./lib/frontendPreflight.mjs";
import {
  __test__ as roundtableSuiteTest,
  resolveRoundtableDragTargetTestId,
} from "./e2e-worldline-roundtable-suite.mjs";
import {
  classifyWsAuthHardeningProbe,
} from "./e2e-ws-contract-suite.mjs";

function buildHtml(entryPath, {
  cssPath = "/assets/index-a.css",
  includeCss = true,
  includeLegacyNomodule = true,
  legacyPolyfillPath = "/assets/polyfills-legacy.js",
  legacyEntryPath = "/assets/index-legacy.js",
  includeViteLegacyIds = true,
} = {}) {
  const cssTag = includeCss
    ? `<link rel="stylesheet" crossorigin href="${cssPath}">`
    : "";
  const legacyNomoduleTag = includeLegacyNomodule
    ? `<script nomodule>window.__legacy_nomodule_fallback__=true;</script>`
    : "";
  const legacyPolyfillId = includeViteLegacyIds ? ' id="vite-legacy-polyfill"' : "";
  const legacyEntryId = includeViteLegacyIds ? ' id="vite-legacy-entry"' : "";
  const legacyEntryLookup = includeViteLegacyIds
    ? "document.getElementById('vite-legacy-entry').getAttribute('data-src')"
    : "document.currentScript?.getAttribute('data-src')";
  return `<!doctype html><html><head>${cssTag}<script type="module" crossorigin src="${entryPath}"></script></head><body><div id="root"></div>${legacyNomoduleTag}<script nomodule crossorigin${legacyPolyfillId} src="${legacyPolyfillPath}"></script><script nomodule crossorigin${legacyEntryId} data-src="${legacyEntryPath}">System.import(${legacyEntryLookup})</script></body></html>`;
}

function createResponse(status, body, contentType = "text/html; charset=utf-8") {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return contentType;
        return null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("buildPhase3BatchAPreflightPaths includes each deep-link route used by batch-a", () => {
  assert.deepEqual(
    buildPhase3BatchAPreflightPaths("scenario-42"),
    [
      "/",
      "/agents/new",
      "/agents",
      "/sim/scenario-42/causal-map",
    ],
  );
});

test("buildPhase3BatchBPreflightPaths includes each deep-link route used by batch-b", () => {
  assert.deepEqual(
    buildPhase3BatchBPreflightPaths({
      scenarioId: "scenario-42",
      debateId: "debate-7",
      branchA: "alpha",
      branchB: "beta",
    }),
    [
      "/",
      "/debate/debate-7/result",
      "/result/scenario-42",
      "/result/scenario-42/compare?branch_a=alpha&branch_b=beta",
    ],
  );
});

test("assertFrontendRoutesReady accepts consistent HTML routes that share the same entry asset", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/agents/new", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('ok');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css; charset=utf-8")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  const result = await assertFrontendRoutesReady({
    baseUrl: "http://127.0.0.1:18928",
    routePaths: ["/", "/agents/new"],
    fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
  });

  assert.equal(result.entryAssetPath, "/assets/index-a.js");
  assert.deepEqual(result.cssEntryAssetPaths, ["/assets/index-a.css"]);
  assert.equal(result.legacyPolyfillAssetPath, "/assets/polyfills-legacy.js");
  assert.equal(result.legacyEntryAssetPath, "/assets/index-legacy.js");
  assert.deepEqual(
    result.checkedRoutes.map((route) => route.path),
    ["/", "/agents/new"],
  );
});

test("assertFrontendRoutesReady accepts generic nomodule legacy scripts without Vite-specific ids", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js", { includeViteLegacyIds: false }))],
    ["http://127.0.0.1:18928/result/scenario-42", createResponse(200, buildHtml("/assets/index-a.js", { includeViteLegacyIds: false }))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('ok');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css; charset=utf-8")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  const result = await assertFrontendRoutesReady({
    baseUrl: "http://127.0.0.1:18928",
    routePaths: ["/", "/result/scenario-42"],
    fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
  });

  assert.equal(result.legacyPolyfillAssetPath, "/assets/polyfills-legacy.js");
  assert.equal(result.legacyEntryAssetPath, "/assets/index-legacy.js");
});

test("roundtable parseArgs accepts explicit mobile viewport dimensions", () => {
  const args = roundtableSuiteTest.parseArgs([
    "node",
    "scripts/e2e-worldline-roundtable-suite.mjs",
    "mobile",
    "--mobile-width",
    "320",
    "--mobile-height",
    "740",
  ]);

  assert.equal(args.mobileWidth, 320);
  assert.equal(args.mobileHeight, 740);
});

test("roundtable parseArgs accepts an explicit scenario id", () => {
  const args = roundtableSuiteTest.parseArgs([
    "node",
    "scripts/e2e-worldline-roundtable-suite.mjs",
    "full",
    "--scenario-id",
    "scenario-42",
  ]);

  assert.equal(args.scenarioId, "scenario-42");
});

test("roundtable fixture scenario import uses fresh locale-scoped replay payloads", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    return {
      ok: true,
      async json() {
        return {
          id: `imported-${body.scenario.language}-${calls.length}`,
          branches: body.scenario.branches,
          agents: body.scenario.agents,
          messages: body.scenario.messages,
        };
      },
    };
  };

  const zh = await roundtableSuiteTest.importRoundtableFixtureScenario(
    "http://127.0.0.1:18927",
    "zh",
    { fetchImpl },
  );
  const en = await roundtableSuiteTest.importRoundtableFixtureScenario(
    "http://127.0.0.1:18927",
    "en",
    { fetchImpl },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:18927/api/scenario/import-replay");
  assert.equal(calls[1].url, "http://127.0.0.1:18927/api/scenario/import-replay");
  assert.equal(calls[0].body.scenario.language, "zh");
  assert.equal(calls[1].body.scenario.language, "en");
  assert.notEqual(calls[0].body.scenario.question, calls[1].body.scenario.question);
  assert.equal(zh.id, "imported-zh-1");
  assert.equal(en.id, "imported-en-2");
});

test("roundtable fixture mode respects an explicit scenario id", async () => {
  const result = await roundtableSuiteTest.resolveRoundtableScenarioIds({
    backendUrl: "http://127.0.0.1:18927",
    locale: "en",
    requestedScenarioId: "scenario-42",
    preferredScenarioIds: { desktop: "old-desktop", mobile: "old-mobile" },
    fixtureMode: true,
    fetchImpl: async () => {
      throw new Error("explicit scenario should not import a fixture");
    },
  });

  assert.deepEqual(result, {
    desktopScenarioId: "scenario-42",
    mobileScenarioId: "scenario-42",
    fixtureScenarioId: null,
  });
});

test("roundtable contract validation accepts restored custom rooms", () => {
  const contract = roundtableSuiteTest.assertSupportedRoundtableContractPayload({
    page: {
      controls: {
        discussion_format: "deep_dive",
        cast_mode: "custom",
      },
    },
  }, "restored custom room");

  assert.deepEqual(contract, {
    discussionFormat: "deep_dive",
    castMode: "custom",
    isDefault: false,
  });
});

test("roundtable contract validation rejects unsupported values", () => {
  assert.throws(
    () => roundtableSuiteTest.assertSupportedRoundtableContractPayload({
      page: {
        controls: {
          discussion_format: "unknown",
          cast_mode: "smart_pick",
        },
      },
    }, "bad roundtable contract"),
    /unsupported discussion_format=unknown/,
  );
});

test("roundtable parseArgs rejects invalid mobile viewport dimensions", () => {
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-width",
    ]),
    /--mobile-width requires a value/,
  );
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-width",
      "wide",
    ]),
    /--mobile-width must be an integer/,
  );
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-width",
      "320.5",
    ]),
    /--mobile-width must be an integer/,
  );
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-width",
      "-1",
    ]),
    /--mobile-width must be an integer/,
  );
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-width",
      "239",
    ]),
    /--mobile-width must be an integer/,
  );
  assert.throws(
    () => roundtableSuiteTest.parseArgs([
      "node",
      "scripts/e2e-worldline-roundtable-suite.mjs",
      "mobile",
      "--mobile-height",
      "99999",
    ]),
    /--mobile-height must be an integer/,
  );
});

test("assertFrontendRoutesReady fails fast when a deep-link route returns 404", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/agents/new", createResponse(404, "Not Found", "text/plain")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/", "/agents/new"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /agents\/new.*404/i,
  );
});

test("assertFrontendRoutesReady rejects mixed entry fingerprints across deep-link routes", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/agents", createResponse(200, buildHtml("/assets/index-b.js"))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('a');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-b.js", createResponse(200, "console.log('b');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/", "/agents"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /entry module mismatch/i,
  );
});

test("assertFrontendRoutesReady rejects a missing entry asset even when the HTML routes return 200", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/agents", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(404, "missing", "text/plain")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/", "/agents"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /entry asset.*404/i,
  );
});

test("assertFrontendRoutesReady rejects HTML that omits the local CSS entry asset", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js", { includeCss: false }))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('ok');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /local CSS entry stylesheet/i,
  );
});

test("assertFrontendRoutesReady rejects HTML that omits the legacy nomodule fallback script", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js", { includeLegacyNomodule: false }))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('ok');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(200, "System.register([]);", "application/javascript")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /legacy nomodule fallback script/i,
  );
});

test("assertFrontendRoutesReady rejects a missing legacy entry asset", async () => {
  const responses = new Map([
    ["http://127.0.0.1:18928/", createResponse(200, buildHtml("/assets/index-a.js"))],
    ["http://127.0.0.1:18928/assets/index-a.js", createResponse(200, "console.log('ok');", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-a.css", createResponse(200, "body{}", "text/css")],
    ["http://127.0.0.1:18928/assets/polyfills-legacy.js", createResponse(200, "System;", "application/javascript")],
    ["http://127.0.0.1:18928/assets/index-legacy.js", createResponse(404, "missing", "text/plain")],
  ]);

  await assert.rejects(
    () => assertFrontendRoutesReady({
      baseUrl: "http://127.0.0.1:18928",
      routePaths: ["/"],
      fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
    }),
    /legacy entry asset.*404/i,
  );
});

test("batch-a reuses the shared preflight route builder", () => {
  assert.deepEqual(
    batchATest.preflightRoutePaths,
    buildPhase3BatchAPreflightPaths("sc-e2e-causal-001"),
  );
});

test("batch-a targets the causal graph screen-reader fallback list via stable test id", () => {
  assert.equal(batchATest.srFallbackListTestId, "causal-events-list");
});

test("batch-b reuses the shared preflight route builder", () => {
  assert.deepEqual(
    batchBTest.preflightRoutePaths,
    buildPhase3BatchBPreflightPaths({
      scenarioId: "sc-e2e-batch-b",
      debateId: "debate-e2e-batch-b",
      branchA: "branch-a",
      branchB: "branch-b",
    }),
  );
});

test("batch-a mobile defaults use an explicit touch/mobile context", () => {
  assert.equal(batchATest.mobileContextDefaults.isMobile, true);
  assert.equal(batchATest.mobileContextDefaults.hasTouch, true);
  assert.ok(batchATest.mobileContextDefaults.userAgent);
  assert.ok(batchATest.mobileContextDefaults.deviceScaleFactor > 1);
});

test("batch-b mobile defaults use an explicit touch/mobile context", () => {
  assert.equal(batchBTest.mobileContextDefaults.isMobile, true);
  assert.equal(batchBTest.mobileContextDefaults.hasTouch, true);
  assert.ok(batchBTest.mobileContextDefaults.userAgent);
  assert.ok(batchBTest.mobileContextDefaults.deviceScaleFactor > 1);
});

test("batch-a full mode expands to a multi-browser surface matrix by default", () => {
  const runs = batchATest.buildSurfaceRuns({
    mode: "full",
    browser: "chromium",
    browserExplicitlySet: false,
  });
  assert.ok(runs.length >= 4);
  assert.deepEqual(
    [...new Set(runs.map((run) => run.browser))].sort(),
    ["chromium", "firefox", "webkit"],
  );
  assert.ok(runs.some((run) => run.mode === "mobile" && run.context.isMobile && run.context.hasTouch));
});

test("batch-b full mode expands to a multi-browser surface matrix by default", () => {
  const runs = batchBTest.buildSurfaceRuns({
    mode: "full",
    browser: "chromium",
    browserExplicitlySet: false,
  });
  assert.ok(runs.length >= 4);
  assert.deepEqual(
    [...new Set(runs.map((run) => run.browser))].sort(),
    ["chromium", "firefox", "webkit"],
  );
  assert.ok(runs.some((run) => run.mode === "mobile" && run.context.isMobile && run.context.hasTouch));
});

test("batch-a graph contract includes pan zoom and fit-view coverage", () => {
  assert.deepEqual(
    batchATest.requiredGraphInteractionSteps,
    [
      "graph-pan-drag-changes-viewport",
      "graph-zoom-controls-change-scale",
      "graph-fit-view-resets-viewport",
    ],
  );
});

test("batch-b graph contract includes pan zoom fit-view and page scroll-through coverage", () => {
  assert.deepEqual(
    batchBTest.requiredGraphInteractionSteps,
    [
      "argument-map-pan-drag-changes-viewport",
      "argument-map-zoom-controls-change-scale",
      "argument-map-fit-view-resets-viewport",
      "argument-map-page-scroll-through-works",
    ],
  );
});

test("batch-a viewport parser understands translate + scale transforms", () => {
  assert.deepEqual(
    batchATest.parseViewportTransform("translate(-164.5px, 72.25px) scale(1.125)"),
    { scale: 1.125, translateX: -164.5, translateY: 72.25 },
  );
});

test("batch-b viewport parser understands translate3d + scale transforms", () => {
  assert.deepEqual(
    batchBTest.parseViewportTransform("translate3d(48px, -96px, 0px) scale(0.85)"),
    { scale: 0.85, translateX: 48, translateY: -96 },
  );
});

test("batch-c exports the ResultView graph integration contract", () => {
  assert.equal(batchCTest.resultGraphRoutePath, "/result/sc-e2e-resume");
  assert.deepEqual(
    batchCTest.resultGraphIntegrationSteps,
    [
      "result-causal-graph-link-visible",
      "result-faction-timeline-visible",
      "result-faction-timeline-default-branch-requested",
      "result-faction-timeline-branch-switches",
    ],
  );
});

test("release signoff preflights the union of phase3 graph routes before running graph suites", () => {
  assert.deepEqual(
    releaseSignoffTest.buildGraphPreflightPaths(),
    [
      ...buildPhase3BatchAPreflightPaths("sc-e2e-causal-001"),
      ...buildPhase3BatchBPreflightPaths({
        scenarioId: "sc-e2e-batch-b",
        debateId: "debate-e2e-batch-b",
        branchA: "branch-a",
        branchB: "branch-b",
      }),
    ],
  );
});

test("release signoff includes batch-c result graph coverage", () => {
  assert.ok(releaseSignoffTest.graphE2EStepIds.includes("phase3c_result_graphs"));
});

test("release signoff propagates headless mode to round 7 graph live suites", () => {
  const specs = releaseSignoffTest.buildRound7GraphLiveStepSpecs(
    "http://127.0.0.1:18928",
    true,
    "output/e2e/release-check",
  );

  for (const spec of specs) {
    assert.ok(
      spec.commandArgs.includes("--headless"),
      `${spec.id} should run browser automation headless in CI`,
    );
    assert.ok(
      spec.commandArgs.includes("--output-dir"),
      `${spec.id} should write artifacts under the release signoff output root`,
    );
    assert.equal(spec.artifactDir, `output/e2e/release-check/${spec.id}`);
    assert.equal(spec.resultFile, `output/e2e/release-check/${spec.id}/result.json`);
  }
});

test("release signoff includes the graph-focused vitest gate", () => {
  assert.deepEqual(
    releaseSignoffTest.buildGraphFocusedVitestArgs(),
    [
      "test",
      "--",
      "--run",
      ...releaseSignoffTest.graphFocusedVitestTests,
    ],
  );
  assert.deepEqual(
    releaseSignoffTest.graphFocusedVitestTests,
    [
      "src/lib/manualChunks.test.ts",
      "src/lib/performanceBudgets.test.ts",
      "src/lib/exportValidation.test.ts",
      "src/components/ArgumentMap.test.tsx",
      "src/components/FactionTimeline.test.tsx",
      "src/components/GraphNodeCard.test.tsx",
      "src/components/NodeDetailPanel.test.tsx",
      "src/pages/CausalReviewView.test.tsx",
      "src/pages/ReplayEmptyState.test.tsx",
      "src/pages/ResultView.test.tsx",
      "src/scripts/releaseSignoff.test.ts",
      "src/i18n/locales.test.ts",
    ],
  );
});

test("roundtable desktop drag targets the source branch seat", () => {
  assert.equal(
    resolveRoundtableDragTargetTestId(" branch-b "),
    "roundtable-seat-slot-branch-b",
  );
  assert.throws(
    () => resolveRoundtableDragTargetTestId(""),
    /missing source branch/i,
  );
});

test("ws contract probe distinguishes first-frame auth hardening mode", () => {
  assert.deepEqual(
    classifyWsAuthHardeningProbe({ closed: true, code: 4001 }),
    {
      enabled: true,
      detail: "invalid first auth frame closed with 4001",
    },
  );
  assert.equal(
    classifyWsAuthHardeningProbe({ closed: true, code: 1006 }).enabled,
    false,
  );
  assert.equal(
    classifyWsAuthHardeningProbe({ closed: false }).enabled,
    false,
  );
});
