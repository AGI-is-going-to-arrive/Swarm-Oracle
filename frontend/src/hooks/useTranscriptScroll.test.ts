import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTranscriptScroll } from './useTranscriptScroll';

describe('useTranscriptScroll', () => {
  it('initializes with default ref values', () => {
    const { result } = renderHook(() => useTranscriptScroll());

    expect(result.current.listRef.current).toBeNull();
    expect(result.current.autoStickRef.current).toBe(false);
    expect(result.current.hydratedRef.current).toBe(false);
    expect(result.current.scrollSnapshotRef.current).toBeNull();
  });

  it('captures scroll snapshot from a mock element', () => {
    const { result } = renderHook(() => useTranscriptScroll());

    const mockEl = {
      scrollHeight: 1000,
      scrollTop: 900,
      clientHeight: 100,
    } as HTMLDivElement;

    Object.defineProperty(result.current.listRef, 'current', {
      value: mockEl,
      writable: true,
    });

    act(() => {
      result.current.captureSnapshot();
    });

    const snapshot = result.current.scrollSnapshotRef.current;
    expect(snapshot).not.toBeNull();
    expect(snapshot!.scrollHeight).toBe(1000);
    expect(snapshot!.bottomOffset).toBe(0);
  });

  it('detects near-bottom correctly', () => {
    const { result } = renderHook(() => useTranscriptScroll());

    const mockEl = {
      scrollHeight: 1000,
      scrollTop: 850,
      clientHeight: 100,
    } as HTMLDivElement;

    Object.defineProperty(result.current.listRef, 'current', {
      value: mockEl,
      writable: true,
    });

    expect(result.current.isNearBottom(60)).toBe(true);

    (mockEl as { scrollTop: number }).scrollTop = 500;
    expect(result.current.isNearBottom(60)).toBe(false);
  });

  it('returns stable function references across renders', () => {
    const { result, rerender } = renderHook(() => useTranscriptScroll());

    const firstCapture = result.current.captureSnapshot;
    const firstScroll = result.current.scrollToBottom;
    const firstHandle = result.current.handleScroll;

    rerender();

    expect(result.current.captureSnapshot).toBe(firstCapture);
    expect(result.current.scrollToBottom).toBe(firstScroll);
    expect(result.current.handleScroll).toBe(firstHandle);
  });
});
