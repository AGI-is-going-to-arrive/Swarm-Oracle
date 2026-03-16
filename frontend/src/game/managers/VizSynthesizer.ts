/**
 * VizSynthesizer — Synthesizes viz:* events from REST API data.
 *
 * When a user opens a completed simulation in Pixel Theater mode,
 * no live WebSocket viz events are emitted. This module bridges that
 * gap by constructing viz:scene_init, viz:bubble_show, and
 * viz:emotion_change events from the Zustand store data.
 */

import type { AgentInfo, AgentMessage } from '../../types';
import { inferSceneThemeFromQuestion } from '../../lib/themeRegistry';
import { dispatchVizEvent } from './EventBridge';

// ── Role → Sprite ID Mapping ────────────────────────────

const ROLE_SPRITE_MAP: Record<string, string> = {
  // ── English roles ──
  king: 'sprite_king',
  queen: 'sprite_king',
  monarch: 'sprite_king',
  ruler: 'sprite_king',
  emperor: 'sprite_king',
  president: 'sprite_king',
  warrior: 'sprite_warrior',
  soldier: 'sprite_warrior',
  fighter: 'sprite_warrior',
  guard: 'sprite_warrior',
  knight: 'sprite_warrior',
  scholar: 'sprite_scholar',
  professor: 'sprite_scholar',
  teacher: 'sprite_scholar',
  intellectual: 'sprite_scholar',
  philosopher: 'sprite_scholar',
  student: 'sprite_scholar',
  merchant: 'sprite_merchant',
  trader: 'sprite_merchant',
  businessman: 'sprite_merchant',
  banker: 'sprite_merchant',
  ceo: 'sprite_merchant',
  entrepreneur: 'sprite_merchant',
  farmer: 'sprite_farmer',
  peasant: 'sprite_farmer',
  worker: 'sprite_farmer',
  laborer: 'sprite_farmer',
  priest: 'sprite_priest',
  cleric: 'sprite_priest',
  monk: 'sprite_priest',
  religious: 'sprite_priest',
  rebel: 'sprite_rebel',
  revolutionary: 'sprite_rebel',
  activist: 'sprite_rebel',
  diplomat: 'sprite_diplomat',
  ambassador: 'sprite_diplomat',
  negotiator: 'sprite_diplomat',
  politician: 'sprite_diplomat',
  villager: 'sprite_villager',
  citizen: 'sprite_villager',
  civilian: 'sprite_villager',
  spy: 'sprite_spy',
  agent: 'sprite_spy',
  informant: 'sprite_spy',
  explorer: 'sprite_explorer',
  adventurer: 'sprite_explorer',
  traveler: 'sprite_explorer',
  scientist: 'sprite_scientist',
  researcher: 'sprite_scientist',
  inventor: 'sprite_scientist',
  general: 'sprite_general',
  commander: 'sprite_general',
  marshal: 'sprite_general',
  admiral: 'sprite_general',
  artist: 'sprite_artist',
  musician: 'sprite_artist',
  poet: 'sprite_artist',
  painter: 'sprite_artist',
  composer: 'sprite_artist',
  engineer: 'sprite_engineer',
  architect: 'sprite_engineer',
  builder: 'sprite_engineer',
  noble: 'sprite_noble',
  lord: 'sprite_noble',
  duke: 'sprite_noble',
  baron: 'sprite_noble',
  aristocrat: 'sprite_noble',
  healer: 'sprite_healer',
  doctor: 'sprite_healer',
  physician: 'sprite_healer',
  medic: 'sprite_healer',
  nurse: 'sprite_healer',

  // ── Chinese role keywords ──
  国王: 'sprite_king',
  女王: 'sprite_king',
  皇帝: 'sprite_king',
  总统: 'sprite_king',
  主席: 'sprite_king',
  领袖: 'sprite_king',
  统治者: 'sprite_king',
  战士: 'sprite_warrior',
  士兵: 'sprite_warrior',
  军人: 'sprite_warrior',
  武士: 'sprite_warrior',
  骑士: 'sprite_warrior',
  将领: 'sprite_general',
  将军: 'sprite_general',
  司令: 'sprite_general',
  元帅: 'sprite_general',
  学者: 'sprite_scholar',
  教授: 'sprite_scholar',
  教师: 'sprite_scholar',
  老师: 'sprite_scholar',
  学生: 'sprite_scholar',
  哲学家: 'sprite_scholar',
  研究: 'sprite_scientist',
  科学家: 'sprite_scientist',
  发明家: 'sprite_scientist',
  物理: 'sprite_scientist',
  化学: 'sprite_scientist',
  实验: 'sprite_scientist',
  商人: 'sprite_merchant',
  企业家: 'sprite_merchant',
  董事: 'sprite_merchant',
  创始人: 'sprite_merchant',
  总裁: 'sprite_merchant',
  农民: 'sprite_farmer',
  工人: 'sprite_farmer',
  劳动者: 'sprite_farmer',
  牧师: 'sprite_priest',
  僧侣: 'sprite_priest',
  宗教: 'sprite_priest',
  革命: 'sprite_rebel',
  叛逆: 'sprite_rebel',
  活动家: 'sprite_rebel',
  外交: 'sprite_diplomat',
  大使: 'sprite_diplomat',
  政治家: 'sprite_diplomat',
  政治: 'sprite_diplomat',
  局长: 'sprite_diplomat',
  官员: 'sprite_diplomat',
  村民: 'sprite_villager',
  市民: 'sprite_villager',
  公民: 'sprite_villager',
  居民: 'sprite_villager',
  间谍: 'sprite_spy',
  特工: 'sprite_spy',
  探险家: 'sprite_explorer',
  冒险家: 'sprite_explorer',
  艺术家: 'sprite_artist',
  音乐家: 'sprite_artist',
  诗人: 'sprite_artist',
  画家: 'sprite_artist',
  作曲家: 'sprite_artist',
  工程师: 'sprite_engineer',
  建筑师: 'sprite_engineer',
  程序员: 'sprite_engineer',
  软件: 'sprite_engineer',
  贵族: 'sprite_noble',
  伯爵: 'sprite_noble',
  公爵: 'sprite_noble',
  医生: 'sprite_healer',
  医师: 'sprite_healer',
  护士: 'sprite_healer',
};

