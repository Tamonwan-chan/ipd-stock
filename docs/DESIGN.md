# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **v0.5**, 19 Nov 2026. Based on [PRD.md](PRD.md), IPD staff answers to PRD section 7, OPD's reply on the requisition format, IPD's main-storage requisition form, and an analysis of 3 months of HOSxP dispensing data (§5.1).

Changes from v0.1: no pack boxes (OPD accepts plain units); IPD lines are added to OPD's own requisition; usage is stored daily.
Changes from v0.2: par uses the standard periodic-review safety-stock formula (it beat the percentile method at equal stock); liquids dispensed per ml are counted and requested in whole bottles; expensive, infrequent drugs get their own tier; home medications (HM) confirmed to come from IPD stock, so they stay in the usage data.
Changes from v0.3 (issues #1–#4): IPD requests from **main storage (คลัง) every 2 weeks** on its own form ใบเบิกหรือใบส่งคืน, no longer through OPD's weekly requisition; drugs used **less than weekly** are fetched from OPD instead, as a separate, optional request; quantities stay in units. A shelf min (ยอดต่ำสุด) warns when stock won't last until the delivery.
Dropped on 16 Nov: the 1-pack rule (main storage when the busiest cycle used ≥ 80% of a pack). Main storage's pack sizes change often and IPD requests in units, so pack sizes are not tracked.
Added on 18 Nov (staff request): optional whole-box lines on the main-storage form. Staff type boxes and units per box on a count line; the form then shows `1x1000` under จำนวนเบิกใหม่ and `1` under จ่ายหรือรับคืน. The last units per box typed is remembered per drug (`Drugs.pack_size`) and offered next round, so a changed box size is visible and corrected by hand. Pack sizes still play no part in par, min or the suggested quantity.
Changes from v0.4 (web app v2, 18 Nov; opened to staff 19 Nov): the app's own logins with roles and a change log (§7); counting on a printed count sheet at the shelf, typed in at a PC; staff do the HOSxP import in the web app; delivery checks with expiry dates and document numbers (§6).

Changes on 20 Nov (from the first teaching round with IPD staff): menu in the order of the work; ใบเบิกพิเศษ, an extra main-storage request between rounds (`Rounds.kind = EXTRA`); a warning at the delivery check when what came expires within 3 months; the stock card reloads when รายการยา is shown again; the icon credit moved to the About dialog.

## 1. What round 1 must do

From PRD section 2, nothing more:

1. Compute a **par level** (ยอดที่ควรมี) per drug from real usage.
2. At each count (every 2 weeks), take on-hand quantities and compute **how much to order**.
3. Produce a **main-storage requisition** laid out like the paper form ใบเบิกหรือใบส่งคืน: drug name, unit, on-hand, quantity in dispensing units (e.g. `Vitamin B complex 1500 เม็ด`) (§6).
4. Produce a separate, optional, monthly **OPD list** for drugs used less than weekly (§5.2).

Out of scope for round 1: automatic stock deduction, live HIS integration, expiry alerts for stock on the shelf. Delivery checks with expiry dates were added on 18 Nov at the owner's request (§6); on 20 Nov the check also warns about short-dated deliveries (within 3 months).

## 2. Constraints that shape the design

| Fact (source) | Design consequence |
| :- | :- |
| One pharmacy technician counts and orders, 30–60 min, timing unpredictable (Q7) | Counting must be fast and resumable → a printed count sheet filled in at the shelf, then typed in at a PC with autosave (18 Nov). Keep the stock list short (§5.2) |
| IPD has no usable computer/printer; prints at the warehouse or OPD (Q10) | Everything runs in a browser; output works from any PC |
| Pharmacist reviews but often can't check every line (Q8) | Review screen shows **exceptions first** |
| IPD requests from main storage every 2 weeks, independent of the monthly OPD requests (16–17 Nov) | Demand window = count day through the delivery after next = 16 days + `delay_days` (§5). Count Tuesday morning, delivery Wednesday afternoon |
| 11 HAD injectables must never run out (Q4) | Per-drug `critical` flag → par from the worst observed window + minimum par |
| Main storage's form has a unit column (หน่วยนับ); IPD requests in units, and pack sizes change too often to track (16 Nov) | No box rounding; output in units (whole bottles for liquids dispensed per ml). Staff may type a line as whole boxes × units per box (18 Nov, §6) |
| Low-use drugs are fetched from OPD, not requested from main storage (16 Nov), once a month (17 Nov) | Use frequency decides main storage vs OPD; OPD suggestion = a month of use (§5.2) |
| HOSxP export is daily, one row per drug per day, no patient columns | Store daily usage in the Sheet; the daily SD and the worst W-day window need daily data |
| Repo is public | No spreadsheet IDs, script IDs or hospital data in git |

## 3. Architecture

```
┌──────────────── Google Sheet "IPD Stock" (database, private) ────────────────┐
│ Settings │ Drugs │ UsageDaily │ Rounds │ RoundLines │ OpdRequests │ OpdLines │ │
│ Expiry │ Users │ ChangeLog │ Import                                            │
└────────────────────────────────▲─────────────────────────────────────────────┘
                                 │ SpreadsheetApp (bound script)
┌────────────────────────────────┴─────────────────────────────────────────────┐
│ Apps Script project (this repo, deployed with clasp)                         │
│  Calc.js   pure functions: mean/SD, worst window, par, order (Node-tested)
│  Schema.js tabs, columns and column types (plain data)                       │
│  Db.js     read/write sheets as arrays of objects, LockService (Node-tested) │
│  Import.js HOSxP rows → UsageDaily, new drugs → Drugs, recompute par        │
│  Auth.js   web app logins: hashed passwords, sessions, roles                 │
│  Api.js    web app server calls (each checks the session), change log        │
│  Code.js   onOpen menu (admin) + doGet web app                               │
│  ui/       App.html (page), Styles.html, Client.html (browser JS)            │
└────────────┬───────────────────────────┬─────────────────────────────────────┘
     Sheet menu (owner)           Web app (HtmlService): login, left menu (§6)
     - import usage (paste)       - home: round steps, below-min list, waiting
     - recompute par              - medicines: list + stock card, add/edit
     - create tabs                - requisition: main storage (count sheet, count,
     - first admin login            form) or OPD; delivery checks + expiry dates
                                  - HOSxP import, min/max list; admin: users, log
```

- **Container-bound script** on the existing private "IPD Stock" spreadsheet (which already holds the HOSxP export): simplest permissions, custom menu for free, no IDs in code.
- **Web app** for everything staff do: HOSxP import, medicines, count, review, forms, delivery checks. The Sheet menu stays for the owner (tabs, recompute, the first admin login).
- **`Calc.js` has no Apps Script calls**, so it runs unchanged in Node for tests. It ends with
  `if (typeof module !== 'undefined') module.exports = {...}`.
- **`Db.js` takes the spreadsheet as an argument** (default: the bound one) and uses only a dozen SpreadsheetApp calls, so tests run it against an in-memory fake (`test/fake-spreadsheet.js`).
- Scale: ~340 drugs; ~12k usage rows per quarter (~47k/year); 26 rounds/year. Well within Sheets limits. Writes go through `LockService`.

## 4. Data model (one sheet tab per table, row 1 = headers)

Defined in `src/Schema.js`; **IPD › ตั้งค่าแท็บข้อมูล** (`setupSheets` → `Db.ensureSchema`) creates missing tabs, appends missing columns to row 1 (never reorders or deletes), adds missing Settings keys with their defaults, refreshes the notes of known keys (never their values), and lists Settings keys the code no longer reads (e.g. `main_pack_share`) without deleting them. Other tabs, such as the original HOSxP export, are left alone. Db reads columns by name, so the admin may reorder columns or add their own.

Each column has a type. Text columns get the plain-text format so Sheets doesn't turn values like `2026-11-17` (a `round_id`) or `00123` (an `item_code`) into a date or a number. Date columns hold real Sheet dates and are read as ISO `YYYY-MM-DD`; this needs the script and the spreadsheet both set to the Asia/Bangkok time zone. Checkbox columns read blank as FALSE.

**Settings**: key / value / note (Thai explanation for the admin)

| key | default | meaning |
| :- | :- | :- |
| `cycle_days` | 14 | days between main-storage requisitions (every 2 weeks) |
| `lead_days` | 1 | count day → delivery day: count Tuesday morning, delivery Wednesday afternoon (IPD, 17 Nov) |
| `delay_days` | 0 | extra days for late delivery, added to the window. IPD chose **5** for every drug (17 Nov): set 5 in the Sheet's Settings (§5.3) |
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
| `pack_size` | 1000 | units (`request_unit`) per box at main storage, as last typed on a count line; written by the web app, offered again next round. Display only (§6) |
| `source` | MAIN | pharmacist's choice: `MAIN` (main storage, counted, par-based) / `OPD` (fetched from OPD, optional) / `NONE` (requested from neither: billing-only rows such as `Salbutamol solution (คิดเป็น มล.)`) / blank = follow `source_calc` |
| `item_code` | | main storage's item code (หมายเลขพัสดุ) if one exists (§9) |
| `unit_price` | 0.5 | latest HOSxP `unit_price`; used only to find expensive drugs |
| `stocked` | TRUE | counted and ordered from main storage. Written by recompute from `source`, the rule and `critical` (§6); change `source` rather than this column |
| `critical` | TRUE | HAD / emergency-box items. Ticked on import when the name has the `HAD` tag; the pharmacist may change it |
| `min_par` | 10 | floor for par (e.g. emergency-box quantity). Not the same as the shelf min below |
| `par_override` | | pharmacist's manual par; wins when set |
| `min_override` | | pharmacist's manual shelf min (ยอดต่ำสุด); wins when set, 0 turns the warning off |
| `location` | ตู้เก็บยา | optional: ตู้เก็บยา / ชั้นวางยา / ลิ้นชักยา. Parked (#12): not raised with staff unless they ask; while no stocked drug has one, lists show no place headings |
| `shelf_order` | 120 | optional walking order within a place (#12) |
| `use_freq` | 0.95 | share of days used in history (written by recompute) |
| `source_calc` | OPD | use-frequency rule result, `MAIN` or `OPD` (written by recompute) |
| `par_calc` | 36 | written by recompute |
| `min_calc` | 8 | shelf min, in `unit`s, written by recompute (§5) |
| `par_updated` | 2026-11-20 | written by recompute |

Match key on import: `hosxp_name + strength + unit`.

**UsageDaily**: `date`, `drug_id`, `qty`. Only nonzero rows are needed; missing days count as 0. Price columns are not imported. Importing a period replaces the rows dated within it (`Db.replaceUsage`), so a re-import never double counts.

**Rounds**: `round_id` (the count date, e.g. `2026-11-17`; ISO week numbers no longer fit a 2-week cycle), `count_date`, `status`, `counted_by`, `submitted_at`, `reviewed_by`, `approved_at`, `note`, `received_at`, `received_by` (set when staff confirm the delivery check, ยืนยันรับเข้าคลัง), `req_no`, `receipt_no` (document numbers, below), `kind` (20 Nov: blank = the 2-week round; `EXTRA` = a ใบเบิกพิเศษ), `count_printed_at`, `form_printed_at` (20 Nov: last time the count sheet / the approved ใบเบิก was printed, for the round's steps; not in the change log)

**ใบเบิกพิเศษ** (20 Nov, staff request): an extra request to main storage between 2-week rounds, e.g. when use jumps. It is a Rounds row with `kind = EXTRA` (`round_id` `EX-<date>`, `-2`… for more the same day) and RoundLines holding only `final_qty`: no count, no suggestion. Like an OPD request it needs no approval: `Api.createExtraRequest` saves it as `APPROVED` with its `req_no` at once (optional reason in `note`), so the delivery check (`saveReceived` / `confirmReceipt`), the ตรวจรับยา list and the stock card treat it like a round's ใบเบิก. It is kept out of everything about the 2-week round: the count page's round and round list (`Api.state`), `startRound`, `saveLines` and `approveRound`. Before its delivery is confirmed it can be cancelled (`Api.cancelExtraRequest`, status `CANCELLED`; its number is not reused). Any medicine on the main-storage or OPD list can be requested.

**Document numbers** (18 Nov): a ใบเบิก gets `req_no` `บ.69/0001` when its round is approved (only if something is requested) or when an OPD request is saved; the delivery check gets `receipt_no` `ร.69/0001` when it is confirmed. One series each for main storage and OPD together, from 0001 again each Thai year (`Api.nextNo_`, run under the script lock). A ใบเบิก has one ใบรับ: what main storage or OPD didn't give is closed, not carried over; if it is still needed it goes on the next ใบเบิก. The ใบรับ is kept separate from the ใบเบิก because what arrives often differs from what was asked for. The ใบเบิก number is printed in the form's เลขที่ box.

**RoundLines**: one row per round and drug (key `round_id` + `drug_id`, written with `Db.upsert` as each count autosaves); frozen at approval
`round_id`, `drug_id`, `on_hand`, `par_used`, `suggested_qty`, `final_qty`, `boxes`, `pack_size`, `change_reason`, `flags`, `received_qty`
(`boxes` and `pack_size`: optional whole boxes requested and units per box; when both are set, `final_qty = boxes × pack_size`. `Api.saveLines` adds these columns to an older Sheet on first save. `received_qty`: what main storage delivered, in request units, typed at the delivery check; blank = not checked. Written after approval too: approval freezes what was requested, not what arrived.)

**OpdRequests**: one row per request taken to the OPD pharmacy (key `request_id` = `OPD-<date>`, `-2`, `-3`… for more the same day)
`request_id`, `request_date`, `kind` (`MONTHLY` = the monthly list of rarely used drugs; `URGENT` = a fetch because a drug ran low, which may include main-storage drugs), `status` (`REQUESTED` → `RECEIVED` when the check is confirmed; or `CANCELLED`), `requested_by`, `received_at`, `received_by`, `note`, `req_no`, `receipt_no`

**OpdLines**: key `request_id` + `drug_id`: `qty` requested, `received_qty` handed over (blank = not checked)

Both OPD tabs and the receiving columns are created on first use (`Db.ensureColumns` creates a missing tab), so an older Sheet needs no setup run. Urgent requests are the record of OPD trips for the trial month (PRD §8: at most 1–2 a week).

**Expiry** (18 Nov): key `ref` + `drug_id` + `exp_date`: one row per expiry date typed at a delivery check (`ref` = the round id or OPD request id, `source` `MAIN` / `OPD`), `added_at`, `added_by`, `removed_at`, `removed_by`. A line can have several dates. A row leaves the shelf when staff remove it on the stock card (the lot is used up) or correct it at the delivery check; rows are never deleted. Alerts for dates already on the shelf are a later step; the delivery check warns when a date typed is within 3 months of today (or already past), marks it red, counts those lines next to the summary and names them on the confirm click. Staff can still confirm: short-dated stock is sometimes all main storage has (owner, 20 Nov). Confirmed ใบรับ show such dates in red, measured from the day received. Dates carry no quantity per lot (decided 18 Nov): the app can't deplete stock in real time and the HOSxP rate overstates IPD use, so a per-lot quantity would be wrong within days; whether a date is still on the shelf is confirmed by staff (remove it when the lot is gone).

**Users** (web app logins, `Auth.js`): key `username`; `name`, `role` (`staff` / `admin`), `active`, `pw_salt`, `pw_hash` (salted SHA-256, never the password), `created_at`, `last_login`. An older Sheet's `email` column is left alone and ignored.

**ChangeLog** (append-only): `at`, `user`, `action`, `target`, `detail`. Written when a change is submitted, not on every autosave: counts and requested quantities are logged once per line when the round is approved (count, suggested, เบิกจริง, boxes, reason, under the approver's name; `Rounds.counted_by` keeps who counted), plus approvals, deliveries and expiry dates, OPD requests, medicine edits, imports, logins, user changes. Read by the admin in the app.

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
                 by box: จำนวนเบิกใหม่ = "boxes x pack_size", จ่ายหรือรับคืน = boxes
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

Overrides, in order (`Calc.stockDecision`): `critical` (HAD) drugs are always `MAIN` (confirmed by IPD staff, 17 Nov); the pharmacist's `source` (`MAIN`/`OPD`/`NONE`) wins; a `min_par` or `par_override` makes a drug `MAIN` (the pharmacist wants it on the shelf); expensive, infrequent drugs are `OPD` until they get one of those.

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

IPD staff (17 Nov): the buffer applies to **every drug**, not only critical ones, so every shelf also covers refilling the emergency boxes used on each shift. They chose **5 days** (17 Nov).

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

### Sheet menu (owner)
Since web app v2, staff import the HOSxP file themselves on the web page before each count (**นำเข้าข้อมูล HOSxP**, same checks as step 2). The Sheet menu path below does the same from the **Import** tab.

1. Export the HOSxP daily IPD dispensing report (same columns as now: `order_date, drug_name, strength, drug_unit, total_quantity, unit_price, total_price`) and paste it into **Import**.
2. Menu **IPD › นำเข้าข้อมูลการใช้ยา** (`Import.importUsage`):
   - Checks every row first: `order_date` as d/m/yyyy text (C.E. or B.E.) or a Sheet date, quantity a number, no date after today. Any error aborts the whole import with the row numbers, and nothing is written.
   - Rejects a column that Sheets converted only partly (some cells dates, others text with a day over 12): the sign of a month/day locale reading 5/11 as 11 May. The fix is to format column A as plain text and paste again.
   - Sums same-day rows, drops zero quantities, matches **Drugs** by `hosxp_name + strength + unit`, and creates new drugs with `critical` ticked when the name has the `HAD` tag. Updates `unit_price` to the latest price.
   - Replaces **UsageDaily** rows within the imported date range, clears **Import** (header kept), and runs step 3.
3. Menu **IPD › คำนวณยอดที่ควรมีใหม่** (`Import.recompute`): uses the last `history_days` of **UsageDaily** up to the latest usage date (not before the first one), and writes `use_freq`, `mean_daily`, `source_calc`, `stocked`, `par_calc`, `min_calc`, `par_updated`. The summary lists expensive drugs needing a `min_par` and drugs whose `source` differs from the rule.
4. Pharmacist reviews `source`, `critical`, `min_par`, `par_override`, `min_override` and `location` in **Drugs**, then reruns step 3. Placeholder rows such as `YA....` stay unstocked. They are recognised by the name only: real drugs can have unit `.` in HOSxP (magnesium sulfate 50% inj, a HAD drug; ritonavir).

**`stocked` is written by recompute** (`Calc.stockDecision`); the pharmacist steers it through `source`:
- `source` blank: the use-frequency rule decides (`source_calc`).
- `source` = `OPD` → not stocked; `MAIN` → stocked, whatever the rule says.
- `source` = `NONE` → on neither list. For HOSxP rows that only carry a charge, e.g. nebuliser solution billed per ml on the ward (17 Nov).
- `min_par` or `par_override` set → stocked.
- `critical` drugs are always stocked. Expensive, infrequent drugs are stocked only once they have a `min_par` or `par_override` (or `source = MAIN`).

### Web app (v2, 18 Nov 2026: layout chosen by the owner)

Layout: a home dashboard and one medicine list (common in inventory apps such as Sortly and BoxHero), with a stock card per medicine (the บัตรคุมยา). Staff sign in first (§7). The left menu (20 Nov) puts the main job first, in the order of the work: หน้าหลัก, นำเข้าข้อมูล HOSxP, เบิกยา, ตรวจรับยา. Under a ข้อมูลยา heading come the pages used now and then: รายการยา and ป้ายสูงสุด/ต่ำสุด. The admin pages come last. The screens:

1. **หน้าหลัก**: the 2-week round as seven steps (HOSxP import, done when the data reaches within 7 days of the count date → print count sheet → type counts → เบิกจริง / boxes → approve → print form → delivery check with expiry dates), with what is done. Since 20 Nov each step is a button that goes where the step is done (import page; print the count sheet; the count list; the approve button; the ใบเบิก; the delivery check of this round's ใบเบิก). Done steps are green with ✓, and the next step to do (the first not done after the last done one) is outlined and labelled ถัดไป. Done rules: count sheet = printed for this round (`Rounds.count_printed_at`, via `Api.markPrinted`), or counting started; counts = every main-storage drug counted; steps 2–4 also once approved; ใบเบิก = printed after approval (`Rounds.form_printed_at`) or received. The same steps sit above the count list; tiles for drugs below min at the latest count, deliveries waiting from main storage and from OPD, and the number of medicines; the below-min list with **ขอด่วนจาก OPD** per drug (opens the OPD request with that drug ticked, type ด่วน).
2. **รายการยา**: one searchable list (name, HOSxP name, strength, item code) with filters (main storage, OPD, critical, below min, not requested), latest count and its date, max / min and a status. Clicking a medicine opens its **stock card**: latest count, max / min, HOSxP average use (labelled an estimate: new admissions and weekend patients are dispensed from OPD stock), units per box, the expiry dates on the shelf (each removable), and the history (each round's count, request and delivery; each ใบเบิกพิเศษ; each OPD request and what came) from `Api.drugCard`. The open card is fetched again whenever รายการยา is shown, so deliveries checked elsewhere appear (before 20 Nov it kept the copy loaded when the medicine was opened). **แก้ไขข้อมูลยา** / **+ เพิ่มยา** (`Api.saveDrug`): name and unit used on the form, HOSxP units per request unit, item code, units per box, source (automatic / main storage / OPD / none), critical, and max / min set by hand (typed in request units, stored as `par_override` / `min_override` in HOSxP units). A new medicine needs the HOSxP name, strength and unit exactly as HOSxP writes them, so later imports match it; those three can't be changed afterwards. Saving recomputes the stock rules.
3. **เบิกยา**, one page with a switch:
   - **เบิกจากคลัง (ทุก 2 สัปดาห์)**: the round's steps, then two sub-views. *นับยาและยอดเบิก*: **พิมพ์ใบนับยา** prints the count sheet (main-storage drugs with max / min, then OPD drugs kept on the IPD shelf with a month's average use, and an empty column for the count); staff count on paper, then type the counts here. Main-storage lines show the suggested quantity, `เบิกจริง`, optional `กล่อง` × `ต่อกล่อง`, flags, autosave (`Api.saveLines`), and **อนุมัติรอบนี้** (two clicks). OPD drugs get a count box only (saved as a round line with no request). *ใบเบิก*: the paper form, 19 lines per A4 page; boxed lines show `boxes x pack_size` and the box count under จ่ายหรือรับคืน; print, CSV or copy.
   - **เบิกจาก OPD**: OPD drugs with the latest count of this cycle, a month's average use and the suggested quantity = a month's average use − the count (when counted within `cycle_days`), else a month's use. Ticking แสดงยาที่เบิกคลังด้วย adds main-storage drugs and switches the type to ด่วน. **บันทึกและพิมพ์** (`Api.createOpdRequest`) prints it with a จ่ายจริง column. History of requests with reprint, and urgent requests in the last 7 days (PRD §8).
   - **ใบเบิกพิเศษ (จากคลัง)** (20 Nov): written line by line. A **เพิ่มยา** search box suggests medicines on the main-storage or OPD list as staff type (↑/↓, Enter or click adds one; medicines already on the list are left out); the cursor goes to the new line's quantity, and Enter there goes back to the search box for the next medicine. Lines can be removed (×); the list is kept in the browser until saved. Optional reason. **บันทึกและพิมพ์ใบเบิก** needs two clicks: the first checks that every line has a quantity (blank ones are marked red) and turns the button red to confirm; the second saves (`Api.createExtraRequest`, ใบเบิก number as for a round or an OPD request) and prints the same paper form as the round (blank คงเหลือ column, "(ใบเบิกพิเศษ)" after the date). Below: recent ใบเบิกพิเศษ with their result and reprint.
4. **ตรวจรับยา**: lists only approved ใบเบิก still waiting for their delivery (main storage and OPD, with their numbers, oldest first); staff click the one that matches what arrived. Per line: received quantity (or ครบ, or fill all blanks; 0 = nothing came), ครบ / ขาด / เกิน, and **any number of expiry dates**. **บันทึกร่าง** saves a draft (`Api.saveReceived` / `Api.saveOpdReceived`; a date taken off a line is removed). **ยืนยันรับเข้าคลัง** (two clicks; `Api.confirmReceipt` / `Api.confirmOpdReceipt`) needs every line filled and an expiry date on every line that received something (an empty date box shows by default; missing ones are marked red), gives the ใบรับ number and locks the quantities (expiry dates can still be fixed on the server). Below: the last 15 confirmed ใบรับ, each opening a read-only view. A ใบเบิกพิเศษ shows as from คลังยา (ใบเบิกพิเศษ), with reprint and cancel like an OPD request. Expiry dates within 3 months are flagged (above, ใบเบิกพิเศษ / expiry).
5. **นำเข้าข้อมูล HOSxP**: drag a HOSxP export (xlsx/xls/csv, read in the browser with SheetJS), preview, import (`Api.importFile` → `Import.importRows`). Staff do this themselves before counting.
6. **ป้ายสูงสุด/ต่ำสุด**: printable list of stocked drugs with max and min in request units, plus CSV.
7. Admin only: **ผู้ใช้งาน** (add staff, set name / role / password, deactivate instead of delete; the last active admin can't be removed) and **ประวัติการแก้ไข** (the last 500 ChangeLog rows, searchable).

Everything printed goes through one hidden `#print-area`, so only that page reaches the printer. The round review step (status `REVIEW`) is folded into the count screen: the pharmacist edits `เบิกจริง` and approves. Real use is not worked out from counts: patients' doses also come from OPD stock (new admissions, weekends), so max / min stay based on the HOSxP rate.

Deployment: `clasp push`, then `clasp update-deployment <deploymentId>` to publish to the same URL (`clasp create-deployment` the first time). `clasp push` alone updates the test deployment (`@HEAD`, the `/dev` URL, editors only), so a change can be tried before staff see it. The manifest runs the app as the owner and, since 19 Nov, lets anyone with the link open it (`ANYONE_ANONYMOUS`); the app's own login guards every call (§7).

Round status: `COUNTING → APPROVED` (the review step is folded into the count screen). Approved rounds are read-only.

## 7. Access and privacy

- **The app's own logins** (18 Nov, `Auth.js`). The web app runs as the owner (*Execute as: me*), so the Sheet stays private and staff need no Google account. Each person signs in with a username and password; the Users tab keeps only a salted hash. A login returns a random session token kept in the browser and sent with every call; sessions live in the script cache for 6 hours after the last call. Every `api*` call checks the token and the user's Users row (a deactivated user is out at once). Five wrong passwords in a row pause that username for 10 minutes. **ออกจากระบบ** ends the session on a shared PC.
- **Roles:** `staff` do all the work, including the HOSxP import and adding / editing medicines. `admin` (the owner) can also manage users and read the change log. The owner creates the first admin from the Sheet menu **IPD › สร้างบัญชีผู้ดูแลระบบ / ตั้งรหัสใหม่** (also the way back in if the admin password is lost).
- **Who changed what:** names (not emails) go into `counted_by`, `reviewed_by`, `received_by`, `requested_by`, Expiry and every ChangeLog row.
- The web app's `access` is *Anyone* (`ANYONE_ANONYMOUS`) since 19 Nov, so staff need no Google account; the login page is the only thing a stranger with the link sees.
- The HOSxP export has no patient columns. If a future export adds HN/AN or names, the importer ignores every column except the seven above.
- Git holds code and docs only. `.clasp.json` (script ID) is gitignored. No usage data is committed.

## 8. Repository layout

```
src/                 Apps Script project root (clasp rootDir)
  appsscript.json          time zone Asia/Bangkok, V8
  Code.js  Calc.js  Schema.js  Db.js  Import.js  Auth.js  Api.js
  ui/ App.html  Styles.html  Client.html
test/                node --test: calc, db, import, auth, api (+ fake-spreadsheet.js)
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
- Quantities in units on both lists. Pack sizes change too often to keep a table, so the calculation never uses them. Since 18 Nov staff may type a main-storage line as whole boxes × units per box; the last units per box is remembered per drug (`Drugs.pack_size`) and corrected by hand when main storage changes it (§6). Main storage vs OPD by use frequency (§5.2).
- Lead time: count on Tuesday morning, main storage delivers Wednesday afternoon → `lead_days = 1` (17 Nov).
- OPD requests: once a month → `opd_cycle_days = 30` (17 Nov).
- OPD list: IPD's current list (79 drugs) checked against Aug–Oct usage: 33 move to main storage, 4 rarely used HAD injections for the pharmacist to decide, 28 stay with OPD, 14 unused in the period (#3, 17 Nov).
- Targets for the trial month (PRD §8): trips to OPD at most 1–2 a week (aim 0–1); requisition work at most 20–30 minutes per round.
- Delivery delay: `delay_days = 5`, on every drug; main-storage cycle confirmed every 2 weeks (17 Nov).
- HAD drugs always come from main storage (17 Nov). Only the HAD-tagged forms: digoxin injection is HAD, digoxin tablet is not.
- OPD list after staff review (17 Nov): the 33 move to main storage except clozapine 100 mg, ibuprofen 200 mg, bisoprolol 5 mg and S.M.W (`source = OPD`); atropine injection and budesonide nasal spray also move (`source = MAIN`); the 4 HAD injections stay in main storage.
- Charge-only rows: nurses enter them in HOSxP to bill by the ml or unit; the drug itself comes from a bottle or vial that has its own row (or isn't IPD stock) → `source = NONE`, set by hand (17 Nov):
  - per ml: `Berodual solution (คิดเป็น มล.พ่นยาใน รพ.)`, `Salbutamol solution (คิดเป็น มล.)(C)`, `(ยาชา) Li-docaine inj. (ต่อ มล.)(B)`;
  - per unit: `Mixtard 30/70 (คิดเป็นยูนิต)`, `REGULAR INSULIN (RI) (คิดยูนิต)` (the vials are `Mixtard 30/70 (ขวด)` and `REGULAR INSULIN inj (RI)10ml`).

  Exceptions: `KCl syr. (คิดต่อ ml.)` and `Syrup (คิดเป็น ml)` are real IPD stock with no other row, so they stay counted, requested in whole bottles (240 ml and 450 ml). No automatic rule by name: the wording varies (คิดเป็น / คิดต่อ / คิดยูนิต / ต่อ มล.) and would catch these two. The recompute summary lists every `NONE` row.
- Issue sizes: lidocaine viscous comes from main storage in 100 ml bottles (HOSxP counts 15 ml bottles → `request_factor` 100/15); S.M.W is requested by the 3.750 L gallon (HOSxP counts 120 ml bottles → `request_factor` 31.25). `Syrup (คิดเป็น ml)`: 450 ml bottle.

Open:
1. ~~Accounts and devices~~ resolved (18 Nov): the app's own logins, so no Google accounts are needed (§7); staff count on a printed count sheet and type the counts in at a PC.
2. ~~Lead time~~ resolved above.
3. ~~Delivery delay~~ resolved above (5 days).
4. ~~Bottle sizes~~ resolved above. Adrenaline 1 mg/ml: 1 ml = 1 ampoule.
5. ~~Multiple locations~~ parked with shelf places (#12): only if staff ask.
6. **Drug code.** Can IT add HOSxP `icode` to the export? Names change and have typos; a code is a safer key.
7. **Expensive, infrequent drugs.** IPD pharmacist (17 Nov): keep about 5 days of use at the maximum dose per drug. Draft table in #5, waiting for the pharmacist; enter the result as `par_override` (`min_par` is only a floor) (§5.2).
8. ~~Pack sizes~~ not used in the calculation (#2, closed). Optional whole-box lines typed by staff since 18 Nov (§6).
9. ~~OPD list~~ resolved above. Deferiprone (GPO-L-ONE) moves with the 33 → `source = MAIN` until the pharmacist sets its `par_override`.
10. ~~Rule details~~ resolved above: HAD always main storage; weekly use is the line.
11. **หมายเลขพัสดุ.** Does main storage have an item code per drug? (#4)
12. **Page layout.** The paper form has ~19 lines per sheet: number the printout's pages to match, or print one continuous list? (#4)
