import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ReportChart,
  ReportChartBase,
  ProbabilityBarChartData,
  FactionShareChartData,
} from '../../types';
import './ReportCharts.css';

interface ProbabilityBarChartProps {
  data: ProbabilityBarChartData;
}

export const ProbabilityBarChart = React.memo(function ProbabilityBarChart({ data }: ProbabilityBarChartProps) {
  const { t } = useTranslation();

  if (data.status === 'missing' || !data.branches || data.branches.length === 0) {
    return (
      <div className="text-sm text-[color:var(--text-muted)] italic my-2">
        {data.reason ? data.reason : t('result.report.chartEmpty')}
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
    <div className="my-4 p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] probability-bar-chart" role="region" aria-label={t('result.report.probabilityChartTitle')}>
      <h4 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">
        {t('result.report.probabilityChartTitle')}
      </h4>
      <div className="space-y-3">
        {sortedBranches.map((branch) => {
          const pct = Math.round(branch.probability * 100);
          const isDominant = branch.dominant;

          return (
            <div key={branch.branch_id} className="flex flex-col gap-1">
              <div className="flex justify-between items-center text-xs text-[color:var(--text-secondary)]">
                <span className="font-medium break-words [overflow-wrap:anywhere] max-w-[80%] flex items-center">
                  {branch.label}
                  {isDominant && (
                    <span 
                      className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold dominant-badge"
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
      <div className="text-sm text-[color:var(--text-muted)] italic my-2">
        {data.reason ? data.reason : t('result.report.chartEmpty')}
      </div>
    );
  }

  return (
    <div className="my-4 p-4 rounded-lg bg-[color:var(--bg-hover)] border border-[color:var(--border-subtle)] faction-share-chart" role="region" aria-label={t('result.report.factionChartTitle')}>
      <h4 className="text-sm font-semibold text-[color:var(--text-primary)] mb-3">
        {t('result.report.factionChartTitle')}
      </h4>
      <div className="space-y-3">
        {data.factions.map((faction) => {
          const pct = Math.round(faction.share * 100);
          return (
            <div key={faction.faction_key} className="flex flex-col gap-1">
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
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--text-muted)] mt-3 pt-3 border-t border-[color:var(--border-subtle)]">
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
  return chart.type === 'probability_bar';
}

function isFactionShareChart(chart: ReportChart): chart is ReportChartBase & { type: 'faction_share'; data: FactionShareChartData } {
  return chart.type === 'faction_share';
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
    <div className="mt-4 p-4 bg-[color:var(--bg-hover)] rounded border border-[color:var(--border-subtle)] text-sm text-[color:var(--text-muted)] italic chart-unavailable">
      {t('result.report.chartUnavailable')}
    </div>
  );
});
