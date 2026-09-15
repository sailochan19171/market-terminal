// Balance sheet and cash flow line definitions for NSE result XBRL (Ind-AS corporate and banking formats).
// [key, label, tags in priority order, level] - level 0 = total/heading, 1 = line, 2 = sub-line.
export type LineDef = [key: string, label: string, tags: string[], level: number];

export const BALANCE_SHEET: Record<"corporate" | "bank", LineDef[]> = {
  corporate: [
    ["ppe", "Property, plant and equipment", ["PropertyPlantAndEquipment"], 1],
    ["cwip", "Capital work in progress", ["CapitalWorkInProgress"], 1],
    ["goodwill", "Goodwill", ["Goodwill"], 1],
    ["intangibles", "Other intangible assets", ["OtherIntangibleAssets"], 1],
    ["noncurrent_investments", "Non-current investments", ["NoncurrentInvestments"], 1],
    ["noncurrent_assets", "Non-current assets", ["NoncurrentAssets"], 0],
    ["inventories", "Inventories", ["Inventories"], 1],
    ["receivables", "Trade receivables", ["TradeReceivablesCurrent"], 1],
    ["cash", "Cash and cash equivalents", ["CashAndCashEquivalents"], 1],
    ["current_investments", "Current investments", ["CurrentInvestments"], 1],
    ["current_assets", "Current assets", ["CurrentAssets"], 0],
    ["total_assets", "Total assets", ["Assets"], 0],
    ["share_capital", "Equity share capital", ["EquityShareCapital"], 1],
    ["other_equity", "Other equity (reserves)", ["OtherEquity"], 1],
    ["owners_equity", "Equity attributable to owners", ["EquityAttributableToOwnersOfParent"], 1],
    ["minority", "Non-controlling interest", ["NonControllingInterest"], 1],
    ["equity", "Total equity", ["Equity"], 0],
    ["borrowings_noncurrent", "Long-term borrowings", ["BorrowingsNoncurrent"], 1],
    ["noncurrent_liabilities", "Non-current liabilities", ["NoncurrentLiabilities"], 0],
    ["borrowings_current", "Short-term borrowings", ["BorrowingsCurrent"], 1],
    ["payables", "Trade payables", ["TradePayablesCurrent"], 1],
    ["current_liabilities", "Current liabilities", ["CurrentLiabilities"], 0],
    ["total_liabilities", "Total liabilities", ["Liabilities"], 0],
    ["equity_and_liabilities", "Total equity and liabilities", ["EquityAndLiabilities"], 0],
  ],
  bank: [
    ["share_capital", "Capital", ["Capital"], 1],
    ["reserves", "Reserves and surplus", ["ReservesAndSurplus"], 1],
    ["deposits", "Deposits", ["Deposits"], 1],
    ["borrowings", "Borrowings", ["Borrowings"], 1],
    ["other_liabilities", "Other liabilities and provisions", ["OtherLiabilitiesAndProvisions"], 1],
    ["equity_and_liabilities", "Total capital and liabilities", ["CapitalAndLiabilities"], 0],
    ["cash_rbi", "Cash and balances with RBI", ["CashAndBalancesWithReserveBankOfIndia"], 1],
    ["bank_balances", "Balances with banks, call money", ["BalancesWithBanksAndMoneyAtCallAndShortNotice"], 1],
    ["investments", "Investments", ["Investments"], 1],
    ["advances", "Advances (loans)", ["Advances"], 1],
    ["fixed_assets", "Fixed assets", ["FixedAssets"], 1],
    ["other_assets", "Other assets", ["OtherAssets"], 1],
    ["total_assets", "Total assets", ["Assets"], 0],
  ],
};

export const CASH_FLOW: LineDef[] = [
  ["cfo", "Cash from operating activities", ["CashFlowsFromUsedInOperatingActivities"], 0],
  ["taxes_paid", "Income taxes paid", ["IncomeTaxesPaidRefundClassifiedAsOperatingActivities"], 2],
  ["capex", "Purchase of fixed assets (capex)", ["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "PurchaseOfTangibleAssetsClassifiedAsInvestingActivities"], 1],
  ["asset_sales", "Sale of fixed assets", ["ProceedsFromSalesOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "ProceedsFromSalesOfTangibleAssetsClassifiedAsInvestingActivities"], 2],
  ["cfi", "Cash from investing activities", ["CashFlowsFromUsedInInvestingActivities"], 0],
  ["borrowings_raised", "Borrowings raised", ["ProceedsFromBorrowingsClassifiedAsFinancingActivities"], 1],
  ["borrowings_repaid", "Borrowings repaid", ["RepaymentsOfBorrowingsClassifiedAsFinancingActivities"], 1],
  ["dividends_paid", "Dividends paid", ["DividendsPaidClassifiedAsFinancingActivities"], 1],
  ["interest_paid", "Interest paid", ["InterestPaidClassifiedAsFinancingActivities"], 2],
  ["shares_issued", "Shares issued", ["ProceedsFromIssuingShares", "ProceedsFromIssuingSharesClassifiedAsFinancingActivities"], 2],
  ["cff", "Cash from financing activities", ["CashFlowsFromUsedInFinancingActivities"], 0],
  ["net_change", "Net change in cash", ["IncreaseDecreaseInCashAndCashEquivalents"], 0],
  ["closing_cash", "Cash at end of period", ["CashAndCashEquivalentsCashFlowStatement"], 1],
];

/** Lines filed as positive outflows; stored negative so each section sums visibly. */
export const OUTFLOWS = new Set(["taxes_paid", "capex", "borrowings_repaid", "dividends_paid", "interest_paid"]);
export const DERIVED: Record<string, string> = { fcf: "Free cash flow (operating − capex)" };

export const STATEMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS nse_statement (
    symbol        TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    consolidated  TEXT NOT NULL,
    kind          TEXT NOT NULL,
    months        INTEGER,
    report_format TEXT,
    data          TEXT,
    xbrl_url      TEXT,
    fetched_at    TEXT NOT NULL,
    PRIMARY KEY (symbol, period_end, consolidated, kind)
);`;
