import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cancelDebate, getDebateRestartOptions, getSessionBoundUserId, isApiError, predictDebate, restartDebate } from '../api/client';
import { createCompatUuid } from '../lib/compatUuid';
import { buildAutomationErrorState, getLocalizedApiErrorMessage } from '../lib/apiErrorMessage';
import { DebateBetModal } from '../components/DebateBetModal';
import { DebateMomentumBar } from '../components/DebateMomentumBar';
import { DebateScoreCard } from '../components/DebateScoreCard';
import { DebateStageRibbon } from '../components/DebateStageRibbon';
import { FoldableTurn } from '../components/ui/FoldableTurn';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { stringifyAutomationPayload, type AutomationWindow } from '../game/automation';
import {
  resolveDebateCounterplayRecord,
  loadDebateCounterplay,
  saveDebateCounterplay,
  type DebateCounterplayRecord,
} from '../lib/debateCounterplay';
import {
  DEBATE_PHASE_ORDER,
  getDebateDimensionLabel,
  getDebatePhaseLabel,
  getDebateSideLabel,
} from '../lib/debateLabels';
import {
  buildDebatePhaseSummaries,
  getDebateScoreLeader,
  type DebateLeader,
} from '../lib/debateInsights';
import { DEBATE_UI_ASSETS, getThemeAssetPath, getTheaterThemeLabel } from '../lib/themeRegistry';
import { getFirstGrapheme } from '../lib/textUtils';
import {
  captureElementDataUrl,
  useScreenCapture,
} from '../hooks/useScreenCapture';
import { useDebateWS } from '../hooks/useDebateWS';
import { useDebateStore } from '../stores/debateStore';
import { getDirectorIdentity } from '../lib/directorIdentity';
import type { DebatePhase, DebateProfileChoice, DebateRestartOptions, DebateSnapshot, RestartDebateRequest } from '../types';
import { ArgumentMap } from '../components/ArgumentMap';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import './DebateArena.css';

const REVEAL_INTERVAL_MS = 1400;
const SPOTLIGHT_TRUNCATE_LEN = 120;

interface DebateRoomInsight {
  side: 'proposition' | 'opposition' | 'judge';
  role: string;
  persona: string | null;
  statusLabel: string;
  note: string;
  sourceLabel: string | null;
  active: boolean;
}

type AvailablePredictionOptions = {
  winner: string[];
  verdict_tone: string[];
};

const DEFAULT_DEBATE_PREDICTION_OPTIONS: AvailablePredictionOptions = {
  winner: ['proposition', 'opposition'],
  verdict_tone: ['order', 'balance', 'rupture'],
};

function normalizePredictionOptions(
  options: AvailablePredictionOptions | null | undefined,
): AvailablePredictionOptions {
  const winner = options?.winner.filter((value) => typeof value === 'string' && value.trim().length > 0) ?? [];
  const verdictTone = options?.verdict_tone.filter((value) => typeof value === 'string' && value.trim().length > 0) ?? [];
  return {
    winner: winner.length > 0 ? winner : DEFAULT_DEBATE_PREDICTION_OPTIONS.winner,
    verdict_tone: verdictTone.length > 0 ? verdictTone : DEFAULT_DEBATE_PREDICTION_OPTIONS.verdict_tone,
  };
}

function getLeaderLabel(
  t: ReturnType<typeof useTranslation>['t'],
  leader: DebateLeader,
): string {
  if (leader === 'balanced') return t('debate.phase_balance');
  return getDebateSideLabel(t, leader);
}

const DEBATE_ROLES = ['proposition', 'opposition', 'judge'] as const;
type DebateRole = (typeof DEBATE_ROLES)[number];

function pendingRestartKey(debateId: string): string {
  return `swarmoracle:debate-restart:pending:${debateId}`;
}

function readPendingRestart(debateId: string): RestartDebateRequest | null {
  try {
    const raw = sessionStorage.getItem(pendingRestartKey(debateId));
    if (!raw || raw.length > 2048) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.client_request_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.client_request_id)) return null;
    const fields = ['proposition_model_profile_id', 'opposition_model_profile_id', 'judge_model_profile_id', 'current_server_token'];
    if (fields.some((field) => record[field] !== undefined && (typeof record[field] !== 'string' || String(record[field]).length > 128))) return null;
    if (record.use_current_server_provider !== undefined && typeof record.use_current_server_provider !== 'boolean') return null;
    const tokens = record.profile_confirmation_tokens;
    if (tokens !== undefined) {
      if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return null;
      const entries = Object.entries(tokens);
      if (entries.length > 3 || entries.some(([key, token]) => key.length > 128 || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token))) return null;
    }
    if (Object.keys(record).some((key) => !['client_request_id', 'use_current_server_provider', 'profile_confirmation_tokens', ...fields].includes(key))) return null;
    return record as unknown as RestartDebateRequest;
  } catch {
    return null;
  }
}

