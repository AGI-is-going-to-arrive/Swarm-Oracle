import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, Link } from 'react-router-dom';
import { useResultContext } from './ResultContext';
import { useCapabilityCheck } from '../../hooks/useCapabilityCheck';
import { generateReport, getStory } from '../../api/client';
import { ReportConfidenceBadge } from './ReportConfidenceBadge';
import { ReportToc } from './ReportToc';
import { ReportSection } from './ReportSection';
import { ReportEvidenceDrawer } from './ReportEvidenceDrawer';
import { PremortemAnalysisBlock } from './PremortemAnalysisBlock';
import { isLocalLlmBaseUrl, loadLlmProviderPolicy, validateByok } from '../../lib/llmProviderPolicy';
import { getLocalizedApiErrorMessage } from '../../lib/apiErrorMessage';
import {
  consumeResultReportStream,
  ReportStreamInterruptedError,
} from '../../lib/resultReportSse';
import type {
  FullReport,
  FullReportTruncatedMarker,
  InterviewEvidenceEntry,
  ReportEvidence,
  ReportSectionFailureReason,
  ReportTier,
  Scenario,
  StoryData,
  ToolTraceSummary,
} from '../../types';
// The .report-doc editorial skin lives in ResultReportView.css. Import it here (not only in
// the standalone /report page) so the inline embed on /result/:id is fully styled too —
// otherwise the panel renders unskinned (+ zeroed padding) on a direct /result/:id load.
import '../ResultReportView.css';

interface Props {
  /** `inline` is rendered inside ResultView (page already has an <h1>); `standalone`
   *  is the /result/:id/report route (ResultReportView supplies the page <h1>). */
  variant?: 'inline' | 'standalone';
  /** Optional refresh callback (standalone re-fetches story); falls back to a full reload. */
  onRefresh?: () => void;
  storyData?: StoryData | null;
  activeScenarioId?: string | null;
  isZh?: boolean;
  isReplayMode?: boolean;
  scenarioStatus?: Scenario['status'];
}

export type ReportContentLanguage = 'zh' | 'en';

const REPORT_CONTENT_LANGUAGES: readonly ReportContentLanguage[] = ['zh', 'en'];
const REPORT_PROGRESS_STAGE_IDS = new Set([
  'timeline', 'factions', 'conflicts', 'premortem', 'indicators', 'sources', 'translation',
]);

function isReportContentLanguage(value: unknown): value is ReportContentLanguage {
  return value === 'zh' || value === 'en';
}

/**
 * Resolve the language of report-authored content independently from the UI chrome.
 * New reports use both metadata fields, with an explicit `missing` status vetoing a
 * stale `available_languages` entry. The final fallbacks keep persisted legacy reports
 * readable when one or both metadata fields are absent at runtime.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveReportContentLanguage(
  report: Pick<FullReport, 'language' | 'available_languages' | 'language_status'>,
  preferredLanguage: ReportContentLanguage,
): ReportContentLanguage {
  const declaredLanguages = Array.isArray(report.available_languages)
    ? report.available_languages.filter(isReportContentLanguage)
    : [];
  const uniqueDeclaredLanguages = [...new Set(declaredLanguages)];
  const status = report.language_status;
  const hasAuthoritativeStatus = Boolean(status && typeof status === 'object');
  const statusLanguages = hasAuthoritativeStatus
    ? REPORT_CONTENT_LANGUAGES.filter((language) => status?.[language] === 'available')
    : [];
  const availableLanguages = hasAuthoritativeStatus
    ? [
        ...uniqueDeclaredLanguages.filter((language) => status?.[language] === 'available'),
        ...statusLanguages.filter((language) => !uniqueDeclaredLanguages.includes(language)),
      ]
    : uniqueDeclaredLanguages;

  if (availableLanguages.includes(preferredLanguage)) return preferredLanguage;
  if (isReportContentLanguage(report.language) && availableLanguages.includes(report.language)) {
    return report.language;
  }
  if (availableLanguages[0]) return availableLanguages[0];

  // Legacy compatibility: old persisted payloads may not carry availability metadata.
  if (isReportContentLanguage(report.language)) return report.language;
  return preferredLanguage;
}

/** Project translated authored text while leaving the saved report and provenance intact. */
// eslint-disable-next-line react-refresh/only-export-components
export function projectReportContentLanguage(
  report: FullReport,
  language: ReportContentLanguage,
): FullReport {
  const translated = report.authored_content_i18n?.[language];
  const sectionTexts = translated?.section_texts;
  const completeVariant = translated
    && typeof translated.title === 'string' && translated.title.trim()
    && typeof translated.summary === 'string' && translated.summary.trim()
    && sectionTexts
    && Object.keys(sectionTexts).length === report.sections.length
    && report.sections.every((section) => (
      typeof sectionTexts[section.id]?.title === 'string'
      && typeof sectionTexts[section.id]?.body_md === 'string'
    ));
  if (!completeVariant || !translated || !sectionTexts) {
    if (language === report.language) return report;
    // Legacy reports can have translated chapter bodies without translated
    // appendices. Keep that core readable; the original remains selectable.
    return {
      ...report,
      limitations: '',
      follow_ups: [],
      indicators_to_watch: [],
      dissenting: null,
      premortem_analysis: null,
      interview_status: report.interview_status
        ? { ...report.interview_status, message: '' }
        : report.interview_status,
      verdict: {
        ...report.verdict,
        disclaimer: null,
        analytic_confidence: {
          ...report.verdict.analytic_confidence,
          basis: report.verdict.analytic_confidence.basis_i18n?.[language] || '',
        },
      },
    };
  }
  const title = translated.title as string;
  const summary = translated.summary as string;
  const basis = translated.confidence_basis
    ?? report.verdict.analytic_confidence.basis_i18n?.[language]
    ?? '';
  return {
    ...report,
    language,
    title,
    title_i18n: { ...report.title_i18n, [language]: title },
    summary,
    summary_i18n: { ...report.summary_i18n, [language]: summary },
    limitations: translated.limitations,
    follow_ups: translated.follow_ups,
    indicators_to_watch: translated.indicators_to_watch,
    dissenting: translated.dissenting,
    interview_evidence: translated.interview_evidence,
    interview_status: translated.interview_status,
    premortem_analysis: translated.premortem_analysis,
    sections: report.sections.map((section) => ({
      ...section,
      title: sectionTexts[section.id].title,
      title_i18n: { ...section.title_i18n, [language]: sectionTexts[section.id].title },
      body_md_i18n: { ...section.body_md_i18n, [language]: sectionTexts[section.id].body_md },
    })),
    verdict: {
      ...report.verdict,
      headline_answer: translated.headline_answer,
      disclaimer: translated.disclaimer ?? null,
      analytic_confidence: {
        ...report.verdict.analytic_confidence,
        basis,
        basis_i18n: {
          zh: report.verdict.analytic_confidence.basis_i18n?.zh || '',
          en: report.verdict.analytic_confidence.basis_i18n?.en || '',
          [language]: basis,
        },
      },
    },
  };
}

function isTruncatedReportMarker(
  report: FullReport | FullReportTruncatedMarker | null | undefined,
): report is FullReportTruncatedMarker {
  return Boolean(report && 'truncated' in report && report.truncated === true);
}

