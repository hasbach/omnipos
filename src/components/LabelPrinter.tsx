import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Printer, CheckSquare, Square, Tag, RefreshCw, Eye
} from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

interface Product {
  id: number;
  name: string;
  barcode?: string;
  price: number;
  price_lbp?: number;
  unit?: string;
  category?: string;
}

interface LabelField {
  key: keyof Product | 'price_lbp';
  label: string;
  enabled: boolean;
}

interface LabelSize {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
}

interface Props {
  products: Product[];            // All products (to let user pick)
  preSelected?: number[];         // IDs that arrive pre-checked
  onClose: () => void;
}

// ── Barcode SVG renderer (Code 39 — no library needed) ───────────────────────
// Code 39 encodes each char as 9 bars (5 bars, 4 spaces): narrow/wide pattern.
const CODE39_PATTERNS: Record<string, string> = {
  '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
  '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
  'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
  'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
  'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
  'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
  'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
  'Z':'nwwnwnnnn','-':'nwnnnnwnw',' ':'nwnnwnwnn','*':'nwnnwnwnn',
  '$':'nwnwnwnnn','/':'nwnnnwnwn','+':'nnnwnwnwn','%':'nwnwnnnwn',
};

function renderCode39(text: string): JSX.Element {
  const N = 1.5; // narrow bar width (px)
  const W = 3.5; // wide bar width (px)
  const H = 36;  // bar height (px)
  const QUIET = 6;

  const chars = ('*' + text.toUpperCase().replace(/[^0-9A-Z\-\s\$\/\+%]/g, '') + '*').split('');
  const bars: { x: number; w: number; isBar: boolean }[] = [];
  let x = QUIET;

  chars.forEach((ch, ci) => {
    const pat = CODE39_PATTERNS[ch] || CODE39_PATTERNS['*'];
    pat.split('').forEach((t, i) => {
      const w = t === 'w' ? W : N;
      bars.push({ x, w, isBar: i % 2 === 0 }); // even indices are bars
      x += w;
    });
    if (ci < chars.length - 1) { x += N; } // inter-char gap
  });

  const totalW = x + QUIET;
  return (
    <svg width={totalW} height={H + 14} viewBox={`0 0 ${totalW} ${H + 14}`} xmlns="http://www.w3.org/2000/svg">
      {bars.filter(b => b.isBar).map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={H} fill="#000" />
      ))}
      <text x={totalW / 2} y={H + 11} textAnchor="middle" fontFamily="monospace" fontSize="8" fill="#000">
        {text.toUpperCase()}
      </text>
    </svg>
  );
}

// ── Label preview component ───────────────────────────────────────────────────

