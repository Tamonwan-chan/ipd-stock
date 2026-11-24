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
 * Db.js — read and write the spreadsheet's tabs as arrays of objects (DESIGN §4).
 *
 * Every function takes the Spreadsheet as an optional last argument (default: the
 * spreadsheet this script is bound to), so tests can pass a fake. Only this small part
 * of the SpreadsheetApp API is used:
 *   ss.getSheetByName, ss.insertSheet,
 *   sheet.getLastRow, getLastColumn, getMaxRows, getRange(row, col, numRows, numCols), setFrozenRows,
 *   range.getValues, setValues, clearContent, setNumberFormat.
 *
 * Rows read by readTable carry `_row`, their sheet row number, for updateFields.
 * Functions here don't take the lock themselves; callers wrap a whole job in Db.withLock
 * so that, e.g., an import reads and writes under one lock.
 *
 * Dates: the script and the spreadsheet must both use the Asia/Bangkok time zone
 * (appsscript.json and File › Settings). Apps Script runs JavaScript in the script's
 * time zone, so a Date's getFullYear/getMonth/getDate are the calendar date shown in the Sheet.
 */
var Db = (function () {
  'use strict';

  // Resolved when called, not when this file loads: Apps Script loads files in an order
  // we don't control, and in Node the other modules come from require.
  function calc_() { return typeof Calc !== 'undefined' ? Calc : require('./Calc.js'); }
  function schema_() { return typeof Schema !== 'undefined' ? Schema : require('./Schema.js'); }

  var FORMATS = { string: '@', date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm' };

  function spreadsheet_(ss) {
    return ss || SpreadsheetApp.getActiveSpreadsheet();
  }

  function sheet_(name, ss) {
    var sh = spreadsheet_(ss).getSheetByName(name);
    if (!sh) throw new Error('Tab "' + name + '" not found. Run IPD › ตั้งค่าแท็บข้อมูล first.');
    return sh;
  }

  function header_(sh) {
    var n = sh.getLastColumn();
    if (n === 0) return [];
    return sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return String(h).trim(); });
  }

  // ------------------------------------------------------------ cell values

  function pad2_(n) { return (n < 10 ? '0' : '') + n; }

  function isoFromDate_(d) {
    return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
  }

  function isBlank_(v) { return v === null || v === undefined || v === ''; }

  /** Sheet cell value -> JS value, by column type. */
  function fromCell(v, type) {
    switch (type) {
      case 'string':
        if (v instanceof Date) return isoFromDate_(v); // typed into a column before it was formatted
        return isBlank_(v) ? '' : String(v);
      case 'number':
        return isBlank_(v) ? '' : calc_().toNumber(v);
      case 'bool':
        return v === true || /^(true|y|yes|1)$/i.test(String(v).trim());
      case 'date':
        if (v instanceof Date) return isoFromDate_(v);
        if (isBlank_(v)) return '';
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(v).trim())) return String(v).trim();
        return calc_().parseHosxpDate(v); // d/m/yyyy typed as text; throws on anything else
      case 'datetime':
        if (v instanceof Date) return isoFromDate_(v) + ' ' + pad2_(v.getHours()) + ':' + pad2_(v.getMinutes());
        return isBlank_(v) ? '' : String(v);
      default:
        return v;
    }
  }

  /** JS value -> Sheet cell value, by column type. */
  function toCell(v, type) {
    if (isBlank_(v)) return '';
    switch (type) {
      case 'string':
        return String(v);
      case 'number':
        var n = calc_().toNumber(v);
        return n === null ? '' : n;
      case 'bool':
        return v === true || /^(true|y|yes|1)$/i.test(String(v).trim());
      case 'date':
      case 'datetime':
        if (v instanceof Date) return v;
        var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(String(v));
        if (!m) throw new Error('Not an ISO date: ' + v);
        return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
      default:
        return v;
    }
  }

  function rowFromObject_(table, header, obj) {
    var S = schema_();
    return header.map(function (h) { return toCell(obj[h], S.typeOf(table, h)); });
  }

  // ------------------------------------------------------------------ setup

  /** Append the schema columns missing from row 1; returns their names. */
  function addMissingColumns_(sh, name, header) {
    var missing = schema_().columnNames(name).filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length) sh.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
    return missing;
  }

  /**
   * Create one tab if it is missing and add its missing schema columns (formatted by type),
   * so a Sheet set up before a tab or column existed keeps working without rerunning setup.
   * Cheap when nothing is missing.
   * @return {string[]} columns added
   */
  function ensureColumns(name, ss) {
    var S = schema_();
    S.table(name); // unknown names throw before anything is created
    var book = spreadsheet_(ss);
    var sh = book.getSheetByName(name);
    if (!sh) { sh = book.insertSheet(name); sh.setFrozenRows(1); }
    var header = header_(sh);
    var missing = addMissingColumns_(sh, name, header);
    var rows = Math.max(sh.getMaxRows() - 1, 1);
    missing.forEach(function (h, i) {
      var fmt = FORMATS[S.typeOf(name, h)];
      if (fmt) sh.getRange(2, header.length + i + 1, rows, 1).setNumberFormat(fmt);
    });
    return missing;
  }

  /**
   * Create missing tabs, add missing columns at the end of row 1 (never reorders or
   * deletes), format columns by type, freeze the header, add missing Settings keys
   * with their defaults, and refresh the note of known keys (values are never touched).
   * Settings keys the code no longer reads are reported, not deleted. Tabs that aren't in
   * the schema are left alone. Safe to rerun.
   * @return {{created:string[], addedColumns:Object<string,string[]>, addedSettings:string[],
   *           updatedNotes:string[], unusedSettings:string[]}}
   */
  function ensureSchema(ss) {
    var S = schema_();
    var book = spreadsheet_(ss);
    var report = { created: [], addedColumns: {}, addedSettings: [], updatedNotes: [], unusedSettings: [] };

    S.ORDER.forEach(function (name) {
      var sh = book.getSheetByName(name);
      if (!sh) { sh = book.insertSheet(name); report.created.push(name); }

      var header = header_(sh);
      var missing = addMissingColumns_(sh, name, header);
      if (missing.length && header.length) report.addedColumns[name] = missing;
      header = header.concat(missing);
      sh.setFrozenRows(1);

      var rows = Math.max(sh.getMaxRows() - 1, 1);
      header.forEach(function (h, i) {
        var fmt = FORMATS[S.typeOf(name, h)];
        if (fmt) sh.getRange(2, i + 1, rows, 1).setNumberFormat(fmt);
      });
    });

    var have = {};
    var defaults = calc_().DEFAULTS;
    // written by recompute and the web app's import, not in DEFAULTS
    var written = { usage_from: true, usage_to: true, import_from: true, import_to: true, import_at: true, import_by: true };
    var stale = [];
    readTable('Settings', book).forEach(function (r) {
      if (!r.key) return;
      have[r.key] = true;
      var note = S.SETTING_NOTES[r.key];
      if (note && r.note !== note) { r.note = note; stale.push(r); }
      if (!(r.key in defaults) && !written[r.key]) report.unusedSettings.push(r.key);
    });
    if (stale.length) updateFields('Settings', stale, ['note'], book);
    report.updatedNotes = stale.map(function (r) { return r.key; });
    var add = Object.keys(defaults).filter(function (k) { return !have[k]; }).map(function (k) {
      return { key: k, value: defaults[k], note: S.SETTING_NOTES[k] || '' };
    });
    if (add.length) appendRows('Settings', add, book);
    report.addedSettings = add.map(function (r) { return r.key; });
    return report;
  }

  // ------------------------------------------------------------------- read

  /**
   * All non-blank rows of a tab as objects keyed by column name, plus `_row`.
   * Columns in the schema are converted by type; extra columns are returned raw.
   */
  function readTable(name, ss) {
    var S = schema_();
    var sh = sheet_(name, ss);
    var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol === 0) return [];
    var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
    var header = values[0].map(function (h) { return String(h).trim(); });
    var types = header.map(function (h) { return S.typeOf(name, h); });
    var out = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (row.every(isBlank_)) continue;
      var obj = { _row: i + 1 };
      for (var c = 0; c < header.length; c++) {
        if (header[c]) obj[header[c]] = fromCell(row[c], types[c]);
      }
      out.push(obj);
    }
    return out;
  }

  /** Settings tab as {key: value} (raw values; see settings()). */
  function readSettings(ss) {
    var out = {};
    readTable('Settings', ss).forEach(function (r) { if (r.key) out[r.key] = r.value; });
    return out;
  }

  /** Settings merged over Calc.DEFAULTS, numbers parsed: what Calc functions expect. */
  function settings(ss) {
    return calc_().settingsWithDefaults(readSettings(ss));
  }

  // ------------------------------------------------------------------ write

  /** Append objects as new rows, in the tab's current column order. Returns the first new row number. */
  function appendRows(name, objs, ss) {
    var sh = sheet_(name, ss);
    var header = header_(sh);
    var first = sh.getLastRow() + 1;
    if (!objs.length) return first;
    var rows = objs.map(function (o) { return rowFromObject_(name, header, o); });
    sh.getRange(first, 1, rows.length, header.length).setValues(rows);
    return first;
  }

  /**
   * Write the given fields of rows read earlier (each needs `_row`). One read and one
   * write per field, so it stays fast for a few hundred rows.
   */
  function updateFields(name, records, fields, ss) {
    if (!records.length || !fields.length) return;
    var S = schema_();
    var sh = sheet_(name, ss);
    var header = header_(sh);
    var lastRow = sh.getLastRow();
    fields.forEach(function (f) {
      var col = header.indexOf(f);
      if (col < 0) throw new Error('Column "' + f + '" not found in ' + name);
      var range = sh.getRange(2, col + 1, lastRow - 1, 1);
      var vals = range.getValues();
      var type = S.typeOf(name, f);
      records.forEach(function (r) {
        if (!(r._row >= 2 && r._row <= lastRow)) throw new Error('Bad _row ' + r._row + ' for ' + name);
        vals[r._row - 2][0] = toCell(r[f], type);
      });
      range.setValues(vals);
    });
  }

  function keyOf_(keyFields, obj) {
    return keyFields.map(function (k) { return String(obj[k]); }).join('\u0001');
  }

  /**
   * Insert or update rows by the tab's key (Schema key, e.g. round_id + drug_id).
   * Only the fields present in `objs` are written on existing rows.
   * @return {{updated:number, appended:number}}
   */
  function upsert(name, objs, ss) {
    var keyFields = schema_().table(name).key;
    if (!keyFields) throw new Error(name + ' has no key');
    var index = {};
    readTable(name, ss).forEach(function (r) { index[keyOf_(keyFields, r)] = r; });

    // A key repeated within objs is merged into one record; later values win.
    var updates = {}, appends = {}, order = [], fields = {};
    objs.forEach(function (o) {
      keyFields.forEach(function (k) { if (isBlank_(o[k])) throw new Error('Missing key ' + k + ' for ' + name); });
      var key = keyOf_(keyFields, o);
      var existing = index[key];
      var rec = existing ? (updates[key] = updates[key] || { _row: existing._row })
                         : (appends[key] = appends[key] || (order.push(key), {}));
      Object.keys(o).forEach(function (k) {
        if (k === '_row') return;
        rec[k] = o[k];
        if (existing) fields[k] = true;
      });
    });
    updates = Object.keys(updates).map(function (k) { return updates[k]; });
    appends = order.map(function (k) { return appends[k]; });
    updateFields(name, updates, Object.keys(fields), ss);
    appendRows(name, appends, ss);
    return { updated: updates.length, appended: appends.length };
  }

  /** Replace every data row of a tab (row 1 kept). */
  function rewriteTable(name, objs, ss) {
    var sh = sheet_(name, ss);
    var header = header_(sh);
    var lastRow = sh.getLastRow();
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, header.length).clearContent();
    if (objs.length) {
      var rows = objs.map(function (o) { return rowFromObject_(name, header, o); });
      sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    }
  }

  /**
   * Store daily usage: rows dated within the incoming range (first..last date) are
   * replaced, rows outside it are kept, so re-importing a period never double counts.
   * @param {{date:string, drug_id:string, qty:number}[]} rows  ISO dates
   * @return {{removed:number, added:number, total:number}}
   */
  function replaceUsage(rows, ss) {
    if (!rows.length) return { removed: 0, added: 0, total: readTable('UsageDaily', ss).length };
    var from = rows[0].date, to = rows[0].date;
    rows.forEach(function (r) { if (r.date < from) from = r.date; if (r.date > to) to = r.date; });
    var existing = readTable('UsageDaily', ss);
    var kept = existing.filter(function (r) { return r.date < from || r.date > to; });
    var all = kept.map(function (r) { return { date: r.date, drug_id: r.drug_id, qty: r.qty }; }).concat(rows);
    all.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : a.drug_id < b.drug_id ? -1 : a.drug_id > b.drug_id ? 1 : 0;
    });
    rewriteTable('UsageDaily', all, ss);
    return { removed: existing.length - kept.length, added: rows.length, total: all.length };
  }

  /** Next free drug_id ('D001', 'D002', ...), never reusing a number. */
  function nextDrugId(existingIds) {
    var max = 0;
    existingIds.forEach(function (id) {
      var m = /^D(\d+)$/.exec(String(id));
      if (m && +m[1] > max) max = +m[1];
    });
    var n = String(max + 1);
    while (n.length < 3) n = '0' + n;
    return 'D' + n;
  }

  /** Run fn under the document lock (no lock outside Apps Script, e.g. in tests). */
  function withLock(fn) {
    if (typeof LockService === 'undefined') return fn();
    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  return {
    fromCell: fromCell,
    toCell: toCell,
    ensureSchema: ensureSchema,
    ensureColumns: ensureColumns,
    readTable: readTable,
    readSettings: readSettings,
    settings: settings,
    appendRows: appendRows,
    updateFields: updateFields,
    upsert: upsert,
    rewriteTable: rewriteTable,
    replaceUsage: replaceUsage,
    nextDrugId: nextDrugId,
    withLock: withLock
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Db;
