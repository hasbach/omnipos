// Browsers change the value of a focused <input type="number"> when the mouse wheel scrolls
// over it, which silently corrupts prices, quantities and cash counts while the operator is
// just trying to scroll the page. This installs one global listener that, on a wheel event over
// a focused number input, blurs it — the value stays put and the wheel's default action scrolls
// the page instead. Text inputs are left alone (their value never changes on scroll, and we must
// not disturb the caret while typing).
let installed = false;

export function disableNumberInputScroll(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;

  document.addEventListener(
    'wheel',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement &&
        target.type === 'number' &&
        target === document.activeElement
      ) {
        // Dropping focus before the browser applies its default (the increment/decrement)
        // stops the value from changing, while still letting the page scroll normally.
        target.blur();
      }
    },
    { passive: true }
  );
}
