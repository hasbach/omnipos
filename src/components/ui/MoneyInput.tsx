import React, { forwardRef } from 'react';
import { Input, type InputProps } from './Input';

export interface MoneyInputProps extends Omit<InputProps, 'type' | 'onChange' | 'value' | 'startAdornment' | 'endAdornment'> {
  value: number | '';
  onChange: (value: number) => void;
  /** e.g. "$" or "LL" */
  currencySymbol?: string;
  min?: number;
  step?: number;
}

/** Money input: currency suffix/prefix, tabular right-aligned figures, select-all-on-focus. */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(function MoneyInput(
  { value, onChange, currencySymbol, className = '', onFocus, step = 0.01, ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      step={step}
      value={value}
      startAdornment={currencySymbol}
      className={['num text-end', className].join(' ')}
      onFocus={(e) => {
        e.target.select();
        onFocus?.(e);
      }}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(raw === '' ? 0 : Number(raw));
      }}
      {...rest}
    />
  );
});

export default MoneyInput;
