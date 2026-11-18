// Tests for src/Api.js (server side of the web app) against an in-memory spreadsheet.
// Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../src/Db.js');
const Api = require('../src/Api.js');
const Import = require('../src/Import.js');
const { FakeSpreadsheet } = require('./fake-spreadsheet.js');

function setup() {
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  const rows = [];
  let n = 2;
  for (let day = 1; day <= 28; day++) {
    rows.push([n++, `${day}/8/2026`, 'Busy tab', '10 mg.', 'เม็ด', 10, 1]);
    if (day % 14 === 7) rows.push([n++, `${day}/8/2026`, 'Slow tab', '5 mg.', 'เม็ด', 7, 2]); // 2 of 28 days
    rows.push([n++, `${day}/8/2026`, 'KCl inj *HAD*', '', 'Amp', day % 7 === 0 ? 5 : 0, 10]);
  }
  const r = Api.importFile(rows, ss);
  assert.equal(r.ok, true, (r.errors || []).join('\n'));
  return ss;
}

test('importFile: rows from the page import like the Import tab', () => {
  const ss = setup();
  assert.equal(Db.readTable('Drugs', ss).length, 3);
  assert.equal(Db.readTable('UsageDaily', ss).length, 28 + 2 + 4);
  const bad = Api.importFile([[5, '31/2/2026', 'X', '', 'เม็ด', 1, 1]], ss);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^แถว 5:/); // the file's row number
});

test('state: drugs with par and source, usage window, no round yet; JSON only', () => {
  const ss = setup();
  const st = Api.state(null, ss);
  assert.deepEqual(st.usage, { from: '2026-08-01', to: '2026-08-28' });
  assert.equal(st.round, null);
  const d = Object.fromEntries(st.drugs.map(x => [x.hosxp_name, x]));
  assert.deepEqual([d['Busy tab'].source, d['Busy tab'].stocked], ['MAIN', true]);
  assert.deepEqual([d['Slow tab'].source, d['Slow tab'].stocked], ['OPD', false]);
  assert.equal(d['Slow tab'].opd_suggestion, 15); // 14 used in 28 days → 15 per 30-day OPD cycle
  assert.equal(st.settings.opd_cycle_days, 30);
  assert.equal(d['KCl inj *HAD*'].critical, true);
  assert.ok(d['Busy tab'].par >= 160); // 10/day × 16 days, steady
  assert.equal(st.settings.window_days, 16);
  assert.equal(st.settings.min_days, 2);
  assert.deepEqual([d['Busy tab'].min, d['Busy tab'].min_source], [20, 'calc']); // 10/day × 2 days, steady
  // nothing that google.script.run can't send
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
});

test('state: source NONE (billing-only row) is on neither the count nor the OPD list', () => {
  const ss = setup();
  const drugs = Db.readTable('Drugs', ss);
  const slow = drugs.find(x => x.hosxp_name === 'Slow tab');
  const busy = drugs.find(x => x.hosxp_name === 'Busy tab');
  slow.source = 'NONE';
  busy.source = 'NONE';
  Db.updateFields('Drugs', [slow, busy], ['source'], ss);
  Import.recompute(ss);
  const d = Object.fromEntries(Api.state(null, ss).drugs.map(x => [x.hosxp_name, x]));
  assert.deepEqual([d['Slow tab'].source, d['Slow tab'].stocked], ['', false]);
  assert.deepEqual([d['Busy tab'].source, d['Busy tab'].stocked], ['', false]);
});

test('state: expensive, infrequent drug is on the OPD list until the pharmacist sets a par', () => {
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  const rows = [];
  let n = 2;
  for (let day = 1; day <= 28; day++) {
    rows.push([n++, `${day}/8/2026`, 'Busy tab', '10 mg.', 'เม็ด', 10, 1]);
    // used on 8 of 28 days (≥ weekly, < half) at 1000 THB each → expensive tier
    if (day % 7 === 0 || day % 7 === 3) rows.push([n++, `${day}/8/2026`, 'Pricey inj', '1 g.', 'Vial', 2, 1000]);
  }
  assert.equal(Api.importFile(rows, ss).ok, true);
  let p = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Pricey inj');
  assert.deepEqual([p.source, p.stocked], ['OPD', false]);

  const d = Db.readTable('Drugs', ss).find(x => x.hosxp_name === 'Pricey inj');
  assert.equal(d.source_calc, 'MAIN'); // the frequency rule alone would stock it
  d.par_override = 6;
  Db.updateFields('Drugs', [d], ['par_override'], ss);
  Import.recompute(ss);
  p = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Pricey inj');
  assert.deepEqual([p.source, p.stocked, p.par], ['MAIN', true, 6]);
});

test('round: start, save lines (server recomputes), reopen same round, approve locks', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  assert.equal(r.status, 'COUNTING');
  assert.deepEqual(Api.startRound(ss), r); // one open round at a time

  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  const saved = Api.saveLines(r.round_id, [
    { drug_id: busy.drug_id, on_hand: '40', final_qty: '', change_reason: '' },
    { drug_id: kcl.drug_id, on_hand: 0, final_qty: 3, change_reason: 'ห้องฉุกเฉินยืมไป' },
  ], ss);
  assert.equal(saved[busy.drug_id].suggested_qty, busy.par - 40);
  assert.equal(saved[busy.drug_id].flags, '');
  assert.equal(saved[kcl.drug_id].final_qty, 3);
  assert.match(saved[kcl.drug_id].flags, /CRITICAL_LOW/);
  assert.match(saved[kcl.drug_id].flags, /EDITED/);

  // under min (20 for Busy tab) → BELOW_MIN
  const low = Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 15, final_qty: '' }], ss);
  assert.match(low[busy.drug_id].flags, /BELOW_MIN/);

  // a later save of the same drug updates the line, not a new one
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 50, final_qty: '' }], ss);
  const st2 = Api.state(null, ss);
  assert.equal(st2.round.round_id, r.round_id);
  assert.equal(st2.lines[busy.drug_id].on_hand, 50);
  assert.equal(Db.readTable('RoundLines', ss).length, 2);

  const a = Api.approveRound(r.round_id, ss);
  assert.equal(a.status, 'APPROVED');
  assert.throws(() => Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 1 }], ss), /อนุมัติแล้ว/);
  // approved round still shows (latest), and a new round gets a new id
  assert.equal(Api.state(null, ss).round.status, 'APPROVED');
  const r2 = Api.startRound(ss);
  assert.notEqual(r2.round_id, r.round_id);
  assert.equal(Api.state(null, ss).round.round_id, r2.round_id);
  assert.equal(Api.state(r.round_id, ss).round.round_id, r.round_id); // pick an older round
});

