/* api/route.js — 편명 → 출발·도착 공항 중계 (Vercel 서버리스 함수)
 *
 * adsb.lol 의 routeset 은 CORS 헤더를 붙여 주므로 브라우저에서 직접 불러도
 * 되지만, 항공기 조회가 이 함수를 지나가는 배포본에서는 항로도 같이 지나가게
 * 두는 편이 낫다 — 상류가 정책을 바꿔도 한 곳만 고치면 된다.
 *
 *   POST /api/route   { "planes": [{ "callsign": "KAL086", "lat": 0, "lng": 0 }] }
 *
 * 저장소에 package.json 이 없으므로 .js 는 CommonJS 로 해석된다.
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 만 받습니다' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  const planes = body && Array.isArray(body.planes) ? body.planes.slice(0, 100) : null;
  if (!planes) return res.status(400).json({ error: 'planes 배열이 필요합니다' });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch('https://api.adsb.lol/api/0/routeset', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
                 'User-Agent': 'fly-ar-radar/1.0' },
      body: JSON.stringify({ planes })
    });
    clearTimeout(timer);
    if (!r.ok) return res.status(502).json({ error: `상류 HTTP ${r.status}` });
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json(await r.json());
  } catch (e) {
    clearTimeout(timer);
    return res.status(502).json({ error: e.name === 'AbortError' ? '시간 초과' : (e.message || '실패') });
  }
};
