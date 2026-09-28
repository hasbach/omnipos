import React, { forwardRef } from 'react';
import { Input, type InputProps } from './Input';

export interface NumberInputProps extends Omit<InputProps, 'type' | 'onChange' | 'value'> {
  value: number | '';
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

/** Numeric input: tabular figures, select-all-on-focus, reports plain numbers via onChange. */
export const NumberInput = forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  { value, onChange, className = '', onFocus, ...rest },
  ref,
) {
  return (
    <Input
      ref={ref}
      type="number"
      inputMode="decimal"
      value={value}
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

export default NumberInput;
