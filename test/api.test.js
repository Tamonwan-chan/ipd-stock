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

test('saveReceived: delivery from main storage, line by line; round marked received when complete', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  Api.saveLines(r.round_id, [
    { drug_id: busy.drug_id, on_hand: 0, final_qty: '' },      // suggestion > 0
    { drug_id: kcl.drug_id, on_hand: 0, final_qty: 3 },
  ], ss);
  Api.approveRound(r.round_id, ss); // receiving happens after approval

  let res = Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: '2' }], ss);
  assert.equal(res.lines[kcl.drug_id], 2);
  assert.equal(res.round.received_at, ''); // Busy tab not checked yet

  res = Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: busy.par }], ss);
  assert.notEqual(res.round.received_at, '');
  const st2 = Api.state(r.round_id, ss);
  assert.equal(st2.lines[kcl.drug_id].received_qty, 2);
  assert.notEqual(st2.round.received_at, '');

  // clearing a line reopens the check
  res = Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: '' }], ss);
  assert.equal(res.round.received_at, '');

  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: -1 }], ss), /ไม่ถูกต้อง/);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: 'D999', received_qty: 1 }], ss), /ไม่ได้เบิก/);
});

test('saveReceived: a line with nothing to request is not part of the check', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  Api.saveLines(r.round_id, [
    { drug_id: busy.drug_id, on_hand: 9999, final_qty: '' }, // full: suggestion 0
    { drug_id: kcl.drug_id, on_hand: 0, final_qty: 3 },
  ], ss);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ไม่ได้เบิก/);
  const res = Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: 3 }], ss);
  assert.notEqual(res.round.received_at, '');
});

test('OPD requests: save, receive line by line, cancel; tabs created in an older Sheet', () => {
  const ss = setup();
  // Sheet from before 18 Nov: no OPD tabs
  ss.sheets = ss.sheets.filter(sh => sh.name !== 'OpdRequests' && sh.name !== 'OpdLines');
  let st = Api.state(null, ss);
  assert.deepEqual(st.opd_requests, []);
  const slow = st.drugs.find(x => x.hosxp_name === 'Slow tab');
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');

  const req = Api.createOpdRequest('MONTHLY', [
    { drug_id: slow.drug_id, qty: 15 },
    { drug_id: busy.drug_id, qty: 0 }, // dropped
  ], '', ss);
  assert.match(req.request_id, /^OPD-\d{4}-\d{2}-\d{2}$/);
  assert.equal(req.status, 'REQUESTED');
  assert.deepEqual(req.lines, [{ drug_id: slow.drug_id, qty: 15, received_qty: '' }]);

  // an urgent fetch the same day for a main-storage drug that ran low
  const urgent = Api.createOpdRequest('URGENT', [{ drug_id: busy.drug_id, qty: 20 }], '', ss);
  assert.equal(urgent.request_id, req.request_id + '-2');

  let got = Api.saveOpdReceived(req.request_id, [{ drug_id: slow.drug_id, received_qty: 10 }], ss);
  assert.equal(got.status, 'RECEIVED');
  assert.notEqual(got.received_at, '');
  assert.equal(got.lines[0].received_qty, 10);

  st = Api.state(null, ss);
  assert.deepEqual(st.opd_requests.map(r => [r.request_id, r.status]),
    [[urgent.request_id, 'REQUESTED'], [req.request_id, 'RECEIVED']]); // open first
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);

  assert.equal(Api.cancelOpdRequest(urgent.request_id, ss).status, 'CANCELLED');
  assert.throws(() => Api.saveOpdReceived(urgent.request_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ยกเลิกแล้ว/);
  assert.throws(() => Api.cancelOpdRequest(req.request_id, ss), /รับยาแล้ว/);
  assert.throws(() => Api.createOpdRequest('WEEKLY', [{ drug_id: slow.drug_id, qty: 1 }], '', ss), /ประเภท/);
  assert.throws(() => Api.createOpdRequest('URGENT', [{ drug_id: slow.drug_id, qty: 0 }], '', ss), /ยังไม่มีรายการ/);
  assert.throws(() => Api.saveOpdReceived(req.request_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ไม่อยู่ในรายการ/);
});

test('counting a drug fetched from OPD: count only, nothing requested; latest count in state', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const slow = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Slow tab');
  const saved = Api.saveLines(r.round_id, [{ drug_id: slow.drug_id, on_hand: 4, final_qty: 99, boxes: 1, pack_size: 10 }], ss);
  assert.deepEqual([saved[slow.drug_id].on_hand, saved[slow.drug_id].suggested_qty, saved[slow.drug_id].final_qty], [4, '', '']);
  const d = Api.state(null, ss).drugs.find(x => x.drug_id === slow.drug_id);
  assert.deepEqual(d.last_count, { qty: 4, date: r.count_date });
});

test('change log: who did what, written by each change', () => {
  const ss = setup();
  Api.setActor('Nurse A');
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 12, final_qty: '' }], ss);
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 12, final_qty: '' }], ss); // no change: no row
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 12, final_qty: 200 }], ss);
  const log = Api.changeLog(3, ss); // newest first; the import before it is logged too
  assert.deepEqual(log.map(x => [x.user, x.action]), [['Nurse A', 'นับ/เบิก'], ['Nurse A', 'นับ/เบิก'], ['Nurse A', 'เริ่มรอบนับ']]);
  assert.match(log[0].detail, /เบิกจริง – → 200/);
  assert.match(log[1].detail, /คงเหลือ – → 12/);
  assert.equal(log[0].target, 'Busy tab 10 mg.');
  assert.equal(Db.readTable('Rounds', ss)[0].counted_by, 'Nurse A');
  Api.setActor('');
});

