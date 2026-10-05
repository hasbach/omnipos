/** Money inputs accept at most 2 decimal places, in every currency. */

/** Round a typed money amount to 2 decimals (float-safe: 1.005 -> 1.01). */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return sign * Number((Math.abs(n) * (1 + Number.EPSILON)).toFixed(2));
}

/**
 * Truncate a typed/pasted numeric string to 2 decimals. A trailing '.' (or a
 * 1-2 digit fraction) is preserved so the user can keep typing.
 */
export function clampMoneyInput(raw: string): string {
  const dot = raw.indexOf('.');
  if (dot === -1) return raw;
  return raw.slice(0, dot + 1) + raw.slice(dot + 1, dot + 3);
}
