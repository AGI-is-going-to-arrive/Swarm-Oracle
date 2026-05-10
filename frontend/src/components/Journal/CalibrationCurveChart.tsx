/* ═══════════════════════════════════════════════════════════
   Personal Prediction Journal — Calibration Curve Chart
   Pure SVG line chart, no external charting library.
   X = predicted probability (0..1), Y = actual frequency (0..1).
   ═══════════════════════════════════════════════════════════ */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CalibrationBin } from '../../api/client';

interface Props {
  bins: CalibrationBin[];
  width?: number;
  height?: number;
}

/** Logical SVG viewport. Outer padding leaves room for axis labels. */
const PADDING_LEFT = 44;
const PADDING_RIGHT = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 36;

interface Plotted {
  x: number;
  y: number;
  bin: CalibrationBin & { predicted_avg: number; actual_frequency: number };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function hasPoint(bin: CalibrationBin): bin is CalibrationBin & {
  predicted_avg: number;
  actual_frequency: number;
} {
  return Number.isFinite(bin.predicted_avg) && Number.isFinite(bin.actual_frequency);
}

function formatRange(range: CalibrationBin['range']): string {
  if (Array.isArray(range) && range.length >= 2) {
    return `${range[0].toFixed(1)}-${range[1].toFixed(1)}`;
  }
  return '';
}

export function CalibrationCurveChart({ bins, width = 480, height = 320 }: Props) {
  const { t } = useTranslation();
  const innerW = Math.max(0, width - PADDING_LEFT - PADDING_RIGHT);
  const innerH = Math.max(0, height - PADDING_TOP - PADDING_BOTTOM);

  const plotted = useMemo<Plotted[]>(() => {
    if (!Array.isArray(bins)) return [];
    return bins
      .filter((bin): bin is CalibrationBin & { predicted_avg: number; actual_frequency: number } => Boolean(bin) && hasPoint(bin))
      .map((bin) => {
        const px = clamp01(bin.predicted_avg);
        const py = clamp01(bin.actual_frequency);
        return {
          x: PADDING_LEFT + px * innerW,
          y: PADDING_TOP + (1 - py) * innerH,
          bin,
        };
      })
      .sort((a, b) => a.bin.predicted_avg - b.bin.predicted_avg);
  }, [bins, innerW, innerH]);

  const polylinePoints = useMemo(
    () => plotted.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
    [plotted],
  );

  const isEmpty = plotted.length === 0;

  // 45-degree reference line (perfect calibration)
  const refX0 = PADDING_LEFT;
  const refY0 = PADDING_TOP + innerH;
  const refX1 = PADDING_LEFT + innerW;
  const refY1 = PADDING_TOP;

  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <figure className="journal-calibration" aria-label={t('journal.calibration.aria_label', 'Calibration curve')}>
      <svg
        className="journal-calibration__svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby="journal-calibration-title"
        preserveAspectRatio="xMidYMid meet"
      >
        <title id="journal-calibration-title">
          {t('journal.calibration.title', 'Calibration curve')}
        </title>

        {/* Plot area background */}
        <rect
          x={PADDING_LEFT}
          y={PADDING_TOP}
          width={innerW}
          height={innerH}
          className="journal-calibration__plot-bg"
        />

        {/* Grid + tick marks */}
        {ticks.map((tick) => {
          const tx = PADDING_LEFT + tick * innerW;
          const ty = PADDING_TOP + (1 - tick) * innerH;
          return (
            <g key={tick} className="journal-calibration__tick">
              {/* vertical gridline */}
              <line
                x1={tx}
                x2={tx}
                y1={PADDING_TOP}
                y2={PADDING_TOP + innerH}
                className="journal-calibration__gridline"
              />
              {/* horizontal gridline */}
              <line
                x1={PADDING_LEFT}
                x2={PADDING_LEFT + innerW}
                y1={ty}
                y2={ty}
                className="journal-calibration__gridline"
              />
              {/* x-axis label */}
              <text
                x={tx}
                y={PADDING_TOP + innerH + 18}
                className="journal-calibration__axis-label"
                textAnchor="middle"
              >
                {tick.toFixed(2)}
              </text>
              {/* y-axis label */}
              <text
                x={PADDING_LEFT - 8}
                y={ty + 4}
                className="journal-calibration__axis-label"
                textAnchor="end"
              >
                {tick.toFixed(2)}
              </text>
            </g>
          );
        })}

        {/* 45-degree perfect-calibration reference line */}
        <line
          x1={refX0}
          y1={refY0}
          x2={refX1}
          y2={refY1}
          className="journal-calibration__reference"
          aria-hidden="true"
        />

        {/* Connecting polyline + circles for each bin */}
        {!isEmpty && (
          <>
            <polyline
              points={polylinePoints}
              className="journal-calibration__line"
              fill="none"
              aria-hidden="true"
            />
            {plotted.map((p, idx) => (
              <circle
                key={`${p.bin.range}-${idx}`}
                cx={p.x}
                cy={p.y}
                r={Math.min(8, 4 + Math.log2((p.bin.count || 0) + 1))}
                className="journal-calibration__point"
              >
                <title>
                  {t('journal.calibration.point_tooltip', {
                    defaultValue: '{{range}}: predicted {{predicted}}, actual {{actual}} (n={{count}})',
                    range: formatRange(p.bin.range),
                    predicted: p.bin.predicted_avg.toFixed(2),
                    actual: p.bin.actual_frequency.toFixed(2),
                    count: p.bin.count,
                  })}
                </title>
              </circle>
            ))}
          </>
        )}

        {/* Axis titles */}
        <text
          x={PADDING_LEFT + innerW / 2}
          y={height - 6}
          className="journal-calibration__axis-title"
          textAnchor="middle"
        >
          {t('journal.calibration.x_axis', 'Predicted probability')}
        </text>
        <text
          x={12}
          y={PADDING_TOP + innerH / 2}
          className="journal-calibration__axis-title"
          textAnchor="middle"
          transform={`rotate(-90, 12, ${PADDING_TOP + innerH / 2})`}
        >
          {t('journal.calibration.y_axis', 'Actual frequency')}
        </text>

        {isEmpty && (
          <text
            x={PADDING_LEFT + innerW / 2}
            y={PADDING_TOP + innerH / 2}
            className="journal-calibration__empty-label"
            textAnchor="middle"
          >
            {t('journal.calibration.empty', 'No resolved predictions yet.')}
          </text>
        )}
      </svg>
      <figcaption className="journal-calibration__caption">
        {t('journal.calibration.caption', 'Diagonal = perfect calibration; circle size scales with sample count.')}
      </figcaption>
    </figure>
  );
}

export default CalibrationCurveChart;
