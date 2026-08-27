/* src/_test.mjs — 브라우저 회귀 테스트 (개발용).
 *
 * 계산부는 src/_check.js 로 브라우저 없이 확인할 수 있지만, 권한·캔버스·
 * DOM 이 얽힌 부분은 실제로 띄워 봐야 한다. 여기 있는 항목은 대부분
 * "한 번 났던 결함" 이다 — 다시 나지 않는지 지킨다.
 *
 *   python3 build.py && npx http-server . -p 8099 -s &
 *   node src/_test.mjs [url]
 *
 * 하늘 배경으로 카메라 모드까지 보려면 먼저 node src/_sky.mjs sky.y4m
 */
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.argv[2] || 'http://127.0.0.1:8099/index.html';
const SKY = 'sky.y4m';
const fail = [], errs = [];

const ok = (name, cond, detail) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail ? '   ' + detail : ''));
  if (!cond) fail.push(name);
};
const head = t => console.log('\n' + t);

const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (fs.existsSync(SKY)) args.push('--use-file-for-fake-video-capture=' + fs.realpathSync(SKY));

const browser = await chromium.launch({ args });

async function open(vp, mobile) {
  const c = await browser.newContext({
    viewport: vp, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile,
    permissions: ['geolocation', 'camera'],
    geolocation: { latitude: 37.5665, longitude: 126.9780, accuracy: 9 }
  });
  const p = await c.newPage();
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL);
  return { c, p };
}

/* ── 데모 흐름 ─────────────────────────────────────────────── */
head('데모 흐름');
{
  const { c, p } = await open({ width: 414, height: 896 }, true);
  await p.click('#bDemo');
  await p.waitForTimeout(6000);
  const d = await p.evaluate(() => ({
    count: Source.state.count,
    tca: Object.values(Source.fleet).filter(a => a.tca).length,
    trails: Object.values(Source.fleet).filter(a => a.trail && a.trail.length > 1).length,
    routes: App.state.list.filter(a => Route.get(a.cs)).length
  }));
  ok('항공기가 잡힌다', d.count > 0, `${d.count}대`);
  ok('최근접 통과가 풀린다', d.tca === d.count);
  ok('자취가 쌓인다', d.trails === d.count);
  ok('항로가 붙는다', d.routes > 0, `${d.routes}건`);

  /* 스쿼크 XSS — 피드 값이 원시 HTML 로 들어가던 결함 */
  const xss = await p.evaluate(() => {
    const a = App.state.list[0];
    a.squawk = '<img src=x onerror="window.__pwned=1">';
    App.select(a.id); UI.open('detail');
    return new Promise(r => setTimeout(() => r({
      pwned: !!window.__pwned,
      imgs: document.querySelectorAll('#sheetBody img').length
    }), 400));
  });
  ok('피드 값이 HTML 로 실행되지 않는다', !xss.pwned && xss.imgs === 0);

  /* 목록이 표시 거리 필터를 무시하던 결함 */
  const filt = await p.evaluate(async () => {
    App.cfg.maxNm = 20;
    UI.open('list');
    await new Promise(r => setTimeout(r, 400));
    const rows = document.querySelectorAll('#sheetBody .row').length;
    const within = App.state.list.filter(a => a.slantM <= 20 * 1852).length;
    App.cfg.maxNm = 120;
    return { rows, within, all: App.state.list.length };
  });
  ok('목록이 표시 거리를 따른다', filt.rows === filt.within,
     `목록 ${filt.rows} / 반경내 ${filt.within} / 전체 ${filt.all}`);

  /* 화각을 손으로 맞춰도 자동 추정이 덮어쓰던 결함 */
  const fov = await p.evaluate(async () => {
    App.cfg.fovAuto = true;
    UI.open('settings');
    await new Promise(r => setTimeout(r, 400));
    const n = document.getElementById('setFov');
    n.value = 44; n.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return { fov: App.cfg.fov, auto: App.cfg.fovAuto };
  });
  ok('화각을 만지면 자동 추정이 꺼진다', fov.auto === false && fov.fov === 44);

  /* 센서가 살아 있으면 Escape 가 먹지 않던 결함 */
  const esc = await p.evaluate(async () => {
    UI.open('list');
    await new Promise(r => setTimeout(r, 300));
    Orient.state.manual = false; Orient.state.ok = true; Orient.state.stamp = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { usable: Orient.usable(), closed: !UI.current() };
  });
  ok('센서가 살아 있어도 Escape 가 먹는다', esc.usable && esc.closed);

  /* 드래그 감도가 tan 투영을 무시하던 결함 */
  const drag = await p.evaluate(async () => {
    /* 화면 한가운데를 그 방위로 맞춘 뒤 재야 한다.
       시야 밖이나 등 뒤 방향을 재면 픽셀 차이가 무의미해진다. */
    Orient.setManual(95, 0);
    await new Promise(r => setTimeout(r, 700));
    const perPx = 180 / Math.PI / View.state.f;          // 앱이 쓰는 값
    const a = View.project(94, 0), b = View.project(96, 0);
    return { perPx, measured: 2 / Math.abs(b.x - a.x), front: a.front && b.front };
  });
  ok('감도 측정이 시야 안에서 이뤄졌다', drag.front);
  ok('드래그 감도가 실측 각도와 맞는다',
     Math.abs(drag.perPx - drag.measured) / drag.measured < 0.05,
     `${drag.perPx.toFixed(5)} vs ${drag.measured.toFixed(5)}`);

  await c.close();
}

