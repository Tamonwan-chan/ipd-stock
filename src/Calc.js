/**
 * Calc.js — pure calculation functions for the IPD stock tool.
 *
 * No Apps Script services are used here, so this file runs unchanged in
 * Google Apps Script (as the global `Calc`) and in Node (via require) for tests.
 * Dates are ISO strings 'YYYY-MM-DD' throughout; the Apps Script layer converts
 * Sheet Date cells to ISO before calling in.
 *
 * Policy: periodic review, order-up-to (R, S). See docs/DESIGN.md §5.
 */
var Calc = (function () {
  'use strict';

  var EPS = 1e-9;

  /** Settings defaults; the Settings sheet overrides any of these. */
  var DEFAULTS = {
    cycle_days: 14,         // days between main-storage requisitions (every 2 weeks)
    lead_days: 1,           // count day -> delivery day. Pending confirmation with IPD
    delay_days: 0,          // extra days for late delivery
    history_days: 90,       // usage history used for par
    z: 1.65,                // safety factor, normal drugs
    critical_z: 2.33,       // safety factor, critical drugs
    main_pack_share: 0.8,   // busiest cycle uses at least this share of a pack -> main storage, else OPD
    min_use_freq: 1 / 7,    // fallback when pack_size is unknown: below this share of days used, not stocked
    expensive_value: 5000,  // THB of usage over the history window ...
    expensive_max_freq: 0.5 // ... combined with use on fewer than this share of days
  };

  // ---------------------------------------------------------------- helpers

  /** Round up, ignoring floating-point noise (6.0000000001 -> 6). `+ 0` turns -0 into 0. */
  function ceilSafe(x) {
    return Math.ceil(x - EPS) + 0;
  }

  /** True for null, undefined, '' and whitespace-only strings. */
  function isBlank(v) {
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  }

  /** Number from a cell value, or null when blank / not a number. */
  function toNumber(v) {
    if (isBlank(v)) return null;
    var n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
    return isFinite(n) ? n : null;
  }

  /** Merge user settings over DEFAULTS, converting numeric strings. */
  function settingsWithDefaults(s) {
    var out = {};
    for (var k in DEFAULTS) {
      var v = s && toNumber(s[k]);
      out[k] = v === null || v === undefined ? DEFAULTS[k] : v;
    }
    return out;
  }

  // ------------------------------------------------------------------ dates

  function isoFromUTC(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function utcFromIso(iso) {
    var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!p) throw new Error('Bad ISO date: ' + iso);
    return Date.UTC(+p[1], +p[2] - 1, +p[3]);
  }

  function addDays(iso, n) {
    return isoFromUTC(utcFromIso(iso) + n * 864e5);
  }

  /** Inclusive day count from a to b ('2026-08-01'..'2026-08-03' -> 3). */
  function daysInclusive(a, b) {
    return Math.round((utcFromIso(b) - utcFromIso(a)) / 864e5) + 1;
  }

  /**
   * HOSxP export date 'd/m/yyyy' -> ISO. Accepts Buddhist-era years (> 2400)
   * by subtracting 543. Throws on anything else so bad imports fail loudly.
   */
  function parseHosxpDate(s) {
    var p = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(String(s));
    if (!p) throw new Error('Unrecognised HOSxP date: ' + s);
    var d = +p[1], m = +p[2], y = +p[3];
    if (y > 2400) y -= 543;
    var ms = Date.UTC(y, m - 1, d);
    var iso = isoFromUTC(ms);
    if (+iso.slice(8, 10) !== d || +iso.slice(5, 7) !== m) throw new Error('Invalid date: ' + s);
    return iso;
  }

  // ------------------------------------------------------- drug identity

  /** Collapse whitespace so trivial spacing differences still match. */
  function norm(s) {
    return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
  }

  /** Match key for a HOSxP drug: name + strength + unit. */
  function drugKey(name, strength, unit) {
    return norm(name) + ' | ' + norm(strength) + ' | ' + norm(unit);
  }

  /** HOSxP tags high-alert drugs with 'HAD' in the name. */
  function isCriticalName(name) {
    return /HAD/i.test(String(name));
  }

  /** Placeholder rows such as 'YA.........' with unit '.'. */
  function isPlaceholder(name, unit) {
    return /\.{5,}/.test(String(name)) || norm(unit) === '.';
  }

  // ------------------------------------------------------------ usage stats

  /**
   * Daily quantity series from [{date: ISO, qty}] rows, covering from..to
   * inclusive. Missing days are 0; rows outside the range are ignored;
   * several rows on one day are summed.
   */
  function dailySeries(rows, from, to) {
    var n = daysInclusive(from, to);
    var series = [];
    for (var i = 0; i < n; i++) series.push(0);
    var start = utcFromIso(from);
    (rows || []).forEach(function (r) {
      var q = toNumber(r.qty);
      if (q === null) return;
      var idx = Math.round((utcFromIso(r.date) - start) / 864e5);
      if (idx >= 0 && idx < n) series[idx] += q;
    });
    return series;
  }

  /** Mean, population SD, share of days used, total and length of a series. */
  function usageStats(series) {
    var n = series.length;
    if (n === 0) return { days: 0, total: 0, mean: 0, sd: 0, useFreq: 0 };
    var total = 0, used = 0;
    series.forEach(function (q) { total += q; if (q > 0) used++; });
    var mean = total / n, ss = 0;
    series.forEach(function (q) { ss += (q - mean) * (q - mean); });
    return { days: n, total: total, mean: mean, sd: Math.sqrt(ss / n), useFreq: used / n };
  }

  /** Largest sum over any W consecutive days (whole series if shorter than W). */
  function maxWindowSum(series, W) {
    if (series.length <= W) return series.reduce(function (a, b) { return a + b; }, 0);
    var s = 0, best;
    for (var i = 0; i < W; i++) s += series[i];
    best = s;
    for (var j = W; j < series.length; j++) {
      s += series[j] - series[j - W];
      if (s > best) best = s;
    }
    return best;
  }

  /**
   * usageStats plus `cycleMax`, the busiest cycle_days-long stretch in the series
   * (input for the 1-pack rule).
   */
  function drugStats(series, settings) {
    var s = settingsWithDefaults(settings);
    var st = usageStats(series);
    st.cycleMax = maxWindowSum(series, s.cycle_days);
    return st;
  }

  // -------------------------------------------------------------------- par

  /** Days from count to the next delivery, inclusive (default 14 + 1 + 1 + 0 = 16). */
  function windowDays(settings) {
    var s = settingsWithDefaults(settings);
    return s.cycle_days + s.lead_days + 1 + s.delay_days;
  }

  /**
   * Par level for one drug, in HOSxP units.
   *   parCalc = ceil(mean·W + z·sd·√W); critical drugs also ≥ worst W-day demand.
   *   par     = par_override if set, else max(parCalc, min_par).
   *
   * @param {number[]} series  daily usage over the history window
   * @param {{critical?:boolean, min_par?:*, par_override?:*}} drug
   * @param {Object} settings
   * @return {{par:number, parCalc:number, source:string, W:number, mean:number, sd:number, useFreq:number}}
   *   source: 'override' | 'min_par' | 'calc' | 'none'
   */
  function calcPar(series, drug, settings) {
    var s = settingsWithDefaults(settings);
    var W = windowDays(s);
    var st = usageStats(series);
    var critical = !!(drug && drug.critical);
    var z = critical ? s.critical_z : s.z;

    var parCalc = st.mean > 0 ? ceilSafe(st.mean * W + z * st.sd * Math.sqrt(W)) : 0;
    if (critical) parCalc = Math.max(parCalc, maxWindowSum(series, W));

    var override = toNumber(drug && drug.par_override);
    var minPar = toNumber(drug && drug.min_par) || 0;
    var par, source;
    if (override !== null) { par = override; source = 'override'; }
    else if (minPar > parCalc) { par = minPar; source = 'min_par'; }
    else { par = parCalc; source = parCalc > 0 ? 'calc' : 'none'; }

    return { par: par, parCalc: parCalc, source: source, W: W, mean: st.mean, sd: st.sd, useFreq: st.useFreq };
  }

  /** Days from a count to that cycle's delivery, inclusive (default 1 + 1 + 0 = 2). */
  function minDays(settings) {
    var s = settingsWithDefaults(settings);
    return s.lead_days + 1 + s.delay_days;
  }

  /**
   * Min (ยอดต่ำสุด) for one drug, in HOSxP units: stock that should last from a count
   * until that cycle's delivery arrives. Below it, the drug will probably run out first,
   * so staff fetch it from OPD the same day.
   *   minCalc = ceil(mean·T + z·sd·√T), T = lead_days + 1 + delay_days;
   *   critical drugs also ≥ the worst T-day demand seen.
   * @param {number[]} series  daily usage over the history window
   * @param {{critical?:boolean}} drug
   * @return {{minCalc:number, T:number}}
   */
  function calcMin(series, drug, settings) {
    var s = settingsWithDefaults(settings);
    var T = minDays(s);
    var st = usageStats(series);
    var critical = !!(drug && drug.critical);
    var z = critical ? s.critical_z : s.z;
    var minCalc = st.mean > 0 ? ceilSafe(st.mean * T + z * st.sd * Math.sqrt(T)) : 0;
    if (critical) minCalc = Math.max(minCalc, maxWindowSum(series, T));
    return { minCalc: minCalc, T: T };
  }

  /**
   * Min in effect for a Drugs row: min_override if set, else min_calc; never above the par
   * in effect (a min above max would flag every count).
   * @return {{min:number, source:string}}  source: 'override' | 'calc' | 'none'
   */
  function minFromStored(drug) {
    var par = parFromStored(drug).par;
    var override = toNumber(drug.min_override);
    var min, source;
    if (override !== null) { min = override; source = 'override'; }
    else { min = toNumber(drug.min_calc) || 0; source = min > 0 ? 'calc' : 'none'; }
    return { min: Math.min(min, par), source: source };
  }

  /**
   * Par in effect for a Drugs row, from the stored par_calc (same rules as calcPar):
   * par_override if set, else max(par_calc, min_par).
   * @return {{par:number, source:string}}  source: 'override' | 'min_par' | 'calc' | 'none'
   */
  function parFromStored(drug) {
    var override = toNumber(drug.par_override);
    if (override !== null) return { par: override, source: 'override' };
    var calc = toNumber(drug.par_calc) || 0;
    var minPar = toNumber(drug.min_par) || 0;
    if (minPar > calc) return { par: minPar, source: 'min_par' };
    return { par: calc, source: calc > 0 ? 'calc' : 'none' };
  }

  /**
   * Where a drug should come from (DESIGN §5.2, issue #3):
   *   busiest cycle in the history ≥ main_pack_share (80%) of a pack → 'MAIN' (main storage, par-based)
   *   otherwise                                                       → 'OPD'  (fetched from OPD, optional)
   *   pack size unknown                                               → 'UNKNOWN'
   * @param {number} cycleMax  largest use over any cycle_days-long stretch, in HOSxP units (drugStats)
   * @param {*} packSize       HOSxP units per pack (blank = unknown)
   */
  function supplySource(cycleMax, packSize, settings) {
    var s = settingsWithDefaults(settings);
    var pack = toNumber(packSize);
    if (pack === null || pack <= 0) return 'UNKNOWN';
    return (cycleMax || 0) >= s.main_pack_share * pack - EPS ? 'MAIN' : 'OPD';
  }

  /**
   * Suggested supply source, stock-list membership and review tier for one drug.
   * `stocked` = counted at each round and ordered up to par from main storage.
   * @param {{name:string, unit?:string, unit_price?:*, pack_size?:*}} d
   * @param {{cycleMax?:number, total?:number, useFreq:number}} stats  drugStats over the history window
   * @return {{stocked:boolean, critical:boolean, tier:string, source:string|null}}
   *   tier:   'placeholder' | 'critical' | 'expensive' | 'regular' | 'opd' | 'rare'
   *   source: 'MAIN' | 'OPD' | 'UNKNOWN' (pack size missing) | null (placeholder)
   */
  function classifyDrug(d, stats, settings) {
    var s = settingsWithDefaults(settings);
    if (isPlaceholder(d.name, d.unit)) return { stocked: false, critical: false, tier: 'placeholder', source: null };
    // HAD drugs must never run out: always main storage (open question in issue #3).
    // d.critical (the Drugs column) wins when given; otherwise the HAD tag in the name decides.
    var critical = d.critical === undefined || d.critical === null || d.critical === '' ? isCriticalName(d.name) : !!d.critical;
    if (critical) return { stocked: true, critical: true, tier: 'critical', source: 'MAIN' };
    var source = supplySource(stats.cycleMax, d.pack_size, s);
    var value = (stats.total || 0) * (toNumber(d.unit_price) || 0);
    if (value >= s.expensive_value && stats.useFreq < s.expensive_max_freq) {
      return { stocked: false, critical: false, tier: 'expensive', source: source }; // pharmacist sets min_par
    }
    if (source === 'MAIN') return { stocked: true, critical: false, tier: 'regular', source: source };
    if (source === 'OPD') return { stocked: false, critical: false, tier: 'opd', source: source };
    // Pack size unknown: fall back to use frequency until it is filled in.
    if (stats.useFreq >= s.min_use_freq - EPS) return { stocked: true, critical: false, tier: 'regular', source: source };
    return { stocked: false, critical: false, tier: 'rare', source: source };
  }

  /**
   * Final stock decision for one drug: the pharmacist's `source` wins over the 1-pack rule.
   *   source 'OPD'                      → not stocked
   *   source 'MAIN' set by pharmacist   → stocked
   *   rule says MAIN                    → stocked, except expensive drugs without a manual par
   *   pack size unknown                 → classifyDrug's use-frequency fallback (expensive: manual par only)
   * Critical drugs are always stocked; placeholders never.
   * @param {{source?:string, min_par?:*, par_override?:*}} drug  Drugs row
   * @param {{stocked:boolean, critical:boolean, tier:string, source:string|null}} cls  classifyDrug result
   * @return {{source:string|null, stocked:boolean}}  source = the one in effect
   */
  function stockDecision(drug, cls) {
    if (cls.tier === 'placeholder') return { source: null, stocked: false };
    if (cls.critical) return { source: 'MAIN', stocked: true };
    var manual = norm(drug.source).toUpperCase();
    var source = manual === 'MAIN' || manual === 'OPD' ? manual : cls.source;
    var manualPar = (toNumber(drug.min_par) || 0) > 0 || toNumber(drug.par_override) !== null;
    if (source === 'OPD') return { source: source, stocked: false };
    if (manual === 'MAIN') return { source: source, stocked: true };
    if (cls.tier === 'expensive') return { source: source, stocked: manualPar };
    if (source === 'MAIN') return { source: source, stocked: true };
    return { source: source, stocked: cls.stocked };
  }

  // ------------------------------------------------------------------ order

  /**
   * Quantity to request from main storage, in request units (whole units, rounded up).
   * @param {number} par            in HOSxP units
   * @param {*} countedRequestUnits on hand, in request units (may be decimal); blank = not counted
   * @param {*} requestFactor       HOSxP units per request unit (blank = 1)
   * @return {{counted:boolean, onHand:number|null, shortfall:number|null, qty:number|null}}
   */
  function suggestOrder(par, countedRequestUnits, requestFactor) {
    var f = toNumber(requestFactor) || 1;
    var c = toNumber(countedRequestUnits);
    if (c === null) return { counted: false, onHand: null, shortfall: null, qty: null };
    var onHand = c * f;
    var shortfall = Math.max(0, par - onHand);
    return { counted: true, onHand: onHand, shortfall: shortfall, qty: ceilSafe(shortfall / f) };
  }

  /**
   * Review flags for one round line.
   * @param {{critical?:boolean, stocked?:boolean}} drug
   * @param {{par:number, source:string, mean:number, min?:number}} parInfo  min in HOSxP units (minFromStored)
   * @param {{counted:boolean, onHand:number|null, qty:number|null}} order
   * @param {*} finalQty  pharmacist's quantity (blank = unchanged)
   * @param {*} requestFactor
   * @param {Object} settings
   * @return {string[]}
   */
  function lineFlags(drug, parInfo, order, finalQty, requestFactor, settings) {
    var s = settingsWithDefaults(settings);
    var f = toNumber(requestFactor) || 1;
    var flags = [];
    if (!order.counted) flags.push('NOT_COUNTED');
    if (order.counted && parInfo.min > 0 && order.onHand < parInfo.min) flags.push('BELOW_MIN');
    if (drug.critical && order.counted && order.onHand < parInfo.par) flags.push('CRITICAL_LOW');
    var cycleUse = parInfo.mean * s.cycle_days;
    if (order.counted && cycleUse > 0 && order.qty * f > 2 * cycleUse) flags.push('BIG_ORDER');
    if (parInfo.source !== 'calc') flags.push('NO_USAGE_DATA');
    var fq = toNumber(finalQty);
    if (fq !== null && fq !== order.qty) flags.push('EDITED');
    return flags;
  }

  /**
   * Suggested quantity for an OPD drug: expected use over one cycle, in request units.
   * Staff decide per line whether to request it at all (issue #3).
   */
  function opdSuggestion(meanDaily, requestFactor, settings) {
    var s = settingsWithDefaults(settings);
    var f = toNumber(requestFactor) || 1;
    var mean = meanDaily || 0;
    return mean > 0 ? Math.max(1, ceilSafe(mean * s.cycle_days / f)) : 0;
  }

  // ----------------------------------------------------------------- output

  function displayName(drug) {
    return norm(drug.request_name) || norm(drug.hosxp_name);
  }

  function displayUnit(drug) {
    return norm(drug.request_unit) || norm(drug.unit);
  }

  /**
   * One line of the main-storage form ใบเบิกหรือใบส่งคืน (issue #4). Quantities in units.
   * @param {*} onHand  counted on-hand in request units (คงเหลือจากครั้งที่แล้ว)
   */
  function mainFormLine(drug, onHand, qty) {
    var c = toNumber(onHand);
    return {
      item_code: norm(drug.item_code),
      name: displayName(drug),
      unit: displayUnit(drug),
      on_hand: c === null ? '' : c,
      qty: qty
    };
  }

  /**
   * Tab-separated main-storage lines with qty > 0, in the form's column order:
   * ลำดับ, หมายเลขพัสดุ, รายการ, หน่วยนับ, คงเหลือจากครั้งที่แล้ว, จำนวนเบิกใหม่.
   */
  function mainFormTsv(lines) {
    return lines
      .filter(function (l) { return l.qty > 0; })
      .map(function (l, i) { return [i + 1, l.item_code, l.name, l.unit, l.on_hand, l.qty].join('\t'); })
      .join('\n');
  }

  /** One line of the OPD request list. */
  function opdLine(drug, qty) {
    return { name: displayName(drug), qty: qty, unit: displayUnit(drug), remark: 'IPD' };
  }

  /** Numbered tab-separated OPD lines with qty > 0. */
  function opdTsv(lines) {
    return lines
      .filter(function (l) { return l.qty > 0; })
      .map(function (l, i) { return [i + 1, l.name, l.qty, l.unit, l.remark].join('\t'); })
      .join('\n');
  }

  return {
    DEFAULTS: DEFAULTS,
    settingsWithDefaults: settingsWithDefaults,
    toNumber: toNumber,
    isBlank: isBlank,
    addDays: addDays,
    daysInclusive: daysInclusive,
    parseHosxpDate: parseHosxpDate,
    drugKey: drugKey,
    isCriticalName: isCriticalName,
    isPlaceholder: isPlaceholder,
    dailySeries: dailySeries,
    usageStats: usageStats,
    maxWindowSum: maxWindowSum,
    drugStats: drugStats,
    windowDays: windowDays,
    calcPar: calcPar,
    parFromStored: parFromStored,
    minDays: minDays,
    calcMin: calcMin,
    minFromStored: minFromStored,
    supplySource: supplySource,
    classifyDrug: classifyDrug,
    stockDecision: stockDecision,
    suggestOrder: suggestOrder,
    lineFlags: lineFlags,
    opdSuggestion: opdSuggestion,
    mainFormLine: mainFormLine,
    mainFormTsv: mainFormTsv,
    opdLine: opdLine,
    opdTsv: opdTsv
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
