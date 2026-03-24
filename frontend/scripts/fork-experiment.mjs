import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_ROOT = path.join(FRONTEND_ROOT, "output", "e2e");
const DEFAULT_API_URL = process.env.SWARM_API_URL || "http://127.0.0.1:18927";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function resolveFrontendPath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;

  const normalized = inputPath.replace(/^\.\/+/, "");
  if (
    normalized === "frontend"
    || normalized.startsWith(`frontend${path.sep}`)
    || normalized.startsWith("frontend/")
  ) {
    return path.join(path.dirname(FRONTEND_ROOT), normalized);
  }
  return path.join(FRONTEND_ROOT, normalized);
}

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\u4e00-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "scenario";
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function writeCsv(filePath, headers, rows) {
  const lines = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function parseTemperatureList(rawValue) {
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value));
}

function parseSensitivityList(rawValue) {
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value));
}

function parseVariantList(rawValue) {
  return rawValue
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .filter((value) => ["a", "b", "c", "d", "e", "f"].includes(value));
}

function parseBudgetList(rawValue) {
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number.parseInt(item, 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

function parseArgs(argv) {
  const args = {
    apiUrl: DEFAULT_API_URL,
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, `${timestampLabel()}-fork-experiment`),
    questions: [],
    questionsFile: "",
    temperatures: [0, 0.4, 0.7, 1.0],
    branchSensitivities: [0.7],
    forkPromptVariants: ["a"],
    forkDetectorActiveBranchLimits: [0],
    runs: 3,
    rounds: 5,
    numAgents: 20,
    mode: "blackboard",
    visualizationEnabled: false,
    reasoningEffort: "",
    concurrency: 2,
    timeoutMs: 12 * 60_000,
    pollIntervalMs: 2_000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--api-url" && next) {
      args.apiUrl = next;
      i += 1;
    } else if (arg === "--output-dir" && next) {
      args.outputDir = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--question" && next) {
      args.questions.push(next);
      i += 1;
    } else if (arg === "--questions-file" && next) {
      args.questionsFile = resolveFrontendPath(next);
      i += 1;
    } else if (arg === "--temperatures" && next) {
      args.temperatures = parseTemperatureList(next);
      i += 1;
    } else if (arg === "--branch-sensitivities" && next) {
      args.branchSensitivities = parseSensitivityList(next);
      i += 1;
    } else if (arg === "--fork-prompt-variants" && next) {
      args.forkPromptVariants = parseVariantList(next);
      i += 1;
    } else if (arg === "--fork-detector-active-branch-limits" && next) {
      args.forkDetectorActiveBranchLimits = parseBudgetList(next);
      i += 1;
    } else if (arg === "--runs" && next) {
      args.runs = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
    } else if (arg === "--rounds" && next) {
      args.rounds = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
    } else if (arg === "--num-agents" && next) {
      args.numAgents = Math.max(3, Number.parseInt(next, 10) || 3);
      i += 1;
    } else if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (arg === "--visualization-enabled") {
      args.visualizationEnabled = true;
    } else if (arg === "--reasoning-effort" && next) {
      args.reasoningEffort = next;
      i += 1;
    } else if (arg === "--concurrency" && next) {
      args.concurrency = Math.max(1, Number.parseInt(next, 10) || 1);
      i += 1;
    } else if (arg === "--timeout-ms" && next) {
      args.timeoutMs = Math.max(10_000, Number.parseInt(next, 10) || args.timeoutMs);
      i += 1;
    } else if (arg === "--poll-interval-ms" && next) {
      args.pollIntervalMs = Math.max(500, Number.parseInt(next, 10) || args.pollIntervalMs);
      i += 1;
    } else {
      throw new Error(
        "Usage: node scripts/fork-experiment.mjs "
        + "[--api-url URL] [--output-dir DIR] [--question TEXT] [--questions-file PATH] "
        + "[--temperatures 0,0.4,0.7,1.0] [--branch-sensitivities 0.3,0.7,0.9] "
        + "[--fork-prompt-variants a,b,c,d,e,f] [--fork-detector-active-branch-limits 0,1,2] "
        + "[--runs 3] [--rounds 5] [--num-agents 20] "
        + "[--mode raw|blackboard] [--visualization-enabled] [--reasoning-effort low|medium|high] [--concurrency 2] "
        + "[--timeout-ms 720000] [--poll-interval-ms 2000]",
      );
    }
  }

  if (args.questionsFile) {
    const raw = fs.readFileSync(args.questionsFile, "utf8");
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error("--questions-file JSON must be an array");
      }
      args.questions.push(...parsed.map((item) => String(item || "").trim()).filter(Boolean));
    } else {
      args.questions.push(...trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }
  }

  if (args.questions.length === 0) {
    throw new Error("Provide at least one --question or a --questions-file");
  }
  if (args.temperatures.length === 0) {
    throw new Error("Provide at least one valid temperature via --temperatures");
  }
  if (args.branchSensitivities.length === 0) {
    throw new Error("Provide at least one valid branch sensitivity via --branch-sensitivities");
  }
  if (args.forkPromptVariants.length === 0) {
    throw new Error("Provide at least one valid prompt variant via --fork-prompt-variants");
  }
  if (args.forkDetectorActiveBranchLimits.length === 0) {
    throw new Error("Provide at least one valid branch detector budget via --fork-detector-active-branch-limits");
  }

  return args;
}

