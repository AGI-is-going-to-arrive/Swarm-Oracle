/**
 * e2eFixtureNet.mjs — Offline fixture network harness for SWARM_E2E_FIXTURE_MODE.
 *
 * Goal (M-fixture): when SWARM_E2E_FIXTURE_MODE=1, the e2e corners/mobile suites
 * must run with ZERO network escape to a real backend. Every API call — both
 * browser-side (page `fetch`/WebSocket) and Node-side (`globalThis.fetch` used by
 * the suite's own helpers like createScenarioViaApi/resolveMatrixScenario) — is
 * satisfied by an in-memory fixture store.
 *
 * Active, fail-closed zero-escape guard (NOT passive observation):
 *   - Browser side: a catch-all `page.route("/api/**")` registered FIRST (so it runs
 *     LAST in Playwright's LIFO order) records every uncovered request into
 *     `unhandled[]` and fulfills a synthetic 404 — the request never reaches the
 *     network. Specific per-endpoint routes registered afterward win and serve
 *     fixtures. This mirrors the proven pattern in e2e-gate3-sprint3-probe.mjs.
 *   - Node side: `globalThis.fetch` is monkey-patched. `/api/**` requests are served
 *     from the store; any uncovered `/api/**` request is recorded into `escapes[]`
 *     and rejected (never hits the network). Non-/api fetches (e.g. the Safari
 *     WebDriver protocol at 127.0.0.1:4444) pass through to the real fetch.
 *
 * The caller asserts both `unhandled[]` (browser) and `escapes[]` (node) are empty
 * at suite end; non-empty => the suite FAILS.
 *
 * Honesty note: the director_state / gameplay_state read-after-write derivations
 * (commitment_outcome, most_used_card, counterplay_card_count, system_tracks, …)
 * are hand-mirrored from the backend's Python logic. They capture the FRONTEND
 * consumption contract offline, but cannot capture backend-derivation regressions.
 * See .ccg/tasks/oss-readiness-audit/M-FIXTURE-PLAN.md §6.
 */

export const FIXTURE_MODE = process.env.SWARM_E2E_FIXTURE_MODE === "1";

/** Stable fixture scenario ids served entirely offline. */
export const FIXTURE_SCENARIO_IDS = {
  // Completed scenarios — drive result / replay / director / gameplay / share.
  governance: "fixture-corners-governance",
  law: "fixture-corners-law",
  // Live (in-progress) scenario — drives the prediction / capture cases, whose
  // CTA gate is `!isSimulationComplete`. Created via POST /api/scenario so the
  // suite's createScenarioViaApi-based cases resolve to a non-completed sim.
  governanceLive: "fixture-corners-governance-live",
};

const NOW_ISO = "2026-03-19T00:00:00Z";

function isoOffset(minutes) {
  return new Date(Date.parse(NOW_ISO) + minutes * 60_000).toISOString();
}

// ---------------------------------------------------------------------------
// Canonical fixture scenario payloads
// ---------------------------------------------------------------------------

function makeGovernanceScenario() {
  const branches = [
    {
      id: "fx-gov-branch-a",
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: "",
      title: "法庭接管阈值",
      description: "算法治理在压力下交还司法终审。",
      summary: "司法终审接管",
      story: "法院完成了终审复核，故事文本已经齐备，治理权重新回到合议庭。",
      insight: "制度韧性来自可被审计的终审通道。",
      key_moments: ["公开听证开启", "终审复核落定"],
      probability: 0.62,
      status: "COMPLETED",
    },
    {
      id: "fx-gov-branch-b",
      parent_branch_id: null,
      fork_round: 1,
      fork_reason: "triggered fork",
      title: "算法自治延续",
      description: "算法继续主导但引入外部审计。",
      summary: "算法自治",
      story: "算法治理延续，但被迫接受跨部门审计与定期复核。",
      insight: "缺乏人类终审时，外部审计成为唯一刹车。",
      key_moments: ["审计链建立"],
      probability: 0.38,
      status: "COMPLETED",
    },
  ];
  const agents = [
    { id: "fx-gov-agent-1", name: "合议庭庭长", role: "裁决者", tier: "CORE", emotion: "focused" },
    { id: "fx-gov-agent-2", name: "审计官", role: "监督者", tier: "IMPORTANT", emotion: "vigilant" },
    { id: "fx-gov-agent-3", name: "算法架构师", role: "建造者", tier: "SUPPORT", emotion: "analytical" },
  ];
  return {
    id: FIXTURE_SCENARIO_IDS.governance,
    question: "如果人工智能统治世界并且所有国家都由算法直接治理，会发生什么？",
    status: "done",
    created_at: NOW_ISO,
    total_rounds: 3,
    mode: "blackboard",
    visualization_enabled: true,
    scene_theme: "governance_surveillance",
    agents,
    branches,
    messages: [],
    groups: [],
    hierarchical: false,
    director_state: makeEmptyDirectorState(),
    gameplay_state: makeEmptyGameplayState(),
    fork_debug: null,
  };
}

/**
 * Live (in-progress) governance scenario for prediction / capture cases.
 * status:"simulating" => `isSimulationComplete` stays false => prediction CTA on.
 * Keeps branches/agents so the predict modal selectors and gameplay preview
 * controls populate. The WS fixture for this id HOLDS open (no simulation_done).
 */
