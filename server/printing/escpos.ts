// Minimal ESC/POS command builder for thermal receipt printers.
// Covers the generic command subset supported by virtually all ESC/POS-compatible
// printers (Epson TM-T88 family and clones), which is what most receipt printers speak.

const ESC = 0x1B;
const GS = 0x1D;

export class EscPos {
  private chunks: Buffer[] = [];

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
    return this.push([ESC, 0x45, on ? 1 : 0]);
  }

  underline(on: boolean): this {
    return this.push([ESC, 0x2D, on ? 1 : 0]);
  }

  align(mode: 'left' | 'center' | 'right'): this {
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
    return this.push(Buffer.from(str, 'latin1'));
  }

  feed(lines = 1): this {
    return this.push(Buffer.from('\n'.repeat(Math.max(1, lines)), 'latin1'));
  }

  hr(char = '-'): this {
    return this.text(char.repeat(this.width)).feed(1);
  }

  // Left-justified label, right-justified value, padded to fill the line width.
  kv(label: string, value: string): this {
    const space = Math.max(1, this.width - label.length - value.length);
    return this.text(label + ' '.repeat(space) + value).feed(1);
  }

  // Product/service name on the left, "qty x total" right-aligned; long names truncate.
  itemLine(name: string, qty: number, total: string): this {
    const rightPart = `${String(qty).padStart(3)} x ${total.padStart(8)}`;
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
}

export function paperWidthToColumns(paperWidthMm?: number): number {
  return paperWidthMm === 58 ? 32 : 48;
}
