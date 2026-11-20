/*
 * สต็อกยา IPD
 * ลิขสิทธิ์ © 2569 (2026) ภญ.ธมลวรรณ จันทร์แก้ว สงวนลิขสิทธิ์
 * Copyright © 2026 Tamonwan Chankaew. All rights reserved.
 * Designed & Developed by ภญ.ธมลวรรณ จันทร์แก้ว
 * ห้ามคัดลอก ดัดแปลง หรือนำไปใช้โดยไม่ได้รับอนุญาต ดูเงื่อนไขในไฟล์ LICENSE
 * No use, copying or modification without written permission. See LICENSE.
 * Contact: tamonwanchankaew@gmail.com
 * กลุ่มงานเภสัชกรรม โรงพยาบาลสันกำแพง จังหวัดเชียงใหม่
 */
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

const YY = String(new Date().getFullYear() + 543).slice(2); // document numbers: บ.69/0001, ร.69/0001

test('main-storage ใบเบิก: number at approval, draft check, ใบรับ number at confirm, then locked', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  Api.saveLines(r.round_id, [
    { drug_id: busy.drug_id, on_hand: 0, final_qty: '' },      // suggestion > 0
    { drug_id: kcl.drug_id, on_hand: 0, final_qty: 3 },
  ], ss);
  // not approved yet: not on the delivery list, can't be checked
  assert.deepEqual(Api.state(null, ss).main_docs, []);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: 3 }], ss), /ยังไม่อนุมัติ/);
  assert.throws(() => Api.confirmReceipt(r.round_id, ss), /ยังไม่อนุมัติ/);

  const approved = Api.approveRound(r.round_id, ss);
  assert.equal(approved.req_no, 'บ.' + YY + '/0001');
  assert.throws(() => Api.approveRound(r.round_id, ss), /อนุมัติแล้ว/);
  let docs = Api.state(null, ss).main_docs;
  assert.deepEqual(docs.map(d => [d.req_no, d.receipt_no, d.lines.length]), [['บ.' + YY + '/0001', '', 2]]);

  // draft: saving doesn't finish the check
  let res = Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: '2' }], ss);
  assert.equal(res.doc.lines.find(l => l.drug_id === kcl.drug_id).received_qty, 2);
  assert.equal(res.doc.received_at, '');
  assert.throws(() => Api.confirmReceipt(r.round_id, ss), /ยังไม่ได้ใส่จำนวนที่ได้รับ 1 รายการ/);
  Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 0 }], ss); // nothing came: 0
  assert.equal(Api.state(r.round_id, ss).round.received_at, '');
  // what came needs its expiry date (a line with 0 doesn't)
  assert.throws(() => Api.confirmReceipt(r.round_id, ss), /ยังไม่ได้ใส่วันหมดอายุ 1 รายการ: KCl/);
  Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, exp: ['2027-05-31'] }], ss);

  const doc = Api.confirmReceipt(r.round_id, ss);
  assert.equal(doc.receipt_no, 'ร.' + YY + '/0001');
  assert.notEqual(doc.received_at, '');
  assert.equal(Api.state(r.round_id, ss).lines[kcl.drug_id].received_qty, 2);
  assert.match(Api.changeLog(1, ss)[0].detail, /ใบเบิก บ\.\d\d\/0001: ครบ 0, ขาด 2/);
  // locked: quantities can't change, expiry dates can still be fixed
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: 3 }], ss), /แก้จำนวนที่ได้รับไม่ได้/);
  Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: 2, exp: ['2027-06-30'] }], ss);
  assert.throws(() => Api.confirmReceipt(r.round_id, ss), /ยืนยันรับเข้าคลังแล้ว/);

  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: -1 }], ss), /ไม่ถูกต้อง/);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: 'D999', received_qty: 1 }], ss), /ไม่ได้เบิก/);

  // the next approved round takes the next number; received ones stay listed after the open ones
  const r2 = Api.startRound(ss);
  Api.saveLines(r2.round_id, [{ drug_id: kcl.drug_id, on_hand: 0, final_qty: 1 }], ss);
  assert.equal(Api.approveRound(r2.round_id, ss).req_no, 'บ.' + YY + '/0002');
  docs = Api.state(null, ss).main_docs;
  assert.deepEqual(docs.map(d => [d.req_no, !!d.received_at]), [['บ.' + YY + '/0002', false], ['บ.' + YY + '/0001', true]]);
});