function makeGovernanceLiveScenario() {
  const base = makeGovernanceScenario();
  return {
    ...base,
    id: FIXTURE_SCENARIO_IDS.governanceLive,
    status: "simulating",
    // Branches start ACTIVE (still running) but remain selectable for the bet form.
    branches: base.branches.map((b) => ({ ...b, status: "ACTIVE", story: "", insight: "" })),
  };
}

function makeLawScenario() {
  const branches = [
    {
      id: "fx-law-branch-a",
      parent_branch_id: null,
      fork_round: 0,
      fork_reason: "",
      title: "紧急否决常态化",
      description: "最高法院的紧急否决权被频繁动用。",
      summary: "紧急否决",
      story: "最高法院反复动用紧急否决权，算法政策被逐条复核后才允许执行。",
      insight: "否决权一旦常态化，立法节奏被司法重新定义。",
      key_moments: ["首例紧急否决", "复核流程制度化"],
      probability: 0.7,
      status: "COMPLETED",
    },
    {
      id: "fx-law-branch-b",
      parent_branch_id: null,
      fork_round: 1,
      fork_reason: "triggered fork",
      title: "否决权受限",
      description: "立法机关收回部分否决空间。",
      summary: "否决受限",
      story: "立法机关通过新程序限制了紧急否决的适用范围。",
      insight: "权力制衡最终回到多方协商。",
      key_moments: ["程序性限制通过"],
      probability: 0.3,
      status: "COMPLETED",
    },
  ];
  const agents = [
    { id: "fx-law-agent-1", name: "首席大法官", role: "裁决者", tier: "CORE", emotion: "resolute" },
    { id: "fx-law-agent-2", name: "立法代表", role: "协商者", tier: "IMPORTANT", emotion: "measured" },
  ];
  return {
    id: FIXTURE_SCENARIO_IDS.law,
    question: "如果最高法院拥有暂停所有算法政策的紧急否决权，会发生什么？",
    status: "done",
    created_at: NOW_ISO,
    total_rounds: 3,
    mode: "blackboard",
    visualization_enabled: true,
    scene_theme: "law_court_variant",
    agents,
    branches,
    messages: [],
    groups: [],
    hierarchical: false,
    director_state: makeEmptyDirectorState(),
    gameplay_state: makeEmptyGameplayState(),
    fork_debug: null,
  };
}

function makeEmptyDirectorState() {
  return {
    revision: 0,
    objectives: {
      generated_for_question: null,
      generated_for_profile: null,
      goals: [],
      last_updated_at: null,
    },
    commitment: {
      active: false,
      branch_id: null,
      branch_title: null,
      committed_at_round: null,
      committed_at: null,
      outcome: null,
    },
  };
}

function makeEmptyGameplayState() {
  return {
    revision: 0,
    cards: { usage_log: [] },
    betting: { bets: [] },
    archive: { key_moments: [], branch_snapshots: [] },
  };
}

// ---------------------------------------------------------------------------
// Backend-derivation mirrors (see honesty note above)
// ---------------------------------------------------------------------------

function dominantBranch(scenario) {
  const branches = Array.isArray(scenario.branches) ? scenario.branches : [];
  return [...branches].sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0] ?? null;
}

/**
 * Mirror of the backend campaign summary derivation needed by the corner-case
 * predicates (director-state + gameplay-state roundtrips).
 */
function deriveCampaignSummary(scenario) {
  const director = scenario.director_state ?? makeEmptyDirectorState();
  const gameplay = scenario.gameplay_state ?? makeEmptyGameplayState();
  const usageLog = gameplay.cards?.usage_log ?? [];
  const bets = gameplay.betting?.bets ?? [];

  // most_used_card / counterplay
  const counts = new Map();
  for (const entry of usageLog) {
    counts.set(entry.card_id, (counts.get(entry.card_id) ?? 0) + 1);
  }
  let mostUsedCard = null;
  let mostUsedCount = 0;
  for (const [cardId, count] of counts) {
    if (count > mostUsedCount) {
      mostUsedCount = count;
      mostUsedCard = cardId;
    }
  }
  const lastCounterplayCard = usageLog.length ? usageLog[usageLog.length - 1].card_id : null;

  // commitment_outcome: the readback predicate asserts "hit" when an active
  // commitment exists against the dominant branch. Backend resolves
  // outcome:"pending" + commitment on dominant branch => "hit".
  const dom = dominantBranch(scenario);
  let commitmentOutcome = null;
  if (director.commitment?.active && director.commitment?.branch_id) {
    commitmentOutcome = director.commitment.branch_id === dom?.id ? "hit" : "miss";
  }

  const goals = director.objectives?.goals ?? [];
  return {
    scenario_id: scenario.id,
    has_campaign: true,
    profile_id: "governance",
    archive_grade: "B",
    profile_resonance: "aligned",
    betting_hit: bets.length > 0,
    most_used_card: mostUsedCard,
    completed_daily_challenge: false,
    objective_completed_count: goals.length,
    objective_total_count: goals.length,
    commitment_outcome: commitmentOutcome,
    counterplay_card_count: usageLog.length,
    last_counterplay_card: lastCounterplayCard,
    campaign_score_delta: 4,
    // finalized_at:null => ResultView won't auto-build a finalize-result (whose
    // render dereferences `.mastery.level`); the archive_summary fields above
    // still feed `displayArchive` for the roundtrip predicates.
    finalized_at: null,
  };
}

