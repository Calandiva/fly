/* ── 35-track.js — 궤적과 최근접 통과 예측 ───────────────────────
   "지금 어디에 있나" 만큼 궁금한 건 "어디로 가나" 와 "얼마나 가까워지나" 다.
   지나온 자취를 짧게 쌓아 두고, 현재 속도·기수·상승률이 유지된다고 보고
   관측자와 가장 가까워지는 시점을 찾는다.
   ---------------------------------------------------------------- */
'use strict';

var Track = (function () {
  var TRAIL_MS = 2000;        // 자취 표본 간격
  var TRAIL_MAX = 90;         // 최대 3분치
  var TCA_HORIZON = 1800;     // 예측 지평 (초)
  var TCA_RANGE = 250000;     // 이 밖은 계산하지 않는다 (m)

  /* t 초 뒤의 위치·고도. 기수와 속도가 그대로 유지된다고 본다. */
  function ahead(a, t) {
    var d = Geo.ktToMps(a.gs) * t;
    var q = Geo.destination(a.dlat, a.dlon, a.track, d);
    var altFt = (a.daltFt || 0) + (a.vsFpm ? (a.vsFpm / 60) * t : 0);
    if (altFt < 0) altFt = 0;
    return { lat: q.lat, lon: q.lon, altFt: altFt };
  }

  /* 관측자까지의 시선 거리 */
  function slantAt(p, a, t) {
    var q = ahead(a, t);
    var g = Geo.haversine(p.lat, p.lon, q.lat, q.lon);
    return Geo.slant(g, Geo.ftToM(q.altFt) - (p.alt || 0));
  }

  /* 최근접 통과 (TCA).
     직선 비행에서 거리는 시간에 대해 아래로 볼록하므로 삼분 탐색이면
     충분하다. 해석해로 풀 수도 있지만 그러려면 평면 근사를 해야 하고,
     그 오차가 정확히 "머리 위를 스치는" 경우에 가장 커진다. */
  function tca(p, a) {
    if (!p || !p.ok) return null;
    if (a.gs == null || a.gs < 20 || a.track == null) return null;
    if (a.slantM > TCA_RANGE) return null;

    var lo = 0, hi = TCA_HORIZON;
    for (var i = 0; i < 30; i++) {
      var m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (slantAt(p, a, m1) < slantAt(p, a, m2)) hi = m2; else lo = m1;
    }
    var t = (lo + hi) / 2;

    var q = ahead(a, t);
    var ground = Geo.haversine(p.lat, p.lon, q.lat, q.lon);
    var dh = Geo.ftToM(q.altFt) - (p.alt || 0);
    var r = {
      t: t,
      dist: Geo.slant(ground, dh),
      ground: ground,
      altFt: q.altFt,
      az: Geo.bearing(p.lat, p.lon, q.lat, q.lon),
      el: Geo.elevation(ground, dh),
      past: t < 3 && a.slantM < slantAt(p, a, 20)      // 이미 지나가 멀어지는 중
    };
    /* 예측 지평 끝에 붙었다면 그건 최근접이 아니라 "아직 다가오는 중" 이다 */
    r.beyond = t > TCA_HORIZON - 5;
    return r;
  }

  /* 자취 표본. 간격이 찰 때만 쌓되, 관측자 기준 방위·거리·고각까지 그때
     같이 구해 둔다. 매 프레임 90점 × 수십 대를 다시 푸는 건 낭비다. */
  var homeLat = null, homeLon = null;

  function sample(fleet, nowMs) {
    var p = Position.state;
    if (!p.ok) return;

    /* 관측자가 크게 움직였으면 저장해 둔 방위·거리가 더는 맞지 않는다 */
    if (homeLat != null && Geo.haversine(homeLat, homeLon, p.lat, p.lon) > 1000) {
      for (var j in fleet) fleet[j].trail = null;
    }
    homeLat = p.lat; homeLon = p.lon;

    for (var k in fleet) {
      var a = fleet[k];
      if (a.dlat == null) continue;
      if (!a.trail) a.trail = [];
      var last = a.trail[a.trail.length - 1];
      if (last && nowMs - last[6] < TRAIL_MS) continue;
      var ground = Geo.haversine(p.lat, p.lon, a.dlat, a.dlon);
      var dh = Geo.ftToM(a.daltFt || 0) - (p.alt || 0);
      /*     0     1     2       3                 4        5                       6   */
      a.trail.push([a.dlat, a.dlon, a.daltFt || 0,
                    Geo.bearing(p.lat, p.lon, a.dlat, a.dlon), ground,
                    Geo.elevation(ground, dh), nowMs]);
      if (a.trail.length > TRAIL_MAX) a.trail.shift();
    }
  }

  /* 자취 점의 자리 이름 — 인덱스를 직접 쓰지 않도록 */
  var T = { LAT: 0, LON: 1, ALT: 2, AZ: 3, DIST: 4, EL: 5, TIME: 6 };

  /* 관측이 갱신될 때 한 번씩 다시 푼다. 매 프레임 풀 이유가 없다 —
     입력이 그대로면 답도 그대로다. */
  function update(fleet, nowMs) {
    var p = Position.state;
    sample(fleet, nowMs);
    for (var k in fleet) {
      var a = fleet[k];
      if (a.slantM == null) continue;
      a.tca = tca(p, a);
    }
  }

  /* "곧 가까이 지나갈" 항공기인가 */
  function imminent(a, withinM, withinS) {
    var c = a.tca;
    return !!(c && !c.past && !c.beyond && c.dist <= withinM && c.t <= withinS);
  }

  /* 앞으로의 경로를 관측자 기준 방위·고각으로 — 예측선 그리기용 */
  function forecast(a, seconds, step) {
    var p = Position.state;
    if (!p.ok || a.gs == null || a.gs < 20 || a.track == null) return [];
    var out = [];
    for (var t = 0; t <= seconds + 0.001; t += step) {
      var q = ahead(a, t);
      var g = Geo.haversine(p.lat, p.lon, q.lat, q.lon);
      var dh = Geo.ftToM(q.altFt) - (p.alt || 0);
      out.push({ t: t, az: Geo.bearing(p.lat, p.lon, q.lat, q.lon),
                 el: Geo.elevation(g, dh), dist: Geo.slant(g, dh) });
    }
    return out;
  }

  return { tca: tca, sample: sample, update: update, ahead: ahead, forecast: forecast,
           imminent: imminent, TRAIL_MAX: TRAIL_MAX, T: T };
})();
