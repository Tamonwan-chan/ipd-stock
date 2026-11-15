# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **draft v0.2**, 15 Nov 2026. Based on [PRD.md](PRD.md), IPD staff answers to PRD section 7, OPD's reply on the requisition format, and an analysis of 3 months of HOSxP dispensing data (§5.1).

Changes from v0.1: no pack sizes or box rounding (OPD accepts plain units); IPD lines are added to OPD's own requisition; usage is stored daily; par uses a percentile of real demand instead of mean × days.

## 1. What round 1 must do

From PRD section 2, nothing more:

1. Compute a **par level** (ยอดที่ควรมี) per drug from real usage.
2. At each weekly count, take on-hand quantities and compute **how much to order**.
3. Produce a **requisition list OPD can add to its own requisition as-is**: drug name, quantity in dispensing units (e.g. `Vitamin B complex 1500 เม็ด`), remark `IPD`.

Out of scope for round 1: automatic stock deduction, live HIS integration, expiry tracking, receiving/check-in records.

## 2. Constraints that shape the design

| Fact (source) | Design consequence |
| :- | :- |
| One pharmacy technician counts and orders, 30–60 min, timing unpredictable (Q7) | Counting must be fast, resumable, and work at the shelf → mobile web page with autosave. Keep the stock list short (§5.2) |
| IPD has no usable computer/printer; prints at the warehouse or OPD (Q10) | Everything runs in a browser; output works from any PC |
| Pharmacist reviews but often can't check every line (Q8) | Review screen shows **exceptions first** |
| OPD orders Tuesday, stock arrives Wednesday ~14:00 (Q1) | Demand window = count day through next delivery = 9 days (§5) |
| 11 HAD injectables must never run out (Q4) | Per-drug `critical` flag → par from the worst observed window + minimum par |
| OPD accepts quantities in units and will add IPD lines to its own requisition (OPD, 15 Nov) | No pack sizes, no box rounding; output is a plain list in units |
| HOSxP export is daily, one row per drug per day, no patient columns | Store daily usage in the Sheet; percentiles need daily data |
| Repo is public | No spreadsheet IDs, script IDs or hospital data in git |

## 3. Architecture

```
┌──────────────── Google Sheet "IPD Stock" (database, private) ────────────────┐
│ Settings │ Drugs │ UsageDaily │ Rounds │ RoundLines │ Users │ Import         │
└────────────────────────────────▲─────────────────────────────────────────────┘
                                 │ SpreadsheetApp (bound script)
┌────────────────────────────────┴─────────────────────────────────────────────┐
│ Apps Script project (this repo, deployed with clasp)                         │
│  Calc.js   pure functions: rolling windows, percentile, par, order (Node-tested)
│  Db.js     read/write sheets as arrays of objects, LockService               │
│  Import.js HOSxP CSV → UsageDaily, new drugs → Drugs, recompute par         │
│  Rounds.js round lifecycle                                                   │
│  Code.js   onOpen menu (admin) + doGet web app routing                       │
└────────────┬───────────────────────────┬─────────────────────────────────────┘
     Sheet menu (admin)           Web app (HtmlService)
     - import usage               - /count   technician, phone
     - recompute par              - /review  pharmacist
     - edit drug list             - /print   list for OPD + copy
```

- **Container-bound script** on the existing private "IPD Stock" spreadsheet (which already holds the HOSxP export): simplest permissions, custom menu for free, no IDs in code.
- **Web app** for the weekly jobs (count, review, output). Admin jobs (import, drug list) stay in the Sheet UI; they're done quarterly by someone comfortable with spreadsheets.
- **`Calc.js` has no Apps Script calls**, so it runs unchanged in Node for tests. It ends with
  `if (typeof module !== 'undefined') module.exports = {...}`.
- Scale: ~340 drugs; ~12k usage rows per quarter (~47k/year); 52 rounds/year. Well within Sheets limits. Writes go through `LockService`.

## 4. Data model (one sheet tab per table, row 1 = headers)

**Settings**: key / value

| key | default | meaning |
| :- | :- | :- |
| `cycle_days` | 7 | days between deliveries |
| `lead_days` | 1 | count day → delivery day (Tue → Wed). **Pending confirmation with IPD** |
| `delay_days` | 0 | extra days for late delivery, added to the window. **Decision needed** (§5.3) |
| `history_days` | 90 | usage history used to compute par |
| `percentile` | 0.90 | par covers this share of past demand windows (normal drugs) |
| `critical_percentile` | 1.00 | same, for `critical` drugs (= worst window seen) |
| `min_use_freq` | 0.143 | drugs used on fewer than this share of days (≈ less than weekly) are not stocked by default |

