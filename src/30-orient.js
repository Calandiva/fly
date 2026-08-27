/* ── 30-orient.js — 기기 자세와 화면 투영 ────────────────────────
   DeviceOrientation 의 alpha/beta/gamma 는 Z-X'-Y'' 내인 회전이고,
   하늘을 보려고 폰을 세우면 beta 가 90° 부근 — 바로 짐벌락 지점이다.
   오일러각을 그대로 평활화하면 그 근처에서 심하게 떨리므로
   쿼터니언으로 바꿔 slerp 한 뒤 행렬로 되돌린다.
   ---------------------------------------------------------------- */
'use strict';

/* ── 쿼터니언 (w,x,y,z) ────────────────────────────────────────── */
var Quat = {
  mul: function (a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
    ];
  },
  axis: function (ax, ay, az, ang) {
    var h = ang / 2, s = Math.sin(h);
    return [Math.cos(h), ax * s, ay * s, az * s];
  },
  /* Z-X'-Y'' 내인 회전 = qz(alpha) ⊗ qx(beta) ⊗ qy(gamma) */
  fromZXY: function (a, b, g) {
    return Quat.mul(Quat.mul(Quat.axis(0, 0, 1, a), Quat.axis(1, 0, 0, b)),
                    Quat.axis(0, 1, 0, g));
  },
  dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; },
  neg: function (q) { return [-q[0], -q[1], -q[2], -q[3]]; },
  norm: function (q) {
    var n = Math.sqrt(Quat.dot(q, q)) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  },
  slerp: function (a, b, t) {
    var d = Quat.dot(a, b);
    if (d < 0) { b = Quat.neg(b); d = -d; }
    if (d > 0.9995) {                                  // 거의 같으면 선형 보간
      return Quat.norm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                        a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
    }
    var th0 = Math.acos(Math.min(1, d)), th = th0 * t;
    var s0 = Math.cos(th) - d * Math.sin(th) / Math.sin(th0);
    var s1 = Math.sin(th) / Math.sin(th0);
    return Quat.norm([a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1,
                      a[2] * s0 + b[2] * s1, a[3] * s0 + b[3] * s1]);
  },
  /* 회전행렬 (기기좌표 → 월드 ENU). 열 우선이 아니라 R[행][열]. */
  toMat: function (q) {
    var w = q[0], x = q[1], y = q[2], z = q[3];
    var xx = x * x, yy = y * y, zz = z * z;
    return [
      [1 - 2 * (yy + zz), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (xx + zz), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (xx + yy)]
    ];
  }
};

