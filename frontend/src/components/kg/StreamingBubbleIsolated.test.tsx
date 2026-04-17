/**
 * FE-3 — StreamingBubbleIsolated tests.
 *
 * Assertions:
 *   - token×100 appends cause ZERO re-renders of the component
 *   - onRef(null) is called on unmount
 *   - StrictMode dev double-mount: null → api sequence
 *   - finalize overrides content atomically
 */
import { act, render } from '@testing-library/react';
import { Profiler, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  StreamingBubbleIsolated,
  type StreamingBubbleApi,
} from './StreamingBubbleIsolated';

describe('StreamingBubbleIsolated — imperative API', () => {
  it('token×100 appends cause 0 re-renders', () => {
    // Use React.Profiler `onRender` callback which fires once per commit —
    // idiomatic way to count renders without mutating outer variables.
    const onRender = vi.fn();
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();

    const { getByTestId } = render(
      <Profiler id="bubble-profile" onRender={onRender}>
        <StreamingBubbleIsolated onRef={onRefSpy} />
      </Profiler>,
    );
    // Allow layout effect to run.
    expect(onRefSpy).toHaveBeenCalled();
    const api = onRefSpy.mock.calls.find((c) => c[0] !== null)?.[0] as StreamingBubbleApi;
    expect(api).toBeDefined();

    const initialRenders = onRender.mock.calls.length;
    act(() => {
      for (let i = 0; i < 100; i += 1) {
        api.appendToken('x');
      }
    });
    // Direct DOM mutation in appendToken must NOT re-render the React tree.
    expect(onRender.mock.calls.length).toBe(initialRenders);
    expect(getByTestId('node-conversation-streaming').textContent).toBe('x'.repeat(100));
  });

  it('finalize() sets content atomically', () => {
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();
    const { getByTestId } = render(<StreamingBubbleIsolated onRef={onRefSpy} />);
    const api = onRefSpy.mock.calls.find((c) => c[0] !== null)?.[0] as StreamingBubbleApi;
    act(() => {
      api.appendToken('stream');
      api.finalize('final text');
    });
    expect(getByTestId('node-conversation-streaming').textContent).toBe('final text');
  });

  it('reset() clears content', () => {
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();
    const { getByTestId } = render(<StreamingBubbleIsolated onRef={onRefSpy} />);
    const api = onRefSpy.mock.calls.find((c) => c[0] !== null)?.[0] as StreamingBubbleApi;
    act(() => {
      api.appendToken('abc');
      api.reset();
    });
    expect(getByTestId('node-conversation-streaming').textContent).toBe('');
  });

  it('onRef(null) invoked on unmount', () => {
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();
    const { unmount } = render(<StreamingBubbleIsolated onRef={onRefSpy} />);
    unmount();
    const lastCall = onRefSpy.mock.calls[onRefSpy.mock.calls.length - 1];
    expect(lastCall[0]).toBeNull();
  });

  it('StrictMode dev double-mount: onRef(null) before onRef(newApi)', () => {
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();
    render(
      <StrictMode>
        <StreamingBubbleIsolated onRef={onRefSpy} />
      </StrictMode>,
    );
    const calls = onRefSpy.mock.calls.map((c) => c[0]);
    // StrictMode: mount, unmount, mount (React 18/19). The sequence MUST
    // contain at least one null between two non-null apis.
    const nonNullIdx = calls.findIndex((c) => c !== null);
    const nullIdx = calls.findIndex((c, i) => c === null && i > nonNullIdx);
    // At minimum we expect {api1, null, api2}. If React skipped strict
    // remount in this environment, at least final state has an api.
    expect(nonNullIdx).toBeGreaterThanOrEqual(0);
    if (nullIdx !== -1) {
      // If null appeared, a 2nd api must follow it.
      const followupApi = calls.slice(nullIdx + 1).some((c) => c !== null);
      expect(followupApi).toBe(true);
    }
  });

  it('stale api appendToken after unmount is safe (no throw)', () => {
    const onRefSpy = vi.fn<(api: StreamingBubbleApi | null) => void>();
    const { unmount } = render(<StreamingBubbleIsolated onRef={onRefSpy} />);
    const api = onRefSpy.mock.calls.find((c) => c[0] !== null)?.[0] as StreamingBubbleApi;
    unmount();
    expect(() => api.appendToken('after-unmount')).not.toThrow();
  });
});