/**
 * Neutral campaign summary for case-owned scenarios with no fixture archive
 * (e.g. mock-result-loading-gate). `has_campaign: false` tells ResultView to set
 * campaignSummary = null and skip the finalize-result render (which dereferences
 * `.mastery.level`), matching the backend's no-campaign contract.
 */
function emptyCampaignSummary(scenarioId) {
  return { scenario_id: scenarioId, has_campaign: false, finalized_at: null };
}

/**
 * Full CampaignFinalizeResult (types.ts) for completed fixtures. ResultView's
 * finalize path dereferences `campaign.mastery.profile_id` + `.mastery.level`,
 * so the shape must be complete.
 */
function deriveCampaignFinalizeResult(scenario) {
  const summary = deriveCampaignSummary(scenario);
  return {
    scenario_id: scenario.id,
    already_finalized: false,
    campaign_score_delta: summary.campaign_score_delta ?? 0,
    score_breakdown: [],
    profile: {
      user_id: "fixture-director",
      user_name: "Fixture Director",
      total_runs: 3,
      completed_challenges: 1,
      total_bets: 2,
      hit_bets: 1,
      highest_archive_grade: "B",
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    },
    mastery: {
      profile_id: "governance",
      runs: 3,
      challenge_completions: 1,
      signature_hits: 1,
      aligned_hits: 1,
      campaign_score: 12,
      level: 1,
      best_archive_grade: "B",
      favorite_card_id: summary.most_used_card ?? null,
      next_level_score: 20,
      score_to_next_level: 8,
    },
    newly_unlocked_badges: [],
    badges: [],
  };
}

/** Lightweight capabilities fixture — keep gated SSE panels off to minimize surface. */
function capabilitiesFixture() {
  const off = { enabled: false, version: "1.0.0", server_only: false, degraded_mode: null };
  const on = { enabled: true, version: "1.0.0", server_only: false, degraded_mode: null };
  return {
    web_search: {
      enabled: false, version: "1.0.0", server_only: true, degraded_mode: null,
      scope: "server", server_enabled: false, method: "none", provider: null,
    },
    custom_agents: off,
    agent_identity: off,
    causal_graph: off,
    counterfactual_replay: on,
    factions: off,
    argument_map: off,
    agent_conversation: off,
    kg_explorer: off,
    replay_trace: off,
    graph_analysis: off,
    roundtable_survey: off,
    roundtable_analyst: off,
    snapshot_export: on,
    result_verdict: off,
  };
}

function makeStoryPayload(scenario) {
  return {
    scenario_id: scenario.id,
    question: scenario.question,
    status: scenario.status,
    branches: (scenario.branches ?? []).map((b) => ({ ...b })),
  };
}

function makeDirectorStatePayload(scenario) {
  const ds = scenario.director_state ?? makeEmptyDirectorState();
  return { scenario_id: scenario.id, ...ds };
}

function makeGameplayStatePayload(scenario) {
  const gs = scenario.gameplay_state ?? makeEmptyGameplayState();
  return { scenario_id: scenario.id, ...gs };
}

function makeChallengeDefinition(idx, profileId, question) {
  return {
    id: `fx-challenge-${idx}`,
    question,
    question_en: question,
    subtitle_zh: "夹具挑战",
    subtitle_en: "Fixture challenge",
    profile_id: profileId,
    rounds: 1,
    num_agents: 3,
    mode: "blackboard",
    visualization_enabled: true,
    difficulty_tier: "normal",
  };
}

/** Challenge rotation feeding the homepage daily + weekly challenge cards. */
function makeChallengeRotation(localDate) {
  return {
    local_date: localDate || NOW_ISO.slice(0, 10),
    week_key: "2026-W12",
    iso_week_key: "2026-W12",
    today_challenge: makeChallengeDefinition(0, "governance", "如果一座城市完全交给算法治理，会发生什么？"),
    weekly_challenges: [
      makeChallengeDefinition(1, "governance", "如果立法权与算法治理权相互制衡，会发生什么？"),
      makeChallengeDefinition(2, "law", "如果司法终审必须由合议庭复核，会发生什么？"),
      makeChallengeDefinition(3, "trade", "如果关键贸易枢纽被单一联盟垄断，会发生什么？"),
    ],
    weekly_track: null,
  };
}

function makeDailyChallengeStatus(userId, profileId, localDate) {
  return {
    user_id: userId,
    profile_id: profileId || "governance",
    local_date: localDate || NOW_ISO.slice(0, 10),
    timezone_offset_minutes: 0,
    completed: false,
    scenario_id: null,
    completed_at: null,
    most_used_card: null,
  };
}

function makeCampaignProfile() {
  return {
    user_id: "fixture-director",
    user_name: "Fixture Director",
    total_runs: 3,
    completed_challenges: 1,
    total_bets: 2,
    hit_bets: 1,
    highest_archive_grade: "B",
    campaign_score: 0,
    level: 1,
    dominant_profile_id: "governance",
    aligned_resonance_count: 0,
    off_axis_resonance_count: 0,
    betraying_resonance_count: 0,
    badges: [],
    weekly_summary: null,
    daily_challenge_status: null,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  };
}

// ---------------------------------------------------------------------------
// Fixture store
// ---------------------------------------------------------------------------

/**
 * In-memory fixture store shared by the Node-side fetch fixture and the browser
 * page fixtures. PUT director/gameplay state mutates the store; subsequent GET
 * reflects the write (read-after-write roundtrip).
 */
