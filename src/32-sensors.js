/* ── 32-sensors.js — 위치와 카메라 ──────────────────────────────
   권한은 반드시 사용자 제스처 안에서 요청한다. iOS 는 그 밖에서 부르면
   조용히 거부되고, 카메라는 https(또는 localhost) 가 아니면 아예 없다.
   ---------------------------------------------------------------- */
'use strict';

var Position = (function () {
  var st = {
    ok: false, lat: null, lon: null, alt: 0, acc: null,
    ts: 0, err: null, watching: false, manual: false,
    perm: 'unknown',        // granted | prompt | denied | unknown
    fixes: 0,               // 지금까지 받은 좌표 개수
    lost: false             // 한 번 잡혔다가 끊겼는가
  };
  var subs = [], watchId = null, permStatus = null;

  function emit() { for (var i = 0; i < subs.length; i++) subs[i](st); }

  /* 마지막 좌표를 받은 지 얼마나 됐는가 (초). 없으면 null. */
  function age() { return st.ts ? (Date.now() - st.ts) / 1000 : null; }

  /* 좌표가 오래됐으면 지켜보기가 멈춘 것이다 — 화면을 벗어났다 돌아왔을 때
     흔히 그렇게 된다. */
  function stale(limit) { var a = age(); return a != null && a > (limit || 60); }

  /* 권한 상태를 지속적으로 지켜본다. Permissions API 가 없으면 unknown 으로
     두고, 좌표가 들어오는지 여부로만 판단한다. */
  function watchPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      navigator.permissions.query({ name: 'geolocation' }).then(function (p) {
        permStatus = p;
        st.perm = p.state;
        emit();
        p.onchange = function () {
          var was = st.perm;
          st.perm = p.state;
          if (p.state !== 'granted' && was === 'granted') {
            st.ok = false; st.lost = true;
            st.err = '위치 권한이 회수되었습니다';
          }
          if (p.state === 'granted' && was !== 'granted') {
            st.err = null; st.lost = false;
            start();
          }
          emit();
        };
      }).catch(function () {});
    } catch (e) {}
  }

  function accept(p) {
    st.ok = true; st.err = null; st.manual = false; st.lost = false;
    st.lat = p.coords.latitude; st.lon = p.coords.longitude;
    st.alt = (p.coords.altitude != null && isFinite(p.coords.altitude)) ? p.coords.altitude : 0;
    st.acc = p.coords.accuracy;
    st.ts = Date.now();
    st.fixes++;
    if (st.perm === 'unknown' || st.perm === 'prompt') st.perm = 'granted';
    emit();
  }

  function fail(e) {
    if (e && e.code === 1) { st.perm = 'denied'; st.err = '위치 권한이 거부되었습니다'; }
    else if (e && e.code === 3) st.err = '위치를 얻는 데 시간이 너무 오래 걸립니다';
    else st.err = '위치를 확인할 수 없습니다';
    if (st.ok) st.lost = true;
    emit();
  }

  /* 한 번 즉시 받아 오고, 이어서 계속 지켜본다 */
  function start() {
    if (!navigator.geolocation) {
      st.err = '이 브라우저는 위치 기능을 지원하지 않습니다'; emit();
      return Promise.reject(new Error(st.err));
    }
    watchPermission();
    return new Promise(function (res, rej) {
      navigator.geolocation.getCurrentPosition(function (p) {
        accept(p); watch(); res(st);
      }, function (e) {
        fail(e); watch(); rej(new Error(st.err));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }

  /* 사용자가 직접 다시 잡아 달라고 할 때. 지켜보기가 멈춰 있으면 다시 건다. */
  function refresh() {
    if (!navigator.geolocation) return Promise.reject(new Error('위치 기능이 없습니다'));
    watchPermission();
    return new Promise(function (res, rej) {
      navigator.geolocation.getCurrentPosition(function (p) {
        accept(p);
        if (!st.watching) watch();
        res(st);
      }, function (e) { fail(e); rej(new Error(st.err)); },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    });
  }

  function watch() {
    if (st.watching || !navigator.geolocation) return;
    st.watching = true;
    watchId = navigator.geolocation.watchPosition(accept, function (e) {
      if (!st.ok) fail(e);          // 이미 좌표가 있으면 일시적 실패는 무시
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  }

  function stop() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null; st.watching = false;
  }

  /* 위치를 못 쓰는 환경(데스크톱 등)에서 좌표를 직접 넣는다 */
  function set(lat, lon, alt) {
    st.ok = true; st.manual = true; st.err = null;
    st.lat = lat; st.lon = lon; st.alt = alt || 0; st.acc = null; st.ts = Date.now();
    emit();
  }

  return { state: st, start: start, stop: stop, set: set, refresh: refresh,
           age: age, stale: stale,
           on: function (f) { subs.push(f); } };
})();

var Camera = (function () {
  var st = { on: false, err: null, w: 0, h: 0, label: '' };
  var stream = null, el = null, opening = null;

  function bind(video) { el = video; }

  function start() {
    if (st.on) return Promise.resolve(st);
    /* 여는 중에 또 부르면 getUserMedia 가 두 번 돌아 스트림 하나가 미아가 된다.
       그 스트림은 아무도 stop() 하지 않아 카메라 표시등이 계속 켜져 있다. */
    if (opening) return opening;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      st.err = 'https 연결이 아니거나 카메라를 지원하지 않는 브라우저입니다';
      return Promise.reject(new Error(st.err));
    }
    /* 화면이 세로인데 16:9 가로 영상을 받으면 object-fit:cover 가 좌우를
       잘라 낸다. 1920×1080 을 414×896 뷰포트에 덮으면 가로의 74% 가
       사라져 실제로 보이는 화각이 20° 도 안 된다 — 손을 조금만 돌려도
       비행기가 화면 밖으로 나가 버리는 것이 이것이다.
       그래서 뷰포트와 같은 방향·비율의 영상을 달라고 한다. */
    var vp = viewport();
    var portrait = vp.h >= vp.w;
    opening = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: portrait ? 1080 : 1920 },
        height: { ideal: portrait ? 1920 : 1080 },
        aspectRatio: { ideal: vp.w / vp.h }
      }
    }).then(function (s) {
      /* 여는 사이에 사용자가 카메라를 껐다면 새 스트림은 바로 접는다 */
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = s;
      var track = s.getVideoTracks()[0];
      st.label = track ? track.label : '';
      el.srcObject = s;
      return el.play().catch(function () { /* 자동재생 차단은 무시 — muted 라 대개 통과한다 */ });
    }).then(function () {
      return new Promise(function (res) {
        if (el.videoWidth) return res();
        el.addEventListener('loadedmetadata', function h() {
          el.removeEventListener('loadedmetadata', h); res();
        });
        setTimeout(res, 2500);
      });
    }).then(function () {
      opening = null;
      st.on = true; st.err = null;
      st.w = el.videoWidth || 0; st.h = el.videoHeight || 0;
      el.classList.remove('off');
      return st;
    }).catch(function (e) {
      opening = null;
      st.on = false;
      st.err = (e && e.name === 'NotAllowedError') ? '카메라 권한이 거부되었습니다'
             : (e && e.name === 'NotFoundError') ? '뒷면 카메라를 찾을 수 없습니다'
             : (e && e.message) || '카메라를 열 수 없습니다';
      throw new Error(st.err);
    });
    return opening;
  }

  function stop() {
    opening = null;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; st.on = false; st.w = 0; st.h = 0;
    if (el) { el.srcObject = null; el.classList.add('off'); }
  }

  function viewport() {
    return { w: window.innerWidth || 1, h: window.innerHeight || 1 };
  }

  /* 휴대폰 메인 카메라(1배)의 긴 축 화각은 대략 65~70°.
     영상의 가로·세로는 화면을 돌리면 뒤바뀌지만 이 값은 그대로다. */
  var LONG_FOV = 67;

  /* 지금 붙어 있는 <video> 가 실제로 내보내는 크기. 화면을 돌리면 브라우저가
     프레임도 함께 돌려 가로·세로가 뒤바뀌는데, 그때 예전 값을 그대로 쓰면
     초점거리가 두 배 가까이 틀어진다. 그래서 매 프레임 싸게 확인한다. */
  function dims() {
    if (!el) return { w: 0, h: 0 };
    var w = el.videoWidth || 0, h = el.videoHeight || 0;
    if (w && h) { st.w = w; st.h = h; }
    return { w: st.w, h: st.h };
  }

  return { state: st, bind: bind, start: start, stop: stop,
           dims: dims, longFov: LONG_FOV };
})();
