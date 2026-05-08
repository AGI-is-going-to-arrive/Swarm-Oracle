/* ═══════════════════════════════════════════════════════════
   P1-9 — Resume Panel
   Allows selecting a branch + round to resume simulation.
   ═══════════════════════════════════════════════════════════ */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isApiError, resumeFromRound } from '../api/client';

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
  const [selectedBranch, setSelectedBranch] = useState('');
  const [selectedRoundInput, setSelectedRoundInput] = useState('1');
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
  const canSubmit = Boolean(selectedBranch) && isRoundValid && !isLocked;

  useEffect(() => () => {
    if (redirectTimerRef.current !== null) {
      window.clearTimeout(redirectTimerRef.current);
    }
  }, []);

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
        </div>
      </div>

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
