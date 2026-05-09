import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AnalystSSEEvent } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import {
  createInitialAnalystCache,
  type AnalystCacheState,
  type AnalystStoppedReason,
} from './postVerdictCaches';

interface AnalystStreamViewProps {
  scenarioId: string;
  roomId?: string | null;
  cache: AnalystCacheState;
  setCache: Dispatch<SetStateAction<AnalystCacheState>>;
  contextVersion: number;
}

type AnalystToolKind = 'causal' | 'identity' | 'web' | 'other';
const ANALYST_STOPPED_REASONS = new Set<AnalystStoppedReason>([
  'final_response',
  'llm_error',
  'unexpected_action',
  'max_iterations',
  'stream_failure',
]);

function normalizeStoppedReason(reason: unknown): AnalystStoppedReason {
  return typeof reason === 'string' && ANALYST_STOPPED_REASONS.has(reason as AnalystStoppedReason)
    ? reason as AnalystStoppedReason
    : 'final_response';
}

function classifyTool(action: string): AnalystToolKind {
  switch (action) {
    case 'query_causal_graph':
      return 'causal';
    case 'search_identity_memories':
      return 'identity';
    case 'search_web_context':
      return 'web';
    default:
      return 'other';
  }
}

const TOOL_ICON: Record<AnalystToolKind, string> = {
  causal: '◈',
  identity: '◎',
  web: '◉',
  other: '□',
};

