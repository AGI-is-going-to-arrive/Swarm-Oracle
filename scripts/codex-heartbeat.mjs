#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const FRONTEND_E2E_ROOT = path.join(REPO_ROOT, "frontend", "output", "e2e");
const PROGRESS_PATH = path.join(REPO_ROOT, "progress.md");

function parseArgs(argv) {
  const args = {
    intervalSeconds: 0,
    label: "codex-heartbeat",
    logFile: "",
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--interval" && next) {
      args.intervalSeconds = Number.parseInt(next, 10) || 0;
      index += 1;
    } else if (arg === "--label" && next) {
      args.label = next;
      index += 1;
    } else if (arg === "--log-file" && next) {
      args.logFile = path.isAbsolute(next) ? next : path.join(REPO_ROOT, next);
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    }
  }

  return args;
}

function runGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function getGitSummary() {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const statusText = runGit(["status", "--short"]);
  const lines = statusText ? statusText.split("\n").filter(Boolean) : [];
  const untracked = lines.filter((line) => line.startsWith("??")).length;
  const changedFiles = lines
    .map((line) => line.trim().split(/\s+/).slice(1).join(" "))
    .filter(Boolean);

  return {
    branch,
    modifiedCount: lines.length - untracked,
    untrackedCount: untracked,
    changedFiles: changedFiles.slice(0, 8),
  };
}

function walkResultFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const stack = [rootDir];
  const results = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === "result.json") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function summarizeSamples(samples) {
  const runtimeCreated = samples.filter((sample) => sample?.createdAtRuntime).length;
  const recovered = samples.filter((sample) => sample?.recovery != null).length;
  return {
    sampleCount: samples.length,
    runtimeCreated,
    recovered,
  };
}

function summarizeE2EResult(data) {
  if (Array.isArray(data?.samples)) {
    const summary = summarizeSamples(data.samples);
    return `matrix ${summary.sampleCount} samples, runtime=${summary.runtimeCreated}, recovery=${summary.recovered}`;
  }

  if (Array.isArray(data?.matrix?.samples)) {
    const summary = summarizeSamples(data.matrix.samples);
    const cornerCount = Object.keys(data.corners?.cases ?? {}).length;
    return `full matrix=${summary.sampleCount}, runtime=${summary.runtimeCreated}, recovery=${summary.recovered}, corners=${cornerCount}`;
  }

  if (data?.desktop && data?.mobile) {
    return `debate ${data.mode ?? "suite"} desktop+mobile ready`;
  }

  return `keys=${Object.keys(data ?? {}).join(",")}`;
}

function getLatestE2EResult() {
  const files = walkResultFiles(FRONTEND_E2E_ROOT);
  if (files.length === 0) return null;

  const newest = files
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

  try {
    const raw = fs.readFileSync(newest.filePath, "utf8");
    const data = JSON.parse(raw);
    return {
      path: path.relative(REPO_ROOT, newest.filePath),
      summary: summarizeE2EResult(data),
      updatedAt: new Date(newest.mtimeMs).toLocaleString("zh-CN", { hour12: false }),
    };
  } catch (error) {
    return {
      path: path.relative(REPO_ROOT, newest.filePath),
      summary: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
      updatedAt: new Date(newest.mtimeMs).toLocaleString("zh-CN", { hour12: false }),
    };
  }
}

function getLatestProgressSection() {
  if (!fs.existsSync(PROGRESS_PATH)) return null;
  const lines = fs.readFileSync(PROGRESS_PATH, "utf8").split(/\r?\n/);
  let start = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith("## ")) {
      start = index;
      break;
    }
  }

  if (start === -1) return null;

  const heading = lines[start].replace(/^##\s+/, "").trim();
  const highlights = lines
    .slice(start + 1)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.trim())
    .slice(0, 4)
    .map((line) => line.replace(/^- /, ""));

  return { heading, highlights };
}

function buildSnapshot(label) {
  return {
    timestamp: new Date().toLocaleString("zh-CN", { hour12: false }),
    label,
    git: getGitSummary(),
    latestE2E: getLatestE2EResult(),
    latestProgress: getLatestProgressSection(),
  };
}

function formatSnapshot(snapshot) {
  const lines = [
    `[heartbeat] ${snapshot.timestamp} :: ${snapshot.label}`,
    `- git: branch=${snapshot.git.branch}, modified=${snapshot.git.modifiedCount}, untracked=${snapshot.git.untrackedCount}`,
  ];

  if (snapshot.git.changedFiles.length > 0) {
    lines.push(`- focus: ${snapshot.git.changedFiles.join(", ")}`);
  }

  if (snapshot.latestE2E) {
    lines.push(`- latest-e2e: ${snapshot.latestE2E.path} :: ${snapshot.latestE2E.summary}`);
    lines.push(`- latest-e2e-updated: ${snapshot.latestE2E.updatedAt}`);
  }

  if (snapshot.latestProgress) {
    lines.push(`- progress: ${snapshot.latestProgress.heading}`);
    for (const highlight of snapshot.latestProgress.highlights) {
      lines.push(`  · ${highlight}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function writeLog(logFile, payload) {
  if (!logFile) return;
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, payload, "utf8");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  let running = true;

  process.on("SIGINT", () => {
    running = false;
  });
  process.on("SIGTERM", () => {
    running = false;
  });

  do {
    const snapshot = buildSnapshot(args.label);
    const payload = args.json ? `${JSON.stringify(snapshot, null, 2)}\n` : formatSnapshot(snapshot);
    process.stdout.write(payload);
    writeLog(args.logFile, payload);

    if (!running || args.intervalSeconds <= 0) break;
    await sleep(args.intervalSeconds * 1000);
  } while (running);
}

await main();
