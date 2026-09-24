// Minimal ESC/POS command builder for thermal receipt printers.
// Covers the generic command subset supported by virtually all ESC/POS-compatible
// printers (Epson TM-T88 family and clones), which is what most receipt printers speak.

import { createRequire } from "module";

const ESC = 0x1B;
const GS = 0x1D;

// Arabic (and other RTL/joined scripts) can't go out as plain text: the printer's built-in
// fonts are single-byte code pages, Arabic code page numbers differ between printer brands, and
// even the right one prints unjoined letters left-to-right. So any line containing such text is
// drawn with a real font (letter joining + bidi handled by Skia) and sent as a raster image,
// which every ESC/POS printer prints the same way. Latin-only lines stay plain text.
const RTL_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_STRONG = /[A-Za-zÀ-ɏ]/;
const FONT_FAMILY = 'Tahoma, Arial, sans-serif';
const FONT_PX = 24;   // matches the printer's 12x24 Font A, so image lines sit in with text lines
const LINE_PX = 32;

// Loaded lazily: if the native canvas module is ever missing, receipts still print (Arabic
// just degrades to the old plain-text output) instead of the whole print failing.
let canvasModule: any;
function loadCanvas(): any {
  if (canvasModule === undefined) {
    try { canvasModule = createRequire(import.meta.url)('@napi-rs/canvas'); }
    catch (e: any) { console.error('Receipt Arabic rendering unavailable:', e?.message); canvasModule = null; }
  }
  return canvasModule;
}

export function needsRaster(str: string): boolean {
  return RTL_SCRIPT.test(str);
}

// Like HTML dir="auto": the first strong character decides the base direction.
function baseDirection(str: string): 'rtl' | 'ltr' {
  for (const ch of str) {
    if (RTL_SCRIPT.test(ch)) return 'rtl';
    if (LTR_STRONG.test(ch)) return 'ltr';
  }
  return 'ltr';
}

type Align = 'left' | 'center' | 'right';
type Segment = { text: string; align: Align };
type Positioned = Segment & { x: number };

export class EscPos {
  private chunks: Buffer[] = [];
  private alignment: Align = 'left';
  private isBold = false;
  // A raster line already advances the paper past itself, so the `.feed(1)` every caller
  // chains after a line must not add a second, blank line.
  private swallowNewline = false;

  // width = printable characters per line, e.g. 32 for 58mm paper, 48 for 80mm.
  constructor(private width: number = 48) {}

