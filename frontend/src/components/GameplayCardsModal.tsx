import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { intervene } from '../api/client';
import { dispatchVizEvent } from '../game';
import {
  applyCardUsage,
  canUseCard,
  getCardCooldownRemaining,
  loadScenarioMeta,
  type ScenarioMeta,
} from '../lib/scenarioMeta';
import type { AgentInfo, BranchInfo } from '../types';
import {
  buildAgentsById,
  buildGameplayAutoDirective,
  buildGameplayCardPrompt,
  GAMEPLAY_CARD_DEFS,
  getDefaultGameplayTargetBranch,
  getGameplayCardDefinition,
  getGameplayBadgeSrc,
  getGameplayCardDirectivePreview,
  getGameplayProfileDescription,
  getGameplayProfileFrameSrc,
  getGameplayProfileLabel,
  getGameplayProfileSignatureHooks,
  getRecommendedGameplayCards,
  getSuggestedGameplayAgents,
  getSuggestedSourceBranchId,
  inferGameplayProfile,
  type GameplayCardId,
} from './gameplayCards';
import './InterventionModal.css';
import './GameplayCardsModal.css';

interface Props {
  scenarioId: string;
  branches: BranchInfo[];
  agents: AgentInfo[];
  question: string;
  sceneTheme?: string | null;
  currentRound?: number;
  readOnly?: boolean;
  disabledReason?: string | null;
  onClose: () => void;
  onAutomationStateChange?: (state: Record<string, unknown> | null) => void;
}

