import type {
  ReportStatus,
  ReportSectionFailureReason,
  ReportTier,
  ResultReportSSEEvent,
  ToolTraceSummary,
} from '../types';

const REPORT_EVENT_NAMES = new Set<ResultReportSSEEvent['event']>([
  'report_started',
  'report_section_delta',
  'report_section_complete',
  'report_failed',
  'report_complete',
]);

const REPORT_STATUSES = new Set<ResultReportSSEEvent['data']['status']>([
  'pending',
  'generating',
  'complete',
  'partial',
  'failed',
  'cancelled',
  'skipped',
]);

const REPORT_TIERS = new Set<ReportTier>(['generation', 'rewrite', 'static']);

const SECTION_FAILURE_REASONS = new Set<ReportSectionFailureReason>([
  'timeout',
  'tool_floor_not_met',
  'empty_outline',
  'json_parse_error',
  'plan_outline_timeout',
  'unsupported_action',
  'tool_budget_exhausted',
  'empty_body',
  'other',
]);

export const REPORT_TERMINAL_STATUSES: ReadonlySet<ReportStatus> = new Set([
  'complete',
  'failed',
  'cancelled',
  'skipped',
  // Persisted pre-Wave-2 reports used partial as their terminal status.
  'partial',
]);

export class ReportStreamInterruptedError extends Error {
  override readonly name = 'ReportStreamInterruptedError';
}

function interrupted(message: string): ReportStreamInterruptedError {
  return new ReportStreamInterruptedError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function isToolTraceSummary(value: unknown): value is ToolTraceSummary {
  if (!isRecord(value)) return false;
  return typeof value.tool === 'string'
    && typeof value.query === 'string'
    && typeof value.item_count === 'number'
    && Number.isFinite(value.item_count)
    && typeof value.elapsed_ms === 'number'
    && Number.isFinite(value.elapsed_ms);
}

function parseData(dataText: string): ResultReportSSEEvent['data'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataText) as unknown;
  } catch {
    throw interrupted('Result report stream contained malformed JSON data.');
  }

  if (!isRecord(parsed)
    || typeof parsed.status !== 'string'
    || !REPORT_STATUSES.has(parsed.status as ResultReportSSEEvent['data']['status'])
    || !Array.isArray(parsed.tool_trace)
    || !parsed.tool_trace.every(isToolTraceSummary)
    || !isOptionalString(parsed, 'report_id')
    || !isOptionalString(parsed, 'section_id')
    || !isOptionalString(parsed, 'message')
    || !isOptionalString(parsed, 'error_code')) {
    throw interrupted('Result report stream contained invalid event data.');
  }

  if (parsed.tier !== undefined
    && (typeof parsed.tier !== 'string' || !REPORT_TIERS.has(parsed.tier as ReportTier))) {
    throw interrupted('Result report stream contained an invalid tier.');
  }

  if (parsed.failure_reason !== undefined
    && parsed.failure_reason !== null
    && (typeof parsed.failure_reason !== 'string'
      || !SECTION_FAILURE_REASONS.has(parsed.failure_reason as ReportSectionFailureReason))) {
    throw interrupted('Result report stream contained an invalid section failure reason.');
  }

  return parsed as unknown as ResultReportSSEEvent['data'];
}

function parseFrame(frame: string): ResultReportSSEEvent | null {
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    let value = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') eventName = value;
    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  if (eventName === null || !REPORT_EVENT_NAMES.has(eventName as ResultReportSSEEvent['event'])) {
    throw interrupted('Result report stream contained an unknown event.');
  }

  return {
    event: eventName as ResultReportSSEEvent['event'],
    data: parseData(dataLines.join('\n')),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Report generation aborted', 'AbortError');
}

export async function consumeResultReportStream(
  response: Response,
  signal: AbortSignal,
  onEvent: (event: ResultReportSSEEvent) => void,
): Promise<ResultReportSSEEvent> {
  if (!response.body) {
    throw interrupted('Result report response body was empty.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal: ResultReportSSEEvent | null = null;
  let cancelPromise: Promise<void> | null = null;
  let reachedEof = false;

  const cancelReader = (reason?: unknown): Promise<void> => {
    cancelPromise ??= reader.cancel(reason).catch(() => undefined);
    return cancelPromise;
  };

  const acceptFrame = (frame: string) => {
    const event = parseFrame(frame);
    if (!event) return;

    if (terminal) {
      if (event.event === 'report_complete') {
        throw interrupted('Result report stream contained duplicate terminal events.');
      }
      return;
    }

    if (event.event === 'report_complete') {
      if (!REPORT_TERMINAL_STATUSES.has(event.data.status as ReportStatus)) {
        throw interrupted('Result report stream ended with an unknown terminal status.');
      }
      terminal = event;
    }

    onEvent(event);
  };

  const drainFrames = () => {
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary || boundary.index === undefined) return;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      acceptFrame(frame);
    }
  };

  const handleAbort = () => {
    void cancelReader(abortReason(signal));
  };

  signal.addEventListener('abort', handleAbort, { once: true });
  try {
    if (signal.aborted) {
      handleAbort();
      throw abortReason(signal);
    }

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        if (signal.aborted) throw abortReason(signal);
        throw interrupted('Result report stream could not be read.');
      }

      if (signal.aborted) throw abortReason(signal);
      if (chunk.done) {
        reachedEof = true;
        buffer += decoder.decode();
        drainFrames();
        if (buffer.trim()) acceptFrame(buffer);
        buffer = '';
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      drainFrames();
      if (terminal) break;
    }

    if (!terminal) {
      throw interrupted('Result report stream ended before report_complete.');
    }
    return terminal;
  } finally {
    signal.removeEventListener('abort', handleAbort);
    if (!reachedEof) void cancelReader(signal.aborted ? abortReason(signal) : undefined);
    if (cancelPromise) await cancelPromise;
    reader.releaseLock();
  }
}
