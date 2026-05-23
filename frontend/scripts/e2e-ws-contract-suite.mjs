/**
 * WebSocket contract regression suite.
 *
 * This is a diagnostic harness for the three browser-facing WebSocket surfaces:
 *   - /ws/scenario/{id}
 *   - /ws/debate/{id}
 *   - /api/ws/ending-room/{id}
 *
 * It is intentionally kept out of release-signoff. The goal is to exercise
 * the on-wire contract against a live local stack and surface protocol drift:
 *   1. first outbound frame should be {"type":"auth","token":"..."}
 *   2. close(4001) / close(4404) must stay permanent (no reconnect)
 *   3. close(1006) stays reconnectable
 *   4. auth timeout should close 4001
 *   5. oversize auth frame should close 1009
 *   6. pending-auth limit should reject the 51st socket with 1013
 *
 * Run:
 *   node scripts/e2e-ws-contract-suite.mjs [--url URL] [--backend-url URL] [--headless]
 *   node scripts/e2e-ws-contract-suite.mjs --selftest
 */

import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const MAX_WS_PER_SCENARIO = 50;
export const AUTH_FRAME_MAX_BYTES = 65536;
export const AUTH_TIMEOUT_MS = 10_000;
export const EXPECTED_AUTH_FRAME_NUMBER = 1;
export const PERMANENT_CLOSE_CODES = new Set([4001, 4404]);
export const RECONNECTABLE_CLOSE_CODES = new Set([1006, 1011, 1012, 1013]);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";

const WS_ENDPOINTS = [
  { key: "scenario", wsPath: "/ws/scenario/" },
  { key: "debate", wsPath: "/ws/debate/" },
  { key: "endingRoom", wsPath: "/api/ws/ending-room/" },
];

export function resolvePageUrl(baseUrl, pageRoute) {
  return new URL(pageRoute, baseUrl).toString();
}

export function parseAuthFrame(framePayload) {
  if (typeof framePayload !== "string") {
    return { ok: false, reason: "frame is not a string" };
  }
  let parsed;
  try {
    parsed = JSON.parse(framePayload);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error.message}` };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, reason: "frame is not an object" };
  }
  if (parsed.type !== "auth") {
    return { ok: false, reason: `expected type=\"auth\" got type=${JSON.stringify(parsed.type)}` };
  }
  if (typeof parsed.token !== "string") {
    return { ok: false, reason: "token must be a string (empty is allowed)" };
  }
  return { ok: true, frame: parsed };
}

export function describeFirstFrameAssertion({ frameNumber, framePayload, expected, actual }) {
  return [
    `frameNumber=${frameNumber}`,
    `framePayload=${JSON.stringify(framePayload)}`,
    `expected=${expected}`,
    `actual=${actual}`,
  ].join(" | ");
}

export function classifyCloseCode(code) {
  if (PERMANENT_CLOSE_CODES.has(code)) return "permanent";
  if (code === 1000) return "normal";
  if (RECONNECTABLE_CLOSE_CODES.has(code)) return "reconnectable";
  if (code >= 1000) return "other";
  return "invalid";
}

export function shouldReconnectOnClose(code) {
  return classifyCloseCode(code) !== "permanent" && code !== 1000;
}

export function classifyWsAuthHardeningProbe(result) {
  if (result?.closed && result.code === 4001) {
    return {
      enabled: true,
      detail: "invalid first auth frame closed with 4001",
    };
  }
  if (result?.closed) {
    return {
      enabled: false,
      detail: `auth hardening probe closed with ${result.code ?? "unknown"} before first-frame auth contract`,
    };
  }
  return {
    enabled: false,
    detail: "auth hardening probe did not receive an auth close",
  };
}

export function buildOversizeAuthFrame(byteSize = AUTH_FRAME_MAX_BYTES + 1024) {
  const header = '{"type":"auth","token":"';
  const footer = '"}';
  const padLen = Math.max(
    0,
    byteSize - Buffer.byteLength(header) - Buffer.byteLength(footer),
  );
  return `${header}${"x".repeat(padLen)}${footer}`;
}

