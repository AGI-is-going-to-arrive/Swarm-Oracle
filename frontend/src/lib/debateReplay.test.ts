import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DebateResultPayload } from '../types';
import {
  buildDebateReplayLocalUrl,
  buildDebateReplayUrl,
  decodeDebateReplayToken,
  encodeDebateReplayToken,
  readDebateReplayLocalCopy,
  saveDebateReplayLocalCopy,
} from './debateReplay';

const payload: DebateResultPayload = {
  id: 'debate-1',
  question: 'Should AI run every city?',
  motion: 'Motion',
  language: 'en',
  profile_id: 'governance',
  scene_theme: 'debate_arena_civic',
  status: 'done',
  current_phase: 'verdict',
  created_at: '2026-03-19T00:00:00Z',
  updated_at: '2026-03-19T00:00:00Z',
  participants: [
    { side: 'proposition', name: 'Proposition', role: 'Governance Vanguard' },
    { side: 'opposition', name: 'Opposition', role: 'Governance Skeptic' },
    { side: 'judge', name: 'Judge', role: 'Structured Arbiter' },
  ],
  score: { proposition: 80, opposition: 72, audience_meter: 8 },
  turns: [],
  available_prediction_options: {
    winner: ['proposition', 'opposition'],
    verdict_tone: ['order', 'balance', 'rupture'],
  },
  phase_insights: [],
  result_ready: true,
  result: {
    winner: 'proposition',
    verdict_tone: 'order',
    adjudication_mode: 'llm_hybrid',
    score: { proposition: 80, opposition: 72, audience_meter: 8 },
    breakdown: {
      coherence: { proposition: 4, opposition: 3 },
    },
    best_argument: 'Best argument',
    best_rebuttal: 'Best rebuttal',
    judge_summary: 'Judge summary',
    judge_rationale: null,
    replay: [],
  },
  counterplay: null,
  predictions: [],
};

describe('debateReplay helpers', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a replay token', () => {
    const token = encodeDebateReplayToken(payload);
    expect(decodeDebateReplayToken(token)).toEqual(payload);
  });

  it('builds a portable replay url', () => {
    const url = buildDebateReplayUrl('https://example.com/', payload);
    expect(url).toContain('/debate/replay/result?replay=');
  });

  it('round-trips a local replay copy', () => {
    const replayId = saveDebateReplayLocalCopy(payload);
    expect(readDebateReplayLocalCopy(replayId)).toEqual(payload);
    expect(buildDebateReplayLocalUrl('https://example.com/', replayId)).toContain('/debate/replay/result?local=');
  });

  it('falls back when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {});

    const replayId = saveDebateReplayLocalCopy(payload);

    expect(replayId).toMatch(/\S+/);
    expect(readDebateReplayLocalCopy(replayId)).toEqual(payload);
  });
});
