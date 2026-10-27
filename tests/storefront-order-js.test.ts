import vm from 'node:vm';
import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { FakeEl, memoryStorage, CONFIG, run, item, plain, checkoutPage } from './helpers/storefrontVm.js';
import { __dicts } from '../storefront/src/i18n.js';

const ATTEMPT = 'sf-attempt:v1:beirut-market';
const ORDERS = 'sf-orders:v1:beirut-market';
const quote = (price = 2, problems: any[] = [], extra: any[] = []) => ({ lines: [{ line: 1, listing: item().id, unit: 'base', qty: 10, product_name: '<Milk>', unit_name: 'pcs', ok: true, unit_price_usd: price, line_total_usd: price * 10, line_total_local: 100, ...{} }, ...extra], total_usd: price * 10, total_local: 100, local: { code: 'LBP' }, problems });

function setup(opts: { wa?: string; storage?: ReturnType<typeof memoryStorage>; uuid?: boolean } = {}) {
  const p = checkoutPage(['pickup']);
  p.name.value = 'Jane Doe'; p.phone.value = '70123456';
  const trap = p.form.appendChild(new FakeEl('input', { name: 'website' }));
  for (const id of ['sf-quote', 'sf-confirm', 'sf-myorders']) p.page.byId[id] = new FakeEl('section');
  const calls: { url: string; body: any; options: any }[] = [];
  const replies: any[] = [];
  const timers = new Map<number, () => void>(); let sequence = 0;
  const storage = opts.storage || memoryStorage();
  const cfg = { ...CONFIG, mode: 'online', wa: opts.wa === undefined ? CONFIG.wa : opts.wa, ui: __dicts.en, api: { quote: '/order/quote', submit: '/order' } };
  const crypto = { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a), ...(opts.uuid === false ? {} : { randomUUID: () => webcrypto.randomUUID() }) };
  const globals = {
    AbortController,
    setTimeout: (fn: () => void, ms: number) => { assert.equal(ms, 15000); timers.set(++sequence, fn); return sequence; },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (url: string, options: any) => {
      calls.push({ url, body: JSON.parse(options.body), options });
      assert.ok(['/order', '/order/quote'].includes(url)); assert.equal(options.credentials, 'omit');
      const r = replies.shift();
      if (r === 'abort') return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('AbortError'))));
      if (r instanceof Error) throw r;
      assert.ok(r, 'program a response');
      return { ok: r.http !== false, json: async () => r };
    },
  };
  const h = run({ config: cfg, page: p.page, storage, checkout: true, globals });
  h.window.crypto = crypto;
  // Run after crypto is installed, as it is in a real browser.
  vm.runInContext(fs.readFileSync('storefront/public/order.js', 'utf8'), h.ctx);
  if (!h.cart.load().lines.length) h.cart.add(item(), 10);
  const review = async (q = quote()) => { replies.push({ ok: true, quote: q }); await h.window.OmniOrder.send(); };
  return { ...h, ...p, trap, calls, replies, timers, review, order: h.window.OmniOrder, cfg };
}

test('review sends available prices, marks changed/unavailable/minimum lines, and place uses exact quote', async () => {
  const h = setup();
  h.cart.add(item({ id: 'gone', unavailable: true }), 1); h.cart.load().lines[1].unavailable = true;
  const q = quote(2, [{ line: 1, code: 'price_changed' }], [{ line: 2, listing: 'gone', unit: 'base', qty: 1, ok: false, problem: 'listing_unavailable', product_name: 'Gone', unit_name: 'pcs' }]);
  await h.review(q);
  assert.deepEqual(h.calls[0].body, { lines: [{ listing: item().id, unit: 'base', qty: 10, price: 1.5 }] });
  assert.equal(h.submit.textContent, 'Place order');
  const host = h.page.byId['sf-quote'];
  assert.equal(host.querySelector('del')!.textContent, '$1.50');
  assert.match(host.text, /\$2.00/); assert.match(host.text, /excluded/);
  assert.equal(host.querySelector('.sf-line-unavailable')!.tagName, 'LI');
  assert.equal(host.querySelector('script'), null, 'catalog text is textContent');
  h.replies.push({ code: 'refused' }); await h.order.send();
  assert.equal(h.calls[1].body.expected_total_usd, 20);
  assert.deepEqual(h.calls[1].body.lines, [{ listing: item().id, unit: 'base', qty: 10, price: 2 }]);
  assert.equal(h.calls[1].body.website, '');
  const m = setup(); await m.review(quote(2, [{ line: 1, code: 'below_listing_minimum' }, { code: 'below_store_minimum' }]));
  assert.match(m.page.byId['sf-quote'].text, /below their minimum/); assert.match(m.page.byId['sf-quote'].text, /minimum order/);
  await m.order.send(); assert.equal(m.calls.length, 1); assert.equal(m.submit.disabled, true);
});

