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

export default async function handler(req, res) {
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

  for (const up of UPSTREAM) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(up.url(la, lo, nm), {
        signal: ctl.signal,
        headers: { 'Accept': 'application/json', 'User-Agent': 'fly-ar-radar/1.0' }
      });
      clearTimeout(timer);
      if (!r.ok) { tried.push(`${up.name}: HTTP ${r.status}`); continue; }
      const json = await r.json();
      const ac = json.ac || json.aircraft;
      if (!Array.isArray(ac)) { tried.push(`${up.name}: 모양이 다름`); continue; }

      /* 몇 초 캐시해 둔다 — 같은 곳을 보는 사람이 여럿이면 상류 부담이 준다 */
      res.setHeader('Cache-Control', 's-maxage=4, stale-while-revalidate=20');
      return res.status(200).json({ ac, now: json.now || Date.now(), _via: up.name });
    } catch (e) {
      clearTimeout(timer);
      tried.push(`${up.name}: ${e.name === 'AbortError' ? '시간 초과' : (e.message || '실패')}`);
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(502).json({ error: '상류 공급자에 닿지 못했습니다', tried });
}
