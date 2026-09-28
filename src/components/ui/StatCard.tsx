import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card } from './Card';

export interface StatCardProps {
  label: string;
  value: React.ReactNode;
  delta?: number; // percent, positive = good/up, negative = bad/down
  icon?: LucideIcon;
  /** Optional sparkline values (rendered as a tiny inline SVG trend line). */
  trend?: number[];
  className?: string;
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 64;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} className="shrink-0" aria-hidden="true">
      <polyline points={points} fill="none" stroke="var(--color-primary)" strokeWidth={1.5} />
    </svg>
  );
}

export function StatCard({ label, value, delta, icon: Icon, trend, className = '' }: StatCardProps) {
  const isUp = typeof delta === 'number' && delta >= 0;

  return (
    <Card className={['p-4 min-w-0', className].join(' ')}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-medium uppercase tracking-[0.04em] text-text-3" title={label}>{label}</p>
        {Icon && (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-primary">
            <Icon size={16} aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        {/* Never wrap an amount across lines ("$" / "6,571.32"); scale down in narrow cards instead. */}
        <p className="num min-w-0 truncate whitespace-nowrap text-[clamp(1.25rem,1.9vw,1.75rem)] font-bold leading-none text-text">{value}</p>
        {trend && <Sparkline values={trend} />}
      </div>
      {typeof delta === 'number' && (
        <div className={['mt-2 inline-flex items-center gap-1 text-xs font-medium', isUp ? 'text-success' : 'text-danger'].join(' ')}>
          {isUp ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
          <span className="num">{Math.abs(delta).toFixed(1)}%</span>
        </div>
      )}
    </Card>
  );
}

export default StatCard;