/**
 * Well-known figure names → sprite mapping.
 * Only the surname or key part is needed for partial match.
 */
const NAME_SPRITE_MAP: Record<string, string> = {
  // Business / Tech leaders → merchant
  盖茨: 'sprite_merchant', 'gates': 'sprite_merchant',
  马云: 'sprite_merchant', 'jack ma': 'sprite_merchant',
  扎克伯格: 'sprite_merchant', 'zuckerberg': 'sprite_merchant',
  贝索斯: 'sprite_merchant', 'bezos': 'sprite_merchant',
  马斯克: 'sprite_engineer', 'musk': 'sprite_engineer',
  乔布斯: 'sprite_engineer', 'jobs': 'sprite_engineer',
  李彦宏: 'sprite_scientist', // Baidu AI
  任正非: 'sprite_merchant', // Huawei
  // Political leaders → king
  克林顿: 'sprite_king', 'clinton': 'sprite_king',
  奥巴马: 'sprite_king', 'obama': 'sprite_king',
  特朗普: 'sprite_king', 'trump': 'sprite_king',
  丘吉尔: 'sprite_general', 'churchill': 'sprite_general',
  林肯: 'sprite_king', 'lincoln': 'sprite_king',
  拿破仑: 'sprite_general', 'napoleon': 'sprite_general',
  // Scientists → scientist
  爱因斯坦: 'sprite_scientist', 'einstein': 'sprite_scientist',
  牛顿: 'sprite_scientist', 'newton': 'sprite_scientist',
  达芬奇: 'sprite_artist', 'da vinci': 'sprite_artist',
  // Scholars / Philosophers
  孔子: 'sprite_scholar',
  柏拉图: 'sprite_scholar', 'plato': 'sprite_scholar',
  亚里士多德: 'sprite_scholar', 'aristotle': 'sprite_scholar',
  诸葛亮: 'sprite_scholar',
};

/** All available sprite keys for hash-based distribution. */
const ALL_SPRITE_KEYS = [
  'sprite_king', 'sprite_warrior', 'sprite_scholar', 'sprite_merchant',
  'sprite_farmer', 'sprite_priest', 'sprite_rebel', 'sprite_diplomat',
  'sprite_villager', 'sprite_spy', 'sprite_explorer', 'sprite_scientist',
  'sprite_general', 'sprite_artist', 'sprite_engineer', 'sprite_noble',
  'sprite_healer',
];

/** Simple string hash for deterministic sprite assignment. */
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Map an agent's role (and name as fallback) to a sprite texture key.
 * Supports both English and Chinese roles/names.
 */
export function mapRoleToSpriteId(role: string, name: string): string {
  const roleLower = role.toLowerCase();
  const nameLower = name.toLowerCase();

  // Exact match on role
  if (ROLE_SPRITE_MAP[roleLower]) {
    return ROLE_SPRITE_MAP[roleLower];
  }

  // Partial match on role (works for both English and Chinese)
  for (const [keyword, spriteId] of Object.entries(ROLE_SPRITE_MAP)) {
    if (roleLower.includes(keyword)) return spriteId;
  }

  // Well-known name lookup
  for (const [nameKey, spriteId] of Object.entries(NAME_SPRITE_MAP)) {
    if (nameLower.includes(nameKey) || name.includes(nameKey)) return spriteId;
  }

  // Partial match on name via ROLE_SPRITE_MAP
  for (const [keyword, spriteId] of Object.entries(ROLE_SPRITE_MAP)) {
    if (nameLower.includes(keyword)) return spriteId;
  }

  // Deterministic hash-based fallback — distribute across all sprites for variety
  const hash = hashString(name || role);
  return ALL_SPRITE_KEYS[hash % ALL_SPRITE_KEYS.length];
}