export function createFixtureStore() {
  const scenarios = new Map();
  scenarios.set(FIXTURE_SCENARIO_IDS.governance, makeGovernanceScenario());
  scenarios.set(FIXTURE_SCENARIO_IDS.governanceLive, makeGovernanceLiveScenario());
  scenarios.set(FIXTURE_SCENARIO_IDS.law, makeLawScenario());

  function getScenario(id) {
    return scenarios.get(id) ?? null;
  }

  function putDirectorState(id, payload) {
    const scenario = scenarios.get(id);
    if (!scenario) return null;
    const prev = scenario.director_state ?? makeEmptyDirectorState();
    scenario.director_state = {
      revision: (prev.revision ?? 0) + 1,
      objectives: payload.objectives ?? prev.objectives,
      commitment: payload.commitment ?? prev.commitment,
    };
    return makeDirectorStatePayload(scenario);
  }

  function putGameplayState(id, payload) {
    const scenario = scenarios.get(id);
    if (!scenario) return null;
    const prev = scenario.gameplay_state ?? makeEmptyGameplayState();
    scenario.gameplay_state = {
      revision: (prev.revision ?? 0) + 1,
      cards: payload.cards ?? prev.cards,
      betting: payload.betting ?? prev.betting,
      archive: payload.archive ?? prev.archive,
    };
    return makeGameplayStatePayload(scenario);
  }

  return {
    scenarios,
    getScenario,
    putDirectorState,
    putGameplayState,
    dominantBranch,
    deriveCampaignSummary,
    deriveCampaignFinalizeResult,
    capabilitiesFixture,
    makeStoryPayload,
    makeDirectorStatePayload,
    makeGameplayStatePayload,
    makeCampaignProfile,
    makeChallengeRotation,
    makeDailyChallengeStatus,
  };
}

// ---------------------------------------------------------------------------
// Shared URL routing — single source of truth for both node + browser layers
// ---------------------------------------------------------------------------

/**
 * Resolve a fixture response for an /api/** request.
 * Returns { status, json } when handled, or null when the request must be treated
 * as an escape (fail-closed).
 */
