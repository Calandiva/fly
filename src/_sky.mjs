/* src/_sky.mjs — 가짜 카메라에 물릴 하늘 영상을 만드는 개발용 스크립트.
 *
 * 카메라 모드는 실제 하늘을 배경에 깔아 봐야 HUD 가 읽히는지 알 수 있다.
 * Chromium 의 기본 가짜 카메라는 초록색 테스트 패턴이라 그 판단이 안 된다.
 * (실제로 이 스크립트로 밝은 구름 위에서 상태 칩과 고각 눈금이 사라지는
 *  걸 발견했다. 어두운 데모 배경에서는 멀쩡해 보였다.)
 *
 *   node src/_sky.mjs                     # sky.y4m 생성
 *   chromium --use-fake-device-for-media-stream \
 *            --use-file-for-fake-video-capture=sky.y4m
 *
 * Playwright 번들 ffmpeg 에는 PNG 디코더가 없어 캔버스 픽셀을 바로
 * YUV420 으로 바꿔 Y4M 을 직접 쓴다.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const OUT = process.argv[2] || 'sky.y4m';
const W = 1920, H = 1080;

const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
await p.setContent(`<canvas id=c width=${W} height=${H}></canvas><style>body{margin:0}</style>`);

await p.evaluate(() => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  const W = c.width, H = c.height, HZ = H * 0.80;          // 지평선 높이

  const sky = g.createLinearGradient(0, 0, 0, HZ);
  sky.addColorStop(0.00, '#1B4E8C');
  sky.addColorStop(0.45, '#4E8FC4');
  sky.addColorStop(0.80, '#9FC7DF');
  sky.addColorStop(1.00, '#D6E4EA');
  g.fillStyle = sky; g.fillRect(0, 0, W, HZ);

  const sun = g.createRadialGradient(W * 0.78, H * 0.18, 0, W * 0.78, H * 0.18, 460);
  sun.addColorStop(0, 'rgba(255,246,214,.85)');
  sun.addColorStop(0.25, 'rgba(255,240,200,.28)');
  sun.addColorStop(1, 'rgba(255,240,200,0)');
  g.fillStyle = sun; g.fillRect(0, 0, W, HZ);

  let seed = 20260827;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  function cloud(cx, cy, scale, alpha) {
    g.save(); g.filter = 'blur(' + (12 * scale) + 'px)';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * Math.PI * 2, r = Math.pow(rnd(), .6);
      g.fillStyle = 'rgba(255,255,255,' + (alpha * (0.5 + rnd() * 0.5)).toFixed(3) + ')';
      g.beginPath();
      g.arc(cx + Math.cos(a) * r * 210 * scale, cy + Math.sin(a) * r * 52 * scale,
            (26 + rnd() * 62) * scale, 0, 6.2832);
      g.fill();
    }
    g.restore();
  }
  cloud(W * 0.16, H * 0.16, 1.5, .55); cloud(W * 0.44, H * 0.09, 1.1, .42);
  cloud(W * 0.70, H * 0.34, 1.9, .38); cloud(W * 0.10, H * 0.44, 1.3, .30);
  cloud(W * 0.88, H * 0.58, 1.0, .34); cloud(W * 0.34, H * 0.62, 2.2, .22);

  function ridge(base, amp, color) {
    g.fillStyle = color; g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) {
      g.lineTo(x, base - amp * (Math.sin(x / 430) * .6 + Math.sin(x / 170 + 1.7) * .3 +
                                Math.sin(x / 91 + 4) * .1));
    }
    g.lineTo(W, H); g.closePath(); g.fill();
  }
  ridge(HZ - 26, 42, 'rgba(126,157,180,.55)');
  ridge(HZ - 6, 26, 'rgba(96,124,146,.75)');

  g.fillStyle = '#2B3540';
  let x = -40;
  while (x < W + 40) {
    const w = 34 + rnd() * 90, h = 30 + rnd() * 210;
    g.fillRect(x, HZ - h, w, h + 200);
    if (rnd() > .72) g.fillRect(x + w * 0.4, HZ - h - 46, 7, 46);
    x += w + 4 + rnd() * 26;
  }
  g.fillStyle = '#1E262E'; g.fillRect(0, HZ + 90, W, H);

  g.fillStyle = 'rgba(255,214,140,.5)';
  for (let i = 0; i < 900; i++) {
    const wx = rnd() * W, wy = HZ - rnd() * 190;
    if (rnd() > .55) g.fillRect(wx, wy, 3, 5);
  }

  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,.22)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);
});

const b64 = await p.evaluate(() => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  const d = g.getImageData(0, 0, W, H).data;
  const ySz = W * H, cSz = (W >> 1) * (H >> 1);
  const out = new Uint8Array(ySz + cSz * 2);
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    out[y * W + x] = clamp(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  }
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {   // 크로마는 2x2 평균
    let r = 0, gg = 0, bb = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = ((y + dy) * W + (x + dx)) * 4;
      r += d[i]; gg += d[i + 1]; bb += d[i + 2];
    }
    r /= 4; gg /= 4; bb /= 4;
    const ci = (y >> 1) * (W >> 1) + (x >> 1);
    out[ySz + ci] = clamp(-0.168736 * r - 0.331264 * gg + 0.5 * bb + 128);
    out[ySz + cSz + ci] = clamp(0.5 * r - 0.418688 * gg - 0.081312 * bb + 128);
  }
  let s = '', CH = 0x8000;
  for (let i = 0; i < out.length; i += CH) s += String.fromCharCode.apply(null, out.subarray(i, i + CH));
  return btoa(s);
});
await b.close();

const frame = Buffer.from(b64, 'base64');
const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`, 'ascii')];
const mark = Buffer.from('FRAME\n', 'ascii');
for (let i = 0; i < 8; i++) parts.push(mark, frame);   // 몇 프레임만 — 정지 화면이면 충분하다
const buf = Buffer.concat(parts);
fs.writeFileSync(OUT, buf);
console.log(OUT, (buf.length / 1024 / 1024).toFixed(1) + ' MB');
