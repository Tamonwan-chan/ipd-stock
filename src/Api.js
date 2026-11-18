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

  // The signed-in user's name, set by the api* wrappers (Auth.check) before each call.
  // Each google.script.run call is its own execution, so this never leaks between users.
  var actor = '';
  function setActor(name) { actor = String(name || ''); }
  function actor_() { return actor; }

  /**
   * Append rows to the change log: [action, target, detail]. Who and when are added here.
   * Actions and details are in Thai (read by the admin).
   */
  function log_(entries, ss) {
    if (!entries.length) return;
    var D = db_();
    D.ensureColumns('ChangeLog', ss);
    var at = now_();
    D.appendRows('ChangeLog', entries.map(function (e) {
      return { at: at, user: actor_(), action: e[0], target: e[1] || '', detail: e[2] || '' };
    }), ss);
  }

  function drugLabel_(d) {
    if (!d) return '';
    var name = String(d.request_name || '').trim() || String(d.hosxp_name || '');
    var st = String(d.strength || '').trim();
    return st && name.indexOf(st) < 0 ? name + ' ' + st : name;
  }

  function show_(v) { return v === '' || v === null || v === undefined ? '–' : String(v); }

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

    var lines = {}, lastCount = {};
    var roundDate = {};
    rounds.forEach(function (r) { roundDate[r.round_id] = r.count_date; });
    D.readTable('RoundLines', ss).forEach(function (l) {
      if (round && l.round_id === round.round_id) lines[l.drug_id] = lineFromRow_(l);
      var q = C.toNumber(l.on_hand), dt = roundDate[l.round_id];
      if (q === null || !dt) return;
      var prev = lastCount[l.drug_id];
      if (!prev || dt > prev.date) lastCount[l.drug_id] = { qty: q, date: dt };
    });

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
        opd_suggestion: C.opdSuggestion(mean, factor, s),
        manual_source: manual,
        last_count: lastCount[d.drug_id] || null
      };
    });

    return {
      today: today_(),
      settings: { cycle_days: s.cycle_days, lead_days: s.lead_days, delay_days: s.delay_days, z: s.z,
        window_days: C.windowDays(s), min_days: C.minDays(s), min_use_freq: s.min_use_freq,
        opd_cycle_days: s.opd_cycle_days },
      usage: { from: D.fromCell(raw.usage_from, 'date'), to: D.fromCell(raw.usage_to, 'date') },
      drugs: out,
      round: round ? roundInfo_(round) : null,
      lines: lines,
      rounds: rounds.slice(0, 20).map(roundInfo_),
      opd_requests: opdRequests_(ss),
      expiry: expiryOnHand_(readOptional_('Expiry', ss))
    };
  }

  // ------------------------------------------------------------------ expiry

  /** Expiry rows still on the shelf, by expiry date. */
  function expiryOnHand_(rows) {
    return rows.filter(function (x) { return x.exp_date && !x.removed_at; }).map(function (x) {
      return { ref: x.ref, drug_id: x.drug_id, exp_date: x.exp_date, source: x.source || '' };
    }).sort(function (a, b) { return a.exp_date < b.exp_date ? -1 : a.exp_date > b.exp_date ? 1 : 0; });
  }

  function expDates_(list) {
    if (!Array.isArray(list)) return null;
    var seen = {}, out = [];
    list.forEach(function (v) {
      var t = String(v === null || v === undefined ? '' : v).trim();
      if (!t) return;
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      if (!m || +m[1] < 2000 || +m[1] > 2100 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) {
        throw new Error('วันหมดอายุไม่ถูกต้อง: ' + t);
      }
      if (!seen[t]) { seen[t] = true; out.push(t); }
    });
    return out.sort();
  }

  /**
   * Make the expiry dates of one delivery line (ref + drug) equal `dates`: new dates are
   * added (or brought back), dates no longer listed are removed. Returns [added, removed].
   */
  function setExpiry_(source, ref, drugId, dates, all, rows) {
    var have = {};
    all.forEach(function (x) { if (x.ref === ref && x.drug_id === drugId) have[x.exp_date] = x; });
    var added = [], removed = [], at = now_();
    dates.forEach(function (dt) {
      var x = have[dt];
      if (!x) {
        rows.push({ ref: ref, drug_id: drugId, exp_date: dt, source: source, added_at: at, added_by: actor_(), removed_at: '', removed_by: '' });
        added.push(dt);
      } else if (x.removed_at) {
        rows.push({ ref: ref, drug_id: drugId, exp_date: dt, removed_at: '', removed_by: '' });
        added.push(dt);
      }
    });
    Object.keys(have).forEach(function (dt) {
      if (dates.indexOf(dt) < 0 && !have[dt].removed_at) {
        rows.push({ ref: ref, drug_id: drugId, exp_date: dt, removed_at: at, removed_by: actor_() });
        removed.push(dt);
      }
    });
    return [added, removed];
  }

  function expiryText_(change) {
    var parts = [];
    if (change[0].length) parts.push('วันหมดอายุ +' + change[0].join(', +'));
    if (change[1].length) parts.push('ลบวันหมดอายุ ' + change[1].join(', '));
    return parts.join('; ');
  }

  /** Staff remove an expiry date from the shelf (used up, or typed by mistake). */
  function removeExpiry(ref, drugId, expDate, ss) {
    var D = db_();
    var x = readOptional_('Expiry', ss).filter(function (r) {
      return r.ref === ref && r.drug_id === drugId && r.exp_date === expDate && !r.removed_at;
    })[0];
    if (!x) throw new Error('ไม่พบวันหมดอายุนี้ (อาจถูกลบไปแล้ว)');
    x.removed_at = now_();
    x.removed_by = actor_();
    D.updateFields('Expiry', [x], ['removed_at', 'removed_by'], ss);
    var drug = D.readTable('Drugs', ss).filter(function (d) { return d.drug_id === drugId; })[0];
    log_([['ลบวันหมดอายุ', drugLabel_(drug) || drugId, expDate + ' (' + ref + ')']], ss);
    return expiryOnHand_(readOptional_('Expiry', ss));
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
    var r = import_().importRows(raw, ss, {});
    if (r.ok) log_([['นำเข้าข้อมูล HOSxP', r.from + ' ถึง ' + r.to, r.rows + ' แถว, ยาใหม่ ' + r.newDrugs.length + ' รายการ']], ss);
    return r;
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
    var r = { round_id: id, count_date: today, status: 'COUNTING', counted_by: actor_() };
    D.appendRows('Rounds', [r], ss);
    log_([['เริ่มรอบนับ', id, '']], ss);
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

    var old = {};
    D.readTable('RoundLines', ss).forEach(function (l) { if (l.round_id === roundId) old[l.drug_id] = l; });
    var out = {}, rows = [], packs = {}, logs = [];
    edits.forEach(function (e) {
      var d = drugs[e.drug_id];
      if (!d) throw new Error('ไม่พบยา ' + e.drug_id);
      if (!d.stocked) {
        // Drugs fetched from OPD are counted too (what is left on the IPD shelf), but not requested.
        var n = C.toNumber(e.on_hand);
        if (n !== null && n < 0) throw new Error('จำนวนคงเหลือไม่ถูกต้อง: ' + e.on_hand);
        var cl = { round_id: roundId, drug_id: e.drug_id, on_hand: n === null ? '' : n, par_used: '', suggested_qty: '',
          final_qty: '', boxes: '', pack_size: '', change_reason: '', flags: '' };
        rows.push(cl);
        out[e.drug_id] = lineFromRow_(cl);
        var was = old[e.drug_id] ? old[e.drug_id].on_hand : '';
        if (show_(was) !== show_(cl.on_hand)) logs.push(['นับยา', drugLabel_(d), 'คงเหลือ ' + show_(was) + ' → ' + show_(cl.on_hand)]);
        return;
      }
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
      var o = old[e.drug_id] || {}, diff = [];
      if (show_(o.on_hand) !== show_(line.on_hand)) diff.push('คงเหลือ ' + show_(o.on_hand) + ' → ' + show_(line.on_hand));
      if (show_(o.final_qty) !== show_(line.final_qty)) diff.push('เบิกจริง ' + show_(o.final_qty) + ' → ' + show_(line.final_qty));
      if (show_(o.boxes) !== show_(line.boxes) || show_(o.pack_size) !== show_(line.pack_size)) {
        diff.push('กล่อง ' + show_(o.boxes) + '×' + show_(o.pack_size) + ' → ' + show_(line.boxes) + '×' + show_(line.pack_size));
      }
      if ((o.change_reason || '') !== line.change_reason) diff.push('เหตุผล: ' + show_(line.change_reason));
      if (diff.length) logs.push(['นับ/เบิก', drugLabel_(d), diff.join('; ')]);
    });
    D.upsert('RoundLines', rows, ss);
    log_(logs.map(function (x) { x[2] = 'รอบ ' + roundId + ': ' + x[2]; return x; }), ss);
    var changed = Object.keys(packs).map(function (id) { return packs[id]; });
    if (changed.length) D.updateFields('Drugs', changed, ['pack_size'], ss);
    if (!round.counted_by) D.updateFields('Rounds', [{ _row: round._row, counted_by: actor_() }], ['counted_by'], ss);
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
    D.ensureColumns('Expiry', ss);
    var round = roundById_(roundId, ss);
    var lines = {};
    D.readTable('RoundLines', ss).forEach(function (l) { if (l.round_id === roundId) lines[l.drug_id] = l; });
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var lots = D.readTable('Expiry', ss), lotRows = [];
    var rows = [], out = {}, logs = [];
    edits.forEach(function (e) {
      var l = lines[e.drug_id];
      if (!l || !(requested_(l) > 0)) throw new Error('รายการนี้ไม่ได้เบิกในรอบนี้: ' + e.drug_id);
      var was = l.received_qty;
      var diff = [];
      if (e.received_qty !== undefined) {
        l.received_qty = receivedValue_(e.received_qty);
        rows.push({ round_id: roundId, drug_id: e.drug_id, received_qty: l.received_qty });
        if (show_(was) !== show_(l.received_qty)) diff.push('ได้รับ ' + show_(was) + ' → ' + show_(l.received_qty));
      }
      out[e.drug_id] = l.received_qty === undefined ? '' : l.received_qty;
      var dates = expDates_(e.exp);
      if (dates) {
        var t = expiryText_(setExpiry_('MAIN', roundId, e.drug_id, dates, lots, lotRows));
        if (t) diff.push(t);
      }
      if (diff.length) logs.push(['ตรวจรับจากคลัง', drugLabel_(drugs[e.drug_id]) || e.drug_id, 'รอบ ' + roundId + ': ' + diff.join('; ')]);
    });
    if (rows.length) D.upsert('RoundLines', rows, ss);
    if (lotRows.length) D.upsert('Expiry', lotRows, ss);
    log_(logs, ss);
    var done = Object.keys(lines).every(function (id) {
      var l = lines[id];
      return !(requested_(l) > 0) || l.received_qty !== '';
    });
    if (done && !round.received_at) {
      round.received_at = now_();
      round.received_by = actor_();
    } else if (!done) {
      round.received_at = '';
      round.received_by = '';
    }
    D.updateFields('Rounds', [round], ['received_at', 'received_by'], ss);
    return { lines: out, round: roundInfo_(round), expiry: expiryOnHand_(D.readTable('Expiry', ss)) };
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
    var r = { request_id: id, request_date: today, kind: kind, status: 'REQUESTED', requested_by: actor_(), note: note || '' };
    D.appendRows('OpdRequests', [r], ss);
    var out = rows.map(function (l) { return { request_id: id, drug_id: l.drug_id, qty: l.qty, received_qty: '' }; });
    D.appendRows('OpdLines', out, ss);
    log_([['ขอยาจาก OPD', id, (kind === 'URGENT' ? 'ด่วน' : 'ประจำเดือน') + ': ' + rows.map(function (l) {
      return drugLabel_(drugs[l.drug_id]) + ' ' + l.qty;
    }).join(', ')]], ss);
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
    D.ensureColumns('Expiry', ss);
    var r = opdById_(requestId, ss);
    if (r.status === 'CANCELLED') throw new Error('รายการขอนี้ยกเลิกแล้ว');
    var lines = {};
    D.readTable('OpdLines', ss).forEach(function (l) { if (l.request_id === requestId) lines[l.drug_id] = l; });
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var lots = D.readTable('Expiry', ss), lotRows = [], logs = [], rows = [];
    edits.forEach(function (e) {
      var l = lines[e.drug_id];
      if (!l) throw new Error('ยานี้ไม่อยู่ในรายการขอ: ' + e.drug_id);
      var was = l.received_qty, diff = [];
      if (e.received_qty !== undefined) {
        l.received_qty = receivedValue_(e.received_qty);
        rows.push({ request_id: requestId, drug_id: e.drug_id, received_qty: l.received_qty });
        if (show_(was) !== show_(l.received_qty)) diff.push('ได้รับ ' + show_(was) + ' → ' + show_(l.received_qty));
      }
      var dates = expDates_(e.exp);
      if (dates) {
        var t = expiryText_(setExpiry_('OPD', requestId, e.drug_id, dates, lots, lotRows));
        if (t) diff.push(t);
      }
      if (diff.length) logs.push(['รับยาจาก OPD', drugLabel_(drugs[e.drug_id]) || e.drug_id, requestId + ': ' + diff.join('; ')]);
    });
    if (rows.length) D.upsert('OpdLines', rows, ss);
    if (lotRows.length) D.upsert('Expiry', lotRows, ss);
    log_(logs, ss);
    var done = Object.keys(lines).every(function (id) { return lines[id].received_qty !== ''; });
    if (done && r.status !== 'RECEIVED') {
      r.status = 'RECEIVED'; r.received_at = now_(); r.received_by = actor_();
    } else if (!done) {
      r.status = 'REQUESTED'; r.received_at = ''; r.received_by = '';
    }
    D.updateFields('OpdRequests', [r], ['status', 'received_at', 'received_by'], ss);
    var info = opdInfo_(r, Object.keys(lines).map(function (id) {
      var l = lines[id];
      return { drug_id: l.drug_id, qty: l.qty, received_qty: l.received_qty };
    }));
    info.expiry = expiryOnHand_(D.readTable('Expiry', ss));
    return info;
  }

  /** Cancel a request that was saved by mistake or never taken to OPD. */
  function cancelOpdRequest(requestId, ss) {
    var r = opdById_(requestId, ss);
    if (r.status === 'RECEIVED') throw new Error('รับยาแล้ว ยกเลิกไม่ได้');
    r.status = 'CANCELLED';
    db_().updateFields('OpdRequests', [r], ['status'], ss);
    log_([['ยกเลิกการขอจาก OPD', requestId, '']], ss);
    return opdInfo_(r, []);
  }

  /** Approve (freeze) a round. */
  function approveRound(roundId, ss) {
    var D = db_();
    var round = roundById_(roundId, ss);
    round.status = 'APPROVED';
    round.approved_at = now_();
    round.reviewed_by = actor_();
    D.updateFields('Rounds', [round], ['status', 'approved_at', 'reviewed_by'], ss);
    log_([['อนุมัติรอบ', roundId, '']], ss);
    return roundInfo_(round);
  }

  // -------------------------------------------------------------- medicines

  /** Request units → HOSxP units for a typed max/min (blank stays blank). */
  function toHosxp_(v, factor, label) {
    var C = calc_();
    if (C.isBlank(v) || String(v).trim() === '') return '';
    var n = C.toNumber(v);
    if (n === null || n < 0) throw new Error(label + 'ไม่ถูกต้อง: ' + v);
    return Math.round(n * factor * 1e6) / 1e6;
  }

  function editable_(d) {
    var C = calc_();
    var f = C.toNumber(d.request_factor) || 1;
    var po = C.toNumber(d.par_override), mo = C.toNumber(d.min_override);
    return {
      drug_id: d.drug_id, hosxp_name: d.hosxp_name || '', strength: d.strength || '', unit: d.unit || '',
      request_name: d.request_name || '', request_unit: d.request_unit || '',
      request_factor: C.toNumber(d.request_factor) === null ? '' : C.toNumber(d.request_factor),
      item_code: d.item_code || '', pack_size: C.toNumber(d.pack_size) === null ? '' : C.toNumber(d.pack_size),
      source: String(d.source || '').trim().toUpperCase(), critical: !!d.critical,
      max: po === null ? '' : Math.round(po / f * 1e6) / 1e6, min: mo === null ? '' : Math.round(mo / f * 1e6) / 1e6
    };
  }

  /**
   * One medicine's stock card: its editable fields, every count / request / delivery
   * (main storage and OPD), newest first, and the expiry dates on the shelf.
   */
  function drugCard(drugId, ss) {
    var C = calc_(), D = db_();
    var d = D.readTable('Drugs', ss).filter(function (x) { return x.drug_id === drugId; })[0];
    if (!d) throw new Error('ไม่พบยา ' + drugId);
    var rounds = {};
    D.readTable('Rounds', ss).forEach(function (r) { rounds[r.round_id] = r; });
    var hist = [];
    D.readTable('RoundLines', ss).forEach(function (l) {
      if (l.drug_id !== drugId || !rounds[l.round_id]) return;
      var r = rounds[l.round_id], req = requested_(l);
      hist.push({ type: 'MAIN', ref: l.round_id, date: r.count_date, status: r.status,
        on_hand: l.on_hand, requested: req === null ? '' : req,
        boxes: l.boxes === undefined ? '' : l.boxes, pack_size: l.pack_size === undefined ? '' : l.pack_size,
        received_qty: l.received_qty === undefined ? '' : l.received_qty, received_at: r.received_at || '' });
    });
    var reqs = {};
    readOptional_('OpdRequests', ss).forEach(function (r) { reqs[r.request_id] = r; });
    readOptional_('OpdLines', ss).forEach(function (l) {
      var r = reqs[l.request_id];
      if (l.drug_id !== drugId || !r || r.status === 'CANCELLED') return;
      hist.push({ type: 'OPD', ref: l.request_id, date: r.request_date, status: r.status, kind: r.kind,
        on_hand: '', requested: C.toNumber(l.qty), received_qty: l.received_qty, received_at: r.received_at || '' });
    });
    hist.sort(function (a, b) {
      return a.date < b.date ? 1 : a.date > b.date ? -1 : a.ref < b.ref ? 1 : a.ref > b.ref ? -1 : 0;
    });
    var lots = expiryOnHand_(readOptional_('Expiry', ss)).filter(function (x) { return x.drug_id === drugId; });
    return { drug: editable_(d), history: hist, expiry: lots };
  }

  var DRUG_FIELDS = [
    ['request_name', 'ชื่อที่ใช้เบิก'], ['request_unit', 'หน่วยเบิก'], ['request_factor', 'จำนวนหน่วย HOSxP ต่อหน่วยเบิก'],
    ['item_code', 'หมายเลขพัสดุ'], ['pack_size', 'จำนวนต่อกล่อง'], ['source', 'เบิกจาก'], ['critical', 'ยาห้ามขาด'],
    ['par_override', 'สูงสุด (กำหนดเอง)'], ['min_override', 'ต่ำสุด (กำหนดเอง)']
  ];

  /**
   * Add or edit a medicine. New medicines need the HOSxP name, strength and unit exactly as
   * HOSxP writes them (so later imports match them); those three can't be changed later.
   * `max` / `min` are typed in request units and stored in HOSxP units (par_override / min_override).
   * Recomputes the stock rules afterwards, so the lists update at once.
   * @return {string} drug_id
   */
  function saveDrug(f, ss) {
    var C = calc_(), D = db_();
    D.ensureColumns('Drugs', ss);
    var drugs = D.readTable('Drugs', ss);
    var isNew = !f.drug_id;
    var d;
    if (isNew) {
      var name = String(f.hosxp_name || '').trim(), unit = String(f.unit || '').trim();
      if (!name || !unit) throw new Error('ใส่ชื่อยาและหน่วยตาม HOSxP');
      var key = C.drugKey(name, f.strength, unit).toLowerCase();
      if (drugs.some(function (x) { return C.drugKey(x.hosxp_name, x.strength, x.unit).toLowerCase() === key; })) {
        throw new Error('มียานี้อยู่แล้ว (ชื่อ ขนาด และหน่วยตรงกัน)');
      }
      d = { drug_id: D.nextDrugId(drugs.map(function (x) { return x.drug_id; })), hosxp_name: name,
        strength: String(f.strength || '').trim(), unit: unit, stocked: false, critical: false };
    } else {
      d = drugs.filter(function (x) { return x.drug_id === f.drug_id; })[0];
      if (!d) throw new Error('ไม่พบยา ' + f.drug_id);
    }
    var source = String(f.source || '').trim().toUpperCase();
    if (source && ['MAIN', 'OPD', 'NONE'].indexOf(source) < 0) throw new Error('ไม่รู้จักแหล่งเบิก ' + f.source);
    var factor = C.isBlank(f.request_factor) || String(f.request_factor).trim() === '' ? '' : C.toNumber(f.request_factor);
    if (factor !== '' && !(factor > 0)) throw new Error('จำนวนหน่วย HOSxP ต่อหน่วยเบิก ต้องมากกว่า 0');
    var pack = C.isBlank(f.pack_size) || String(f.pack_size).trim() === '' ? '' : C.toNumber(f.pack_size);
    if (pack !== '' && !(pack > 0)) throw new Error('จำนวนต่อกล่อง ต้องมากกว่า 0');
    var fx = factor || 1;
    var next = {
      request_name: String(f.request_name || '').trim(), request_unit: String(f.request_unit || '').trim(),
      request_factor: factor, item_code: String(f.item_code || '').trim(), pack_size: pack,
      source: source, critical: !!f.critical,
      par_override: toHosxp_(f.max, fx, 'สูงสุด'), min_override: toHosxp_(f.min, fx, 'ต่ำสุด')
    };
    if (next.par_override !== '' && next.min_override !== '' && next.min_override > next.par_override) {
      throw new Error('ต่ำสุดต้องไม่มากกว่าสูงสุด');
    }
    var changes = [], fields = [];
    DRUG_FIELDS.forEach(function (fl) {
      var k = fl[0], was = d[k] === undefined || d[k] === null ? '' : d[k], now = next[k];
      if (k === 'critical') { was = !!was; }
      if (String(was) === String(now)) return;
      fields.push(k);
      changes.push(fl[1] + ' ' + show_(k === 'critical' ? (was ? 'ใช่' : 'ไม่') : was) + ' → ' +
        show_(k === 'critical' ? (now ? 'ใช่' : 'ไม่') : now));
      d[k] = now;
    });
    if (isNew) {
      D.appendRows('Drugs', [d], ss);
      log_([['เพิ่มยา', drugLabel_(d), 'HOSxP: ' + d.hosxp_name + ' | ' + d.strength + ' | ' + d.unit + (changes.length ? '; ' + changes.join('; ') : '')]], ss);
    } else {
      if (!fields.length) return d.drug_id;
      D.updateFields('Drugs', [d], fields, ss);
      log_([['แก้ข้อมูลยา', drugLabel_(d), changes.join('; ')]], ss);
    }
    import_().recompute(ss);
    return d.drug_id;
  }

  /** The newest change-log rows (admin). */
  function changeLog(limit, ss) {
    var rows = readOptional_('ChangeLog', ss).map(function (r) {
      return { at: r.at, user: r.user, action: r.action, target: r.target, detail: r.detail };
    });
    rows.reverse();
    return rows.slice(0, limit || 500);
  }

  return { state: state, importFile: importFile, startRound: startRound, saveLines: saveLines, approveRound: approveRound,
    saveReceived: saveReceived, createOpdRequest: createOpdRequest, saveOpdReceived: saveOpdReceived,
    cancelOpdRequest: cancelOpdRequest, removeExpiry: removeExpiry, drugCard: drugCard, saveDrug: saveDrug,
    changeLog: changeLog, setActor: setActor, log: log_ };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Api;

