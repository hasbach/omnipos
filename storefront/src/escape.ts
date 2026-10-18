// HTML escaping for the storefront. Every value that comes from a store (names, descriptions, categories,
// contact details) goes through html() or attr() before it is written into a page.

const MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Text content. */
export function html(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => MAP[c]);
}

/** Attribute value (same escaping; kept separate so call sites say what they mean). */
export const attr = html;

/** Builds a URL path + query; empty / null params are dropped. Returns an unescaped string — wrap in attr(). */
export function url(path: string, params: Record<string, string | number | null | undefined> = {}): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}
