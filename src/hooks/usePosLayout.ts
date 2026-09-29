import { useCallback, useSyncExternalStore } from 'react';

// Per-register POS layout preferences (cart/catalog split, row density, tile size, catalog visibility).
// Pure UI conveniences: kept in localStorage of this terminal only. All storage access is guarded so the
// POS renders with defaults when storage is unavailable. State lives in a tiny module-level store so the
// splitter, cart, catalog and layout menu all stay in sync without a provider.

export type PosDensity = 'comfortable' | 'compact';
export type PosTileSize = 'sm' | 'md' | 'lg';

export interface PosLayout {
  cartPct: number; // width of the cart pane as % of the POS area
  density: PosDensity;
  tileSize: PosTileSize;
  hideCatalog: boolean;
}

export const POS_LAYOUT_KEY = 'omnipos.posLayout.v1';
export const CART_PCT_MIN = 40;
export const CART_PCT_MAX = 78; // keeps the catalog at >= 22%
export const CART_PCT_DEFAULT = 66;

export const DEFAULT_POS_LAYOUT: PosLayout = {
  cartPct: CART_PCT_DEFAULT,
  density: 'compact',
  tileSize: 'md',
  hideCatalog: false,
};

export const clampCartPct = (n: number) =>
  Math.min(CART_PCT_MAX, Math.max(CART_PCT_MIN, Math.round(n * 10) / 10));

function sanitize(raw: any): PosLayout {
  const d = DEFAULT_POS_LAYOUT;
  if (!raw || typeof raw !== 'object') return { ...d };
  return {
    cartPct: typeof raw.cartPct === 'number' && Number.isFinite(raw.cartPct) ? clampCartPct(raw.cartPct) : d.cartPct,
    density: raw.density === 'comfortable' || raw.density === 'compact' ? raw.density : d.density,
    tileSize: raw.tileSize === 'sm' || raw.tileSize === 'md' || raw.tileSize === 'lg' ? raw.tileSize : d.tileSize,
    hideCatalog: raw.hideCatalog === true,
  };
}

function load(): PosLayout {
  try {
    const s = localStorage.getItem(POS_LAYOUT_KEY);
    return s ? sanitize(JSON.parse(s)) : { ...DEFAULT_POS_LAYOUT };
  } catch {
    return { ...DEFAULT_POS_LAYOUT };
  }
}

let state: PosLayout = load();
const listeners = new Set<() => void>();

function persist() {
  try { localStorage.setItem(POS_LAYOUT_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function update(patch: Partial<PosLayout>, save = true) {
  const next = sanitize({ ...state, ...patch });
  if (
    next.cartPct !== state.cartPct || next.density !== state.density ||
    next.tileSize !== state.tileSize || next.hideCatalog !== state.hideCatalog
  ) {
    state = next;
    listeners.forEach((l) => l());
  }
  if (save) persist();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => state;

export function usePosLayout() {
  const layout = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  /** `save=false` while dragging; call again with the final value (or `commit`) on release. */
  const setCartPct = useCallback((pct: number, save = true) => update({ cartPct: clampCartPct(pct) }, save), []);
  const commit = useCallback(() => persist(), []);
  const setDensity = useCallback((density: PosDensity) => update({ density }), []);
  const setTileSize = useCallback((tileSize: PosTileSize) => update({ tileSize }), []);
  const setHideCatalog = useCallback((hideCatalog: boolean) => update({ hideCatalog }), []);
  const reset = useCallback(() => update({ ...DEFAULT_POS_LAYOUT }), []);

  return { layout, setCartPct, commit, setDensity, setTileSize, setHideCatalog, reset };
}
