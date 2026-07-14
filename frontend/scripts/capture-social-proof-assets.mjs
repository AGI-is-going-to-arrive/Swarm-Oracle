import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18930";
const LANGUAGE_STORAGE_KEY = "swarmoracle:language:v1";
const SCENARIO_ID = "capture-social-proof";
const BRANCH_ID = "branch-root";
const VIEWPORT = { width: 1440, height: 900 };

const OUTPUTS = {
  zh: {
    feed: path.join(REPO_ROOT, "docs/screenshots/24-initial-feed.png"),
    ledger: path.join(REPO_ROOT, "docs/screenshots/25-action-ledger.png"),
  },
  en: {
    feed: path.join(REPO_ROOT, "docs/screenshots-en/24-initial-feed.png"),
    ledger: path.join(REPO_ROOT, "docs/screenshots-en/25-action-ledger.png"),
  },
  feedGif: path.join(REPO_ROOT, "site/assets/gifs/initial-feed-bilingual.gif"),
  ledgerGif: path.join(REPO_ROOT, "site/assets/gifs/action-ledger-bilingual.gif"),
  manifest: path.join(FRONTEND_ROOT, "output/capture/social-proof.capture-manifest.json"),
};

const CAPABILITIES = {
  causal_graph: { enabled: true },
  graph_analysis: { enabled: false },
  custom_agents: { enabled: false },
  multi_run: { enabled: false },
  education_templates: { enabled: false },
  model_profiles: { enabled: false },
  you_vs_oracle: { enabled: false },
  web_search: { enabled: false, providers: {} },
};

const SCENARIO = {
  id: SCENARIO_ID,
  question: "How should a city coordinate verified flood updates and rescue requests?",
  status: "done",
  created_at: "2026-07-14T08:00:00+10:00",
  total_rounds: 3,
  mode: "blackboard",
  visualization_enabled: false,
  agents: [
    { id: "agent-coordinator", name: "Crisis Coordinator", role: "Coordinator", tier: "CORE" },
    { id: "agent-reporter", name: "Field Reporter", role: "Reporter", tier: "IMPORTANT" },
  ],
  branches: [{ id: BRANCH_ID, title: "Verified response", probability: 1, status: "COMPLETED" }],
  messages: [],
  groups: [],
};

const GRAPH = {
  id: "capture-social-proof-graph",
  scope_kind: "branch_lineage",
  available_branches: [BRANCH_ID],
  nodes: [
    { id: "event-1", key: "flood-warning", type: "event", label: "Flood warning verified", round: 1, payload: { branch_id: BRANCH_ID, agent_id: "agent-coordinator" } },
    { id: "event-2", key: "rescue-route", type: "event", label: "Rescue route published", round: 2, payload: { branch_id: BRANCH_ID, agent_id: "agent-reporter" } },
  ],
  edges: [{ id: "edge-1", source: "event-1", target: "event-2", type: "influenced", weight: 0.8, label: "informed" }],
};

