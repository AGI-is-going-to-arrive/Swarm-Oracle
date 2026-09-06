import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DebateResultPayload } from '../types';
import {
  buildDebateReplayLocalUrl,
  buildDebateReplayUrl,
  decodeDebateReplayToken,
  DebateReplayStorageError,
  encodeDebateReplayToken,
  readDebateReplayLocalCopy,
  resetDebateReplayLocalCopies,
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
    vi.restoreAllMocks();
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

  it('reuses the same local id for equal content regardless of object key order', () => {
    const write = vi.spyOn(window.localStorage, 'setItem');
    const first = saveDebateReplayLocalCopy(payload);
    const reordered = Object.fromEntries(Object.entries(payload).reverse()) as unknown as DebateResultPayload;
    expect(saveDebateReplayLocalCopy(reordered)).toBe(first);
    expect(write).toHaveBeenCalledTimes(1);
    expect(readDebateReplayLocalCopy(first)).toEqual(payload);
  });

  it('retains at most 20 copies and never changes unrelated storage', () => {
    window.localStorage.setItem('user-preference', 'keep');
    const ids = Array.from({ length: 21 }, (_, index) => saveDebateReplayLocalCopy({ ...payload, id: `debate-${index}` }));
    expect(readDebateReplayLocalCopy(ids[0])).toBeNull();
    expect(readDebateReplayLocalCopy(ids.at(-1) ?? '')?.id).toBe('debate-20');
    const raw = window.localStorage.getItem('swarmoracle:debate-replay:v1') ?? '{}';
    expect(Object.keys(JSON.parse(raw))).toHaveLength(20);
    expect(window.localStorage.getItem('user-preference')).toBe('keep');
  });

  it('caps storage size by evicting older valid copies and rejects an oversized copy', () => {
    const large = { ...payload, result: { ...payload.result, judge_summary: 'A'.repeat(400_000) } };
    const first = saveDebateReplayLocalCopy({ ...large, id: 'first' });
    saveDebateReplayLocalCopy({ ...large, id: 'second' });
    const latest = saveDebateReplayLocalCopy({ ...large, id: 'latest' });
    const raw = window.localStorage.getItem('swarmoracle:debate-replay:v1') ?? '';
    expect(raw.length).toBeLessThanOrEqual(1_000_000);
    expect(readDebateReplayLocalCopy(first)).toBeNull();
    expect(readDebateReplayLocalCopy(latest)?.id).toBe('latest');
    expect(() => saveDebateReplayLocalCopy({ ...payload, result: { ...payload.result, judge_summary: 'B'.repeat(1_000_001) } })).toThrow('capacity');
    expect(window.localStorage.getItem('swarmoracle:debate-replay:v1')).toBe(raw);
  });

  it.each(['{broken', 'null', '[]', '{"bad":{"result":null}}'])('contains damaged cache without overwriting it: %s', (raw) => {
    window.localStorage.setItem('swarmoracle:debate-replay:v1', raw);
    expect(readDebateReplayLocalCopy('bad')).toBeNull();
    expect(() => saveDebateReplayLocalCopy(payload)).toThrow(DebateReplayStorageError);
    expect(window.localStorage.getItem('swarmoracle:debate-replay:v1')).toBe(raw);
  });

  it('isolates denied reads and quota failures, while reusing a readable existing link', () => {
    const first = saveDebateReplayLocalCopy(payload);
    const raw = window.localStorage.getItem('swarmoracle:debate-replay:v1');
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    expect(saveDebateReplayLocalCopy(payload)).toBe(first);
    expect(() => saveDebateReplayLocalCopy({ ...payload, id: 'new' })).toThrow('capacity');
    expect(window.localStorage.getItem('swarmoracle:debate-replay:v1')).toBe(raw);
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(readDebateReplayLocalCopy(first)).toBeNull();
    expect(() => saveDebateReplayLocalCopy(payload)).toThrow('unavailable');
  });

  it('does not treat inherited object properties as replay payloads', () => {
    window.localStorage.setItem('swarmoracle:debate-replay:v1', '{}');
    expect(readDebateReplayLocalCopy('toString')).toBeNull();
    expect(readDebateReplayLocalCopy('__proto__')).toBeNull();
  });

  it('resets only the explicitly owned replay cache', () => {
    window.localStorage.setItem('swarmoracle:debate-replay:v1', '{broken');
    window.localStorage.setItem('other-saved-content', 'keep');
    resetDebateReplayLocalCopies();
    expect(window.localStorage.getItem('swarmoracle:debate-replay:v1')).toBeNull();
    expect(window.localStorage.getItem('other-saved-content')).toBe('keep');
  });
});
