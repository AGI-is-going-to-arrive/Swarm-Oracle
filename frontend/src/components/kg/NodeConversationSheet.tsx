/**
 * FE-3 — NodeConversationSheet.
 *
 * Single-component responsive drawer backed by shadcn/Sheet:
 *   - Desktop (≥768px): side="right"
 *   - Mobile (<768px): side="bottom" with 40/70/100 snap points
 *     * User cycles snap via the grab handle (40 → 70 → 100 → 40)
 *     * Also exposed via Cmd/Ctrl+ArrowUp / Cmd/Ctrl+ArrowDown on the
 *       textarea (ArrowUp raises snap toward 100vh, ArrowDown lowers it).
 *     * `data-snap` is reflected on the SheetContent root for e2e.
 *
 * Keyboard shortcuts (HC from ui-prompts.md §13 + frontend/CLAUDE.md):
 *   - ESC closes the Sheet (native Radix behaviour).
 *   - Cmd/Ctrl+Enter submits the current input (calls `onSubmit`).
 *   - Cmd/Ctrl+R fires `onResend` (parent re-issues the last turn).
 *     `preventDefault()` is always called so the browser never triggers a
 *     page reload when the Sheet is focused.
 *
 * Integration:
 *   - useAgentConversation — state machine + aria-live + streaming bubble registry
 *   - local SSE bridge — fetch `/turn`, parse SSE frames, dispatch turn events
 *   - useDraftAutoSave — sessionStorage draft restoration (HC-29)
 *
 * Focus-stable during streaming: incoming token deltas update bubble
 * textContent via ref (not setState), so `activeElement` (textarea / send
 * / close) is NEVER stolen.
 *
 * Mobile bottom-sheet scroll conflict guard: the inner transcript + input
 * scroll region carries `data-no-drag="true"` + stopPropagation on
 * touchstart so the drag-to-close gesture only triggers on the handle area.
 *
 * NOTE: this component exposes itself via props only — the 4 trigger
 * sources (ArgumentMap / CausalReviewView / FactionTimeline / KGExplorerView)
 * wire onClick in the FE-3-seq serial phase.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { buildSessionHeaders } from '../../api/client';
import { mapBackendErrorCode } from '../../lib/conversationStateMachine';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { cn } from '../../lib/utils';
import { useAgentConversation, type RegisteredStreamBubble } from '../../hooks/useAgentConversation';
import { useDraftAutoSave } from '../../hooks/useDraftAutoSave';
import { useNodeConversationTransport } from '../../hooks/useNodeConversationTransport';

import { ConversationRecoveryBanner } from './ConversationRecoveryBanner';
import { DraftRestoredBanner } from './DraftRestoredBanner';
import { EmptyStateQuickQuestions } from './EmptyStateQuickQuestions';
import { StreamingBubbleIsolated, type StreamingBubbleApi } from './StreamingBubbleIsolated';

function useIsMobile(maxWidth = 768): boolean {
  // Synchronous initialiser avoids the initial setState-in-effect cascade.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(`(max-width: ${maxWidth}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const onChange = (ev: MediaQueryListEvent) => setIsMobile(ev.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [maxWidth]);
  return isMobile;
}

export interface NodeConversationOrigin {
  /** Graph node id (ArgumentMap/CausalReviewView/FactionTimeline/KGExplorer). */
  nodeId: string;
  /** Node type label (argument/causal/faction/kg). */
  nodeType: string;
  /** Optional excerpt for prompt context. */
  excerpt?: string;
}

export interface NodeConversationSheetProps {
  /** Controlled open state. */
  open: boolean;
  /** Caller-controlled open setter. */
  onOpenChange: (open: boolean) => void;
  /** Optional close callback for trigger owners. */
  onClose?: () => void;
  /** Thread id to connect WS + fetch history. */
  threadId?: string | null;
  /** Scenario id (for deep link / display). */
  scenarioId: string;
  /** Agent identity this conversation targets. */
  identityId?: string | null;
  /** Graph node origin metadata (display + prompt context). */
  origin?: NodeConversationOrigin;
  /** Submit handler (REST POST /conversation/{thread}/turn). */
  onSubmit?: (text: string) => void;
  /** Abort current streaming turn handler. */
  onAbort?: () => void;
  /** Resend last user turn (Cmd/Ctrl+R shortcut). Parent owns the payload. */
  onResend?: () => void;
}

/**
 * Mobile bottom-sheet snap points. Hardcoded so Tailwind JIT can statically
 * extract the `max-h-[<N>vh]` class names (dynamic template strings would
 * be purged). Order matches the cycle 40 → 70 → 100 → 40.
 */