async function requestJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function createScenarioViaApi(apiUrl, payload) {
  return requestJson(`${apiUrl}/api/scenario`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function getScenarioViaApi(apiUrl, scenarioId) {
  return requestJson(`${apiUrl}/api/scenario/${scenarioId}`);
}

async function getStoryViaApi(apiUrl, scenarioId) {
  return requestJson(`${apiUrl}/api/scenario/${scenarioId}/story`);
}

async function waitForScenarioDone(apiUrl, scenarioId, { timeoutMs, pollIntervalMs }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const scenario = await getScenarioViaApi(apiUrl, scenarioId);
    if (scenario.status === "done" || scenario.status === "error") {
      return scenario;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for scenario ${scenarioId}`);
}

function summarizeRoundChecks(checks) {
  return Array.isArray(checks)
    ? checks.map((check) => ({
      round: check.round,
      branch_id: check.branch_id,
      branch_title: check.branch_title ?? "",
      diverge_signal_count: check.diverge_signal_count,
      detector_invoked: check.detector_invoked,
      skip_reason: check.skip_reason ?? "",
      decision: check.decision,
      should_fork: check.detector_result?.should_fork ?? "",
      reason: check.detector_result?.reason ?? "",
      created_branch_titles: (check.created_branch_titles || []).join(" | "),
      diverge_signals: (check.diverge_signals || []).join(" | "),
    }))
    : [];
}

function buildCsvRows(run) {
  return run.round_checks.map((check) => ({
    question: run.question,
    run_label: run.run_label,
    scenario_id: run.scenario_id,
    temperature: run.temperature,
    branch_sensitivity: run.branch_sensitivity,
    fork_prompt_variant: run.fork_prompt_variant,
    fork_detector_active_branch_limit: run.fork_detector_active_branch_limit,
    rounds: run.rounds,
    num_agents: run.num_agents,
    branch_count: run.branch_count,
    story_branch_count: run.story_branch_count,
    fork_event_count: run.fork_event_count,
    forked_branch_count: run.forked_branch_count,
    diverge_message_count: run.diverge_message_count,
    round: check.round,
    branch_title: check.branch_title,
    diverge_signal_count: check.diverge_signal_count,
    detector_invoked: check.detector_invoked,
    skip_reason: check.skip_reason,
    decision: check.decision,
    should_fork: check.should_fork,
    reason: check.reason,
    created_branch_titles: check.created_branch_titles,
    diverge_signals: check.diverge_signals,
  }));
}

function buildAggregateSummary(runs) {
  const byQuestionAndTemperature = new Map();
  for (const run of runs) {
    const key = `${run.question}@@${run.temperature}@@${run.branch_sensitivity}@@${run.fork_prompt_variant}@@${run.fork_detector_active_branch_limit}`;
    const entry = byQuestionAndTemperature.get(key) ?? {
      question: run.question,
      temperature: run.temperature,
      branch_sensitivity: run.branch_sensitivity,
      fork_prompt_variant: run.fork_prompt_variant,
      fork_detector_active_branch_limit: run.fork_detector_active_branch_limit,
      run_count: 0,
      fork_hit_count: 0,
      multi_ending_count: 0,
      avg_branch_count: 0,
      avg_story_branch_count: 0,
    };
    entry.run_count += 1;
    if (run.fork_event_count > 0) entry.fork_hit_count += 1;
    if (run.story_branch_count > 1) entry.multi_ending_count += 1;
    entry.avg_branch_count += run.branch_count;
    entry.avg_story_branch_count += run.story_branch_count;
    byQuestionAndTemperature.set(key, entry);
  }

  return [...byQuestionAndTemperature.values()].map((entry) => ({
    ...entry,
    fork_hit_rate: Number((entry.fork_hit_count / entry.run_count).toFixed(4)),
    multi_ending_rate: Number((entry.multi_ending_count / entry.run_count).toFixed(4)),
    avg_branch_count: Number((entry.avg_branch_count / entry.run_count).toFixed(2)),
    avg_story_branch_count: Number((entry.avg_story_branch_count / entry.run_count).toFixed(2)),
  }));
}

async function main() {
  const args = parseArgs(process.argv);
  ensureDir(args.outputDir);
  const samplesDir = path.join(args.outputDir, "samples");
  ensureDir(samplesDir);

  const runs = [];
  const csvRows = [];
  const tasks = [];
  for (const question of args.questions) {
    for (const temperature of args.temperatures) {
      for (const branchSensitivity of args.branchSensitivities) {
        for (const forkPromptVariant of args.forkPromptVariants) {
          for (const forkDetectorActiveBranchLimit of args.forkDetectorActiveBranchLimits) {
            for (let runIndex = 1; runIndex <= args.runs; runIndex += 1) {
              const runLabel = [
                slugify(question),
                `t${String(temperature).replace(".", "_")}`,
                `s${String(branchSensitivity).replace(".", "_")}`,
                `p${forkPromptVariant}`,
                `k${forkDetectorActiveBranchLimit}`,
                `run${String(runIndex).padStart(2, "0")}`,
              ].join("-");
              tasks.push({
                question,
                temperature,
                branchSensitivity,
                forkPromptVariant,
                forkDetectorActiveBranchLimit,
                runIndex,
                runLabel,
              });
            }
          }
        }
      }
    }
  }

  let nextTaskIndex = 0;
  async function runNextTask() {
    const taskIndex = nextTaskIndex;
    nextTaskIndex += 1;
    if (taskIndex >= tasks.length) return;

    const task = tasks[taskIndex];
    console.log(`[fork-experiment] start ${task.runLabel}`);
    const scenario = await createScenarioViaApi(args.apiUrl, {
      question: task.question,
      rounds: args.rounds,
      num_agents: args.numAgents,
      mode: args.mode,
      visualization_enabled: args.visualizationEnabled,
      temperature: task.temperature,
      branch_sensitivity: task.branchSensitivity,
      fork_prompt_variant: task.forkPromptVariant,
      ...(task.forkDetectorActiveBranchLimit > 0
        ? { fork_detector_active_branch_limit: task.forkDetectorActiveBranchLimit }
        : {}),
      ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
    });
    const finalScenario = await waitForScenarioDone(args.apiUrl, scenario.id, args);
    const story = await getStoryViaApi(args.apiUrl, scenario.id);
    const roundChecks = summarizeRoundChecks(finalScenario.fork_debug?.round_checks);

    const runResult = {
      run_label: task.runLabel,
      scenario_id: scenario.id,
      question: task.question,
      temperature: task.temperature,
      branch_sensitivity: task.branchSensitivity,
      fork_prompt_variant: task.forkPromptVariant,
      fork_detector_active_branch_limit: task.forkDetectorActiveBranchLimit,
      rounds: args.rounds,
      num_agents: args.numAgents,
      reasoning_effort: args.reasoningEffort || null,
      branch_count: finalScenario.branches?.length ?? 0,
      story_branch_count: story.branches?.length ?? 0,
      fork_event_count: finalScenario.fork_debug?.fork_event_count ?? 0,
      forked_branch_count: finalScenario.fork_debug?.forked_branch_count ?? 0,
      diverge_message_count: finalScenario.fork_debug?.diverge_message_count ?? 0,
      round_checks: roundChecks,
      fork_debug: finalScenario.fork_debug ?? null,
    };

    runs.push(runResult);
    csvRows.push(...buildCsvRows(runResult));
    writeJson(path.join(samplesDir, `${task.runLabel}.json`), runResult);
    console.log(`[fork-experiment] done ${task.runLabel} scenario=${scenario.id} forks=${runResult.fork_event_count} branches=${runResult.branch_count}`);
    await runNextTask();
  }

  await Promise.all(
    Array.from(
      { length: Math.min(args.concurrency, tasks.length) },
      () => runNextTask(),
    ),
  );

  const result = {
    generated_at: new Date().toISOString(),
    api_url: args.apiUrl,
    config: {
      questions: args.questions,
      temperatures: args.temperatures,
      branch_sensitivities: args.branchSensitivities,
      fork_prompt_variants: args.forkPromptVariants,
      fork_detector_active_branch_limits: args.forkDetectorActiveBranchLimits,
      runs: args.runs,
      rounds: args.rounds,
      num_agents: args.numAgents,
      mode: args.mode,
      visualization_enabled: args.visualizationEnabled,
      reasoning_effort: args.reasoningEffort || null,
      concurrency: args.concurrency,
      timeout_ms: args.timeoutMs,
      poll_interval_ms: args.pollIntervalMs,
    },
    aggregate: buildAggregateSummary(runs),
    runs,
  };

  writeJson(path.join(args.outputDir, "result.json"), result);
  writeCsv(
    path.join(args.outputDir, "results.csv"),
    [
      "question",
      "run_label",
      "scenario_id",
      "temperature",
      "branch_sensitivity",
      "fork_prompt_variant",
      "fork_detector_active_branch_limit",
      "rounds",
      "num_agents",
      "branch_count",
      "story_branch_count",
      "fork_event_count",
      "forked_branch_count",
      "diverge_message_count",
      "round",
      "branch_title",
      "diverge_signal_count",
      "detector_invoked",
      "skip_reason",
      "decision",
      "should_fork",
      "reason",
      "created_branch_titles",
      "diverge_signals",
    ],
    csvRows,
  );

  console.log(JSON.stringify({
    output_dir: args.outputDir,
    aggregate: result.aggregate,
    run_count: runs.length,
    csv_rows: csvRows.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