test('saveReceived: a line with nothing to request is not part of the check; nothing requested = no ใบเบิก number', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const kcl = st.drugs.find(x => x.critical);
  Api.saveLines(r.round_id, [
    { drug_id: busy.drug_id, on_hand: 9999, final_qty: '' }, // full: suggestion 0
    { drug_id: kcl.drug_id, on_hand: 0, final_qty: 3 },
  ], ss);
  Api.approveRound(r.round_id, ss);
  assert.throws(() => Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ไม่ได้เบิก/);
  Api.saveReceived(r.round_id, [{ drug_id: kcl.drug_id, received_qty: 3, exp: ['2027-01-31'] }], ss);
  assert.match(Api.confirmReceipt(r.round_id, ss).receipt_no, /^ร\./);

  const r2 = Api.startRound(ss);
  Api.saveLines(r2.round_id, [{ drug_id: busy.drug_id, on_hand: 9999, final_qty: '' }], ss);
  assert.equal(Api.approveRound(r2.round_id, ss).req_no, '');
});

test('OPD requests: ใบเบิก number when saved, draft receive, confirm gives the ใบรับ number, cancel', () => {
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
  assert.equal(req.req_no, 'บ.' + YY + '/0001');
  assert.deepEqual(req.lines, [{ drug_id: slow.drug_id, qty: 15, received_qty: '' }]);

  // an urgent fetch the same day for a main-storage drug that ran low; same number series
  const urgent = Api.createOpdRequest('URGENT', [{ drug_id: busy.drug_id, qty: 20 }], '', ss);
  assert.equal(urgent.request_id, req.request_id + '-2');
  assert.equal(urgent.req_no, 'บ.' + YY + '/0002');

  assert.throws(() => Api.confirmOpdReceipt(req.request_id, ss), /ยังไม่ได้ใส่จำนวนที่ได้รับ 1 รายการ/);
  let got = Api.saveOpdReceived(req.request_id, [{ drug_id: slow.drug_id, received_qty: 10 }], ss);
  assert.equal(got.status, 'REQUESTED'); // a draft until confirmed
  assert.equal(got.lines[0].received_qty, 10);
  assert.throws(() => Api.confirmOpdReceipt(req.request_id, ss), /ยังไม่ได้ใส่วันหมดอายุ/);
  Api.saveOpdReceived(req.request_id, [{ drug_id: slow.drug_id, exp: ['2027-02-28', '2027-04-30'] }], ss);
  got = Api.confirmOpdReceipt(req.request_id, ss);
  assert.deepEqual([got.status, got.receipt_no], ['RECEIVED', 'ร.' + YY + '/0001']);
  assert.notEqual(got.received_at, '');
  assert.throws(() => Api.saveOpdReceived(req.request_id, [{ drug_id: slow.drug_id, received_qty: 15 }], ss), /แก้จำนวนที่ได้รับไม่ได้/);

  st = Api.state(null, ss);
  assert.deepEqual(st.opd_requests.map(r => [r.request_id, r.status]),
    [[urgent.request_id, 'REQUESTED'], [req.request_id, 'RECEIVED']]); // open first
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);

  assert.equal(Api.cancelOpdRequest(urgent.request_id, ss).status, 'CANCELLED');
  assert.throws(() => Api.saveOpdReceived(urgent.request_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ยกเลิกแล้ว/);
  assert.throws(() => Api.confirmOpdReceipt(urgent.request_id, ss), /ยกเลิกแล้ว/);
  assert.throws(() => Api.cancelOpdRequest(req.request_id, ss), /รับยาแล้ว/);
  assert.throws(() => Api.createOpdRequest('WEEKLY', [{ drug_id: slow.drug_id, qty: 1 }], '', ss), /ประเภท/);
  assert.throws(() => Api.createOpdRequest('URGENT', [{ drug_id: slow.drug_id, qty: 0 }], '', ss), /ยังไม่มีรายการ/);
  assert.throws(() => Api.saveOpdReceived(req.request_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ไม่อยู่ในรายการ/);
});

test('ใบเบิกพิเศษ: number when saved, checked like a round, kept off the count page, cancel', () => {
  const ss = setup();
  Api.setActor('Nurse A');
  const st = Api.state(null, ss);
  const busy = st.drugs.find(x => x.hosxp_name === 'Busy tab');
  const slow = st.drugs.find(x => x.hosxp_name === 'Slow tab'); // an OPD drug can be requested from main storage too
  assert.throws(() => Api.createExtraRequest([{ drug_id: busy.drug_id, qty: 0 }], '', ss), /ยังไม่มีรายการ/);
  assert.throws(() => Api.createExtraRequest([{ drug_id: 'D999', qty: 1 }], '', ss), /ไม่พบยา/);

  const doc = Api.createExtraRequest([{ drug_id: busy.drug_id, qty: 30 }, { drug_id: slow.drug_id, qty: '5' }], ' ผู้ป่วยใหม่หลายราย ', ss);
  assert.equal(doc.kind, 'EXTRA');
  assert.equal(doc.status, 'APPROVED');
  assert.equal(doc.note, 'ผู้ป่วยใหม่หลายราย');
  assert.equal(doc.req_no, `บ.${YY}/0001`);
  assert.deepEqual(doc.lines.map(l => [l.drug_id, l.qty]), [[busy.drug_id, 30], [slow.drug_id, 5]]);

  // not a 2-week round: the count page has no round, and starting one makes a normal round
  let s2 = Api.state(null, ss);
  assert.equal(s2.round, null);
  assert.deepEqual(s2.rounds, []);
  assert.deepEqual(s2.main_docs.map(d => d.round_id), [doc.round_id]);
  const r = Api.startRound(ss);
  assert.notEqual(r.round_id, doc.round_id);
  assert.equal(r.kind, '');
  assert.throws(() => Api.saveLines(doc.round_id, [{ drug_id: busy.drug_id, on_hand: 1 }], ss), /ใบเบิกพิเศษ/);
  assert.throws(() => Api.approveRound(doc.round_id, ss), /ใบเบิกพิเศษ/);
  assert.equal(Api.state(null, ss).round.round_id, r.round_id);

  // delivery check exactly like a round's ใบเบิก
  Api.saveReceived(doc.round_id, [{ drug_id: busy.drug_id, received_qty: 30, exp: ['2027-06-30'] },
    { drug_id: slow.drug_id, received_qty: 0 }], ss);
  const got = Api.confirmReceipt(doc.round_id, ss);
  assert.equal(got.receipt_no, `ร.${YY}/0001`);
  const card = Api.drugCard(busy.drug_id, ss);
  assert.deepEqual(card.history.map(h => [h.type, h.kind, h.requested, h.received_qty]), [['MAIN', 'EXTRA', 30, 30]]);
  assert.throws(() => Api.cancelExtraRequest(doc.round_id, ss), /ยกเลิกไม่ได้/);

  // cancel: gone from ตรวจรับยา and the stock card; numbers are not reused
  const doc2 = Api.createExtraRequest([{ drug_id: busy.drug_id, qty: 10 }], '', ss);
  assert.equal(doc2.req_no, `บ.${YY}/0002`);
  assert.notEqual(doc2.round_id, doc.round_id);
  assert.throws(() => Api.cancelExtraRequest(r.round_id, ss), /เฉพาะใบเบิกพิเศษ/);
  assert.equal(Api.cancelExtraRequest(doc2.round_id, ss).status, 'CANCELLED');
  assert.ok(!Api.state(null, ss).main_docs.some(d => d.round_id === doc2.round_id));
  assert.equal(Api.drugCard(busy.drug_id, ss).history.filter(h => h.kind === 'EXTRA').length, 1);
  assert.throws(() => Api.saveReceived(doc2.round_id, [{ drug_id: busy.drug_id, received_qty: 1 }], ss), /ยกเลิกแล้ว/);
  const log = Api.changeLog(50, ss);
  assert.ok(log.some(x => x.action === 'ใบเบิกพิเศษ' && /ผู้ป่วยใหม่หลายราย/.test(x.detail) && x.user === 'Nurse A'));
  assert.ok(log.some(x => x.action === 'ยกเลิกใบเบิกพิเศษ'));
});

test('markPrinted: count sheet while counting, ใบเบิก once approved; shown in state', () => {
  const ss = setup();
  const r = Api.startRound(ss);
  assert.equal(Api.state(null, ss).round.count_printed_at, '');
  Api.markPrinted(r.round_id, 'count', ss);
  assert.match(Api.state(null, ss).round.count_printed_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.throws(() => Api.markPrinted(r.round_id, 'form', ss), /ยังไม่อนุมัติ/);
  assert.throws(() => Api.markPrinted(r.round_id, 'other', ss), /ไม่รู้จัก/);
  Api.approveRound(r.round_id, ss);
  assert.throws(() => Api.markPrinted(r.round_id, 'count', ss), /อนุมัติแล้ว/);
  const info = Api.markPrinted(r.round_id, 'form', ss);
  assert.ok(info.form_printed_at);
  assert.equal(Api.state(null, ss).round.form_printed_at, info.form_printed_at);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  const ex = Api.createExtraRequest([{ drug_id: busy.drug_id, qty: 1 }], '', ss);
  assert.throws(() => Api.markPrinted(ex.round_id, 'form', ss), /ใบเบิกพิเศษ/);
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

test('change log: counts are logged once at approval, not on every autosave', () => {
  const ss = setup();
  Api.setActor('Nurse A');
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  const slow = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Slow tab');
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 1, final_qty: '' }], ss);
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 12, final_qty: '' }, { drug_id: slow.drug_id, on_hand: 4 }], ss);
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 12, final_qty: 200 }], ss);
  assert.equal(Api.changeLog(1, ss)[0].action, 'เริ่มรอบนับ'); // autosaves write nothing to the log
  Api.setActor('Pharmacist B');
  Api.approveRound(r.round_id, ss);
  const log = Api.changeLog(3, ss); // newest first
  assert.deepEqual(log.map(x => [x.user, x.action]), [['Pharmacist B', 'อนุมัติรอบ'], ['Pharmacist B', 'นับ/เบิก'], ['Pharmacist B', 'นับ/เบิก']]);
  assert.equal(log[0].detail, 'ใบเบิก บ.' + YY + '/0001: นับ 2 รายการ, เบิก 1 รายการ');
  const busyRow = log.find(x => x.target === 'Busy tab 10 mg.');
  assert.match(busyRow.detail, /คงเหลือ 12; ควรเบิก \d+; เบิกจริง 200/);
  assert.equal(Db.readTable('Rounds', ss)[0].counted_by, 'Nurse A');
  Api.setActor('');
});

