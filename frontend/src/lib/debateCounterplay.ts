import type { TFunction } from 'i18next';

import type {
  DebatePhase,
  DebatePrediction,
  DebateCounterplayResult,
  DebatePredictionKind,
  DebateResultPayload,
  DebateVerdictTone,
} from '../types';
import { getDebatePhaseLabel, getDebateSideLabel, getDebateVerdictToneLabel } from './debateLabels';

const STORAGE_KEY = 'swarmoracle:debate-counterplay:v1';
const COUNTERPLAY_STORAGE_TTL_DAYS = 30;
const COUNTERPLAY_STORAGE_TTL_MS = COUNTERPLAY_STORAGE_TTL_DAYS * 24 * 60 * 60 * 1000;

export interface DebateCounterplayRecord {
  debateId: string;
  kind: DebatePredictionKind;
  targetValue: string;
  confidence: number;
  phase: DebatePhase;
  variant: 'balanced' | 'reversal';
  createdAt: string;
}

interface DebateCounterplayStore {
  version: number;
  records: Record<string, DebateCounterplayRecord>;
}

function isFreshCounterplayRecord(record: DebateCounterplayRecord, cutoff: number): boolean {
  const createdAt = Date.parse(record.createdAt);
  return Number.isFinite(createdAt) && createdAt >= cutoff;
}

function safeReadStore(): DebateCounterplayStore {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { version: 1, records: {} };
    }
    const parsed = JSON.parse(raw) as DebateCounterplayStore;
    const cutoff = Date.now() - COUNTERPLAY_STORAGE_TTL_MS;
    const records = Object.entries(parsed.records ?? {}).reduce<Record<string, DebateCounterplayRecord>>(
      (nextRecords, [key, record]) => {
        if (
          record != null
          && typeof record === 'object'
          && isFreshCounterplayRecord(record as DebateCounterplayRecord, cutoff)
        ) {
          nextRecords[key] = record as DebateCounterplayRecord;
        }
        return nextRecords;
      },
      {},
    );
    if (Object.keys(records).length !== Object.keys(parsed.records ?? {}).length) {
      safeWriteStore({ version: 1, records });
    }
    return {
      version: 1,
      records,
    };
  } catch {
    return { version: 1, records: {} };
  }
}

function safeWriteStore(store: DebateCounterplayStore) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (error) {
    console.warn('[debateCounterplay] Failed to persist counterplay state', error);
  }
}

export function saveDebateCounterplay(record: DebateCounterplayRecord): DebateCounterplayRecord {
  const store = safeReadStore();
  store.records[record.debateId] = record;
  safeWriteStore(store);
  return record;
}

export function loadDebateCounterplay(debateId: string): DebateCounterplayRecord | null {
  const store = safeReadStore();
  return store.records[debateId] ?? null;
}

export function extractDebateCounterplayRecord(
  predictions: DebatePrediction[] | null | undefined,
  payloadCounterplay?: DebateCounterplayResult | null,
): DebateCounterplayRecord | null {
  if (payloadCounterplay) {
    return {
      debateId: payloadCounterplay.debate_id,
      kind: payloadCounterplay.kind,
      targetValue: payloadCounterplay.target_value,
      confidence: payloadCounterplay.confidence,
      phase: payloadCounterplay.phase,
      variant: payloadCounterplay.variant,
      createdAt: payloadCounterplay.created_at,
    };
  }

  const candidate = [...(predictions ?? [])]
    .filter((prediction) => (
      prediction.is_counterplay === true
      && prediction.counterplay_phase
      && prediction.counterplay_variant
    ))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];

  if (!candidate?.counterplay_phase || !candidate?.counterplay_variant) return null;

  return {
    debateId: candidate.debate_id,
    kind: candidate.kind,
    targetValue: candidate.target_value,
    confidence: candidate.confidence,
    phase: candidate.counterplay_phase,
    variant: candidate.counterplay_variant,
    createdAt: candidate.created_at,
  };
}

export function resolveDebateCounterplayRecord(payload: {
  resultCounterplay?: DebateCounterplayResult | null;
  predictions?: DebatePrediction[] | null;
  localRecord?: DebateCounterplayRecord | null;
}): DebateCounterplayRecord | null {
  return (
    extractDebateCounterplayRecord(payload.predictions, payload.resultCounterplay)
    ?? payload.localRecord
    ?? null
  );
}

export function clearDebateCounterplay(debateId: string) {
  const store = safeReadStore();
  if (!store.records[debateId]) return;
  delete store.records[debateId];
  safeWriteStore(store);
}

export function getDebateCounterplaySummary(
  record: DebateCounterplayRecord | null | undefined,
  t: TFunction,
): string | null {
  if (!record) return null;

  const phaseLabel = getDebatePhaseLabel(t, record.phase);
  const targetLabel = record.kind === 'winner'
    ? getDebateSideLabel(t, record.targetValue as 'proposition' | 'opposition' | 'judge')
    : getDebateVerdictToneLabel(t, record.targetValue as DebateVerdictTone);

  return t(`debate.counterplay_summary_${record.variant}`, {
    phase: phaseLabel,
    target: targetLabel,
    confidence: Math.round(record.confidence * 100),
  });
}

export function resolveDebateCounterplayOutcome(
  record: DebateCounterplayRecord | null | undefined,
  result: DebateResultPayload['result'] | null | undefined,
): 'hit' | 'miss' | null {
  if (!record || !result) return null;
  if (record.kind === 'winner') {
    return record.targetValue === result.winner ? 'hit' : 'miss';
  }
  return record.targetValue === result.verdict_tone ? 'hit' : 'miss';
}
