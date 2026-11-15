# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **draft v0.3**, 15 Nov 2026. Based on [PRD.md](PRD.md), IPD staff answers to PRD section 7, OPD's reply on the requisition format, and an analysis of 3 months of HOSxP dispensing data (§5.1).

Changes from v0.1: no pack boxes (OPD accepts plain units); IPD lines are added to OPD's own requisition; usage is stored daily.
Changes from v0.2: par uses the standard periodic-review safety-stock formula (it beat the percentile method at equal stock); liquids dispensed per ml are counted and requested in whole bottles; expensive, infrequent drugs get their own tier; home medications (HM) confirmed to come from IPD stock, so they stay in the usage data.

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
| OPD accepts quantities in units and will add IPD lines to its own requisition (OPD, 15 Nov) | No box rounding; output is a plain list in units (whole bottles for liquids dispensed per ml) |
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
| `z` | 1.65 | safety factor, normal drugs (nominal 95%; ~93% achieved on real data) |
| `critical_z` | 2.33 | safety factor, `critical` drugs (nominal 99%) |
| `min_use_freq` | 0.143 | drugs used on fewer than this share of days (≈ less than weekly) are not stocked by default |

Demand window `W = cycle_days + lead_days + 1 + delay_days` (= 9 by default: Tuesday count through next Wednesday's delivery, inclusive).

**Drugs**: one row per HOSxP drug, created automatically on import

| column | example | notes |
| :- | :- | :- |
| `drug_id` | D001 | stable key; never reuse. Replace with HOSxP `icode` if IT can include it (§9 Q6) |
| `hosxp_name` | `(NED)VIT B complex tab(-)` | exact `drug_name` from HOSxP |
| `strength` | `1+1+etc mg.` | part of the match key (e.g. NSS 100 ml vs 1000 ml) |
| `unit` | เม็ด | HOSxP `drug_unit`; usage and par are in this unit |
| `request_unit` | ขวด | optional, unit to count and request in when it differs from `unit`; blank = `unit` |
| `request_factor` | 240 | `unit`s per `request_unit` (KCl syrup: 240 ml per bottle); blank = 1 |
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

This is a **periodic-review, order-up-to policy** (also called *(R, S)* or *par-level replenishment*): count at a fixed interval, order the difference up to a target level. It is the standard policy when stock is **not tracked in real time**, which is IPD's situation: the only stock figure is the weekly count. Reorder-point policies ("order when stock falls to X") need a live stock figure and don't fit.

```
W              = cycle_days + lead_days + 1 + delay_days          (default 9 days: Tue count → next Wed delivery)
d̄, σ           = mean and standard deviation of daily qty over the last history_days (missing days = 0)
par_calc       = ceil( d̄·W + z·σ·√W )                             z = critical ? critical_z : z
par            = par_override  if set,  else max(par_calc, min_par)
                 critical drugs also: par ≥ largest W-day demand seen in history

on_hand        = counted_request_units × request_factor            (decimals allowed: half a bottle = 0.5)
suggested_qty  = ceil( max(0, par − on_hand) / request_factor )    in request units
output line    = "{request_name}  {final_qty} {request_unit}   IPD"
```

`d̄·W` is the expected use until the next delivery; `z·σ·√W` is the safety stock. The safety stock grows with how irregular the drug's use is, not with a fixed number of buffer days.

### 5.1 Evidence

HOSxP IPD dispensing, 1 Aug – 31 Oct 2026: 92 days, 336 drug/strength/unit combinations, 330 with any use, including home medications (HM) dispensed from IPD stock. Backtest: par computed from Aug–Sep, then checked against October demand. "Short" = demand from count to next delivery exceeded par, so IPD would have needed a top-up from OPD.

**Formula** (201 drugs used at least weekly; every October day tried as a count day):

| Par method (weekly cycle) | Drug-cycles short | Peak stock | Avg on-hand |
| :- | -: | -: | -: |
| mean × 11 (PRD formula + 1 lead day) | ~18% | 102k THB | — |
| empirical P90 of 9-day demand (v0.2) | 7.0% | 148k THB | 107k THB |
| textbook, z = 1.28 (nominal 90%) | 9.3% | 125k THB | 84k THB |
| **textbook, z = 1.65 (nominal 95%)** | **7.0%** | **136k THB** | **95k THB** |
| empirical P95 | 5.6% | 165k THB | 124k THB |

The textbook formula matches the percentile method's shortfall rate with ~8% less stock, needs only a mean and SD, and is what other hospitals' and companies' inventory systems use, so it's easier to defend. It achieves a bit less than its nominal 95% because HM dispensing makes demand lumpier than the formula assumes.

**Review period** (empirical P90 for both):

| Cycle | Drug-cycles short | Shortfalls/month | Avg on-hand | Counts/month |
| :- | -: | -: | -: | -: |
| **weekly** | 7.0% | ~60 | 107k THB | 4.3 |
| every 2 weeks | 10.0% | ~43 | 149k THB | 2.1 |

Ordering every 2 weeks halves the counting work but needs ~40% more stock on the shelf. At the same stock, weekly ordering with a higher safety factor has fewer shortfalls. Weekly also matches OPD's own warehouse cycle, so it is the design default (`cycle_days = 7`).

Caveats: one month of out-of-sample data; 3 months can't show seasonality; "short" counts any shortfall, even 1 unit, so it overstates real trips. Use these numbers to compare options, not as a forecast.

### 5.2 What to stock

| Use frequency (Aug–Oct) | Drugs | Default |
| :- | -: | :- |
| at least every 2nd day | 92 | stock |
| at least weekly | 108 | stock |
| at least monthly | 85 | not stocked unless pharmacist sets `stocked`/`min_par` |
| rarer | 45 | not stocked |
| never used | 6 | not stocked |

Rare drugs are where every method fails (10–13% short even at P95), because 3 months show only a handful of uses. They're better handled by the pharmacist's judgement (`min_par`) or fetched on demand. Default stock list ≈ 200 drugs + all `critical`.

**Expensive and infrequent drugs** (≥ 5k THB per quarter, used on fewer than half of days): about 20 drugs, e.g. remdesivir, ertapenem, tiotropium and umeclidinium/vilanterol inhalers, enoxaparin. A formula par would keep several expensive units idle on the shelf. Default for these: not formula-stocked; the pharmacist sets `min_par` (often 0–2) or treats them as patient-specific. The recompute step lists them for review. This is the ABC-VEN idea: service level depends on how vital a drug is (VEN) and how much stock costs (ABC), not one rule for all.

The 11 HAD injectables named by IPD staff all appear in HOSxP with an `HAD` tag in the name (amiodarone, nicardipine, sodium bicarbonate, norepinephrine, KCl inj, adenosine, MgSO4 50%, 3% NaCl, dopamine, Ca gluconate, digoxin). The import step pre-sets `critical` for names containing `HAD`; the pharmacist confirms. Four oral warfarin strengths are also tagged HAD.

### 5.3 Delivery delay

Staff asked for 3–5 extra days in case of late delivery (Q5). The safety stock covers *demand* variation, not a *late delivery*. Adding `delay_days = 3` widens the window to 12 days and raises stock roughly by a third. Decide with IPD whether late deliveries happen often enough to pay for that, or whether `delay_days` applies to `critical` drugs only.

### 5.4 First rounds and later improvements

- **No starting stock figure is needed.** The first count is the baseline. If on-hand is above par, the order is 0 and stock drifts down to par over the following weeks.
- **Phase 2: estimated stock between counts.** HOSxP already records every dispense. With a more frequent import (e.g. daily), the tool can estimate `last count + received − dispensed since count` and warn mid-week when a critical drug is likely low. Comparing that estimate with the next physical count also shows counting or recording errors. Not in round 1.
- **Physical backup for critical drugs: two-bin.** Split each HAD drug into two bins. When the front bin is empty, a card goes into the request tray. This works with no IT at all and catches a run on a critical drug before the weekly count.

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
1. **Count** (technician, phone). Opens the current round, created automatically for the week. Drugs are grouped by location in `shelf_order`, with name, strength, unit and a critical badge, and one number input in the drug's request unit (tablets, ampoules, or bottles for per-ml liquids; decimals allowed for an opened bottle). Each row autosaves, so a half-finished count survives interruptions. A progress bar shows "counted 87/210". **ส่งให้เภสัชตรวจ** sets status `REVIEW`.
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

Resolved:
- OPD will add IPD lines to its own requisition, in units (PRD Q2).
- The HOSxP report includes home medications (HM), and HM is dispensed from IPD stock, so HM stays in the usage data.
- Liquids dispensed per ml are requested as whole bottles (KCl elixir: 240 ml per bottle) → `request_unit` / `request_factor`.
- Ordering cycle: weekly, matching OPD's warehouse cycle (§5.1).

Open:
1. **Accounts and devices.** Do the technician and pharmacist have Google accounts, and will they count on a phone? (Decides §7.)
2. **Lead time.** Which day and time is the count actually done, relative to Wednesday's delivery? (Sets `lead_days`.)
3. **Delivery delay.** How often does stock arrive later than Wednesday? Is `delay_days` needed for all drugs, critical only, or none? (§5.3; being confirmed with IPD staff.)
4. **Bottle sizes.** Per-ml drugs in HOSxP: KCl syrup (240 ml, confirmed), Berodual solution, Salbutamol solution, lidocaine 2% inj, adrenaline 1 mg/ml (1 ml = 1 ampoule), and a generic `Syrup (คิดเป็น ml)` row. Need the bottle/vial size of each.
5. **Multiple locations.** Is any drug kept in more than one place? If yes, counting needs one row per drug-location.
6. **Drug code.** Can IT add HOSxP `icode` to the export? Names change and have typos; a code is a safer key.
7. **Expensive, infrequent drugs.** Pharmacist to confirm `min_par` for the ~20 drugs listed by the recompute step (§5.2).