// Simulate a Sheet set up before a column existed: remove it from the tab.
function dropColumn(ss, tab, name) {
  const sh = ss.getSheetByName(tab);
  const i = sh.grid[0].indexOf(name);
  assert.ok(i >= 0, name);
  sh.grid.forEach(row => row.splice(i, 1));
  const f = {};
  for (const [c, v] of Object.entries(sh.formats)) if (+c !== i + 1) f[+c > i + 1 ? +c - 1 : c] = v;
  sh.formats = f;
}

test('saveLines: boxes × units per box sets final_qty; units per box remembered on the drug', () => {
  const ss = setup();
  dropColumn(ss, 'Drugs', 'pack_size'); // Sheet from before 18 Nov: columns added on first save
  dropColumn(ss, 'RoundLines', 'boxes');
  dropColumn(ss, 'RoundLines', 'pack_size');
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  assert.equal(busy.pack_size, null);

  let saved = Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: 7, boxes: 1, pack_size: 1000 }], ss);
  assert.deepEqual([saved[busy.drug_id].final_qty, saved[busy.drug_id].boxes, saved[busy.drug_id].pack_size], [1000, 1, 1000]);
  assert.match(saved[busy.drug_id].flags, /EDITED/);
  let st = Api.state(null, ss);
  assert.equal(st.drugs.find(x => x.drug_id === busy.drug_id).pack_size, 1000);
  assert.deepEqual([st.lines[busy.drug_id].boxes, st.lines[busy.drug_id].pack_size], [1, 1000]);

  // no boxes: final_qty as typed; the units per box is still recorded
  saved = Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: 300, boxes: '', pack_size: 1000 }], ss);
  assert.deepEqual([saved[busy.drug_id].final_qty, saved[busy.drug_id].boxes], [300, '']);

  // main storage changed the box: 500 per box replaces 1000 for next time
  saved = Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: '', boxes: 2, pack_size: 500 }], ss);
  assert.equal(saved[busy.drug_id].final_qty, 1000);
  st = Api.state(null, ss);
  assert.equal(st.drugs.find(x => x.drug_id === busy.drug_id).pack_size, 500);
  assert.equal(Db.readTable('RoundLines', ss).length, 1);

  // clearing the units per box on a line keeps the drug's remembered value
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: 5, boxes: '', pack_size: '' }], ss);
  assert.equal(Api.state(null, ss).drugs.find(x => x.drug_id === busy.drug_id).pack_size, 500);
});

test('saveLines: blank count is "not counted", unknown drug fails', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  const saved = Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: '', final_qty: '' }], ss);
  assert.equal(saved[busy.drug_id].on_hand, '');
  assert.equal(saved[busy.drug_id].suggested_qty, '');
  assert.match(saved[busy.drug_id].flags, /NOT_COUNTED/);
  assert.throws(() => Api.saveLines(r.round_id, [{ drug_id: 'D999', on_hand: 1 }], ss), /ไม่พบยา/);
  assert.throws(() => Api.saveLines('nope', [], ss), /ไม่พบรอบ/);
});

test('saveLocations: writes location and shelf_order, checks the place name', () => {
  const ss = setup();
  const st = Api.state(null, ss);
  assert.deepEqual(st.locations, ['ตู้เก็บยา', 'ชั้นวางยา', 'ลิ้นชักยา']);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  assert.equal(Api.saveLocations([
    { drug_id: busy.drug_id, location: 'ชั้นวางยา', shelf_order: 20 },
    { drug_id: kcl.drug_id, location: 'ชั้นวางยา', shelf_order: '10' },
  ], ss), 2);
  let d = Object.fromEntries(Api.state(null, ss).drugs.map(x => [x.drug_id, x]));
  assert.deepEqual([d[busy.drug_id].location, d[busy.drug_id].shelf_order], ['ชั้นวางยา', 20]);
  assert.equal(d[kcl.drug_id].shelf_order, 10);

  // back to "not set": the order is cleared too
  Api.saveLocations([{ drug_id: busy.drug_id, location: '', shelf_order: 30 }], ss);
  d = Object.fromEntries(Api.state(null, ss).drugs.map(x => [x.drug_id, x]));
  assert.deepEqual([d[busy.drug_id].location, d[busy.drug_id].shelf_order], ['', null]);

  assert.throws(() => Api.saveLocations([{ drug_id: busy.drug_id, location: 'ตู้เย็น', shelf_order: 1 }], ss), /ไม่รู้จักที่เก็บ/);
  assert.throws(() => Api.saveLocations([{ drug_id: 'D999', location: '', shelf_order: '' }], ss), /ไม่พบยา/);
});

test('ui/Client.html: script parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/Client.html'), 'utf8');
  const js = html.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(js));
});
