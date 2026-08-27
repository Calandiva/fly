/* ── 42-route.js — 편명으로 출발·도착 공항 찾기 ───────────────────
   항공기 위치 피드에는 항로가 없다. adsb.lol 의 routeset 로 편명을
   한꺼번에 물어보고 세션 내내 캐시한다.

   본 기능과 완전히 분리해 둔다 — 이 조회가 죽어도 AR 화면은 그대로
   돌아가야 하고, 몇 번 연속 실패하면 스스로 물러난다.
   ---------------------------------------------------------------- */
'use strict';

var Route = (function () {
  var URL = 'https://api.adsb.lol/api/0/routeset';
  var BATCH = 60;             // 한 번에 물어볼 편명 수
  var MIN_GAP = 20000;        // 조회 간격
  var GIVE_UP = 3;            // 연속 실패 허용 횟수

  var cache = Object.create(null);   // 편명 → 항로 | null(모름)
  var pending = Object.create(null); // 조회 중인 편명
  var st = { on: true, fails: 0, off: false, last: 0, hits: 0, asked: 0, err: null };

  function get(cs) {
    if (!cs) return null;
    var v = cache[cs.trim().toUpperCase()];
    return v || null;                 // null 은 "물어봤는데 모름" 도 겸한다
  }
  function known(cs) {
    return cs ? Object.prototype.hasOwnProperty.call(cache, cs.trim().toUpperCase()) : false;
  }

  /* 응답 모양이 바뀌어도 조용히 빈손으로 끝나게 방어적으로 읽는다 */
  function parse(row) {
    if (!row || typeof row !== 'object') return null;
    var cs = (row.callsign || '').trim().toUpperCase();
    if (!cs) return null;

    var codes = [];
    var s = row._airport_codes_iata || row.airport_codes || '';
    if (typeof s === 'string' && s.indexOf('-') > 0) {
      codes = s.split('-').map(function (x) { return x.trim().toUpperCase(); })
                .filter(function (x) { return /^[A-Z0-9]{3,4}$/.test(x); });
    }

    var ports = Array.isArray(row._airports) ? row._airports : [];
    function port(i) {
      var a = ports[i], code = codes[i] || (a && (a.iata || a.icao)) || null;
      if (!code) return null;
      code = String(code).toUpperCase();
      return {
        code: code,
        ko: Catalog.airport(code),
        name: (a && (a.name || a.location)) || null,
        country: (a && a.countryiso2) || null,
        lat: a && typeof a.lat === 'number' ? a.lat : null,
        lon: a && typeof a.lon === 'number' ? a.lon : null
      };
    }

    var n = Math.max(codes.length, ports.length);
    if (n < 2) return null;
    var from = port(0), to = port(n - 1);
    if (!from || !to) return null;

    var via = [];
    for (var i = 1; i < n - 1; i++) { var v = port(i); if (v) via.push(v); }

    return {
      cs: cs, from: from, to: to, via: via,
      plausible: row.plausible === undefined ? 1 : row.plausible
    };
  }

  /* 사람이 읽을 이름 — 한글 이름이 있으면 그쪽, 없으면 원문, 없으면 코드 */
  function label(p) { return p ? (p.ko || p.name || p.code) : '—'; }

  /* "인천 → 로스앤젤레스" */
  function text(r) {
    if (!r) return null;
    var mid = r.via.length ? ' → ' + r.via.map(label).join(' → ') : '';
    return label(r.from) + mid + ' → ' + label(r.to);
  }

  /* 아직 모르는 편명을 모아 한 번에 물어본다. 화면에 보이는 것부터. */
  function pump(list) {
    if (!st.on || st.off) return;
    var now = Date.now();
    if (now - st.last < MIN_GAP) return;

    var want = [];
    for (var i = 0; i < list.length && want.length < BATCH; i++) {
      var a = list[i];
      var cs = a.cs && a.cs.trim().toUpperCase();
      if (!cs || cs.length < 4) continue;
      if (known(cs) || pending[cs]) continue;
      /* 편명 모양이 아니면(등록기호 등) 항로가 있을 리 없다 */
      if (!/^[A-Z]{3}[0-9]/.test(cs)) { cache[cs] = null; continue; }
      want.push({ callsign: cs, lat: a.dlat, lng: a.dlon });
    }
    if (!want.length) return;

    st.last = now;
    st.asked += want.length;
    want.forEach(function (w) { pending[w.callsign] = 1; });

    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) try { ctl.abort(); } catch (e) {} }, 12000);

    fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ planes: want }),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      clearTimeout(to);
      var rows = Array.isArray(json) ? json : (json && Array.isArray(json.routes) ? json.routes : []);
      for (var i = 0; i < rows.length; i++) {
        var r = parse(rows[i]);
        if (r) { cache[r.cs] = r; st.hits++; }
      }
      /* 답이 안 온 편명은 "모름" 으로 못박아 다시 묻지 않는다 */
      want.forEach(function (w) {
        if (!Object.prototype.hasOwnProperty.call(cache, w.callsign)) cache[w.callsign] = null;
        delete pending[w.callsign];
      });
      st.fails = 0; st.err = null;
    }).catch(function (e) {
      clearTimeout(to);
      want.forEach(function (w) { delete pending[w.callsign]; });
      st.fails++;
      st.err = (e && e.message) || '항로 조회 실패';
      if (st.fails >= GIVE_UP) st.off = true;     // 조용히 물러난다
    });
  }

  function setOn(v) {
    st.on = !!v;
    if (v) { st.off = false; st.fails = 0; st.last = 0; }
  }
  function reset() {
    for (var k in cache) delete cache[k];
    st.hits = 0; st.asked = 0; st.fails = 0; st.off = false; st.last = 0;
  }

  return { state: st, get: get, known: known, text: text, label: label,
           pump: pump, setOn: setOn, reset: reset, _parse: parse, _cache: cache };
})();
