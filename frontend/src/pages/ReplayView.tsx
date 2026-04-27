import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { buildSessionHeaders } from '../api/client';
import { useCapabilityCheck } from '../hooks/useCapabilityCheck';
import {
  useReplayTimeline,
  type PlaybackSpeed,
} from '../hooks/useReplayTimeline';
import { ReplayAgentQueue, type ReplayAgentInfo } from '../components/replay/ReplayAgentQueue';
import { ReplayEmptyState } from '../components/replay/ReplayEmptyState';
import { ReplayPlaybackControl } from '../components/replay/ReplayPlaybackControl';
import { ReplayTimelineScrubber } from '../components/replay/ReplayTimelineScrubber';

// ── Types ─────────────────────────────────────────────────────

interface ReplayTraceNode {
  branch_id: string;
  parent_branch_id: string | null;
  replay_source_branch_id: string | null;
  origin_round: number;
  replay_kind: string;
  status: string;
  created_at: string;
}

interface ReplayTraceResponse {
  nodes: ReplayTraceNode[];
  next_cursor: string | null;
}

interface CausalGraphNode {
  id: string;
  key: string;
  type: string;
  label: string;
  round: number | null;
  payload: unknown;
}

interface CausalGraphResponse {
  id: string;
  nodes: CausalGraphNode[];
  edges: unknown[];
}

// ── Helpers ───────────────────────────────────────────────────

function readPayload(node: CausalGraphNode): Record<string, unknown> {
  return (typeof node.payload === 'object' && node.payload !== null && !Array.isArray(node.payload))
    ? node.payload as Record<string, unknown>
    : {};
}

function extractAgentsFromGraph(graph: CausalGraphResponse | null): ReplayAgentInfo[] {
  if (!graph) return [];
  const agentMap = new Map<string, ReplayAgentInfo>();
  for (const node of graph.nodes ?? []) {
    const payload = readPayload(node);
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : null;
    if (!agentId || agentMap.has(agentId)) continue;
    const agentName = typeof payload.agent_name === 'string' && payload.agent_name.trim()
      ? payload.agent_name.trim()
      : agentId;
    agentMap.set(agentId, { id: agentId, name: agentName });
  }
  return [...agentMap.values()];
}

function buildFrames(
  trace: ReplayTraceResponse | null,
  graph: CausalGraphResponse | null,
): { count: number; nodeByFrame: Map<number, CausalGraphNode | null>; nodesByFrame: Map<number, CausalGraphNode[]>; turnIds: string[]; frameToRound: number[] } {
  const rounds = new Set<number>();
  if (trace?.nodes) {
    for (const n of trace.nodes) {
      if (typeof n.origin_round === 'number' && n.origin_round >= 0) rounds.add(n.origin_round);
    }
  }
  if (graph?.nodes) {
    for (const n of graph.nodes) {
      if (typeof n.round === 'number' && n.round >= 0) rounds.add(n.round);
    }
  }

  const nodesByRound = new Map<number, CausalGraphNode[]>();
  const nodeByRound = new Map<number, CausalGraphNode | null>();
  if (graph?.nodes) {
    for (const node of graph.nodes) {
      if (typeof node.round === 'number' && node.round >= 0) {
        if (!nodeByRound.has(node.round)) nodeByRound.set(node.round, node);
        const list = nodesByRound.get(node.round) ?? [];
        list.push(node);
        nodesByRound.set(node.round, list);
      }
    }
  }

  const sortedRounds = [...rounds].sort((a, b) => a - b);
  const populatedRounds = sortedRounds.filter(r => (nodesByRound.get(r)?.length ?? 0) > 0);
  const frameToRound = populatedRounds.length > 0 ? populatedRounds : sortedRounds;
  const count = frameToRound.length;

  const nodeByFrame = new Map<number, CausalGraphNode | null>();
  const nodesByFrame = new Map<number, CausalGraphNode[]>();
  for (let i = 0; i < count; i++) {
    const round = frameToRound[i];
    nodeByFrame.set(i, nodeByRound.get(round) ?? null);
    nodesByFrame.set(i, nodesByRound.get(round) ?? []);
  }

  const turnIds = frameToRound.map(r => `turn_${r}`);
  return { count, nodeByFrame, nodesByFrame, turnIds, frameToRound };
}

function pickActiveAgent(
  frame: number,
  nodeByFrame: Map<number, CausalGraphNode | null>,
): string | null {
  const node = nodeByFrame.get(frame);
  if (!node) return null;
  const payload = readPayload(node);
  return typeof payload.agent_id === 'string' ? payload.agent_id : null;
}

function hashToHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