export type NodeConversationSnapLevel = '40' | '70' | '100';
const SNAP_LEVELS: NodeConversationSnapLevel[] = ['40', '70', '100'];
const SNAP_MAX_H: Record<NodeConversationSnapLevel, string> = {
  '40': 'data-[state=open]:max-h-[40vh]',
  '70': 'data-[state=open]:max-h-[70vh]',
  '100': 'data-[state=open]:max-h-[100vh]',
};
function nextSnap(current: NodeConversationSnapLevel): NodeConversationSnapLevel {
  const idx = SNAP_LEVELS.indexOf(current);
  return SNAP_LEVELS[(idx + 1) % SNAP_LEVELS.length];
}
function raiseSnap(current: NodeConversationSnapLevel): NodeConversationSnapLevel {
  const idx = SNAP_LEVELS.indexOf(current);
  return SNAP_LEVELS[Math.min(idx + 1, SNAP_LEVELS.length - 1)];
}
function lowerSnap(current: NodeConversationSnapLevel): NodeConversationSnapLevel {
  const idx = SNAP_LEVELS.indexOf(current);
  return SNAP_LEVELS[Math.max(idx - 1, 0)];
}

export function NodeConversationSheet(props: NodeConversationSheetProps) {
  const {
    open,
    onOpenChange,
    onClose,
    threadId: initialThreadId = null,
    scenarioId,
    identityId,
    origin,
    onSubmit,
    onAbort,
    onResend,
  } = props;
  const { t } = useTranslation();
  const isMobile = useIsMobile(768);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId);
  const lastSubmittedMessageRef = useRef<string | null>(null);
  const originNodeId = origin?.nodeId ?? null;
  const originNodeType = origin?.nodeType ?? null;

  const {
    state: convState,
    dispatch: convDispatch,
    dispatchWsEvent,
    registerStreamBubble,
    ariaLiveApi,
  } = useAgentConversation({ threadId });
  const { announceRef: ariaLiveAnnounceRef, flushNow: flushAriaLiveNow } = ariaLiveApi;

  // Draft auto-save (per thread id).
  const draftKey = useMemo(() => `swarmoracle_draft:${threadId ?? 'default'}`, [threadId]);
  const draft = useDraftAutoSave(draftKey);

  const [inputValue, setInputValue] = useState<string>('');
  const [draftNoticeDismissed, setDraftNoticeDismissed] = useState<boolean>(false);
  const sheetContentRef = useRef<HTMLDivElement | null>(null);

  // Hydrate from restored draft on first time `draft.restored` flips from
  // null → string (one-shot). This is a legitimate external-sync effect:
  // sessionStorage is outside React state so we must read-then-project.
  const draftHydratedRef = useRef<boolean>(false);
  useEffect(() => {
    if (draftHydratedRef.current) return;
    if (draft.restored !== null && inputValue === '') {
      draftHydratedRef.current = true;
      setInputValue(draft.restored);
    }
  }, [draft.restored, inputValue]);

  // Persist input value to sessionStorage (debounced inside hook).
  useEffect(() => {
    if (inputValue.length > 0) draft.save(inputValue);
  }, [draft, inputValue]);

  const dispatchTransportError = useCallback((code: string, message?: string) => {
    convDispatch({ type: 'error', code: mapBackendErrorCode(code), message });
  }, [convDispatch]);

  const {
    abortActiveRequest,
    startConversation,
    streamTurn,
  } = useNodeConversationTransport({
    scenarioId,
    identityId,
    originNodeId,
    originNodeType,
    setThreadId,
    onTransportError: dispatchTransportError,
    onWsEvent: dispatchWsEvent,
  });

  useEffect(() => {
    if (initialThreadId) {
      setThreadId(initialThreadId);
    }
  }, [initialThreadId]);

  useEffect(() => {
    if (!open) {
      abortActiveRequest();
      lastSubmittedMessageRef.current = null;
      setThreadId(initialThreadId);
    }
  }, [abortActiveRequest, initialThreadId, open]);

  useEffect(() => {
    flushAriaLiveNow();
  }, [flushAriaLiveNow, open]);

  // Stable bubble-ref callback; StrictMode idempotent.
  const bubbleRef = useRef<StreamingBubbleApi | null>(null);
  const handleBubbleRef = useCallback(
    (api: StreamingBubbleApi | null) => {
      bubbleRef.current = api;
      const bubbleId = originNodeId ?? threadId ?? 'default';
      const registered: RegisteredStreamBubble | null = api
        ? { appendToken: api.appendToken, finalize: api.finalize, reset: api.reset }
        : null;
      registerStreamBubble(bubbleId, registered);
    },
    [originNodeId, registerStreamBubble, threadId],
  );

  const handleSubmit = useCallback(async () => {
    const text = inputValue.trim();
    if (text.length === 0) return;
    lastSubmittedMessageRef.current = text;
    draft.save(text);
    if (onSubmit) {
      onSubmit(text);
      return;
    }
    const accepted = !threadId
      ? await startConversation(text)
      : await streamTurn(threadId, text);
    if (!accepted) return;
    draft.discard();
    setInputValue('');
  }, [draft, inputValue, onSubmit, startConversation, streamTurn, threadId]);

  const handleAbort = useCallback(async () => {
    if (onAbort) {
      onAbort();
      return;
    }
    abortActiveRequest();
    if (threadId) {
      try {
        await fetch(`/api/conversation/${encodeURIComponent(threadId)}/active`, {
          method: 'DELETE',
          headers: buildSessionHeaders(),
        });
      } catch {
        // Best-effort network cleanup.
      }
    }
    convDispatch({ type: 'abort' });
  }, [abortActiveRequest, convDispatch, onAbort, threadId]);

  const handleResend = useCallback(async () => {
    if (onResend) {
      onResend();
      return;
    }
    const lastMessage = lastSubmittedMessageRef.current?.trim();
    if (!lastMessage || !threadId) return;
    await streamTurn(threadId, lastMessage);
  }, [onResend, streamTurn, threadId]);

  const handleDiscardDraft = useCallback(() => {
    draft.discard();
    setInputValue('');
    setDraftNoticeDismissed(true);
  }, [draft]);

  // Mobile snap-point state (40/70/100 vh). Starts at 70 (default reading
  // height). Cycled by the grab handle; raised/lowered by keyboard shortcut.
  const [snapLevel, setSnapLevel] = useState<NodeConversationSnapLevel>('70');
  const handleSnapCycle = useCallback(() => {
    setSnapLevel((lvl) => nextSnap(lvl));
  }, []);

  /**
   * Textarea onKeyDown — Cmd/Ctrl+Enter submit, Cmd/Ctrl+R resend,
   * Cmd/Ctrl+ArrowUp/ArrowDown mobile snap.
   *
   * Always preventDefault on modifier+key combos we claim, so the browser
   * never refreshes the page (Cmd+R) or inserts a newline (Cmd+Enter).
   */
  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        handleSubmit();
        return;
      }
      const lower = e.key.toLowerCase();
      if (lower === 'r') {
        e.preventDefault();
        e.stopPropagation();
        handleResend();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSnapLevel((lvl) => raiseSnap(lvl));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSnapLevel((lvl) => lowerSnap(lvl));
        return;
      }
    },
    [handleSubmit, handleResend],
  );

  // Mobile bottom-sheet drag guard: stop touchstart propagation on the
  // inner scroll region so radix-dialog / any drag-to-close handler on the
  // sheet body does not intercept inner scroll. We attach native (non-React)
  // listeners so the stop runs during the real DOM bubble — React's synthetic
  // dispatch at document root is too late to prevent the parent's addEventListener
  // spy from firing. We use a callback ref so the listener is installed
  // synchronously when the DOM node appears (not deferred to useEffect).
  const stopTouchPropagation = useCallback((ev: Event) => {
    ev.stopPropagation();
  }, []);
  const scrollRegionRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.addEventListener('touchstart', stopTouchPropagation);
    },
    [stopTouchPropagation],
  );
  const inputRegionRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) node.addEventListener('touchstart', stopTouchPropagation);
    },
    [stopTouchPropagation],
  );

  const side = isMobile ? 'bottom' : 'right';
  const handleSheetOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) onClose?.();
    onOpenChange(nextOpen);
  }, [onClose, onOpenChange]);
  const handleDesktopInteractOutside = useCallback((event: Event) => {
    if (isMobile) return;
    event.preventDefault();
  }, [isMobile]);
  const handleSheetEscapeKeyDown = useCallback((event: KeyboardEvent) => {
    if (isMobile) return;
    const target = event.target;
    if (target instanceof Node && sheetContentRef.current?.contains(target)) {
      return;
    }
    event.preventDefault();
  }, [isMobile]);

  const showRecovery = convState.turn === 'error' || convState.turn === 'recovering';
  const showEmpty = convState.turn === 'idle' && inputValue.length === 0;
  const isStreaming = convState.turn === 'streaming';
  const isDone = convState.turn === 'done';

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange} modal={isMobile}>
      <SheetContent
        ref={sheetContentRef}
        side={side}
        hideOverlay={!isMobile}
        onInteractOutside={handleDesktopInteractOutside}
        onEscapeKeyDown={handleSheetEscapeKeyDown}
        data-testid="node-conversation-sheet"
        data-mobile={isMobile ? 'true' : 'false'}
        data-snap={isMobile ? snapLevel : undefined}
        className={cn(
          'flex h-full flex-col',
          isMobile
            ? cn(
                'rounded-t-2xl pb-[env(safe-area-inset-bottom)]',
                SNAP_MAX_H[snapLevel],
              )
            : 'w-full sm:max-w-md',
        )}
      >
        {isMobile ? (
          <button
            type="button"
            data-testid="node-conversation-snap-handle"
            data-snap={snapLevel}
            aria-label={t('conversation.sheet.snap_handle_aria', {
              snap: snapLevel,
              defaultValue: `Snap bottom sheet (current ${snapLevel}vh)`,
            })}
            onClick={handleSnapCycle}
            className="mx-auto mt-1 h-1.5 w-12 rounded-full bg-border-default hover:bg-text-muted"
          />
        ) : null}
        <SheetHeader>
          <SheetTitle>
            {t('conversation.sheet.title', {
              defaultValue: origin?.nodeType ?? 'Conversation',
            })}
          </SheetTitle>
          <SheetDescription className="sr-only">
            {t('conversation.sheet.description', {
              defaultValue: 'Ask the agent about the selected node and review the streamed reply here.',
            })}
          </SheetDescription>
        </SheetHeader>

        {/* Draft status */}
        {!draftNoticeDismissed && draft.restored !== null ? (
          <DraftRestoredBanner variant="restored" onDiscard={handleDiscardDraft} />
        ) : null}
        {!draft.available ? <DraftRestoredBanner variant="unavailable" /> : null}

        {/* Transcript / stream region — drag-guarded */}
        <div
          ref={scrollRegionRef}
          data-testid="node-conversation-scroll-region"
          data-no-drag="true"
          aria-label={t('conversation.sheet.scroll_region_aria')}
          className="flex-1 overflow-y-auto"
        >
          <div className="px-1 py-2 text-sm leading-relaxed text-text-primary">
            <StreamingBubbleIsolated onRef={handleBubbleRef} />
          </div>
          {showEmpty ? <EmptyStateQuickQuestions onSelect={setInputValue} /> : null}

          {showRecovery ? (
            <ConversationRecoveryBanner
              code={convState.code ?? 'server_error'}
              message={convState.message}
              onRetry={() => convDispatch({ type: 'reset' })}
              onDiscard={() => convDispatch({ type: 'reset' })}
            />
          ) : null}
        </div>

        {/* sr-only aria-live node for streaming announcements */}
        <div
          ref={ariaLiveAnnounceRef}
          className="sr-only"
          role="status"
          aria-live="polite"
          aria-atomic="false"
          data-testid="node-conversation-aria-live"
        />

        {/* Input + controls */}
        <div
          ref={inputRegionRef}
          data-no-drag="true"
          className="flex gap-2 border-t border-border-default pt-3"
        >
          <textarea
            data-testid="node-conversation-input"
            aria-label={t('conversation.input.placeholder')}
            aria-keyshortcuts="Meta+Enter Control+Enter Meta+R Control+R"
            placeholder={t('conversation.input.placeholder')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            rows={2}
            className="flex-1 resize-none rounded-md border border-border-default bg-surface p-2 text-sm text-text-primary"
          />
          {isStreaming ? (
            <button
              type="button"
              data-testid="node-conversation-stop"
              onClick={handleAbort}
              className="min-h-[44px] min-w-[44px] rounded-md border border-amber-400/60 px-3 text-xs text-amber-100 hover:bg-amber-500/20"
            >
              {t('conversation.input.stop')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="node-conversation-send"
              onClick={handleSubmit}
              disabled={inputValue.trim().length === 0}
              className="min-h-[44px] min-w-[44px] rounded-md bg-primary px-3 text-xs text-white hover:bg-primary/80 disabled:opacity-40"
            >
              {t('conversation.input.send')}
            </button>
          )}
          <button
            type="button"
            data-testid="node-conversation-close"
            onClick={() => handleSheetOpenChange(false)}
            aria-label={t('conversation.sheet.close_aria')}
            className="min-h-[44px] min-w-[44px] rounded-md border border-border-default px-3 text-xs text-text-muted hover:bg-surface-muted"
          >
            {t('common.close', { defaultValue: 'Close' })}
          </button>
        </div>

        {/* Continue-chatting CTA shown post-done */}
        {isDone ? (
          <button
            type="button"
            data-testid="node-conversation-cta-continue"
            onClick={() => convDispatch({ type: 'reset' })}
            className="mt-2 min-h-[44px] rounded-md border border-border-default px-3 py-2 text-xs text-text-primary hover:bg-surface-muted"
          >
            {t('conversation.cta.continue_chatting')}
          </button>
        ) : null}

        {/* Debug tag: thread + scenario + identity (sr-only for e2e) */}
        <span className="sr-only" data-testid="node-conversation-meta">
          {`thread=${threadId ?? ''} scenario=${scenarioId} identity=${identityId}`}
        </span>
      </SheetContent>
    </Sheet>
  );
}