export default function GameplayCardsModal({
  scenarioId,
  branches,
  agents,
  question,
  sceneTheme,
  currentRound = 1,
  readOnly = false,
  disabledReason = null,
  onClose,
  onAutomationStateChange,
}: Props) {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const gameplayProfile = useMemo(
    () => inferGameplayProfile(question, sceneTheme),
    [question, sceneTheme],
  );
  const recommendedCards = useMemo(
    () => getRecommendedGameplayCards(gameplayProfile.id),
    [gameplayProfile.id],
  );
  const profileSignatureHooks = useMemo(
    () => getGameplayProfileSignatureHooks(gameplayProfile.id, isZh),
    [gameplayProfile.id, isZh],
  );
  const activeBranches = useMemo(
    () => branches.filter((branch) => branch.status === 'ACTIVE'),
    [branches],
  );
  const defaultTargetBranchId = useMemo(
    () => getDefaultGameplayTargetBranch(activeBranches),
    [activeBranches],
  );
  const [cardId, setCardId] = useState<GameplayCardId>(recommendedCards[0] ?? 'civilization_debate');
  const [targetBranchId, setTargetBranchId] = useState(defaultTargetBranchId);
  const initialAgentSuggestion = useMemo(
    () => getSuggestedGameplayAgents(recommendedCards[0] ?? 'civilization_debate', agents, gameplayProfile.id),
    [agents, gameplayProfile.id, recommendedCards],
  );
  const [primaryAgentId, setPrimaryAgentId] = useState(initialAgentSuggestion.primaryAgentId);
  const [secondaryAgentId, setSecondaryAgentId] = useState(
    initialAgentSuggestion.secondaryAgentId ?? agents[1]?.id ?? agents[0]?.id ?? '',
  );
  const [sourceBranchId, setSourceBranchId] = useState(getSuggestedSourceBranchId(branches, defaultTargetBranchId, gameplayProfile.id));
  const [customDirective, setCustomDirective] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [meta, setMeta] = useState<ScenarioMeta>(() => loadScenarioMeta(scenarioId));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const normalizedCurrentRound = Math.max(1, currentRound);

  const agentsById = useMemo(() => buildAgentsById(agents), [agents]);
  const targetBranch = activeBranches.find((branch) => branch.id === targetBranchId) ?? activeBranches[0] ?? null;
  const sourceBranch = branches.find((branch) => branch.id === sourceBranchId) ?? null;
  const cardDef = getGameplayCardDefinition(cardId);
  const profileFrameSrc = getGameplayProfileFrameSrc(gameplayProfile.id);
  const cardAvailability = canUseCard(meta, cardId, normalizedCurrentRound);
  const cardCooldownRemaining = getCardCooldownRemaining(meta, cardId, normalizedCurrentRound);
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

  useEffect(() => {
    if (!targetBranchId && activeBranches.length > 0) {
      setTargetBranchId(activeBranches[0].id);
    }
  }, [activeBranches, targetBranchId]);

  useEffect(() => {
    setMeta(loadScenarioMeta(scenarioId));
  }, [scenarioId]);

  useEffect(() => {
    setCardId((current) => recommendedCards.includes(current) ? current : (recommendedCards[0] ?? current));
  }, [recommendedCards]);

  useEffect(() => {
    const suggestion = getSuggestedGameplayAgents(cardId, agents, gameplayProfile.id);
    if (suggestion.primaryAgentId) {
      setPrimaryAgentId(suggestion.primaryAgentId);
    }
    if (suggestion.secondaryAgentId) {
      setSecondaryAgentId(suggestion.secondaryAgentId);
    }
  }, [agents, cardId, gameplayProfile.id]);

  useEffect(() => {
    setSourceBranchId(getSuggestedSourceBranchId(branches, targetBranchId, gameplayProfile.id));
  }, [branches, gameplayProfile.id, targetBranchId]);

  useEffect(() => {
    setCustomDirective(autoDirective);
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
      status,
      read_only: readOnly,
      error: errorMsg || null,
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
    sourceBranchId,
    status,
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

  const requiresSecondAgent = cardId === 'civilization_debate';
  const requiresSourceBranch = cardId === 'spacetime_rift';
  const isDisabled = readOnly || status === 'submitting' || status === 'success';

  const placeholder = (() => {
    switch (cardId) {
      case 'civilization_debate':
        return isZh ? '输入辩题，例如：算法应否拥有最终否决权？' : 'Enter the debate topic…';
      case 'spy_infiltrate':
        return isZh ? '输入隐藏议程，例如：暗中瓦解地方议会联盟。' : 'Enter the hidden agenda…';
      case 'human_takeover':
        return isZh ? '输入你要让该角色说的话…' : 'Write the line the user wants to inject…';
      case 'spacetime_rift':
        return isZh ? '输入另一条时间线泄漏的信号…' : 'Describe the leaked signal from another timeline…';
      case 'mandate_surge':
        return isZh ? '输入这波民意浪潮要求立刻发生什么…' : 'Describe what the sudden mandate wave is demanding…';
      case 'public_hearing':
        return isZh ? '输入这场公开听证必须摊开的证据、条款或代价…' : 'Describe the evidence, terms, or trade-offs the hearing must expose…';
      case 'resource_triage':
        return isZh ? '输入这轮资源分诊必须明确保住或限供的对象…' : 'Describe who must be protected first and who gets rationed in this triage…';
      case 'forbidden_ritual':
        return isZh ? '输入这次禁术、秘仪或例外条款要付出的代价…' : 'Describe the taboo act and the price the branch must pay for it…';
    }
  })();

  const handleSubmit = async () => {
    if (!targetBranch) {
      setErrorMsg(isZh ? '当前没有可干预的活跃分支。' : 'No active branch is available for intervention.');
      return;
    }
    if (readOnly) {
      setErrorMsg(disabledReason ?? (isZh ? '导演准备中，当前仅可预览玩法卡。' : 'Director tools are warming up. Preview only for now.'));
      return;
    }

    if ((cardId === 'spy_infiltrate' || cardId === 'human_takeover') && !primaryAgentId) {
      setErrorMsg(isZh ? '请选择目标角色。' : 'Select a target agent.');
      return;
    }

    if (requiresSecondAgent && (!secondaryAgentId || primaryAgentId === secondaryAgentId)) {
      setErrorMsg(isZh ? '文明辩论需要两名不同角色。' : 'Civilization Debate needs two different agents.');
      return;
    }

    if (requiresSourceBranch && (!sourceBranch || sourceBranch.id === targetBranch.id)) {
      setErrorMsg(isZh ? '时空裂缝需要另一条来源分支。' : 'Space-Time Rift needs a different source branch.');
      return;
    }

    if (!cardAvailability.ok) {
      setErrorMsg(
        cardAvailability.reason === 'points'
          ? (isZh ? '导演点数不足。' : 'Not enough director points.')
          : (isZh ? `该卡仍在冷却中，还需 ${cardCooldownRemaining} 轮。` : `This card is cooling down for ${cardCooldownRemaining} more round(s).`),
      );
      return;
    }

    setStatus('submitting');
    setErrorMsg('');

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
      isZh,
    });

    try {
      await intervene(scenarioId, {
        branch_id: targetBranch.id,
        text: prompt,
      });

      dispatchVizEvent('viz:event_anim', {
        animation: cardDef.animation,
        card_name: cardDef.labelEn,
        card_name_zh: cardDef.labelZh,
      });

      setMeta(
        applyCardUsage(scenarioId, {
          cardId,
          profileId: gameplayProfile.id,
          branchId: targetBranch.id,
          branchTitle: targetBranch.title,
          round: normalizedCurrentRound,
          cost: 1,
          directive: customDirective,
          usedAt: new Date().toISOString(),
        }),
      );

      setStatus('success');
      closeTimerRef.current = setTimeout(() => onClose(), 1200);
    } catch (error) {
      setStatus('error');
      setErrorMsg(error instanceof Error ? error.message : t('intervention.error'));
    }
  };

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && handleClose()}>
      <div className="modal-content gameplay-modal">
        <header className="modal-header">
          <img
            className="gameplay-modal__art"
            src="/assets/ui/generated/gameplay_panel.png"
            alt="Gameplay tactics crest"
          />
          <h2>{t('gameplay.title')}</h2>
          <p className="modal-subtitle">{t('gameplay.subtitle')}</p>
          <p className="gameplay-modal__profile">
            {isZh ? '当前玩法画像：' : 'Scenario profile: '}
            <strong>{getGameplayProfileLabel(gameplayProfile.id, isZh)}</strong>
            {' · '}
            {getGameplayProfileDescription(gameplayProfile.id, isZh)}
          </p>
          <div className="gameplay-modal__hooks" aria-label={isZh ? '题材钩子' : 'Scenario hooks'}>
            {profileSignatureHooks.map((hook) => (
              <span key={hook} className="gameplay-modal__hook">{hook}</span>
            ))}
          </div>
          <p className="gameplay-modal__resource">
            {isZh ? '导演点数：' : 'Director points: '}
            <strong>{meta.director.remainingPoints}/{meta.director.maxPoints}</strong>
          </p>
          {readOnly && (
            <p className="gameplay-modal__preview-note">
              {disabledReason ?? (isZh ? '导演准备中，当前仅可预览玩法卡。' : 'Director tools are warming up. Preview only for now.')}
            </p>
          )}
        </header>

        <div className="modal-body gameplay-modal__body">
          <div className="gameplay-card-grid">
            {GAMEPLAY_CARD_DEFS.map((card) => {
              const selected = card.id === cardId;
              const recommended = recommendedCards.includes(card.id);
              return (
                <button
                  key={card.id}
                  className={`gameplay-card gameplay-card--profile-${gameplayProfile.id} ${selected ? 'gameplay-card--active' : ''}`}
                  onClick={() => setCardId(card.id)}
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
                      {recommended && (
                        <span className="gameplay-card__badge">
                          <img src={getGameplayBadgeSrc('recommended')} alt="" aria-hidden="true" />
                          <span>{isZh ? '推荐' : 'Recommended'}</span>
                        </span>
                      )}
                    </span>
                    <span className="gameplay-card__desc">
                      {isZh ? card.descriptionZh : card.descriptionEn}
                    </span>
                    <span className="gameplay-card__flavor">
                      {getGameplayCardDirectivePreview(gameplayProfile.id, card.id, isZh)}
                    </span>
                    <span className="gameplay-card__meta">
                      {isZh ? '消耗 1 点' : 'Cost 1'}
                      {getCardCooldownRemaining(meta, card.id, normalizedCurrentRound) > 0 && (
                        <>
                          {' · '}
                          {isZh
                            ? `冷却 ${getCardCooldownRemaining(meta, card.id, normalizedCurrentRound)} 轮`
                            : `CD ${getCardCooldownRemaining(meta, card.id, normalizedCurrentRound)} rounds`}
                        </>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="modal-field gameplay-modal__field">
            <label>{t('gameplay.target_branch')}</label>
            <select
              className="gameplay-select"
              value={targetBranchId ?? ''}
              onChange={(event) => setTargetBranchId(event.target.value)}
              disabled={isDisabled}
            >
              {activeBranches.length > 0 ? (
                activeBranches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.title}
                  </option>
                ))
              ) : (
                <option value="">{isZh ? '等待分支同步…' : 'Waiting for branches…'}</option>
              )}
            </select>
          </div>

          {(cardId === 'civilization_debate' || cardId === 'spy_infiltrate' || cardId === 'human_takeover') && (
            <div className="modal-field gameplay-modal__field">
              <label>{t('gameplay.primary_agent')}</label>
              <select
                className="gameplay-select"
                value={primaryAgentId}
                onChange={(event) => setPrimaryAgentId(event.target.value)}
                disabled={isDisabled}
              >
                {agents.length > 0 ? (
                  agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))
                ) : (
                  <option value="">{isZh ? '等待角色同步…' : 'Waiting for agents…'}</option>
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
                onChange={(event) => setSecondaryAgentId(event.target.value)}
                disabled={isDisabled}
              >
                {agents.length > 0 ? (
                  agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))
                ) : (
                  <option value="">{isZh ? '等待角色同步…' : 'Waiting for agents…'}</option>
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
                onChange={(event) => setSourceBranchId(event.target.value)}
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
                  <option value="">{isZh ? '等待来源世界线…' : 'Waiting for source branch…'}</option>
                )}
              </select>
            </div>
          )}

          <textarea
            ref={inputRef}
            className="intervention-input gameplay-modal__textarea"
            placeholder={placeholder}
            value={customDirective}
            onChange={(event) => setCustomDirective(event.target.value)}
            disabled={isDisabled}
            rows={4}
          />

          <p className="template-hint gameplay-modal__hint">
            {t('gameplay.hint')}
          </p>

          {errorMsg && <p className="modal-error">{errorMsg}</p>}
          {status === 'success' && <p className="modal-success">{t('intervention.success')}</p>}
        </div>

        <footer className="modal-footer">
          <button className="btn btn-ghost" onClick={handleClose} disabled={status === 'submitting'}>
            {t('intervention.cancel')}
          </button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={isDisabled}>
            {status === 'submitting'
              ? '...'
              : readOnly
                ? (isZh ? '导演准备中' : 'Preparing Director Tools')
                : t('gameplay.apply')}
          </button>
        </footer>
      </div>
    </div>
  );
}
