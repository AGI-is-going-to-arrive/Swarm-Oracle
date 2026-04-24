import { vi } from 'vitest';

export class NoopWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = NoopWebSocket.OPEN;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = NoopWebSocket.CLOSED;
  });

  constructor(url = '') {
    this.url = url;
  }
}

export function stubNoopWebSocket(): void {
  vi.stubGlobal('WebSocket', NoopWebSocket as unknown as typeof WebSocket);
}
