/* ═══════════════════════════════════════════════════════════
   SwarmOracle — PredictionModal (P5-B)
   ═══════════════════════════════════════════════════════════ */

import { useState, useRef, useEffect, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { submitPrediction } from '../api/client';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { createCompatUuid } from '../lib/compatUuid';
import { getDirectorIdentity, updateDirectorName } from '../lib/directorIdentity';
import {
  buildStructuredPredictionText,
  ENDING_TONE_OPTIONS,
  PROFILE_RESONANCE_OPTIONS,
  getEndingToneLabel,
  getStructuredBetKindLabel,
  getStructuredBetOptions,
  type EndingToneId,
  type ProfileResonanceId,
  type StructuredBetKind,
} from '../lib/predictionBetting';
import { placeBet, type ScenarioMeta } from '../lib/scenarioMeta';
import type { BranchInfo } from '../types';
import './PredictionModal.css';

function useScrollFade(ref: React.RefObject<HTMLDivElement | null>) {
  const [top, setTop] = useState(false);
  const [bottom, setBottom] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      setTop(el.scrollTop > 4);
      setBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
    };
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    if (!ro) {
      window.addEventListener('resize', check);
    }
    return () => {
      el.removeEventListener('scroll', check);
      ro?.disconnect();
      if (!ro) {
        window.removeEventListener('resize', check);
      }
    };
  }, [ref]);
  return { top, bottom };
}

const PREDICTION_TEXT_LIMIT = 500;

interface Props {
  scenarioId: string;
  initialMeta?: ScenarioMeta | null;
  onClose: () => void;
  branches?: BranchInfo[];
  question?: string;
  sceneTheme?: string | null;
  currentRound?: number;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
  onPlacedBet?: (nextMeta: ScenarioMeta) => void | Promise<void>;
}

