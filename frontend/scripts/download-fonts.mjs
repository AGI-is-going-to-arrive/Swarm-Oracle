#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// download-fonts.mjs — S0-3 Google Fonts localization (cross-platform)
//
// Re-fetches the four font families used by SwarmOracle from Google Fonts and
// regenerates frontend/src/fonts.css + frontend/public/fonts/*.woff2.
//
// Pure Node (>= 18, uses global fetch + fs) — runs on Windows / macOS / Linux
// with no bash dependency. Run from anywhere:
//   node frontend/scripts/download-fonts.mjs
//   npm run fonts            (from frontend/)
//
// Output:
//   frontend/public/fonts/{family}-{weight}[-italic][-cjk-NNN].woff2  (~200 files, ~10 MB)
//   frontend/src/fonts.css                                            (200 @font-face blocks)
//
// Why a script: full Noto Sans SC + Noto Serif SC coverage requires ~194 CJK
// subset chunks (~10 MB). Browsers fetch only the chunks whose unicode-range
// matches actual on-screen text, so the 10 MB on disk does NOT translate to
// 10 MB of network at runtime — typical Chinese page loads 1-2 chunks (~100 KB).
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(SCRIPT_DIR, "..");
const PUBLIC_FONTS_DIR = path.join(FRONTEND_DIR, "public", "fonts");
const FONTFACE_CSS = path.join(FRONTEND_DIR, "src", "fonts.css");

const GOOGLE_CSS_URL =
  "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300..700;1,300..700&family=Instrument+Sans:ital,wght@0,400..700;1,400..700&family=Noto+Sans+SC:wght@400..700&family=Noto+Serif+SC:wght@300..700&display=swap";

// A modern Chrome UA is required so Google returns woff2 + variable-font CSS.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36";

if (typeof fetch !== "function") {
  console.error("[download-fonts] global fetch unavailable — requires Node.js >= 18.");
  process.exit(1);
}

export function assignLocalFontNames(blocks) {
  const slugFamily = (f) => f.toLowerCase().replace(/\s+/g, "-");
  const weightSlug = (w) => w.replace(/\s+/g, "-");
  const chunkCounters = {};
  for (const b of blocks) {
    const styleSuffix = b.style === "italic" ? "-italic" : "";
    if (b.subset === null) {
      const key = b.family + "|" + b.style + "|" + b.weight;
      const idx = chunkCounters[key] ?? 0;
      chunkCounters[key] = idx + 1;
      b.localName =
        slugFamily(b.family) +
        "-" +
        weightSlug(b.weight) +
        styleSuffix +
        "-cjk-" +
        String(idx).padStart(3, "0") +
        ".woff2";
    } else {
      b.localName = slugFamily(b.family) + "-" + weightSlug(b.weight) + styleSuffix + ".woff2";
    }
  }
  return blocks;
}

async function main() {
  fs.mkdirSync(PUBLIC_FONTS_DIR, { recursive: true });

  console.log("[download-fonts] target dir:", PUBLIC_FONTS_DIR);
  console.log("[download-fonts] fontface css:", FONTFACE_CSS);

  // 1. Fetch the Google Fonts CSS index.
  const res = await fetch(GOOGLE_CSS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error("CSS fetch failed: " + res.status);
  const css = await res.text();

  // 2. Parse @font-face blocks. Optional preceding /* subset */ comment.
  const blockRe = /(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g;
  const blocks = [];
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const subset = m[1] || null;
    const body = m[2];
    blocks.push({
      subset,
      family: (body.match(/font-family:\s*'([^']+)'/) || [])[1],
      style: ((body.match(/font-style:\s*([^;]+);/) || [])[1] || "").trim(),
      weight: ((body.match(/font-weight:\s*([^;]+);/) || [])[1] || "").trim(),
      url: ((body.match(/url\(([^)]+)\)/) || [])[1] || "").trim(),
      range: ((body.match(/unicode-range:\s*([^;}]+);/) || [])[1] || "").trim(),
    });
  }

  // 3. Selection: keep latin (English) + all unlabeled blocks for Noto SC families (CJK chunks).
  const cjkFamilies = new Set(["Noto Sans SC", "Noto Serif SC"]);
  const selected = blocks.filter(
    (b) => b.subset === "latin" || (cjkFamilies.has(b.family) && b.subset === null),
  );

  // 4. Build local filenames: {family-slug}-{weight}[-italic][-cjk-NNN].woff2
  assignLocalFontNames(selected);

  console.log("[download-fonts] planning", selected.length, "files");

  // 5. Concurrency-limited downloader.
  async function pool(items, limit, worker) {
    let i = 0;
    await Promise.all(
      new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
          const idx = i++;
          if (idx >= items.length) return;
          await worker(items[idx], idx);
        }
      }),
    );
  }

  let ok = 0;
  let fail = 0;
  let totalBytes = 0;
  const t0 = Date.now();
  await pool(selected, 8, async (b) => {
    try {
      const r = await fetch(b.url);
      if (!r.ok) {
        fail++;
        return;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(path.join(PUBLIC_FONTS_DIR, b.localName), buf);
      totalBytes += buf.length;
      ok++;
    } catch {
      fail++;
    }
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    "[download-fonts] downloaded",
    ok,
    "/",
    selected.length,
    "(",
    (totalBytes / 1024 / 1024).toFixed(2),
    "MB,",
    elapsed,
    "s)",
  );
  if (fail > 0) {
    console.error("[download-fonts] FAIL count:", fail);
    process.exit(1);
  }

  // 6. Emit fonts.css.
  const out = [];
  out.push("/* ───────── Local Google Fonts ─────────");
  out.push("   Generated by frontend/scripts/download-fonts.mjs");
  out.push(
    "   " +
      selected.length +
      " woff2 files in /public/fonts/, " +
      (totalBytes / 1024 / 1024).toFixed(2) +
      " MB on disk.",
  );
  out.push("   Browsers fetch only the chunks whose unicode-range matches the page text.");
  out.push("   ───────────────────────────────────── */");
  out.push("");
  let lastFamily = null;
  for (const b of selected) {
    if (b.family !== lastFamily) {
      if (lastFamily !== null) out.push("");
      out.push("/* " + b.family + " */");
      lastFamily = b.family;
    }
    out.push("@font-face {");
    out.push("  font-family: '" + b.family + "';");
    out.push("  font-style: " + b.style + ";");
    out.push("  font-weight: " + b.weight + ";");
    out.push("  font-display: swap;");
    out.push("  src: url('/fonts/" + b.localName + "') format('woff2');");
    if (b.range) out.push("  unicode-range: " + b.range + ";");
    out.push("}");
  }
  fs.writeFileSync(FONTFACE_CSS, out.join("\n") + "\n");
  console.log("[download-fonts] wrote", FONTFACE_CSS, "(", selected.length, "@font-face blocks)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => console.log("[download-fonts] done"))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
