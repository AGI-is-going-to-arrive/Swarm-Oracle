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

function windowsNpxFixture(context, { bash = true, config = "null", configStatus = 0 } = {}) {
  const cwd = workspace(context);
  const npmBin = path.join(cwd, "npm installation & bin");
  const gitBin = path.join(cwd, "Git installation & tools", "cmd");
  const bashPath = path.join(cwd, "Git installation & tools", "bin", "bash.exe");
  const configEnvPath = path.join(cwd, "config query env.json");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.mkdirSync(gitBin, { recursive: true });
  fs.writeFileSync(path.join(npmBin, "npm-cli.js"), [
    "const settings = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^npm_config_(?:offline|update_notifier)$/iu.test(key)));",
    `require('node:fs').writeFileSync(${JSON.stringify(configEnvPath)}, JSON.stringify(settings));`,
    `process.stdout.write(${JSON.stringify(config)}); process.exitCode = ${configStatus};`,
  ].join("\n"));
  fs.writeFileSync(path.join(npmBin, "npx-cli.js"), "");
  fs.writeFileSync(path.join(gitBin, "git.exe"), "");
  if (bash) {
    fs.mkdirSync(path.dirname(bashPath), { recursive: true });
    fs.writeFileSync(bashPath, "");
  }
  return { cwd, bashPath, configEnvPath, env: { Path: gitBin, npm_execpath: path.join(npmBin, "npm-cli.js") } };
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
  const program = [
    "const argv = process.argv.slice(2);",
    "if (argv.join(' ') === 'config get script-shell') process.stdout.write('null');",
    "else {",
    "  const shell = argv[0]?.startsWith('--script-shell=') ? argv.shift().slice('--script-shell='.length) : null;",
    "  process.stdout.write(JSON.stringify({ argv, shell }));",
    "}",
  ].join("\n");
  for (const tool of ["npm", "npx"]) fs.writeFileSync(path.join(bin, `${tool}-cli.js`), program);

  for (const tool of ["npm.cmd", "npx.cmd"]) {
    const result = signoff.captureCommand(tool, LITERAL_ARGS, {
      cwd,
      env: { npm_execpath: path.join(bin, "npm-cli.js") },
    });
    assertSucceeded(result);
    const captured = JSON.parse(result.stdout);
    assert.deepEqual(captured.argv, LITERAL_ARGS);
    if (process.platform === "win32" && tool === "npx.cmd") {
      assert.equal(path.isAbsolute(captured.shell), true);
      assert.equal(path.basename(captured.shell), "bash.exe");
    } else {
      assert.equal(captured.shell, null);
    }
  }
});

test("Windows multiline npx selects Git Bash and isolates query and MSYS settings", (context) => {
  const fixture = windowsNpxFixture(context);
  fixture.env.msys2_arg_conv_excl = "old exclusion";
  fixture.env.MSYS_NO_PATHCONV = "0";
  const callerQuerySettings = {
    NPM_CONFIG_OFFLINE: "false",
    npm_config_offline: "caller offline",
    NPM_CONFIG_UPDATE_NOTIFIER: "true",
    npm_config_update_notifier: "caller notifier",
  };
  Object.assign(fixture.env, callerQuerySettings);
  const args = ["--offline", "--no-install", "--", "probe", ...LITERAL_ARGS, "--script-shell=literal"];
  const invocation = resolveSpawnCommand("npx.cmd", args, { ...fixture, platform: "win32" });

  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1), [`--script-shell=${fixture.bashPath}`, ...args]);
  assert.equal(invocation.env.MSYS2_ARG_CONV_EXCL, "*");
  assert.equal(invocation.env.MSYS_NO_PATHCONV, "1");
  assert.equal(invocation.env.msys2_arg_conv_excl, undefined);
  assert.equal(fixture.env.msys2_arg_conv_excl, "old exclusion");
  assert.equal(fixture.env.MSYS_NO_PATHCONV, "0");
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.configEnvPath, "utf8")), {
    npm_config_offline: "true", npm_config_update_notifier: "false",
  });
  for (const [key, value] of Object.entries(callerQuerySettings)) {
    assert.equal(fixture.env[key], value);
    assert.equal(invocation.env[key], value);
  }
});

