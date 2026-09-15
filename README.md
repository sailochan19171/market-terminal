# Market Terminal — Indian market research (BSE + NSE)

A local research site for Indian equities: prices, indices, market summary and market watch, company dashboards
with results, balance sheets, cash flows and shareholding, stored point-in-time analyses, screens, filings,
portfolio (broker CSV or CAS statement import), watchlist and alerts.

Everything runs in one Next.js app. The API routes, the data pipeline and the background jobs are TypeScript
in `frontend/`; there is no separate backend server.

---

## Run it

Requirements: **Node.js 22.16+** (the app uses Node's built-in `node:sqlite`) and Google Chrome (only for the
browser tests).

```bash
cd frontend
npm install
cp ../.env.example ../.env      # optional: alerts, broker credentials, tuning
npm run build
npm start                       # http://localhost:3000
```

`npm start` also launches the background job runner as a child process. It:

- parses result filings (XBRL) into quarterly figures, balance sheets, cash flows and shareholding;
- refreshes a company within seconds when its page is opened and its filings are not read yet;
- runs the end-of-day update on weekdays at 19:30 IST (and catches up if the machine was off);
- rebuilds derived metrics and stored analyses as new data arrives.

Set `MARKET_JOBS=off` to run the site without jobs. Job progress: `data/logs/jobs.log`, or `/api/v2/jobs`.

On Windows, `start-app.ps1` starts the app and can be registered to run at logon (instructions in the file).

### First run: building the database

The SQLite database lives in `data/bse.db` (not in git). Backfill it with the command line:

```bash
cd frontend
npm run market -- init
npm run market -- sync-all --years 2        # BSE: scrips, indices, corporate actions, bhavcopy, announcements
npm run market -- nse-sync-all --years 2    # NSE: symbols, indices, corporate data, bhavcopy
npm run market -- nse-index-history --years 5
npm run market -- metrics
npm run market -- status
```

After that the job runner keeps it current. `npm run market -- help` lists every command (portfolio import,
watchlist, alert rules, broker sync, single sources).

---

## Project layout

```
frontend/
  src/app/                 pages (App Router) and API routes (src/app/api/**/route.ts)
  src/components/          UI: header, dashboard, charts, market widgets, loaders
  src/server/              backend (no Next.js imports)
    bse/, nse/             exchange clients and data sources (bhavcopy, filings, XBRL, live feeds)
    core/                  schema, metrics, analyses, portfolio, CAS parser, search index
    alerts/, brokers/      alert rules and channels (Telegram, email, desktop); broker adapters
    api/                   services behind the API routes
    jobs/                  job runner, worker, daily scheduler, CLI commands
    cli.ts                 `npm run market -- <command>`
  src/instrumentation.ts   starts the job runner with the web server
  tests/e2e/               Playwright browser suites (`npm run e2e`)
start-app.ps1              Windows launcher / logon task
.env.example               configuration template
```

---

## Data sources

Every endpoint was probed against the live exchange sites before being wired in.

### BSE

| Data | Source |
|---|---|
| Security master (code, ISIN, group, face value, market cap) | `ListofScripData/w` |
| Daily EOD OHLCV for every traded security | Bhavcopy CSV |
| Corporate announcements and filings, with PDF links | `AnnSubCategoryGetData/w` |
| Corporate actions: dividends, splits, bonuses | `Corpaction/w`, `CorporateAction/w` |
| Index master and values | `IndexList/w`, `IndexMasterNew_ng/w` |

### NSE

| Data | Source |
|---|---|
| Equity master | `EQUITY_L.csv` |
| Daily EOD OHLCV (UDiFF, legacy format before July 2024) | `BhavCopy_NSE_CM_*.csv.zip` |
| Announcements, corporate actions, board meetings, insider trades | `/api/corporate-*`, `/api/corporates-pit` |
| Quarterly results, including integrated filings from 2025 | `/api/corporates-financial-results`, `/api/integrated-filing-results` |
| Results, balance sheet, cash flow and shareholding figures | XBRL filings on nsearchives |
| Indices with OHLC, PE, PB, dividend yield; constituents; daily history | `/api/allIndices`, `ind_*list.csv`, `ind_close_all_*.csv` |
| Live market pulse: market status, gainers/losers, volume spurts, 52-week highs/lows | `/api/marketStatus`, `/api/live-analysis-*` |

### What it deliberately does not do

- It does not crawl the exchange websites page by page; it reads the JSON and file endpoints the sites
  themselves use, and every client throttles itself.
- It does not bypass access controls. NSE endpoints protected by Akamai Bot Manager are not collected; the
  client stops with an error instead.
- Your portfolio and watchlist are never scraped: they come from your broker's official API with your own
  credentials, a broker CSV export, or a CAS PDF you upload. The CAS password is used in memory only and is
  never stored or logged.

---

## Configuration

Copy `.env.example` to `.env` in the repository root. Everything is optional:

- `ALERT_CHANNELS` with Telegram / SMTP settings for alerts;
- `BROKER` with Zerodha, Upstox or Angel One credentials for your own holdings;
- `MARKET_JOBS=off` to disable background jobs; `FUNDAMENTALS_WORKERS`, `FUNDAMENTALS_RPS` to tune parsing.

`.env` and `data/` are gitignored. Never commit real credentials.

---

## Tests

```bash
cd frontend
npx tsc --noEmit
npm run e2e          # dashboard and market-page browser suites against http://localhost:3000
```

Figures are derived from exchange filings and may be incomplete; check the source documents before acting
on them. This project is not affiliated with NSE or BSE.
