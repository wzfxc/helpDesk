'use client';

import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { FieldError } from 'react-hook-form';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-blue-700 text-white hover:bg-blue-800 disabled:bg-blue-300 dark:bg-blue-600 dark:hover:bg-blue-500 dark:disabled:bg-blue-900',
  secondary:
    'border border-slate-400 bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-500 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:opacity-50',
  ghost: 'text-slate-800 hover:bg-slate-200 dark:text-slate-100 dark:hover:bg-slate-800',
};

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type={type}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium',
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

export const inputClass =
  'w-full rounded-md border border-slate-400 bg-white px-3 py-1.5 text-sm text-slate-900 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100';

interface FieldRenderProps {
  id: string;
  'aria-invalid': boolean;
  'aria-describedby': string | undefined;
}

/** Label + control + error text, wired together with aria-invalid / aria-describedby. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: (props: FieldRenderProps) => ReactNode;
}) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ');
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy || undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Maps a react-hook-form/zod error to a localized message. */
export function fieldErrorMessage(
  t: (key: string, values?: Record<string, string | number>) => string,
  error: FieldError | undefined,
  max?: number,
): string | undefined {
  if (!error) return undefined;
  switch (error.type) {
    case 'too_small':
    case 'invalid_type':
      return t('errors.required');
    case 'too_big':
      return t('errors.tooLong', { max: max ?? 0 });
    default:
      return t('errors.invalid');
  }
}

const BADGE_COLORS: Record<string, string> = {
  new: 'bg-sky-100 text-sky-900 dark:bg-sky-900 dark:text-sky-100',
  open: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900 dark:text-emerald-100',
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  resolved: 'bg-violet-100 text-violet-900 dark:bg-violet-900 dark:text-violet-100',
  closed: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  low: 'bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100',
  normal: 'bg-blue-100 text-blue-900 dark:bg-blue-900 dark:text-blue-100',
  high: 'bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100',
  urgent: 'bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100',
};

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-block rounded px-2 py-0.5 text-xs font-medium',
        BADGE_COLORS[kind] ?? BADGE_COLORS.closed,
      )}
    >
      {children}
    </span>
  );
}
