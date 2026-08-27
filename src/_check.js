// src/_check.js — 번들을 Node vm 에서 돌려 문법과 기본 동작을 확인하는 개발용 스크립트.
//   사용: node src/_check.js "<검증코드>" [파일...]
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = __dirname;
const files = process.argv.slice(3).length ? process.argv.slice(3)
  : fs.readdirSync(SRC).filter(f => /^\d.*\.js$/.test(f) && f !== '99-boot.js').sort();
const code = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
const ctx = vm.createContext({
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, isFinite, isNaN,
  parseInt, parseFloat, Promise, Error, RegExp, Map, Set,
  setTimeout, clearTimeout, setInterval, clearInterval, performance,
  fetch: typeof fetch === 'function' ? fetch : undefined,
  window: { addEventListener() {}, screen: {} },
  document: { hidden: false },
  navigator: {}
});
try { vm.runInContext(code, ctx, { filename: 'bundle.js' }); }
catch (e) { console.error('LOAD FAIL:', e.message); process.exit(1); }
console.log('loaded:', files.join(' '));
const probe = process.argv[2];
if (probe) vm.runInContext(probe, ctx, { filename: 'probe' });
