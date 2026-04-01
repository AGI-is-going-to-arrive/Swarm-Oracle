#!/usr/bin/env node
/**
 * Generate dedicated scene backgrounds and card frames for new themes/profiles
 * using Gemini Image API.
 *
 * Usage: node scripts/generate-theme-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCENES_DIR = path.join(__dirname, '../public/assets/scenes');
const FRAMES_DIR = path.join(__dirname, '../public/assets/ui/generated');

const API_KEY = 'AQ.Ab8RN6Kc6cRSLuZqe8SwJ4KTR5jz_d7lEy2ZbmUWnwJfpGAk_A';
const MODEL = 'gemini-3.1-flash-image-preview';
const API_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL}:generateContent?key=${API_KEY}`;

const SCENE_STYLE = 'high-resolution pixel art, detailed retro game background, 16:9 aspect ratio, rich color palette, atmospheric lighting, no text or UI elements';

const SCENES = [
  { id: 'finance_exchange', prompt: `A bustling stock exchange trading floor in pixel art style. Rows of wooden desks with green-screen terminals, ticker tape machines, stacks of ledgers, brass lamps, tall arched windows with golden light streaming in. ${SCENE_STYLE}` },
  { id: 'cyber_market', prompt: `A neon-lit cyberpunk street market at night in pixel art style. Holographic signs, cramped stalls with glowing wares, rain-slicked streets reflecting neon, vendors in hooded coats, overhead wires and drones. ${SCENE_STYLE}` },
  { id: 'medical_institute', prompt: `A Victorian-era medical research institute interior in pixel art style. Glass cabinets with specimen jars, brass microscopes, anatomy charts on walls, gas lamps, a long laboratory bench with chemical apparatus. ${SCENE_STYLE}` },
  { id: 'academy_hall', prompt: `A grand university lecture hall in pixel art style. Tiered wooden seating, a large chalkboard covered in equations, stained glass windows, bookshelves lining the walls, a podium with an open tome. ${SCENE_STYLE}` },
  { id: 'tech_campus', prompt: `A futuristic technology campus courtyard in pixel art style. Glass and steel buildings, holographic displays floating above walkways, manicured gardens with geometric paths, a central fountain with data streams. ${SCENE_STYLE}` },
  { id: 'arena_colosseum', prompt: `An ancient Roman colosseum interior in pixel art style. Sandy arena floor, towering stone arches, spectator stands filled with crowds, red banners, a royal box with purple canopy, dramatic sunset sky. ${SCENE_STYLE}` },
  { id: 'concert_hall', prompt: `An ornate baroque concert hall in pixel art style. Crystal chandeliers, velvet-curtained stage, gilded balconies, an orchestra pit with instruments, warm amber lighting, intricate ceiling frescoes. ${SCENE_STYLE}` },
  { id: 'media_tower', prompt: `A towering broadcast media center rooftop in pixel art style. Satellite dishes and antenna arrays, banks of monitors showing different channels, a news desk overlooking a sprawling city skyline at dusk. ${SCENE_STYLE}` },
  { id: 'diplomatic_summit', prompt: `A grand diplomatic summit hall in pixel art style. A large round table with national flags, ornate carved chairs, marble columns, floor-to-ceiling draped windows, world map on the wall, formal lighting. ${SCENE_STYLE}` },
  { id: 'underground_network', prompt: `An underground resistance bunker network in pixel art style. Concrete tunnels with exposed pipes, makeshift radio stations, flickering fluorescent lights, maps pinned to walls, crates of supplies, a war room table. ${SCENE_STYLE}` },
];

// Extra scene that was mapped but could use its own identity
const EXTRA_SCENE = { id: 'finance_exchange_variant', prompt: null }; // skip if not needed

const FRAME_STYLE = 'ornate decorative card frame border, pixel art style, transparent center area for content, no text, symmetrical design, game UI element';

const FRAMES = [
  { id: 'finance', prompt: `A gold and emerald green card frame with coin motifs, stock chart wave patterns in corners, banker's seal emblem at top. ${FRAME_STYLE}` },
  { id: 'scholar', prompt: `A warm parchment and dark wood card frame with quill pen motifs, open book ornaments in corners, university crest at top. ${FRAME_STYLE}` },
  { id: 'medical', prompt: `A white and teal card frame with caduceus staff motifs, heartbeat line patterns, medical cross emblem at top. ${FRAME_STYLE}` },
  { id: 'technology', prompt: `A sleek silver and electric blue card frame with circuit board trace patterns, gear and chip motifs in corners, digital eye emblem at top. ${FRAME_STYLE}` },
  { id: 'entertainment', prompt: `A vibrant purple and gold card frame with stage spotlight motifs, musical note ornaments, theatrical mask emblem at top. ${FRAME_STYLE}` },
  { id: 'diplomacy', prompt: `A navy blue and pearl white card frame with olive branch motifs, globe and handshake ornaments in corners, balanced scales emblem at top. ${FRAME_STYLE}` },
];

async function generateImage(prompt, outputPath, label) {
  if (fs.existsSync(outputPath)) {
    const stat = fs.statSync(outputPath);
    // Skip if file > 100KB (likely already a real image, not a tiny placeholder)
    if (stat.size > 100 * 1024) {
      console.log(`[SKIP] ${label} — already exists (${(stat.size / 1024).toFixed(0)}KB)`);
      return true;
    }
  }

  console.log(`[GEN] ${label}...`);
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`  [ERR] HTTP ${res.status} attempt ${attempt}/3: ${errText.slice(0, 200)}`);
        if (attempt < 3) {
          const wait = res.status === 429 ? 15000 * attempt : 5000 * attempt;
          console.log(`  [WAIT] ${(wait/1000).toFixed(0)}s before retry...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        return false;
      }

      const json = await res.json();
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

      if (!imagePart) {
        console.error(`  [ERR] No image in response attempt ${attempt}/3`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        return false;
      }

      const buffer = Buffer.from(imagePart.inlineData.data, 'base64');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, buffer);
      console.log(`  [OK] ${label} — ${(buffer.length / 1024).toFixed(0)}KB`);
      return true;
    } catch (err) {
      console.error(`  [ERR] ${err.message} attempt ${attempt}/3`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
  return false;
}

async function main() {
  console.log('=== Generating Scene Backgrounds ===\n');
  let sceneOk = 0, sceneFail = 0;
  for (const scene of SCENES) {
    const out = path.join(SCENES_DIR, `${scene.id}.png`);
    const ok = await generateImage(scene.prompt, out, `scene/${scene.id}`);
    if (ok) sceneOk++; else sceneFail++;
    // Rate limit: pause between requests to avoid 429
    await new Promise(r => setTimeout(r, 8000));
  }

  console.log('\n=== Generating Card Frames ===\n');
  let frameOk = 0, frameFail = 0;
  for (const frame of FRAMES) {
    const out = path.join(FRAMES_DIR, `gameplay_card_frame_${frame.id}.png`);
    const ok = await generateImage(frame.prompt, out, `frame/${frame.id}`);
    if (ok) frameOk++; else frameFail++;
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n=== Done ===`);
  console.log(`Scenes: ${sceneOk} OK, ${sceneFail} failed`);
  console.log(`Frames: ${frameOk} OK, ${frameFail} failed`);

  if (sceneFail > 0 || frameFail > 0) {
    process.exitCode = 1;
  }
}

main();
