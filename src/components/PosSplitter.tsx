import React, { useRef, useState } from 'react';
import { useI18n } from '../intl/index';
import { usePosLayout, CART_PCT_MIN, CART_PCT_MAX, CART_PCT_DEFAULT } from '../hooks/usePosLayout';

/**
 * Draggable vertical splitter between the cart and the catalog. `containerRef` is the element whose
 * width the cart percentage refers to. RTL-aware: the cart sits on the right in RTL, so the drag
 * measures from the right edge and the arrow keys flip.
 */
export default function PosSplitter({ containerRef }: { containerRef: React.RefObject<HTMLElement | null> }) {
  const { t, dir } = useI18n();
  const isRtl = dir === 'rtl';
  const { layout, setCartPct, commit } = usePosLayout();
  const [dragging, setDragging] = useState(false);
  const lastPct = useRef(layout.cartPct);

  const pctFromX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return null;
    const px = isRtl ? r.right - clientX : clientX - r.left;
    return (px / r.width) * 100;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const p = pctFromX(e.clientX);
    if (p != null) { setCartPct(p, false); lastPct.current = p; }
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    commit();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Cart grows toward the catalog: right in LTR, left in RTL.
    const grow = isRtl ? 'ArrowLeft' : 'ArrowRight';
    const shrink = isRtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) setCartPct(layout.cartPct + 2);
    else if (e.key === shrink) setCartPct(layout.cartPct - 2);
    else if (e.key === 'Home') setCartPct(CART_PCT_MIN);
    else if (e.key === 'End') setCartPct(CART_PCT_MAX);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('pos_resize_panels', 'Resize cart and catalog')}
      aria-valuemin={CART_PCT_MIN}
      aria-valuemax={CART_PCT_MAX}
      aria-valuenow={Math.round(layout.cartPct)}
      tabIndex={0}
      title={t('pos_resize_hint', 'Drag to resize - double-click to reset')}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => { if (dragging) { setDragging(false); commit(); } }}
      onDoubleClick={() => setCartPct(CART_PCT_DEFAULT)}
      onKeyDown={onKeyDown}
      className={`group relative z-10 w-2 shrink-0 -mx-px cursor-col-resize touch-none select-none outline-none flex items-stretch justify-center focus-visible:bg-primary/20 ${dragging ? 'bg-primary/20' : 'hover:bg-primary/10'}`}
    >
      <span className={`w-px ${dragging ? 'bg-primary' : 'bg-border group-hover:bg-primary group-focus-visible:bg-primary'}`} />
      <span className={`pointer-events-none absolute top-1/2 -translate-y-1/2 h-10 w-1 rounded-full ${dragging ? 'bg-primary' : 'bg-border-strong group-hover:bg-primary'}`} />
    </div>
  );
}
