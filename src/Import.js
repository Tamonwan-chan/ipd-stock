/**
 * Import.js — HOSxP usage import and par recompute (DESIGN §6, quarterly admin jobs).
 *
 *   importUsage  Import tab (pasted HOSxP export) → Drugs (new drugs) + UsageDaily, then recompute.
 *   recompute    UsageDaily + Drugs → use_freq, source_calc, stocked, par_calc, par_updated.
 *
 * Both take the spreadsheet as an optional argument (tests pass a fake) and do not lock;
 * Code.js wraps them in Db.withLock. Nothing is written if the pasted data has errors.
 */
var Import = (function () {
  'use strict';

  function calc_() { return typeof Calc !== 'undefined' ? Calc : require('./Calc.js'); }
  function db_() { return typeof Db !== 'undefined' ? Db : require('./Db.js'); }

  var MAX_ERRORS = 20;

  // ------------------------------------------------------------- parsing

  function pad2_(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * order_date cell → ISO date, or throws. Accepts a Sheet date (Sheets parses pasted dates
   * when the spreadsheet locale allows), 'd/m/yyyy' text in C.E. or B.E., or ISO text.
   * A Sheet date with a B.E. year (e.g. 2569) is converted to C.E.
   */
  function importDate(v) {
    if (v instanceof Date) {
      var y = v.getFullYear();
      if (y > 2400) y -= 543;
      return y + '-' + pad2_(v.getMonth() + 1) + '-' + pad2_(v.getDate());
    }
    var s = String(v === null || v === undefined ? '' : v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return calc_().parseHosxpDate(s);
  }

  /**
   * Validate and aggregate pasted HOSxP rows (objects from Db.readTable('Import')).
   * @param {Object[]} raw
   * @param {string} today  ISO; dates after it are rejected (catches day/month swaps)
   * @return {{usage:{date,key,name,strength,unit,qty,unit_price}[], errors:string[], skipped:number,
   *           from:string|null, to:string|null}}
   *   usage: one entry per date and drug (same-day rows summed), zero quantities dropped
   */
  function parseImport(raw, today) {
    var C = calc_();
    var errors = [], byKey = {}, order = [], skipped = 0, from = null, to = null;
    var sawSheetDate = false, sawDayOver12Text = false;

    raw.forEach(function (r) {
      var where = 'แถว ' + r._row + ': ';
      var name = C.isBlank(r.drug_name) ? '' : String(r.drug_name).trim();
      if (name === 'drug_name') { skipped++; return; } // header pasted again
      if (!name) { errors.push(where + 'ไม่มีชื่อยา'); return; }

      if (r.order_date instanceof Date) sawSheetDate = true;
      else if (/^\s*(1[3-9]|2\d|3[01])\//.test(String(r.order_date))) sawDayOver12Text = true;

      var date;
      try { date = importDate(r.order_date); } catch (e) { errors.push(where + 'วันที่ไม่ถูกต้อง "' + r.order_date + '"'); return; }
      if (date > today) { errors.push(where + 'วันที่ ' + date + ' อยู่ในอนาคต (วัน/เดือนสลับกัน?)'); return; }

      var qty = C.toNumber(r.total_quantity);
      if (qty === null) { errors.push(where + 'จำนวนไม่ใช่ตัวเลข "' + r.total_quantity + '"'); return; }
      if (qty === 0) { skipped++; return; }

      var key = C.drugKey(name, r.strength, r.drug_unit);
      var k = date + '\u0001' + key;
      if (!byKey[k]) {
        byKey[k] = { date: date, key: key, name: name, strength: String(r.strength === undefined ? '' : r.strength).trim(),
          unit: String(r.drug_unit === undefined ? '' : r.drug_unit).trim(), qty: 0, unit_price: null };
        order.push(k);
      }
      byKey[k].qty += qty;
      var price = C.toNumber(r.unit_price);
      if (price !== null) byKey[k].unit_price = price;
      if (from === null || date < from) from = date;
      if (to === null || date > to) to = date;
    });

    // Sheets turned some dates into Date values and left others as text: with a
    // month/day locale, "5/11/2026" became 11 May while "25/11/2026" stayed text.
    if (sawSheetDate && sawDayOver12Text) {
      errors.unshift('วันที่ในคอลัมน์ order_date ถูก Google Sheets แปลงไม่เหมือนกัน (บางแถวเป็นวันที่ บางแถวเป็นข้อความ) ' +
        'ให้ตั้งคอลัมน์ A ของแท็บ Import เป็น "ข้อความธรรมดา" (รูปแบบ › ตัวเลข › ข้อความธรรมดา) แล้ววางข้อมูลใหม่');
    }
    return { usage: order.map(function (k) { return byKey[k]; }), errors: errors, skipped: skipped, from: from, to: to };
  }

  // -------------------------------------------------------------- import

  /**
   * Import the pasted HOSxP export.
   * @param {Spreadsheet=} ss
   * @param {{today?:string}=} opts  today as ISO (default: now, in the script time zone)
   * @return {{ok:boolean, errors:string[], rows:number, from, to, newDrugs:string[], priceUpdates:number,
   *           usage:{removed,added,total}, recompute:Object}}
   */
  function importUsage(ss, opts) {
    var raw = db_().readTable('Import', ss);
    if (!raw.length) return { ok: false, errors: ['แท็บ Import ว่าง: วางข้อมูลจาก HOSxP ก่อน'] };
    var r = importRows(raw, ss, opts);
    if (r.ok) db_().rewriteTable('Import', [], ss);
    return r;
  }

  /**
   * Import HOSxP rows given as objects {_row, order_date, drug_name, strength, drug_unit,
   * total_quantity, unit_price} (from the Import tab, or a file read by the web page).
   * Same result as importUsage; nothing is written if any row has an error.
   */
  function importRows(raw, ss, opts) {
    var C = calc_(), D = db_();
    var today = (opts && opts.today) || D.fromCell(new Date(), 'date');
    if (!raw.length) return { ok: false, errors: ['ไม่มีข้อมูล'] };

    var parsed = parseImport(raw, today);
    if (parsed.errors.length) {
      var shown = parsed.errors.slice(0, MAX_ERRORS);
      if (parsed.errors.length > MAX_ERRORS) shown.push('… และอีก ' + (parsed.errors.length - MAX_ERRORS) + ' แถว');
      return { ok: false, errors: shown };
    }
    if (!parsed.usage.length) return { ok: false, errors: ['ไม่มีแถวที่มีจำนวนใช้มากกว่า 0'] };

    // Match drugs; create the new ones.
    var drugs = D.readTable('Drugs', ss);
    var byKey = {};
    drugs.forEach(function (d) { byKey[C.drugKey(d.hosxp_name, d.strength, d.unit)] = d; });
    var ids = drugs.map(function (d) { return d.drug_id; });
    var newDrugs = [], latestPrice = {};

    parsed.usage.forEach(function (u) {
      if (!byKey[u.key]) {
        var id = D.nextDrugId(ids);
        ids.push(id);
        var d = { drug_id: id, hosxp_name: u.name, strength: u.strength, unit: u.unit,
          critical: C.isCriticalName(u.name), stocked: false };
        byKey[u.key] = d;
        newDrugs.push(d);
      }
      if (u.unit_price !== null) {
        var lp = latestPrice[u.key];
        if (!lp || u.date >= lp.date) latestPrice[u.key] = { date: u.date, price: u.unit_price };
      }
    });

    // Latest price: on new drugs directly, on existing drugs only when it changed.
    var priceUpdates = [];
    Object.keys(latestPrice).forEach(function (k) {
      var d = byKey[k], p = latestPrice[k].price;
      if (d._row) { if (C.toNumber(d.unit_price) !== p) { d.unit_price = p; priceUpdates.push(d); } }
      else d.unit_price = p;
    });

    D.appendRows('Drugs', newDrugs, ss);
    D.updateFields('Drugs', priceUpdates, ['unit_price'], ss);
    var usage = D.replaceUsage(parsed.usage.map(function (u) {
      return { date: u.date, drug_id: byKey[u.key].drug_id, qty: u.qty };
    }), ss);

    return {
      ok: true, errors: [], rows: raw.length - parsed.skipped, from: parsed.from, to: parsed.to,
      newDrugs: newDrugs.map(function (d) { return d.hosxp_name; }), priceUpdates: priceUpdates.length,
      usage: usage, recompute: recompute(ss, { today: today })
    };
  }

  // ----------------------------------------------------------- recompute

  /**
   * Recompute every drug from the last `history_days` of UsageDaily (ending at the latest
   * usage date, not today, so an old export still gives a full window).
   * Writes use_freq, source_calc, stocked, par_calc, par_updated. Leaves the pharmacist's
   * columns (source, critical, pack_size, min_par, par_override, ...) alone.
   * @return {{from, to, drugs:number, stocked:number, source:Object, noPackSize:number,
   *           expensive:string[], overridden:string[]}}
   *   overridden: drugs whose `source` set by the pharmacist differs from the rule's result
   */
  function recompute(ss, opts) {
    var C = calc_(), D = db_();
    var today = (opts && opts.today) || D.fromCell(new Date(), 'date');
    D.ensureSchema(ss); // a sheet set up by an older version may lack newer columns
    var s = D.settings(ss);
    var drugs = D.readTable('Drugs', ss);
    var usage = D.readTable('UsageDaily', ss);

    var first = null, to = null;
    usage.forEach(function (u) {
      if (!u.date) return;
      if (to === null || u.date > to) to = u.date;
      if (first === null || u.date < first) first = u.date;
    });
    var report = { from: null, to: to, drugs: drugs.length, stocked: 0, source: {}, noPackSize: 0, expensive: [], overridden: [] };
    if (!drugs.length) return report;
    // Window: the last history_days, but not before the data starts (days before the
    // first import would otherwise count as zero use).
    var from = to ? C.addDays(to, -(s.history_days - 1)) : null;
    if (from && first > from) from = first;
    report.from = from;

    var rowsByDrug = {};
    usage.forEach(function (u) {
      if (!from || u.date < from) return;
      (rowsByDrug[u.drug_id] = rowsByDrug[u.drug_id] || []).push(u);
    });

    drugs.forEach(function (d) {
      var series = from ? C.dailySeries(rowsByDrug[d.drug_id] || [], from, to) : [];
      var st = C.drugStats(series, s);
      var cls = C.classifyDrug({ name: d.hosxp_name, unit: d.unit, unit_price: d.unit_price,
        pack_size: d.pack_size, critical: d.critical }, st, s);
      var dec = C.stockDecision(d, cls);
      var par = C.calcPar(series, { critical: cls.critical }, s);

      d.use_freq = Math.round(st.useFreq * 1000) / 1000;
      d.mean_daily = Math.round(st.mean * 1000) / 1000;
      d.source_calc = cls.source || '';
      d.stocked = dec.stocked;
      d.par_calc = par.parCalc;
      d.par_updated = today;

      if (dec.stocked) report.stocked++;
      var key = dec.source || 'none';
      report.source[key] = (report.source[key] || 0) + 1;
      if (cls.source === 'UNKNOWN') report.noPackSize++;
      if (cls.tier === 'expensive') report.expensive.push(d.hosxp_name);
      var manual = String(d.source || '').trim().toUpperCase();
      if ((manual === 'MAIN' || manual === 'OPD') && cls.source !== 'UNKNOWN' && cls.source && manual !== cls.source && !cls.critical) {
        report.overridden.push(d.hosxp_name);
      }
    });

    D.updateFields('Drugs', drugs, ['use_freq', 'mean_daily', 'source_calc', 'stocked', 'par_calc', 'par_updated'], ss);
    // Remember the window for the web page (Settings rows outside Calc.DEFAULTS are ignored by Calc).
    D.upsert('Settings', [
      { key: 'usage_from', value: from, note: 'ช่วงข้อมูลที่ใช้คำนวณล่าสุด (เขียนโดยโปรแกรม)' },
      { key: 'usage_to', value: to, note: 'ช่วงข้อมูลที่ใช้คำนวณล่าสุด (เขียนโดยโปรแกรม)' }
    ], ss);
    return report;
  }

  return {
    importDate: importDate,
    parseImport: parseImport,
    importUsage: importUsage,
    importRows: importRows,
    recompute: recompute
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Import;