function DebateLifecycleControls({ debate, onReveal }: { debate: DebateSnapshot; onReveal: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [cachedRequest] = useState(() => readPendingRestart(debate.id));
  const pendingRequest = useRef<RestartDebateRequest | null>(cachedRequest);
  const [open, setOpen] = useState(Boolean(cachedRequest));
  const [working, setWorking] = useState<'cancel' | 'restart' | null>(null);
  const workingRef = useRef(false);
  const mountedRef = useRef(true);
  const requestEpochRef = useRef(0);
  const [options, setOptions] = useState<DebateRestartOptions | null>(null);
  const [profiles, setProfiles] = useState<DebateProfileChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [choiceError, setChoiceError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(Boolean(cachedRequest));
  const [selected, setSelected] = useState<Partial<Record<DebateRole, string>>>(() => cachedRequest ? {
    proposition: cachedRequest.proposition_model_profile_id ?? '',
    opposition: cachedRequest.opposition_model_profile_id ?? '',
    judge: cachedRequest.judge_model_profile_id ?? '',
  } : {});
  const [useServer, setUseServer] = useState(cachedRequest?.use_current_server_provider ?? false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const terminal = ['done', 'error', 'cancelled'].includes(debate.status);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestEpochRef.current += 1; };
  }, []);
  const loadChoices = useCallback(async (): Promise<void> => {
    const epoch = ++requestEpochRef.current;
    setLoading(true);
    setChoiceError(false);
    try {
      const choice = await getDebateRestartOptions(debate.id);
      if (!mountedRef.current || requestEpochRef.current !== epoch) return;
      setOptions(choice);
      setProfiles(choice.owned_profile_choices ?? []);
      setActionError((current) => current === 'changed' ? null : current);
      setSelected((current) => Object.keys(current).length > 0 ? current : Object.fromEntries(
        choice.providers.map((provider) => [provider.role, provider.available ? provider.profile_id ?? '' : '']),
      ));
    } catch {
      if (mountedRef.current && requestEpochRef.current === epoch) setChoiceError(true);
    } finally {
      if (mountedRef.current && requestEpochRef.current === epoch) setLoading(false);
    }
  }, [debate.id]);
  useEffect(() => { if (cachedRequest) void loadChoices(); }, [cachedRequest, loadChoices]);

  const cancel = async (): Promise<void> => {
    if (workingRef.current) return;
    workingRef.current = true;
    setWorking('cancel');
    setActionError(null);
    try {
      const snapshot = await cancelDebate(debate.id);
      if (mountedRef.current) useDebateStore.getState().setDebate(snapshot, debate.id);
    } catch {
      if (mountedRef.current) setActionError('cancel');
    } finally {
      workingRef.current = false;
      if (mountedRef.current) setWorking(null);
    }
  };

  const restart = async (): Promise<void> => {
    if (workingRef.current) return;
    const request: RestartDebateRequest = pendingRequest.current ?? {
      client_request_id: createCompatUuid(),
      ...(selected.proposition ? { proposition_model_profile_id: selected.proposition } : {}),
      ...(selected.opposition ? { opposition_model_profile_id: selected.opposition } : {}),
      ...(selected.judge ? { judge_model_profile_id: selected.judge } : {}),
      profile_confirmation_tokens: Object.fromEntries(
        profiles.filter((profile) => Object.values(selected).includes(profile.profile_id))
          .map((profile) => [profile.profile_id, profile.confirmation_token]),
      ),
      ...(useServer ? { use_current_server_provider: true, current_server_token: options?.server_provider.confirmation_token } : {}),
    };
    pendingRequest.current = request;
    try { sessionStorage.setItem(pendingRestartKey(debate.id), JSON.stringify(request)); } catch { /* Retry remains stable in memory. */ }
    workingRef.current = true;
    setWorking('restart');
    setActionError(null);
    try {
      const snapshot = await restartDebate(debate.id, request);
      pendingRequest.current = null;
      try { sessionStorage.removeItem(pendingRestartKey(debate.id)); } catch { /* Readback is still available in history. */ }
      if (!mountedRef.current) return;
      useDebateStore.getState().setDebate(snapshot);
      navigate(`/debate/${snapshot.id}`);
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      if (isApiError(error) && error.status >= 400 && error.status < 500) {
        pendingRequest.current = null;
        try { sessionStorage.removeItem(pendingRestartKey(debate.id)); } catch { /* No provider credentials are stored here. */ }
        setUncertain(false);
        setActionError(error.code === 'DEBATE_RESTART_PROVIDER_CHANGED' ? 'changed' : 'restart');
      } else {
        setUncertain(true);
        setActionError('uncertain');
      }
    } finally {
      workingRef.current = false;
      if (mountedRef.current) setWorking(null);
    }
  };
  const canRestart = Boolean(uncertain || (options && !loading && !choiceError && actionError !== 'changed' && DEBATE_ROLES.every(
    (role) => selected[role]
      ? profiles.some((profile) => profile.profile_id === selected[role] && profile.confirmation_token)
      : useServer && options.server_provider.available,
  )));

  return (
    <section className="debate-recovery-panel" aria-label={t('debate.recovery_controls')}>
      {debate.status === 'cancelled' && <p role="status">{t('debate.cancelled_notice')}</p>}
      {debate.status === 'error' && <p role="status">{t('debate.failed_preserved_notice')}</p>}
      <div className="debate-controls">
        {!terminal && <button type="button" className="btn btn-ghost" disabled={Boolean(working)} onClick={() => void cancel()}>{working === 'cancel' ? t('debate.cancelling') : t('debate.cancel_run')}</button>}
        {terminal && <button type="button" className="btn btn-ghost" onClick={onReveal}>{t('debate.open_preserved_turns')}</button>}
        <button type="button" className="btn btn-ghost" onClick={() => void useDebateStore.getState().loadDebate(debate.id)}>{t('common.refresh')}</button>
        <button type="button" className="btn btn-ghost" onClick={() => navigate('/history')}>{t('debate.open_experiments')}</button>
        {debate.source_debate_id && <button type="button" className="btn btn-ghost" onClick={() => navigate(`/debate/${debate.source_debate_id}`)}>{t('debate.previous_run')}</button>}
        {terminal && <button type="button" className="btn btn-primary" aria-expanded={open} onClick={() => {
          setOpen((current) => !current);
          if (!open) { void loadChoices(); requestAnimationFrame(() => headingRef.current?.focus()); }
        }}>{t('debate.restart_open')}</button>}
      </div>
      {uncertain && <p role="status">{t('debate.restart_uncertain')}</p>}
      {actionError && actionError !== 'uncertain' && <p role="alert">{t(actionError === 'changed' ? 'debate.restart_provider_changed' : actionError === 'cancel' ? 'debate.cancel_failed' : 'debate.restart_failed')}</p>}
      {open && terminal && (
        <div>
          <h2 ref={headingRef} tabIndex={-1}>{t('debate.restart_open')}</h2>
          <p>{t('debate.restart_preserves_source')}</p>
          {loading && <p role="status">{t('common.loading')}</p>}
          {choiceError && <p role="status">{t('roundtable.profile_list_failed')}</p>}
          <button type="button" className="btn btn-ghost" disabled={Boolean(working) || loading || uncertain} onClick={() => void loadChoices()}>{t('debate.reload_models')}</button>
          <fieldset disabled={Boolean(working) || uncertain || loading} className="debate-restart-models">
            <legend>{t('debate.restart_model_choices')}</legend>
            {DEBATE_ROLES.map((role) => {
              const original = options?.providers.find((provider) => provider.role === role);
              return <label key={role}>
                {getDebateSideLabel(t, role)}
                <select value={selected[role] ?? ''} onChange={(event) => setSelected((current) => ({ ...current, [role]: event.target.value }))}>
                  <option value="">{t('model_profiles.placeholder_select')}</option>
                  {selected[role] && !profiles.some((profile) => profile.profile_id === selected[role]) && <option value={selected[role]}>{t('roundtable.provider_unavailable')}</option>}
                  {profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.name} ({profile.model})</option>)}
                </select>
                {original?.source === 'unknown' && <span>{t('debate.original_model_unknown')}</span>}
                {original?.source === 'profile' && !original.available && <span>{t('debate.original_model_unavailable')}</span>}
              </label>;
            })}
            <label className="debate-restart-server">
              <input type="checkbox" checked={useServer} disabled={!options?.server_provider.available}
                onChange={(event) => setUseServer(event.target.checked)} />
              {t('debate.restart_use_server')}: {options?.server_provider.name ?? t('roundtable.provider_unavailable')}
            </label>
          </fieldset>
          <button type="button" className="btn btn-primary" disabled={Boolean(working) || !canRestart} onClick={() => void restart()}>{working === 'restart' ? t('debate.restarting') : uncertain ? t('debate.restart_retry_same') : t('debate.restart_confirm')}</button>
        </div>
      )}
    </section>
  );
}

