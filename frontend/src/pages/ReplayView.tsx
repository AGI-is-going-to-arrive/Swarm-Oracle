/* ═══════════════════════════════════════════════════════════
   FE-4 — ReplayView (`/replay/:id`)
   Independent replay path (HC-11): NO import of `replayCodec`.
   Fetches `/api/scenario/:id/replay-trace` + `/api/scenario/:id/
   causal-graph` in parallel. Wraps everything in
   `<div className="replay-view-root">` so the keyboard scope
   guard in useReplayTimeline can discriminate focus ownership
   against Phaser canvases / sibling inputs.
   ═══════════════════════════════════════════════════════════ */

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

// ── Types mirroring BE-4 / existing CausalReview ──────────────

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

// ── Helpers ────────────────────────────────────────────────────

function extractAgentsFromGraph(graph: CausalGraphResponse | null): ReplayAgentInfo[] {
  if (!graph) return [];
  const agentMap = new Map<string, ReplayAgentInfo>();
  for (const node of graph.nodes ?? []) {
    const payload = (typeof node.payload === 'object' && node.payload !== null && !Array.isArray(node.payload))
      ? node.payload as Record<string, unknown>
      : {};
    const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : null;
    if (!agentId) continue;
    if (agentMap.has(agentId)) continue;
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
): { count: number; nodeByFrame: Map<number, CausalGraphNode | null>; turnIds: string[] } {
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
  const sorted = [...rounds].sort((a, b) => a - b);
  const count = sorted.length > 0 ? sorted[sorted.length - 1] + 1 : 0;

  const nodeByFrame = new Map<number, CausalGraphNode | null>();
  if (graph?.nodes) {
    for (const node of graph.nodes) {
      if (typeof node.round === 'number' && node.round >= 0) {
        if (!nodeByFrame.has(node.round)) nodeByFrame.set(node.round, node);
      }
    }
  }
  const turnIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    turnIds.push(`turn_${i}`);
  }
  return { count, nodeByFrame, turnIds };
}

function pickActiveAgent(
  frame: number,
  nodeByFrame: Map<number, CausalGraphNode | null>,
): string | null {
  const node = nodeByFrame.get(frame);
  if (!node) return null;
  const payload = (typeof node.payload === 'object' && node.payload !== null && !Array.isArray(node.payload))
    ? node.payload as Record<string, unknown>
    : {};
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : null;
  return agentId;
}

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
        const payload = (await traceRes.json()) as ReplayTraceResponse;
        setTrace(payload);
      }
      if (graphRes.ok) {
        const graphPayload = (await graphRes.json()) as CausalGraphResponse;
        setGraph(graphPayload);
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

  const { count: totalFrames, nodeByFrame } = useMemo(
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

  // Auto-focus root on mount so keyboard shortcuts work immediately (they
  // rely on activeElement being inside `.replay-view-root`).
  useEffect(() => {
    if (rootRef.current && typeof rootRef.current.focus === 'function') {
      try {
        rootRef.current.focus({ preventScroll: true });
      } catch {
        // jsdom may not support focus options — safe to ignore.
      }
    }
  }, []);

  const activeAgentId = useMemo(
    () => pickActiveAgent(frameIndex, nodeByFrame),
    [frameIndex, nodeByFrame],
  );

  if (capLoading || (!capabilityError && enabled && loadingData)) {
    return (
      <div
        ref={rootRef}
        data-testid="replay-view-root"
        className="replay-view-root"
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}
      >
        <p>{t('common.loading', 'Loading...')}</p>
      </div>
    );
  }

  if (capabilityError) {
    return (
      <div
        ref={rootRef}
        data-testid="replay-view-root"
        className="replay-view-root"
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}
      >
        <h1 style={{ margin: '0 0 1rem', fontSize: '1.4rem' }}>
          {t('replay.title', 'Replay')}
        </h1>
        <ReplayEmptyState
          title={t('replay.feature_unavailable_title', 'Replay availability could not be checked')}
          message={t(
            'replay.feature_unavailable_description',
            'Unable to confirm whether replay trace is available right now. Please retry.',
          )}
          onRetry={() => void reloadCapability?.()}
          retryLabel={t('common.retry', 'Retry')}
        />
        <div style={{ marginTop: '1rem' }}>
          <Link to="/" style={{ color: '#8ab4f8' }}>
            {t('common.back_home', 'Back to Home')}
          </Link>
        </div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div
        ref={rootRef}
        data-testid="replay-view-root"
        className="replay-view-root"
        tabIndex={-1}
        style={{ maxWidth: 960, margin: '0 auto', padding: '3rem 1rem', textAlign: 'center' }}
      >
        <h1 style={{ margin: '0 0 1rem', fontSize: '1.4rem' }}>
          {t('replay.title', 'Replay')}
        </h1>
        <ReplayEmptyState
          title={t('replay.feature_disabled_title', 'Replay trace is unavailable')}
          message={t(
            'replay.feature_disabled_description',
            'This server has replay trace disabled for this environment.',
          )}
        />
        <div style={{ marginTop: '1rem' }}>
          <Link to="/" style={{ color: '#8ab4f8' }}>
            {t('common.back_home', 'Back to Home')}
          </Link>
        </div>
      </div>
    );
  }

  const hasTrace = (trace?.nodes?.length ?? 0) > 0;
  const hasFrames = totalFrames > 0;
  const showEmpty = !!error || !hasTrace || !hasFrames;

  return (
    <div
      ref={rootRef}
      data-testid="replay-view-root"
      className="replay-view-root"
      tabIndex={-1}
      style={{ maxWidth: 960, margin: '0 auto', padding: '1.5rem 1rem' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem' }}>
          {t('replay.title', 'Replay')}
        </h1>
        <Link to="/" style={{ color: '#8ab4f8' }}>
          {t('common.back_home', 'Back to Home')}
        </Link>
      </div>

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
          <div style={{ marginBottom: '1rem' }}>
            <ReplayTimelineScrubber
              frameIndex={frameIndex}
              totalFrames={totalFrames}
              onFrameChange={setFrame}
              ariaLabel={t('replay.scrubber.aria_label', 'Replay timeline')}
            />
          </div>

          <div style={{ marginBottom: '1rem' }}>
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
          </div>

          <section aria-label={t('replay.agent_queue.aria_label', 'Replay agent queue')}>
            <ReplayAgentQueue
              agents={agents}
              activeAgentId={activeAgentId}
            />
          </section>

          <section
            aria-label={t('replay.trace.aria_label', 'Replay trace')}
            style={{
              marginTop: '1rem', padding: '0.75rem 1rem',
              border: '1px solid var(--color-border, #333)',
              borderRadius: 8,
            }}
          >
            <p style={{ margin: 0, fontSize: 13, color: 'var(--color-muted, #888)' }}>
              {t('replay.trace.frame_count_label', 'Frame')}: {frameIndex + 1} / {totalFrames}
              {` · `}
              {t('replay.trace.branches_label', 'Branches')}: {trace?.nodes.length ?? 0}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

export default ReplayView;
