/* ── 45-demo.js — 데모 항공기 생성기 ─────────────────────────────
   센서도 통신도 없는 곳(데스크톱, 실내, 권한 거부)에서 화면을 확인하려고
   쓴다. 실제 피드와 같은 모양의 관측 행을 만들어 Source 에 그대로 넣는다.
   ---------------------------------------------------------------- */
'use strict';

var Demo = (function () {
  var timer = null, sim = [], t0 = 0;
  var DEFAULT = { lat: 37.5665, lon: 126.9780, alt: 38 };   // 서울시청

  var SEED = [
    /* 순항 중인 여객기 — 멀고 높다 */
    { cs: 'KAL086', reg: 'HL8008', t: 'B77W', d: 62, b: 285, alt: 37000, gs: 472, trk: 68,  vs: 0 },
    { cs: 'AAR221', reg: 'HL8381', t: 'A359', d: 41, b: 205, alt: 34000, gs: 455, trk: 355, vs: 0 },
    { cs: 'JAL954', reg: 'JA773J', t: 'B788', d: 88, b: 118, alt: 39000, gs: 488, trk: 246, vs: 0 },
    { cs: 'CPA411', reg: 'B-KQK',  t: 'B77W', d: 105,b: 168, alt: 41000, gs: 501, trk: 12,  vs: 0 },
    { cs: 'UAE322', reg: 'A6-EQK', t: 'B77W', d: 74, b: 320, alt: 36000, gs: 465, trk: 128, vs: 0 },
    { cs: 'FDX5108',reg: 'N572FE', t: 'B77L', d: 53, b: 47,  alt: 33000, gs: 448, trk: 212, vs: 0 },
    /* 인천으로 접근 중 — 낮아지며 가까워진다 */
    { cs: 'JJA1204',reg: 'HL8322', t: 'B738', d: 22, b: 262, alt: 11500, gs: 268, trk: 82,  vs: -1450 },
    { cs: 'TWB712', reg: 'HL8501', t: 'B38M', d: 31, b: 240, alt: 16800, gs: 305, trk: 71,  vs: -1900 },
    /* 김포에서 이륙 상승 중 */
    { cs: 'ABL8523',reg: 'HL8394', t: 'A321', d: 14, b: 194, alt: 7200,  gs: 241, trk: 168, vs: 2350 },
    { cs: 'JNA1205',reg: 'HL8021', t: 'B738', d: 9,  b: 226, alt: 4100,  gs: 212, trk: 205, vs: 2800 },
    /* 저고도 — 헬기와 자가용기 */
    { cs: 'HL9613', reg: 'HL9613', t: 'A139', d: 4,  b: 95,  alt: 1400,  gs: 118, trk: 300, vs: 0 },
    { cs: 'HL1234', reg: 'HL1234', t: 'C172', d: 7,  b: 340, alt: 2800,  gs: 96,  trk: 145, vs: 260 }
  ];

  /* 데모에서도 항로가 보이게 캐시에 직접 심는다 — 네트워크를 타지 않는다 */
  var ROUTES = {
    KAL086: ['ICN', 'LAX'], AAR221: ['ICN', 'SYD'], JAL954: ['NRT', 'SIN'],
    CPA411: ['HKG', 'ICN'], UAE322: ['DXB', 'ICN'], FDX5108: ['ANC', 'CAN'],
    JJA1204: ['CJU', 'ICN'], TWB712: ['KIX', 'ICN'],
    ABL8523: ['GMP', 'PUS'], JNA1205: ['GMP', 'CJU']
  };

  function seedRoutes() {
    for (var cs in ROUTES) {
      var c = ROUTES[cs];
      Route._cache[cs] = {
        cs: cs, plausible: 1, via: [],
        from: { code: c[0], ko: Catalog.airport(c[0]), name: null, country: null, lat: null, lon: null },
        to:   { code: c[1], ko: Catalog.airport(c[1]), name: null, country: null, lat: null, lon: null }
      };
    }
  }

  function build() {
    var p = Position.state.ok ? Position.state : DEFAULT;
    sim = SEED.map(function (s, i) {
      var q = Geo.destination(p.lat, p.lon, s.b, Geo.nmToM(s.d));
      return {
        id: (0x718000 + i * 0x137 + 0x2a).toString(16),
        cs: s.cs, reg: s.reg, type: s.t,
        lat: q.lat, lon: q.lon, altFt: s.alt,
        gs: s.gs, track: s.trk, vsFpm: s.vs,
        squawk: ('0000' + (1000 + i * 137 % 6000)).slice(-4),
        turn: (i % 3 === 0) ? (i % 2 ? 0.12 : -0.09) : 0   // 살짝 선회시켜 정지 화면처럼 보이지 않게
      };
    });
    t0 = Date.now();
  }

  function step() {
    var now = Date.now(), dt = 1.0;
    var rows = sim.map(function (a) {
      if (a.turn) a.track = Geo.norm360(a.track + a.turn * dt);
      var q = Geo.destination(a.lat, a.lon, a.track, Geo.ktToMps(a.gs) * dt);
      a.lat = q.lat; a.lon = q.lon;
      if (a.vsFpm) {
        a.altFt += (a.vsFpm / 60) * dt;
        /* 순항고도나 접지 부근에 닿으면 수직속도를 접는다 */
        if (a.altFt > 41000) { a.altFt = 41000; a.vsFpm = 0; }
        if (a.altFt < 900) { a.altFt = 900; a.vsFpm = 0; a.gs = Math.max(140, a.gs - 6); }
      }
      return {
        id: a.id, cs: a.cs, reg: a.reg, type: a.type, desc: null, cat: null,
        lat: a.lat, lon: a.lon,
        altFt: a.altFt, baroFt: a.altFt - 180,
        gs: a.gs, track: a.track, vsFpm: a.vsFpm,
        squawk: a.squawk, ground: false, emg: null,
        tPos: now - 800                    // 실제 피드처럼 살짝 지연시켜 추측항법도 함께 검증한다
      };
    });
    Source._ingest(rows, now);
    Source.state.live = true;
    Source.state.lastOk = now;
    Source.state.count = rows.length;
    Source.state.providerName = '데모';
  }

  function start() {
    stop();
    if (!Position.state.ok) Position.set(DEFAULT.lat, DEFAULT.lon, DEFAULT.alt);
    seedRoutes();
    build();
    step();
    timer = setInterval(step, 1000);
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { start: start, stop: stop, DEFAULT: DEFAULT,
           get elapsed() { return (Date.now() - t0) / 1000; } };
})();
