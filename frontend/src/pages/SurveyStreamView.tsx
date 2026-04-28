import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EndingRoomParticipant, SurveySSEEvent } from '../types';
import { useRoundtableSseStream } from '../hooks/useRoundtableSseStream';
import { loadLlmProviderPolicy } from '../lib/llmProviderPolicy';

export interface SurveyCacheState {
  responses: Map<string, SurveySSEEvent>;
  streaming: boolean;
  error: string | null;
  participantOrder: string[];
}

export const INITIAL_SURVEY_CACHE: SurveyCacheState = {
  responses: new Map(),
  streaming: false,
  error: null,
  participantOrder: [],
};

interface SurveyStreamViewProps {
  scenarioId: string;
  participants: EndingRoomParticipant[];
  cacheRef: React.RefObject<SurveyCacheState>;
  version: number;
  bumpVersion: () => void;
}

const MAX_SURVEY_PARTICIPANTS = 6;

export default function SurveyStreamView({
  scenarioId,
  participants,
  cacheRef,
  bumpVersion,
}: SurveyStreamViewProps) {
  const { t } = useTranslation();
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const questionRef = useRef('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(participants.slice(0, MAX_SURVEY_PARTICIPANTS).map((p) => p.id)),
  );

  const cache = cacheRef.current;

  const toggleParticipant = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_SURVEY_PARTICIPANTS) {
        next.add(id);
      }
      return next;
    });
  }, []);

  const orderedParticipantIds = useMemo(
    () => participants.filter((p) => selectedIds.has(p.id)).map((p) => p.id),
    [participants, selectedIds],
  );

  const participantMap = useMemo(
    () => new Map(participants.map((p) => [p.id, p])),
    [participants],
  );

  const onEvent = useCallback((event: SurveySSEEvent) => {
    if (event.type === 'survey_response') {
      if (!event.participant_id) {
        cacheRef.current.error = event.error || 'Roundtable survey stream failed';
        cacheRef.current.streaming = false;
        bumpVersion();
        return;
      }
      cacheRef.current.responses.set(event.participant_id, event);
      bumpVersion();
    }
  }, [cacheRef, bumpVersion]);

  const onError = useCallback((code: string, message: string) => {
    cacheRef.current.error = `${code}: ${message}`;
    cacheRef.current.streaming = false;
    bumpVersion();
  }, [cacheRef, bumpVersion]);

  const onComplete = useCallback(() => {
    cacheRef.current.streaming = false;
    bumpVersion();
  }, [cacheRef, bumpVersion]);

  const { start, abort } = useRoundtableSseStream<SurveySSEEvent>({
    scenarioId,
    endpoint: 'survey',
    onEvent,
    onError,
    onComplete,
  });

  const handleSubmit = useCallback(() => {
    const question = questionRef.current.trim();
    if (!question || orderedParticipantIds.length === 0) return;
    const c = cacheRef.current;
    c.responses = new Map();
    c.error = null;
    c.streaming = true;
    c.participantOrder = orderedParticipantIds;
    bumpVersion();

    const policy = loadLlmProviderPolicy();
    void start({
      question,
      participant_ids: orderedParticipantIds,
      ...(policy.apiKey ? { llm_api_key: policy.apiKey } : {}),
      ...(policy.baseUrl ? { llm_base_url: policy.baseUrl } : {}),
      ...(policy.model ? { llm_model: policy.model } : {}),
    });
  }, [cacheRef, bumpVersion, orderedParticipantIds, start]);

  const displayOrder = cache.participantOrder.length > 0 ? cache.participantOrder : orderedParticipantIds;

  return (
    <div className="survey-stream" data-testid="survey-stream-view">
      <div className="survey-stream__picker" role="group" aria-label={t('roundtable.survey_select_participants')}>
        {participants.map((p) => (
          <label key={p.id} className={`survey-stream__checkbox ${selectedIds.has(p.id) ? 'is-selected' : ''}`}>
            <input
              type="checkbox"
              checked={selectedIds.has(p.id)}
              onChange={() => toggleParticipant(p.id)}
              disabled={cache.streaming || (!selectedIds.has(p.id) && selectedIds.size >= MAX_SURVEY_PARTICIPANTS)}
            />
            <span>{p.display_name}</span>
          </label>
        ))}
      </div>

      <div className="survey-stream__input">
        <textarea
          className="survey-stream__textarea"
          placeholder={t('roundtable.survey_placeholder')}
          onChange={(e) => { questionRef.current = e.target.value; forceRender(); }}
          disabled={cache.streaming}
          rows={2}
        />
        <button
          type="button"
          className="survey-stream__submit btn btn--sm"
          onClick={cache.streaming ? abort : handleSubmit}
          disabled={!cache.streaming && (!questionRef.current.trim() || selectedIds.size === 0)}
        >
          {cache.streaming ? t('roundtable.survey_stop') : t('roundtable.survey_ask')}
        </button>
      </div>

      {(cache.streaming || cache.responses.size > 0) && (
        <div className="survey-stream__grid">
          {displayOrder.map((pid) => {
            const response = cache.responses.get(pid);
            const participant = participantMap.get(pid);
            const hasError = response?.error;
            return (
              <div
                key={pid}
                className={`survey-stream__card ${response ? 'is-filled' : ''} ${hasError ? 'is-error' : ''}`}
              >
                <div className="survey-stream__card-header">
                  <strong>{response?.display_name ?? participant?.display_name ?? pid}</strong>
                  <span>{response?.role ?? participant?.role_slot ?? ''}</span>
                </div>
                {response ? (
                  hasError ? (
                    <p className="survey-stream__card-error">{response.error}</p>
                  ) : (
                    <p className="survey-stream__card-answer">{response.answer}</p>
                  )
                ) : (
                  <div className="survey-stream__card-skeleton">
                    {cache.streaming && <span className="editorial-streaming-cursor" />}
                  </div>
                )}
                {response?.elapsed_ms != null && (
                  <span className="survey-stream__card-elapsed">
                    {(response.elapsed_ms / 1000).toFixed(1)}s
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!cache.streaming && cache.responses.size === 0 && !cache.error && (
        <p className="survey-stream__empty-hint">{t('roundtable.survey_empty_hint')}</p>
      )}

      {cache.error && (
        <div className="survey-stream__error">
          <span>{cache.error}</span>
          <button type="button" className="btn btn--sm" onClick={handleSubmit}>
            {t('roundtable.survey_retry')}
          </button>
        </div>
      )}
    </div>
  );
}