export function resolveApiFixture(store, { method, pathname, search }) {
  const m = method.toUpperCase();
  const q = search ?? "";
  const allows = (...methods) => methods.includes(m);

  // /api/capabilities
  if (pathname === "/api/capabilities") {
    if (!allows("GET")) return null;
    return { status: 200, json: store.capabilitiesFixture() };
  }

  // /api/scenarios?... (history list)
  if (pathname === "/api/scenarios") {
    if (!allows("GET")) return null;
    const scenarios = [...store.scenarios.values()].map((s) => ({
      id: s.id,
      question: s.question,
      status: s.status,
      created_at: s.created_at,
      agent_count: (s.agents ?? []).length,
    }));
    const params = new URLSearchParams(q.startsWith("?") ? q.slice(1) : q);
    const limit = Number(params.get("limit") ?? 12);
    const offset = Number(params.get("offset") ?? 0);
    return {
      status: 200,
      json: { total: scenarios.length, limit, offset, scenarios: scenarios.slice(offset, offset + limit) },
    };
  }

  // /api/leaderboard
  if (pathname === "/api/leaderboard") {
    if (!allows("GET")) return null;
    return { status: 200, json: { entries: [] } };
  }

  // /api/campaign/scenario/{id}/director-state  (GET/PUT)
  let match = pathname.match(/^\/api\/campaign\/scenario\/([^/]+)\/director-state$/);
  if (match) {
    if (!allows("GET", "PUT")) return null;
    const id = decodeURIComponent(match[1]);
    const scenario = store.getScenario(id);
    if (!scenario) return { defer: true };
    if (m === "PUT") return { status: 200, json: store.makeDirectorStatePayload(scenario), mutate: "director" };
    return { status: 200, json: store.makeDirectorStatePayload(scenario) };
  }

  // /api/campaign/scenario/{id}/gameplay-state  (GET/PUT)
  match = pathname.match(/^\/api\/campaign\/scenario\/([^/]+)\/gameplay-state$/);
  if (match) {
    if (!allows("GET", "PUT")) return null;
    const id = decodeURIComponent(match[1]);
    const scenario = store.getScenario(id);
    if (!scenario) return { defer: true };
    if (m === "PUT") return { status: 200, json: store.makeGameplayStatePayload(scenario), mutate: "gameplay" };
    return { status: 200, json: store.makeGameplayStatePayload(scenario) };
  }

  // /api/campaign/scenario/{id}/summary
  match = pathname.match(/^\/api\/campaign\/scenario\/([^/]+)\/summary$/);
  if (match) {
    if (!allows("GET")) return null;
    const id = decodeURIComponent(match[1]);
    const scenario = store.getScenario(id);
    if (!scenario) {
      // Case-owned scenario (e.g. mock-result-loading-gate): no campaign archive.
      return { status: 200, json: emptyCampaignSummary(id) };
    }
    return { status: 200, json: store.deriveCampaignSummary(scenario) };
  }

  // /api/campaign/scenario/{id}/finalize (POST) — full CampaignFinalizeResult.
  match = pathname.match(/^\/api\/campaign\/scenario\/([^/]+)\/finalize$/);
  if (match) {
    if (!allows("POST")) return null;
    const id = decodeURIComponent(match[1]);
    const scenario = store.getScenario(id);
    if (!scenario) {
      // Case-owned scenario without a fixture archive: signal missing campaign.
      return { status: 404, json: { detail: "no campaign" } };
    }
    return { status: 200, json: store.deriveCampaignFinalizeResult(scenario) };
  }

  // /api/campaign/challenges/rotation — homepage daily + weekly challenge cards
  if (pathname === "/api/campaign/challenges/rotation") {
    if (!allows("GET")) return null;
    const params = new URLSearchParams(q.startsWith("?") ? q.slice(1) : q);
    return { status: 200, json: store.makeChallengeRotation(params.get("local_date")) };
  }

  // /api/campaign/profile/{id}/daily-status — homepage daily challenge status
  match = pathname.match(/^\/api\/campaign\/profile\/([^/]+)\/daily-status$/);
  if (match) {
    if (!allows("GET")) return null;
    const params = new URLSearchParams(q.startsWith("?") ? q.slice(1) : q);
    return {
      status: 200,
      json: store.makeDailyChallengeStatus(decodeURIComponent(match[1]), params.get("profile_id"), params.get("local_date")),
    };
  }

  // /api/campaign/profile/{id}/(mastery|badges|weekly-summary)
  if (/^\/api\/campaign\/profile\/[^/]+\/mastery$/.test(pathname)) {
    if (!allows("GET")) return null;
    return { status: 200, json: [] };
  }
  if (/^\/api\/campaign\/profile\/[^/]+\/badges$/.test(pathname)) {
    if (!allows("GET")) return null;
    return { status: 200, json: [] };
  }
  if (/^\/api\/campaign\/profile\/[^/]+\/weekly-summary/.test(pathname)) {
    if (!allows("GET")) return null;
    return { status: 200, json: { user_id: decodeURIComponent(pathname.split("/")[4]), total_runs: 3, campaign_score_delta: 0, top_profile_id: "governance" } };
  }
  if (/^\/api\/campaign\/profile\/[^/]+$/.test(pathname)) {
    if (!allows("GET")) return null;
    return { status: 200, json: store.makeCampaignProfile() };
  }

  // /api/quota/summary
  if (pathname.startsWith("/api/quota/summary")) {
    if (!allows("GET")) return null;
    return { status: 200, json: { conversation: null, replay: null } };
  }

  // /api/replay-artifact (POST) — share artifact persistence
  if (pathname === "/api/replay-artifact") {
    if (!allows("POST")) return null;
    return {
      status: 201,
      json: { id: "fx-replay-artifact", kind: "scenario_result_v1", created_at: NOW_ISO },
    };
  }

  // /api/intervention-templates
  if (pathname === "/api/intervention-templates") {
    if (!allows("GET")) return null;
    return { status: 200, json: [] };
  }

  // /api/me/* (journal etc.) — empty
  if (pathname.startsWith("/api/me/")) {
    if (pathname === "/api/me/journal") {
      if (m === "GET") return { status: 200, json: { items: [], limit: 50, offset: 0 } };
      if (m === "POST") {
        return {
          status: 200,
          json: {
            id: 1,
            user_id: "fixture-user",
            scenario_id: null,
            question: "Fixture forecast",
            predicted_probability: 0.5,
            actual_outcome: null,
            resolved_at: null,
            created_at: NOW_ISO,
            brier_score: null,
          },
        };
      }
      return null;
    }
    if (pathname === "/api/me/calibration") {
      if (!allows("GET")) return null;
      return { status: 200, json: { bins: [] } };
    }
    if (/^\/api\/me\/journal\/[^/]+\/resolve$/.test(pathname)) {
      if (!allows("PATCH")) return null;
      return {
        status: 200,
        json: {
          id: 1,
          user_id: "fixture-user",
          scenario_id: null,
          question: "Fixture forecast",
          predicted_probability: 0.5,
          actual_outcome: true,
          resolved_at: NOW_ISO,
          created_at: NOW_ISO,
          brier_score: 0.25,
        },
      };
    }
    if (!allows("GET")) return null;
    return { status: 200, json: [] };
  }

  // /api/scenario/{id}/<sub>
  match = pathname.match(/^\/api\/scenario\/([^/]+)\/(.+)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const sub = match[2];
    const scenario = store.getScenario(id);

    // Scenario-AGNOSTIC, read-only background pollers: serve a safe empty value
    // for ANY scenario id (including per-case fixtures like mock-result-loading-
    // gate / fixture-live-fork-marker) so they never escape. These are harmless
    // and not stubbed by the case-owned fixtures.
    if (sub === "predictions") {
      if (!allows("GET")) return null;
      return { status: 200, json: [] };
    }
    if (sub.startsWith("checkpoints")) {
      if (!allows("GET")) return null;
      return { status: 200, json: [] };
    }
    if (sub.startsWith("faction-timeline")) {
      if (!allows("GET")) return null;
      return { status: 200, json: [] };
    }
    if (sub.startsWith("intervention-effects")) {
      if (!allows("GET")) return null;
      return { status: 200, json: { scenario_id: id, effects: [], applied: [] } };
    }
    if (sub.startsWith("replay-trace")) {
      if (!allows("GET")) return null;
      return { status: 200, json: { scenario_id: id, entries: [], timeline_markers: [], next_cursor: null } };
    }

    // Scenario-SPECIFIC payloads: only the store's own scenarios. Unknown ids are
    // owned by a per-case fixture -> defer so its explicit route wins (or the
    // fail-closed catch-all records a genuine escape).
    if (!scenario) return { defer: true };

    if (sub === "story") {
      if (!allows("GET")) return null;
      return { status: 200, json: store.makeStoryPayload(scenario) };
    }
    if (sub === "agents") {
      if (!allows("GET")) return null;
      return { status: 200, json: (scenario.agents ?? []).map((a) => ({ ...a })) };
    }
    if (sub.startsWith("branches")) {
      if (!allows("GET")) return null;
      return { status: 200, json: (scenario.branches ?? []).map((b) => ({ ...b })) };
    }
    if (sub === "predict") {
      if (!allows("POST")) return null;
      // Default success (cases that want failure register their own override first).
      return {
        status: 200,
        json: { id: "fx-pred", scenario_id: id, score: 80, score_reason: "fixture", confidence: 0.7 },
      };
    }
    if (sub.startsWith("social/")) {
      if (!allows("POST")) return null;
      return { status: 200, json: { copy: "夹具分享文案。", platform_name: "小红书" } };
    }
    if (sub === "export") {
      if (!allows("GET")) return null;
      return { status: 200, contentType: "text/markdown", body: "# Fixture\n" };
    }
    // Unknown sub-resource on a known scenario -> escape (fail-closed).
    return null;
  }

  // /api/scenario/{id} (bare GET) or DELETE
  match = pathname.match(/^\/api\/scenario\/([^/]+)$/);
  if (match) {
    if (!allows("GET", "DELETE")) return null;
    const id = decodeURIComponent(match[1]);
    if (m === "DELETE") {
      if (!store.scenarios.has(id)) return { defer: true };
      store.scenarios.delete(id);
      return { status: 200, json: { status: "deleted", scenario_id: id } };
    }
    const scenario = store.getScenario(id);
    if (!scenario) return { defer: true };
    return { status: 200, json: scenario };
  }

  // /api/scenario (POST create) — return the LIVE governance fixture so the
  // prediction / capture cases (createScenarioViaApi -> navigate /sim) land on an
  // in-progress sim where can_open_prediction is true.
  if (pathname === "/api/scenario" && m === "POST") {
    return { status: 200, json: store.getScenario(FIXTURE_SCENARIO_IDS.governanceLive) };
  }

  // POST /api/scenario/{id}/predict on a live scenario must NOT mark complete.

  // Unhandled -> escape.
  return null;
}