Demand window `W = cycle_days + lead_days + 1 + delay_days` (= 9 by default: Tuesday count through next Wednesday's delivery, inclusive).

**Drugs**: one row per HOSxP drug, created automatically on import

| column | example | notes |
| :- | :- | :- |
| `drug_id` | D001 | stable key; never reuse. Replace with HOSxP `icode` if IT can include it (§9 Q6) |
| `hosxp_name` | `(NED)VIT B complex tab(-)` | exact `drug_name` from HOSxP |
| `strength` | `1+1+etc mg.` | part of the match key (e.g. NSS 100 ml vs 1000 ml) |
| `unit` | เม็ด | HOSxP `drug_unit`; counting and ordering use this unit |
| `request_name` | Vitamin B complex | optional, name to print for OPD; blank = `hosxp_name` |
| `stocked` | TRUE | FALSE = keep for matching, never count or order |
| `critical` | TRUE | HAD / emergency-box items |
| `min_par` | 10 | floor for par (e.g. emergency-box quantity) |
| `par_override` | | pharmacist's manual par; wins when set |
| `location` | ตู้เก็บยา | ตู้เก็บยา / ชั้นวางยา / ลิ้นชักยา |
| `shelf_order` | 120 | walking order for counting |
| `use_freq` | 0.95 | share of days used in history (written by recompute) |
| `par_calc` | 36 | written by recompute |
| `par_updated` | 2026-11-20 | written by recompute |

Match key on import: `hosxp_name + strength + unit`.

**UsageDaily**: `date`, `drug_id`, `qty`. Only nonzero rows are needed; missing days count as 0. Price columns are not imported.

**Rounds**: `round_id` (e.g. `2026-W47`), `count_date`, `status`, `counted_by`, `submitted_at`, `reviewed_by`, `approved_at`, `note`

**RoundLines**: frozen at approval
`round_id`, `drug_id`, `on_hand`, `par_used`, `suggested_qty`, `final_qty`, `change_reason`, `flags`

**Users**: `email`, `name`, `role` (`counter` / `pharmacist` / `admin`)

**Import**: scratch tab. The HOSxP export is pasted here, then cleared after a successful import.

Snapshotting `par_used` into each line keeps past rounds reproducible after par is recomputed, and gives the before/after numbers PRD §8 asks for.

## 5. Calculations (`Calc.js`)

```
W              = cycle_days + lead_days + 1 + delay_days          (default 9)
windows        = every W-day rolling sum of daily qty over the last history_days
par_calc       = ceil( percentile(windows, critical ? critical_percentile : percentile) )
par            = par_override  if set,  else max(par_calc, min_par)

suggested_qty  = max(0, par − on_hand)                             (units, no rounding)
output line    = "{request_name}  {final_qty} {unit}   IPD"
```

### 5.1 Why a percentile, not mean × days (evidence)

HOSxP IPD dispensing, 1 Aug – 31 Oct 2026: 92 days, 336 drug/strength/unit combinations, 330 with any use. Backtest: par computed from Aug–Sep, then checked against the 9-day demand from each Tuesday in October. "Short" = 9-day demand exceeded par, so IPD would have needed a top-up from OPD at least once that week.

| Par method | Drug-weeks short | Par stock value (approx.) |
| :- | -: | -: |
| mean × 10 (PRD formula, 7 + 3 buffer) | 20.1% | — |
| mean × 11 (+1 lead day) | 17.7% | 110k THB |
| mean × 13 | 14.2% | 130k THB |
| mean × 17 | 10.5% | 167k THB |
| **P90 of 9-day windows** | **8.9%** | **164k THB** |
| P95 of 9-day windows | 7.9% | 185k THB |

- The PRD's mean-based formula is too lean: about 1 drug-week in 5 would run short. Most IPD drugs are bursty (210 of 330 had a month more than 2× another month).
- At equal stock value, the percentile does somewhat better than a larger multiplier, and it's easier to explain to staff: "enough for 9 weeks out of 10, based on the last 3 months".
- Restricting to drugs used at least weekly (202 drugs), P90 gives 6.4% short.
- Caveats: only 3 out-of-sample weeks; 3 months can't show seasonality; "short" counts any shortfall, even 1 unit, so it overstates real trips. Use these numbers to compare methods, not as a forecast.

### 5.2 What to stock

| Use frequency (Aug–Oct) | Drugs | Default |
| :- | -: | :- |
| at least every 2nd day | 92 | stock |
| at least weekly | 108 | stock |
| at least monthly | 85 | not stocked unless pharmacist sets `stocked`/`min_par` |
| rarer | 45 | not stocked |
| never used | 6 | not stocked |

Rare drugs are where every method fails (10–13% short even at P95), because 3 months show only a handful of uses. They're better handled by the pharmacist's judgement (`min_par`) or fetched on demand. Default stock list ≈ 200 drugs + all `critical`.

The 11 HAD injectables named by IPD staff all appear in HOSxP with an `HAD` tag in the name (amiodarone, nicardipine, sodium bicarbonate, norepinephrine, KCl inj, adenosine, MgSO4 50%, 3% NaCl, dopamine, Ca gluconate, digoxin). The import step pre-sets `critical` for names containing `HAD`; the pharmacist confirms. Four oral warfarin strengths are also tagged HAD.

### 5.3 Delivery delay

Staff asked for 3–5 extra days in case of late delivery (Q5). The percentile covers *demand* variation, not a *late delivery*. Adding `delay_days = 3` widens the window to 12 days and raises stock roughly by a third. Decide with IPD whether late deliveries happen often enough to pay for that, or whether `delay_days` applies to `critical` drugs only.

### Flags (shown first in review)

| flag | condition |
| :- | :- |
| `NOT_COUNTED` | stocked drug left blank (blank ≠ 0) |
| `CRITICAL_LOW` | critical drug and on_hand < par |
| `BIG_ORDER` | suggested_qty > 2 × usual weekly use (on_hand much lower than expected: miscount, or usage jumped) |
| `NO_USAGE_DATA` | par came only from `min_par`/override, or par is 0 |
| `EDITED` | pharmacist changed `final_qty` |

## 6. Workflows

### Quarterly (admin, Sheet UI)
1. Export the HOSxP daily IPD dispensing report (same columns as now: `order_date, drug_name, strength, drug_unit, total_quantity, unit_price, total_price`) and paste it into **Import**.
2. Menu **IPD › นำเข้าข้อมูลการใช้ยา**: parse `order_date` (d/m/yyyy, C.E.), match or create **Drugs** rows, append **UsageDaily** (replacing any overlapping dates), clear **Import**. New drugs arrive as `stocked = FALSE` with `use_freq` filled in.
3. Menu **IPD › คำนวณยอดที่ควรมีใหม่**: writes `use_freq`, `par_calc`, `par_updated`. On first run, drugs with `use_freq ≥ min_use_freq` are suggested as `stocked`.
4. Pharmacist reviews `stocked`, `critical`, `min_par` and `location` in **Drugs**. Placeholder rows such as `YA....` (unit `.`) stay unstocked.

### Weekly round (web app)
1. **Count** (technician, phone). Opens the current round, created automatically for the week. Drugs are grouped by location in `shelf_order`, with name, strength, unit and a critical badge, and one number input in HOSxP units. Each row autosaves, so a half-finished count survives interruptions. A progress bar shows "counted 87/210". **ส่งให้เภสัชตรวจ** sets status `REVIEW`.
2. **Review** (pharmacist). Flagged lines first, rest collapsed. `final_qty` is editable and requires a short reason when changed. **อนุมัติ** freezes the round (`APPROVED`).
3. **Output**. A list of lines with `final_qty > 0`: ลำดับ / รายการ / จำนวน / หน่วย / หมายเหตุ = IPD. Two forms: a printable A4 page, and **คัดลอก** (tab-separated) for pasting into OPD's requisition if it is electronic.

Status flow: `COUNTING → REVIEW → APPROVED`. The pharmacist can send a round back to `COUNTING`. Approved rounds are read-only.

## 7. Access and privacy

- **Recommended:** web app deployed as *Execute as: user accessing*, and the Sheet shared (editor) with the 2–4 people in **Users**. This gives real identities for `counted_by` / `reviewed_by`. It needs every user to have a Google account (§9 Q1).
- Fallback if staff have no Google accounts: *Execute as: me*, with each user picking their name from a list. This is weaker: anyone holding the URL could submit.
- The HOSxP export has no patient columns. If a future export adds HN/AN or names, the importer ignores every column except the seven above.
- Git holds code and docs only. `.clasp.json` (script ID) is gitignored. No usage data is committed.

## 8. Repository layout

```
src/                 Apps Script project root (clasp rootDir)
  appsscript.json
  Code.js  Calc.js  Db.js  Import.js  Rounds.js
  ui/ Count.html  Review.html  Output.html  Styles.html
test/calc.test.js    node --test, covers Calc.js only
docs/                PRD, DESIGN
```

Plain JavaScript (V8 runtime), no build step, so anyone can open the script in the Apps Script editor and read it.

## 9. Open questions

Resolved: OPD will add IPD lines to its own requisition, in units (PRD Q2; former Q4 partial packs and Q5 form format).

1. **Accounts and devices.** Do the technician and pharmacist have Google accounts, and will they count on a phone? (Decides §7.)
2. **Lead time.** Which day and time is the count actually done, relative to Wednesday's delivery? (Sets `lead_days`; Thai discussion note sent to IPD.)
3. **Delivery delay.** Is `delay_days` needed for all drugs, critical only, or none? (§5.3)
4. **Scope of the HOSxP report.** The Oct report in the PRD had 135 items; this export has 290 drugs in October alone, with large one-day quantities of chronic oral drugs (e.g. 92 tablets in one day). Does it include **discharge/home medications**? If those are dispensed from OPD rather than IPD stock, they should be excluded, and the stock list shrinks.
5. **Multiple locations.** Is any drug kept in more than one place? If yes, counting needs one row per drug-location.
6. **Drug code.** Can IT add HOSxP `icode` to the export? Names change and have typos; a code is a safer key.
7. **Liquid units.** A few drugs are dispensed per ml (e.g. KCl syrup, `1 ml.`). Does IPD count and request these in ml, or in bottles? If bottles, those drugs need a per-drug conversion factor.
