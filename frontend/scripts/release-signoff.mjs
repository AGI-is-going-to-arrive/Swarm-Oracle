import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFrontendRoutesReady,
  buildPhase3BatchAPreflightPaths,
  buildPhase3BatchBPreflightPaths,
} from "./lib/frontendPreflight.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const BACKEND_ROOT = path.join(REPO_ROOT, "backend");
const IS_MAIN_MODULE = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";
const VALID_DEBATE_ADJUDICATION_MODES = new Set(["deterministic", "llm_hybrid"]);
const GRAPH_FOCUSED_VITEST_TESTS = [
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
  "src/i18n/locales.test.ts",
];
const GRAPH_E2E_STEP_IDS = [
  "phase3a_graph_default",
  "phase3b_graph_default",
  "phase3c_result_graphs",
  "phase3a_graph_zh",
  "phase3b_graph_zh",
  "phase3a_graph_firefox",
  "phase3b_graph_firefox",
  "phase3a_graph_webkit",
  "phase3b_graph_webkit",
];
const ROUND7_CHECK_STEP_IDS = [
  "agent_conversation_ws_endpoint",
  "scenario_deleted_terminal",
  "x_org_id_header",
  "cmd_r_suppress_reload",
  "snap_cycle_70_100_40",
];
const ROUND7_GRAPH_LIVE_STEP_IDS = [
  "phase3a_graph_default",
  "phase3b_graph_default",
  "phase3c_result_graphs",
  "phase3a_graph_zh",
  "phase3b_graph_zh",
];
const PREDICTION_FOCUSED_STEP_IDS = [
  "prediction_modal_late_branches",
];
const BACKEND_SIGNOFF_TESTS = [
  "tests/test_campaign_api.py",
  "tests/test_campaign_service.py",
  "tests/test_debate_api.py",
  "tests/test_debate_service.py",
  "tests/test_config.py",
  "tests/test_predictions.py",
  "tests/test_card_events.py",
  "tests/test_gameplay_contract_sync.py",
  "tests/test_metrics.py",
];
const PYTHON_HTTP_CHECK_SCRIPT = [
  "import sys, urllib.request",
  "url = sys.argv[1]",
  "expected_type = sys.argv[2]",
  "expected_body = sys.argv[3]",
  "with urllib.request.urlopen(url, timeout=10) as response:",
  "    body = response.read().decode('utf-8', errors='replace')",
  "    content_type = response.headers.get('content-type', '')",
  "    if response.status >= 400:",
  "        raise SystemExit(f'HTTP {response.status} for {url}')",
  "    if expected_type and expected_type not in content_type:",
  "        raise SystemExit(f'Unexpected content-type for {url}: {content_type}')",
  "    if expected_body and expected_body not in body:",
  "        raise SystemExit(f'Missing expected body marker for {url}: {expected_body}')",
].join("\n");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getDefaultBackendPython() {
  if (process.platform === "win32") {
    return path.join(BACKEND_ROOT, ".venv", "Scripts", "python.exe");
  }

  return path.join(BACKEND_ROOT, ".venv", "bin", "python");
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveFrontendPath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  const normalized = inputPath.replace(/^\.\/+/, "");
  if (normalized === "frontend" || normalized.startsWith("frontend/")) {
    return path.join(REPO_ROOT, normalized);
  }
  return path.join(FRONTEND_ROOT, normalized);
}