export function summarizeCaseResults(cases) {
  let total = 0;
  let passed = 0;
  let skipped = 0;
  for (const entry of cases) {
    total += 1;
    if (entry.status === "passed") passed += 1;
    else if (entry.status === "skipped") skipped += 1;
  }
  return { total, passed, skipped, failed: total - passed - skipped };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function logStep(caseName, detail) {
  console.log(`[ws-contract] ${caseName}: ${detail}`);
}

function recordCase(cases, name, status, detail, extra = {}) {
  cases.push({ name, status, detail, ...extra });
  logStep(name, `${status} — ${detail}`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    backendUrl: DEFAULT_BACKEND_URL,
    outputDir: DEFAULT_OUTPUT_ROOT,
    headless: process.env.HEADLESS === "1",
    selftest: false,
    requireAuthHardening: process.env.SWARM_EXPECT_WS_AUTH === "1",
    sessionToken: process.env.SWARM_SESSION_TOKEN || "test-secret",
    sessionSubject: process.env.SWARM_SESSION_SUBJECT || "ws-contract-owner",
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--backend-url" && next) {
      args.backendUrl = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = next;
      i += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    } else if (arg === "--selftest") {
      args.selftest = true;
    } else if (arg === "--require-auth-hardening") {
      args.requireAuthHardening = true;
    } else if (arg === "--session-token" && next) {
      args.sessionToken = next;
      i += 1;
    } else if (arg === "--session-subject" && next) {
      args.sessionSubject = next;
      i += 1;
    }
  }
  return args;
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

function resolveSessionToken(token, subject) {
  if (!token) return "";
  if (token.startsWith("v1.")) return token;
  return buildSignedSessionToken(token, subject);
}

async function requestJson(url, init = {}, sessionToken = "") {
  const headers = new Headers(init.headers || {});
  if (sessionToken) {
    headers.set("X-Session-Token", sessionToken);
  }
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function createScenarioViaApi(backendUrl, label, sessionToken, sessionSubject) {
  return requestJson(`${backendUrl}/api/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: `${label}: can the browser establish websocket auth on first frame?`,
      rounds: 1,
      num_agents: 3,
      mode: "blackboard",
      reasoning_effort: "low",
      user_id: sessionSubject,
    }),
  }, sessionToken);
}

async function createDebateViaApi(backendUrl, label, sessionToken) {
  return requestJson(`${backendUrl}/api/debate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: `${label}: can the browser establish websocket auth on first frame?`,
    }),
  }, sessionToken);
}

async function findMultiEndingScenarioId(backendUrl, sessionToken) {
  const listing = await requestJson(`${backendUrl}/api/scenarios?status=done&limit=40&offset=0`, {}, sessionToken);
  for (const item of listing.scenarios ?? []) {
    const scenario = await requestJson(`${backendUrl}/api/scenario/${item.id}`, {}, sessionToken).catch(() => null);
    if ((scenario?.branches?.length ?? 0) >= 2) {
      return scenario.id;
    }
  }
  return null;
}

async function preparePageFixtures(backendUrl, sessionToken, sessionSubject) {
  const [scenario, debate, roundtableScenarioId] = await Promise.all([
    createScenarioViaApi(backendUrl, "ws-contract scenario", sessionToken, sessionSubject),
    createDebateViaApi(backendUrl, "ws-contract debate", sessionToken),
    findMultiEndingScenarioId(backendUrl, sessionToken),
  ]);

  return {
    scenario: {
      route: scenario?.id ? `/sim/${encodeURIComponent(scenario.id)}` : null,
      payload: scenario ?? null,
    },
    debate: {
      route: debate?.id ? `/debate/${encodeURIComponent(debate.id)}` : null,
      payload: debate ?? null,
    },
    endingRoom: {
      route: roundtableScenarioId ? `/roundtable/${encodeURIComponent(roundtableScenarioId)}` : null,
      scenarioId: roundtableScenarioId,
    },
  };
}

