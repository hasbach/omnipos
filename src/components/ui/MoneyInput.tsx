import React, { forwardRef } from 'react';
import { Input, type InputProps } from './Input';
import { clampMoneyInput, roundMoney } from '../../lib/money';

export interface MoneyInputProps extends Omit<InputProps, 'type' | 'onChange' | 'value' | 'startAdornment' | 'endAdornment'> {
  value: number | '';
  onChange: (value: number) => void;
  /** e.g. "$" or "LL" */
  currencySymbol?: string;
  min?: number;
  step?: number;
  /** Decimal places kept (default 2). Costs use 6 so a cost keyed in the local currency converts back exactly. */
  decimals?: number;
}

function clampDecimals(raw: string, decimals: number): string {
  const dot = raw.indexOf('.');
  return dot === -1 ? raw : raw.slice(0, dot + 1) + raw.slice(dot + 1, dot + 1 + decimals);
}

/** Money input (max 2 decimals in any currency unless `decimals` says otherwise): currency suffix/prefix, tabular right-aligned figures, select-all-on-focus. */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, currencySymbol, className = '', onFocus, onBlur, step = 0.01, decimals = 2, ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      step={decimals > 2 ? 'any' : step}
      value={value}
      startAdornment={currencySymbol}
      className={['num text-end', className].join(' ')}
      onFocus={(e) => {
        e.target.select();
        onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = decimals === 2 ? clampMoneyInput(e.target.value) : clampDecimals(e.target.value, decimals);
        onChange(raw === '' ? 0 : Number(raw));
      }}
      onBlur={(e) => {
        if (value !== '' && Number.isFinite(value)) {
          const r = decimals === 2 ? roundMoney(value) : Number(value.toFixed(decimals));
          if (r !== value) onChange(r);
        }
        onBlur?.(e);
      }}
      {...rest}
    />
  );
});

export default MoneyInput;
