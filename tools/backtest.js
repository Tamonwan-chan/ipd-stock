#!/usr/bin/env node
/**
 * Backtest the par formula in src/Calc.js against a HOSxP daily IPD dispensing export.
 *
 *   npm run backtest -- data/raw/<export>.csv [--split 2026-10-01] [--z 1.65] [--delay 0]
 *                       [--cycle 14]
 *
 * Par is computed from usage before --split and checked against demand from every
 * possible count day after it. A drug-cycle is "short" when demand from the count day
 * to the next delivery (W days) exceeds par. Prints aggregates only, never per-drug
 * data, so output is safe to paste into docs. The CSV itself stays in data/raw/ (gitignored).
 *
 * Expected CSV columns (HOSxP export):
 *   order_date,drug_name,strength,drug_unit,total_quantity,unit_price,total_price
 */
const fs = require('node:fs');
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

function args(argv) {
  const out = { file: null, split: null, z: null, delay: null, cycle: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--split') out.split = argv[++i];
    else if (argv[i] === '--z') out.z = Number(argv[++i]);
    else if (argv[i] === '--delay') out.delay = Number(argv[++i]);
    else if (argv[i] === '--cycle') out.cycle = Number(argv[++i]);
    else out.file = argv[i];
  }
  if (!out.file) { console.error('usage: npm run backtest -- <export.csv> [--split YYYY-MM-DD] [--z N] [--delay N] [--cycle N]'); process.exit(1); }
  return out;
}

const readCsv = file => parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const colOf = header => name => { const i = header.indexOf(name); if (i < 0) throw new Error('missing column ' + name); return i; };

const opt = args(process.argv.slice(2));
const [header, ...rows] = readCsv(opt.file);
const col = colOf(header);
const C = { date: col('order_date'), name: col('drug_name'), strength: col('strength'), unit: col('drug_unit'), qty: col('total_quantity'), price: col('unit_price') };

// Group usage rows by drug.
const drugs = new Map();
let first = null, last = null;
for (const r of rows) {
  const date = Calc.parseHosxpDate(r[C.date]);
  if (!first || date < first) first = date;
  if (!last || date > last) last = date;
  const key = Calc.drugKey(r[C.name], r[C.strength], r[C.unit]);
  if (!drugs.has(key)) drugs.set(key, { name: r[C.name], unit: r[C.unit], unit_price: Number(r[C.price]) || 0, rows: [] });
  drugs.get(key).rows.push({ date, qty: r[C.qty] });
}

const settings = Calc.settingsWithDefaults({ z: opt.z, delay_days: opt.delay, cycle_days: opt.cycle });
const split = opt.split || Calc.addDays(last, -30); // default: last 31 days out of sample
const trainEnd = Calc.addDays(split, -1);
const W = Calc.windowDays(settings);
// Demand is checked against an on-time delivery; delay_days only raises par.
const evalW = Calc.windowDays(Object.assign({}, settings, { delay_days: 0 }));

let starts = 0, short = 0, peak = 0, avg = 0;
const tiers = {}, sources = {};
for (const d of drugs.values()) {
  const train = Calc.dailySeries(d.rows, first, trainEnd);
  const stats = Calc.usageStats(train);
  const cls = Calc.classifyDrug(d, stats, settings);
  tiers[cls.tier] = (tiers[cls.tier] || 0) + 1;
  if (cls.source) sources[cls.source] = (sources[cls.source] || 0) + 1;
  if (!cls.stocked) continue;
  const { par, mean } = Calc.calcPar(train, { critical: cls.critical }, settings);
  peak += par * d.unit_price;
  avg += Math.max(0, par - mean * (1 + settings.cycle_days / 2)) * d.unit_price;
  const test = Calc.dailySeries(d.rows, split, last);
  for (let t = 0; t + evalW <= test.length; t++) {
    starts++;
    if (test.slice(t, t + evalW).reduce((a, b) => a + b, 0) > par) short++;
  }
}

const stocked = (tiers.regular || 0) + (tiers.critical || 0);
const pShort = short / starts;
console.log(`data            ${first} → ${last} (${Calc.daysInclusive(first, last)} days), ${drugs.size} drugs`);
console.log(`train / test    ${first}..${trainEnd} / ${split}..${last}`);
console.log(`settings        cycle ${settings.cycle_days} days, par window W=${W} days, checked against ${evalW} days (on-time delivery), z=${settings.z}, critical_z=${settings.critical_z}`);
console.log(`tiers           ${Object.entries(tiers).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`source          ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`stocked         ${stocked} drugs`);
console.log(`short           ${(100 * pShort).toFixed(1)}% of drug-cycles  (≈ ${(pShort * stocked * 30 / settings.cycle_days).toFixed(0)} shortfalls/month)`);
console.log(`stock value     peak ≈ ${(peak / 1000).toFixed(0)}k THB, average on-hand ≈ ${(avg / 1000).toFixed(0)}k THB`);
