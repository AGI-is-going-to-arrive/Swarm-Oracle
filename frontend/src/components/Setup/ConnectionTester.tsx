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
import { testLlmConnection, probeNativeSearch, isApiError } from '../../api/client';
import type { NativeSearchProbe } from '../../api/client';

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
  testTimeoutText?: string;
  showLogText?: string;
  hideLogText?: string;
  /** When true the test button is disabled (e.g. an edited profile whose stored
   *  key isn't available client-side); disabledHint explains why in the status line. */
  disabled?: boolean;
  disabledHint?: string;
  /** When true, also request a native-search static probe (model-profiles page). */
  includeNativeProbe?: boolean;
  /** Native search upstream override. */
  nativeSearchUpstream?: string;
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
  native_search?: NativeSearchProbe | null;
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
  testTimeoutText,
  showLogText,
  hideLogText,
  disabled,
  disabledHint,
  includeNativeProbe,
  nativeSearchUpstream,
}: ConnectionTesterProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TesterStatus>('idle');
  const [message, setMessage] = useState<string>('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rawPayload, setRawPayload] = useState<TestResultPayload | null>(null);
  const [showLog, setShowLog] = useState<boolean>(false);
  const [nativeStatus, setNativeStatus] = useState<'idle' | 'probing' | 'success' | 'error'>('idle');
  const [nativeResult, setNativeResult] = useState<NativeSearchProbe | null>(null);

  const runTest = async () => {
    setStatus('testing');
    setMessage(testingText || t('setup.testing'));
    setLatencyMs(null);
    setRawPayload(null);

    if (includeNativeProbe) {
      setNativeStatus('probing');
      setNativeResult(null);
    } else {
      setNativeStatus('idle');
      setNativeResult(null);
    }

    const promises: Promise<void>[] = [];

    if (includeNativeProbe) {
      promises.push((async () => {
        try {
          const nativeData = await probeNativeSearch(
            apiKey || undefined,
            baseUrl || undefined,
            model || undefined,
            nativeSearchUpstream,
          );
          setNativeResult(nativeData);
          setNativeStatus(nativeData ? 'success' : 'error');
          setRawPayload((prev) => ({
            ...prev,
            native_search: nativeData,
          }));
        } catch {
          setNativeStatus('error');
          setRawPayload((prev) => ({
            ...prev,
            native_search: null,
          }));
        }
      })());
    }

    promises.push((async () => {
      try {
        const payload = await testLlmConnection(
          apiKey || undefined,
          baseUrl || undefined,
          model || undefined,
          requestsPerMinute,
          tokensPerMinute,
          false,
          false,
          nativeSearchUpstream,
        );
        const result = normalizeTestResult(
          payload as TestResultPayload,
          testSuccessText || t('setup.test_success'),
          testFailureText || t('setup.test_failure'),
        );
        setRawPayload((prev) => {
          // 完整测试走 includeNativeProbe=false，后端 native_search 恒为 null；
          // 保留 native 快探测已写入的值，避免覆盖调试日志里的 native_search。
          const next: TestResultPayload = { ...prev, ...payload };
          if (next.native_search == null && prev?.native_search != null) {
            next.native_search = prev.native_search;
          }
          return next;
        });
        setStatus(result.status);
        setMessage(result.message);
        setLatencyMs(result.latencyMs);
      } catch (err) {
        // ApiError (HTTP-level failure) vs network/parse failures.
        let errorMessage = '';
        if (isApiError(err)) {
          errorMessage = err.message || testFailureText || t('setup.test_failure');
          setRawPayload((prev) => ({
            ...prev,
            status: 'error',
            message: errorMessage,
          }));
          setStatus('error');
          setMessage(errorMessage);
        } else {
          setStatus('error');
          const isTimeout = err instanceof Error && /timed out/i.test(err.message);
          errorMessage = isTimeout
            ? (testTimeoutText || t('setup.test_failure_timeout'))
            : (testFailureNetworkText || t('setup.test_failure_network'));
          setMessage(errorMessage);
        }
      }
    })());

    await Promise.all(promises);
  };

  const dotClass = `status-dot status-dot--${status}`;
  const canTest = baseUrl.trim().length > 0 && status !== 'testing' && !disabled;

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
          {status === 'idle'
            ? (disabled && disabledHint ? disabledHint : (testIdleText || t('setup.test_idle')))
            : message}
          {status === 'success' && latencyMs != null
            ? ` · ${latencyMs} ms`
            : ''}
        </span>
      </div>

      {includeNativeProbe && nativeStatus !== 'idle' ? (
        <div
          className={`tester__native tester__native--${
            nativeStatus === 'probing' ? 'probing' : (nativeResult?.would_inject_tools ? 'ok' : 'blocked')
          }`}
          aria-live="polite"
        >
          <div className="tester__native-head">
            <span className="tester__native-title">{t('setup.native_probe_title')}</span>
            <span className="tester__native-badge">
              {nativeStatus === 'probing'
                ? t('setup.native_probe_probing')
                : (nativeResult?.would_inject_tools
                  ? t('setup.native_probe_supported')
                  : t('setup.native_probe_unsupported'))}
            </span>
          </div>
          {nativeStatus !== 'probing' && nativeResult ? (
            <>
              {nativeResult.message ? (
                <p className="tester__native-msg">{nativeResult.message}</p>
              ) : null}
              {nativeResult.detail ? (
                <p className="tester__native-detail">
                  {`provider=${nativeResult.detail.provider} · ${nativeResult.detail.api_form} · is_proxy=${String(
                    nativeResult.detail.is_proxy,
                  )} · adapter=${nativeResult.detail.adapter}${
                    nativeResult.detail.native_search_upstream
                      ? ` · native_search_upstream=${nativeResult.detail.native_search_upstream}`
                      : ''
                  }`}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

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
