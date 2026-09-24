// Arabic as printer-native text, for printers with a built-in Arabic code page (e.g. Xprinter).
// The printer only maps bytes to glyphs: it neither joins letters nor lays text out right to
// left. So this module does both, the way the text would appear on screen:
//   1. shape  - pick each letter's isolated / final / initial / medial presentation form
//               (plus the lam-alef ligatures), from its neighbours in logical order;
//   2. reorder - a compact version of the Unicode bidi algorithm, producing the left-to-right
//               visual order the print head needs (numbers and Latin words keep their order);
//   3. encode  - map the result to the code page's bytes (iconv-lite).
// Anything the code page can't hold returns null, and the caller prints that line as an image.
import iconv from "iconv-lite";

export type ArabicEncoding = 'cp864' | 'cp1256';

// [isolated, final, initial, medial]; 0 = the letter has no such form (right-joining letters
// never connect to the letter after them, so they have no initial/medial forms).
const FORMS: Record<number, [number, number, number, number]> = {
  0x0621: [0xFE80, 0, 0, 0],
  0x0622: [0xFE81, 0xFE82, 0, 0],
  0x0623: [0xFE83, 0xFE84, 0, 0],
  0x0624: [0xFE85, 0xFE86, 0, 0],
  0x0625: [0xFE87, 0xFE88, 0, 0],
  0x0626: [0xFE89, 0xFE8A, 0xFE8B, 0xFE8C],
  0x0627: [0xFE8D, 0xFE8E, 0, 0],
  0x0628: [0xFE8F, 0xFE90, 0xFE91, 0xFE92],
  0x0629: [0xFE93, 0xFE94, 0, 0],
  0x062A: [0xFE95, 0xFE96, 0xFE97, 0xFE98],
  0x062B: [0xFE99, 0xFE9A, 0xFE9B, 0xFE9C],
  0x062C: [0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0],
  0x062D: [0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4],
  0x062E: [0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8],
  0x062F: [0xFEA9, 0xFEAA, 0, 0],
  0x0630: [0xFEAB, 0xFEAC, 0, 0],
  0x0631: [0xFEAD, 0xFEAE, 0, 0],
  0x0632: [0xFEAF, 0xFEB0, 0, 0],
  0x0633: [0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4],
  0x0634: [0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8],
  0x0635: [0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC],
  0x0636: [0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0],
  0x0637: [0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4],
  0x0638: [0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8],
  0x0639: [0xFEC9, 0xFECA, 0xFECB, 0xFECC],
  0x063A: [0xFECD, 0xFECE, 0xFECF, 0xFED0],
  0x0641: [0xFED1, 0xFED2, 0xFED3, 0xFED4],
  0x0642: [0xFED5, 0xFED6, 0xFED7, 0xFED8],
  0x0643: [0xFED9, 0xFEDA, 0xFEDB, 0xFEDC],
  0x0644: [0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0],
  0x0645: [0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4],
  0x0646: [0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8],
  0x0647: [0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC],
  0x0648: [0xFEED, 0xFEEE, 0, 0],
  0x0649: [0xFEEF, 0xFEF0, 0, 0],
  0x064A: [0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4],
};

// Lam + alef variant -> [isolated, final] ligature.
const LAM_ALEF: Record<number, [number, number]> = {
  0x0622: [0xFEF5, 0xFEF6],
  0x0623: [0xFEF7, 0xFEF8],
  0x0625: [0xFEF9, 0xFEFA],
  0x0627: [0xFEFB, 0xFEFC],
};

const TATWEEL = 0x0640;
const HARAKAT = /[ً-ْٰ]/g; // vowel marks: optional in writing, absent from CP864

const joinsBefore = (cp: number) => cp === TATWEEL || (FORMS[cp] !== undefined && FORMS[cp][2] !== 0);
const joinsAfter = (cp: number) => cp === TATWEEL || FORMS[cp] !== undefined;

// Logical-order Arabic -> presentation forms (still logical order).
export function shape(text: string): string {
  const cps = [...text.replace(HARAKAT, '')].map(c => c.codePointAt(0)!);
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    const forms = FORMS[cp];
    if (!forms) { out.push(cp); continue; }
    const prev = i > 0 ? cps[i - 1] : 0;
    const joinPrev = joinsBefore(prev);

    if (cp === 0x0644 && LAM_ALEF[cps[i + 1]]) {
      out.push(LAM_ALEF[cps[i + 1]][joinPrev ? 1 : 0]);
      i++;
      continue;
    }

    const joinNext = forms[2] !== 0 && i + 1 < cps.length && joinsAfter(cps[i + 1]);
    const form = joinPrev ? (joinNext ? forms[3] : forms[1]) : (joinNext ? forms[2] : forms[0]);
    out.push(form || forms[0]);
  }
  return String.fromCodePoint(...out);
}

// ---- Bidi (reduced UBA: strong types, numbers, neutrals, levels, L2 reversal, mirroring) ----

type BidiClass = 'L' | 'R' | 'EN' | 'AN' | 'N';
const isArabicLetter = (cp: number) => (cp >= 0x0600 && cp <= 0x06FF && !(cp >= 0x0660 && cp <= 0x0669))
  || (cp >= 0x0750 && cp <= 0x08FF) || (cp >= 0xFB50 && cp <= 0xFDFF) || (cp >= 0xFE70 && cp <= 0xFEFF)
  || (cp >= 0x0590 && cp <= 0x05FF);

