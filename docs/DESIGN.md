# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **draft v0.4**, 16 Nov 2026. Based on [PRD.md](PRD.md), IPD staff answers to PRD section 7, OPD's reply on the requisition format, IPD's main-storage requisition form, and an analysis of 3 months of HOSxP dispensing data (§5.1).

Changes from v0.1: no pack boxes (OPD accepts plain units); IPD lines are added to OPD's own requisition; usage is stored daily.
Changes from v0.2: par uses the standard periodic-review safety-stock formula (it beat the percentile method at equal stock); liquids dispensed per ml are counted and requested in whole bottles; expensive, infrequent drugs get their own tier; home medications (HM) confirmed to come from IPD stock, so they stay in the usage data.
Changes from v0.3 (issues #1–#4): IPD requests from **main storage (คลัง) every 2 weeks** on its own form ใบเบิกหรือใบส่งคืน, no longer through OPD's weekly requisition; drugs that never used **80% of a pack in a cycle** are fetched from OPD instead, as a separate, optional request; quantities stay in units.

## 1. What round 1 must do

From PRD section 2, nothing more:

1. Compute a **par level** (ยอดที่ควรมี) per drug from real usage.
2. At each count (every 2 weeks), take on-hand quantities and compute **how much to order**.
3. Produce a **main-storage requisition** laid out like the paper form ใบเบิกหรือใบส่งคืน: drug name, unit, on-hand, quantity in dispensing units (e.g. `Vitamin B complex 1500 เม็ด`) (§6).
4. Produce a separate, optional **OPD list** for drugs that never used 80% of a pack in a cycle (§5.2).

Out of scope for round 1: automatic stock deduction, live HIS integration, expiry tracking, receiving/check-in records.

## 2. Constraints that shape the design

| Fact (source) | Design consequence |
| :- | :- |
| One pharmacy technician counts and orders, 30–60 min, timing unpredictable (Q7) | Counting must be fast, resumable, and work at the shelf → mobile web page with autosave. Keep the stock list short (§5.2) |
| IPD has no usable computer/printer; prints at the warehouse or OPD (Q10) | Everything runs in a browser; output works from any PC |
| Pharmacist reviews but often can't check every line (Q8) | Review screen shows **exceptions first** |
| IPD requests from main storage every 2 weeks, independent of OPD's weekly cycle (16 Nov) | Demand window = count day through next delivery = 16 days (§5). Count and delivery days still to confirm |
| 11 HAD injectables must never run out (Q4) | Per-drug `critical` flag → par from the worst observed window + minimum par |
| Main storage's form has a unit column (หน่วยนับ); IPD will request in units first, packs only if staff ask (16 Nov) | No box rounding; output in units (whole bottles for liquids dispensed per ml) |
| Low-use drugs are fetched from OPD, not requested from main storage (16 Nov) | Pack size per drug; 1-pack rule decides main storage vs OPD (§5.2) |
| HOSxP export is daily, one row per drug per day, no patient columns | Store daily usage in the Sheet; the daily SD and the worst W-day window need daily data |
| Repo is public | No spreadsheet IDs, script IDs or hospital data in git |

## 3. Architecture

```
┌──────────────── Google Sheet "IPD Stock" (database, private) ────────────────┐
│ Settings │ Drugs │ UsageDaily │ Rounds │ RoundLines │ Users │ Import         │
└────────────────────────────────▲─────────────────────────────────────────────┘
                                 │ SpreadsheetApp (bound script)
┌────────────────────────────────┴─────────────────────────────────────────────┐
│ Apps Script project (this repo, deployed with clasp)                         │
│  Calc.js   pure functions: mean/SD, worst window, par, order (Node-tested)
│  Db.js     read/write sheets as arrays of objects, LockService               │
│  Import.js HOSxP CSV → UsageDaily, new drugs → Drugs, recompute par         │
│  Rounds.js round lifecycle                                                   │
│  Code.js   onOpen menu (admin) + doGet web app routing                       │
└────────────┬───────────────────────────┬─────────────────────────────────────┘
     Sheet menu (admin)           Web app (HtmlService)
     - import usage               - /count   technician, phone
     - recompute par              - /review  pharmacist
     - edit drug list             - /print   main-storage form + OPD list
```

- **Container-bound script** on the existing private "IPD Stock" spreadsheet (which already holds the HOSxP export): simplest permissions, custom menu for free, no IDs in code.
- **Web app** for the jobs done every round (count, review, output). Admin jobs (import, drug list) stay in the Sheet UI; they're done quarterly by someone comfortable with spreadsheets.
- **`Calc.js` has no Apps Script calls**, so it runs unchanged in Node for tests. It ends with
  `if (typeof module !== 'undefined') module.exports = {...}`.
- Scale: ~340 drugs; ~12k usage rows per quarter (~47k/year); 52 rounds/year. Well within Sheets limits. Writes go through `LockService`.

## 4. Data model (one sheet tab per table, row 1 = headers)

**Settings**: key / value

| key | default | meaning |
| :- | :- | :- |
| `cycle_days` | 14 | days between main-storage requisitions (every 2 weeks) |
| `lead_days` | 1 | count day → delivery day. **Pending confirmation with IPD** |
| `delay_days` | 0 | extra days for late delivery, added to the window. **Decision needed** (§5.3) |
| `history_days` | 90 | usage history used to compute par |
| `z` | 1.65 | safety factor, normal drugs (nominal 95%; ~93% achieved on real data) |
| `critical_z` | 2.33 | safety factor, `critical` drugs (nominal 99%) |
| `main_pack_share` | 0.8 | busiest cycle uses at least this share of a pack → main storage, else OPD (§5.2) |
| `min_use_freq` | 0.143 | fallback while `pack_size` is blank: drugs used on fewer than this share of days (≈ less than weekly) are not stocked |
| `expensive_value` | 5000 | THB of usage over the history window that, together with … |
| `expensive_max_freq` | 0.5 | … use on fewer than this share of days, puts a drug in the pharmacist-set tier (§5.2) |

Demand window `W = cycle_days + lead_days + 1 + delay_days` (= 16 by default: count day through the delivery after next, inclusive).

**Drugs**: one row per HOSxP drug, created automatically on import

| column | example | notes |
| :- | :- | :- |
| `drug_id` | D001 | stable key; never reuse. Replace with HOSxP `icode` if IT can include it (§9 Q6) |
| `hosxp_name` | `(NED)VIT B complex tab(-)` | exact `drug_name` from HOSxP |
| `strength` | `1+1+etc mg.` | part of the match key (e.g. NSS 100 ml vs 1000 ml) |
| `unit` | เม็ด | HOSxP `drug_unit`; usage and par are in this unit |
| `request_unit` | ขวด | optional, unit to count and request in when it differs from `unit`; blank = `unit` |
| `request_factor` | 240 | `unit`s per `request_unit` (KCl syrup: 240 ml per bottle); blank = 1 |
| `request_name` | Vitamin B complex | optional, name to print on the requisition; blank = `hosxp_name` |
| `pack_size` | 100 | `unit`s per pack as main storage issues it (box of 100). Used only for the 1-pack rule (§5.2); quantities are not rounded to packs |
| `source` | MAIN | `MAIN` (main storage, counted, par-based) / `OPD` (fetched from OPD, optional). Suggested by recompute, pharmacist can override |
| `item_code` | | main storage's item code (หมายเลขพัสดุ) if one exists (§9) |
| `unit_price` | 0.5 | latest HOSxP `unit_price`; used only to find expensive drugs |
| `stocked` | TRUE | counted and ordered from main storage. FALSE = OPD drug, or kept for matching only |
| `critical` | TRUE | HAD / emergency-box items |
| `min_par` | 10 | floor for par (e.g. emergency-box quantity) |
| `par_override` | | pharmacist's manual par; wins when set |
| `location` | ตู้เก็บยา | ตู้เก็บยา / ชั้นวางยา / ลิ้นชักยา |
| `shelf_order` | 120 | walking order for counting |
| `use_freq` | 0.95 | share of days used in history (written by recompute) |
| `source_calc` | OPD | 1-pack rule result, `UNKNOWN` while `pack_size` is blank (written by recompute) |
| `par_calc` | 36 | written by recompute |
| `par_updated` | 2026-11-20 | written by recompute |

Match key on import: `hosxp_name + strength + unit`.

**UsageDaily**: `date`, `drug_id`, `qty`. Only nonzero rows are needed; missing days count as 0. Price columns are not imported.

**Rounds**: `round_id` (the count date, e.g. `2026-11-17`; ISO week numbers no longer fit a 2-week cycle), `count_date`, `status`, `counted_by`, `submitted_at`, `reviewed_by`, `approved_at`, `note`

**RoundLines**: frozen at approval
`round_id`, `drug_id`, `on_hand`, `par_used`, `suggested_qty`, `final_qty`, `change_reason`, `flags`

**Users**: `email`, `name`, `role` (`counter` / `pharmacist` / `admin`)

**Import**: scratch tab. The HOSxP export is pasted here, then cleared after a successful import.

Snapshotting `par_used` into each line keeps past rounds reproducible after par is recomputed, and gives the before/after numbers PRD §8 asks for.

## 5. Calculations (`Calc.js`)

This is a **periodic-review, order-up-to policy** (also called *(R, S)* or *par-level replenishment*): count at a fixed interval, order the difference up to a target level. It is the standard policy when stock is **not tracked in real time**, which is IPD's situation: the only stock figure is the count every 2 weeks. Reorder-point policies ("order when stock falls to X") need a live stock figure and don't fit.

```
W              = cycle_days + lead_days + 1 + delay_days          (default 16 days: count → the delivery after next)
d̄, σ           = mean and standard deviation of daily qty over the last history_days (missing days = 0)
par_calc       = ceil( d̄·W + z·σ·√W )                             z = critical ? critical_z : z
par            = par_override  if set,  else max(par_calc, min_par)
                 critical drugs also: par ≥ largest W-day demand seen in history

on_hand        = counted_request_units × request_factor            (decimals allowed: half a bottle = 0.5)
suggested_qty  = ceil( max(0, par − on_hand) / request_factor )    in request units
main form line = ลำดับ | item_code | request_name | request_unit | on_hand | final_qty
OPD suggestion = ceil( d̄·cycle_days / request_factor ), at least 1 if used      (staff choose whether to request)
```

`d̄·W` is the expected use until the next delivery; `z·σ·√W` is the safety stock. The safety stock grows with how irregular the drug's use is, not with a fixed number of buffer days.

### 5.1 Evidence

HOSxP IPD dispensing, 1 Aug – 31 Oct 2026: 92 days, 336 drug/strength/unit combinations, 330 with any use, including home medications (HM) dispensed from IPD stock. Backtest: par computed from Aug–Sep, then checked against October demand. "Short" = demand from count to next delivery exceeded par, so IPD would have needed a top-up from OPD.

**Formula**, v0.3 analysis (201 drugs used at least weekly; every October day tried as a count day):

| Par method (weekly cycle) | Drug-cycles short | Peak stock | Avg on-hand |
| :- | -: | -: | -: |
| mean × 11 (PRD formula + 1 lead day) | ~18% | 102k THB | — |
| empirical P90 of 9-day demand (v0.2) | 7.0% | 148k THB | 107k THB |
| textbook, z = 1.28 (nominal 90%) | 9.3% | 125k THB | 84k THB |
| **textbook, z = 1.65 (nominal 95%)** | **7.0%** | **136k THB** | **95k THB** |
| empirical P95 | 5.6% | 165k THB | 124k THB |

The textbook formula matches the percentile method's shortfall rate with ~8% less stock, needs only a mean and SD, and is what other hospitals' and companies' inventory systems use, so it's easier to defend. It achieves a bit less than its nominal 95% because HM dispensing makes demand lumpier than the formula assumes.

**Review period**, v0.3 analysis (empirical P90 for both):

| Cycle | Drug-cycles short | Shortfalls/month | Avg on-hand | Counts/month |
| :- | -: | -: | -: | -: |
| **weekly** | 7.0% | ~60 | 107k THB | 4.3 |
| every 2 weeks | 10.0% | ~43 | 149k THB | 2.1 |

Ordering every 2 weeks halves the counting work but needs ~40% more stock on the shelf. At the same stock, weekly ordering with a higher safety factor has fewer shortfalls. v0.3 chose weekly for that reason.

**v0.4: every 2 weeks.** IPD now requests from main storage every other week, on its own form, so `cycle_days = 14`. Textbook formula, z = 1.65, same train/test split as §5.3, deliveries on time:

| Cycle | W | Drug-cycles short | Shortfalls/month | Peak stock | Avg on-hand |
| :- | -: | -: | -: | -: | -: |
| weekly | 9 | 7.2% | ~60 | 107k THB | 74k THB |
| **every 2 weeks** | 16 | 9.4% | ~40 | 172k THB | 113k THB |
| every 2 weeks, z = 1.28 | 16 | 11.6% | ~49 | 162k THB | 103k THB |

Each cycle is a little more likely to run short (the window is longer, so one bad stretch matters more), but there are half as many cycles, so shortfalls per month drop. The cost is ~50–60% more stock on the shelf. Drugs that come from OPD leave the formula (§5.2), which will lower these figures once pack sizes are filled in.

Caveats: one month of out-of-sample data; 3 months can't show seasonality; "short" counts any shortfall, even 1 unit, so it overstates real trips. Use these numbers to compare options, not as a forecast.

### 5.2 What to stock: main storage or OPD

**1-pack rule (v0.4).** A drug is requested from main storage when its **busiest cycle** in the history window used **at least 80% of a pack** (owner's decision, 16 Nov: a drug that went through 91 of a box of 100 in its busiest 2 weeks should be requested as a box from main storage):

```
cycleMax       = largest use over any cycle_days-long stretch of the history (Calc.drugStats)
cycleMax ≥ main_pack_share · pack_size  →  source = MAIN  (counted, par-based, on the main-storage form)
otherwise                               →  source = OPD   (fetched from OPD when staff choose; suggestion = one cycle of average use)
pack_size blank                         →  source = UNKNOWN, falls back to the use-frequency table below
```

`main_pack_share` = 0.8 (Settings). `critical` (HAD) drugs are always `MAIN`. Expensive, infrequent drugs keep their own tier whatever the rule says. `npm run pack-rule` applies the rule to a HOSxP export and writes a per-drug report to `data/raw/` (never committed).

Why the busiest cycle rather than the average: the average hides drugs whose use comes in bursts, and those are the ones IPD runs short of and has to fetch from OPD. The cost is that a single large burst in 3 months is enough to make a drug `MAIN`; the pharmacist can override `source`.

Notes from the first run (Aug–Oct data, 26 pack sizes taken from main storage's issue slip and the requisition form; 16 MAIN, 9 OPD, critical drugs excluded):
- Drugs issued one at a time (pack size 1: creams, eye drops, insulin vials, irrigation bottles) become `MAIN` as soon as one is used in a cycle.
- Some high-use drugs in packs of 1000 still come out `OPD` (hundreds of tablets in the busiest cycle, under 800). Confirm with IPD that OPD is happy to supply those volumes.

**Use frequency** (fallback while `pack_size` is blank):

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

Staff asked for 3–5 extra days in case of late delivery (Q5). The safety stock covers *demand* variation, not a *late delivery*. Backtest with `src/Calc.js` (`npm run backtest`, train Aug–Sep, test Oct, 197 stocked drugs, deliveries on time):

| `delay_days` | Weekly: short | Peak stock | Avg on-hand | Every 2 weeks: short | Peak stock | Avg on-hand |
| -: | -: | -: | -: | -: | -: | -: |
| 0 | 7.2% | 107k THB | 74k THB | 9.4% | 172k THB | 113k THB |
| 3 | 4.6% | 135k THB | 102k THB | 6.6% | 199k THB | 140k THB |
| 5 | 3.5% | 154k THB | 121k THB | 4.7% | 216k THB | 157k THB |

Extra days also cut shortfalls when deliveries are on time, because they add stock. Each day costs roughly 9–10k THB of extra stock on either cycle. Decide with IPD whether late deliveries happen often enough to pay for that, or whether `delay_days` applies to `critical` drugs only.

These figures are lower than §5.1 because the ~11 expensive, infrequent drugs (§5.2) are left out of the formula.

### 5.4 First rounds and later improvements

- **No starting stock figure is needed.** The first count is the baseline. If on-hand is above par, the order is 0 and stock drifts down to par over the following weeks.
- **Phase 2: estimated stock between counts.** HOSxP already records every dispense. With a more frequent import (e.g. daily), the tool can estimate `last count + received − dispensed since count` and warn mid-week when a critical drug is likely low. Comparing that estimate with the next physical count also shows counting or recording errors. Not in round 1.
- **Physical backup for critical drugs: two-bin.** Split each HAD drug into two bins. When the front bin is empty, a card goes into the request tray. This works with no IT at all and catches a run on a critical drug before the next count.

### Flags (shown first in review)

| flag | condition |
| :- | :- |
| `NOT_COUNTED` | stocked drug left blank (blank ≠ 0) |
| `CRITICAL_LOW` | critical drug and on_hand < par |
| `BIG_ORDER` | suggested_qty > 2 × usual use per cycle (on_hand much lower than expected: miscount, or usage jumped) |
| `NO_USAGE_DATA` | par came only from `min_par`/override, or par is 0 |
| `EDITED` | pharmacist changed `final_qty` |

## 6. Workflows

### Quarterly (admin, Sheet UI)
1. Export the HOSxP daily IPD dispensing report (same columns as now: `order_date, drug_name, strength, drug_unit, total_quantity, unit_price, total_price`) and paste it into **Import**.
2. Menu **IPD › นำเข้าข้อมูลการใช้ยา**: parse `order_date` (d/m/yyyy, C.E.), match or create **Drugs** rows, append **UsageDaily** (replacing any overlapping dates), clear **Import**. New drugs arrive as `stocked = FALSE` with `use_freq` filled in.
3. Menu **IPD › คำนวณยอดที่ควรมีใหม่**: writes `use_freq`, `source_calc`, `par_calc`, `par_updated`. Drugs with `source_calc = MAIN` are suggested as `stocked`; drugs with a blank `pack_size` are listed for the pharmacist to fill in.
4. Pharmacist reviews `pack_size`, `source`, `stocked`, `critical`, `min_par` and `location` in **Drugs**. Placeholder rows such as `YA....` (unit `.`) stay unstocked.

### Round every 2 weeks (web app)
1. **Count** (technician, phone). Opens the current round, created automatically for the cycle. Only `MAIN` drugs are counted. Drugs are grouped by location in `shelf_order`, with name, strength, unit and a critical badge, and one number input in the drug's request unit (tablets, ampoules, or bottles for per-ml liquids; decimals allowed for an opened bottle). Each row autosaves, so a half-finished count survives interruptions. A progress bar shows "counted 87/210". **ส่งให้เภสัชตรวจ** sets status `REVIEW`.
2. **Review** (pharmacist). Flagged lines first, rest collapsed. `final_qty` is editable and requires a short reason when changed. **อนุมัติ** freezes the round (`APPROVED`).
3. **Output: main-storage form.** Lines with `final_qty > 0` in the column order of ใบเบิกหรือใบส่งคืน: ลำดับ / หมายเลขพัสดุ / รายการ / หน่วยนับ / คงเหลือจากครั้งที่แล้ว (on-hand from the count) / จำนวนเบิกใหม่. จ่ายหรือรับคืน and the price columns are left for main storage. Printable A4 plus **คัดลอก** (tab-separated).
4. **Output: OPD list** (optional, any time). `OPD` drugs with the suggested quantity for one cycle; staff tick the lines they want and print or copy: ลำดับ / รายการ / จำนวน / หน่วย / หมายเหตุ = IPD.

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
tools/backtest.js    replays a HOSxP export through Calc.js (aggregates only)
tools/pack-rule.js   applies the 1-pack rule; per-drug report goes to data/raw/ only
docs/                PRD, DESIGN
```

Plain JavaScript (V8 runtime), no build step, so anyone can open the script in the Apps Script editor and read it.

## 9. Open questions

Resolved:
- OPD will add IPD lines to its own requisition, in units (PRD Q2).
- The HOSxP report includes home medications (HM), and HM is dispensed from IPD stock, so HM stays in the usage data.
- Liquids dispensed per ml are requested as whole bottles (KCl elixir: 240 ml per bottle) → `request_unit` / `request_factor`.
- Ordering cycle: every 2 weeks, from main storage on IPD's own form (v0.4, §5.1).
- Quantities in units on both lists; pack rounding only if IPD staff ask.

Open:
1. **Accounts and devices.** Do the technician and pharmacist have Google accounts, and will they count on a phone? (Decides §7.)
2. **Lead time.** Which day is the count done, and when does main storage deliver? (Sets `lead_days`.)
3. **Delivery delay.** How often does stock arrive later than Wednesday? Is `delay_days` needed for all drugs, critical only, or none? (§5.3; being confirmed with IPD staff.)
4. **Bottle sizes.** Per-ml drugs in HOSxP: KCl syrup (240 ml, confirmed), Berodual solution, Salbutamol solution, lidocaine 2% inj, adrenaline 1 mg/ml (1 ml = 1 ampoule), and a generic `Syrup (คิดเป็น ml)` row. Need the bottle/vial size of each.
5. **Multiple locations.** Is any drug kept in more than one place? If yes, counting needs one row per drug-location.
6. **Drug code.** Can IT add HOSxP `icode` to the export? Names change and have typos; a code is a safer key.
7. **Expensive, infrequent drugs.** Pharmacist to confirm `min_par` for the ~20 drugs listed by the recompute step (§5.2).
8. **Pack sizes.** 26 known so far (issue slip and requisition form). Where do the rest come from: main storage's item list? (#2)
9. **OPD list.** IPD's current list of drugs fetched from OPD, to check against the 1-pack rule (#3).
10. **1-pack rule details.** HAD always main storage? Is OPD happy to supply large volumes of drugs that come in packs of 1000? (#3, §5.2)
11. **หมายเลขพัสดุ.** Does main storage have an item code per drug? (#4)
12. **Page layout.** The paper form has ~19 lines per sheet: number the printout's pages to match, or print one continuous list? (#4)
