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
  function schema_() { return typeof Schema !== 'undefined' ? Schema : require('./Schema.js'); }

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
      final_qty: l.final_qty, received_qty: l.received_qty === undefined ? '' : l.received_qty,
      boxes: l.boxes === undefined ? '' : l.boxes,
      pack_size: l.pack_size === undefined ? '' : l.pack_size,
      change_reason: l.change_reason || '', flags: l.flags || ''
    };
  }

  function roundInfo_(r) {
    return { round_id: r.round_id, count_date: r.count_date, status: r.status, counted_by: r.counted_by || '',
      approved_at: r.approved_at || '', reviewed_by: r.reviewed_by || '',
      received_at: r.received_at || '', received_by: r.received_by || '' };
  }

  /** Rows of a tab that may not exist yet in an older Sheet (created on first write). */
  function readOptional_(name, ss) {
    try { return db_().readTable(name, ss); } catch (e) {
      if (/not found/.test(e.message)) return [];
      throw e;
    }
  }

  /** Quantity requested on a round line: the edited quantity, else the suggestion. */
  function requested_(l) {
    var C = calc_();
    var f = C.toNumber(l.final_qty);
    return f !== null ? f : C.toNumber(l.suggested_qty);
  }

  /** Received quantity typed by staff: blank = not checked yet; must be a number ≥ 0. */
  function receivedValue_(v) {
    var C = calc_();
    if (C.isBlank(v) || String(v).trim() === '') return '';
    var n = C.toNumber(v);
    if (n === null || n < 0) throw new Error('จำนวนที่ได้รับไม่ถูกต้อง: ' + v);
    return n;
  }

  /** OPD requests with their lines, newest first: every open one, then the last 10 closed. */
  function opdRequests_(ss) {
    var lines = {};
    readOptional_('OpdLines', ss).forEach(function (l) {
      (lines[l.request_id] = lines[l.request_id] || []).push({ drug_id: l.drug_id, qty: l.qty, received_qty: l.received_qty });
    });
    var reqs = readOptional_('OpdRequests', ss);
    reqs.sort(function (a, b) { return a.request_id < b.request_id ? 1 : a.request_id > b.request_id ? -1 : 0; });
    var open = reqs.filter(function (r) { return r.status === 'REQUESTED'; });
    var closed = reqs.filter(function (r) { return r.status !== 'REQUESTED'; }).slice(0, 10);
    return open.concat(closed).map(function (r) { return opdInfo_(r, lines[r.request_id] || []); });
  }

  function opdInfo_(r, lines) {
    return { request_id: r.request_id, request_date: r.request_date, kind: r.kind, status: r.status,
      requested_by: r.requested_by || '', received_at: r.received_at || '', received_by: r.received_by || '',
      note: r.note || '', lines: lines };
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
      var mn = C.minFromStored(d);
      var factor = C.toNumber(d.request_factor) || 1;
      var manual = String(d.source || '').trim().toUpperCase();
      // Source in effect, consistent with `stocked` (written by recompute via Calc.stockDecision):
      // stocked → MAIN; NONE (billing-only rows) or placeholder (no source_calc) → neither list;
      // anything else not stocked → OPD, including expensive drugs the rule would put in MAIN.
      var source = manual === 'NONE' ? '' : d.stocked ? 'MAIN' : (manual === 'OPD' || d.source_calc) ? 'OPD' : '';
      var mean = C.toNumber(d.mean_daily) || 0;
      return {
        drug_id: d.drug_id,
        name: String(d.request_name || '').trim() || d.hosxp_name,
        hosxp_name: d.hosxp_name,
        strength: d.strength,
        unit: String(d.request_unit || '').trim() || d.unit,
        hosxp_unit: d.unit,
        factor: factor,
        pack_size: C.toNumber(d.pack_size),
        item_code: d.item_code || '',
        location: d.location || '',
        shelf_order: C.toNumber(d.shelf_order),
        critical: !!d.critical,
        stocked: !!d.stocked,
        source: source,
        par: p.par,
        par_source: p.source,
        min: mn.min,
        min_source: mn.source,
        mean_daily: mean,
        use_freq: C.toNumber(d.use_freq) || 0,
        opd_suggestion: C.opdSuggestion(mean, factor, s)
      };
    });

    return {
      user: userEmail_(),
      today: today_(),
      settings: { cycle_days: s.cycle_days, lead_days: s.lead_days, delay_days: s.delay_days, z: s.z,
        window_days: C.windowDays(s), min_days: C.minDays(s), min_use_freq: s.min_use_freq,
        opd_cycle_days: s.opd_cycle_days },
      usage: { from: D.fromCell(raw.usage_from, 'date'), to: D.fromCell(raw.usage_to, 'date') },
      drugs: out,
      round: round ? roundInfo_(round) : null,
      lines: lines,
      rounds: rounds.slice(0, 20).map(roundInfo_),
      opd_requests: opdRequests_(ss)
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
   * When `boxes` and `pack_size` (units per box) are both given, final_qty = boxes × pack_size.
   * A typed pack_size is remembered on the drug (Drugs.pack_size) and offered again next round.
   * @param {string} roundId
   * @param {{drug_id:string, on_hand:*, final_qty:*, boxes:*, pack_size:*, change_reason:string}[]} edits
   * @return {Object<string, Object>} saved lines by drug_id
   */
  function saveLines(roundId, edits, ss) {
    var C = calc_(), D = db_();
    var round = roundById_(roundId, ss);
    if (round.status === 'APPROVED') throw new Error('รอบนี้อนุมัติแล้ว แก้ไขไม่ได้');
    D.ensureColumns('RoundLines', ss); // Sheets set up before boxes / pack_size existed
    D.ensureColumns('Drugs', ss);
    var s = D.settings(ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });

    var out = {}, rows = [], packs = {};
    edits.forEach(function (e) {
      var d = drugs[e.drug_id];
      if (!d) throw new Error('ไม่พบยา ' + e.drug_id);
      var p = C.parFromStored(d);
      var factor = C.toNumber(d.request_factor) || 1;
      var order = C.suggestOrder(p.par, e.on_hand, factor);
      var pack = C.toNumber(e.pack_size);
      if (pack !== null && pack <= 0) pack = null;
      var byBox = C.boxQty(e.boxes, pack);
      var finalQty = byBox !== null ? byBox : C.toNumber(e.final_qty);
      if (pack !== null && pack !== C.toNumber(d.pack_size)) { d.pack_size = pack; packs[e.drug_id] = d; }
      var flags = C.lineFlags({ critical: !!d.critical },
        { par: p.par, source: p.source, mean: C.toNumber(d.mean_daily) || 0, min: C.minFromStored(d).min },
        order, finalQty === null ? '' : finalQty, factor, s);
      var line = {
        round_id: roundId, drug_id: e.drug_id,
        on_hand: order.counted ? C.toNumber(e.on_hand) : '',
        par_used: p.par,
        suggested_qty: order.qty === null ? '' : order.qty,
        final_qty: finalQty === null ? '' : finalQty,
        boxes: byBox === null ? '' : C.toNumber(e.boxes),
        pack_size: pack === null ? '' : pack,
        change_reason: e.change_reason || '',
        flags: flags.join(' ')
      };
      rows.push(line);
      out[e.drug_id] = lineFromRow_(line);
    });
    D.upsert('RoundLines', rows, ss);
    var changed = Object.keys(packs).map(function (id) { return packs[id]; });
    if (changed.length) D.updateFields('Drugs', changed, ['pack_size'], ss);
    if (!round.counted_by) D.updateFields('Rounds', [{ _row: round._row, counted_by: userEmail_() }], ['counted_by'], ss);
    return out;
  }

  /**
   * Record what main storage delivered for a round (ตรวจรับ). Allowed after approval.
   * The round is marked received once every requested line has a received quantity.
   * @param {{drug_id:string, received_qty:*}[]} edits  blank = not checked yet
   * @return {{lines:Object<string,*>, round:Object}} received_qty by drug_id, and the round
   */
  function saveReceived(roundId, edits, ss) {
    var D = db_();
    D.ensureColumns('Rounds', ss); // Sheets set up before receiving existed
    D.ensureColumns('RoundLines', ss);
    var round = roundById_(roundId, ss);
    var lines = {};
    D.readTable('RoundLines', ss).forEach(function (l) { if (l.round_id === roundId) lines[l.drug_id] = l; });
    var rows = [], out = {};
    edits.forEach(function (e) {
      var l = lines[e.drug_id];
      if (!l || !(requested_(l) > 0)) throw new Error('รายการนี้ไม่ได้เบิกในรอบนี้: ' + e.drug_id);
      l.received_qty = receivedValue_(e.received_qty);
      rows.push({ round_id: roundId, drug_id: e.drug_id, received_qty: l.received_qty });
      out[e.drug_id] = l.received_qty;
    });
    D.upsert('RoundLines', rows, ss);
    var done = Object.keys(lines).every(function (id) {
      var l = lines[id];
      return !(requested_(l) > 0) || l.received_qty !== '';
    });
    if (done && !round.received_at) {
      round.received_at = now_();
      round.received_by = userEmail_();
    } else if (!done) {
      round.received_at = '';
      round.received_by = '';
    }
    D.updateFields('Rounds', [round], ['received_at', 'received_by'], ss);
    return { lines: out, round: roundInfo_(round) };
  }

  /**
   * Save a request to the OPD pharmacy (printed and taken to OPD).
   * @param {string} kind  MONTHLY (the monthly list) or URGENT (a drug running low)
   * @param {{drug_id:string, qty:*}[]} lines  lines with qty ≤ 0 are dropped
   */
  function createOpdRequest(kind, lines, note, ss) {
    var C = calc_(), D = db_();
    if (schema_().ENUMS.kind.indexOf(kind) < 0) throw new Error('ไม่รู้จักประเภทการขอ: ' + kind);
    D.ensureColumns('OpdRequests', ss);
    D.ensureColumns('OpdLines', ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var seen = {};
    var rows = lines.map(function (l) {
      if (!drugs[l.drug_id]) throw new Error('ไม่พบยา ' + l.drug_id);
      if (seen[l.drug_id]) throw new Error('ยาซ้ำในรายการ ' + l.drug_id);
      seen[l.drug_id] = true;
      return { drug_id: l.drug_id, qty: C.toNumber(l.qty) };
    }).filter(function (l) { return l.qty > 0; });
    if (!rows.length) throw new Error('ยังไม่มีรายการที่จะขอ');

    var today = today_();
    var ids = D.readTable('OpdRequests', ss).map(function (r) { return r.request_id; });
    var id = 'OPD-' + today, n = 2;
    while (ids.indexOf(id) >= 0) id = 'OPD-' + today + '-' + n++;
    var r = { request_id: id, request_date: today, kind: kind, status: 'REQUESTED', requested_by: userEmail_(), note: note || '' };
    D.appendRows('OpdRequests', [r], ss);
    var out = rows.map(function (l) { return { request_id: id, drug_id: l.drug_id, qty: l.qty, received_qty: '' }; });
    D.appendRows('OpdLines', out, ss);
    return opdInfo_(r, out.map(function (l) { return { drug_id: l.drug_id, qty: l.qty, received_qty: '' }; }));
  }

  function opdById_(requestId, ss) {
    var r = db_().readTable('OpdRequests', ss).filter(function (x) { return x.request_id === requestId; })[0];
    if (!r) throw new Error('ไม่พบรายการขอ ' + requestId);
    return r;
  }

  /**
   * Record what OPD handed over. The request is RECEIVED once every line has a quantity.
   * @param {{drug_id:string, received_qty:*}[]} edits
   */
  function saveOpdReceived(requestId, edits, ss) {
    var D = db_();
    var r = opdById_(requestId, ss);
    if (r.status === 'CANCELLED') throw new Error('รายการขอนี้ยกเลิกแล้ว');
    var lines = {};
    D.readTable('OpdLines', ss).forEach(function (l) { if (l.request_id === requestId) lines[l.drug_id] = l; });
    var rows = edits.map(function (e) {
      var l = lines[e.drug_id];
      if (!l) throw new Error('ยานี้ไม่อยู่ในรายการขอ: ' + e.drug_id);
      l.received_qty = receivedValue_(e.received_qty);
      return { request_id: requestId, drug_id: e.drug_id, received_qty: l.received_qty };
    });
    D.upsert('OpdLines', rows, ss);
    var done = Object.keys(lines).every(function (id) { return lines[id].received_qty !== ''; });
    if (done && r.status !== 'RECEIVED') {
      r.status = 'RECEIVED'; r.received_at = now_(); r.received_by = userEmail_();
    } else if (!done) {
      r.status = 'REQUESTED'; r.received_at = ''; r.received_by = '';
    }
    D.updateFields('OpdRequests', [r], ['status', 'received_at', 'received_by'], ss);
    return opdInfo_(r, Object.keys(lines).map(function (id) {
      var l = lines[id];
      return { drug_id: l.drug_id, qty: l.qty, received_qty: l.received_qty };
    }));
  }

  /** Cancel a request that was saved by mistake or never taken to OPD. */
  function cancelOpdRequest(requestId, ss) {
    var r = opdById_(requestId, ss);
    if (r.status === 'RECEIVED') throw new Error('รับยาแล้ว ยกเลิกไม่ได้');
    r.status = 'CANCELLED';
    db_().updateFields('OpdRequests', [r], ['status'], ss);
    return opdInfo_(r, []);
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

  return { state: state, importFile: importFile, startRound: startRound, saveLines: saveLines, approveRound: approveRound,
    saveReceived: saveReceived, createOpdRequest: createOpdRequest, saveOpdReceived: saveOpdReceived,
    cancelOpdRequest: cancelOpdRequest };
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
function apiSaveReceived(roundId, edits) { return Db.withLock(function () { return Api.saveReceived(roundId, edits); }); }
function apiCreateOpdRequest(kind, lines, note) { return Db.withLock(function () { return Api.createOpdRequest(kind, lines, note); }); }
function apiSaveOpdReceived(requestId, edits) { return Db.withLock(function () { return Api.saveOpdReceived(requestId, edits); }); }
function apiCancelOpdRequest(requestId) { return Db.withLock(function () { return Api.cancelOpdRequest(requestId); }); }
function apiApproveRound(roundId) { return Db.withLock(function () { return Api.approveRound(roundId); }); }
