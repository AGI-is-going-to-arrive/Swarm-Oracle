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

function legacyPresetFor(filePath) {
  const assetId = path.parse(filePath).name;
  return `legacy_backfill/${assetId}`;
}

function relativeOutput(filePath) {
  return path.relative(FRONTEND_ROOT, filePath).replaceAll(path.sep, "/");
}

function legacySourceFor(filePath) {
  const normalized = filePath.replaceAll(path.sep, "/");
  if (normalized.includes("/public/assets/scenes/")) {
    return "Legacy repository scene asset with missing original generation record";
  }
  return "Legacy repository generated UI asset with missing original generation record";
}

function buildBackfilledMeta(filePath, existingMeta) {
  const now = new Date().toISOString();
  const hadExistingMeta = existingMeta != null;
  const hasCompleteLegacyRecord = hadExistingMeta
    && REQUIRED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(existingMeta, key));

  if (hasCompleteLegacyRecord) {
    return existingMeta;
  }

  const base = existingMeta ?? {};
  return {
    ...base,
    preset: base.preset ?? legacyPresetFor(filePath),
    model: base.model ?? "unknown",
    provider: base.provider ?? "unknown",
    source: base.source ?? legacySourceFor(filePath),
    source_url: Object.prototype.hasOwnProperty.call(base, "source_url") ? base.source_url : null,
    generated_at: Object.prototype.hasOwnProperty.call(base, "generated_at") ? base.generated_at : null,
    output: base.output ?? relativeOutput(filePath),
    prompt: Object.prototype.hasOwnProperty.call(base, "prompt") ? base.prompt : null,
    provenance_status: base.provenance_status ?? (hadExistingMeta ? "backfilled_partial" : "backfilled_legacy"),
    backfilled_at: base.backfilled_at ?? now,
    notes: base.notes ?? "Original generation preset/model/timestamp were not fully preserved in repository history; this sidecar was backfilled from an on-repo asset audit.",
  };
}

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

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  let created = 0;
  let updated = 0;
  let unchanged = 0;

  for (const assetDir of ASSET_DIRS) {
    for await (const pngPath of walkPngFiles(assetDir)) {
      const metaPath = `${pngPath}.meta.json`;
      let existingMeta = null;
      try {
        existingMeta = await readJson(metaPath);
      } catch {
        existingMeta = null;
      }

      const nextMeta = buildBackfilledMeta(pngPath, existingMeta);
      const prevSerialized = existingMeta ? `${JSON.stringify(existingMeta, null, 2)}\n` : null;
      const nextSerialized = `${JSON.stringify(nextMeta, null, 2)}\n`;

      if (prevSerialized === nextSerialized) {
        unchanged += 1;
        continue;
      }

      await fs.writeFile(metaPath, nextSerialized, "utf8");
      if (existingMeta) {
        updated += 1;
      } else {
        created += 1;
      }
    }
  }

  console.log(JSON.stringify({ created, updated, unchanged }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
