/* ── 80-app.js — 상태, 입력, 메인 루프 ─────────────────────────── */
'use strict';

var App = (function () {
  var KEY = 'fly.cfg.v1';

  /* 빌드 표시 — build.py 가 채워 넣는다. 배포된 것이 어느 빌드인지
     화면에서 바로 확인할 수 있어야 "올리긴 했나" 를 두고 헤매지 않는다. */
  var BUILD = '__BUILD__';

  var cfg = {
    metric: true,
    camera: true,
    showGround: false,      // 지상·고도 미상 항공기를 하늘에 그릴 것인가
    headingUp: false,
    trail: true,
    route: true,
    alertOn: true,
    chime: false,
    alertKm: 8,
    alertMin: 5,
    wake: true,
    demo: false,
    fov: 67, fovAuto: true,
    headingOffset: 0,
    tiltOffset: 0,          // 고각 보정 — 지평선이 어긋날 때
    maxNm: 60,              // AR 은 이보다 멀면 전부 지평선에 붙는다
    minAltFt: 0,
    scopeNm: 40,
    radiusNm: 120,
    intervalMs: 6000,
    customUrl: '',
    customKind: 'readsb',
    lastGood: ''            // 지난번에 통하던 주소 id — 다음에 여기서 시작한다
  };

  var state = {
    cfg: cfg,
    list: [],
    visible: 0,
    selected: null,
    aimed: null,            // 지금 화면 한가운데에 둔 항공기
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

  /* iOS 는 사용자 제스처 밖에서 만든 AudioContext 를 정지 상태로 두고,
     제스처 밖의 resume() 도 거부한다. 알림음은 제스처가 아닌 곳에서
     울리므로 시작 버튼을 누르는 그 순간에 미리 열어 둬야 한다. */
  function primeAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) {}
  }

  function beep() {
    try {
      if (!actx) return;                     // 제스처 안에서 열리지 않았다
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
  /* 곧 가까이 지나갈 항공기를 한 번씩만 알린다.
     "지금 10 km 안" 이 아니라 "앞으로 N 분 안에 M km 까지" 를 본다 —
     이미 가까운 것보다 다가오는 것이 알릴 값어치가 있다. */
  function alerts(list, nowMs) {
    if (!cfg.alertOn || !state.started) return;
    var lim = cfg.alertKm * 1000, hor = cfg.alertMin * 60;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.altFt != null && a.altFt < 500) continue;      // 지상 이동체는 뺀다
      if (!Track.imminent(a, lim, hor)) continue;
      if (nearSet[a.id]) continue;
      nearSet[a.id] = nowMs;
      var c = a.tca;
      var when = c.t < 60 ? Math.round(c.t) + '초' : Math.round(c.t / 60) + '분';
      UI.toast((a.cs || a.reg || a.id.toUpperCase()) + ' · ' + when + ' 뒤 ' +
               Geo.fmtDist(c.dist, cfg.metric) + ' 거리로 지나갑니다' +
               (c.el > 60 ? ' — 거의 머리 위' : ''), 'warn');
      if (cfg.chime) beep();
    }
    /* 15분 지난 알림 기록은 지운다 — 다음에 다시 다가오면 또 알려야 한다 */
    for (var k in nearSet) if (nowMs - nearSet[k] > 900000 || !Source.fleet[k]) delete nearSet[k];
  }

  /* ── 시작 ─────────────────────────────────────────────────── */
  function start(useCamera) {
    if (state.started) return;
    state.started = true;
    document.getElementById('gate').classList.add('hide');
    primeAudio();

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
    wakeOn();
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

  /* 점검에서 찾은 주소를 채택한다. 직접 지정 공급자로 넣고 그것을 쓴다. */
  function useUrl(tpl, kind) {
    cfg.customUrl = tpl;
    cfg.customKind = kind === 'opensky' ? 'opensky' : 'readsb';
    Source.setCustom(cfg.customUrl, cfg.customKind);
    if (cfg.demo) { cfg.demo = false; Source.setDemo(false); }
    var i = Source.customIndex();
    if (i >= 0) Source.setProvider(i);
    save();
  }

  /* ── 겨냥 ──────────────────────────────────────────────────
     이 앱의 쓰임은 "하늘에 보이는 저 비행기가 뭐지" 다. 그러니 화면
     한가운데에 둔 한 대를 붙잡아 그 한 대의 정보를 크게 보여 준다.

     붙잡은 것은 웬만하면 놓지 않는다 — 손이 조금 흔들릴 때마다 대상이
     바뀌면 읽을 수가 없다. */
  var AIM_DEG = 14;         // 이 안에 들어와야 겨냥으로 친다
  var HOLD_DEG = 22;        // 한 번 잡으면 여기까지는 놓지 않는다
  var STICKY = 1.5;         // 다른 것이 이만큼 더 가까워야 갈아탄다

  function pickAim(list) {
    var maxM = Geo.nmToM(cfg.maxNm);
    var best = null, bestSep = 1e9, held = null;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.slantM > maxM) break;
      if (!cfg.showGround && !a.airborne) continue;
      if (a.altFt != null && a.altFt < cfg.minAltFt) continue;
      var p = View.project(a.az, a.el);
      if (!p.front) continue;
      a._sep = p.sep;
      if (a.id === state.aimed) held = a;
      if (p.sep < bestSep) { bestSep = p.sep; best = a; }
    }
    /* 붙잡고 있던 것이 아직 시야에 있고, 새 후보가 압도적으로 가깝지
       않으면 그대로 둔다 */
    if (held && held._sep <= HOLD_DEG &&
        (!best || best.id === held.id || held._sep <= best._sep * STICKY)) {
      return held.id;
    }
    return (best && bestSep <= AIM_DEG) ? best.id : null;
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
    state.aimed = pickAim(list);

    /* 화면 필터를 통과한 대수 */
    var maxM = Geo.nmToM(cfg.maxNm), n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].slantM > maxM) break;
      if (!cfg.showGround && !list[i].airborne) continue;
      if (list[i].altFt != null && list[i].altFt < cfg.minAltFt) continue;
      n++;
    }
    state.visible = n;

    var now = Date.now();
    Render.frame(list, {
      metric: cfg.metric, selected: state.selected, now: now,
      maxNm: cfg.maxNm, minAltFt: cfg.minAltFt,
      scopeNm: cfg.scopeNm, headingUp: cfg.headingUp,
      trail: cfg.trail, synth: !Camera.state.on, showGround: cfg.showGround,
      aimed: state.aimed,
      alertM: cfg.alertKm * 1000, alertS: cfg.alertMin * 60
    });

    UI.status(state);
    UI.paint(state, false);
    hostNotice();
    alerts(list, now);
    if (cfg.route) Route.pump(list);
  }

  /* 서버 없는 호스팅이면 한 번 짚어 준다 — 여기서는 무엇을 해도 안 되고,
     어디로 가야 하는지 모르면 계속 같은 자리를 맴돌게 된다. */
  var noticed = false;
  function hostNotice() {
    if (noticed || !state.started) return;
    var s = Source.state;
    if (s.demo || s.everOk || !s.relayDead || s.searching) return;
    if (s.sweep !== 0) return;                    // 아직 훑는 중
    noticed = true;
    var host = location.hostname;
    UI.toast(host + ' 에는 중계 서버가 없어 항공기를 받을 수 없습니다 — ' +
             'Vercel 주소(…vercel.app)로 열어 주세요', 'bad');
  }

  function pause() { if (raf) cancelAnimationFrame(raf); raf = null; tPrev = 0; }
  function resume() { if (!raf) { tPrev = 0; raf = requestAnimationFrame(loop); } }

  /* 하늘을 올려다보는 동안 화면이 꺼지면 곤란하다.
     탭을 벗어나면 브라우저가 알아서 풀어 버리므로 돌아올 때 다시 잡는다. */
  var wl = null;
  function wakeOn() {
    if (!cfg.wake || !navigator.wakeLock || wl) return;
    navigator.wakeLock.request('screen').then(function (s) {
      wl = s;
      s.addEventListener('release', function () { wl = null; });
    }).catch(function () { /* 지원하지 않거나 거부됨 — 조용히 넘어간다 */ });
  }
  function wakeOff() { if (wl) { try { wl.release(); } catch (e) {} wl = null; } }
  function setWake(v) { cfg.wake = v; save(); if (v) wakeOn(); else wakeOff(); }

  /* ── 화면 저장 ──────────────────────────────────────────────
     카메라 영상 위에 HUD 를 얹어 한 장으로 합친다. 카메라를 끈 상태면
     하늘과 지면도 이미 HUD 캔버스에 그려져 있어 그대로 나온다. */
  function capture() {
    var hud = document.getElementById('hud');
    var vid = document.getElementById('cam');
    var out = document.createElement('canvas');
    out.width = hud.width; out.height = hud.height;
    var g = out.getContext('2d');
    g.fillStyle = '#050908';
    g.fillRect(0, 0, out.width, out.height);

    if (Camera.state.on && vid.videoWidth) {
      var vw = vid.videoWidth, vh = vid.videoHeight;
      var scale = Math.max(out.width / vw, out.height / vh);   // object-fit: cover
      var dw = vw * scale, dh = vh * scale;
      try { g.drawImage(vid, (out.width - dw) / 2, (out.height - dh) / 2, dw, dh); }
      catch (e) { /* 아직 첫 프레임이 안 온 경우 */ }
    }
    g.drawImage(hud, 0, 0);

    /* 공유용이므로 언제 찍은 것인지 남긴다. 위치는 넣지 않는다. */
    var dpr = hud.width / Math.max(1, Render.size.w);
    var now = new Date();
    var stampPad = function (n) { return ('0' + n).slice(-2); };
    var stamp = 'Fly AR RADAR · ' + now.getFullYear() + '-' + stampPad(now.getMonth() + 1) + '-' +
                stampPad(now.getDate()) + ' ' + stampPad(now.getHours()) + ':' + stampPad(now.getMinutes());
    g.save();
    g.scale(dpr, dpr);
    g.font = '10px "IBM Plex Mono","D2Coding",ui-monospace,monospace';
    g.textAlign = 'right'; g.textBaseline = 'bottom';
    var sw = g.measureText(stamp).width;
    var sx = Render.size.w - 10, sy = Render.size.h - 10;
    g.fillStyle = 'rgba(4,10,8,.55)';
    g.fillRect(sx - sw - 7, sy - 15, sw + 12, 18);
    g.fillStyle = 'rgba(234,244,239,.72)';
    g.fillText(stamp, sx, sy);
    g.restore();

    var d = new Date(), pad = function (n) { return ('0' + n).slice(-2); };
    var name = 'fly-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
               '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.png';

    if (!out.toBlob) { UI.toast('이 브라우저에서는 저장할 수 없습니다', 'warn'); return; }
    out.toBlob(function (blob) {
      if (!blob) { UI.toast('저장에 실패했습니다', 'bad'); return; }
      var file = null;
      try { file = new File([blob], name, { type: 'image/png' }); } catch (e) {}
      /* iOS 는 a[download] 가 잘 듣지 않는다 — 공유 시트를 먼저 시도한다 */
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'Fly' })
          .then(function () { UI.toast('저장했습니다'); })
          .catch(function () { /* 사용자가 취소 */ });
        return;
      }
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      UI.toast('저장했습니다');
    }, 'image/png');
  }

  /* 선택한 항공기 쪽으로 시선을 돌린다 (센서가 없을 때만 뜻이 있다) */
  function lookAt(id) {
    var a = state.byId(id);
    if (!a || a.az == null) return false;
    if (Orient.usable()) return false;
    Orient.setManual(a.az, a.el);
    return true;
  }

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
    /* 빨간 상태 칩을 누르면 바로 점검 화면으로 — 거기서 손쓸 수 있다 */
    document.getElementById('stat').onclick = function (e) {
      if (e.target.closest('.chip.bad') || e.target.closest('.chip.warn')) UI.open('settings');
    };
    document.getElementById('bList').onclick = function () { UI.toggle('list'); };
    document.getElementById('bSet').onclick = function () { UI.toggle('settings'); };
    document.getElementById('bClose').onclick = function () { UI.close(); };
    dom.bCam.onclick = function () { setCamera(!cfg.camera); };
    dom.bLock.onclick = function () { cfg.headingUp = !cfg.headingUp; save(); syncButtons(); };
    document.getElementById('bShot').onclick = function () { capture(); };

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
        /* vFov/높이 는 tan 투영 때문에 실제와 어긋난다 —
           초점거리에서 나오는 화면 중앙의 각도/픽셀 비율을 쓴다. */
        var perPx = Geo.deg(1 / Math.max(1, View.state.f));
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

    /* CSP 가 막은 요청을 기록해 둔다 — 나중에 CORS 실패와 갈라내는 단서가 된다 */
    document.addEventListener('securitypolicyviolation', function (e) {
      Source.noteCsp(e.blockedURI || e.violatedDirective || '');
    });

    /* 화면 회전 각이 바뀌면 캔버스도 그 자리에서 다시 잡는다.
       resize 이벤트를 기다리면 그 사이 몇 프레임이 어긋난 채 그려진다. */
    Orient.onRotate(function () { Render.resize(); });
    window.addEventListener('resize', function () { Render.resize(); });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', function () { Render.resize(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { pause(); wakeOff(); return; }
      resume(); wakeOn();
      /* 화면을 벗어나 있는 동안 지켜보기가 멈추는 기기가 많다.
         돌아왔는데 좌표가 오래됐으면 조용히 다시 잡는다. */
      if (state.started && !Source.state.demo && Position.stale(45)) {
        Position.refresh().catch(function () {});
      }
      Source.fetchOnce();
    });

    /* 데스크톱 키보드 */
    window.addEventListener('keydown', function (e) {
      if (e.target && /input|select|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'Escape') { UI.close(); e.preventDefault(); return; }
      var step = e.shiftKey ? 15 : 5;
      if (Orient.usable()) return;            // 아래는 센서가 없을 때의 둘러보기
      if (e.key === 'ArrowLeft') Orient.setManual(Orient.state.mh - step, Orient.state.mp);
      else if (e.key === 'ArrowRight') Orient.setManual(Orient.state.mh + step, Orient.state.mp);
      else if (e.key === 'ArrowUp') Orient.setManual(Orient.state.mh, Orient.state.mp + step);
      else if (e.key === 'ArrowDown') Orient.setManual(Orient.state.mh, Orient.state.mp - step);
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
    Orient.setTilt(cfg.tiltOffset);
    Orient.setManual(0, 12);             // 센서가 붙기 전까지의 기본 시선
    Source.setRadius(cfg.radiusNm);
    Source.setInterval(cfg.intervalMs);
    if (cfg.customUrl) {
      Source.setCustom(cfg.customUrl, cfg.customKind);
      var ci = Source.customIndex();
      if (ci >= 0) Source.setProvider(ci);
    }
    /* 지난번에 통하던 주소가 있으면 거기서 시작한다 — 매번 처음부터
       훑을 이유가 없다 */
    if (cfg.lastGood) {
      for (var gi = 0; gi < Source.PROVIDERS.length; gi++) {
        if (Source.PROVIDERS[gi].id === cfg.lastGood) { Source.setProvider(gi); break; }
      }
    }
    Source.setOnFound(function (prov) {
      if (cfg.lastGood !== prov.id) { cfg.lastGood = prov.id; save(); }
    });
    if (cfg.demo) Source.state.demo = true;
    Route.setOn(cfg.route);
    bind();
    syncButtons();

    /* 위치가 끊기면 화면의 모든 계산이 근거를 잃는다 — 조용히 넘어가면 안 된다 */
    var hadFix = false, warned = '';
    Position.on(function (p) {
      if (p.ok && !Source.state.demo && !Source.state.lastOk) Source.fetchOnce();
      if (p.ok) { hadFix = true; if (warned) { UI.toast('위치를 다시 잡았습니다'); warned = ''; } }
      else if (hadFix && state.started) {
        var why = p.perm === 'denied' ? '위치 권한이 회수되었습니다' : (p.err || '위치가 끊겼습니다');
        if (warned !== why) {
          warned = why;
          UI.toast(why + ' — 설정에서 다시 잡아 주세요', 'bad');
        }
      }
    });

    resume();
  }

  return { BUILD: BUILD, state: state, cfg: cfg, boot: boot, start: start, select: select,
           save: save, setCamera: setCamera, setWake: setWake, primeAudio: primeAudio,
           useUrl: useUrl,
           capture: capture, lookAt: lookAt, pause: pause, resume: resume };
})();
