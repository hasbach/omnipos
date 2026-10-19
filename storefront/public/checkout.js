// OmniPOS storefront checkout (spec 003, Slice 1 — WhatsApp order). Loaded on the cart page only, after cart.js.
// Turns the cart and the form into a pre-filled WhatsApp message to the shop (in the shop's language) and opens
// it in the visitor's own WhatsApp. Nothing is sent to or stored by OmniPOS; "remember my details" stays in this
// browser.
(function () {
  'use strict';

  var C = window.OmniCart;
  var form = document.getElementById('sf-checkout');
  if (!C || !form) return;

  var cfg = C.config;
  var BUYER = 'sf-buyer:v1:' + cfg.address;
  // Longest encoded text we put in a wa.me link (Arabic expands ~6× when percent-encoded) — research R8.
  var MAX_ENCODED = 6000;
  var LIMITS = { name: 80, phone: 30, address: 300, note: 300 };

  function fill(s, vars) {
    if (vars) Object.keys(vars).forEach(function (k) { s = s.split('{' + k + '}').join(String(vars[k])); });
    return s;
  }
  function ui(key, vars) { return fill((cfg.ui && cfg.ui[key]) || key, vars); }
  function msg(key, vars) { return fill((cfg.msg && cfg.msg[key]) || key, vars); }

  function field(name) { return form.querySelector('[name="' + name + '"]'); }
  function radios() { return form.querySelectorAll('input[name="fulfilment"]'); }

  function methods() {
    var out = [];
    if (cfg.pickup && cfg.pickup.on) out.push('pickup');
    if (cfg.delivery && cfg.delivery.on) out.push('delivery');
    return out;
  }

  function values() {
    var f = '';
    radios().forEach(function (r) { if (r.checked) f = r.value; });
    if (!f && methods().length === 1) f = methods()[0];
    var text = function (n) { var e = field(n); return e ? String(e.value || '').trim().slice(0, LIMITS[n]) : ''; };
    var remember = field('remember');
    return { name: text('name'), phone: text('phone'), fulfilment: f, address: text('address'), note: text('note'), remember: !!(remember && remember.checked) };
  }

  /** Field errors: { field: message key }. */
  function validate(v) {
    var errors = {};
    if (!v.name) errors.name = 'field_required';
    if (v.phone && !/^[0-9+\s()-]+$/.test(v.phone)) errors.phone = 'invalid_phone';
    if (methods().indexOf(v.fulfilment) < 0) errors.fulfilment = 'field_required';
    if (v.fulfilment === 'delivery' && !v.address) errors.address = 'field_required';
    return errors;
  }

  /** What stops the order regardless of the form: empty cart, minimum order, listing minimums. */
  function blockers() {
    var t = C.totals();
    var out = [];
    if (t.count === 0) out.push('empty');
    else if (cfg.minOrderUsd && t.usd + 1e-9 < cfg.minOrderUsd) out.push(ui('amount_to_minimum', { price: C.fmtUsd(Math.round((cfg.minOrderUsd - t.usd) * 100) / 100) }));
    if (C.minimumIssues().length) out.push(ui('minimum_blocks'));
    return out;
  }

  function buildMessage(v) {
    var lines = C.load().lines.filter(function (l) { return !l.unavailable; }).map(function (l) {
      return C.fmtQty(l.qty) + ' × ' + l.title + ' (' + l.name + ') — ' + C.fmtUsd(C.lineAmounts(l).usd);
    });
    var t = C.totals();
    var total = C.fmtUsd(t.usd) + (t.local === null ? '' : ' · ' + C.fmtLocal(t.local));
    var how = v.fulfilment === 'delivery'
      ? msg('msg_delivery', { address: v.address })
      : msg('msg_pickup') + (cfg.pickup && cfg.pickup.note ? ' — ' + cfg.pickup.note : '');
    var out = [msg('msg_new_order', { store: cfg.storeName }), cfg.home, ''].concat(lines, ['', msg('msg_total', { total: total }), how, msg('msg_name', { name: v.name })]);
    if (v.phone) out.push(msg('msg_phone', { phone: v.phone }));
    if (v.note) out.push(msg('msg_note', { note: v.note }));
    out.push('', msg('msg_prices_confirmed'));
    return out.join('\n');
  }

  function waUrl(text) { return 'https://wa.me/' + cfg.wa + '?text=' + encodeURIComponent(text); }
  function tooLong(text) { return encodeURIComponent(text).length > MAX_ENCODED; }

  // ---- remembered details (this browser only) ---------------------------------------------------------

  function loadBuyer() {
    try { var b = JSON.parse(window.localStorage.getItem(BUYER) || 'null'); return b && typeof b === 'object' ? b : null; } catch (e) { return null; }
  }
  function saveBuyer(v) {
    try {
      if (v.remember) window.localStorage.setItem(BUYER, JSON.stringify({ name: v.name, phone: v.phone, address: v.address, fulfilment: v.fulfilment }));
      else window.localStorage.removeItem(BUYER);
    } catch (e) { /* storage blocked: nothing to remember */ }
  }
  function prefill() {
    var b = loadBuyer();
    if (!b) return;
    ['name', 'phone', 'address'].forEach(function (n) { var e = field(n); if (e && typeof b[n] === 'string') e.value = b[n].slice(0, LIMITS[n]); });
    radios().forEach(function (r) { if (r.value === b.fulfilment) r.checked = true; });
    var remember = field('remember');
    if (remember) remember.checked = true;
  }

  // ---- form state ---------------------------------------------------------------------------------------

  function showErrors(errors) {
    form.querySelectorAll('.sf-error').forEach(function (p) {
      var key = errors[p.getAttribute('data-for')];
      p.textContent = key ? ui(key) : '';
      p.hidden = !key;
    });
  }

  var block = document.getElementById('sf-checkout-block');
  var submit = form.querySelector('.sf-submit');

  function update() {
    var v = values();
    var addr = document.getElementById('sf-address-field');
    if (addr) addr.hidden = v.fulfilment !== 'delivery';
    var note = field('note');
    var counter = form.querySelector('[data-counter="note"]');
    if (note && counter) counter.textContent = String(note.value || '').length + '/' + LIMITS.note;
    var reasons = blockers().filter(function (r) { return r !== 'empty'; });
    if (!reasons.length && C.totals().count && tooLong(buildMessage(v))) reasons.push(ui('order_too_long'));
    if (block) { block.textContent = reasons.join(' '); block.hidden = !reasons.length; }
    if (submit) submit.disabled = reasons.length > 0 || C.totals().count === 0;
    return reasons;
  }

  // ---- "did you send it?" --------------------------------------------------------------------------------

  var dialog = document.getElementById('sf-sent');
  var pending = false;
  function askSent() {
    if (!pending || !dialog) return;
    pending = false;
    dialog.hidden = false;
  }
  if (dialog) {
    dialog.querySelectorAll('[data-sent]').forEach(function (b) {
      b.addEventListener('click', function () {
        dialog.hidden = true;
        if (b.getAttribute('data-sent') === 'yes') {
          C.clear();
          var fb = document.getElementById('sf-wa-fallback');
          if (fb) fb.hidden = true;
        }
      });
    });
  }
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') askSent(); });
  window.addEventListener('focus', askSent);

  function send() {
    var v = values();
    var errors = validate(v);
    showErrors(errors);
    var first = Object.keys(errors)[0];
    if (first) {
      var e = first === 'fulfilment' ? radios()[0] : field(first);
      if (e && e.focus) e.focus();
      return null;
    }
    if (update().length || C.totals().count === 0) return null;
    var url = waUrl(buildMessage(v));
    saveBuyer(v);
    var fb = document.getElementById('sf-wa-fallback');
    if (fb) {
      var a = fb.querySelector('a');
      if (a) { a.href = url; a.onclick = function () { pending = true; }; }
      fb.hidden = false;
    }
    pending = true;
    window.open(url, '_blank', 'noopener');
    return url;
  }

  form.addEventListener('submit', function (ev) { ev.preventDefault(); send(); });
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  C.onChange = update;

  window.OmniCheckout = { values: values, validate: validate, blockers: blockers, buildMessage: buildMessage, waUrl: waUrl, tooLong: tooLong, send: send, update: update, MAX_ENCODED: MAX_ENCODED };

  prefill();
  update();
})();
