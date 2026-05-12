/* ═══════════════════════════════════════════════════════════
   P1-9 — Resume Panel
   Allows selecting a branch + round to resume simulation.
   P1-3 — Checkpoint picker enhancement: when checkpoints are
   available, the user picks a checkpoint to seed the resume
   round (with a compressed_summary preview); otherwise falls
   back to the legacy numeric input.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getCheckpoints, isApiError, resumeFromRound } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import type { CheckpointInfo } from '../types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatCheckpointSummary(
  raw: string | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const stances = parsed
        .flatMap((item) => {
          if (!isRecord(item) || typeof item.stance !== 'string') return [];
          return item.stance && item.stance !== '?' ? [item.stance] : [];
        })
        .slice(0, 3)
        .join(t('resume.stance_separator', { defaultValue: ', ' }));
      return t(stances ? 'resume.checkpoint_context_with_stances' : 'resume.checkpoint_context', {
        count: parsed.length,
        stances: stances || undefined,
        defaultValue: stances
          ? 'Resume with {{count}} agents — current stances include: {{stances}}'
          : 'Resume with {{count}} agents from this checkpoint',
      });
    }
    if (isRecord(parsed)) {
      const summary = parsed.global_summary || parsed.summary || parsed.compressed_summary;
      if (typeof summary === 'string') return summary.trim();
    }
  } catch {
    // not JSON — return raw if it looks like readable text
  }
  if (trimmed.startsWith('[{') || trimmed.startsWith('{"')) return '';
  return raw;
}

function formatCheckpointOptionLabel(
  cp: CheckpointInfo,
  branchTitle: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const roundLabel = t('resume.round_label', { round: cp.round_number, defaultValue: `Round ${cp.round_number}` });
  if (branchTitle) return `${roundLabel} — ${branchTitle}`;
  return roundLabel;
}

interface BranchLike {
  id: string;
  title: string;
}

interface Props {
  scenarioId: string;
  branches: BranchLike[];
  totalRounds: number;
  onCreated?: (branchId: string) => void;
}

export function ResumePanel({ scenarioId, branches, totalRounds, onCreated }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { enabled: replayEnabled } = useCapabilityCheck('counterfactual_replay');
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedRoundInput, setSelectedRoundInput] = useState('1');
  const [selectedCheckpointId, setSelectedCheckpointId] = useState('');
  const [checkpoints, setCheckpoints] = useState<CheckpointInfo[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const redirectTimerRef = useRef<number | null>(null);

  const normalizedTotalRounds = useMemo(() => {
    if (!Number.isFinite(totalRounds)) return 1;
    return Math.max(1, Math.floor(totalRounds));
  }, [totalRounds]);

  const selectedRound = Number(selectedRoundInput);
  const isRoundValid = (
    selectedRoundInput.trim() !== ''
    && Number.isInteger(selectedRound)
    && selectedRound >= 1
    && selectedRound <= normalizedTotalRounds
  );
  const isLocked = submitting || result !== null;
  const validationError = selectedBranch && !isRoundValid
    ? t('resume.invalid_round', {
        max: normalizedTotalRounds,
        defaultValue: `Enter a whole round between 1 and ${normalizedTotalRounds}`,
      })
    : null;
  const visibleError = error ?? validationError;
  const canSubmit = (
    Boolean(selectedBranch)
    && isRoundValid
    && !isLocked
    && !(checkpoints.length > 0 && !selectedCheckpointId)
  );

  useEffect(() => () => {
    if (redirectTimerRef.current !== null) {
      window.clearTimeout(redirectTimerRef.current);
    }
  }, []);

  // P1-3: load checkpoints (scenario-scoped) when capability enabled.
  // Re-fetch when the user switches branch so the picker stays branch-scoped.
  // Filter out checkpoints whose round exceeds totalRounds to avoid silently-disabled submit.
  useEffect(() => {
    if (!replayEnabled || !scenarioId) {
      setCheckpoints([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await getCheckpoints(scenarioId, selectedBranch || undefined);
        if (cancelled) return;
        const filtered = list.filter((cp) => cp.round_number <= normalizedTotalRounds);
        const sorted = [...filtered].sort((a, b) => a.round_number - b.round_number);
        setCheckpoints(sorted);
      } catch {
        if (cancelled) return;
        // Non-fatal: panel falls back to numeric input
        setCheckpoints([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [replayEnabled, scenarioId, selectedBranch, normalizedTotalRounds]);

  // Reset checkpoint selection when the available list changes.
  useEffect(() => {
    if (selectedCheckpointId
      && !checkpoints.some((cp) => cp.id === selectedCheckpointId)) {
      setSelectedCheckpointId('');
    }
  }, [checkpoints, selectedCheckpointId]);

  const selectedCheckpoint = useMemo(
    () => checkpoints.find((cp) => cp.id === selectedCheckpointId) ?? null,
    [checkpoints, selectedCheckpointId],
  );

  const hasCheckpoints = checkpoints.length > 0;
  const checkpointPickRequired = hasCheckpoints && !selectedCheckpointId;

  const handleSubmit = useCallback(async () => {
    if (!isRoundValid) {
      setError(
        t('resume.invalid_round', {
          max: normalizedTotalRounds,
          defaultValue: `Enter a whole round between 1 and ${normalizedTotalRounds}`,
        }),
      );
      return;
    }
    if (!selectedBranch || !canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const data = await resumeFromRound(scenarioId, {
        source_branch_id: selectedBranch,
        round_number: selectedRound,
      });
      setResult(data.branch_id);
      onCreated?.(data.branch_id);
      redirectTimerRef.current = window.setTimeout(() => {
        navigate(`/sim/${scenarioId}`);
      }, 500);
    } catch (err) {
      const fallback = t('resume.error_generic', 'Failed to resume simulation');
      const rawMessage = isApiError(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : fallback;
      const msg = rawMessage.replace(/^API \d+\s+[A-Z_]+:\s*/i, '') || fallback;
      if (
        (isApiError(err) && err.status === 429)
        || msg.includes('429')
        || msg.toLowerCase().includes('limit')
      ) {
        setError(t('resume.limit_reached', 'Maximum 3 replay branches per scenario'));
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, isRoundValid, navigate, normalizedTotalRounds, onCreated, scenarioId, selectedBranch, selectedRound, t]);

  return (
    <div className="result-resume">
      <h3 className="result-resume__heading">
        {t('resume.title', 'Resume Simulation')}
      </h3>
      <p className="result-resume__intro">
        {t('resume.intro', 'Pick a branch and checkpoint to create a new timeline branch that continues from that point.')}
      </p>

      <div className="result-resume__form">
        <div className="result-resume__field">
          <label htmlFor="resume-branch" className="result-resume__label">
            {t('resume.branch', 'Branch')}
          </label>
          <select
            id="resume-branch"
            value={selectedBranch}
            onChange={e => {
              setSelectedBranch(e.target.value);
              setSelectedCheckpointId('');
              setError(null);
            }}
            disabled={isLocked}
            className="result-resume__select"
          >
            <option value="">{t('resume.select_branch', '-- Select --')}</option>
            {branches.map(b => (
              <option key={b.id} value={b.id}>{b.title || b.id}</option>
            ))}
          </select>
        </div>

        <div className="result-resume__field">
          {hasCheckpoints ? (
            <>
              <label htmlFor="resume-checkpoint" className="result-resume__label">
                {t('resume.checkpoint_label', 'Resume from checkpoint')}
              </label>
              <select
                id="resume-checkpoint"
                value={selectedCheckpointId}
                onChange={e => {
                  const next = e.target.value;
                  setSelectedCheckpointId(next);
                  setError(null);
                  const picked = checkpoints.find((cp) => cp.id === next);
                  if (picked) {
                    setSelectedRoundInput(String(picked.round_number));
                  }
                }}
                disabled={isLocked || !selectedBranch}
                aria-invalid={visibleError ? 'true' : undefined}
                className="result-resume__select"
              >
                <option value="">
                  {!selectedBranch
                    ? t('resume.select_branch_first', 'Select a branch first')
                    : t('resume.checkpoint_select', 'Select checkpoint')}
                </option>
                {checkpoints.map((cp) => {
                  const branch = branches.find((b) => b.id === cp.branch_id);
                  return (
                    <option key={cp.id} value={cp.id}>
                      {formatCheckpointOptionLabel(cp, branch?.title ?? '', t)}
                    </option>
                  );
                })}
              </select>
              {selectedCheckpoint && (
                <p className="result-resume__hint" data-testid="resume-resolved-round">
                  {t('resume.round_label', {
                    round: selectedCheckpoint.round_number,
                    defaultValue: `Round ${selectedCheckpoint.round_number}`,
                  })}
                </p>
              )}
              {!selectedBranch && (
                <p className="result-resume__hint">
                  {t('resume.select_branch_hint', 'Please select a branch to see available checkpoints')}
                </p>
              )}
              {selectedBranch && checkpointPickRequired && (
                <p className="result-resume__hint">
                  {t('resume.checkpoint_select', 'Select checkpoint')}
                </p>
              )}
            </>
          ) : (
            <>
              <label htmlFor="resume-round" className="result-resume__label">
                {t('resume.round', 'Round')}
              </label>
              <input
                id="resume-round"
                type="number"
                min={1}
                max={normalizedTotalRounds}
                step={1}
                inputMode="numeric"
                value={selectedRoundInput}
                onChange={e => {
                  setSelectedRoundInput(e.target.value);
                  setError(null);
                }}
                disabled={isLocked}
                aria-invalid={visibleError ? 'true' : undefined}
                className="result-resume__input"
              />
              {replayEnabled && (
                <p className="result-resume__hint">
                  {t('resume.no_checkpoints', 'No checkpoints available')}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {selectedCheckpoint && (() => {
        const readable = formatCheckpointSummary(selectedCheckpoint.compressed_summary, t);
        if (!readable) return null;
        return (
          <div className="result-resume__summary">
            <p className="result-resume__summary-label">
              {t('resume.summary_preview', 'Summary')}
            </p>
            <p className="result-resume__summary-body">{readable}</p>
          </div>
        );
      })()}

      {visibleError && <p role="alert" className="result-resume__feedback result-resume__feedback--error">{visibleError}</p>}
      {result && (
        <p className="result-resume__feedback result-resume__feedback--success">
          {t('resume.created', 'Resume branch created!')}
        </p>
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit}
        className="result-resume__submit"
      >
        {submitting ? t('common.submitting', 'Submitting...') : t('resume.submit', 'Resume')}
      </button>
    </div>
  );
}