function summaryPathFor(outputRoot) {
  return path.join(outputRoot, "summary.json");
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    backendUrl: DEFAULT_BACKEND_URL,
    outputRoot: resolveFrontendPath(path.join("output", "e2e", `${timestampLabel()}-release-signoff`)),
    headless: process.env.HEADLESS === "1",
    dryRun: false,
    includeSafari: false,
    includeBackendChecks: process.env.SWARM_SKIP_BACKEND_CHECKS !== "1",
    includeAssetsCheck: process.env.SWARM_SKIP_ASSETS_CHECK !== "1",
    webdriverUrl: process.env.SAFARI_WEBDRIVER_URL || "http://127.0.0.1:4444",
    scenarioId: process.env.SWARM_SCENARIO_ID || "",
    backendPython: process.env.SWARM_BACKEND_PYTHON || getDefaultBackendPython(),
    requireDebateAdjudicationMode: process.env.SWARM_REQUIRE_DEBATE_ADJUDICATION_MODE || "",
    invocationLabel: process.env.SWARM_SIGNOFF_LABEL || process.env.GITHUB_WORKFLOW || "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
      index += 1;
    } else if (arg === "--backend-url" && next) {
      args.backendUrl = next;
      index += 1;
    } else if (arg === "--output-root" && next) {
      args.outputRoot = resolveFrontendPath(next);
      index += 1;
    } else if (arg === "--webdriver-url" && next) {
      args.webdriverUrl = next;
      index += 1;
    } else if (arg === "--scenario-id" && next) {
      args.scenarioId = next;
      index += 1;
    } else if (arg === "--backend-python" && next) {
      args.backendPython = path.isAbsolute(next) ? next : path.resolve(REPO_ROOT, next);
      index += 1;
    } else if (arg === "--require-debate-adjudication-mode" && next) {
      args.requireDebateAdjudicationMode = next;
      index += 1;
    } else if (arg === "--invocation-label" && next) {
      args.invocationLabel = next;
      index += 1;
    } else if (arg === "--headless") {
      args.headless = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--include-safari") {
      args.includeSafari = true;
    } else if (arg === "--skip-backend-checks") {
      args.includeBackendChecks = false;
    } else if (arg === "--skip-assets-check") {
      args.includeAssetsCheck = false;
    } else {
      throw new Error(
        "Usage: node scripts/release-signoff.mjs [--url URL] [--backend-url URL] [--output-root DIR] [--headless] [--include-safari] [--webdriver-url URL] [--scenario-id ID] [--backend-python PATH] [--require-debate-adjudication-mode deterministic|llm_hybrid] [--invocation-label LABEL] [--skip-backend-checks] [--skip-assets-check] [--dry-run]",
      );
    }
  }

  if (
    args.requireDebateAdjudicationMode
    && !VALID_DEBATE_ADJUDICATION_MODES.has(args.requireDebateAdjudicationMode)
  ) {
    throw new Error(
      `Unsupported debate adjudication mode requirement: ${args.requireDebateAdjudicationMode}`,
    );
  }

  return args;
}

