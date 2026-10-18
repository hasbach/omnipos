// Contact buttons (spec 002 FR-010a / FR-011): one per contact detail the shop filled in — WhatsApp (pre-filled
// message), Call, Email. Nothing is recorded: the links open the visitor's own apps.
import { attr, html } from './escape.js';
import { t } from './i18n.js';
import type { Lang } from './router.js';
import type { PublicStore } from './data.js';

/** wa.me link with digits only (international format, no "+" or "00"); null when there is no usable number. */
export function whatsappLink(number: string | null | undefined, text: string): string | null {
  if (!number) return null;
  let digits = number.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length < 6) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function telLink(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.trim().replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return cleaned.replace(/\D/g, '').length >= 6 ? `tel:${cleaned}` : null;
}

export function mailtoLink(email: string | null | undefined, subject: string): string | null {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}

/** The button row, or '' when the shop filled in no contact detail. */
export function contactButtons(lang: Lang, store: PublicStore, msg: { whatsapp: string; subject: string }): string {
  const buttons: string[] = [];
  const wa = whatsappLink(store.contact_whatsapp, msg.whatsapp);
  if (wa) buttons.push(`<a class="sf-button sf-wa" href="${attr(wa)}" target="_blank" rel="noopener">${html(t(lang, 'contact_whatsapp'))}</a>`);
  const tel = telLink(store.contact_phone);
  if (tel) buttons.push(`<a class="sf-button sf-button-secondary" href="${attr(tel)}">${html(t(lang, 'contact_call'))}</a>`);
  const mail = mailtoLink(store.contact_email, msg.subject);
  if (mail) buttons.push(`<a class="sf-button sf-button-secondary" href="${attr(mail)}">${html(t(lang, 'contact_email'))}</a>`);
  return buttons.length ? `<div class="sf-contact">${buttons.join('\n')}</div>` : '';
}
