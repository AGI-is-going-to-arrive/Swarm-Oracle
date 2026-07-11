/**
 * EventBridge — Routes viz:* WebSocket events to Phaser scenes.
 *
 * The bridge uses DOM CustomEvents as an intermediary between the
 * React WS layer and the Phaser game instance.  This avoids coupling
 * Phaser directly to Zustand and keeps the viz subsystem modular.
 *
 * Flow:  WS message → useSimulationWS → window.dispatchEvent(CustomEvent)
 *                                    → EventBridge.on() → Phaser scene handler
 */

export type VizEventType =
  | 'viz:scene_init'
  | 'viz:agent_move'
  | 'viz:bubble_show'
  | 'viz:world_split'
  | 'viz:event_anim'
  | 'viz:emotion_change'
  | 'viz:scene_change'
  | 'viz:ending_play'
  | 'viz:weather_change'
  | 'viz:clear_bubbles'
  | 'viz:sprite_positions'
  | 'viz:faction_cluster'
  | 'viz:faction_event';

export interface SpritePositionUpdate {
  agents: Array<{
    agent_id: string;
    name: string;
    x: number;
    y: number;
    spriteH: number;
    visible: boolean;
    emotion?: string;
  }>;
  canvasRect: {
    width: number;
    height: number;
  };
}

export type EmotionMetadataStatus = 'available' | 'unavailable';

export interface BubbleEmotionSource {
  emotion?: string | null;
  emotion_metadata_status?: EmotionMetadataStatus;
  emotion_metadata_failure_code?: string;
}

export interface BubbleShowPayload extends Record<string, unknown> {
  sprite_id?: string;
  bubble_text?: string;
  bubble_mode?: 'live' | 'replay';
  emotion?: string;
  emotion_metadata_status?: 'available' | 'unavailable';
  emotion_metadata_failure_code?: string;
  halo_color?: string;
}

export function bubbleEmotionPayload(
  source: BubbleEmotionSource,
): Pick<
  BubbleShowPayload,
  'emotion' | 'emotion_metadata_status' | 'emotion_metadata_failure_code'
> {
  if (source.emotion_metadata_status === 'unavailable') {
    return {
      emotion_metadata_status: 'unavailable',
      ...(source.emotion_metadata_failure_code
        ? { emotion_metadata_failure_code: source.emotion_metadata_failure_code }
        : {}),
    };
  }

  const emotion = typeof source.emotion === 'string' ? source.emotion.trim() : '';
  return {
    ...(emotion ? { emotion } : {}),
    ...(source.emotion_metadata_status === 'available'
      ? { emotion_metadata_status: 'available' as const }
      : {}),
  };
}

export function resolveBubbleEmotionState(
  emotion: unknown,
  emotionMetadataStatus: unknown,
  supportedEmotions: ReadonlySet<string>,
): string {
  if (emotionMetadataStatus === 'unavailable') return 'unavailable';
  const normalizedEmotion = typeof emotion === 'string' ? emotion.trim() : '';
  return normalizedEmotion && supportedEmotions.has(normalizedEmotion)
    ? normalizedEmotion
    : 'unknown';
}

export function shouldClearEmotionHalo(emotionState: string): boolean {
  return emotionState === 'neutral'
    || emotionState === 'unknown'
    || emotionState === 'unavailable';
}

export interface VizEventPayloadMap {
  'viz:bubble_show': BubbleShowPayload;
  'viz:clear_bubbles': Record<string, never>;
  'viz:sprite_positions': SpritePositionUpdate;
}

export type VizEventPayload<T extends string> =
  T extends keyof VizEventPayloadMap ? VizEventPayloadMap[T] : Record<string, unknown>;

export type VizHandler<T extends string = string> = (data: VizEventPayload<T>) => void;

class EventBridgeClass {
  private handlers: Map<string, Set<(data: Record<string, unknown>) => void>> = new Map();
  private domListener: ((e: Event) => void) | null = null;
  private active = false;

  /**
   * Start listening for viz:* CustomEvents on window.
   * Call once when Phaser game mounts.
   */
  start(): void {
    if (this.active) return;
    this.active = true;

    this.domListener = (e: Event) => {
      if (!this.active) return;
      const ce = e as CustomEvent;
      const { type: vizType, data } = ce.detail ?? {};
      if (!vizType) return;

      const fns = this.handlers.get(vizType);
      if (fns) {
        for (const fn of fns) {
          try {
            fn(data);
          } catch (err) {
            console.error(`[EventBridge] Handler error for ${vizType}:`, err);
          }
        }
      }
    };

    window.addEventListener('viz-event', this.domListener);
    console.log('[EventBridge] Started listening');
  }

  /**
   * Stop listening.  Call when Phaser game unmounts.
   */
  stop(): void {
    this.active = false;
    if (this.domListener) {
      window.removeEventListener('viz-event', this.domListener);
      this.domListener = null;
    }
    this.handlers.clear();
    console.log('[EventBridge] Stopped');
  }

  /**
   * Register a handler for a specific viz event type.
   */
  on<T extends VizEventType | string>(eventType: T, handler: VizHandler<T>): () => void {
    const set = this.handlers.get(eventType) ?? new Set();
    const normalizedHandler = handler as (data: Record<string, unknown>) => void;
    set.add(normalizedHandler);
    this.handlers.set(eventType, set);
    return () => {
      set.delete(normalizedHandler);
      if (set.size === 0) this.handlers.delete(eventType);
    };
  }

  /**
   * Remove all handlers for a specific event type.
   */
  off(eventType: VizEventType | string): void {
    this.handlers.delete(eventType);
  }

  /**
   * Dispatch a viz event (used by the WS layer).
   * This fires a CustomEvent on `window` which the bridge picks up.
   */
  static dispatch<T extends VizEventType | string>(type: T, data: VizEventPayload<T>): void {
    window.dispatchEvent(
      new CustomEvent('viz-event', { detail: { type, data } })
    );
  }
}

/** Singleton instance */
export const EventBridge = new EventBridgeClass();

/**
 * Convenience: dispatch a viz:* event from the WS layer.
 */
export function dispatchVizEvent<T extends VizEventType | string>(type: T, data: VizEventPayload<T>): void {
  EventBridgeClass.dispatch(type, data);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    EventBridge.stop();
  });
}
