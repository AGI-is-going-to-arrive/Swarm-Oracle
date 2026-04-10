import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { intervene } from '../api/client';
import { dispatchVizEvent } from '../game';
import { getApiErrorCode, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import {
  applyCardUsage,
  canUseCard,
  getCardCooldownRemaining,
  loadScenarioMeta,
  type ScenarioMeta,
} from '../lib/scenarioMeta';
import { applyScenarioGameplayState } from '../lib/scenarioGameplayState';
import type { AgentInfo, BranchInfo, ScenarioGameplayState } from '../types';
import { GAMEPLAY_PANEL_ASSET } from '../lib/themeRegistry';
import {
  buildAgentsById,
  buildGameplayAutoDirective,
  buildGameplayCardPrompt,
  getDefaultGameplayTargetBranch,
  getGameplayCardDefinition,
  getGameplayBadgeSrc,
  getGameplayCardLabel,
  getGameplayCardDirectivePreview,
  getGameplayProfileDescription,
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileTacticalState,
  getGameplayProfileSignatureHooks,
  getScenarioSystemTrackState,
  getGameplaySignatureArcState,
  getRecommendedGameplayCards,
  getSuggestedGameplayAgents,
  getSuggestedSourceBranchId,
  inferGameplayProfile,
  isCounterplayCard,
  type GameplayCardId,
} from './gameplayCards';
import { CONTRACT_GAMEPLAY_CARD_DEFS } from '../lib/gameplayContract';
import './InterventionModal.css';
import './GameplayCardsModal.css';

interface Props {
  scenarioId: string;
  initialMeta?: ScenarioMeta | null;
  branches: BranchInfo[];
  agents: AgentInfo[];
  question: string;
  sceneTheme?: string | null;
  currentRound?: number;
  readOnly?: boolean;
  disabledReason?: string | null;
  onApplied?: (
    nextMeta: ScenarioMeta,
    persistedGameplayState?: ScenarioGameplayState | null,
  ) => void | Promise<void>;
  onClose: () => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export default function GameplayCardsModal({
  scenarioId,
  initialMeta = null,
  branches,
  agents,
  question,
  sceneTheme,
  currentRound = 1,
  readOnly = false,
  disabledReason = null,
  onApplied,
  onClose,
  onAutomationStateChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const gameplayProfile = useMemo(
    () => inferGameplayProfile(question, sceneTheme),
    [question, sceneTheme],
  );
  const [meta, setMeta] = useState<ScenarioMeta>(() => initialMeta ?? loadScenarioMeta(scenarioId));
  const recommendedCards = useMemo(
    () => getRecommendedGameplayCards(gameplayProfile.id, meta.cards.usageLog, meta.commitment),
    [gameplayProfile.id, meta.cards.usageLog, meta.commitment],
  );
  const defaultCardId = useMemo(
    () => (CONTRACT_GAMEPLAY_CARD_DEFS[0]?.id ?? 'civilization_debate') as GameplayCardId,
    [],
  );
  const profileSignatureHooks = useMemo(
    () => getGameplayProfileSignatureHooks(gameplayProfile.id, isZh),
    [gameplayProfile.id, isZh],
  );
  const signatureArcState = useMemo(
    () => getGameplaySignatureArcState(gameplayProfile.id, meta.cards.usageLog, isZh),
    [gameplayProfile.id, isZh, meta.cards.usageLog],
  );
  const systemTracks = useMemo(
    () => getScenarioSystemTrackState(gameplayProfile.id, meta.cards.usageLog, meta.commitment, isZh),
    [gameplayProfile.id, isZh, meta.cards.usageLog, meta.commitment],
  );
  const tacticalState = useMemo(
    () => getGameplayProfileTacticalState(gameplayProfile.id, meta.cards.usageLog, meta.commitment, isZh),
    [gameplayProfile.id, isZh, meta.cards.usageLog, meta.commitment],
  );
  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.status === 'ACTIVE'),
    [branches],
  );
  const defaultTargetBranchId = useMemo(
    () => {
      const committedActiveBranch = meta.commitment.active
        ? activeBranches.find((branch) => branch.id === meta.commitment.branchId)
        : null;
      return committedActiveBranch?.id ?? getDefaultGameplayTargetBranch(activeBranches);
    },
    [activeBranches, meta.commitment.active, meta.commitment.branchId],
  );
  const [cardId, setCardId] = useState<GameplayCardId>(recommendedCards[0] ?? defaultCardId);
  const [targetBranchIdOverride, setTargetBranchIdOverride] = useState<string | null>(defaultTargetBranchId);
  const suggestedAgents = useMemo(
    () => getSuggestedGameplayAgents(recommendedCards[0] ?? defaultCardId, agents, gameplayProfile.id),
    [agents, defaultCardId, gameplayProfile.id, recommendedCards],
  );
  const [primaryAgentIdOverride, setPrimaryAgentIdOverride] = useState<string | null>(suggestedAgents.primaryAgentId);
  const [secondaryAgentIdOverride, setSecondaryAgentIdOverride] = useState<string | null>(
    suggestedAgents.secondaryAgentId ?? agents[1]?.id ?? agents[0]?.id ?? '',
  );
  const [sourceBranchIdOverride, setSourceBranchIdOverride] = useState<string | null>(
    getSuggestedSourceBranchId(branches, defaultTargetBranchId, gameplayProfile.id),
  );
  const [customDirectiveOverride, setCustomDirectiveOverride] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [queueNotice, setQueueNotice] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const normalizedCurrentRound = Math.max(1, currentRound);

  const agentsById = useMemo(() => buildAgentsById(agents), [agents]);
  const autoDirective = useMemo(
    () => buildGameplayAutoDirective({
      cardId,
      question,
      sceneTheme,
      profileId: gameplayProfile.id,
      isZh,
    }),
    [cardId, gameplayProfile.id, isZh, question, sceneTheme],
  );
  const targetBranchId = useMemo(
    () => (
      targetBranchIdOverride && activeBranches.some((branch) => branch.id === targetBranchIdOverride)
        ? targetBranchIdOverride
        : defaultTargetBranchId
    ),
    [activeBranches, defaultTargetBranchId, targetBranchIdOverride],
  );
  const agentSuggestion = useMemo(
    () => getSuggestedGameplayAgents(cardId, agents, gameplayProfile.id),
    [agents, cardId, gameplayProfile.id],
  );
  const primaryAgentId = useMemo(
    () => (
      primaryAgentIdOverride && agents.some((agent) => agent.id === primaryAgentIdOverride)
        ? primaryAgentIdOverride
        : agentSuggestion.primaryAgentId
    ),
    [agentSuggestion.primaryAgentId, agents, primaryAgentIdOverride],
  );
  const secondaryAgentId = useMemo(() => {
    const fallbackAgentId =
      agentSuggestion.secondaryAgentId
      ?? agents[1]?.id
      ?? agents.find((agent) => agent.id !== primaryAgentId)?.id
      ?? agents[0]?.id
      ?? '';
    return secondaryAgentIdOverride && agents.some((agent) => agent.id === secondaryAgentIdOverride)
      ? secondaryAgentIdOverride
      : fallbackAgentId;
  }, [agentSuggestion.secondaryAgentId, agents, primaryAgentId, secondaryAgentIdOverride]);
  const suggestedSourceBranchId = useMemo(
    () => getSuggestedSourceBranchId(branches, targetBranchId, gameplayProfile.id),
    [branches, gameplayProfile.id, targetBranchId],
  );
  const sourceBranchId = useMemo(
    () => (
      sourceBranchIdOverride
      && branches.some((branch) => branch.id === sourceBranchIdOverride && branch.id !== targetBranchId)
        ? sourceBranchIdOverride
        : suggestedSourceBranchId
    ),
    [branches, sourceBranchIdOverride, suggestedSourceBranchId, targetBranchId],
  );
  const customDirective = customDirectiveOverride ?? autoDirective;
  const targetBranch = activeBranches.find((branch) => branch.id === targetBranchId) ?? activeBranches[0] ?? null;
  const sourceBranch = branches.find((branch) => branch.id === sourceBranchId) ?? null;
  const cardDef = getGameplayCardDefinition(cardId);
  const profileFrameSrc = getGameplayProfileFrameSrc(gameplayProfile.id);
  const cardAvailability = canUseCard(meta, cardId, normalizedCurrentRound);
  const cardCooldownRemaining = getCardCooldownRemaining(meta, cardId, normalizedCurrentRound);
  const selectedCardLabel = isZh ? cardDef.labelZh : cardDef.labelEn;
  const waitingBranchLabel = t('gameplay.waiting_branches');
  const waitingAgentLabel = t('gameplay.waiting_agents');
  const waitingSourceLabel = t('gameplay.waiting_source_branch');
  const directiveModeLabel = customDirectiveOverride
    ? t('gameplay.directive_manual')
    : t('gameplay.directive_auto');
  const submittingLabel = t('gameplay.submitting');
  const readOnlyLabel = t('gameplay.preview_only_cta');
  const signatureArcProgressText = signatureArcState.completed
    ? t('gameplay.signature_arc_completed', {
      current: signatureArcState.totalSteps,
      total: signatureArcState.totalSteps,
    })
    : t('gameplay.signature_arc_progress', {
      current: signatureArcState.completedSteps,
      total: signatureArcState.totalSteps,
      next: signatureArcState.nextCardId
        ? getGameplayCardLabel(signatureArcState.nextCardId, isZh)
        : t('gameplay.signature_arc_free_pivot'),
    });
  const systemTrackSummary = isZh
    ? `${systemTracks.riskLabel} ${systemTracks.riskValue}/6；${systemTracks.resourceLabel} ${systemTracks.resourceValue}/6`
    : `${systemTracks.riskLabel} ${systemTracks.riskValue}/6; ${systemTracks.resourceLabel} ${systemTracks.resourceValue}/6`;
  const directorPointsLabel = t('gameplay.director_points');
  const pressureLabel = t('gameplay.pressure_label');
  const commitmentLabel = t('gameplay.committed_branch_label');
  const tacticalLabel = t('gameplay.play_pattern_label');
  const previewStatusLabel = t('gameplay.preview_only_note');
  const availabilityLabel = readOnly
    ? previewStatusLabel
    : !cardAvailability.ok
      ? (
        cardAvailability.reason === 'points'
          ? t('gameplay.error_points')
          : t('gameplay.error_cooldown', { count: cardCooldownRemaining })
      )
      : t('gameplay.ready_note');

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setMeta(initialMeta ?? loadScenarioMeta(scenarioId));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [initialMeta, scenarioId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCardId((current) => recommendedCards.includes(current) ? current : (recommendedCards[0] ?? defaultCardId));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [defaultCardId, recommendedCards]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setPrimaryAgentIdOverride(null);
      setSecondaryAgentIdOverride(null);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [agents, cardId, gameplayProfile.id]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCustomDirectiveOverride(null);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [autoDirective]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      onAutomationStateChange?.(null);
    };
  }, [onAutomationStateChange]);

  useEffect(() => {
    onAutomationStateChange?.({
      kind: 'gameplay_cards',
      card_id: cardId,
      target_branch_id: targetBranchId,
      primary_agent_id: primaryAgentId || null,
      secondary_agent_id: secondaryAgentId || null,
      source_branch_id: sourceBranchId || null,
      custom_length: customDirective.length,
      profile_id: gameplayProfile.id,
      director_points_remaining: meta.director.remainingPoints,
      cooldown_remaining: cardCooldownRemaining,
      current_round: normalizedCurrentRound,
      recommended_cards: recommendedCards,
      commitment_branch_id: meta.commitment.branchId ?? null,
      commitment_active: meta.commitment.active,
      signature_arc: {
        label: signatureArcState.label,
        completed_steps: signatureArcState.completedSteps,
        total_steps: signatureArcState.totalSteps,
        next_card_id: signatureArcState.nextCardId,
        risk_value: systemTracks.riskValue,
        resource_value: systemTracks.resourceValue,
      },
      status,
      read_only: readOnly,
      error: errorMsg || null,
      tactical_mode: tacticalState.mode,
      tactical_note: tacticalState.note,
    });
  }, [
    cardId,
    customDirective.length,
    errorMsg,
    gameplayProfile.id,
    cardCooldownRemaining,
    meta.director.remainingPoints,
    normalizedCurrentRound,
    onAutomationStateChange,
    primaryAgentId,
    readOnly,
    recommendedCards,
    secondaryAgentId,
    signatureArcState.completedSteps,
    signatureArcState.label,
    signatureArcState.nextCardId,
    signatureArcState.totalSteps,
    sourceBranchId,
    status,
    systemTracks.resourceValue,
    systemTracks.riskValue,
    tacticalState.mode,
    tacticalState.note,
    targetBranchId,
  ]);

  const handleClose = useCallback(() => {
    if (status === 'submitting') return;
    onClose();
  }, [onClose, status]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClose]);

  const requiresPrimaryAgent = cardDef.requiresPrimaryAgent;
  const requiresSecondAgent = cardDef.requiresSecondaryAgent;
  const requiresSourceBranch = cardDef.requiresSourceBranch;
  const isDisabled = readOnly || status === 'submitting' || status === 'success';
  const placeholder = isZh ? cardDef.placeholderZh : cardDef.placeholderEn;

  const handleSubmit = async () => {
    if (!targetBranch) {
      setErrorMsg(isZh ? '当前没有可干预的活跃分支。' : 'No active branch is available for intervention.');
      return;
    }
    if (readOnly) {
      setErrorMsg(disabledReason ?? previewStatusLabel);
      return;
    }

    if (requiresPrimaryAgent && !primaryAgentId) {
      setErrorMsg(isZh ? '请选择目标角色。' : 'Select a target agent.');
      return;
    }

    if (requiresSecondAgent && (!secondaryAgentId || primaryAgentId === secondaryAgentId)) {
      setErrorMsg(
        cardId === 'backchannel_pact'
          ? (isZh ? '密约交易需要两名不同角色。' : 'Backchannel Pact needs two different agents.')
          : (isZh ? '文明辩论需要两名不同角色。' : 'Civilization Debate needs two different agents.'),
      );
      return;
    }

    if (requiresSourceBranch && (!sourceBranch || sourceBranch.id === targetBranch.id)) {
      setErrorMsg(t('gameplay.error_source_branch'));
      return;
    }

    if (!cardAvailability.ok) {
      setErrorMsg(
        cardAvailability.reason === 'points'
          ? t('gameplay.error_points')
          : t('gameplay.error_cooldown', { count: cardCooldownRemaining }),
      );
      return;
    }

    setStatus('submitting');
    setErrorMsg('');
    setQueueNotice('');

    const prompt = buildGameplayCardPrompt({
      cardId,
      question,
      sceneTheme,
      profileId: gameplayProfile.id,
      targetBranchTitle: targetBranch.title,
      sourceBranchTitle: sourceBranch?.title,
      agentsById,
      primaryAgentId,
      secondaryAgentId,
      customDirective,
      signatureArcLabel: signatureArcState.label,
      signatureArcProgress: signatureArcProgressText,
      systemTrackSummary,
      profileDoctrine: tacticalState.note,
      isZh,
    });

    try {
      const response = await intervene(scenarioId, {
        branch_id: targetBranch.id,
        text: prompt,
        card_id: cardId,
        profile_id: gameplayProfile.id,
        directive: customDirective,
      });

      dispatchVizEvent('viz:event_anim', {
        animation: cardDef.animation,
        card_name: cardDef.labelEn,
        card_name_zh: cardDef.labelZh,
      });

      const nextMeta = response.gameplay_state
        ? applyScenarioGameplayState(scenarioId, response.gameplay_state)
        : applyCardUsage(scenarioId, {
            cardId,
            profileId: gameplayProfile.id,
            branchId: targetBranch.id,
            branchTitle: targetBranch.title,
            round: normalizedCurrentRound,
            directive: customDirective,
            usedAt: new Date().toISOString(),
          });
      setMeta(nextMeta);
      if ((response.queued_ahead ?? 0) > 0) {
        setQueueNotice(
          t('intervention.queue_note_delayed', { count: response.queued_ahead }),
        );
      } else {
        setQueueNotice(t('intervention.queue_note_next'));
      }
      await onApplied?.(nextMeta, response.gameplay_state ?? null);

      setStatus('success');
      closeTimerRef.current = setTimeout(() => onClose(), 1800);
    } catch (error) {
      setStatus('error');
      const errorCode = getApiErrorCode(error);
      if (errorCode === 'GAMEPLAY_CARD_POINTS_EXHAUSTED') {
        setErrorMsg(t('gameplay.error_points'));
      } else if (errorCode === 'GAMEPLAY_CARD_ON_COOLDOWN') {
        setErrorMsg(t('gameplay.error_cooldown', { count: Math.max(cardCooldownRemaining, 1) }));
      } else if (errorCode === 'GAMEPLAY_CARD_MIN_ROUND') {
        setErrorMsg(t('gameplay.error_min_round', { round: cardDef.minRound }));
      } else {
        setErrorMsg(getLocalizedApiErrorMessage(error, t, t('intervention.error')));
      }
    }
  };

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && handleClose()}>
      <div className="modal-content gameplay-modal">
        <header className="modal-header">
          <img
            className="gameplay-modal__art"
            src={GAMEPLAY_PANEL_ASSET}
            alt={isZh ? '玩法策略徽记' : 'Gameplay tactics crest'}
          />
          <h2>{t('gameplay.title')}</h2>
          <p className="modal-subtitle">{t('gameplay.subtitle')}</p>
          <p className="gameplay-modal__profile">
            {isZh ? '当前玩法画像' : 'Scenario profile'}:
            <strong>{getGameplayProfileLabel(gameplayProfile.id, isZh)}</strong>
            {' · '}
            {getGameplayProfileDescription(gameplayProfile.id, isZh)}
          </p>
          <div className="gameplay-modal__hooks" aria-label={isZh ? '题材钩子' : 'Scenario hooks'}>
            {profileSignatureHooks.map((hook) => (
              <span key={hook} className="gameplay-modal__hook">{hook}</span>
            ))}
          </div>
          <div className="gameplay-modal__stats" aria-label={isZh ? '导演状态' : 'Director state'}>
            <div className="gameplay-modal__stat">
              <span>{directorPointsLabel}</span>
              <strong>{meta.director.remainingPoints}/{meta.director.maxPoints}</strong>
            </div>
            <div className="gameplay-modal__stat">
              <span>{systemTracks.riskLabel}</span>
              <strong>{systemTracks.riskValue}/6</strong>
            </div>
            <div className="gameplay-modal__stat">
              <span>{systemTracks.resourceLabel}</span>
              <strong>{systemTracks.resourceValue}/6</strong>
            </div>
            <div className="gameplay-modal__stat">
              <span>{pressureLabel}</span>
              <strong>{systemTracks.pressure}</strong>
            </div>
          </div>
          <div className="gameplay-modal__preview-stack">
            <section className="gameplay-modal__preview-note">
              <strong>{isZh ? '题材连锁事件' : 'Signature arc'}</strong>
              <span>{signatureArcState.sequenceLabels.join(' → ')}</span>
              <span>{signatureArcProgressText}</span>
            </section>
            <section className="gameplay-modal__preview-note gameplay-modal__preview-note--secondary">
              <strong>{tacticalLabel}</strong>
              <span>{tacticalState.label}</span>
              <span>{tacticalState.note}</span>
              <span>
                {commitmentLabel}
                {': '}
                <strong>{meta.commitment.branchTitle ?? '—'}</strong>
              </span>
            </section>
          </div>
          <div className={`gameplay-modal__availability ${cardAvailability.ok && !readOnly ? 'gameplay-modal__availability--ready' : ''}`}>
            <strong>{isZh ? '当前卡牌状态' : 'Card status'}</strong>
            <span>{availabilityLabel}</span>
          </div>
          {readOnly && (
            <p className="gameplay-modal__preview-note">
              {disabledReason ?? previewStatusLabel}
            </p>
          )}
        </header>

        <div className="modal-body gameplay-modal__body">
          <div className="gameplay-card-grid">
            {CONTRACT_GAMEPLAY_CARD_DEFS.map((card) => {
              const nextCardId = signatureArcState.nextCardId as GameplayCardId | null;
              const currentCardId = card.id as GameplayCardId;
              const selected = currentCardId === cardId;
              const recommended = currentCardId === nextCardId
                || recommendedCards.slice(0, 3).includes(currentCardId);
              return (
                <button
                  key={currentCardId}
                  className={`gameplay-card gameplay-card--profile-${gameplayProfile.id} ${selected ? 'gameplay-card--active' : 'gameplay-card--inactive'}`}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCardId(currentCardId)}
                  disabled={isDisabled}
                >
                  <img
                    className="gameplay-card__frame"
                    src={profileFrameSrc}
                    alt=""
                    aria-hidden="true"
                  />
                  <span className="gameplay-card__content">
                    <span className="gameplay-card__head">
                      <span className="gameplay-card__icon">{card.icon}</span>
                      <span className="gameplay-card__label">{isZh ? card.labelZh : card.labelEn}</span>
                      <span className="gameplay-card__badge-stack">
                        {recommended && (
                          <span className="gameplay-card__badge gameplay-card__badge--recommended">
                            <img src={getGameplayBadgeSrc('recommended')} alt="" aria-hidden="true" />
                            <span>
                              {currentCardId === nextCardId
                                ? (isZh ? '下一步' : 'Next')
                                : (isZh ? '推荐' : 'Recommended')}
                            </span>
                          </span>
                        )}
                        {isCounterplayCard(currentCardId) && (
                          <span className="gameplay-card__badge gameplay-card__badge--counter">
                            <span>{isZh ? '反制' : 'Counter'}</span>
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="gameplay-card__desc">
                      {isZh ? card.descriptionZh : card.descriptionEn}
                    </span>
                    <span className="gameplay-card__flavor">
                      {getGameplayCardDirectivePreview(gameplayProfile.id, currentCardId, isZh)}
                    </span>
                    <span className="gameplay-card__meta">
                      {isZh ? '消耗 1 点' : 'Cost 1'}
                      {getCardCooldownRemaining(meta, currentCardId, normalizedCurrentRound) > 0 && (
                        <>
                          {' · '}
                          {isZh
                            ? `冷却 ${getCardCooldownRemaining(meta, currentCardId, normalizedCurrentRound)} 轮`
                            : `CD ${getCardCooldownRemaining(meta, currentCardId, normalizedCurrentRound)} rounds`}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <section className="gameplay-modal__selection" aria-live="polite">
            <div className="gameplay-modal__selection-head">
              <div className="gameplay-modal__selection-copy">
                <span className="gameplay-modal__selection-kicker">
                  {isZh ? '当前卡牌' : 'Selected card'}
                </span>
                <strong>{selectedCardLabel}</strong>
              </div>
              <span
                className={`gameplay-modal__selection-state ${cardAvailability.ok && !readOnly ? 'gameplay-modal__selection-state--ready' : ''}`}
              >
                {readOnly ? readOnlyLabel : availabilityLabel}
              </span>
            </div>
            <div className="gameplay-modal__selection-grid">
              <div className="gameplay-modal__selection-item">
                <span>{t('gameplay.target_branch')}</span>
                <strong>{targetBranch?.title ?? waitingBranchLabel}</strong>
              </div>
              <div className="gameplay-modal__selection-item">
                <span>{directorPointsLabel}</span>
                <strong>{meta.director.remainingPoints}/{meta.director.maxPoints}</strong>
              </div>
              {requiresPrimaryAgent && (
                <div className="gameplay-modal__selection-item">
                  <span>{t('gameplay.primary_agent')}</span>
                  <strong>{primaryAgentId ? (agentsById[primaryAgentId]?.name ?? waitingAgentLabel) : waitingAgentLabel}</strong>
                </div>
              )}
              {requiresSecondAgent && (
                <div className="gameplay-modal__selection-item">
                  <span>{t('gameplay.secondary_agent')}</span>
                  <strong>{secondaryAgentId ? (agentsById[secondaryAgentId]?.name ?? waitingAgentLabel) : waitingAgentLabel}</strong>
                </div>
              )}
              {requiresSourceBranch && (
                <div className="gameplay-modal__selection-item">
                <span>{t('gameplay.source_branch')}</span>
                <strong>{sourceBranch?.title ?? waitingSourceLabel}</strong>
              </div>
            )}
            <div className="gameplay-modal__selection-item">
              <span>{isZh ? '导向提示' : 'Directive mode'}</span>
              <strong>{directiveModeLabel}</strong>
            </div>
          </div>
          </section>

          <div className="modal-field gameplay-modal__field">
            <label>{t('gameplay.target_branch')}</label>
            <select
              className="gameplay-select"
              value={targetBranchId ?? ''}
              onChange={(event) => setTargetBranchIdOverride(event.target.value)}
              disabled={isDisabled}
            >
              {activeBranches.length > 0 ? (
                activeBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.title}
                  </option>
                ))
              ) : (
                <option value="">{waitingBranchLabel}</option>
              )}
            </select>
          </div>

          {requiresPrimaryAgent && (
            <div className="modal-field gameplay-modal__field">
              <label>{t('gameplay.primary_agent')}</label>
              <select
                className="gameplay-select"
                value={primaryAgentId}
                onChange={(event) => setPrimaryAgentIdOverride(event.target.value)}
                disabled={isDisabled}
              >
                {agents.length > 0 ? (
                agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))
              ) : (
                <option value="">{waitingAgentLabel}</option>
              )}
            </select>
          </div>
          )}

          {requiresSecondAgent && (
            <div className="modal-field gameplay-modal__field">
              <label>{t('gameplay.secondary_agent')}</label>
              <select
                className="gameplay-select"
                value={secondaryAgentId}
                onChange={(event) => setSecondaryAgentIdOverride(event.target.value)}
                disabled={isDisabled}
              >
                {agents.length > 0 ? (
                agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))
              ) : (
                <option value="">{waitingAgentLabel}</option>
              )}
            </select>
          </div>
          )}

          {requiresSourceBranch && (
            <div className="modal-field gameplay-modal__field">
              <label>{t('gameplay.source_branch')}</label>
              <select
                className="gameplay-select"
                value={sourceBranchId}
                onChange={(event) => setSourceBranchIdOverride(event.target.value)}
                disabled={isDisabled}
              >
                {branches.filter((branch) => branch.id !== targetBranchId).length > 0 ? (
                  branches
                    .filter((branch) => branch.id !== targetBranchId)
                    .map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.title}
                      </option>
                    ))
                ) : (
                  <option value="">{waitingSourceLabel}</option>
                )}
              </select>
            </div>
          )}

          <textarea
            ref={inputRef}
            className="intervention-input gameplay-modal__textarea"
            aria-label={isZh ? '玩法卡指令' : 'Gameplay card directive'}
            placeholder={placeholder}
            value={customDirective}
            onChange={(event) => setCustomDirectiveOverride(event.target.value)}
            disabled={isDisabled}
            rows={4}
          />

          <p className="template-hint gameplay-modal__hint">
            {t('gameplay.hint')}
          </p>

          <div className="gameplay-modal__status" aria-live="polite">
            {errorMsg && <p className="modal-error">{errorMsg}</p>}
            {status === 'success' && (
              <>
                <p className="modal-success">
                  {t('gameplay.success')}
                </p>
                {queueNotice && (
                  <p className="template-hint gameplay-modal__hint">{queueNotice}</p>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="modal-footer">
          <button className="btn btn-ghost" onClick={handleClose} disabled={status === 'submitting'}>
            {t('intervention.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={isDisabled}>
            {status === 'submitting'
              ? submittingLabel
              : readOnly
                ? readOnlyLabel
                : t('gameplay.apply')}
          </button>
        </footer>
      </div>
    </div>
  );
}
