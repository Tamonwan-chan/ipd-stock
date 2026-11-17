# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **draft v0.4**, 16 Nov 2026. Based on [PRD.md](PRD.md), IPD staff answers to PRD section 7, OPD's reply on the requisition format, IPD's main-storage requisition form, and an analysis of 3 months of HOSxP dispensing data (§5.1).

Changes from v0.1: no pack boxes (OPD accepts plain units); IPD lines are added to OPD's own requisition; usage is stored daily.
Changes from v0.2: par uses the standard periodic-review safety-stock formula (it beat the percentile method at equal stock); liquids dispensed per ml are counted and requested in whole bottles; expensive, infrequent drugs get their own tier; home medications (HM) confirmed to come from IPD stock, so they stay in the usage data.
Changes from v0.3 (issues #1–#4): IPD requests from **main storage (คลัง) every 2 weeks** on its own form ใบเบิกหรือใบส่งคืน, no longer through OPD's weekly requisition; drugs used **less than weekly** are fetched from OPD instead, as a separate, optional request; quantities stay in units. A shelf min (ยอดต่ำสุด) warns when stock won't last until the delivery.
Dropped on 16 Nov: the 1-pack rule (main storage when the busiest cycle used ≥ 80% of a pack). Main storage's pack sizes change often and IPD requests in units, so pack sizes are not tracked.

## 1. What round 1 must do

From PRD section 2, nothing more:

1. Compute a **par level** (ยอดที่ควรมี) per drug from real usage.
2. At each count (every 2 weeks), take on-hand quantities and compute **how much to order**.
3. Produce a **main-storage requisition** laid out like the paper form ใบเบิกหรือใบส่งคืน: drug name, unit, on-hand, quantity in dispensing units (e.g. `Vitamin B complex 1500 เม็ด`) (§6).
4. Produce a separate, optional, monthly **OPD list** for drugs used less than weekly (§5.2).

Out of scope for round 1: automatic stock deduction, live HIS integration, expiry tracking, receiving/check-in records.

## 2. Constraints that shape the design

| Fact (source) | Design consequence |
| :- | :- |
| One pharmacy technician counts and orders, 30–60 min, timing unpredictable (Q7) | Counting must be fast, resumable, and work at the shelf → mobile web page with autosave. Keep the stock list short (§5.2) |
| IPD has no usable computer/printer; prints at the warehouse or OPD (Q10) | Everything runs in a browser; output works from any PC |
| Pharmacist reviews but often can't check every line (Q8) | Review screen shows **exceptions first** |
| IPD requests from main storage every 2 weeks, independent of OPD's weekly cycle (16 Nov) | Demand window = count day through next delivery = 16 days (§5). Count and delivery days still to confirm |
| 11 HAD injectables must never run out (Q4) | Per-drug `critical` flag → par from the worst observed window + minimum par |
| Main storage's form has a unit column (หน่วยนับ); IPD requests in units, and pack sizes change too often to track (16 Nov) | No box rounding and no pack sizes; output in units (whole bottles for liquids dispensed per ml) |
| Low-use drugs are fetched from OPD, not requested from main storage (16 Nov), once a month (17 Nov) | Use frequency decides main storage vs OPD; OPD suggestion = a month of use (§5.2) |
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
│  Schema.js tabs, columns and column types (plain data)                       │
│  Db.js     read/write sheets as arrays of objects, LockService (Node-tested) │
│  Import.js HOSxP rows → UsageDaily, new drugs → Drugs, recompute par        │
│  Api.js    web app server calls: state, import file, rounds, save lines      │
│  Code.js   onOpen menu (admin) + doGet web app                               │
│  ui/       App.html (page), Styles.html, Client.html (browser JS)            │
└────────────┬───────────────────────────┬─────────────────────────────────────┘
     Sheet menu (admin)           Web app (HtmlService), one page, five tabs
     - import usage (paste)       - 1 import: drag a HOSxP file (.xlsx/.xls/.csv)
     - recompute par              - 2 count: on-hand → suggested qty, autosave
     - create tabs                - 3 main-storage form: print / CSV / copy
                                  - 4 OPD list: tick, print / copy
```

- **Container-bound script** on the existing private "IPD Stock" spreadsheet (which already holds the HOSxP export): simplest permissions, custom menu for free, no IDs in code.
- **Web app** for the jobs done every round (count, review, output). Admin jobs (import, drug list) stay in the Sheet UI; they're done quarterly by someone comfortable with spreadsheets.
- **`Calc.js` has no Apps Script calls**, so it runs unchanged in Node for tests. It ends with
  `if (typeof module !== 'undefined') module.exports = {...}`.
- **`Db.js` takes the spreadsheet as an argument** (default: the bound one) and uses only a dozen SpreadsheetApp calls, so tests run it against an in-memory fake (`test/fake-spreadsheet.js`).
- Scale: ~340 drugs; ~12k usage rows per quarter (~47k/year); 26 rounds/year. Well within Sheets limits. Writes go through `LockService`.

## 4. Data model (one sheet tab per table, row 1 = headers)

Defined in `src/Schema.js`; **IPD › ตั้งค่าแท็บข้อมูล** (`setupSheets` → `Db.ensureSchema`) creates missing tabs, appends missing columns to row 1 (never reorders or deletes), and adds missing Settings keys with their defaults. Other tabs, such as the original HOSxP export, are left alone. Db reads columns by name, so the admin may reorder columns or add their own.

Each column has a type. Text columns get the plain-text format so Sheets doesn't turn values like `2026-11-17` (a `round_id`) or `00123` (an `item_code`) into a date or a number. Date columns hold real Sheet dates and are read as ISO `YYYY-MM-DD`; this needs the script and the spreadsheet both set to the Asia/Bangkok time zone. Checkbox columns read blank as FALSE.

**Settings**: key / value / note (Thai explanation for the admin)

| key | default | meaning |
| :- | :- | :- |
| `cycle_days` | 14 | days between main-storage requisitions (every 2 weeks) |
| `lead_days` | 1 | count day → delivery day: count Tuesday morning, delivery Wednesday afternoon (IPD, 17 Nov) |
| `delay_days` | 0 | extra days for late delivery, added to the window. **Decision needed** (§5.3) |
| `history_days` | 90 | usage history used to compute par |
| `z` | 1.65 | safety factor, normal drugs (nominal 95%; ~93% achieved on real data) |
| `critical_z` | 2.33 | safety factor, `critical` drugs (nominal 99%) |
| `min_use_freq` | 0.143 | drugs used on at least this share of days (1 in 7 ≈ weekly) → main storage, stocked; rarer → OPD (§5.2) |
| `opd_cycle_days` | 30 | days between OPD requests (once a month); sizes the OPD suggestion (§5.2) |
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
| `source` | MAIN | pharmacist's choice: `MAIN` (main storage, counted, par-based) / `OPD` (fetched from OPD, optional) / blank = follow `source_calc` |
| `item_code` | | main storage's item code (หมายเลขพัสดุ) if one exists (§9) |
| `unit_price` | 0.5 | latest HOSxP `unit_price`; used only to find expensive drugs |
| `stocked` | TRUE | counted and ordered from main storage. Written by recompute from `source`, the rule and `critical` (§6); change `source` rather than this column |
| `critical` | TRUE | HAD / emergency-box items. Ticked on import when the name has the `HAD` tag; the pharmacist may change it |
| `min_par` | 10 | floor for par (e.g. emergency-box quantity). Not the same as the shelf min below |
| `par_override` | | pharmacist's manual par; wins when set |
| `min_override` | | pharmacist's manual shelf min (ยอดต่ำสุด); wins when set, 0 turns the warning off |
| `location` | ตู้เก็บยา | ตู้เก็บยา / ชั้นวางยา / ลิ้นชักยา |
| `shelf_order` | 120 | walking order for counting |
| `use_freq` | 0.95 | share of days used in history (written by recompute) |
| `source_calc` | OPD | use-frequency rule result, `MAIN` or `OPD` (written by recompute) |
| `par_calc` | 36 | written by recompute |
| `min_calc` | 8 | shelf min, in `unit`s, written by recompute (§5) |
| `par_updated` | 2026-11-20 | written by recompute |

Match key on import: `hosxp_name + strength + unit`.

**UsageDaily**: `date`, `drug_id`, `qty`. Only nonzero rows are needed; missing days count as 0. Price columns are not imported. Importing a period replaces the rows dated within it (`Db.replaceUsage`), so a re-import never double counts.

**Rounds**: `round_id` (the count date, e.g. `2026-11-17`; ISO week numbers no longer fit a 2-week cycle), `count_date`, `status`, `counted_by`, `submitted_at`, `reviewed_by`, `approved_at`, `note`

**RoundLines**: one row per round and drug (key `round_id` + `drug_id`, written with `Db.upsert` as each count autosaves); frozen at approval
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
OPD suggestion = ceil( d̄·opd_cycle_days / request_factor ), at least 1 if used  (staff choose whether to request)

T              = lead_days + 1 + delay_days                        (default 2 days: count → this round's delivery)
min_calc       = ceil( d̄·T + z·σ·√T )                             critical drugs also: min ≥ largest T-day demand seen
min            = min_override  if set,  else min_calc;  never above par
BELOW_MIN      = counted on_hand < min
```

`d̄·W` is the expected use until the next delivery; `z·σ·√W` is the safety stock. The safety stock grows with how irregular the drug's use is, not with a fixed number of buffer days.

**Shelf min (ยอดต่ำสุด).** Par (max) is what each round tops up to. The min answers a different question: is there enough on the shelf to last until this round's delivery arrives? Below it, the drug will probably run out before main storage delivers, so staff fetch a top-up from OPD the same day. It uses the same formula as par with the shorter window `T`. The count page shows it next to max and flags lines under it; a printable list (tab 5) puts both numbers on the shelf, so anyone who notices a low bin between counts can check it without the app. On the Aug–Oct 2026 data the min is typically about a quarter of the max (median 0.23).

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

Each cycle is a little more likely to run short (the window is longer, so one bad stretch matters more), but there are half as many cycles, so shortfalls per month drop. The cost is ~50–60% more stock on the shelf. Drugs fetched from OPD are not in the formula (§5.2).

Caveats: one month of out-of-sample data; 3 months can't show seasonality; "short" counts any shortfall, even 1 unit, so it overstates real trips. Use these numbers to compare options, not as a forecast.

### 5.2 What to stock: main storage or OPD

**Use-frequency rule.** A drug is stocked and requested from main storage when it was used on at least `min_use_freq` of the days in the history window (default 1/7: about weekly). Rarer drugs are fetched from OPD: IPD requests them once a month (17 Nov 2026), suggested quantity = average use over `opd_cycle_days` (30).

```
use_freq ≥ min_use_freq   →  source = MAIN  (counted, par-based, on the main-storage form)
otherwise                 →  source = OPD   (optional OPD list)
```

Overrides, in order (`Calc.stockDecision`): `critical` (HAD) drugs are always `MAIN`; the pharmacist's `source` (`MAIN`/`OPD`) wins; a `min_par` or `par_override` makes a drug `MAIN` (the pharmacist wants it on the shelf); expensive, infrequent drugs are `OPD` until they get one of those.

The 1-pack rule it replaces (main storage when the busiest 2 weeks used ≥ 80% of a pack) was dropped on 16 Nov: main storage's pack sizes change often, and IPD requests in units anyway. With no pack sizes filled in, the frequency rule was already deciding every drug, so the stock list didn't change (191 drugs on the Aug–Oct data; 136 go to the OPD list).

| Use frequency (Aug–Oct) | Drugs | Default |
| :- | -: | :- |
| at least every 2nd day | 92 | stock |
| at least weekly | 108 | stock |
| at least monthly | 85 | OPD, unless the pharmacist sets `source` or `min_par` |
| rarer | 45 | OPD |
| never used | 6 | not listed |

Rare drugs are where every method fails (10–13% short even at P95), because 3 months show only a handful of uses. They're better handled by the pharmacist's judgement (`min_par`) or fetched on demand. Default stock list ≈ 200 drugs + all `critical`.

**Expensive and infrequent drugs** (≥ 5k THB per quarter, used on fewer than half of days): about 20 drugs, e.g. remdesivir, ertapenem, tiotropium and umeclidinium/vilanterol inhalers, enoxaparin. A formula par would keep several expensive units idle on the shelf. Default for these: not formula-stocked; the pharmacist sets `min_par` (often 0–2) or treats them as patient-specific. Until then they appear on the OPD list; the recompute step lists them for review. This is the ABC-VEN idea: service level depends on how vital a drug is (VEN) and how much stock costs (ABC), not one rule for all.

The 11 HAD injectables named by IPD staff all appear in HOSxP with an `HAD` tag in the name (amiodarone, nicardipine, sodium bicarbonate, norepinephrine, KCl inj, adenosine, MgSO4 50%, 3% NaCl, dopamine, Ca gluconate, digoxin). The import step pre-sets `critical` for names containing `HAD`; the pharmacist confirms. Four oral warfarin strengths are also tagged HAD.

### 5.3 Delivery delay

Staff asked for 3–5 extra days in case of late delivery (Q5). The safety stock covers *demand* variation, not a *late delivery*. Backtest with `src/Calc.js` (`npm run backtest`, train Aug–Sep, test Oct, 197 stocked drugs, deliveries on time):

| `delay_days` | Weekly: short | Peak stock | Avg on-hand | Every 2 weeks: short | Peak stock | Avg on-hand |
| -: | -: | -: | -: | -: | -: | -: |
| 0 | 7.2% | 107k THB | 74k THB | 9.4% | 172k THB | 113k THB |
| 3 | 4.6% | 135k THB | 102k THB | 6.6% | 199k THB | 140k THB |
| 5 | 3.5% | 154k THB | 121k THB | 4.7% | 216k THB | 157k THB |

IPD staff (17 Nov): the buffer applies to **every drug**, not only critical ones, so every shelf also covers refilling the emergency boxes used on each shift. The number of days (3, 4 or 5) is still to choose.

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
| `BELOW_MIN` | on_hand < min: fetch from OPD today, it won't last until the delivery |
| `CRITICAL_LOW` | critical drug and on_hand < par |
| `BIG_ORDER` | suggested_qty > 2 × usual use per cycle (on_hand much lower than expected: miscount, or usage jumped) |
| `NO_USAGE_DATA` | par came only from `min_par`/override, or par is 0 |
| `EDITED` | pharmacist changed `final_qty` |

## 6. Workflows

### Quarterly (admin, Sheet UI)
1. Export the HOSxP daily IPD dispensing report (same columns as now: `order_date, drug_name, strength, drug_unit, total_quantity, unit_price, total_price`) and paste it into **Import**.
2. Menu **IPD › นำเข้าข้อมูลการใช้ยา** (`Import.importUsage`):
   - Checks every row first: `order_date` as d/m/yyyy text (C.E. or B.E.) or a Sheet date, quantity a number, no date after today. Any error aborts the whole import with the row numbers, and nothing is written.
   - Rejects a column that Sheets converted only partly (some cells dates, others text with a day over 12): the sign of a month/day locale reading 5/11 as 11 May. The fix is to format column A as plain text and paste again.
   - Sums same-day rows, drops zero quantities, matches **Drugs** by `hosxp_name + strength + unit`, and creates new drugs with `critical` ticked when the name has the `HAD` tag. Updates `unit_price` to the latest price.
   - Replaces **UsageDaily** rows within the imported date range, clears **Import** (header kept), and runs step 3.
3. Menu **IPD › คำนวณยอดที่ควรมีใหม่** (`Import.recompute`): uses the last `history_days` of **UsageDaily** up to the latest usage date (not before the first one), and writes `use_freq`, `mean_daily`, `source_calc`, `stocked`, `par_calc`, `min_calc`, `par_updated`. The summary lists expensive drugs needing a `min_par` and drugs whose `source` differs from the rule.
4. Pharmacist reviews `source`, `critical`, `min_par`, `par_override`, `min_override` and `location` in **Drugs**, then reruns step 3. Placeholder rows such as `YA....` (unit `.`) stay unstocked.

**`stocked` is written by recompute** (`Calc.stockDecision`); the pharmacist steers it through `source`:
- `source` blank: the use-frequency rule decides (`source_calc`).
- `source` = `OPD` → not stocked; `MAIN` → stocked, whatever the rule says.
- `min_par` or `par_override` set → stocked.
- `critical` drugs are always stocked. Expensive, infrequent drugs are stocked only once they have a `min_par` or `par_override` (or `source = MAIN`).

### Web app (v1, 16 Nov 2026)

One page (`ui/App.html`) with five tabs:

1. **นำเข้าข้อมูลการใช้ยา**: drag a HOSxP export onto the drop box. The browser reads it with SheetJS (xlsx/xls/csv; CSV decoded as UTF-8, else Windows-874 Thai), finds the header row by column name, turns Excel date serials into d/m/yyyy, drops zero rows, shows a preview, and sends the rows to `Api.importFile` → `Import.importRows` (same checks and result as the Sheet menu).
2. **นับยาและคำนวณยอดเบิก**: one open round at a time (`round_id` = count date). Stocked drugs grouped by location, each showing max / min in request units; a line under min turns red with "ต่ำกว่า min — ขอจาก OPD วันนี้" and is counted in the header. Typing on-hand updates the suggested quantity at once, and edits are saved in batches every ~1 s (`Api.saveLines`, which recomputes `par_used`, `suggested_qty` and flags on the server). `เบิกจริง` overrides the suggestion and asks for a reason. **อนุมัติรอบนี้** (two clicks) freezes the round. Earlier rounds can be reopened read-only from a picker.
3. **ใบเบิก (คลัง)**: the paper form's layout, 19 lines per A4 page, lines with quantity > 0 in counting order. Header fields (เล่มที่, เลขที่, จาก, ถึง, วันที่) are typed above the preview. Print, CSV download (UTF-8 with BOM, opens in Excel), or copy as tab-separated text.
4. **ขอจาก OPD**: OPD-source drugs used in the history window, suggested quantity = average use over `opd_cycle_days` (a month); tick lines, print or copy. Ticks are remembered in the browser only.
5. **ป้ายสูงสุด/ต่ำสุด**: printable A4 list of every stocked drug by location with max and min in request units (rounded up), plus CSV. Reprint after each import, since both numbers change.

The round review step (status `REVIEW`) is folded into the same screen for now: the pharmacist edits `เบิกจริง` and approves.

Deployment: `clasp push`, then `clasp update-deployment <deploymentId>` to publish to the same URL (`clasp create-deployment` the first time). The manifest runs the app as the owner with access limited to the owner (`MYSELF`); widen `access` when staff start using it (§7).

### Round every 2 weeks (web app, original plan)
1. **Count** (technician, phone). Opens the current round, created automatically for the cycle. Only `MAIN` drugs are counted. Drugs are grouped by location in `shelf_order`, with name, strength, unit and a critical badge, and one number input in the drug's request unit (tablets, ampoules, or bottles for per-ml liquids; decimals allowed for an opened bottle). Each row autosaves, so a half-finished count survives interruptions. A progress bar shows "counted 87/210". **ส่งให้เภสัชตรวจ** sets status `REVIEW`.
2. **Review** (pharmacist). Flagged lines first, rest collapsed. `final_qty` is editable and requires a short reason when changed. **อนุมัติ** freezes the round (`APPROVED`).
3. **Output: main-storage form.** Lines with `final_qty > 0` in the column order of ใบเบิกหรือใบส่งคืน: ลำดับ / หมายเลขพัสดุ / รายการ / หน่วยนับ / คงเหลือจากครั้งที่แล้ว (on-hand from the count) / จำนวนเบิกใหม่. จ่ายหรือรับคืน and the price columns are left for main storage. Printable A4 plus **คัดลอก** (tab-separated).
4. **Output: OPD list** (monthly). `OPD` drugs with the suggested quantity for one OPD cycle (`opd_cycle_days`); staff tick the lines they want and print or copy: ลำดับ / รายการ / จำนวน / หน่วย / หมายเหตุ = IPD.

Status flow: `COUNTING → REVIEW → APPROVED`. The pharmacist can send a round back to `COUNTING`. Approved rounds are read-only.

## 7. Access and privacy

- **Recommended:** web app deployed as *Execute as: user accessing*, and the Sheet shared (editor) with the 2–4 people in **Users**. This gives real identities for `counted_by` / `reviewed_by`. It needs every user to have a Google account (§9 Q1).
- Fallback if staff have no Google accounts: *Execute as: me*, with each user picking their name from a list. This is weaker: anyone holding the URL could submit.
- The HOSxP export has no patient columns. If a future export adds HN/AN or names, the importer ignores every column except the seven above.
- Git holds code and docs only. `.clasp.json` (script ID) is gitignored. No usage data is committed.

## 8. Repository layout

```
src/                 Apps Script project root (clasp rootDir)
  appsscript.json          time zone Asia/Bangkok, V8
  Code.js  Calc.js  Schema.js  Db.js  Import.js  Api.js
  ui/ App.html  Styles.html  Client.html
test/                node --test: calc, db, import, api (+ fake-spreadsheet.js)
tools/backtest.js    replays a HOSxP export through Calc.js (aggregates only)
docs/                PRD, DESIGN
```

Plain JavaScript (V8 runtime), no build step, so anyone can open the script in the Apps Script editor and read it.

## 9. Open questions

Resolved:
- OPD will add IPD lines to its own requisition, in units (PRD Q2).
- The HOSxP report includes home medications (HM), and HM is dispensed from IPD stock, so HM stays in the usage data.
- Liquids dispensed per ml are requested as whole bottles (KCl elixir: 240 ml per bottle) → `request_unit` / `request_factor`.
- Ordering cycle: every 2 weeks, from main storage on IPD's own form (v0.4, §5.1).
- Quantities in units on both lists; no pack sizes (they change too often). Main storage vs OPD by use frequency (§5.2).
- Lead time: count on Tuesday morning, main storage delivers Wednesday afternoon → `lead_days = 1` (17 Nov).
- OPD requests: once a month → `opd_cycle_days = 30` (17 Nov).
- OPD list: IPD's current list (79 drugs) checked against Aug–Oct usage: 33 move to main storage, 4 rarely used HAD injections for the pharmacist to decide, 28 stay with OPD, 14 unused in the period (#3, 17 Nov).
- Targets for the trial month (PRD §8): trips to OPD at most 1–2 a week (aim 0–1); requisition work at most 20–30 minutes per round.

Open:
1. **Accounts and devices.** Do the technician and pharmacist have Google accounts, and will they count on a phone? (Decides §7.)
2. ~~Lead time~~ resolved above.
3. **Delivery delay.** Staff want the buffer on all drugs (17 Nov). Choose `delay_days`: 3, 4 or 5 (§5.3). Staff also wrote "weekly requisition" in that answer: confirm the main-storage cycle is still every 2 weeks.
4. **Bottle sizes.** Per-ml drugs in HOSxP: KCl syrup (240 ml, confirmed), Berodual solution, Salbutamol solution, lidocaine 2% inj, adrenaline 1 mg/ml (1 ml = 1 ampoule), and a generic `Syrup (คิดเป็น ml)` row. Need the bottle/vial size of each. Staff answers (17 Nov): `Syrup (คิดเป็น ml)` = 450 ml bottle. Lidocaine viscous "100 ml" and S.M.W "3.750 L" need checking: HOSxP already counts them per 15-ml and 120-ml bottle, so these may be main storage's issue sizes. Still missing: Berodual solution, Salbutamol solution, lidocaine 2% inj.
5. **Multiple locations.** Is any drug kept in more than one place? If yes, counting needs one row per drug-location.
6. **Drug code.** Can IT add HOSxP `icode` to the export? Names change and have typos; a code is a safer key.
7. **Expensive, infrequent drugs.** IPD pharmacist (17 Nov): keep about 5 days of use at the maximum dose per drug. Next: list each drug's maximum daily dose → `min_par`, for the pharmacist to confirm (§5.2).
8. **Pack sizes.** 26 known so far (issue slip and requisition form). Where do the rest come from: main storage's item list? (#2)
9. ~~OPD list~~ resolved above. Pharmacist to confirm the 5 borderline drugs (used on exactly 14 of 92 days) and deferiprone (GPO-L-ONE: shelf stock or patient-specific).
10. **Rule details.** HAD always main storage? 4 HAD injections on IPD's OPD list are used on 1–3 days in 3 months (calcium gluconate, dopamine, adenosine, digoxin). Is weekly the right line between main storage and OPD? (#3, §5.2)
11. **หมายเลขพัสดุ.** Does main storage have an item code per drug? (#4)
12. **Page layout.** The paper form has ~19 lines per sheet: number the printout's pages to match, or print one continuous list? (#4)
