/* ── 20-geo.js — 측지 계산과 단위 ───────────────────────────────
   좌표계 약속: ENU (X=동, Y=북, Z=상). 방위(azimuth)는 진북 기준 시계방향.
   ---------------------------------------------------------------- */
'use strict';

var Geo = (function () {
  var R_E = 6371008.8;                 // 평균 지구 반지름 (m)
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function rad(d) { return d * D2R; }
  function deg(r) { return r * R2D; }

  /* 각도를 [0,360) 으로 정규화 */
  function norm360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  /* 각도를 (-180,180] 으로 정규화 — 최단 회전 방향 계산용 */
  function norm180(d) { d = norm360(d); return d > 180 ? d - 360 : d; }

  /* 두 각 사이를 최단 경로로 보간 */
  function lerpAngle(a, b, t) { return norm360(a + norm180(b - a) * t); }

  /* 지표면 대권 거리 (m) */
  function haversine(lat1, lon1, lat2, lon2) {
    var p1 = rad(lat1), p2 = rad(lat2);
    var dp = p2 - p1, dl = rad(lon2 - lon1);
    var a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R_E * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* 출발점에서 목표점을 바라보는 초기 방위각 (진북 0°, 시계방향) */
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return norm360(deg(Math.atan2(y, x)));
  }

  /* 대권을 따라 방위 brg 로 dist(m) 이동한 지점 — 추측항법에 쓴다 */
  function destination(lat, lon, brg, dist) {
    var d = dist / R_E, t = rad(brg), p1 = rad(lat), l1 = rad(lon);
    var sp = Math.sin(p1), cp = Math.cos(p1), sd = Math.sin(d), cd = Math.cos(d);
    var p2 = Math.asin(sp * cd + cp * sd * Math.cos(t));
    var l2 = l1 + Math.atan2(Math.sin(t) * sd * cp, cd - sp * Math.sin(p2));
    return { lat: deg(p2), lon: norm180(deg(l2)) };
  }

  /* 고각(elevation). 지구 곡률로 인한 침하 d²/2R 를 빼 준다.
     ground: 지표 거리(m), dh: 관측자 대비 고도차(m) */
  function elevation(ground, dh) {
    if (ground < 1) return dh > 0 ? 90 : -90;
    return deg(Math.atan2(dh - (ground * ground) / (2 * R_E), ground));
  }

  /* 관측자↔항공기 시선 거리 (m) */
  function slant(ground, dh) {
    var drop = (ground * ground) / (2 * R_E);
    return Math.sqrt(ground * ground + (dh - drop) * (dh - drop));
  }

  /* 방위·고각 → ENU 단위벡터 */
  function enu(az, el) {
    var a = rad(az), e = rad(el), ce = Math.cos(e);
    return [ce * Math.sin(a), ce * Math.cos(a), Math.sin(e)];
  }

  /* 위경도 1° 당 미터 — 조회 반경을 위경도 상자로 바꿀 때 쓴다 */
  function degBox(lat, meters) {
    var dLat = meters / 111320;
    var dLon = meters / (111320 * Math.max(0.02, Math.cos(rad(lat))));
    return { dLat: dLat, dLon: dLon };
  }

  /* ── 단위 변환 ── */
  var FT = 0.3048, NM = 1852, KT = 0.514444;
  function ftToM(f) { return f * FT; }
  function mToFt(m) { return m / FT; }
  function ktToMps(k) { return k * KT; }
  function nmToM(n) { return n * NM; }
  function mToNm(m) { return m / NM; }

  /* ── 표시 서식 ──
     metric=true 면 km/m·km/h, false 면 NM·ft·kt 를 쓴다. */
  function fmtDist(m, metric) {
    if (!isFinite(m)) return '—';
    if (metric) return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
    var nm = m / NM;
    return nm < 1 ? nm.toFixed(2) + ' NM' : nm.toFixed(nm < 10 ? 1 : 0) + ' NM';
  }
  function fmtAlt(ftVal, metric) {
    if (ftVal == null || !isFinite(ftVal)) return '—';
    if (metric) return Math.round(ftVal * FT).toLocaleString('ko') + ' m';
    return Math.round(ftVal).toLocaleString('ko') + ' ft';
  }
  function fmtSpd(kt, metric) {
    if (kt == null || !isFinite(kt)) return '—';
    return metric ? Math.round(kt * KT * 3.6) + ' km/h' : Math.round(kt) + ' kt';
  }
  /* 상승/하강률 */
  function fmtVs(fpm, metric) {
    if (fpm == null || !isFinite(fpm)) return '—';
    var s = fpm > 60 ? '▲ ' : fpm < -60 ? '▼ ' : '— ';
    var v = Math.abs(Math.round(fpm / 10) * 10);
    return s + (metric ? (v * FT / 60).toFixed(1) + ' m/s' : v.toLocaleString('ko') + ' fpm');
  }
  /* 방위각 → 16방위 한글 이름 */
  var PTS = ['북','북북동','북동','동북동','동','동남동','남동','남남동',
             '남','남남서','남서','서남서','서','서북서','북서','북북서'];
  function compass(az) { return PTS[Math.round(norm360(az) / 22.5) % 16]; }
  /* 방위각 → 항공용 3자리 표기 (015°) */
  function fmtAz(az) { return ('00' + Math.round(norm360(az))).slice(-3) + '°'; }
  /* 고도를 항공식 FL 로 — 18,000ft 이상에서만 의미가 있다 */
  function flightLevel(ft) {
    if (ft == null || !isFinite(ft) || ft < 18000) return null;
    return 'FL' + ('00' + Math.round(ft / 100)).slice(-3);
  }
  /* 좌표 표기. 도분초는 읽기 어렵고 소수 5자리면 약 1m 이다. */
  function fmtLatLon(lat, lon) {
    if (lat == null || lon == null) return '—';
    var ns = lat >= 0 ? 'N' : 'S', ew = lon >= 0 ? 'E' : 'W';
    return Math.abs(lat).toFixed(5) + '° ' + ns + '  ' +
           Math.abs(lon).toFixed(5) + '° ' + ew;
  }

  /* 경과 시간 */
  function fmtAge(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 1) return '방금';
    if (sec < 60) return Math.round(sec) + '초 전';
    if (sec < 3600) return Math.round(sec / 60) + '분 전';
    return Math.round(sec / 3600) + '시간 전';
  }

  return {
    R_E: R_E, FT: FT, NM: NM, KT: KT,
    rad: rad, deg: deg, norm360: norm360, norm180: norm180, lerpAngle: lerpAngle,
    haversine: haversine, bearing: bearing, destination: destination,
    elevation: elevation, slant: slant, enu: enu, degBox: degBox,
    ftToM: ftToM, mToFt: mToFt, ktToMps: ktToMps, nmToM: nmToM, mToNm: mToNm,
    fmtDist: fmtDist, fmtAlt: fmtAlt, fmtSpd: fmtSpd, fmtVs: fmtVs,
    compass: compass, fmtAz: fmtAz, flightLevel: flightLevel, fmtAge: fmtAge,
    fmtLatLon: fmtLatLon
  };
})();
