import React, { useState } from 'react';
import { useI18n } from '../../../intl/index';
import { formatNumber } from '../../../lib/format';

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

export interface DonutChartProps {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  valueFormatter?: (v: number) => string;
  centerLabel?: string;
  className?: string;
}

const DEFAULT_COLORS = [
  'var(--color-primary)',
  'var(--color-accent)',
  'var(--color-success)',
  'var(--color-info)',
  'var(--color-danger)',
  'var(--color-border-strong)',
];

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polar(cx, cy, r, endAngle);
  const end = polar(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

export function DonutChart({ data, size = 180, thickness = 24, valueFormatter, centerLabel, className = '' }: DonutChartProps) {
  let chartLabel = 'Donut chart';
  try {
    chartLabel = useI18n().t('ui_donut_chart', 'Donut chart');
  } catch {
    /* charts can be used outside I18nProvider in rare cases. */
  }
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = size / 2 - thickness / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  const fmt = valueFormatter || ((v: number) => formatNumber(v, { decimals: 0 }));

  let cursor = 0;
  const segments = data.map((d, i) => {
    const angle = (d.value / total) * 360;
    const seg = { start: cursor, end: cursor + angle, d, i };
    cursor += angle;
    return seg;
  });

  return (
    <div className={['flex items-center gap-4', className].join(' ')}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={chartLabel}>
          {segments.map((seg) => (
            <path
              key={seg.i}
              d={arcPath(cx, cy, r, seg.start, seg.end === seg.start ? seg.end + 0.001 : seg.end)}
              fill="none"
              stroke={seg.d.color || DEFAULT_COLORS[seg.i % DEFAULT_COLORS.length]}
              strokeWidth={thickness}
              opacity={hoverIdx === null || hoverIdx === seg.i ? 1 : 0.4}
              onMouseEnter={() => setHoverIdx(seg.i)}
              onMouseLeave={() => setHoverIdx(null)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {hoverIdx !== null ? (
            <>
              <span className="text-xs text-text-3">{data[hoverIdx].label}</span>
              <span className="num text-sm font-semibold text-text">{fmt(data[hoverIdx].value)}</span>
            </>
          ) : (
            <>
              <span className="num text-lg font-semibold text-text">{fmt(total)}</span>
              {centerLabel && <span className="text-xs text-text-3">{centerLabel}</span>}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        {data.map((d, i) => (
          <button
            key={i}
            type="button"
            className="flex items-center gap-1.5 text-xs cursor-pointer"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: d.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length] }} />
            <span className="text-text-2">{d.label}</span>
            <span className="num text-text-3">{fmt(d.value)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default DonutChart;
