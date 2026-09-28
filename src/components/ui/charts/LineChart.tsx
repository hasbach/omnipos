import React, { useState } from 'react';
import { useI18n } from '../../../intl/index';
import { formatNumber } from '../../../lib/format';

export interface LineChartSeries {
  name: string;
  color?: string;
  data: number[];
}

export interface LineChartProps {
  labels: string[];
  series: LineChartSeries[];
  height?: number;
  width?: number;
  valueFormatter?: (v: number) => string;
  className?: string;
}

const DEFAULT_COLORS = ['var(--color-primary)', 'var(--color-accent)', 'var(--color-success)', 'var(--color-info)'];

export function LineChart({ labels, series, height = 220, width = 640, valueFormatter, className = '' }: LineChartProps) {
  let chartLabel = 'Line chart';
  try {
    chartLabel = useI18n().t('ui_line_chart', 'Line chart');
  } catch {
    /* charts can be used outside I18nProvider in rare cases. */
  }
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const padding = { top: 16, right: 16, bottom: 28, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const allValues = series.flatMap((s) => s.data);
  // Round the axis out to a "nice" step (1/2/2.5/5 × 10^n over 4 gridlines) so labels read
  // $0 / $150 / $300 … rather than $152.76 / $305.51.
  const niceStep = (span: number) => {
    const raw = span / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  };
  const rawMax = Math.max(1, ...allValues);
  const rawMin = Math.min(0, ...allValues);
  const step = niceStep(rawMax - rawMin);
  const max = Math.ceil(rawMax / step) * step;
  const min = Math.floor(rawMin / step) * step;
  const range = max - min || 1;

  const n = labels.length;
  const xFor = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const yFor = (v: number) => innerH - ((v - min) / range) * innerH;

  const fmt = valueFormatter || ((v: number) => formatNumber(v, { decimals: 0 }));

  return (
    <div className={['relative w-full', className].join(' ')}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label={chartLabel}>
        <g transform={`translate(${padding.left},${padding.top})`}>
          {/* gridlines */}
          {Array.from({ length: Math.round(range / step) + 1 }, (_, i) => i / Math.round(range / step)).map((t) => {
            const y = innerH * t;
            const val = Math.round((max - range * t) / step) * step;
            return (
              <g key={t}>
                <line x1={0} x2={innerW} y1={y} y2={y} stroke="var(--color-border)" strokeWidth={1} />
                <text x={-8} y={y} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--color-text-3)">
                  {fmt(val)}
                </text>
              </g>
            );
          })}

          {series.map((s, si) => {
            const color = s.color || DEFAULT_COLORS[si % DEFAULT_COLORS.length];
            const points = s.data.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ');
            return (
              <g key={s.name}>
                <polyline points={points} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {s.data.map((v, i) => (
                  <circle
                    key={i}
                    cx={xFor(i)}
                    cy={yFor(v)}
                    r={hoverIdx === i ? 4 : 2.5}
                    fill={color}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
                  />
                ))}
              </g>
            );
          })}

          {/* hover guide */}
          {hoverIdx !== null && (
            <line x1={xFor(hoverIdx)} x2={xFor(hoverIdx)} y1={0} y2={innerH} stroke="var(--color-border-strong)" strokeDasharray="3 3" />
          )}

          {/* x labels */}
          {labels.map((l, i) => {
            if (n > 8 && i % Math.ceil(n / 8) !== 0) return null;
            return (
              <text key={i} x={xFor(i)} y={innerH + 18} textAnchor="middle" fontSize={10} fill="var(--color-text-3)">
                {l}
              </text>
            );
          })}
        </g>
      </svg>

      {hoverIdx !== null && (
        <div className="pointer-events-none absolute top-2 start-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-[var(--shadow-card)]">
          <p className="font-medium text-text">{labels[hoverIdx]}</p>
          {series.map((s, si) => (
            <p key={s.name} className="flex items-center gap-1.5 text-text-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.color || DEFAULT_COLORS[si % DEFAULT_COLORS.length] }}
              />
              {s.name}: <span className="num">{fmt(s.data[hoverIdx])}</span>
            </p>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {series.map((s, si) => (
            <span key={s.name} className="inline-flex items-center gap-1.5 text-xs text-text-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: s.color || DEFAULT_COLORS[si % DEFAULT_COLORS.length] }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default LineChart;
