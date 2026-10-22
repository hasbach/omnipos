// Online checkout: quotes require a separate confirmation; retries keep both private keys.
(function () {
  'use strict';
  var el = document.getElementById('sf-order'), cfg;
  try { cfg = JSON.parse(el.textContent); } catch (e) { return; }
  var C = window.OmniCart, X = window.OmniCheckout;
  var form = document.getElementById('sf-checkout');
  var ATTEMPT = 'sf-attempt:v1:' + cfg.address, ORDERS = 'sf-orders:v1:' + cfg.address;
  var attempt = null, quote = null, reviewed = '', busy = false;
  function ui(k, vars) {
    var s = (cfg.ui && cfg.ui[k]) || k;
    Object.keys(vars || {}).forEach(function (v) { s = s.split('{' + v + '}').join(String(vars[v])); });
    return s;
  }
  function read(k) { try { return JSON.parse(window.localStorage.getItem(k)); } catch (e) { return null; } }
  function write(k, v) {
    try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* keep this visit usable */ }
  }
  function node(tag, text, parent, cls) {
    var n = document.createElement(tag);
    if (text !== null) n.textContent = text;
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }
  function empty(n) { if (n) while (n.firstChild) n.removeChild(n.firstChild); }
  function orderUrl(key) { return (cfg.base !== undefined ? cfg.base : cfg.api.submit.replace(/\/order(?:\?.*)?$/, '')) + '/o/' + key; }
  function orders() {
    var v = read(ORDERS);
    return v && v.v === 1 && Array.isArray(v.orders) ? v.orders.filter(function (o) {
      return o && /^[A-Za-z0-9_-]{32}$/.test(o.key) && typeof o.number === 'string' && !isNaN(new Date(o.at).getTime());
    }).slice(0, 20) : [];
  }
  function remember(o) {
    var list = orders().filter(function (a) { return a.key !== o.key; });
    list.push(o);
    list.sort(function (a, b) { return new Date(b.at).getTime() - new Date(a.at).getTime(); });
    write(ORDERS, { v: 1, orders: list.slice(0, 20) });
    drawOrders();
  }
  function drawOrders() {
    var host = document.getElementById('sf-myorders');
    if (!host) return;
    empty(host);
    var list = orders();
    host.hidden = !list.length;
    if (list.length) node('h2', ui('my_orders'), host);
    list.forEach(function (o) {
      var row = node('p', null, host, 'sf-myorder');
      var a = node('a', o.number, row); a.href = orderUrl(o.key);
      node('span', new Date(o.at).toLocaleDateString() + ' · ' + ui('badge_' + o.state), row);
      var b = node('button', ui('forget_order'), row); b.type = 'button';
      b.addEventListener('click', function () {
        write(ORDERS, { v: 1, orders: orders().filter(function (x) { return x.key !== o.key; }) }); drawOrders();
      });
    });
  }
  window.OmniOrder = { orders: orders, drawOrders: drawOrders };
  if (cfg.status) { remember(cfg.status); return; }
  if (!C || !X || !form || cfg.mode !== 'online') return;
  var button = form.querySelector('.sf-submit');
  var block = document.getElementById('sf-checkout-block');
  var fallback = document.getElementById('sf-wa-fallback');
  function lines() {
    return C.load().lines.filter(function (l) { return !l.unavailable; }).map(function (l) {
      return { listing: l.id, unit: l.unit, qty: l.qty, price: l.price };
    });
  }
  // A canonical line fingerprint avoids resetting a retry when only presentation changes.
  function hash() {
    var text = JSON.stringify(lines().sort(function (a, b) { return (a.listing + ':' + a.unit).localeCompare(b.listing + ':' + b.unit); }));
    var h = 2166136261;
    for (var i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16) + ':' + text.length;
  }
  function randomStatus() {
    var bytes = new Uint8Array(24), chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', s = '';
    window.crypto.getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += chars[(n >>> 18) & 63] + chars[(n >>> 12) & 63] + chars[(n >>> 6) & 63] + chars[n & 63];
    }
    return s;
  }
  function uuid() {
    if (window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16); window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    return Array.prototype.map.call(b, function (x, i) { return ([4, 6, 8, 10].indexOf(i) >= 0 ? '-' : '') + ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function keys() {
    var h = hash();
    if (!attempt) attempt = read(ATTEMPT);
    if (!attempt || attempt.cart !== h || !/^[A-Za-z0-9_-]{32}$/.test(attempt.status) || typeof attempt.key !== 'string') {
      attempt = { key: uuid(), status: randomStatus(), cart: h }; write(ATTEMPT, attempt);
    }
    return attempt;
  }
  async function request(url, payload) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try {
      var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal, credentials: 'omit', cache: 'no-store' });
      if (!r.ok) throw new Error('unavailable');
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  function message(k) { if (block) { block.textContent = ui(k); block.hidden = false; } }
  function unavailable() {
    message('cloud_unreachable');
    if (fallback && cfg.wa) {
      var text = X.buildMessage(X.values());
      if (X.tooLong(text)) { message('order_too_long'); return; }
      var a = fallback.querySelector('a');
      a.href = X.waUrl(text); a.textContent = ui('send_whatsapp_instead');
      fallback.hidden = false;
    }
  }
  function problems(l) {
    return (quote.problems || []).filter(function (p) { return p.line === l.line; }).map(function (p) { return p.code; }).concat(l.problem ? [l.problem] : []);
  }
  function excluded(l) { return l.ok === false || problems(l).some(function (p) { return ['listing_unavailable', 'unit_not_orderable', 'out_of_stock', 'invalid_quantity'].indexOf(p) >= 0; }); }
  function quoteLines() { return quote.lines.filter(function (l) { return !excluded(l); }); }
  function blocked() {
    return !quoteLines().length || (quote.problems || []).some(function (p) { return ['below_listing_minimum', 'below_store_minimum', 'too_many_lines', 'fulfilment_unavailable'].indexOf(p.code) >= 0; });
  }
  function drawQuote(q) {
    quote = q; reviewed = hash();
    var host = document.getElementById('sf-quote'); empty(host);
    if ((q.problems || []).length) node('p', ui('quote_changed'), host);
    var list = node('ul', null, host, 'sf-review-lines');
    q.lines.forEach(function (l) {
      var old = lines().filter(function (x) { return x.listing === l.listing && x.unit === l.unit; })[0];
      var saved = C.load().lines.filter(function (x) { return x.id === l.listing && x.unit === l.unit; })[0] || {};
      var row = node('li', (l.product_name || saved.title || '') + ' (' + (l.unit_name || saved.name || '') + ') × ' + (l.qty || l.ordered_qty || saved.qty), list, excluded(l) ? 'sf-line-unavailable' : '');
      if (excluded(l)) node('p', ui('line_unavailable') + ' ' + ui(l.problem || problems(l)[0]), row);
      else {
        if (old && old.price !== l.unit_price_usd) {
          var del = node('del', C.fmtUsd(old.price), row); del.setAttribute('aria-label', ui('price_was', { price: C.fmtUsd(old.price) }));
        }
        node('strong', ' ' + C.fmtUsd(l.unit_price_usd), row, 'sf-new-price');
        if (l.line_total_local != null && q.local) node('span', ' · ' + C.fmtLocal(l.line_total_local), row);
        if (problems(l).indexOf('below_listing_minimum') >= 0) node('p', ui('minimum_blocks'), row);
      }
    });
    node('p', ui('total') + ': ' + C.fmtUsd(q.total_usd) + (q.total_local != null && q.local ? ' · ' + C.fmtLocal(q.total_local) : ''), host, 'sf-cart-total');
    if ((q.problems || []).some(function (p) { return p.code === 'below_store_minimum'; })) node('p', ui('amount_to_minimum', { price: C.fmtUsd(Math.max(0, cfg.minOrderUsd - q.total_usd)) }), host);
    button.textContent = ui('place_order'); button.disabled = blocked();
  }
  function success(r, k) {
    var url = orderUrl(k.status);
    remember({ number: r.number, key: k.status, at: new Date().toISOString(), state: 'submitted' });
    if (hash() === k.cart) C.clear();
    write(ATTEMPT, null); attempt = null; quote = null;
    var host = document.getElementById('sf-confirm'); empty(host); host.hidden = false;
    node('h2', ui('order_placed'), host); node('p', ui('order_number', { number: r.number }), host);
    var a = node('a', ui('status_link'), host); a.href = url;
    var copy = node('button', ui('copy_link'), host); copy.type = 'button';
    var input = node('input', null, host); input.value = new URL(url, window.location.href).href; input.readOnly = true;
    copy.addEventListener('click', function () {
      if (window.navigator && window.navigator.clipboard) window.navigator.clipboard.writeText(input.value).catch(function () { input.focus(); input.select(); });
      else { input.focus(); input.select(); }
    });
    node('a', ui('back_to_store'), host).href = orderUrl('').slice(0, -2);
    if (fallback) fallback.hidden = true;
  }
  async function send() {
    if (busy) return;
    var v = X.values(), errors = X.validate(v);
    if (!v.phone) errors.phone = 'field_required';
    X.showErrors(errors);
    var first = Object.keys(errors)[0];
    if (first) { var f = form.querySelector('[name="' + first + '"]'); if (f) f.focus(); return; }
    if (!lines().length) return;
    busy = true; button.disabled = true; if (fallback) fallback.hidden = true;
    if (block) block.hidden = true;
    try {
      keys();
      if (!quote || reviewed !== hash()) {
        var reviewHash = hash();
        var r = await request(cfg.api.quote, { lines: lines() });
        if (reviewHash !== hash()) return;
        if (r.ok && r.quote) drawQuote(r.quote); else if (r.code === 'unavailable') unavailable(); else message('order_failed');
      } else if (!blocked()) {
        var k = keys(); X.saveBuyer(v);
        var trap = form.querySelector('[name="website"]');
        var result = await request(cfg.api.submit, { attempt: k.key, status_key: k.status, customer: { name: v.name, phone: v.phone, fulfilment: v.fulfilment, address: v.address, note: v.note }, lines: quoteLines().map(function (l) { return { listing: l.listing, unit: l.unit, qty: l.qty === undefined ? l.ordered_qty : l.qty, price: l.unit_price_usd }; }), expected_total_usd: quote.total_usd, website: trap ? trap.value : '' });
        if (result.code === 'created' || result.code === 'existing') success(result, k);
        else if (result.code === 'changed') { if (k.cart === hash()) drawQuote(result.quote); }
        else if (result.code === 'invalid') { var err = {}; err[result.field] = result.field === 'phone' ? 'invalid_phone' : 'field_required'; X.showErrors(err); }
        else if (result.code === 'phone_limit' || result.code === 'network_limit') message('too_many_orders');
        else if (result.code === 'unavailable') unavailable();
        else message('order_failed');
      }
    } catch (e) { unavailable(); }
    finally { busy = false; button.disabled = !lines().length || !!(quote && blocked()); }
  }
  function reset() {
    if (quote && reviewed !== hash()) { quote = null; empty(document.getElementById('sf-quote')); button.textContent = ui('review_order'); }
    if (attempt && attempt.cart !== hash()) { attempt = null; write(ATTEMPT, null); }
    if (fallback) fallback.hidden = true;
  }
  var previous = C.onChange;
  C.onChange = function () { if (previous) previous(); reset(); };
  function updateButton() { button.disabled = busy || !lines().length || !!(quote && blocked()); }
  form.addEventListener('input', updateButton);
  form.addEventListener('change', updateButton);
  form.addEventListener('submit', function (e) { e.preventDefault(); send(); });
  window.OmniOrder = { send: send, keys: keys, orders: orders, drawOrders: drawOrders };
  drawOrders();
})();