// ---------------------------------------------------------------------------
// Node-side fetch fixture
// ---------------------------------------------------------------------------

/**
 * Monkey-patch globalThis.fetch so the suite's own Node helpers
 * (createScenarioViaApi / getScenarioViaApi / put*State / resolveMatrixScenario)
 * are served from the store. Returns { escapes, restore }.
 *
 * Fail-closed: any uncovered /api/** request is recorded into `escapes` and
 * rejected — it never reaches the network. Non-/api fetches pass through.
 */
export function installNodeFetchFixture(store) {
  const escapes = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = async function fixtureFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    let parsed;
    try {
      parsed = new URL(url, "http://fixture.local");
    } catch {
      return realFetch(input, init);
    }
    if (!parsed.pathname.startsWith("/api/")) {
      // e.g. Safari WebDriver protocol — pass through to real fetch.
      return realFetch(input, init);
    }

    const method = (init.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    let bodyJson = null;
    if (init.body) {
      try { bodyJson = JSON.parse(init.body); } catch { bodyJson = null; }
    }

    const resolved = resolveApiFixture(store, {
      method,
      pathname: parsed.pathname,
      search: parsed.search,
    });

    if (!resolved || resolved.defer) {
      escapes.push({ method, url: parsed.pathname + parsed.search });
      // Fail-closed: synthesize an error response, never hit the network.
      return makeNodeResponse(503, { detail: "fixture escape (node)", path: parsed.pathname });
    }

    if (resolved.mutate === "director" && bodyJson) {
      const id = decodeURIComponent(parsed.pathname.split("/")[4]);
      const updated = store.putDirectorState(id, bodyJson);
      return makeNodeResponse(200, updated);
    }
    if (resolved.mutate === "gameplay" && bodyJson) {
      const id = decodeURIComponent(parsed.pathname.split("/")[4]);
      const updated = store.putGameplayState(id, bodyJson);
      return makeNodeResponse(200, updated);
    }

    if (resolved.body != null) {
      return makeNodeTextResponse(resolved.status, resolved.body, resolved.contentType ?? "text/plain");
    }
    return makeNodeResponse(resolved.status, resolved.json);
  };

  return {
    escapes,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

function makeNodeResponse(status, json) {
  const body = JSON.stringify(json ?? null);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeNodeTextResponse(status, text, contentType) {
  return new Response(text, { status, headers: { "Content-Type": contentType } });
}

// ---------------------------------------------------------------------------
// Browser-side page fixtures
// ---------------------------------------------------------------------------

/**
 * Install the fail-closed catch-all + per-endpoint fixture routes on a page.
 * Returns { unhandled } — an array the caller asserts is empty at suite end.
 *
 * The catch-all is registered FIRST so Playwright's LIFO ordering makes it the
 * final fallback; specific routes registered afterward take precedence.
 *
 * `predictOverrides` lets a case force a specific predict/social response BEFORE
 * the generic fixtures (registered after => higher precedence in LIFO).
 */
export async function installApiFixtures(page, store, options = {}) {
  const unhandled = [];
  const json = (b, s = 200) => ({ status: s, contentType: "application/json", body: JSON.stringify(b ?? null) });

  // 1) fail-closed catch-all (registered first => runs last)
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      unhandled.push({ method: route.request().method(), url: route.request().url() });
      return route.fulfill(json({ detail: "Unhandled fixture API request" }, 404));
    },
  );

  // 2) generic resolver for everything the store knows about
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method().toUpperCase();
    const parsed = new URL(request.url());
    let bodyJson = null;
    const postData = request.postData();
    if (postData) {
      try { bodyJson = JSON.parse(postData); } catch { bodyJson = null; }
    }

    const resolved = resolveApiFixture(store, {
      method,
      pathname: parsed.pathname,
      search: parsed.search,
    });

    if (!resolved || resolved.defer) {
      // Defer: either a per-case route owns this (registered later => wins in
      // LIFO), or it falls through to the fail-closed catch-all (records + 404).
      return route.fallback();
    }

    if (resolved.mutate === "director" && bodyJson) {
      const id = decodeURIComponent(parsed.pathname.split("/")[4]);
      const updated = store.putDirectorState(id, bodyJson);
      return route.fulfill(json(updated));
    }
    if (resolved.mutate === "gameplay" && bodyJson) {
      const id = decodeURIComponent(parsed.pathname.split("/")[4]);
      const updated = store.putGameplayState(id, bodyJson);
      return route.fulfill(json(updated));
    }
    if (resolved.body != null) {
      return route.fulfill({
        status: resolved.status,
        contentType: resolved.contentType ?? "text/plain",
        body: resolved.body,
      });
    }
    return route.fulfill(json(resolved.json, resolved.status));
  });

  // 3) optional per-case overrides (registered last => highest precedence)
  if (Array.isArray(options.overrides)) {
    for (const ov of options.overrides) {
      await page.route(ov.pattern, ov.handler);
    }
  }

  return { unhandled };
}

