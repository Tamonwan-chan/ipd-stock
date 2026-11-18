// Tests for src/Db.js against an in-memory spreadsheet. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../src/Db.js');
const Schema = require('../src/Schema.js');
const Calc = require('../src/Calc.js');
const { FakeSpreadsheet } = require('./fake-spreadsheet.js');

const fresh = () => { const ss = new FakeSpreadsheet(); Db.ensureSchema(ss); return ss; };
const strip = rows => rows.map(({ _row, ...rest }) => rest);

test('ensureSchema: creates every tab with headers, frozen row 1, default settings', () => {
  const ss = new FakeSpreadsheet();
  ss.insertSheet('Rate Aug-Oct 26').set(1, 1, 'order_date'); // existing tab, not in the schema
  const r = Db.ensureSchema(ss);
  assert.deepEqual(r.created, Schema.ORDER);
  assert.deepEqual(r.addedColumns, {});
  assert.deepEqual(r.addedSettings, Object.keys(Calc.DEFAULTS));
  for (const name of Schema.ORDER) {
    const sh = ss.getSheetByName(name);
    assert.deepEqual(sh.dump()[0], Schema.columnNames(name), name);
    assert.equal(sh.frozenRows, 1);
  }
  assert.deepEqual(ss.getSheetByName('Rate Aug-Oct 26').dump(), [['order_date']]);
  assert.deepEqual(Db.settings(ss), Calc.settingsWithDefaults({}));
  const s = Db.readTable('Settings', ss).find(x => x.key === 'min_use_freq');
  assert.equal(s.value, 1 / 7);
  assert.ok(s.note.length > 0);
});

test('ensureSchema: rerun changes nothing and keeps edited settings', () => {
  const ss = fresh();
  const row = Db.readTable('Settings', ss).find(x => x.key === 'cycle_days');
  Db.updateFields('Settings', [{ _row: row._row, value: 7 }], ['value'], ss);
  const r = Db.ensureSchema(ss);
  assert.deepEqual(r, { created: [], addedColumns: {}, addedSettings: [], updatedNotes: [], unusedSettings: [] });
  assert.equal(Db.settings(ss).cycle_days, 7);
  assert.equal(Db.readTable('Settings', ss).length, Object.keys(Calc.DEFAULTS).length);
});

test('ensureSchema: refreshes stale notes, keeps values, reports unused keys', () => {
  const ss = fresh();
  const row = Db.readTable('Settings', ss).find(x => x.key === 'lead_days');
  Db.updateFields('Settings', [{ _row: row._row, value: 2, note: 'old note' }], ['value', 'note'], ss);
  Db.upsert('Settings', [{ key: 'old_rule', value: 0.8, note: '' }, { key: 'usage_from', value: '2026-08-01', note: '' }], ss);
  const r = Db.ensureSchema(ss);
  assert.deepEqual(r.updatedNotes, ['lead_days']);
  assert.deepEqual(r.unusedSettings, ['old_rule']);
  const s = Db.readTable('Settings', ss).find(x => x.key === 'lead_days');
  assert.equal(s.note, Schema.SETTING_NOTES.lead_days);
  assert.equal(Db.settings(ss).lead_days, 2);
  assert.ok(Db.readTable('Settings', ss).some(x => x.key === 'old_rule')); // reported, not deleted
});

test('ensureSchema: adds missing columns at the end, keeps order and data', () => {
  const ss = new FakeSpreadsheet();
  const sh = ss.insertSheet('Users');
  sh.getRange(1, 1, 2, 2).setValues([['name', 'email'], ['Somchai', 'a@example.com']]);
  const r = Db.ensureSchema(ss);
  assert.deepEqual(r.addedColumns, { Users: ['role'] });
  assert.deepEqual(sh.dump(), [['name', 'email', 'role'], ['Somchai', 'a@example.com', '']]);
  assert.deepEqual(strip(Db.readTable('Users', ss)), [{ name: 'Somchai', email: 'a@example.com', role: '' }]);
});