export function inferSceneTheme(question: string): string {
  return inferSceneThemeFromQuestion(question);
}

// ── Position Generation ─────────────────────────────────

interface AgentVizData {
  agent_id: string;
  name: string;
  sprite_id: string;
  x: number;
  y: number;
}

/**
 * Generate agent positions using a semicircular arrangement.
 * Agents are placed on the lower 60% of the canvas (ground area).
 */
function generatePositions(agents: AgentInfo[]): AgentVizData[] {
  const count = agents.length;
  const canvasW = 800;
  const canvasH = 450;
  const centerX = canvasW / 2;
  const centerY = canvasH * 0.55;
  const radiusX = canvasW * 0.38;
  const radiusY = canvasH * 0.15;

  return agents.map((agent, i) => {
    // Distribute agents along a semicircle (π arc)
    const angle = Math.PI * (i / Math.max(count - 1, 1));
    const x = Math.round(centerX - radiusX * Math.cos(angle));
    const y = Math.round(centerY + radiusY * Math.sin(angle));

    return {
      agent_id: agent.id,
      name: agent.name,
      sprite_id: mapRoleToSpriteId(agent.role, agent.name),
      x,
      y,
    };
  });
}

// ── Public API ──────────────────────────────────────────

/**
 * Build a viz:scene_init event data object from store agents.
 */
export function synthesizeSceneInit(
  agents: AgentInfo[],
  theme: string,
): Record<string, unknown> {
  return {
    scene_theme: theme,
    agents: generatePositions(agents),
  };
}

/**
 * Replay historical messages as a timed sequence of viz:bubble_show and
 * viz:emotion_change events. Returns a cleanup function to cancel timers.
 */
export function synthesizeBubbles(
  messages: AgentMessage[],
  agents: AgentInfo[],
  batchSize = 3,
  intervalMs = 1800,
): () => void {
  // Build agent_id set for validation
  const agentIds = new Set(agents.map(a => a.id));

  const timers: ReturnType<typeof setTimeout>[] = [];
  const maxMessages = messages.length; // Replay ALL messages across all rounds
  const batches = Math.ceil(maxMessages / batchSize);

  for (let batch = 0; batch < batches; batch++) {
    const timer = setTimeout(() => {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, maxMessages);

      for (let i = start; i < end; i++) {
        const msg = messages[i];
        // Use agent_id directly — WorldScene stores agents by agent_id,
        // NOT by sprite texture key. The old code passed sprite texture
        // keys (e.g. "sprite_king") which never matched the UUID keys.
        const agentId = msg.agent_id;
        if (!agentIds.has(agentId)) continue; // skip unknown agents

        // Dispatch bubble
        dispatchVizEvent('viz:bubble_show', {
          sprite_id: agentId,
          bubble_text: msg.message.length > 60 ? msg.message.slice(0, 57) + '...' : msg.message,
          emotion: msg.emotion || 'neutral',
        });

        // Dispatch emotion change
        if (msg.emotion && msg.emotion !== 'neutral') {
          dispatchVizEvent('viz:emotion_change', {
            sprite_id: agentId,
            halo_color: emotionToHaloColor(msg.emotion),
          });
        }
      }
    }, intervalMs * batch);

    timers.push(timer);
  }

  console.log(`[VizSynthesizer] Scheduled ${batches} bubble batches (${maxMessages} messages)`);

  return () => {
    for (const t of timers) clearTimeout(t);
  };
}

/**
 * Immediately render the latest visible bubble state for each agent.
 * Useful for "skip replay" controls on completed theater scenes.
 */
export function synthesizeLatestBubbles(
  messages: AgentMessage[],
  agents: AgentInfo[],
): void {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const latestByAgent = new Map<string, AgentMessage>();

  for (const message of messages) {
    if (!agentIds.has(message.agent_id)) continue;
    latestByAgent.set(message.agent_id, message);
  }

  for (const message of latestByAgent.values()) {
    dispatchVizEvent('viz:bubble_show', {
      sprite_id: message.agent_id,
      bubble_text: message.message.length > 60 ? message.message.slice(0, 57) + '...' : message.message,
      emotion: message.emotion || 'neutral',
    });

    if (message.emotion && message.emotion !== 'neutral') {
      dispatchVizEvent('viz:emotion_change', {
        sprite_id: message.agent_id,
        halo_color: emotionToHaloColor(message.emotion),
      });
    }
  }
}

// ── Helpers ─────────────────────────────────────────────

function emotionToHaloColor(emotion: string): string {
  const colors: Record<string, string> = {
    aggressive: '#ff0000',
    angry: '#ff3300',
    anxious: '#ff9900',
    fearful: '#ff6600',
    cautious: '#ffcc00',
    calm: '#66ccff',
    hopeful: '#00cc66',
    cooperative: '#33cc33',
    confident: '#6699ff',
    neutral: '#999999',
  };
  return colors[emotion] || '#999999';
}
