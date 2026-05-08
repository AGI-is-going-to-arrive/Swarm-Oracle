/**
 * FE-3 v3/v4 (HC-38 / R3-M4 / R4-N4 / R4-S3) — Streaming bubble.
 *
 * Pure imperative bubble that exposes `appendToken / finalize / reset` via a
 * ref callback. Token deltas are written to `textContent` directly — they
 * DO NOT trigger React re-renders. React.memo guards against parent
 * re-render cascades.
 *
 * StrictMode contract (R4-N4):
 *   - Mount:   onRef(api)
 *   - Unmount: onRef(null)
 *   - StrictMode dev double-mount: first onRef(null) then onRef(newApi)
 *
 * Caller implementation of onRef MUST be idempotent: holding a stale api
 * reference and calling appendToken on it MUST NOT throw. This component
 * guards via internal `useRef` null checks.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { SafeMarkdown } from '../SafeMarkdown';

export interface StreamingBubbleApi {
  /** Imperative; writes `delta` directly to DOM, no React re-render. */
  appendToken: (delta: string) => void;
  /**
   * Finalize with the full authoritative text. Sets textContent once and
   * "freezes" the bubble. Safe to call after reset().
   */
  finalize: (fullText: string) => void;
  /** Clear content — preparing for a new streaming turn. */
  reset: () => void;
}

export interface StreamingBubbleIsolatedProps {
  /** Optional initial text to seed the bubble. */
  initialText?: string;
  /**
   * Ref callback. Contract:
   *   - Component mount: onRef(api)
   *   - Component unmount: onRef(null) (parent MUST clear reference)
   *   - React 18 StrictMode dev double-mount: first onRef(null), then
   *     onRef(newApi). Parent implementation MUST be idempotent.
   */
  onRef: (api: StreamingBubbleApi | null) => void;
  className?: string;
  /** Optional data-testid (defaults to `node-conversation-streaming`). */
  testId?: string;
}

function StreamingBubbleIsolatedImpl(props: StreamingBubbleIsolatedProps) {
  const { initialText, onRef, className, testId } = props;
  const nodeRef = useRef<HTMLSpanElement | null>(null);
  const [finalText, setFinalText] = useState<string | null>(null);

  // Wrap stable callbacks — each one internally null-checks nodeRef so
  // stale api references from StrictMode double-mount are safe.
  const appendToken = useCallback((delta: string) => {
    if (!nodeRef.current) return;
    if (typeof delta !== 'string' || delta.length === 0) return;
    // Direct textContent mutation; ~100 tokens/sec zero React work.
    nodeRef.current.textContent = (nodeRef.current.textContent ?? '') + delta;
  }, []);

  const finalize = useCallback((fullText: string) => {
    if (nodeRef.current) nodeRef.current.textContent = '';
    setFinalText(fullText);
  }, []);

  const reset = useCallback(() => {
    setFinalText(null);
    if (nodeRef.current) nodeRef.current.textContent = '';
  }, []);

  // Wire onRef on mount/unmount. Clean up FIRST so StrictMode double-mount
  // yields (null, newApi) sequence.
  useEffect(() => {
    const api: StreamingBubbleApi = { appendToken, finalize, reset };
    onRef(api);
    return () => {
      onRef(null);
    };
  }, [appendToken, finalize, reset, onRef]);

  // Seed initial text once (subsequent updates driven by imperative API).
  useEffect(() => {
    if (initialText && nodeRef.current && nodeRef.current.textContent === '') {
      nodeRef.current.textContent = initialText;
    }
    // intentionally no deps beyond initialText
  }, [initialText]);

  return (
    <div
      className={className}
      data-testid={testId ?? 'node-conversation-streaming'}
    >
      <span
        ref={nodeRef}
        aria-hidden={finalText === null ? undefined : 'true'}
        style={finalText === null ? undefined : { display: 'none' }}
      />
      {finalText !== null ? (
        <SafeMarkdown className="node-conversation-markdown">
          {finalText}
        </SafeMarkdown>
      ) : null}
    </div>
  );
}

// React.memo: re-renders only when props identity changes (e.g. className).
// Token deltas do NOT change props; they mutate DOM via ref.
export const StreamingBubbleIsolated = memo(StreamingBubbleIsolatedImpl);
