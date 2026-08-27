/* ── 99-boot.js — 시동 ─────────────────────────────────────────── */
'use strict';
(function () {
  function go() {
    try { App.boot(); }
    catch (e) {
      var t = document.getElementById('toast');
      if (t) t.innerHTML = '<div class="tst bad">시작하지 못했습니다: ' + UI.esc(e.message) + '</div>';
      if (window.console) console.error(e);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();
