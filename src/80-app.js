/* ── 80-app.js — 상태, 입력, 메인 루프 ─────────────────────────── */
'use strict';

var App = (function () {
  var KEY = 'fly.cfg.v1';

  var cfg = {
    metric: true,
    camera: true,
    headingUp: false,
    chime: false,
    demo: false,
    fov: 67, fovAuto: true,
    headingOffset: 0,
    maxNm: 120,
    minAltFt: 0,
    scopeNm: 40,
    radiusNm: 120,
    intervalMs: 6000
  };

  var state = {
    cfg: cfg,
    list: [],
    visible: 0,
    selected: null,
    started: false,
    get metric() { return cfg.metric; },
    byId: function (id) { return id ? (Source.fleet[id] || null) : null; }
  };

  var dom = {}, raf = null, tPrev = 0;

  /* ── 설정 저장 ────────────────────────────────────────────── */
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (var k in cfg) if (s[k] !== undefined && typeof s[k] === typeof cfg[k]) cfg[k] = s[k];
    } catch (e) { /* 저장소를 못 쓰면 기본값으로 간다 */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ── 알림음 ───────────────────────────────────────────────── */
  var actx = null, nearSet = Object.create(null);
  function beep() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = 'sine'; o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1320, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + 0.36);
    } catch (e) {}
  }
  function chime(list) {
    var lim = 10000, next = Object.create(null), fresh = false;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.slantM > lim) break;                 // 거리순 정렬이라 여기서 끊어도 된다
      next[a.id] = 1;
      if (!nearSet[a.id]) fresh = true;
    }
    nearSet = next;
    if (fresh && cfg.chime && state.started) beep();
  }

  /* ── 시작 ─────────────────────────────────────────────────── */
  function start(useCamera) {
    if (state.started) return;
    state.started = true;
    document.getElementById('gate').classList.add('hide');

    /* 세 요청 모두 이 제스처 안에서 곧바로 띄운다.
       await 로 줄세우면 iOS 가 사용자 동작으로 인정하지 않는다. */
    Orient.request().catch(function (e) {
      UI.toast(e.message || '방향 센서를 쓸 수 없습니다 — 화면을 끌어 둘러보세요', 'warn');
    });

    if (useCamera && cfg.camera) {
      Camera.start().then(function (s) {
        dom.synth.classList.remove('on');
        View.video(s.w, s.h);
        if (cfg.fovAuto) { cfg.fov = Camera.guessFov(); View.setFov(cfg.fov); }
      }).catch(function (e) {
        cfg.camera = false;
        dom.synth.classList.add('on');
        UI.toast(e.message || '카메라를 열 수 없습니다', 'warn');
        syncButtons();
      });
    }

    Position.start().catch(function (e) {
      UI.toast(e.message || '위치를 확인할 수 없습니다', 'bad');
      if (!cfg.demo) UI.toast('설정에서 데모 모드를 켜면 화면을 확인할 수 있습니다', 'warn', true);
    });

    Source.setRadius(cfg.radiusNm);
    Source.setInterval(cfg.intervalMs);
    Source.start();
  }

  function setCamera(v) {
    cfg.camera = v; save();
    if (v) {
      Camera.start().then(function (s) {
        dom.synth.classList.remove('on');
        View.video(s.w, s.h);
        if (cfg.fovAuto) { cfg.fov = Camera.guessFov(); View.setFov(cfg.fov); }
      }).catch(function (e) {
        cfg.camera = false; dom.synth.classList.add('on');
        UI.toast(e.message, 'warn'); syncButtons();
      });
    } else {
      Camera.stop();
      dom.synth.classList.add('on');
      View.video(0, 0);
      View.setFov(cfg.fov);
    }
    syncButtons();
  }

  function select(id) {
    state.selected = id;
    UI.paint(state, true);
  }

  /* ── 메인 루프 ────────────────────────────────────────────── */
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    var dt = tPrev ? Math.min(0.25, (ts - tPrev) / 1000) : 0.016;
    tPrev = ts;

    Orient.step(dt);
    var list = Source.advance(Date.now(), dt);
    state.list = list;

    /* 화면 필터를 통과한 대수 */
    var maxM = Geo.nmToM(cfg.maxNm), n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].slantM > maxM) break;
      if (list[i].altFt != null && list[i].altFt < cfg.minAltFt) continue;
      n++;
    }
    state.visible = n;

    Render.frame(list, {
      metric: cfg.metric, selected: state.selected,
      maxNm: cfg.maxNm, minAltFt: cfg.minAltFt,
      scopeNm: cfg.scopeNm, headingUp: cfg.headingUp,
      synth: !Camera.state.on
    });

    UI.status(state);
    UI.paint(state, false);
    chime(list);
  }

  function pause() { if (raf) cancelAnimationFrame(raf); raf = null; tPrev = 0; }
  function resume() { if (!raf) { tPrev = 0; raf = requestAnimationFrame(loop); } }

  /* ── 입력 ─────────────────────────────────────────────────── */
  function syncButtons() {
    dom.bCam.classList.toggle('on', cfg.camera && Camera.state.on);
    dom.bLock.classList.toggle('on', cfg.headingUp);
    dom.bLock.textContent = cfg.headingUp ? 'H' : 'N';
    dom.bLock.title = cfg.headingUp ? '레이더: 헤딩업' : '레이더: 노스업';
  }

  function bind() {
    dom.synth = document.getElementById('synth');
    dom.hud = document.getElementById('hud');
    dom.scope = document.getElementById('scope');
    dom.bCam = document.getElementById('bCam');
    dom.bLock = document.getElementById('bLock');

    document.getElementById('bStart').onclick = function () { start(true); };
    document.getElementById('bDemo').onclick = function () {
      cfg.demo = true; Source.setDemo(true); save();
      start(false);
      UI.toast('데모 항공기를 띄웁니다. 화면을 끌어 둘러보세요');
    };
    document.getElementById('bList').onclick = function () { UI.toggle('list'); };
    document.getElementById('bSet').onclick = function () { UI.toggle('settings'); };
    document.getElementById('bClose').onclick = function () { UI.close(); };
    dom.bCam.onclick = function () { setCamera(!cfg.camera); };
    dom.bLock.onclick = function () { cfg.headingUp = !cfg.headingUp; save(); syncButtons(); };

    /* 스코프 탭 → 선택 */
    dom.scope.onclick = function (e) {
      var r = dom.scope.getBoundingClientRect();
      var id = Render.pickScope(e.clientX - r.left, e.clientY - r.top);
      if (id) { select(id); UI.open('detail'); }
    };

    /* HUD: 탭이면 선택, 끌면(센서 없을 때) 둘러보기 */
    var down = null, moved = 0, look = null;
    dom.hud.addEventListener('pointerdown', function (e) {
      down = { x: e.clientX, y: e.clientY };
      moved = 0;
      look = Orient.usable() ? null : { h: Orient.state.mh, p: Orient.state.mp };
      dom.hud.setPointerCapture(e.pointerId);
    });
    dom.hud.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - down.x, dy = e.clientY - down.y;
      moved = Math.max(moved, Math.hypot(dx, dy));
      if (look) {
        var perPx = View.vFov() / Math.max(1, Render.size.h);
        Orient.setManual(look.h + dx * perPx * -1, look.p + dy * perPx);
      }
    });
    dom.hud.addEventListener('pointerup', function (e) {
      if (down && moved < 9) {
        var r = dom.hud.getBoundingClientRect();
        var id = Render.pick(e.clientX - r.left, e.clientY - r.top);
        if (id) { select(id); UI.open('detail'); }
        else if (UI.current()) UI.close();
      }
      down = null; look = null;
    });
    dom.hud.addEventListener('pointercancel', function () { down = null; look = null; });

    /* 데스크톱: 휠로 화각 조절 */
    dom.hud.addEventListener('wheel', function (e) {
      e.preventDefault();
      cfg.fov = Math.max(25, Math.min(120, cfg.fov + (e.deltaY > 0 ? 2 : -2)));
      cfg.fovAuto = false;
      View.setFov(cfg.fov); save();
      if (UI.current() === 'settings') UI.paint(state, true);
    }, { passive: false });

    /* 시트를 아래로 끌면 닫힘 */
    var g = document.getElementById('grab'), gy = null;
    g.addEventListener('pointerdown', function (e) { gy = e.clientY; g.setPointerCapture(e.pointerId); });
    g.addEventListener('pointerup', function (e) {
      if (gy != null && e.clientY - gy > 40) UI.close();
      gy = null;
    });

    window.addEventListener('resize', function () { Render.resize(); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { Render.resize(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause(); else { resume(); Source.fetchOnce(); }
    });

    /* 데스크톱 키보드 */
    window.addEventListener('keydown', function (e) {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      var step = e.shiftKey ? 15 : 5;
      if (Orient.usable()) return;
      if (e.key === 'ArrowLeft') Orient.setManual(Orient.state.mh - step, Orient.state.mp);
      else if (e.key === 'ArrowRight') Orient.setManual(Orient.state.mh + step, Orient.state.mp);
      else if (e.key === 'ArrowUp') Orient.setManual(Orient.state.mh, Orient.state.mp + step);
      else if (e.key === 'ArrowDown') Orient.setManual(Orient.state.mh, Orient.state.mp - step);
      else if (e.key === 'Escape') UI.close();
      else return;
      e.preventDefault();
    });
  }

  function boot() {
    load();
    UI.init();
    Camera.bind(document.getElementById('cam'));
    Render.init(document.getElementById('hud'), document.querySelector('#scope canvas'));
    Render.resize();
    View.setFov(cfg.fov);
    Orient.setOffset(cfg.headingOffset);
    Orient.setManual(0, 12);             // 센서가 붙기 전까지의 기본 시선
    Source.setRadius(cfg.radiusNm);
    Source.setInterval(cfg.intervalMs);
    if (cfg.demo) Source.state.demo = true;
    bind();
    syncButtons();

    Position.on(function (p) {
      if (p.ok && !Source.state.demo && !Source.state.lastOk) Source.fetchOnce();
    });

    resume();
  }

  return { state: state, cfg: cfg, boot: boot, start: start, select: select,
           save: save, setCamera: setCamera, pause: pause, resume: resume };
})();
