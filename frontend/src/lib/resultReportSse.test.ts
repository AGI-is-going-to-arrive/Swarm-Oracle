import { describe, expect, it, vi } from 'vitest';

import {
  ReportStreamInterruptedError,
  consumeResultReportStream,
} from './resultReportSse';

function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }));
}

function openResponseFrom(chunk: string): {
  cancel: ReturnType<typeof vi.fn>;
  response: Response;
  stream: ReadableStream<Uint8Array>;
} {
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(chunk));
    },
    cancel,
  });
  return { cancel, response: new Response(stream), stream };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<
  | { kind: 'resolved'; value: T }
  | { kind: 'rejected'; error: unknown }
  | { kind: 'timeout' }
> {
  return Promise.race([
    promise.then(
      (value) => ({ kind: 'resolved', value }) as const,
      (error: unknown) => ({ kind: 'rejected', error }) as const,
    ),
    new Promise<{ kind: 'timeout' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    }),
  ]);
}

const freshSignal = (): AbortSignal => new AbortController().signal;

describe('consumeResultReportStream', () => {
  it('parses CRLF frames across chunk boundaries, joins data lines, and ignores comments', async () => {
    const seen: Array<{ event: string; sectionId?: string; tier?: string }> = [];
    const response = responseFrom([
      ': keepalive\r',
      '\n\r\n',
      'event: report_section_complete\r\n',
      'data:{"status":"complete","section_id":"time',
      'line",\r\ndata:"tier":"rewrite","failure_reason":null,"tool_trace":[]}\r',
      '\n\r\nevent: report_complete\r\ndata: {"status":"complete","tool_trace":[]}\r\n\r',
      '\n',
    ]);

    const terminal = await consumeResultReportStream(response, freshSignal(), (event) => {
      seen.push({
        event: event.event,
        sectionId: event.data.section_id,
        tier: event.data.tier,
      });
    });

    expect(seen).toEqual([
      { event: 'report_section_complete', sectionId: 'timeline', tier: 'rewrite' },
      { event: 'report_complete', sectionId: undefined, tier: undefined },
    ]);
    expect(terminal.data.status).toBe('complete');
    expect(response.body?.locked).toBe(false);
  });

  it('does not treat a section-scoped report_failed event as whole-report termination', async () => {
    const seen: string[] = [];

    const terminal = await consumeResultReportStream(responseFrom([
      'event: report_failed\ndata: {"status":"failed","section_id":"factions","error_code":"SECTION_FAILED","failure_reason":"timeout","tool_trace":[]}\n\n',
      'event: report_section_complete\ndata: {"status":"complete","section_id":"timeline","tool_trace":[]}\n\n',
      'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ]), freshSignal(), (event) => seen.push(event.event));

    expect(seen).toEqual([
      'report_failed',
      'report_section_complete',
      'report_complete',
    ]);
    expect(terminal).toMatchObject({
      event: 'report_complete',
      data: { status: 'failed' },
    });
  });

  it('keeps the terminal event sticky and ignores a later delta already in the buffer', async () => {
    const seen: string[] = [];

    const terminal = await consumeResultReportStream(responseFrom([
      'event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n'
        + 'event: report_section_delta\ndata: {"status":"generating","section_id":"late","tool_trace":[]}\n\n',
    ]), freshSignal(), (event) => seen.push(event.event));

    expect(seen).toEqual(['report_complete']);
    expect(terminal).toMatchObject({
      event: 'report_complete',
      data: { status: 'complete' },
    });
  });

  it('cancels an open body and resolves as soon as the terminal event arrives', async () => {
    const { cancel, response, stream } = openResponseFrom(
      'event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n',
    );
    const controller = new AbortController();
    const result = consumeResultReportStream(response, controller.signal, () => undefined);

    const outcome = await settleWithin(result, 100);
    if (outcome.kind === 'timeout') {
      controller.abort(new DOMException('Test cleanup', 'AbortError'));
      await result.catch(() => undefined);
    }

    expect(outcome).toMatchObject({
      kind: 'resolved',
      value: { event: 'report_complete', data: { status: 'complete' } },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each(['complete', 'failed', 'cancelled', 'skipped', 'partial'] as const)(
    'accepts one report_complete event with legacy-compatible terminal status %s',
    async (status) => {
      const terminal = await consumeResultReportStream(responseFrom([
        `event: report_complete\ndata: {"status":"${status}","tool_trace":[]}\n\n`,
      ]), freshSignal(), () => undefined);

      expect(terminal.data.status).toBe(status);
    },
  );

  it('fails closed when EOF arrives without report_complete', async () => {
    await expect(consumeResultReportStream(responseFrom([
      'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
      'event: report_failed\ndata: {"status":"failed","section_id":"timeline","tool_trace":[]}\n\n',
    ]), freshSignal(), () => undefined)).rejects.toBeInstanceOf(ReportStreamInterruptedError);
  });

  it('fails closed for a null or zero-length response body', async () => {
    await expect(consumeResultReportStream(
      new Response(null),
      freshSignal(),
      () => undefined,
    )).rejects.toMatchObject({ name: 'ReportStreamInterruptedError' });

    await expect(consumeResultReportStream(
      responseFrom([]),
      freshSignal(),
      () => undefined,
    )).rejects.toMatchObject({ name: 'ReportStreamInterruptedError' });
  });

  it('fails closed for malformed JSON data', async () => {
    await expect(consumeResultReportStream(responseFrom([
      'event: report_complete\ndata: {"status":"complete"\n\n',
    ]), freshSignal(), () => undefined)).rejects.toMatchObject({
      name: 'ReportStreamInterruptedError',
    });
  });

  it.each([
    [
      'malformed JSON',
      'event: report_started\ndata: {"status":"generating"\n\n',
    ],
    [
      'an unknown event',
      'event: report_mystery\ndata: {"status":"generating","tool_trace":[]}\n\n',
    ],
  ])('cancels and releases an open body after %s', async (_label, chunk) => {
    const { cancel, response, stream } = openResponseFrom(chunk);

    await expect(consumeResultReportStream(
      response,
      freshSignal(),
      () => undefined,
    )).rejects.toMatchObject({ name: 'ReportStreamInterruptedError' });

    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('cancels and releases an open body when onEvent throws', async () => {
    const { cancel, response, stream } = openResponseFrom(
      'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
    );
    const callbackError = new Error('render failed');

    await expect(consumeResultReportStream(response, freshSignal(), () => {
      throw callbackError;
    })).rejects.toBe(callbackError);

    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('fails closed for an unknown report_complete status', async () => {
    await expect(consumeResultReportStream(responseFrom([
      'event: report_complete\ndata: {"status":"mystery","tool_trace":[]}\n\n',
    ]), freshSignal(), () => undefined)).rejects.toMatchObject({
      name: 'ReportStreamInterruptedError',
    });
  });

  it('fails closed when the stream contains duplicate terminal events', async () => {
    await expect(consumeResultReportStream(responseFrom([
      'event: report_complete\ndata: {"status":"complete","tool_trace":[]}\n\n'
        + 'event: report_complete\ndata: {"status":"failed","tool_trace":[]}\n\n',
    ]), freshSignal(), () => undefined)).rejects.toMatchObject({
      name: 'ReportStreamInterruptedError',
    });
  });

  it('cancels the reader and releases its lock when aborted', async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: report_started\ndata: {"status":"generating","tool_trace":[]}\n\n',
        ));
      },
      cancel,
    });
    const response = new Response(stream);
    const controller = new AbortController();

    const result = consumeResultReportStream(response, controller.signal, () => undefined);
    await vi.waitFor(() => expect(stream.locked).toBe(true));
    controller.abort(new DOMException('Report generation aborted', 'AbortError'));

    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });
});
