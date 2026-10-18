// OmniPOS storefront — progressive enhancement only; every page works without this file.
(function () {
  'use strict';

  // Language memory (no cookies, so pages stay cacheable): a language picked in the switcher is remembered on
  // this device; a later visit without ?lang= is sent once to the remembered language.
  var KEY = 'sf-lang';
  document.querySelectorAll('.sf-langs a[data-lang]').forEach(function (a) {
    a.addEventListener('click', function () {
      try { window.localStorage.setItem(KEY, a.getAttribute('data-lang')); } catch (e) { /* storage blocked */ }
    });
  });
  try {
    var saved = window.localStorage.getItem(KEY);
    var params = new URLSearchParams(window.location.search);
    if (saved && /^(en|ar|fr)$/.test(saved) && !params.has('lang') && document.querySelector('.sf-langs') &&
        document.documentElement.lang !== saved) {
      params.set('lang', saved);
      window.location.replace(window.location.pathname + '?' + params.toString() + window.location.hash);
    }
  } catch (e) { /* storage blocked: keep the store's language */ }

  // Product gallery: keep the dot indicator in sync with the swiped photo.
  document.querySelectorAll('.sf-gallery-wrap').forEach(function (wrap) {
    var strip = wrap.querySelector('.sf-gallery');
    var dots = wrap.querySelectorAll('.sf-dot');
    if (!strip || dots.length < 2) return;
    var update = function () {
      var w = strip.clientWidth || 1;
      var i = Math.round(Math.abs(strip.scrollLeft) / w);
      dots.forEach(function (d, n) { if (n === i) d.setAttribute('data-active', ''); else d.removeAttribute('data-active'); });
    };
    strip.addEventListener('scroll', function () { window.requestAnimationFrame(update); }, { passive: true });
  });
})();