export default function PredictionModal({
  scenarioId,
  initialMeta = null,
  onClose,
  branches = [],
  question,
  sceneTheme,
  currentRound = 1,
  onAutomationStateChange,
  onPlacedBet,
}: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();
  const [text, setText] = useState('');
  const [betKind, setBetKind] = useState<StructuredBetKind>('branch_winner');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const branchOptions = getStructuredBetOptions(branches);
  const committedBranchId = initialMeta?.commitment.branchId ?? '';
  const defaultTargetBranchId =
    branchOptions.some((branch) => branch.id === committedBranchId)
      ? committedBranchId
      : branchOptions[0]?.id ?? '';
  const [targetBranchIdOverride, setTargetBranchIdOverride] = useState<string | null>(null);
  const [endingTone, setEndingTone] = useState<EndingToneId>('order');
  const [profileResonance, setProfileResonance] = useState<ProfileResonanceId>('aligned');
  const [confidence, setConfidence] = useState(0.5);
  const [userName, setUserName] = useState(directorIdentity.userName);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submittedPredictionRef = useRef<{ pendingMeta: ScenarioMeta } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const advancedSectionId = useId();
  const scrollFade = useScrollFade(bodyRef);
  useFocusTrap(dialogRef, true);
  const shouldAutoFocusText = (() => {
    if (typeof window === 'undefined') return false;
    if (window.innerWidth <= 720) return false;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) {
      return false;
    }
    return true;
  })();

  useEffect(() => {
    if (shouldAutoFocusText) {
      inputRef.current?.focus();
      return;
    }
    closeButtonRef.current?.focus();
  }, [shouldAutoFocusText]);

  // Cleanup auto-close timer on unmount
  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Stable close handler that guards against closing during submission
  const handleClose = useCallback(() => {
    if (status === 'submitting') return; // Don't close while submitting
    onClose();
  }, [status, onClose]);

  // Close on Escape key (only when this dialog is topmost — guarded against background dispatch).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const overlays = document.querySelectorAll<HTMLElement>('[data-modal-overlay="true"]');
      const topmost = overlays[overlays.length - 1];
      if (topmost && topmost !== dialogRef.current?.parentElement) return;
      handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const hasBranchTargets = branchOptions.length > 0;
  const targetBranchId =
    targetBranchIdOverride && branchOptions.some((branch) => branch.id === targetBranchIdOverride)
      ? targetBranchIdOverride
      : defaultTargetBranchId;
  const effectiveBetKind =
    !hasBranchTargets && betKind === 'branch_winner'
      ? 'ending_tone'
      : betKind;

  const confidenceLabel =
    confidence <= 0.3
      ? t('prediction.confidence_low')
      : confidence <= 0.7
        ? t('prediction.confidence_mid')
        : t('prediction.confidence_high');
  const betKindLabel = getStructuredBetKindLabel(effectiveBetKind, t);
  const betTargetLabel =
    effectiveBetKind === 'branch_winner'
      ? (
        branchOptions.find((branch) => branch.id === targetBranchId)?.label
        ?? t('prediction.waiting_worldline')
      )
      : effectiveBetKind === 'ending_tone'
        ? ENDING_TONE_OPTIONS[endingTone][isZh ? 'zh' : 'en']
        : PROFILE_RESONANCE_OPTIONS[profileResonance][isZh ? 'zh' : 'en'];
  const commitmentLabel =
    initialMeta?.commitment.branchTitle
    ?? t('prediction.commitment_empty');
  const oracleLabel = userName.trim() || t('prediction.name_placeholder');
  const isDisabled = status === 'submitting' || status === 'success';
  const effectiveTargetBranchId =
    branchOptions.some((branch) => branch.id === targetBranchId)
      ? targetBranchId
      : defaultTargetBranchId;
  const hasValidBranchTarget = branchOptions.some((branch) => branch.id === effectiveTargetBranchId);
  const structuredTargetId =
    effectiveBetKind === 'branch_winner'
      ? effectiveTargetBranchId
      : effectiveBetKind === 'ending_tone'
        ? endingTone
        : profileResonance;
  const structuredTargetLabel =
    effectiveBetKind === 'branch_winner'
      ? branchOptions.find((branch) => branch.id === effectiveTargetBranchId)?.label ?? effectiveTargetBranchId
      : effectiveBetKind === 'ending_tone'
        ? getEndingToneLabel(endingTone, isZh)
        : PROFILE_RESONANCE_OPTIONS[profileResonance][isZh ? 'zh' : 'en'];
  const predictionPayloadLength = buildStructuredPredictionText({
    kind: effectiveBetKind,
    targetId: structuredTargetId,
    targetLabel: structuredTargetLabel,
    rationale: text,
    confidence,
    userName,
    placedAtRound: currentRound,
    sceneTheme,
    question,
  }).length;
  const payloadWithoutRationale = buildStructuredPredictionText({
    kind: effectiveBetKind,
    targetId: structuredTargetId,
    targetLabel: structuredTargetLabel,
    rationale: '',
    confidence,
    userName,
    placedAtRound: currentRound,
    sceneTheme,
    question,
  });
  const predictionRationaleLimit = Math.max(
    0,
    PREDICTION_TEXT_LIMIT - payloadWithoutRationale.length - 1,
  );
  const isPredictionTooLong = predictionPayloadLength > PREDICTION_TEXT_LIMIT;
  const canSubmit =
    Boolean(text.trim())
    && !isDisabled
    && (effectiveBetKind !== 'branch_winner' || hasValidBranchTarget)
    && !isPredictionTooLong;

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed || status === 'submitting' || status === 'success') return;
    if (effectiveBetKind === 'branch_winner' && !hasValidBranchTarget) {
      setStatus('error');
      setErrorMsg(t('prediction.error_branch_pending'));
      return;
    }

    setStatus('submitting');
    setErrorMsg('');

    const predictionText = buildStructuredPredictionText({
      kind: effectiveBetKind,
      targetId: structuredTargetId,
      targetLabel: structuredTargetLabel,
      rationale: trimmed,
      confidence,
      userName,
      placedAtRound: currentRound,
      sceneTheme,
      question,
    });
    if (predictionText.length > PREDICTION_TEXT_LIMIT) {
      setStatus('error');
      setErrorMsg(t('prediction.error_too_long'));
      return;
    }

    // Step 1: submitPrediction (idempotent retry — skip if already submitted but persist failed).
    let nextMeta: ScenarioMeta;
    if (submittedPredictionRef.current) {
      nextMeta = submittedPredictionRef.current.pendingMeta;
    } else {
      try {
        const trimmedName = userName.trim();
        await submitPrediction(
          scenarioId,
          predictionText,
          confidence,
          trimmedName || undefined,
          directorIdentity.userId,
        );
        if (trimmedName) {
          updateDirectorName(trimmedName);
        }
        // Step 2: local placeBet
        nextMeta = placeBet(scenarioId, {
          betId: createCompatUuid(),
          kind: effectiveBetKind,
          targetId: structuredTargetId,
          targetLabel: structuredTargetLabel,
          confidence,
          userName: userName.trim() || undefined,
          placedAtRound: currentRound,
          placedAt: new Date().toISOString(),
          resolved: false,
        });
        submittedPredictionRef.current = { pendingMeta: nextMeta };
      } catch (err) {
        setStatus('error');
        setErrorMsg(getLocalizedApiErrorMessage(err, t, t('prediction.error')));
        return;
      }
    }

    // Step 3: await gameplay-state persistence — surface specific error, keep modal open.
    try {
      await onPlacedBet?.(nextMeta);
    } catch (err) {
      setStatus('error');
      setErrorMsg(getLocalizedApiErrorMessage(err, t, t('prediction.error_persistence')));
      return;
    }

    submittedPredictionRef.current = null;
    setStatus('success');
    closeTimerRef.current = setTimeout(() => onClose(), 1200);
  };

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'prediction_modal',
      bet_kind: effectiveBetKind,
      target_branch_id: effectiveTargetBranchId || null,
      ending_tone: endingTone,
      profile_resonance: profileResonance,
      text_length: text.length,
      confidence,
      confidence_label: confidenceLabel,
      prediction_text_length: predictionPayloadLength,
      prediction_text_limit: PREDICTION_TEXT_LIMIT,
      rationale_limit: predictionRationaleLimit,
      too_long: isPredictionTooLong,
      user_name_length: userName.length,
      status,
      error: errorMsg || null,
      can_submit: canSubmit,
      submit_disabled: !canSubmit,
    });

    return () => {
      onAutomationStateChange?.(null);
    };
  }, [canSubmit, confidence, confidenceLabel, effectiveBetKind, effectiveTargetBranchId, endingTone, errorMsg, isPredictionTooLong, onAutomationStateChange, predictionPayloadLength, predictionRationaleLimit, profileResonance, status, text, userName.length]);

  const scrollCls = [
    'modal-content prediction-modal',
    scrollFade.top ? 'has-scroll-top' : '',
    scrollFade.bottom ? 'has-scroll-bottom' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className="modal-overlay prediction-modal-overlay"
      data-modal-overlay="true"
      onClick={(e) => e.target === e.currentTarget && handleClose()}
    >
      <div
        ref={dialogRef}
        className={scrollCls}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
      >
        <header className="modal-header">
          <h2 id={titleId}>{t('prediction.title')}</h2>
          <p id={subtitleId} className="modal-subtitle">{t('prediction.subtitle')}</p>
        </header>

        <div className="modal-body" ref={bodyRef}>
          <section className="prediction-summary" aria-label={t('prediction.bet_preview_prefix')}>
            <div className="prediction-summary__head">
              <span className="prediction-summary__kicker">
                {t('prediction.summary_label')}
              </span>
              <strong>{betKindLabel}</strong>
            </div>
            <div className="prediction-summary__grid">
              <div className="prediction-summary__item">
                <span className="prediction-summary__label">{t('prediction.bet_target_label')}</span>
                <strong>{betTargetLabel}</strong>
              </div>
              <div className="prediction-summary__item">
                <span className="prediction-summary__label">{t('game.round_label')}</span>
                <strong>R{currentRound}</strong>
              </div>
              <div className="prediction-summary__item">
                <span className="prediction-summary__label">{t('prediction.oracle_label')}</span>
                <strong>{oracleLabel}</strong>
              </div>
              <div className="prediction-summary__item">
                <span className="prediction-summary__label">{t('sim.director.commitment_label')}</span>
                <strong>{commitmentLabel}</strong>
              </div>
            </div>
            {!hasBranchTargets && effectiveBetKind === 'ending_tone' && (
              <p className="prediction-summary__note">
                {t('prediction.branch_unavailable_note')}
              </p>
            )}
          </section>

          <div className="pred-group-divider" aria-hidden="true">
            <span className="pred-group-divider__label">
              {t('prediction.group_bet_config', { defaultValue: 'Bet Config' })}
            </span>
          </div>

          <div className="pred-field">
            <label className="pred-label" htmlFor="pred-kind">{t('prediction.bet_kind_label')}</label>
            <select
              id="pred-kind"
              className="pred-input"
              value={effectiveBetKind}
              onChange={(e) => setBetKind(e.target.value as StructuredBetKind)}
              disabled={isDisabled}
            >
              <option value="branch_winner">{getStructuredBetKindLabel('branch_winner', t)}</option>
              <option value="ending_tone">{getStructuredBetKindLabel('ending_tone', t)}</option>
              {(advancedOpen || effectiveBetKind === 'profile_resonance') && (
                <option value="profile_resonance">{getStructuredBetKindLabel('profile_resonance', t)}</option>
              )}
            </select>
          </div>

          <div className="pred-advanced">
            <button
              type="button"
              className="pred-advanced__toggle"
              aria-expanded={advancedOpen}
              aria-controls={advancedOpen ? advancedSectionId : undefined}
              onClick={() => setAdvancedOpen((prev) => !prev)}
              disabled={isDisabled}
            >
              <span aria-hidden="true">{advancedOpen ? '▾' : '▸'}</span>
              {' '}
              {advancedOpen
                ? t('prediction.hide_advanced')
                : t('prediction.show_advanced')}
            </button>
            {advancedOpen && (
              <div className="pred-advanced__body" id={advancedSectionId}>
                <p className="pred-advanced__hint">{t('prediction.advanced_section_hint')}</p>
                <p className="pred-advanced__caption">
                  {t('prediction.advanced_section_label')}
                  {' · '}
                  {getStructuredBetKindLabel('profile_resonance', t)}
                </p>
              </div>
            )}
          </div>

          {effectiveBetKind === 'branch_winner' && branchOptions.length > 0 && (
            <div className="pred-field">
              <label className="pred-label" htmlFor="pred-branch">{t('prediction.bet_target_label')}</label>
              <select
                id="pred-branch"
                className="pred-input"
                value={targetBranchId}
                onChange={(e) => setTargetBranchIdOverride(e.target.value)}
                disabled={isDisabled}
              >
                {branchOptions.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.label}</option>
                ))}
              </select>
            </div>
          )}

          {effectiveBetKind === 'ending_tone' && (
            <div className="pred-field">
              <label className="pred-label" htmlFor="pred-tone">{t('prediction.bet_target_label')}</label>
              <select
                id="pred-tone"
                className="pred-input"
                value={endingTone}
              onChange={(e) => setEndingTone(e.target.value as EndingToneId)}
              disabled={isDisabled}
            >
                {Object.entries(ENDING_TONE_OPTIONS).map(([tone, labels]) => (
                  <option key={tone} value={tone}>{labels[isZh ? 'zh' : 'en']}</option>
                ))}
              </select>
            </div>
          )}

          {effectiveBetKind === 'profile_resonance' && (
            <div className="pred-field">
              <label className="pred-label" htmlFor="pred-resonance">{t('prediction.bet_target_label')}</label>
              <select
                id="pred-resonance"
                className="pred-input"
                value={profileResonance}
              onChange={(e) => setProfileResonance(e.target.value as ProfileResonanceId)}
              disabled={isDisabled}
            >
                {Object.entries(PROFILE_RESONANCE_OPTIONS).map(([resonance, labels]) => (
                  <option key={resonance} value={resonance}>{labels[isZh ? 'zh' : 'en']}</option>
                ))}
              </select>
            </div>
          )}

          {/* Prediction Text */}
          <div className="pred-field">
            <label className="pred-label" htmlFor="pred-text">{t('prediction.text_label')}</label>
            <textarea
              id="pred-text"
              ref={inputRef}
              className="pred-textarea"
              placeholder={t('prediction.text_placeholder')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={isDisabled}
              rows={4}
              maxLength={predictionRationaleLimit}
            />
            <div className="prediction-modal__helper-row">
              <span className="pred-char-count">{text.length}/{predictionRationaleLimit}</span>
              <span className="pred-char-count pred-char-count--hint">
                {t('prediction.bet_preview_prefix')}
                {' '}
                {betTargetLabel}
              </span>
            </div>
          </div>

          <div className="pred-group-divider" aria-hidden="true">
            <span className="pred-group-divider__label">
              {t('prediction.group_oracle_info', { defaultValue: 'Oracle Info' })}
            </span>
          </div>

          {/* Confidence Slider */}
          <div className="pred-field">
            <label className="pred-label" htmlFor="pred-confidence">
              {t('prediction.confidence_label')}
              <span className={`pred-confidence-badge${confidence > 0.7 ? ' pred-confidence-badge--high' : confidence <= 0.3 ? ' pred-confidence-badge--low' : ''}`}>{confidenceLabel} — {Math.round(confidence * 100)}%</span>
            </label>
            <input
              id="pred-confidence"
              type="range"
              className="pred-slider"
              min={0}
              max={1}
              step={0.05}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
              disabled={isDisabled}
              aria-label={t('prediction.confidence_label')}
            />
          </div>

          {/* User Name */}
          <div className="pred-field">
            <label className="pred-label" htmlFor="pred-name">{t('prediction.name_label')}</label>
            <input
              id="pred-name"
              type="text"
              className="pred-input"
              placeholder={t('prediction.name_placeholder')}
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              disabled={isDisabled}
              maxLength={30}
            />
          </div>

          <div className="prediction-modal__status" aria-live="polite">
            {errorMsg && <p className="modal-error">{errorMsg}</p>}
            {status === 'success' && <p className="modal-success">{t('prediction.success')}</p>}
          </div>
        </div>

        <footer className="modal-footer">
          <button
            ref={closeButtonRef}
            className="btn btn-ghost"
            onClick={handleClose}
            disabled={status === 'submitting'}
          >
            {t('prediction.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {status === 'submitting'
              ? t('prediction.submitting')
              : t('prediction.submit')}
          </button>
        </footer>
      </div>
    </div>
  );
}
