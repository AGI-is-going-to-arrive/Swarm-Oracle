import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(SCRIPT_DIR, "..");

const PRESETS = {
  debate_arena_civic: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/debate_arena_civic.png"),
    prompt: "Pixel-art civic debate arena for a retro strategy theater interface, same visual language as SwarmOracle Game Boy Color inspired political simulation, ceremonial public assembly floor, two opposed speaker podiums, central judge dais, warm ivory stone, muted magenta and brass civic banners, clear center stage for UI overlays, cinematic yet grid-friendly, 16:9 composition, no text, no photorealism, no neon esports style.",
  },
  debate_arena_judicial: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/debate_arena_judicial.png"),
    prompt: "Pixel-art judicial debate arena for a retro strategy theater interface, same visual language as SwarmOracle Game Boy Color inspired political simulation, grand tribunal bench, opposing legal podiums, stacked archive walls, restrained ivory stone, aged brass and violet procedural accents, readable center stage for UI overlays, cinematic but grid-friendly, 16:9 composition, no text, no photorealism, no modern TV studio look.",
  },
  debate_arena_forum: {
    output: path.join(FRONTEND_ROOT, "public/assets/scenes/debate_arena_forum.png"),
    prompt: "Pixel-art high-conflict public forum for a retro strategy theater interface, same visual language as SwarmOracle Game Boy Color inspired political simulation, circular speaker floor, rotating oversight balcony, modular civic machinery, warm parchment stone, brass rails and muted berry-violet signals, readable center stage for UI overlays, cinematic and grid-friendly, 16:9 composition, no text, no photorealism, no neon esports style.",
  },
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
  debate_stage_banner: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_stage_banner.png"),
    prompt: "Pixel-art ceremonial stage banner for a retro strategy debate arena UI, same visual language as SwarmOracle political theater, warm parchment cloth, brass trim, restrained berry-violet civic sigils, centered empty plaque for phase text, wide transparent-friendly panel composition, no words, no photorealism.",
  },
  debate_verdict_panel: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_verdict_panel.png"),
    prompt: "Pixel-art verdict panel for a retro strategy debate result screen, same visual language as SwarmOracle Game Boy Color inspired theater UI, layered ivory paper, brass frame, muted magenta judicial wax seal, centered empty content area, elegant but readable, no text, no photorealism, no esports HUD look.",
  },
  debate_score_meter: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_score_meter.png"),
    prompt: "Pixel-art score meter frame for a retro strategy debate arena UI, same visual language as SwarmOracle theater, symmetrical dual-lane gauge, brass rails, parchment backing, muted berry-violet civic accents, empty transparent center for dynamic bars, no text, no photorealism.",
  },
  debate_badge_proposition: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_badge_proposition.png"),
    prompt: "Pixel-art badge icon for the proposition side in a retro strategy debate arena, same visual language as SwarmOracle theater, warm brass and parchment crest, upward civic torch motif, compact emblem, no text, transparent-friendly, no photorealism.",
  },
  debate_badge_opposition: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_badge_opposition.png"),
    prompt: "Pixel-art badge icon for the opposition side in a retro strategy debate arena, same visual language as SwarmOracle theater, steel-blue and brass crest, balanced shield motif, compact emblem, no text, transparent-friendly, no photorealism.",
  },
  debate_badge_judge: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_badge_judge.png"),
    prompt: "Pixel-art badge icon for the judge in a retro strategy debate arena, same visual language as SwarmOracle theater, ivory and brass crest, ceremonial gavel and scales motif, compact emblem, no text, transparent-friendly, no photorealism.",
  },
  debate_quote_frame: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/debate_quote_frame.png"),
    prompt: "Pixel-art quote frame for a retro strategy debate result UI, same visual language as SwarmOracle theater, layered parchment inset, brass corner brackets, subtle berry-violet civic flourish, empty center for text overlay, no text, no photorealism.",
  },
  oracle_chamber_panel: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/oracle_chamber_panel.png"),
    prompt: "Pixel-art oracle chamber decorative panel for a retro strategy archive debrief UI, same visual language as SwarmOracle, warm parchment and ivory paper layers, brass trim, restrained plum-violet sigils, circular archive-eye motif, subtle worldline thread glyphs, elegant empty center and soft edge ornament for UI overlays, no text, no photorealism, no neon, no modern glassmorphism.",
  },
  oracle_chamber_crest: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/oracle_chamber_crest.png"),
    prompt: "Pixel-art oracle chamber crest for a retro strategy archive UI, wax-seal inspired plum and brass emblem, concentric archive eye, time-ring and braided thread motifs, compact icon, transparent-friendly, no text, no photorealism.",
  },
  worldline_roundtable_panel: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/worldline_roundtable_panel.png"),
    prompt: "Pixel-art worldline roundtable decorative panel for a retro strategy multiverse review UI, same visual language as SwarmOracle, parchment and ivory surface, brass ring table motif, restrained plum-violet archive symbols, suspended worldline threads and probability markers around an empty center, ceremonial but readable, no text, no photorealism, no sci-fi neon dashboard.",
  },
  worldline_roundtable_banner: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/worldline_roundtable_banner.png"),
    prompt: "Pixel-art ceremonial banner for a worldline roundtable UI, same visual language as SwarmOracle archive theater, warm parchment cloth, brass trims, plum-violet worldline knots, mirrored seat ornaments, elegant central plaque area for title text, transparent-friendly, no words, no photorealism.",
  },
  oracle_quote_frame: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/oracle_quote_frame.png"),
    prompt: "Pixel-art quote frame for Oracle Chambers follow-up transcript UI, same visual language as SwarmOracle, layered ivory paper inset, brass corner clamps, subtle oracle-eye and thread motifs in plum-violet, empty center for quote text, transparent-friendly, no words, no photorealism.",
  },
  badge_ending_chamber: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/badge_ending_chamber.png"),
    prompt: "Pixel-art compact badge for Ending Chamber mode, same visual language as SwarmOracle archive theater, brass and parchment medallion, archive-eye doorway motif, transparent-friendly, no text, no photorealism.",
  },
  badge_worldline_roundtable: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/badge_worldline_roundtable.png"),
    prompt: "Pixel-art compact badge for Worldline Roundtable mode, same visual language as SwarmOracle archive theater, brass and parchment medallion, circular table with branching thread motif, transparent-friendly, no text, no photorealism.",
  },
  badge_crossline_gallery: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/badge_crossline_gallery.png"),
    prompt: "Pixel-art compact badge for Crossline Gallery mode, same visual language as SwarmOracle archive theater, brass and parchment medallion, balcony gallery motif overlooking distant thread cards, transparent-friendly, no text, no photorealism.",
  },
  ending_room_participant_frame: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/ending_room_participant_frame.png"),
    prompt: "Pixel-art participant card frame for Oracle Chambers UI, same visual language as SwarmOracle, narrow vertical-friendly parchment card with brass trim, plum-violet accent tabs, subtle archive thread embossing, readable empty center for avatar and stats, no text, no photorealism.",
  },
  ending_room_influence_badge: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/ending_room_influence_badge.png"),
    prompt: "Pixel-art tiny influence badge for Oracle Chambers participant cards, same visual language as SwarmOracle archive theater, brass lozenge with plum-violet star and radiating lines, transparent-friendly, no text, no photorealism.",
  },
  timeline_marker_chamber: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/timeline_marker_chamber.png"),
    prompt: "Pixel-art small timeline marker icon for Oracle Chamber events, same visual language as SwarmOracle, brass timeline pin with archive-eye doorway motif, transparent-friendly, no text, no photorealism.",
  },
  timeline_marker_roundtable: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/timeline_marker_roundtable.png"),
    prompt: "Pixel-art small timeline marker icon for Worldline Roundtable events, same visual language as SwarmOracle, brass timeline pin with circular table and branching worldline motif, transparent-friendly, no text, no photorealism.",
  },
  ending_room_speaker_glow: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/ending_room_speaker_glow.png"),
    prompt: "Pixel-art speaker focus glow ornament for Oracle Chambers UI, same visual language as SwarmOracle archive theater, soft brass and plum-violet ring aura, transparent-friendly, designed to sit behind an active speaker portrait or badge, no text, no photorealism.",
  },
  archivist_emblem: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/archivist_emblem.png"),
    prompt: "Pixel-art archivist emblem for SwarmOracle archive UI, wax seal and brass medallion hybrid, archive eye, hourglass, braided thread and dossier motifs, compact transparent-friendly emblem, no text, no photorealism.",
  },
  worldline_dossier_divider: {
    output: path.join(FRONTEND_ROOT, "public/assets/ui/generated/worldline_dossier_divider.png"),
    prompt: "Pixel-art dossier divider ornament for worldline archive UI, same visual language as SwarmOracle, long horizontal parchment divider with brass knots, plum-violet thread motifs and subtle archive marks, transparent-friendly, no text, no photorealism.",
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
        source: "Google Gemini image preview API",
        source_url: "https://aiplatform.googleapis.com/v1/publishers/google",
        generated_at: new Date().toISOString(),
        output: path.relative(FRONTEND_ROOT, outputPath),
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