test("Windows multiline npx fails closed when Git Bash or shell configuration is unavailable", (context) => {
  for (const options of [{ bash: false }, { configStatus: 1 }]) {
    const fixture = windowsNpxFixture(context, options);
    assert.throws(() => resolveSpawnCommand("npx", ["probe", ...LITERAL_ARGS], {
      ...fixture, platform: "win32",
    }), /(?:require Git for Windows|Cannot verify npm script-shell).*directly with Node\.js/u);
  }
});

test("Windows multiline npx rejects explicit CLI, environment, and npm configuration shells", (context) => {
  const fixture = windowsNpxFixture(context);
  const args = ["--", "probe", ...LITERAL_ARGS];
  for (const flag of ["--script-shell=cmd.exe", "--shell=cmd.exe"]) {
    assert.throws(() => resolveSpawnCommand("npx", [flag, ...args], {
      ...fixture, platform: "win32",
    }), /explicit script-shell override/u);
  }
  assert.throws(() => resolveSpawnCommand("npx", args, {
    ...fixture, platform: "win32", env: { ...fixture.env, NPM_CONFIG_SCRIPT_SHELL: "cmd.exe" },
  }), /explicit script-shell override/u);

  const cwd = workspace(context);
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "shell-config-probe", version: "1.0.0" }));
  fs.writeFileSync(path.join(cwd, ".npmrc"), "script-shell=cmd.exe\n");
  assert.throws(() => resolveSpawnCommand("npx", args, {
    cwd, platform: "win32",
  }), /explicit script-shell override/u);
});

test("ordinary npm and npx calls preserve the existing command and environment path", (context) => {
  const fixture = windowsNpxFixture(context, { bash: false, configStatus: 1 });
  for (const [command, args, platform] of [
    ["npm", LITERAL_ARGS, "win32"],
    ["npx", ["--offline", "--no-install", "--", "probe", "single line"], "win32"],
    ["npx", LITERAL_ARGS, "linux"],
  ]) {
    const invocation = resolveSpawnCommand(command, args, { ...fixture, platform });
    assert.equal(invocation.command, process.execPath);
    assert.deepEqual(invocation.args, [path.join(path.dirname(fixture.env.npm_execpath), `${command}-cli.js`), ...args]);
    assert.equal(invocation.env, undefined);
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
  // npx resolves package bins by exact filename, including .exe on Windows.
  const bin = path.join(cwd, "node_modules", ".bin");
  const nodeCommand = process.platform === "win32" ? "release-runtime-node.exe" : "release-runtime-node";
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(bin, nodeCommand));
  assertSucceeded(signoff.captureCommand("npx", ["--offline", "--no-install", "--", nodeCommand, scriptPath, outputPath, ...LITERAL_ARGS], {
    cwd, env, timeoutMs: 30_000,
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), LITERAL_ARGS);
  const pathArgs = [...LITERAL_ARGS, "/literal/path", "--value=/literal/path"];
  assertSucceeded(signoff.captureCommand("npx", ["--offline", "--no-install", "--", nodeCommand, scriptPath, outputPath, ...pathArgs], {
    cwd, env, timeoutMs: 30_000,
  }));
  assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, "utf8")), pathArgs);
  assert.equal(fs.existsSync(path.join(env.npm_config_cache, "_npx")), false);
});

test("a missing npm JavaScript entrypoint fails without a shell fallback", () => {
  assert.throws(() => resolveSpawnCommand("npm", ["test"], {
    env: {},
    nodePath: path.join(tmpdir(), "missing-node-runtime", "node"),
  }), /Cannot locate npm-cli\.js/u);
});