function classify(cp: number): BidiClass {
  if (cp >= 0x0660 && cp <= 0x0669) return 'AN';
  if (isArabicLetter(cp)) return 'R';
  if (cp >= 0x30 && cp <= 0x39) return 'EN';
  if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A) || (cp >= 0xC0 && cp <= 0x24F)) return 'L';
  return 'N';
}

const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<' };

export function baseIsRtl(text: string): boolean {
  for (const ch of text) {
    const c = classify(ch.codePointAt(0)!);
    if (c === 'R') return true;
    if (c === 'L') return false;
  }
  return false;
}

// Logical -> visual order for one printed line.
export function toVisual(text: string, rtlBase = baseIsRtl(text)): string {
  const chars = [...text];
  const types = chars.map(c => classify(c.codePointAt(0)!));
  const base = rtlBase ? 1 : 0;

  // W2/W7: European digits take the type of the last strong text before them — Arabic numbers
  // after Arabic, plain left-to-right text after Latin.
  let lastStrong: BidiClass = rtlBase ? 'R' : 'L';
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'L' || types[i] === 'R') lastStrong = types[i];
    else if (types[i] === 'EN') types[i] = lastStrong === 'R' ? 'AN' : 'L';
  }
  // Separators inside a number ("1,250.00", "12:30") stay with it.
  for (let i = 1; i < types.length - 1; i++) {
    if (types[i] === 'N' && /[.,:\/]/.test(chars[i]) && types[i - 1] === types[i + 1] && (types[i - 1] === 'EN' || types[i - 1] === 'AN')) {
      types[i] = types[i - 1];
    }
  }
  // N1/N2: neutrals take the direction of matching neighbours (numbers count as R), else base.
  const dirOf = (t: BidiClass) => (t === 'L' ? 'L' : t === 'N' ? null : 'R');
  for (let i = 0; i < types.length; i++) {
    if (types[i] !== 'N') continue;
    let j = i;
    while (j < types.length && types[j] === 'N') j++;
    const before = i > 0 ? dirOf(types[i - 1]) : (rtlBase ? 'R' : 'L');
    const after = j < types.length ? dirOf(types[j]) : (rtlBase ? 'R' : 'L');
    const resolved: BidiClass = before === after ? (before as BidiClass) : (rtlBase ? 'R' : 'L');
    for (let k = i; k < j; k++) types[k] = resolved;
    i = j - 1;
  }
  // I1/I2: embedding levels.
  const levels = types.map(t => {
    if (base === 0) return t === 'R' ? 1 : t === 'AN' ? 2 : t === 'EN' ? 0 : 0;
    return t === 'R' ? 1 : 2; // L, EN, AN on an RTL line
  });
  // L2: reverse every run at or above each level, from the highest down to the lowest odd.
  const order = chars.map((_, i) => i);
  const maxLevel = Math.max(0, ...levels);
  for (let lvl = maxLevel; lvl >= 1; lvl--) {
    for (let i = 0; i < order.length; i++) {
      if (levels[order[i]] < lvl) continue;
      let j = i;
      while (j < order.length && levels[order[j]] >= lvl) j++;
      order.splice(i, j - i, ...order.slice(i, j).reverse());
      i = j - 1;
    }
  }
  return order.map(i => (levels[i] % 2 === 1 && MIRROR[chars[i]]) ? MIRROR[chars[i]] : chars[i]).join('');
}

// ---- Encoding ----

// CP864 has only some of the four forms for many letters (often one glyph serves as both
// isolated and final, another as both initial and medial). Substitute the closest form it has.
const cp864Chars = new Set([...iconv.decode(Buffer.from([...Array(256).keys()]), 'cp864')]);
const FORM_FALLBACK: Record<number, number[]> = {};
for (const forms of Object.values(FORMS)) {
  const [iso, fin, ini, med] = forms;
  const chains: [number, number[]][] = [[iso, [fin, ini, med]], [fin, [iso, med, ini]], [ini, [med, iso, fin]], [med, [ini, fin, iso]]];
  for (const [form, alts] of chains) if (form) FORM_FALLBACK[form] = alts.filter(Boolean);
}
for (const [iso, fin] of Object.values(LAM_ALEF)) { FORM_FALLBACK[iso] = [fin]; FORM_FALLBACK[fin] = [iso]; }

function toCp864Glyphs(visual: string): string {
  return [...visual].map(ch => {
    if (cp864Chars.has(ch)) return ch;
    const alt = FORM_FALLBACK[ch.codePointAt(0)!]?.map(cp => String.fromCodePoint(cp)).find(c => cp864Chars.has(c));
    return alt ?? ch;
  }).join('');
}

// Printed columns a logical string takes (after shaping, a lam-alef pair is one column).
export function printedLength(text: string, encoding: ArabicEncoding): number {
  return encoding === 'cp864' ? [...shape(text)].length : [...text.replace(HARAKAT, '')].length;
}

// Logical text -> printer bytes in visual order, or null if the code page can't hold it all.
export function encodeArabicLine(text: string, encoding: ArabicEncoding, rtlBase?: boolean): Buffer | null {
  let visual: string;
  if (encoding === 'cp864') {
    visual = toCp864Glyphs(toVisual(shape(text), rtlBase ?? baseIsRtl(text)));
  } else {
    // Windows-1256 holds base letters only; printers with this table pick glyph shapes themselves.
    visual = toVisual(text.replace(HARAKAT, ''), rtlBase ?? baseIsRtl(text));
  }
  const bytes = iconv.encode(visual, encoding);
  return iconv.decode(bytes, encoding) === visual ? bytes : null;
}