// ---------------------------------------------------------------------------
// Browser-side WebSocket fixture (completed-state driver)
// ---------------------------------------------------------------------------

function scenarioToWsConfig(scenario, { complete }) {
  const branches = scenario.branches ?? [];
  const primary = branches[0] ?? null;
  const fork = branches.find((b) => (b.fork_round ?? 0) > 0) ?? null;
  return {
    scenarioId: scenario.id,
    complete,
    agents: (scenario.agents ?? []).map((a) => ({ id: a.id, name: a.name, emotion: a.emotion ?? "neutral" })),
    primaryBranch: primary
      ? { id: primary.id, title: primary.title, probability: primary.probability ?? 1 }
      : { id: "fx-root", title: "Root", probability: 1 },
    forkBranch: fork
      ? { id: fork.id, title: fork.title, parent: fork.parent_branch_id ?? primary?.id ?? null, fork_round: fork.fork_round ?? 1 }
      : null,
    totalRounds: scenario.total_rounds ?? 3,
  };
}

/**
 * Build an addInitScript-compatible (fn, arg) pair installing a FixtureWebSocket
 * that handles MULTIPLE `/ws/scenario/{id}` streams offline:
 *   - completed scenarios replay a compressed lifecycle ending in simulation_done
 *     (Theater/result/replay predicates resolve);
 *   - live scenarios stream activity but HOLD open (no simulation_done) so the
 *     prediction CTA gate `!isSimulationComplete` stays satisfied.
 * The first frame replies `auth_ok` to the client's `auth` frame.
 *
 * FAIL-CLOSED (M-fixture High fix): a same-origin `/ws/**` connection that does
 * NOT match a fixture scenario (e.g. `/ws/debate/...`, `/ws/ending-room/...`,
 * `/ws/agent-conversation/...`, or `/ws/scenario/{unknown}`) is treated as a
 * network ESCAPE — it is recorded into the persistent suite recorder and the
 * socket is failed (async `error` + `close` 1011) WITHOUT ever opening a native
 * WebSocket to the backend. `/ws/**` is treated as backend surface even when
 * constructed with an absolute cross-origin URL. Only explicitly-allowlisted
 * non-backend sockets (e.g. Vite HMR/internal) fall through to native WebSocket
 * so dev-server live-reload keeps working.
 *
 * @param {Array<{scenario: object, complete: boolean}>} entries
 */
