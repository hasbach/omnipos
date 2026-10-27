import { useEffect, useRef, useState } from 'react';
import { usePermissions } from '../lib/usePermissions';
import { useI18n } from '../intl/index';
import { useToast } from '../components/ui';
import { ordersApi } from '../lib/ordersApi';
import { orderNotification, readOrderMute } from '../lib/orderNotifications';

export function ordersMuted(): boolean {
  try { return readOrderMute(window.localStorage); } catch { return false; }
}

/**
 * Toast + short tone when new online orders arrive (socket ORDERS_UPDATED, re-dispatched as window 'pos-sync' in both the
 * back office and the POS window). Only for users who may view orders.
 */
export function useOrderNotifications() {
  const { can, ready } = usePermissions();
  const allowed = ready && can('orders.view');
  const { t } = useI18n();
  const toast = useToast();
  // Refs, so a new t / toast identity doesn't re-subscribe and close the audio context.
  const tRef = useRef(t);
  const toastRef = useRef(toast);
  tRef.current = t;
  toastRef.current = toast;

  useEffect(() => {
    if (!allowed) return;
    // Browsers only start audio after a user gesture: create / resume the context on the first click or key.
    let context: AudioContext | null = null;
    const unlock = () => {
      try {
        context ??= new AudioContext();
        void context.resume().catch(() => {});
      } catch { /* no audio on this device */ }
    };
    const beep = () => {
      if (context?.state !== 'running') return;
      try {
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, context.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.2);
        tone.connect(gain);
        gain.connect(context.destination);
        tone.start();
        tone.stop(context.currentTime + 0.2);
      } catch { /* ignore */ }
    };
    const notify = (event: Event) => {
      const n = orderNotification((event as CustomEvent).detail, true, ordersMuted());
      if (!n.toast) return;
      toastRef.current.info(tRef.current('orders_notification').replace('{n}', String(n.count)), { duration: 8000 });
      if (n.tone) beep();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('pos-sync', notify);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('pos-sync', notify);
      void context?.close().catch(() => {});
    };
  }, [allowed]);
}

/** Count of New orders for the sidebar / POS badge, refreshed on every ORDERS_UPDATED. */
export function useOrderBadge() {
  const { can, ready } = usePermissions();
  const allowed = ready && can('orders.view');
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!allowed) { setCount(0); return; }
    let active = true;
    const refresh = () => {
      ordersApi.summary().then((s) => { if (active) setCount(s.submitted); }).catch(() => {});
    };
    const onSync = (e: Event) => { if ((e as CustomEvent).detail?.type === 'ORDERS_UPDATED') refresh(); };
    refresh();
    window.addEventListener('pos-sync', onSync);
    return () => {
      active = false;
      window.removeEventListener('pos-sync', onSync);
    };
  }, [allowed]);
  return count;
}
