#!/usr/bin/env node
/**
 * Offline browser behavior suite for node conversation. Despite the historical
 * filename, this does not call a provider. Workbench and CausalReview are tested
 * through real graph cards. Workbench requires detail then explicit Ask;
 * standalone CausalReview opens its single context sheet directly. ArgumentMap has no general
 * scenario-chat binding; KG canvas and FactionTimeline are not claimed here.
 *
 * node scripts/e2e-node-conversation-live.mjs [desktop|mobile|full]
 *   [--url URL] [--browser chromium|firefox|webkit] [--headless] [--output-dir DIR]
 *
 * API/WS/Node guards fail closed. A bounded browser ReadableStream supplies
 * incremental SSE; the fixture ledger persists turns across browser reloads.
 * This proves frontend consumption, not backend durability or provider quality.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, firefox, webkit } from "playwright";
import { closePlaywrightBrowser } from "./playwrightTeardown.mjs";
import {
  buildFixtureWsInitScript,
  createFixtureStore,
  FIXTURE_SCENARIO_IDS,
  installApiFixtures,
  installNodeFetchFixture,
} from "./e2eFixtureNet.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
const FIXTURE_SCENARIO_ID = FIXTURE_SCENARIO_IDS.governance;
const FIXTURE_THREAD_ID = "thread-e2e-1";
const FIXTURE_OWNER_ID = "offline-conversation-owner-b";
// Deliberately unsigned test data. Network guards prevent it reaching a backend.
const FIXTURE_SESSION_TOKEN = `v1.${Buffer.from(JSON.stringify({ sub: FIXTURE_OWNER_ID })).toString("base64url")}.offline-fixture`;
const BRANCH_ID = "fx-gov-branch-a";
const NODE_ID = "conversation-event-1";
const NODE_LABEL = "Audit officer requests a public hearing";
const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const { defaultBrowserType: _unused, ...MOBILE_CTX_DEFAULTS } = devices["iPhone 13"];
const CAPABILITIES_FIXTURE = {
  ...createFixtureStore().capabilitiesFixture(),
  agent_conversation: { enabled: true },
  causal_graph: { enabled: true },
  kg_explorer: { enabled: true },
  llm_configured: true,
  llm_static_configured: true,
};
const TURN_ERROR_CODES = ["LLM_5XX", "STREAM_TIMEOUT"];
const TRIGGER_SOURCES = [
  { key: "workbench", route: `/workbench/${FIXTURE_SCENARIO_ID}?view=graph`, inspectFirst: true },
  { key: "causal_review", route: `/sim/${FIXTURE_SCENARIO_ID}/causal-map`, inspectFirst: false },
];
const GRAPH_FIXTURE = {
  id: "conversation-snapshot", available_branches: [BRANCH_ID],
  nodes: [
    {
      id: NODE_ID, key: "event-1", type: "event", label: NODE_LABEL, round: 1,
      payload: {
        branch_id: BRANCH_ID, agent_id: "fx-gov-agent-2", agent_name: "Audit officer",
        content: "The audit officer asks for public evidence before the court decides.",
      },
    },
    {
      id: "conversation-event-2", key: "event-2", type: "event",
      label: "Court schedules the hearing", round: 2,
      payload: { branch_id: BRANCH_ID, content: "The court schedules a public hearing." },
    },
  ],
  edges: [{
    id: "conversation-edge", source: NODE_ID, target: "conversation-event-2",
    type: "caused", label: "caused", weight: 1,
    evidence: { confidence_tier: "high", source_ref: "message-1", source_round_number: 1,
      detail: "The request precedes the scheduling decision." },
  }],
};

function timestampLabel() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
function parseArgs(argv) {
  const args = { mode: "desktop", baseUrl: DEFAULT_BASE_URL, browser: "chromium",
    browserExplicitlySet: false, outputDir: "", headless: process.env.HEADLESS === "1" };
  let i = 2;
  if (argv[i] && !argv[i].startsWith("--")) args.mode = argv[i++];
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--headless") args.headless = true;
    else if (["--url", "--browser", "--output-dir"].includes(arg) && argv[i + 1]) {
      const field = { "--url": "baseUrl", "--browser": "browser", "--output-dir": "outputDir" }[arg];
      args[field] = argv[++i];
      if (arg === "--browser") args.browserExplicitlySet = true;
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  assert.ok(["desktop", "mobile", "full"].includes(args.mode), "mode must be desktop, mobile, or full");
  assert.ok(["chromium", "firefox", "webkit"].includes(args.browser), "unsupported browser");
  const url = new URL(args.baseUrl);
  assert.ok(["http:", "https:"].includes(url.protocol), "--url must be HTTP(S)");
  args.baseUrl = url.origin;
  return args;
}
function assertOfflineMode(env = process.env) {
  if (env.SWARM_E2E_MODE === "live") {
    const configured = Boolean(env.SWARM_E2E_SCENARIO_ID?.trim());
    throw new Error(configured
      ? "This suite is offline-only; live scenario configuration does not authorize provider calls."
      : "Live mode requires an explicit real SWARM_E2E_SCENARIO_ID; fixture IDs are not live evidence.");
  }
}
function buildContextOptions(mode, browser = "chromium") {
  if (mode !== "mobile") return { viewport: DESKTOP_VIEWPORT, reducedMotion: "reduce", locale: "en-US" };
  const context = { ...MOBILE_CTX_DEFAULTS, reducedMotion: "reduce", locale: "en-US" };
  if (browser === "firefox") delete context.isMobile;
  return context;
}
function buildSurfaceRuns(args) {
  const make = (mode, browser) => ({ mode, browser, context: buildContextOptions(mode, browser) });
  return args.mode === "full"
    ? [make("desktop", args.browser), make("mobile", args.browser)]
    : [make(args.mode, args.browser)];
}
async function launchBrowser(headless, browserName = "chromium") {
  if (browserName === "firefox") return firefox.launch({ headless });
  if (browserName === "webkit") return webkit.launch({ headless });
  try { return await chromium.launch({ headless }); }
  catch { return chromium.launch({ channel: "chrome", headless }); }
}

/** Finite, explicit plans: no unconfigured request receives a successful reply. */
function createConversationFixtureStore() {
  const threads = new Map();
  const requests = [];
  const frames = [];
  const cancellations = [];
  const plans = [];
  const violations = [];
  function fail(message) {
    violations.push(message);
    return { status: 409, json: { detail: { code: "FIXTURE_CONTRACT_ERROR", message } } };
  }
  function snapshot(thread) { return structuredClone(thread); }
  function appendPair(thread, content) {
    const now = new Date().toISOString();
    const user = { id: `${thread.thread_id}-user-${thread.last_turn_sequence + 1}`,
      role: "user", sequence: ++thread.last_turn_sequence, content, status: "done", created_at: now };
    const assistant = { id: `${thread.thread_id}-assistant-${thread.last_turn_sequence + 1}`,
      role: "assistant", sequence: ++thread.last_turn_sequence, content: "", status: "pending", created_at: now };
    thread.turns.push(user, assistant);
    thread.active_turn_id = assistant.id;
    thread.latest_status = "pending";
    return assistant;
  }
  function request({ method, pathname, body = {}, ownerUserId = "" }) {
    requests.push({ method, pathname, body: structuredClone(body), ownerUserId });
    if (!["", FIXTURE_OWNER_ID].includes(ownerUserId)) return fail("Unknown fixture session owner");
    if (pathname === "/api/conversation/start" && method === "POST") {
      if (body.scenario_id !== FIXTURE_SCENARIO_ID || body.origin_node_id !== NODE_ID
        || body.origin_node_type !== "event" || body.origin_branch_id !== BRANCH_ID
        || body.origin_round_number !== 1 || !body.first_user_content?.trim()) {
        return fail("Start request did not preserve the selected node's scenario/branch/round/type");
      }
      const id = `thread-e2e-${threads.size + 1}`;
      const thread = { thread_id: id, scenario_id: body.scenario_id, agent_identity_id: null,
        owner_user_id: ownerUserId, origin_node_id: body.origin_node_id, origin_node_type: body.origin_node_type,
        origin_branch_id: body.origin_branch_id, origin_round_number: body.origin_round_number,
        last_turn_sequence: 0, turns: [], created_at: new Date().toISOString() };
      const assistant = appendPair(thread, body.first_user_content);
      threads.set(id, thread);
      return { status: 200, json: { ...snapshot(thread), assistant_turn_id: assistant.id } };
    }
    if (pathname === `/api/scenario/${FIXTURE_SCENARIO_ID}/conversations` && method === "GET") {
      return { status: 200, json: { items: [...threads.values()]
        .filter(thread => thread.owner_user_id === ownerUserId).map(snapshot), cursor: null, has_more: false } };
    }
    const match = pathname.match(/^\/api\/conversation\/(thread-e2e-\d+)(?:\/(turn|active))?$/);
    const thread = match && threads.get(match[1]);
    if (!thread) return fail(`Unknown conversation fixture ${method} ${pathname}`);
    if (thread.owner_user_id !== ownerUserId) {
      return { status: 404, json: { detail: { code: "THREAD_NOT_FOUND", message: "Thread not found" } } };
    }
    if (!match[2] && method === "GET") return { status: 200, json: snapshot(thread) };
    if (match[2] === "active" && method === "DELETE") {
      const turn = thread.turns.find(item => item.id === thread.active_turn_id);
      if (!turn) return fail("Abort requires a reserved active fixture turn");
      turn.status = "aborted";
      turn.error_code = "USER_ABORTED";
      thread.active_turn_id = null;
      thread.latest_status = "aborted";
      return { status: 200, json: { aborted: true, turn_id: turn.id } };
    }
    if (match[2] !== "turn" || method !== "POST") return fail(`Unsupported ${method} ${pathname}`);
    const plan = plans.shift();
    if (!plan || plan.question !== body.user_content) return fail("Missing or mismatched explicit SSE plan");
    let turn = thread.turns.find(item => item.id === thread.active_turn_id);
    if (!(turn?.status === "pending" && thread.turns.at(-2)?.content === body.user_content)) {
      if (turn) return fail("Concurrent fixture turn must not succeed");
      turn = appendPair(thread, body.user_content);
    }
    turn.status = "streaming";
    thread.latest_status = "streaming";
    const data = { turn_id: turn.id, thread_id: thread.thread_id, sequence: turn.sequence, model: "offline-fixture" };
    const events = [{ event: "turn_started", data, delay: 0 }];
    const parts = plan.parts ?? ["Visible partial ", "answer."];
    events.push({ event: "turn_token_delta", data: { ...data, delta: parts[0] }, delay: 60 });
    if (plan.kind === "incomplete") {
      return { status: 200, stream: { events, closeDelay: 450, incomplete: true, turnId: turn.id } };
    }
    if (plan.kind === "error" || plan.kind === "server_abort") {
      events.push({ event: plan.kind === "error" ? "turn_error" : "turn_aborted",
        data: { ...data, status: plan.kind === "error" ? "error" : "aborted",
          code: plan.kind === "error" ? "LLM_5XX" : "USER_ABORTED", message: "Offline fixture terminal" }, delay: 450 });
    } else {
      events.push({ event: "turn_token_delta", data: { ...data, delta: parts[1] ?? "" },
        delay: plan.kind === "stop" ? 10000 : 450 });
      events.push({ event: "turn_completed", data: { ...data, status: "committed" }, delay: 350 });
    }
    return { status: 200, stream: { events, closeDelay: 0, turnId: turn.id } };
  }
  function record({ event, data, at }) {
    if (event === "transport_cancelled") {
      cancellations.push({ turnId: data.turn_id, at });
      return;
    }
    frames.push({ event, data: structuredClone(data), at });
    const thread = [...threads.values()].find(item => item.turns.some(turn => turn.id === data.turn_id));
    const turn = thread?.turns.find(item => item.id === data.turn_id);
    if (!turn) { violations.push("Frame for an unknown fixture turn"); return; }
    if (["aborted", "error", "done"].includes(turn.status)) {
      violations.push(`Late fixture frame after ${turn.status}: ${event}`);
      return;
    }
    if (event === "turn_token_delta") turn.content += data.delta;
    if (["turn_completed", "turn_error", "turn_aborted", "incomplete"].includes(event)) {
      turn.status = event === "turn_completed" ? "done" : event === "turn_aborted" ? "aborted" : "error";
      turn.error_code = data.code ?? (event === "incomplete" ? "STREAM_TIMEOUT" : null);
      thread.active_turn_id = null;
      thread.latest_status = turn.status;
    }
  }
  return { threads, requests, frames, cancellations, plans, violations, request, record };
}

