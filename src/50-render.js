/* ── 50-render.js — HUD 오버레이와 레이더 스코프 ─────────────────
   지평선·고각 눈금은 실제 투영으로 그린다. 폰을 기울이면 같이 기울어야
   카메라 영상과 어긋나지 않기 때문. 반대로 상단 방위 리본은 늘 수평으로
   둔다 — 기울어진 눈금은 읽기 어렵다.
   ---------------------------------------------------------------- */
'use strict';

var Render = (function () {
  var cv, cx, sv, sx;                       // 메인 캔버스 / 스코프 캔버스
  var W = 0, H = 0, DPR = 1, SAFE_T = 0;
  var reserved = [];                        // UI 가 덮는 자리 — 라벨을 놓지 않는다
  var SW = 0, SH = 0;                       // 스코프 크기
  var hit = [];                             // 이번 프레임의 마커 히트박스
  var scopeHit = [];

  var FONT = '"IBM Plex Mono","D2Coding",ui-monospace,monospace';
  var SANS = '"IBM Plex Sans KR",-apple-system,sans-serif';

  /* 고도대별 색 — 레이더 관습대로 낮을수록 따뜻하게 */
  function altColor(ft) {
    if (ft == null || !isFinite(ft)) return '#8FA3A8';
    if (ft < 3000)  return '#FF6B5E';
    if (ft < 8000)  return '#FF9F45';
    if (ft < 15000) return '#FFD24B';
    if (ft < 24000) return '#7DE88C';
    if (ft < 33000) return '#5FE3A1';
    return '#6FD8FF';
  }

  function init(canvas, scope) {
    cv = canvas; cx = cv.getContext('2d');
    sv = scope; sx = sv.getContext('2d');
  }

  function resize() {
    DPR = Math.min(2.5, window.devicePixelRatio || 1);
    var r = cv.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
    View.resize(W, H, DPR);

    var probe = document.getElementById('probe');
    SAFE_T = probe ? probe.getBoundingClientRect().height : 0;

    /* 상태 칩·세로 툴바·스코프가 앉은 자리를 미리 막아 둔다.
       그러지 않으면 라벨이 버튼 뒤로 들어가 읽을 수 없게 된다. */
    var host = cv.getBoundingClientRect();
    reserved = ['#top', '#tools', '#scope'].map(function (sel) {
      var n = document.querySelector(sel);
      if (!n) return null;
      var b = n.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      return [b.left - host.left - 6, b.top - host.top - 6, b.width + 12, b.height + 12];
    }).filter(Boolean);

    /* 시트가 열려 스코프가 숨겨져 있으면 크기가 0 으로 잡힌다.
       그대로 반영하면 시트를 닫아도 스코프가 빈 채로 남는다. */
    var sr = sv.getBoundingClientRect();
    if (sr.width > 0 && sr.height > 0) {
      SW = Math.round(sr.width); SH = Math.round(sr.height);
      sv.width = Math.round(SW * DPR); sv.height = Math.round(SH * DPR);
      sx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
  }

  /* ── 조각들 ───────────────────────────────────────────────── */

  /* 밝은 하늘 위의 얇은 선과 작은 글자는 그냥 두면 사라진다.
     지도에서 쓰는 방식대로 어두운 테두리를 먼저 깔고 그 위에 그린다. */
  function haloText(g, txt, x, y, width) {
    g.save();
    g.lineJoin = 'round'; g.miterLimit = 2;
    g.strokeStyle = 'rgba(3,9,7,.66)';
    g.lineWidth = width || 2.6;
    g.strokeText(txt, x, y);
    g.restore();
    g.fillText(txt, x, y);
  }

  /* 선을 두 번 긋는다 — 어두운 넓은 획 위에 원래 색.
     테두리를 너무 굵게 두르면 어두운 하늘에서 전선처럼 보인다. */
  function casedStroke(g, draw, width, color, cased) {
    g.save();
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(3,9,7,' + (cased == null ? 0.42 : cased) + ')';
    g.lineWidth = width + 1.6;
    draw(g);
    g.strokeStyle = color; g.lineWidth = width;
    draw(g);
    g.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* 항공기 평면 실루엣. 위쪽이 진행 방향. */
  function planeGlyph(g, s) {
    g.beginPath();
    g.moveTo(0, -s);                       // 기수
    g.lineTo(s * 0.20, -s * 0.30);
    g.lineTo(s * 1.00, s * 0.16);          // 오른쪽 날개
    g.lineTo(s * 1.00, s * 0.40);
    g.lineTo(s * 0.18, s * 0.24);
    g.lineTo(s * 0.16, s * 0.66);
    g.lineTo(s * 0.46, s * 0.92);          // 오른쪽 수평미익
    g.lineTo(s * 0.46, s * 1.06);
    g.lineTo(0, s * 0.88);
    g.lineTo(-s * 0.46, s * 1.06);
    g.lineTo(-s * 0.46, s * 0.92);
    g.lineTo(-s * 0.16, s * 0.66);
    g.lineTo(-s * 0.18, s * 0.24);
    g.lineTo(-s * 1.00, s * 0.40);
    g.lineTo(-s * 1.00, s * 0.16);
    g.lineTo(-s * 0.20, -s * 0.30);
    g.closePath();
  }

  /* 볼록 다각형을 반평면으로 자른다 (Sutherland–Hodgman).
     지평선은 투영 중심을 지나는 평면이라 화면에서는 늘 직선이다. */
  function clipHalf(poly, inside, cross) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    return out;
  }

  /* 카메라가 없을 때의 하늘·지면. 월드의 위쪽 벡터를 화면좌표로 옮기면
     지평선의 직선 방정식이 바로 떨어진다:  nx·u + ny·v = nz  (u,v 는 정규화 좌표) */
  function synth(g) {
    var n = Orient.toScreenSpace([0, 0, 1]);
    var f = View.state.f, cx0 = W / 2, cy0 = H / 2;
    var val = function (p) { return n[0] * (p[0] - cx0) / f + n[1] * (cy0 - p[1]) / f - n[2]; };

    /* 화면 중앙 열에서의 지평선 높이 — 하늘 그러데이션의 기준점 */
    var hy = Math.abs(n[1]) > 1e-6 ? (cy0 - (n[2] * f - n[0] * 0) / n[1]) : (n[2] > 0 ? -H : 2 * H);
    hy = Math.max(-H, Math.min(2 * H, hy));

    var sky = g.createLinearGradient(0, hy - H * 1.15, 0, hy);
    sky.addColorStop(0, '#03101A');
    sky.addColorStop(0.55, '#072434');
    sky.addColorStop(1, '#0E3D55');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    var rect = [[0, 0], [W, 0], [W, H], [0, H]];
    var ground = clipHalf(rect, function (p) { return val(p) < 0; }, function (a, b) {
      var va = val(a), vb = val(b), t = va / (va - vb);
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    });
    if (ground.length > 2) {
      var gg = g.createLinearGradient(0, hy, 0, hy + H * 0.9);
      gg.addColorStop(0, '#0A2417');
      gg.addColorStop(1, '#030B07');
      g.fillStyle = gg;
      g.beginPath();
      g.moveTo(ground[0][0], ground[0][1]);
      for (var i = 1; i < ground.length; i++) g.lineTo(ground[i][0], ground[i][1]);
      g.closePath(); g.fill();
    }
  }

  /* 지평선과 고각 눈금 — 실제 투영을 쓰므로 자세에 따라 기울고 휜다 */
  function horizon(g, head) {
    var LAD = [-30, -20, -10, 0, 10, 20, 30, 45, 60, 75];
    g.lineWidth = 1;
    for (var i = 0; i < LAD.length; i++) {
      var el = LAD[i], zero = el === 0;
      var span = zero ? 70 : 22, stepDeg = zero ? 5 : 11;
      var pts = [], any = false;
      for (var d = -span; d <= span + 0.001; d += stepDeg) {
        var p = View.project(Geo.norm360(head + d), el);
        pts.push(p);
        if (p.front && p.x > -W && p.x < W * 2 && p.y > -H && p.y < H * 2) any = true;
      }
      if (!any) continue;
      var trace = function (gg) {
        gg.beginPath();
        var started = false;
        for (var k = 0; k < pts.length; k++) {
          if (!pts[k].front) { started = false; continue; }
          if (!started) { gg.moveTo(pts[k].x, pts[k].y); started = true; }
          else gg.lineTo(pts[k].x, pts[k].y);
        }
        gg.stroke();
      };
      casedStroke(g, trace, zero ? 1.5 : 0.9,
                  zero ? 'rgba(120,240,180,.80)' : 'rgba(120,240,180,.34)',
                  zero ? 0.45 : 0.30);
      if (!zero) {
        var lab = View.project(Geo.norm360(head), el);
        if (lab.front && lab.x > -40 && lab.x < W + 40 && lab.y > 0 && lab.y < H) {
          g.font = '600 10px ' + FONT;
          g.fillStyle = 'rgba(150,250,200,.95)';
          g.textAlign = 'left'; g.textBaseline = 'middle';
          haloText(g, (el > 0 ? '+' : '') + el + '°', lab.x + 8, lab.y);
        }
      }
    }
  }

  /* 상단 방위 리본 */
  function compass(g, head, absolute) {
    var y = 62 + SAFE_T;                     // 상단 상태 칩 아래
    var f = View.state.f, cxp = W / 2;
    var half = Geo.deg(Math.atan((W / 2) / f));
    g.save();
    g.beginPath(); g.rect(0, y - 20, W, 34); g.clip();

    casedStroke(g, function (gg) {
      gg.beginPath(); gg.moveTo(0, y + 11); gg.lineTo(W, y + 11); gg.stroke();
    }, 0.9, 'rgba(120,240,180,.30)', 0.28);

    var start = Math.ceil((head - half - 5) / 5) * 5;
    for (var a = start; a <= head + half + 5; a += 5) {
      var diff = Geo.norm180(a - head);
      if (Math.abs(diff) > 88) continue;
      var x = cxp + f * Math.tan(Geo.rad(diff));
      if (x < -30 || x > W + 30) continue;
      var az = Geo.norm360(a);
      var major = az % 45 === 0, mid = az % 15 === 0;
      var len = major ? 10 : mid ? 6 : 3.5;
      casedStroke(g, function (gg) {
        gg.beginPath(); gg.moveTo(x, y + 11); gg.lineTo(x, y + 11 - len); gg.stroke();
      }, major ? 1.5 : 0.9, major ? 'rgba(140,245,190,.95)' : 'rgba(120,240,180,.55)',
         major ? 0.45 : 0.28);
      if (major) {
        g.font = '700 11px ' + FONT;
        g.fillStyle = absolute ? '#6FEDAE' : '#FFC24B';
        g.textAlign = 'center'; g.textBaseline = 'bottom';
        var nm = ['N', '045', 'E', '135', 'S', '225', 'W', '315'][az / 45];
        haloText(g, nm, x, y + 0);
      }
    }
    g.restore();

    /* 현재 방위 판 */
    var txt = Geo.fmtAz(head);
    g.font = '700 13px ' + FONT;
    var tw = g.measureText(txt).width + 16;
    g.fillStyle = absolute ? 'rgba(95,227,161,.92)' : 'rgba(255,194,75,.92)';
    roundRect(g, cxp - tw / 2, y + 12, tw, 20, 5); g.fill();
    g.fillStyle = '#04120C';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, cxp, y + 22.5);

    /* 중앙 조준선 */
    casedStroke(g, function (gg) {
      gg.beginPath();
      gg.moveTo(cxp - 13, H / 2); gg.lineTo(cxp - 5, H / 2);
      gg.moveTo(cxp + 5, H / 2); gg.lineTo(cxp + 13, H / 2);
      gg.moveTo(cxp, H / 2 - 13); gg.lineTo(cxp, H / 2 - 5);
      gg.moveTo(cxp, H / 2 + 5); gg.lineTo(cxp, H / 2 + 13);
      gg.stroke();
    }, 1.4, 'rgba(140,245,190,.85)', 0.45);
  }

  /* 라벨 겹침 회피 — 가까운 것부터 자리를 잡고 늦게 온 것을 아래로 민다 */
  /* mx,my: 마커 한가운데. gap: 마커의 바깥 반지름(고리 포함) + 여백.
     라벨 상자를 마커 기준으로 잡아야 강조 고리를 파고들지 않는다.

     후보가 화면 밖으로 조금 삐져나오면 잘라 버리지 말고 안쪽으로 밀어
     넣는다 — 몇 픽셀 차이로 라벨을 통째로 잃는 게 훨씬 나쁘다. */
  var EDGE = 3;
  function place(boxes, mx, my, w, h, gap, preferLeft) {
    if (w > W - EDGE * 2 || h > H - EDGE * 2) return null;
    var xs = preferLeft ? [mx - gap - w, mx + gap] : [mx + gap, mx - gap - w];
    var y0 = my - h / 2;
    var ys = [y0, y0 - h - 10, y0 + h + 10];

    /* 가까운 자리를 먼저 다 훑고 나서 아래로 민다.
       후보별로 끝까지 밀어 보면 지시선이 화면을 가로지를 만큼 길어진다. */
    for (var push = 0; push < 4; push++) {
      for (var yi = 0; yi < ys.length; yi++) {
        for (var xi = 0; xi < xs.length; xi++) {
          var bx = Math.max(EDGE, Math.min(W - w - EDGE, xs[xi]));
          var by = ys[yi] + push * (h + 5);
          if (by < EDGE || by + h > H - EDGE) continue;
          var clash = false;
          for (var i = 0; i < boxes.length; i++) {
            var b = boxes[i];
            if (bx < b[0] + b[2] + 4 && bx + w + 4 > b[0] &&
                by < b[1] + b[3] + 3 && by + h + 3 > b[1]) { clash = true; break; }
          }
          if (!clash) return [bx, by];
        }
      }
    }
    return null;
  }

  function label(a, metric, extra) {
    var l1 = a.cs || a.reg || a.id.toUpperCase();
    var t = a.type ? a.type.toUpperCase() : null;
    var l2 = (t ? t + ' · ' : '') + Geo.fmtAlt(a.altFt, metric);
    var vs = a.vsFpm > 200 ? ' ▲' : a.vsFpm < -200 ? ' ▼' : '';
    var out = [l1, l2, Geo.fmtDist(a.slantM, metric) + vs];
    if (extra) {
      var r = Route.get(a.cs);
      if (r) {
        var rt = Route.label(r.from) + ' → ' + Route.label(r.to);
        if (rt.length > 22) rt = rt.slice(0, 21) + '…';
        out.push(rt);
      }
      var c = a.tca;
      if (c && !c.past && !c.beyond && c.t < 900) {
        var when = c.t < 60 ? Math.round(c.t) + '초' : Math.round(c.t / 60) + '분';
        out.push('최근접 ' + Geo.fmtDist(c.dist, metric) + ' · ' + when + ' 뒤');
      }
    }
    return out;
  }

  /* 선택한 항공기의 지나온 자취와 앞으로 갈 길.
     전부 그리면 하늘이 실타래가 된다 — 고른 한 대만 그린다. */
  function path(g, a, nowMs, metric) {
    /* 지나온 자취: 오래된 쪽일수록 흐리게 */
    var tr = a.trail;
    if (tr && tr.length > 1) {
      var T = Track.T, oldest = tr[0][T.TIME], span = Math.max(1, nowMs - oldest);
      for (var i = 1; i < tr.length; i++) {
        var p0 = View.project(tr[i - 1][T.AZ], tr[i - 1][T.EL]);
        var p1 = View.project(tr[i][T.AZ], tr[i][T.EL]);
        if (!p0.front || !p1.front) continue;
        g.strokeStyle = 'rgba(111,216,255,' + (0.10 + 0.42 * ((tr[i][T.TIME] - oldest) / span)).toFixed(3) + ')';
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      }
    }

    var dir = 0;                     // 예측선이 화면에서 뻗는 좌우 방향

    /* 앞으로 갈 길: 점선. 1분마다 눈금을 찍되 최근접 지점까지는 이어 준다 */
    var c0 = a.tca;
    var span = 240;
    if (c0 && !c0.past && !c0.beyond && c0.t > span) span = Math.min(900, c0.t + 40);
    var fc = Track.forecast(a, span, Math.max(15, span / 24));
    if (fc.length > 1) {
      g.save();
      g.setLineDash([4, 5]);
      var tracePred = function (gg) {
        gg.beginPath();
        var started = false;
        for (var j = 0; j < fc.length; j++) {
          var q = View.project(fc[j].az, fc[j].el);
          if (!q.front) { started = false; continue; }
          if (!started) { gg.moveTo(q.x, q.y); started = true; } else gg.lineTo(q.x, q.y);
        }
        gg.stroke();
      };
      g.strokeStyle = 'rgba(3,9,7,.38)'; g.lineWidth = 3.1; tracePred(g);
      g.strokeStyle = 'rgba(150,225,255,.9)'; g.lineWidth = 1.5; tracePred(g);
      g.restore();

      var p0 = View.project(fc[0].az, fc[0].el);
      for (var k = 1; k < fc.length; k++) {
        var pk = View.project(fc[k].az, fc[k].el);
        if (p0.front && pk.front && Math.abs(pk.x - p0.x) > 20) { dir = pk.x - p0.x; break; }
      }

      /* 정면으로 다가오는 항공기는 예측선이 한 점으로 눌려 눈금이 겹친다.
         앞서 찍은 눈금과 너무 가까우면 건너뛴다. */
      var lastX = -1e9, lastY = -1e9;
      for (var m = 0; m < fc.length; m++) {
        if (fc[m].t < 30 || Math.abs(fc[m].t % 60) > 1) continue;
        var t = View.project(fc[m].az, fc[m].el);
        if (!t.front || !View.onScreen(t, 0)) continue;
        if (Math.hypot(t.x - lastX, t.y - lastY) < 30) continue;
        lastX = t.x; lastY = t.y;
        g.fillStyle = 'rgba(111,216,255,.7)';
        g.beginPath(); g.arc(t.x, t.y, 2.6, 0, 6.2832); g.fill();
        g.font = '600 9px ' + FONT;
        g.fillStyle = '#BFEEFF';
        g.textAlign = 'center'; g.textBaseline = 'top';
        haloText(g, Math.round(fc[m].t / 60) + '분', t.x, t.y + 6);
      }
    }

    /* 최근접 통과 지점 */
    var c = a.tca;
    if (c && !c.past && !c.beyond && c.t < 900) {
      var cp = View.project(c.az, c.el);
      if (cp.front && View.onScreen(cp, 60)) {
        g.save();
        g.translate(cp.x, cp.y);
        g.strokeStyle = '#FFC24B'; g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(0, -7); g.lineTo(7, 0); g.lineTo(0, 7); g.lineTo(-7, 0); g.closePath();
        g.stroke();
        g.font = '600 10px ' + FONT;
        g.textAlign = 'center'; g.textBaseline = 'bottom';
        var txt = '최근접 ' + Geo.fmtDist(c.dist, metric);
        var w = g.measureText(txt).width + 10;
        g.fillStyle = 'rgba(6,12,10,.8)';
        roundRect(g, -w / 2, -26, w, 15, 4); g.fill();
        g.fillStyle = '#FFC24B';
        g.fillText(txt, 0, -13);
        g.restore();
      }
    }
    return dir;
  }

  /* ── 메인 프레임 ──────────────────────────────────────────── */

  function frame(list, opt) {
    if (!cx) return;
    cx.clearRect(0, 0, W, H);
    hit = [];
    var o = Orient.state;
    var metric = opt.metric, sel = opt.selected, absolute = o.absolute && !Orient.stale();

    if (opt.synth) synth(cx);
    horizon(cx, o.heading);
    compass(cx, o.heading, absolute);

    /* 겨냥한 한 대에 궤적과 예상 경로를 붙인다. 선택한 것이 따로 있으면
       그쪽이 우선 — 사람이 고른 것이 더 강한 뜻이다. */
    var focusId = sel || opt.aimed;
    var focusA = focusId ? Source.fleet[focusId] : null;
    var pathDx = 0;
    if (opt.trail && focusA && focusA.az != null) pathDx = path(cx, focusA, opt.now, metric);

    var boxes = reserved.slice(), labeled = 0, offs = [];
    var maxLabels = W < 420 ? 8 : 14;

    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.slantM > Geo.nmToM(opt.maxNm)) continue;
      if (!opt.showGround && !a.airborne) continue;   // 고도 미상·지상 항공기
      if (a.altFt != null && a.altFt < opt.minAltFt) continue;
      var p = View.project(a.az, a.el);
      a._sx = p.x; a._sy = p.y; a._front = p.front;

      if (!View.onScreen(p, 30)) {
        if (offs.length < 6) offs.push(a);
        continue;
      }

      var isSel = sel === a.id;
      var isAim = opt.aimed === a.id;
      var focus = isSel || isAim;              // 크게 보여 줄 한 대
      var near = Track.imminent(a, opt.alertM, opt.alertS);
      var col = altColor(a.altFt);
      /* 가까울수록 크게 — 2km 에서 18px, 90km 에서 6px */
      var s = 18 - 12 * Math.min(1, Math.max(0, (a.slantM - 2000) / 88000));
      var alpha = 0.45 + 0.55 * Math.min(1, Math.max(0, 1 - (a.slantM - 15000) / 130000));
      if (focus || near) alpha = 1;
      if (focus) s = Math.max(s, 16);          // 겨냥한 것은 눈에 띄게

      cx.save();
      cx.globalAlpha = alpha;
      cx.translate(p.x, p.y);
      cx.rotate(Geo.rad(a.relTrack != null ? a.relTrack : 0));
      planeGlyph(cx, s * 0.5);
      cx.fillStyle = col;
      cx.fill();
      cx.lineWidth = 1;
      cx.strokeStyle = 'rgba(2,8,6,.75)';
      cx.stroke();
      cx.restore();

      if (near) {
        /* 곧 가까이 지나갈 항공기 — 숨쉬듯 커지는 고리로 눈에 띄게 */
        var ph = 0.5 + 0.5 * Math.sin(opt.now / 260);
        cx.save();
        cx.strokeStyle = 'rgba(255,194,75,' + (0.85 - 0.45 * ph).toFixed(2) + ')';
        cx.lineWidth = 2;
        cx.beginPath(); cx.arc(p.x, p.y, s * 1.15 + 10 + ph * 9, 0, 6.2832); cx.stroke();
        cx.restore();
      }
      if (focus) {
        cx.save();
        cx.globalAlpha = 0.95; cx.strokeStyle = '#6FD8FF'; cx.lineWidth = 1.8;
        cx.beginPath(); cx.arc(p.x, p.y, s * 1.15 + 9, 0, 6.2832); cx.stroke();
        /* 겨냥 표시는 네 귀퉁이 괄호 — 조준하고 있다는 뜻이 분명해진다 */
        var r = s * 1.15 + 17, arm = 7;
        cx.setLineDash([]);
        cx.beginPath();
        [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(function (q) {
          cx.moveTo(p.x + q[0] * r, p.y + q[1] * r - q[1] * arm);
          cx.lineTo(p.x + q[0] * r, p.y + q[1] * r);
          cx.lineTo(p.x + q[0] * r - q[0] * arm, p.y + q[1] * r);
        });
        cx.stroke();
        cx.restore();
      }

      /* 진행 방향 벡터 — 60초 뒤 위치까지. 길이가 곧 속도이고,
         이게 없으면 순항기는 멈춰 있는 점으로만 보인다. */
      if (opt.trail && a.lead) {
        var lp = View.project(a.lead.az, a.lead.el);
        if (lp.front) {
          var lx = lp.x - p.x, ly = lp.y - p.y;
          var len = Math.sqrt(lx * lx + ly * ly);
          if (len > 2) {
            /* 너무 짧으면 안 보이고 너무 길면 하늘을 가른다 */
            var draw = Math.max(14, Math.min(70, len));
            var ex = p.x + lx / len * draw, ey = p.y + ly / len * draw;
            casedStroke(cx, function (gg) {
              gg.beginPath(); gg.moveTo(p.x, p.y); gg.lineTo(ex, ey); gg.stroke();
            }, focus || near ? 1.8 : 1.2, focus ? '#6FD8FF' : col, 0.35);
            cx.save();
            cx.globalAlpha = alpha;
            cx.fillStyle = focus ? '#6FD8FF' : col;
            cx.beginPath(); cx.arc(ex, ey, focus || near ? 2.4 : 1.8, 0, 6.2832); cx.fill();
            cx.restore();
            /* 라벨이 벡터 위에 앉지 않도록 끝점 언저리를 막아 둔다 */
            boxes.push([ex - 12, ey - 10, 24, 20]);
          }
        }
      }

      hit.push({ id: a.id, x: p.x, y: p.y, r: Math.max(24, s * 1.4) });

      /* 라벨. 겨냥한 한 대만 전부 펼치고 나머지는 편명 한 줄로 둔다 —
         지평선에 늘어선 수십 대에 전부 네 줄을 붙이면 하늘이 글자로 덮인다. */
      if (labeled >= maxLabels && !focus) continue;
      var L = focus ? label(a, metric, true)
                    : [a.cs || a.reg || a.id.toUpperCase()];
      var w = 0, j;
      for (j = 0; j < L.length; j++) {
        cx.font = (j === 0 ? '600 12.5px ' : '11px ') + FONT;
        w = Math.max(w, cx.measureText(L[j]).width);
      }
      w += 14;
      var h = 10 + L.length * 12;
      /* 강조 고리가 가장 크게 부푼 상태를 기준으로 여백을 잡는다 */
      var gap = s * 1.15 + (focus ? 21 : near ? 21 : 10) + 6;
      var pos = place(boxes, p.x, p.y, w, h, gap, focus && pathDx > 0);
      if (!pos) continue;
      boxes.push([pos[0], pos[1], w, h]);
      labeled++;

      cx.save();
      cx.globalAlpha = Math.max(0.75, alpha);
      /* 지시선 */
      cx.strokeStyle = focus ? 'rgba(111,216,255,.75)' : 'rgba(95,227,161,.4)';
      cx.lineWidth = 1;
      cx.beginPath();
      cx.moveTo(p.x, p.y);
      cx.lineTo(pos[0] < p.x ? pos[0] + w : pos[0], pos[1] + h / 2);
      cx.stroke();

      cx.fillStyle = focus ? 'rgba(6,14,20,.82)' : 'rgba(6,12,10,.62)';
      cx.strokeStyle = focus ? 'rgba(111,216,255,.7)' : 'rgba(95,227,161,.24)';
      roundRect(cx, pos[0], pos[1], w, h, 6);
      cx.fill(); cx.stroke();

      cx.textAlign = 'left'; cx.textBaseline = 'middle';
      cx.font = '600 12.5px ' + FONT;
      cx.fillStyle = focus ? '#BFEEFF' : '#EAF4EF';
      cx.fillText(L[0], pos[0] + 7, pos[1] + 12);
      cx.font = '11px ' + FONT;
      for (var li = 1; li < L.length; li++) {
        cx.fillStyle = li === 1 ? col
                     : /^최근접/.test(L[li]) ? '#FFC24B'
                     : li === 2 ? 'rgba(159,182,172,.95)' : 'rgba(191,238,255,.92)';
        cx.fillText(L[li], pos[0] + 7, pos[1] + 12 + li * 12);
      }
      cx.restore();
    }

    offscreen(cx, offs, sel, metric, boxes);
    scope(list, opt);
  }

  /* 시야 밖 항공기를 가장자리 화살표로 알려 준다 */
  function offscreen(g, list, sel, metric, boxes) {
    var cxp = W / 2, cyp = H / 2, pad = 34, padR = 62;   // 오른쪽은 세로 툴바만큼 더 띄운다
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var dx = a._sx - cxp, dy = a._sy - cyp;
      if (!a._front) { dx = -dx; dy = -dy; }
      var m = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= m; dy /= m;
      var rx = (W / 2 - (dx > 0 ? padR : pad)) / Math.abs(dx || 1e-6);
      var ry = (H / 2 - pad) / Math.abs(dy || 1e-6);
      var r = Math.min(rx, ry);
      var x = cxp + dx * r, y = cyp + dy * r;
      var isSel = sel === a.id;

      /* 이미 놓인 라벨이나 UI 와 겹치면 건너뛴다 — 겹쳐 찍히면 둘 다 못 읽는다 */
      var txt = (a.cs || a.reg || a.id.toUpperCase()) + '  ' + Geo.fmtDist(a.slantM, metric);
      g.font = '10px ' + FONT;
      var tw = g.measureText(txt).width;
      var align = (x > W - 110) ? 'right' : (x < 90 ? 'left' : 'center');
      var base = (y < H / 2) ? 'top' : 'bottom';
      var ox = align === 'right' ? -12 : align === 'left' ? 12 : 0;
      var oy = base === 'top' ? 12 : -12;
      var bx = x + ox - (align === 'right' ? tw : align === 'left' ? 0 : tw / 2) - 3;
      var by = y + oy - (base === 'top' ? 0 : 13) - 2;
      var bw = tw + 6, bh = 17;
      var clash = false;
      for (var b = 0; b < boxes.length; b++) {
        var q = boxes[b];
        if (bx < q[0] + q[2] && bx + bw > q[0] && by < q[1] + q[3] && by + bh > q[1]) { clash = true; break; }
      }
      if (clash && !isSel) continue;
      boxes.push([bx, by, bw, bh]);

      g.save();
      g.globalAlpha = isSel ? 1 : 0.62;
      g.translate(x, y);
      g.rotate(Math.atan2(dy, dx) + Math.PI / 2);
      g.beginPath();
      g.moveTo(0, -9); g.lineTo(7, 6); g.lineTo(0, 2.5); g.lineTo(-7, 6);
      g.closePath();
      g.fillStyle = isSel ? '#6FD8FF' : altColor(a.altFt);
      g.fill();
      g.restore();

      g.save();
      g.globalAlpha = isSel ? 1 : 0.62;
      g.font = '10px ' + FONT;
      g.textAlign = align; g.textBaseline = base;
      g.fillStyle = 'rgba(4,10,8,.6)';
      g.fillRect(bx, by, bw, bh);
      g.fillStyle = isSel ? '#BFEEFF' : 'rgba(234,244,239,.92)';
      g.fillText(txt, x + ox, y + oy);
      g.restore();
    }
  }

  /* ── 레이더 스코프 ────────────────────────────────────────── */

  function scope(list, opt) {
    if (!sx || !SW) return;
    scopeHit = [];
    var R = Math.min(SW, SH) / 2 - 4, cxp = SW / 2, cyp = SH / 2;
    var rangeM = Geo.nmToM(opt.scopeNm);
    var up = opt.headingUp ? Orient.state.heading : 0;   // 화면 위쪽이 가리키는 방위

    sx.clearRect(0, 0, SW, SH);

    /* 배경 */
    sx.fillStyle = 'rgba(4,10,8,.55)';
    sx.beginPath(); sx.arc(cxp, cyp, R + 4, 0, 6.2832); sx.fill();

    /* 카메라 시야 부채꼴 */
    var halfFov = Geo.deg(Math.atan((View.state.w / 2) / View.state.f));
    var camRel = Geo.rad(Geo.norm360(Orient.state.heading - up) - 90);
    sx.save();
    sx.fillStyle = 'rgba(95,227,161,.13)';
    sx.beginPath();
    sx.moveTo(cxp, cyp);
    sx.arc(cxp, cyp, R, camRel - Geo.rad(halfFov), camRel + Geo.rad(halfFov));
    sx.closePath(); sx.fill();
    sx.restore();

    /* 거리 링 */
    sx.strokeStyle = 'rgba(95,227,161,.26)'; sx.lineWidth = 1;
    for (var k = 1; k <= 3; k++) {
      sx.beginPath(); sx.arc(cxp, cyp, R * k / 3, 0, 6.2832); sx.stroke();
    }
    sx.strokeStyle = 'rgba(95,227,161,.16)';
    sx.beginPath();
    sx.moveTo(cxp - R, cyp); sx.lineTo(cxp + R, cyp);
    sx.moveTo(cxp, cyp - R); sx.lineTo(cxp, cyp + R);
    sx.stroke();

    /* 방위 글자 */
    sx.font = '600 9px ' + FONT;
    sx.textAlign = 'center'; sx.textBaseline = 'middle';
    var marks = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    for (var mi = 0; mi < marks.length; mi++) {
      var ang = Geo.rad(Geo.norm360(marks[mi][1] - up) - 90);
      var mx = cxp + Math.cos(ang) * (R - 8), my = cyp + Math.sin(ang) * (R - 8);
      sx.fillStyle = marks[mi][0] === 'N' ? '#5FE3A1' : 'rgba(159,182,172,.75)';
      sx.fillText(marks[mi][0], mx, my);
    }

    /* 범위 표시 */
    sx.font = '9px ' + FONT;
    sx.textAlign = 'left'; sx.textBaseline = 'top';
    sx.fillStyle = 'rgba(159,182,172,.7)';
    sx.fillText(Geo.fmtDist(rangeM, opt.metric), 7, SH - 15);

    /* 항공기 — 자취를 먼저 깔고 그 위에 점을 찍는다 */
    var T = Track.T;
    var pol = function (az, dist) {
      var rr = (dist / rangeM) * R, th = Geo.rad(Geo.norm360(az - up) - 90);
      return [cxp + Math.cos(th) * rr, cyp + Math.sin(th) * rr];
    };

    for (var i = list.length - 1; opt.trail && i >= 0; i--) {
      var a = list[i];
      if (a.distM > rangeM) continue;
      if (a.altFt != null && a.altFt < opt.minAltFt) continue;
      var isSel = opt.selected === a.id || opt.aimed === a.id;
      if (!opt.showGround && !a.airborne) continue;
      var tr = a.trail;
      if (!tr || tr.length < 2) continue;
      sx.strokeStyle = isSel ? 'rgba(111,216,255,.75)' : 'rgba(95,227,161,.30)';
      sx.lineWidth = isSel ? 1.6 : 1;
      sx.beginPath();
      var began = false;
      for (var q = 0; q < tr.length; q++) {
        if (tr[q][T.DIST] > rangeM) { began = false; continue; }
        var pt = pol(tr[q][T.AZ], tr[q][T.DIST]);
        if (!began) { sx.moveTo(pt[0], pt[1]); began = true; } else sx.lineTo(pt[0], pt[1]);
      }
      sx.stroke();
    }

    for (i = list.length - 1; i >= 0; i--) {
      var a2 = list[i];
      if (a2.distM > rangeM) continue;
      if (a2.altFt != null && a2.altFt < opt.minAltFt) continue;
      if (!opt.showGround && !a2.airborne) continue;
      var sel2 = opt.selected === a2.id || opt.aimed === a2.id;
      var near2 = Track.imminent(a2, opt.alertM, opt.alertS);
      var xy = pol(a2.az, a2.distM), x = xy[0], y = xy[1];

      /* 기수 방향 꼬리 */
      if (a2.track != null) {
        var tt = Geo.rad(Geo.norm360(a2.track - up) - 90);
        sx.strokeStyle = sel2 ? '#6FD8FF' : 'rgba(95,227,161,.5)';
        sx.lineWidth = 1;
        sx.beginPath(); sx.moveTo(x, y);
        sx.lineTo(x + Math.cos(tt) * 7, y + Math.sin(tt) * 7); sx.stroke();
      }
      sx.fillStyle = sel2 ? '#6FD8FF' : altColor(a2.altFt);
      sx.beginPath(); sx.arc(x, y, sel2 ? 3.6 : 2.4, 0, 6.2832); sx.fill();
      if (near2 && !sel2) {
        sx.strokeStyle = 'rgba(255,194,75,.85)'; sx.lineWidth = 1.2;
        sx.beginPath(); sx.arc(x, y, 6, 0, 6.2832); sx.stroke();
      }
      if (sel2) {
        sx.strokeStyle = '#6FD8FF'; sx.lineWidth = 1;
        sx.beginPath(); sx.arc(x, y, 7, 0, 6.2832); sx.stroke();
      }
      scopeHit.push({ id: a2.id, x: x, y: y });
    }

    /* 관측자 */
    sx.fillStyle = '#EAF4EF';
    sx.beginPath(); sx.arc(cxp, cyp, 2.2, 0, 6.2832); sx.fill();
    sx.strokeStyle = 'rgba(234,244,239,.35)'; sx.lineWidth = 1;
    sx.beginPath(); sx.arc(cxp, cyp, 5.5, 0, 6.2832); sx.stroke();
  }

  /* ── 히트 테스트 ──────────────────────────────────────────── */
  function pick(x, y) {
    var best = null, bd = 1e9;
    for (var i = 0; i < hit.length; i++) {
      var h = hit[i], d = Math.hypot(h.x - x, h.y - y);
      if (d < h.r && d < bd) { bd = d; best = h.id; }
    }
    return best;
  }
  function pickScope(x, y) {
    var best = null, bd = 1e9;
    for (var i = 0; i < scopeHit.length; i++) {
      var h = scopeHit[i], d = Math.hypot(h.x - x, h.y - y);
      if (d < 14 && d < bd) { bd = d; best = h.id; }
    }
    return best;
  }

  return { init: init, resize: resize, frame: frame, pick: pick, pickScope: pickScope,
           altColor: altColor, planeGlyph: planeGlyph,
           get size() { return { w: W, h: H }; } };
})();