function readExecutionContext(invocationLabel) {
  return {
    ci: process.env.CI === "true",
    invocation_label: invocationLabel || null,
    github: {
      workflow: process.env.GITHUB_WORKFLOW || null,
      event_name: process.env.GITHUB_EVENT_NAME || null,
      ref: process.env.GITHUB_REF || null,
      ref_name: process.env.GITHUB_REF_NAME || null,
      sha: process.env.GITHUB_SHA || null,
      run_id: process.env.GITHUB_RUN_ID || null,
      run_attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      actor: process.env.GITHUB_ACTOR || null,
    },
  };
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function runCommand(command, args, options) {
  const rendered = formatCommand(command, args);
  console.log(`\n$ ${rendered}`);
  if (options.dryRun) return;

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? FRONTEND_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${rendered}`);
  }
}

function serializeError(error) {
  if (!(error instanceof Error)) return { message: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
  };
}

function captureCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? FRONTEND_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function readGitMetadata() {
  try {
    const repoRoot = captureCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: REPO_ROOT,
    });
    if (repoRoot.status !== 0) {
      throw new Error(repoRoot.stderr.trim() || "git rev-parse failed");
    }

    const commit = captureCommand("git", ["log", "-1", "--format=%H%n%cI%n%s"], {
      cwd: REPO_ROOT,
    });
    if (commit.status !== 0) {
      throw new Error(commit.stderr.trim() || "git log failed");
    }

    const branch = captureCommand("git", ["branch", "--show-current"], {
      cwd: REPO_ROOT,
    });
    const worktree = captureCommand("git", ["status", "--short", "--branch"], {
      cwd: REPO_ROOT,
    });

    const [commitSha = "", committedAt = "", subject = ""] = commit.stdout.trim().split("\n");
    const worktreeStatus = worktree.stdout.trim();

    return {
      available: true,
      repo_root: repoRoot.stdout.trim(),
      branch: branch.status === 0 ? branch.stdout.trim() || null : null,
      commit: {
        sha: commitSha || null,
        committed_at: committedAt || null,
        subject: subject || null,
      },
      worktree: {
        status: worktreeStatus || "clean",
        dirty: worktreeStatus.split("\n").some((line) => line && !line.startsWith("##")),
      },
    };
  } catch (error) {
    return {
      available: false,
      error: serializeError(error),
    };
  }
}

function writeSummary(outputRoot, summary) {
  ensureDir(outputRoot);
  fs.writeFileSync(summaryPathFor(outputRoot), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function runStep(summary, runArgs, stepId, command, commandArgs, options = {}) {
  const startedAt = new Date().toISOString();
  const step = {
    id: stepId,
    status: "running",
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    command: formatCommand(command, commandArgs),
    cwd: options.cwd ?? FRONTEND_ROOT,
    artifact_dir: options.artifactDir ?? null,
    result_file: options.resultFile ?? null,
    browser_launch_file: options.browserLaunchFile ?? null,
    error: null,
  };
  summary.steps.push(step);
  writeSummary(runArgs.outputRoot, summary);

  const startTime = Date.now();
  try {
    runCommand(command, commandArgs, { ...runArgs, ...options });
    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    step.error = serializeError(error);
    throw error;
  } finally {
    step.finished_at = new Date().toISOString();
    step.duration_ms = Date.now() - startTime;
    writeSummary(runArgs.outputRoot, summary);
  }
}

function buildRound7GraphLiveStepSpecs(baseUrl, headless = false) {
  return [
    {
      id: "phase3a_graph_default",
      commandArgs: [
        "scripts/e2e-phase3-batch-a.mjs",
        "full",
        ...(headless ? ["--headless"] : []),
      ],
      env: {
        SWARM_URL: baseUrl,
        SWARM_E2E_MODE: "live",
      },
    },
    {
      id: "phase3b_graph_default",
      commandArgs: [
        "scripts/e2e-phase3-batch-b.mjs",
        "full",
        ...(headless ? ["--headless"] : []),
      ],
      env: {
        SWARM_URL: baseUrl,
        SWARM_E2E_MODE: "live",
      },
    },
    {
      id: "phase3c_result_graphs",
      commandArgs: [
        "scripts/e2e-phase3-batch-c.mjs",
        "full",
        ...(headless ? ["--headless"] : []),
      ],
      env: {
        SWARM_URL: baseUrl,
        SWARM_E2E_MODE: "live",
      },
    },
    {
      id: "phase3a_graph_zh",
      commandArgs: [
        "scripts/e2e-phase3-batch-a.mjs",
        "full",
        ...(headless ? ["--headless"] : []),
      ],
      env: {
        SWARM_URL: baseUrl,
        SWARM_E2E_MODE: "live",
        SWARM_E2E_LOCALE: "zh-CN",
      },
    },
    {
      id: "phase3b_graph_zh",
      commandArgs: [
        "scripts/e2e-phase3-batch-b.mjs",
        "full",
        ...(headless ? ["--headless"] : []),
      ],
      env: {
        SWARM_URL: baseUrl,
        SWARM_E2E_MODE: "live",
        SWARM_E2E_LOCALE: "zh-CN",
      },
    },
  ];
}

function registerRound7GraphLiveSteps({
  summary,
  args,
  baseUrl,
  nodeCommand,
  runStep: runStepImpl = runStep,
}) {
  for (const spec of buildRound7GraphLiveStepSpecs(baseUrl, args.headless)) {
    runStepImpl(summary, args, spec.id, nodeCommand, spec.commandArgs, {
      env: spec.env,
    });
  }
}

function buildPredictionFocusedStepSpecs(baseUrl, outputRoot, headless) {
  const predictLateBranchesOutput = path.join(outputRoot, "predict-late-branches");
  return [
    {
      id: "prediction_modal_late_branches",
      commandArgs: [
        "scripts/e2e-automation.mjs",
        "predict-late-branches",
        "--url",
        baseUrl,
        "--output-dir",
        predictLateBranchesOutput,
        ...(headless ? ["--headless"] : []),
      ],
      artifactDir: predictLateBranchesOutput,
      resultFile: path.join(predictLateBranchesOutput, "result.json"),
    },
  ];
}

function registerPredictionFocusedSteps({
  summary,
  args,
  baseUrl,
  outputRoot,
  headless,
  nodeCommand,
  runStep: runStepImpl = runStep,
}) {
  for (const spec of buildPredictionFocusedStepSpecs(baseUrl, outputRoot, headless)) {
    runStepImpl(summary, args, spec.id, nodeCommand, spec.commandArgs, {
      artifactDir: spec.artifactDir,
      resultFile: spec.resultFile,
    });
  }
}

async function runAsyncStep(summary, runArgs, stepId, runner, options = {}) {
  const startedAt = new Date().toISOString();
  const step = {
    id: stepId,
    status: "running",
    started_at: startedAt,
    finished_at: null,
    duration_ms: null,
    command: options.command ?? stepId,
    cwd: options.cwd ?? FRONTEND_ROOT,
    artifact_dir: options.artifactDir ?? null,
    result_file: options.resultFile ?? null,
    browser_launch_file: options.browserLaunchFile ?? null,
    error: null,
  };
  summary.steps.push(step);
  writeSummary(runArgs.outputRoot, summary);

  const startTime = Date.now();
  try {
    if (!runArgs.dryRun) {
      await runner();
    }
    step.status = "passed";
  } catch (error) {
    step.status = "failed";
    step.error = serializeError(error);
    throw error;
  } finally {
    step.finished_at = new Date().toISOString();
    step.duration_ms = Date.now() - startTime;
    writeSummary(runArgs.outputRoot, summary);
  }
}

function buildSuiteArgs(scriptName, mode, baseUrl, outputDir, headless, scenarioId) {
  const args = [scriptName, mode, "--url", baseUrl, "--output-dir", outputDir];
  if (headless) args.push("--headless");
  if (scenarioId) args.push("--scenario-id", scenarioId);
  return args;
}

function buildGraphPreflightPaths() {
  return [
    ...buildPhase3BatchAPreflightPaths(),
    ...buildPhase3BatchBPreflightPaths(),
  ];
}

function buildGraphFocusedVitestArgs() {
  return ["test", "--", "--run", ...GRAPH_FOCUSED_VITEST_TESTS];
}

function buildHttpCheckArgs(url, expectedContentType = "", expectedBodyMarker = "") {
  return ["-c", PYTHON_HTTP_CHECK_SCRIPT, url, expectedContentType, expectedBodyMarker];
}

function ensureBackendPythonExists(pythonPath) {
  if (fs.existsSync(pythonPath)) return;

  throw new Error(
    `Backend Python not found: ${pythonPath}\n` +
      "Create backend/.venv, pass --backend-python PATH, or use --skip-backend-checks.",
  );
}

export const __test__ = {
  buildGraphPreflightPaths,
  buildGraphFocusedVitestArgs,
  buildRound7GraphLiveStepSpecs,
  buildPredictionFocusedStepSpecs,
  registerRound7GraphLiveSteps,
  registerPredictionFocusedSteps,
  graphE2EStepIds: GRAPH_E2E_STEP_IDS,
  graphFocusedVitestTests: GRAPH_FOCUSED_VITEST_TESTS,
  predictionFocusedStepIds: PREDICTION_FOCUSED_STEP_IDS,
  round7CheckStepIds: ROUND7_CHECK_STEP_IDS,
  round7GraphLiveStepIds: ROUND7_GRAPH_LIVE_STEP_IDS,
};

async function main() {
  const args = parseArgs(process.argv);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const nodeCommand = process.execPath;

  const cornersOutput = path.join(args.outputRoot, "corners");
  const mobileOutput = path.join(args.outputRoot, "mobile");
  const crossBrowserOutput = path.join(args.outputRoot, "cross-browser");
  const roundtableFirefoxOutput = path.join(args.outputRoot, "roundtable-firefox");
  const roundtableWebkitOutput = path.join(args.outputRoot, "roundtable-webkit");
  const roundtableEnFirefoxOutput = path.join(args.outputRoot, "roundtable-en-firefox");
  const roundtableEnWebkitOutput = path.join(args.outputRoot, "roundtable-en-webkit");
  const debateOutput = path.join(args.outputRoot, "debate-full");
  const debateFirefoxOutput = path.join(args.outputRoot, "debate-firefox");
  const debateWebkitOutput = path.join(args.outputRoot, "debate-webkit");
  // QA-2 — Tier 1 live suites for the graph-playability-upgrade delivery.
  const nodeConversationLiveOutput = path.join(args.outputRoot, "node-conversation-live");
  const kgExplorerLiveOutput = path.join(args.outputRoot, "kg-explorer-live");
  const replayViewLiveOutput = path.join(args.outputRoot, "replay-view-live");
  const webSearchLiveOutput = path.join(args.outputRoot, "web-search-live");
  const capabilityMatrixOutput = path.join(args.outputRoot, "capability-matrix");
  const newSourceIngestionLiveOutput = path.join(args.outputRoot, "new-source-ingestion-live");
  const phase3aFirefoxOutput = path.join(args.outputRoot, "phase3a-firefox");
  const phase3bFirefoxOutput = path.join(args.outputRoot, "phase3b-firefox");
  const phase3aWebkitOutput = path.join(args.outputRoot, "phase3a-webkit");
  const phase3bWebkitOutput = path.join(args.outputRoot, "phase3b-webkit");
  const endingRoomOutput = path.join(args.outputRoot, "ending-room-followup");
  const endingRoomEnOutput = path.join(args.outputRoot, "ending-room-followup-en");
  const endingRoomFirefoxOutput = path.join(args.outputRoot, "ending-room-followup-firefox");
  const endingRoomWebkitOutput = path.join(args.outputRoot, "ending-room-followup-webkit");
  const endingRoomEnFirefoxOutput = path.join(args.outputRoot, "ending-room-followup-en-firefox");
  const endingRoomEnWebkitOutput = path.join(args.outputRoot, "ending-room-followup-en-webkit");
  const roundtableOutput = path.join(args.outputRoot, "roundtable-full");
  const roundtableEnOutput = path.join(args.outputRoot, "roundtable-en");
  const safariOutput = path.join(args.outputRoot, "safari");
  const summary = {
    version: 1,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    base_url: args.baseUrl,
    backend_url: args.backendUrl,
    output_root: args.outputRoot,
    headless: args.headless,
    include_safari: args.includeSafari,
    include_backend_checks: args.includeBackendChecks,
    include_assets_check: args.includeAssetsCheck,
    require_debate_adjudication_mode: args.requireDebateAdjudicationMode || null,
    webdriver_url: args.includeSafari ? args.webdriverUrl : null,
    scenario_id: args.scenarioId || null,
    execution_context: readExecutionContext(args.invocationLabel),
    git: readGitMetadata(),
    steps: [],
    error: null,
  };
  writeSummary(args.outputRoot, summary);

  console.log("Release signoff plan:");
  console.log(`- frontend root: ${FRONTEND_ROOT}`);
  console.log(`- base url: ${args.baseUrl}`);
  console.log(`- backend url: ${args.backendUrl}`);
  console.log(`- output root: ${args.outputRoot}`);
  console.log(`- headless: ${args.headless ? "true" : "false"}`);
  console.log(`- include safari: ${args.includeSafari ? "true" : "false"}`);
  console.log(`- backend checks: ${args.includeBackendChecks ? "true" : "false"}`);
  console.log(`- assets check: ${args.includeAssetsCheck ? "true" : "false"}`);
  if (args.requireDebateAdjudicationMode) {
    console.log(`- required debate adjudication mode: ${args.requireDebateAdjudicationMode}`);
  }
  if (args.invocationLabel) {
    console.log(`- invocation label: ${args.invocationLabel}`);
  }
  if (args.scenarioId) {
    console.log(`- safari scenario id: ${args.scenarioId}`);
  }
  if (args.includeBackendChecks) {
    console.log(`- backend root: ${BACKEND_ROOT}`);
    console.log(`- backend python: ${args.backendPython}`);
    ensureBackendPythonExists(args.backendPython);
  }

  try {
    if (args.includeBackendChecks) {
      runStep(
        summary,
        args,
        "backend_checks",
        args.backendPython,
        ["-m", "pytest", ...BACKEND_SIGNOFF_TESTS, "-q"],
        { cwd: BACKEND_ROOT },
      );
      runStep(
        summary,
        args,
        "backend_metrics",
        args.backendPython,
        buildHttpCheckArgs(`${args.backendUrl}/metrics`, "text/plain", "# HELP"),
        { cwd: BACKEND_ROOT },
      );
    }
    runStep(summary, args, "typecheck", npxCommand, ["tsc", "--noEmit", "-p", "tsconfig.app.json"]);
    runStep(summary, args, "lint", npmCommand, ["run", "lint"]);
    runStep(summary, args, "graph_focused_vitest", npmCommand, buildGraphFocusedVitestArgs());
    runStep(summary, args, "build", npmCommand, ["run", "build"]);
    runStep(summary, args, "perf_budgets", npmCommand, ["run", "perf:budgets:check"]);
    runStep(
      summary,
      args,
      "script_contracts",
      nodeCommand,
      [
        "--test",
        "scripts/e2e-debate-suite.test.mjs",
        "scripts/e2e-frontend-preflight.test.mjs",
        "scripts/e2e-ending-room-followup-suite.test.mjs",
        "scripts/e2e-web-search-suite.test.mjs",
        "scripts/e2e-new-source-ingestion-live.test.mjs",
        "scripts/e2e-capability-matrix.test.mjs",
        "scripts/e2e-native-search-suite.test.mjs",
      ],
    );
    if (args.includeBackendChecks) {
      runStep(
        summary,
        args,
        "agent_conversation_ws_endpoint",
        args.backendPython,
        [
          "-m",
          "pytest",
          "tests/test_team_review_round6_fixes.py::TestC1AgentConversationWsEndpoint::test_capacity_scope_uses_scenario_id_not_thread_id",
          "-q",
        ],
        { cwd: BACKEND_ROOT },
      );
      runStep(
        summary,
        args,
        "scenario_deleted_terminal",
        args.backendPython,
        [
          "-m",
          "pytest",
          "tests/test_conversation.py::TestSSEStream::test_scenario_deleted_mid_stream_emits_terminal_error",
          "tests/test_conversation.py::TestAbort::test_stream_cancelled_error_finalizes_turn_and_thread",
          "-q",
        ],
        { cwd: BACKEND_ROOT },
      );
      runStep(
        summary,
        args,
        "x_org_id_header",
        args.backendPython,
        [
          "-m",
          "pytest",
          "tests/test_team_review_round6_fixes.py::TestC3OrgIdHeaderAndQuota::test_org_header_is_case_folded_before_persistence_and_quota",
          "-q",
        ],
        { cwd: BACKEND_ROOT },
      );
    }
    runStep(
      summary,
      args,
      "cmd_r_suppress_reload",
      npmCommand,
      [
        "test",
        "--",
        "--run",
        "src/components/kg/NodeConversationSheet.test.tsx",
        "-t",
        "Cmd+R fires onResend and preventDefault blocks browser refresh",
      ],
    );
    runStep(
      summary,
      args,
      "snap_cycle_70_100_40",
      npmCommand,
      [
        "test",
        "--",
        "--run",
        "src/components/kg/NodeConversationSheet.test.tsx",
        "-t",
        "clicking handle cycles 70 → 100 → 40 → 70",
      ],
    );
    if (args.includeAssetsCheck) {
      runStep(summary, args, "assets_check", npmCommand, ["run", "assets:provenance:check"]);
    }
    await runAsyncStep(
      summary,
      args,
      "phase3_graph_preflight",
      () => assertFrontendRoutesReady({
        baseUrl: args.baseUrl,
        routePaths: buildGraphPreflightPaths(),
        label: "phase3 graph preflight",
      }),
      {
        command: `assertFrontendRoutesReady(${args.baseUrl})`,
      },
    );
    registerRound7GraphLiveSteps({
      summary,
      args,
      baseUrl: args.baseUrl,
      nodeCommand,
      runStep,
    });
    registerPredictionFocusedSteps({
      summary,
      args,
      baseUrl: args.baseUrl,
      outputRoot: args.outputRoot,
      headless: args.headless,
      nodeCommand,
      runStep,
    });
    runStep(
      summary,
      args,
      "phase3a_graph_firefox",
      nodeCommand,
      [
        "scripts/e2e-phase3-batch-a.mjs",
        "desktop",
        "--browser",
        "firefox",
        "--output-dir",
        phase3aFirefoxOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: phase3aFirefoxOutput,
        resultFile: path.join(phase3aFirefoxOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "phase3b_graph_firefox",
      nodeCommand,
      [
        "scripts/e2e-phase3-batch-b.mjs",
        "desktop",
        "--browser",
        "firefox",
        "--output-dir",
        phase3bFirefoxOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: phase3bFirefoxOutput,
        resultFile: path.join(phase3bFirefoxOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "phase3a_graph_webkit",
      nodeCommand,
      [
        "scripts/e2e-phase3-batch-a.mjs",
        "desktop",
        "--browser",
        "webkit",
        "--output-dir",
        phase3aWebkitOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: phase3aWebkitOutput,
        resultFile: path.join(phase3aWebkitOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "phase3b_graph_webkit",
      nodeCommand,
      [
        "scripts/e2e-phase3-batch-b.mjs",
        "desktop",
        "--browser",
        "webkit",
        "--output-dir",
        phase3bWebkitOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: phase3bWebkitOutput,
        resultFile: path.join(phase3bWebkitOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "corners",
      nodeCommand,
      buildSuiteArgs("scripts/e2e-suite.mjs", "corners", args.baseUrl, cornersOutput, args.headless, args.scenarioId),
      {
        artifactDir: cornersOutput,
        resultFile: path.join(cornersOutput, "result.json"),
        browserLaunchFile: path.join(cornersOutput, "browser-launch.json"),
        env: {
          SWARM_E2E_FIXTURE_MODE: "1",
        },
      },
    );
    runStep(
      summary,
      args,
      "mobile",
      nodeCommand,
      buildSuiteArgs("scripts/e2e-suite.mjs", "mobile", args.baseUrl, mobileOutput, args.headless, args.scenarioId),
      {
        artifactDir: mobileOutput,
        resultFile: path.join(mobileOutput, "result.json"),
        browserLaunchFile: path.join(mobileOutput, "browser-launch.json"),
      },
    );
    runStep(
      summary,
      args,
      "cross_browser",
      nodeCommand,
      buildSuiteArgs("scripts/e2e-suite.mjs", "cross-browser", args.baseUrl, crossBrowserOutput, args.headless, args.scenarioId),
      {
        artifactDir: crossBrowserOutput,
        resultFile: path.join(crossBrowserOutput, "result.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        endingRoomOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomOutput,
        resultFile: path.join(endingRoomOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup_en",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--locale",
        "en",
        "--output-dir",
        endingRoomEnOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomEnOutput,
        resultFile: path.join(endingRoomEnOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup_firefox",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "firefox",
        "--output-dir",
        endingRoomFirefoxOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomFirefoxOutput,
        resultFile: path.join(endingRoomFirefoxOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup_en_firefox",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "firefox",
        "--locale",
        "en",
        "--output-dir",
        endingRoomEnFirefoxOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomEnFirefoxOutput,
        resultFile: path.join(endingRoomEnFirefoxOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup_webkit",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "webkit",
        "--output-dir",
        endingRoomWebkitOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomWebkitOutput,
        resultFile: path.join(endingRoomWebkitOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "ending_room_followup_en_webkit",
      nodeCommand,
      [
        "scripts/e2e-ending-room-followup-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "webkit",
        "--locale",
        "en",
        "--output-dir",
        endingRoomEnWebkitOutput,
        ...(args.headless ? ["--headless", "true"] : []),
      ],
      {
        artifactDir: endingRoomEnWebkitOutput,
        resultFile: path.join(endingRoomEnWebkitOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_full",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--output-dir",
        roundtableOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableOutput,
        resultFile: path.join(roundtableOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_en",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--locale",
        "en",
        "--output-dir",
        roundtableEnOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableEnOutput,
        resultFile: path.join(roundtableEnOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_firefox",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--browser",
        "firefox",
        "--output-dir",
        roundtableFirefoxOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableFirefoxOutput,
        resultFile: path.join(roundtableFirefoxOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_en_firefox",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--browser",
        "firefox",
        "--locale",
        "en",
        "--output-dir",
        roundtableEnFirefoxOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableEnFirefoxOutput,
        resultFile: path.join(roundtableEnFirefoxOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_webkit",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--browser",
        "webkit",
        "--output-dir",
        roundtableWebkitOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableWebkitOutput,
        resultFile: path.join(roundtableWebkitOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "roundtable_en_webkit",
      nodeCommand,
      [
        "scripts/e2e-worldline-roundtable-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--backend-url",
        args.backendUrl,
        "--browser",
        "webkit",
        "--locale",
        "en",
        "--output-dir",
        roundtableEnWebkitOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: roundtableEnWebkitOutput,
        resultFile: path.join(roundtableEnWebkitOutput, "summary.json"),
      },
    );
    runStep(
      summary,
      args,
      "debate_full",
      nodeCommand,
      [
        "scripts/e2e-debate-suite.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        debateOutput,
        ...(args.requireDebateAdjudicationMode
          ? ["--require-adjudication-mode", args.requireDebateAdjudicationMode]
          : []),
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: debateOutput,
        resultFile: path.join(debateOutput, "result.json"),
      },
    );
    runStep(
      summary,
      args,
      "debate_firefox",
      nodeCommand,
      [
        "scripts/e2e-debate-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "firefox",
        "--output-dir",
        debateFirefoxOutput,
        ...(args.requireDebateAdjudicationMode
          ? ["--require-adjudication-mode", args.requireDebateAdjudicationMode]
          : []),
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: debateFirefoxOutput,
        resultFile: path.join(debateFirefoxOutput, "result.json"),
      },
    );
    runStep(
      summary,
      args,
      "debate_webkit",
      nodeCommand,
      [
        "scripts/e2e-debate-suite.mjs",
        "desktop",
        "--url",
        args.baseUrl,
        "--browser",
        "webkit",
        "--output-dir",
        debateWebkitOutput,
        ...(args.requireDebateAdjudicationMode
          ? ["--require-adjudication-mode", args.requireDebateAdjudicationMode]
          : []),
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: debateWebkitOutput,
        resultFile: path.join(debateWebkitOutput, "result.json"),
      },
    );
    // QA-2 — graph-playability-upgrade Tier 1 live suites (fail → block release).
    runStep(
      summary,
      args,
      "node_conversation_live",
      nodeCommand,
      [
        "scripts/e2e-node-conversation-live.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        nodeConversationLiveOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: nodeConversationLiveOutput,
        resultFile: path.join(nodeConversationLiveOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "kg_explorer_live",
      nodeCommand,
      [
        "scripts/e2e-kg-explorer-live.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        kgExplorerLiveOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: kgExplorerLiveOutput,
        resultFile: path.join(kgExplorerLiveOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "replay_view_live",
      nodeCommand,
      [
        "scripts/e2e-replay-view-live.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        replayViewLiveOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: replayViewLiveOutput,
        resultFile: path.join(replayViewLiveOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "web_search_live",
      nodeCommand,
      [
        "scripts/e2e-web-search-suite.mjs",
        "--url",
        args.baseUrl,
        "--output-dir",
        webSearchLiveOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: webSearchLiveOutput,
        resultFile: path.join(webSearchLiveOutput, "summary.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "capability_matrix",
      nodeCommand,
      [
        "scripts/e2e-capability-matrix.mjs",
        "--url",
        args.baseUrl,
        "--output-dir",
        capabilityMatrixOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: capabilityMatrixOutput,
        resultFile: path.join(capabilityMatrixOutput, "results.json"),
        env: {
          SWARM_URL: args.baseUrl,
        },
      },
    );
    runStep(
      summary,
      args,
      "new_source_ingestion_live",
      nodeCommand,
      [
        "scripts/e2e-new-source-ingestion-live.mjs",
        "full",
        "--url",
        args.baseUrl,
        "--output-dir",
        newSourceIngestionLiveOutput,
        ...(args.headless ? ["--headless"] : []),
      ],
      {
        artifactDir: newSourceIngestionLiveOutput,
        resultFile: path.join(newSourceIngestionLiveOutput, "result.json"),
        env: {
          SWARM_URL: args.baseUrl,
          SWARM_E2E_MODE: "live",
        },
      },
    );

    if (args.includeSafari) {
      runStep(
        summary,
        args,
        "safari",
        nodeCommand,
        [
          "scripts/e2e-suite.mjs",
          "safari",
          "--url",
          args.baseUrl,
          "--webdriver-url",
          args.webdriverUrl,
          "--output-dir",
          safariOutput,
          ...(args.scenarioId ? ["--scenario-id", args.scenarioId] : []),
        ],
        {
          artifactDir: safariOutput,
          resultFile: path.join(safariOutput, "result.json"),
        },
      );
    }

    summary.status = "passed";
    summary.finished_at = new Date().toISOString();
    writeSummary(args.outputRoot, summary);
    console.log("\nRelease signoff completed.");
    console.log(`Artifacts: ${args.outputRoot}`);
    console.log(`Summary: ${summaryPathFor(args.outputRoot)}`);
  } catch (error) {
    summary.status = "failed";
    summary.finished_at = new Date().toISOString();
    summary.error = serializeError(error);
    writeSummary(args.outputRoot, summary);
    throw error;
  }
}

if (IS_MAIN_MODULE) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
