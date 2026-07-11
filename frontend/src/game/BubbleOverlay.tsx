import { useCallback, useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import useReducedMotion from '../hooks/useReducedMotion';
import { EMOTION_HALO_COLORS } from './constants/emotionColors';
import { getAgentPaletteToken } from './constants/agentPalette';
import {
  resolveBubbleEmotionState,
  type SpritePositionUpdate,
} from './managers/EventBridge';
import './BubbleOverlay.css';

interface BubbleOverlayProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

type BubbleMode = 'live' | 'replay';
type BubbleRecord = {
  id: string;
  spriteId: string;
  fullText: string;
  displayText: string;
  mode: BubbleMode;
  emotion: string;
  accent: string;
  surface: string;
  createdAt: number;
};

type SpritePosition = SpritePositionUpdate['agents'][number];
type CanvasRect = SpritePositionUpdate['canvasRect'];

const NORMAL_MAX_TEXT_CHARS = 72;
const COMPACT_MAX_TEXT_CHARS = 48;
const COMPACT_WIDTH_PX = 360;
const MAX_VISIBLE_BUBBLES = 8;
const LIVE_LINGER_MS = 1800;
const REPLAY_LINGER_MS = 2800;
const LINGER_MS_PER_CHAR = 18;
const LINGER_MAX_MS = 4400;
const TYPEWRITER_MS_PER_CHAR = 22;
const INITIAL_TYPEWRITER_CHARS = 4;
const DEFAULT_CANVAS_RECT: CanvasRect = { width: 800, height: 450 };

const EMOTION_CLASS_NAMES = new Set(Object.keys(EMOTION_HALO_COLORS));

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clipText(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) return normalized;
  return `${chars.slice(0, Math.max(0, maxChars - 3)).join('')}...`;
}

function getVisibleLimit(agentCount: number, fallbackCount: number): number {
  const effectiveCount = agentCount > 0 ? agentCount : fallbackCount;
  return Math.max(0, Math.min(effectiveCount, MAX_VISIBLE_BUBBLES));
}

function normalizeEmotion(value: string | null, metadataStatus: unknown): string {
  return resolveBubbleEmotionState(value, metadataStatus, EMOTION_CLASS_NAMES);
}

function parseBubbleMode(value: unknown): BubbleMode {
  return value === 'replay' ? 'replay' : 'live';
}

function getBubbleLifetimeMs(mode: BubbleMode, textLength: number, reducedMotion: boolean): number {
  const baseLingerMs = mode === 'replay' ? REPLAY_LINGER_MS : LIVE_LINGER_MS;
  const lingerMs = Math.min(LINGER_MAX_MS, baseLingerMs + textLength * LINGER_MS_PER_CHAR);
  if (reducedMotion) return lingerMs;
  const typewriterMs = Math.max(0, textLength - INITIAL_TYPEWRITER_CHARS) * TYPEWRITER_MS_PER_CHAR;
  return typewriterMs + lingerMs;
}

function parseCanvasRect(value: unknown): CanvasRect {
  if (!value || typeof value !== 'object') return DEFAULT_CANVAS_RECT;
  const candidate = value as { width?: unknown; height?: unknown };
  return {
    width: isFiniteNumber(candidate.width) && candidate.width > 0 ? candidate.width : DEFAULT_CANVAS_RECT.width,
    height: isFiniteNumber(candidate.height) && candidate.height > 0 ? candidate.height : DEFAULT_CANVAS_RECT.height,
  };
}

function parseSpritePositions(data: Record<string, unknown>): SpritePositionUpdate | null {
  const agentsValue = data.agents;
  if (!Array.isArray(agentsValue)) return null;

  const agents: SpritePosition[] = agentsValue.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const candidate = entry as Record<string, unknown>;
    const agentId = readString(candidate.agent_id);
    if (!agentId || !isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y)) return [];
    return [{
      agent_id: agentId,
      name: readString(candidate.name) ?? agentId,
      x: candidate.x,
      y: candidate.y,
      spriteH: isFiniteNumber(candidate.spriteH) ? candidate.spriteH : 64,
      visible: candidate.visible !== false,
      ...(readString(candidate.emotion) ? { emotion: readString(candidate.emotion) ?? undefined } : {}),
    }];
  });

  return {
    agents,
    canvasRect: parseCanvasRect(data.canvasRect),
  };
}

