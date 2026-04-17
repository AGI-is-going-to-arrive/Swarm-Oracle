/**
 * FE-3 (HC-40) — Global reconnect scheduler singleton.
 *
 * Ensures at most N concurrent in-flight WS reconnect attempts across the
 * entire app. Each caller registers with a `reconnectKey` (e.g. thread_id),
 * a backoff-delay-ms computed by the hook, and a `connectFn`. The scheduler
 * queues requests beyond the concurrency cap and dispatches FIFO.
 *
 * Exported as a pure object singleton so it can be mocked in tests via
 * `createReconnectScheduler()`.
 */

export interface ReconnectScheduler {
  /**
   * Request a reconnect attempt. `connectFn` is invoked after `delayMs`
   * when the active slot opens up. Returns a cancel token; callers MUST
   * invoke `cancel()` on unmount to avoid orphan timers.
   */
  schedule: (
    reconnectKey: string,
    delayMs: number,
    connectFn: () => void,
  ) => { cancel: () => void };
  /**
   * Mark an in-flight attempt as completed (success or terminal failure).
   * Frees the active slot so the next queued request can run.
   */
  release: (reconnectKey: string) => void;
  /** Current active in-flight attempts (tests only). */
  activeCount: () => number;
  /** Current queued depth (tests only). */
  queueDepth: () => number;
}

interface QueueEntry {
  reconnectKey: string;
  delayMs: number;
  connectFn: () => void;
  cancelled: boolean;
}

const DEFAULT_MAX_CONCURRENT = 3;

export function createReconnectScheduler(maxConcurrent = DEFAULT_MAX_CONCURRENT): ReconnectScheduler {
  const active = new Set<string>();
  const queue: QueueEntry[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const runNext = () => {
    while (active.size < maxConcurrent && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.cancelled) continue;
      active.add(entry.reconnectKey);
      const timer = setTimeout(() => {
        timers.delete(entry.reconnectKey);
        if (entry.cancelled) {
          active.delete(entry.reconnectKey);
          runNext();
          return;
        }
        try {
          entry.connectFn();
        } catch (err) {
          // Failure of connectFn releases slot; caller must also call release()
          // on terminal outcome to match the happy path contract.
          active.delete(entry.reconnectKey);
          runNext();
          throw err;
        }
      }, Math.max(0, entry.delayMs));
      timers.set(entry.reconnectKey, timer);
    }
  };

  return {
    schedule(reconnectKey, delayMs, connectFn) {
      const entry: QueueEntry = { reconnectKey, delayMs, connectFn, cancelled: false };
      queue.push(entry);
      runNext();
      return {
        cancel() {
          entry.cancelled = true;
          const timer = timers.get(reconnectKey);
          if (timer) {
            clearTimeout(timer);
            timers.delete(reconnectKey);
            active.delete(reconnectKey);
            runNext();
          }
        },
      };
    },
    release(reconnectKey) {
      if (active.delete(reconnectKey)) {
        runNext();
      }
    },
    activeCount: () => active.size,
    queueDepth: () => queue.length,
  };
}

/** Global singleton used by `useAgentConversationWS`. */
export const globalReconnectScheduler: ReconnectScheduler = createReconnectScheduler();

/**
 * Exponential backoff with ±25% jitter.
 * Sequence: 1 → 2 → 4 → 8 → 16 → 60s (capped).
 */
export function computeBackoffDelayMs(attempt: number): number {
  const base = Math.min(Math.pow(2, Math.max(0, attempt)), 60);
  const jitter = (Math.random() * 0.5 - 0.25) * base;
  return Math.max(0, Math.round((base + jitter) * 1000));
}
