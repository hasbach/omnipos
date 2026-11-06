// POS scan feedback tones (Web Audio, no audio files, works offline in Electron).
// success: one short high beep = the item went into the cart.
// error:   two low buzzes = the scan/entry was read but nothing was added.
// The on/off switch is the tenant setting pos_scan_beep (missing = on), pushed in by usePos.

export type BeepKind = 'success' | 'error';

let enabled = true;
let context: AudioContext | null = null;
let unlockInstalled = false;

/** Turns the POS beeps on/off (Settings → pos_scan_beep). */
export function setBeepEnabled(on: boolean): void {
  enabled = on;
}

export function isBeepEnabled(): boolean {
  return enabled;
}

function getContext(): AudioContext | null {
  if (context) return context;
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/**
 * Browsers only start audio after a user gesture: create / resume the shared context on the first click
 * or key press (a barcode scanner types keys, so the first scan unlocks it before its own beep).
 */
export function installBeepUnlock(): void {
  if (unlockInstalled || typeof window === 'undefined') return;
  unlockInstalled = true;
  const unlock = () => {
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
}

function tone(ctx: AudioContext, at: number, freq: number, duration: number, type: OscillatorType, volume: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  // Short attack and exponential release: no click at either end.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.02);
}

/** Plays the success or error tone (no-op when beeps are off or the device has no audio). */
export function beep(kind: BeepKind): void {
  if (!enabled || typeof window === 'undefined') return;
  installBeepUnlock();
  const ctx = getContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const now = ctx.currentTime + 0.005;
    if (kind === 'success') {
      tone(ctx, now, 1400, 0.09, 'sine', 0.25);
    } else {
      tone(ctx, now, 220, 0.16, 'square', 0.08);
      tone(ctx, now + 0.21, 180, 0.2, 'square', 0.08);
    }
  } catch { /* ignore: audio is best-effort */ }
}
