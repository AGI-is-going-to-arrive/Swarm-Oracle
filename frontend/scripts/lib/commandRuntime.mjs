import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function npmCliCandidates(tool, env, nodePath) {
  const cliName = `${tool}-cli.js`;
  const candidates = [];
  // npm run supplies the exact npm installation, including version-manager installs.
  if (env.npm_execpath && /[\\/](?:npm|npx)-cli\.js$/iu.test(env.npm_execpath)) {
    candidates.push(path.join(path.dirname(env.npm_execpath), cliName));
  }

  const pathKey = Object.keys(env).sort().find((key) => key.toLowerCase() === "path");
  const pathEntries = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const directory = entry.replace(/^"(.*)"$/u, "$1");
    for (const name of process.platform === "win32" ? [`${tool}.cmd`, tool] : [tool]) {
      const launcher = path.join(directory, name);
      if (!isFile(launcher)) continue;
      const resolved = fs.realpathSync(launcher);
      if (path.basename(resolved) === cliName) candidates.push(resolved);
      candidates.push(path.join(path.dirname(resolved), "node_modules", "npm", "bin", cliName));
      candidates.push(path.resolve(path.dirname(resolved), "..", "lib", "node_modules", "npm", "bin", cliName));
    }
  }

  const nodeDirectory = path.dirname(nodePath);
  candidates.push(path.join(nodeDirectory, "node_modules", "npm", "bin", cliName));
  candidates.push(path.resolve(nodeDirectory, "..", "lib", "node_modules", "npm", "bin", cliName));
  return candidates;
}

function multilineNpxInvocation(cli, args, { env, nodePath, cwd }) {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const explicitShell = options.some((arg) => /^--(?:script-shell|shell)(?:=|$)/iu.test(arg))
    || Object.entries(env).some(([key, value]) => /^npm_config_script_shell$/iu.test(key) && value);
  const shellError = "Multiline npx arguments require Git Bash without an explicit script-shell override. "
    + "Remove the override or execute the multiline program directly with Node.js.";
  if (explicitShell) throw new Error(shellError);

  const configOptions = [];
  for (let index = 0; index < options.length; index += 1) {
    const arg = options[index];
    if (/^--(?:userconfig|globalconfig|prefix|location)(?:=|$)/u.test(arg)) {
      configOptions.push(arg);
      if (!arg.includes("=") && options[index + 1] !== undefined) configOptions.push(options[++index]);
    }
  }
  const configEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^npm_config_(?:offline|update_notifier)$/iu.test(key)));
  configEnv.npm_config_offline = "true";
  configEnv.npm_config_update_notifier = "false";
  const config = spawnSync(nodePath, [path.join(path.dirname(cli), "npm-cli.js"), "config", "get", "script-shell", ...configOptions], {
    cwd, env: configEnv, encoding: "utf8", shell: false, timeout: 15_000,
  });
  if (config.error || config.status !== 0) {
    throw new Error("Cannot verify npm script-shell for multiline npx arguments. Execute the program directly with Node.js.");
  }
  if (config.stdout.trim() && config.stdout.trim() !== "null") throw new Error(shellError);

  const pathKey = Object.keys(env).sort().find((key) => key.toLowerCase() === "path");
  let bash;
  for (const entry of (env[pathKey] ?? "").split(path.delimiter).filter(Boolean)) {
    const git = path.join(entry.replace(/^"(.*)"$/u, "$1"), "git.exe");
    if (!isFile(git)) continue;
    const directory = path.dirname(fs.realpathSync(git));
    bash = [
      path.resolve(directory, "..", "bin", "bash.exe"),
      path.resolve(directory, "..", "usr", "bin", "bash.exe"),
      path.join(directory, "bash.exe"),
      path.resolve(directory, "..", "..", "bin", "bash.exe"),
    ].find(isFile);
    if (bash) break;
  }
  if (!bash) {
    throw new Error("Multiline npx arguments on Windows require Git for Windows with Git Bash on PATH. Execute the program directly with Node.js if Git Bash is unavailable.");
  }
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(?:MSYS2_ARG_CONV_EXCL|MSYS_NO_PATHCONV)$/iu.test(key)));
  childEnv.MSYS2_ARG_CONV_EXCL = "*";
  childEnv.MSYS_NO_PATHCONV = "1";
  const invocationArgs = [cli, `--script-shell=${bash}`, ...args];
  if (args.some((arg) => arg.includes("\r"))) {
    // MSYS Bash discards raw CR while parsing. Expand it only after parsing.
    const preload = [
      "import { createRequire } from 'node:module';",
      `const require = createRequire(${JSON.stringify(cli)});`,
      "let escape;",
      "try { escape = require('@npmcli/promise-spawn/lib/escape.js'); } catch (cause) { throw new Error('Cannot preserve carriage returns: unsupported npm shell quoting entrypoint.', { cause }); }",
      "if (typeof escape?.sh !== 'function') throw new Error('Cannot preserve carriage returns: unsupported npm shell quoting entrypoint.');",
      "const quote = escape.sh;",
      "escape.sh = (value) => value.split('\\r').map((part) => quote(part)).join(\"$'\\\\r'\");",
    ].join("\n");
    invocationArgs.unshift("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
  }
  return { command: nodePath, args: invocationArgs, env: childEnv };
}

/**
 * Resolve npm's batch launchers to JavaScript and preserve multiline npx argv.
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, nodePath?: string, cwd?: string, platform?: NodeJS.Platform}} options
 * @returns {{command: string, args: string[], env?: NodeJS.ProcessEnv}}
 */
export function resolveSpawnCommand(command, args, { env = process.env, nodePath = process.execPath, cwd = process.cwd(), platform = process.platform } = {}) {
  const match = /^(npm|npx)(?:\.cmd)?$/iu.exec(command);
  if (!match) return { command, args };

  const tool = match[1].toLowerCase();
  const cli = npmCliCandidates(tool, env, nodePath).find(isFile);
  if (!cli) {
    throw new Error(`Cannot locate ${tool}-cli.js. Run via npm run release:signoff or install npm alongside Node.js.`);
  }
  if (platform === "win32" && tool === "npx" && args.some((arg) => /[\r\n]/u.test(arg))) {
    // cmd.exe truncates multiline arguments inside npm's nested script execution.
    return multilineNpxInvocation(cli, args, { env, nodePath, cwd });
  }
  return { command: nodePath, args: [cli, ...args] };
}