const ACTIONS = [
  {
    id: "action-bootstrap",
    sequence: 1,
    branch_id: BRANCH_ID,
    round: 1,
    agent: { id: "source-flood-office", name: "Municipal Flood Control Office" },
    action_type: "POST",
    status: "verified",
    target: null,
    parent_action_id: null,
    content: "Rainfall exceeded 100 mm in two hours; temporary traffic controls are active.",
    payload: {
      bootstrap: true,
      source_name: "Municipal Flood Control Office",
      published_at: "2026-07-14T08:10:00+10:00",
      credibility_hint: "Official bulletin; monitor for updates",
      tags: ["storm", "traffic"],
    },
    failure_code: null,
    created_at: "2026-07-14T08:10:00+10:00",
  },
  {
    id: "action-follow",
    sequence: 2,
    branch_id: BRANCH_ID,
    round: 1,
    agent: { id: "agent-coordinator", name: "Crisis Coordinator" },
    action_type: "FOLLOW",
    status: "verified",
    target: { kind: "agent", id: "source-flood-office" },
    parent_action_id: null,
    content: "Follow official flood-control updates.",
    payload: {},
    failure_code: null,
    created_at: "2026-07-14T08:12:00+10:00",
  },
  {
    id: "action-comment",
    sequence: 3,
    branch_id: BRANCH_ID,
    round: 2,
    agent: { id: "agent-reporter", name: "Field Reporter" },
    action_type: "COMMENT",
    status: "verified",
    target: { kind: "action", id: "action-bootstrap" },
    parent_action_id: "action-bootstrap",
    content: "North Shore evacuation routes are being cross-checked now.",
    payload: {},
    failure_code: null,
    created_at: "2026-07-14T08:25:00+10:00",
  },
  {
    id: "action-mute",
    sequence: 4,
    branch_id: BRANCH_ID,
    round: 2,
    agent: { id: "agent-coordinator", name: "Crisis Coordinator" },
    action_type: "MUTE",
    status: "verified",
    target: { kind: "agent", id: "source-rumor-wire" },
    parent_action_id: null,
    content: "Mute the unverified rumor account from subsequent feeds.",
    payload: {},
    failure_code: null,
    created_at: "2026-07-14T08:28:00+10:00",
  },
  {
    id: "action-reaction",
    sequence: 5,
    branch_id: BRANCH_ID,
    round: 3,
    agent: { id: "agent-reporter", name: "Field Reporter" },
    action_type: "REACTION",
    status: "verified",
    target: { kind: "action", id: "action-bootstrap" },
    parent_action_id: "action-bootstrap",
    content: null,
    payload: { reaction: "confirmed" },
    failure_code: null,
    created_at: "2026-07-14T08:35:00+10:00",
  },
];

function localizedActions(locale) {
  if (locale !== "zh") return ACTIONS;
  const localized = [
    { name: "市防汛指挥部", content: "过去两小时降雨量突破 100 毫米，低洼路段已实施临时交通管制。" },
    { name: "应急协调员", content: "关注防汛部门的官方更新。" },
    { name: "现场记者", content: "正在交叉核验北岸社区的疏散路线。" },
    { name: "应急协调员", content: "从后续信息流中屏蔽未经核实的传言账户。" },
    { name: "现场记者", content: null },
  ];
  return ACTIONS.map((action, index) => ({
    ...action,
    agent: { ...action.agent, name: localized[index].name },
    content: localized[index].content,
    payload: action.id === "action-bootstrap"
      ? {
          ...action.payload,
          source_name: "市防汛指挥部",
          credibility_hint: "官方通报，仍需关注后续更新",
          tags: ["暴雨", "交通"],
        }
      : action.payload,
  }));
}

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function json(route, payload, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(payload) });
}

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, headless: true };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--url" && argv[index + 1]) {
      args.baseUrl = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--headed") {
      args.headless = false;
    } else if (argv[index] === "--headless") {
      args.headless = true;
    } else {
      throw new Error("Usage: node scripts/capture-social-proof-assets.mjs [--url URL] [--headless|--headed]");
    }
  }
  return args;
}

