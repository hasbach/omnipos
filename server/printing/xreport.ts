import { EscPos, paperWidthToColumns, type ArabicTextMode } from "./escpos.js";

export type ThermalLine =
  | { kind: 'center'; text: string; bold?: boolean }
  | { kind: 'section'; text: string }
  | { kind: 'kv'; label: string; value: string; bold?: boolean; indent?: boolean }
  | { kind: 'text'; text: string; bold?: boolean }
  | { kind: 'hr'; char?: string }
  | { kind: 'feed'; lines?: number };

export function buildThermalReportBuffer(opts: {
  lines: ThermalLine[];
  paperWidth?: number;
  arabic?: ArabicTextMode | null;
}): Buffer {
  const width = paperWidthToColumns(opts.paperWidth);
  const p = new EscPos(width, opts.arabic);

  p.init();
  p.feed(2);

  for (const line of opts.lines || []) {
    if (!line || typeof line !== 'object') continue;
    switch (line.kind) {
      case 'center':
        p.align('center').bold(!!line.bold).text(String(line.text ?? '')).feed(1).bold(false).align('left');
        break;
      case 'section':
        p.hr();
        p.align('center').bold(true).text(String(line.text ?? '')).feed(1).bold(false).align('left');
        break;
      case 'kv': {
        const prefix = line.indent ? '  ' : '';
        p.align('left').bold(!!line.bold).kv(prefix + String(line.label ?? ''), String(line.value ?? '')).bold(false);
        break;
      }
      case 'text':
        p.align('left').bold(!!line.bold).text(String(line.text ?? '')).feed(1).bold(false);
        break;
      case 'hr':
        p.align('left').hr(line.char || '-');
        break;
      case 'feed':
        p.feed(Math.max(1, Math.min(6, Number(line.lines) || 1)));
        break;
    }
  }

  p.feed(6).cut();
  return p.toBuffer();
}
