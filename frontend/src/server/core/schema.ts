// Generated from core/schema.sql and core/schema_nse.sql. Base tables for every module.

export const SCHEMA_BSE = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

-- Every listed security on BSE.
CREATE TABLE IF NOT EXISTS scrip (
    scrip_cd     TEXT PRIMARY KEY,
    scrip_id     TEXT,
    scrip_name   TEXT,
    issuer_name  TEXT,
    isin         TEXT,
    grp          TEXT,
    face_value   REAL,
    industry     TEXT,
    segment      TEXT,
    status       TEXT,
    market_cap   REAL,
    url          TEXT,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_scrip_isin ON scrip(isin);
CREATE INDEX IF NOT EXISTS ix_scrip_id   ON scrip(scrip_id);

-- Daily EOD bars, from the official Bhavcopy.
CREATE TABLE IF NOT EXISTS bhavcopy (
    trade_date   TEXT NOT NULL,
    scrip_cd     TEXT NOT NULL,
    ticker       TEXT,
    isin         TEXT,
    series       TEXT,
    instrument   TEXT,
    open         REAL,
    high         REAL,
    low          REAL,
    close        REAL,
    last         REAL,
    prev_close   REAL,
    volume       INTEGER,
    turnover     REAL,
    num_trades   INTEGER,
    PRIMARY KEY (trade_date, scrip_cd, series, instrument)
);
CREATE INDEX IF NOT EXISTS ix_bhav_scrip ON bhavcopy(scrip_cd, trade_date);
CREATE INDEX IF NOT EXISTS ix_bhav_date  ON bhavcopy(trade_date);

-- Which dates we have already pulled (so re-runs are cheap and holidays
-- are not retried forever).
CREATE TABLE IF NOT EXISTS bhavcopy_day (
    trade_date TEXT PRIMARY KEY,
    status     TEXT NOT NULL,      -- ok | nodata | error
    rows       INTEGER DEFAULT 0,
    fetched_at TEXT NOT NULL,
    note       TEXT
);

-- Corporate announcements / filings.
CREATE TABLE IF NOT EXISTS announcement (
    news_id     TEXT PRIMARY KEY,
    scrip_cd    TEXT,
    headline    TEXT,
    category    TEXT,
    subcategory TEXT,
    news_dt     TEXT,
    pdf_name    TEXT,
    pdf_url     TEXT,
    body        TEXT,
    fetched_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ann_scrip ON announcement(scrip_cd, news_dt);
CREATE INDEX IF NOT EXISTS ix_ann_dt    ON announcement(news_dt);

CREATE TABLE IF NOT EXISTS announcement_day (
    day        TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    rows       INTEGER DEFAULT 0,
    fetched_at TEXT NOT NULL
);

-- Dividends, splits, bonuses, rights...
CREATE TABLE IF NOT EXISTS corp_action (
    scrip_cd    TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    ex_date     TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    bc_from     TEXT NOT NULL DEFAULT '',
    bc_to       TEXT,
    amount      REAL,
    security    TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (scrip_cd, purpose, ex_date, record_date, bc_from)
);
CREATE INDEX IF NOT EXISTS ix_ca_ex ON corp_action(ex_date);

-- BSE indices and their values.
CREATE TABLE IF NOT EXISTS bse_index (
    index_code TEXT PRIMARY KEY,
    index_name TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS index_value (
    index_code TEXT NOT NULL,
    as_of      TEXT NOT NULL,
    value      REAL,
    change     REAL,
    pct_change REAL,
    open       REAL,
    high       REAL,
    low        REAL,
    prev_close REAL,
    PRIMARY KEY (index_code, as_of)
);

-- Point-in-time quote snapshots (only what you explicitly snapshot).
CREATE TABLE IF NOT EXISTS quote_snapshot (
    scrip_cd   TEXT NOT NULL,
    as_of      TEXT NOT NULL,
    ltp        REAL,
    change     REAL,
    pct_change REAL,
    raw        TEXT,
    PRIMARY KEY (scrip_cd, as_of)
);

-- YOUR broker holdings / watchlist. Never scraped - pulled via broker API.
CREATE TABLE IF NOT EXISTS holding (
    broker     TEXT NOT NULL,
    as_of      TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    isin       TEXT,
    exchange   TEXT,
    quantity   REAL,
    avg_price  REAL,
    last_price REAL,
    pnl        REAL,
    raw        TEXT,
    PRIMARY KEY (broker, as_of, symbol, exchange)
);

CREATE TABLE IF NOT EXISTS watchlist (
    name       TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    scrip_cd   TEXT,
    exchange   TEXT,
    source     TEXT,               -- 'manual' | broker name
    added_at   TEXT NOT NULL,
    PRIMARY KEY (name, symbol, exchange)
);

-- Alert rules and the log of what already fired (dedupe).
CREATE TABLE IF NOT EXISTS alert_rule (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL,      -- announcement | price_move | corp_action
    params     TEXT NOT NULL,      -- JSON
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_sent (
    rule_name  TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    sent_at    TEXT NOT NULL,
    channel    TEXT,
    PRIMARY KEY (rule_name, dedupe_key)
);

-- Run bookkeeping.
CREATE TABLE IF NOT EXISTS run_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task       TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    status     TEXT,
    rows       INTEGER DEFAULT 0,
    message    TEXT
);
`;

export const SCHEMA_NSE = `
-- NSE tables. BSE tables live in schema.sql and keep their original,
-- unprefixed names; everything NSE-specific is prefixed nse_.

-- Every equity listed on NSE (from EQUITY_L.csv).
CREATE TABLE IF NOT EXISTS nse_symbol (
    symbol       TEXT PRIMARY KEY,
    company      TEXT,
    series       TEXT,
    listing_date TEXT,
    paid_up      REAL,
    market_lot   INTEGER,
    isin         TEXT,
    face_value   REAL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_nsesym_isin ON nse_symbol(isin);

-- Daily EOD bars from the UDiFF bhavcopy.
CREATE TABLE IF NOT EXISTS nse_bhavcopy (
    trade_date  TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    series      TEXT NOT NULL DEFAULT '',
    instrument  TEXT NOT NULL DEFAULT '',
    isin        TEXT,
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    last        REAL,
    prev_close  REAL,
    settle      REAL,
    volume      INTEGER,
    turnover    REAL,
    num_trades  INTEGER,
    open_int    REAL,
    expiry      TEXT,
    strike      REAL,
    option_type TEXT,
    PRIMARY KEY (trade_date, symbol, series, instrument, expiry, strike, option_type)
);
CREATE INDEX IF NOT EXISTS ix_nsebhav_sym  ON nse_bhavcopy(symbol, trade_date);
CREATE INDEX IF NOT EXISTS ix_nsebhav_date ON nse_bhavcopy(trade_date);

CREATE TABLE IF NOT EXISTS nse_bhavcopy_day (
    trade_date TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    rows       INTEGER DEFAULT 0,
    fetched_at TEXT NOT NULL,
    note       TEXT
);

-- Corporate announcements / filings.
CREATE TABLE IF NOT EXISTS nse_announcement (
    ann_id     TEXT PRIMARY KEY,
    symbol     TEXT,
    company    TEXT,
    subject    TEXT,
    details    TEXT,
    ann_dt     TEXT,
    pdf_url    TEXT,
    fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_nseann_sym ON nse_announcement(symbol, ann_dt);
CREATE INDEX IF NOT EXISTS ix_nseann_dt  ON nse_announcement(ann_dt);

-- Dividends, splits, bonuses.
CREATE TABLE IF NOT EXISTS nse_corp_action (
    symbol      TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    ex_date     TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL DEFAULT '',
    series      TEXT,
    company     TEXT,
    isin        TEXT,
    face_value  REAL,
    bc_start    TEXT,
    bc_end      TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (symbol, purpose, ex_date, record_date)
);
CREATE INDEX IF NOT EXISTS ix_nseca_ex ON nse_corp_action(ex_date);

-- Indices and their values.
CREATE TABLE IF NOT EXISTS nse_index (
    index_symbol TEXT PRIMARY KEY,
    index_name   TEXT,
    grp          TEXT,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nse_index_value (
    index_symbol TEXT NOT NULL,
    as_of        TEXT NOT NULL,
    last         REAL,
    variation    REAL,
    pct_change   REAL,
    open         REAL,
    high         REAL,
    low          REAL,
    prev_close   REAL,
    year_high    REAL,
    year_low     REAL,
    pe           REAL,
    pb           REAL,
    div_yield    REAL,
    PRIMARY KEY (index_symbol, as_of)
);

CREATE TABLE IF NOT EXISTS nse_index_constituent (
    index_symbol TEXT NOT NULL,
    symbol       TEXT NOT NULL,
    company      TEXT,
    industry     TEXT,
    isin         TEXT,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (index_symbol, symbol)
);

-- Company fundamentals.
CREATE TABLE IF NOT EXISTS nse_financial_result (
    symbol       TEXT NOT NULL,
    period_end   TEXT NOT NULL DEFAULT '',
    consolidated TEXT NOT NULL DEFAULT '',
    audited      TEXT,
    company      TEXT,
    broadcast_dt TEXT,
    xbrl_url     TEXT,
    raw          TEXT,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (symbol, period_end, consolidated)
);

CREATE TABLE IF NOT EXISTS nse_shareholding (
    symbol       TEXT NOT NULL,
    as_of_date   TEXT NOT NULL DEFAULT '',
    company      TEXT,
    isin         TEXT,
    promoter     REAL,
    public       REAL,
    emp_trusts   REAL,
    broadcast_dt TEXT,
    raw          TEXT,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (symbol, as_of_date)
);

CREATE TABLE IF NOT EXISTS nse_board_meeting (
    symbol      TEXT NOT NULL,
    meeting_dt  TEXT NOT NULL DEFAULT '',
    purpose     TEXT,
    description TEXT,
    company     TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (symbol, meeting_dt, purpose)
);

CREATE TABLE IF NOT EXISTS nse_insider_trade (
    symbol      TEXT NOT NULL,
    acquirer    TEXT NOT NULL DEFAULT '',
    broadcast   TEXT NOT NULL DEFAULT '',
    company     TEXT,
    security    TEXT,
    quantity    REAL,
    value       REAL,
    txn_type    TEXT,
    raw         TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (symbol, acquirer, broadcast)
);

-- Figures parsed out of the XBRL behind each result filing.
-- Amounts are in rupees; divide by 1e7 for crore.
CREATE TABLE IF NOT EXISTS nse_fundamental (
    symbol         TEXT NOT NULL,
    period_end     TEXT NOT NULL DEFAULT '',
    consolidated   TEXT NOT NULL DEFAULT '',
    company        TEXT,
    revenue        REAL,
    other_income   REAL,
    total_income   REAL,
    total_expenses REAL,
    pbt            REAL,
    pat            REAL,
    eps_basic      REAL,
    eps_diluted    REAL,
    equity_capital REAL,
    xbrl_url       TEXT,
    -- 'ok' when income - expenses reconciles to PBT; 'suspect' otherwise.
    -- Revenue tagging varies between filers, so treat revenue as best-effort
    -- and prefer pat / eps, which cross-check against share count.
    quality        TEXT,
    net_margin     REAL,
    fetched_at     TEXT NOT NULL,
    PRIMARY KEY (symbol, period_end, consolidated)
);
CREATE INDEX IF NOT EXISTS ix_fund_symbol ON nse_fundamental(symbol, period_end);

-- Daily OHLC and valuation for every NSE index (ind_close_all archive).
CREATE TABLE IF NOT EXISTS nse_index_history (
    index_name   TEXT NOT NULL,
    display_name TEXT,
    trade_date   TEXT NOT NULL,
    open         REAL,
    high         REAL,
    low          REAL,
    close        REAL,
    pts_change   REAL,
    pct_change   REAL,
    volume       REAL,
    turnover_cr  REAL,
    pe           REAL,
    pb           REAL,
    div_yield    REAL,
    PRIMARY KEY (index_name, trade_date)
);
CREATE INDEX IF NOT EXISTS ix_idxhist_date ON nse_index_history(trade_date);

CREATE TABLE IF NOT EXISTS nse_index_history_day (
    trade_date TEXT PRIMARY KEY,
    status     TEXT NOT NULL,
    rows       INTEGER DEFAULT 0,
    fetched_at TEXT NOT NULL
);
`;