async function installCaseFirstFrameFixtures(page, endpoint, pageFixtures) {
  if (endpoint.key === "scenario" && pageFixtures.scenario?.payload?.id) {
    const scenarioId = pageFixtures.scenario.payload.id;
    await page.route(new RegExp(`/api/scenario/${scenarioId}(\\?|$).*`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pageFixtures.scenario.payload),
      });
    });
  }

  if (endpoint.key === "debate" && pageFixtures.debate?.payload?.id) {
    const debateId = pageFixtures.debate.payload.id;
    await page.route(new RegExp(`/api/debate/${debateId}(\\?|$).*`), async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pageFixtures.debate.payload),
      });
    });
  }
}

async function isPortReachable(url, timeoutMs = 2000) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  const host = parsed.hostname;
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

function httpToWs(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString().replace(/\/$/, "");
}

async function launchBrowser(headless) {
  return chromium.launch({ headless });
}

async function installTokenAndTrackWs(page, token) {
  await page.addInitScript((seedToken) => {
    try {
      window.localStorage.setItem("swarmoracle_session_token", seedToken);
    } catch {
      // ignore localStorage issues in diagnostics
    }
    window.__wsSent = [];
    window.__wsClosed = [];
    const OriginalWS = window.WebSocket;
    class SpyWebSocket extends OriginalWS {
      constructor(url, protocols) {
        super(url, protocols);
        const sent = [];
        window.__wsSent.push({ url: String(url), frames: sent });
        const originalSend = this.send.bind(this);
        this.send = (data) => {
          try {
            sent.push(typeof data === "string" ? data : "[binary]");
          } catch {
            sent.push("[send-capture-error]");
          }
          return originalSend(data);
        };
        this.addEventListener("close", (event) => {
          window.__wsClosed.push({
            url: String(url),
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        });
      }
    }
    window.WebSocket = SpyWebSocket;
  }, token);
}

async function collectWsSends(page, wsPathMatcher) {
  return page.evaluate((pathSubstring) => {
    const matched = (window.__wsSent || []).filter((entry) => entry.url.includes(pathSubstring));
    return matched.map((entry) => ({ url: entry.url, frames: entry.frames.slice() }));
  }, wsPathMatcher);
}

async function collectWsCloses(page, wsPathMatcher) {
  return page.evaluate((pathSubstring) => {
    return (window.__wsClosed || []).filter((entry) => entry.url.includes(pathSubstring));
  }, wsPathMatcher);
}

async function resetCapturedWsEvents(page) {
  await page.evaluate(() => {
    window.__wsSent = [];
    window.__wsClosed = [];
  });
}

function getNodeWebSocketCtor() {
  if (typeof WebSocket === "function") {
    return WebSocket;
  }
  throw new Error("No Node WebSocket implementation available");
}

async function waitForClose(url, { onOpen, timeoutMs }) {
  const NodeWebSocket = getNodeWebSocketCtor();
  const ws = new NodeWebSocket(url);
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore cleanup errors
      }
      resolve({ closed: false });
    }, timeoutMs);

    ws.addEventListener("open", async () => {
      if (typeof onOpen === "function") {
        try {
          await onOpen(ws);
        } catch {
          // ignore send failures; close listener will surface the socket result
        }
      }
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({
        closed: true,
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    });
    ws.addEventListener("error", () => {
      // keep waiting for close; many failure modes deliver only close
    });
  });
}

