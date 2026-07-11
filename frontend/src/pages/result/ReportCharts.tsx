import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ReportChart,
  ReportChartBase,
  ProbabilityBarChartData,
  FactionShareChartData,
} from '../../types';
import './ReportCharts.css';
import { resolveChartEmptyReason } from './reportChartEmpty';

interface ProbabilityBarChartProps {
  data: ProbabilityBarChartData;
}

export const ProbabilityBarChart = React.memo(function ProbabilityBarChart({ data }: ProbabilityBarChartProps) {
  const { t } = useTranslation();

  if (data.status === 'missing' || !data.branches || data.branches.length === 0) {
    return (
      <div className="report-chart-empty text-sm text-[color:var(--text-muted)] italic">
        {resolveChartEmptyReason(data.reason, t)}
      </div>
    );
  }

  if (data.branches.length === 1) {
    return (
      <div className="report-chart-empty text-sm text-[color:var(--text-muted)] italic">
        {t(
          'result.report.probabilityChartNoComparison',
          'Only one simulated path is available, so there is no branch comparison.',
        )}
      </div>
    );
  }

  // Sort branches according to data.sort if available
  const sortedBranches = [...data.branches].sort((a, b) => {
    if (data.sort) {
      const indexA = data.sort.indexOf(a.branch_id);
      const indexB = data.sort.indexOf(b.branch_id);
      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
    }
    return 0;
  });

  return (
    <div className="rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] probability-bar-chart" role="region" aria-label={t('result.report.probabilityChartTitle')}>
      <h4 className="text-sm font-semibold text-[color:var(--text-primary)]">
        {t('result.report.probabilityChartTitle')}
      </h4>
      <div className="report-chart__rows">
        {sortedBranches.map((branch) => {
          const pct = Math.round(branch.probability * 100);
          const isDominant = branch.dominant;

          return (
            <div key={branch.branch_id} className="report-chart__row">
              <div className="flex justify-between items-center text-xs text-[color:var(--text-secondary)]">
                <span className="font-medium break-words [overflow-wrap:anywhere] max-w-[80%] flex items-center">
                  {branch.label}
                  {isDominant && (
                    <span
                      className="inline-flex items-center rounded text-[10px] font-bold dominant-badge"
                      title={t('result.report.dominantBranch')}
                    >
                      <span className="sr-only">{t('result.report.dominantBranch')}</span>
                      ★
                    </span>
                  )}
                </span>
                <span className="font-semibold tabular-nums shrink-0">{pct}%</span>
              </div>
              <div
                className="w-full bg-[color:var(--bg-hover)] rounded-full h-2.5 overflow-hidden border border-[color:var(--border-subtle)] relative bar-track"
                role="img"
                aria-label={`${branch.label}: ${pct}%${isDominant ? ` (${t('result.report.dominantBranch')})` : ''}`}
              >
                <div
                  className={`h-full rounded-full transition-all duration-500 ease-out bar-fill ${
                    isDominant
                      ? 'bg-[color:var(--color-primary)]'
                      : 'bg-[color:var(--text-muted)]'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

interface FactionShareChartProps {
  data: FactionShareChartData;
}

export const FactionShareChart = React.memo(function FactionShareChart({ data }: FactionShareChartProps) {
  const { t } = useTranslation();

  if (data.status === 'missing' || !data.factions || data.factions.length === 0) {
    return (
      <div className="report-chart-empty text-sm text-[color:var(--text-muted)] italic">
        {resolveChartEmptyReason(data.reason, t)}
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] faction-share-chart" role="region" aria-label={t('result.report.factionChartTitle')}>
      <h4 className="text-sm font-semibold text-[color:var(--text-primary)]">
        {t('result.report.factionChartTitle')}
      </h4>
      <div className="report-chart__rows">
        {data.factions.map((faction) => {
          const pct = Math.round(faction.share * 100);
          return (
            <div key={faction.faction_key} className="report-chart__row">
              <div className="flex justify-between items-center text-xs text-[color:var(--text-secondary)]">
                <span className="font-medium break-words [overflow-wrap:anywhere] max-w-[60%]">
                  {faction.label}
                </span>
                <span className="text-[color:var(--text-muted)] shrink-0">
                  {t('result.report.factionMembers', { count: faction.member_count })} ({pct}%)
                </span>
              </div>
              <div
                className="w-full bg-[color:var(--bg-hover)] rounded-full h-2.5 overflow-hidden border border-[color:var(--border-subtle)] relative bar-track"
                role="img"
                aria-label={`${faction.label}: ${pct}%, ${t('result.report.factionMembers', { count: faction.member_count })}`}
              >
                <div
                  className="h-full rounded-full transition-all duration-500 ease-out bg-[color:var(--color-primary)] bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Footnote */}
      <div className="report-chart__footnote">
        <span>
          {t('result.report.factionRelations', { count: data.relation_edge_count })}
        </span>
        <span>
          {data.avg_opposition !== null && data.avg_opposition !== undefined
            ? t('result.report.factionOpposition', { value: Math.round(data.avg_opposition * 100) / 100 })
            : t('result.report.factionOppositionNone')}
        </span>
      </div>
    </div>
  );
});

// Runtime Type Guards
function isProbabilityBarChart(chart: ReportChart): chart is ReportChartBase & { type: 'probability_bar'; data: ProbabilityBarChartData } {
  if (chart.type !== 'probability_bar') {
    return false;
  }
  const data = chart.data;
  return (
    data !== null &&
    typeof data === 'object' &&
    'branches' in data &&
    Array.isArray(data.branches)
  );
}

function isFactionShareChart(chart: ReportChart): chart is ReportChartBase & { type: 'faction_share'; data: FactionShareChartData } {
  if (chart.type !== 'faction_share') {
    return false;
  }
  const data = chart.data;
  return (
    data !== null &&
    typeof data === 'object' &&
    'factions' in data &&
    Array.isArray(data.factions)
  );
}

interface ReportChartRendererProps {
  chart: ReportChart;
}

export const ReportChartRenderer = React.memo(function ReportChartRenderer({ chart }: ReportChartRendererProps) {
  const { t } = useTranslation();

  if (isProbabilityBarChart(chart)) {
    return <ProbabilityBarChart data={chart.data} />;
  }

  if (isFactionShareChart(chart)) {
    return <FactionShareChart data={chart.data} />;
  }

  return (
    <div className="bg-[color:var(--bg-hover)] rounded border border-[color:var(--border-subtle)] text-sm text-[color:var(--text-muted)] italic chart-unavailable">
      {t('result.report.chartUnavailable')}
    </div>
  );
});