test('ensureColumns: adds the missing columns of one tab, formatted; no-op when complete', () => {
  const ss = fresh();
  assert.deepEqual(Db.ensureColumns('Rounds', ss), []);
  const sh = ss.getSheetByName('Users');
  sh.grid = [['email', 'name']];
  sh.formats = {};
  assert.deepEqual(Db.ensureColumns('Users', ss), ['role']);
  assert.deepEqual(sh.dump()[0], ['email', 'name', 'role']);
  assert.equal(sh.formats[3], '@');
  assert.throws(() => Db.ensureColumns('Nope', ss), /Unknown table|not found/);
  // a tab that doesn't exist yet is created with its header
  ss.sheets = ss.sheets.filter(sh => sh.name !== 'OpdLines');
  assert.deepEqual(Db.ensureColumns('OpdLines', ss), Schema.columnNames('OpdLines'));
  assert.equal(ss.getSheetByName('OpdLines').frozenRows, 1);
});

test('appendRows / readTable: round trip by type, blanks, _row', () => {
  const ss = fresh();
  Db.appendRows('Drugs', [
    { drug_id: 'D001', hosxp_name: 'Drug A', unit: 'เม็ด', par_calc: 100, stocked: true, par_updated: '2026-11-20', item_code: '00123' },
    { drug_id: 'D002', hosxp_name: 'Drug B', unit: 'ขวด', request_factor: '240', critical: 'TRUE' },
  ], ss);
  const sh = ss.getSheetByName('Drugs');
  const header = sh.dump()[0];
  assert.ok(sh.dump()[1][header.indexOf('par_updated')] instanceof Date, 'date column holds a Sheet date');
  const [a, b] = Db.readTable('Drugs', ss);
  assert.equal(a._row, 2);
  assert.equal(a.par_updated, '2026-11-20');
  assert.equal(a.item_code, '00123'); // text column keeps leading zeros
  assert.equal(a.par_calc, 100);
  assert.equal(a.stocked, true);
  assert.equal(a.critical, false); // blank bool
  assert.equal(a.min_par, '');     // blank number
  assert.equal(b.request_factor, 240);
  assert.equal(b.critical, true);
});

test('readTable: reads by column name, whatever the order; skips blank rows; extra columns raw', () => {
  const ss = new FakeSpreadsheet();
  const sh = ss.insertSheet('UsageDaily');
  sh.getRange(1, 1, 4, 4).setValues([
    ['qty', 'my_note', 'drug_id', 'date'],
    [5, 'x', 'D001', new Date(2026, 7, 1)],
    ['', '', '', ''],
    [2, '', 'D002', '2/8/2026'],
  ]);
  assert.deepEqual(strip(Db.readTable('UsageDaily', ss)), [
    { qty: 5, my_note: 'x', drug_id: 'D001', date: '2026-08-01' },
    { qty: 2, my_note: '', drug_id: 'D002', date: '2026-08-02' },
  ]);
});

test('text columns stay text: round_id that looks like a date is not turned into a Date', () => {
  const ss = fresh();
  Db.appendRows('Rounds', [{ round_id: '2026-11-17', count_date: '2026-11-17', status: 'COUNTING', submitted_at: '2026-11-17 14:05' }], ss);
  const [r] = Db.readTable('Rounds', ss);
  assert.equal(r.round_id, '2026-11-17');
  assert.equal(r.count_date, '2026-11-17');
  assert.equal(r.submitted_at, '2026-11-17 14:05');
  // Without the '@' format, the fake (like Sheets) would have stored a Date:
  const raw = ss.getSheetByName('Rounds').dump()[1];
  assert.equal(typeof raw[0], 'string');
});

test('updateFields: writes only the given fields of the given rows', () => {
  const ss = fresh();
  Db.appendRows('Drugs', [
    { drug_id: 'D001', hosxp_name: 'A', par_calc: 1, location: 'ตู้เก็บยา' },
    { drug_id: 'D002', hosxp_name: 'B', par_calc: 2, location: 'ชั้นวางยา' },
  ], ss);
  const [, b] = Db.readTable('Drugs', ss);
  Db.updateFields('Drugs', [{ ...b, par_calc: 20, location: 'changed', par_updated: '2026-11-20' }], ['par_calc', 'par_updated'], ss);
  const [a2, b2] = Db.readTable('Drugs', ss);
  assert.equal(a2.par_calc, 1);
  assert.equal(b2.par_calc, 20);
  assert.equal(b2.par_updated, '2026-11-20');
  assert.equal(b2.location, 'ชั้นวางยา');
  assert.throws(() => Db.updateFields('Drugs', [{ _row: 2 }], ['nope'], ss), /not found/);
  assert.throws(() => Db.updateFields('Drugs', [{ _row: 9 }], ['par_calc'], ss), /Bad _row/);
});

