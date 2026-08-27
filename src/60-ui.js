/* ── 60-ui.js — 시트(목록·상세·설정)와 상태 표시 ────────────────── */
'use strict';

var UI = (function () {
  var $ = function (s) { return document.querySelector(s); };
  var el = {};
  var view = null;                 // 'list' | 'detail' | 'settings' | null
  var sortBy = 'dist';             // 'dist' | 'alt'
  var lastPaint = 0;

  function init() {
    el.stage = $('#stage'); el.sheet = $('#sheet'); el.body = $('#sheetBody');
    el.title = $('#sheetTitle'); el.tools = $('#sheetTools'); el.stat = $('#stat');
    el.toast = $('#toast');
  }

  /* ── 토스트 ───────────────────────────────────────────────── */
  var toastSeen = Object.create(null);
  function toast(msg, kind, once) {
    if (once) {
      if (toastSeen[msg]) return;
      toastSeen[msg] = 1;
    }
    var d = document.createElement('div');
    d.className = 'tst' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    el.toast.appendChild(d);
    setTimeout(function () {
      d.style.transition = 'opacity .3s'; d.style.opacity = '0';
      setTimeout(function () { d.remove(); }, 320);
    }, kind === 'bad' ? 5200 : 3400);
  }

  /* ── 상단 상태 칩 ─────────────────────────────────────────── */
  var statKey = '';
  function status(app) {
    var p = Position.state, o = Orient.state, s = Source.state;
    var chips = [];

    if (!p.ok) chips.push(['bad', '위치 없음']);
    else if (p.manual) chips.push(['warn', '위치 수동']);
    else chips.push(['', '±' + (p.acc != null ? Math.round(p.acc) : '?') + ' m']);

    if (Orient.stale()) chips.push(['bad', '방향 센서 없음']);
    else if (!o.absolute) chips.push(['warn', '방위 미보정']);

    var age = s.lastOk ? (Date.now() - s.lastOk) / 1000 : null;
    if (s.demo) chips.push(['warn', '데모']);
    else if (!s.live || age == null) chips.push(['bad', s.lastErr || '수신 대기']);
    else if (age > 25) chips.push(['warn', s.providerName + ' · ' + Geo.fmtAge(age)]);
    else chips.push(['live', s.providerName]);

    chips.push(['mute', app.visible + '대 / ' + s.count]);

    var key = JSON.stringify(chips);
    if (key === statKey) return;
    statKey = key;
    el.stat.innerHTML = chips.map(function (c) {
      if (c[0] === 'live') return '<span class="chip"><i class="dot live"></i>' + esc(c[1]) + '</span>';
      return '<span class="chip' + (c[0] ? ' ' + c[0] : '') + '">' + esc(c[1]) + '</span>';
    }).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── 시트 열고 닫기 ───────────────────────────────────────── */
  function open(v) {
    view = v;
    el.sheet.classList.add('open');
    el.stage.classList.add('sheet');
    lastPaint = 0;
    paint(App.state, true);
  }
  function close() {
    view = null;
    el.sheet.classList.remove('open');
    el.stage.classList.remove('sheet');
    /* 숨어 있던 스코프가 다시 나오므로 캔버스 크기를 잡아 준다 */
    if (typeof Render !== 'undefined') Render.resize();
  }
  function toggle(v) { if (view === v) close(); else open(v); }
  function current() { return view; }

  /* ── 그리기 ───────────────────────────────────────────────── */
  function paint(app, force) {
    if (!view) return;
    var now = performance.now();
    if (!force && now - lastPaint < 220) return;      // 목록·상세는 초당 4~5회면 충분하다
    lastPaint = now;
    if (view === 'list') paintList(app);
    else if (view === 'detail') paintDetail(app);
    else if (view === 'settings' && force) paintSettings(app);
  }

  /* ── 목록 ─────────────────────────────────────────────────── */
  function paintList(app) {
    el.title.textContent = '주변 항공기';
    el.tools.innerHTML =
      '<div class="seg" id="sortSeg">' +
      '<button data-k="dist"' + (sortBy === 'dist' ? ' class="on"' : '') + '>가까운 순</button>' +
      '<button data-k="alt"' + (sortBy === 'alt' ? ' class="on"' : '') + '>낮은 순</button></div>';
    el.tools.querySelector('#sortSeg').onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      sortBy = b.dataset.k; paint(app, true);
    };

    var list = app.list.slice();
    if (sortBy === 'alt') list.sort(function (a, b) { return (a.altFt || 0) - (b.altFt || 0); });

    if (!list.length) {
      el.body.innerHTML = '<div class="empty">' +
        (Position.state.ok
          ? '조회 반경 안에 항공기가 없습니다.<br>설정에서 반경을 넓히거나 고도 필터를 확인해 보세요.'
          : '위치를 먼저 확인해야 주변 항공기를 찾을 수 있습니다.') + '</div>';
      return;
    }

    var m = app.metric, html = '';
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var f = Catalog.flight(a.cs);
      var tn = Catalog.typeName(a.type);
      var sub = [f ? f.airline + ' ' + f.number : null, tn, a.reg].filter(Boolean).join(' · ');
      html +=
        '<div class="row' + (app.selected === a.id ? ' sel' : '') + '" data-id="' + esc(a.id) + '">' +
          '<div class="glyph" style="color:' + Render.altColor(a.altFt) + '">' + glyphSvg(a.relTrack) + '</div>' +
          '<div style="min-width:0">' +
            '<div class="cs">' + esc(a.cs || a.reg || a.id.toUpperCase()) + '</div>' +
            '<div class="sub">' + esc(sub || '정보 없음') + '</div>' +
          '</div>' +
          '<div class="rt"><b>' + esc(Geo.fmtDist(a.slantM, m)) + '</b>' +
            esc(Geo.fmtAlt(a.altFt, m)) + '<br>' +
            esc(Geo.fmtAz(a.az) + ' ' + Geo.compass(a.az)) + '</div>' +
        '</div>';
    }
    el.body.innerHTML = html;
    el.body.onclick = function (e) {
      var r = e.target.closest('.row'); if (!r) return;
      App.select(r.dataset.id);
      open('detail');
    };
  }

  function glyphSvg(rel) {
    var r = rel != null ? rel : 0;
    return '<svg width="20" height="20" viewBox="-12 -12 24 24" style="transform:rotate(' + r.toFixed(0) + 'deg)">' +
      '<path fill="currentColor" d="M0-10 1.8-3 10 1.4 10 3.6 1.6 2.2 1.4 6.2 4.2 8.6 4.2 9.8 0 8.2 -4.2 9.8 -4.2 8.6 -1.4 6.2 -1.6 2.2 -10 3.6 -10 1.4 -1.8-3Z"/></svg>';
  }

  /* ── 상세 ─────────────────────────────────────────────────── */
  function paintDetail(app) {
    var a = app.byId(app.selected);
    if (!a) {
      el.title.textContent = '항공기';
      el.tools.innerHTML = '';
      el.body.innerHTML = '<div class="empty">선택한 항공기가 수신 범위를 벗어났습니다.</div>';
      return;
    }
    var m = app.metric;
    var f = Catalog.flight(a.cs);
    var tn = Catalog.typeName(a.type);
    var country = a.country || Catalog.country(a.reg, a.id);
    var sq = Catalog.squawk(a.squawk);
    var fl = Geo.flightLevel(a.altFt);

    el.title.textContent = '항공기 상세';
    el.tools.innerHTML = '<button class="btn" id="bBack">목록</button>';
    el.tools.querySelector('#bBack').onclick = function () { open('list'); };

    /* 어디를 봐야 하는지 — 지금 보는 방향과의 차이 */
    var o = Orient.state;
    var dAz = Geo.norm180(a.az - o.heading);
    var dEl = a.el - o.pitch;
    var guide;
    if (Math.abs(dAz) < 6 && Math.abs(dEl) < 6) guide = '화면 한가운데에 있습니다';
    else {
      var g = [];
      if (Math.abs(dAz) >= 6) g.push((dAz > 0 ? '오른쪽으로 ' : '왼쪽으로 ') + Math.round(Math.abs(dAz)) + '°');
      if (Math.abs(dEl) >= 6) g.push((dEl > 0 ? '위로 ' : '아래로 ') + Math.round(Math.abs(dEl)) + '°');
      guide = g.join(', ');
    }

    var cells = [
      ['고도', Geo.fmtAlt(a.altFt, m) + (fl ? '<small>' + fl + '</small>' : '')],
      ['거리', Geo.fmtDist(a.slantM, m)],
      ['방위', Geo.fmtAz(a.az) + '<small>' + Geo.compass(a.az) + '</small>'],
      ['고각', a.el.toFixed(1) + '°'],
      ['속도', Geo.fmtSpd(a.gs, m)],
      ['기수', a.track != null ? Geo.fmtAz(a.track) : '—'],
      ['상승·하강', Geo.fmtVs(a.vsFpm, m)],
      ['지표 거리', Geo.fmtDist(a.distM, m)],
      ['스쿼크', a.squawk || '—'],
      ['수신 지연', Geo.fmtAge(a.age)]
    ];

    var meta = [f ? f.airline + ' ' + f.number + '편' : null, tn, a.reg, country]
      .filter(Boolean).join(' · ');

    el.body.innerHTML =
      '<div class="dhead">' +
        '<div class="glyph" style="color:' + Render.altColor(a.altFt) + ';width:34px;height:34px">' +
          glyphSvg(a.relTrack) + '</div>' +
        '<div style="min-width:0"><div class="cs">' + esc(a.cs || a.reg || a.id.toUpperCase()) + '</div>' +
        '<div class="meta">' + esc(meta || 'ICAO ' + a.id.toUpperCase()) + '</div></div>' +
      '</div>' +
      (sq ? '<div style="margin-top:10px" class="chip bad">' + esc(sq.t) + '</div>' : '') +
      (a.emg ? '<div style="margin-top:10px" class="chip bad">비상 신호: ' + esc(a.emg) + '</div>' : '') +
      '<div style="margin-top:11px;padding:9px 11px;border-radius:8px;background:rgba(111,216,255,.10);' +
        'border:1px solid rgba(111,216,255,.28);font-size:12.5px;color:#BFEEFF">⌖ ' + esc(guide) + '</div>' +
      '<div class="dgrid">' + cells.map(function (c) {
        return '<div class="cell"><k>' + esc(c[0]) + '</k><v>' + c[1] + '</v></div>';
      }).join('') + '</div>' +
      '<div style="margin-top:12px;font-size:11px;color:var(--ink-3);line-height:1.6">' +
        'ICAO 24bit ' + esc(a.id.toUpperCase()) +
        (a.cat ? ' · ' + esc(Catalog.category(a.cat) || a.cat) : '') +
        ' · 출처 ' + esc(Source.state.providerName) +
      '</div>';
  }

  /* ── 설정 ─────────────────────────────────────────────────── */
  function paintSettings(app) {
    el.title.textContent = '설정';
    el.tools.innerHTML = '';
    var c = app.cfg;

    function row(lab, hint, ctl, cls) {
      return '<div class="fld' + (cls ? ' ' + cls : '') + '"><div class="lab"><b>' + lab + '</b>' +
        (hint ? '<i>' + hint + '</i>' : '') + '</div><div class="ctl">' + ctl + '</div></div>';
    }
    function slider(id, min, max, step, val, unit) {
      return '<input type="range" id="' + id + '" min="' + min + '" max="' + max +
        '" step="' + step + '" value="' + val + '"><span class="val" id="' + id + 'V">' +
        val + (unit || '') + '</span>';
    }
    function sw(id, on) {
      return '<label class="sw"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '><i></i></label>';
    }

    el.body.innerHTML =
      '<div class="sechead">보기</div>' +
      row('단위', '거리·고도·속도 표기', '<div class="seg" id="unitSeg">' +
        '<button data-v="1"' + (c.metric ? ' class="on"' : '') + '>미터법</button>' +
        '<button data-v="0"' + (!c.metric ? ' class="on"' : '') + '>항공 단위</button></div>') +
      row('카메라', '끄면 인공 지평선 위에 그립니다', sw('setCam', c.camera)) +
      row('레이더 기준', '스코프 위쪽을 무엇에 맞출지', '<div class="seg" id="upSeg">' +
        '<button data-v="0"' + (!c.headingUp ? ' class="on"' : '') + '>노스업</button>' +
        '<button data-v="1"' + (c.headingUp ? ' class="on"' : '') + '>헤딩업</button></div>') +
      row('접근 알림음', '10 km 안으로 새 항공기가 들어오면 울립니다', sw('setChime', c.chime)) +

      '<div class="sechead">보정</div>' +
      row('카메라 화각', '화면 속 항공기가 실제보다 안쪽/바깥쪽에 있으면 조절하세요',
        slider('setFov', 25, 120, 1, Math.round(c.fov), '°'), 'col') +
      row('방위 보정', '나침반이 틀어져 있을 때 좌우로 밉니다',
        slider('setOff', -45, 45, 1, Math.round(c.headingOffset), '°'), 'col') +

      '<div class="sechead">표시 범위</div>' +
      row('표시 거리', '이보다 먼 항공기는 화면에 그리지 않습니다',
        slider('setMax', 10, 250, 5, Math.round(c.maxNm), ' NM'), 'col') +
      row('최저 고도', '지상 차량과 저고도 잡음을 걸러 냅니다',
        slider('setMinAlt', 0, 20000, 500, Math.round(c.minAltFt), ' ft'), 'col') +
      row('스코프 범위', '레이더 바깥 링까지의 거리',
        slider('setScope', 5, 250, 5, Math.round(c.scopeNm), ' NM'), 'col') +

      '<div class="sechead">데이터</div>' +
      row('조회 반경', '서버에 요청하는 범위. 넓을수록 응답이 커집니다',
        slider('setRadius', 20, 250, 10, Math.round(c.radiusNm), ' NM'), 'col') +
      row('갱신 주기', '', slider('setIval', 3, 30, 1, Math.round(c.intervalMs / 1000), ' 초'), 'col') +
      row('공급자', '현재 ' + esc(Source.state.providerName) + ' 사용 중',
        '<select id="setProv" style="height:32px;background:var(--panel-2);border:1px solid var(--line);' +
        'border-radius:7px;padding:0 8px">' +
        Source.PROVIDERS.map(function (p, i) {
          return '<option value="' + i + '"' + (i === Source.state.provider ? ' selected' : '') + '>' + esc(p.name) + '</option>';
        }).join('') + '</select>') +
      row('데모 모드', '실제 수신 대신 가상의 항공기를 띄웁니다', sw('setDemo', c.demo)) +

      '<div style="margin-top:16px;font-size:11px;color:var(--ink-3);line-height:1.65">' +
      '위치와 카메라 영상은 이 기기 밖으로 나가지 않습니다. 서버에는 조회할 좌표 범위만 보냅니다. ' +
      '항공기 위치는 공개 ADS-B 수신망에서 오며 수 초의 지연과 누락이 있습니다. 항행이나 관제 목적으로 쓸 수 없습니다.</div>';

    bindSettings(app);
  }

  function bindSettings(app) {
    var c = app.cfg;
    function seg(id, fn) {
      var n = document.getElementById(id); if (!n) return;
      n.onclick = function (e) {
        var b = e.target.closest('button'); if (!b) return;
        [].forEach.call(n.children, function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        fn(b.dataset.v === '1');
      };
    }
    function rng(id, unit, fn) {
      var n = document.getElementById(id), v = document.getElementById(id + 'V');
      if (!n) return;
      n.oninput = function () { v.textContent = n.value + unit; fn(parseFloat(n.value)); };
    }
    function chk(id, fn) {
      var n = document.getElementById(id); if (!n) return;
      n.onchange = function () { fn(n.checked); };
    }

    seg('unitSeg', function (v) { c.metric = v; App.save(); });
    seg('upSeg', function (v) { c.headingUp = v; App.save(); });
    chk('setCam', function (v) { App.setCamera(v); });
    chk('setChime', function (v) { c.chime = v; App.save(); });
    chk('setDemo', function (v) { c.demo = v; Source.setDemo(v); App.save(); toast(v ? '데모 항공기를 띄웁니다' : '실제 수신으로 돌아갑니다'); });
    rng('setFov', '°', function (v) { c.fov = v; View.setFov(v); App.save(); });
    rng('setOff', '°', function (v) { c.headingOffset = v; Orient.setOffset(v); App.save(); });
    rng('setMax', ' NM', function (v) { c.maxNm = v; App.save(); });
    rng('setMinAlt', ' ft', function (v) { c.minAltFt = v; App.save(); });
    rng('setScope', ' NM', function (v) { c.scopeNm = v; App.save(); });
    rng('setRadius', ' NM', function (v) { c.radiusNm = v; Source.setRadius(v); App.save(); });
    rng('setIval', ' 초', function (v) { c.intervalMs = v * 1000; Source.setInterval(v * 1000); App.save(); });
    var p = document.getElementById('setProv');
    if (p) p.onchange = function () { Source.setProvider(parseInt(p.value, 10)); App.save(); };
  }

  return { init: init, toast: toast, status: status, open: open, close: close,
           toggle: toggle, current: current, paint: paint, esc: esc };
})();