function getStageElement(root: HTMLDivElement): HTMLElement {
  return root.querySelector<HTMLElement>('.phaser-game-container') ?? root;
}

function getStageMetrics(root: HTMLDivElement | null, canvasRect: CanvasRect) {
  if (!root) {
    return {
      offsetX: 0,
      offsetY: 0,
      width: canvasRect.width,
      height: canvasRect.height,
      compact: false,
    };
  }

  const stage = getStageElement(root);
  const rootRect = root.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const width = stageRect.width || rootRect.width || canvasRect.width;
  const height = stageRect.height || rootRect.height || canvasRect.height;

  return {
    offsetX: stageRect.left - rootRect.left,
    offsetY: stageRect.top - rootRect.top,
    width,
    height,
    compact: width < COMPACT_WIDTH_PX,
  };
}

export function BubbleOverlay({ containerRef }: BubbleOverlayProps) {
  const reducedMotion = useReducedMotion();
  const [bubbles, setBubbles] = useState<BubbleRecord[]>([]);
  const [isCompact, setIsCompact] = useState(false);
  const bubblesRef = useRef<BubbleRecord[]>([]);
  const spritePositionsRef = useRef(new Map<string, SpritePosition>());
  const canvasRectRef = useRef<CanvasRect>(DEFAULT_CANVAS_RECT);
  const agentCountRef = useRef(0);
  const bubbleElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const textElementsRef = useRef(new Map<string, HTMLSpanElement>());
  const typewriterRafsRef = useRef(new Map<string, number>());
  const typewriterStartedRef = useRef(new Set<string>());
  const removalTimersRef = useRef(new Map<string, number>());
  const positionRafRef = useRef<number | null>(null);
  const activeSpriteIdRef = useRef<string | null>(null);

  const clearRemovalTimer = useCallback((id: string) => {
    const timer = removalTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      removalTimersRef.current.delete(id);
    }
  }, []);

  const cancelTypewriter = useCallback((id: string) => {
    const raf = typewriterRafsRef.current.get(id);
    if (raf !== undefined) {
      window.cancelAnimationFrame(raf);
      typewriterRafsRef.current.delete(id);
    }
  }, []);

  const removeBubble = useCallback((id: string) => {
    clearRemovalTimer(id);
    cancelTypewriter(id);
    typewriterStartedRef.current.delete(id);
    setBubbles((current) => current.filter((bubble) => bubble.id !== id));
  }, [cancelTypewriter, clearRemovalTimer]);

  const trimToVisibleLimit = useCallback((records: BubbleRecord[]) => {
    const limit = getVisibleLimit(agentCountRef.current, records.length);
    if (records.length <= limit) return records;

    const next = records.slice(records.length - limit);
    const kept = new Set(next.map((bubble) => bubble.id));
    for (const bubble of records) {
      if (!kept.has(bubble.id)) {
        clearRemovalTimer(bubble.id);
        cancelTypewriter(bubble.id);
        typewriterStartedRef.current.delete(bubble.id);
      }
    }
    return next;
  }, [cancelTypewriter, clearRemovalTimer]);

  const clearAllBubbles = useCallback(() => {
    for (const timer of removalTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    removalTimersRef.current.clear();
    for (const raf of typewriterRafsRef.current.values()) {
      window.cancelAnimationFrame(raf);
    }
    typewriterRafsRef.current.clear();
    typewriterStartedRef.current.clear();
    activeSpriteIdRef.current = null;
    setBubbles([]);
  }, []);

  const dispatchAgentDetailRequest = useCallback((spriteId: string | null) => {
    if (!spriteId) return;
    const bubble = bubblesRef.current.find((item) => item.spriteId === spriteId);
    if (!bubble) return;

    window.dispatchEvent(new CustomEvent('swarm:agent_detail_request', {
      detail: {
        sprite_id: bubble.spriteId,
        agent_id: bubble.spriteId,
        bubble_text: bubble.fullText,
        bubble_mode: bubble.mode,
        emotion: bubble.emotion,
      },
    }));
  }, []);

  const schedulePositionSync = useCallback(() => {
    if (positionRafRef.current !== null) return;

    positionRafRef.current = window.requestAnimationFrame(() => {
      positionRafRef.current = null;
      const metrics = getStageMetrics(containerRef.current, canvasRectRef.current);
      const canvasWidth = Math.max(canvasRectRef.current.width, 1);
      const canvasHeight = Math.max(canvasRectRef.current.height, 1);

      for (const bubble of bubblesRef.current) {
        const element = bubbleElementsRef.current.get(bubble.id);
        if (!element) continue;

        const position = spritePositionsRef.current.get(bubble.spriteId);
        if (!position?.visible) {
          element.style.opacity = '0';
          continue;
        }

        const cssX = metrics.offsetX + (position.x / canvasWidth) * metrics.width;
        const cssY = metrics.offsetY + (position.y / canvasHeight) * metrics.height;
        const lift = Math.max(34, (position.spriteH / canvasHeight) * metrics.height * 0.5 + 14);

        element.style.setProperty('--bubble-lift', `${Math.round(lift)}px`);
        element.style.transform =
          `translate3d(${Math.round(cssX)}px, ${Math.round(cssY)}px, 0) translate(-50%, calc(-100% - var(--bubble-lift)))`;
        element.style.opacity = '1';
      }
    });
  }, [containerRef]);

  useEffect(() => {
    bubblesRef.current = bubbles;
    schedulePositionSync();

    const activeIds = new Set(bubbles.map((bubble) => bubble.id));
    for (const id of Array.from(typewriterStartedRef.current)) {
      if (!activeIds.has(id)) {
        cancelTypewriter(id);
        typewriterStartedRef.current.delete(id);
        textElementsRef.current.delete(id);
        bubbleElementsRef.current.delete(id);
      }
    }
  }, [bubbles, cancelTypewriter, schedulePositionSync]);

  useEffect(() => {
    for (const bubble of bubbles) {
      const textElement = textElementsRef.current.get(bubble.id);
      if (!textElement || typewriterStartedRef.current.has(bubble.id)) continue;

      typewriterStartedRef.current.add(bubble.id);
      const chars = Array.from(bubble.displayText);
      if (reducedMotion || chars.length <= INITIAL_TYPEWRITER_CHARS) {
        textElement.textContent = bubble.displayText;
        continue;
      }

      const startedAt = performance.now();
      let lastCount = -1;
      const step = (now: number) => {
        const elapsed = now - startedAt;
        const count = Math.min(
          chars.length,
          INITIAL_TYPEWRITER_CHARS + Math.floor(elapsed / TYPEWRITER_MS_PER_CHAR),
        );

        if (count !== lastCount) {
          textElement.textContent = chars.slice(0, count).join('');
          lastCount = count;
        }

        if (count < chars.length) {
          typewriterRafsRef.current.set(bubble.id, window.requestAnimationFrame(step));
        } else {
          typewriterRafsRef.current.delete(bubble.id);
        }
      };

      textElement.textContent = chars.slice(0, INITIAL_TYPEWRITER_CHARS).join('');
      typewriterRafsRef.current.set(bubble.id, window.requestAnimationFrame(step));
    }
  }, [bubbles, reducedMotion]);

  useEffect(() => {
    if (!reducedMotion) return;

    for (const bubble of bubblesRef.current) {
      cancelTypewriter(bubble.id);
      const textElement = textElementsRef.current.get(bubble.id);
      if (textElement) textElement.textContent = bubble.displayText;
    }
  }, [cancelTypewriter, reducedMotion]);

  useEffect(() => {
    const initialMetrics = getStageMetrics(containerRef.current, canvasRectRef.current);
    setIsCompact(initialMetrics.compact);

    const updatePositions = (data: Record<string, unknown>) => {
      const payload = parseSpritePositions(data);
      if (!payload) return;

      const previousAgentCount = agentCountRef.current;
      agentCountRef.current = payload.agents.length;
      canvasRectRef.current = payload.canvasRect;
      spritePositionsRef.current = new Map(payload.agents.map((agent) => [agent.agent_id, agent]));

      const metrics = getStageMetrics(containerRef.current, payload.canvasRect);
      setIsCompact((current) => current === metrics.compact ? current : metrics.compact);

      if (previousAgentCount !== payload.agents.length) {
        setBubbles((current) => trimToVisibleLimit(current));
      }

      schedulePositionSync();
    };

    const showBubble = (data: Record<string, unknown>) => {
      const spriteId = readString(data.sprite_id);
      const fullText = readString(data.bubble_text);
      if (!spriteId || !fullText) return;

      const metrics = getStageMetrics(containerRef.current, canvasRectRef.current);
      setIsCompact((current) => current === metrics.compact ? current : metrics.compact);

      const emotion = normalizeEmotion(
        readString(data.emotion),
        data.emotion_metadata_status,
      );
      const mode = parseBubbleMode(data.bubble_mode);
      const palette = getAgentPaletteToken(spriteId);
      const now = performance.now();
      const id = `${spriteId}:${now.toFixed(3)}`;
      const bubble: BubbleRecord = {
        id,
        spriteId,
        fullText: normalizeText(fullText),
        displayText: clipText(fullText, metrics.compact ? COMPACT_MAX_TEXT_CHARS : NORMAL_MAX_TEXT_CHARS),
        mode,
        emotion,
        accent: palette.accent,
        surface: palette.surface,
        createdAt: now,
      };

      setBubbles((current) => {
        const replaced = current.filter((item) => item.spriteId !== spriteId);
        for (const item of current) {
          if (item.spriteId === spriteId) {
            clearRemovalTimer(item.id);
            cancelTypewriter(item.id);
            typewriterStartedRef.current.delete(item.id);
          }
        }
        return trimToVisibleLimit([...replaced, bubble].sort((a, b) => a.createdAt - b.createdAt));
      });

      const lifetimeMs = getBubbleLifetimeMs(mode, bubble.displayText.length, reducedMotion);
      removalTimersRef.current.set(id, window.setTimeout(() => removeBubble(id), lifetimeMs));
      activeSpriteIdRef.current = spriteId;
      schedulePositionSync();
    };

    const clearBubbles = () => {
      clearAllBubbles();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (positionRafRef.current !== null) {
          window.cancelAnimationFrame(positionRafRef.current);
          positionRafRef.current = null;
        }
        for (const bubble of bubblesRef.current) {
          cancelTypewriter(bubble.id);
          const textElement = textElementsRef.current.get(bubble.id);
          if (textElement) textElement.textContent = bubble.displayText;
        }
        return;
      }
      schedulePositionSync();
    };

    const handlePageHide = () => {
      if (positionRafRef.current !== null) {
        window.cancelAnimationFrame(positionRafRef.current);
        positionRafRef.current = null;
      }
      for (const raf of typewriterRafsRef.current.values()) {
        window.cancelAnimationFrame(raf);
      }
      typewriterRafsRef.current.clear();
    };

    const handleResize = () => {
      const metrics = getStageMetrics(containerRef.current, canvasRectRef.current);
      setIsCompact((current) => current === metrics.compact ? current : metrics.compact);
      schedulePositionSync();
    };

    const handleVizEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: unknown; data?: unknown }>).detail;
      if (!detail || typeof detail.type !== 'string') return;

      const data =
        detail.data && typeof detail.data === 'object'
          ? detail.data as Record<string, unknown>
          : {};

      if (detail.type === 'viz:bubble_show') {
        showBubble(data);
        return;
      }
      if (detail.type === 'viz:sprite_positions') {
        updatePositions(data);
        return;
      }
      if (detail.type === 'viz:clear_bubbles') {
        clearBubbles();
      }
    };

    const removalTimers = removalTimersRef.current;
    const typewriterRafs = typewriterRafsRef.current;
    const typewriterStarted = typewriterStartedRef.current;
    const bubbleElements = bubbleElementsRef.current;
    const textElements = textElementsRef.current;

    window.addEventListener('viz-event', handleVizEvent);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('viz-event', handleVizEvent);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('resize', handleResize);
      if (positionRafRef.current !== null) {
        window.cancelAnimationFrame(positionRafRef.current);
        positionRafRef.current = null;
      }
      for (const timer of removalTimers.values()) {
        window.clearTimeout(timer);
      }
      removalTimers.clear();
      for (const raf of typewriterRafs.values()) {
        window.cancelAnimationFrame(raf);
      }
      typewriterRafs.clear();
      typewriterStarted.clear();
      bubbleElements.clear();
      textElements.clear();
    };
  }, [
    cancelTypewriter,
    clearAllBubbles,
    clearRemovalTimer,
    containerRef,
    removeBubble,
    reducedMotion,
    schedulePositionSync,
    trimToVisibleLimit,
  ]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName.toLowerCase();
      return tagName === 'input'
        || tagName === 'select'
        || tagName === 'textarea'
        || target.isContentEditable;
    };

    const focusBubbleAt = (delta: number) => {
      const visible = bubblesRef.current.filter((bubble) => {
        const element = bubbleElementsRef.current.get(bubble.id);
        return element && element.style.opacity !== '0';
      });
      if (visible.length === 0) return;

      const currentIndex = visible.findIndex((bubble) => bubble.spriteId === activeSpriteIdRef.current);
      const nextIndex = currentIndex >= 0
        ? (currentIndex + delta + visible.length) % visible.length
        : (delta > 0 ? 0 : visible.length - 1);
      const next = visible[nextIndex];
      const element = bubbleElementsRef.current.get(next.id);
      if (!element) return;
      activeSpriteIdRef.current = next.spriteId;
      element.focus({ preventScroll: true });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || isEditableTarget(event.target)) return;
      if (bubblesRef.current.length === 0) return;

      if (event.key === '[') {
        event.preventDefault();
        focusBubbleAt(-1);
        return;
      }
      if (event.key === ']') {
        event.preventDefault();
        focusBubbleAt(1);
        return;
      }
      if (event.key === 'Enter') {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest('.bubble-overlay__bubble')) {
          event.preventDefault();
          dispatchAgentDetailRequest(activeSpriteIdRef.current);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dispatchAgentDetailRequest]);

  const overlayClassName = `bubble-overlay${isCompact ? ' bubble-overlay--compact' : ''}`;

  return (
    <div
      className={overlayClassName}
      data-capture-top-overlay="true"
    >
      <div
        className="bubble-overlay__sr-only"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-atomic="false"
      >
        {bubbles.map((bubble) => (
          <p key={`${bubble.id}-sr`}>
            {bubble.fullText}
          </p>
        ))}
      </div>
      {bubbles.map((bubble) => {
        const emotionClass = `bubble-overlay__bubble--emotion-${bubble.emotion}`;
        const modeClass = `bubble-overlay__bubble--${bubble.mode}`;
        const style = {
          '--bubble-aa-accent': bubble.accent,
          '--bubble-aa-surface': bubble.surface,
        } as React.CSSProperties;

        return (
          <button
            key={bubble.id}
            type="button"
            ref={(element) => {
              if (element) {
                bubbleElementsRef.current.set(bubble.id, element);
              } else {
                bubbleElementsRef.current.delete(bubble.id);
              }
            }}
            className={`bubble-overlay__bubble ${emotionClass} ${modeClass}`}
            style={style}
            tabIndex={-1}
            aria-label={bubble.fullText}
            data-sprite-id={bubble.spriteId}
            onFocus={() => {
              activeSpriteIdRef.current = bubble.spriteId;
            }}
            onClick={() => dispatchAgentDetailRequest(bubble.spriteId)}
          >
            <span
              aria-hidden="true"
              className="bubble-overlay__text"
              ref={(element) => {
                if (element) {
                  textElementsRef.current.set(bubble.id, element);
                } else {
                  textElementsRef.current.delete(bubble.id);
                }
              }}
            />
          </button>
        );
      })}
    </div>
  );
}
