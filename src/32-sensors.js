/* ── 32-sensors.js — 위치와 카메라 ──────────────────────────────
   권한은 반드시 사용자 제스처 안에서 요청한다. iOS 는 그 밖에서 부르면
   조용히 거부되고, 카메라는 https(또는 localhost) 가 아니면 아예 없다.
   ---------------------------------------------------------------- */
'use strict';

var Position = (function () {
  var st = {
    ok: false, lat: null, lon: null, alt: 0, acc: null,
    ts: 0, err: null, watching: false, manual: false
  };
  var subs = [], watchId = null;

  function emit() { for (var i = 0; i < subs.length; i++) subs[i](st); }

  function accept(p) {
    st.ok = true; st.err = null; st.manual = false;
    st.lat = p.coords.latitude; st.lon = p.coords.longitude;
    st.alt = (p.coords.altitude != null && isFinite(p.coords.altitude)) ? p.coords.altitude : 0;
    st.acc = p.coords.accuracy;
    st.ts = Date.now();
    emit();
  }

  function fail(e) {
    st.err = e && e.code === 1 ? '위치 권한이 거부되었습니다'
           : e && e.code === 3 ? '위치를 얻는 데 시간이 너무 오래 걸립니다'
           : '위치를 확인할 수 없습니다';
    emit();
  }

  /* 한 번 즉시 받아 오고, 이어서 계속 지켜본다 */
  function start() {
    if (!navigator.geolocation) {
      st.err = '이 브라우저는 위치 기능을 지원하지 않습니다'; emit();
      return Promise.reject(new Error(st.err));
    }
    return new Promise(function (res, rej) {
      navigator.geolocation.getCurrentPosition(function (p) {
        accept(p); watch(); res(st);
      }, function (e) {
        fail(e); watch(); rej(new Error(st.err));
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
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

  return { state: st, start: start, stop: stop, set: set,
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
    opening = navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 }, height: { ideal: 1080 }
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

  /* 영상 비율로부터 그럴듯한 기본 수평화각을 고른다.
     휴대폰 메인 카메라의 긴 축 화각은 대략 65~70° 이므로 거기에 맞춘다. */
  function guessFov() {
    if (!st.w || !st.h) return 67;
    var longFov = 67;
    if (st.w >= st.h) return longFov;
    return Geo.deg(2 * Math.atan(Math.tan(Geo.rad(longFov) / 2) * st.w / st.h));
  }

  return { state: st, bind: bind, start: start, stop: stop, guessFov: guessFov };
})();
