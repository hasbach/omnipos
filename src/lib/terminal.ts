const KEY = 'omnipos.terminalId';

/**
 * Terminal identity. Electron injects ?terminalId=... at launch, but the query string is lost on
 * in-app navigation, so the value is remembered in sessionStorage.
 */
export function getTerminalId(): string {
  let fromUrl: string | null = null;
  try { fromUrl = new URLSearchParams(window.location.search).get('terminalId'); } catch { /* ignore */ }
  if (fromUrl) {
    try { sessionStorage.setItem(KEY, fromUrl); } catch { /* ignore */ }
    return fromUrl;
  }
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved) return saved;
  } catch { /* ignore */ }
  return 'MAIN';
}