export default function AnalystStreamView({
  scenarioId,
  roomId,
  cache,
  setCache,
  contextVersion,
}: AnalystStreamViewProps) {
  const { t } = useTranslation();
  const [question, setQuestion] = useState('');
  const userAbortedRef = useRef(false);

  const onEvent = useCallback((event: AnalystSSEEvent) => {
    setCache((current) => {
      if (event.type === 'analyst_thinking') {
        const iterations = current.iterations.map((iteration) => ({ ...iteration }));
        const existing = iterations.find((iteration) => iteration.iteration === event.iteration);
        if (existing) {
          existing.action = event.action;
          existing.params = event.params;
        } else {
          iterations.push({
            iteration: event.iteration,
            action: event.action,
            params: event.params,
          });
        }
        return { ...current, iterations };
      }

      if (event.type === 'analyst_tool_result') {
        return {
          ...current,
          iterations: current.iterations.map((iteration) => (
            iteration.iteration === event.iteration
              ? {
                ...iteration,
                summary: event.summary,
                elapsed_ms: event.elapsed_ms,
              }
              : iteration
          )),
        };
      }

      if (event.type === 'analyst_response') {
        return {
          ...current,
          finalAnswer: event.answer,
          stoppedReason: normalizeStoppedReason(event.stopped_reason),
          streaming: false,
          error: event.error ?? current.error,
          aborted: false,
        };
      }

      return current;
    });
  }, [setCache]);

  const onError = useCallback((code: string, message: string) => {
    setCache((current) => ({
      ...current,
      error: `${code}: ${message}`,
      streaming: false,
      aborted: false,
    }));
  }, [setCache]);

  const onComplete = useCallback(() => {
    setCache((current) => ({
      ...current,
      streaming: false,
      aborted: current.aborted || userAbortedRef.current,
    }));
  }, [setCache]);

  const { start, abort } = useRoundtableSseStream<AnalystSSEEvent>({
    scenarioId,
    endpoint: 'analyst',
    onEvent,
    onError,
    onComplete,
  });

  const handleAbort = useCallback(() => {
    userAbortedRef.current = true;
    setCache((current) => ({
      ...current,
      streaming: false,
      error: null,
      aborted: true,
    }));
    abort();
  }, [abort, setCache]);

  useEffect(() => {
    abort();
  }, [abort, contextVersion]);

  const handleSubmit = useCallback(() => {
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;
    userAbortedRef.current = false;
    setCache({
      ...createInitialAnalystCache(),
      streaming: true,
      aborted: false,
    });

    const policy = loadLlmProviderPolicy();
    void start({
      question: normalizedQuestion,
      ...(roomId ? { room_id: roomId } : {}),
      ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
      ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
      ...(policy.model ? { llm_model: policy.model } : {}),
    });
  }, [question, roomId, setCache, start]);

  const handleRetry = useCallback(() => {
    handleSubmit();
  }, [handleSubmit]);

  const stoppedReasonLabel = (reason: AnalystStoppedReason | null): string => {
    switch (reason) {
      case 'final_response': return '';
      case 'llm_error': return t('roundtable.analyst_error_llm');
      case 'unexpected_action': return t('roundtable.analyst_error_action');
      case 'max_iterations': return t('roundtable.analyst_max_iterations');
      case 'stream_failure': return t('roundtable.analyst_error_stream');
      default: return '';
    }
  };

  const toolLabel = (action: string): string => {
    const kind = classifyTool(action);
    switch (kind) {
      case 'causal': return t('analyst.tool_causal_graph');
      case 'identity': return t('analyst.tool_identity');
      case 'web': return t('analyst.tool_web');
      default: return action;
    }
  };

  return (
    <div className="analyst-stream" data-testid="analyst-stream-view">
      <div className="analyst-stream__input">
        <textarea
          className="analyst-stream__textarea"
          placeholder={t('roundtable.analyst_placeholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={cache.streaming}
          rows={2}
        />
        <button
          type="button"
          className={`analyst-stream__submit btn btn--sm${cache.streaming ? ' is-streaming' : ''}`}
          onClick={cache.streaming ? handleAbort : handleSubmit}
          disabled={!cache.streaming && !question.trim()}
        >
          {cache.streaming ? t('roundtable.analyst_stop') : t('roundtable.analyst_ask')}
        </button>
      </div>

      {!cache.streaming
        && cache.iterations.length === 0
        && !cache.finalAnswer
        && !cache.error
        && !cache.aborted && (
        <p className="analyst-stream__empty-hint">{t('roundtable.explore_analyst_desc')}</p>
      )}

      {cache.iterations.length > 0 && (
        <div className="analyst-stream__iterations" aria-live="polite">
          {cache.iterations.map((iteration) => {
            const kind = classifyTool(iteration.action);
            return (
              <div key={iteration.iteration} className="analyst-stream__iteration">
                <span className="analyst-stream__iteration-badge">{iteration.iteration}</span>
                <div className="analyst-stream__iteration-body">
                  <span
                    className={`analyst-tool-chip analyst-tool-chip--${kind}`}
                    data-tool-kind={kind}
                  >
                    <span className="analyst-tool-chip__icon" aria-hidden="true">{TOOL_ICON[kind]}</span>
                    <span className="analyst-tool-chip__label">{toolLabel(iteration.action)}</span>
                  </span>
                  {iteration.summary && (
                    <p className="analyst-stream__tool-summary">{iteration.summary}</p>
                  )}
                  {iteration.elapsed_ms != null && (
                    <span className="analyst-stream__elapsed">
                      {(iteration.elapsed_ms / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {cache.streaming && (
            <div className="analyst-stream__thinking">
              <span className="editorial-streaming-cursor">{t('roundtable.analyst_thinking')}</span>
            </div>
          )}
        </div>
      )}

      {cache.finalAnswer && (
        <div className="analyst-stream__answer" aria-live="polite">
          <p className="analyst-stream__answer-text">{cache.finalAnswer}</p>
        </div>
      )}

      {cache.stoppedReason && cache.stoppedReason !== 'final_response' && (
        <div className="analyst-stream__stopped">
          <span className="analyst-status-pill analyst-status-pill--error" aria-label={t('analyst.status_error')}>
            <span className="analyst-status-pill__dot" aria-hidden="true" />
            <span className="analyst-status-pill__label">{t('analyst.status_error')}</span>
          </span>
          <span className="analyst-status-pill__detail">{stoppedReasonLabel(cache.stoppedReason)}</span>
          {(cache.stoppedReason === 'llm_error' || cache.stoppedReason === 'stream_failure') && (
            <button type="button" className="btn btn--sm" onClick={handleRetry}>
              {t('roundtable.analyst_retry')}
            </button>
          )}
        </div>
      )}

      {cache.error && !cache.stoppedReason && (
        <div className="analyst-stream__error">
          <span className="analyst-status-pill analyst-status-pill--error" aria-label={t('analyst.status_error')}>
            <span className="analyst-status-pill__dot" aria-hidden="true" />
            <span className="analyst-status-pill__label">{t('analyst.status_error')}</span>
          </span>
          <span className="analyst-status-pill__detail">{cache.error}</span>
          <button type="button" className="btn btn--sm" onClick={handleRetry}>
            {t('roundtable.analyst_retry')}
          </button>
        </div>
      )}

      {!cache.streaming
        && !cache.error
        && !cache.stoppedReason
        && !cache.finalAnswer
        && cache.aborted && (
        <div className="analyst-stream__stopped">
          <span className="analyst-status-pill analyst-status-pill--aborted" aria-label={t('analyst.status_aborted')}>
            <span className="analyst-status-pill__dot" aria-hidden="true" />
            <span className="analyst-status-pill__label">{t('analyst.status_aborted')}</span>
          </span>
          <button type="button" className="btn btn--sm" onClick={handleRetry}>
            {t('roundtable.analyst_retry')}
          </button>
        </div>
      )}
    </div>
  );
}