async function installFailClosedFixtures(page, locale, baseUrl, networkLog) {
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      networkLog.blocked.push(request.url());
      return route.abort("blockedbyclient");
    }
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/ws/")) {
      return route.continue();
    }
    if (url.pathname.startsWith("/ws/")) {
      networkLog.blocked.push(request.url());
      return route.abort("blockedbyclient");
    }

    networkLog.apiRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    if (request.method() !== "GET") {
      networkLog.unhandled.push(`${request.method()} ${url.pathname}`);
      return json(route, { detail: "fixture mode rejected mutation" }, 405);
    }
    if (url.pathname === "/api/capabilities") return json(route, CAPABILITIES);
    if (url.pathname === `/api/scenario/${SCENARIO_ID}`) return json(route, SCENARIO);
    if (url.pathname === `/api/scenario/${SCENARIO_ID}/causal-graph`) return json(route, GRAPH);
    if (url.pathname === `/api/scenario/${SCENARIO_ID}/actions`) {
      let items = localizedActions(locale);
      const actionType = url.searchParams.get("action_type");
      if (actionType) items = items.filter((item) => item.action_type === actionType);
      return json(route, { scenario_id: SCENARIO_ID, items, next_cursor: null, has_more: false });
    }

    const emptyArrayPaths = [
      "/api/agents/identities",
      "/api/agents/identities/favorites",
      "/api/model-profiles",
      "/api/packs",
      "/api/scenarios/samples",
      "/api/campaign/challenges",
    ];
    if (emptyArrayPaths.includes(url.pathname)) return json(route, []);
    if (url.pathname === "/api/campaign/state") return json(route, {});
    if (url.pathname === "/api/campaign/challenges/rotation") {
      const challenge = {
        id: "capture-daily-challenge",
        question: "如何协调洪灾信息？",
        question_en: "How should flood information be coordinated?",
        subtitle_zh: "核实来源并协调救援",
        subtitle_en: "Verify sources and coordinate rescue",
        profile_id: "governance",
        rounds: 3,
        num_agents: 3,
        mode: "blackboard",
        visualization_enabled: false,
      };
      return json(route, {
        local_date: url.searchParams.get("local_date") ?? "2026-07-14",
        week_key: "2026-W29",
        today_challenge: challenge,
        weekly_challenges: [challenge],
        weekly_track: null,
      });
    }
    if (url.pathname === "/api/campaign/profile/default_user") {
      return json(route, {
        user_id: "default_user", user_name: "Local Director", total_runs: 0,
        completed_challenges: 0, total_bets: 0, hit_bets: 0, highest_archive_grade: null,
        created_at: "2026-07-14T00:00:00Z", updated_at: "2026-07-14T00:00:00Z",
      });
    }
    if (url.pathname === "/api/campaign/profile/default_user/mastery") return json(route, []);
    if (url.pathname === "/api/campaign/profile/default_user/badges") return json(route, []);
    if (url.pathname === "/api/campaign/profile/default_user/daily-status") {
      return json(route, { completed: false, scenario_id: null });
    }
    if (url.pathname === "/api/campaign/profile/default_user/weekly-summary") {
      return json(route, {
        user_id: "default_user", week_start: "2026-07-13", week_end: "2026-07-19",
        timezone_offset_minutes: -600, total_runs: 0, completed_daily_challenges: 0,
        campaign_score_delta: 0, hit_bets: 0, profile_runs: {},
      });
    }

    networkLog.unhandled.push(`${request.method()} ${url.pathname}${url.search}`);
    return json(route, { detail: "unhandled fixture request" }, 599);
  });
}

async function newFixturePage(browser, locale, baseUrl, networkLog) {
  const context = await browser.newContext({ viewport: VIEWPORT, locale: locale === "zh" ? "zh-CN" : "en-US" });
  await context.addInitScript(({ key, language }) => {
    window.localStorage.setItem(key, language);
    window.localStorage.setItem("onboarding.completed", "true");
    window.localStorage.setItem("swarm_onboarding_completed", "true");
  }, { key: LANGUAGE_STORAGE_KEY, language: locale });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    console.error(`[capture pageerror] ${error.message}`);
    networkLog.unhandled.push(`PAGE_ERROR ${error.message}`);
  });
  await installFailClosedFixtures(page, locale, baseUrl, networkLog);
  return { context, page };
}

async function captureFeed(browser, locale, baseUrl, outputPath, networkLog) {
  const { context, page } = await newFixturePage(browser, locale, baseUrl, networkLog);
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    await page.locator(".iv-advanced__trigger").click();
    await page.locator(".iv-advanced__body.is-open").waitFor({ state: "visible" });
    await page.locator(".initial-feed").evaluate((element) => {
      element.scrollIntoView({ block: "start" });
      window.scrollBy(0, -48);
    });
    await page.getByRole("button", { name: locale === "zh" ? "载入暴雨救援示例" : "Load storm rescue example" }).click();
    await page.locator(".initial-feed__item").nth(2).waitFor({ state: "visible" });
    await page.locator(".initial-feed").evaluate((element) => {
      element.scrollIntoView({ block: "start" });
      window.scrollBy(0, -48);
    });
    await page.waitForTimeout(300);
    ensureParent(outputPath);
    await page.screenshot({ path: outputPath, type: "png", scale: "css" });
  } finally {
    await context.close();
  }
}

