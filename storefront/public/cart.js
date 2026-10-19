// OmniPOS storefront cart (spec 003, Slice 1). Loaded only on stores that take orders. The cart lives in this
// browser only (localStorage, one key per store); pages stay identical for every visitor, so this script reads
// store data from the #sf-order JSON block and listing data from data- attributes, and draws everything that
// differs per visitor. Nothing is sent to OmniPOS.
(function () {
  'use strict';

  var cfgEl = document.getElementById('sf-order');
  if (!cfgEl) return;
  var cfg;
  try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { return; }

  var MAX_LINES = 50;
  var MAX_QTY = 999;
  var KEY = 'sf-cart:v1:' + cfg.address;
  var cart = null;
  var storageOk = true;

  function ui(key, vars) {
    var s = (cfg.ui && cfg.ui[key]) || key;
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  }

  // ---- storage --------------------------------------------------------------------------------------

  function readStore(key) {
    try { return window.localStorage.getItem(key); } catch (e) { storageOk = false; return null; }
  }
  function writeStore(key, value) {
    try {
      if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value);
    } catch (e) { storageOk = false; }
  }

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function numOrNull(v) { return v === null || v === undefined || v === '' ? null : (isFinite(Number(v)) ? Number(v) : null); }

  function validLine(l) {
    return l && typeof l.id === 'string' && typeof l.unit === 'string' && typeof l.title === 'string' &&
      isFinite(l.qty) && l.qty > 0 && l.qty <= MAX_QTY && isFinite(l.price) && isFinite(l.factor) && l.factor > 0;
  }

  function load() {
    if (cart) return cart;
    var raw = readStore(KEY);
    var c = null;
    try { c = raw ? JSON.parse(raw) : null; } catch (e) { c = null; }
    if (!c || c.v !== 1 || !Array.isArray(c.lines)) c = { v: 1, updated: 0, lines: [] };
    c.lines = c.lines.filter(validLine).slice(0, MAX_LINES);
    cart = c;
    return c;
  }

  function save() {
    var c = load();
    c.updated = Date.now();
    writeStore(KEY, JSON.stringify(c));
    render();
  }

  // ---- quantities and lines -------------------------------------------------------------------------

  /** Error key for a quantity, or null when it is valid. Decimals (≤ 3) only for lines sold by measure. */
  function qtyError(q, dec) {
    if (!isFinite(q) || q <= 0) return 'invalid_quantity';
    if (q > MAX_QTY) return 'cart_limit_qty';
    if (!dec && Math.floor(q) !== q) return 'invalid_quantity';
    if (dec && Math.abs(q * 1000 - Math.round(q * 1000)) > 1e-6) return 'invalid_quantity';
    return null;
  }

  function findLine(c, id, unit) {
    for (var i = 0; i < c.lines.length; i++) if (c.lines[i].id === id && c.lines[i].unit === unit) return i;
    return -1;
  }

  /** Adds qty of item (merging with the same listing + unit). Returns an error key or null. */
  function add(item, qty) {
    var c = load();
    var i = findLine(c, item.id, item.unit);
    var total = (i >= 0 ? c.lines[i].qty : 0) + qty;
    var err = qtyError(qty, item.dec) || qtyError(Math.round(total * 1000) / 1000, item.dec);
    if (err) return err;
    if (i < 0 && c.lines.length >= MAX_LINES) return 'cart_limit_lines';
    var line = {
      id: item.id, unit: item.unit, qty: Math.round(total * 1000) / 1000, title: item.title, img: item.img || null,
      name: item.name, factor: item.factor, price: item.price, price_lbp: item.price_lbp, min: item.min, dec: !!item.dec,
      base: item.base || '',
    };
    if (i >= 0) c.lines[i] = line; else c.lines.push(line);
    save();
    return null;
  }

  function setQty(id, unit, qty) {
    var c = load();
    var i = findLine(c, id, unit);
    if (i < 0) return 'invalid_quantity';
    var err = qtyError(qty, c.lines[i].dec);
    if (err) return err;
    c.lines[i].qty = qty;
    save();
    return null;
  }

  function remove(id, unit) {
    var c = load();
    var i = findLine(c, id, unit);
    if (i >= 0) { c.lines.splice(i, 1); save(); }
  }

  function clear() { load().lines = []; save(); }

  // ---- money (same rules as the storefront's price display) -----------------------------------------

  function round2(n) { return Math.round(n * 100) / 100; }

  /** Local price of one unit: the product's own local price, else USD × the store rate (whole amount). */
  function unitLocal(line) {
    var l = cfg.local || {};
    if (!l.show) return null;
    if (line.price_lbp !== null && line.price_lbp > 0) return line.price_lbp;
    if (l.rate > 0) return Math.round(line.price * l.rate);
    return null;
  }

  function lineAmounts(line) {
    var ul = unitLocal(line);
    return { usd: round2(line.price * line.qty), local: ul === null ? null : Math.round(ul * line.qty) };
  }

  function totals() {
    var usd = 0, local = 0, hasLocal = !!(cfg.local && cfg.local.show), count = 0;
    load().lines.forEach(function (line) {
      if (line.unavailable) return;
      var a = lineAmounts(line);
      usd += a.usd;
      if (a.local === null) hasLocal = false; else local += a.local;
      count++;
    });
    return { usd: round2(usd), local: hasLocal && count ? local : null, count: count };
  }

  /** Listings below their minimum (in base units, summed over the listing's lines). */
  function minimumIssues() {
    var by = {};
    load().lines.forEach(function (line) {
      if (line.unavailable || !line.min) return;
      var b = by[line.id] || (by[line.id] = { id: line.id, title: line.title, min: line.min, unit: line.base || '', have: 0 });
      b.have += line.qty * line.factor;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).filter(function (b) { return b.have + 1e-9 < b.min; });
  }

  var usdFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var wholeFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  function fmtUsd(n) { return '$' + usdFmt.format(n); }
  function fmtLocal(n) { return wholeFmt.format(n) + ' ' + ((cfg.local && (cfg.local.symbol || cfg.local.code)) || ''); }
  function fmtQty(q) { return String(Math.round(q * 1000) / 1000); }

  // ---- listing data on the page ---------------------------------------------------------------------

  function itemFrom(host, unitEl) {
    var unit = unitEl.getAttribute('data-unit');
    return {
      id: host.getAttribute('data-id'), title: host.getAttribute('data-title') || '', img: host.getAttribute('data-img') || null,
      min: numOrNull(host.getAttribute('data-min')), dec: host.getAttribute('data-dec') === '1' && unit === 'base',
      base: host.getAttribute('data-base') || '',
      unit: unit, name: unitEl.getAttribute('data-name') || '', factor: num(unitEl.getAttribute('data-factor')) || 1,
      price: num(unitEl.getAttribute('data-price')), price_lbp: numOrNull(unitEl.getAttribute('data-price-lbp')),
    };
  }

  /** Every listing shown on this page, by id: { units: { key: item } }. */
  function pageItems() {
    var out = {};
    document.querySelectorAll('form.sf-order').forEach(function (form) {
      var units = {};
      form.querySelectorAll('option[data-unit]').forEach(function (o) { units[o.getAttribute('data-unit')] = itemFrom(form, o); });
      out[form.getAttribute('data-id')] = { units: units };
    });
    document.querySelectorAll('[data-sf-add]').forEach(function (b) {
      var u = {};
      u[b.getAttribute('data-unit')] = itemFrom(b, b);
      // A card shows only one unit; a product page form (if any) knows them all.
      if (!out[b.getAttribute('data-id')]) out[b.getAttribute('data-id')] = { units: u, partial: true };
    });
    return out;
  }

  /** Refresh cart lines from the listing data on this page (prices, names; units no longer offered). */
  function refreshFromPage() {
    var items = pageItems();
    var c = load();
    var changed = false;
    c.lines.forEach(function (line) {
      var p = items[line.id];
      if (!p) return;
      var fresh = p.units[line.unit];
      if (fresh) {
        ['title', 'img', 'name', 'factor', 'price', 'price_lbp', 'min', 'dec', 'base'].forEach(function (k) {
          if (line[k] !== fresh[k]) { line[k] = fresh[k]; changed = true; }
        });
        if (line.unavailable) { delete line.unavailable; changed = true; }
      } else if (!p.partial && !line.unavailable) {
        line.unavailable = true;
        changed = true;
      }
    });
    if (changed) save();
  }

  // ---- page wiring ----------------------------------------------------------------------------------

  function setStatus(el, text) { if (el) el.textContent = text; }

  function bindForms() {
    document.querySelectorAll('form.sf-order').forEach(function (form) {
      form.hidden = false;
      var select = form.querySelector('select[name="unit"]');
      var qty = form.querySelector('input[name="qty"]');
      var status = form.querySelector('.sf-order-status');
      var dec = form.getAttribute('data-dec') === '1';
      var syncStep = function () {
        var base = select && select.value === 'base';
        if (qty) { qty.step = dec && base ? '0.001' : '1'; qty.min = qty.step; qty.inputMode = dec && base ? 'decimal' : 'numeric'; }
      };
      if (select) select.addEventListener('change', syncStep);
      syncStep();
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var opt = select ? select.options[select.selectedIndex] : form.querySelector('option[data-unit]');
        if (!opt) return;
        var err = add(itemFrom(form, opt), Number(String(qty ? qty.value : '1').replace(',', '.')));
        setStatus(status, err ? ui(err) : ui('added_to_cart'));
      });
    });
    document.querySelectorAll('[data-sf-add]').forEach(function (b) {
      b.hidden = false;
      b.addEventListener('click', function () {
        var item = itemFrom(b, b);
        var err = add(item, item.min && item.min > 1 ? item.min : 1);
        b.setAttribute('aria-label', err ? ui(err) : ui('added_to_cart'));
        flash(err ? ui(err) : ui('added_to_cart'));
      });
    });
    document.querySelectorAll('[data-sf-choose], .sf-cart-link').forEach(function (a) { a.hidden = false; });
  }

  var flashEl = null;
  function flash(text) {
    if (!flashEl) {
      flashEl = document.createElement('p');
      flashEl.className = 'sf-flash';
      flashEl.setAttribute('role', 'status');
      document.body.appendChild(flashEl);
    }
    flashEl.textContent = text;
    flashEl.hidden = false;
    clearTimeout(flash.t);
    flash.t = setTimeout(function () { flashEl.hidden = true; }, 2500);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function imgSrc(path) {
    return path ? '/img/' + path.split('/').map(encodeURIComponent).join('/') : cfg.placeholder;
  }

  function money(usd, local) { return fmtUsd(usd) + (local === null ? '' : ' · ' + fmtLocal(local)); }

  /** Amounts read left to right in every language: an isolated LTR span inside the (maybe RTL) text. */
  function moneyEl(usd, local) {
    var span = el('span', 'sf-money', money(usd, local));
    span.setAttribute('dir', 'ltr');
    return span;
  }

  /** A translated sentence with the amount placed where {price} is. */
  function withMoney(parent, template, amountEl) {
    var parts = template.split('{price}');
    if (parts[0]) parent.appendChild(el('span', '', parts[0]));
    parent.appendChild(amountEl);
    if (parts[1]) parent.appendChild(el('span', '', parts[1]));
    return parent;
  }

  function renderLine(line) {
    var li = el('li', 'sf-cart-line' + (line.unavailable ? ' sf-cart-line-off' : ''));
    var img = el('img');
    img.src = imgSrc(line.img);
    img.alt = '';
    img.width = 64;
    img.height = 64;
    li.appendChild(img);

    var info = el('div', 'sf-cart-info');
    var title = el('a', 'sf-cart-title', line.title);
    title.href = cfg.product.replace('__ID__', encodeURIComponent(line.id));
    info.appendChild(title);
    var unitLocalPrice = unitLocal(line);
    info.appendChild(withMoney(el('span', 'sf-cart-unit', ''), line.name + ' · ' + ui('each'), moneyEl(line.price, unitLocalPrice)));
    if (line.unavailable) info.appendChild(el('span', 'sf-cart-warn', ui('unavailable_line')));
    li.appendChild(info);

    var qtyBox = el('div', 'sf-qty');
    var step = line.dec ? 0.1 : 1;
    var minus = el('button', 'sf-qty-btn', '−');
    minus.type = 'button';
    minus.setAttribute('aria-label', ui('decrease'));
    var input = el('input');
    input.type = 'number';
    input.value = fmtQty(line.qty);
    input.min = line.dec ? '0.001' : '1';
    input.step = line.dec ? '0.001' : '1';
    input.max = String(MAX_QTY);
    input.setAttribute('aria-label', ui('quantity'));
    var plus = el('button', 'sf-qty-btn', '+');
    plus.type = 'button';
    plus.setAttribute('aria-label', ui('increase'));
    var change = function (q) {
      q = Math.round(q * 1000) / 1000;
      if (q <= 0) { remove(line.id, line.unit); return; }
      var err = setQty(line.id, line.unit, q);
      if (err) { flash(ui(err)); input.value = fmtQty(line.qty); }
    };
    minus.addEventListener('click', function () { change(line.qty - step); });
    plus.addEventListener('click', function () { change(line.qty + step); });
    input.addEventListener('change', function () { change(Number(String(input.value).replace(',', '.'))); });
    qtyBox.appendChild(minus);
    qtyBox.appendChild(input);
    qtyBox.appendChild(plus);
    var row = el('div', 'sf-cart-row');
    row.appendChild(qtyBox);

    var a = lineAmounts(line);
    var amount = el('span', 'sf-cart-amount', line.unavailable ? '' : money(a.usd, a.local));
    amount.setAttribute('dir', 'ltr');
    row.appendChild(amount);
    li.appendChild(row);
    var rm = el('button', 'sf-cart-remove', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', ui('remove') + ' — ' + line.title);
    rm.addEventListener('click', function () { remove(line.id, line.unit); });
    li.appendChild(rm);
    return li;
  }

  function render() {
    var c = load();
    document.querySelectorAll('.sf-cart-count').forEach(function (b) {
      b.textContent = String(c.lines.length);
      b.hidden = c.lines.length === 0;
    });
    var list = document.getElementById('sf-cart-lines');
    if (!list) return;
    var note = document.getElementById('sf-cart-storage-note');
    if (note) note.hidden = storageOk;
    var empty = document.getElementById('sf-cart-empty');
    var full = document.getElementById('sf-cart-full');
    if (empty) empty.hidden = c.lines.length > 0;
    if (full) full.hidden = c.lines.length === 0;
    while (list.firstChild) list.removeChild(list.firstChild);
    c.lines.forEach(function (line) { list.appendChild(renderLine(line)); });
    var t = totals();
    var total = document.getElementById('sf-cart-total');
    if (total) {
      while (total.firstChild) total.removeChild(total.firstChild);
      withMoney(total, ui('total') + ': {price}', moneyEl(t.usd, t.local));
    }
    var issues = document.getElementById('sf-cart-issues');
    if (issues) {
      while (issues.firstChild) issues.removeChild(issues.firstChild);
      minimumIssues().forEach(function (m) {
        issues.appendChild(el('p', 'sf-cart-warn', ui('minimum_qty', { product: m.title, min: fmtQty(m.min), unit: m.unit })));
      });
    }
  }

  // For tests and the checkout (US2): the cart logic without the DOM.
  window.OmniCart = {
    config: cfg, load: load, add: add, setQty: setQty, remove: remove, clear: clear, totals: totals,
    lineAmounts: lineAmounts, unitLocal: unitLocal, minimumIssues: minimumIssues, qtyError: qtyError,
    fmtUsd: fmtUsd, fmtLocal: fmtLocal, fmtQty: fmtQty, refreshFromPage: refreshFromPage, render: render,
    storageOk: function () { return storageOk; }, MAX_LINES: MAX_LINES, MAX_QTY: MAX_QTY,
  };

  load();
  bindForms();
  refreshFromPage();
  render();
})();
