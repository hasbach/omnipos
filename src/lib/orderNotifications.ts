// New-online-order notifications on a register (specs/003-retail-ordering research R21). Pure logic only, so it can be
// tested without a DOM: the hook in src/hooks/useOrderNotifications.ts does the toast, the tone and the badge.

// Per-register preference (a device setting, not synced): mutes the tone only — the toast and badge still show.
export const ORDER_MUTE_KEY = 'omnipos.orders.mute';

export interface MuteStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function readOrderMute(storage: Pick<MuteStorage, 'getItem'>): boolean {
  try { return storage.getItem(ORDER_MUTE_KEY) === '1'; } catch { return false; }
}

export function writeOrderMute(storage: Pick<MuteStorage, 'setItem'>, muted: boolean): boolean {
  try {
    storage.setItem(ORDER_MUTE_KEY, muted ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** What a socket event should trigger: a toast (new orders arrived) and, unless muted, the tone. */
export function orderNotification(event: unknown, canView: boolean, muted: boolean): { toast: boolean; tone: boolean; count: number } {
  const none = { toast: false, tone: false, count: 0 };
  if (!canView || !event || typeof event !== 'object') return none;
  const e = event as { type?: unknown; newSubmitted?: unknown };
  if (e.type !== 'ORDERS_UPDATED' || typeof e.newSubmitted !== 'number' || !Number.isFinite(e.newSubmitted) || e.newSubmitted <= 0) {
    return none;
  }
  return { toast: true, tone: !muted, count: e.newSubmitted };
}