/* ── 자세 추적기 ───────────────────────────────────────────────── */
var Orient = (function () {
  var st = {
    ok: false,              // 이벤트를 한 번이라도 받았는가
    absolute: false,        // 진북/자북 기준인가 (아니면 방위 신뢰 불가)
    source: null,           // 'ios' | 'absolute' | 'relative'
    raw: [1, 0, 0, 0],      // 방금 들어온 자세
    q: [1, 0, 0, 0],        // 평활화된 자세
    R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    screen: 0,              // screen.orientation.angle
    heading: 0,             // 진북 기준 시계방향, 카메라(뒷면)가 보는 방향
    pitch: 0,               // 카메라 시선의 고각
    roll: 0,
    offset: 0,              // 사용자 보정값(°)
    manual: false,          // 센서가 없어 드래그로 둘러보는 중인가
    mh: 0, mp: 12,          // 드래그 모드의 방위·고각
    tLast: 0,
    stamp: 0                // 마지막 이벤트 시각
  };

  var SMOOTH = 14;          // 클수록 반응이 빠르고 대신 떨린다

  function screenAngle() {
    if (window.screen && window.screen.orientation && typeof window.screen.orientation.angle === 'number') {
      return window.screen.orientation.angle;
    }
    return (typeof window.orientation === 'number') ? window.orientation : 0;
  }

  /* 드래그 모드에서는 방위를 직접 지정하므로 보정 오프셋을 다시 더하지 않는다 */
  function eff() { return st.manual ? 0 : st.offset; }

  var absSeen = false;

  function onEvent(e) {
    if (e.alpha == null && e.beta == null && e.gamma == null) return;

    var ios = typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading);

    /* 안드로이드는 absolute 와 상대 이벤트가 함께 온다. 둘의 alpha 기준이
       달라 섞어 쓰면 방위가 두 값 사이를 오간다 — 절대 쪽만 받는다. */
    if (e.type === 'deviceorientationabsolute') absSeen = true;
    else if (absSeen && !ios) return;

    st.manual = false;
    var a = e.alpha || 0;

    /* iOS 는 alpha 가 임의 기준이라 쓸 수 없다. webkitCompassHeading 이
       기기 상단이 향하는 진북 기준 방위이므로 alpha = 360 - heading. */
    if (ios) {
      a = Geo.norm360(360 - e.webkitCompassHeading);
      st.absolute = true; st.source = 'ios';
    } else if (e.absolute === true || e.type === 'deviceorientationabsolute') {
      st.absolute = true; st.source = 'absolute';
    } else if (!st.absolute) {
      st.source = 'relative';
    }

    st.raw = Quat.fromZXY(Geo.rad(a), Geo.rad(e.beta || 0), Geo.rad(e.gamma || 0));
    st.stamp = performance.now();
    st.ok = true;
  }

  /* 매 프레임 호출 — dt(초) 만큼 평활화를 진행한다 */
  function step(dt) {
    st.screen = screenAngle();
    if (!st.ok) return;
    var t = 1 - Math.exp(-SMOOTH * Math.max(0.001, Math.min(0.2, dt)));
    st.q = Quat.slerp(st.q, st.raw, t);
    st.R = Quat.toMat(st.q);

    /* 카메라(기기 뒷면)는 기기 -z 를 본다. 월드로 옮기면 R·(0,0,-1) = -R[..][2] */
    var f = [-st.R[0][2], -st.R[1][2], -st.R[2][2]];
    st.heading = Geo.norm360(Geo.deg(Math.atan2(f[0], f[1])) + eff());
    st.pitch = Geo.deg(Math.asin(Math.max(-1, Math.min(1, f[2]))));

    /* 화면에서 지평선이 얼마나 기울어 보이는가.
       기기 기준으로 재면 가로 화면에서 늘 90° 가까이 나와 쓸모가 없다.
       월드의 위쪽 벡터를 화면좌표로 옮겨야 뷰포트 기준 기울기가 된다. */
    var n = toScreenSpace([0, 0, 1]);
    st.roll = Geo.deg(Math.atan2(n[0], n[1]));
  }

  /* 월드 ENU 단위벡터 → 화면 정렬 기기좌표.
     보정 오프셋만큼 월드를 반대로 돌려 준 뒤 Rᵀ 를 적용하고,
     마지막에 화면 회전 φ 를 더해 뷰포트 축에 맞춘다. */
  function toScreenSpace(v) {
    var o = Geo.rad(-eff()), co = Math.cos(o), so = Math.sin(o);
    /* 오프셋은 위(Z)축 회전 — 방위를 offset 만큼 돌린 것과 같다 */
    var e = v[0] * co - v[1] * so, n = v[0] * so + v[1] * co, u = v[2];
    var R = st.R;
    var dx = R[0][0] * e + R[1][0] * n + R[2][0] * u;   // Rᵀ 1행
    var dy = R[0][1] * e + R[1][1] * n + R[2][1] * u;
    var dz = R[0][2] * e + R[1][2] * n + R[2][2] * u;
    var p = Geo.rad(st.screen), cp = Math.cos(p), sp = Math.sin(p);
    return [cp * dx - sp * dy, sp * dx + cp * dy, dz];
  }

  function attach() {
    var abs = 'ondeviceorientationabsolute' in window;
    if (abs) window.addEventListener('deviceorientationabsolute', onEvent, true);
    window.addEventListener('deviceorientation', onEvent, true);
    if (window.screen && window.screen.orientation) {
      window.screen.orientation.addEventListener('change', function () { st.screen = screenAngle(); });
    }
    window.addEventListener('orientationchange', function () { st.screen = screenAngle(); });
    st.screen = screenAngle();
  }

  /* iOS 13+ 는 사용자 제스처 안에서 명시적 허가를 받아야 한다 */
  function request() {
    var D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      return D.requestPermission().then(function (r) {
        if (r !== 'granted') throw new Error('방향 센서 권한이 거부되었습니다');
        attach(); return true;
      });
    }
    attach();
    return Promise.resolve(true);
  }

  /* 이벤트가 끊겼는지 — 3초 넘게 조용하면 센서 없음으로 본다 */
  function stale() { return st.manual ? false : (!st.ok || (performance.now() - st.stamp) > 3000); }
  /* 진짜 센서가 살아 있는지 (드래그 모드는 제외) */
  function usable() { return st.ok && !st.manual && (performance.now() - st.stamp) <= 3000; }

  /* 드래그로 둘러보기.
     ZXY 오일러에서 카메라가 (h, p) 를 보게 하려면 alpha=-h, beta=90+p, gamma=0.
     (R 의 3열이 기기 +z 이고 카메라는 -z 를 보므로 그렇게 떨어진다.) */
  function setManual(h, p) {
    st.manual = true; st.absolute = true; st.source = 'manual'; st.ok = true;
    st.mh = Geo.norm360(h);
    st.mp = Math.max(-88, Math.min(88, p));
    st.raw = Quat.fromZXY(Geo.rad(-st.mh), Geo.rad(90 + st.mp), 0);
    st.stamp = performance.now();
  }

  return {
    state: st, step: step, request: request, attach: attach,
    toScreenSpace: toScreenSpace, stale: stale, usable: usable, setManual: setManual,
    setOffset: function (d) { st.offset = d; }
  };
})();

