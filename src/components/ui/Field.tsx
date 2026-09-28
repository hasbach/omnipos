import React from 'react';

export interface FieldProps {
  label?: React.ReactNode;
  htmlFor?: string;
  helper?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

export function Field({ label, htmlFor, helper, error, required, className = '', children }: FieldProps) {
  return (
    <div className={['flex flex-col gap-1.5', className].join(' ')}>
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-text-2">
          {label}
          {required && <span className="text-danger ms-0.5">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : helper ? (
        <p className="text-xs text-text-3">{helper}</p>
      ) : null}
    </div>
  );
}

export default Field;
