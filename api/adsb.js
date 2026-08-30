/* api/adsb.js — 항공기 조회 중계 (Vercel 서버리스 함수)
 *
 * 공개 ADS-B API 는 대부분 Access-Control-Allow-Origin 을 보내지 않는다.
 * 그래서 정적 페이지에서 브라우저로 직접 부르면 CORS 에 막힌다 — 주소가
 * 틀려서가 아니라 구조가 그렇다. (adsb.lol 의 /v2/* 가 그렇고, 같은
 * 저장소의 /api/0/routeset 에만 CORS 헤더가 붙어 있다.)
 *
 * 서버끼리는 CORS 가 없다. 이 함수가 대신 받아 와 같은 출처로 돌려준다.
 * 사용자 좌표는 이 배포본 밖의 제3자를 거치지 않는다.
 *
 *   GET /api/adsb?lat=37.5665&lon=126.978&nm=120
 *
 * 저장소에 package.json 이 없으므로 .js 는 CommonJS 로 해석된다.
 * ESM 문법(export default)을 쓰면 함수가 뜨기도 전에 죽는다.
 */

const UPSTREAM = [
  { name: 'adsb.lol',
    url: (la, lo, nm) => `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'adsb.fi',
    url: (la, lo, nm) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${nm}` },
  { name: 'airplanes.live',
    url: (la, lo, nm) => `https://api.airplanes.live/v2/point/${la}/${lo}/${nm}` }
];

const num = (v, lo, hi, dflt) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const q = req.query || {};
  const lat = num(q.lat, -90, 90, null);
  const lon = num(q.lon, -180, 180, null);
  const nm = Math.round(num(q.nm, 1, 250, 120));
  if (lat === null || lon === null) {
    return res.status(400).json({ error: 'lat 과 lon 이 필요합니다' });
  }

  const la = lat.toFixed(4), lo = lon.toFixed(4);
  const tried = [];

  /* 상류를 하나씩 기다리면 최악이 3 x 8초 = 24초다. 클라이언트는 12초에
     포기하므로, 느린 회선이나 콜드 스타트가 겹치면 서버는 아직 시도 중인데
     화면에는 "수신 실패" 만 남는다. 그래서 한꺼번에 띄우고 가장 먼저
     제대로 답하는 것을 쓴다. */
  const PER_TRY = 6000;

  const attempt = async (up) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PER_TRY);
    try {
      const r = await fetch(up.url(la, lo, nm), {
        signal: ctl.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'fly-ar-radar/1.0' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const ac = json.ac || json.aircraft;
      if (!Array.isArray(ac)) throw new Error('모양이 다름');
      return { ac, now: json.now || Date.now(), _via: up.name };
    } catch (e) {
      throw new Error(`${up.name}: ${e.name === 'AbortError' ? '시간 초과' : (e.message || '실패')}`);
    } finally {
      clearTimeout(timer);
    }
  };

  /* Promise.any 는 Node 15+ 에 있지만, 실패 사유를 모아 두려면 직접 도는 편이
     낫다 — 어느 상류가 왜 안 됐는지가 화면 진단까지 그대로 올라간다. */
  const winner = await new Promise((resolve) => {
    let left = UPSTREAM.length;
    let done = false;
    UPSTREAM.forEach((up) => {
      attempt(up).then((v) => {
        if (!done) { done = true; resolve(v); }
      }, (e) => {
        tried.push(e.message);
        if (--left === 0 && !done) { done = true; resolve(null); }
      });
    });
  });

  if (winner) {
    /* 몇 초 캐시해 둔다 — 같은 곳을 보는 사람이 여럿이면 상류 부담이 준다 */
    res.setHeader('Cache-Control', 's-maxage=4, stale-while-revalidate=20');
    return res.status(200).json(winner);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({ error: '상류 공급자에 닿지 못했습니다', tried });
};
