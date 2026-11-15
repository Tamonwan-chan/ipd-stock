# CLAUDE.md

Context for Claude Code sessions on this repo.

## Project

Weekly drug stock and requisition tool for a hospital inpatient pharmacy (IPD). IPD has no stock system of its own; its requisition is added to the OPD pharmacy's weekly warehouse requisition. Built on Google Apps Script + Google Sheets (the Sheet is the database).

- Requirements: [docs/PRD.md](docs/PRD.md) (Thai; snapshot of a Google Doc co-edited with IPD staff, titled "PRD IPD stock")
- Design and decisions: [docs/DESIGN.md](docs/DESIGN.md), the source of truth for formulas, data model and open questions
- Status summary for staff: [README.md](README.md) (Thai)

## Status

- Done: PRD, design v0.3, `src/Calc.js` (pure calculation functions) with tests, `tools/backtest.js`.
- Next: Sheet schema + `Db.js`, `Import.js` (HOSxP paste → UsageDaily/Drugs, recompute par), then the count/review/output web app. See DESIGN §9 for questions still open with IPD staff.

## Commands

```
npm test                                   # unit tests (node --test), no dependencies
npm run backtest -- data/raw/<export>.csv --split 2026-10-01 [--z 1.65] [--delay 3]
```

## Rules

- **Public repo.** Never commit hospital data, spreadsheet/script IDs, `.clasp.json`, or per-drug usage numbers. HOSxP exports go in `data/raw/` (gitignored). Docs may quote aggregates only.
- The usage data lives in the owner's private Google Sheet "IPD Stock" (HOSxP daily export, Aug–Oct 2026). To work with it locally, download it as CSV into `data/raw/`.
- `src/Calc.js` must stay free of Apps Script services so it runs in Node; it exposes the global `Calc` and `module.exports`. Dates inside Calc are ISO `YYYY-MM-DD` strings.
- Plain JavaScript (Apps Script V8), no build step.
- Language: code, comments and DESIGN in English; anything IPD staff read (README, UI text, printouts) in Thai.
- Git identity for commits: `Tamonwan-chan <305665671+Tamonwan-chan@users.noreply.github.com>` (keeps the owner's personal email out of public history). Set it per repo: `git config user.email ...`.