test('expiry dates at the delivery check: several per line, corrected, removed from the shelf', () => {
  const ss = setup();
  ss.sheets = ss.sheets.filter(sh => sh.name !== 'Expiry'); // older Sheet
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: 100 }], ss);
  let res = Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 100, exp: ['2027-06-30', '2027-03-31', ''] }], ss);
  assert.deepEqual(res.expiry.map(x => x.exp_date), ['2027-03-31', '2027-06-30']); // sorted, blanks ignored
  assert.equal(res.expiry[0].source, 'MAIN');
  // a typo fixed: 2027-06-30 was really 2027-07-31; quantity untouched when not sent
  res = Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, exp: ['2027-03-31', '2027-07-31'] }], ss);
  assert.deepEqual(res.expiry.map(x => x.exp_date), ['2027-03-31', '2027-07-31']);
  assert.equal(res.lines[busy.drug_id], 100);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, exp: ['31/03/2027'] }], ss), /วันหมดอายุไม่ถูกต้อง/);
  // the lot dated March is used up
  const left = Api.removeExpiry(r.round_id, busy.drug_id, '2027-03-31', ss);
  assert.deepEqual(left.map(x => x.exp_date), ['2027-07-31']);
  assert.throws(() => Api.removeExpiry(r.round_id, busy.drug_id, '2027-03-31', ss), /ไม่พบ/);
  assert.deepEqual(Api.state(null, ss).expiry.map(x => x.exp_date), ['2027-07-31']);
  // OPD deliveries carry dates too
  const slow = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Slow tab');
  const req = Api.createOpdRequest('MONTHLY', [{ drug_id: slow.drug_id, qty: 5 }], '', ss);
  const got = Api.saveOpdReceived(req.request_id, [{ drug_id: slow.drug_id, received_qty: 5, exp: ['2026-12-31'] }], ss);
  assert.deepEqual(got.expiry.map(x => [x.exp_date, x.source]), [['2026-12-31', 'OPD'], ['2027-07-31', 'MAIN']]);
  assert.ok(Api.changeLog(20, ss).some(x => x.action === 'ลบวันหมดอายุ'));
});

test('drugCard: counts, requests and deliveries from both sources, newest first', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 10, final_qty: 2, boxes: 2, pack_size: 1 }], ss);
  Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 2, exp: ['2027-01-31'] }], ss);
  Api.createOpdRequest('URGENT', [{ drug_id: busy.drug_id, qty: 20 }], '', ss);
  const c = Api.drugCard(busy.drug_id, ss);
  assert.equal(c.drug.hosxp_name, 'Busy tab');
  assert.deepEqual(c.history.map(h => h.type), ['OPD', 'MAIN']); // same day: the OPD id sorts after the round id
  const main = c.history.find(h => h.type === 'MAIN');
  assert.deepEqual([main.on_hand, main.requested, main.boxes, main.received_qty], [10, 2, 2, 2]);
  assert.deepEqual(c.expiry.map(x => x.exp_date), ['2027-01-31']);
  assert.throws(() => Api.drugCard('D999', ss), /ไม่พบยา/);
});

test('saveDrug: edit in request units, add a new medicine, duplicates refused, logged', () => {
  const ss = setup();
  Api.setActor('Nurse B');
  const slow = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Slow tab');
  // a pharmacist decides to stock it: max 3 packs of 10 = 30 units (request unit = pack of 10)
  Api.saveDrug({ drug_id: slow.drug_id, request_name: 'Slow tab 5 mg', request_unit: 'แผง', request_factor: 10,
    source: 'MAIN', max: 3, min: 1, critical: false }, ss);
  const d = Api.state(null, ss).drugs.find(x => x.drug_id === slow.drug_id);
  assert.deepEqual([d.name, d.unit, d.stocked, d.source, d.par, d.min], ['Slow tab 5 mg', 'แผง', true, 'MAIN', 30, 10]);
  const card = Api.drugCard(slow.drug_id, ss).drug;
  assert.deepEqual([card.max, card.min, card.source], [3, 1, 'MAIN']);
  assert.match(Api.changeLog(1, ss)[0].detail, /เบิกจาก – → MAIN/);

  const id = Api.saveDrug({ hosxp_name: 'New syrup', strength: '60 ml', unit: 'ขวด', source: 'OPD' }, ss);
  const n = Api.state(null, ss).drugs.find(x => x.drug_id === id);
  assert.deepEqual([n.hosxp_name, n.source, n.stocked], ['New syrup', 'OPD', false]);
  assert.equal(Api.changeLog(1, ss)[0].action, 'เพิ่มยา');
  assert.throws(() => Api.saveDrug({ hosxp_name: 'new syrup', strength: '60 ml', unit: 'ขวด' }, ss), /มียานี้อยู่แล้ว/);
  assert.throws(() => Api.saveDrug({ hosxp_name: 'X' }, ss), /หน่วย/);
  assert.throws(() => Api.saveDrug({ drug_id: id, max: 1, min: 2 }, ss), /ต่ำสุดต้องไม่มากกว่าสูงสุด/);
  assert.throws(() => Api.saveDrug({ drug_id: id, source: 'WARD' }, ss), /แหล่งเบิก/);
  // the HOSxP name can't be changed on an existing medicine (later imports match by it)
  Api.saveDrug({ drug_id: id, hosxp_name: 'Renamed', unit: 'ขวด', source: 'OPD' }, ss);
  assert.equal(Api.drugCard(id, ss).drug.hosxp_name, 'New syrup');
  Api.setActor('');
});

test('ui/Client.html: script parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/Client.html'), 'utf8');
  const js = html.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(js));
});
