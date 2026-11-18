/**
 * Schema.js — tabs and columns of the "IPD Stock" spreadsheet (DESIGN §4).
 *
 * Plain data, no Apps Script calls: Db.js uses it to create tabs and convert cells,
 * and it loads in Node for tests. Row 1 of every tab holds the column names; Db reads
 * by name, so columns may be reordered or extra columns added by hand.
 *
 * Column types:
 *   string    stored as plain text ('@' format) so values like '2026-11-17' or '00123' stay as typed
 *   number    number or blank
 *   bool      checkbox / TRUE-FALSE; blank reads as false
 *   date      calendar date; read as ISO 'YYYY-MM-DD', written as a Sheet date
 *   datetime  timestamp; read as 'YYYY-MM-DD HH:mm', written as a Sheet date-time
 *   raw       left exactly as the Sheet returns it (Settings values, pasted HOSxP data)
 */
var Schema = (function () {
  'use strict';

  function cols(list) {
    return list.map(function (c) { return { name: c[0], type: c[1] }; });
  }

  var TABLES = {
    Settings: {
      key: ['key'],
      columns: cols([['key', 'string'], ['value', 'raw'], ['note', 'string']])
    },
    Drugs: {
      key: ['drug_id'],
      columns: cols([
        ['drug_id', 'string'],
        ['hosxp_name', 'string'],
        ['strength', 'string'],
        ['unit', 'string'],
        ['request_unit', 'string'],
        ['request_factor', 'number'],
        ['request_name', 'string'],
        ['pack_size', 'number'],
        ['source', 'string'],
        ['item_code', 'string'],
        ['unit_price', 'number'],
        ['stocked', 'bool'],
        ['critical', 'bool'],
        ['min_par', 'number'],
        ['par_override', 'number'],
        ['min_override', 'number'],
        ['location', 'string'],
        ['shelf_order', 'number'],
        ['use_freq', 'number'],
        ['mean_daily', 'number'],
        ['source_calc', 'string'],
        ['par_calc', 'number'],
        ['min_calc', 'number'],
        ['par_updated', 'date']
      ])
    },
    UsageDaily: {
      key: ['date', 'drug_id'],
      columns: cols([['date', 'date'], ['drug_id', 'string'], ['qty', 'number']])
    },
    Rounds: {
      key: ['round_id'],
      columns: cols([
        ['round_id', 'string'],
        ['count_date', 'date'],
        ['status', 'string'],
        ['counted_by', 'string'],
        ['submitted_at', 'datetime'],
        ['reviewed_by', 'string'],
        ['approved_at', 'datetime'],
        ['note', 'string'],
        ['received_at', 'datetime'],
        ['received_by', 'string']
      ])
    },
    RoundLines: {
      key: ['round_id', 'drug_id'],
      columns: cols([
        ['round_id', 'string'],
        ['drug_id', 'string'],
        ['on_hand', 'number'],
        ['par_used', 'number'],
        ['suggested_qty', 'number'],
        ['final_qty', 'number'],
        ['boxes', 'number'],
        ['pack_size', 'number'],
        ['change_reason', 'string'],
        ['flags', 'string'],
        ['received_qty', 'number']
      ])
    },
    // Requests to the OPD pharmacy: the monthly list, or an urgent fetch when a drug runs low.
    OpdRequests: {
      key: ['request_id'],
      columns: cols([
        ['request_id', 'string'],
        ['request_date', 'date'],
        ['kind', 'string'],
        ['status', 'string'],
        ['requested_by', 'string'],
        ['received_at', 'datetime'],
        ['received_by', 'string'],
        ['note', 'string']
      ])
    },
    OpdLines: {
      key: ['request_id', 'drug_id'],
      columns: cols([
        ['request_id', 'string'],
        ['drug_id', 'string'],
        ['qty', 'number'],
        ['received_qty', 'number']
      ])
    },
    // Web app logins (Auth.js). Passwords are stored only as a salted hash.
    Users: {
      key: ['username'],
      columns: cols([
        ['username', 'string'],
        ['name', 'string'],
        ['role', 'string'],
        ['active', 'bool'],
        ['pw_salt', 'string'],
        ['pw_hash', 'string'],
        ['created_at', 'datetime'],
        ['last_login', 'datetime']
      ])
    },
    // Who changed what and when (written by Api, read by the admin). Append-only.
    ChangeLog: {
      key: null,
      columns: cols([
        ['at', 'datetime'],
        ['user', 'string'],
        ['action', 'string'],
        ['target', 'string'],
        ['detail', 'string']
      ])
    },
    // Expiry dates typed at a delivery check, one row per date per delivery line. A row
    // leaves the stock when staff remove it (the lot is used up or was a typo).
    Expiry: {
      key: ['ref', 'drug_id', 'exp_date'],
      columns: cols([
        ['ref', 'string'],
        ['drug_id', 'string'],
        ['exp_date', 'date'],
        ['source', 'string'],
        ['added_at', 'datetime'],
        ['added_by', 'string'],
        ['removed_at', 'datetime'],
        ['removed_by', 'string']
      ])
    },
    // Scratch tab: the HOSxP export is pasted here, then cleared after import.
    Import: {
      key: null,
      columns: cols([
        ['order_date', 'raw'],
        ['drug_name', 'raw'],
        ['strength', 'raw'],
        ['drug_unit', 'raw'],
        ['total_quantity', 'raw'],
        ['unit_price', 'raw'],
        ['total_price', 'raw']
      ])
    }
  };

  /** Tab order when creating the spreadsheet. */
  var ORDER = ['Settings', 'Drugs', 'UsageDaily', 'Rounds', 'RoundLines', 'OpdRequests', 'OpdLines', 'Expiry',
    'Users', 'ChangeLog', 'Import'];

  /** Allowed values for coded columns. */
  var ENUMS = {
    source: ['MAIN', 'OPD', 'NONE'],
    source_calc: ['MAIN', 'OPD'],
    location: ['ตู้เก็บยา', 'ชั้นวางยา', 'ลิ้นชักยา'],
    status: ['COUNTING', 'REVIEW', 'APPROVED'],
    kind: ['MONTHLY', 'URGENT'],
    opd_status: ['REQUESTED', 'RECEIVED', 'CANCELLED'],
    role: ['staff', 'admin'],
    expiry_source: ['MAIN', 'OPD']
  };

  /** Notes written next to each setting (read by the admin in the Sheet, so in Thai). */
  var SETTING_NOTES = {
    cycle_days: 'จำนวนวันระหว่างรอบเบิกจากคลัง (14 = ทุก 2 สัปดาห์)',
    lead_days: 'วันนับยา → วันที่ยามาถึง (นับวันอังคารเช้า ยามาถึงวันพุธบ่าย = 1)',
    delay_days: 'วันเผื่อยามาช้า บวกเข้าช่วงที่ต้องมียาพอ',
    history_days: 'จำนวนวันย้อนหลังที่ใช้คำนวณยอดที่ควรมี',
    z: 'ค่าความปลอดภัย ยาทั่วไป (1.65 ≈ 95%)',
    critical_z: 'ค่าความปลอดภัย ยา HAD / ยาห้ามขาด (2.33 ≈ 99%)',
    min_use_freq: 'ยาที่มีการใช้อย่างน้อยสัดส่วนวันนี้ → เบิกจากคลัง น้อยกว่า → ขอจาก OPD (0.143 = 1 ใน 7 วัน ≈ สัปดาห์ละครั้ง)',
    opd_cycle_days: 'จำนวนวันระหว่างรอบขอยาจาก OPD (30 = เดือนละครั้ง) ใช้คำนวณจำนวนที่แนะนำในรายการขอจาก OPD',
    expensive_value: 'มูลค่าการใช้ (บาท) ในช่วงย้อนหลัง ที่ถือว่าเป็นยาราคาสูง',
    expensive_max_freq: 'ยาราคาสูงที่ใช้น้อยกว่าสัดส่วนวันนี้ ให้เภสัชกำหนดยอดเอง'
  };

  function table(name) {
    var t = TABLES[name];
    if (!t) throw new Error('Unknown table: ' + name);
    return t;
  }

  function columnNames(name) {
    return table(name).columns.map(function (c) { return c.name; });
  }

  /** Column type by name; columns not in the schema (added by hand) are 'raw'. */
  function typeOf(name, column) {
    var cs = table(name).columns;
    for (var i = 0; i < cs.length; i++) if (cs[i].name === column) return cs[i].type;
    return 'raw';
  }

  return {
    TABLES: TABLES,
    ORDER: ORDER,
    ENUMS: ENUMS,
    SETTING_NOTES: SETTING_NOTES,
    table: table,
    columnNames: columnNames,
    typeOf: typeOf
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Schema;