/* ── 화면 투영 ─────────────────────────────────────────────────
   카메라 영상은 object-fit:cover 로 화면을 덮는다. 광축은 뷰포트
   한가운데에 오고, 수평 화각은 "잘리기 전 영상 전체 폭"에 대응하므로
   초점거리는 그 폭을 기준으로 잡아야 실제 하늘과 맞는다. */
var View = (function () {
  var st = { w: 0, h: 0, dpr: 1, fov: 67, f: 600, cx: 0, cy: 0, vw: 0, vh: 0 };

  function resize(w, h, dpr) { st.w = w; st.h = h; st.dpr = dpr || 1; recalc(); }
  function video(vw, vh) { st.vw = vw || 0; st.vh = vh || 0; recalc(); }
  function setFov(d) { st.fov = Math.max(25, Math.min(120, d)); recalc(); }

  function recalc() {
    st.cx = st.w / 2; st.cy = st.h / 2;
    if (st.vw > 0 && st.vh > 0 && st.w > 0 && st.h > 0) {
      /* 카메라 영상이 있을 때: 화각은 잘리기 전 영상 전체 폭에 대응한다 */
      var scale = Math.max(st.w / st.vw, st.h / st.vh);   // object-fit: cover
      st.f = (st.vw * scale / 2) / Math.tan(Geo.rad(st.fov) / 2);
    } else {
      /* 카메라가 없을 때: 화각을 화면의 긴 축에 준다. 세로 화면의 가로에
         맞추면 세로 시야가 100° 를 넘어 하늘이 지나치게 넓게 퍼진다. */
      var long = Math.max(st.w, st.h) || 1;
      st.f = (long / 2) / Math.tan(Geo.rad(st.fov) / 2);
    }
  }

  /* 방위·고각 → 화면 픽셀. 뒤쪽이면 front=false 이고 좌표는 방향만 유효하다. */
  function project(az, el) {
    var d = Orient.toScreenSpace(Geo.enu(az, el));
    var depth = -d[2];                                   // 카메라는 -z 방향
    if (depth <= 0.0001) {
      /* 시야 뒤 — 화면 밖 지시자를 그리려고 방향만 되돌린다 */
      var m = Math.sqrt(d[0] * d[0] + d[1] * d[1]) || 1e-6;
      return { x: st.cx + (d[0] / m) * st.w, y: st.cy - (d[1] / m) * st.h,
               front: false, depth: depth };
    }
    return {
      x: st.cx + st.f * (d[0] / depth),
      y: st.cy - st.f * (d[1] / depth),
      front: true, depth: depth
    };
  }

  /* 화면 픽셀이 시야 안(여유 포함)인지 */
  function onScreen(p, pad) {
    pad = pad || 0;
    return p.front && p.x > -pad && p.x < st.w + pad && p.y > -pad && p.y < st.h + pad;
  }

  /* 현재 초점거리에서의 실제 수직 화각 — 눈금자 그릴 때 쓴다 */
  function vFov() { return Geo.deg(2 * Math.atan((st.h / 2) / st.f)); }

  return { state: st, resize: resize, video: video, setFov: setFov,
           project: project, onScreen: onScreen, vFov: vFov };
})();
