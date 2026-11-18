// Unit tests for src/Calc.js. Run: npm test
// Synthetic numbers only — no hospital data in this public repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../src/Calc.js');

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('settingsWithDefaults: fills gaps, parses numeric strings, keeps zeros', () => {
  const s = Calc.settingsWithDefaults({ z: '2', delay_days: 0, cycle_days: '' });
  assert.equal(s.z, 2);
  assert.equal(s.delay_days, 0);
  assert.equal(s.cycle_days, 14);
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
  assert.ok(!Calc.isPlaceholder('Magnesium So4 (B),50% inj*HAD*', '.')); // real drug, unit '.' in HOSxP
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

test('windowDays: 14 + 1 + 1 + delay', () => {
  assert.equal(Calc.windowDays({}), 16);
  assert.equal(Calc.windowDays({ delay_days: 3 }), 19);
  assert.equal(Calc.windowDays({ cycle_days: 7 }), 9);
});

test('calcPar: steady demand has no safety stock', () => {
  const r = Calc.calcPar(Array(90).fill(2), {}, {});
  assert.equal(r.parCalc, 32); // 2/day × 16 days, sd 0
  assert.equal(r.par, 32);
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
  assert.equal(r.parCalc, Math.ceil(2 * 16 + 1.65 * 2 * 4)); // 32 + 13.2 → 46
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
  const series = Array(90).fill(1); // parCalc 16
  assert.deepEqual(
    [Calc.calcPar(series, { par_override: 0 }, {}).par, Calc.calcPar(series, { par_override: 0 }, {}).source],
    [0, 'override']);
  assert.equal(Calc.calcPar(series, { par_override: '25' }, {}).par, 25);
  const floored = Calc.calcPar(series, { min_par: 20 }, {});
  assert.deepEqual([floored.par, floored.source], [20, 'min_par']);
  const blank = Calc.calcPar(series, { min_par: '', par_override: '' }, {});
  assert.deepEqual([blank.par, blank.source], [16, 'calc']);
});

test('calcPar: no usage gives par 0 with source none', () => {
  const r = Calc.calcPar(Array(90).fill(0), {}, {});
  assert.deepEqual([r.par, r.source], [0, 'none']);
});

test('boxQty: boxes × units per box, only when both are usable', () => {
  assert.equal(Calc.boxQty(1, 1000), 1000);
  assert.equal(Calc.boxQty('2', '500'), 1000);
  assert.equal(Calc.boxQty(0, 500), 0);
  assert.equal(Calc.boxQty(3, 0.1), 0.3); // no float noise
  assert.equal(Calc.boxQty('', 1000), null);
  assert.equal(Calc.boxQty(1, ''), null);
  assert.equal(Calc.boxQty(1, 0), null);
  assert.equal(Calc.boxQty(-1, 10), null);
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
  const parInfo = { par: 18, source: 'calc', mean: 2 }; // use per cycle 28
  const f = (drug, count, finalQty) =>
    Calc.lineFlags(drug, parInfo, Calc.suggestOrder(parInfo.par, count, 1), finalQty, 1, {});
  assert.deepEqual(f({}, '', ''), ['NOT_COUNTED']);
  assert.deepEqual(f({ critical: true }, 10, ''), ['CRITICAL_LOW']);
  assert.deepEqual(f({}, 10, ''), []);
  assert.deepEqual(f({}, 10, 5), ['EDITED']);
  assert.deepEqual(f({}, 10, 8), []); // same as suggested → not edited
  // par override far above usual use → order of 60 > 2 × 28
  const big = Calc.lineFlags({}, { par: 60, source: 'override', mean: 2 }, Calc.suggestOrder(60, 0, 1), '', 1, {});
  assert.deepEqual(big, ['BIG_ORDER', 'NO_USAGE_DATA']);
});

test('minDays: lead + 1 + delay', () => {
  assert.equal(Calc.minDays({}), 2);
  assert.equal(Calc.minDays({ lead_days: 2, delay_days: 1 }), 4);
});

test('calcMin: mean·T + z·σ·√T; critical uses critical_z and the worst T days', () => {
  assert.deepEqual(Calc.calcMin(Array(90).fill(2), {}, {}), { minCalc: 4, T: 2 }); // steady: 2/day × 2 days
  const series = [0, 4, 0, 4, 0, 4, 0, 4]; // mean 2, sd 2
  assert.equal(Calc.calcMin(series, {}, {}).minCalc, Math.ceil(2 * 2 + 1.65 * 2 * Math.SQRT2)); // 4 + 4.67 → 9
  const burst = Array(90).fill(0);
  burst[10] = 20;
  burst[11] = 10;
  assert.ok(Calc.calcMin(burst, {}, {}).minCalc < 30);
  assert.ok(Calc.calcMin(burst, { critical: true }, {}).minCalc >= 30); // never below the worst 2 days
  assert.equal(Calc.calcMin(Array(90).fill(0), {}, {}).minCalc, 0);
});

test('minFromStored: override wins (including 0), never above par', () => {
  assert.deepEqual(Calc.minFromStored({ min_calc: 6, par_calc: 40 }), { min: 6, source: 'calc' });
  assert.deepEqual(Calc.minFromStored({ min_calc: 6, min_override: '10', par_calc: 40 }), { min: 10, source: 'override' });
  assert.deepEqual(Calc.minFromStored({ min_calc: 6, min_override: 0, par_calc: 40 }), { min: 0, source: 'override' });
  assert.deepEqual(Calc.minFromStored({ min_calc: '', par_calc: 40 }), { min: 0, source: 'none' });
  assert.equal(Calc.minFromStored({ min_calc: 6, par_override: 4 }).min, 4); // capped at par
});

test('lineFlags: BELOW_MIN when the count is under min (HOSxP units)', () => {
  const parInfo = { par: 40, source: 'calc', mean: 2, min: 6 };
  const f = (count, factor) =>
    Calc.lineFlags({}, parInfo, Calc.suggestOrder(parInfo.par, count, factor), '', factor, { cycle_days: 30 });
  assert.deepEqual(f(5, 1), ['BELOW_MIN']);
  assert.deepEqual(f(6, 1), []);
  assert.deepEqual(f(0.5, 10), ['BELOW_MIN']); // half a 10-unit bottle = 5 units
  assert.deepEqual(f('', 1), ['NOT_COUNTED']);
  const noMin = Calc.lineFlags({}, { par: 40, source: 'calc', mean: 2 }, Calc.suggestOrder(40, 0, 1), '', 1, { cycle_days: 30 });
  assert.deepEqual(noMin, []);
});

test('supplySource: used at least 1 day in 7 → main storage, else OPD', () => {
  assert.equal(Calc.supplySource(1, {}), 'MAIN');
  assert.equal(Calc.supplySource(1 / 7, {}), 'MAIN'); // exactly weekly
  assert.equal(Calc.supplySource(0.14, {}), 'OPD');
  assert.equal(Calc.supplySource(0, {}), 'OPD');
  assert.equal(Calc.supplySource(0.1, { min_use_freq: 0.1 }), 'MAIN');
});

test('classifyDrug', () => {
  const st = (useFreq, total = 100) => ({ useFreq, total });
  assert.deepEqual(Calc.classifyDrug({ name: 'YA.......', unit: '.' }, st(1)),
    { stocked: false, critical: false, tier: 'placeholder', source: null });
  assert.equal(Calc.classifyDrug({ name: 'Magnesium So4 (B),50% inj*HAD*', unit: '.' }, st(0.01)).tier, 'critical');
  assert.deepEqual(Calc.classifyDrug({ name: 'KCl inj **HAD**' }, st(0.01)),
    { stocked: true, critical: true, tier: 'critical', source: 'MAIN' });
  assert.equal(Calc.classifyDrug({ name: 'Costly inj', unit_price: 1000 }, st(0.2, 10)).tier, 'expensive');
  assert.equal(Calc.classifyDrug({ name: 'Costly but daily', unit_price: 1000 }, st(0.9, 10)).tier, 'regular');
  assert.deepEqual(Calc.classifyDrug({ name: 'Weekly', unit_price: 1 }, st(1 / 7)),
    { stocked: true, critical: false, tier: 'regular', source: 'MAIN' });
  assert.deepEqual(Calc.classifyDrug({ name: 'Rare', unit_price: 1 }, st(0.05)),
    { stocked: false, critical: false, tier: 'opd', source: 'OPD' });
});

test('opdSuggestion: one OPD cycle (a month) of use, at least 1 when used', () => {
  assert.equal(Calc.opdSuggestion(0.5, 1, {}), 15);
  assert.equal(Calc.opdSuggestion(0.01, 1, {}), 1);
  assert.equal(Calc.opdSuggestion(0, 1, {}), 0);
  assert.equal(Calc.opdSuggestion(30, 240, {}), 4); // 900 ml → 4 bottles of 240 ml
});

test('opdSuggestion: follows opd_cycle_days, not the main-storage cycle_days', () => {
  assert.equal(Calc.opdSuggestion(0.5, 1, { opd_cycle_days: 28, cycle_days: 7 }), 14);
  assert.equal(Calc.opdSuggestion(0.5, 1, { cycle_days: 7 }), 15);
});

test('mainFormLine and mainFormTsv: form column order, units', () => {
  const vit = { hosxp_name: '(NED)VIT B complex tab(-)', unit: 'เม็ด', request_name: 'Vitamin B complex' };
  const kcl = { hosxp_name: 'KCl syr. (คิดต่อ ml.) (C)', unit: '1 ml.', request_unit: 'ขวด', item_code: 'A12' };
  const lines = [Calc.mainFormLine(vit, 120, 1500), Calc.mainFormLine(kcl, 0.5, 0), Calc.mainFormLine(kcl, '', 3)];
  assert.deepEqual(lines[0], { item_code: '', name: 'Vitamin B complex', unit: 'เม็ด', on_hand: 120, qty: 1500 });
  assert.equal(Calc.mainFormTsv(lines),
    '1\t\tVitamin B complex\tเม็ด\t120\t1500\n2\tA12\tKCl syr. (คิดต่อ ml.) (C)\tขวด\t\t3');
});

test('opdLine and opdTsv', () => {
  const kcl = { hosxp_name: 'KCl syr. (คิดต่อ ml.) (C)', unit: '1 ml.', request_unit: 'ขวด', request_name: '' };
  const vit = { hosxp_name: '(NED)VIT B complex tab(-)', unit: 'เม็ด', request_name: 'Vitamin B complex' };
  const lines = [Calc.opdLine(kcl, 3), Calc.opdLine({ hosxp_name: 'X', unit: 'เม็ด' }, 0), Calc.opdLine(vit, 1500)];
  assert.deepEqual(lines[0], { name: 'KCl syr. (คิดต่อ ml.) (C)', qty: 3, unit: 'ขวด', remark: 'IPD' });
  assert.equal(Calc.opdTsv(lines),
    '1\tKCl syr. (คิดต่อ ml.) (C)\t3\tขวด\tIPD\n2\tVitamin B complex\t1500\tเม็ด\tIPD');
});

test('classifyDrug: critical column wins over the HAD name tag', () => {
  const st = { useFreq: 1, total: 10 };
  assert.equal(Calc.classifyDrug({ name: 'Warfarin *HAD*', critical: false }, st).tier, 'regular');
  assert.equal(Calc.classifyDrug({ name: 'Plain', critical: true }, st).tier, 'critical');
  assert.equal(Calc.classifyDrug({ name: 'X *HAD*', critical: '' }, st).tier, 'critical');
});

test('stockDecision: pharmacist source and par win; expensive goes to OPD until it has a par', () => {
  const cls = (tier, source, stocked = false, critical = false) => ({ tier, source, stocked, critical });
  assert.deepEqual(Calc.stockDecision({}, cls('placeholder', null)), { source: null, stocked: false });
  assert.deepEqual(Calc.stockDecision({ source: 'OPD' }, cls('critical', 'MAIN', true, true)), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({}, cls('regular', 'MAIN', true)), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({ source: 'opd' }, cls('regular', 'MAIN', true)), { source: 'OPD', stocked: false });
  assert.deepEqual(Calc.stockDecision({ source: 'MAIN' }, cls('opd', 'OPD')), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({}, cls('expensive', 'MAIN')), { source: 'OPD', stocked: false });
  assert.deepEqual(Calc.stockDecision({ min_par: 2 }, cls('expensive', 'MAIN')), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({ par_override: 0 }, cls('expensive', 'OPD')), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({}, cls('opd', 'OPD')), { source: 'OPD', stocked: false });
  assert.deepEqual(Calc.stockDecision({ min_par: 5 }, cls('opd', 'OPD')), { source: 'MAIN', stocked: true });
  assert.deepEqual(Calc.stockDecision({ min_par: 5, source: 'OPD' }, cls('opd', 'OPD')), { source: 'OPD', stocked: false });
  // NONE: billing-only rows, requested from nowhere; HAD still wins
  assert.deepEqual(Calc.stockDecision({ source: 'none', min_par: 5 }, cls('regular', 'MAIN', true)), { source: null, stocked: false });
  assert.deepEqual(Calc.stockDecision({ source: 'NONE' }, cls('critical', 'MAIN', true, true)), { source: 'MAIN', stocked: true });
});
