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
 * 크로미움이 기본 위치에 없으면 PW_EXE 로 실행 파일을 지정합니다.
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

const browser = await chromium.launch({ args, executablePath: process.env.PW_EXE || undefined });

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

  /* 화각 슬라이더는 "눈에 보이는 가로 화각" 을 직접 잡는다.
     사람이 확인할 수 있는 값이어야 맞출 수 있기 때문. */
  const fov = await p.evaluate(async () => {
    UI.open('settings');
    await new Promise(r => setTimeout(r, 400));
    const n = document.getElementById('setFov');
    n.value = 44; n.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    return { h: View.hFov(), saved: App.cfg.fovLong, long: View.state.fovLong };
  });
  ok('화각을 만지면 보이는 가로 화각이 그 값이 된다',
     Math.abs(fov.h - 44) < 0.6 && Math.abs(fov.saved - fov.long) < 0.01,
     `보이는 ${fov.h.toFixed(1)}° · 저장 긴축 ${fov.saved.toFixed(1)}°`);

  /* 화면을 돌리면 영상의 가로·세로가 뒤바뀐다. 그때 화각을 "영상 가로
     기준" 으로 들고 있으면 초점거리가 두 배 가까이 틀어져, 한 번 맞춰 둔
     보정이 무너지고 조금만 돌려도 비행기가 엉뚱한 곳에 섰다.
     기준을 렌즈의 긴 축으로 잡으면 돌려도 같은 렌즈로 남는다. */
  const relens = await p.evaluate(() => {
    View.setFov(67);
    View.video(1080, 1920);
    const port = { f: View.state.f, fov: View.state.fov, long: View.state.fovLong };
    View.video(1920, 1080);
    const land = { f: View.state.f, fov: View.state.fov, long: View.state.fovLong };
    /* 세로 화면(414×896)에서 세로 영상은 세로가 꽉 차고, 가로 영상은
       가로가 잘린다. 초점거리는 달라도 렌즈(긴 축 화각)는 같아야 한다. */
    return { port, land };
  });
  ok('화면을 돌려도 렌즈 화각은 그대로',
     Math.abs(relens.port.long - relens.land.long) < 0.01 &&
     Math.abs(relens.port.f - relens.land.f) > 1,
     `긴축 ${relens.port.long.toFixed(1)}° · f ${relens.port.f.toFixed(0)} → ${relens.land.f.toFixed(0)}`);

  /* 세로 영상을 받으면 가로 시야가 20° 밑으로 떨어지지 않아야 한다.
     한때 16:9 가로 영상을 세로 화면에 덮어 가로의 74% 를 잘라 냈고,
     그 상태에서는 손을 조금만 돌려도 비행기가 화면 밖으로 나갔다. */
  const wide = await p.evaluate(() => {
    View.setFov(67); View.video(1080, 1920);
    return { h: View.hFov(), v: View.vFov() };
  });
  ok('세로 화면에서 가로 시야가 충분하다', wide.h > 28,
     `가로 ${wide.h.toFixed(0)}° 세로 ${wide.v.toFixed(0)}°`);

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
