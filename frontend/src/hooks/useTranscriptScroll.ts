import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  captureTranscriptScrollSnapshot,
  computeBottomAnchoredScrollTop,
  type TranscriptScrollSnapshot,
} from '../lib/textLayout/oracleTranscriptLayout';

/**
 * Shared hook for Oracle transcript scroll anchoring.
 *
 * Used by both EndingChatModal and WorldlineRoundtableView to maintain
 * bottom-anchored scrolling during draft→commit transitions and new turns.
 */
export function useTranscriptScroll() {
  const listRef = useRef<HTMLDivElement>(null);
  const autoStickRef = useRef(false);
  const hydratedRef = useRef(false);
  const scrollSnapshotRef = useRef<TranscriptScrollSnapshot | null>(null);

  const captureSnapshot = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    scrollSnapshotRef.current = captureTranscriptScrollSnapshot({
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    });
  }, []);

  const restoreBottomAnchor = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const nextTop = computeBottomAnchoredScrollTop(
      { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight },
      scrollSnapshotRef.current,
    );
    el.scrollTop = nextTop;
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  const isNearBottom = useCallback((threshold = 60) => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.clientHeight - el.scrollTop <= threshold;
  }, []);

  const handleScroll = useCallback(() => {
    autoStickRef.current = isNearBottom();
    captureSnapshot();
  }, [isNearBottom, captureSnapshot]);

  const getScrollSnapshot = useCallback((): TranscriptScrollSnapshot | null => {
    return scrollSnapshotRef.current;
  }, []);

  return {
    listRef,
    autoStickRef,
    hydratedRef,
    scrollSnapshotRef,
    captureSnapshot,
    restoreBottomAnchor,
    scrollToBottom,
    isNearBottom,
    handleScroll,
    getScrollSnapshot,
  };
}

/**
 * Auto-scroll to bottom when content changes, if user was already near bottom.
 */
export function useAutoScrollToBottom(
  listRef: React.RefObject<HTMLDivElement | null>,
  autoStickRef: React.RefObject<boolean>,
  deps: unknown[],
) {
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !autoStickRef.current) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