export function buildFixtureWsInitScript(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const configs = list.map((e) =>
    e && e.scenario
      ? scenarioToWsConfig(e.scenario, { complete: e.complete !== false })
      : scenarioToWsConfig(e, { complete: true }),
  );
  const arg = { configs };

  function initScript(cfgArg) {
    const NativeWebSocket = window.WebSocket;
    const byId = new Map((cfgArg.configs || []).map((c) => [c.scenarioId, c]));
    if (!Array.isArray(window.__fixtureWsEscapes__)) {
      window.__fixtureWsEscapes__ = [];
    }

    function recordWsEscape(entry) {
      window.__fixtureWsEscapes__.push(entry);
      const recorder = window.__recordFixtureWsEscape;
      if (typeof recorder === "function") {
        Promise.resolve(recorder(entry)).catch(() => {});
      }
    }

    // Allowlist of NON-backend sockets that may use the native impl:
    //  - cross-origin non-/ws sockets: never the proxied backend surface;
    //  - Vite HMR / internal dev sockets (path starts with /@vite or has the
    //    `vite-hmr` subprotocol) so dev-server live-reload is not broken.
    function isAllowlistedNativeWs(parsed, protocols) {
      try {
        if (parsed.pathname.startsWith("/ws/")) return false;
        if (parsed.host !== window.location.host) return true;
      } catch { /* fall through */ }
      if (/^\/@vite\b|^\/@react-refresh\b|\/__vite_hmr\b/.test(parsed.pathname)) return true;
      const protoList = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      if (protoList.some((p) => String(p).includes("vite-hmr"))) return true;
      return false;
    }

    class FixtureWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url, protocols) {
        this.url = String(url);
        this.protocols = protocols;
        this.readyState = FixtureWebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.binaryType = "blob";
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.onclose = null;
        this._listeners = new Map();
        this._timers = [];
        this._cfg = null;

        let parsed = null;
        try { parsed = new URL(this.url, window.location.href); } catch { parsed = null; }

        // Allowlisted non-backend socket (non-/ws cross-origin / Vite HMR): use native.
        if (parsed && isAllowlistedNativeWs(parsed, protocols)) {
          return new NativeWebSocket(url, protocols);
        }

        const match = parsed ? parsed.pathname.match(/\/ws\/scenario\/([^/?#]+)$/) : null;
        const id = match ? decodeURIComponent(match[1]) : null;
        this._cfg = id ? byId.get(id) ?? null : null;

        if (!this._cfg) {
          // Same-origin /ws/** with no fixture: FAIL-CLOSED, record as escape,
          // never open a native socket to the (proxied) backend.
          recordWsEscape({
            url: this.url,
            pathname: parsed ? parsed.pathname : this.url,
          });
          this._schedule(() => {
            this.readyState = FixtureWebSocket.CLOSED;
            this._emit("error", new Event("error"));
            this._emit("close", new CloseEvent("close", { code: 1011, reason: "fixture ws escape", wasClean: false }));
          }, 10);
          return;
        }

        this._schedule(() => {
          this.readyState = FixtureWebSocket.OPEN;
          this._emit("open", new Event("open"));
          // First-frame auth handshake.
          this._send({ type: "auth_ok", data: {} });
          this._replay();
        }, 20);
      }

      _send(payload, index = 0) {
        this._emit(
          "message",
          new MessageEvent("message", {
            data: JSON.stringify({
              ...payload,
              meta: {
                stream_id: this._cfg.scenarioId,
                sequence: index + 1,
                event_id: `${this._cfg.scenarioId}:${index + 1}`,
                manager_instance_id: "fixture-ws",
                emitted_at: new Date().toISOString(),
              },
            }),
          }),
        );
      }

      _replay() {
        const cfg = this._cfg;
        const primary = cfg.primaryBranch;
        const events = [];
        events.push({ type: "status", data: { status: "simulating", hierarchical: false } });
        events.push({
          type: "branch_init",
          data: { branch_id: primary.id, title: primary.title, probability: primary.probability, parent_branch_id: null },
        });
        for (const agent of cfg.agents) {
          events.push({
            type: "agent_speak_start",
            data: { agent: agent.name, agent_id: agent.id, branch: primary.id, round: 1 },
          });
          events.push({
            type: "agent_speak",
            data: {
              agent: agent.name, agent_id: agent.id,
              message: `${agent.name} 在第一轮给出推演立场。`,
              emotion: agent.emotion, branch: primary.id, round: 1,
            },
          });
        }
        events.push({
          type: "round_summary",
          data: { branch_id: primary.id, round: 1, summary: "第一轮推演完成。" },
        });
        if (cfg.forkBranch) {
          events.push({
            type: "branch_fork",
            data: {
              branch_id: cfg.forkBranch.id,
              parent_branch_id: cfg.forkBranch.parent,
              title: cfg.forkBranch.title,
              fork_round: cfg.forkBranch.fork_round,
              fork_reason: "triggered fork",
              probability: 0.4,
            },
          });
        }
        if (cfg.complete) {
          events.push({
            type: "narration",
            data: { branch_id: primary.id, story: "夹具叙事：推演已经完成，世界线收束。" },
          });
          events.push({ type: "simulation_done", data: { status: "done" } });
        }
        // Live scenarios: stop here (no simulation_done) so the sim stays in
        // progress and the prediction CTA remains available.

        events.forEach((payload, index) => {
          this._schedule(() => this._send(payload, index), 60 * (index + 1));
        });
      }

      _schedule(fn, delay) {
        const timer = window.setTimeout(fn, delay);
        this._timers.push(timer);
      }

      _emit(type, event) {
        const handler = this[`on${type}`];
        if (typeof handler === "function") handler.call(this, event);
        const listeners = this._listeners.get(type) || [];
        for (const listener of listeners) {
          try { listener.call(this, event); } catch { /* ignore */ }
        }
      }

      addEventListener(type, listener) {
        const listeners = this._listeners.get(type) || [];
        listeners.push(listener);
        this._listeners.set(type, listeners);
      }

      removeEventListener(type, listener) {
        const listeners = this._listeners.get(type) || [];
        this._listeners.set(type, listeners.filter((entry) => entry !== listener));
      }

      send() { /* swallow auth + control frames */ }

      close(code = 1000) {
        if (this.readyState === FixtureWebSocket.CLOSED) return;
        this.readyState = FixtureWebSocket.CLOSING;
        for (const timer of this._timers) window.clearTimeout(timer);
        this._timers = [];
        this.readyState = FixtureWebSocket.CLOSED;
        this._emit("close", new CloseEvent("close", { code, wasClean: true }));
      }
    }

    FixtureWebSocket.__swarmFixtureNet = true;
    window.WebSocket = FixtureWebSocket;
  }

  return { fn: initScript, arg };
}
