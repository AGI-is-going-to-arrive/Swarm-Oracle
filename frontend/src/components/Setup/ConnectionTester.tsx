/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Setup Wizard Connection Tester (S0-1)
   ═══════════════════════════════════════════════════════════
   Calls POST /api/health/test and surfaces a 4-state UI:
   idle / testing / success / error.
   - StatusDot is inlined (per task spec — no separate file)
   - aria-live="polite" announces state transitions
   - JSON pre log is collapsible-by-default to keep the UI quiet
*/

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { testLlmConnection, isApiError } from '../../api/client';

export interface ConnectionTesterProps {
  baseUrl: string;
  apiKey: string;
  model?: string;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  // Custom translations to override setup.*
  testButtonText?: string;
  testingText?: string;
  testIdleText?: string;
  testSuccessText?: string;
  testFailureText?: string;
  testFailureNetworkText?: string;
  showLogText?: string;
  hideLogText?: string;
}

export type TesterStatus = 'idle' | 'testing' | 'success' | 'error';

interface BackendLlmResult {
  status?: 'ok' | 'error' | string;
  model?: string | null;
  response?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

interface TestResultPayload {
  status?: 'success' | 'error';
  message?: string;
  latency_ms?: number | null;
  server?: string;
  llm?: BackendLlmResult | null;
  [key: string]: unknown;
}

interface NormalizedTestResult {
  status: 'success' | 'error';
  message: string;
  latencyMs: number | null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : null;
}

function normalizeTestResult(
  payload: TestResultPayload,
  fallbackSuccess: string,
  fallbackFailure: string,
): NormalizedTestResult {
  if (payload.status === 'success') {
    return {
      status: 'success',
      message: readText(payload.message) ?? fallbackSuccess,
      latencyMs: typeof payload.latency_ms === 'number' ? payload.latency_ms : null,
    };
  }

  if (payload.status === 'error') {
    return {
      status: 'error',
      message: readText(payload.message) ?? fallbackFailure,
      latencyMs: null,
    };
  }

  if (payload.llm?.status === 'ok') {
    return {
      status: 'success',
      message: readText(payload.llm.response) ?? fallbackSuccess,
      latencyMs: null,
    };
  }

  if (payload.llm?.status === 'error') {
    return {
      status: 'error',
      message: readText(payload.llm.error) ?? fallbackFailure,
      latencyMs: null,
    };
  }

  return {
    status: 'error',
    message: fallbackFailure,
    latencyMs: null,
  };
}

export function ConnectionTester({
  baseUrl,
  apiKey,
  model,
  requestsPerMinute,
  tokensPerMinute,
  testButtonText,
  testingText,
  testIdleText,
  testSuccessText,
  testFailureText,
  testFailureNetworkText,
  showLogText,
  hideLogText,
}: ConnectionTesterProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TesterStatus>('idle');
  const [message, setMessage] = useState<string>('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rawPayload, setRawPayload] = useState<TestResultPayload | null>(null);
  const [showLog, setShowLog] = useState<boolean>(false);

  const runTest = async () => {
    setStatus('testing');
    setMessage(testingText || t('setup.testing'));
    setLatencyMs(null);
    setRawPayload(null);

    try {
      const payload = await testLlmConnection(
        apiKey || undefined,
        baseUrl || undefined,
        model || undefined,
        requestsPerMinute,
        tokensPerMinute,
      );
      const result = normalizeTestResult(
        payload as TestResultPayload,
        testSuccessText || t('setup.test_success'),
        testFailureText || t('setup.test_failure'),
      );
      setRawPayload(payload as TestResultPayload);
      setStatus(result.status);
      setMessage(result.message);
      setLatencyMs(result.latencyMs);
    } catch (err) {
      // ApiError (HTTP-level failure) vs network/parse failures.
      if (isApiError(err)) {
        const errorMessage = err.message || testFailureText || t('setup.test_failure');
        const errorPayload: TestResultPayload = {
          status: 'error',
          message: errorMessage,
        };
        setRawPayload(errorPayload);
        setStatus('error');
        setMessage(errorMessage);
      } else {
        setStatus('error');
        setMessage(testFailureNetworkText || t('setup.test_failure_network'));
      }
    }
  };

  const dotClass = `status-dot status-dot--${status}`;
  const canTest = baseUrl.trim().length > 0 && status !== 'testing';

  return (
    <div className="tester">
      <div className="tester__row">
        <button
          type="button"
          className="tester__btn"
          onClick={runTest}
          disabled={!canTest}
          aria-label={testButtonText || t('setup.test_button')}
        >
          {status === 'testing' ? (testingText || t('setup.testing')) : (testButtonText || t('setup.test_button'))}
        </button>
        <span className={dotClass} aria-hidden="true" />
        <span
          className="tester__status-text"
          aria-live="polite"
          role="status"
        >
          {status === 'idle' ? (testIdleText || t('setup.test_idle')) : message}
          {status === 'success' && latencyMs != null
            ? ` · ${latencyMs} ms`
            : ''}
        </span>
      </div>

      {rawPayload ? (
        <div className="tester__log-wrap">
          <button
            type="button"
            className="tester__log-toggle"
            onClick={() => setShowLog((prev) => !prev)}
            aria-expanded={showLog}
          >
            {showLog ? (hideLogText || t('setup.hide_log')) : (showLogText || t('setup.show_log'))}
          </button>
          {showLog ? (
            <pre className="tester__log">
              {JSON.stringify(rawPayload, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default ConnectionTester;
