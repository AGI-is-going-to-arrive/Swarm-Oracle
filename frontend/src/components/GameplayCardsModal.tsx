import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { intervene } from '../api/client';
import { dispatchVizEvent } from '../game';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
  getDefaultGameplayTargetBranch,
  getGameplayCardDefinition,
  getGameplayCardDisplayModel,
  getGameplayCardLabel,
  getGameplayProfileDescription,
  getGameplayProfileLabel,
  getGameplayProfileTacticalState,
  getScenarioSystemTrackState,
  getGameplaySignatureArcState,
  getSuggestedGameplayAgents,
  getSuggestedSourceBranchId,
  inferGameplayProfile,
  isCounterplayCard,
  type GameplayCardGroupId,
  type GameplayCardId,
} from './gameplayCards';
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

const GROUP_ICON_KEYS: Record<GameplayCardGroupId, string> = {
  role_play: 'gameplay.group_role_play_icon',
  worldline_distort: 'gameplay.group_worldline_distort_icon',
  crisis_dispatch: 'gameplay.group_crisis_dispatch_icon',
  counter_cool: 'gameplay.group_counter_cool_icon',
};

const GROUP_TITLE_KEYS: Record<GameplayCardGroupId, string> = {
  role_play: 'gameplay.group_role_play_title',
  worldline_distort: 'gameplay.group_worldline_distort_title',
  crisis_dispatch: 'gameplay.group_crisis_dispatch_title',
  counter_cool: 'gameplay.group_counter_cool_title',
};

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
  const displayModel = useMemo(
    () => getGameplayCardDisplayModel(gameplayProfile.id, {
      usages: meta.cards.usageLog,
      commitment: meta.commitment,
    }),
    [gameplayProfile.id, meta.cards.usageLog, meta.commitment],
  );
  const recommendedCards = displayModel.recommended;
  const defaultCardId = useMemo<GameplayCardId>(
    () => (recommendedCards[0] ?? displayModel.groups.flatMap((group) => group.cardIds)[0] ?? 'civilization_debate'),
    [displayModel.groups, recommendedCards],
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
  const [cardId, setCardId] = useState<GameplayCardId>(defaultCardId);
  const [targetBranchIdOverride, setTargetBranchIdOverride] = useState<string | null>(defaultTargetBranchId);
  const initialSuggestion = useMemo(
    () => getSuggestedGameplayAgents(defaultCardId, agents, gameplayProfile.id),
    [agents, defaultCardId, gameplayProfile.id],
  );
  const [primaryAgentIdOverride, setPrimaryAgentIdOverride] = useState<string | null>(initialSuggestion.primaryAgentId);
  const [secondaryAgentIdOverride, setSecondaryAgentIdOverride] = useState<string | null>(
    initialSuggestion.secondaryAgentId ?? agents[1]?.id ?? agents[0]?.id ?? '',
  );
  const [sourceBranchIdOverride, setSourceBranchIdOverride] = useState<string | null>(
    getSuggestedSourceBranchId(branches, defaultTargetBranchId, gameplayProfile.id),
  );
  const [customDirectiveOverride, setCustomDirectiveOverride] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [queueNotice, setQueueNotice] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Record<GameplayCardGroupId, boolean>>({
    role_play: false,
    worldline_distort: false,
    crisis_dispatch: false,
    counter_cool: false,
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const subtitleId = useId();
  const targetBranchSelectId = useId();
  const primaryAgentSelectId = useId();
  const secondaryAgentSelectId = useId();
  const sourceBranchSelectId = useId();
  useFocusTrap(dialogRef, true);
  const shouldAutoFocusDirective = (() => {
    if (typeof window === 'undefined') return false;
    if (window.innerWidth <= 720) return false;
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(pointer: fine)').matches) {
      return false;
    }
    return true;
  })();
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
  const cardAvailability = canUseCard(meta, cardId, normalizedCurrentRound);
  const cardCooldownRemaining = getCardCooldownRemaining(meta, cardId, normalizedCurrentRound);
  const selectedCardLabel = isZh ? cardDef.labelZh : cardDef.labelEn;
  const waitingBranchLabel = t('gameplay.waiting_branches');
  const waitingAgentLabel = t('gameplay.waiting_agents');
  const waitingSourceLabel = t('gameplay.waiting_source_branch');
  const submittingLabel = t('gameplay.submitting');
  const readOnlyLabel = t('gameplay.preview_only_cta');
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

  const lastAppliedUsage = useMemo(() => {
    const usages = meta.cards.usageLog;
    if (!usages.length) return null;
    return usages
      .filter((usage) => usage.round === normalizedCurrentRound)
      .slice(-1)[0]
      ?? null;
  }, [meta.cards.usageLog, normalizedCurrentRound]);

  const buildCardPreview = useCallback(
    (selectedCardId: GameplayCardId): string => {
      const card = getGameplayCardDefinition(selectedCardId);
      const cardLabel = isZh ? card.labelZh : card.labelEn;
      const suggestion = getSuggestedGameplayAgents(selectedCardId, agents, gameplayProfile.id);
      const primaryName = selectedCardId === cardId
        ? (primaryAgentId ? agentsById[primaryAgentId]?.name : '')
        : (suggestion.primaryAgentId ? agentsById[suggestion.primaryAgentId]?.name : '');
      const secondaryName = selectedCardId === cardId
        ? (secondaryAgentId ? agentsById[secondaryAgentId]?.name : '')
        : (suggestion.secondaryAgentId ? agentsById[suggestion.secondaryAgentId]?.name : '');
      const fallbackPrimary = t('gameplay.card_preview_fallback_primary');
      const fallbackTheme = t('gameplay.card_preview_fallback_theme');
      const namesList = [primaryName, secondaryName].filter((name): name is string => Boolean(name && name.trim()));
      const primaryDisplay = namesList.length > 0 ? namesList.join(isZh ? '、' : ' & ') : fallbackPrimary;
      const themeDisplay = cardLabel || fallbackTheme;
      return t('gameplay.card_preview_template', {
        primary: primaryDisplay,
        theme: themeDisplay,
      });
    },
    [agents, agentsById, cardId, gameplayProfile.id, isZh, primaryAgentId, secondaryAgentId, t],
  );

  const buildWhyNow = useCallback(
    (currentCardId: GameplayCardId): string => {
      if (currentCardId === signatureArcState.nextCardId) {
        return t('gameplay.card_why_now_signature');
      }
      if (recommendedCards.includes(currentCardId)) {
        if (systemTracks.counterplayRecommended && isCounterplayCard(currentCardId)) {
          return t('gameplay.card_why_now_counter');
        }
        return t('gameplay.card_why_now_recommended');
      }
      return t('gameplay.card_why_now_default');
    },
    [recommendedCards, signatureArcState.nextCardId, systemTracks.counterplayRecommended, t],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setMeta(initialMeta ?? loadScenarioMeta(scenarioId));
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [initialMeta, scenarioId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setCardId((current) => {
        const allKnown = [
          ...recommendedCards,
          ...displayModel.groups.flatMap((group) => group.cardIds),
        ];
        return allKnown.includes(current) ? current : (recommendedCards[0] ?? defaultCardId);
      });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [defaultCardId, displayModel.groups, recommendedCards]);

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
    if (shouldAutoFocusDirective) {
      inputRef.current?.focus();
      return;
    }
    closeButtonRef.current?.focus();
  }, [shouldAutoFocusDirective]);

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
    meta.commitment.active,
    meta.commitment.branchId,
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
      if (event.key !== 'Escape') return;
      const overlays = document.querySelectorAll<HTMLElement>('[data-modal-overlay="true"]');
      const topmost = overlays[overlays.length - 1];
      if (topmost && topmost !== dialogRef.current?.parentElement) return;
      handleClose();
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
      setErrorMsg(t('gameplay.error_no_active_branch'));
      return;
    }
    if (readOnly) {
      setErrorMsg(disabledReason ?? previewStatusLabel);
      return;
    }

    if (requiresPrimaryAgent && !primaryAgentId) {
      setErrorMsg(t('gameplay.error_select_target_agent'));
      return;
    }

    if (requiresSecondAgent && (!secondaryAgentId || primaryAgentId === secondaryAgentId)) {
      setErrorMsg(
        cardId === 'backchannel_pact'
          ? t('gameplay.error_two_different_agents_pact')
          : t('gameplay.error_two_different_agents_debate'),
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
    const directiveText = (customDirective.trim() || autoDirective).trim();

    try {
      const response = await intervene(scenarioId, {
        branch_id: targetBranch.id,
        text: directiveText,
        card_id: cardId,
        profile_id: gameplayProfile.id,
        directive: directiveText,
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
            directive: directiveText,
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

  const renderCard = (currentCardId: GameplayCardId, options: { highlighted: boolean }) => {
    const card = getGameplayCardDefinition(currentCardId);
    const selected = currentCardId === cardId;
    const counter = isCounterplayCard(currentCardId);
    const cooldown = getCardCooldownRemaining(meta, currentCardId, normalizedCurrentRound);
    const cardLabel = isZh ? card.labelZh : card.labelEn;
    const cardDesc = isZh ? card.descriptionZh : card.descriptionEn;
    const previewText = buildCardPreview(currentCardId);
    const whyNowText = buildWhyNow(currentCardId);
    return (
      <button
        key={currentCardId}
        type="button"
        className={`gameplay-card-v2 ${selected ? 'gameplay-card-v2--selected' : ''} ${options.highlighted ? 'gameplay-card-v2--recommended' : ''}`}
        aria-pressed={selected}
        onClick={() => setCardId(currentCardId)}
        disabled={isDisabled}
      >
        <span className="gameplay-card-v2__head">
          <span className="gameplay-card-v2__icon" aria-hidden="true">{card.icon}</span>
          <span className="gameplay-card-v2__title">{cardLabel}</span>
          {options.highlighted && (
            <span className="gameplay-card-v2__badge gameplay-card-v2__badge--recommended">
              {t('gameplay.recommended_label')}
            </span>
          )}
          {counter && !options.highlighted && (
            <span className="gameplay-card-v2__badge gameplay-card-v2__badge--counter">
              {t('gameplay.counter_label')}
            </span>
          )}
        </span>
        <span className="gameplay-card-v2__desc">{cardDesc}</span>
        <dl className="gameplay-card-v2__questions">
          <div className="gameplay-card-v2__row">
            <dt>{t('gameplay.card_question_action')}</dt>
            <dd>{previewText}</dd>
          </div>
          <div className="gameplay-card-v2__row">
            <dt>{t('gameplay.card_question_affected')}</dt>
            <dd>
              {card.requiresPrimaryAgent || card.requiresSecondaryAgent
                ? t('gameplay.card_affected_targeted')
                : t('gameplay.card_affected_branch')}
            </dd>
          </div>
          <div className="gameplay-card-v2__row">
            <dt>{t('gameplay.card_question_next_round')}</dt>
            <dd>{cardDesc}</dd>
          </div>
          <div className="gameplay-card-v2__row">
            <dt>{t('gameplay.card_question_why_now')}</dt>
            <dd>{whyNowText}</dd>
          </div>
        </dl>
        <span className="gameplay-card-v2__meta">
          <span>{t('gameplay.cost_one')}</span>
          {cooldown > 0 && (
            <span>{t('gameplay.cooldown_remaining', { count: cooldown })}</span>
          )}
        </span>
      </button>
    );
  };

  const toggleGroup = (groupId: GameplayCardGroupId) => {
    setExpandedGroups((current) => ({ ...current, [groupId]: !current[groupId] }));
  };

  const submitButtonLabel = readOnly
    ? readOnlyLabel
    : isDisabled && status === 'submitting'
      ? submittingLabel
      : t('gameplay.submit_action');

  return (
    <div
      className="modal-overlay"
      data-modal-overlay="true"
      onClick={(event) => event.target === event.currentTarget && handleClose()}
    >
      <div
        ref={dialogRef}
        className="modal-content gameplay-modal gameplay-modal-v2"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
      >
        <header className="modal-header gameplay-modal-v2__header">
          <img
            className="gameplay-modal__art"
            src={GAMEPLAY_PANEL_ASSET}
            alt={t('gameplay.crest_alt')}
          />
          <h2 id={titleId}>{t('gameplay.title')}</h2>
          <p id={subtitleId} className="modal-subtitle">{t('gameplay.subtitle')}</p>
          <p className="gameplay-modal__profile">
            {t('gameplay.profile_label')}:
            <strong>{getGameplayProfileLabel(gameplayProfile.id, isZh)}</strong>
            {' · '}
            {getGameplayProfileDescription(gameplayProfile.id, isZh)}
          </p>
          {lastAppliedUsage && (
            <p
              className="gameplay-modal-v2__active-marker"
              role="status"
              aria-label={t('gameplay.active_marker_aria')}
            >
              {t('gameplay.active_marker', {
                label: getGameplayCardLabel(lastAppliedUsage.cardId as GameplayCardId, isZh),
              })}
            </p>
          )}
          <div className="gameplay-modal__stats" aria-label={t('gameplay.director_state_aria')}>
            <div className="gameplay-modal__stat">
              <span>{t('gameplay.director_points')}</span>
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
              <span>{t('gameplay.pressure_label')}</span>
              <strong>{systemTracks.pressure}</strong>
            </div>
          </div>
          <div
            className={`gameplay-modal__availability ${cardAvailability.ok && !readOnly ? 'gameplay-modal__availability--ready' : ''}`}
          >
            <strong>{t('gameplay.card_status_title')}</strong>
            <span>{availabilityLabel}</span>
          </div>
          {readOnly && (
            <p className="gameplay-modal__preview-note">
              {disabledReason ?? previewStatusLabel}
            </p>
          )}
        </header>

        <div className="modal-body gameplay-modal-v2__body">
          <section
            className="gameplay-modal-v2__section gameplay-modal-v2__section--primary"
            aria-labelledby="gameplay-recommended-heading"
          >
            <div className="gameplay-modal-v2__section-head">
              <h3 id="gameplay-recommended-heading">{t('gameplay.recommended_section_title')}</h3>
              <p>{t('gameplay.recommended_section_subtitle')}</p>
            </div>
            <div className="gameplay-modal-v2__recommended-grid">
              {recommendedCards.map((currentCardId) => renderCard(currentCardId, { highlighted: true }))}
            </div>
          </section>

          <section
            className="gameplay-modal-v2__section"
            aria-labelledby="gameplay-more-heading"
          >
            <div className="gameplay-modal-v2__section-head">
              <h3 id="gameplay-more-heading">{t('gameplay.more_options_title')}</h3>
              <p>{t('gameplay.more_options_subtitle')}</p>
            </div>
            <div className="gameplay-modal-v2__groups">
              {displayModel.groups.map((group) => {
                const expanded = expandedGroups[group.id];
                if (group.cardIds.length === 0) return null;
                const groupId = `gameplay-group-${group.id}`;
                return (
                  <div key={group.id} className="gameplay-modal-v2__group">
                    <button
                      type="button"
                      className="gameplay-modal-v2__group-toggle"
                      aria-expanded={expanded}
                      aria-controls={expanded ? groupId : undefined}
                      onClick={() => toggleGroup(group.id)}
                    >
                      <span className="gameplay-modal-v2__group-icon" aria-hidden="true">
                        {t(GROUP_ICON_KEYS[group.id])}
                      </span>
                      <span className="gameplay-modal-v2__group-title">{t(GROUP_TITLE_KEYS[group.id])}</span>
                      <span className="gameplay-modal-v2__group-count">{group.cardIds.length}</span>
                      <span className="gameplay-modal-v2__group-chevron" aria-hidden="true">
                        {expanded ? '−' : '+'}
                      </span>
                      <span className="sr-only">
                        {expanded ? t('gameplay.group_collapse') : t('gameplay.group_expand')}
                      </span>
                    </button>
                    {expanded && (
                      <div
                        id={groupId}
                        className="gameplay-modal-v2__group-cards"
                        role="region"
                        aria-label={t(GROUP_TITLE_KEYS[group.id])}
                      >
                        {group.cardIds.map((currentCardId) => renderCard(currentCardId, { highlighted: false }))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="gameplay-modal-v2__controls">
            <div className="modal-field gameplay-modal__field">
              <label htmlFor={targetBranchSelectId}>{t('gameplay.target_branch')}</label>
              <select
                id={targetBranchSelectId}
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
                <label htmlFor={primaryAgentSelectId}>{t('gameplay.primary_agent')}</label>
                <select
                  id={primaryAgentSelectId}
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
                <label htmlFor={secondaryAgentSelectId}>{t('gameplay.secondary_agent')}</label>
                <select
                  id={secondaryAgentSelectId}
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
                <label htmlFor={sourceBranchSelectId}>{t('gameplay.source_branch')}</label>
                <select
                  id={sourceBranchSelectId}
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
              aria-label={t('gameplay.card_directive_aria')}
              placeholder={placeholder}
              value={customDirective}
              onChange={(event) => setCustomDirectiveOverride(event.target.value)}
              disabled={isDisabled}
              rows={4}
            />

            <p className="gameplay-modal-v2__preview" role="status" aria-live="polite">
              <strong>{t('gameplay.card_preview_label')}</strong>
              <span>{buildCardPreview(cardId)}</span>
            </p>

            <p className="template-hint gameplay-modal__hint">{t('gameplay.hint')}</p>
          </section>

          <div className="gameplay-modal__status" aria-live="polite">
            {errorMsg && <p className="modal-error">{errorMsg}</p>}
            {status === 'success' && (
              <>
                <p className="modal-success">
                  {t('gameplay.toast_applied')}
                </p>
                {queueNotice && (
                  <p className="template-hint gameplay-modal__hint">{queueNotice}</p>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="modal-footer gameplay-modal-v2__footer">
          <button
            ref={closeButtonRef}
            className="btn btn-ghost"
            onClick={handleClose}
            disabled={status === 'submitting'}
          >
            {t('intervention.cancel')}
          </button>
          <button className="btn btn-primary gameplay-modal-v2__submit" onClick={handleSubmit} disabled={isDisabled}>
            <span className="gameplay-modal-v2__submit-primary">
              {status === 'submitting' ? submittingLabel : submitButtonLabel}
            </span>
            {!readOnly && status !== 'submitting' && (
              <span className="gameplay-modal-v2__submit-secondary">
                {`· ${selectedCardLabel}`}
              </span>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}
