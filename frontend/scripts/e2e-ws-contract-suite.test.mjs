import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTH_FRAME_MAX_BYTES,
  EXPECTED_AUTH_FRAME_NUMBER,
  MAX_WS_PER_SCENARIO,
  PERMANENT_CLOSE_CODES,
  RECONNECTABLE_CLOSE_CODES,
  buildOversizeAuthFrame,
  classifyCloseCode,
  describeFirstFrameAssertion,
  parseAuthFrame,
  shouldReconnectOnClose,
  summarizeCaseResults,
} from "./e2e-ws-contract-suite.mjs";

test("parseAuthFrame accepts well-formed auth frames with empty token", () => {
  const result = parseAuthFrame(JSON.stringify({ type: "auth", token: "" }));
  assert.equal(result.ok, true);
  assert.equal(result.frame.type, "auth");
  assert.equal(result.frame.token, "");
});

test("parseAuthFrame accepts non-empty token strings", () => {
  const result = parseAuthFrame(JSON.stringify({ type: "auth", token: "abc.def.ghi" }));
  assert.equal(result.ok, true);
  assert.equal(result.frame.token, "abc.def.ghi");
});

test("parseAuthFrame rejects non-string payloads", () => {
  const result = parseAuthFrame(42);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a string/i);
});

test("parseAuthFrame rejects invalid JSON", () => {
  const result = parseAuthFrame("not json");
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid JSON/i);
});

test("parseAuthFrame rejects wrong type field", () => {
  const result = parseAuthFrame(JSON.stringify({ type: "resync", token: "" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /type="auth"/);
});

test("parseAuthFrame rejects null frame", () => {
  const result = parseAuthFrame(JSON.stringify(null));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not an object/);
});

test("parseAuthFrame rejects frame without token string", () => {
  const result = parseAuthFrame(JSON.stringify({ type: "auth" }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /token must be a string/);
});

test("classifyCloseCode marks 4001 and 4404 as permanent", () => {
  assert.equal(classifyCloseCode(4001), "permanent");
  assert.equal(classifyCloseCode(4404), "permanent");
});

test("classifyCloseCode marks 1006 as reconnectable", () => {
  assert.equal(classifyCloseCode(1006), "reconnectable");
});

test("classifyCloseCode marks 1000 as normal", () => {
  assert.equal(classifyCloseCode(1000), "normal");
});

test("shouldReconnectOnClose honors the hook reconnect policy", () => {
  assert.equal(shouldReconnectOnClose(4001), false);
  assert.equal(shouldReconnectOnClose(4404), false);
  assert.equal(shouldReconnectOnClose(1000), false);
  assert.equal(shouldReconnectOnClose(1006), true);
  assert.equal(shouldReconnectOnClose(1013), true);
});

test("buildOversizeAuthFrame exceeds the 64KB server limit", () => {
  const frame = buildOversizeAuthFrame();
  assert.ok(Buffer.byteLength(frame) > AUTH_FRAME_MAX_BYTES);
});

test("buildOversizeAuthFrame honors an explicit target byte size", () => {
  const frame = buildOversizeAuthFrame(AUTH_FRAME_MAX_BYTES + 512);
  assert.ok(Buffer.byteLength(frame) >= AUTH_FRAME_MAX_BYTES + 512);
});

test("describeFirstFrameAssertion surfaces frameNumber and payload", () => {
  const message = describeFirstFrameAssertion({
    frameNumber: 1,
    framePayload: '{"type":"auth","token":""}',
    expected: '{"type":"auth","token":"<string>"}',
    actual: "ok",
  });
  assert.match(message, /frameNumber=1/);
  assert.match(message, /framePayload=/);
  assert.match(message, /expected=/);
  assert.match(message, /actual=/);
});

test("summarizeCaseResults counts pass fail and skip", () => {
  const summary = summarizeCaseResults([
    { status: "passed" },
    { status: "passed" },
    { status: "failed" },
    { status: "skipped" },
  ]);
  assert.deepEqual(summary, { total: 4, passed: 2, skipped: 1, failed: 1 });
});

test("constants match the documented contract", () => {
  assert.equal(MAX_WS_PER_SCENARIO, 50);
  assert.equal(AUTH_FRAME_MAX_BYTES, 65536);
  assert.equal(EXPECTED_AUTH_FRAME_NUMBER, 1);
  assert.ok(PERMANENT_CLOSE_CODES.has(4001));
  assert.ok(PERMANENT_CLOSE_CODES.has(4404));
  assert.ok(RECONNECTABLE_CLOSE_CODES.has(1006));
});
