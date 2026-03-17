import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");

const PRESETS = {
  generic_frame: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/gameplay_card_frame_generic.png"),
    prompt: "Pixel-art gameplay card frame for general strategy scenarios, warm ivory panel, magenta violet and brass accents, subtle switchboard and civic committee motifs, centered empty window for content, wide 16:9 composition, no text, no checkerboard transparency, consistent with SwarmOracle retro theater UI.",
  },
  generic_scene_variant: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/switchboard_forum_variant.png"),
    prompt: "Pixel-art rotating review chamber for retro strategy governance drama, warm ivory stone, magenta violet and brass committee signals, civic switchboard consoles, procedural tribunal atmosphere, wide 16:9 composition, no text, no photorealism, consistent with SwarmOracle theater style.",
  },
  law_scene_variant: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/law_court_variant.png"),
    prompt: "Pixel-art constitutional court chamber for a retro strategy simulation, warm ivory stone, brass and violet judicial accents, elevated bench, legal archive walls, wide 16:9 composition, no text, no photorealism, consistent with SwarmOracle theater style.",
  },
  faith_scene_variant: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/faith_temple_variant.png"),
    prompt: "Pixel-art sacred council hall for prophecy and doctrinal conflict, candlelit ivory stone, amethyst and gold glow, ritual banners, wide 16:9 composition, no text, no photorealism, consistent with SwarmOracle theater style.",
  },
};

function parseArgs(argv) {
  const args = {
    model: "gemini-3.1-flash-image-preview",
    presets: [],
    force: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--model" && next) {
      args.model = next;
      i += 1;
    } else if (arg === "--preset" && next) {
      args.presets.push(next);
      i += 1;
    } else if (arg === "--force") {
      args.force = true;
    }
  }

  if (args.presets.length === 0) {
    throw new Error(`Usage: node scripts/generate-ui-assets.mjs --preset ${Object.keys(PRESETS).join("|")} [--preset ...] [--model gemini-3.1-flash-image-preview|gemini-3-pro-image-preview] [--force]`);
  }

  return args;
}

async function requestImage({ model, prompt, apiKey }) {
  const payload = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const attempts = [
    {
      label: "aiplatform",
      url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${model}:generateContent?key=${apiKey}`,
    },
    {
      label: "generativelanguage",
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const response = await fetch(attempt.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await response.json();
    if (!response.ok) {
      lastError = new Error(`${attempt.label} ${response.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
      continue;
    }

    const inlineData = json?.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData;
    if (!inlineData?.data) {
      lastError = new Error(`${attempt.label}: response did not include inline image data`);
      continue;
    }

    return {
      provider: attempt.label,
      mimeType: inlineData.mimeType ?? "image/png",
      data: inlineData.data,
      raw: json,
    };
  }

  throw lastError ?? new Error("No image provider returned usable image data");
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY is required");
  }

  for (const presetName of args.presets) {
    const preset = PRESETS[presetName];
    if (!preset) {
      throw new Error(`Unknown preset: ${presetName}`);
    }

    const outputPath = preset.output;
    if (!args.force) {
      try {
        await fs.access(outputPath);
        console.log(`skip ${presetName}: ${outputPath} already exists`);
        continue;
      } catch {
        // continue
      }
    }

    const result = await requestImage({
      model: args.model,
      prompt: preset.prompt,
      apiKey,
    });

    await ensureDir(outputPath);
    await fs.writeFile(outputPath, Buffer.from(result.data, "base64"));
    await fs.writeFile(
      `${outputPath}.meta.json`,
      `${JSON.stringify({
        preset: presetName,
        model: args.model,
        provider: result.provider,
        prompt: preset.prompt,
      }, null, 2)}\n`,
      "utf8",
    );
    console.log(`generated ${presetName} -> ${path.relative(FRONTEND_ROOT, outputPath)} via ${result.provider}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
