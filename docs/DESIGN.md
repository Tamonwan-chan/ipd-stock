# Design: IPD stock tool (Google Apps Script + Google Sheets)

Status: **draft v0.1**, 15 Nov 2026. Based on [PRD.md](PRD.md) and IPD staff answers to PRD section 7.

## 1. What round 1 must do

From PRD section 2, nothing more:

1. Compute a **par level** (ยอดที่ควรมี) per drug from real usage.
2. At each weekly count, take on-hand quantities and compute **how much to order**.
3. Produce a **requisition list in OPD's format**: OPD's drug name, quantity as `boxes x pack size` (e.g. `2x100`), remark `IPD`.

Out of scope for round 1: automatic stock deduction, hospital system (HIS) integration, expiry tracking, receiving/check-in records.

## 2. Constraints that shape the design

| Fact (source) | Design consequence |
| :- | :- |
| One pharmacy technician counts and orders, 30–60 min, timing unpredictable (Q7) | Counting must be fast, resumable, and work at the shelf → mobile web page with autosave |
| IPD has no usable computer/printer; prints at the warehouse or OPD (Q10) | Everything runs in a browser; the print page must work from any PC |
| Pharmacist reviews but often can't check every line (Q8) | Review screen shows **exceptions first**, not 135 rows |
| OPD orders Tuesday, stock arrives Wednesday ~14:00 (Q1) | Coverage days = cycle + lead time + buffer (see §5) |
| 11 HAD injectables must never run out (Q4) | Per-drug `critical` flag → longer buffer + minimum par |
| IT report uses different names/units than the OPD form (PRD §4) | Drug master holds the IT name ↔ OPD name ↔ pack size mapping |
| Repo is public | No spreadsheet IDs, script IDs or hospital data in git |

## 3. Architecture

```
┌──────────────── Google Sheet (database, private) ────────────────┐
│ Settings │ Drugs │ Usage │ Rounds │ RoundLines │ Users │ Import  │
└────────────────────────────▲─────────────────────────────────────┘
                             │ SpreadsheetApp (bound script)
┌────────────────────────────┴─────────────────────────────────────┐
│ Apps Script project (this repo, deployed with clasp)             │
│  Calc.js   pure functions: par, order qty, OPD text (Node-tested)│
│  Db.js     read/write sheets as arrays of objects, LockService   │
│  Import.js aggregate IT report → Usage, recompute par            │
│  Rounds.js round lifecycle                                       │
│  Code.js   onOpen menu (admin) + doGet web app routing           │
└────────────┬───────────────────────────┬─────────────────────────┘
     Sheet menu (admin)           Web app (HtmlService)
     - import usage               - /count   technician, phone
     - recompute par              - /review  pharmacist
     - edit drug master           - /print   A4 requisition + copy
```

- **Container-bound script** on the Sheet: simplest permissions, custom menu for free, no IDs in code.
- **Web app** for the two weekly jobs (count, review/print). Admin jobs (import, drug master) stay in the Sheet UI because they're done quarterly by someone comfortable with spreadsheets.
- **`Calc.js` has no Apps Script calls**, so it runs unchanged in Node for tests. It ends with
  `if (typeof module !== 'undefined') module.exports = {...}`.
- Scale is tiny (~135 drugs, 52 rounds/year ≈ 7k lines/year), so Sheets is fine as a database. Writes go through `LockService` to stop two sessions from overwriting each other.

## 4. Data model (one sheet tab per table, row 1 = headers)

**Settings**: key / value

| key | default | meaning |
| :- | :- | :- |
| `cycle_days` | 7 | days between deliveries |
| `lead_days` | 1 | count day → delivery day (Tue → Wed). **Pending confirmation with IPD** |
| `buffer_days` | 3 | safety days, normal drugs |
| `critical_buffer_days` | 5 | safety days, `critical` drugs |
| `overshoot_ratio` | 2 | flag a line when box rounding orders more than this × the shortfall |

**Drugs**: drug master, one row per stocked or candidate drug

