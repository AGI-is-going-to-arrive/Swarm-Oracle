/**
 * EventBridge unit tests (Vitest + jsdom)
 *
 * Covers: start/stop lifecycle, on/off subscription, dispatch routing,
 * handler error isolation, duplicate start protection, unknown event
 * handling, and cleanup completeness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBridge, dispatchVizEvent } from './EventBridge';

// Reset after each test
afterEach(() => {
  EventBridge.stop();
});

describe('EventBridge — lifecycle', () => {
  it('start() enables event listening', () => {
    const handler = vi.fn();
    EventBridge.start();
    EventBridge.on('viz:bubble_show', handler);

    dispatchVizEvent('viz:bubble_show', { agent_id: 'a1' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ agent_id: 'a1' });
  });

  it('stop() removes listener and clears handlers', () => {
    const handler = vi.fn();
    EventBridge.start();
    EventBridge.on('viz:bubble_show', handler);
    EventBridge.stop();

    dispatchVizEvent('viz:bubble_show', { agent_id: 'a1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('double start() is idempotent (no duplicate listeners)', () => {
    const handler = vi.fn();
    EventBridge.start();
    EventBridge.start(); // second call should be no-op
    EventBridge.on('viz:bubble_show', handler);

    dispatchVizEvent('viz:bubble_show', { agent_id: 'a1' });

    // Should fire exactly once, not twice
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('EventBridge — on/off subscription', () => {
  beforeEach(() => {
    EventBridge.start();
  });

  it('on() returns an unsubscribe function', () => {
    const handler = vi.fn();
    const unsub = EventBridge.on('viz:agent_move', handler);

    dispatchVizEvent('viz:agent_move', { x: 100, y: 200 });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();

    dispatchVizEvent('viz:agent_move', { x: 300, y: 400 });
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  it('off() removes all handlers for event type', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    EventBridge.on('viz:emotion_change', h1);
    EventBridge.on('viz:emotion_change', h2);

    EventBridge.off('viz:emotion_change');

    dispatchVizEvent('viz:emotion_change', { emotion: 'angry' });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('supports multiple handlers for the same event type', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    EventBridge.on('viz:scene_change', h1);
    EventBridge.on('viz:scene_change', h2);

    dispatchVizEvent('viz:scene_change', { scene: 'medieval_village' });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('supports handlers for different event types independently', () => {
    const bubbleHandler = vi.fn();
    const moveHandler = vi.fn();
    EventBridge.on('viz:bubble_show', bubbleHandler);
    EventBridge.on('viz:agent_move', moveHandler);

    dispatchVizEvent('viz:bubble_show', { text: 'Hello' });

    expect(bubbleHandler).toHaveBeenCalledTimes(1);
    expect(moveHandler).not.toHaveBeenCalled();
  });
});

describe('EventBridge — error handling', () => {
  beforeEach(() => {
    EventBridge.start();
  });

  it('handler error does not break other handlers', () => {
    const errorHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const safeHandler = vi.fn();

    EventBridge.on('viz:event_anim', errorHandler);
    EventBridge.on('viz:event_anim', safeHandler);

    // Suppress console.error for this test
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    dispatchVizEvent('viz:event_anim', { animation: 'earthquake_shake' });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(safeHandler).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});

describe('EventBridge — edge cases', () => {
  beforeEach(() => {
    EventBridge.start();
  });

  it('unknown event type is silently ignored', () => {
    // No handler registered for this type — should not throw
    expect(() => {
      dispatchVizEvent('viz:unknown_type', { data: 'test' });
    }).not.toThrow();
  });

  it('dispatch with missing detail fields is handled gracefully', () => {
    // Dispatch a raw CustomEvent without 'type' in detail
    expect(() => {
      window.dispatchEvent(
        new CustomEvent('viz-event', { detail: {} })
      );
    }).not.toThrow();
  });

  it('dispatch with null detail is handled gracefully', () => {
    expect(() => {
      window.dispatchEvent(
        new CustomEvent('viz-event', { detail: null })
      );
    }).not.toThrow();
  });

  it('events are not received before start()', () => {
    EventBridge.stop(); // ensure stopped
    const handler = vi.fn();
    EventBridge.on('viz:world_split', handler);

    dispatchVizEvent('viz:world_split', { parent: 'p1' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('events dispatched after stop() are not received', () => {
    const handler = vi.fn();
    EventBridge.on('viz:ending_play', handler);
    EventBridge.stop();

    dispatchVizEvent('viz:ending_play', { title: 'Victory' });

    expect(handler).not.toHaveBeenCalled();
  });
});
