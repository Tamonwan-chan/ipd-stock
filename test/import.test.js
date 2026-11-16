// Tests for src/Import.js against an in-memory spreadsheet. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../src/Db.js');
const Import = require('../src/Import.js');
const { FakeSpreadsheet } = require('./fake-spreadsheet.js');

const TODAY = '2026-11-16';
const HEADER = ['order_date', 'drug_name', 'strength', 'drug_unit', 'total_quantity', 'unit_price', 'total_price'];

function setup() {
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  return ss;
}

/** Paste rows into the Import tab under its header, like a user would. */
function paste(ss, rows) {
  const sh = ss.getSheetByName('Import');
  sh.getRange(2, 1, rows.length, HEADER.length).setValues(rows.map(r => HEADER.map((_, i) => r[i] === undefined ? '' : r[i])));
}

const drugsByName = ss => Object.fromEntries(Db.readTable('Drugs', ss).map(d => [d.hosxp_name, d]));
const usage = ss => Db.readTable('UsageDaily', ss).map(u => [u.date, u.drug_id, u.qty]);

test('importDate: text and Sheet dates, C.E. and B.E.', () => {
  assert.equal(Import.importDate('1/8/2026'), '2026-08-01');
  assert.equal(Import.importDate('1/8/2569'), '2026-08-01');
  assert.equal(Import.importDate('2026-08-01'), '2026-08-01');
  assert.equal(Import.importDate(new Date(2026, 7, 1)), '2026-08-01');
  assert.equal(Import.importDate(new Date(2569, 7, 1)), '2026-08-01');
  assert.throws(() => Import.importDate('Aug 1'));
});

test('importUsage: creates drugs, stores daily usage, clears Import, recomputes', () => {
  const ss = setup();
  paste(ss, [
    ['1/8/2026', 'Drug A tab', '10 mg.', 'เม็ด', 4, 1.5, 6],
    ['1/8/2026', 'Drug A tab', '10 mg.', 'เม็ด', 2, 1.5, 3],        // same day: summed
    ['2/8/2026', 'Drug A tab', '20 mg.', 'เม็ด', 1, 2, 2],          // other strength: other drug
    ['2/8/2026', 'KCl inj (C) **HAD**', '20 mEq', 'Amp', 3, 10, 30],
    ['3/8/2026', 'Drug B syr', '', 'ml', 0, 1, 0],                  // zero: dropped
    [new Date(2026, 7, 3), 'Drug A tab', '10 mg.', 'เม็ด', '1,000', 1.75, 1750], // Sheet date, comma
  ]);
  const r = Import.importUsage(ss, { today: TODAY });
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual([r.from, r.to], ['2026-08-01', '2026-08-03']);
  assert.deepEqual(r.newDrugs, ['Drug A tab', 'Drug A tab', 'KCl inj (C) **HAD**']);

  const d = drugsByName(ss);
  const a10 = Db.readTable('Drugs', ss).find(x => x.strength === '10 mg.');
  assert.equal(a10.drug_id, 'D001');
  assert.equal(a10.unit_price, 1.75); // latest date's price
  assert.equal(d['KCl inj (C) **HAD**'].critical, true);
  assert.equal(d['KCl inj (C) **HAD**'].stocked, true);  // critical → always stocked
  assert.equal(d['KCl inj (C) **HAD**'].source_calc, 'MAIN');
  assert.equal(a10.par_updated, TODAY);
  assert.ok(a10.par_calc > 0);
  assert.ok(a10.min_calc > 0 && a10.min_calc < a10.par_calc);
  assert.equal(a10.source_calc, 'UNKNOWN'); // no pack size yet

  assert.deepEqual(usage(ss), [
    ['2026-08-01', 'D001', 6],
    ['2026-08-02', 'D002', 1],
    ['2026-08-02', 'D003', 3],
    ['2026-08-03', 'D001', 1000],
  ]);
  assert.equal(Db.readTable('Import', ss).length, 0);
  assert.deepEqual(ss.getSheetByName('Import').dump()[0], HEADER); // header kept
});

test('importUsage: re-import replaces overlapping dates, matches existing drugs, updates price', () => {
  const ss = setup();
  paste(ss, [['1/8/2026', 'Drug A', '', 'เม็ด', 5, 1], ['2/8/2026', 'Drug A', '', 'เม็ด', 5, 1]]);
  Import.importUsage(ss, { today: TODAY });
  paste(ss, [['2/8/2026', 'Drug A', '', 'เม็ด', 7, 1.25], ['3/8/2026', 'Drug A', '', 'เม็ด', 1, 1.25]]);
  const r = Import.importUsage(ss, { today: TODAY });
  assert.deepEqual(r.newDrugs, []);
  assert.equal(r.priceUpdates, 1);
  assert.deepEqual(r.usage, { removed: 1, added: 2, total: 3 });
  assert.deepEqual(usage(ss), [['2026-08-01', 'D001', 5], ['2026-08-02', 'D001', 7], ['2026-08-03', 'D001', 1]]);
  assert.equal(Db.readTable('Drugs', ss).length, 1);
  assert.equal(Db.readTable('Drugs', ss)[0].unit_price, 1.25);
});