function isFullReport(
  report: FullReport | FullReportTruncatedMarker | null | undefined,
): report is FullReport {
  return Boolean(report && 'verdict' in report && report.verdict);
}

function splitSentencesDecimalSafe(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  const len = text.length;

  const isAsciiLetter = (char: string | undefined) => Boolean(char && /[A-Za-z]/.test(char));
  const isAbbreviationPeriod = (index: number) => {
    const prev = text[index - 1];
    const prevPrev = text[index - 2];
    return isAsciiLetter(prev) && prevPrev === '.';
  };

  for (let i = 0; i < len; i++) {
    const char = text[i];

    // CJK termination characters: 。 ！？
    if (char === '。' || char === '！' || char === '？') {
      const sentence = text.slice(start, i + 1).trim();
      if (sentence) {
        sentences.push(sentence);
      }
      start = i + 1;
      continue;
    }

    // Latin punctuation: . ! ?
    if (char === '.' || char === '!' || char === '?') {
      const isDigitPrev = i > 0 && text[i - 1] >= '0' && text[i - 1] <= '9';
      const isDigitNext = i < len - 1 && text[i + 1] >= '0' && text[i + 1] <= '9';
      const isDecimal = isDigitPrev && isDigitNext;

      if (!isDecimal && !isAbbreviationPeriod(i)) {
        const isFollowedByWhitespaceOrEnd =
          i === len - 1 ||
          /\s/.test(text[i + 1]);

        if (isFollowedByWhitespaceOrEnd) {
          const sentence = text.slice(start, i + 1).trim();
          if (sentence) {
            sentences.push(sentence);
          }
          start = i + 1;
        }
      }
    }
  }

  if (start < len) {
    const sentence = text.slice(start).trim();
    if (sentence) {
      sentences.push(sentence);
    }
  }

  return sentences;
}

function deriveTakeaways(report: FullReport, lang: 'zh' | 'en'): string[] {
  const items: string[] = [];
  const usesPrimaryLanguage = lang === report.language;

  // Fields without an i18n contract are authored in `report.language`. When the
  // viewer selects a genuinely available alternate language, do not mix those
  // primary-language strings into the localized digest.
  if (usesPrimaryLanguage) {
    const headline = report.verdict?.headline_answer?.trim() ?? '';
    if (headline) {
      items.push(headline);
    }
  }

  // 2. summary_i18n[lang] 首 1-2 句(按小数安全切句)
  const summaryText = (report.summary_i18n?.[lang] || '').trim();
  if (summaryText) {
    const sentences = splitSentencesDecimalSafe(summaryText);
    const summarySentences = sentences.slice(0, 2);
    for (const sent of summarySentences) {
      items.push(sent);
    }
  }

  if (usesPrimaryLanguage) {
    // 3. follow_ups[] 取 1-2
    const followUps = report.follow_ups || [];
    for (const fu of followUps.slice(0, 2)) {
      const trimmed = fu?.trim() ?? '';
      if (trimmed) {
        items.push(trimmed);
      }
    }

    // 4. indicators_to_watch[].signal 取 1-2
    const indicators = report.indicators_to_watch || [];
    for (const ind of indicators.slice(0, 2)) {
      const signal = ind?.signal?.trim() ?? '';
      if (signal) {
        items.push(signal);
      }
    }
  }

  // 去重且最多3条
  const uniqueItems: string[] = [];
  for (const item of items) {
    if (!uniqueItems.includes(item)) {
      uniqueItems.push(item);
    }
  }

  return uniqueItems.slice(0, 3);
}

const ALLOWED_SECTION_IDS = ['timeline', 'factions', 'conflicts', 'premortem', 'indicators', 'sources'];
const REPORT_GENERATE_TIMEOUT_MS = 35 * 60_000;

type TerminalAuthorityState = 'idle' | 'pending' | 'resolved';
type ReportAction = { operation: 'generate' } | {
  operation: 'translate';
  targetLanguage: ReportContentLanguage;
};

function reportAttemptFingerprint(
  report: FullReport | FullReportTruncatedMarker | null | undefined,
): string | null {
  if (!isFullReport(report)) return null;
  return JSON.stringify({
    generatedAt: report.generated_at,
    status: report.status,
    targetBranchId: report.target_branch_id,
    targetBranchSort: report.target_branch_sort,
    detailLevel: report.detail_level ?? 'full',
    availableLanguages: report.available_languages,
    languageStatus: report.language_status,
    authoredContent: report.authored_content_i18n,
  });
}

interface SectionStreamProgress {
  sectionId: string;
  status: 'complete' | 'failed';
  tier?: ReportTier;
  failureReason?: ReportSectionFailureReason | null;
}

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

const SECTION_TIER_LOCALE_KEYS: Record<ReportTier, string> = {
  generation: 'result.report.sectionTier.generation',
  rewrite: 'result.report.sectionTier.rewrite',
  static: 'result.report.sectionTier.static',
};

const SECTION_FAILURE_LOCALE_KEYS: Record<ReportSectionFailureReason, string> = {
  timeout: 'result.report.sectionFailureReason.timeout',
  tool_floor_not_met: 'result.report.sectionFailureReason.tool_floor_not_met',
  empty_outline: 'result.report.sectionFailureReason.empty_outline',
  json_parse_error: 'result.report.sectionFailureReason.json_parse_error',
  plan_outline_timeout: 'result.report.sectionFailureReason.plan_outline_timeout',
  unsupported_action: 'result.report.sectionFailureReason.unsupported_action',
  tool_budget_exhausted: 'result.report.sectionFailureReason.tool_budget_exhausted',
  empty_body: 'result.report.sectionFailureReason.empty_body',
  other: 'result.report.sectionFailureReason.other',
};

function normalizedFailureReason(reason: unknown): ReportSectionFailureReason {
  return typeof reason === 'string' && SECTION_FAILURE_REASONS.has(reason as ReportSectionFailureReason)
    ? reason as ReportSectionFailureReason
    : 'other';
}

interface ToolTraceChipProps {
  trace: ToolTraceSummary[];
}

