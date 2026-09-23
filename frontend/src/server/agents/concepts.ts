// explain_concept (spec §3.1): what a ratio means, using the exact formula the engine computes, so the explanation
// and the numbers elsewhere on the page can never disagree.
import type { Persona } from "./config";
import { scrub } from "./compliance";
import type { Trace } from "./trace";

export interface Concept { key: string; name: string; formula: string; reads: string; watch: string }

export const CONCEPTS: Record<string, Concept> = {
  roe: { key: "roe", name: "Return on equity (ROE)", formula: "Net income ÷ average shareholders' equity", reads: "How much profit the business earns on the money shareholders have put in and left in.", watch: "Borrowing can inflate it; compare it with debt to equity, and look for consistency over ten years rather than one good year." },
  roce: { key: "roce", name: "Return on capital employed (ROCE)", formula: "EBIT ÷ (total assets − current liabilities)", reads: "Operating profit earned on all long-term capital, whether it came from shareholders or lenders.", watch: "Not meaningful for banks, whose capital structure is different." },
  roic: { key: "roic", name: "Return on invested capital (ROIC)", formula: "EBIT × (1 − tax rate) ÷ (total debt + equity − cash)", reads: "After-tax operating profit on the capital actually tied up in the business.", watch: "Above the cost of capital, growth creates value; below it, growth destroys it." },
  roa: { key: "roa", name: "Return on assets (ROA)", formula: "Net income ÷ average total assets", reads: "Profit generated per rupee of assets.", watch: "For banks, around 1% or more is typically strong; for industrial companies it varies widely by sector." },
  debtToEquity: { key: "debtToEquity", name: "Debt to equity", formula: "Total debt ÷ shareholders' equity", reads: "How much the company borrows for each rupee of shareholders' money.", watch: "Suppressed when equity is negative. Compare within a sector: utilities normally carry more debt than software firms." },
  interestCoverage: { key: "interestCoverage", name: "Interest coverage", formula: "EBIT ÷ interest expense", reads: "How many times operating profit covers the interest bill.", watch: "Below about 2 leaves little room if profits fall." },
  currentRatio: { key: "currentRatio", name: "Current ratio", formula: "Current assets ÷ current liabilities", reads: "Whether short-term assets cover the bills due within a year.", watch: "Not used for banks and lenders." },
  quickRatio: { key: "quickRatio", name: "Quick ratio", formula: "(Current assets − inventory) ÷ current liabilities", reads: "The current ratio without counting stock that still has to be sold.", watch: "More demanding than the current ratio for inventory-heavy businesses." },
  pe: { key: "pe", name: "Price to earnings (P/E)", formula: "Share price ÷ diluted EPS", reads: "How many rupees the market pays for each rupee of annual earnings.", watch: "Not meaningful when earnings are negative. Compare with the company's own history and its sector, and with its growth (the PEG)." },
  pb: { key: "pb", name: "Price to book (P/B)", formula: "Share price ÷ book value per share", reads: "The price against the accounting value of shareholders' equity.", watch: "Most useful for banks and asset-heavy firms; read it alongside ROE." },
  peg: { key: "peg", name: "PEG ratio", formula: "P/E ÷ (5-year EPS CAGR × 100)", reads: "The P/E adjusted for how fast earnings have grown.", watch: "Around 1 or below is the classic growth-at-a-reasonable-price reading; it relies on past growth continuing." },
  evEbitda: { key: "evEbitda", name: "EV to EBITDA", formula: "(Market cap + total debt − cash) ÷ EBITDA", reads: "The value of the whole business, debt included, against its operating earnings.", watch: "Skipped for financial companies." },
  dividendYield: { key: "dividendYield", name: "Dividend yield", formula: "Dividend per share ÷ share price", reads: "The cash return from dividends at today's price.", watch: "A very high yield can mean the market expects a cut." },
  payoutRatio: { key: "payoutRatio", name: "Payout ratio", formula: "Dividends paid ÷ net income", reads: "The share of profit paid out as dividends.", watch: "Above 100% is paid from reserves or borrowing and cannot last." },
  freeCashFlow: { key: "freeCashFlow", name: "Free cash flow", formula: "Operating cash flow − capital expenditure", reads: "Cash left after keeping the business running and growing, available to repay debt or reward shareholders.", watch: "One heavy capex year can make it negative; look at several years." },
  cashConversion: { key: "cashConversion", name: "Cash conversion", formula: "Operating cash flow ÷ net income", reads: "How much of reported profit arrived as cash.", watch: "Persistently below 1 can mean profits are tied up in receivables or inventory." },
  cashConversionCycle: { key: "cashConversionCycle", name: "Cash conversion cycle", formula: "DSO + DIO − DPO", reads: "Days between paying suppliers and collecting from customers.", watch: "Lengthening over time ties up more working capital." },
  grossMargin: { key: "grossMargin", name: "Gross margin", formula: "Gross profit ÷ revenue", reads: "What is left of each rupee of sales after the direct cost of goods.", watch: "Stable or rising margins can signal pricing power." },
  operatingMargin: { key: "operatingMargin", name: "Operating margin", formula: "Operating income ÷ revenue", reads: "Profit from operations per rupee of sales.", watch: "Compare within a sector." },
  ebitdaMargin: { key: "ebitdaMargin", name: "EBITDA margin", formula: "EBITDA ÷ revenue", reads: "Operating profit before depreciation per rupee of sales.", watch: "Ignores the cost of replacing assets." },
  netMargin: { key: "netMargin", name: "Net profit margin", formula: "Net income ÷ revenue", reads: "Profit after everything, per rupee of sales.", watch: "One-off gains can flatter a single year." },
  revenueCagr5y: { key: "revenueCagr5y", name: "Revenue CAGR", formula: "(End revenue ÷ start revenue)^(1 ÷ years) − 1", reads: "The steady annual growth rate that links two years' revenue.", watch: "Not computed when the starting value is zero or negative." },
  epsCagr5y: { key: "epsCagr5y", name: "EPS CAGR", formula: "(End EPS ÷ start EPS)^(1 ÷ years) − 1", reads: "The compound annual growth in earnings per share.", watch: "Dilution from new shares slows it even when profit grows." },
  netInterestMargin: { key: "netInterestMargin", name: "Net interest margin (NIM)", formula: "Net interest income ÷ average interest-earning assets", reads: "A lender's spread between what it earns on loans and what it pays for funds.", watch: "Specific to banks and NBFCs." },
  costToIncome: { key: "costToIncome", name: "Cost to income", formula: "Operating expenses ÷ (net interest income + other income)", reads: "How much a bank spends to earn each rupee of income.", watch: "Lower is more efficient." },
  creditToDeposit: { key: "creditToDeposit", name: "Credit to deposit", formula: "Total advances ÷ total deposits", reads: "How much of its deposits a bank has lent out.", watch: "Very high levels mean reliance on other, often costlier, funding." },
  gross_npa: { key: "gross_npa", name: "Gross NPA ratio", formula: "Gross non-performing assets ÷ gross advances", reads: "The share of a bank's loans that have stopped paying.", watch: "Not yet parsed on this platform: it appears in the results annexure rather than the XBRL filing." },
  piotroski: { key: "piotroski", name: "Piotroski F-score", formula: "Nine pass/fail tests on profitability, leverage, liquidity and efficiency, scored 0 to 9", reads: "Whether the company's financial position is improving across the board.", watch: "7 or more is usually read as strong, 3 or less as weak." },
  altmanZ: { key: "altmanZ", name: "Altman Z'' score", formula: "6.56 × working capital/assets + 3.26 × retained earnings/assets + 6.72 × EBIT/assets + 1.05 × equity value/liabilities", reads: "A published model of bankruptcy risk.", watch: "Above 2.6 safe, 1.1 to 2.6 grey, below 1.1 distress. Not used for financial companies." },
  beneishM: { key: "beneishM", name: "Beneish M-score", formula: "A weighted combination of eight year-on-year accounting variables", reads: "A published screen for patterns associated with earnings manipulation.", watch: "Above -1.78 is flagged. A flag is a reason to read the accounts, not proof of anything." },
  dupont: { key: "dupont", name: "DuPont analysis", formula: "ROE = net margin × asset turnover × equity multiplier", reads: "Splits ROE into profitability, efficiency and leverage.", watch: "Two companies with the same ROE can get there very differently." },
  marginOfSafety: { key: "marginOfSafety", name: "Margin of safety", formula: "(Intrinsic value − price) ÷ intrinsic value", reads: "How far below an estimate of intrinsic value the price sits.", watch: "The estimate depends on its assumptions; the scenarios show how much." },
  daysInventoryOutstanding: { key: "daysInventoryOutstanding", name: "Days inventory outstanding", formula: "365 ÷ inventory turnover", reads: "How many days of stock the company holds.", watch: "Inventory growing faster than sales can signal slowing demand." },
  daysSalesOutstanding: { key: "daysSalesOutstanding", name: "Days sales outstanding", formula: "365 ÷ receivables turnover", reads: "How long customers take to pay.", watch: "Rising DSO can mean sales are being booked before cash arrives." },
};

export async function explainConcept(trace: Trace, key: string, persona: Persona, question: string): Promise<{ concept: Concept | null; text: string; writtenBy: "data" | "model" }> {
  const concept = CONCEPTS[key] ?? null;
  if (!concept) return { concept: null, text: "That measure is not one this analysis computes yet.", writtenBy: "data" };
  const plain = `${concept.name} = ${concept.formula}. ${concept.reads} ${concept.watch}`;
  const reply = await trace.llm("synthesis", {
    system: `${persona.systemPrompt.replace(/\s+/g, " ")} Explain one financial measure to a beginner in 3-4 plain sentences, in the spirit of an analysis inspired by ${persona.inspiredBy}'s principles, including why that approach cares about it. Use the formula exactly as given. Do not invent figures or examples with numbers. Never speak as ${persona.inspiredBy} and never quote them. No buy or sell language.`,
    user: `QUESTION: ${question}\nMEASURE: ${plain}`,
    temperature: 0.3, maxTokens: 700,
  });
  if (!reply.text) return { concept, text: plain, writtenBy: "data" };
  const cleaned = scrub(reply.text.replace(/[*#`]/g, "")).text;
  return { concept, text: cleaned || plain, writtenBy: cleaned ? "model" : "data" };
}
