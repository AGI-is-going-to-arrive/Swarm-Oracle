import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { FILE_BUDGETS } from "./lib/performanceBudgetConfig.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const DIST_ASSETS_DIR = path.join(FRONTEND_ROOT, "dist", "assets");

const DIRECTORY_BUDGETS = [
  {
    label: "public/assets total",
    dir: path.join(FRONTEND_ROOT, "public", "assets"),
    maxBytes: 100 * 1024 * 1024,
  },
  {
    label: "public/assets/scenes",
    dir: path.join(FRONTEND_ROOT, "public", "assets", "scenes"),
    maxBytes: 65 * 1024 * 1024,
  },
  {
    label: "public/assets/ui",
    dir: path.join(FRONTEND_ROOT, "public", "assets", "ui"),
    maxBytes: 45 * 1024 * 1024,
  },
];

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(2)} KiB`;
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

async function listFiles(dirPath) {
  return await fs.readdir(dirPath, { withFileTypes: true });
}

async function getDirectorySize(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(fullPath);
    } else if (entry.isFile()) {
      total += (await fs.stat(fullPath)).size;
    }
  }
  return total;
}

async function resolveFileBudgetMatches(pattern) {
  const entries = await listFiles(DIST_ASSETS_DIR);
  const matches = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(DIST_ASSETS_DIR, entry.name))
    .sort();
  if (matches.length === 0) {
    throw new Error(`Missing dist asset matching ${pattern}`);
  }
  return matches;
}

async function evaluateFileBudget(budget) {
  const filePaths = await resolveFileBudgetMatches(budget.pattern);
  return await Promise.all(filePaths.map(async (filePath) => {
    const bytes = await fs.readFile(filePath);
    const gzipBytes = gzipSync(bytes).length;
    return {
      label: budget.label,
      file: path.relative(FRONTEND_ROOT, filePath),
      bytes: bytes.length,
      gzipBytes,
      maxBytes: budget.maxBytes,
      maxGzipBytes: budget.maxGzipBytes,
      withinBudget: bytes.length <= budget.maxBytes && gzipBytes <= budget.maxGzipBytes,
    };
  }));
}

async function evaluateDirectoryBudget(budget) {
  const bytes = await getDirectorySize(budget.dir);
  return {
    label: budget.label,
    dir: path.relative(FRONTEND_ROOT, budget.dir),
    bytes,
    maxBytes: budget.maxBytes,
    withinBudget: bytes <= budget.maxBytes,
  };
}

async function main() {
  const fileResults = (await Promise.all(FILE_BUDGETS.map(evaluateFileBudget))).flat();
  const directoryResults = await Promise.all(DIRECTORY_BUDGETS.map(evaluateDirectoryBudget));

  const violations = [
    ...fileResults
      .filter((result) => !result.withinBudget)
      .map((result) => ({
        label: result.label,
        detail: `${result.file} raw=${formatKiB(result.bytes)} budget=${formatKiB(result.maxBytes)}, gzip=${formatKiB(result.gzipBytes)} budget=${formatKiB(result.maxGzipBytes)}`,
      })),
    ...directoryResults
      .filter((result) => !result.withinBudget)
      .map((result) => ({
        label: result.label,
        detail: `${result.dir} size=${formatMiB(result.bytes)} budget=${formatMiB(result.maxBytes)}`,
      })),
  ];

  const summary = {
    status: violations.length === 0 ? "ok" : "violation",
    file_budgets: fileResults.map((result) => ({
      ...result,
      bytes_label: formatKiB(result.bytes),
      gzip_label: formatKiB(result.gzipBytes),
      max_bytes_label: formatKiB(result.maxBytes),
      max_gzip_label: formatKiB(result.maxGzipBytes),
    })),
    directory_budgets: directoryResults.map((result) => ({
      ...result,
      bytes_label: formatMiB(result.bytes),
      max_bytes_label: formatMiB(result.maxBytes),
    })),
    violations,
  };

  console.log(JSON.stringify(summary, null, 2));

  if (violations.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
