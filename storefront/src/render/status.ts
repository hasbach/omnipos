// Neutral status pages. "Store unavailable" is deliberately the same for an unknown address and for a store
// that is paused / draft / wholesale / off / unlicensed: the public catalog never reveals which (spec FR-016).
import { attr, html } from '../escape.js';
import { t } from '../i18n.js';
import type { Lang } from '../router.js';

export type StatusKind = 'store_unavailable' | 'page_not_found' | 'product_unavailable' | 'temporarily_unavailable';

export function statusBody(lang: Lang, kind: StatusKind, link?: { href: string; label: string }): string {
  return `<section class="sf-status">
<h1>${html(t(lang, `${kind}_title`))}</h1>
<p>${html(t(lang, `${kind}_text`))}</p>
${link ? `<p><a class="sf-button" href="${attr(link.href)}">${html(link.label)}</a></p>` : ''}
</section>`;
}
