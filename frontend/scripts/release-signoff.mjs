import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(FRONTEND_ROOT, "..");
const BACKEND_ROOT = path.join(REPO_ROOT, "backend");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";
const DEFAULT_BACKEND_URL = process.env.SWARM_BACKEND_URL || "http://127.0.0.1:18927";
const VALID_DEBATE_ADJUDICATION_MODES = new Set(["deterministic", "llm_hybrid"]);
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

function buildSuiteArgs(scriptName, mode, baseUrl, outputDir, headless, scenarioId) {
  const args = [scriptName, mode, "--url", baseUrl, "--output-dir", outputDir];
  if (headless) args.push("--headless");
  if (scenarioId) args.push("--scenario-id", scenarioId);
  return args;
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

function main() {
  const args = parseArgs(process.argv);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const nodeCommand = process.execPath;

  const cornersOutput = path.join(args.outputRoot, "corners");
  const mobileOutput = path.join(args.outputRoot, "mobile");
  const crossBrowserOutput = path.join(args.outputRoot, "cross-browser");
  const debateOutput = path.join(args.outputRoot, "debate-full");
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
    runStep(summary, args, "build", npmCommand, ["run", "build"]);
    runStep(summary, args, "perf_budgets", npmCommand, ["run", "perf:budgets:check"]);
    if (args.includeAssetsCheck) {
      runStep(summary, args, "assets_check", npmCommand, ["run", "assets:provenance:check"]);
    }
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

main();