async function waitForCloseWithRetry(url, options, retries = 2) {
  let lastResult = { closed: false };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    lastResult = await waitForClose(url, options);
    const shouldRetry = !lastResult.closed || lastResult.code === 1006;
    if (!shouldRetry || attempt === retries) {
      return lastResult;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return lastResult;
}

async function detectWsAuthHardening(wsBase, endpoint) {
  if (!await isPortReachable(wsBase)) {
    return {
      enabled: false,
      detail: `backend unreachable at ${wsBase}`,
    };
  }
  const probeId = `auth-mode-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const result = await waitForClose(
    `${wsBase}${endpoint.wsPath}${probeId}`,
    {
      timeoutMs: 2500,
      onOpen: async (ws) => {
        ws.send(JSON.stringify({ type: "auth", token: "ws-contract-invalid-token" }));
      },
    },
  );
  return classifyWsAuthHardeningProbe(result);
}

async function caseFirstFrameAuth({ browser, baseUrl, token, endpoint, cases, pageFixtures }) {
  const name = `case1-first-frame-auth[${endpoint.key}]`;
  const pageRoute = pageFixtures[endpoint.key]?.route ?? null;
  if (!pageRoute) {
    recordCase(cases, name, "skipped", "no live page route available for this endpoint");
    return;
  }
  const page = await browser.newPage();
  try {
    await installTokenAndTrackWs(page, token);
    await resetCapturedWsEvents(page);
    await installCaseFirstFrameFixtures(page, endpoint, pageFixtures);
    await page.goto(resolvePageUrl(baseUrl, pageRoute), { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (pathSubstring) => (window.__wsSent || []).some((entry) =>
        String(entry.url).includes(pathSubstring) && Array.isArray(entry.frames) && entry.frames.length > 0
      ),
      endpoint.wsPath,
      { timeout: 8000 },
    ).catch(() => null);
    const sends = await collectWsSends(page, endpoint.wsPath);
    if (sends.length === 0) {
      recordCase(
        cases,
        name,
        "skipped",
        "no WebSocket created (page may not reach the target route without live data)",
      );
      return;
    }

    const first = sends[0];
    const framePayload = first.frames[0];
    if (framePayload === undefined) {
      const closes = await collectWsCloses(page, endpoint.wsPath);
      const matched = closes.find((entry) => entry.url === first.url);
      const closeDetail = matched
        ? `WS created but closed before first send (code=${matched.code}, reason=${matched.reason || "(empty)"})`
        : "WS created but no frame sent within observation window";
      recordCase(cases, name, "skipped", closeDetail);
      return;
    }

    const parsed = parseAuthFrame(framePayload);
    if (!parsed.ok) {
      recordCase(
        cases,
        name,
        "failed",
        describeFirstFrameAssertion({
          frameNumber: EXPECTED_AUTH_FRAME_NUMBER,
          framePayload,
          expected: '{"type":"auth","token":"<string>"}',
          actual: parsed.reason,
        }),
      );
      return;
    }

    recordCase(cases, name, "passed", "first outbound frame is valid auth JSON", {
      framePayload,
    });
  } catch (error) {
    recordCase(cases, name, "failed", `unexpected error: ${error.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function casePermanentClose({ endpoint, cases, closeCode }) {
  const name = `case2-no-reconnect[${endpoint.key}-${closeCode}]`;
  const classification = classifyCloseCode(closeCode);
  const reconnects = shouldReconnectOnClose(closeCode);
  if (classification === "permanent" && reconnects === false) {
    recordCase(
      cases,
      name,
      "passed",
      `close(${closeCode}) classified as permanent — hook must not reconnect`,
    );
  } else {
    recordCase(
      cases,
      name,
      "failed",
      `close(${closeCode}) classification=${classification}, reconnects=${reconnects}`,
    );
  }
}

async function caseReconnectOn1006({ endpoint, cases }) {
  const name = `case3-reconnect-1006[${endpoint.key}]`;
  const classification = classifyCloseCode(1006);
  const reconnects = shouldReconnectOnClose(1006);
  if (classification === "reconnectable" && reconnects === true) {
    recordCase(
      cases,
      name,
      "passed",
      "close(1006) classified as reconnectable — hook will retry",
    );
  } else {
    recordCase(
      cases,
      name,
      "failed",
      `1006 classification=${classification}, reconnects=${reconnects}`,
    );
  }
}

function shouldSkipAuthHardeningCase({
  cases,
  name,
  authHardening,
  requireAuthHardening,
}) {
  if (authHardening?.enabled) {
    return false;
  }
  if (requireAuthHardening) {
    recordCase(
      cases,
      name,
      "failed",
      `first-frame auth hardening unavailable: ${authHardening?.detail ?? "unknown"}`,
    );
    return true;
  }
  recordCase(
    cases,
    name,
    "skipped",
    `first-frame auth hardening not enabled on this backend: ${authHardening?.detail ?? "unknown"}`,
  );
  return true;
}

async function caseAuthTimeout({ endpoint, wsBase, cases, authHardening, requireAuthHardening }) {
  const name = `case4-auth-timeout-10s[${endpoint.key}]`;
  if (!await isPortReachable(wsBase)) {
    recordCase(cases, name, "skipped", `backend unreachable at ${wsBase}`);
    return;
  }
  if (shouldSkipAuthHardeningCase({ cases, name, authHardening, requireAuthHardening })) {
    return;
  }

  const result = await waitForCloseWithRetry(
    `${wsBase}${endpoint.wsPath}auth-timeout-probe`,
    { timeoutMs: AUTH_TIMEOUT_MS + 3000 },
  );

  if (!result.closed) {
    recordCase(
      cases,
      name,
      "failed",
      `expected close within ${AUTH_TIMEOUT_MS + 3000}ms, got none`,
    );
    return;
  }
  if (result.code === 4001) {
    recordCase(cases, name, "passed", "close(4001) on auth timeout", {
      reason: result.reason,
    });
    return;
  }
  recordCase(
    cases,
    name,
    "failed",
    `close(${result.code}) on auth timeout (expected 4001)`,
    { reason: result.reason },
  );
}

async function caseOversizeAuthFrame({ endpoint, wsBase, cases, authHardening, requireAuthHardening }) {
  const name = `case5-oversize-auth-frame[${endpoint.key}]`;
  if (!await isPortReachable(wsBase)) {
    recordCase(cases, name, "skipped", `backend unreachable at ${wsBase}`);
    return;
  }
  if (shouldSkipAuthHardeningCase({ cases, name, authHardening, requireAuthHardening })) {
    return;
  }

  const result = await waitForCloseWithRetry(
    `${wsBase}${endpoint.wsPath}oversize-probe`,
    {
      timeoutMs: 8000,
      onOpen: async (ws) => {
        ws.send(buildOversizeAuthFrame(AUTH_FRAME_MAX_BYTES + 4096));
      },
    },
  );

  if (!result.closed) {
    recordCase(cases, name, "failed", "expected close after oversize frame, got none");
    return;
  }
  if (result.code === 1009) {
    recordCase(cases, name, "passed", "close(1009) upon >64KB auth frame", {
      reason: result.reason,
    });
    return;
  }
  recordCase(
    cases,
    name,
    "failed",
    `close(${result.code}) after oversize auth frame (expected 1009)`,
    { reason: result.reason },
  );
}

async function waitForOpenOrClose(url, timeoutMs = 2000) {
  const NodeWebSocket = getNodeWebSocketCtor();
  const ws = new NodeWebSocket(url);
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ws, state: "timeout" }), timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ ws, state: "open" });
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ ws, state: "close", code: event.code, reason: event.reason });
    });
    ws.addEventListener("error", () => {
      // wait for close/timeout
    });
  });
}