test('importUsage: any bad row aborts the whole import, nothing written', () => {
  const ss = setup();
  paste(ss, [
    ['1/8/2026', 'Drug A', '', 'เม็ด', 5, 1],
    ['31/2/2026', 'Drug B', '', 'เม็ด', 5, 1],
    ['1/8/2026', 'Drug C', '', 'เม็ด', 'five', 1],
    ['1/12/2026', 'Drug D', '', 'เม็ด', 1, 1],   // after today
    ['1/8/2026', '', '', 'เม็ด', 1, 1],
  ]);
  const r = Import.importUsage(ss, { today: TODAY });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0], /^แถว 3: วันที่ไม่ถูกต้อง/);
  assert.match(r.errors[1], /^แถว 4: จำนวนไม่ใช่ตัวเลข/);
  assert.match(r.errors[2], /อนาคต/);
  assert.match(r.errors[3], /ไม่มีชื่อยา/);
  assert.equal(Db.readTable('Drugs', ss).length, 0);
  assert.equal(Db.readTable('UsageDaily', ss).length, 0);
  assert.equal(Db.readTable('Import', ss).length, 5); // left for fixing
});

test('importUsage: dates half-converted by a month/day locale are rejected', () => {
  const ss = setup();
  paste(ss, [
    [new Date(2026, 4, 11), 'Drug A', '', 'เม็ด', 1, 1], // "5/11/2026" read as 11 May
    ['25/11/2026', 'Drug A', '', 'เม็ด', 1, 1],
  ]);
  const r = Import.importUsage(ss, { today: '2026-12-31' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /ข้อความธรรมดา/);
});

test('importUsage: header row pasted again is skipped; empty Import is an error', () => {
  const ss = setup();
  assert.equal(Import.importUsage(ss, { today: TODAY }).ok, false);
  paste(ss, [HEADER, ['1/8/2026', 'Drug A', '', 'เม็ด', 2, 1]]);
  const r = Import.importUsage(ss, { today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.rows, 1);
});

test('recompute: 1-pack rule from pack_size, pharmacist source wins, columns kept', () => {
  const ss = setup();
  const rows = [];
  for (let day = 1; day <= 28; day++) {
    const date = `${day}/8/2026`;
    rows.push([date, 'Busy', '', 'เม็ด', 10, 1]);     // 140 per 14 days
    rows.push([date, 'Slow', '', 'เม็ด', 1, 1]);      // 14 per 14 days
    rows.push([date, 'Forced', '', 'เม็ด', 1, 1]);
  }
  paste(ss, rows);
  Import.importUsage(ss, { today: TODAY });

  const d = drugsByName(ss);
  const set = (name, fields) => Db.updateFields('Drugs', [{ ...d[name], ...fields }], Object.keys(fields), ss);
  set('Busy', { pack_size: 100, location: 'ตู้เก็บยา' });
  set('Slow', { pack_size: 100 });
  set('Forced', { pack_size: 100, source: 'MAIN' });

  const r = Import.recompute(ss, { today: '2026-11-20' });
  const after = drugsByName(ss);
  assert.deepEqual([after.Busy.source_calc, after.Busy.stocked], ['MAIN', true]);
  assert.deepEqual([after.Slow.source_calc, after.Slow.stocked], ['OPD', false]);
  assert.deepEqual([after.Forced.source_calc, after.Forced.source, after.Forced.stocked], ['OPD', 'MAIN', true]);
  assert.equal(after.Busy.location, 'ตู้เก็บยา');
  assert.equal(after.Busy.par_updated, '2026-11-20');
  assert.equal(after.Busy.use_freq, 1);
  assert.deepEqual(r.overridden, ['Forced']);
  assert.deepEqual(r.source, { MAIN: 2, OPD: 1 });
  assert.equal(r.noPackSize, 0);
  assert.deepEqual([r.from, r.to], ['2026-08-01', '2026-08-28']); // window starts where the data starts
});

test('recompute: window is the last history_days when there is more data', () => {
  const ss = setup();
  paste(ss, [['1/1/2026', 'Old', '', 'เม็ด', 99, 1], ['30/9/2026', 'New', '', 'เม็ด', 1, 1]]);
  const r = Import.importUsage(ss, { today: TODAY }).recompute;
  assert.deepEqual([r.from, r.to], ['2026-07-03', '2026-09-30']);
  assert.equal(drugsByName(ss).Old.use_freq, 0); // outside the window
});

test('recompute: unticking critical in Drugs is respected', () => {
  const ss = setup();
  paste(ss, [['1/8/2026', 'Warfarin 3 mg *HAD*', '', 'เม็ด', 1, 1]]);
  Import.importUsage(ss, { today: TODAY });
  const [w] = Db.readTable('Drugs', ss);
  assert.equal(w.stocked, true);
  Db.updateFields('Drugs', [{ ...w, critical: false, pack_size: 100 }], ['critical', 'pack_size'], ss);
  Import.recompute(ss, { today: TODAY });
  const [w2] = Db.readTable('Drugs', ss);
  assert.deepEqual([w2.source_calc, w2.stocked], ['OPD', false]);
});

test('recompute: no usage yet', () => {
  const ss = setup();
  assert.deepEqual(Import.recompute(ss, { today: TODAY }),
    { from: null, to: null, drugs: 0, stocked: 0, source: {}, noPackSize: 0, expensive: [], overridden: [] });
});
