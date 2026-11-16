#!/usr/bin/env node
/**
 * Apply the 1-pack rule (issue #3) to every drug in a HOSxP daily IPD dispensing export:
 * busiest cycle ≥ main_pack_share (80%) of a pack → MAIN (main storage), otherwise OPD.
 *
 *   npm run pack-rule -- data/raw/<export>.csv --packs data/raw/<packs>.csv --out data/raw/<report>.csv [--cycle 14]
 *
 * --packs  CSV with columns drug_name,strength,drug_unit,pack_size (other columns ignored).
 *          Drugs missing from it, or with a blank pack_size, get source UNKNOWN.
 * --out    per-drug report (UTF-8 with BOM so Excel shows Thai). It holds per-drug usage,
 *          so it must stay in data/raw/ (gitignored). The console shows aggregates only.
 * --init-packs  write a packs CSV listing every drug with a blank pack_size, to fill in,
 *          keeping any pack sizes already in --packs.
 */
const fs = require('node:fs');
const path = require('node:path');
const Calc = require('../src/Calc.js');

function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.length > 1 || r[0] !== '');
}

const readCsv = file => parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const colOf = header => name => { const i = header.indexOf(name); if (i < 0) throw new Error('missing column ' + name); return i; };
const csvCell = v => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const writeCsv = (file, rows) => fs.writeFileSync(file, '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function args(argv) {
  const out = { file: null, packs: null, out: null, cycle: null, initPacks: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--packs') out.packs = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--cycle') out.cycle = Number(argv[++i]);
    else if (argv[i] === '--init-packs') out.initPacks = argv[++i];
    else out.file = argv[i];
  }
  if (!out.file || !(out.out || out.initPacks)) {
    console.error('usage: npm run pack-rule -- <export.csv> [--packs packs.csv] (--out report.csv | --init-packs packs.csv) [--cycle N]');
    process.exit(1);
  }
  for (const f of [out.out, out.initPacks]) {
    if (f && !path.resolve(f).includes(path.join('data', 'raw'))) {
      console.error(`refusing to write per-drug data outside data/raw/: ${f}`);
      process.exit(1);
    }
  }
  return out;
}

const opt = args(process.argv.slice(2));
const settings = Calc.settingsWithDefaults({ cycle_days: opt.cycle });

// Pack sizes (and any notes) by drug key.
const packs = new Map();
if (opt.packs && fs.existsSync(opt.packs)) {
  const [ph, ...pr] = readCsv(opt.packs);
  const pc = colOf(ph);
  const noteCol = ph.indexOf('pack_note');
  for (const r of pr) {
    packs.set(Calc.drugKey(r[pc('drug_name')], r[pc('strength')], r[pc('drug_unit')]),
      { size: r[pc('pack_size')], note: noteCol >= 0 ? r[noteCol] : '' });
  }
}

// Usage by drug.
const [header, ...rows] = readCsv(opt.file);
const col = colOf(header);
const C = { date: col('order_date'), name: col('drug_name'), strength: col('strength'), unit: col('drug_unit'), qty: col('total_quantity'), price: col('unit_price') };
const drugs = new Map();
let first = null, last = null;
for (const r of rows) {
  const date = Calc.parseHosxpDate(r[C.date]);
  if (!first || date < first) first = date;
  if (!last || date > last) last = date;
  const key = Calc.drugKey(r[C.name], r[C.strength], r[C.unit]);
  if (!drugs.has(key)) drugs.set(key, { key, name: r[C.name], strength: r[C.strength], unit: r[C.unit], rows: [] });
  const d = drugs.get(key);
  d.unit_price = Number(r[C.price]) || d.unit_price || 0; // latest price
  d.rows.push({ date, qty: r[C.qty] });
}

if (opt.initPacks) {
  const out = [['drug_name', 'strength', 'drug_unit', 'pack_size', 'pack_note']];
  for (const d of [...drugs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const p = packs.get(d.key) || { size: '', note: '' };
    out.push([d.name, d.strength, d.unit, p.size, p.note]);
  }
  writeCsv(opt.initPacks, out);
  console.log(`wrote ${out.length - 1} drugs to ${opt.initPacks}`);
}

if (opt.out) {
  const N = settings.cycle_days;
  const out = [['drug_name', 'strength', 'drug_unit', 'unit_price', 'use_days', 'total_qty',
    `avg_per_${N}d`, `busiest_${N}d`, 'pack_size', 'busiest_share_of_pack', 'source', 'stocked', 'tier', 'opd_suggestion', 'pack_note']];
  const counts = {};
  for (const d of drugs.values()) {
    const series = Calc.dailySeries(d.rows, first, last);
    const st = Calc.drugStats(series, settings);
    const p = packs.get(d.key) || { size: '', note: '' };
    const cls = Calc.classifyDrug({ name: d.name, unit: d.unit, unit_price: d.unit_price, pack_size: p.size }, st, settings);
    const perCycle = st.mean * N;
    const pack = Calc.toNumber(p.size);
    counts[cls.source || 'placeholder'] = (counts[cls.source || 'placeholder'] || 0) + 1;
    d.out = [d.name, d.strength, d.unit, d.unit_price, Math.round(st.useFreq * st.days), st.total,
      round(perCycle), st.cycleMax, p.size, pack ? round(st.cycleMax / pack, 2) : '',
      cls.source || '', cls.stocked ? 'Y' : '', cls.tier,
      cls.source === 'OPD' ? Calc.opdSuggestion(st.mean, 1, settings) : '', p.note];
    d.sortKey = { MAIN: 0, OPD: 1, UNKNOWN: 2 }[cls.source] ?? 3;
    d.cycleMax = st.cycleMax;
  }
  const sorted = [...drugs.values()].sort((a, b) => a.sortKey - b.sortKey || b.cycleMax - a.cycleMax);
  writeCsv(opt.out, out.concat(sorted.map(d => d.out)));
  console.log(`data     ${first} → ${last} (${Calc.daysInclusive(first, last)} days), ${drugs.size} drugs, cycle ${N} days`);
  console.log(`source   ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`wrote    ${opt.out}`);
}
