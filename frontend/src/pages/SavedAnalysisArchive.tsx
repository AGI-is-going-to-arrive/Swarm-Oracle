import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listPostVerdictOutputs } from '../api/client';
import { SafeMarkdown } from '../components/SafeMarkdown';
import type { SavedPostVerdictOutput } from '../types';

export interface SavedAnalysisArchiveProps {
  scenarioId: string;
  roomId?: string | null;
  refreshKey?: number;
  newOutput?: { scenarioId: string; output: SavedPostVerdictOutput } | null;
  onOutputsChange?: (outputs: SavedPostVerdictOutput[]) => void;
}

export default function SavedAnalysisArchive({
  scenarioId, roomId, refreshKey, newOutput, onOutputsChange,
}: SavedAnalysisArchiveProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const [outputs, setOutputs] = useState<SavedPostVerdictOutput[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const requestEpochRef = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const epoch = ++requestEpochRef.current;
    setLoading(true);
    setError(false);
    try {
      const response = await listPostVerdictOutputs(scenarioId, roomId);
      if (requestEpochRef.current === epoch) {
        setOutputs((current) => [
          ...current.filter((item) => !response.outputs.some((loaded) => loaded.id === item.id)),
          ...response.outputs,
        ]);
      }
    } catch {
      if (requestEpochRef.current === epoch) setError(true);
    } finally {
      if (requestEpochRef.current === epoch) setLoading(false);
    }
  }, [roomId, scenarioId]);

  useEffect(() => {
    setOutputs([]);
    setOpenedId(null);
    void load();
    return () => { requestEpochRef.current += 1; };
  }, [load, refreshKey]);
  useEffect(() => {
    if (newOutput?.scenarioId !== scenarioId) return;
    const output = newOutput.output;
    if (roomId && output.room_id !== roomId && !output.archived) return;
    setOutputs((current) => [output, ...current.filter((item) => item.id !== output.id)]);
  }, [newOutput, roomId, scenarioId]);
  useEffect(() => { onOutputsChange?.(outputs); }, [onOutputsChange, outputs]);

  const opened = outputs.find((item) => item.id === openedId);
  return (
    <details className="saved-analysis-archive" style={{ marginBlock: '0.75rem' }}>
      <summary>{t('roundtable.saved_outputs')} ({outputs.length})</summary>
      {loading && <p role="status">{t('common.loading')}</p>}
      {error ? (
        <div role="status">
          <p>{t('roundtable.output_list_failed')}</p>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>{t('common.retry')}</button>
        </div>
      ) : !loading && outputs.length === 0 ? <p>{t('roundtable.output_empty')}</p> : null}
      {outputs.length > 0 && (
        <ul>
          {outputs.map((output) => (
            <li key={output.id} style={{ marginBlock: '0.5rem', overflowWrap: 'anywhere' }}>
              <button type="button" className="btn btn--sm" aria-expanded={openedId === output.id}
                onClick={() => setOpenedId((current) => current === output.id ? null : output.id)}>
                {t(output.kind === 'analyst' ? 'roundtable.explore_analyst' : 'roundtable.explore_survey')}: {output.question}
              </button>
              <time dateTime={output.created_at} style={{ display: 'block' }}>
                {new Date(output.created_at).toLocaleString(i18n?.language)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {opened && (
        <article aria-label={t('roundtable.saved_analysis')} style={{ overflowWrap: 'anywhere' }}>
          <h4>{opened.question}</h4>
          <p>{t('roundtable.output_origin_notice')}</p>
          {opened.archived && <p>{t('roundtable.output_archived')}</p>}
          {opened.provider && <p>{t('roundtable.output_model')}: {opened.provider.name}{opened.provider.name !== opened.provider.model ? ` (${opened.provider.model})` : ''}</p>}
          {opened.kind === 'analyst' ? <SafeMarkdown>{opened.answer ?? ''}</SafeMarkdown> : (
            opened.responses?.map((response) => (
              <section key={response.participant_id}>
                <h5>{response.display_name} · {response.role}</h5>
                <SafeMarkdown>{response.answer}</SafeMarkdown>
              </section>
            ))
          )}
        </article>
      )}
    </details>
  );
}