function LabelPreview({ product, fields, size, showBarcode }: {
  product: Product;
  fields: LabelField[];
  size: LabelSize;
  showBarcode: boolean;
}) {
  const PX_PER_MM = 3.78;
  const w = size.widthMm * PX_PER_MM;
  const h = size.heightMm * PX_PER_MM;

  return (
    <div
      style={{ width: w, height: h, minHeight: h }}
      className="bg-white border border-gray-300 rounded flex flex-col items-center justify-center px-2 py-1.5 overflow-hidden shadow-md text-black"
    >
      {fields.find(f => f.key === 'name' && f.enabled) && (
        <p className="font-black text-center leading-tight truncate w-full text-center"
           style={{ fontSize: Math.min(9, size.heightMm / 4) + 'px' }}>
          {product.name}
        </p>
      )}
      {showBarcode && product.barcode && (
        <div className="flex-shrink-0 flex items-center justify-center w-full overflow-hidden" style={{ maxHeight: h * 0.45 }}>
          <div style={{ transform: `scale(${Math.min(1, (w - 8) / 120)})`, transformOrigin: 'center center' }}>
            {renderCode39(product.barcode)}
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap justify-center">
        {fields.find(f => f.key === 'price' && f.enabled) && (
          <span className="font-black" style={{ fontSize: Math.min(10, size.heightMm / 3.5) + 'px' }}>
            ${product.price.toFixed(2)}
          </span>
        )}
        {fields.find(f => f.key === 'price_lbp' && f.enabled) && product.price_lbp && (
          <span className="font-mono text-emerald-700" style={{ fontSize: Math.min(8, size.heightMm / 4.5) + 'px' }}>
            {product.price_lbp.toLocaleString()} LL
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-wrap justify-center">
        {fields.find(f => f.key === 'unit' && f.enabled) && product.unit && (
          <span className="text-gray-500 uppercase" style={{ fontSize: Math.min(7, size.heightMm / 5) + 'px' }}>
            {product.unit}
          </span>
        )}
        {fields.find(f => f.key === 'category' && f.enabled) && product.category && (
          <span className="text-gray-500 uppercase" style={{ fontSize: Math.min(7, size.heightMm / 5) + 'px' }}>
            · {product.category}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Print CSS generator ───────────────────────────────────────────────────────

function buildPrintHtml(
  selectedProducts: Product[],
  fields: LabelField[],
  showBarcode: boolean,
  size: LabelSize,
  copies: number
): string {
  const labelItems: string[] = [];

  selectedProducts.forEach(product => {
    for (let c = 0; c < copies; c++) {
      const nameHtml = fields.find(f => f.key === 'name' && f.enabled)
        ? `<div class="label-name">${product.name}</div>` : '';

      let barcodeHtml = '';
      if (showBarcode && product.barcode) {
        // inline SVG for print
        const N = 1.5, W = 3.5, H = 32, QUIET = 6;
        const chars = ('*' + product.barcode.toUpperCase().replace(/[^0-9A-Z\-\s\$\/\+%]/g, '') + '*').split('');
        let bars: { x: number; w: number; isBar: boolean }[] = [];
        let x = QUIET;
        chars.forEach((ch, ci) => {
          const pat = CODE39_PATTERNS[ch] || CODE39_PATTERNS['*'];
          pat.split('').forEach((t, i) => {
            const bw = t === 'w' ? W : N;
            bars.push({ x, w: bw, isBar: i % 2 === 0 });
            x += bw;
          });
          if (ci < chars.length - 1) x += N;
        });
        const totalW = x + QUIET;
        const rectsSvg = bars.filter(b => b.isBar).map(b =>
          `<rect x="${b.x}" y="0" width="${b.w}" height="${H}" fill="#000"/>`
        ).join('');
        barcodeHtml = `
          <div class="label-barcode">
            <svg width="${totalW}" height="${H + 14}" viewBox="0 0 ${totalW} ${H + 14}" xmlns="http://www.w3.org/2000/svg">
              ${rectsSvg}
              <text x="${totalW / 2}" y="${H + 11}" text-anchor="middle" font-family="monospace" font-size="8" fill="#000">${product.barcode}</text>
            </svg>
          </div>`;
      }

      const priceHtml = (fields.find(f => f.key === 'price' && f.enabled) || fields.find(f => f.key === 'price_lbp' && f.enabled))
        ? `<div class="label-prices">
            ${fields.find(f => f.key === 'price' && f.enabled) ? `<span class="price-usd">$${product.price.toFixed(2)}</span>` : ''}
            ${fields.find(f => f.key === 'price_lbp' && f.enabled) && product.price_lbp ? `<span class="price-lbp">${product.price_lbp.toLocaleString()} LL</span>` : ''}
           </div>` : '';

      const metaHtml = (fields.find(f => f.key === 'unit' && f.enabled) || fields.find(f => f.key === 'category' && f.enabled))
        ? `<div class="label-meta">
            ${fields.find(f => f.key === 'unit' && f.enabled) && product.unit ? `<span>${product.unit}</span>` : ''}
            ${fields.find(f => f.key === 'category' && f.enabled) && product.category ? `<span>· ${product.category}</span>` : ''}
           </div>` : '';

      labelItems.push(`<div class="label">${nameHtml}${barcodeHtml}${priceHtml}${metaHtml}</div>`);
    }
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Product Labels</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { margin: 5mm; }
  body { font-family: Arial, sans-serif; background: white; }
  .labels-grid {
    display: flex; flex-wrap: wrap; gap: 2mm;
  }
  .label {
    width: ${size.widthMm}mm;
    height: ${size.heightMm}mm;
    border: 0.5pt solid #ccc;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    padding: 1.5mm; overflow: hidden;
    page-break-inside: avoid;
  }
  .label-name { font-weight: 900; font-size: ${Math.max(5, size.heightMm / 4.5)}pt; text-align: center; line-height: 1.1; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .label-barcode { display: flex; justify-content: center; align-items: center; max-width: 100%; overflow: hidden; }
  .label-barcode svg { max-width: ${size.widthMm - 3}mm; height: auto; }
  .label-prices { display: flex; gap: 2mm; align-items: center; flex-wrap: wrap; justify-content: center; }
  .price-usd { font-weight: 900; font-size: ${Math.max(6, size.heightMm / 3.5)}pt; }
  .price-lbp { font-size: ${Math.max(5, size.heightMm / 4.5)}pt; color: #15803d; font-family: monospace; }
  .label-meta { display: flex; gap: 1.5mm; font-size: ${Math.max(4, size.heightMm / 5.5)}pt; color: #666; text-transform: uppercase; flex-wrap: wrap; justify-content: center; }
</style>
</head>
<body>
<div class="labels-grid">
${labelItems.join('\n')}
</div>
</body>
</html>`;
}

// ── Main Component ────────────────────────────────────────────────────────────

const LABEL_SIZES: LabelSize[] = [
  { id: 's', label: '38 × 25 mm', widthMm: 38, heightMm: 25 },
  { id: 'm', label: '50 × 30 mm', widthMm: 50, heightMm: 30 },
  { id: 'l', label: '70 × 40 mm', widthMm: 70, heightMm: 40 },
  { id: 'xl', label: '90 × 50 mm', widthMm: 90, heightMm: 50 },
];

const DEFAULT_FIELDS: LabelField[] = [
  { key: 'name',      label: 'Product Name', enabled: true  },
  { key: 'price',     label: 'Price (USD)',   enabled: true  },
  { key: 'price_lbp', label: 'Price (LBP)',   enabled: false },
  { key: 'unit',      label: 'Unit',          enabled: true  },
  { key: 'category',  label: 'Category',      enabled: false },
];

export default function LabelPrinter({ products, preSelected = [], onClose }: Props) {
  const [fields, setFields] = useState<LabelField[]>(DEFAULT_FIELDS);
  const [showBarcode, setShowBarcode] = useState(true);
  const [sizeId, setSizeId] = useState<string>('m');
  const [copies, setCopies] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set(preSelected));
  const [search, setSearch] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);

  const size = LABEL_SIZES.find(s => s.id === sizeId) || LABEL_SIZES[1];
  const filtered = products.filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    (p.barcode || '').includes(search)
  );
  const selectedProducts = products.filter(p => selected.has(p.id));
  const previewProduct = selectedProducts[0] || products[0];

  const toggleField = (key: string) => {
    setFields(prev => prev.map(f => f.key === key ? { ...f, enabled: !f.enabled } : f));
  };

  const toggleProduct = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(filtered.map(p => p.id)));
  const clearAll = () => setSelected(new Set());

  const handlePrint = () => {
    if (selectedProducts.length === 0) return;
    setIsPrinting(true);
    const html = buildPrintHtml(selectedProducts, fields, showBarcode, size, copies);
    const win = window.open('', '_blank', 'width=900,height=700');
    if (!win) { setIsPrinting(false); return; }
    win.document.write(html);
    win.document.close();
    win.onload = () => {
      win.focus();
      win.print();
      setIsPrinting(false);
    };
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
      />
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 20 }}
        className="relative bg-app-surface w-full max-w-5xl rounded-3xl shadow-2xl border border-app-border overflow-hidden flex flex-col"
        style={{ maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-app-border flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-app-ink text-app-bg rounded-xl"><Tag size={18} /></div>
            <div>
              <h2 className="text-xl font-black uppercase tracking-tighter">Print Product Labels</h2>
              <p className="text-[10px] opacity-40 font-bold uppercase">
                {selected.size} product{selected.size !== 1 ? 's' : ''} selected · {selected.size * copies} label{selected.size * copies !== 1 ? 's' : ''} total
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-app-bg rounded-xl transition-colors"><X size={20} /></button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* LEFT — Product list */}
          <div className="w-72 flex-shrink-0 border-r border-app-border flex flex-col">
            <div className="p-4 border-b border-app-border space-y-2 flex-shrink-0">
              <div className="flex gap-2">
                <button onClick={selectAll} className="flex-1 py-1.5 text-[10px] font-black uppercase bg-app-ink text-app-bg rounded-lg hover:opacity-90 transition-all">All</button>
                <button onClick={clearAll} className="flex-1 py-1.5 text-[10px] font-black uppercase border border-app-border rounded-lg hover:bg-app-bg transition-all">Clear</button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search products..."
                  className="w-full pl-3 pr-3 py-2 bg-app-bg border border-app-border rounded-xl text-xs outline-none"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {filtered.map(p => (
                <button
                  key={p.id}
                  onClick={() => toggleProduct(p.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left border-b border-app-border/30 hover:bg-app-bg/50 transition-colors ${selected.has(p.id) ? 'bg-emerald-500/5' : ''}`}
                >
                  <div className={`w-4 h-4 rounded flex-shrink-0 border-2 flex items-center justify-center transition-all ${selected.has(p.id) ? 'bg-emerald-500 border-emerald-500' : 'border-app-border'}`}>
                    {selected.has(p.id) && <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold truncate">{p.name}</p>
                    <p className="text-[9px] font-mono opacity-40 truncate">{p.barcode || '—'}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* RIGHT — Config + Preview */}
          <div className="flex-1 flex flex-col overflow-y-auto">
            <div className="flex-1 p-6 space-y-6">

              {/* Label Size */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase opacity-50 tracking-widest">Label Size</label>
                <div className="grid grid-cols-4 gap-2">
                  {LABEL_SIZES.map(s => (
                    <button
                      key={s.id}
                      onClick={() => setSizeId(s.id)}
                      className={`py-2.5 px-3 rounded-xl border-2 text-[10px] font-black uppercase transition-all ${
                        sizeId === s.id ? 'border-app-ink bg-app-ink text-app-bg' : 'border-app-border hover:border-app-ink/40'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Fields */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase opacity-50 tracking-widest">Fields to Display</label>
                <div className="grid grid-cols-2 gap-2">
                  {/* Barcode toggle separately */}
                  <button
                    onClick={() => setShowBarcode(v => !v)}
                    className={`flex items-center gap-2 p-3 rounded-xl border-2 text-left transition-all ${
                      showBarcode ? 'border-app-ink bg-app-ink/5' : 'border-app-border/30 opacity-50'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${showBarcode ? 'bg-app-ink border-app-ink' : 'border-app-border'}`}>
                      {showBarcode && <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <span className="text-xs font-black uppercase">Barcode</span>
                  </button>
                  {fields.map(f => (
                    <button
                      key={f.key}
                      onClick={() => toggleField(f.key)}
                      className={`flex items-center gap-2 p-3 rounded-xl border-2 text-left transition-all ${
                        f.enabled ? 'border-app-ink bg-app-ink/5' : 'border-app-border/30 opacity-50'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${f.enabled ? 'bg-app-ink border-app-ink' : 'border-app-border'}`}>
                        {f.enabled && <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3"><path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <span className="text-xs font-black uppercase">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Copies */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase opacity-50 tracking-widest">Copies per Product</label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setCopies(c => Math.max(1, c - 1))}
                    className="w-10 h-10 rounded-xl border-2 border-app-border hover:bg-app-bg transition-all font-black text-lg flex items-center justify-center"
                  >−</button>
                  <span className="text-2xl font-black w-10 text-center">{copies}</span>
                  <button
                    onClick={() => setCopies(c => Math.min(100, c + 1))}
                    className="w-10 h-10 rounded-xl border-2 border-app-border hover:bg-app-bg transition-all font-black text-lg flex items-center justify-center"
                  >+</button>
                  <span className="text-[10px] opacity-40 font-bold ml-2">
                    = {selected.size * copies} total labels
                  </span>
                </div>
              </div>

              {/* Live Preview */}
              {previewProduct && (
                <div className="space-y-3">
                  <label className="text-[10px] font-black uppercase opacity-50 tracking-widest flex items-center gap-2">
                    <Eye size={12} /> Preview (actual size)
                  </label>
                  <div className="p-6 bg-app-bg rounded-2xl border border-app-border/30 flex items-center justify-center">
                    <div style={{ transform: 'scale(2)', transformOrigin: 'center center', margin: `${size.heightMm * 3.78}px ${size.widthMm * 3.78 / 2}px` }}>
                      <LabelPreview
                        product={previewProduct}
                        fields={fields}
                        size={size}
                        showBarcode={showBarcode}
                      />
                    </div>
                  </div>
                  <p className="text-[9px] opacity-30 text-center">Preview shown at 2× scale — will print at {size.label}</p>
                </div>
              )}
            </div>

            {/* Print button */}
            <div className="p-6 border-t border-app-border flex-shrink-0">
              <button
                onClick={handlePrint}
                disabled={selected.size === 0 || isPrinting}
                className="w-full py-4 bg-app-ink text-app-bg rounded-2xl font-black uppercase text-sm flex items-center justify-center gap-3 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-30"
              >
                {isPrinting
                  ? <><RefreshCw size={18} className="animate-spin" /> Preparing...</>
                  : <><Printer size={18} /> Print {selected.size * copies} Label{selected.size * copies !== 1 ? 's' : ''}</>
                }
              </button>
              {selected.size === 0 && (
                <p className="text-[10px] opacity-30 text-center mt-2">Select at least one product from the list</p>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
