import fs from "node:fs";
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

/**
 * Resolve npm's batch-file launchers to JavaScript so no shell re-parses argv.
 * @param {string} command
 * @param {string[]} args
 * @param {{env?: NodeJS.ProcessEnv, nodePath?: string}} options
 * @returns {{command: string, args: string[]}}
 */
export function resolveSpawnCommand(command, args, { env = process.env, nodePath = process.execPath } = {}) {
  const match = /^(npm|npx)(?:\.cmd)?$/iu.exec(command);
  if (!match) return { command, args };

  const tool = match[1].toLowerCase();
  const cli = npmCliCandidates(tool, env, nodePath).find(isFile);
  if (!cli) {
    throw new Error(`Cannot locate ${tool}-cli.js. Run via npm run release:signoff or install npm alongside Node.js.`);
  }
  return { command: nodePath, args: [cli, ...args] };
}
