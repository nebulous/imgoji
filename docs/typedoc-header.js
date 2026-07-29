// Inject the imgoji site-header (matching /docs), relocate TypeDoc's search into
// it, hide TypeDoc's own toolbar, and pin the light theme so the pages always
// match the rest of the site (no theme toggle).
(function () {
  function injectHeader() {
    if (document.querySelector('.site-header')) return;
    const h = document.createElement('header');
    h.className = 'site-header';
    const base = document.documentElement.dataset.base || './';
    h.innerHTML =
      '<a class="brand" href="' + base + '../index.html"><span class="mark" aria-hidden="true">🖼</span> imgoji</a>' +
      '<div class="header-right">' +
        '<nav aria-label="Library">' +
          '<a href="' + base + 'index.html">docs</a>' +
          '<a href="' + base + '../paper.html">paper</a>' +
          '<a href="https://github.com/nebulous/imgoji">github</a>' +
        '</nav>' +
        '<div class="header-tools"></div>' +
      '</div>';
    document.body.insertBefore(h, document.body.firstChild);
  }
  function moveSearch() {
    const slot = document.querySelector('.site-header .header-tools');
    if (!slot) return;
    const move = (el) => { if (el && !slot.contains(el)) slot.appendChild(el); };
    move(document.getElementById('tsd-search-trigger'));
    move(document.getElementById('tsd-search'));
  }
  function forceLight() { document.documentElement.dataset.theme = 'light'; }
  function whenApp(cb) {
    if (window.app) return cb();
    let n = 0; const iv = setInterval(() => { if (window.app || ++n > 60) { clearInterval(iv); cb(); } }, 50);
  }
  injectHeader();
  forceLight();
  whenApp(() => { moveSearch(); forceLight(); });
})();