test('keys persist across retries and reload, change with lines, and UUID fallback uses secure bytes', async () => {
  for (const uuid of [true, false]) {
    const h = setup({ uuid }); await h.review();
    const keys = plain(h.order.keys());
    assert.match(keys.key, /^[0-9a-f-]{36}$/); assert.match(keys.status, /^[A-Za-z0-9_-]{32}$/);
    for (let i = 0; i < 2; i++) { h.replies.push(new Error('dropped')); await h.order.send(); }
    assert.equal(h.calls[1].body.attempt, keys.key); assert.equal(h.calls[2].body.status_key, keys.status);
    const reloaded = setup({ storage: h.storage }); assert.deepEqual(plain(reloaded.order.keys()), keys);
    h.cart.setQty(item().id, 'base', 11);
    assert.notEqual(h.order.keys().status, keys.status);
    assert.equal(h.submit.textContent, 'Review order');
  }
});

test('created and existing save newest-first bounded history, clear cart/attempt and show a working link; Forget', async () => {
  for (const code of ['created', 'existing']) {
    const h = setup();
    h.storage.setItem(ORDERS, JSON.stringify({ v: 1, orders: Array.from({ length: 20 }, (_, i) => ({ number: 'W-' + i, key: String(i).padStart(32, 'a'), at: '2020-01-01', state: 'submitted' })) }));
    await h.review(); const k = h.order.keys().status;
    h.replies.push({ code, number: 'W-1001', status_url: '/o/' + k }); await h.order.send();
    const saved = JSON.parse(h.storage.getItem(ORDERS)!);
    assert.equal(saved.v, 1); assert.equal(saved.orders.length, 20);
    assert.deepEqual(saved.orders[0], { number: 'W-1001', key: k, at: saved.orders[0].at, state: 'submitted' });
    assert.equal(h.cart.load().lines.length, 0); assert.equal(h.storage.getItem(ATTEMPT), null);
    assert.equal(h.page.byId['sf-confirm'].querySelector('a')!.href, '/o/' + k);
    assert.equal(h.page.byId['sf-confirm'].hidden, false);
    h.page.byId['sf-myorders'].querySelector('button')!.dispatch('click');
    assert.equal(JSON.parse(h.storage.getItem(ORDERS)!).orders.length, 19);
  }
});

test('changed requires another confirmation and uses updated quote prices', async () => {
  const h = setup(); await h.review();
  h.replies.push({ code: 'changed', quote: quote(3) }); await h.order.send();
  assert.equal(h.calls.length, 2); assert.match(h.page.byId['sf-quote'].text, /\$3.00/);
  h.replies.push({ code: 'refused' }); await h.order.send();
  assert.equal(h.calls[2].body.lines[0].price, 3); assert.equal(h.calls[2].body.expected_total_usd, 30);
});