const EMOTION_ICONS: Record<string, string> = {
  aggressive: '\u{1F525}', angry: '\u{1F4A2}', anxious: '\u{1F630}',
  fearful: '\u{1F628}', cautious: '\u{1F914}', calm: '\u{1F343}',
  hopeful: '\u{2728}', cooperative: '\u{1F91D}', confident: '\u{1F4AA}',
  neutral: '\u{2014}', focused: '\u{1F3AF}',
};

// ── Component ─────────────────────────────────────────────────

export function ReplayView() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const {
    loading: capLoading,
    enabled,
    error: capabilityError,
    reload: reloadCapability,
  } = useCapabilityCheck('replay_trace');

  const [trace, setTrace] = useState<ReplayTraceResponse | null>(null);
  const [graph, setGraph] = useState<CausalGraphResponse | null>(null);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const encodedId = id ? encodeURIComponent(id) : '';

  const fetchAll = useCallback(async () => {
    if (!encodedId) return;
    setLoadingData(true);
    setError(null);
    setTrace(null);
    setGraph(null);
    try {
      const [traceRes, graphRes] = await Promise.all([
        fetch(`/api/scenario/${encodedId}/replay-trace`, { headers: buildSessionHeaders() }),
        fetch(`/api/scenario/${encodedId}/causal-graph`, { headers: buildSessionHeaders() }),
      ]);
      if (!traceRes.ok) {
        setError(traceRes.status);
        setTrace(null);
      } else {
        setTrace((await traceRes.json()) as ReplayTraceResponse);
      }
      if (graphRes.ok) {
        setGraph((await graphRes.json()) as CausalGraphResponse);
      } else {
        setGraph(null);
      }
    } catch {
      setError(-1);
      setTrace(null);
      setGraph(null);
    } finally {
      setLoadingData(false);
    }
  }, [encodedId]);

  useEffect(() => {
    if (!enabled || capabilityError) return;
    fetchAll();
  }, [capabilityError, enabled, fetchAll]);

  const { count: totalFrames, nodeByFrame, nodesByFrame, frameToRound } = useMemo(
    () => buildFrames(trace, graph),
    [trace, graph],
  );
  const agents = useMemo(() => extractAgentsFromGraph(graph), [graph]);

  const {
    frameIndex,
    playing,
    speed,
    setFrame,
    play,
    pause,
    step,
    skipToEnd,
    setSpeed,
  } = useReplayTimeline({ totalFrames });

  useEffect(() => {
    if (rootRef.current && typeof rootRef.current.focus === 'function') {
      try {
        rootRef.current.focus({ preventScroll: true });
      } catch { /* jsdom */ }
    }
  }, []);

  const activeAgentId = useMemo(
    () => pickActiveAgent(frameIndex, nodeByFrame),
    [frameIndex, nodeByFrame],
  );

  // Loading state
  if (capLoading || (!capabilityError && enabled && loadingData)) {
    return (
      <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
        <div className="replay-loading">
          <div className="replay-loading__spinner" />
          <p className="replay-loading__text">{t('common.loading', 'Loading...')}</p>
        </div>
      </div>
    );
  }

  // Capability error / disabled
  if (capabilityError || !enabled) {
    return (
      <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
        <header className="replay-header">
          <h1 className="replay-header__title">{t('replay.title', 'Replay')}</h1>
        </header>
        <ReplayEmptyState
          title={capabilityError
            ? t('replay.feature_unavailable_title', 'Replay availability could not be checked')
            : t('replay.feature_disabled_title', 'Replay trace is unavailable')}
          message={capabilityError
            ? t('replay.feature_unavailable_description', 'Unable to confirm whether replay trace is available right now. Please retry.')
            : t('replay.feature_disabled_description', 'This server has replay trace disabled for this environment.')}
          onRetry={capabilityError ? () => void reloadCapability?.() : undefined}
          retryLabel={t('common.retry', 'Retry')}
        />
        <div className="replay-header__back-row">
          <Link to="/" className="replay-header__link">{t('common.back_home', 'Back to Home')}</Link>
        </div>
      </div>
    );
  }

  const hasTrace = (trace?.nodes?.length ?? 0) > 0;
  const hasFrames = totalFrames > 0;
  const showEmpty = !!error || !hasTrace || !hasFrames;
  const currentRound = frameToRound[frameIndex];

  return (
    <div ref={rootRef} data-testid="replay-view-root" className="replay-view-root replay-shell" tabIndex={-1}>
      {/* ── Header ── */}
      <header className="replay-header">
        <div className="replay-header__left">
          <Link to="/" className="replay-header__back" aria-label={t('common.back_home', 'Back to Home')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <h1 className="replay-header__title">{t('replay.title', 'Replay')}</h1>
          {!showEmpty && currentRound != null && (
            <span className="replay-header__badge">
              R{currentRound}
            </span>
          )}
        </div>
        <div className="replay-header__right">
          {!showEmpty && id && (
            <Link to={`/sim/${encodeURIComponent(id)}`} className="replay-header__theater-btn">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6.5 6.5L10.5 8.5L6.5 10.5V6.5Z" fill="currentColor" />
              </svg>
              {t('replay.open_pixel_theater', 'Open Pixel Theater')}
            </Link>
          )}
        </div>
      </header>

      {showEmpty ? (
        <ReplayEmptyState
          message={error === -1
            ? t('replay.empty.offline', 'Network error loading replay trace.')
            : t('replay.empty.no_data', 'No replay lineage for this scenario yet.')}
          onRetry={fetchAll}
          retryLabel={t('replay.empty.retry', 'Retry')}
          title={t('replay.empty.title', 'No replay trace available')}
        />
      ) : (
        <>
          {/* ── Transport bar ── */}
          <div className="replay-transport">
            <ReplayPlaybackControl
              playing={playing}
              speed={speed}
              canStepBack={frameIndex > 0}
              canStepForward={frameIndex < totalFrames - 1}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onPlay={play}
              onPause={pause}
              onSkipToEnd={skipToEnd}
              onSpeedChange={(s: PlaybackSpeed) => setSpeed(s)}
            />
            <ReplayTimelineScrubber
              frameIndex={frameIndex}
              totalFrames={totalFrames}
              onFrameChange={setFrame}
              ariaLabel={t('replay.scrubber.aria_label', 'Replay timeline')}
            />
          </div>

          {/* ── Agents ── */}
          <section aria-label={t('replay.agent_queue.aria_label', 'Replay agent queue')} className="replay-agents-section">
            <ReplayAgentQueue agents={agents} activeAgentId={activeAgentId} />
          </section>

          {/* ── Frame metadata ── */}
          <div className="replay-meta">
            <span className="replay-meta__frame">
              {t('replay.trace.frame_count_label', 'Frame')} {frameIndex + 1} / {totalFrames}
            </span>
            {currentRound != null && (
              <span className="replay-meta__round">Round {currentRound}</span>
            )}
            <span className="replay-meta__branches">
              {t('replay.trace.branches_label', 'Branches')}: {trace?.nodes.length ?? 0}
            </span>
          </div>

          {/* ── Trace cards ── */}
          <section aria-label={t('replay.trace.aria_label', 'Replay trace')} className="replay-trace">
            <div role="log" aria-live="polite" className="replay-trace__list">
              {(nodesByFrame.get(frameIndex) ?? []).map(node => {
                const p = readPayload(node);
                const agentId = typeof p.agent_id === 'string' ? p.agent_id : null;
                const agentName = typeof p.agent_name === 'string' && p.agent_name.trim()
                  ? p.agent_name.trim()
                  : (agentId ? agentId.slice(0, 8) : null);
                const content = typeof p.content === 'string' ? p.content : (node.label || '');
                const emotion = typeof p.emotion === 'string' ? p.emotion : null;
                const isFork = node.type === 'fork';
                const hue = agentId ? hashToHue(agentId) : 260;
                const accentColor = `oklch(65% 0.18 ${hue})`;

                if (isFork && !agentName) {
                  return (
                    <div key={node.id} className="replay-card replay-card--fork">
                      <div className="replay-card__fork-icon" aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                          <path d="M8 2V6M8 6L4 10M8 6L12 10M4 10V14M12 10V14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <div className="replay-card__fork-body">
                        <span className="replay-card__fork-label">
                          {t('replay.trace.branch_fork', 'Branch fork')}
                        </span>
                        <span className="replay-card__round">R{node.round ?? '?'}</span>
                      </div>
                      {content && <p className="replay-card__fork-detail">{content}</p>}
                    </div>
                  );
                }

                return (
                  <div
                    key={node.id}
                    className="replay-card"
                    style={{ '--card-accent': accentColor } as React.CSSProperties}
                  >
                    <div className="replay-card__header">
                      <span className="replay-card__avatar" aria-hidden="true" style={{ background: accentColor }}>
                        {agentName ? agentName.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() : '?'}
                      </span>
                      <div className="replay-card__meta">
                        <strong className="replay-card__name">{agentName ?? t('replay.trace.unknown_agent', 'System')}</strong>
                        {emotion && (
                          <span className="replay-card__emotion">
                            {EMOTION_ICONS[emotion] ?? ''} {emotion}
                          </span>
                        )}
                      </div>
                      <span className="replay-card__round">R{node.round ?? '?'}</span>
                    </div>
                    <p className="replay-card__content">{content}</p>
                  </div>
                );
              })}
              {(nodesByFrame.get(frameIndex) ?? []).length === 0 && (
                <p className="replay-trace__empty">
                  {t('replay.trace.no_events_frame', 'No events for this frame.')}
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default ReplayView;
