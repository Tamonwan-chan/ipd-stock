/**
 * Api.js — server side of the web app (ui/App.html), called with google.script.run.
 *
 * google.script.run can only call top-level functions, so each api* function below is a
 * thin wrapper around Api.<name>(…, ss). The Api methods take the spreadsheet as the last
 * argument for tests. Everything returned is plain JSON (no Date objects).
 */
var Api = (function () {
  'use strict';

  function calc_() { return typeof Calc !== 'undefined' ? Calc : require('./Calc.js'); }
  function db_() { return typeof Db !== 'undefined' ? Db : require('./Db.js'); }
  function import_() { return typeof Import !== 'undefined' ? Import : require('./Import.js'); }

  function userEmail_() {
    try { return typeof Session !== 'undefined' ? Session.getActiveUser().getEmail() : ''; } catch (e) { return ''; }
  }

  function now_() {
    var d = new Date();
    return db_().fromCell(d, 'datetime');
  }

  function today_() { return db_().fromCell(new Date(), 'date'); }

  function lineFromRow_(l) {
    return {
      on_hand: l.on_hand, par_used: l.par_used, suggested_qty: l.suggested_qty,
      final_qty: l.final_qty, change_reason: l.change_reason || '', flags: l.flags || ''
    };
  }

  function roundInfo_(r) {
    return { round_id: r.round_id, count_date: r.count_date, status: r.status, counted_by: r.counted_by || '',
      approved_at: r.approved_at || '', reviewed_by: r.reviewed_by || '' };
  }

  /**
   * Everything the page needs. `roundId` picks a round (default: the open one, else the latest).
   */
  function state(roundId, ss) {
    var C = calc_(), D = db_();
    var s = D.settings(ss);
    var raw = D.readSettings(ss);
    var drugs = D.readTable('Drugs', ss);
    var rounds = D.readTable('Rounds', ss);
    rounds.sort(function (a, b) { return a.round_id < b.round_id ? 1 : a.round_id > b.round_id ? -1 : 0; });

    var round = null;
    if (roundId) round = rounds.filter(function (r) { return r.round_id === roundId; })[0] || null;
    if (!round) round = rounds.filter(function (r) { return r.status !== 'APPROVED'; })[0] || rounds[0] || null;

    var lines = {};
    if (round) {
      D.readTable('RoundLines', ss).forEach(function (l) {
        if (l.round_id === round.round_id) lines[l.drug_id] = lineFromRow_(l);
      });
    }

    var out = drugs.filter(function (d) { return d.drug_id; }).map(function (d) {
      var p = C.parFromStored(d);
      var factor = C.toNumber(d.request_factor) || 1;
      var manual = String(d.source || '').trim().toUpperCase();
      var source = manual === 'MAIN' || manual === 'OPD' ? manual : (d.source_calc || '');
      var mean = C.toNumber(d.mean_daily) || 0;
      return {
        drug_id: d.drug_id,
        name: String(d.request_name || '').trim() || d.hosxp_name,
        hosxp_name: d.hosxp_name,
        strength: d.strength,
        unit: String(d.request_unit || '').trim() || d.unit,
        hosxp_unit: d.unit,
        factor: factor,
        item_code: d.item_code || '',
        location: d.location || '',
        shelf_order: C.toNumber(d.shelf_order),
        critical: !!d.critical,
        stocked: !!d.stocked,
        source: source,
        pack_size: C.toNumber(d.pack_size),
        par: p.par,
        par_source: p.source,
        mean_daily: mean,
        use_freq: C.toNumber(d.use_freq) || 0,
        opd_suggestion: C.opdSuggestion(mean, factor, s)
      };
    });

    return {
      user: userEmail_(),
      today: today_(),
      settings: { cycle_days: s.cycle_days, lead_days: s.lead_days, delay_days: s.delay_days, z: s.z,
        window_days: C.windowDays(s), main_pack_share: s.main_pack_share },
      usage: { from: D.fromCell(raw.usage_from, 'date'), to: D.fromCell(raw.usage_to, 'date') },
      drugs: out,
      round: round ? roundInfo_(round) : null,
      lines: lines,
      rounds: rounds.slice(0, 20).map(roundInfo_)
    };
  }

  /**
   * Import rows read from a HOSxP file by the page.
   * @param {Array[]} rows  [fileRow, order_date, drug_name, strength, drug_unit, total_quantity, unit_price]
   */
  function importFile(rows, ss) {
    var raw = rows.map(function (r) {
      return { _row: r[0], order_date: r[1], drug_name: r[2], strength: r[3], drug_unit: r[4],
        total_quantity: r[5], unit_price: r[6] };
    });
    db_().ensureSchema(ss);
    return import_().importRows(raw, ss, {});
  }

  /** Open a round for today, or return the round that is still open. */
  function startRound(ss) {
    var D = db_();
    var rounds = D.readTable('Rounds', ss);
    var open = rounds.filter(function (r) { return r.status !== 'APPROVED'; })[0];
    if (open) return roundInfo_(open);
    var today = today_();
    var id = today, n = 2;
    var ids = rounds.map(function (r) { return r.round_id; });
    while (ids.indexOf(id) >= 0) id = today + '-' + n++;
    var r = { round_id: id, count_date: today, status: 'COUNTING', counted_by: userEmail_() };
    D.appendRows('Rounds', [r], ss);
    return roundInfo_(r);
  }

  function roundById_(roundId, ss) {
    var r = db_().readTable('Rounds', ss).filter(function (x) { return x.round_id === roundId; })[0];
    if (!r) throw new Error('ไม่พบรอบ ' + roundId);
    return r;
  }

  /**
   * Save counted / edited lines. The server recomputes par_used, suggested_qty and flags.
   * @param {string} roundId
   * @param {{drug_id:string, on_hand:*, final_qty:*, change_reason:string}[]} edits
   * @return {Object<string, Object>} saved lines by drug_id
   */
  function saveLines(roundId, edits, ss) {
    var C = calc_(), D = db_();
    var round = roundById_(roundId, ss);
    if (round.status === 'APPROVED') throw new Error('รอบนี้อนุมัติแล้ว แก้ไขไม่ได้');
    var s = D.settings(ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });

    var out = {}, rows = [];
    edits.forEach(function (e) {
      var d = drugs[e.drug_id];
      if (!d) throw new Error('ไม่พบยา ' + e.drug_id);
      var p = C.parFromStored(d);
      var factor = C.toNumber(d.request_factor) || 1;
      var order = C.suggestOrder(p.par, e.on_hand, factor);
      var finalQty = C.toNumber(e.final_qty);
      var flags = C.lineFlags({ critical: !!d.critical }, { par: p.par, source: p.source, mean: C.toNumber(d.mean_daily) || 0 },
        order, finalQty === null ? '' : finalQty, factor, s);
      var line = {
        round_id: roundId, drug_id: e.drug_id,
        on_hand: order.counted ? C.toNumber(e.on_hand) : '',
        par_used: p.par,
        suggested_qty: order.qty === null ? '' : order.qty,
        final_qty: finalQty === null ? '' : finalQty,
        change_reason: e.change_reason || '',
        flags: flags.join(' ')
      };
      rows.push(line);
      out[e.drug_id] = lineFromRow_(line);
    });
    D.upsert('RoundLines', rows, ss);
    if (!round.counted_by) D.updateFields('Rounds', [{ _row: round._row, counted_by: userEmail_() }], ['counted_by'], ss);
    return out;
  }

  /** Approve (freeze) a round. */
  function approveRound(roundId, ss) {
    var D = db_();
    var round = roundById_(roundId, ss);
    round.status = 'APPROVED';
    round.approved_at = now_();
    round.reviewed_by = userEmail_();
    D.updateFields('Rounds', [round], ['status', 'approved_at', 'reviewed_by'], ss);
    return roundInfo_(round);
  }

  return { state: state, importFile: importFile, startRound: startRound, saveLines: saveLines, approveRound: approveRound };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Api;

// ---------------------------------------------------------- google.script.run entry points

function apiState(roundId) {
  try {
    return Api.state(roundId);
  } catch (e) {
    if (!/not found/.test(e.message)) throw e;
    Db.withLock(function () { Db.ensureSchema(); }); // first visit: tabs not created yet
    return Api.state(roundId);
  }
}
function apiImportFile(rows) { return Db.withLock(function () { return Api.importFile(rows); }); }
function apiStartRound() { return Db.withLock(function () { return Api.startRound(); }); }
function apiSaveLines(roundId, edits) { return Db.withLock(function () { return Api.saveLines(roundId, edits); }); }
function apiApproveRound(roundId) { return Db.withLock(function () { return Api.approveRound(roundId); }); }
