# CLAUDE.md

Context for Claude Code sessions on this repo.

## Project

Drug stock and requisition tool for a hospital inpatient pharmacy (IPD). IPD has no stock system of its own. It requests from main storage (คลัง) every 2 weeks on the paper form ใบเบิกหรือใบส่งคืน, and fetches low-use drugs (used less than weekly) from the OPD pharmacy. Everything is in units; pack sizes are not tracked (they change too often). Built on Google Apps Script + Google Sheets (the Sheet is the database).

- Requirements: [docs/PRD.md](docs/PRD.md) (Thai; snapshot of a Google Doc co-edited with IPD staff, titled "PRD IPD stock")
- Design and decisions: [docs/DESIGN.md](docs/DESIGN.md), the source of truth for formulas, data model and open questions
- Status summary for staff: [README.md](README.md) (Thai)

## Status

- Done: PRD, design v0.4 (2-week cycle, use-frequency rule for main storage vs OPD, shelf min, main-storage form), `src/Calc.js` (pure calculation functions), `src/Schema.js` + `src/Db.js` (Sheet tabs, read/write as objects), `src/Import.js` (HOSxP rows → Drugs/UsageDaily, recompute), `src/Api.js` + `src/ui/` (web app: import file, count with max/min, BELOW_MIN and optional boxes × units per box, main-storage form, delivery check from main storage, OPD request + receive with urgent-trip count, min/max shelf list), `src/Auth.js` (logins, sessions), `src/Code.js` (doGet + IPD menu), all server code tested; `tools/backtest.js`. The 1-pack rule and `tools/pack-rule.js` were removed on 16 Nov 2026.
- Deployed with `clasp push` to the Apps Script project bound to the private "IPD Stock" Sheet. `.clasp.json` (script ID) is local only; on another PC, recreate it from the script ID in the Apps Script editor (Project Settings), with `"rootDir": "src"`.
- Open decisions are tracked as GitHub issues (#1–#4) and in DESIGN §9.
- Web app v2 (18 Nov 2026, branch `ui-redesign`): own logins (`src/Auth.js`, Users tab, roles staff/admin, ChangeLog of every change), left-menu layout (home, medicine list + stock card with add/edit, เบิกยา main storage or OPD with a printed count sheet, delivery checks with several expiry dates per line, admin users + change log). Pushed to the test deployment (@HEAD /dev URL); live deployment still v12. Expiry alerts come later.
- 20 Nov 2026, after the first teaching round with staff (not UAT yet): menu in work order, ใบเบิกพิเศษ (`Rounds.kind = EXTRA`, `Api.createExtraRequest` / `cancelExtraRequest`), warning at the delivery check for expiry within 3 months, stock card reloads when รายการยา is shown again (the OPD delivery "missing" from the card was a stale card), icon credit moved into the About dialog.
- Web app v1 deployed (owner-only access). The browser code in `src/ui/Client.html` has no automated tests beyond a parse check; try changes in the deployed page.
- Next: feedback from IPD staff on the web app; widen web app access (DESIGN §7). See DESIGN §9 for questions still open with IPD staff.

## Commands

```
npm test                                   # unit tests (node --test), no dependencies
npm run backtest -- data/raw/<export>.csv --split 2026-10-01 [--z 1.65] [--delay 3] [--cycle 14]
clasp push                                 # upload src/ to the bound Apps Script project (needs .clasp.json)
clasp update-deployment <deploymentId>     # publish the pushed code to the web app URL (ID: clasp list-deployments)
```

clasp 3: to bind a script to an existing Sheet, use `clasp create-script --parentId <sheetId> --rootDir src` **without** `--type`. With `--type sheets` it ignores `--parentId` and creates a new, empty spreadsheet. `create-script` also overwrites `src/appsscript.json` with a default (New York time zone): restore it with `git checkout -- src/appsscript.json` before pushing.

## Rules

- **Public repo.** Never commit hospital data, spreadsheet/script IDs, `.clasp.json`, or per-drug usage numbers. HOSxP exports go in `data/raw/` (gitignored). Docs may quote aggregates only.
- The usage data lives in the owner's private Google Sheet "IPD Stock", tab "Rate Aug-Oct 26" (HOSxP daily export, Aug–Oct 2026). To work with it locally, export it as CSV into `data/raw/` with `order_date` as d/m/yyyy.
- `src/Calc.js` and `src/Schema.js` must stay free of Apps Script services so they run in Node; each exposes a global (`Calc`, `Schema`) and `module.exports`. Dates inside Calc are ISO `YYYY-MM-DD` strings.
- `src/Db.js` touches the Sheet only through the spreadsheet object passed in (default `SpreadsheetApp.getActiveSpreadsheet()`). If it needs a new SpreadsheetApp method, add it to `test/fake-spreadsheet.js` too. Resolve other modules inside functions (`calc_()`, `schema_()`), not at load time: Apps Script file load order isn't guaranteed.
- Plain JavaScript (Apps Script V8), no build step.
- Language: code, comments and DESIGN in English; anything IPD staff read (README, UI text, printouts) in Thai.
- `npm test` runs `node --test "test/*.test.js"` (Node ≥ 22 expands the glob). `node --test test/` fails on Node 24.
- Git identity for commits: `Tamonwan-chan <305665671+Tamonwan-chan@users.noreply.github.com>`. Set it per repo: `git config user.email ...`.
- Credit (owner's `program-credit` skill, 18 Nov 2026): `LICENSE`, the README license section, a header at the top of every source file, the footer + About dialog (เกี่ยวกับโปรแกรม) on every screen, and `PL_CREDIT.line` at the end of every printout and CSV export. The owner chose to show her contact email in these, in this public repo. Keep all of them; give new source files the same header.