| column | example | notes |
| :- | :- | :- |
| `drug_id` | D001 | stable key; never reuse |
| `it_name` | `**AMLODIPINE **(C) 10 mg.` | exact text in the IT report, used for matching |
| `opd_name` | Amlo 10 | name as written on the OPD form |
| `unit` | เม็ด | sub-unit: เม็ด / แอมป์ / ไวอัล / ขวด |
| `pack_size` | 100 | sub-units per box; 1 for items ordered singly (NSS) |
| `stocked` | TRUE | FALSE = keep the row for matching, but never count or order |
| `critical` | TRUE | HAD / emergency-box items |
| `min_par` | 10 | floor for par (needed for low- or zero-usage critical drugs) |
| `par_override` | | pharmacist's manual par; wins over the calculation when set |
| `location` | ตู้เก็บยา | ตู้เก็บยา / ชั้นวางยา / ลิ้นชักยา |
| `shelf_order` | 120 | walking order for counting |
| `avg_daily_use` | 3.2 | written by "Recompute par" |
| `par_calc` | 36 | written by "Recompute par" |
| `par_updated` | 2026-11-20 | written by "Recompute par" |

**Usage**: aggregated usage per drug per import period (no patient data)
`period_start`, `period_end`, `it_name`, `drug_id` (blank if unmatched), `qty_units`, `imported_at`

**Rounds**: one row per weekly requisition
`round_id` (e.g. `2026-W47`), `count_date`, `status`, `counted_by`, `submitted_at`, `reviewed_by`, `approved_at`, `note`

**RoundLines**: one row per drug per round, frozen at approval
`round_id`, `drug_id`, `boxes_counted`, `loose_counted`, `on_hand_units`, `par_used`, `suggested_boxes`, `final_boxes`, `change_reason`, `flags`

**Users**: `email`, `name`, `role` (`counter` / `pharmacist` / `admin`)

**Import**: scratch tab. The IT report is pasted here, then cleared after a successful import.

Snapshotting `par_used` into each line means past rounds stay reproducible after par is recomputed, and they give the before/after numbers PRD §8 asks for.

## 5. Calculations (`Calc.js`)

```
coverage_days  = cycle_days + lead_days + (critical ? critical_buffer_days : buffer_days)
avg_daily_use  = Σ qty_units in window / days in window
par_calc       = ceil(avg_daily_use × coverage_days)
par            = par_override  if set,  else max(par_calc, min_par)

on_hand_units  = boxes_counted × pack_size + loose_counted
shortfall      = max(0, par − on_hand_units)
suggested_boxes= ceil(shortfall / pack_size)

opd_qty_text   = pack_size == 1 ? "{boxes}" : "{boxes}x{pack_size}"     → "2x100", "4"
```

