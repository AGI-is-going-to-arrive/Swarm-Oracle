import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import {
  buildFixtureWsInitScript,
  createFixtureStore,
  FIXTURE_SCENARIO_IDS,
  resolveApiFixture,
} from "./e2eFixtureNet.mjs";
import { __test__ as releaseSignoffTest } from "./release-signoff.mjs";

test("resolveApiFixture fail-closes wrong HTTP methods instead of returning 200", () => {
  const store = createFixtureStore();
  const scenarioId = FIXTURE_SCENARIO_IDS.governance;
  const wrongMethodProbes = [
    { method: "POST", pathname: "/api/scenarios", search: "" },
    { method: "DELETE", pathname: "/api/capabilities", search: "" },
    { method: "GET", pathname: `/api/scenario/${scenarioId}/predict`, search: "" },
    { method: "GET", pathname: "/api/replay-artifact", search: "" },
    { method: "POST", pathname: `/api/scenario/${scenarioId}/story`, search: "" },
  ];

  for (const probe of wrongMethodProbes) {
    const resolved = resolveApiFixture(store, probe);
    assert.notEqual(
      resolved?.status,
      200,
      `${probe.method} ${probe.pathname} must not be served as a successful fixture response`,
    );
    assert.ok(
      resolved === null || resolved.defer === true,
      `${probe.method} ${probe.pathname} must fall through to fail-closed handling`,
    );
  }
});

test("FixtureWebSocket records escapes through a persistent binding across navigation", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const wsEscapes = [];

  try {
    await page.route("http://fixture.local/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>fixture</body></html>",
    }));
    await page.exposeBinding("__recordFixtureWsEscape", (_source, entry) => {
      wsEscapes.push(entry);
    });

    const store = createFixtureStore();
    const ws = buildFixtureWsInitScript([
      { scenario: store.getScenario(FIXTURE_SCENARIO_IDS.governance), complete: true },
    ]);
    await page.addInitScript(ws.fn, ws.arg);
    await page.goto("http://fixture.local/");

    await page.evaluate(() => {
      const socket = new WebSocket("/ws/debate/escaped");
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", () => {});
    });
    await page.waitForTimeout(50);
    assert.equal(wsEscapes.length, 1);
    assert.equal(wsEscapes[0].pathname, "/ws/debate/escaped");

    await page.goto("http://fixture.local/after-navigation");
    const windowEscapesAfterNavigation = await page.evaluate(() => window.__fixtureWsEscapes__ ?? []);

    assert.deepEqual(windowEscapesAfterNavigation, []);
    assert.equal(wsEscapes.length, 1, "Node-side recorder must retain pre-navigation WS escapes");
  } finally {
    await browser.close();
  }
});

test("FixtureWebSocket fail-closes cross-origin backend-style /ws URLs", async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const wsEscapes = [];

  try {
    await page.route("http://fixture.local/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>fixture</body></html>",
    }));
    await page.exposeBinding("__recordFixtureWsEscape", (_source, entry) => {
      wsEscapes.push(entry);
    });

    const store = createFixtureStore();
    const ws = buildFixtureWsInitScript([
      { scenario: store.getScenario(FIXTURE_SCENARIO_IDS.governance), complete: true },
    ]);
    await page.addInitScript(ws.fn, ws.arg);
    await page.goto("http://fixture.local/");

    await page.evaluate(() => {
      const socket = new WebSocket("ws://127.0.0.1:9/ws/scenario/not-fixtured");
      socket.addEventListener("error", () => {});
      socket.addEventListener("close", () => {});
    });
    await page.waitForTimeout(50);

    assert.equal(wsEscapes.length, 1);
    assert.equal(wsEscapes[0].pathname, "/ws/scenario/not-fixtured");
  } finally {
    await browser.close();
  }
});

test("release-signoff fixture suite specs use a blackhole backend URL", () => {
  const specs = releaseSignoffTest.buildFixtureSuiteStepSpecs(
    "http://127.0.0.1:18928",
    "/tmp/release-signoff",
    true,
    "scenario-42",
  );

  assert.deepEqual(specs.map((spec) => spec.id), ["corners", "mobile"]);
  for (const spec of specs) {
    assert.equal(spec.env.SWARM_E2E_FIXTURE_MODE, "1");
    assert.equal(spec.env.SWARM_BACKEND_URL, "http://127.0.0.1:9");
    assert.equal(spec.commandArgs.includes("--headless"), true);
    assert.equal(spec.commandArgs.includes("--scenario-id"), true);
    assert.equal(spec.commandArgs.includes("scenario-42"), true);
  }
});
