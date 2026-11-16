# CLAUDE.md

Context for Claude Code sessions on this repo.

## Project

Drug stock and requisition tool for a hospital inpatient pharmacy (IPD). IPD has no stock system of its own. It requests from main storage (คลัง) every 2 weeks on the paper form ใบเบิกหรือใบส่งคืน, and fetches low-use drugs (busiest 2 weeks under 80% of a pack) from the OPD pharmacy. Built on Google Apps Script + Google Sheets (the Sheet is the database).

- Requirements: [docs/PRD.md](docs/PRD.md) (Thai; snapshot of a Google Doc co-edited with IPD staff, titled "PRD IPD stock")
- Design and decisions: [docs/DESIGN.md](docs/DESIGN.md), the source of truth for formulas, data model and open questions
- Status summary for staff: [README.md](README.md) (Thai)

## Status

- Done: PRD, design v0.4 (2-week cycle, 1-pack rule, main-storage form), `src/Calc.js` (pure calculation functions), `src/Schema.js` + `src/Db.js` (Sheet tabs, read/write as objects) + `src/Code.js` (menu: create tabs), all tested; `tools/backtest.js`, `tools/pack-rule.js`.
- Not yet deployed to the Apps Script project (no `.clasp.json` here).
- Open decisions are tracked as GitHub issues (#1–#4) and in DESIGN §9.
- Next: `Import.js` (HOSxP paste → UsageDaily/Drugs, recompute par), then the count/review/output web app. See DESIGN §9 for questions still open with IPD staff.

## Commands

```
npm test                                   # unit tests (node --test), no dependencies
npm run backtest -- data/raw/<export>.csv --split 2026-10-01 [--z 1.65] [--delay 3] [--cycle 14] [--packs data/raw/pack-sizes.csv]
npm run pack-rule -- data/raw/<export>.csv --packs data/raw/pack-sizes.csv --out data/raw/pack-rule-report.csv
```

## Rules

- **Public repo.** Never commit hospital data, spreadsheet/script IDs, `.clasp.json`, or per-drug usage numbers. HOSxP exports go in `data/raw/` (gitignored). Docs may quote aggregates only.
- The usage data lives in the owner's private Google Sheet "IPD Stock", tab "Rate Aug-Oct 26" (HOSxP daily export, Aug–Oct 2026). To work with it locally, export it as CSV into `data/raw/` with `order_date` as d/m/yyyy. Pack sizes are kept in `data/raw/pack-sizes.csv` (drug_name, strength, drug_unit, pack_size, pack_note).
- `src/Calc.js` and `src/Schema.js` must stay free of Apps Script services so they run in Node; each exposes a global (`Calc`, `Schema`) and `module.exports`. Dates inside Calc are ISO `YYYY-MM-DD` strings.
- `src/Db.js` touches the Sheet only through the spreadsheet object passed in (default `SpreadsheetApp.getActiveSpreadsheet()`). If it needs a new SpreadsheetApp method, add it to `test/fake-spreadsheet.js` too. Resolve other modules inside functions (`calc_()`, `schema_()`), not at load time: Apps Script file load order isn't guaranteed.
- Plain JavaScript (Apps Script V8), no build step.
- Language: code, comments and DESIGN in English; anything IPD staff read (README, UI text, printouts) in Thai.
- `npm test` runs `node --test "test/*.test.js"` (Node ≥ 22 expands the glob). `node --test test/` fails on Node 24.
- Git identity for commits: `Tamonwan-chan <305665671+Tamonwan-chan@users.noreply.github.com>` (keeps the owner's personal email out of public history). Set it per repo: `git config user.email ...`.
