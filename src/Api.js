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
      received_at: r.received_at || '', received_by: r.received_by || '',
      req_no: r.req_no || '', receipt_no: r.receipt_no || '',
      kind: isExtra_(r) ? 'EXTRA' : '', note: r.note || '',
      count_printed_at: r.count_printed_at || '', form_printed_at: r.form_printed_at || '',
      data_from: r.data_from || '', data_to: r.data_to || '',
      import_from: r.import_from || '', import_to: r.import_to || '', import_at: r.import_at || '' };
  }

  /** The HOSxP data in use now: the max/min window and the last file imported. */
  function dataNow_(ss) {
    var D = db_(), raw = D.readSettings(ss);
    var out = { data_from: D.fromCell(raw.usage_from, 'date'), data_to: D.fromCell(raw.usage_to, 'date'),
      import_from: D.fromCell(raw.import_from, 'date'), import_to: D.fromCell(raw.import_to, 'date'),
      import_at: D.fromCell(raw.import_at, 'datetime'), import_by: String(raw.import_by || '') };
    if (!out.import_to) {
      // Imported before these Settings rows existed: take the last import in the change log.
      var last = readOptional_('ChangeLog', ss).filter(function (x) { return x.action === 'นำเข้าข้อมูล HOSxP'; }).pop();
      var m = last && /^(\d{4}-\d{2}-\d{2}) ถึง (\d{4}-\d{2}-\d{2})$/.exec(String(last.target || ''));
      if (m) { out.import_from = m[1]; out.import_to = m[2]; out.import_at = last.at || ''; out.import_by = last.user || ''; }
    }
    return out;
  }

  /** A ใบเบิกพิเศษ (extra main-storage request outside the 2-week round), kept in Rounds. */
  function isExtra_(r) { return String(r.kind || '').trim().toUpperCase() === 'EXTRA'; }

  /**
   * Next document number: ใบเบิก 'บ' (req_no) or ใบรับ 'ร' (receipt_no), e.g. บ.69/0001.
   * One series for main storage and OPD together, starting at 0001 each Thai (B.E.) year.
   */
  function nextNo_(prefix, field, ss) {
    var head = prefix + '.' + String(Number(today_().slice(0, 4)) + 543).slice(2) + '/';
    var max = 0;
    ['Rounds', 'OpdRequests'].forEach(function (t) {
      readOptional_(t, ss).forEach(function (r) {
        var v = String(r[field] || '');
        if (v.indexOf(head) !== 0) return;
        var n = parseInt(v.slice(head.length), 10);
        if (n > max) max = n;
      });
    });
    var s = String(max + 1);
    while (s.length < 4) s = '0' + s;
    return head + s;
  }

  /** Main-storage ใบเบิก (an approved round) with its requested lines, for the delivery check. */
  function mainDoc_(r, lines) {
    var info = roundInfo_(r);
    info.lines = (lines || []).filter(function (l) { return requested_(l) > 0; }).map(function (l) {
      return { drug_id: l.drug_id, qty: requested_(l), boxes: l.boxes === undefined ? '' : l.boxes,
        pack_size: l.pack_size === undefined ? '' : l.pack_size,
        received_qty: l.received_qty === undefined ? '' : l.received_qty };
    });
    return info;
  }

  /** Short result of a check: "ครบ 10, ขาด 2" (lines are {qty, received_qty}). */
  function recvSummary_(lines) {
    var C = calc_(), ok = 0, short = 0, over = 0;
    lines.forEach(function (l) {
      var q = C.toNumber(l.qty), v = C.toNumber(l.received_qty);
      if (v === q) ok++; else if (v < q) short++; else over++;
    });
    return 'ครบ ' + ok + (short ? ', ขาด ' + short : '') + (over ? ', เกิน ' + over : '');
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
      note: r.note || '', req_no: r.req_no || '', receipt_no: r.receipt_no || '', lines: lines };
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
    // The count page only knows the 2-week rounds; ใบเบิกพิเศษ appear in main_docs (ตรวจรับยา).
    var cycle = rounds.filter(function (r) { return !isExtra_(r); });

    var round = null;
    if (roundId) round = cycle.filter(function (r) { return r.round_id === roundId; })[0] || null;
    if (!round) round = cycle.filter(function (r) { return r.status !== 'APPROVED'; })[0] || cycle[0] || null;

    var lines = {}, byRound = {};
    var roundLines = D.readTable('RoundLines', ss);
    roundLines.forEach(function (l) {
      if (round && l.round_id === round.round_id) lines[l.drug_id] = lineFromRow_(l);
      (byRound[l.round_id] = byRound[l.round_id] || []).push(l);
    });
    var opdCount = latestOpdCounts_(ss);
    var lastCount = lastCounts_(rounds, roundLines, opdCount);

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
        last_count: lastCount[d.drug_id] || null,
        opd_count: opdCount[d.drug_id] || null // latest count typed on the OPD page
      };
    });

    return {
      today: today_(),
      settings: { cycle_days: s.cycle_days, lead_days: s.lead_days, delay_days: s.delay_days, z: s.z,
        window_days: C.windowDays(s), min_days: C.minDays(s), min_use_freq: s.min_use_freq,
        opd_cycle_days: s.opd_cycle_days },
      usage: { from: D.fromCell(raw.usage_from, 'date'), to: D.fromCell(raw.usage_to, 'date') },
      data: dataNow_(ss),
      drugs: out,
      round: round ? roundInfo_(round) : null,
      lines: lines,
      rounds: cycle.slice(0, 20).map(roundInfo_),
      main_docs: mainDocs_(rounds, byRound),
      opd_requests: opdRequests_(ss),
      expiry: expiryOnHand_(readOptional_('Expiry', ss))
    };
  }

  /**
   * Main-storage ใบเบิก for ตรวจรับยา, newest first: every approved one still waiting for its
   * delivery check, then the last 10 received. Rounds not approved yet are never listed.
   * ใบเบิกพิเศษ are included (approved when saved; cancelled ones are left out).
   */
  function mainDocs_(rounds, byRound) {
    var docs = rounds.filter(function (r) { return r.status === 'APPROVED'; }).map(function (r) {
      return mainDoc_(r, byRound[r.round_id]);
    }).filter(function (d) { return d.lines.length; });
    var open = docs.filter(function (d) { return !d.received_at; });
    var done = docs.filter(function (d) { return d.received_at; }).slice(0, 10);
    return open.concat(done);
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
    if (!r.ok) return r;
    log_([['นำเข้าข้อมูล HOSxP', r.from + ' ถึง ' + r.to, r.rows + ' แถว, ยาใหม่ ' + r.newDrugs.length + ' รายการ']], ss);
    // The file staff dragged in (its dates, when, who), shown on the count page and count sheet
    // so they can confirm the round uses the right file.
    var note = 'ไฟล์ HOSxP ที่นำเข้าล่าสุด (เขียนโดยโปรแกรม)';
    db_().upsert('Settings', [
      { key: 'import_from', value: r.from, note: note }, { key: 'import_to', value: r.to, note: note },
      { key: 'import_at', value: now_(), note: note }, { key: 'import_by', value: actor_(), note: note }
    ], ss);
    // Importing is step 1 of a round: when the last round is approved, open the next one, so
    // the count page shows a round staff can type into (not the approved, locked one).
    var cycle = db_().readTable('Rounds', ss).filter(function (x) { return !isExtra_(x); });
    if (cycle.length && !openRound_(cycle)) r.newRound = startRound(ss);
    return r;
  }

  function openRound_(rounds) {
    return rounds.filter(function (r) { return !isExtra_(r) && r.status !== 'APPROVED'; })[0] || null;
  }

  /** Open a round for today, or return the round that is still open. */
  function startRound(ss) {
    var D = db_();
    var rounds = D.readTable('Rounds', ss);
    var open = openRound_(rounds);
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
    if (isExtra_(round)) throw new Error('ใบเบิกพิเศษไม่มีการนับ แก้ในหน้านับยาไม่ได้');
    if (round.status === 'APPROVED') throw new Error('รอบนี้อนุมัติแล้ว แก้ไขไม่ได้');
    D.ensureColumns('RoundLines', ss); // Sheets set up before boxes / pack_size existed
    D.ensureColumns('Drugs', ss);
    var s = D.settings(ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });

    // Not logged here: this runs on every autosave. approveRound logs the final lines once.
    var out = {}, rows = [], packs = {};
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
    });
    D.upsert('RoundLines', rows, ss);
    var changed = Object.keys(packs).map(function (id) { return packs[id]; });
    if (changed.length) D.updateFields('Drugs', changed, ['pack_size'], ss);
    if (!round.counted_by) D.updateFields('Rounds', [{ _row: round._row, counted_by: actor_() }], ['counted_by'], ss);
    return out;
  }

  /**
   * Save the delivery check of an approved ใบเบิก from main storage (a draft until
   * confirmReceipt). After confirmation the quantities are locked; expiry dates can still be fixed.
   * @param {{drug_id:string, received_qty:*, exp:string[]}[]} edits  blank qty = not checked yet
   * @return {{doc:Object, expiry:Object[]}} the ใบเบิก with its lines, and expiry dates on the shelf
   */
  function saveReceived(roundId, edits, ss) {
    var D = db_();
    D.ensureColumns('Rounds', ss); // Sheets set up before receiving existed
    D.ensureColumns('RoundLines', ss);
    D.ensureColumns('Expiry', ss);
    var round = roundById_(roundId, ss);
    if (round.status === 'CANCELLED') throw new Error('ใบเบิกนี้ยกเลิกแล้ว');
    if (round.status !== 'APPROVED') throw new Error('ใบเบิกนี้ยังไม่อนุมัติ ยังตรวจรับไม่ได้');
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
        var v = receivedValue_(e.received_qty);
        if (round.received_at && show_(v) !== show_(was)) throw new Error('ยืนยันรับเข้าคลังแล้ว แก้จำนวนที่ได้รับไม่ได้');
        l.received_qty = v;
        rows.push({ round_id: roundId, drug_id: e.drug_id, received_qty: l.received_qty });
        if (show_(was) !== show_(l.received_qty)) diff.push('ได้รับ ' + show_(was) + ' → ' + show_(l.received_qty));
      }
      out[e.drug_id] = l.received_qty === undefined ? '' : l.received_qty;
      var dates = expDates_(e.exp);
      if (dates) {
        var t = expiryText_(setExpiry_('MAIN', roundId, e.drug_id, dates, lots, lotRows));
        if (t) diff.push(t);
      }
      if (diff.length) logs.push(['ตรวจรับจากคลัง', drugLabel_(drugs[e.drug_id]) || e.drug_id, docName_(round, roundId) + ': ' + diff.join('; ')]);
    });
    if (rows.length) D.upsert('RoundLines', rows, ss);
    if (lotRows.length) D.upsert('Expiry', lotRows, ss);
    log_(logs, ss);
    return { doc: mainDoc_(round, objValues_(lines)), expiry: expiryOnHand_(D.readTable('Expiry', ss)) };
  }

  function objValues_(o) { return Object.keys(o).map(function (k) { return o[k]; }); }

  /** Before a ใบรับ is confirmed: every line that received something needs an expiry date. */
  function checkExpiry_(ref, lines, ss) {
    var C = calc_(), D = db_();
    var has = {};
    readOptional_('Expiry', ss).forEach(function (x) { if (x.ref === ref && x.exp_date && !x.removed_at) has[x.drug_id] = true; });
    var missing = lines.filter(function (l) { return C.toNumber(l.received_qty) > 0 && !has[l.drug_id]; });
    if (!missing.length) return;
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var names = missing.slice(0, 3).map(function (l) { return drugLabel_(drugs[l.drug_id]) || l.drug_id; });
    throw new Error('ยังไม่ได้ใส่วันหมดอายุ ' + missing.length + ' รายการ: ' + names.join(', ') + (missing.length > 3 ? ' …' : ''));
  }
  function docName_(r, ref) { return r.req_no ? 'ใบเบิก ' + r.req_no : ref; }

  /**
   * Finish the delivery check of a main-storage ใบเบิก: every requested line must have a received
   * quantity (0 when nothing came). Gives the ใบรับ number (ร.69/0001) and locks the quantities.
   * What main storage didn't give is not carried over: it goes on the next ใบเบิก if still needed.
   */
  function confirmReceipt(roundId, ss) {
    var D = db_();
    D.ensureColumns('Rounds', ss);
    var round = roundById_(roundId, ss);
    if (round.status === 'CANCELLED') throw new Error('ใบเบิกนี้ยกเลิกแล้ว');
    if (round.status !== 'APPROVED') throw new Error('ใบเบิกนี้ยังไม่อนุมัติ ยังตรวจรับไม่ได้');
    if (round.received_at) throw new Error('ใบเบิกนี้ยืนยันรับเข้าคลังแล้ว');
    var lines = D.readTable('RoundLines', ss).filter(function (l) { return l.round_id === roundId && requested_(l) > 0; });
    var todo = lines.filter(function (l) { return l.received_qty === '' || l.received_qty === undefined || l.received_qty === null; });
    if (todo.length) throw new Error('ยังไม่ได้ใส่จำนวนที่ได้รับ ' + todo.length + ' รายการ (ไม่ได้รับเลยให้ใส่ 0)');
    checkExpiry_(roundId, lines, ss);
    round.receipt_no = nextNo_('ร', 'receipt_no', ss);
    round.received_at = now_();
    round.received_by = actor_();
    D.updateFields('Rounds', [round], ['receipt_no', 'received_at', 'received_by'], ss);
    var doc = mainDoc_(round, lines);
    log_([['ยืนยันรับเข้าคลัง', round.receipt_no, 'จากคลัง ' + docName_(round, roundId) + ': ' + recvSummary_(doc.lines)]], ss);
    return doc;
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
    // An OPD request needs no approval: its ใบเบิก number is given when it is saved.
    var r = { request_id: id, request_date: today, kind: kind, status: 'REQUESTED', requested_by: actor_(), note: note || '',
      req_no: nextNo_('บ', 'req_no', ss), receipt_no: '' };
    D.appendRows('OpdRequests', [r], ss);
    var out = rows.map(function (l) { return { request_id: id, drug_id: l.drug_id, qty: l.qty, received_qty: '' }; });
    D.appendRows('OpdLines', out, ss);
    // Today's shelf counts go in the change log here, once, not on every autosave.
    var counted = readOptional_('OpdCounts', ss).filter(function (c) {
      return c.count_date === today && C.toNumber(c.qty) !== null;
    });
    log_((counted.length ? [['นับคงเหลือยา OPD', today, counted.map(function (c) {
      return (drugLabel_(drugs[c.drug_id]) || c.drug_id) + ' ' + c.qty;
    }).join(', ')]] : []).concat([['ขอยาจาก OPD', r.req_no, (kind === 'URGENT' ? 'ด่วน' : 'ประจำเดือน') + ': ' + rows.map(function (l) {
      return drugLabel_(drugs[l.drug_id]) + ' ' + l.qty;
    }).join(', ')]]), ss);
    return opdInfo_(r, out.map(function (l) { return { drug_id: l.drug_id, qty: l.qty, received_qty: '' }; }));
  }

  /**
   * Latest shelf count per drug, {drug_id: {qty, date}}: from round lines (dated by the round's
   * count date) and from counts typed on the OPD page, which win on the same day.
   */
  function lastCounts_(rounds, roundLines, opdCount) {
    var C = calc_(), out = {}, roundDate = {};
    rounds.forEach(function (r) { roundDate[r.round_id] = r.count_date; });
    roundLines.forEach(function (l) {
      var q = C.toNumber(l.on_hand), dt = roundDate[l.round_id];
      if (q === null || !dt) return;
      var prev = out[l.drug_id];
      if (!prev || dt > prev.date) out[l.drug_id] = { qty: q, date: dt };
    });
    Object.keys(opdCount).forEach(function (id) {
      var c = opdCount[id], prev = out[id];
      if (!prev || c.date >= prev.date) out[id] = c;
    });
    return out;
  }

  /** Latest non-blank count per drug from OpdCounts: {drug_id: {qty, date}}. */
  function latestOpdCounts_(ss) {
    var C = calc_(), out = {};
    readOptional_('OpdCounts', ss).forEach(function (c) {
      var q = C.toNumber(c.qty);
      if (q === null || !c.count_date) return;
      var prev = out[c.drug_id];
      if (!prev || c.count_date > prev.date) out[c.drug_id] = { qty: q, date: c.count_date };
    });
    return out;
  }

  /**
   * Save shelf counts of drugs fetched from OPD, typed on the OPD page (autosaved as typed).
   * Counts are dated today; typing again the same day replaces that day's count, and a blank
   * clears it (the previous day's count then applies again). Main-storage drugs are counted
   * in the 2-week round instead. Logged once when the OPD request is saved.
   * @param {{drug_id:string, qty:*}[]} edits
   * @return {Object<string, {opd_count:Object|null, last_count:Object|null}>} by drug_id after the
   *   save: the latest count from this page, and the latest count from anywhere ({qty, date} each)
   */
  function saveOpdCounts(edits, ss) {
    var C = calc_(), D = db_();
    D.ensureColumns('OpdCounts', ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var today = today_(), at = now_();
    var rows = (edits || []).map(function (e) {
      var d = drugs[e.drug_id];
      if (!d) throw new Error('ไม่พบยา ' + e.drug_id);
      if (d.stocked) throw new Error(drugLabel_(d) + ' เป็นยาเบิกจากคลัง ให้นับในหน้าเบิกจากคลัง');
      var blank = e.qty === null || e.qty === undefined || String(e.qty).trim() === '';
      var q = blank ? null : C.toNumber(e.qty);
      if (!blank && (q === null || q < 0)) throw new Error('จำนวนคงเหลือไม่ถูกต้อง: ' + e.qty);
      return { count_date: today, drug_id: e.drug_id, qty: q === null ? '' : q, counted_by: actor_(), counted_at: at };
    });
    if (rows.length) D.upsert('OpdCounts', rows, ss);
    var opd = latestOpdCounts_(ss);
    var last = lastCounts_(D.readTable('Rounds', ss), D.readTable('RoundLines', ss), opd), out = {};
    rows.forEach(function (r) { out[r.drug_id] = { opd_count: opd[r.drug_id] || null, last_count: last[r.drug_id] || null }; });
    return out;
  }

  function opdById_(requestId, ss) {
    var r = db_().readTable('OpdRequests', ss).filter(function (x) { return x.request_id === requestId; })[0];
    if (!r) throw new Error('ไม่พบรายการขอ ' + requestId);
    return r;
  }

  /**
   * Save what OPD handed over (a draft until confirmOpdReceipt; then quantities are locked).
   * @param {{drug_id:string, received_qty:*, exp:string[]}[]} edits
   */
  function saveOpdReceived(requestId, edits, ss) {
    var D = db_();
    D.ensureColumns('Expiry', ss);
    var r = opdById_(requestId, ss);
    if (r.status === 'CANCELLED') throw new Error('รายการขอนี้ยกเลิกแล้ว');
    var locked = r.status === 'RECEIVED';
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
        var v = receivedValue_(e.received_qty);
        if (locked && show_(v) !== show_(was)) throw new Error('ยืนยันรับเข้าคลังแล้ว แก้จำนวนที่ได้รับไม่ได้');
        l.received_qty = v;
        rows.push({ request_id: requestId, drug_id: e.drug_id, received_qty: l.received_qty });
        if (show_(was) !== show_(l.received_qty)) diff.push('ได้รับ ' + show_(was) + ' → ' + show_(l.received_qty));
      }
      var dates = expDates_(e.exp);
      if (dates) {
        var t = expiryText_(setExpiry_('OPD', requestId, e.drug_id, dates, lots, lotRows));
        if (t) diff.push(t);
      }
      if (diff.length) logs.push(['รับยาจาก OPD', drugLabel_(drugs[e.drug_id]) || e.drug_id, docName_(r, requestId) + ': ' + diff.join('; ')]);
    });
    if (rows.length) D.upsert('OpdLines', rows, ss);
    if (lotRows.length) D.upsert('Expiry', lotRows, ss);
    log_(logs, ss);
    var info = opdInfo_(r, opdLineList_(lines));
    info.expiry = expiryOnHand_(D.readTable('Expiry', ss));
    return info;
  }

  function opdLineList_(lines) {
    return objValues_(lines).map(function (l) { return { drug_id: l.drug_id, qty: l.qty, received_qty: l.received_qty }; });
  }

  /** Finish the check of what OPD handed over: gives the ใบรับ number, like confirmReceipt. */
  function confirmOpdReceipt(requestId, ss) {
    var D = db_();
    D.ensureColumns('OpdRequests', ss);
    var r = opdById_(requestId, ss);
    if (r.status === 'CANCELLED') throw new Error('รายการขอนี้ยกเลิกแล้ว');
    if (r.status === 'RECEIVED') throw new Error('ใบเบิกนี้ยืนยันรับเข้าคลังแล้ว');
    var lines = {};
    D.readTable('OpdLines', ss).forEach(function (l) { if (l.request_id === requestId) lines[l.drug_id] = l; });
    var todo = objValues_(lines).filter(function (l) { return l.received_qty === '' || l.received_qty === undefined || l.received_qty === null; });
    if (todo.length) throw new Error('ยังไม่ได้ใส่จำนวนที่ได้รับ ' + todo.length + ' รายการ (ไม่ได้รับเลยให้ใส่ 0)');
    checkExpiry_(requestId, objValues_(lines), ss);
    r.status = 'RECEIVED';
    r.receipt_no = nextNo_('ร', 'receipt_no', ss);
    r.received_at = now_();
    r.received_by = actor_();
    D.updateFields('OpdRequests', [r], ['status', 'receipt_no', 'received_at', 'received_by'], ss);
    var info = opdInfo_(r, opdLineList_(lines));
    log_([['ยืนยันรับเข้าคลัง', r.receipt_no, 'จาก OPD ' + docName_(r, requestId) + ': ' + recvSummary_(info.lines)]], ss);
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

  /**
   * ใบเบิกพิเศษ: an extra request to main storage between 2-week rounds (any medicine, any
   * quantity, no count). Like an OPD request it needs no approval: it gets its ใบเบิก number
   * when saved, prints on the main-storage form and is checked in ตรวจรับยา.
   * Kept in Rounds (kind EXTRA, status APPROVED) so the delivery check and stock card work as usual.
   * @param {{drug_id:string, qty:*}[]} lines  lines with qty ≤ 0 are dropped
   * @param {string} note  optional reason, kept with the request and in the change log
   * @return {Object} the ใบเบิก as in main_docs
   */
  function createExtraRequest(lines, note, ss) {
    var C = calc_(), D = db_();
    D.ensureColumns('Rounds', ss);
    D.ensureColumns('RoundLines', ss);
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var seen = {};
    var rows = (lines || []).map(function (l) {
      if (!drugs[l.drug_id]) throw new Error('ไม่พบยา ' + l.drug_id);
      if (seen[l.drug_id]) throw new Error('ยาซ้ำในรายการ ' + l.drug_id);
      seen[l.drug_id] = true;
      var q = C.toNumber(l.qty);
      if (q !== null && q < 0) throw new Error('จำนวนไม่ถูกต้อง: ' + l.qty);
      return { drug_id: l.drug_id, qty: q };
    }).filter(function (l) { return l.qty > 0; });
    if (!rows.length) throw new Error('ยังไม่มีรายการที่จะเบิก');

    var today = today_();
    var ids = D.readTable('Rounds', ss).map(function (r) { return r.round_id; });
    var id = 'EX-' + today, n = 2;
    while (ids.indexOf(id) >= 0) id = 'EX-' + today + '-' + n++;
    var r = { round_id: id, count_date: today, status: 'APPROVED', kind: 'EXTRA', counted_by: actor_(),
      reviewed_by: actor_(), approved_at: now_(), note: String(note || '').trim(),
      req_no: nextNo_('บ', 'req_no', ss), receipt_no: '' };
    D.appendRows('Rounds', [r], ss);
    var out = rows.map(function (l) {
      return { round_id: id, drug_id: l.drug_id, on_hand: '', par_used: '', suggested_qty: '', final_qty: l.qty,
        boxes: '', pack_size: '', change_reason: '', flags: '', received_qty: '' };
    });
    D.appendRows('RoundLines', out, ss);
    log_([['ใบเบิกพิเศษ', r.req_no, (r.note ? 'เหตุผล: ' + r.note + ' · ' : '') + rows.map(function (l) {
      return drugLabel_(drugs[l.drug_id]) + ' ' + l.qty;
    }).join(', ')]], ss);
    return mainDoc_(r, out);
  }

  /** Cancel a ใบเบิกพิเศษ saved by mistake or never sent (before its delivery check is confirmed). */
  function cancelExtraRequest(roundId, ss) {
    var D = db_();
    var r = roundById_(roundId, ss);
    if (!isExtra_(r)) throw new Error('ยกเลิกได้เฉพาะใบเบิกพิเศษ');
    if (r.received_at) throw new Error('ยืนยันรับเข้าคลังแล้ว ยกเลิกไม่ได้');
    if (r.status === 'CANCELLED') return roundInfo_(r);
    r.status = 'CANCELLED';
    D.updateFields('Rounds', [r], ['status'], ss);
    log_([['ยกเลิกใบเบิกพิเศษ', r.req_no || roundId, '']], ss);
    return roundInfo_(r);
  }

  /**
   * Record that a round's paper was printed, so the round's steps (หน้าหลัก) can show it done:
   * `count` = the count sheet (round still open), `form` = the ใบเบิก (round approved).
   * Keeps the latest time. Not in the change log: printing changes no data.
   */
  function markPrinted(roundId, which, ss) {
    var D = db_();
    var field = { count: 'count_printed_at', form: 'form_printed_at' }[which];
    if (!field) throw new Error('ไม่รู้จักเอกสาร: ' + which);
    D.ensureColumns('Rounds', ss);
    var r = roundById_(roundId, ss);
    if (isExtra_(r)) throw new Error('ใบเบิกพิเศษไม่มีขั้นตอนของรอบ');
    if (which === 'count' && r.status === 'APPROVED') throw new Error('รอบนี้อนุมัติแล้ว');
    if (which === 'form' && r.status !== 'APPROVED') throw new Error('รอบนี้ยังไม่อนุมัติ');
    r[field] = now_();
    D.updateFields('Rounds', [r], [field], ss);
    return roundInfo_(r);
  }

  /** Approve (freeze) a round. Its ใบเบิก gets a number (บ.69/0001) if anything is requested. */
  function approveRound(roundId, ss) {
    var D = db_();
    D.ensureColumns('Rounds', ss);
    var round = roundById_(roundId, ss);
    if (isExtra_(round)) throw new Error('ใบเบิกพิเศษไม่ต้องอนุมัติ ได้เลขใบเบิกตอนบันทึก');
    if (round.status === 'APPROVED') throw new Error('รอบนี้อนุมัติแล้ว');
    var mine = D.readTable('RoundLines', ss).filter(function (l) { return l.round_id === roundId; });
    round.status = 'APPROVED';
    round.approved_at = now_();
    round.reviewed_by = actor_();
    if (mine.some(function (l) { return requested_(l) > 0; })) round.req_no = nextNo_('บ', 'req_no', ss);
    // Keep the HOSxP data this round was counted and requested with.
    var data = dataNow_(ss), DATA = ['data_from', 'data_to', 'import_from', 'import_to', 'import_at'];
    DATA.forEach(function (k) { round[k] = data[k]; });
    D.updateFields('Rounds', [round], ['status', 'approved_at', 'reviewed_by', 'req_no'].concat(DATA), ss);
    // The change log gets the final count and request of each line here, once,
    // not every autosave while staff type.
    var drugs = {};
    D.readTable('Drugs', ss).forEach(function (d) { drugs[d.drug_id] = d; });
    var counted = 0, requested = 0, logs = [];
    mine.forEach(function (l) {
      var parts = [];
      if (l.on_hand !== '' && l.on_hand !== null) { counted++; parts.push('คงเหลือ ' + l.on_hand); }
      if (l.suggested_qty !== '' && l.suggested_qty !== null) parts.push('ควรเบิก ' + l.suggested_qty);
      if (requested_(l) > 0) requested++;
      if (l.final_qty !== '' && l.final_qty !== null) {
        parts.push('เบิกจริง ' + l.final_qty + (l.boxes !== '' && l.boxes !== null ? ' (' + l.boxes + '×' + l.pack_size + ')' : ''));
      }
      if (l.change_reason) parts.push('เหตุผล: ' + l.change_reason);
      if (parts.length) logs.push(['นับ/เบิก', drugLabel_(drugs[l.drug_id]) || l.drug_id, 'รอบ ' + roundId + ': ' + parts.join('; ')]);
    });
    // Summary row last, so it heads the newest-first log view.
    log_(logs.concat([['อนุมัติรอบ', roundId, (round.req_no ? 'ใบเบิก ' + round.req_no + ': ' : '') +
      'นับ ' + counted + ' รายการ, เบิก ' + requested + ' รายการ']]), ss);
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
      if (r.status === 'CANCELLED') return;
      hist.push({ type: 'MAIN', ref: l.round_id, date: r.count_date, status: r.status, kind: isExtra_(r) ? 'EXTRA' : '',
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
    readOptional_('OpdCounts', ss).forEach(function (c) {
      if (c.drug_id !== drugId || C.toNumber(c.qty) === null) return;
      hist.push({ type: 'OPD_COUNT', ref: 'OPDCOUNT-' + c.count_date, date: c.count_date, status: '', kind: '',
        on_hand: C.toNumber(c.qty), requested: '', received_qty: '', received_at: '' });
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
    saveReceived: saveReceived, confirmReceipt: confirmReceipt, createOpdRequest: createOpdRequest,
    saveOpdReceived: saveOpdReceived, confirmOpdReceipt: confirmOpdReceipt, saveOpdCounts: saveOpdCounts,
    cancelOpdRequest: cancelOpdRequest, createExtraRequest: createExtraRequest, cancelExtraRequest: cancelExtraRequest,
    markPrinted: markPrinted,
    removeExpiry: removeExpiry, drugCard: drugCard, saveDrug: saveDrug,
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
    var r;
    try {
      r = Auth.login(username, password);
    } catch (e) {
      // Failed logins go to the change log (never the typed password; the typed name only
      // when it is a real user), so an admin can see why someone could not sign in.
      if (e.reason) {
        Api.setActor(e.who || '');
        Api.log([['เข้าสู่ระบบไม่สำเร็จ', e.who || '', e.reason]]);
        SpreadsheetApp.flush();
      }
      throw e;
    }
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
function apiConfirmReceipt(token, roundId) { return locked_(token, null, function () { return Api.confirmReceipt(roundId); }); }
function apiConfirmOpdReceipt(token, requestId) { return locked_(token, null, function () { return Api.confirmOpdReceipt(requestId); }); }
function apiCreateOpdRequest(token, kind, lines, note) { return locked_(token, null, function () { return Api.createOpdRequest(kind, lines, note); }); }
function apiSaveOpdCounts(token, edits) { return locked_(token, null, function () { return Api.saveOpdCounts(edits); }); }
function apiSaveOpdReceived(token, requestId, edits) { return locked_(token, null, function () { return Api.saveOpdReceived(requestId, edits); }); }
function apiCancelOpdRequest(token, requestId) { return locked_(token, null, function () { return Api.cancelOpdRequest(requestId); }); }
function apiCreateExtraRequest(token, lines, note) { return locked_(token, null, function () { return Api.createExtraRequest(lines, note); }); }
function apiCancelExtraRequest(token, roundId) { return locked_(token, null, function () { return Api.cancelExtraRequest(roundId); }); }
function apiMarkPrinted(token, roundId, which) { return locked_(token, null, function () { return Api.markPrinted(roundId, which); }); }
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