  private push(bytes: number[] | Buffer): this {
    this.chunks.push(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    return this;
  }

  init(): this {
    return this.push([ESC, 0x40]);
  }

  bold(on: boolean): this {
    this.isBold = on;
    return this.push([ESC, 0x45, on ? 1 : 0]);
  }

  underline(on: boolean): this {
    return this.push([ESC, 0x2D, on ? 1 : 0]);
  }

  align(mode: Align): this {
    this.alignment = mode;
    const n = mode === 'center' ? 1 : mode === 'right' ? 2 : 0;
    return this.push([ESC, 0x61, n]);
  }

  // w/h are extra magnification steps (0 = normal size, 1 = double, ...).
  size(w: number, h: number): this {
    const clamped = (n: number) => Math.max(0, Math.min(7, n));
    const n = (clamped(w) << 4) | clamped(h);
    return this.push([GS, 0x21, n]);
  }

  text(str: string): this {
    if (needsRaster(str) && this.rasterLines([{ text: str, align: this.alignment }], true)) return this;
    this.swallowNewline = false;
    return this.push(Buffer.from(str, 'latin1'));
  }

  feed(lines = 1): this {
    let n = Math.max(1, lines);
    if (this.swallowNewline) { this.swallowNewline = false; n -= 1; }
    return n > 0 ? this.push(Buffer.from('\n'.repeat(n), 'latin1')) : this;
  }

  hr(char = '-'): this {
    return this.text(char.repeat(this.width)).feed(1);
  }

  // Left-justified label, right-justified value, padded to fill the line width.
  kv(label: string, value: string): this {
    if (needsRaster(label + value) && this.rasterLines([{ text: label, align: 'left' }, { text: value, align: 'right' }], false)) {
      return this.feed(1);
    }
    const space = Math.max(1, this.width - label.length - value.length);
    return this.text(label + ' '.repeat(space) + value).feed(1);
  }

  // "Label: value" line. An Arabic value is laid out in its own RTL block — label flush left,
  // value flowing in from the right edge and wrapping under itself — rather than as one mixed
  // LTR line, where the bidi algorithm pushes punctuation at a line break to the wrong end.
  labeled(label: string, value: string): this {
    if (!needsRaster(value)) return this.text(`${label} ${value}`).feed(1);
    const width = this.measurer();
    if (!width) return this.text(`${label} ${value}`).feed(1);
    const rtl = baseDirection(value) === 'rtl';
    const indent = width(`${label} `);
    const lines = wrapText(value, this.dotsWide - indent, width);
    const rows: Positioned[][] = lines.map((text, i) => {
      const valueSeg: Positioned = rtl
        ? { text, align: 'right', x: this.dotsWide }
        : { text, align: 'left', x: indent };
      return i === 0 ? [{ text: label, align: 'left', x: 0 }, valueSeg] : [valueSeg];
    });
    if (this.drawRows(rows)) return this.feed(1);
    return this.text(`${label} ${value}`).feed(1);
  }

  // Product/service name on the left, "qty x total" right-aligned; long names truncate.
  itemLine(name: string, qty: number, total: string): this {
    const rightPart = `${String(qty).padStart(3)} x ${total.padStart(8)}`;
    if (needsRaster(name)) {
      // The "qty x total" keeps its usual columns; the name gets the rest of the line (in dots).
      const fitted = this.fitToDots(name, (this.width - rightPart.length - 1) * 12);
      if (fitted !== null && this.rasterLines([{ text: fitted, align: 'left' }, { text: rightPart.trimStart(), align: 'right' }], false)) {
        return this.feed(1);
      }
    }
    const nameWidth = Math.max(4, this.width - rightPart.length - 1);
    const truncated = name.length > nameWidth ? name.slice(0, Math.max(1, nameWidth - 3)) + '...' : name.padEnd(nameWidth);
    return this.text(`${truncated} ${rightPart}`).feed(1);
  }

  cut(partial = true): this {
    return this.push([GS, 0x56, partial ? 1 : 0]);
  }

  // Generic cash-drawer kick pulse (ESC p m t1 t2). pin 0 = drawer 1 (most common wiring).
  openDrawer(pin: 0 | 1 = 0): this {
    return this.push([ESC, 0x70, pin, 25, 250]);
  }

  raw(bytes: Buffer): this {
    return this.push(bytes);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  // 12-dot-wide Font A columns: 48 cols = 576 dots (80mm), 32 cols = 384 dots (58mm).
  private get dotsWide(): number {
    return this.width * 12;
  }

  private get font(): string {
    return `${this.isBold ? 'bold ' : ''}${FONT_PX}px ${FONT_FAMILY}`;
  }

  private measurer(): ((t: string) => number) | null {
    const canvas = loadCanvas();
    if (!canvas) return null;
    const ctx = canvas.createCanvas(1, 1).getContext('2d');
    ctx.font = this.font;
    return (t: string) => ctx.measureText(t).width;
  }

  // Truncates `text` (with an ellipsis) until it renders within `maxDots`; null if no canvas.
  private fitToDots(text: string, maxDots: number): string | null {
    const width = this.measurer();
    if (!width) return null;
    if (width(text) <= maxDots) return text;
    let cut = text.length - 1;
    while (cut > 1 && width(text.slice(0, cut) + '…') > maxDots) cut--;
    return text.slice(0, cut) + '…';
  }

  // Draws one printed line (segments share it: e.g. a name on the left, a price on the right)
  // and sends it as a GS v 0 raster image. With `wrap`, a single segment too long for the paper
  // is word-wrapped over several lines. Returns false if canvas isn't available.
  private rasterLines(segments: Segment[], wrap: boolean): boolean {
    const width = this.measurer();
    if (!width) return false;
    const widthPx = this.dotsWide;
    const place = (s: Segment): Positioned => ({ ...s, x: s.align === 'left' ? 0 : s.align === 'right' ? widthPx : widthPx / 2 });
    const rows: Positioned[][] = wrap && segments.length === 1
      ? wrapText(segments[0].text, widthPx, width).map(t => [place({ ...segments[0], text: t })])
      : [segments.map(place)];
    return this.drawRows(rows);
  }

  private drawRows(rows: Positioned[][]): boolean {
    const canvas = loadCanvas();
    if (!canvas) return false;
    const widthPx = this.dotsWide;
    const c = canvas.createCanvas(widthPx, LINE_PX * rows.length);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000';
    ctx.font = this.font;
    ctx.textBaseline = 'middle';
    rows.forEach((row, i) => {
      for (const seg of row) {
        ctx.direction = baseDirection(seg.text);
        ctx.textAlign = seg.align;
        ctx.fillText(seg.text, seg.x, LINE_PX * i + LINE_PX / 2);
      }
    });

    // Anti-aliased canvas -> 1 bit per dot (MSB first); dark enough = printed.
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const bytesPerRow = widthPx / 8;
    const bits = Buffer.alloc(bytesPerRow * c.height);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < widthPx; x++) {
        const o = (y * widthPx + x) * 4;
        if ((data[o] + data[o + 1] + data[o + 2]) / 3 < 140) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    // The image spans the full paper width with the text already placed inside it.
    this.push([ESC, 0x61, 0]);
    this.push([GS, 0x76, 0x30, 0, bytesPerRow & 0xFF, bytesPerRow >> 8, c.height & 0xFF, c.height >> 8]);
    this.push(bits);
    this.align(this.alignment);
    this.swallowNewline = true;
    return true;
  }
}

// Greedy word wrap by rendered width; a single word wider than the line is hard-broken.
function wrapText(text: string, maxPx: number, width: (t: string) => number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= maxPx) { line = candidate; continue; }
    if (line) out.push(line);
    line = word;
    while (width(line) > maxPx && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && width(line.slice(0, cut)) > maxPx) cut--;
      out.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line || out.length === 0) out.push(line);
  return out;
}

export function paperWidthToColumns(paperWidthMm?: number): number {
  return paperWidthMm === 58 ? 32 : 48;
}