test('form submission is owned by online checkout; edits cannot bypass a blocked quote', async () => {
  const h = setup();
  h.replies.push({ ok: true, quote: quote(2, [{ code: 'below_store_minimum' }]) });
  h.form.dispatch('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1); assert.equal(h.opened.length, 0);
  h.form.dispatch('input');
  assert.equal(h.submit.disabled, true);
});

test('a late quote never reviews edited lines, and a late success keeps newly edited cart lines', async () => {
  const h = setup();
  let resolve!: (value: any) => void;
  h.ctx.fetch = async () => ({ ok: true, json: () => new Promise(r => { resolve = r; }) });
  const pending = h.order.send();
  await new Promise(r => setImmediate(r));
  h.cart.setQty(item().id, 'base', 11);
  resolve({ ok: true, quote: quote() }); await pending;
  assert.equal(h.page.byId['sf-quote'].children.length, 0);
  h.ctx.fetch = async () => ({ ok: true, json: async () => ({ ok: true, quote: quote() }) });
  await h.order.send();
  h.ctx.fetch = async () => ({ ok: true, json: () => new Promise(r => { resolve = r; }) });
  const submit = h.order.send();
  await new Promise(r => setImmediate(r));
  h.cart.setQty(item().id, 'base', 12);
  resolve({ code: 'created', number: 'W-1001' }); await submit;
  assert.equal(h.cart.load().lines[0].qty, 12);
});

test('field errors, limits and generic refusals keep cart and show localized messages', async () => {
  for (const code of ['invalid', 'phone_limit', 'network_limit', 'refused', 'store_unavailable']) {
    const h = setup(); await h.review(); h.replies.push({ code, field: 'phone' }); await h.order.send();
    if (code === 'invalid') assert.equal(h.form.querySelector('[data-for="phone"]')!.hidden, false);
    else assert.match(h.block.textContent, code.includes('limit') ? /Too many orders/ : /could not be sent/);
    assert.equal(h.cart.load().lines.length, 1);
  }
  const h = setup(); h.phone.value = ''; await h.order.send(); assert.equal(h.calls.length, 0);
});

test('unavailable, network failures and 15s abort retain cart and offer only the existing WhatsApp message', async () => {
  for (const wa of ['', CONFIG.wa]) for (const failure of [{ code: 'unavailable' }, new Error('offline'), 'abort', { http: false }]) {
    const h = setup({ wa }); await h.review(); h.replies.push(failure);
    const pending = h.order.send();
    if (failure === 'abort') { assert.equal(h.timers.size, 1); for (const fn of h.timers.values()) fn(); }
    await pending;
    assert.match(h.block.textContent, /could not confirm receipt/); assert.equal(h.cart.load().lines.length, 1);
    assert.equal(h.fallback.hidden, !wa);
    if (wa) assert.equal(h.fallback.querySelector('a')!.href, h.checkout.waUrl(h.checkout.buildMessage(h.checkout.values())));
    assert.equal(h.timers.size, 0); assert.equal(h.opened.length, 0);
    assert.equal('cookie' in h.document, false);
  }
});

test('blocked/corrupt storage remains usable and preserves retry keys in memory', async () => {
  const h = setup({ storage: memoryStorage(true) }); await h.review(); const k = h.order.keys().status;
  h.replies.push(new Error('offline')); await h.order.send(); assert.equal(h.order.keys().status, k);
  const bad = setup(); bad.storage.setItem(ORDERS, '{'); bad.storage.setItem(ATTEMPT, '{');
  assert.equal(bad.order.orders().length, 0); assert.match(bad.order.keys().status, /^[\w-]{32}$/);
});

test('status script updates only this store device history, without fetching', () => {
  const storage = memoryStorage(); const key = 'z'.repeat(32);
  storage.setItem(ORDERS, JSON.stringify({ v: 1, orders: [{ number: 'W-1', key, at: '2026-01-01', state: 'submitted' }] }));
  const page = { body: new FakeEl('body'), byId: { 'sf-myorders': new FakeEl('section') } };
  run({ storage, page, order: true, config: { address: 'beirut-market', base: '/s/beirut-market', status: { number: 'W-1', key, at: '2026-01-01', state: 'ready' }, ui: __dicts.en }, globals: { fetch: () => assert.fail('no status fetch') } });
  const list = JSON.parse(storage.getItem(ORDERS)!).orders;
  assert.equal(list.length, 1); assert.equal(list[0].state, 'ready');
  assert.equal(page.byId['sf-myorders'].querySelector('a')!.href, '/s/beirut-market/o/' + key);
});

test('"My orders" links keep the page language', () => {
  const storage = memoryStorage(); const key = 'z'.repeat(32);
  storage.setItem(ORDERS, JSON.stringify({ v: 1, orders: [{ number: 'W-1', key, at: '2026-01-01', state: 'submitted' }] }));
  const page = { body: new FakeEl('body'), byId: { 'sf-myorders': new FakeEl('section') } };
  run({ storage, page, order: true, config: { address: 'beirut-market', base: '/s/beirut-market', lang: 'ar', status: { number: 'W-1', key, at: '2026-01-01', state: 'ready' }, ui: __dicts.ar }, globals: { fetch: () => assert.fail('no status fetch') } });
  assert.equal(page.byId['sf-myorders'].querySelector('a')!.href, '/s/beirut-market/o/' + key + '?lang=ar');
});
