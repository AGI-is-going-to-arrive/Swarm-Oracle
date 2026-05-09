import type { SurveySSEEvent } from '../types';

export interface AnalystIteration {
  iteration: number;
  action: string;
  params?: Record<string, unknown>;
  summary?: string;
  elapsed_ms?: number;
}

export type AnalystStoppedReason =
  | 'final_response'
  | 'llm_error'
  | 'unexpected_action'
  | 'max_iterations'
  | 'stream_failure';

export interface AnalystCacheState {
  iterations: AnalystIteration[];
  finalAnswer: string | null;
  stoppedReason: AnalystStoppedReason | null;
  streaming: boolean;
  error: string | null;
  aborted: boolean;
}

export function createInitialAnalystCache(): AnalystCacheState {
  return {
    iterations: [],
    finalAnswer: null,
    stoppedReason: null,
    streaming: false,
    error: null,
    aborted: false,
  };
}

export interface SurveyCacheState {
  responses: Map<string, SurveySSEEvent>;
  streaming: boolean;
  error: string | null;
  participantOrder: string[];
  aborted: boolean;
}

export function createInitialSurveyCache(): SurveyCacheState {
  return {
    responses: new Map(),
    streaming: false,
    error: null,
    participantOrder: [],
    aborted: false,
  };
}