/* ── 카메라 · 화면 저장 ─────────────────────────────────────── */
head('카메라 · 화면 저장');
{
  const { c, p } = await open({ width: 414, height: 896 }, true);
  await c.grantPermissions(['camera']);
  await p.click('#bStart');
  await p.waitForTimeout(3000);
  const cam = await p.evaluate(() => ({ on: Camera.state.on, w: Camera.state.w, h: Camera.state.h }));
  ok('카메라가 열린다', cam.on && cam.w > 0, `${cam.w}x${cam.h}`);

  /* 연속 호출에 스트림이 새어 카메라가 켜진 채 남던 결함 */
  const leak = await p.evaluate(async () => {
    App.setCamera(true); App.setCamera(true); App.setCamera(true);
    await new Promise(r => setTimeout(r, 2500));
    const s = document.getElementById('cam').srcObject;
    return s ? s.getVideoTracks().filter(t => t.readyState === 'live').length : 0;
  });
  ok('카메라를 여러 번 켜도 스트림은 하나', leak === 1, `살아있는 트랙 ${leak}`);

  const dl = p.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await p.click('#bShot');
  const d = await dl;
  const size = d ? fs.statSync(await d.path()).size : 0;
  ok('화면 저장이 실제 PNG 를 낸다', size > 20000, d ? `${(size / 1024) | 0} KB` : '내려받기 없음');
  await c.close();
}

/* ── 화면 크기별 ───────────────────────────────────────────── */
head('화면 크기별');
for (const [name, vp, mobile] of [
  ['세로', { width: 414, height: 896 }, true],
  ['가로', { width: 896, height: 414 }, true],
  ['데스크톱', { width: 1440, height: 900 }, false]
]) {
  const { c, p } = await open(vp, mobile);
  await p.click('#bDemo');
  await p.waitForTimeout(4000);
  const d = await p.evaluate(() => ({
    visible: App.state.visible,
    scope: document.querySelector('#scope canvas').width,
    f: View.state.f
  }));
  ok(name, d.visible > 0 && d.scope > 0 && d.f > 0,
     `${d.visible}대 / 스코프 ${d.scope}px / f ${d.f | 0}`);
  await c.close();
}

await browser.close();
head(errs.length ? '페이지 오류:\n  ' + errs.join('\n  ') : '페이지 오류 없음');
console.log(fail.length ? `\n실패 ${fail.length}건: ${fail.join(', ')}` : '\n전부 통과');
process.exit(fail.length || errs.length ? 1 : 0);
