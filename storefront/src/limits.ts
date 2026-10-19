// Page-weight budget (spec 002 SC-001: store home ≤ 2 s on 4G). Checked by tests/storefront-routing.test.ts.
export const LIMITS = {
  /** Rendered store home with a full page of 48 product cards. */
  homeHtmlBytes: 60 * 1024,
  cssBytes: 20 * 1024,
  jsBytes: 10 * 1024,
  /** 003: loaded only on stores that take orders (cart.js) and only on the cart page (checkout.js). */
  cartJsBytes: 16 * 1024,
  checkoutJsBytes: 10 * 1024,
} as const;
