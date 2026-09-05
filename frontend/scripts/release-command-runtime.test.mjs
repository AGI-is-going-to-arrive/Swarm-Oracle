import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { __test__ as signoff } from "./release-signoff.mjs";
import { resolveSpawnCommand } from "./lib/commandRuntime.mjs";

const LITERAL_ARGS = [
  "spaces & pipes | redirects < > parentheses ( ) caret ^",
  "%SWARM_RUNTIME_SENTINEL% !SWARM_RUNTIME_SENTINEL! $SWARM_RUNTIME_SENTINEL",
  "quotes \"double\" 'single' `backticks` $(echo unexpected)",
  "line one\nline two\r\n中文内容",
  "trailing backslash\\",
  "",
];

function workspace(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "swarm release & ")));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, result.stderr);
}

test("capture preserves a multiline Node program, literal argv, and a spaced working directory", (context) => {
  const cwd = workspace(context);
  const program = [
    "const result = { cwd: process.cwd(), argv: process.argv.slice(1) };",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = signoff.captureCommand(process.execPath, ["-e", program, ...LITERAL_ARGS], {
    cwd,
    env: { SWARM_RUNTIME_SENTINEL: "must not be expanded" },
  });

  assertSucceeded(result);
  assert.deepEqual(JSON.parse(result.stdout), { cwd, argv: LITERAL_ARGS });
});

test("run executes multiline Python through a venv path containing spaces and ampersands", {
  skip: process.env.SWARM_SKIP_BACKEND_CHECKS === "1",
}, (context) => {
  const cwd = workspace(context);
  const venv = path.join(cwd, "python runtime & tools");
  const python = process.env.SWARM_BACKEND_PYTHON || "python";
  assertSucceeded(signoff.captureCommand(python, ["-m", "venv", "--without-pip", venv], {
    cwd,
    timeoutMs: 30_000,
  }));
  const pythonPath = process.platform === "win32"
    ? path.join(venv, "Scripts", "python.exe")
    : path.join(venv, "bin", "python");
  const outputPath = path.join(cwd, "result & output.json");
  const program = [
    "import json, os, pathlib, sys",
    "probe = 'parentheses (safe) & pipes | percent %'",
    "result = {'cwd': os.getcwd(), 'argv': sys.argv[2:], 'probe': probe}",
    "pathlib.Path(sys.argv[1]).write_text(json.dumps(result), encoding='utf-8')",
  ].join("\n");

  signoff.runCommand(pythonPath, ["-c", program, outputPath, ...LITERAL_ARGS], {
    cwd,
    env: { SWARM_RUNTIME_SENTINEL: "must not be expanded" },
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), {
    cwd,
    argv: LITERAL_ARGS,
    probe: "parentheses (safe) & pipes | percent %",
  });
});

test("Git receives shell metacharacters and multiline config values literally", (context) => {
  const cwd = workspace(context);
  const value = LITERAL_ARGS.join("\n");
  const result = signoff.captureCommand("git", ["-c", `probe.value=${value}`, "config", "--get", "probe.value"], {
    cwd,
    env: { SWARM_RUNTIME_SENTINEL: "must not be expanded" },
  });

  assertSucceeded(result);
  assert.equal(result.stdout.replace(/\r?\n$/u, ""), value);
});

test("capture reports a signalled child as failure", () => {
  const result = signoff.captureCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"]);
  assert.notEqual(result.status, 0);
});

test("npm CLI lookup and execution preserve argv when its installed path contains spaces", (context) => {
  const cwd = workspace(context);
  const bin = path.join(cwd, "npm installation & bin");
  fs.mkdirSync(bin);
  const program = "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n";
  for (const tool of ["npm", "npx"]) fs.writeFileSync(path.join(bin, `${tool}-cli.js`), program);

  for (const tool of ["npm.cmd", "npx.cmd"]) {
    const result = signoff.captureCommand(tool, LITERAL_ARGS, {
      cwd,
      env: { npm_execpath: path.join(bin, "npm-cli.js") },
    });
    assertSucceeded(result);
    assert.deepEqual(JSON.parse(result.stdout), LITERAL_ARGS);
  }
});

test("real npm and npx run offline with literal arguments and spaced artifact paths", (context) => {
  const cwd = workspace(context);
  const env = {
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_cache: path.join(cwd, "npm cache"),
    SWARM_RUNTIME_SENTINEL: "must not be expanded",
  };
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "release-runtime-probe", version: "1.0.0" }));
  const value = LITERAL_ARGS.join("\n");
  assertSucceeded(signoff.captureCommand("npm", ["--prefix", cwd, "pkg", "set", `probe=${value}`], {
    cwd, env, timeoutMs: 30_000,
  }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")).probe, value);

  const scriptPath = path.join(cwd, "argv & probe.cjs");
  const outputPath = path.join(cwd, "npx & result.json");
  fs.writeFileSync(scriptPath, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));",
  ].join("\n"));
  assertSucceeded(signoff.captureCommand("npx", ["--offline", "--no-install", "--", "node", scriptPath, outputPath, ...LITERAL_ARGS], {
    cwd, env, timeoutMs: 30_000,
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), LITERAL_ARGS);
});

test("a missing npm JavaScript entrypoint fails without a shell fallback", () => {
  assert.throws(() => resolveSpawnCommand("npm", ["test"], {
    env: {},
    nodePath: path.join(tmpdir(), "missing-node-runtime", "node"),
  }), /Cannot locate npm-cli\.js/u);
});
