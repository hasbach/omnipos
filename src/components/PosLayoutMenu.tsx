import React, { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, RotateCcw } from 'lucide-react';
import { useI18n } from '../intl/index';
import { usePosLayout, type PosDensity, type PosTileSize } from '../hooks/usePosLayout';

function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-text-3 mb-1.5">{label}</p>
      <div role="radiogroup" aria-label={label} className="grid gap-1 bg-surface-2 p-1 rounded-[var(--radius-input)]" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`min-h-[36px] px-2 text-xs font-semibold rounded-md cursor-pointer transition-colors ${value === o.value ? 'bg-primary text-on-primary' : 'text-text-2 hover:text-text hover:bg-surface'}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PosLayoutMenu() {
  const { t } = useI18n();
  const { layout, setDensity, setTileSize, setHideCatalog, reset } = usePosLayout();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('pos_layout', 'Layout')}
        title={t('pos_layout', 'Layout')}
        className={`flex items-center justify-center h-8 w-8 rounded-[var(--radius-input)] cursor-pointer ${open ? 'bg-primary text-on-primary' : 'text-text-2 hover:bg-surface hover:text-text'}`}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={t('pos_layout', 'Layout')}
          className="absolute end-0 top-full mt-1 w-72 max-w-[calc(100vw-1rem)] p-3 space-y-3 bg-surface border border-border rounded-lg shadow-[var(--shadow-modal)] z-50"
        >
          <Segmented<PosDensity>
            label={t('pos_layout_density', 'Cart row density')}
            value={layout.density}
            onChange={setDensity}
            options={[
              { value: 'comfortable', label: t('pos_layout_comfortable', 'Comfortable') },
              { value: 'compact', label: t('pos_layout_compact', 'Compact') },
            ]}
          />
          <Segmented<PosTileSize>
            label={t('pos_layout_tiles', 'Catalog tile size')}
            value={layout.tileSize}
            onChange={setTileSize}
            options={[
              { value: 'sm', label: t('pos_layout_small', 'Small') },
              { value: 'md', label: t('pos_layout_medium', 'Medium') },
              { value: 'lg', label: t('pos_layout_large', 'Large') },
            ]}
          />
          <label className="flex items-center justify-between gap-3 min-h-[40px] cursor-pointer">
            <span className="text-sm font-semibold text-text">{t('pos_layout_hide_catalog', 'Hide catalog')}</span>
            <input
              type="checkbox"
              role="switch"
              checked={layout.hideCatalog}
              onChange={(e) => setHideCatalog(e.target.checked)}
              className="h-5 w-5 accent-primary cursor-pointer"
            />
          </label>
          <p className="text-[11px] text-text-3 -mt-2">{t('pos_layout_drag_hint', 'Drag the divider between the cart and the catalog to resize; double-click it to reset.')}</p>
          <button
            type="button"
            onClick={reset}
            className="w-full flex items-center justify-center gap-2 min-h-[40px] text-xs font-bold border border-border rounded-[var(--radius-input)] text-text-2 hover:border-border-strong hover:text-text cursor-pointer"
          >
            <RotateCcw size={14} /> {t('pos_layout_reset', 'Reset layout')}
          </button>
        </div>
      )}
    </div>
  );
}
