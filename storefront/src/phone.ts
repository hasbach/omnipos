// WhatsApp numbers in international form. Shops are in Lebanon, so a number typed without a country code is
// Lebanese: drop a leading 0 and prefix 961 (71 315 744 → 96171315744, 03 123 456 → 9613123456). Shared by the
// storefront's wa.me links and the back office, which saves the number as "+<digits>" (server/commerce.ts).

export const DEFAULT_COUNTRY_CODE = '961';

/** Digits only, country code first, no "+"/"00"; null when there is no usable number. */
export function whatsappDigits(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 ? digits : null;
  if (digits.startsWith('00')) return digits.length >= 10 ? digits.slice(2) : null;
  // Local Lebanese numbers are 7 or 8 digits once the trunk 0 is dropped (landlines 01…, mobiles 03 / 7x / 81).
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 7 || digits.length === 8) return DEFAULT_COUNTRY_CODE + digits;
  // Longer: already starts with a country code ("96170123456").
  return digits.length >= 9 ? digits : null;
}

/** "+<digits>" for storage, or null when the number isn't usable. */
export function normalizeWhatsapp(input: string | null | undefined): string | null {
  const digits = whatsappDigits(input);
  return digits ? `+${digits}` : null;
}
