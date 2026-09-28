import React, { useMemo, useState } from 'react';
import { formatNumber } from '../../lib/format';

export interface CurrencyLike {
  code: string;
  symbol: string;
  rate?: number;
}

/**
 * Common bill/coin denominations for a currency. USD gets the standard set of bills.
 * Any local currency with a high per-USD rate (LBP-like) gets the standard Lebanese pound note
 * set. Anything else falls back to a magnitude-derived set so the counter is never empty.
 */
function denominationsFor(currency: CurrencyLike): number[] {
  if (currency.code === 'USD') return [100, 50, 20, 10, 5, 1];
  if (currency.code === 'LBP' || currency.code === 'LB') {
    return [100000, 50000, 20000, 10000, 5000, 1000];
  }
  const rate = currency.rate && currency.rate > 0 ? currency.rate : 1;
  const magnitude = Math.pow(10, Math.max(0, Math.floor(Math.log10(rate || 1))));
  return [magnitude * 10, magnitude * 5, magnitude * 2, magnitude, Math.max(1, magnitude / 2), Math.max(1, magnitude / 5)]
    .map((n) => Math.round(n))
    .filter((n, i, arr) => n > 0 && arr.indexOf(n) === i);
}

export interface DenominationCounterProps {
  currency: CurrencyLike;
  onTotalChange?: (total: number) => void;
  className?: string;
}

/** A per-denomination quantity counter for one currency; reports the counted subtotal. */
export function DenominationCounter({ currency, onTotalChange, className = '' }: DenominationCounterProps) {
  const denoms = useMemo(() => denominationsFor(currency), [currency.code, currency.rate]);
  const [qty, setQty] = useState<Record<number, string>>({});

  const total = denoms.reduce((sum, d) => sum + (parseFloat(qty[d] || '0') || 0) * d, 0);

  React.useEffect(() => {
    onTotalChange?.(total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  return (
    <div className={['flex flex-col gap-1.5', className].join(' ')}>
      {denoms.map((d) => {
        const q = parseFloat(qty[d] || '0') || 0;
        return (
          <div key={d} className="flex items-center gap-2 text-sm">
            <span className="num w-24 shrink-0 font-medium text-text-2">
              {currency.symbol} {formatNumber(d, { decimals: 0 })}
            </span>
            <span className="text-text-3">×</span>
            <input
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={qty[d] ?? ''}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setQty((prev) => ({ ...prev, [d]: e.target.value }))}
              className="num h-8 w-20 rounded-[var(--radius-input)] border border-border bg-surface px-2 text-end text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              placeholder="0"
            />
            <span className="text-text-3">=</span>
            <span className="num flex-1 text-end text-text-2">
              {currency.symbol} {formatNumber(q * d, { decimals: 0 })}
            </span>
          </div>
        );
      })}
      <div className="mt-1 flex items-center justify-between border-t border-border pt-2 text-sm font-semibold">
        <span className="text-text-2">Subtotal</span>
        <span className="num text-text">
          {currency.symbol} {formatNumber(total, { decimals: currency.rate && currency.rate > 100 ? 0 : 2 })}
        </span>
      </div>
    </div>
  );
}

export default DenominationCounter;
