// The order reader, checked: the rules that read a filing, the checks on what the model returns, and the two
// views the dashboard asks for.
//   npm run check:orders
import { Db } from "../src/server/db";
import { amountsInCrore, isRealCustomer, parseByRules, parseWithModel } from "../src/server/orders/extract";
import { annualValue, companyOrders, filterOptions, listOrders } from "../src/server/orders/query";
import { ensureSchema, save } from "../src/server/orders/store";

let failed = 0;
function eq(what: string, got: unknown, want: unknown) {
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) < 0.005 : JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(want)})`}`);
}

const FILING = `
Sub: Intimation of receipt of Letter of Award under Regulation 30 of SEBI (LODR) Regulations, 2015.
We wish to inform you that the Company has received a Letter of Award from Uttar Pradesh Expressways Industrial
Development Authority for collection of user fees at toll plazas. The value of the order is Rs. 220.66 crore
(Rupees Two Hundred Twenty Crore only) exclusive of GST. The completion period is 24 months from the date of award.
Whether domestic or international: Domestic.
`;

async function main() {
  console.log("Reading a filing with the rules alone (no model, no key)");
  {
    const p = parseByRules(FILING);
    eq("the order value is read in crore", p.contractValueCr, 220.66);
    eq("the execution period is read in months", p.durationMonths, 24);
    eq("the customer is the party named after \"from\"", p.customer, "Uttar Pradesh Expressways Industrial Development Authority");
    eq("the kind of order is labelled", p.orderType, "Letter of award");
    eq("it is an order win", p.isOrder, true);
  }

  console.log("\nUnits and currencies");
  {
    eq("lakh becomes crore", amountsInCrore("worth Rs. 250 lakh").map((a) => a.value), [2.5]);
    eq("million becomes crore", amountsInCrore("USD 5 million and Rs. 40 million").map((a) => a.value), [4]);
    eq("a bare rupee figure is not taken as crore", amountsInCrore("Rs. 483.70 towards fees").length, 0);
    eq("a filing with no amount leaves the value empty", parseByRules("The Company has received a work order from Tata Projects Limited.").contractValueCr, null);
    eq("and says which field the filing did not state", parseByRules("Received a work order from Tata Projects Limited.").note, "not stated in the filing: contract value, duration");
  }

  console.log("\nThe disclosure form's own words are not a customer");
  for (const junk of ["Domestic", "domestic/ international entity", "whether domestic or international", "Not applicable", "N.A."]) {
    eq(`"${junk}" is not a customer`, isRealCustomer(junk), false);
  }
  for (const junk of ["the Company in this regard is enclosed", "a Global EPC Company that specialises in bulk", "its esteemed domestic customer", "domestic/"]) {
    eq(`"${junk.slice(0, 32)}..." is not a customer`, isRealCustomer(junk), false);
  }
  for (const real of ["NHAI", "Tata Projects Limited", "M/s. Shree Tatyasaheb Kore Warana SSK Ltd", "Uttar Pradesh Expressways Industrial Development Authority"]) {
    eq(`"${real}" is a customer`, isRealCustomer(real), true);
  }

  console.log("\nThe disclosure form's own words are not a customer");
  for (const junk of ["Domestic", "domestic/ international entity", "whether domestic or international", "Not applicable", "N.A."]) {
    eq(`"${junk}" is not a customer`, isRealCustomer(junk), false);
  }
  for (const real of ["NHAI", "Tata Projects Limited", "Uttar Pradesh Expressways Industrial Development Authority"]) {
    eq(`"${real}" is a customer`, isRealCustomer(real), true);
  }

  console.log("\nThe order's own value, not the largest figure in the filing");
  {
    const press = "PRESS RELEASE GPTINFRA Bags Order Valued at Rs. 483.72 Crore. The Company has received the following contract. Name of the entity awarding the : Chief Project Manager, Rail Vikas Nigam Limited. The order book stands at Rs. 4,992 Crore.";
    eq("a press release's order value beats its order book", parseByRules(press).contractValueCr, 483.72);
    eq("and the customer comes from the labelled line", parseByRules(press).customer, "Chief Project Manager, Rail Vikas Nigam Limited");
    const beml = "BEML Limited has secured an order valued at over Rs. 5,400/- Crores from M/s. National High Speed Rail Corporation Limited (NHSRCL), for the supply of rolling stock.";
    eq("an amount written with /- is read", parseByRules(beml).contractValueCr, 5400);
    eq("and \"from M/s ...\" names the customer", parseByRules(beml).customer, "M/s. National High Speed Rail Corporation Limited (NHSRCL)");
    const rupees = "The contract value is Rs. 23,74,01,563/- (Rupees Twenty-Three Crore Seventy-Four Lakhs Only) Including 18% GST. Name of the entity awarding the order/Contract: M/s Larsen & Toubro Limited.";
    eq("rupees written out in full become crore", parseByRules(rupees).contractValueCr, 23.7401563);
    eq("a bare figure under ten lakh is not taken as an order value", parseByRules("The order value is Rs. 4,500 for stationery.").contractValueCr, null);
  }

  console.log("\nA court or tax order filed under the same category is not an order win");
  eq("a penalty order is rejected", parseByRules("Intimation of adjudication order passed by the Income Tax department imposing a penalty of Rs. 2 crore.").isOrder, false);

  console.log("\nWhat the model returns is checked against the document");
  {
    const rules = parseByRules(FILING);
    const asModel = (reply: Record<string, unknown>) => parseWithModel(FILING, rules, {
      model: "test",
      chatFn: async () => ({ text: JSON.stringify(reply), model: "test", promptTokens: 1, completionTokens: 1, latencyMs: 1 }),
    });
    const invented = await asModel({ is_order: true, customer: "Reliance Industries Limited", contract_value_cr: 9999, duration_months: 24 });
    eq("a customer the filing never names is dropped", invented.customer, "Uttar Pradesh Expressways Industrial Development Authority");
    eq("a value the filing never states is dropped", invented.contractValueCr, 220.66);
    const good = await asModel({ is_order: true, customer: "Uttar Pradesh Expressways Industrial Development Authority", contract_value_cr: 220.66, duration_months: 24, order_type: "Letter of Award", work_scope: "collection of user fees at toll plazas" });
    eq("a reading the filing supports is kept", [good.customer, good.contractValueCr, good.orderType], ["Uttar Pradesh Expressways Industrial Development Authority", 220.66, "Letter of Award"]);
    const wordy = await asModel({ is_order: true, order_type: "Design, Development and Supply of Automatic Test Equipment for radars" });
    eq("a description in the order-type field falls back to the label", wordy.orderType, "Letter of award");
    const notOrder = await asModel({ is_order: false });
    eq("the model may say the filing is not an order", notOrder.isOrder, false);
  }

  console.log("\nAnnual value: a contract is spread over the period it runs");
  {
    eq("a two-year order counts half a year at a time", annualValue(240, 24), 120);
    eq("an order inside a year counts in full", annualValue(60, 8), 60);
    eq("no value, no annual value", annualValue(null, 12), null);
  }

  console.log("\nThe two views, on rows written for this check");
  {
    const db = new Db({ kind: "local", file: ":memory:" });
    db.exec(`CREATE TABLE company_metrics (symbol TEXT PRIMARY KEY, company TEXT, industry TEXT, sales_ttm_cr REAL, basis TEXT, latest_quarter TEXT, market_cap_cr REAL, bse_code TEXT);
             INSERT INTO company_metrics VALUES ('ACME','Acme Engineering Ltd','Construction',1000,'consolidated','2026-06-30',4000,NULL),
                                                ('TINY','Tiny Works Ltd','Construction',50,'standalone','2026-06-30',80,NULL);`);
    ensureSchema(db);
    const row = (id: string, symbol: string, company: string, at: string, value: number | null, months: number | null, exchange = "NSE") => ({
      id, exchange, symbol, scripCd: null, company, announcedAt: at, customer: "NHAI", orderType: "Work order",
      contractValueCr: value, currency: "INR", durationMonths: months, workScope: null, location: null, isOrder: true,
      confidence: 1, extractedBy: "model", model: "test", headline: "order", summary: null, pdfUrl: "https://x/y.pdf",
      pdfChars: 900, note: null,
    });
    const today = new Date().toISOString().slice(0, 19);
    const older = new Date(Date.now() - 200 * 86_400_000).toISOString().slice(0, 19);
    save(db, row("NSE:1", "ACME", "Acme Engineering Ltd", today, 500, 24));
    save(db, row("BSE:1", "ACME", "Acme Engineering Ltd", today, 500, 24, "BSE"));   // the same order, filed twice
    save(db, row("NSE:2", "ACME", "Acme Engineering Ltd", today, 100, 6));
    save(db, row("NSE:3", "TINY", "Tiny Works Ltd", today, 75, 12));
    save(db, row("NSE:4", "ACME", "Acme Engineering Ltd", older, 900, 12));           // outside a 6-month view

    const six = listOrders(db, { months: 6 });
    eq("one order filed with both exchanges is counted once", six.total, 3);
    eq("an order outside the period is left out", six.rows.some((r) => r.contractValueCr === 900), false);
    eq("order size is the annual value against revenue", six.rows.find((r) => r.id === "NSE:1")?.orderSizePct, 25);
    eq("a year-long order counts its whole value", six.rows.find((r) => r.id === "NSE:2")?.orderSizePct, 10);

    eq("filtering by size keeps only the big ones", listOrders(db, { months: 6, minOrderPct: 20 }).total, 2);
    eq("filtering by company works", listOrders(db, { months: 6, company: "TINY" }).total, 1);
    eq("a longer period brings the older order back", listOrders(db, { months: 12 }).total, 4);

    const companies = companyOrders(db, { months: 6 });
    eq("companies are ranked by orders against revenue", companies.map((c) => c.symbol), ["TINY", "ACME"]);
    eq("Tiny's orders are worth more than a year of sales", companies[0].ordersPctOfRevenue, 150);
    eq("Acme's two orders are added up", [companies[1].orderCount, companies[1].totalOrderValueCr], [2, 600]);
    eq("the market cap filter excludes the small one", companyOrders(db, { months: 6, minMarketCapCr: 500 }).map((c) => c.symbol), ["ACME"]);
    eq("the minimum revenue share filter works", companyOrders(db, { months: 6, minRevenuePct: 100 }).map((c) => c.symbol), ["TINY"]);
    eq("a company's own orders come with it", companies[1].orders.length, 2);

    const options = filterOptions(db, { months: 6 });
    eq("the company dropdown offers only companies on screen", options.companies.map((o) => o.value), ["ACME", "TINY"]);
    eq("the customer dropdown is built from the orders", options.customers.map((o) => o.value), ["NHAI"]);
    db.close();
  }

  console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} failed` : "\nAll checks passed");
  process.exit(failed ? 1 : 0);
}

main();
