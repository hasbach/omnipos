import React, { useState } from 'react';
import { useI18n } from '../../../intl/index';
import { formatNumber } from '../../../lib/format';

export interface BarChartDatum {
  label: string;
  value: number;
  color?: string;
}

export interface BarChartProps {
  data: BarChartDatum[];
  height?: number;
  width?: number;
  valueFormatter?: (v: number) => string;
  horizontal?: boolean;
  className?: string;
}

export function BarChart({ data, height = 220, width = 640, valueFormatter, horizontal, className = '' }: BarChartProps) {
  let chartLabel = 'Bar chart';
  try {
    chartLabel = useI18n().t('ui_bar_chart', 'Bar chart');
  } catch {
    /* charts can be used outside I18nProvider in rare cases. */
  }
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const padding = horizontal
    ? { top: 8, right: 40, bottom: 8, left: 96 }
    : { top: 16, right: 16, bottom: 32, left: 44 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const max = Math.max(1, ...data.map((d) => d.value));
  const fmt = valueFormatter || ((v: number) => formatNumber(v, { decimals: 0 }));
  const n = data.length || 1;

  if (horizontal) {
    const barH = Math.min(28, innerH / n - 8);
    return (
      <div className={['relative w-full', className].join(' ')}>
        <svg viewBox={`0 0 ${width} ${Math.max(height, n * (barH + 12))}`} className="w-full h-auto" role="img" aria-label={chartLabel}>
          <g transform={`translate(${padding.left},${padding.top})`}>
            {data.map((d, i) => {
              const y = i * (barH + 12);
              const w = (d.value / max) * innerW;
              return (
                <g key={i} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}>
                  <text x={-8} y={y + barH / 2} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--color-text-2)">
                    {d.label}
                  </text>
                  <rect x={0} y={y} width={innerW} height={barH} rx={3} fill="var(--color-surface-2)" />
                  <rect
                    x={0}
                    y={y}
                    width={Math.max(2, w)}
                    height={barH}
                    rx={3}
                    fill={d.color || 'var(--color-primary)'}
                    opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.5}
                  />
                  <text x={w + 6} y={y + barH / 2} dominantBaseline="middle" fontSize={11} fill="var(--color-text)">
                    {fmt(d.value)}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    );
  }

  const barW = Math.min(48, innerW / n - 8);

  return (
    <div className={['relative w-full', className].join(' ')}>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label={chartLabel}>
        <g transform={`translate(${padding.left},${padding.top})`}>
          <line x1={0} x2={innerW} y1={innerH} y2={innerH} stroke="var(--color-border)" strokeWidth={1} />
          {data.map((d, i) => {
            const x = i * (innerW / n) + (innerW / n - barW) / 2;
            const h = (d.value / max) * innerH;
            return (
              <g key={i} onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)}>
                <rect
                  x={x}
                  y={innerH - h}
                  width={barW}
                  height={h}
                  rx={3}
                  fill={d.color || 'var(--color-primary)'}
                  opacity={hoverIdx === null || hoverIdx === i ? 1 : 0.5}
                />
                <text x={x + barW / 2} y={innerH + 16} textAnchor="middle" fontSize={10} fill="var(--color-text-3)">
                  {d.label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {hoverIdx !== null && (
        <div className="pointer-events-none absolute top-2 start-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs shadow-[var(--shadow-card)]">
          <p className="font-medium text-text">{data[hoverIdx].label}</p>
          <p className="num text-text-2">{fmt(data[hoverIdx].value)}</p>
        </div>
      )}
    </div>
  );
}

export default BarChart;