// ---------------------------------------------------------- google.script.run entry points
// Every call carries the session token from apiLogin. session_() checks it (Auth.check), and
// the user's name goes into Rounds, OPD requests, Expiry and the ChangeLog.

function session_(token, role) {
  var u = Auth.check(token, role);
  Api.setActor(u.name);
  return u;
}
function locked_(token, role, fn) {
  var u = session_(token, role);
  return Db.withLock(function () { return fn(u); });
}

function apiLogin(username, password) {
  return Db.withLock(function () {
    var r = Auth.login(username, password);
    Api.setActor(r.user.name);
    Api.log([['เข้าสู่ระบบ', r.user.username, '']]);
    return r;
  });
}
function apiLogout(token) { Auth.logout(token); }

function apiState(token, roundId) {
  var u = session_(token);
  var st;
  try {
    st = Api.state(roundId);
  } catch (e) {
    if (!/not found/.test(e.message)) throw e;
    Db.withLock(function () { Db.ensureSchema(); }); // first visit: tabs not created yet
    st = Api.state(roundId);
  }
  st.user = u;
  return st;
}
function apiImportFile(token, rows) { return locked_(token, null, function () { return Api.importFile(rows); }); }
function apiStartRound(token) { return locked_(token, null, function () { return Api.startRound(); }); }
function apiSaveLines(token, roundId, edits) { return locked_(token, null, function () { return Api.saveLines(roundId, edits); }); }
function apiSaveReceived(token, roundId, edits) { return locked_(token, null, function () { return Api.saveReceived(roundId, edits); }); }
function apiCreateOpdRequest(token, kind, lines, note) { return locked_(token, null, function () { return Api.createOpdRequest(kind, lines, note); }); }
function apiSaveOpdReceived(token, requestId, edits) { return locked_(token, null, function () { return Api.saveOpdReceived(requestId, edits); }); }
function apiCancelOpdRequest(token, requestId) { return locked_(token, null, function () { return Api.cancelOpdRequest(requestId); }); }
function apiApproveRound(token, roundId) { return locked_(token, null, function () { return Api.approveRound(roundId); }); }
function apiRemoveExpiry(token, ref, drugId, expDate) { return locked_(token, null, function () { return Api.removeExpiry(ref, drugId, expDate); }); }
function apiDrugCard(token, drugId) { session_(token); return Api.drugCard(drugId); }
function apiSaveDrug(token, fields) { return locked_(token, null, function () { return Api.saveDrug(fields); }); }
function apiChangePassword(token, oldPw, newPw) {
  return locked_(token, null, function (u) {
    Auth.changePassword(u.username, oldPw, newPw);
    Api.log([['เปลี่ยนรหัสผ่าน', u.username, '']]);
  });
}

// admin only
function apiUsers(token) { session_(token, 'admin'); return Auth.listUsers(); }
function apiSaveUser(token, user) {
  return locked_(token, 'admin', function () {
    var r = Auth.saveUser(user);
    if (r.changes.length) Api.log([[r.created ? 'เพิ่มผู้ใช้' : 'แก้ผู้ใช้', r.user.username, r.changes.join('; ')]]);
    return Auth.listUsers();
  });
}
function apiChangeLog(token, limit) { session_(token, 'admin'); return Api.changeLog(limit); }