test('expiry dates at the delivery check: several per line, corrected, removed from the shelf', () => {
  const ss = setup();
  ss.sheets = ss.sheets.filter(sh => sh.name !== 'Expiry'); // older Sheet
  const r = Api.startRound(ss);
  const busy = Api.state(null, ss).drugs.find(x => x.hosxp_name === 'Busy tab');
  Api.saveLines(r.round_id, [{ drug_id: busy.drug_id, on_hand: 0, final_qty: 100 }], ss);
  Api.approveRound(r.round_id, ss);
  let res = Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, received_qty: 100, exp: ['2027-06-30', '2027-03-31', ''] }], ss);
  assert.deepEqual(res.expiry.map(x => x.exp_date), ['2027-03-31', '2027-06-30']); // sorted, blanks ignored
  assert.equal(res.expiry[0].source, 'MAIN');
  // a typo fixed: 2027-06-30 was really 2027-07-31; quantity untouched when not sent
  res = Api.saveReceived(r.round_id, [{ drug_id: busy.drug_id, exp: ['2027-03-31', '2027-07-31'] }], ss);
  assert.deepEqual(res.expiry.map(x => x.exp_date), ['2027-03-31', '2027-07-31']);
  assert.equal(res.doc.lines[0].received_qty, 100);
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
  Api.approveRound(r.round_id, ss);
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
  const js = html.replace(/^\s*<!--[\s\S]*?-->/, '').replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(js));
});
