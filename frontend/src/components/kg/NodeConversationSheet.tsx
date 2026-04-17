/**
 * FE-3 — NodeConversationSheet.
 *
 * Single-component responsive drawer backed by shadcn/Sheet:
 *   - Desktop (≥768px): side="right"
 *   - Mobile (<768px): side="bottom" with 40/70/100 snap (via CSS vh cap)
 *
 * Integration:
 *   - useAgentConversation — state machine + aria-live + streaming bubble registry
 *   - useAgentConversationWS — transport (auth_ok, turn events, 4001/4404)
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

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet';
import { cn } from '../../lib/utils';
import { useAgentConversation, type RegisteredStreamBubble } from '../../hooks/useAgentConversation';
import { useAgentConversationWS } from '../../hooks/useAgentConversationWS';
import { useDraftAutoSave } from '../../hooks/useDraftAutoSave';

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
  /** Thread id to connect WS + fetch history. */
  threadId: string | null;
  /** Scenario id (for deep link / display). */
  scenarioId: string;
  /** Agent identity this conversation targets. */
  identityId: string;
  /** Graph node origin metadata (display + prompt context). */
  origin?: NodeConversationOrigin;
  /** Submit handler (REST POST /conversation/{thread}/turn). */
  onSubmit?: (text: string) => void;
  /** Abort current streaming turn handler. */
  onAbort?: () => void;
}

export function NodeConversationSheet(props: NodeConversationSheetProps) {
  const {
    open,
    onOpenChange,
    threadId,
    scenarioId,
    identityId,
    origin,
    onSubmit,
    onAbort,
  } = props;
  const { t } = useTranslation();
  const isMobile = useIsMobile(768);

  const conversation = useAgentConversation({ threadId });
  // Extract plain (non-ref) properties so subsequent render code never
  // reads them through the `conversation` object — `ariaLiveApi` carries
  // refs which triggers the `react-hooks/refs` rule.
  const { state: convState, dispatch: convDispatch, ariaLiveApi } = conversation;
  const { announceRef: ariaLiveAnnounceRef } = ariaLiveApi;

  // WS transport — stable onEvent callback via ref in the hook.
  useAgentConversationWS({
    threadId,
    ready: open,
    onEvent: conversation.dispatchWsEvent,
  });

  // Draft auto-save (per thread id).
  const draftKey = useMemo(() => `swarmoracle_draft:${threadId ?? 'default'}`, [threadId]);
  const draft = useDraftAutoSave(draftKey);

  const [inputValue, setInputValue] = useState<string>('');
  const [draftNoticeDismissed, setDraftNoticeDismissed] = useState<boolean>(false);

  // Hydrate from restored draft on first time `draft.restored` flips from
  // null → string (one-shot). This is a legitimate external-sync effect:
  // sessionStorage is outside React state so we must read-then-project.
  const draftHydratedRef = useRef<boolean>(false);
  useEffect(() => {
    if (draftHydratedRef.current) return;
    if (draft.restored !== null && inputValue === '') {
      draftHydratedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInputValue(draft.restored);
    }
  }, [draft.restored, inputValue]);

  // Persist input value to sessionStorage (debounced inside hook).
  useEffect(() => {
    if (inputValue.length > 0) draft.save(inputValue);
  }, [draft, inputValue]);

  // Stable bubble-ref callback; StrictMode idempotent.
  const bubbleRef = useRef<StreamingBubbleApi | null>(null);
  const handleBubbleRef = useCallback(
    (api: StreamingBubbleApi | null) => {
      bubbleRef.current = api;
      const bubbleId = origin?.nodeId ?? threadId ?? 'default';
      const registered: RegisteredStreamBubble | null = api
        ? { appendToken: api.appendToken, finalize: api.finalize, reset: api.reset }
        : null;
      conversation.registerStreamBubble(bubbleId, registered);
    },
    [conversation, origin?.nodeId, threadId],
  );

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim();
    if (text.length === 0) return;
    onSubmit?.(text);
    convDispatch({ type: 'submit' });
    draft.discard();
    setInputValue('');
  }, [convDispatch, draft, inputValue, onSubmit]);

  const handleAbort = useCallback(() => {
    onAbort?.();
    convDispatch({ type: 'abort' });
  }, [convDispatch, onAbort]);

  const handleDiscardDraft = useCallback(() => {
    draft.discard();
    setInputValue('');
    setDraftNoticeDismissed(true);
  }, [draft]);

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

  const showRecovery = convState.turn === 'error' || convState.turn === 'recovering';
  const showEmpty = convState.turn === 'idle' && inputValue.length === 0;
  const isStreaming = convState.turn === 'streaming';
  const isDone = convState.turn === 'done';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        data-testid="node-conversation-sheet"
        data-mobile={isMobile ? 'true' : 'false'}
        aria-labelledby="node-conversation-sheet-title"
        className={cn(
          'flex h-full flex-col',
          isMobile
            ? 'rounded-t-2xl pb-[env(safe-area-inset-bottom)] data-[state=open]:max-h-[70vh]'
            : 'w-full sm:max-w-md',
        )}
      >
        <SheetHeader>
          <SheetTitle id="node-conversation-sheet-title">
            {t('conversation.sheet.title', {
              defaultValue: origin?.nodeType ?? 'Conversation',
            })}
          </SheetTitle>
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
          {showEmpty ? (
            <EmptyStateQuickQuestions onSelect={setInputValue} />
          ) : (
            <div className="px-1 py-2 text-sm leading-relaxed text-text-primary">
              <StreamingBubbleIsolated onRef={handleBubbleRef} />
            </div>
          )}

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
            placeholder={t('conversation.input.placeholder')}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
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
            onClick={() => onOpenChange(false)}
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