test('upsert: composite key, updates in place, appends new, merges repeats', () => {
  const ss = fresh();
  assert.deepEqual(Db.upsert('RoundLines', [
    { round_id: '2026-11-17', drug_id: 'D001', on_hand: 5 },
    { round_id: '2026-11-17', drug_id: 'D002', on_hand: 0 },
  ], ss), { updated: 0, appended: 2 });
  assert.deepEqual(Db.upsert('RoundLines', [
    { round_id: '2026-11-17', drug_id: 'D002', on_hand: 3 },          // update
    { round_id: '2026-12-01', drug_id: 'D001', on_hand: 9 },          // same drug, new round
    { round_id: '2026-12-01', drug_id: 'D001', flags: 'EDITED' },     // repeat: merged
  ], ss), { updated: 1, appended: 1 });
  assert.deepEqual(strip(Db.readTable('RoundLines', ss)).map(r => [r.round_id, r.drug_id, r.on_hand, r.flags]), [
    ['2026-11-17', 'D001', 5, ''],
    ['2026-11-17', 'D002', 3, ''],
    ['2026-12-01', 'D001', 9, 'EDITED'],
  ]);
  assert.throws(() => Db.upsert('RoundLines', [{ round_id: '2026-11-17', on_hand: 1 }], ss), /Missing key drug_id/);
  assert.throws(() => Db.upsert('Import', [{}], ss), /no key/);
});

test('replaceUsage: replaces the incoming date range only, sorted', () => {
  const ss = fresh();
  Db.replaceUsage([
    { date: '2026-08-02', drug_id: 'D002', qty: 1 },
    { date: '2026-08-01', drug_id: 'D001', qty: 4 },
    { date: '2026-08-03', drug_id: 'D001', qty: 2 },
  ], ss);
  const r = Db.replaceUsage([
    { date: '2026-08-03', drug_id: 'D001', qty: 7 },
    { date: '2026-08-04', drug_id: 'D001', qty: 1 },
  ], ss);
  assert.deepEqual(r, { removed: 1, added: 2, total: 4 });
  assert.deepEqual(strip(Db.readTable('UsageDaily', ss)), [
    { date: '2026-08-01', drug_id: 'D001', qty: 4 },
    { date: '2026-08-02', drug_id: 'D002', qty: 1 },
    { date: '2026-08-03', drug_id: 'D001', qty: 7 },
    { date: '2026-08-04', drug_id: 'D001', qty: 1 },
  ]);
  // shrinking the table clears leftover rows
  Db.rewriteTable('UsageDaily', [{ date: '2026-09-01', drug_id: 'D009', qty: 1 }], ss);
  assert.equal(Db.readTable('UsageDaily', ss).length, 1);
  assert.equal(ss.getSheetByName('UsageDaily').getLastRow(), 2);
});

test('nextDrugId: never reuses a number', () => {
  assert.equal(Db.nextDrugId([]), 'D001');
  assert.equal(Db.nextDrugId(['D001', 'D007', 'x', 'D003']), 'D008');
  assert.equal(Db.nextDrugId(['D999']), 'D1000');
});

test('missing tab: helpful error', () => {
  assert.throws(() => Db.readTable('Drugs', new FakeSpreadsheet()), /ตั้งค่าแท็บข้อมูล/);
});

test('withLock: runs directly without LockService, releases the lock on error', () => {
  assert.equal(Db.withLock(() => 42), 42);
  const calls = [];
  global.LockService = { getDocumentLock: () => ({ waitLock: ms => calls.push('wait ' + ms), releaseLock: () => calls.push('release') }) };
  try {
    assert.throws(() => Db.withLock(() => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(calls, ['wait 30000', 'release']);
  } finally {
    delete global.LockService;
  }
});

test('toCell / fromCell edge cases', () => {
  assert.equal(Db.toCell(null, 'number'), '');
  assert.equal(Db.toCell('1,500', 'number'), 1500);
  assert.equal(Db.toCell('abc', 'number'), '');
  assert.throws(() => Db.toCell('17/11/2026', 'date'), /ISO/);
  assert.equal(Db.fromCell(new Date(2026, 10, 17), 'string'), '2026-11-17');
  assert.equal(Db.fromCell('no', 'bool'), false);
});