async function captureLedger(browser, locale, baseUrl, outputPath, networkLog) {
  const { context, page } = await newFixturePage(browser, locale, baseUrl, networkLog);
  try {
    await page.goto(`${baseUrl}/sim/${SCENARIO_ID}/causal-map?branch_id=${BRANCH_ID}`, { waitUntil: "domcontentloaded" });
    const panel = page.getByTestId("action-ledger-panel");
    await panel.waitFor({ state: "visible" });
    const toggle = panel.locator(".action-ledger__toggle");
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await panel.locator(".action-ledger__card").nth(4).waitFor({ state: "visible" });
    await panel.locator(".action-ledger__details-toggle").first().click();
    await panel.locator(".action-ledger__details").waitFor({ state: "visible" });
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    ensureParent(outputPath);
    await page.screenshot({ path: outputPath, type: "png", scale: "css" });
  } finally {
    await context.close();
  }
}

function createBilingualGif(firstPath, secondPath, outputPath) {
  ensureParent(outputPath);
  const result = spawnSync("ffmpeg", [
    "-y", "-loop", "1", "-t", "1.6", "-i", firstPath,
    "-loop", "1", "-t", "1.6", "-i", secondPath,
    "-filter_complex",
    "[0:v]fps=10,scale=960:-2:flags=lanczos,setsar=1[a];[1:v]fps=10,scale=960:-2:flags=lanczos,setsar=1[b];[a][b]concat=n=2:v=1:a=0,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
    "-loop", "0", outputPath,
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error("ffmpeg is required on PATH");
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function main() {
  const args = parseArgs(process.argv);
  const networkLog = { apiRequests: [], blocked: [], unhandled: [] };
  const browser = await chromium.launch({ headless: args.headless });
  try {
    await captureFeed(browser, "zh", args.baseUrl, OUTPUTS.zh.feed, networkLog);
    await captureFeed(browser, "en", args.baseUrl, OUTPUTS.en.feed, networkLog);
    await captureLedger(browser, "zh", args.baseUrl, OUTPUTS.zh.ledger, networkLog);
    await captureLedger(browser, "en", args.baseUrl, OUTPUTS.en.ledger, networkLog);
  } finally {
    await browser.close();
  }

  if (networkLog.unhandled.length > 0) {
    throw new Error(`Unhandled fixture requests: ${networkLog.unhandled.join(", ")}`);
  }
  createBilingualGif(OUTPUTS.zh.feed, OUTPUTS.en.feed, OUTPUTS.feedGif);
  createBilingualGif(OUTPUTS.zh.ledger, OUTPUTS.en.ledger, OUTPUTS.ledgerGif);

  const artifactPaths = [
    OUTPUTS.zh.feed, OUTPUTS.en.feed, OUTPUTS.zh.ledger, OUTPUTS.en.ledger,
    OUTPUTS.feedGif, OUTPUTS.ledgerGif,
  ];
  const manifest = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    git_commit: gitCommit(),
    base_url: args.baseUrl,
    viewport: VIEWPORT,
    capture_method: "playwright",
    source_kind: "playwright_fixture",
    fixture_id: SCENARIO_ID,
    fixture_sha256: crypto.createHash("sha256").update(JSON.stringify({
      SCENARIO,
      GRAPH,
      actions_en: localizedActions("en"),
      actions_zh: localizedActions("zh"),
    })).digest("hex"),
    provider_called: false,
    backend_called: false,
    routes: ["/", `/sim/${SCENARIO_ID}/causal-map?branch_id=${BRANCH_ID}`],
    network: networkLog,
    artifacts: artifactPaths.map((filePath) => ({
      output: path.relative(REPO_ROOT, filePath),
      sha256: sha256(filePath),
      bytes: fs.statSync(filePath).size,
    })),
  };
  ensureParent(OUTPUTS.manifest);
  fs.writeFileSync(OUTPUTS.manifest, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(manifest, null, 2));
}

await main();
