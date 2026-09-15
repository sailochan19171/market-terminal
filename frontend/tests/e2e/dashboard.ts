// End-to-end checks for the company dashboard, run against a running build.
//   npm run e2e:dashboard            (E2E_BASE defaults to http://localhost:3000)
import path from "node:path";
import type { Page, Response } from "playwright";
import { BAD_TEXT, BAD_TEXT_ALL, BASE, check, run, shotDir, sleep, watchErrors, withData } from "./harness";

const OUT = shotDir("dashboard");

async function waitDashboard(page: Page, timeout = 40_000) {
  await page.waitForSelector("h1", { timeout });
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading company dashboard"]'), undefined, { timeout });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout });
  await page.waitForTimeout(900);
}

const mainText = (page: Page) => page.locator("main").innerText();
const h1 = (page: Page) => page.locator("h1").first().innerText();
const badFound = (txt: string) => (txt.match(BAD_TEXT_ALL) ?? []).slice(0, 5);
const toDay = (iso: string) => new Date(`${iso}T00:00:00Z`).getTime();

run(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);

  // ---- 1. every company renders real data through the same code path ----
  const companies: [string, string][] = [["HDFCBANK", "HDFC Bank"], ["ICICIBANK", "ICICI Bank"], ["SBIN", "State Bank"], ["RELIANCE", "Reliance"],
    ["TCS", "Tata Consultancy"], ["INFY", "Infosys"], ["ITC", "ITC"], ["LT", "Larsen"]];
  for (const [sym, name] of companies) {
    const t = Date.now();
    await page.goto(`${BASE}/company/${sym}`, { waitUntil: "domcontentloaded" });
    await waitDashboard(page);
    const title = await h1(page);
    const txt = await mainText(page);
    const kpis = await page.locator(".motion-stagger > div").count();
    const charts = await page.locator("main svg.recharts-surface, main canvas").count();
    const na = txt.split("Not available").length - 1;
    check(`${sym}: summary loads (${((Date.now() - t) / 1000).toFixed(1)}s)`, title.toLowerCase().includes(name.toLowerCase()) && kpis >= 12 && charts >= 4,
      `h1='${title}' kpis=${kpis} charts=${charts} not-available=${na}`);
    check(`${sym}: no undefined/NaN/null rendered`, !BAD_TEXT.test(txt), badFound(txt));
    for (const label of ["Market cap", "Revenue (TTM)", "Net profit (TTM)", "EPS (TTM)", "P/E"]) {
      const card = page.locator(".motion-stagger > div", { hasText: label }).first();
      const val = (await card.innerText()).replace(label, "").trim();
      check(`${sym}: KPI ${label}`, /\d/.test(val) || val.includes("Not available"), val.split("\n")[0]);
    }
    await page.screenshot({ path: path.join(OUT, `summary_${sym}.png`) });
  }

  // ---- 2. unavailable metrics explain themselves ----
  await page.goto(`${BASE}/company/TCS`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  const gp = page.locator(".motion-stagger > div", { hasText: "Gross profit (TTM)" }).first();
  check("TCS gross profit is 'Not available'", (await gp.innerText()).includes("Not available"), await gp.innerText());
  const tip = (await gp.locator("[role=tooltip]").count()) ? await gp.locator("[role=tooltip]").first().innerText() : "";
  check("reason tooltip present", tip.toLowerCase().includes("cost") || tip.toLowerCase().includes("services"), tip);

  // ---- 3. detailed view ----
  await page.getByRole("tab", { name: "Detailed analysis" }).click();
  await page.waitForTimeout(1500);
  check("URL has view=detailed", page.url().includes("view=detailed"), page.url());
  const sections = ["overview", "price", "revenue", "gross-profit", "net-profit", "eps", "shares", "valuation", "profitability",
    "growth", "financials", "performance", "observations", "peers", "documents", "sources"];
  const missing: string[] = [];
  for (const s of sections) if (!(await page.locator(`#${s}`).count())) missing.push(s);
  check("detailed view has all 16 sections", !missing.length, missing);
  let txt = await mainText(page);
  check("detailed: no undefined/NaN/null", !BAD_TEXT.test(txt), badFound(txt));
  await page.locator("#financials").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const fin = await page.locator("table", { hasText: "Revenue" }).first().innerText();
  check("quarterly financial table has figures", (fin.match(/\d{1,3}(,\d{2,3})+/g) ?? []).length > 10, fin.slice(0, 160));
  await page.screenshot({ path: path.join(OUT, "detailed_TCS.png"), fullPage: true });

  // chart tooltip carries company + labelled values
  const revChart = page.locator("section", { hasText: "Revenue" }).locator(".recharts-wrapper").first();
  await revChart.scrollIntoViewIfNeeded();
  const bb = (await revChart.boundingBox())!;
  await page.mouse.move(bb.x + bb.width * 0.9, bb.y + bb.height * 0.5);
  await page.waitForTimeout(500);
  const tt = page.locator(".recharts-tooltip-wrapper").filter({ hasText: "Tata" }).first();
  const ttxt = (await tt.count()) ? await tt.innerText() : "";
  check("revenue tooltip shows company, period and ₹ Cr", ttxt.includes("Tata") && ttxt.includes("₹") && ttxt.includes("Cr"), ttxt.replaceAll("\n", " | "));

  // ---- 4. company switching via the dropdown ----
  await page.goto(`${BASE}/company/TCS?view=detailed&range=3M`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  await page.locator("button[aria-haspopup=listbox]").first().click();
  await page.getByLabel("Search companies", { exact: true }).fill("infosys");
  await page.waitForSelector("[role=option]:has-text('Infosys')", { timeout: 10_000 });
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/company\/INFY/, { timeout: 20_000 });
  await waitDashboard(page);
  check("switch company updates whole dashboard", (await h1(page)).includes("Infosys"), await h1(page));
  check("switch keeps view and range", page.url().includes("view=detailed") && page.url().includes("range=3M"), page.url());

  // ---- 5. date presets drive the data ----
  const captured: Response[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/dashboard")) captured.push(r);
  });
  await page.goto(`${BASE}/company/RELIANCE`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  captured.length = 0;
  await page.getByRole("radio", { name: "1M" }).click();
  await page.waitForURL(/range=1M/);
  await waitDashboard(page);
  const body = captured.length ? await captured[captured.length - 1].json() : {};
  const rng = body.range ?? {};
  const days = (toDay(rng.to ?? "2000-01-01") - toDay(rng.from ?? "2000-01-01")) / 86_400_000;
  check("1M preset fetches a 30-day range", days >= 29 && days <= 31 && (body.prices ?? []).length <= 25, `range=${JSON.stringify(rng)} prices=${(body.prices ?? []).length}`);
  await page.getByRole("radio", { name: "Custom" }).click();
  await page.fill("#range-from", "2025-01-01");
  await page.fill("#range-to", "2025-06-30");
  await withData(page, ["/dashboard", "to=2025-06-30"], () => page.getByRole("button", { name: "Apply" }).click());
  await waitDashboard(page);
  txt = await mainText(page);
  check("custom range switches to historical view", txt.includes("Historical view") && txt.includes("30 Jun 2025"), txt.slice(0, 200).replaceAll("\n", " | "));
  const session = await page.locator("text=/close · /").first().innerText();
  check("header price is as of the chosen date", session.includes("Jun 2025"), session);
  await page.fill("#range-from", "2025-08-01");
  await page.fill("#range-to", "2025-07-01");
  await page.getByRole("button", { name: "Apply" }).click();
  await page.waitForTimeout(400);
  check("invalid custom range is rejected inline", (await page.locator("[role=alert]", { hasText: "Start date" }).count()) > 0);
  await page.getByRole("button", { name: "Return to latest" }).click();
  await waitDashboard(page);
  txt = await mainText(page);
  check("return to latest", txt.includes("Latest end-of-day") || txt.includes("Delayed data"), page.url());

  // ---- 6. exchange filter ----
  await page.getByRole("radio", { name: "BSE", exact: true }).click();
  await page.waitForURL(/exchange=BSE/);
  await waitDashboard(page);
  txt = await mainText(page);
  check("BSE exchange uses BSE prices", txt.includes("BSE close") && txt.includes("BSE bhavcopy"));
  await page.goto(`${BASE}/company/500012`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  txt = await mainText(page);
  check("BSE-only company renders with NSE disabled", txt.includes("BSE close") && (await page.getByRole("radio", { name: "NSE", exact: true }).isDisabled()), await h1(page));
  check("BSE-only reasons shown instead of blanks", txt.includes("Not available") && !BAD_TEXT.test(txt));
  await page.screenshot({ path: path.join(OUT, "bse_only.png") });

  // ---- 7. analysis versions ----
  await page.goto(`${BASE}/company/ITC?view=versions`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  await page.getByRole("button", { name: "Analyse latest data" }).click();
  await page.waitForSelector("[role=status]:has-text('analysis v')", { timeout: 30_000 });
  check("analyse latest data stores/reuses a version", true, await page.locator("[role=status]:has-text('analysis v')").first().innerText());
  await page.fill("input[type=date][required]", "2025-11-03");
  await page.getByRole("button", { name: "Build point-in-time analysis" }).click();
  await page.waitForSelector("[role=status]:has-text('03 Nov 2025')", { timeout: 30_000 });
  await page.locator("[role=status]:has-text('03 Nov 2025')").getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/version=\d+/);
  await waitDashboard(page);
  txt = await mainText(page);
  check("historical version view shows that exact analysis", txt.includes("Stored analysis") && txt.includes("03 Nov 2025"), txt.slice(0, 220).replaceAll("\n", " | "));
  const priceLine = await page.locator("text=/close · /").first().innerText();
  check("version prices are as of analysis date", priceLine.includes("Nov 2025") || priceLine.includes("Oct 2025"), priceLine);
  check("exchange locked for stored analysis", await page.getByRole("radio", { name: "NSE", exact: true }).isDisabled());
  await page.getByRole("tab", { name: /Analysis history/ }).click();
  await page.waitForTimeout(1200);
  const boxes = page.locator("input[aria-label^='Compare analysis']");
  const boxCount = await boxes.count();
  check("history lists multiple versions", boxCount >= 2, boxCount);
  if (boxCount >= 2) {
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.waitForSelector("text=Compare analyses", { timeout: 10_000 });
    await page.waitForTimeout(1500);
    const cmp = await page.locator("section", { hasText: "Compare analyses" }).innerText();
    check("compare table renders metric changes", cmp.includes("P/E") && cmp.includes("%"), cmp.slice(0, 200).replaceAll("\n", " | "));
  }
  await page.screenshot({ path: path.join(OUT, "versions_ITC.png"), fullPage: true });
  await page.getByRole("button", { name: "Return to latest" }).click();
  await page.waitForFunction(() => !location.search.includes("version="), undefined, { timeout: 15_000 });
  check("return to latest clears the version", !page.url().includes("version="), page.url());

  // ---- 8. completed analyses page ----
  await page.goto(`${BASE}/analyses`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=View analysis", { timeout: 30_000 });
  const cards = await page.locator("li", { hasText: "View analysis" }).count();
  check("completed analyses list is dynamic", cards >= 10, cards);
  await page.getByPlaceholder("Name, NSE symbol or BSE code").fill("ITC");
  await page.waitForURL(/q=ITC/, { timeout: 10_000 });
  await page.waitForTimeout(1500);
  const firstCard = await page.locator("li", { hasText: "View analysis" }).first().innerText();
  check("analyses search filter", firstCard.includes("ITC"), firstCard.slice(0, 120).replaceAll("\n", " | "));
  if (await page.getByRole("radio", { name: "Every version" }).count()) await page.getByRole("radio", { name: "Every version" }).click();
  else await page.locator("button", { hasText: "Every version" }).click();
  await page.waitForTimeout(1500);
  check("every-version toggle shows history", (await page.locator("li", { hasText: "View analysis" }).count()) >= 2);
  await page.locator("li", { hasText: "View analysis" }).first().getByRole("link", { name: /View analysis/ }).click();
  await page.waitForURL(/\/company\/.+version=\d+/, { timeout: 20_000 });
  await waitDashboard(page);
  check("View analysis opens the dashboard at that version", (await mainText(page)).includes("Stored analysis"), page.url());
  await page.screenshot({ path: path.join(OUT, "analyses_open.png") });

  // ---- 9. API failure keeps the last good data ----
  await page.goto(`${BASE}/company/SBIN`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  const before = await h1(page);
  await page.route("**/dashboard?**", (route) => route.fulfill({ status: 503, body: '{"error":"unavailable","message":"Service temporarily unavailable"}', contentType: "application/json" }));
  const errorsBefore = errors.length;
  await page.getByRole("radio", { name: "6M" }).click();
  await page.waitForSelector("[role=alert]:has-text('Could not refresh')", { timeout: 30_000 });
  check("failed refresh shows a non-blocking notice", true, await page.locator("[role=alert]").first().innerText());
  check("previous data still displayed", (await h1(page)) === before && (await page.locator(".motion-stagger > div").count()) >= 12);
  await page.unroute("**/dashboard?**");
  await page.locator("[role=alert]:has-text('Could not refresh')").getByRole("button", { name: "Retry" }).click();
  await page.waitForFunction(() => !document.body.innerText.includes("Could not refresh"), undefined, { timeout: 30_000 });
  check("retry recovers", true);
  errors.splice(errorsBefore); // the 503s above were deliberate

  // ---- 10. loading skeleton ----
  await page.route("**/dashboard?**", async (route) => {
    await sleep(1500);
    await route.continue();
  });
  await page.goto(`${BASE}/company/LT`, { waitUntil: "domcontentloaded" });
  const skel = page.locator("[aria-label='Loading company dashboard']");
  // The dashboard data is held back 1.5 s above, so a skeleton must become visible once the page renders.
  const skeletonSeen = await skel.first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  check("skeleton shown while loading", skeletonSeen);
  await page.unroute("**/dashboard?**");
  await waitDashboard(page);

  // ---- 11. unknown company ----
  await page.goto(`${BASE}/company/NOTACOMPANY123`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=No company found", { timeout: 20_000 });
  check("unknown company handled", true);
  await page.goto(`${BASE}/company/NIFTY`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Open the index page", { timeout: 20_000 });
  check("index symbol offers index page", true);
  // Expected 404 responses; filtered in place because the listeners hold this array.
  errors.splice(0, errors.length, ...errors.filter((e) => !e.includes("404")));

  // ---- 12. mobile, reduced motion ----
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => errors.push(`mobile pageerror: ${e.message}`));
  for (const view of ["", "?view=detailed"]) {
    await m.goto(`${BASE}/company/HDFCBANK${view}`, { waitUntil: "domcontentloaded" });
    await waitDashboard(m);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile${view || " summary"}: no horizontal page overflow`, overflow <= 1, `overflow=${overflow}px`);
    await m.screenshot({ path: path.join(OUT, `mobile${view.replace("?view=", "_") || "_summary"}.png`), fullPage: true });
  }
  const dur = await m.evaluate(() => getComputedStyle(document.querySelector(".motion-rise")!).animationDuration);
  check("reduced motion disables animations", ["1e-05s", "0.00001s", "0s"].includes(dur) || Number.parseFloat(dur) < 0.001, dur);
  await mctx.close();

  // ---- 13. keyboard access ----
  await page.goto(`${BASE}/company/TCS`, { waitUntil: "domcontentloaded" });
  await waitDashboard(page);
  await page.getByRole("tab", { name: "Summary" }).focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForURL(/view=detailed/, { timeout: 10_000 });
  check("tabs work with the keyboard", page.url().includes("view=detailed"));

  const real = errors.filter((e) => !e.includes("favicon"));
  check("no console or page errors", !real.length, real.slice(0, 6));
});
