import React from 'react';
import { Check } from 'lucide-react';

export interface StepDef {
  key: string;
  label: string;
}

export interface StepperProps {
  steps: StepDef[];
  currentIndex: number;
  className?: string;
}

export function Stepper({ steps, currentIndex, className = '' }: StepperProps) {
  return (
    <ol className={['flex items-center gap-1 sm:gap-2', className].join(' ')}>
      {steps.map((step, i) => {
        const done = i < currentIndex;
        const active = i === currentIndex;
        return (
          <li key={step.key} className="flex min-w-0 flex-1 items-center gap-1 sm:gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={[
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  done ? 'bg-primary text-on-primary' : active ? 'border-2 border-primary text-primary' : 'border border-border text-text-3',
                ].join(' ')}
                aria-hidden="true"
              >
                {done ? <Check size={13} /> : i + 1}
              </span>
              <span className={['hidden truncate text-sm font-medium sm:inline', active ? 'text-text' : done ? 'text-text-2' : 'text-text-3'].join(' ')}>
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

export default Stepper;
