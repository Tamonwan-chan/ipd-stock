// Unit tests for src/Calc.js. Run: npm test  (or: node --test test/)
// Synthetic numbers only — no hospital data in this public repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../src/Calc.js');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('settingsWithDefaults: fills gaps, parses numeric strings, keeps zeros', () => {
  const s = Calc.settingsWithDefaults({ z: '2', delay_days: 0, cycle_days: '' });
  assert.equal(s.z, 2);
  assert.equal(s.delay_days, 0);
  assert.equal(s.cycle_days, 7);
  assert.equal(Calc.settingsWithDefaults().critical_z, 2.33);
});

test('parseHosxpDate: d/m/yyyy, C.E. and B.E. years', () => {
  assert.equal(Calc.parseHosxpDate('1/8/2026'), '2026-08-01');
  assert.equal(Calc.parseHosxpDate('31/10/2026'), '2026-10-31');
  assert.equal(Calc.parseHosxpDate('31/10/2569'), '2026-10-31');
  assert.throws(() => Calc.parseHosxpDate('2026-08-01'));
  assert.throws(() => Calc.parseHosxpDate('31/2/2026'));
});

test('date helpers', () => {
  assert.equal(Calc.addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(Calc.addDays('2026-08-01', -1), '2026-07-31');
  assert.equal(Calc.daysInclusive('2026-08-01', '2026-10-31'), 92);
});

test('drugKey and name rules', () => {
  assert.equal(Calc.drugKey(' 0.9 % NSS ', '1000  ml.', 'ขวด'), '0.9 % NSS | 1000 ml. | ขวด');
  assert.notEqual(Calc.drugKey('0.9 % NSS', '1000 ml.', 'ขวด'), Calc.drugKey('0.9 % NSS', '100 ml.', 'ขวด'));
  assert.ok(Calc.isCriticalName('KCl inj (C) **HAD**'));
  assert.ok(!Calc.isCriticalName('Paracetamol'));
  assert.ok(Calc.isPlaceholder('YA..........', '.'));
  assert.ok(!Calc.isPlaceholder('Amlodipine', 'เม็ด'));
});

test('dailySeries: zero-fills, sums same-day rows, ignores out-of-range', () => {
  const s = Calc.dailySeries([
    { date: '2026-08-01', qty: 2 },
    { date: '2026-08-01', qty: '3' },
    { date: '2026-08-03', qty: 1 },
    { date: '2026-07-31', qty: 99 },
    { date: '2026-08-04', qty: 99 },
    { date: '2026-08-02', qty: '' },
  ], '2026-08-01', '2026-08-03');
  assert.deepEqual(s, [5, 0, 1]);
});

test('usageStats: mean, population SD, use frequency', () => {
  const st = Calc.usageStats([2, 4, 4, 4, 5, 5, 7, 9]);
  near(st.mean, 5);
  near(st.sd, 2);
  assert.equal(st.useFreq, 1);
  assert.equal(Calc.usageStats([0, 3, 0, 1]).useFreq, 0.5);
  assert.deepEqual(Calc.usageStats([]), { days: 0, total: 0, mean: 0, sd: 0, useFreq: 0 });
});

test('maxWindowSum', () => {
  assert.equal(Calc.maxWindowSum([1, 0, 5, 0, 0, 4, 4], 3), 8);
  assert.equal(Calc.maxWindowSum([1, 2], 9), 3);
});

test('windowDays: 7 + 1 + 1 + delay', () => {
  assert.equal(Calc.windowDays({}), 9);
  assert.equal(Calc.windowDays({ delay_days: 3 }), 12);
});

test('calcPar: steady demand has no safety stock', () => {
  const r = Calc.calcPar(Array(90).fill(2), {}, {});
  assert.equal(r.parCalc, 18); // 2/day × 9 days, sd 0
  assert.equal(r.par, 18);
  assert.equal(r.source, 'calc');
});

test('calcPar: floating-point noise does not add a unit', () => {
  // mean 0.1 × W 10 = 1.0000000000000002 in floating point
  const r = Calc.calcPar(Array(10).fill(0.1), {}, { cycle_days: 8 });
  assert.equal(r.parCalc, 1);
});

test('calcPar: safety stock = z·σ·√W', () => {
  const series = [0, 4, 0, 4, 0, 4, 0, 4]; // mean 2, sd 2
  const r = Calc.calcPar(series, {}, { z: 1.65 });
  assert.equal(r.parCalc, Math.ceil(2 * 9 + 1.65 * 2 * 3)); // 18 + 9.9 → 28
});

test('calcPar: critical drugs use critical_z and at least the worst window', () => {
  const series = Array(90).fill(0);
  series[10] = 30; // one burst
  const normal = Calc.calcPar(series, {}, {});
  const crit = Calc.calcPar(series, { critical: true }, {});
  assert.ok(crit.parCalc >= 30);
  assert.ok(crit.parCalc > normal.parCalc);
});

test('calcPar: override wins (including 0), min_par floors, blanks ignored', () => {
  const series = Array(90).fill(1); // parCalc 9
  assert.deepEqual(
    [Calc.calcPar(series, { par_override: 0 }, {}).par, Calc.calcPar(series, { par_override: 0 }, {}).source],
    [0, 'override']);
  assert.equal(Calc.calcPar(series, { par_override: '25' }, {}).par, 25);
  const floored = Calc.calcPar(series, { min_par: 20 }, {});
  assert.deepEqual([floored.par, floored.source], [20, 'min_par']);
  const blank = Calc.calcPar(series, { min_par: '', par_override: '' }, {});
  assert.deepEqual([blank.par, blank.source], [9, 'calc']);
});

test('calcPar: no usage gives par 0 with source none', () => {
  const r = Calc.calcPar(Array(90).fill(0), {}, {});
  assert.deepEqual([r.par, r.source], [0, 'none']);
});

test('suggestOrder: units, no rounding', () => {
  assert.deepEqual(Calc.suggestOrder(18, 5, ''), { counted: true, onHand: 5, shortfall: 13, qty: 13 });
  assert.equal(Calc.suggestOrder(18, 30, 1).qty, 0);
});

test('suggestOrder: bottles for per-ml liquids, decimals for an opened bottle', () => {
  // par 1300 ml, 2.5 bottles of 240 ml on hand = 600 ml → 700 ml short → 3 bottles
  const r = Calc.suggestOrder(1300, 2.5, 240);
  assert.equal(r.onHand, 600);
  assert.equal(r.qty, 3);
});

test('suggestOrder: blank count is "not counted", 0 is a real count', () => {
  assert.equal(Calc.suggestOrder(18, '', 1).counted, false);
  assert.equal(Calc.suggestOrder(18, null, 1).qty, null);
  assert.equal(Calc.suggestOrder(18, 0, 1).qty, 18);
});

test('lineFlags', () => {
  const parInfo = { par: 18, source: 'calc', mean: 2 }; // weekly use 14
  const f = (drug, count, finalQty) =>
    Calc.lineFlags(drug, parInfo, Calc.suggestOrder(parInfo.par, count, 1), finalQty, 1, {});
  assert.deepEqual(f({}, '', ''), ['NOT_COUNTED']);
  assert.deepEqual(f({ critical: true }, 10, ''), ['CRITICAL_LOW']);
  assert.deepEqual(f({}, 10, ''), []);
  assert.deepEqual(f({}, 10, 5), ['EDITED']);
  assert.deepEqual(f({}, 10, 8), []); // same as suggested → not edited
  // par override far above usual use → order of 40 > 2 × 14
  const big = Calc.lineFlags({}, { par: 40, source: 'override', mean: 2 }, Calc.suggestOrder(40, 0, 1), '', 1, {});
  assert.deepEqual(big, ['BIG_ORDER', 'NO_USAGE_DATA']);
});

test('classifyDrug', () => {
  const st = (useFreq, total = 100) => ({ useFreq, total });
  assert.equal(Calc.classifyDrug({ name: 'YA.......', unit: '.' }, st(1)).tier, 'placeholder');
  assert.deepEqual(Calc.classifyDrug({ name: 'KCl inj **HAD**' }, st(0.01)), { stocked: true, critical: true, tier: 'critical' });
  assert.equal(Calc.classifyDrug({ name: 'Costly inj', unit_price: 1000 }, st(0.2, 10)).tier, 'expensive');
  assert.equal(Calc.classifyDrug({ name: 'Costly but daily', unit_price: 1000 }, st(0.9, 10)).tier, 'regular');
  assert.equal(Calc.classifyDrug({ name: 'Weekly', unit_price: 1 }, st(1 / 7)).tier, 'regular');
  assert.equal(Calc.classifyDrug({ name: 'Rare', unit_price: 1 }, st(0.05)).tier, 'rare');
});

test('requestLine and toTsv', () => {
  const kcl = { hosxp_name: 'KCl syr. (คิดต่อ ml.) (C)', unit: '1 ml.', request_unit: 'ขวด', request_name: '' };
  const vit = { hosxp_name: '(NED)VIT B complex tab(-)', unit: 'เม็ด', request_name: 'Vitamin B complex' };
  const lines = [Calc.requestLine(kcl, 3), Calc.requestLine({ hosxp_name: 'X', unit: 'เม็ด' }, 0), Calc.requestLine(vit, 1500)];
  assert.deepEqual(lines[0], { name: 'KCl syr. (คิดต่อ ml.) (C)', qty: 3, unit: 'ขวด', remark: 'IPD' });
  assert.equal(Calc.toTsv(lines),
    '1\tKCl syr. (คิดต่อ ml.) (C)\t3\tขวด\tIPD\n2\tVitamin B complex\t1500\tเม็ด\tIPD');
});
