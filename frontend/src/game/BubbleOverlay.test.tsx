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

function stageRect(width: number, height: number, left: number, top: number): DOMRect {
  return {
    x: left, y: top, left, top, width, height,
    right: left + width, bottom: top + height, toJSON: () => ({}),
  } as DOMRect;
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

  it.each([
    { width: 256, spriteX: 96, center: 128 },
    { width: 256, spriteX: 704, center: 128 },
    { width: 370, spriteX: 96, center: 158 },
    { width: 370, spriteX: 704, center: 212 },
    { width: 370, spriteX: 400, center: 185 },
    { width: 800, spriteX: 96, center: 158 },
    { width: 800, spriteX: 704, center: 642 },
    { width: 800, spriteX: 400, center: 400 },
  ])('keeps the $spriteX sprite bubble readable inside a $width px stage', async ({ width, spriteX, center }) => {
    const bubbleWidth = Math.min(300, width - 16);
    rectSpy.mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('phaser-game-container')
        ? stageRect(width, width * 9 / 16, 70, 62)
        : stageRect(width + 40, width * 9 / 16 + 24, 50, 50);
    });
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockReturnValue(bubbleWidth);
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(80);
    try {
      render(<BubbleOverlayHarness />);
      act(() => {
        dispatchVizEvent('viz:sprite_positions', {
          agents: [{ agent_id: 'edge-agent', name: 'Edge speaker', x: spriteX,
            y: 240, spriteH: 72, visible: true }],
          canvasRect: { width: 800, height: 450 },
        });
        dispatchVizEvent('viz:bubble_show', {
          sprite_id: 'edge-agent', bubble_text: 'The original statement remains readable.',
          bubble_mode: 'replay',
        });
      });
      const bubble = await screen.findByRole('button', {
        name: 'The original statement remains readable.',
      });
      await waitFor(() => expect(bubble.style.opacity).toBe('1'));
      expect(bubble.style.maxInlineSize).toBe(`${width - 16}px`);
      const anchorX = Math.round(20 + spriteX / 800 * width);
      const shiftX = Number.parseFloat(bubble.style.getPropertyValue('--bubble-shift-x'));
      const renderedCenter = anchorX + shiftX;
      expect(renderedCenter).toBe(20 + center);
      expect(renderedCenter - bubbleWidth / 2).toBeGreaterThanOrEqual(28);
      expect(renderedCenter + bubbleWidth / 2).toBeLessThanOrEqual(20 + width - 8);
      expect(bubble.style.transform).toContain(`translate3d(${anchorX}px,`);
      expect(bubble).toHaveAttribute('data-sprite-id', 'edge-agent');
      if (spriteX === 400) expect(shiftX).toBe(0);
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
  });

  it('keeps wrapped speech inside the top edge without changing the sprite anchor', async () => {
    rectSpy.mockReturnValue(stageRect(370, 208.125, 0, 0));
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300);
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(90);
    try {
      render(<BubbleOverlayHarness />);
      act(() => {
        dispatchVizEvent('viz:sprite_positions', {
          agents: [{ agent_id: 'top-agent', name: 'Top speaker', x: 400,
            y: 248, spriteH: 72, visible: true }],
          canvasRect: { width: 800, height: 450 },
        });
        dispatchVizEvent('viz:bubble_show', {
          sprite_id: 'top-agent', bubble_text: 'A wrapped statement stays readable.',
          bubble_mode: 'live',
        });
      });
      const bubble = await screen.findByRole('button', { name: 'A wrapped statement stays readable.' });
      await waitFor(() => expect(bubble.style.opacity).toBe('1'));
      const anchorY = Math.round(248 / 450 * 208.125);
      const lift = Number.parseFloat(bubble.style.getPropertyValue('--bubble-lift'));
      const shiftY = Number.parseFloat(bubble.style.getPropertyValue('--bubble-shift-y'));
      expect(anchorY - lift - 90 + shiftY).toBe(8);
      expect(bubble.style.transform).toContain(`translate3d(185px, ${anchorY}px, 0)`);
    } finally {
      widthSpy.mockRestore();
      heightSpy.mockRestore();
    }
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