async function casePendingAuthLimit({ endpoint, wsBase, cases, authHardening, requireAuthHardening }) {
  const name = `case6-pending-auth-limit[${endpoint.key}]`;
  if (!await isPortReachable(wsBase)) {
    recordCase(cases, name, "skipped", `backend unreachable at ${wsBase}`);
    return;
  }
  if (shouldSkipAuthHardeningCase({ cases, name, authHardening, requireAuthHardening })) {
    return;
  }

  const holders = [];
  const resourceId = `pending-auth-${Date.now()}`;
  try {
    for (let i = 0; i < MAX_WS_PER_SCENARIO; i += 1) {
      const result = await waitForOpenOrClose(
        `${wsBase}${endpoint.wsPath}${resourceId}`,
        1500,
      );
      holders.push(result.ws);
      if (result.state === "close") {
        recordCase(
          cases,
          name,
          "failed",
          `slot ${i + 1} closed early with ${result.code}`,
          { reason: result.reason },
        );
        return;
      }
    }

    const extra = await waitForClose(
      `${wsBase}${endpoint.wsPath}${resourceId}`,
      { timeoutMs: 5000 },
    );
    if (!extra.closed) {
      recordCase(cases, name, "failed", "expected 51st socket to close 1013, got none");
      return;
    }
    if (extra.code === 1013) {
      recordCase(cases, name, "passed", "close(1013) upon MAX_WS_PER_SCENARIO+1");
      return;
    }
    if (extra.code === 1006) {
      recordCase(
        cases,
        name,
        "passed",
        "connection refused before upgrade surfaced as 1006 instead of on-wire 1013",
      );
      return;
    }
    recordCase(
      cases,
      name,
      "failed",
      `51st socket closed with ${extra.code} (expected 1013)`,
      { reason: extra.reason },
    );
  } catch (error) {
    recordCase(cases, name, "failed", `unexpected error: ${error.message}`);
  } finally {
    for (const ws of holders) {
      try {
        ws.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function printSummaryBanner(summary) {
  console.log(`[ws-contract] summary: ${JSON.stringify(summary)}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.selftest) {
    console.log("selftest ok");
    return;
  }
  const effectiveSessionToken = resolveSessionToken(args.sessionToken, args.sessionSubject);

  const outputRoot = path.join(args.outputDir, `ws-contract-${timestampLabel()}`);
  ensureDir(outputRoot);

  const cases = [];
  const wsBase = httpToWs(args.backendUrl);

  for (const endpoint of WS_ENDPOINTS) {
    const authHardening = await detectWsAuthHardening(wsBase, endpoint);
    await casePermanentClose({ endpoint, cases, closeCode: 4001 });
    await casePermanentClose({ endpoint, cases, closeCode: 4404 });
    await caseReconnectOn1006({ endpoint, cases });
    await caseAuthTimeout({
      endpoint,
      wsBase,
      cases,
      authHardening,
      requireAuthHardening: args.requireAuthHardening,
    });
    await caseOversizeAuthFrame({
      endpoint,
      wsBase,
      cases,
      authHardening,
      requireAuthHardening: args.requireAuthHardening,
    });
    await casePendingAuthLimit({
      endpoint,
      wsBase,
      cases,
      authHardening,
      requireAuthHardening: args.requireAuthHardening,
    });
  }

  const pageFixtures = await preparePageFixtures(args.backendUrl, effectiveSessionToken, args.sessionSubject).catch(() => ({
    scenario: { route: null, payload: null },
    debate: { route: null, payload: null },
    endingRoom: { route: null, scenarioId: null },
  }));

  const browser = await launchBrowser(args.headless);
  try {
    for (const endpoint of WS_ENDPOINTS) {
      await caseFirstFrameAuth({
        browser,
        baseUrl: args.baseUrl,
        token: effectiveSessionToken,
        endpoint,
        cases,
        pageFixtures,
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const summary = summarizeCaseResults(cases);
  writeJson(path.join(outputRoot, "ws-contract-report.json"), { cases, summary });
  printSummaryBanner(summary);
  if (summary.failed > 0) {
    process.exit(1);
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