Worked check against the PRD example (NSS 1000 ml, Oct usage 17 bottles / 31 days, normal drug):
0.548/day × (7 + 1 + 3) = 6.03 → par 7. With 2 on hand → order **5** (the PRD's 7 + 3 version gave 4).

**Flags** set on each line, shown first in review:

| flag | condition |
| :- | :- |
| `NOT_COUNTED` | stocked drug left blank (blank ≠ 0) |
| `CRITICAL_LOW` | critical drug and on_hand < par |
| `OVERSHOOT` | suggested_boxes × pack_size > overshoot_ratio × shortfall (large pack, small need) |
| `NO_USAGE_DATA` | par came only from `min_par`/override, or par is 0 |
| `EDITED` | pharmacist changed `final_boxes` |

## 6. Workflows

### One-time setup (admin, Sheet UI)
1. Paste the IT report into **Import** → menu **IPD › นำเข้าข้อมูลการใช้ยา** → enter the period dates.
   The script aggregates by `it_name`, writes **Usage**, and lists unmatched names.
2. Fill **Drugs**: `opd_name`, `pack_size`, `unit`, `stocked`, `critical`, `location`, `shelf_order`. Decide on the 35 zero-usage items (`stocked`, `min_par`).
3. Menu **IPD › คำนวณยอดที่ควรมีใหม่** → writes `avg_daily_use`, `par_calc`, `par_updated`.

### Weekly round (web app)
1. **Count** (technician, phone). Opens the current round, created automatically for the week. The list is grouped by location in `shelf_order`. Each row has drug name, unit, a critical badge, and two inputs: **full boxes** and **loose units**, so nobody multiplies by pack size. Each row autosaves, so a half-finished count survives interruptions. A progress bar shows "counted 87/112". The **ส่งให้เภสัชตรวจ** button sets status `REVIEW`.
2. **Review** (pharmacist). Flagged lines come first, the rest are collapsed. `final_boxes` is editable and requires a short reason when changed. **อนุมัติ** freezes the round (`APPROVED`).
3. **Print / send**. An A4 page in OPD form layout (ลำดับ / รายการ / จำนวนเบิก / หมายเหตุ=IPD), only lines with `final_boxes > 0`, with a signature line for the pharmacist. A **คัดลอก** button copies tab-separated rows for pasting into OPD's form if it is electronic.

Status flow: `COUNTING → REVIEW → APPROVED`. A pharmacist can send a round back to `COUNTING`. Approved rounds are read-only.

### Quarterly (admin)
Repeat setup steps 1 and 3 with the latest 3 months from IT. Par changes take effect from the next round only.

## 7. Access and privacy

- **Recommended:** web app deployed as *Execute as: user accessing*, and the Sheet shared (editor) with the 2–4 people in **Users**. This gives real identities for `counted_by` / `reviewed_by` at no extra cost. It needs every user to have a Google account (**open question 1**).
- Fallback if staff have no Google accounts: *Execute as: me*, with each user picking their name from a list. This is weaker: anyone holding the URL could submit. Acceptable only while the URL stays inside the team.
- The database holds **aggregated per-drug usage only**. If IT's daily report contains patient columns (HN, names), the import step drops them and clears the **Import** tab after aggregating.
- Git holds code and docs only. `.clasp.json` (script ID) is gitignored. No drug usage data is committed.

## 8. Repository layout

```
src/                 Apps Script project root (clasp rootDir)
  appsscript.json
  Code.js  Calc.js  Db.js  Import.js  Rounds.js
  ui/ Count.html  Review.html  Print.html  Styles.html
test/calc.test.js    node --test, covers Calc.js only
docs/                PRD, DESIGN
```

Plain JavaScript (V8 runtime), no build step, so anyone can open the script in the Apps Script editor and read it.

## 9. Milestones

| # | Deliverable | Done when |
| :- | :- | :- |
| M0 | Decisions + data | Open questions below answered; IT report sample in hand; drug master filled for stocked items |
| M1 | Sheet schema + `Calc.js` + tests + import/recompute menu | Par for every stocked drug, matches hand calculation for 5 sample drugs |
| M2 | Count page | Technician completes a real count on phone in ≤ current time |
| M3 | Review + print page | OPD accepts the printout without rewriting anything |
| M4 | 1-month pilot | PRD §8 metrics recorded weekly |

## 10. Open questions (blocking design decisions)

1. **Accounts and devices.** Do the technician and pharmacist have Google accounts, and will they use a phone to count? (Decides §7 and whether the count page is mobile-first.)
2. **Lead time.** On which day and time is the count actually done, relative to Wednesday's delivery? (Sets `lead_days`. Discussion note for IPD staff is being prepared.)
3. **Multiple locations.** Is any drug kept in more than one place (e.g. cabinet + drawer)? If yes, counts need one row per drug-location.
4. **Partial packs.** Can the warehouse issue less than a full box (e.g. 1x100 out of a 1000-tablet pack)? Decides whether `OVERSHOOT` is just a warning or the box size per drug should be an "issue unit" rather than the manufacturer pack.
5. **OPD form.** Is OPD's requisition form paper or Excel/Sheets? Is the IPD list appended or a separate sheet (PRD Q2)? Decides print vs copy-paste output.
6. **IT report columns.** We need a sample file (patient columns removed) to write the importer.
7. **Buffer.** Use 3 days for normal drugs and 5 for HAD, as assumed above?
