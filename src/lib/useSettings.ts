// Small shared hook: fetch /api/settings once (cached across mounts within the session) and expose
// the flags every page needs to check. Kept dependency-free and tiny per the page-agent brief.
import { useEffect, useState } from 'react';
import { api } from './api';

let cache: Record<string, string> | null = null;
let inflight: Promise<Record<string, string>> | null = null;
const listeners = new Set<(s: Record<string, string>) => void>();

function fetchSettings(): Promise<Record<string, string>> {
  if (!inflight) {
    inflight = api.get<Record<string, string>>('/api/settings').catch(() => ({} as Record<string, string>));
  }
  return inflight;
}

/** Called by anything that changes settings (e.g. Settings → Sales & Pricing save) to refresh every mounted useSettings() consumer. */
export function invalidateSettingsCache() {
  cache = null;
  inflight = null;
  fetchSettings().then((s) => {
    cache = s;
    listeners.forEach((fn) => fn(s));
  });
}

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>(cache || {});
  const [loaded, setLoaded] = useState(!!cache);

  useEffect(() => {
    const onUpdate = (s: Record<string, string>) => {
      setSettings(s);
      setLoaded(true);
    };
    listeners.add(onUpdate);

    if (cache) {
      onUpdate(cache);
    } else {
      fetchSettings().then((s) => {
        cache = s;
        onUpdate(s);
      });
    }

    const handleSync = (e: any) => {
      if (e.detail?.type === 'SETTINGS_UPDATED') invalidateSettingsCache();
    };
    window.addEventListener('pos-sync', handleSync);

    return () => {
      listeners.delete(onUpdate);
      window.removeEventListener('pos-sync', handleSync);
    };
  }, []);

  // Default (key missing) = enabled, per spec.
  const priceLevelsEnabled = settings.enable_price_levels !== '0';

  // Stock / price guards (defaults reproduce the old behaviour).
  const allowBelowCost = settings.allow_below_cost !== '0';
  const allowNegativeStock = settings.allow_negative_stock !== '0';
  const hideOutOfStock = settings.hide_out_of_stock === '1';

  return { settings, loaded, priceLevelsEnabled, allowBelowCost, allowNegativeStock, hideOutOfStock };
}

export default useSettings;
