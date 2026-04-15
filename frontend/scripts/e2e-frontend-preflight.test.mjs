import assert from "node:assert/strict";
import test from "node:test";

import { __test__ as batchATest } from "./e2e-phase3-batch-a.mjs";
import { __test__ as batchBTest } from "./e2e-phase3-batch-b.mjs";
import { __test__ as releaseSignoffTest } from "./release-signoff.mjs";
import {
  assertFrontendRoutesReady,
  buildPhase3BatchAPreflightPaths,
  buildPhase3BatchBPreflightPaths,
} from "./lib/frontendPreflight.mjs";

function buildHtml(entryPath) {
  return `<!doctype html><html><head><script type="module" crossorigin src="${entryPath}"></script></head><body><div id="root"></div></body></html>`;
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
  ]);

  const result = await assertFrontendRoutesReady({
    baseUrl: "http://127.0.0.1:18928",
    routePaths: ["/", "/agents/new"],
    fetchImpl: async (url) => responses.get(url) ?? createResponse(404, "missing", "text/plain"),
  });

  assert.equal(result.entryAssetPath, "/assets/index-a.js");
  assert.deepEqual(
    result.checkedRoutes.map((route) => route.path),
    ["/", "/agents/new"],
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

test("batch-a reuses the shared preflight route builder", () => {
  assert.deepEqual(
    batchATest.preflightRoutePaths,
    buildPhase3BatchAPreflightPaths("sc-e2e-causal-001"),
  );
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
