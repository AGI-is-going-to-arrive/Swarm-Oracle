import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const ASSET_DIRS = [
  path.join(FRONTEND_ROOT, "public/assets/ui/generated"),
  path.join(FRONTEND_ROOT, "public/assets/scenes"),
];
const REQUIRED_KEYS = [
  "preset",
  "model",
  "provider",
  "source",
  "source_url",
  "generated_at",
  "output",
  "prompt",
];

async function* walkPngFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      yield* walkPngFiles(fullPath);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".png")) {
      yield fullPath;
    }
  }
}

async function main() {
  const problems = [];

  for (const assetDir of ASSET_DIRS) {
    for await (const pngPath of walkPngFiles(assetDir)) {
      const metaPath = `${pngPath}.meta.json`;
      let meta;
      try {
        meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      } catch (error) {
        problems.push({
          type: "missing_or_invalid_meta",
          asset: path.relative(FRONTEND_ROOT, pngPath),
          meta: path.relative(FRONTEND_ROOT, metaPath),
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const key of REQUIRED_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(meta, key)) {
          problems.push({
            type: "missing_required_key",
            asset: path.relative(FRONTEND_ROOT, pngPath),
            meta: path.relative(FRONTEND_ROOT, metaPath),
            key,
          });
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error(JSON.stringify({ problems }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "ok" }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
