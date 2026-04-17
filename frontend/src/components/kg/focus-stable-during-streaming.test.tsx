/**
 * FE-3 — Focus stability during streaming.
 *
 * Contract (plan §FE-3 step 8):
 *   During streaming token append, if textarea / send / close is the current
 *   activeElement, incoming token deltas must ONLY update bubble textContent
 *   + scrollTop. They must NEVER call `element.focus()` which would steal
 *   focus.
 *
 * This test verifies by registering a bubble with useAgentConversation,
 * focusing a sibling <input>, firing 50 token_token_delta events, and
 * asserting the sibling input remains document.activeElement.
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useAgentConversation } from '../../hooks/useAgentConversation';

describe('Focus stability during streaming', () => {
  it('token×50 flow does not steal focus from external input', () => {
    const { result } = renderHook(() => useAgentConversation());

    // Create a real DOM input and focus it.
    const input = document.createElement('input');
    input.setAttribute('data-testid', 'external-input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    // Register a bubble that mutates a separate DOM node.
    const bubble = document.createElement('span');
    document.body.appendChild(bubble);
    act(() => {
      result.current.registerStreamBubble('b1', {
        appendToken: (delta) => {
          bubble.textContent = (bubble.textContent ?? '') + delta;
        },
        finalize: () => {},
        reset: () => {
          bubble.textContent = '';
        },
      });
    });

    // Drive turn_started + 50 token deltas through useAgentConversation.
    act(() => {
      result.current.dispatchWsEvent({
        type: 'turn_started',
        thread_id: 'th',
        turn_id: 'b1',
        sequence: 1,
      });
      for (let i = 0; i < 50; i += 1) {
        result.current.dispatchWsEvent({
          type: 'turn_token_delta',
          turn_id: 'b1',
          delta: 'x',
        });
      }
    });

    // Focus MUST remain on the external input.
    expect(document.activeElement).toBe(input);
    expect(bubble.textContent).toBe('x'.repeat(50));

    // Cleanup DOM.
    document.body.removeChild(input);
    document.body.removeChild(bubble);
  });
});
