import { useRef } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BubbleOverlay } from './BubbleOverlay';
import { dispatchVizEvent } from './managers/EventBridge';

vi.mock('../hooks/useReducedMotion', () => ({
  default: () => true,
}));

function BubbleOverlayHarness() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={containerRef} data-testid="bubble-harness">
      <div className="phaser-game-container" />
      <BubbleOverlay containerRef={containerRef} />
    </div>
  );
}

describe('BubbleOverlay', () => {
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 450,
      width: 800,
      height: 450,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    rectSpy.mockRestore();
  });

  it('renders DOM bubbles through a polite screen-reader log', async () => {
    render(<BubbleOverlayHarness />);

    act(() => {
      dispatchVizEvent('viz:sprite_positions', {
        agents: [{
          agent_id: 'agent-1',
          name: 'Aurelius',
          x: 220,
          y: 240,
          spriteH: 72,
          visible: true,
          emotion: 'calm',
        }],
        canvasRect: { width: 800, height: 450 },
      });
      dispatchVizEvent('viz:bubble_show', {
        sprite_id: 'agent-1',
        bubble_text: 'Rome holds the line.',
        bubble_mode: 'live',
        emotion: 'calm',
      });
    });

    expect(await screen.findByRole('log')).toHaveAttribute('aria-live', 'polite');
    expect(await screen.findByRole('button', { name: 'Rome holds the line.' })).toBeInTheDocument();
  });

  it('uses distinct unavailable and unknown visuals instead of the neutral class', async () => {
    render(<BubbleOverlayHarness />);

    act(() => {
      dispatchVizEvent('viz:bubble_show', {
        sprite_id: 'agent-unavailable',
        bubble_text: 'Speech with unavailable metadata.',
        bubble_mode: 'live',
        emotion_metadata_status: 'unavailable',
      });
      dispatchVizEvent('viz:bubble_show', {
        sprite_id: 'agent-unknown',
        bubble_text: 'Legacy speech without metadata.',
        bubble_mode: 'live',
      });
    });

    const unavailable = await screen.findByRole('button', { name: 'Speech with unavailable metadata.' });
    const unknown = await screen.findByRole('button', { name: 'Legacy speech without metadata.' });
    expect(unavailable).toHaveClass('bubble-overlay__bubble--emotion-unavailable');
    expect(unavailable).not.toHaveClass('bubble-overlay__bubble--emotion-neutral');
    expect(unknown).toHaveClass('bubble-overlay__bubble--emotion-unknown');
    expect(unknown).not.toHaveClass('bubble-overlay__bubble--emotion-neutral');
  });

  it('keeps explicit neutral metadata on the neutral visual', async () => {
    render(<BubbleOverlayHarness />);

    act(() => {
      dispatchVizEvent('viz:bubble_show', {
        sprite_id: 'agent-neutral',
        bubble_text: 'A neutral observation.',
        emotion: 'neutral',
        emotion_metadata_status: 'available',
      });
    });

    expect(await screen.findByRole('button', { name: 'A neutral observation.' }))
      .toHaveClass('bubble-overlay__bubble--emotion-neutral');
  });

  it('clears bubbles and dispatches agent detail requests from visual bubbles', async () => {
    const detailHandler = vi.fn();
    window.addEventListener('swarm:agent_detail_request', detailHandler);

    try {
      render(<BubbleOverlayHarness />);

      act(() => {
        dispatchVizEvent('viz:bubble_show', {
          sprite_id: 'agent-1',
          bubble_text: 'Commit the reserve.',
          bubble_mode: 'replay',
          emotion: 'confident',
        });
      });

      const bubble = await screen.findByRole('button', { name: 'Commit the reserve.' });
      await userEvent.click(bubble);

      expect(detailHandler).toHaveBeenCalledTimes(1);

      act(() => {
        dispatchVizEvent('viz:clear_bubbles', {});
      });

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Commit the reserve.' })).not.toBeInTheDocument();
      });
    } finally {
      window.removeEventListener('swarm:agent_detail_request', detailHandler);
    }
  });
});
