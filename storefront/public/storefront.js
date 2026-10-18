// OmniPOS storefront — progressive enhancement only; every page works without this file.
(function () {
  'use strict';

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
