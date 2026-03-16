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
  | 'viz:bet_update'
  | 'viz:leaderboard_update';

export type VizHandler = (data: Record<string, unknown>) => void;

class EventBridgeClass {
  private handlers: Map<string, Set<VizHandler>> = new Map();
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
    if (this.domListener) {
      window.removeEventListener('viz-event', this.domListener);
      this.domListener = null;
    }
    this.active = false;
    this.handlers.clear();
    console.log('[EventBridge] Stopped');
  }

  /**
   * Register a handler for a specific viz event type.
   */
  on(eventType: VizEventType | string, handler: VizHandler): () => void {
    const set = this.handlers.get(eventType) ?? new Set();
    set.add(handler);
    this.handlers.set(eventType, set);
    return () => {
      set.delete(handler);
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
  static dispatch(type: string, data: Record<string, unknown>): void {
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
export function dispatchVizEvent(type: string, data: Record<string, unknown>): void {
  EventBridgeClass.dispatch(type, data);
}
