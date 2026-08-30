/* ── 40-source.js — ADS-B 수신과 추측항법 ────────────────────────
   공개 피드는 몇 초에 한 번만 갱신되지만 화면은 60fps 로 움직인다.
   그래서 마지막 관측을 속도·기수·상승률로 앞당겨 계산(추측항법)하고,
   새 관측이 오면 튀지 않도록 표시 위치를 그쪽으로 서서히 끌어당긴다.
   ---------------------------------------------------------------- */
'use strict';

var Source = (function () {

  /* ── 공급자 ────────────────────────────────────────────────
     앞의 것부터 시도하고, 실패하면 다음으로 넘어가 그 자리를 기억한다.

     공개 ADS-B API 는 주소와 정책이 자주 바뀐다. 여기 적힌 주소가 언제까지
     살아 있을지 보장할 수 없으므로, 연결 점검이 아래 CANDIDATES 를 실제로
     찔러 보고 되는 것을 골라 쓰게 해 둔다. 마지막 수단으로 직접 주소를
     넣을 수도 있다. */
  var custom = { url: '', kind: 'readsb' };

  function fillUrl(tpl, la, lo, nm) {
    return String(tpl)
      .replace(/\{lat\}/g, la.toFixed(4))
      .replace(/\{lon\}/g, lo.toFixed(4))
      .replace(/\{nm\}/g, String(nm))
      .replace(/\{km\}/g, String(Math.round(nm * 1.852)));
  }

  function boxUrl(tpl, la, lo, nm) {
    var b = Geo.degBox(la, Geo.nmToM(nm));
    return fillUrl(tpl, la, lo, nm)
      .replace(/\{lamin\}/g, (la - b.dLat).toFixed(4))
      .replace(/\{lamax\}/g, (la + b.dLat).toFixed(4))
      .replace(/\{lomin\}/g, (lo - b.dLon).toFixed(4))
      .replace(/\{lomax\}/g, (lo + b.dLon).toFixed(4));
  }

  /* 공급자 = 후보 주소 하나. 어느 것이 지금 살아 있는지는 네트워크가 있는
     기기에서만 알 수 있으므로 목록으로 두고 앱이 직접 찾아 쓰게 한다. */
  var PROVIDERS = [
    /* 같은 출처 중계를 먼저 본다. 공개 ADS-B API 는 대부분 CORS 헤더를 주지
       않아 브라우저에서 직접 부르면 막힌다 — 주소가 틀려서가 아니라 구조가
       그렇다. 이 배포본에 api/adsb 함수가 있으면 그쪽이 정답이다.
       (정적 호스팅이면 404 가 나고 아래 주소들로 넘어간다.) */
    { id: 'self',      name: '이 사이트 중계', note: 'api/adsb',  kind: 'readsb',  max: 250,
      tpl: '/api/adsb?lat={lat}&lon={lon}&nm={nm}' },
    { id: 'lol-lat',   name: 'adsb.lol',       note: 'v2/lat',    kind: 'readsb',  max: 250,
      tpl: 'https://api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{nm}' },
    { id: 'lol-point', name: 'adsb.lol',       note: 'v2/point',  kind: 'readsb',  max: 250,
      tpl: 'https://api.adsb.lol/v2/point/{lat}/{lon}/{nm}' },
    { id: 'lol-api0',  name: 'adsb.lol',       note: 'api/0',     kind: 'readsb',  max: 250,
      tpl: 'https://api.adsb.lol/api/0/lat/{lat}/lon/{lon}/dist/{nm}' },
    { id: 'fi-open',   name: 'adsb.fi',        note: 'opendata',  kind: 'readsb',  max: 250,
      tpl: 'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}' },
    { id: 'fi-api',    name: 'adsb.fi',        note: 'api',       kind: 'readsb',  max: 250,
      tpl: 'https://api.adsb.fi/v2/lat/{lat}/lon/{lon}/dist/{nm}' },
    { id: 'live-v2',   name: 'airplanes.live', note: 'v2/point',  kind: 'readsb',  max: 250,
      tpl: 'https://api.airplanes.live/v2/point/{lat}/{lon}/{nm}' },
    { id: 'live-rest', name: 'airplanes.live', note: 'rest',      kind: 'readsb',  max: 250,
      tpl: 'https://rest.airplanes.live/point/{lat}/{lon}/{nm}' },
    { id: 'opensky',   name: 'OpenSky',        note: 'states',    kind: 'opensky', max: 400,
      tpl: 'https://opensky-network.org/api/states/all?lamin={lamin}&lomin={lomin}&lamax={lamax}&lomax={lomax}' },
    { id: 'custom',    name: '직접 지정',       note: '',          kind: 'readsb',  max: 250, custom: true, tpl: '' }
  ];

  PROVIDERS.forEach(function (pv) {
    pv.url = function (la, lo, nm) {
      return boxUrl(pv.custom ? custom.url : pv.tpl, la, lo, nm);
    };
    pv.label = pv.name + (pv.note ? ' · ' + pv.note : '');
  });

  var CANDIDATES = PROVIDERS.filter(function (pv) { return !pv.custom; })
    .map(function (pv) {
      /* 도달 확인은 절대 주소일 때만 뜻이 있으므로 호스트를 따로 뽑아 둔다 */
      var m = String(pv.tpl).match(/^https:\/\/([^/]+)/);
      return { host: m ? m[1] : pv.label, kind: pv.kind, tpl: pv.tpl, id: pv.id,
               label: pv.label };
    });

  var st = {
    provider: 0, providerName: PROVIDERS[0].name,
    demo: false, live: false,
    lastOk: 0, lastTry: 0, lastErr: null, fails: 0,
    count: 0, fetching: false, latency: 0,
    tIngest: 0, tSolved: 0,
    everOk: false,          // 이 세션에서 한 번이라도 받아 봤는가
    sweep: 0,               // 주소를 훑어 본 횟수 (한 바퀴 돌면 멈춘다)
    searching: false,
    relayDead: false        // 같은 출처 중계가 404 — 서버 없는 호스팅이다
  };

  /* 페이지 보안 정책(CSP)이 막은 주소. "수신 실패" 가 CORS 인지 CSP 인지
     구분하려면 이 기록이 필요하다 — fetch 는 둘 다 똑같이 TypeError 를 낸다. */
  var cspHits = [];
  function noteCsp(uri) {
    if (uri && cspHits.indexOf(uri) < 0 && cspHits.length < 20) cspHits.push(uri);
  }
  function cspBlocked(url) {
    var host = String(url).replace(/^https?:\/\//, '').split('/')[0];
    for (var i = 0; i < cspHits.length; i++) {
      if (String(cspHits[i]).indexOf(host) >= 0) return true;
    }
    return false;
  }

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
      var hex = String(a.hex || a.r || '').toLowerCase().replace(/^~/, '');
      if (!hex) continue;            // 배열 위치를 식별자로 쓰면 조회마다 정체가 바뀐다
      var ground = a.alt_baro === 'ground' || a.alt_geom === 'ground';
      var baro = ground ? 0 : numOr(a.alt_baro, null);
      var geom = ground ? 0 : numOr(a.alt_geom, null);
      var seen = numOr(a.seen_pos, numOr(a.seen, 0));
      out.push({
        id: hex,
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
      var oid = String(s[0] || '').toLowerCase().trim();
      if (!oid) continue;
      var baroM = s[7], geoM = s[13];
      var altM = (geoM != null ? geoM : baroM);
      out.push({
        id: oid,
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
        st.everOk = true; st.searching = false; st.sweep = 0;
        st.providerName = prov.label;
        if (onFound) onFound(prov);              // 찾은 주소를 기억해 둔다
        emit();
      })
      .catch(function (e) {
        clearTimeout(timeout);
        st.fails++;
        st.lastErr = errText(e);
        if (Date.now() - st.lastOk > cfg.maxAgeMs) st.live = false;

        /* 아직 한 번도 못 받았다면 주소가 틀렸을 가능성이 크다.
           갱신 주기를 기다리지 말고 다음 주소로 곧장 넘어가며 한 바퀴 훑는다.
           설정에 들어가 버튼을 눌러야만 고쳐지는 건 고쳐지는 게 아니다. */
        /* 중계가 404 면 배포가 안 된 것이니 이 세션에서는 접는다.
           그 밖의 실패(시간 초과 등)는 느려서일 수 있으므로 접지 않는다 —
           한 번 늦었다고 세션 내내 버리면 될 것도 안 된다. */
        if (prov.id === 'self') {
          relayDead = st.relayDead = /HTTP 404/.test(String((e && e.message) || ''));
        }

        var usable = PROVIDERS.filter(function (pv) { return !pv.custom || custom.url; }).length;
        /* 빠른 훑기는 한 번만. 한 바퀴 다 실패했는데 6초마다 9곳을 다시
           두드리면 얻는 것 없이 상류만 괴롭힌다. */
        if (!st.everOk && !swept && st.sweep < usable - 1) {
          st.sweep++;
          st.searching = true;
          nextProvider();
          emit();
          st.fetching = false;
          return new Promise(function (r) { setTimeout(r, 400); }).then(fetchOnce);
        }
        /* 한 바퀴를 다 돌았다. 다음 주기부터는 가장 가능성이 큰 곳으로
           되돌아가 계속 두드린다 — 마지막으로 실패한 자리에 눌러앉아
           있어 봐야 얻을 게 없다. */
        if (!st.everOk && !swept && st.sweep >= usable - 1) {
          swept = true;
          st.provider = relayDead ? 1 : 0;
          st.providerName = PROVIDERS[st.provider].label;
          st.sweep = 0;
        }
        st.searching = false;

        /* 이미 받아 본 적이 있으면 두 번 연속 실패했을 때만 옮긴다 */
        if (st.everOk && st.fails >= 2) { nextProvider(); st.fails = 0; }
        emit();
      })
      .then(function () { st.fetching = false; });
  }

  /* 쓸 수 있는 다음 주소로. 직접 지정은 값이 있을 때만 낀다. */
  function nextProvider() {
    for (var n = 1; n <= PROVIDERS.length; n++) {
      var i = (st.provider + n) % PROVIDERS.length;
      if (PROVIDERS[i].custom && !custom.url) continue;
      st.provider = i;
      st.providerName = PROVIDERS[i].label;
      return;
    }
  }

  var onFound = null;
  var relayDead = false;                  // 같은 출처 중계가 404 였는가
  var swept = false;                      // 빠른 훑기를 이미 한 바퀴 돌았는가
  function setOnFound(f) { onFound = f; }

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

  /* 직접 지정 주소. {lat} {lon} {nm} 자리를 채워 쓴다. */
  function setCustom(tpl, kind) {
    custom.url = String(tpl || '').trim();
    custom.kind = kind === 'opensky' ? 'opensky' : 'readsb';
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (PROVIDERS[i].custom) PROVIDERS[i].kind = custom.kind;
    }
  }
  function getCustom() { return { url: custom.url, kind: custom.kind }; }
  function customIndex() {
    for (var i = 0; i < PROVIDERS.length; i++) if (PROVIDERS[i].custom) return i;
    return -1;
  }

  function setProvider(i) {
    st.provider = ((i % PROVIDERS.length) + PROVIDERS.length) % PROVIDERS.length;
    st.providerName = PROVIDERS[st.provider].label;
    st.fails = 0;
    swept = false;                        // 사람이 손댔으면 다시 찾아볼 만하다
    st.sweep = 0;
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

  /* ── 연결 점검 ────────────────────────────────────────────
     "네트워크 실패" 로 뭉뚱그리면 손쓸 데가 없다. 공급자를 하나씩 찔러
     보고 무엇이 막았는지 갈라 준다. 브라우저는 CORS 거부·CSP 차단·주소
     없음을 모두 같은 TypeError 로 주므로 곁의 단서로 구분한다. */
  function why(e, url) {
    if (e && e.name === 'AbortError') return { t: '시간 초과', hint: '10초 안에 응답이 없었습니다' };
    var m = String((e && e.message) || '');
    var http = m.match(/HTTP (\d+)/);
    if (http) {
      var c = http[1];
      if (c === '429') return { t: 'HTTP 429', hint: '요청이 너무 잦습니다 — 갱신 주기를 늘리세요' };
      if (c === '404') return { t: 'HTTP 404', hint: '이 주소가 더는 없습니다 — 공급자 API 가 바뀐 것입니다' };
      if (c === '401' || c === '403') return { t: 'HTTP ' + c, hint: '인증이나 API 키를 요구합니다' };
      if (c[0] === '5') return { t: 'HTTP ' + c, hint: '공급자 서버 쪽 오류입니다' };
      return { t: 'HTTP ' + c, hint: '' };
    }
    if (cspBlocked(url)) {
      return { t: 'CSP 차단', hint: '이 페이지의 보안 정책이 외부 요청을 막습니다. ' +
                                    'Artifact 처럼 정책이 엄격한 곳에서는 동작하지 않습니다' };
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { t: '오프라인', hint: '기기가 네트워크에 연결되어 있지 않습니다' };
    }
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return { t: '연결 실패', hint: '서버에 닿지 못했습니다 — CORS 거부, 없어진 주소, 또는 차단' };
    }
    return { t: '실패', hint: m || '알 수 없는 오류' };
  }

  /* 같은 출처 중계는 사유를 본문에 담아 준다. 상태 코드만 보고 넘기면
     "상류 어디가 왜 안 됐는지" 를 통째로 버리는 셈이다. */
  function selfHint(status, body, text) {
    if (status === 404) {
      return '중계 함수가 배포되지 않았습니다 — 정적 호스팅이거나 api/ 가 함수로 잡히지 않았습니다';
    }
    /* Vercel 의 Deployment Protection 이 켜져 있으면 페이지도 함수도 로그인
       벽 뒤로 들어간다. 브라우저에는 401 이나 로그인 HTML 이 돌아온다. */
    if (status === 401 || status === 403 || isLoginWall(text)) {
      return '배포처에 로그인 보호가 걸려 있습니다 — Vercel 이면 ' +
             'Settings → Deployment Protection 을 끄거나, 보호되지 않는 ' +
             '프로덕션 주소로 여세요';
    }
    if (status === 500) {
      return '중계 함수가 실행 중 죽었습니다 — 배포처의 함수 로그를 확인하세요';
    }
    if (status === 502 && body && body.tried) {
      return '중계는 살아 있는데 상류가 전부 실패했습니다 — ' + body.tried.join(' / ');
    }
    if (body && body.error) return String(body.error);
    return null;
  }

  /* JSON 을 기대했는데 HTML 이 오면 십중팔구 로그인·차단 페이지다 */
  function isLoginWall(text) {
    if (!text) return false;
    var t = String(text).slice(0, 800).toLowerCase();
    if (t.indexOf('<!doctype') < 0 && t.indexOf('<html') < 0) return false;
    return /vercel|authenticat|sign in|log ?in|sso|protection/.test(t);
  }

  function probe(name, url, parse) {
    var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) try { ctl.abort(); } catch (e) {} }, 10000);
    var ms = function () {
      return Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    };
    var isSelf = url.indexOf('/') === 0;
    return fetch(url, { signal: ctl ? ctl.signal : undefined, cache: 'no-store',
                        headers: { 'Accept': 'application/json' } })
      .then(function (res) {
        if (res.ok) {
          /* 200 인데 JSON 이 아닌 경우가 있다 — 로그인 페이지가 그렇다 */
          return res.text().then(function (t) {
            try { return { ok: true, json: JSON.parse(t) }; }
            catch (e) { return { ok: false, status: 200, body: null, text: t }; }
          });
        }
        /* 실패해도 본문을 읽어 본다 — 우리 함수라면 사유가 들어 있다 */
        return res.text().then(function (t) {
          var body = null;
          try { body = JSON.parse(t); } catch (e) {}
          return { ok: false, status: res.status, body: body, text: t };
        }, function () { return { ok: false, status: res.status, body: null, text: '' }; });
      })
      .then(function (r) {
        clearTimeout(to);
        if (r.ok) return { name: name, url: url, ok: true, ms: ms(), n: parse ? parse(r.json) : null };
        var wall = isLoginWall(r.text);
        var w = why(new Error('HTTP ' + r.status), url);
        var hint = (isSelf ? selfHint(r.status, r.body, r.text) : null) ||
                   (wall ? '로그인·차단 페이지가 돌아왔습니다 (JSON 이 아님)' : null) ||
                   (r.body && r.body.error ? String(r.body.error) : null) || w.hint;
        var tag = wall && r.status === 200 ? '로그인 벽' : 'HTTP ' + r.status;
        return { name: name, url: url, ok: false, ms: ms(), t: tag, hint: hint };
      })
      .catch(function (e) {
        clearTimeout(to);
        var w = why(e, url);
        var hint = w.hint;
        if (isSelf && w.t === '연결 실패') {
          hint = '중계 함수에 닿지 못했습니다 — 배포가 끝나지 않았거나 경로가 다릅니다';
        }
        return { name: name, url: url, ok: false, ms: ms(), t: w.t, hint: hint };
      });
  }

  /* 호스트가 살아 있기는 한가.
     no-cors 요청은 응답 내용을 못 읽는 대신, 서버가 무엇이든 답하기만 하면
     성공한다. 이걸로 "주소가 없어졌다" 와 "서버는 있는데 CORS 를 거부한다"
     를 가를 수 있다 — 일반 fetch 는 둘 다 똑같은 TypeError 를 준다. */
  function reach(host) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return Promise.resolve(null);   // 같은 출처 경로
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) try { ctl.abort(); } catch (e) {} }, 8000);
    return fetch('https://' + host + '/', {
      mode: 'no-cors', cache: 'no-store',
      signal: ctl ? ctl.signal : undefined
    }).then(function () { clearTimeout(to); return true; })
      .catch(function () { clearTimeout(to); return false; });
  }

  function diagnose() {
    var p = Position.state;
    var lat = p.ok ? p.lat : 37.5665, lon = p.ok ? p.lon : 126.9780;
    var nm = 50;
    var b = Geo.degBox(lat, Geo.nmToM(nm));
    var box = {
      lamin: (lat - b.dLat).toFixed(4), lamax: (lat + b.dLat).toFixed(4),
      lomin: (lon - b.dLon).toFixed(4), lomax: (lon + b.dLon).toFixed(4)
    };

    var list = CANDIDATES.slice();
    if (custom.url) list.push({ host: '직접 지정', kind: custom.kind, tpl: custom.url, mine: true });

    var out = [], hosts = {}, chain = Promise.resolve();

    list.forEach(function (cand) {
      chain = chain.then(function () {
        var url = fillUrl(cand.tpl, lat, lon, nm)
          .replace(/\{lamin\}/g, box.lamin).replace(/\{lamax\}/g, box.lamax)
          .replace(/\{lomin\}/g, box.lomin).replace(/\{lomax\}/g, box.lomax);
        return probe(cand.host, url, function (json) {
          return (cand.kind === 'opensky' ? normOpenSky(json, Date.now())
                                          : normReadsb(json, Date.now())).length;
        }).then(function (r) {
          r.tpl = cand.tpl; r.kind = cand.kind; r.mine = !!cand.mine;
          out.push(r);
        });
      });
    });

    /* 실패한 주소의 호스트만 도달 여부를 확인한다 */
    chain = chain.then(function () {
      var need = [];
      out.forEach(function (r) {
        if (!r.ok && !r.mine && need.indexOf(r.name) < 0 && r.t === '연결 실패') need.push(r.name);
      });
      var sub = Promise.resolve();
      need.forEach(function (h) {
        sub = sub.then(function () { return reach(h).then(function (v) { hosts[h] = v; }); });
      });
      return sub;
    });

    return chain.then(function () {
      out.forEach(function (r) {
        if (!r.ok && hosts[r.name] === true) {
          r.hint = '서버는 살아 있는데 이 주소가 응답을 주지 않습니다 — ' +
                   '없어진 경로이거나 CORS 를 열어 주지 않습니다';
        } else if (!r.ok && hosts[r.name] === false) {
          r.hint = '이 서버에 아예 닿지 못했습니다 — 없어졌거나 망에서 막혀 있습니다';
        }
      });
      return {
        env: {
          origin: (typeof location !== 'undefined') ? location.origin : '—',
          protocol: (typeof location !== 'undefined') ? location.protocol : '—',
          online: (typeof navigator !== 'undefined') ? navigator.onLine !== false : true,
          secure: (typeof window !== 'undefined') ? !!window.isSecureContext : false,
          csp: cspHits.slice(0, 6)
        },
        providers: out
      };
    });
  }

  return {
    state: st, fleet: fleet, cfg: cfg, PROVIDERS: PROVIDERS,
    on: on, start: start, stop: stop, fetchOnce: fetchOnce, advance: advance,
    setDemo: setDemo, setProvider: setProvider, setRadius: setRadius,
    setInterval: setInterval_,
    diagnose: diagnose, noteCsp: noteCsp, probe: probe, reach: reach, setOnFound: setOnFound,
    setCustom: setCustom, getCustom: getCustom, customIndex: customIndex,
    CANDIDATES: CANDIDATES, fillUrl: fillUrl,
    _ingest: ingest, _normReadsb: normReadsb, _normOpenSky: normOpenSky, _why: why
  };
})();
