/* ═══════════════════════════════════════════════════════════
   SwarmOracle — Setup Wizard Connection Tester (S0-1)
   ═══════════════════════════════════════════════════════════
   Calls POST /api/health/test and surfaces a 4-state UI:
   idle / testing / success / error.
   - StatusDot is inlined (per task spec — no separate file)
   - aria-live="polite" announces state transitions
   - JSON pre log is collapsible-by-default to keep the UI quiet
*/

import { useEffect, useRef, useState } from 'react';
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
  /** Explicit native-search capability override for the tested profile. */
  supportsNativeSearchOverride?: boolean | null;
  /** Reports the state of the current input signature to a parent gate. */
  onStatusChange?: (status: TesterStatus) => void;
  /** Restores a successful test for these exact inputs after a parent step remount. */
  initiallyVerified?: boolean;
}

export type TesterStatus = 'idle' | 'testing' | 'success' | 'error';
type NativeProbeStatus = 'idle' | 'probing' | 'success' | 'blocked' | 'error';

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

function signatureValueForSupportOverride(value: boolean | null | undefined) {
  return value === undefined
    ? { kind: 'omitted' }
    : { kind: 'value', value };
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
  supportsNativeSearchOverride,
  onStatusChange,
  initiallyVerified = false,
}: ConnectionTesterProps) {
  const { t } = useTranslation();
  const requestSignature = JSON.stringify([
    baseUrl,
    apiKey,
    model ?? null,
    requestsPerMinute ?? null,
    tokensPerMinute ?? null,
    nativeSearchUpstream ?? null,
    signatureValueForSupportOverride(supportsNativeSearchOverride),
  ]);
  const runIdRef = useRef(0);
  const mountedRef = useRef(false);
  const requestSignatureRef = useRef(requestSignature);
  const [status, setStatus] = useState<TesterStatus>(initiallyVerified ? 'success' : 'idle');
  const [activeRunSignature, setActiveRunSignature] = useState<string | null>(
    initiallyVerified ? requestSignature : null,
  );
  const [message, setMessage] = useState<string>(
    initiallyVerified ? (testSuccessText || t('setup.test_success')) : '',
  );
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [rawPayload, setRawPayload] = useState<TestResultPayload | null>(null);
  const [showLog, setShowLog] = useState<boolean>(false);
  const [nativeStatus, setNativeStatus] = useState<NativeProbeStatus>('idle');
  const [nativeResult, setNativeResult] = useState<NativeSearchProbe | null>(null);
  const nativeResultRef = useRef<NativeSearchProbe | null>(null);
  const [nativeErrorMessage, setNativeErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    requestSignatureRef.current = requestSignature;
  }, [requestSignature]);

  const runTest = async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const runSignature = requestSignatureRef.current;
    setActiveRunSignature(runSignature);
    const isCurrentRun = () => (
      mountedRef.current
      && runIdRef.current === runId
      && requestSignatureRef.current === runSignature
    );

    setStatus('testing');
    setMessage(testingText || t('setup.testing'));
    setLatencyMs(null);
    setRawPayload(null);
    setNativeErrorMessage(null);

    if (includeNativeProbe) {
      setNativeStatus('probing');
      setNativeResult(null);
      nativeResultRef.current = null;
    } else {
      setNativeStatus('idle');
      setNativeResult(null);
      nativeResultRef.current = null;
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
            supportsNativeSearchOverride,
          );
          if (!isCurrentRun()) return;
          setNativeResult(nativeData);
          nativeResultRef.current = nativeData;
          setNativeStatus(nativeData
            ? (nativeData.would_inject_tools ? 'success' : 'blocked')
            : 'error');
          setNativeErrorMessage(nativeData ? null : t('setup.native_probe_failed'));
          setRawPayload((prev) => ({
            ...prev,
            native_search: nativeData,
            ...(nativeData ? {} : { native_search_error: t('setup.native_probe_failed') }),
          }));
        } catch (err) {
          if (!isCurrentRun()) return;
          const errorMessage = isApiError(err)
            ? err.message
            : (err instanceof Error && err.message
              ? err.message
              : t('setup.native_probe_failed'));
          setNativeResult(null);
          nativeResultRef.current = null;
          setNativeStatus('error');
          setNativeErrorMessage(errorMessage);
          setRawPayload((prev) => ({
            ...prev,
            native_search: null,
            native_search_error: errorMessage,
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
          supportsNativeSearchOverride,
        );
        if (!isCurrentRun()) return;
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
        if (!isCurrentRun()) return;
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
          setRawPayload((prev) => ({
            ...prev,
            status: 'error',
            message: errorMessage,
          }));
          setMessage(errorMessage);
        }
      }
    })());

    await Promise.all(promises);

    if (!isCurrentRun()) return;
    // After static probe + LLM test both complete, fire live native search test
    // if the static probe indicated support.
    if (
      includeNativeProbe
      && runIdRef.current === runId
    ) {
      // Read latest state via refs/callbacks since setState is async
      const currentResult = nativeResultRef.current as NativeSearchProbe | null;
      if (currentResult?.would_inject_tools) {
        // Fire live test asynchronously and update state when done
        setNativeStatus('probing');
        probeNativeSearch(
          apiKey || undefined,
          baseUrl || undefined,
          model || undefined,
          nativeSearchUpstream,
          supportsNativeSearchOverride,
          true, // liveTest
        ).then((liveData) => {
          if (!isCurrentRun()) return;
          if (liveData) {
            setNativeResult(liveData);
            nativeResultRef.current = liveData;
            setNativeStatus(liveData.would_inject_tools ? 'success' : 'blocked');
            setRawPayload((p) => ({ ...p, native_search: liveData }));
          }
        }).catch(() => {
          // Live test failure is non-fatal; keep static result
          if (!isCurrentRun()) return;
          setNativeStatus('success');
        });
      }
    }
  };

  const displayCurrentRun = activeRunSignature === requestSignature;
  const displayStatus = displayCurrentRun ? status : 'idle';
  const displayLatencyMs = displayCurrentRun ? latencyMs : null;
  const displayRawPayload = displayCurrentRun ? rawPayload : null;
  const displayNativeStatus: NativeProbeStatus = displayCurrentRun ? nativeStatus : 'idle';
  const displayNativeResult = displayCurrentRun ? nativeResult : null;
  const displayNativeErrorMessage = displayCurrentRun ? nativeErrorMessage : null;

  useEffect(() => {
    onStatusChange?.(displayStatus);
  }, [displayStatus, onStatusChange]);

  const dotClass = `status-dot status-dot--${displayStatus}`;
  const canTest = baseUrl.trim().length > 0
    && displayStatus !== 'testing'
    && displayNativeStatus !== 'probing'
    && !disabled;
  const nativeClass = displayNativeStatus === 'probing'
    ? 'probing'
    : (displayNativeStatus === 'success'
      ? 'ok'
      : (displayNativeStatus === 'error' ? 'error' : 'blocked'));
  const hasLiveResult = displayNativeResult?.live_result != null;
  const nativeBadgeText = displayNativeStatus === 'probing'
    ? t('setup.native_probe_probing')
    : (displayNativeStatus === 'success'
      ? (hasLiveResult
        ? t('setup.native_probe_live_supported')
        : t('setup.native_probe_supported'))
      : (displayNativeStatus === 'error'
        ? t('setup.native_probe_failed')
        : t('setup.native_probe_unsupported')));

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
          {displayStatus === 'testing' ? (testingText || t('setup.testing')) : (testButtonText || t('setup.test_button'))}
        </button>
        <span className={dotClass} aria-hidden="true" />
        <span
          className="tester__status-text"
          role="status"
        >
          {displayStatus === 'idle'
            ? (disabled && disabledHint ? disabledHint : (testIdleText || t('setup.test_idle')))
            : message}
          {displayStatus === 'success' && displayLatencyMs != null
            ? ` · ${displayLatencyMs} ms`
            : ''}
        </span>
      </div>

      {includeNativeProbe && displayNativeStatus !== 'idle' ? (
        <div
          className={`tester__native tester__native--${nativeClass}`}
          aria-live="polite"
        >
          <div className="tester__native-head">
            <span className="tester__native-title">{hasLiveResult ? t('setup.native_probe_live_title') : t('setup.native_probe_title')}</span>
            <span className="tester__native-badge">
              {nativeBadgeText}
            </span>
          </div>
          {displayNativeStatus === 'error' && displayNativeErrorMessage ? (
            <p className="tester__native-msg">{displayNativeErrorMessage}</p>
          ) : null}
          {displayNativeStatus !== 'probing' && displayNativeResult ? (
            <>
              {displayNativeResult.message ? (
                <p className="tester__native-msg">{displayNativeResult.message}</p>
              ) : null}
              {displayNativeResult.detail ? (
                <div className="tester__native-detail">
                  {([
                    ['provider', displayNativeResult.detail.provider],
                    [displayNativeResult.detail.effective_api_form ?? displayNativeResult.detail.api_form, null],
                    ['is_proxy', String(displayNativeResult.detail.is_proxy)],
                    ['adapter', displayNativeResult.detail.adapter],
                    ...(displayNativeResult.detail.native_search_upstream
                      ? [['native_search_upstream', displayNativeResult.detail.native_search_upstream]]
                      : []),
                    ...(displayNativeResult.detail.inferred_upstream
                      ? [['inferred_from_model', null]]
                      : []),
                  ] as Array<[string, string | null]>).map(([k, v], i) => (
                    <span key={i} className="tester__native-pill">
                      {v != null ? (
                        <>
                          <span className="tester__native-pill-key">{k}</span>
                          ={v}
                        </>
                      ) : k}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {displayRawPayload ? (
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
              {JSON.stringify(displayRawPayload, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default ConnectionTester;
