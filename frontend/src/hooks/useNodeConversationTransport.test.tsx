import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useNodeConversationTransport } from './useNodeConversationTransport';

describe('useNodeConversationTransport', () => {
  it('keeps transport callbacks stable when origin values stay the same', () => {
    const setThreadId = vi.fn();
    const onTransportError = vi.fn();
    const onWsEvent = vi.fn();

    const { result, rerender } = renderHook(
      ({ origin }: { origin: { nodeId: string; nodeType: string } }) =>
        useNodeConversationTransport({
          scenarioId: 'scenario-1',
          identityId: 'identity-1',
          originNodeId: origin.nodeId,
          originNodeType: origin.nodeType,
          setThreadId,
          onTransportError,
          onWsEvent,
        }),
      {
        initialProps: {
          origin: {
            nodeId: 'node-1',
            nodeType: 'argument',
          },
        },
      },
    );

    const initialStartConversation = result.current.startConversation;
    const initialStreamTurn = result.current.streamTurn;

    rerender({
      origin: {
        nodeId: 'node-1',
        nodeType: 'argument',
      },
    });

    expect(result.current.startConversation).toBe(initialStartConversation);
    expect(result.current.streamTurn).toBe(initialStreamTurn);
  });
});