function streamFixtureInitScript({ sessionToken, ownerId }) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, window.location.href);
    const method = (init.method ?? (typeof input === "object" ? input.method : null) ?? "GET").toUpperCase();
    if (url.origin !== window.location.origin || !/^\/api\/conversation\/thread-e2e-\d+\/turn$/.test(url.pathname)) {
      return originalFetch(input, init);
    }
    const requestToken = new Headers(init.headers).get("X-Session-Token") ?? "";
    const ownerUserId = requestToken === sessionToken ? ownerId : requestToken ? "unknown-owner" : "";
    const response = await window.__conversationFixtureRequest({ method, pathname: url.pathname,
      body: JSON.parse(init.body ?? "{}"), ownerUserId });
    if (!response.stream) return new Response(JSON.stringify(response.json), {
      status: response.status, headers: { "Content-Type": "application/json" },
    });
    const plan = response.stream;
    const encoder = new TextEncoder();
    let stopped = false;
    let timer;
    const signal = init.signal ?? (typeof input === "object" ? input.signal : null);
    let abort;
    const body = new ReadableStream({
      start(controller) {
        abort = () => {
          if (stopped) return;
          stopped = true;
          clearTimeout(timer);
          void window.__recordConversationFrame({ event: "transport_cancelled",
            data: { turn_id: plan.turnId }, at: performance.now() });
          controller.error(new DOMException("Fixture request aborted", "AbortError"));
        };
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener("abort", abort, { once: true });
        let index = 0;
        const next = async () => {
          if (stopped) return;
          try {
            const frame = plan.events[index++];
            if (frame) {
              await window.__recordConversationFrame({ event: frame.event, data: frame.data, at: performance.now() });
              if (stopped) return;
              const text = `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
              // Split a frame too, so decoding is verified independently of frame boundaries.
              const split = Math.floor(text.length / 2);
              controller.enqueue(encoder.encode(text.slice(0, split)));
              controller.enqueue(encoder.encode(text.slice(split)));
              timer = setTimeout(next, plan.events[index]?.delay ?? plan.closeDelay);
            } else {
              if (plan.incomplete) await window.__recordConversationFrame({
                event: "incomplete", data: { turn_id: plan.turnId }, at: performance.now(),
              });
              if (stopped) return;
              stopped = true;
              signal?.removeEventListener("abort", abort);
              controller.close();
            }
          } catch (error) {
            if (!stopped) { stopped = true; controller.error(error); }
          }
        };
        timer = setTimeout(next, plan.events[0]?.delay ?? 0);
      },
      cancel() { stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
}

async function installFixtures(page, baseUrl, store, conversation, evidence) {
  const api = await installApiFixtures(page, store);
  evidence.unhandledApi = api.unhandled;
  await page.exposeBinding("__recordFixtureWsEscape", (_source, entry) => evidence.wsEscapes.push(entry));
  const ws = buildFixtureWsInitScript([{ scenario: store.getScenario(FIXTURE_SCENARIO_ID), complete: true }]);
  await page.addInitScript(ws.fn, ws.arg);
  await page.exposeBinding("__conversationFixtureRequest", (_source, request) => conversation.request(request));
  await page.exposeBinding("__recordConversationFrame", (_source, event) => conversation.record(event));
  await page.addInitScript(streamFixtureInitScript, {
    sessionToken: FIXTURE_SESSION_TOKEN, ownerId: FIXTURE_OWNER_ID,
  });
  await page.addInitScript(({ legacyDraftKey }) => {
    localStorage.setItem("swarmoracle:language:v1", "en");
    sessionStorage.setItem(legacyDraftKey, "Legacy draft without owner must stay private");
  }, { legacyDraftKey: `swarmoracle_draft:${FIXTURE_SCENARIO_ID}:${NODE_ID}:${BRANCH_ID}:1` });
  await page.route("**/api/capabilities", async route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: CAPABILITIES_FIXTURE });
  });
  await page.route(`**/api/scenario/${FIXTURE_SCENARIO_ID}/causal-graph*`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({ json: GRAPH_FIXTURE });
  });
  await page.route(url => url.pathname.startsWith("/api/conversation/")
    || url.pathname === `/api/scenario/${FIXTURE_SCENARIO_ID}/conversations`, async route => {
    const request = route.request();
    const requestToken = request.headers()["x-session-token"] ?? "";
    const ownerUserId = requestToken === FIXTURE_SESSION_TOKEN ? FIXTURE_OWNER_ID
      : requestToken ? "unknown-owner" : "";
    const result = conversation.request({ method: request.method(), pathname: new URL(request.url()).pathname,
      body: request.postDataJSON() ?? {}, ownerUserId });
    if (result.stream) throw new Error("SSE must run through the incremental browser fixture");
    return route.fulfill({ status: result.status, json: result.json });
  });
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      evidence.externalRequests.push(route.request().url());
      return route.abort("blockedbyclient");
    }
    return route.fallback();
  });
}

async function waitUntil(page, predicate, message, timeout = 10000, arg = undefined) {
  await page.waitForFunction(predicate, arg, { timeout }).catch(error => {
    throw new Error(`${message}: ${error.message}`);
  });
}
async function waitText(locator, text) {
  await locator.waitFor({ state: "visible", timeout: 10000 });
  const started = Date.now();
  while (!(await locator.innerText()).includes(text)) {
    if (Date.now() - started > 10000) throw new Error(`Expected visible text: ${text}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}
async function openGraphConversation(page, baseUrl, source) {
  const response = await page.goto(`${baseUrl}${source.route}`, { waitUntil: "domcontentloaded", timeout: 20000 });
  assert.ok(response?.ok(), `Navigation must succeed for ${source.key}`);
  const node = page.locator(`.react-flow__node[data-id="${NODE_ID}"] [data-graph-node-card]`);
  await node.waitFor({ state: "visible", timeout: 15000 });
  await node.click();
  if (source.inspectFirst) {
    await waitText(page.getByTestId("node-detail-panel"), NODE_LABEL);
    assert.equal(await page.getByTestId("node-conversation-sheet").count(), 0,
      "Workbench selection must show detail without opening conversation");
    await page.getByTestId("node-detail-ask").click();
  }
  await page.getByTestId("node-conversation-sheet").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("node-conversation-sheet").count(), 1);
  await waitText(page.getByTestId("node-context-banner"), "Audit officer");
  await waitText(page.getByTestId("node-context-banner"), "public evidence");
  assert.equal(await page.getByTestId("node-detail-panel").count(), 0,
    "A conversation sheet must not be covered by a second detail dialog");
}
async function transcript(page) {
  return page.locator('[data-testid="node-conversation-transcript"] article[data-role][data-turn-status]')
    .evaluateAll(nodes => nodes.map(node => ({ role: node.dataset.role,
      status: node.dataset.turnStatus, text: node.innerText })));
}
async function waitAssistant(page, text, status) {
  await waitUntil(page, ({ text, status }) => [...document.querySelectorAll(
    '[data-testid="node-conversation-transcript"] article[data-role="assistant"]',
  )].some(node => (status === "committed" ? ["done", "committed"].includes(node.dataset.turnStatus)
    : node.dataset.turnStatus === status) && node.textContent.includes(text)),
  `Missing assistant ${status} turn`, 10000, { text, status });
  await page.getByTestId("node-conversation-streaming").waitFor({ state: "hidden" });
}

async function runSurface(mode, contextOptions, args) {
  const outputDir = args.outputDir
    ? path.join(path.resolve(args.outputDir), `${mode}-${args.browser}`)
    : path.join(DEFAULT_OUTPUT_ROOT, `node-conversation-${timestampLabel()}-${mode}-${args.browser}`);
  fs.mkdirSync(outputDir, { recursive: true });
  const result = { mode, browser: args.browser, viewport: contextOptions.viewport, live: false,
    testedSurfaces: TRIGGER_SOURCES.map(source => source.key),
    notCovered: ["KGExplorer canvas trigger", "FactionTimeline trigger", "ArgumentMap scenario binding",
      "Real provider output", "Backend persistence", "Storage-quota degradation"],
    tests: { behavior: { steps: [], passed: false } }, artifacts: [],
    network: { unhandledApi: [], wsEscapes: [], externalRequests: [], pageErrors: [] } };
  const steps = result.tests.behavior.steps;
  const store = createFixtureStore();
  const scenario = store.getScenario(FIXTURE_SCENARIO_ID);
  scenario.conversation_llm_configured = true;
  const conversation = createConversationFixtureStore();
  const nodeGuard = installNodeFetchFixture(store);
  let page;
  let failed = false;
  const capture = async name => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(outputDir, filename), fullPage: true });
    result.artifacts.push(filename);
  };
  const step = async (name, action) => {
    try {
      const evidence = await action();
      steps.push({ name, passed: true, ...(evidence ? { evidence } : {}) });
    } catch (error) {
      steps.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) });
      failed = true;
      throw error;
    }
  };
  const browser = await launchBrowser(args.headless, args.browser);
  try {
    const context = await browser.newContext({ ...contextOptions, serviceWorkers: "block" });
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => result.network.pageErrors.push(error.message));
    await installFixtures(page, args.baseUrl, store, conversation, result.network);
    await step("workbench-node-detail-explicit-ask-context", async () => {
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[0]);
      assert.equal(await page.getByTestId("node-conversation-input").inputValue(), "",
        "Unscoped legacy drafts must not be adopted by a new owner-scoped sheet");
      await capture("01-selected-node-context");
      return { nodeId: NODE_ID, branchId: BRANCH_ID, round: 1 };
    });
    const input = page.getByTestId("node-conversation-input");
    await step("unsent-draft-survives-full-navigation", async () => {
      const draftText = "Draft question retained without any provider call";
      const draftKey = `swarmoracle_draft:public:default_user:${FIXTURE_SCENARIO_ID}:${NODE_ID}:${BRANCH_ID}:1`;
      await input.fill(draftText);
      await waitUntil(page, ({ key, text }) => sessionStorage.getItem(key) === text,
        "Draft was not saved", 10000, { key: draftKey, text: draftText });
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[0]);
      assert.equal(await input.inputValue(), draftText);
      await page.getByTestId("conversation-draft-restored").waitFor({ state: "visible" });
      assert.equal(conversation.requests.filter(request => request.method === "POST").length, 0);
      await capture("02-draft-restored");
      return { draftKey, restoredText: draftText };
    });
    const first = { question: "Why did the audit officer request a hearing?", kind: "complete",
      parts: ["The audit officer requested evidence ", "before a decision was made."] };
    const second = { question: "What did the court do next?", kind: "complete",
      parts: ["The court scheduled a public hearing ", "in response to that request."] };
    const send = async plan => {
      conversation.plans.push(plan);
      await input.fill(plan.question);
      await page.getByTestId("node-conversation-send").click();
      await waitText(page.getByTestId("node-conversation-streaming"), plan.parts[0]);
      assert.equal(await page.getByTestId("node-conversation-stop").isVisible(), true);
    };
    await step("first-question-has-incremental-stream-and-user-assistant-pair", async () => {
      await send(first);
      assert.equal((await transcript(page)).filter(turn => turn.role === "assistant"
        && ["done", "committed"].includes(turn.status)).length, 0);
      await capture("03-first-incremental-stream");
      await waitAssistant(page, first.parts.join(""), "committed");
      const turns = await transcript(page);
      assert.deepEqual(turns.map(turn => turn.role), ["user", "assistant"]);
      assert.ok(turns[0].text.includes(first.question));
      return turns;
    });
    await step("second-question-preserves-both-completed-pairs", async () => {
      await send(second);
      await waitAssistant(page, second.parts.join(""), "committed");
      const turns = await transcript(page);
      assert.deepEqual(turns.map(turn => turn.role), ["user", "assistant", "user", "assistant"]);
      for (const [index, text] of [first.question, first.parts.join(""), second.question, second.parts.join("")].entries()) {
        assert.ok(turns[index].text.includes(text));
      }
      assert.equal(conversation.threads.size, 1, "Follow-up must reuse its existing thread");
      await capture("04-two-question-transcript");
      return turns;
    });
    await step("history-picker-restores-both-pairs-after-navigation", async () => {
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[0]);
      await page.getByTestId("conversation-history-picker-toggle").click();
      await page.getByTestId(`conversation-history-picker-row-${FIXTURE_THREAD_ID}`).click();
      await waitAssistant(page, second.parts.join(""), "committed");
      await page.getByTestId("conversation-history-picker-toggle").click();
      const turns = await transcript(page);
      assert.equal(turns.length, 4);
      assert.ok(turns[0].text.includes(first.question));
      assert.ok(turns[1].text.includes(first.parts.join("")));
      assert.ok(turns[2].text.includes(second.question));
      assert.equal(conversation.threads.size, 1);
      await capture("05-history-restored");
      return turns;
    });
    await step("stop-preserves-partial-answer-and-aborts-active-turn", async () => {
      const plan = { question: "Stop this answer while streaming", kind: "stop",
        parts: ["Partial answer retained on stop.", "Forbidden late token"] };
      await send(plan);
      await page.getByTestId("node-conversation-stop").click();
      await waitAssistant(page, plan.parts[0], "aborted");
      await waitUntil(page, () => !document.querySelector('[data-testid="node-conversation-stop"]'),
        "Stop control did not settle");
      const deadline = Date.now() + 3000;
      while (conversation.threads.get(FIXTURE_THREAD_ID).active_turn_id !== null) {
        assert.ok(Date.now() < deadline, "Abort endpoint was never consumed");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(!(await page.getByTestId("node-conversation-transcript").innerText()).includes(plan.parts[1]));
      const last = conversation.threads.get(FIXTURE_THREAD_ID).turns.at(-1);
      assert.equal(last.status, "aborted");
      assert.equal(last.content, plan.parts[0]);
      await capture("06-aborted-prefix");
      return { turn: last, deleteRequests: conversation.requests.filter(request => request.method === "DELETE").length };
    });
    await step("incomplete-sse-is-an-error-with-a-preserved-prefix", async () => {
      const plan = { question: "Handle a stream with no terminal event", kind: "incomplete",
        parts: ["Unfinished streamed evidence"] };
      await send(plan);
      await page.getByTestId("conversation-recovery-banner").waitFor({ state: "visible" });
      await waitAssistant(page, plan.parts[0], "error");
      assert.equal(await page.getByTestId("conversation-recovery-banner").getAttribute("data-code"), "server_error");
      assert.equal(await page.getByTestId("node-conversation-stop").count(), 0);
      await capture("07-incomplete-stream-error");
      await page.getByTestId("conversation-retry").click();
    });
    await step("server-error-recovers-through-explicit-resubmission", async () => {
      const plan = { question: "Recover this failed request", kind: "error", parts: ["Provider partial prefix"] };
      await send(plan);
      await page.getByTestId("conversation-recovery-banner").waitFor({ state: "visible" });
      await waitAssistant(page, plan.parts[0], "error");
      await page.getByTestId("conversation-retry").click();
      await page.getByTestId("conversation-recovery-banner").waitFor({ state: "hidden" });
      const retry = { question: plan.question, kind: "complete", parts: ["Retry recovered ", "the requested answer."] };
      await send(retry);
      await waitAssistant(page, retry.parts.join(""), "committed");
      const turns = await transcript(page);
      assert.ok(turns.some(turn => turn.status === "error" && turn.text.includes(plan.parts[0])));
      await capture("08-retried-answer");
      return { recoveryAction: "Dismiss recovery, explicitly resubmit same question", turns };
    });
    await step("persisted-server-abort-is-not-a-completed-answer", async () => {
      const plan = { question: "Observe a server-side turn revocation", kind: "server_abort", parts: ["Server-revoked prefix"] };
      await send(plan);
      await waitAssistant(page, plan.parts[0], "aborted");
      assert.ok(!(await transcript(page)).some(turn => ["done", "committed"].includes(turn.status)
        && turn.text.includes(plan.parts[0])));
    });
    await step("missing-model-blocks-send-and-retry-rechecks-readiness", async () => {
      scenario.conversation_llm_configured = false;
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[0]);
      await page.getByTestId("conversation-model-readiness").waitFor({ state: "visible" });
      await input.fill("A draft while model configuration is unavailable");
      await waitUntil(page, () => document.querySelector('[data-testid="node-conversation-send"]')?.disabled === true,
        "Missing configuration must disable send");
      const startsBefore = conversation.requests.filter(request => request.pathname.endsWith("/start")).length;
      await capture("10-model-configuration-required");
      scenario.conversation_llm_configured = true;
      await page.getByTestId("conversation-model-readiness").getByRole("button").click();
      await page.getByTestId("conversation-model-readiness").waitFor({ state: "hidden" });
      assert.equal(await page.getByTestId("node-conversation-send").isEnabled(), true);
      assert.equal(await input.inputValue(), "A draft while model configuration is unavailable");
      assert.equal(conversation.requests.filter(request => request.pathname.endsWith("/start")).length, startsBefore);
    });
    await step("causal-review-single-sheet-send-history-and-close-focus", async () => {
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[1]);
      await page.getByTestId("conversation-history-picker-toggle").click();
      await page.getByTestId(`conversation-history-picker-row-${FIXTURE_THREAD_ID}`).click();
      await waitAssistant(page, second.parts.join(""), "committed");
      await page.getByTestId("conversation-history-picker-toggle").click();
      const plan = { question: "Continue this node discussion from the causal review", kind: "complete",
        parts: ["The restored discussion keeps its node context ", "across graph surfaces."] };
      await send(plan);
      await waitAssistant(page, plan.parts.join(""), "committed");
      assert.equal(conversation.threads.size, 1);
      await capture("09-causal-review-ask");
      await page.getByTestId("node-conversation-sheet").getByRole("button", { name: "Close", exact: true }).click();
      await page.getByTestId("node-conversation-sheet").waitFor({ state: "hidden" });
      // FocusScope restores focus after its close effect; observe the settled result.
      await page.waitForFunction(() => document.activeElement?.matches("[data-graph-node-card]"),
        undefined, { timeout: 1500 }).catch(() => {});
      const focused = await page.evaluate(() => ({
        tag: document.activeElement?.tagName,
        text: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent)?.slice(0, 160),
        graphCard: document.activeElement?.matches("[data-graph-node-card]") ?? false,
      }));
      assert.equal(focused.graphCard, true,
        `Closing the ${mode} sheet must restore the graph trigger, got ${JSON.stringify(focused)}`);
      await capture("11-causal-review-close-focus");
      return { nodeId: NODE_ID, route: TRIGGER_SOURCES[1].route, focusAfterClose: focused };
    });
    await step("cross-tab-owner-change-clears-history-stream-and-draft-before-new-thread", async () => {
      await openGraphConversation(page, args.baseUrl, TRIGGER_SOURCES[0]);
      await page.getByTestId("conversation-history-picker-toggle").click();
      await page.getByTestId(`conversation-history-picker-row-${FIXTURE_THREAD_ID}`).click();
      await waitAssistant(page, first.parts.join(""), "committed");
      await page.getByTestId("conversation-history-picker-toggle").click();
      const anonymous = { question: "Anonymous owner still has a pending reply", kind: "stop",
        parts: ["ANONYMOUS_PRIVATE_STREAM_PREFIX", "ANONYMOUS_FORBIDDEN_LATE_TOKEN"] };
      await send(anonymous);
      const oldTurnId = conversation.threads.get(FIXTURE_THREAD_ID).active_turn_id;
      assert.ok(oldTurnId, "Anonymous stream must really be active before switching owners");
      const draftText = "ANONYMOUS_PRIVATE_COMPOSER_DRAFT";
      const oldDraftKey = `swarmoracle_draft:public:default_user:${FIXTURE_SCENARIO_ID}:thread:${FIXTURE_THREAD_ID}`;
      await input.fill(draftText);
      await waitUntil(page, ({ key, text }) => sessionStorage.getItem(key) === text,
        "Anonymous draft was not saved before the owner change", 10000,
        { key: oldDraftKey, text: draftText });
      await capture("12-before-owner-change");
      const requestBoundary = conversation.requests.length;
      await page.evaluate(({ sessionToken }) => {
        const key = "swarmoracle_session_token";
        const oldValue = localStorage.getItem(key);
        localStorage.setItem(key, sessionToken);
        window.dispatchEvent(new StorageEvent("storage", {
          key, oldValue, newValue: sessionToken, storageArea: localStorage, url: location.href,
        }));
      }, { sessionToken: FIXTURE_SESSION_TOKEN });
      await waitUntil(page, () => document.querySelector('[data-testid="node-conversation-input"]')?.value === "",
        "Old owner composer survived the StorageEvent");
      await page.getByTestId("node-conversation-streaming").waitFor({ state: "hidden" });
      assert.equal((await transcript(page)).length, 0, "The new owner must start with an empty transcript");
      assert.ok(!(await page.getByTestId("node-conversation-meta").innerText()).includes(FIXTURE_THREAD_ID));
      assert.ok(!(await page.getByTestId("node-conversation-sheet").innerText()).includes("ANONYMOUS_PRIVATE"));
      const cancellationDeadline = Date.now() + 3000;
      while (!conversation.cancellations.some(item => item.turnId === oldTurnId)) {
        assert.ok(Date.now() < cancellationDeadline, "Owner change did not abort the old streaming fetch");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await page.getByTestId("conversation-history-picker-toggle").click();
      await page.locator(".conversation-history-picker__empty").waitFor({ state: "visible" });
      assert.equal(await page.getByTestId(`conversation-history-picker-row-${FIXTURE_THREAD_ID}`).count(), 0);
      await page.getByTestId("conversation-history-picker-toggle").click();
      await capture("13-new-owner-empty-state");
      const next = { question: "Start an independent reply for owner B", kind: "complete",
        parts: ["Owner B receives only ", "its own conversation."] };
      await send(next);
      await waitAssistant(page, next.parts.join(""), "committed");
      const turns = await transcript(page);
      assert.deepEqual(turns.map(turn => turn.role), ["user", "assistant"]);
      assert.ok(turns[0].text.includes(next.question));
      assert.ok(!turns.some(turn => turn.text.includes("ANONYMOUS_") || turn.text.includes(first.question)));
      const newThread = [...conversation.threads.values()].find(thread => thread.owner_user_id === FIXTURE_OWNER_ID);
      assert.ok(newThread && newThread.thread_id !== FIXTURE_THREAD_ID);
      const ownerRequests = conversation.requests.slice(requestBoundary);
      assert.ok(ownerRequests.length > 0);
      assert.ok(ownerRequests.every(request => request.ownerUserId === FIXTURE_OWNER_ID));
      assert.ok(ownerRequests.every(request => !request.pathname.includes(`/conversation/${FIXTURE_THREAD_ID}`)),
        "A new owner must never reuse or send cleanup for the previous owner's thread");
      assert.equal(ownerRequests.filter(request => request.pathname === "/api/conversation/start").length, 1);
      assert.ok(!conversation.frames.some(frame => frame.data.delta === anonymous.parts[1]));
      await capture("14-new-owner-conversation");
      return { previousThreadId: FIXTURE_THREAD_ID, nextThreadId: newThread.thread_id,
        cancelledTurnId: oldTurnId, newOwner: FIXTURE_OWNER_ID, newOwnerRequests: ownerRequests, turns };
    });
  } catch (error) {
    failed = true;
    if (!steps.some(item => !item.passed)) steps.push({ name: "fixture-or-browser-setup", passed: false,
      error: error instanceof Error ? error.stack : String(error) });
    if (page && !page.isClosed()) {
      await capture("failure").catch(() => {});
      result.failureUrl = page.url();
      result.failureText = await page.locator("body").innerText().catch(() => "");
    }
  } finally {
    try {
      await closePlaywrightBrowser(browser, `e2e-node-conversation-live:${mode}:${args.browser}`);
    } catch (error) {
      failed = true;
      steps.push({ name: "browser-teardown", passed: false,
        error: error instanceof Error ? error.message : String(error) });
    } finally { nodeGuard.restore(); }
  }
  result.network.nodeEscapes = nodeGuard.escapes;
  result.fixture = { requests: conversation.requests, frames: conversation.frames, cancellations: conversation.cancellations,
    violations: conversation.violations, unconsumedPlans: conversation.plans,
    threads: [...conversation.threads.values()] };
  const cleanNetwork = [result.network.unhandledApi, result.network.wsEscapes,
    result.network.externalRequests, result.network.nodeEscapes, result.network.pageErrors,
    conversation.violations, conversation.plans].every(items => items.length === 0);
  steps.push({ name: "offline-network-and-fixture-contract", passed: cleanNetwork });
  result.tests.behavior.passed = !failed && steps.every(item => item.passed);
  result.summary = { totalSteps: steps.length, passedSteps: steps.filter(item => item.passed).length,
    allPassed: result.tests.behavior.passed && steps.length >= 13 };
  writeJson(path.join(outputDir, "result.json"), result);
  return result;
}

export const __test__ = { TRIGGER_SOURCES, TURN_ERROR_CODES, CAPABILITIES_FIXTURE,
  GRAPH_FIXTURE, FIXTURE_SCENARIO_ID, FIXTURE_THREAD_ID, FIXTURE_OWNER_ID, NODE_ID, BRANCH_ID,
  buildSurfaceRuns, parseArgs, assertOfflineMode, createConversationFixtureStore };

async function main() {
  assertOfflineMode();
  const args = parseArgs(process.argv);
  const runs = [];
  for (const surface of buildSurfaceRuns(args)) {
    runs.push(await runSurface(surface.mode, surface.context, { ...args, browser: surface.browser }));
  }
  const allPassed = runs.length > 0 && runs.every(result => result.summary.allPassed);
  console.log(JSON.stringify({ script: "e2e-node-conversation-live", runs: runs.length, allPassed }));
  if (!allPassed) process.exitCode = 1;
}
if (IS_MAIN_MODULE) main().catch(error => { console.error(error); process.exitCode = 1; });
