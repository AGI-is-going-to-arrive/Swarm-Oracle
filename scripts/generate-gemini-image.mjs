#!/usr/bin/env node
/**
 * SwarmOracle — Gemini Image Generation Script
 * Uses Google AI Platform API to generate game art assets.
 *
 * Usage:
 *   node scripts/generate-gemini-image.mjs --prompt "..." --output path/to/file.png
 *   node scripts/generate-gemini-image.mjs --batch batch-spec.json
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const API_KEY = 'AQ.Ab8RN6Kc6cRSLuZqe8SwJ4KTR5jz_d7lEy2ZbmUWnwJfpGAk_A';
const MODEL = 'gemini-3.1-flash-image-preview';
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

async function generateImage(prompt, outputPath) {
  const url = `${BASE_URL}/models/${MODEL}:generateContent?key=${API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      temperature: 0.4,
    }
  };

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.error) {
            reject(new Error(`API Error: ${result.error.message}`));
            return;
          }

          const candidates = result.candidates || [];
          if (candidates.length === 0) {
            reject(new Error('No candidates returned'));
            return;
          }

          const parts = candidates[0].content?.parts || [];
          const imagePart = parts.find(p => p.inlineData);

          if (!imagePart) {
            reject(new Error('No image in response'));
            return;
          }

          const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
          const dir = path.dirname(outputPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(outputPath, imageBuffer);

          console.log(`Generated: ${outputPath} (${imageBuffer.length} bytes)`);
          resolve(outputPath);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(requestBody));
    req.end();
  });
}

async function runBatch(specs) {
  const results = [];
  for (const spec of specs) {
    try {
      console.log(`\nGenerating: ${spec.name}`);
      await generateImage(spec.prompt, spec.output);
      results.push({ name: spec.name, status: 'ok', output: spec.output });
    } catch (e) {
      console.error(`Failed: ${spec.name} — ${e.message}`);
      results.push({ name: spec.name, status: 'error', error: e.message });
    }
    // Rate limit: small delay between requests
    await new Promise(r => setTimeout(r, 2000));
  }
  return results;
}

// --- Art Style Reference ---
const STYLE_PREFIX = `Digital illustration for a strategy/simulation game UI.
Style: isometric 3D-rendered aesthetic with rich color palettes, atmospheric lighting,
cinematic depth, Art Deco / steampunk-influenced frames with ornate borders,
gold and jewel-tone color schemes with glowing neon accents (blues, purples, cyans).
Professional polish suitable for a governance simulation game.
The image should be 1024x1024 pixels, detailed, and visually cohesive with a dark background.`;

const SCENE_STYLE = `Detailed isometric/3D-rendered game scene background for a strategy simulation game.
Rich architectural and environmental elements, atmospheric lighting, cinematic quality with depth and shadow.
Wide format (16:10 aspect ratio), 1024x640 pixels. Dark moody atmosphere with warm accent lighting.`;

const UI_STYLE = `Game UI element on transparent/dark background. Art Deco / steampunk style with ornate borders.
Gold and jewel-tone color scheme with subtle glowing neon accents. 512x512 pixels. Clean edges,
suitable for compositing in a web game interface.`;

// Parse CLI
const args = process.argv.slice(2);

if (args[0] === '--batch') {
  const batchFile = args[1];
  const specs = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
  runBatch(specs).then(results => {
    console.log('\n=== Batch Complete ===');
    console.log(JSON.stringify(results, null, 2));
  });
} else if (args[0] === '--prompt' && args[2] === '--output') {
  generateImage(args[1], args[3]).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
} else if (args[0] === '--generate-missing') {
  // Generate all missing and new assets
  const PUBLIC = path.resolve(import.meta.dirname, '../frontend/public');

  const batch = [
    // --- Missing timeline markers ---
    {
      name: 'timeline_marker_bet',
      prompt: `${UI_STYLE} A small diamond-shaped timeline marker icon for a "betting" event in a strategy game. Features a golden coin or chips symbol inside a glowing diamond frame. Subtle glow effect. 64x64 pixels.`,
      output: `${PUBLIC}/assets/ui/generated/timeline_marker_bet.png`
    },
    {
      name: 'timeline_marker_card',
      prompt: `${UI_STYLE} A small diamond-shaped timeline marker icon for a "card played" event in a strategy game. Features a playing card or gameplay card symbol inside a glowing diamond frame. Subtle cyan glow. 64x64 pixels.`,
      output: `${PUBLIC}/assets/ui/generated/timeline_marker_card.png`
    },
    {
      name: 'timeline_marker_fork',
      prompt: `${UI_STYLE} A small diamond-shaped timeline marker icon for a "branch fork" event in a strategy game. Features a branching path or fork-in-the-road symbol inside a glowing diamond frame. Purple glow effect. 64x64 pixels.`,
      output: `${PUBLIC}/assets/ui/generated/timeline_marker_fork.png`
    },
    {
      name: 'timeline_marker_result',
      prompt: `${UI_STYLE} A small diamond-shaped timeline marker icon for a "result" event in a strategy game. Features a trophy or checkmark symbol inside a glowing diamond frame. Gold glow effect. 64x64 pixels.`,
      output: `${PUBLIC}/assets/ui/generated/timeline_marker_result.png`
    },

    // --- New theme scenes ---
    {
      name: 'scene_finance_exchange',
      prompt: `${SCENE_STYLE} A grand financial exchange hall / stock market floor. Massive holographic stock tickers floating in the air. Traders at ornate desks with glowing screens. Art Deco architecture with marble columns and gold trim. Blue and green accent lighting. Luxurious but tense atmosphere.`,
      output: `${PUBLIC}/assets/scenes/finance_exchange.png`
    },
    {
      name: 'scene_cyber_market',
      prompt: `${SCENE_STYLE} A futuristic cyber marketplace / digital bazaar. Neon-lit stalls selling data and digital goods. Holographic advertisements floating above narrow streets. Mix of high-tech and street market aesthetics. Purple and pink neon lighting with warm market stall glow.`,
      output: `${PUBLIC}/assets/scenes/cyber_market.png`
    },
    {
      name: 'scene_medical_institute',
      prompt: `${SCENE_STYLE} A prestigious medical research institute / biotech laboratory. Clean white and glass architecture with holographic DNA helixes displayed. Advanced medical equipment with soft blue LED lighting. Sterile but warm atmosphere. Green and teal accent lighting.`,
      output: `${PUBLIC}/assets/scenes/medical_institute.png`
    },
    {
      name: 'scene_academy_hall',
      prompt: `${SCENE_STYLE} A grand academy / university great hall. Ancient library combined with futuristic learning technology. Floating holographic books and star maps. Gothic architecture with stained glass windows casting colored light. Warm amber and gold lighting with magical blue accents.`,
      output: `${PUBLIC}/assets/scenes/academy_hall.png`
    },
    {
      name: 'scene_tech_campus',
      prompt: `${SCENE_STYLE} A silicon valley-style tech campus / innovation hub. Glass and steel buildings with green spaces. Giant holographic interfaces and drone delivery. Modern minimalist architecture. Cool blue and white lighting with warm sunset tones.`,
      output: `${PUBLIC}/assets/scenes/tech_campus.png`
    },
    {
      name: 'scene_arena_colosseum',
      prompt: `${SCENE_STYLE} A grand colosseum / sports arena. Massive stone structure with glowing magical barriers. Spectator stands filled with shadows. Sand arena floor with dramatic lighting from above. Ancient Roman architecture meets fantasy elements. Warm gold and red lighting.`,
      output: `${PUBLIC}/assets/scenes/arena_colosseum.png`
    },
    {
      name: 'scene_concert_hall',
      prompt: `${SCENE_STYLE} A magnificent concert hall / theater for performing arts. Ornate balconies with red velvet. Crystal chandeliers casting prismatic light. A grand stage with curtains. Art Nouveau architectural details. Warm amber and crystal-white lighting with purple accents.`,
      output: `${PUBLIC}/assets/scenes/concert_hall.png`
    },
    {
      name: 'scene_media_tower',
      prompt: `${SCENE_STYLE} A towering media broadcast center / propaganda tower. Multiple screens broadcasting different channels. Satellite dishes on the rooftop. Art Deco meets cyberpunk aesthetic. Dramatic red and blue lighting. Ominous atmosphere of information control.`,
      output: `${PUBLIC}/assets/scenes/media_tower.png`
    },
    {
      name: 'scene_underground_network',
      prompt: `${SCENE_STYLE} An underground resistance network / secret bunker headquarters. Tunnels lined with maps and coded messages. Dim lighting with scattered candles and computer screens. Gritty, lived-in atmosphere. Warm amber and cool green lighting.`,
      output: `${PUBLIC}/assets/scenes/underground_network.png`
    },
    {
      name: 'scene_diplomatic_summit',
      prompt: `${SCENE_STYLE} A grand diplomatic summit hall. Circular table arrangement under a domed ceiling with a world map projection. Flags and emblems of multiple factions. Polished marble floors and glass walls overlooking a cityscape. Neutral warm lighting with blue diplomatic accents.`,
      output: `${PUBLIC}/assets/scenes/diplomatic_summit.png`
    },

    // --- New gameplay card frames ---
    {
      name: 'gameplay_card_frame_finance',
      prompt: `${UI_STYLE} Ornate card frame for a "Finance" themed gameplay card. Gold coin and chart motifs. Art Deco border with stock ticker tape pattern. Green and gold color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_finance.png`
    },
    {
      name: 'gameplay_card_frame_scholar',
      prompt: `${UI_STYLE} Ornate card frame for a "Scholar/Academic" themed gameplay card. Book, quill, and constellation motifs. Art Deco border with manuscript pattern. Deep blue and gold color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_scholar.png`
    },
    {
      name: 'gameplay_card_frame_medical',
      prompt: `${UI_STYLE} Ornate card frame for a "Medical/Healthcare" themed gameplay card. Caduceus, DNA helix, and heartbeat motifs. Art Deco border with molecular pattern. Teal and silver color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_medical.png`
    },
    {
      name: 'gameplay_card_frame_technology',
      prompt: `${UI_STYLE} Ornate card frame for a "Technology/Innovation" themed gameplay card. Circuit board, gear, and microchip motifs. Art Deco border with digital pattern. Cyan and silver color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_technology.png`
    },
    {
      name: 'gameplay_card_frame_entertainment',
      prompt: `${UI_STYLE} Ornate card frame for an "Entertainment/Arts" themed gameplay card. Theater mask, musical note, and star motifs. Art Deco border with curtain pattern. Purple and gold color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_entertainment.png`
    },
    {
      name: 'gameplay_card_frame_diplomacy',
      prompt: `${UI_STYLE} Ornate card frame for a "Diplomacy" themed gameplay card. Olive branch, handshake, and globe motifs. Art Deco border with flag pattern. Deep blue and white color scheme. Transparent center area for card content.`,
      output: `${PUBLIC}/assets/ui/generated/gameplay_card_frame_diplomacy.png`
    },
  ];

  runBatch(batch).then(results => {
    const ok = results.filter(r => r.status === 'ok').length;
    const fail = results.filter(r => r.status === 'error').length;
    console.log(`\n=== Generation Complete: ${ok} success, ${fail} failed ===`);
    if (fail > 0) {
      console.log('Failed items:', results.filter(r => r.status === 'error'));
    }
  });
} else {
  console.log(`Usage:
  node scripts/generate-gemini-image.mjs --prompt "description" --output path.png
  node scripts/generate-gemini-image.mjs --batch specs.json
  node scripts/generate-gemini-image.mjs --generate-missing`);
}