export function DebateArenaView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const directorIdentity = getDirectorIdentity();
  const apiUserId = getSessionBoundUserId();

  const debate = useDebateStore((state) => state.debate);
  const status = useDebateStore((state) => state.status);
  const error = useDebateStore((state) => state.error);
  const errorCode = useDebateStore((state) => state.errorCode);
  const loadDebate = useDebateStore((state) => state.loadDebate);
  const isInterrupted = debate?.status === 'cancelled' || debate?.status === 'error';

  const { enabled: argMapEnabled } = useCapabilityCheck('argument_map');
  const [argMapOpen, setArgMapOpen] = useState(true);
  const [stageMapOpen, setStageMapOpen] = useState(false);
  const [argMapRefreshKey, setArgMapRefreshKey] = useState(0);
  const liveArgumentMapPanelId = `debate-live-argument-map-${useId().replace(/:/g, '-')}`;

  const [revealCount, setRevealCount] = useState(0);
  const [selectedPhase, setSelectedPhase] = useState<string>('opening');
  const [showBetModal, setShowBetModal] = useState(false);
  const [betSubmitting, setBetSubmitting] = useState(false);
  const [betModalState, setBetModalState] = useState<Record<string, unknown> | null>(null);
  const [betNotice, setBetNotice] = useState('');
  const [captureNotice, setCaptureNotice] = useState('');
  const [autoReveal, setAutoReveal] = useState(true);
  const [phaseLocked, setPhaseLocked] = useState(false);
  const [phaseCue, setPhaseCue] = useState<{
    phase: string;
    speakerName: string | null;
    speakerSide: 'proposition' | 'opposition' | 'judge' | null;
    token: number;
  } | null>(null);
  const [betPreset, setBetPreset] = useState<{
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
    strategyHint: string;
    phase: DebatePhase;
    variant: 'balanced' | 'reversal';
  } | null>(null);
  const [counterplayRecord, setCounterplayRecord] = useState<DebateCounterplayRecord | null>(null);
  const [expandedPastTurnIds, setExpandedPastTurnIds] = useState<Set<string>>(new Set());
  const [spotlightExpanded, setSpotlightExpanded] = useState(false);
  const [expandedRoomCards, setExpandedRoomCards] = useState<Set<string>>(new Set());
  const [strategyOpenItems, setStrategyOpenItems] = useState<string[]>(['clash']);

  const toggleRoomCard = (side: string) => {
    setExpandedRoomCards((prev) => {
      const next = new Set(prev);
      if (next.has(side)) {
        next.delete(side);
      } else {
        next.add(side);
      }
      return next;
    });
  };
  const revealRef = useRef(0);
  const previousPhaseRef = useRef<string | null>(null);
  const advanceTimeRemainderRef = useRef(0);

  const { status: captureStatus, captureScreenshot } = useScreenCapture({
    selector: '.debate-shell',
  });

  useEffect(() => {
    if (!id) return;
    void loadDebate(id);
    setCounterplayRecord(resolveDebateCounterplayRecord({
      resultCounterplay: null,
      localRecord: loadDebateCounterplay(id),
    }));
  }, [id, loadDebate]);

  useEffect(() => {
    if (!id) return;
    setCounterplayRecord(resolveDebateCounterplayRecord({
      resultCounterplay: debate?.id === id ? debate.counterplay ?? null : null,
      localRecord: loadDebateCounterplay(id),
    }));
  }, [debate?.counterplay, debate?.id, id]);

  useDebateWS(id, Boolean(id) && status !== 'deleted');

  useEffect(() => {
    if (!debate?.turns.length) return;
    if (revealCount === 0) {
      setRevealCount(1);
    }
  }, [debate?.turns.length, revealCount]);

  useEffect(() => {
    revealRef.current = revealCount;
  }, [revealCount]);

  useEffect(() => {
    advanceTimeRemainderRef.current = 0;
  }, [debate?.id, id]);

  useEffect(() => {
    if (!debate?.turns.length || !autoReveal || isInterrupted) return undefined;
    if (revealCount >= debate.turns.length) return undefined;
    const timer = window.setTimeout(() => {
      setRevealCount((current) => Math.min((debate?.turns.length ?? current), current + 1));
    }, REVEAL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoReveal, debate?.turns.length, isInterrupted, revealCount]);

  // P1-5: Refresh argument map when new turns are revealed
  useEffect(() => {
    if (argMapOpen && argMapEnabled) {
      setArgMapRefreshKey(k => k + 1);
    }
  }, [revealCount, argMapOpen, argMapEnabled]);

  const visibleTurns = useMemo(
    () => isInterrupted ? debate?.turns ?? [] : debate?.turns.slice(0, revealCount) ?? [],
    [debate?.turns, isInterrupted, revealCount],
  );
  const latestVisibleTurn = visibleTurns[visibleTurns.length - 1] ?? null;
  const activeSpeakerSide = latestVisibleTurn?.speaker_side ?? null;

  useEffect(() => {
    setSpotlightExpanded(false);
  }, [latestVisibleTurn?.id]);

  const unlockedPhases = useMemo(
    () => Array.from(new Set(visibleTurns.map((turn) => turn.phase))),
    [visibleTurns],
  );

  const currentPhase = latestVisibleTurn?.phase ?? debate?.current_phase ?? 'opening';
  const stageTurns = useMemo(() => {
    if (selectedPhase === currentPhase) {
      return visibleTurns;
    }
    return visibleTurns.filter((turn) => turn.phase === selectedPhase);
  }, [currentPhase, selectedPhase, visibleTurns]);
  const latestStageTurn = stageTurns[stageTurns.length - 1] ?? null;
  const phaseUnlockCount = unlockedPhases.length;
  const phaseSummaries = useMemo(
    () => buildDebatePhaseSummaries(visibleTurns, unlockedPhases),
    [unlockedPhases, visibleTurns],
  );
  const serverPhaseInsights = useMemo(
    () => debate?.phase_insights ?? [],
    [debate?.phase_insights],
  );
  const serverPhaseInsightMap = useMemo(
    () => new Map(serverPhaseInsights.map((insight) => [insight.phase, insight])),
    [serverPhaseInsights],
  );
  const selectedPhaseSummary = useMemo(
    () => phaseSummaries.find((summary) => summary.phase === selectedPhase) ?? null,
    [phaseSummaries, selectedPhase],
  );
  const selectedServerInsight = serverPhaseInsightMap.get(selectedPhase as DebatePhase) ?? null;
  const availablePredictionOptions = useMemo(
    () => normalizePredictionOptions(debate?.available_prediction_options),
    [debate?.available_prediction_options],
  );

  useEffect(() => {
    if (!phaseLocked) {
      setSelectedPhase(currentPhase);
    }
  }, [currentPhase, phaseLocked]);

  useEffect(() => {
    if (!debate) return;
    if (previousPhaseRef.current === null) {
      previousPhaseRef.current = currentPhase;
      return;
    }
    if (previousPhaseRef.current === currentPhase) return;
    previousPhaseRef.current = currentPhase;
    setPhaseCue({
      phase: currentPhase,
      speakerName: latestVisibleTurn?.speaker_name ?? null,
      speakerSide: latestVisibleTurn?.speaker_side ?? null,
      token: Date.now(),
    });
    const timer = window.setTimeout(() => setPhaseCue(null), 2200);
    return () => window.clearTimeout(timer);
  }, [currentPhase, debate, latestVisibleTurn]);

  const currentPhaseIndex = useMemo(
    () => ['opening', 'crossfire', 'rebuttal', 'closing', 'verdict'].indexOf(currentPhase),
    [currentPhase],
  );
  const nextPhase = useMemo(() => {
    const next = DEBATE_PHASE_ORDER[currentPhaseIndex + 1];
    return next ?? null;
  }, [currentPhaseIndex]);
  const canBetNow = Boolean(debate?.status === 'live' && !debate.result_ready && currentPhaseIndex < 3);

  const phaseScoreDelta = useMemo(
    () => stageTurns.reduce(
      (acc, turn) => ({
        proposition: acc.proposition + (turn.score_delta?.proposition ?? 0),
        opposition: acc.opposition + (turn.score_delta?.opposition ?? 0),
      }),
      { proposition: 0, opposition: 0 },
    ),
    [stageTurns],
  );
  const overallPressure = useMemo(
    () => getDebateScoreLeader(debate?.score.proposition ?? 0, debate?.score.opposition ?? 0),
    [debate?.score.opposition, debate?.score.proposition],
  );

  const watchedDimension = useMemo(() => {
    switch (selectedPhase) {
      case 'opening':
        return 'coherence';
      case 'crossfire':
        return 'evidence';
      case 'rebuttal':
        return 'adaptability';
      case 'closing':
      case 'verdict':
        return 'impact';
      default:
        return 'coherence';
    }
  }, [selectedPhase]);

  const clashCopy = useMemo(() => {
    const serverStrategy = selectedServerInsight?.strategy?.trim();
    if (serverStrategy) {
      return serverStrategy;
    }
    return t(`debate.clash_${selectedPhase}`);
  }, [selectedPhase, selectedServerInsight?.strategy, t]);
  const phaseLeaderLabel = useMemo(() => {
    if (phaseScoreDelta.proposition === phaseScoreDelta.opposition) {
      return t('debate.phase_balance');
    }
    return phaseScoreDelta.proposition > phaseScoreDelta.opposition
      ? getDebateSideLabel(t, 'proposition')
      : getDebateSideLabel(t, 'opposition');
  }, [phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const phasePressureCopy = useMemo(() => {
    const swing = Math.abs(phaseScoreDelta.proposition - phaseScoreDelta.opposition);
    if (swing === 0) {
      return t('debate.pressure_even');
    }
    return t('debate.pressure_edge', { side: phaseLeaderLabel, value: swing });
  }, [phaseLeaderLabel, phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const betWindowLabel = canBetNow ? t('debate.bet_window_open') : t('debate.bet_window_locked');
  const counterplayPlan = useMemo(() => {
    if (!debate || !canBetNow) return null;

    const phaseSwing = Math.abs(phaseScoreDelta.proposition - phaseScoreDelta.opposition);
    if (phaseSwing === 0) {
      if (!availablePredictionOptions.verdict_tone.includes('balance')) {
        return null;
      }
      return {
        kind: 'verdict_tone' as const,
        targetValue: 'balance',
        confidence: 0.5,
        label: t('debate.counterplay_balanced_label'),
        summary: t('debate.counterplay_balanced_summary'),
        strategyHint: t('debate.counterplay_balanced_hint'),
        variant: 'balanced' as const,
      };
    }

    const trailingSide = phaseScoreDelta.proposition > phaseScoreDelta.opposition
      ? 'opposition'
      : 'proposition';
    if (!availablePredictionOptions.winner.includes(trailingSide)) {
      return null;
    }
    const confidence = phaseSwing >= 8 ? 0.7 : phaseSwing >= 4 ? 0.6 : 0.5;

    return {
      kind: 'winner' as const,
      targetValue: trailingSide,
      confidence,
      label: t('debate.counterplay_reversal_label'),
      summary: t('debate.counterplay_reversal_summary', {
        side: getDebateSideLabel(t, trailingSide),
        value: phaseSwing,
      }),
      strategyHint: t('debate.counterplay_reversal_hint', {
        side: getDebateSideLabel(t, trailingSide),
        value: phaseSwing,
        confidence: Math.round(confidence * 100),
      }),
      variant: 'reversal' as const,
    };
  }, [availablePredictionOptions.verdict_tone, availablePredictionOptions.winner, canBetNow, debate, phaseScoreDelta.opposition, phaseScoreDelta.proposition, t]);
  const canSubmitCounterplay = Boolean(counterplayPlan) && canBetNow && selectedPhase === currentPhase;
  const feedFocusLabel = useMemo(() => {
    if (!latestVisibleTurn) return null;
    return [
      latestVisibleTurn.speaker_name,
      getDebateSideLabel(t, latestVisibleTurn.speaker_side),
      t(isInterrupted || debate?.status === 'done' ? 'debate.room_state_saved' : 'debate.room_state_floor'),
    ].join(' · ');
  }, [debate?.status, isInterrupted, latestVisibleTurn, t]);
  const phaseCueCopy = useMemo(() => {
    if (!phaseCue) return null;
    return [
      getDebatePhaseLabel(t, phaseCue.phase),
      t('debate.stage_status_live'),
      phaseCue.speakerName,
    ].filter(Boolean).join(' · ');
  }, [phaseCue, t]);
  const unlockProgressLabel = useMemo(() => {
    return t('debate.unlock_progress', {
      unlocked: phaseUnlockCount,
      total: DEBATE_PHASE_ORDER.length,
    });
  }, [phaseUnlockCount, t]);
  const stageStateLabel = useMemo(() => {
    if (debate && ['done', 'error', 'cancelled'].includes(debate.status)) return t(`debate.status_${debate.status}`);
    return phaseLocked ? t('debate.stage_status_locked') : t('debate.stage_status_live');
  }, [debate, phaseLocked, t]);
  const overallLeaderLabel = useMemo(
    () => getLeaderLabel(t, overallPressure.leader),
    [overallPressure.leader, t],
  );
  const overallPressureCopy = useMemo(() => {
    if (overallPressure.leader === 'balanced') {
      return t('debate.overview_judge_even');
    }
    return t('debate.overview_judge_edge', {
      side: overallLeaderLabel,
      value: overallPressure.margin,
    });
  }, [overallLeaderLabel, overallPressure.leader, overallPressure.margin, t]);
  const overviewCards = useMemo(
    () => [
      {
        title: t('debate.overview_room_title'),
        value: stageStateLabel,
        detail: t('debate.overview_room_detail', {
          phase: getDebatePhaseLabel(t, selectedPhase),
          unlocked: phaseUnlockCount,
          total: DEBATE_PHASE_ORDER.length,
          count: visibleTurns.length,
        }),
      },
      {
        title: t('debate.overview_judge_title'),
        value: overallLeaderLabel,
        detail: t('debate.overview_judge_detail', {
          watch: getDebateDimensionLabel(t, watchedDimension),
          pressure: selectedServerInsight?.judge_focus ?? overallPressureCopy,
        }),
      },
      {
        title: t('debate.overview_window_title'),
        value: betWindowLabel,
        detail: counterplayRecord
          ? t('debate.overview_window_used_detail')
          : canBetNow
            ? t('debate.overview_window_open_detail', {
              next: nextPhase ? getDebatePhaseLabel(t, nextPhase) : getDebatePhaseLabel(t, currentPhase),
            })
            : t('debate.overview_window_locked_detail', {
              phase: getDebatePhaseLabel(t, currentPhase),
            }),
      },
    ],
    [
      betWindowLabel,
      canBetNow,
      counterplayRecord,
      currentPhase,
      nextPhase,
      overallLeaderLabel,
      overallPressureCopy,
      phaseUnlockCount,
      selectedServerInsight,
      selectedPhase,
      stageStateLabel,
      t,
      visibleTurns.length,
      watchedDimension,
    ],
  );
  const roomInsights = useMemo<DebateRoomInsight[]>(() => {
    return (debate?.participants ?? []).map((participant) => {
      const latestPhaseTurn = [...stageTurns].reverse().find((turn) => turn.speaker_side === participant.side);
      const latestTurn = latestPhaseTurn
        ?? [...visibleTurns].reverse().find((turn) => turn.speaker_side === participant.side)
        ?? null;

      const personaTrimmed = participant.persona?.trim();

      let statusLabel = t('debate.room_state_waiting');
      let note = participant.side === 'judge'
        ? t('debate.room_quote_judge')
        : t('debate.room_quote_waiting');

      if (isInterrupted) {
        statusLabel = latestTurn ? t('debate.room_state_saved') : t('debate.room_state_stopped');
        note = latestTurn?.content ?? t(participant.side === 'judge' ? 'debate.no_verdict_notice' : 'debate.no_saved_turn');
      } else if (participant.side === 'judge' && debate?.result_ready) {
        statusLabel = t('debate.room_state_verdict_ready');
        note = latestTurn?.content ?? t('debate.open_result_for_verdict');
      } else if (debate?.status === 'done') {
        statusLabel = latestTurn ? t('debate.room_state_saved') : t('debate.room_state_stopped');
        note = latestTurn?.content ?? t('debate.no_saved_turn');
      } else if (latestTurn) {
        statusLabel = latestTurn.id === latestVisibleTurn?.id
          ? t('debate.room_state_floor')
          : participant.side === 'judge'
            ? t('debate.room_state_listening')
            : t('debate.room_state_ready');
        note = latestTurn.content;
      }

      return {
        side: participant.side,
        role: participant.role,
        persona: personaTrimmed && personaTrimmed.length > 0 ? personaTrimmed : null,
        statusLabel,
        note,
        sourceLabel: latestTurn ? getDebatePhaseLabel(t, latestTurn.phase) : null,
        active: debate?.status === 'live' && latestTurn?.id === latestVisibleTurn?.id,
      };
    });
  }, [debate?.participants, debate?.result_ready, debate?.status, isInterrupted, latestVisibleTurn?.id, stageTurns, t, visibleTurns]);

  const themeLabel = getTheaterThemeLabel(debate?.scene_theme, isZh);
  const themeAsset = debate?.scene_theme ? getThemeAssetPath(debate.scene_theme as never) : null;

  useEffect(() => {
    if (!canBetNow && showBetModal) {
      setShowBetModal(false);
    }
    if (!canBetNow && betPreset) {
      setBetPreset(null);
    }
  }, [betPreset, canBetNow, showBetModal]);

  useEffect(() => {
    setStrategyOpenItems((current) => {
      if (!counterplayPlan) {
        return current.includes('counterplay')
          ? current.filter((item) => item !== 'counterplay')
          : current;
      }
      return current.includes('counterplay')
        ? current
        : [...current, 'counterplay'];
    });
  }, [counterplayPlan]);

  useEffect(() => {
    const win = window as AutomationWindow;
    const capture = async (mode: 'canvas' | 'panel' | 'modal' = 'panel') => {
      if (mode === 'modal') {
        if (!showBetModal) return null;
        return captureElementDataUrl('.debate-modal', 'element');
      }
      return captureElementDataUrl('.debate-shell', 'element');
    };
    win.advanceTime = async (ms: number) => {
      advanceTimeRemainderRef.current += Math.max(0, ms);
      const steps = Math.floor(advanceTimeRemainderRef.current / REVEAL_INTERVAL_MS);
      if (steps <= 0) return;
      advanceTimeRemainderRef.current -= steps * REVEAL_INTERVAL_MS;
      setAutoReveal(false);
      setRevealCount((current) => Math.min(debate?.turns.length ?? current, current + steps));
    };
    win.capture_game_screenshot = capture;
    win.render_game_to_text = () => stringifyAutomationPayload(
      {
        question: debate?.question ?? null,
        status: status === 'loading' ? 'loading' : error ? 'error' : debate?.status ?? 'idle',
        currentRound: revealCount,
        totalRounds: debate?.turns.length ?? null,
        viewMode: 'theater',
        visualizationEnabled: true,
        isSimulationComplete: debate?.result_ready ?? false,
        messageCount: visibleTurns.length,
        agentCount: debate?.participants.length ?? 0,
        branchCount: 1,
      },
      debate ? {
        scene: 'DebateArenaDOM',
        theme: debate.scene_theme,
        phase: currentPhase,
        visible_turn_count: visibleTurns.length,
      } : null,
      {
        route: window.location.pathname,
        kind: 'debate',
        error: buildAutomationErrorState(errorCode, error),
        phase: currentPhase,
        selected_phase: selectedPhase,
        is_phase_locked: phaseLocked,
        unlocked_phases: unlockedPhases,
        controls: {
          can_open_prediction: canBetNow,
          can_open_counterplay: canSubmitCounterplay,
          counterplay_used: Boolean(counterplayRecord),
          can_view_result: Boolean(debate?.result_ready),
          can_capture_screenshot: captureStatus === 'idle',
          capture_mode: 'panel',
          active_modal: showBetModal ? 'bet' : null,
          show_bet_modal: showBetModal,
          bet_submitting: betSubmitting,
          available_prediction_options: availablePredictionOptions,
          auto_reveal: autoReveal && !isInterrupted,
          cue_phase: phaseCue?.phase ?? null,
          cue_speaker: phaseCue?.speakerName ?? null,
          modal_state: betModalState,
        },
        debate: debate ? {
          motion: debate.motion,
          proposition: { score: debate.score.proposition },
          opposition: { score: debate.score.opposition },
          judge: { summary_ready: debate.result_ready },
          visible_quotes: visibleTurns.slice(-3).map((turn) => turn.content),
          bet_window_open: canBetNow,
          counterplay: counterplayPlan ? {
            kind: counterplayPlan.kind,
            target_value: counterplayPlan.targetValue,
            confidence: counterplayPlan.confidence,
            label: counterplayPlan.label,
          } : null,
          counterplay_used: Boolean(counterplayRecord),
          stage_turn_count: stageTurns.length,
          unlocked_phase_count: phaseUnlockCount,
          latest_turn_id: latestVisibleTurn?.id ?? null,
          feed_focus: feedFocusLabel,
          phase_delta: phaseScoreDelta,
          watched_dimension: watchedDimension,
          server_phase_insights: serverPhaseInsights,
          room_map: roomInsights,
          stage_summaries: phaseSummaries,
          selected_phase_summary: selectedPhaseSummary,
          overview_cards: overviewCards,
        } : null,
      },
    );

    return () => {
      if (win.render_game_to_text) delete win.render_game_to_text;
      if (win.advanceTime) delete win.advanceTime;
      if (win.capture_game_screenshot === capture) delete win.capture_game_screenshot;
    };
  }, [
    autoReveal,
    betSubmitting,
    betModalState,
    canBetNow,
    captureStatus,
    currentPhase,
    availablePredictionOptions,
    debate,
    error,
    errorCode,
    isInterrupted,
    feedFocusLabel,
    phaseLocked,
    phaseScoreDelta,
    revealCount,
    latestVisibleTurn?.id,
    selectedPhase,
    showBetModal,
    phaseCue,
    phaseUnlockCount,
    stageTurns.length,
    status,
    t,
    unlockedPhases,
    visibleTurns,
    watchedDimension,
    canSubmitCounterplay,
    counterplayPlan,
    counterplayRecord,
    overviewCards,
    phaseSummaries,
    roomInsights,
    serverPhaseInsights,
    selectedPhaseSummary,
  ]);

  const persistCounterplay = (payload: {
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
    phase: DebatePhase;
    variant: 'balanced' | 'reversal';
  }) => {
    if (!id) return null;
    const record = saveDebateCounterplay({
      debateId: id,
      kind: payload.kind,
      targetValue: payload.targetValue,
      confidence: payload.confidence,
      phase: payload.phase,
      variant: payload.variant,
      createdAt: new Date().toISOString(),
    });
    setCounterplayRecord(record);
    return record;
  };

  const handleBetSubmit = async (payload: {
    kind: 'winner' | 'verdict_tone';
    targetValue: string;
    confidence: number;
  }) => {
    if (!id || !canBetNow) return;
    if (!availablePredictionOptions[payload.kind].includes(payload.targetValue)) {
      setBetNotice(t('debate.bet_error'));
      return;
    }
    setBetSubmitting(true);
    try {
      await predictDebate(id, {
        kind: payload.kind,
        targetValue: payload.targetValue,
        confidence: payload.confidence,
        userId: apiUserId,
        userName: directorIdentity.userName,
        ...(betPreset ? {
          isCounterplay: true,
          counterplayPhase: betPreset.phase,
          counterplayVariant: betPreset.variant,
        } : {}),
      });
      if (betPreset) {
        persistCounterplay({
          kind: payload.kind,
          targetValue: payload.targetValue,
          confidence: payload.confidence,
          phase: betPreset.phase,
          variant: betPreset.variant,
        });
      }
      setBetNotice(t('debate.bet_success'));
      setBetPreset(null);
      setShowBetModal(false);
    } catch (nextError) {
      setBetNotice(getLocalizedApiErrorMessage(nextError, t, t('debate.bet_error')));
      throw nextError;
    } finally {
      setBetSubmitting(false);
    }
  };

  const handleOpenBet = () => {
    setBetPreset(null);
    setShowBetModal(true);
  };

  const handleOpenCounterplay = () => {
    if (!counterplayPlan || !canSubmitCounterplay) return;
    setBetPreset({
      kind: counterplayPlan.kind,
      targetValue: counterplayPlan.targetValue,
      confidence: counterplayPlan.confidence,
      strategyHint: counterplayPlan.strategyHint,
      phase: selectedPhase as DebatePhase,
      variant: counterplayPlan.variant,
    });
    setShowBetModal(true);
  };

  const handleQuickCounterplay = async () => {
    if (!id || !counterplayPlan || !canSubmitCounterplay || betSubmitting) return;
    setBetSubmitting(true);
    try {
      await predictDebate(id, {
        kind: counterplayPlan.kind,
        targetValue: counterplayPlan.targetValue,
        confidence: counterplayPlan.confidence,
        userId: apiUserId,
        userName: directorIdentity.userName,
        isCounterplay: true,
        counterplayPhase: selectedPhase as DebatePhase,
        counterplayVariant: counterplayPlan.variant,
      });
      persistCounterplay({
        kind: counterplayPlan.kind,
        targetValue: counterplayPlan.targetValue,
        confidence: counterplayPlan.confidence,
        phase: selectedPhase as DebatePhase,
        variant: counterplayPlan.variant,
      });
      setBetNotice(t('debate.counterplay_success'));
    } catch (nextError) {
      setBetNotice(getLocalizedApiErrorMessage(nextError, t, t('debate.bet_error')));
    } finally {
      setBetSubmitting(false);
    }
  };

  const handleCapture = async () => {
    await captureScreenshot({ selector: '.debate-shell', captureTarget: 'element' });
    setCaptureNotice(t('debate.capture_done'));
    window.setTimeout(() => setCaptureNotice(''), 1600);
  };

  const debateStatusLabel = debate?.status ? t(`debate.status_${debate.status}`) : t('common.loading');
  const displayedMotion = (debate?.motion ?? t('debate.loading')).replace(/^(?:motion|议题|辩题|辯題)\s*[:：]\s*/i, '');

  if (status === 'deleted') {
    return <div className="debate-shell"><section className="debate-recovery-panel" role="status">
      <h1>{t('debate.deleted_title')}</h1>
      <p>{t('debate.deleted_notice')}</p>
      <button type="button" className="btn btn-primary" onClick={() => navigate('/history')}>{t('debate.open_experiments')}</button>
    </section></div>;
  }

  return (
    <div className="debate-shell">
      <div className="debate-shell__inner">
        <section
          className="debate-hero"
          style={themeAsset ? { backgroundImage: `url(${themeAsset})` } : undefined}
        >
          <div className="debate-hero__content">
            <div className="debate-hero__top">
              <span className="debate-hero__eyebrow">
                <img className="debate-hero__banner" src={DEBATE_UI_ASSETS.stageBanner} alt="" aria-hidden="true" />
                {t('debate.entry_title')}
                {themeLabel ? ` · ${themeLabel}` : ''}
              </span>
              <span className={`debate-hero__status ${debate?.result_ready ? 'debate-hero__status--done' : ''}`}>
                {debateStatusLabel}
              </span>
              <DebateStageRibbon
                activePhase={selectedPhase as DebatePhase}
                unlockedPhases={unlockedPhases as DebatePhase[]}
                onSelect={(phase) => {
                  setSelectedPhase(phase);
                  setPhaseLocked(phase !== currentPhase);
                }}
              />
            </div>

            <div className="debate-hero__copy">
              <h1 className="debate-hero__title">{t(debate?.status === 'cancelled' ? 'debate.cancelled_title' : debate?.status === 'error' ? 'debate.failed_title' : debate?.status === 'done' ? 'debate.saved_debate_title' : 'debate.live_title')}</h1>
              <p className="debate-hero__subtitle">{t(debate && ['cancelled', 'error', 'done'].includes(debate.status) ? 'debate.preserved_subtitle' : 'debate.live_subtitle')}</p>
              <p className="debate-hero__motion">
                <strong>{t('debate.motion_label')}:</strong> {displayedMotion}
              </p>
            </div>

            <div className="debate-hero__bottom">
              <DebateMomentumBar
                propositionScore={debate?.score.proposition ?? 0}
                oppositionScore={debate?.score.opposition ?? 0}
                audienceMeter={debate?.score.audience_meter ?? 0}
                frameSrc={DEBATE_UI_ASSETS.scoreMeter}
              />
              {isInterrupted && <p role="note">{t('debate.provisional_score_notice')}</p>}
              <div className="debate-controls">
                <button type="button" className="btn debate-btn-back" onClick={() => navigate('/')}>
                  {t('debate.back_home')}
                </button>
                {!debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-ghost debate-primary-cta debate-primary-cta--hero"
                    onClick={handleOpenBet}
                    disabled={!canBetNow}
                  >
                    {t('debate.open_bet')}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={handleCapture}>
                  {t('debate.capture_panel')}
                </button>
                {debate?.result_ready && (
                  <button
                    type="button"
                    className="btn btn-primary debate-primary-cta debate-primary-cta--hero"
                    onClick={() => navigate(`/debate/${id}/result`)}
                  >
                    {t('debate.view_result')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        {debate && <DebateLifecycleControls key={debate.id} debate={debate} onReveal={() => {
          setRevealCount(debate.turns.length);
          setAutoReveal(false);
          setPhaseLocked(false);
          setSelectedPhase(debate.turns.at(-1)?.phase ?? debate.current_phase);
          requestAnimationFrame(() => document.getElementById('debate-stage-panel')?.focus());
        }} />}

        {betNotice && <p className="debate-phase-chip">{betNotice}</p>}
        {captureNotice && <p className="debate-phase-chip">{captureNotice}</p>}
        <p className="debate-phase-chip">{t('debate.runtime_preset_not_applicable')}</p>
        {error && (
          <p className="debate-modal__error">
            {errorCode ? getLocalizedApiErrorMessage({ code: errorCode }, t, error) : error}
          </p>
        )}
        {phaseCueCopy && debate?.status === 'live' && (
          <section
            key={phaseCue?.token}
            className="debate-live-cue"
            data-testid="debate-live-cue"
            aria-live="polite"
          >
            <span className="debate-live-cue__eyebrow">{getDebatePhaseLabel(t, phaseCue?.phase ?? currentPhase)}</span>
            <strong className="debate-live-cue__title">{phaseCueCopy}</strong>
            <span className="debate-live-cue__meta">
              {phaseCue?.speakerSide ? getDebateSideLabel(t, phaseCue.speakerSide) : stageStateLabel}
            </span>
          </section>
        )}
        <div className="debate-mobile-rail" aria-label={t('debate.mobile_primary_actions')}>
          <button
            type="button"
            className="btn debate-btn-back"
            onClick={() => navigate('/')}
          >
            {t('debate.back_home')}
          </button>
          {!debate?.result_ready ? (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={handleOpenBet}
              disabled={!canBetNow}
            >
              {t('debate.open_bet')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary debate-primary-cta debate-primary-cta--rail"
              onClick={() => navigate(`/debate/${id}/result`)}
            >
              {t('debate.view_result')}
            </button>
          )}
        </div>

        <div className="debate-layout">
          <div className="debate-main">
            <section
              className="debate-panel"
              id="debate-stage-panel"
              role="tabpanel"
              tabIndex={-1}
              aria-labelledby={`debate-stage-tab-${selectedPhase}`}
            >
              <div className="debate-panel__header">
                <h2>{t(debate?.status === 'live' ? 'debate.feed_title' : 'debate.saved_turns_title')}</h2>
                <div className="debate-feed-header-meta">
                  <span className="debate-phase-chip debate-phase-chip--accent">
                    {unlockProgressLabel}
                  </span>
                  <span className="debate-phase-chip">{stageStateLabel}</span>
                </div>
                <div className="debate-controls">
                  {!isInterrupted && <button type="button" className="btn btn-ghost" onClick={() => setAutoReveal((current) => !current)}>
                    {t('debate.auto_reveal')}: {t(autoReveal ? 'debate.state_on' : 'debate.state_off')}
                  </button>}
                  {phaseLocked && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setPhaseLocked(false);
                        setSelectedPhase(currentPhase);
                      }}
                    >
                      {t(debate?.status === 'live' ? 'debate.return_to_live' : 'debate.return_to_latest')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    disabled={!debate?.turns.length}
                    onClick={() => {
                      setAutoReveal(false);
                      setPhaseLocked(false);
                      setRevealCount(debate?.turns.length ?? 0);
                      setSelectedPhase(debate?.result_ready ? 'verdict' : debate?.turns.at(-1)?.phase ?? debate?.current_phase ?? 'opening');
                    }}
                  >
                    {t(debate?.result_ready ? 'debate.skip_to_verdict' : 'debate.open_preserved_turns')}
                  </button>
                </div>
              </div>
              {/* D-2: SpotlightCard for latest visible turn */}
              {latestVisibleTurn && selectedPhase === currentPhase && (
                <article
                  data-testid="debate-live-turn"
                  className={`debate-turn-card debate-turn-card--${latestVisibleTurn.speaker_side} debate-turn-card--hot`}
                >
                  <div className="debate-turn-card__meta">
                    <span className={`debate-speaker-initial debate-speaker-initial--${latestVisibleTurn.speaker_side}`} aria-hidden="true">
                      {getFirstGrapheme(latestVisibleTurn.speaker_name)}
                    </span>
                    <strong>{latestVisibleTurn.speaker_name}</strong>
                    <div className="debate-turn-card__tags">
                      <span className={`debate-phase-chip${latestVisibleTurn.speaker_side === 'opposition' ? ' debate-phase-chip--con' : latestVisibleTurn.speaker_side === 'judge' ? ' debate-phase-chip--judge' : ''}`}>
                        {getDebateSideLabel(t, latestVisibleTurn.speaker_side)}
                      </span>
                    </div>
                  </div>
                  <p className="debate-turn-card__content">
                    {spotlightExpanded || latestVisibleTurn.content.length <= SPOTLIGHT_TRUNCATE_LEN
                      ? latestVisibleTurn.content
                      : latestVisibleTurn.content.slice(0, SPOTLIGHT_TRUNCATE_LEN) + '…'}
                  </p>
                  {latestVisibleTurn.content.length > SPOTLIGHT_TRUNCATE_LEN && (
                    <button
                      type="button"
                      className="debate-spotlight-expand"
                      onClick={() => setSpotlightExpanded((p) => !p)}
                      aria-expanded={spotlightExpanded}
                    >
                      {spotlightExpanded ? t('shared.foldable.collapse') : t('shared.foldable.show_full')}
                      {' '}{spotlightExpanded ? '▲' : '▼'}
                    </button>
                  )}
                </article>
              )}
              <div className="debate-panel__body">
                {feedFocusLabel && (
                  <div className="debate-feed-focus" data-testid="debate-feed-focus">
                    <span className="debate-feed-focus__dot" aria-hidden="true" />
                    <div className="debate-feed-focus__copy">
                      <strong>{getDebatePhaseLabel(t, currentPhase)}</strong>
                      <p>{feedFocusLabel}</p>
                    </div>
                  </div>
                )}
                {stageTurns.length > 0 ? (
                  <div className="debate-turn-list">
                    {stageTurns.map((turn) => {
                      const isCurrentPhaseTurn = turn.phase === currentPhase;
                      const isPastTurn = !isCurrentPhaseTurn;
                      const isExpanded = expandedPastTurnIds.has(turn.id);

                      if (isPastTurn) {
                        return (
                          <FoldableTurn
                            key={turn.id}
                            data-testid={`debate-fold-${turn.id}`}
                            speaker={turn.speaker_name}
                            content={turn.content}
                            isCollapsed={!isExpanded}
                            speakerIndex={turn.speaker_side === 'proposition' ? 0 : turn.speaker_side === 'opposition' ? 1 : 2}
                            className={`debate-fold--${turn.speaker_side}`}
                            onToggle={() => {
                              setExpandedPastTurnIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(turn.id)) {
                                  next.delete(turn.id);
                                } else {
                                  next.add(turn.id);
                                }
                                return next;
                              });
                            }}
                            badge={
                              <>
                                <span className={`debate-speaker-initial debate-speaker-initial--${turn.speaker_side}`} aria-hidden="true">
                                  {getFirstGrapheme(turn.speaker_name)}
                                </span>
                                <span className={`debate-phase-chip${turn.speaker_side === 'opposition' ? ' debate-phase-chip--con' : turn.speaker_side === 'judge' ? ' debate-phase-chip--judge' : ''}`}>
                                  {getDebateSideLabel(t, turn.speaker_side)}
                                </span>
                              </>
                            }
                          />
                        );
                      }

                      return (
                        <article
                          key={turn.id}
                          className={`debate-turn-card debate-turn-card--${turn.speaker_side} ${turn.id === latestStageTurn?.id ? 'debate-turn-card--latest' : ''} ${turn.id === latestVisibleTurn?.id && selectedPhase === currentPhase ? 'debate-turn-card--hot' : ''}`}
                        >
                          <div className="debate-turn-card__meta">
                            <span className={`debate-speaker-initial debate-speaker-initial--${turn.speaker_side}`} aria-hidden="true">
                              {getFirstGrapheme(turn.speaker_name)}
                            </span>
                            <strong>{turn.speaker_name}</strong>
                            <div className="debate-turn-card__tags">
                              <span className={`debate-phase-chip${turn.speaker_side === 'opposition' ? ' debate-phase-chip--con' : turn.speaker_side === 'judge' ? ' debate-phase-chip--judge' : ''}`}>{getDebateSideLabel(t, turn.speaker_side)}</span>
                              {turn.score_delta && (
                                <span className="debate-phase-chip">
                                  {(turn.score_delta.proposition ?? 0) === (turn.score_delta.opposition ?? 0)
                                    ? t('debate.turn_swing_even')
                                    : t('debate.turn_swing_edge', {
                                      side: getDebateSideLabel(
                                        t,
                                        (turn.score_delta.proposition ?? 0) > (turn.score_delta.opposition ?? 0)
                                          ? 'proposition'
                                          : 'opposition',
                                      ),
                                      value: Math.abs((turn.score_delta.proposition ?? 0) - (turn.score_delta.opposition ?? 0)),
                                    })}
                                </span>
                              )}
                            </div>
                          </div>
                          <p className="debate-turn-card__content">{turn.content}</p>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p className="debate-empty-state">{t('debate.loading')}</p>
                )}
              </div>
            </section>

            {/* D-extra: Situation Grid moved to bottom of debate-main */}
            <section className="debate-situation-grid" aria-label={t('debate.overview_room_title')}>
              {overviewCards.map((card) => (
                <article key={card.title} className="debate-situation-card">
                  <span className="debate-situation-card__eyebrow">{card.title}</span>
                  <strong className="debate-situation-card__value">{card.value}</strong>
                  <p className="debate-situation-card__detail">{card.detail}</p>
                </article>
              ))}
            </section>
          </div>

          <aside className="debate-side">
            {/* D-5: Score Grid moved to top of sidebar */}
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h2>{t('debate.participants_title')}</h2>
                <span className="debate-phase-chip">
                  {t('debate.current_phase')}: {getDebatePhaseLabel(t, currentPhase)}
                </span>
              </div>
              <div className="debate-panel__body">
                <div className="debate-score-grid">
                  {debate?.participants.map((participant) => (
                    <DebateScoreCard
                      key={participant.side}
                      sideLabel={getDebateSideLabel(t, participant.side)}
                      role={participant.role}
                      persona={participant.persona}
                      badgeSrc={
                        participant.side === 'proposition'
                          ? DEBATE_UI_ASSETS.badgeProposition
                          : participant.side === 'opposition'
                            ? DEBATE_UI_ASSETS.badgeOpposition
                            : DEBATE_UI_ASSETS.badgeJudge
                      }
                      score={
                        participant.side === 'proposition'
                          ? debate.score.proposition
                          : participant.side === 'opposition'
                            ? debate.score.opposition
                            : debate.result_ready
                              ? t('debate.judge_verdict_ready')
                              : t('debate.judge_pending')
                      }
                      active={
                        participant.side === activeSpeakerSide
                        || (participant.side === 'judge' && currentPhase === 'verdict')
                      }
                    />
                  ))}
                </div>
                <div className="debate-room-grid">
                  {roomInsights.map((insight) => {
                    const isExpanded = expandedRoomCards.has(insight.side);
                    const personaLong = Boolean(insight.persona && insight.persona.length > 40);
                    const noteLong = Boolean(insight.note && insight.note.length > 60);
                    const hasExpandable = personaLong || noteLong;
                    return (
                      <article
                        key={insight.side}
                        className={`debate-room-card debate-room-card--${insight.side} ${insight.active ? 'debate-room-card--active' : ''}`}
                      >
                        <div className="debate-room-card__meta">
                          <strong>{getDebateSideLabel(t, insight.side)}</strong>
                          <span className="debate-phase-chip">{insight.statusLabel}</span>
                        </div>
                        <p className="debate-room-card__role">{insight.role}</p>
                        {insight.persona ? (
                          <p
                            className={`debate-room-card__persona ${isExpanded ? 'debate-room-card__persona--expanded' : ''}`}
                            title={isExpanded ? undefined : insight.persona}
                          >
                            {insight.persona}
                          </p>
                        ) : null}
                        <p className={`debate-room-card__note ${isExpanded ? 'debate-room-card__note--expanded' : ''}`}>
                          {insight.note}
                        </p>
                        {hasExpandable ? (
                          <button
                            type="button"
                            className="debate-card-expand-btn"
                            onClick={() => toggleRoomCard(insight.side)}
                            aria-expanded={isExpanded}
                          >
                            {isExpanded ? t('shared.foldable.collapse_text') : t('shared.foldable.show_full_text')}
                          </button>
                        ) : null}
                        {insight.sourceLabel && (
                          <span className="debate-room-card__source">{insight.sourceLabel}</span>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            </section>

            {/* D-4: Strategy panel with shadcn Accordion */}
            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.strategy_title')}</h3>
                <span className="debate-phase-chip">{betWindowLabel}</span>
              </div>
              <div className="debate-panel__body">
                <Accordion
                  type="multiple"
                  value={strategyOpenItems}
                  onValueChange={setStrategyOpenItems}
                  aria-label={t('debate.strategy_accordion_label')}
                >
                  <AccordionItem value="clash">
                    <AccordionTrigger>
                      <div className="debate-turn-card__meta">
                        <strong>{t('debate.strategy_current_clash')}</strong>
                        <span>{getDebatePhaseLabel(t, selectedPhase)}</span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="debate-rule-copy">{clashCopy}</p>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="pressure">
                    <AccordionTrigger>
                      <div className="debate-turn-card__meta">
                        <strong>{t('debate.strategy_pressure')}</strong>
                        <span>{phaseLeaderLabel}</span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="debate-rule-copy">{phasePressureCopy}</p>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="watchlist">
                    <AccordionTrigger>
                      <div className="debate-turn-card__meta">
                        <strong>{t('debate.strategy_watchlist')}</strong>
                        <span>{getDebateDimensionLabel(t, watchedDimension)}</span>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent>
                      <p className="debate-rule-copy">
                        {canBetNow ? t('debate.watchlist_open') : t('debate.watchlist_locked')}
                      </p>
                    </AccordionContent>
                  </AccordionItem>
                  {counterplayPlan && (
                    <AccordionItem value="counterplay">
                      <AccordionTrigger>
                        <div className="debate-turn-card__meta">
                          <strong>{t('debate.counterplay_title')}</strong>
                          <span>{counterplayPlan.label}</span>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <p className="debate-rule-copy">{counterplayPlan.summary}</p>
                        <div className="debate-counterplay-actions">
                          <button
                            type="button"
                            className="btn btn-primary debate-counterplay-btn"
                            onClick={handleQuickCounterplay}
                            disabled={!canSubmitCounterplay || betSubmitting}
                          >
                            {betSubmitting ? t('debate.bet_submitting') : t('debate.counterplay_submit')}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost debate-counterplay-btn"
                            onClick={handleOpenCounterplay}
                            disabled={!canSubmitCounterplay || betSubmitting}
                          >
                            {t('debate.counterplay_apply')}
                          </button>
                        </div>
                        {counterplayRecord && (
                          <p className="debate-rule-copy">{t('debate.counterplay_used')}</p>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  )}
                </Accordion>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.rules_title')}</h3>
              </div>
              <div className="debate-panel__body">
                <p className="debate-rule-copy">{t('debate.rules_body')}</p>
              </div>
            </section>

            <section className="debate-panel">
              <div className="debate-panel__header">
                <h3>{t('debate.stage_map_title')}</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="debate-phase-chip">{getDebatePhaseLabel(t, selectedPhase)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-testid="debate-stage-map-toggle"
                    aria-expanded={stageMapOpen}
                    onClick={() => setStageMapOpen(o => !o)}
                    style={{ fontSize: '0.78rem', padding: '4px 10px' }}
                  >
                    {stageMapOpen
                      ? t('common.collapse', 'Collapse')
                      : t('common.expand', 'Expand')}
                  </button>
                </div>
              </div>
              {stageMapOpen && (
              <div className="debate-panel__body">
                <p className="debate-rule-copy debate-stage-map__intro">{t('debate.stage_map_subtitle')}</p>
                <div className="debate-stage-summary-list">
                  {phaseSummaries.map((summary) => {
                    const statusLabel = !summary.unlocked
                      ? t(isInterrupted ? 'debate.stage_not_run' : 'debate.stage_status_waiting')
                      : isInterrupted ? t('debate.room_state_saved')
                      : summary.phase === currentPhase && !phaseLocked
                        ? t('debate.stage_status_live')
                        : summary.phase === selectedPhase && phaseLocked
                          ? t('debate.stage_status_locked')
                          : t('debate.stage_status_complete');

                    const swingLabel = summary.swing === 0
                      ? t('debate.stage_swing_even')
                      : t('debate.stage_swing_edge', {
                        side: getLeaderLabel(t, summary.leader),
                        value: summary.swing,
                      });
                    const serverInsight = serverPhaseInsightMap.get(summary.phase);

                    return (
                      <article
                        key={summary.phase}
                        className={`debate-stage-summary-card ${summary.phase === selectedPhase ? 'debate-stage-summary-card--active' : ''}`}
                      >
                        <div className="debate-stage-summary-card__meta">
                          <span className="debate-phase-chip">{getDebatePhaseLabel(t, summary.phase)}</span>
                          <span>{statusLabel}</span>
                        </div>
                        <strong className="debate-stage-summary-card__value">
                          {summary.turnCount > 0
                            ? t('debate.stage_turn_count', { count: summary.turnCount })
                            : t('debate.loading')}
                        </strong>
                        <p className="debate-stage-summary-card__detail">{swingLabel}</p>
                        {serverInsight?.commentary && (
                          <p className="debate-stage-summary-card__detail">{serverInsight.commentary}</p>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
              )}
            </section>
          </aside>
        </div>

        {/* P1-5: Live Argument Map — full-width below layout */}
        {argMapEnabled && id && (
          <section className="debate-panel debate-panel--argument-map-full">
            <div className="debate-panel__header">
              <h3>{t('argument.live_title', 'Argument Map')}</h3>
              <button
                type="button"
                className="btn btn-ghost"
                aria-expanded={argMapOpen}
                aria-controls={liveArgumentMapPanelId}
                onClick={() => setArgMapOpen(o => !o)}
              >
                {argMapOpen
                  ? t('argument.live_collapse', 'Collapse')
                  : t('argument.live_expand', 'Expand')}
              </button>
            </div>
            {argMapOpen && (
              <div id={liveArgumentMapPanelId} className="debate-panel__body">
                <ArgumentMap
                  debateId={id}
                  autoTour={!isInterrupted && Boolean(debate?.result_ready)}
                  visible={argMapOpen}
                  refreshTrigger={argMapRefreshKey}
                  conversationScenarioId={null}
                />
              </div>
            )}
          </section>
        )}
      </div>

      {showBetModal && (
        <DebateBetModal
          loading={betSubmitting}
          availableOptions={availablePredictionOptions}
          initialSelection={betPreset}
          strategyHint={betPreset?.strategyHint ?? null}
          onClose={() => {
            setShowBetModal(false);
            setBetPreset(null);
          }}
          onSubmit={handleBetSubmit}
          onAutomationStateChange={setBetModalState}
        />
      )}
    </div>
  );
}
