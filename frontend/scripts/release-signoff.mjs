import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_BASE_URL = process.env.SWARM_URL || "http://127.0.0.1:18928";

function timestampLabel() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveFrontendPath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.join(FRONTEND_ROOT, inputPath.replace(/^\.\/+/, ""));
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    outputRoot: resolveFrontendPath(path.join("output", "e2e", `${timestampLabel()}-release-signoff`)),
    headless: process.env.HEADLESS === "1",
    dryRun: false,
    includeSafari: false,
    webdriverUrl: process.env.SAFARI_WEBDRIVER_URL || "http://127.0.0.1:4444",
    scenarioId: process.env.SWARM_SCENARIO_ID || "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--url" && next) {
      args.baseUrl = next;
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
    } else if (arg === "--headless") {
      args.headless = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--include-safari") {
      args.includeSafari = true;
    } else {
      throw new Error(
        "Usage: node scripts/release-signoff.mjs [--url URL] [--output-root DIR] [--headless] [--include-safari] [--webdriver-url URL] [--scenario-id ID] [--dry-run]",
      );
    }
  }

  return args;
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

function runCommand(command, args, options) {
  const rendered = formatCommand(command, args);
  console.log(`\n$ ${rendered}`);
  if (options.dryRun) return;

  const result = spawnSync(command, args, {
    cwd: FRONTEND_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      ...options.env,
    },
  });

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? "unknown"}): ${rendered}`);
  }
}

function buildSuiteArgs(scriptName, mode, baseUrl, outputDir, headless, scenarioId) {
  const args = [scriptName, mode, "--url", baseUrl, "--output-dir", outputDir];
  if (headless) args.push("--headless");
  if (scenarioId) args.push("--scenario-id", scenarioId);
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const nodeCommand = process.execPath;

  const cornersOutput = path.join(args.outputRoot, "corners");
  const crossBrowserOutput = path.join(args.outputRoot, "cross-browser");
  const debateOutput = path.join(args.outputRoot, "debate-full");
  const safariOutput = path.join(args.outputRoot, "safari");

  console.log("Release signoff plan:");
  console.log(`- frontend root: ${FRONTEND_ROOT}`);
  console.log(`- base url: ${args.baseUrl}`);
  console.log(`- output root: ${args.outputRoot}`);
  console.log(`- headless: ${args.headless ? "true" : "false"}`);
  console.log(`- include safari: ${args.includeSafari ? "true" : "false"}`);
  if (args.scenarioId) {
    console.log(`- safari scenario id: ${args.scenarioId}`);
  }

  runCommand(npxCommand, ["tsc", "--noEmit", "-p", "tsconfig.app.json"], args);
  runCommand(npmCommand, ["run", "build"], args);
  runCommand(
    nodeCommand,
    buildSuiteArgs("scripts/e2e-suite.mjs", "corners", args.baseUrl, cornersOutput, args.headless, args.scenarioId),
    args,
  );
  runCommand(
    nodeCommand,
    buildSuiteArgs("scripts/e2e-suite.mjs", "cross-browser", args.baseUrl, crossBrowserOutput, args.headless, args.scenarioId),
    args,
  );
  runCommand(
    nodeCommand,
    [
      "scripts/e2e-debate-suite.mjs",
      "full",
      "--url",
      args.baseUrl,
      "--output-dir",
      debateOutput,
      ...(args.headless ? ["--headless"] : []),
    ],
    args,
  );

  if (args.includeSafari) {
    runCommand(
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
      args,
    );
  }

  console.log("\nRelease signoff completed.");
  console.log(`Artifacts: ${args.outputRoot}`);
}

main();
