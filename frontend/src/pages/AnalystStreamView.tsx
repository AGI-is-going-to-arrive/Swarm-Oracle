import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import type { AnalystSSEEvent, ModelProfile } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';
import ReACTReasoningPanel from '../components/ReACTReasoningPanel';
import {
  createInitialAnalystCache,
  type AnalystCacheState,
  type AnalystStoppedReason,
} from './postVerdictCaches';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import { listModelProfiles } from '../api/client';

interface AnalystStreamViewProps {
  scenarioId: string;
  roomId?: string | null;
  cache: AnalystCacheState;
  setCache: Dispatch<SetStateAction<AnalystCacheState>>;
  contextVersion: number;
}

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

  const { enabled: modelProfilesEnabled } = useCapabilityCheck('model_profiles');
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('');

  useEffect(() => {
    if (modelProfilesEnabled) {
      listModelProfiles()
        .then((res) => setProfiles(res.profiles || []))
        .catch(() => {});
    }
  }, [modelProfilesEnabled]);

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
    const useProfile = Boolean(selectedProfileId);
    void start({
      question: normalizedQuestion,
      ...(roomId ? { room_id: roomId } : {}),
      ...(useProfile
        ? { analyst_model_profile_id: selectedProfileId }
        : {
            ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
            ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
            ...(policy.model ? { llm_model: policy.model } : {}),
          }),
    });
  }, [question, roomId, setCache, start, selectedProfileId]);

  const handleRetry = useCallback(() => {
    handleSubmit();
  }, [handleSubmit]);

  return (
    <div className="analyst-stream" data-testid="analyst-stream-view">
      {modelProfilesEnabled && (
        <div className="analyst-profile-selector" style={{ marginBottom: '0.75rem' }}>
          <label htmlFor="analyst-profile-select" style={{ fontSize: '0.85rem', fontWeight: 500, display: 'block', marginBottom: '0.25rem' }}>
            {t('model_profiles.placeholder_select')}
          </label>
          <select
            id="analyst-profile-select"
            className="form-control"
            value={selectedProfileId}
            onChange={(e) => setSelectedProfileId(e.target.value)}
            disabled={cache.streaming}
            style={{ width: '100%', padding: '0.4rem 0.5rem', borderRadius: '4px', border: '1px solid var(--border-color, #e6dfd5)', fontSize: '0.85rem' }}
          >
            <option value="">{t('model_profiles.byok_custom_option')}</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.provider} - {p.model})</option>
            ))}
          </select>
        </div>
      )}
      <div className="analyst-stream__input">
        <textarea
          className="analyst-stream__textarea"
          aria-label={t('roundtable.analyst_label')}
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

      <ReACTReasoningPanel
        iterations={cache.iterations}
        finalAnswer={cache.finalAnswer}
        streaming={cache.streaming}
        stoppedReason={cache.stoppedReason}
        error={cache.error}
        aborted={cache.aborted}
      />

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

      {cache.stoppedReason
        && cache.stoppedReason !== 'final_response'
        && (cache.stoppedReason === 'llm_error' || cache.stoppedReason === 'stream_failure') && (
        <div className="analyst-stream__stopped">
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
