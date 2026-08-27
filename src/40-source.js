/* ── 40-source.js — ADS-B 수신과 추측항법 ────────────────────────
   공개 피드는 몇 초에 한 번만 갱신되지만 화면은 60fps 로 움직인다.
   그래서 마지막 관측을 속도·기수·상승률로 앞당겨 계산(추측항법)하고,
   새 관측이 오면 튀지 않도록 표시 위치를 그쪽으로 서서히 끌어당긴다.
   ---------------------------------------------------------------- */
'use strict';

var Source = (function () {

  /* ── 공급자 ────────────────────────────────────────────────
     앞의 것부터 시도하고, 실패하면 다음으로 넘어가 그 자리를 기억한다. */
  var PROVIDERS = [
    { id: 'adsb.lol', name: 'adsb.lol', kind: 'readsb', max: 250,
      url: function (la, lo, nm) { return 'https://api.adsb.lol/v2/lat/' + la.toFixed(4) + '/lon/' + lo.toFixed(4) + '/dist/' + nm; } },
    { id: 'adsb.fi', name: 'adsb.fi', kind: 'readsb', max: 250,
      url: function (la, lo, nm) { return 'https://opendata.adsb.fi/api/v2/lat/' + la.toFixed(4) + '/lon/' + lo.toFixed(4) + '/dist/' + nm; } },
    { id: 'airplanes.live', name: 'airplanes.live', kind: 'readsb', max: 250,
      url: function (la, lo, nm) { return 'https://api.airplanes.live/v2/point/' + la.toFixed(4) + '/' + lo.toFixed(4) + '/' + nm; } },
    { id: 'opensky', name: 'OpenSky', kind: 'opensky', max: 400,
      url: function (la, lo, nm) {
        var b = Geo.degBox(la, Geo.nmToM(nm));
        return 'https://opensky-network.org/api/states/all?lamin=' + (la - b.dLat).toFixed(4) +
               '&lomin=' + (lo - b.dLon).toFixed(4) + '&lamax=' + (la + b.dLat).toFixed(4) +
               '&lomax=' + (lo + b.dLon).toFixed(4);
      } }
  ];

  var st = {
    provider: 0, providerName: PROVIDERS[0].name,
    demo: false, live: false,
    lastOk: 0, lastTry: 0, lastErr: null, fails: 0,
    count: 0, fetching: false, latency: 0,
    tIngest: 0, tSolved: 0
  };

  var fleet = Object.create(null);     // id → 항공기
  var subs = [];
  var timer = null, ctl = null;
  var cfg = { radiusNm: 120, intervalMs: 6000, maxAgeMs: 75000 };

  function on(f) { subs.push(f); }
  function emit() { for (var i = 0; i < subs.length; i++) subs[i](fleet, st); }

  /* ── 응답 정규화 ──────────────────────────────────────────── */

  function numOr(v, d) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : d;
  }

  /* fetch 가 주는 영문 사유를 화면에 그대로 띄우면 무슨 일인지 알 수 없다 */
  function errText(e) {
    if (!e) return '수신 실패';
    if (e.name === 'AbortError') return '응답 없음 — 요청 취소';
    var m = String(e.message || '');
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '수신 실패 — 네트워크';
    var http = m.match(/HTTP (\d+)/);
    if (http) {
      var c = http[1];
      if (c === '429') return '요청이 너무 잦습니다 — 주기를 늘려 보세요';
      if (c[0] === '5') return '공급자 서버 오류 (' + c + ')';
      return '수신 거부 (' + c + ')';
    }
    return '수신 실패';
  }

  function normReadsb(json, nowMs) {
    var list = json.ac || json.aircraft || [];
    var srvNow = numOr(json.now, nowMs);
    if (srvNow < 1e12) srvNow *= 1000;                  // 초 단위로 준 경우
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var lat = numOr(a.lat, null), lon = numOr(a.lon, null);
      if (lat == null || lon == null) continue;
      var ground = a.alt_baro === 'ground' || a.alt_geom === 'ground';
      var baro = ground ? 0 : numOr(a.alt_baro, null);
      var geom = ground ? 0 : numOr(a.alt_geom, null);
      var seen = numOr(a.seen_pos, numOr(a.seen, 0));
      out.push({
        id: String(a.hex || a.r || i).toLowerCase().replace('~', ''),
        cs: (a.flight || '').trim() || null,
        reg: a.r || null,
        type: a.t || null,
        desc: a.desc || null,
        cat: a.category || null,
        lat: lat, lon: lon,
        altFt: geom != null ? geom : baro,               // 기하고도가 있으면 그쪽이 실제 높이에 가깝다
        baroFt: baro,
        gs: numOr(a.gs, null),
        track: numOr(a.track, numOr(a.mag_heading, null)),
        vsFpm: numOr(a.geom_rate, numOr(a.baro_rate, null)),
        squawk: a.squawk || null,
        ground: ground,
        emg: (a.emergency && a.emergency !== 'none') ? a.emergency : null,
        tPos: srvNow - seen * 1000
      });
    }
    return out;
  }

  function normOpenSky(json, nowMs) {
    var rows = json.states || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i];
      if (s[5] == null || s[6] == null) continue;
      var baroM = s[7], geoM = s[13];
      var altM = (geoM != null ? geoM : baroM);
      out.push({
        id: String(s[0] || i).toLowerCase(),
        cs: (s[1] || '').trim() || null,
        reg: null, type: null, desc: null, cat: null,
        lat: s[6], lon: s[5],
        altFt: altM != null ? Geo.mToFt(altM) : null,
        baroFt: baroM != null ? Geo.mToFt(baroM) : null,
        gs: s[9] != null ? s[9] / Geo.KT : null,
        track: s[10],
        vsFpm: s[11] != null ? Geo.mToFt(s[11]) * 60 : null,
        squawk: s[14] || null,
        ground: !!s[8],
        emg: null,
        country: s[2] || null,
        tPos: (s[3] != null ? s[3] : s[4]) * 1000
      });
    }
    return out;
  }

  /* ── 함대 갱신 ────────────────────────────────────────────── */

  function ingest(rows, nowMs) {
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.id) continue;
      seen[r.id] = 1;
      var a = fleet[r.id];
      if (!a) {
        a = fleet[r.id] = {
          id: r.id, first: nowMs,
          dlat: r.lat, dlon: r.lon, daltFt: r.altFt || 0   // 표시 위치 초기값
        };
      }
      /* 관측값 덮어쓰기 — 다만 빈 값으로 기존 정보를 지우지는 않는다 */
      a.cs = r.cs || a.cs; a.reg = r.reg || a.reg; a.type = r.type || a.type;
      a.desc = r.desc || a.desc; a.cat = r.cat || a.cat; a.country = r.country || a.country;
      a.lat = r.lat; a.lon = r.lon;
      a.altFt = r.altFt != null ? r.altFt : a.altFt;
      a.baroFt = r.baroFt != null ? r.baroFt : a.baroFt;
      a.gs = r.gs != null ? r.gs : a.gs;
      a.track = r.track != null ? r.track : a.track;
      a.vsFpm = r.vsFpm != null ? r.vsFpm : a.vsFpm;
      a.squawk = r.squawk || a.squawk;
      a.emg = r.emg || null;
      a.ground = r.ground;
      a.tPos = r.tPos || nowMs;
      a.tSeen = nowMs;
    }
    /* 오래된 것 정리 */
    for (var k in fleet) {
      if (!seen[k] && nowMs - (fleet[k].tSeen || 0) > cfg.maxAgeMs) delete fleet[k];
    }
    st.count = Object.keys(fleet).length;
    st.tIngest = nowMs;
  }

  /* ── 조회 ─────────────────────────────────────────────────── */

  function fetchOnce() {
    var p = Position.state;
    if (!p.ok || st.demo) return Promise.resolve();
    if (st.fetching) return Promise.resolve();
    st.fetching = true; st.lastTry = Date.now();

    var prov = PROVIDERS[st.provider];
    var nm = Math.min(prov.max, Math.max(5, Math.round(cfg.radiusNm)));
    var url = prov.url(p.lat, p.lon, nm);
    var t0 = performance.now();

    if (ctl) try { ctl.abort(); } catch (e) {}
    ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeout = setTimeout(function () { if (ctl) try { ctl.abort(); } catch (e) {} }, 12000);

    return fetch(url, { signal: ctl ? ctl.signal : undefined, cache: 'no-store',
                        headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (json) {
        clearTimeout(timeout);
        var now = Date.now();
        st.latency = Math.round(performance.now() - t0);
        ingest(prov.kind === 'opensky' ? normOpenSky(json, now) : normReadsb(json, now), now);
        st.lastOk = now; st.lastErr = null; st.fails = 0; st.live = true;
        st.providerName = prov.name;
        emit();
      })
      .catch(function (e) {
        clearTimeout(timeout);
        st.fails++;
        st.lastErr = errText(e);
        /* 두 번 연속 실패하면 다음 공급자로 */
        if (st.fails >= 2 && PROVIDERS.length > 1) {
          st.provider = (st.provider + 1) % PROVIDERS.length;
          st.providerName = PROVIDERS[st.provider].name;
          st.fails = 0;
        }
        if (Date.now() - st.lastOk > cfg.maxAgeMs) st.live = false;
        emit();
      })
      .then(function () { st.fetching = false; });
  }

  function start() {
    stop();
    if (st.demo) { Demo.start(); return; }
    fetchOnce();
    timer = setInterval(function () {
      if (st.demo) return;
      if (document.hidden) return;             // 화면이 꺼져 있으면 조회하지 않는다
      fetchOnce();
    }, cfg.intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    Demo.stop();
  }

  function setDemo(v) {
    st.demo = !!v;
    for (var k in fleet) delete fleet[k];
    st.count = 0;
    start();
  }

  function setProvider(i) {
    st.provider = ((i % PROVIDERS.length) + PROVIDERS.length) % PROVIDERS.length;
    st.providerName = PROVIDERS[st.provider].name;
    st.fails = 0;
    if (!st.demo) fetchOnce();
  }

  function setRadius(nm) { cfg.radiusNm = nm; }
  function setInterval_(ms) {
    cfg.intervalMs = Math.max(3000, ms);
    if (timer) start();
  }

  /* ── 추측항법 + 관측자 기준 기하 ──────────────────────────────
     매 프레임 호출한다. 반환은 거리 순으로 정렬된 가시 목록. */
  function advance(nowMs, dt) {
    var p = Position.state;
    var out = [];
    var pull = 1 - Math.exp(-3.2 * Math.max(0.001, Math.min(0.5, dt)));   // 새 관측으로 끌어당기는 정도

    for (var k in fleet) {
      var a = fleet[k];
      if (a.lat == null) continue;

      /* 마지막 관측을 지금 시각까지 앞당긴다 */
      var age = Math.max(0, (nowMs - (a.tPos || nowMs)) / 1000);
      var tlat = a.lat, tlon = a.lon;
      if (a.gs > 5 && a.track != null && age > 0 && age < 300) {
        var d = Geo.ktToMps(a.gs) * age;
        var q = Geo.destination(a.lat, a.lon, a.track, d);
        tlat = q.lat; tlon = q.lon;
      }
      var talt = (a.altFt || 0) + (a.vsFpm ? (a.vsFpm / 60) * Math.min(age, 120) : 0);

      /* 튐 없이 따라가기 */
      if (a.dlat == null) { a.dlat = tlat; a.dlon = tlon; a.daltFt = talt; }
      a.dlat += (tlat - a.dlat) * pull;
      a.dlon += Geo.norm180(tlon - a.dlon) * pull;
      a.daltFt += (talt - a.daltFt) * pull;
      a.age = age;

      if (!p.ok) continue;

      /* 관측자 기준 방위·고각·거리 */
      var ground = Geo.haversine(p.lat, p.lon, a.dlat, a.dlon);
      var dh = Geo.ftToM(a.daltFt || 0) - (p.alt || 0);
      a.distM = ground;
      a.az = Geo.bearing(p.lat, p.lon, a.dlat, a.dlon);
      a.el = Geo.elevation(ground, dh);
      a.slantM = Geo.slant(ground, dh);
      /* 관측자에서 본 상대 기수 — 마커 글리프를 돌리는 데 쓴다 */
      a.relTrack = a.track != null ? Geo.norm360(a.track - a.az) : null;
      out.push(a);
    }
    out.sort(function (x, y) { return x.slantM - y.slantM; });

    /* 궤적과 최근접 통과는 관측이 갱신됐을 때만 다시 푼다.
       입력이 그대로인데 매 프레임 푸는 건 낭비다. */
    if (st.tIngest && st.tIngest !== st.tSolved) {
      st.tSolved = st.tIngest;
      Track.update(fleet, nowMs);
    }
    return out;
  }

  return {
    state: st, fleet: fleet, cfg: cfg, PROVIDERS: PROVIDERS,
    on: on, start: start, stop: stop, fetchOnce: fetchOnce, advance: advance,
    setDemo: setDemo, setProvider: setProvider, setRadius: setRadius,
    setInterval: setInterval_,
    _ingest: ingest, _normReadsb: normReadsb, _normOpenSky: normOpenSky
  };
})();
