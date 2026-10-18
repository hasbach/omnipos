// <title>, description and link-preview tags (spec 002 FR-012). WhatsApp, Facebook and others read these from
// the HTML without running JavaScript; image and canonical URLs are absolute, canonical always in host form.
import { attr, html } from './escape.js';
import type { Lang } from './router.js';

export interface PageMeta {
  title: string;
  description?: string | null;
  /** Absolute image URL for link previews. */
  image?: string | null;
  canonical?: string | null;
}

const OG_LOCALE: Record<Lang, string> = { en: 'en_US', ar: 'ar_LB', fr: 'fr_FR' };

/** Plain-text summary for meta descriptions: whitespace collapsed, cut at ~160 characters. */
export function summary(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export function metaTags(meta: PageMeta, lang: Lang): string {
  return [
    `<title>${html(meta.title)}</title>`,
    meta.description ? `<meta name="description" content="${attr(meta.description)}">` : '',
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${attr(meta.title)}">`,
    meta.description ? `<meta property="og:description" content="${attr(meta.description)}">` : '',
    meta.image ? `<meta property="og:image" content="${attr(meta.image)}">` : '',
    meta.canonical ? `<meta property="og:url" content="${attr(meta.canonical)}">` : '',
    meta.canonical ? `<link rel="canonical" href="${attr(meta.canonical)}">` : '',
    `<meta property="og:locale" content="${OG_LOCALE[lang]}">`,
    `<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`,
  ].filter(Boolean).join('\n');
}
