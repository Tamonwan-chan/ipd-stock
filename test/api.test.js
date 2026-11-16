// Tests for src/Api.js (server side of the web app) against an in-memory spreadsheet.
// Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Db = require('../src/Db.js');
const Api = require('../src/Api.js');
const { FakeSpreadsheet } = require('./fake-spreadsheet.js');

function setup() {
  const ss = new FakeSpreadsheet();
  Db.ensureSchema(ss);
  const rows = [];
  let n = 2;
  for (let day = 1; day <= 28; day++) {
    rows.push([n++, `${day}/8/2026`, 'Busy tab', '10 mg.', 'เม็ด', 10, 1]);
    rows.push([n++, `${day}/8/2026`, 'Slow tab', '5 mg.', 'เม็ด', 1, 2]);
    rows.push([n++, `${day}/8/2026`, 'KCl inj *HAD*', '', 'Amp', day % 7 === 0 ? 5 : 0, 10]);
  }
  const r = Api.importFile(rows, ss);
  assert.equal(r.ok, true, (r.errors || []).join('\n'));
  // pack sizes: Busy 100 (MAIN), Slow 100 (OPD)
  const d = Object.fromEntries(Db.readTable('Drugs', ss).map(x => [x.hosxp_name, x]));
  Db.updateFields('Drugs', [{ ...d['Busy tab'], pack_size: 100 }, { ...d['Slow tab'], pack_size: 100 }], ['pack_size'], ss);
  require('../src/Import.js').recompute(ss, { today: '2026-11-16' });
  return ss;
}

test('importFile: rows from the page import like the Import tab', () => {
  const ss = setup();
  assert.equal(Db.readTable('Drugs', ss).length, 3);
  assert.equal(Db.readTable('UsageDaily', ss).length, 28 * 2 + 4);
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
  assert.equal(d['Slow tab'].opd_suggestion, 14);
  assert.equal(d['KCl inj *HAD*'].critical, true);
  assert.ok(d['Busy tab'].par >= 160); // 10/day × 16 days, steady
  assert.equal(st.settings.window_days, 16);
  // nothing that google.script.run can't send
  assert.deepEqual(JSON.parse(JSON.stringify(st)), st);
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

test('ui/Client.html: script parses', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/Client.html'), 'utf8');
  const js = html.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
  assert.doesNotThrow(() => new Function(js));
});