export const ToolTraceChip = React.memo(function ToolTraceChip({ trace }: ToolTraceChipProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const regionId = 'report-tool-trace-details';

  if (!trace || trace.length === 0) {
    return null;
  }

  return (
    <div className="report-tool-trace">
      <button
        type="button"
        id="report-tool-trace-trigger"
        aria-expanded={expanded}
        aria-controls={expanded ? regionId : undefined}
        aria-label={expanded ? t('result.report.toolTraceCollapse') : t('result.report.toolTraceExpand')}
        onClick={() => setExpanded(!expanded)}
        className="report-tool-trace__trigger"
      >
        <span>🛠️ {t('result.report.toolTraceLabel', { count: trace.length })}</span>
        <svg
          className={`report-tool-trace__chevron${expanded ? ' is-open' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="3"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div
          id={regionId}
          className="report-tool-trace__details"
          role="region"
          aria-labelledby="report-tool-trace-trigger"
        >
          <ul className="report-tool-trace__list">
            {trace.map((item, index) => (
              <li key={index} className="report-tool-trace__item">
                <div className="report-tool-trace__row">
                  <span className="report-tool-trace__tool">{item.tool}</span>
                  <span className="report-tool-trace__elapsed">
                    {t('result.report.toolTraceElapsed', { ms: item.elapsed_ms })}
                  </span>
                </div>
                <div className="report-tool-trace__row report-tool-trace__row--meta">
                  <span className="report-tool-trace__query" title={item.query || undefined}>
                    {item.query ? item.query : t('result.report.toolTraceEmptyQuery')}
                  </span>
                  <span className="report-tool-trace__count">
                    {t('result.report.toolTraceItemCount', { count: item.item_count })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

// Inner component memoized to narrow context subscription.
// Re-renders ONLY when these specific props change.
const ResultReportPanelInner = React.memo(function ResultReportPanelInner({
  variant = 'inline',
  onRefresh,
  storyData,
  activeScenarioId,
  isZh,
  isReplayMode,
  scenarioStatus,
}: Props & { isZh: boolean; isReplayMode: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const {
    capabilities,
    loading: capLoading,
    error: capError,
    reload,
  } = useCapabilityCheck('result_report');

  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
  const [currentEvidence, setCurrentEvidence] = useState<ReportEvidence[]>([]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | boolean>(false);

  const [localStoryData, setLocalStoryData] = useState<StoryData | null>(null);
  const [localGenerating, setLocalGenerating] = useState(false);
  const [toolTrace, setToolTrace] = useState<ToolTraceSummary[]>([]);
  const [streamInterrupted, setStreamInterrupted] = useState(false);
  const [pollStalled, setPollStalled] = useState(false);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const [sectionProgress, setSectionProgress] = useState<SectionStreamProgress[]>([]);
  const [pollRevision, setPollRevision] = useState(0);
  const [requestedLanguage, setRequestedLanguage] = useState<ReportContentLanguage | null>(null);
  const [activeOperation, setActiveOperation] = useState<ReportAction['operation'] | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const attemptEpochRef = useRef(0);
  const terminalAuthorityRef = useRef<TerminalAuthorityState>('idle');
  const refreshNotifiedRef = useRef(false);
  const awaitingFreshAttemptRef = useRef<{
    epoch: number;
    fingerprint: string | null;
  } | null>(null);

  const activeStoryData = localStoryData || storyData;
  const rawReport = activeStoryData?.full_report;
  const isTruncatedReport = isTruncatedReportMarker(rawReport);
  const sourceReport = isFullReport(rawReport) ? rawReport : null;
  const isReportStale = activeStoryData?.full_report_stale === true;
  const isEnabled = capabilities?.result_report?.enabled ?? false;
  const providerPolicy = loadLlmProviderPolicy();
  const hasByok = Boolean(providerPolicy.apiKey.trim())
    || (Boolean(providerPolicy.model.trim()) && isLocalLlmBaseUrl(providerPolicy.baseUrl));
  const canGenerateReport = !isReplayMode && isEnabled
    && (scenarioStatus === undefined || scenarioStatus === 'done')
    && (capabilities?.llm_configured !== false || hasByok);

  const isGenerating = !pollStalled
    && ((!isReportStale && sourceReport?.status === 'generating') || localGenerating);
  const preferredContentLanguage: ReportContentLanguage = requestedLanguage ?? (isZh ? 'zh' : 'en');
  const reportContentLanguage = sourceReport
    ? resolveReportContentLanguage(sourceReport, preferredContentLanguage)
    : preferredContentLanguage;
  const report = useMemo(() => sourceReport
    ? projectReportContentLanguage(sourceReport, reportContentLanguage)
    : null, [sourceReport, reportContentLanguage]);
  const isBrief = sourceReport?.detail_level === 'brief';
  const canTranslateReport = canGenerateReport && !isReportStale
    && (sourceReport?.status === 'complete' || sourceReport?.status === 'partial');
  const requestedLanguageReady = reportContentLanguage === preferredContentLanguage
    && (reportContentLanguage === sourceReport?.language
      || report?.language === reportContentLanguage);
  const progressStageLabel = (sectionId: string): string => {
    const section = sourceReport?.sections.find((item) => item.id === sectionId);
    return section?.title_i18n[isZh ? 'zh' : 'en']
      || t(REPORT_PROGRESS_STAGE_IDS.has(sectionId)
        ? `result.report.progressStage.${sectionId}` : 'result.report.generating');
  };

  useEffect(() => { setRequestedLanguage(null); }, [isZh]);

  const beginAuthorityAttempt = useCallback(() => {
    const epoch = attemptEpochRef.current + 1;
    attemptEpochRef.current = epoch;
    terminalAuthorityRef.current = 'idle';
    refreshNotifiedRef.current = false;
    awaitingFreshAttemptRef.current = null;
    return epoch;
  }, []);

  const notifyRefreshOnce = useCallback(() => {
    if (refreshNotifiedRef.current) return;
    refreshNotifiedRef.current = true;
    if (onRefresh) {
      onRefresh();
    } else if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, [onRefresh]);

  // Reset local overrides when props change
  useEffect(() => {
    beginAuthorityAttempt();
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setLocalStoryData(null);
    setLocalGenerating(false);
    setRetrying(false);
    setRetryError(false);
    setActiveOperation(null);
    const persistedReport = storyData?.full_report;
    setToolTrace(
      isFullReport(persistedReport) ? (persistedReport.tool_trace ?? []) : [],
    );
    setStreamInterrupted(false);
    setPollStalled(false);
    setActiveSectionId(null);
    setSectionProgress([]);
    setPollRevision((revision) => revision + 1);
  }, [storyData, beginAuthorityAttempt]);

  // Tool activity is part of report evidence, not merely live progress. Sync
  // from persisted story authority after polling/refetch so reopening a report
  // shows the same bounded trace as the generation stream did.
  useEffect(() => {
    if (report?.tool_trace !== undefined) {
      setToolTrace(report.tool_trace);
    }
  }, [report?.generated_at, report?.status, report?.tool_trace]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      attemptEpochRef.current += 1;
      terminalAuthorityRef.current = 'resolved';
      awaitingFreshAttemptRef.current = null;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Poll effect when generating
  useEffect(() => {
    if (!isGenerating || !activeScenarioId || isReplayMode) return;

    const attemptEpoch = attemptEpochRef.current;
    let cancelled = false;
    let timerId: number | undefined;
    const startTime = Date.now();
    const maxPollTime = 35 * 60 * 1000; // 35 minutes

    const isCurrentAttempt = () => (
      !cancelled
      && isMountedRef.current
      && attemptEpochRef.current === attemptEpoch
    );
    const canPoll = () => (
      isCurrentAttempt()
      && terminalAuthorityRef.current === 'idle'
    );
    const schedulePoll = () => {
      if (canPoll()) {
        timerId = window.setTimeout(poll, 15000);
      }
    };

    const poll = async () => {
      if (!canPoll()) return;
      if (Date.now() - startTime >= maxPollTime) {
        if (canPoll()) {
          setLocalGenerating(false);
          setPollStalled(true);
        }
        return;
      }
      try {
        const updatedStory = await getStory(activeScenarioId);
        // A stream terminal can claim authority while this request is in flight.
        // Such a late response belongs to the old arbitration window and must not
        // publish data or schedule another poll.
        if (!canPoll()) return;
        const newReport = updatedStory?.full_report;
        if (newReport && newReport.status === 'generating') {
          awaitingFreshAttemptRef.current = null;
          setLocalStoryData(updatedStory);
          setLocalGenerating(true);
          setPollStalled(false);
          schedulePoll();
        } else if (newReport) {
          const awaitingFreshAttempt = awaitingFreshAttemptRef.current;
          if (
            awaitingFreshAttempt?.epoch === attemptEpoch
            && reportAttemptFingerprint(newReport) === awaitingFreshAttempt.fingerprint
          ) {
            // Persistence can still expose the exact pre-attempt terminal
            // snapshot before an accepted build publishes fresh authority.
            setPollStalled(false);
            schedulePoll();
            return;
          }
          awaitingFreshAttemptRef.current = null;
          terminalAuthorityRef.current = 'resolved';
          setLocalStoryData(updatedStory);
          setLocalGenerating(false);
          setStreamInterrupted(false);
          setPollStalled(false);
          setRetryError(false);
          notifyRefreshOnce();
        } else {
          schedulePoll();
        }
      } catch (err) {
        if (isCurrentAttempt()) {
          console.error('Error polling report status', err);
          schedulePoll();
        }
      }
    };

    schedulePoll();

    return () => {
      cancelled = true;
      if (timerId) {
        clearTimeout(timerId);
      }
    };
  }, [isGenerating, activeScenarioId, isReplayMode, notifyRefreshOnce, pollRevision]);

  const takeaways = useMemo(() => {
    if (!report) return [];
    return deriveTakeaways(report, reportContentLanguage);
  }, [report, reportContentLanguage]);

  const sections = useMemo(() => report?.sections || [], [report]);
  const evidenceDict = useMemo(() => {
    const map = new Map<string, ReportEvidence>();
    if (report?.evidence) {
      for (const ev of report.evidence) map.set(ev.id, ev);
    }
    return map;
  }, [report]);

  const interviewStatus = report?.interview_status;
  const interviewEvidence = useMemo(() => report?.interview_evidence || [], [report]);
  const hasInterviews = useMemo(() => {
    return (interviewEvidence.length > 0) || Boolean(interviewStatus && interviewStatus.status !== 'complete');
  }, [interviewEvidence, interviewStatus]);

  const handleOpenEvidence = useCallback(
    (refs: string[]) => {
      const evs = refs
        .map((ref) => evidenceDict.get(ref))
        .filter((ev): ev is ReportEvidence => ev !== undefined);
      setCurrentEvidence(evs);
      setEvidenceDrawerOpen(true);
    },
    [evidenceDict],
  );

  const handleCloseEvidence = useCallback(() => setEvidenceDrawerOpen(false), []);

  const handleRetry = useCallback(async (action: ReportAction = { operation: 'generate' }) => {
    if (!canGenerateReport) return;
    if (!activeScenarioId || retrying) return;
    if (action.operation === 'translate' && !canTranslateReport) return;

    const providerPolicy = loadLlmProviderPolicy();
    const validation = validateByok({
      apiKey: providerPolicy.apiKey,
      baseUrl: providerPolicy.baseUrl,
    });
    if (!validation.valid) {
      setRetryError(
        getLocalizedApiErrorMessage(
          { code: validation.errorCode },
          t,
          t('conversation.error.byok_invalid'),
        ),
      );
      return;
    }

    const attemptFingerprint = reportAttemptFingerprint(sourceReport);
    const attemptEpoch = beginAuthorityAttempt();
    awaitingFreshAttemptRef.current = {
      epoch: attemptEpoch,
      fingerprint: attemptFingerprint,
    };
    const isCurrentAttempt = () => (
      isMountedRef.current
      && attemptEpochRef.current === attemptEpoch
    );
    const isTerminalAuthorityResolved = () => terminalAuthorityRef.current === 'resolved';
    abortControllerRef.current?.abort();
    setRetrying(true);
    setActiveOperation(action.operation);
    setRetryError(false);
    setToolTrace([]);
    setStreamInterrupted(false);
    setPollStalled(false);
    setActiveSectionId(null);
    setSectionProgress([]);
    setPollRevision((revision) => revision + 1);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const timeoutId = setTimeout(() => controller.abort(), REPORT_GENERATE_TIMEOUT_MS);

    // Show the honest "generating" state (and arm the status poll) for the whole
    // attempt — if the stream times out below while the backend keeps generating,
    // the poll is what eventually clears the stale partial banner.
    setLocalGenerating(true);

    let terminalAuthorityFetchPending = false;
    let terminalFailed = false;
    let terminalFailureCode: string | undefined;
    try {
      const providerPolicy = loadLlmProviderPolicy();
      const res = await generateReport(
        activeScenarioId,
        {
          llmApiKey: providerPolicy.apiKey || undefined,
          llmBaseUrl: providerPolicy.baseUrl || undefined,
          llmModel: providerPolicy.model || undefined,
          llmRequestsPerMinute: providerPolicy.requestsPerMinute ?? undefined,
          llmTokensPerMinute: providerPolicy.tokensPerMinute ?? undefined,
          ...(action.operation === 'translate'
            ? { operation: 'translate' as const, targetLanguage: action.targetLanguage }
            : { operation: 'generate' as const, detailLevel: 'full' as const }),
        },
        controller.signal
      );
      if (!isCurrentAttempt() || isTerminalAuthorityResolved()) return;

      let isAlreadyRunning = false;
      const terminalEvent = await consumeResultReportStream(
        res,
        controller.signal,
        (event) => {
          if (!isCurrentAttempt() || isTerminalAuthorityResolved()) return;
          if (event.data.error_code === 'REPORT_ALREADY_RUNNING') {
            isAlreadyRunning = true;
          }
          if (event.event === 'report_failed' && !event.data.section_id
            && event.data.error_code !== 'REPORT_ALREADY_RUNNING') {
            terminalFailureCode = event.data.error_code;
          }
          if (event.data.section_id) {
            setActiveSectionId(event.data.section_id);
          }
          if (event.event === 'report_section_complete' && event.data.section_id) {
            const next: SectionStreamProgress = {
              sectionId: event.data.section_id,
              status: 'complete',
              tier: event.data.tier,
              failureReason: event.data.failure_reason,
            };
            setSectionProgress((previous) => [
              ...previous.filter((item) => item.sectionId !== next.sectionId),
              next,
            ]);
          } else if (event.event === 'report_failed' && event.data.section_id) {
            const next: SectionStreamProgress = {
              sectionId: event.data.section_id,
              status: 'failed',
              tier: event.data.tier,
              failureReason: event.data.failure_reason,
            };
            setSectionProgress((previous) => [
              ...previous.filter((item) => item.sectionId !== next.sectionId),
              next,
            ]);
          }
          const newTrace = event.data.tool_trace;
          if (newTrace.length > 0) {
            setToolTrace((prev) => [...prev, ...newTrace]);
          }
        }
      );
      terminalFailed = terminalEvent.data.status === 'failed'
        || terminalEvent.data.status === 'cancelled';
      if (!isCurrentAttempt()) return;
      if (isAlreadyRunning) {
        setLocalGenerating(true);
      } else {
        if (isTerminalAuthorityResolved()) return;
        terminalAuthorityRef.current = 'pending';
        terminalAuthorityFetchPending = true;
        const updatedStory = await getStory(activeScenarioId);
        terminalAuthorityFetchPending = false;
        if (!isCurrentAttempt() || terminalAuthorityRef.current !== 'pending') return;
        const updatedReport = updatedStory?.full_report;
        if (updatedReport?.status === 'generating') {
          terminalAuthorityRef.current = 'idle';
          awaitingFreshAttemptRef.current = null;
          setLocalStoryData(updatedStory);
          setLocalGenerating(true);
          setRetryError(false);
          setPollStalled(false);
          setPollRevision((revision) => revision + 1);
        } else if (updatedReport) {
          const awaitingFreshAttempt = awaitingFreshAttemptRef.current;
          if (
            awaitingFreshAttempt?.epoch === attemptEpoch
            && reportAttemptFingerprint(updatedReport) === awaitingFreshAttempt.fingerprint
          ) {
            if (terminalFailed || action.operation === 'translate') {
              terminalAuthorityRef.current = 'resolved';
              awaitingFreshAttemptRef.current = null;
              setLocalStoryData(updatedStory);
              setLocalGenerating(false);
              setStreamInterrupted(false);
              setPollStalled(false);
              setRetryError(terminalFailed
                ? getLocalizedApiErrorMessage({ code: terminalFailureCode }, t, t('result.report.operationFailedPreserved'))
                : false);
              return;
            }
            terminalAuthorityRef.current = 'idle';
            setLocalGenerating(true);
            setPollRevision((revision) => revision + 1);
            return;
          }
          terminalAuthorityRef.current = 'resolved';
          awaitingFreshAttemptRef.current = null;
          setLocalStoryData(updatedStory);
          setLocalGenerating(false);
          setStreamInterrupted(false);
          setPollStalled(false);
          setRetryError(updatedReport.status === 'complete' ? false : true);
          notifyRefreshOnce();
        } else {
          terminalAuthorityRef.current = 'idle';
          setLocalGenerating(true);
          setPollRevision((revision) => revision + 1);
        }
      }
    } catch (err) {
      const error = err as { code?: string; message?: string; name?: string } | null;
      if (isCurrentAttempt() && !isTerminalAuthorityResolved()) {
        if (terminalFailed) {
          terminalAuthorityRef.current = 'resolved';
          awaitingFreshAttemptRef.current = null;
          setLocalGenerating(false);
          setRetryError(getLocalizedApiErrorMessage({ code: terminalFailureCode }, t, t('result.report.operationFailedPreserved')));
        } else if (terminalAuthorityFetchPending && terminalAuthorityRef.current === 'pending') {
          terminalAuthorityRef.current = 'idle';
          setLocalGenerating(true);
          setPollRevision((revision) => revision + 1);
        } else if (err instanceof ReportStreamInterruptedError) {
          // EOF without a terminal event is not terminal authority. Keep the
          // attempt pollable and let the persisted story decide its outcome.
          terminalAuthorityRef.current = 'idle';
          setStreamInterrupted(true);
          setLocalGenerating(true);
        } else if (error && (error.code === 'REPORT_ALREADY_RUNNING' || error.message?.includes('REPORT_ALREADY_RUNNING'))) {
          terminalAuthorityRef.current = 'idle';
          setLocalGenerating(true);
        } else if (error?.name === 'AbortError') {
          // The backend ties report generation to the SSE generator; aborting the
          // reader can cancel the in-flight build, so surface a retryable failure.
          setLocalGenerating(false);
          setRetryError(sourceReport?.sections.length ? t('result.report.operationFailedPreserved') : true);
        } else {
          setLocalGenerating(false);
          setRetryError(getLocalizedApiErrorMessage(err, t, t('result.report.operationFailedPreserved')));
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      if (isCurrentAttempt()) {
        setRetrying(false);
      }
    }
  }, [
    activeScenarioId,
    retrying,
    canGenerateReport,
    canTranslateReport,
    t,
    sourceReport,
    beginAuthorityAttempt,
    notifyRefreshOnce,
  ]);

  const currentIds = useMemo(() => new Set(sections.map((s) => s.id)), [sections]);
  const missingSections = useMemo(() => {
    if (report?.status !== 'partial') return [];
    return ALLOWED_SECTION_IDS.filter((id) => !currentIds.has(id));
  }, [report?.status, currentIds]);

  if (capLoading) {
    if (variant === 'inline') {
      return null;
    }
    return (
      <div className="report-panel-container report-state-card report-state-card--loading animate-pulse motion-reduce:animate-none">
        <div className="report-state-skeleton report-state-skeleton--title" />
        <div className="report-state-skeleton report-state-skeleton--medium" />
        <div className="report-state-skeleton report-state-skeleton--wide" />
      </div>
    );
  }

  if (capError) {
    return (
      <div className="report-panel-container report-state-card">
        <p className="report-state-card__desc">
          {t('result.report.couldNotConfirmAvailability')}
        </p>
        <button
          type="button"
          onClick={() => void reload?.()}
          className="report-state-card__button"
        >
          {t('result.report.retry')}
        </button>
      </div>
    );
  }

  if (!isEnabled) {
    return null;
  }

  const missing = !report || !report.verdict;
  const hasSections = sections.length > 0;
  // An archive can remain readable while its replacement is being generated.
  // Only current-attempt events count as progress until fresh story authority arrives.
  const generationSectionCount = isReportStale
    ? sectionProgress.filter((section) => section.status === 'complete').length
    : sections.length;
  const emptyStatus = !missing && !hasSections
    ? pollStalled
      ? 'stalled'
      : isReportStale
        ? 'stale'
        : report?.status === 'partial'
          || report?.status === 'failed'
          || report?.status === 'cancelled'
          || report?.status === 'skipped'
          ? report.status
          : null
    : null;
  const reportBannerKind = hasSections
    ? pollStalled
      ? 'stalled'
      : isGenerating
        ? 'generating'
        : isReportStale
          ? 'stale'
          : report?.status === 'partial'
            || report?.status === 'failed'
            || report?.status === 'cancelled'
            || report?.status === 'skipped'
            ? report.status
            : null
    : null;

  let reportBannerTitle = '';
  let reportBannerDesc = '';
  if (reportBannerKind === 'generating') {
    reportBannerTitle = t(activeOperation === 'translate'
      ? 'result.report.translatingTitle'
      : isBrief && !activeOperation ? 'result.report.preparingBrief' : 'result.report.generationInProgressTitle');
    reportBannerDesc = activeOperation === 'translate'
      ? t('result.report.translationInProgress')
      : t('result.report.generationInProgressDesc', { count: generationSectionCount });
  } else if (reportBannerKind === 'stale') {
    reportBannerTitle = t('result.report.staleReportTitle');
    reportBannerDesc = t('result.report.staleReportDesc');
  } else if (reportBannerKind === 'partial') {
    reportBannerTitle = t('result.report.reportPartiallyGenerated');
    reportBannerDesc = t('result.report.reportPartiallyGeneratedDesc');
  } else if (reportBannerKind === 'failed') {
    reportBannerTitle = t('result.report.reportFailedTitle');
    reportBannerDesc = t('result.report.reportFailedDesc');
  } else if (reportBannerKind === 'cancelled') {
    reportBannerTitle = t('result.report.reportCancelledTitle');
    reportBannerDesc = t('result.report.reportCancelledDesc');
  } else if (reportBannerKind === 'skipped') {
    reportBannerTitle = t('result.report.reportSkippedTitle');
    reportBannerDesc = t('result.report.reportSkippedDesc');
  } else if (reportBannerKind === 'stalled') {
    reportBannerTitle = t('result.report.pollStalledTitle');
    reportBannerDesc = t('result.report.pollStalledDesc');
  }

  let emptyStatusTitle = '';
  let emptyStatusDesc = '';
  if (emptyStatus === 'stale') {
    emptyStatusTitle = t('result.report.staleReportTitle');
    emptyStatusDesc = t('result.report.staleReportDesc');
  } else if (emptyStatus === 'partial') {
    emptyStatusTitle = t('result.report.reportIncomplete');
    emptyStatusDesc = t('result.report.reportIncompleteDesc');
  } else if (emptyStatus === 'failed') {
    emptyStatusTitle = t('result.report.reportFailedTitle');
    emptyStatusDesc = t('result.report.reportFailedDesc');
  } else if (emptyStatus === 'cancelled') {
    emptyStatusTitle = t('result.report.reportCancelledTitle');
    emptyStatusDesc = t('result.report.reportCancelledDesc');
  } else if (emptyStatus === 'skipped') {
    emptyStatusTitle = t('result.report.reportSkippedTitle');
    emptyStatusDesc = t('result.report.reportSkippedDesc');
  } else if (emptyStatus === 'stalled') {
    emptyStatusTitle = t('result.report.pollStalledTitle');
    emptyStatusDesc = t('result.report.pollStalledDesc');
  }

  if (isGenerating && !hasSections) {
    return (
      <div className="report-panel-container report-state-card">
        <div
          className="report-state-card__icon report-state-card__icon--primary"
          aria-hidden="true"
        >
          <svg className="animate-spin h-6 w-6 text-[color:var(--color-primary)]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {t(isBrief ? 'result.report.preparingBrief' : 'result.report.generatingTitle')}
        </h2>
        <p className="report-state-card__desc">
          {t(isBrief ? 'result.report.briefNoLlm' : 'result.report.generatingDesc')}
        </p>
        {streamInterrupted && (
          <p className="report-state-card__error" role="alert">
            {t('result.report.streamInterrupted')}
          </p>
        )}
        {(sectionProgress.length > 0 || toolTrace.length > 0) && (
          <div className="report-doc report-state-card__live-progress">
            <div className="report-stream-progress" aria-label={t('result.report.progressLabel')}>
              {activeSectionId && (
                <span className="report-stream-progress__current">
                  {t('result.report.progressCurrentSection', { section: progressStageLabel(activeSectionId) })}
                </span>
              )}
              {sectionProgress.map((item) => (
                <div key={item.sectionId} className="report-stream-progress__item">
                  <span>
                    {item.status === 'complete'
                      ? t('result.report.progressSectionComplete', { section: progressStageLabel(item.sectionId) })
                      : t('result.report.progressSectionFailed', { section: progressStageLabel(item.sectionId) })}
                  </span>
                  {item.tier && (
                    <span className={`report-stream-progress__chip report-stream-progress__chip--${item.tier}`}>
                      {t(SECTION_TIER_LOCALE_KEYS[item.tier])}
                    </span>
                  )}
                  {item.failureReason != null && (
                    <span className="report-stream-progress__failure">
                      {t(SECTION_FAILURE_LOCALE_KEYS[normalizedFailureReason(item.failureReason)])}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <ToolTraceChip trace={toolTrace} />
          </div>
        )}
      </div>
    );
  }

  if (isTruncatedReport) {
    return (
      <div className="report-panel-container report-state-card">
        <div
          className="report-state-card__icon report-state-card__icon--warning"
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {t('result.report.reportTruncated')}
        </h2>
        <p className="report-state-card__desc">
          {t('result.report.reportTruncatedDesc')}
        </p>
        {retryError && (
          <p className="report-state-card__error" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {canGenerateReport && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="report-state-card__button report-state-card__button--primary"
          >
            {retrying ? t('result.report.generating') : t('result.report.retryGeneration')}
          </button>
        )}
      </div>
    );
  }

  if (emptyStatus || (missing && variant === 'standalone')) {
    const isNeutralStatus = emptyStatus === 'cancelled'
      || emptyStatus === 'skipped'
      || emptyStatus === 'stale'
      || emptyStatus === 'stalled';
    return (
      <div className="report-panel-container report-state-card">
        <div
          className={`report-state-card__icon ${isNeutralStatus ? 'report-state-card__icon--neutral' : 'report-state-card__icon--danger'}`}
          aria-hidden="true"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h2 className="report-state-card__title">
          {missing
            ? t('result.report.reportNotGenerated')
            : emptyStatusTitle}
        </h2>
        <p className="report-state-card__desc">
          {missing
            ? t('result.report.generateReportDesc')
            : emptyStatusDesc}
        </p>
        {retryError && (
          <p className="report-state-card__error" role="alert">
            {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
          </p>
        )}
        {canGenerateReport && (
          <button
            type="button"
            onClick={() => void handleRetry()}
            disabled={retrying}
            aria-busy={retrying}
            className="report-state-card__button report-state-card__button--primary"
          >
            {retrying
              ? t('result.report.generating')
              : missing
                ? t('result.report.generateReport')
                : isReportStale
                  ? t('result.report.regenerateReport')
                  : t('result.report.retryGeneration')}
          </button>
        )}
      </div>
    );
  }

  if (missing) {
    if (variant === 'inline') {
      if (!canGenerateReport) {
        return null;
      }
      return (
        <div className="report-panel-container report-missing-inline-card">
          <div>
            <p className="text-sm font-semibold text-[color:var(--text-primary)]">📊 {t('result.report.fullReport')}</p>
            <p className="text-xs text-[color:var(--text-secondary)]">{t('result.report.generateReportDesc')}</p>
          </div>
          <button
            type="button"
            onClick={() => navigate(`/result/${activeScenarioId}/report`)}
            className="report-missing-inline-card__button"
          >
            {t('result.report.generateReport')}
          </button>
        </div>
      );
    }
    return null;
  }

  const title = report.title_i18n[reportContentLanguage] || report.title;

  return (
    <div className="report-doc report-panel-container report-panel-container--rendered">
      <div className="report-reading-controls">
        <div>
          <span className="report-reading-controls__depth">{t(isBrief ? 'result.report.briefTitle' : 'result.report.fullAnalysis')}</span>
          {isBrief && <p>{t('result.report.briefNoLlm')}</p>}
        </div>
        <div className="report-language-choice" role="group" aria-label={t('result.report.contentLanguage')}>
          {REPORT_CONTENT_LANGUAGES.map((language) => (
            <button
              key={language}
              type="button"
              className="btn btn-ghost"
              aria-pressed={preferredContentLanguage === language}
              disabled={retrying}
              onClick={() => {
                setRequestedLanguage(language);
                void i18n.changeLanguage(language);
              }}
            >
              {language === 'zh' ? '中文' : 'English'}
            </button>
          ))}
        </div>
      </div>
      {!requestedLanguageReady && (
        <p className="report-language-note" role="status">
          {t('result.report.languageNotReady', {
            requested: preferredContentLanguage === 'zh' ? '中文' : 'English',
            current: reportContentLanguage === 'zh' ? '中文' : 'English',
          })}
        </p>
      )}
      {reportContentLanguage !== sourceReport?.language && (
        <p className="report-language-note">{t('result.report.originalEvidenceNote')}</p>
      )}
      {!isReplayMode && (
        <details className="report-optional-actions">
          <summary>{t('result.report.optionalActions')}</summary>
          <p>{t('result.report.optionalCostUnknown')}</p>
          <p className="report-optional-actions__model">{providerPolicy.model.trim()
            ? t('result.report.sessionModel', { model: providerPolicy.model.trim() })
            : t('result.report.inheritedModel')}</p>
          <div className="report-optional-actions__buttons">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canGenerateReport || retrying || (isGenerating && !streamInterrupted)}
              onClick={() => void handleRetry()}
            >
              {t(isBrief ? 'result.report.generateFullAnalysis' : 'result.report.regenerateFullAnalysis')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canTranslateReport || retrying || (isGenerating && !streamInterrupted)}
              onClick={() => void handleRetry({ operation: 'translate', targetLanguage: preferredContentLanguage })}
            >
              {t('result.report.prepareLanguage', { language: preferredContentLanguage === 'zh' ? '中文' : 'English' })}
            </button>
          </div>
          {isReportStale && <p>{t('result.report.translateStaleHint')}</p>}
          {!canGenerateReport && <p>{t(scenarioStatus !== undefined && scenarioStatus !== 'done'
            ? 'result.report.completedScenarioRequired' : 'result.report.modelRequired')}</p>}
        </details>
      )}
      {retryError && !reportBannerKind && (
        <p className="report-operation-error" role="alert">
          {typeof retryError === 'string' ? retryError : t('result.report.operationFailedPreserved')}
        </p>
      )}
      {isReportStale && reportBannerKind !== 'stale' && (
        <div className="report-partial-banner report-partial-banner--stale" role="status">
          <div className="report-partial-banner__copy">
            <p className="report-partial-banner__title">
              {t('result.report.staleReportTitle')}
            </p>
            <p className="report-partial-banner__desc">
              {t('result.report.staleReportDesc')}
            </p>
          </div>
        </div>
      )}
      {reportBannerKind && (
        <div
          className={`report-partial-banner report-partial-banner--${reportBannerKind}`}
          role="status"
        >
          <div className="report-partial-banner__content">
            <span className="report-partial-banner__icon" aria-hidden="true">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </span>
            <div className="report-partial-banner__copy">
              <p className="report-partial-banner__title">
                {reportBannerTitle}
              </p>
              <p className="report-partial-banner__desc">
                {reportBannerDesc}
              </p>
              {retryError && (
                <p className="report-partial-banner__error" role="alert">
                  {typeof retryError === 'string' ? retryError : t('result.report.retryFailed')}
                </p>
              )}
              {streamInterrupted && (
                <p className="report-partial-banner__error" role="alert">
                  {t('result.report.streamInterrupted')}
                </p>
              )}
              {(isGenerating || pollStalled || sectionProgress.length > 0) && (
                <div className="report-stream-progress" aria-label={t('result.report.progressLabel')}>
                  <span className="report-stream-progress__summary">
                    {t('result.report.progressSections', { count: generationSectionCount })}
                  </span>
                  {activeSectionId && (
                    <span className="report-stream-progress__current">
                      {t('result.report.progressCurrentSection', { section: progressStageLabel(activeSectionId) })}
                    </span>
                  )}
                  {sectionProgress.map((item) => (
                    <div key={item.sectionId} className="report-stream-progress__item">
                      <span>
                        {item.status === 'complete'
                          ? t('result.report.progressSectionComplete', { section: progressStageLabel(item.sectionId) })
                          : t('result.report.progressSectionFailed', { section: progressStageLabel(item.sectionId) })}
                      </span>
                      {item.tier && (
                        <span className={`report-stream-progress__chip report-stream-progress__chip--${item.tier}`}>
                          {t(SECTION_TIER_LOCALE_KEYS[item.tier])}
                        </span>
                      )}
                      {item.failureReason != null && (
                        <span className="report-stream-progress__failure">
                          {t(SECTION_FAILURE_LOCALE_KEYS[normalizedFailureReason(item.failureReason)])}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {canGenerateReport && reportBannerKind !== 'generating' && reportBannerKind !== 'skipped' && (
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              aria-busy={retrying}
              className="report-partial-banner__retry"
            >
              {retrying
                ? t('result.report.generating')
                : isReportStale
                  ? t('result.report.regenerateReport')
                  : t('result.report.retryGeneration')}
            </button>
          )}
        </div>
      )}
      <div className="report-panel-body" lang={reportContentLanguage}>
        {variant === 'inline' ? (
          <>
            {!isReportStale && !isBrief && (
              <ReportConfidenceBadge verdict={report.verdict} language={reportContentLanguage} />
            )}

            {report.status === 'complete' && takeaways.length > 0 && (
              <div className="report-digest">
                <h3 className="report-digest__title">{t('result.report.takeawaysLabel')}</h3>
                <ul className="report-digest__list">
                  {takeaways.map((item, idx) => (
                    <li key={idx} className="report-digest__item">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.status === 'complete' && (
              <ReportToc
                sections={sections}
                hrefBase={`/result/${activeScenarioId}/report`}
                language={reportContentLanguage}
              />
            )}

            <div className="report-cta">
              <p className="report-cta__lead">{t(isBrief ? 'result.report.readBriefLead' : 'result.report.readFullReportLead')}</p>
              {isBrief && report.evidence.length > 0 && (
                <button type="button" className="btn btn-secondary" onClick={() => handleOpenEvidence(report.evidence.map((item) => item.id))}>
                  {t('result.report.viewCitedEvidence')}
                </button>
              )}
              <Link
                to={`/result/${activeScenarioId}/report`}
                className="report-cta__btn"
              >
                {t(isBrief ? 'result.report.readBrief' : 'result.report.readFullReport')}
              </Link>
            </div>
          </>
        ) : (
          <>
            {/* MASTHEAD — serif title + deck rule. Standalone /report only: the inline
                /result/:id embed already renders the page header + verdict card, so the
                report headline here would read as a duplicate stacked serif title (D1). */}
            {variant === 'standalone' && (
              <header className="report-masthead report-reveal">
                <h2 className="report-masthead__title">{title}</h2>
                <p className="report-masthead__deck">{t('result.report.deck')}</p>
                <hr className="report-masthead__rule" />
              </header>
            )}

            {/* HERO STAT BAND — probability / confidence / consensus / disclaimer band */}
            {!isReportStale && (
              <ReportConfidenceBadge verdict={report.verdict} language={reportContentLanguage} />
            )}

            <ReportToc sections={sections} language={reportContentLanguage} />

            <div className="report-content">
              {sections.map((section, idx) => (
                <ReportSection
                  key={section.id}
                  section={section}
                  index={idx}
                  onOpenEvidence={handleOpenEvidence}
                  language={reportContentLanguage}
                  intentionalBrief={isBrief}
                />
              ))}
              {retrying &&
                missingSections.map((id) => (
                  <section
                    key={`skeleton-${id}`}
                    className="report-section report-section--skeleton animate-pulse motion-reduce:animate-none"
                  >
                    <div className="report-section-skeleton__head">
                      <div className="h-6 bg-[color:var(--bg-hover)] rounded w-1/3" />
                      <div className="h-8 bg-[color:var(--bg-hover)] rounded w-24" />
                    </div>
                    <div className="report-section-skeleton__body">
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-full" />
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-5/6" />
                      <div className="h-4 bg-[color:var(--bg-hover)] rounded w-3/4" />
                    </div>
                  </section>
                ))}
            </div>

            <PremortemAnalysisBlock
              analysis={report.premortem_analysis}
              evidence={report.evidence}
              isZh={reportContentLanguage === 'zh'}
              onOpenEvidence={handleOpenEvidence}
            />

            {hasInterviews && (
              <section
                className="report-personas"
                aria-label={t('result.report.interviewsTitle')}
              >
                <div className="report-block-head">
                  <span className="report-block-head__bid" aria-hidden="true">A</span>
                  <h3 className="report-block-head__title">
                    {t('result.report.interviewsTitle')}
                  </h3>
                  {interviewEvidence.length > 0 && (
                    <span className="report-block-head__meta">
                      {t('result.report.sourcesCount', { count: interviewEvidence.length })}
                    </span>
                  )}
                </div>

                {/* §F: honesty intro — these are AI-played roles, not real persons */}
                <p className="report-personas__intro">{t('result.report.personas_intro')}</p>
                <p className="report-personas__intro">{t('result.report.originalEvidenceNote')}</p>

                {/* Interview Status Message */}
                {interviewStatus && interviewStatus.status !== 'complete' && (
                  <div className="report-personas__notice">
                    {interviewStatus.status === 'skipped' && (
                      <p>{t('result.report.interviewStatus_skipped', { message: interviewStatus.message || '' })}</p>
                    )}
                    {interviewStatus.status === 'failed' && (
                      <p>
                        {t('result.report.interviewStatus_failed', {
                          message: interviewStatus.message || '',
                          error_code: interviewStatus.error_code || 'UNKNOWN',
                        })}
                      </p>
                    )}
                    {interviewStatus.status === 'partial' && (
                      <p>
                        {t('result.report.interviewStatus_partial', {
                          message: interviewStatus.message || '',
                          completed: interviewStatus.completed_agents ?? 0,
                          requested: interviewStatus.requested_agents ?? 0,
                          truncated: interviewStatus.truncated_agents ?? 0,
                        })}
                      </p>
                    )}
                  </div>
                )}

                {/* Persona Cards */}
                {interviewEvidence.length > 0 && (
                  <div className="report-personas__grid">
                    {interviewEvidence.map((rawEntry, i) => {
                      if (!rawEntry) return null;
                      const entry = rawEntry as Partial<InterviewEvidenceEntry>;
                      const agentName = entry.agent_name || t('result.report.evidenceKind.default', 'Agent');
                      const branchIndex = entry.branch_index ?? 0;
                      const round = entry.round ?? 0;
                      const excerpt = entry.excerpt || '';

                      return (
                        <article key={i} className="report-persona-card">
                          <div className="report-persona-card__top">
                            <span className="report-persona-card__name">{agentName}</span>
                            <span className="report-persona-card__coord">
                              {t('result.report.interviewCoordinate', {
                                branch_index: branchIndex,
                                round: round,
                              })}
                            </span>
                          </div>
                          {excerpt && (
                            <blockquote className="report-persona-card__quote">{excerpt}</blockquote>
                          )}
                          <span className="report-persona-card__badge">
                            {t('result.report.persona_badge')}
                          </span>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {(report.indicators_to_watch?.length ?? 0) > 0 && (
              <section
                className="report-indicators"
                aria-label={t('result.report.indicatorsToWatch')}
              >
                <div className="report-block-head">
                  <span className="report-block-head__bid" aria-hidden="true">B</span>
                  <h3 className="report-block-head__title">
                    {t('result.report.indicatorsToWatch')}
                  </h3>
                  <span className="report-block-head__meta">
                    {t('result.report.watchlistCount', { count: report.indicators_to_watch.length })}
                  </span>
                </div>
                <div className="report-watch">
                  {report.indicators_to_watch.map((ind, i) => (
                    <div key={i} className="report-watch__row">
                      <div className="report-watch__signal">
                        {ind.signal}
                        {ind.observation && (
                          <span className="report-watch__signal-note">{ind.observation}</span>
                        )}
                        {ind.note && (
                          <span className="report-watch__signal-note">{ind.note}</span>
                        )}
                        {ind.rationale && (
                          <span className="report-watch__signal-rationale">{ind.rationale}</span>
                        )}
                      </div>
                      <div>
                        <span
                          className={`report-watch__dir ${ind.direction === 'up' ? 'is-up' : 'is-down'}`}
                        >
                          <span aria-hidden="true">{ind.direction === 'up' ? '↑' : '↓'}</span>
                          {ind.direction === 'up' ? t('result.report.rising') : t('result.report.falling')}
                        </span>
                      </div>
                      <div className="report-watch__horizon">
                        {ind.time_horizon ? ind.time_horizon : ''}
                      </div>
                      <div className="report-watch__threshold">
                        {ind.threshold && (
                          <>
                            <span className="report-watch__threshold-lbl">{t('result.report.threshold')}</span>
                            {ind.threshold}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* CONSOLE — real tool-trace summary; collapses to nothing when empty */}
            <ToolTraceChip trace={toolTrace} />

            {/* FOOTER */}
            <footer className="report-footer">
              <span>{t('result.report.footerBrand')}</span>
              <span>{t('result.report.footerTagline')}</span>
            </footer>
          </>
        )}
      </div>

      <ReportEvidenceDrawer
        isOpen={evidenceDrawerOpen}
        onClose={handleCloseEvidence}
        scenarioId={activeScenarioId || ''}
        evidence={currentEvidence}
        canOpenReplay={capabilities?.replay_trace?.enabled !== false}
      />
    </div>
  );
});

// Main exported component subscribing to ResultContext, but passing props
// to the memoized ResultReportPanelInner to narrow subscription.
export const ResultReportPanel = React.memo(function ResultReportPanel(props: Props) {
  const context = useResultContext();
  const storyData = props.storyData !== undefined ? props.storyData : context.storyData;
  const activeScenarioId = props.activeScenarioId !== undefined ? props.activeScenarioId : context.activeScenarioId;
  const isZh = props.isZh !== undefined ? props.isZh : context.isZh;
  const isReplayMode = props.isReplayMode !== undefined ? props.isReplayMode : context.isReplayMode;
  const scenarioStatus = props.scenarioStatus !== undefined ? props.scenarioStatus : context.scenario?.status;

  return (
    <ResultReportPanelInner
      {...props}
      storyData={storyData}
      activeScenarioId={activeScenarioId}
      isZh={isZh}
      isReplayMode={isReplayMode}
      scenarioStatus={scenarioStatus}
    />
  );
});
