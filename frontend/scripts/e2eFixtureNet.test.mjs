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
import { __test__ as conversationTest } from "./e2e-node-conversation-live.mjs";

test("fixture capabilities enable the You-vs-Oracle prediction surface", () => {
  const capabilities = createFixtureStore().capabilitiesFixture();

  assert.deepEqual(capabilities.you_vs_oracle, {
    enabled: true,
    version: "1.0.0",
    server_only: false,
    degraded_mode: null,
  });
});

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

test("director-state fixture rejects terminal writes with the backend error contract", () => {
  const store = createFixtureStore();
  const terminalId = FIXTURE_SCENARIO_IDS.governance;
  const activeId = FIXTURE_SCENARIO_IDS.governanceLive;

  const terminalWrite = resolveApiFixture(store, {
    method: "PUT",
    pathname: `/api/campaign/scenario/${terminalId}/director-state`,
    search: "",
  });
  const activeWrite = resolveApiFixture(store, {
    method: "PUT",
    pathname: `/api/campaign/scenario/${activeId}/director-state`,
    search: "",
  });

  assert.equal(terminalWrite.status, 409);
  assert.equal(terminalWrite.json.detail.code, "DIRECTOR_STATE_CLOSED");
  assert.equal(terminalWrite.mutate, undefined);
  assert.equal(activeWrite.status, 200);
  assert.equal(activeWrite.mutate, "director");
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

test("release-signoff executes its focused and WS contract tests", () => {
  assert.equal(
    releaseSignoffTest.graphFocusedVitestTests.includes("src/scripts/releaseSignoff.test.ts"),
    true,
  );
  assert.equal(
    releaseSignoffTest.scriptContractTests.includes("scripts/e2e-ws-contract-suite.test.mjs"),
    true,
  );
});

function conversationStartBody() {
  return {
    scenario_id: conversationTest.FIXTURE_SCENARIO_ID,
    origin_node_id: conversationTest.NODE_ID,
    origin_node_type: "event",
    origin_branch_id: conversationTest.BRANCH_ID,
    origin_round_number: 1,
    first_user_content: "First question",
  };
}

test("conversation suite rejects live mode and keeps mobile context options", () => {
  assert.throws(() => conversationTest.assertOfflineMode({ SWARM_E2E_MODE: "live" }),
    /explicit real SWARM_E2E_SCENARIO_ID/);
  assert.throws(() => conversationTest.assertOfflineMode({
    SWARM_E2E_MODE: "live", SWARM_E2E_SCENARIO_ID: "real-scenario",
  }), /offline-only/);
  const args = conversationTest.parseArgs(["node", "script", "full", "--browser", "webkit", "--headless"]);
  const runs = conversationTest.buildSurfaceRuns(args);
  assert.equal(runs.length, 2);
  assert.equal(runs[1].context.isMobile, true);
  assert.equal(runs[1].context.hasTouch, true);
  assert.equal(runs[1].browser, "webkit");
  assert.equal(conversationTest.TRIGGER_SOURCES.some(source => source.key === "argument_map"), false);
});

test("conversation fixture rejects mixed anchors, wrong methods and unplanned streams", () => {
  const fixture = conversationTest.createConversationFixtureStore();
  assert.equal(fixture.request({ method: "POST", pathname: "/api/conversation/start",
    body: { ...conversationStartBody(), origin_round_number: 999 } }).status, 409);
  assert.equal(fixture.threads.size, 0);
  const start = fixture.request({ method: "POST", pathname: "/api/conversation/start", body: conversationStartBody() });
  assert.equal(start.status, 200);
  const path = `/api/conversation/${start.json.thread_id}`;
  assert.equal(fixture.request({ method: "DELETE", pathname: path }).status, 409);
  assert.equal(fixture.request({ method: "POST", pathname: `${path}/turn`,
    body: { user_content: "First question" } }).status, 409);
  assert.equal(fixture.violations.length, 3);
});

test("conversation fixture bootstrap and follow-up preserve two ordered pairs", () => {
  const fixture = conversationTest.createConversationFixtureStore();
  const start = fixture.request({ method: "POST", pathname: "/api/conversation/start", body: conversationStartBody() });
  const pathname = `/api/conversation/${start.json.thread_id}`;
  for (const question of ["First question", "Second question"]) {
    fixture.plans.push({ question, kind: "complete", parts: [`Reply to ${question}`, "."] });
    const response = fixture.request({ method: "POST", pathname: `${pathname}/turn`, body: { user_content: question } });
    assert.equal(response.status, 200);
    assert.ok(response.stream.events.some(frame => frame.delay > 0));
    for (const frame of response.stream.events) fixture.record(frame);
  }
  const restored = fixture.request({ method: "GET", pathname }).json;
  assert.deepEqual(restored.turns.map(turn => turn.sequence), [1, 2, 3, 4]);
  assert.deepEqual(restored.turns.map(turn => turn.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(restored.turns.map(turn => turn.status), ["done", "done", "done", "done"]);
  assert.equal(restored.turns[3].content, "Reply to Second question.");
  assert.equal(restored.active_turn_id, null);
  assert.deepEqual(fixture.violations, []);
});

test("conversation fixture abort preserves prefix and rejects late stream data", () => {
  const fixture = conversationTest.createConversationFixtureStore();
  const start = fixture.request({ method: "POST", pathname: "/api/conversation/start", body: conversationStartBody() });
  const pathname = `/api/conversation/${start.json.thread_id}`;
  fixture.plans.push({ question: "First question", kind: "stop", parts: ["visible prefix", "late"] });
  const response = fixture.request({ method: "POST", pathname: `${pathname}/turn`, body: { user_content: "First question" } });
  fixture.record(response.stream.events[0]);
  fixture.record(response.stream.events[1]);
  assert.equal(fixture.request({ method: "DELETE", pathname: `${pathname}/active` }).json.aborted, true);
  const restored = fixture.request({ method: "GET", pathname }).json;
  assert.equal(restored.turns[1].content, "visible prefix");
  assert.equal(restored.turns[1].status, "aborted");
  fixture.record(response.stream.events[2]);
  assert.equal(fixture.violations.length, 1);
  assert.equal(fixture.request({ method: "GET", pathname }).json.turns[1].content, "visible prefix");
});

test("conversation fixture separates anonymous and signed-owner threads", () => {
  const fixture = conversationTest.createConversationFixtureStore();
  const anonymous = fixture.request({ method: "POST", pathname: "/api/conversation/start", body: conversationStartBody() }).json;
  const ownerUserId = conversationTest.FIXTURE_OWNER_ID;
  assert.equal(fixture.request({ method: "GET", pathname: `/api/conversation/${anonymous.thread_id}`, ownerUserId }).status, 404);
  assert.deepEqual(fixture.request({ method: "GET", pathname: `/api/scenario/${conversationTest.FIXTURE_SCENARIO_ID}/conversations`, ownerUserId }).json.items, []);
  const owned = fixture.request({ method: "POST", pathname: "/api/conversation/start", body: conversationStartBody(), ownerUserId }).json;
  assert.equal(owned.owner_user_id, ownerUserId);
  assert.notEqual(owned.thread_id, anonymous.thread_id);
  const restored = fixture.request({ method: "GET", pathname: `/api/scenario/${conversationTest.FIXTURE_SCENARIO_ID}/conversations`, ownerUserId }).json;
  assert.deepEqual(restored.items.map(thread => thread.thread_id), [owned.thread_id]);
  assert.deepEqual(fixture.violations, []);
});
