import assert from "node:assert/strict";
import test from "node:test";

import { __test__ } from "./e2e-prediction-modal.mjs";

test("prediction preview fixture serves every API used during initial render", () => {
  const capabilities = __test__.resolveFixtureRequest({
    method: "GET",
    pathname: "/api/capabilities",
  });
  const predictions = __test__.resolveFixtureRequest({
    method: "GET",
    pathname: "/api/scenario/sc-e2e-prediction/predictions",
  });

  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.json, __test__.CAPABILITIES_FIXTURE);
  assert.deepEqual(predictions, { status: 200, json: [] });
});

test("prediction preview fixture fail-closes unexpected API paths and methods", () => {
  const unexpectedRequests = [
    { method: "POST", pathname: "/api/capabilities" },
    { method: "POST", pathname: "/api/scenario/sc-e2e-prediction/predictions" },
    { method: "GET", pathname: "/api/scenario/another-scenario/predictions" },
    { method: "GET", pathname: "/api/health" },
  ];

  for (const request of unexpectedRequests) {
    assert.equal(__test__.resolveFixtureRequest(request), null, `${request.method} ${request.pathname}`);
  }
});

test("prediction preview browser installer records and fulfills unexpected APIs without network escape", async () => {
  const registrations = [];
  const page = {
    route: async (pattern, handler) => {
      registrations.push({ pattern, handler });
    },
  };
  const state = { unhandledApiRequests: [] };

  await __test__.installFixtures(page, state);
  assert.equal(registrations.length, 2);

  let fellBack = false;
  await registrations[1].handler({
    request: () => ({ method: () => "GET", url: () => "http://fixture.local/api/health" }),
    fallback: () => { fellBack = true; },
  });
  assert.equal(fellBack, true);

  let response = null;
  await registrations[0].handler({
    request: () => ({ method: () => "GET", url: () => "http://fixture.local/api/health" }),
    fulfill: (value) => { response = value; },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(state.unhandledApiRequests, [{
    method: "GET",
    url: "http://fixture.local/api/health",
  }]);
});
