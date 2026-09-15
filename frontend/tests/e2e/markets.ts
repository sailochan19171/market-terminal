// End-to-end checks for the header, home, market, results, shareholding, board meeting and statement pages.
//   npm run e2e:markets            (E2E_BASE defaults to http://localhost:3000)
import path from "node:path";
import type { Page } from "playwright";
import { BAD_TEXT, BAD_TEXT_ALL, BASE, check, run, shotDir, withData } from "./harness";

const OUT = shotDir("markets");

async function settle(page: Page, ms = 900) {
  // Link prefetching can keep the network busy; data is checked explicitly afterwards.
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

const pctsOf = async (page: Page) =>
  (await page.locator("tbody tr td:nth-child(4)").allInnerTexts())
    .filter((x) => !["—", ""].includes(x.trim()))
    .map((x) => Number.parseFloat(x.replace("%", "").replace("+", "")));

const sortedDesc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] >= v);
const sortedAsc = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] <= v);
const figures = (s: string) => (s.match(/\d{1,3}(,\d{2,3})+/g) ?? []).length;

run(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });

  // ---- header: ticker + mega menu ----
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Indian markets today", { timeout: 30_000 });
  await settle(page, 1500);
  const strip = await page.locator("[aria-label='Index values at the last close']").innerText();
  check("ticker strip shows SENSEX and NIFTY", strip.includes("SENSEX") && strip.includes("Nifty 50"), strip.slice(0, 120).replaceAll("\n", " "));
  await page.getByRole("button", { name: "Markets" }).hover();
  await page.waitForSelector(".menu-panel >> text=Market watch", { timeout: 5000 });
  const items = await page.locator(".menu-panel a").allInnerTexts();
  check("Markets mega menu lists pages with descriptions", items.length >= 8 && items.join(" ").includes("Every traded security"), items.length);
  await page.screenshot({ path: path.join(OUT, "menu_markets.png") });
  await page.locator(".menu-panel a", { hasText: "Market watch" }).click();
  await page.waitForURL(/\/markets\?tab=watch/, { timeout: 15_000 });
  check("menu navigates to Market watch", page.url().includes("tab=watch"), page.url());
  await page.getByRole("button", { name: "Corporates" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector(".menu-panel >> text=Financial results", { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("menu opens with keyboard and closes with Escape", (await page.locator(".menu-panel").count()) === 0);

  // ---- home: summary / detailed ----
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=NSE market summary", { timeout: 30_000 });
  await settle(page, 1500);
  let txt = (await page.locator("main").innerText()).toLowerCase();
  check("home summary shows NSE and BSE market summaries", txt.includes("nse market summary") && txt.includes("bse market summary") && txt.includes("₹"));
  await page.screenshot({ path: path.join(OUT, "home_summary.png") });
  await page.getByRole("tab", { name: "Detailed view" }).click();
  await page.waitForURL(/view=detailed/, { timeout: 10_000 });
  await settle(page, 2000);
  check("home detailed view shows heatmap and index chart",
    (await page.locator("main canvas, main svg.recharts-surface").count()) > 0 && (await page.locator("main").innerText()).includes("Market snapshot"));
  await page.screenshot({ path: path.join(OUT, "home_detailed.png") });

  // ---- markets: summary ----
  await page.goto(`${BASE}/markets`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Turnover trend", { timeout: 30_000 });
  await settle(page, 1500);
  txt = await page.locator("main").innerText();
  check("NSE market summary has totals, segments and movers", ["Turnover", "Equity (rolling settlement)", "Top gainers", "Most traded by value"].every((k) => txt.includes(k)));
  check("market summary: no undefined/NaN/null", !BAD_TEXT.test(txt), (txt.match(BAD_TEXT_ALL) ?? []).slice(0, 3));
  await page.screenshot({ path: path.join(OUT, "markets_summary_nse.png"), fullPage: true });
  await page.getByRole("button", { name: "BSE", exact: true }).first().click();
  await page.waitForURL(/exchange=BSE/);
  await page.waitForSelector("text=Group A", { timeout: 30_000 });
  check("BSE market summary uses BSE groups", (await page.locator("main").innerText()).includes("Group A"));

  // ---- markets: watch ----
  await page.goto(`${BASE}/markets?tab=watch`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr", { timeout: 30_000 });
  await settle(page);
  await withData(page, ["market/watch", "index=nifty50"], () => page.locator("select").first().selectOption("nifty50"));
  const countTxt = await page.locator("text=/securities · NSE session/").first().innerText();
  check("index filter narrows to NIFTY 50", countTxt.startsWith("50 "), countTxt);
  await withData(page, ["market/watch", "move=gainers"], () => page.getByRole("button", { name: "Gainers" }).click());
  let pcts = await pctsOf(page);
  check("gainers filter returns only rising stocks", pcts.length > 0 && pcts.every((p) => p > 0), pcts.slice(0, 5));
  await withData(page, ["market/watch", "sort=pct"], () => page.getByRole("button", { name: /^% Chg/ }).click());
  pcts = await pctsOf(page);
  check("sort by % change", sortedDesc(pcts) || sortedAsc(pcts), pcts.slice(0, 5));
  await page.goto(`${BASE}/markets?tab=watch&exchange=BSE`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr", { timeout: 30_000 });
  await settle(page);
  const firstRow = await page.locator("tbody tr").first().innerText();
  await withData(page, ["market/watch", "page=2"], () => page.getByRole("button", { name: "Next page" }).click());
  check("BSE market watch paginates", (await page.locator("tbody tr").first().innerText()) !== firstRow);
  await page.screenshot({ path: path.join(OUT, "market_watch_bse.png") });

  // ---- results ----
  await page.goto(`${BASE}/results`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("tbody tr", { timeout: 30_000 });
  await settle(page);
  check("results list loads with YoY figures", (await page.locator("main").innerText()).toLowerCase().includes("companies reported") && (await page.locator("tbody tr").count()) >= 10);
  await withData(page, ["v2/results", "profit=up"], () => page.getByRole("button", { name: "Growing" }).click());
  const yoy = await page.locator("tbody tr td:nth-child(6)").allInnerTexts();
  check("growing-profit filter", yoy.length > 0 && yoy.every((y) => y.startsWith("+")), yoy.slice(0, 5));
  await withData(page, ["v2/results", "sector="], () => page.locator("select").nth(1).selectOption({ index: 1 }));
  check("sector filter applies", page.url().includes("sector="), page.url());
  await page.screenshot({ path: path.join(OUT, "results.png") });

  // ---- shareholding + board meetings ----
  await page.goto(`${BASE}/shareholding`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Companies with detail", { timeout: 30_000 });
  await settle(page);
  let changes = await page.locator("tbody tr td:nth-child(4) span.text-xs").allInnerTexts();
  check("FII increases list positive changes", changes.length > 0 && changes.slice(0, 10).every((c) => c.includes("+")), changes.slice(0, 4));
  await withData(page, ["shareholding-changes", "direction=down"], () => page.getByRole("button", { name: "Reduced" }).click());
  changes = await page.locator("tbody tr td:nth-child(4) span.text-xs").allInnerTexts();
  check("FII reductions list negative changes", !changes.length || changes.slice(0, 10).every((c) => c.includes("-")), changes.slice(0, 4));
  await page.screenshot({ path: path.join(OUT, "shareholding.png") });
  await page.goto(`${BASE}/board-meetings`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Next 7 days", { timeout: 30_000 });
  await settle(page);
  await withData(page, ["board-meetings", "when=past"], () => page.getByRole("button", { name: "Past" }).click());
  await withData(page, ["board-meetings", "purpose=dividend"], () => page.getByRole("button", { name: "Dividend" }).click(), 1200);
  txt = await page.locator("main").innerText();
  check("board meetings: past dividend meetings", txt.toLowerCase().includes("meeting") && txt.includes("ividend"));
  await page.screenshot({ path: path.join(OUT, "board_meetings.png") });

  // ---- company statements ----
  for (const sym of ["HINDZINC", "HDFCBANK"]) {
    await page.goto(`${BASE}/company/${sym}?view=detailed&range=5Y`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#balance-sheet", { timeout: 40_000 });
    await settle(page, 2000);
    await page.locator("#balance-sheet").scrollIntoViewIfNeeded();
    const bs = await page.locator("section", { hasText: "Balance sheet" }).filter({ has: page.locator("table") }).first().innerText();
    check(`${sym}: balance sheet table has figures`, bs.includes("Total assets") && figures(bs) > 10, bs.slice(0, 120).replaceAll("\n", " | "));
    const cfSection = page.locator("section", { hasText: "Cash flow statement" }).first();
    const cf = await cfSection.innerText();
    check(`${sym}: cash flow statement has figures`, cf.includes("Cash from operating activities") && figures(cf) > 5, cf.slice(0, 120).replaceAll("\n", " | "));
    await page.locator("#balance-sheet").screenshot({ path: path.join(OUT, `bs_${sym}.png`) });
    await cfSection.screenshot({ path: path.join(OUT, `cf_${sym}.png`) });
  }
  await page.goto(`${BASE}/company/HINDZINC`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Free cash flow (FY)", { timeout: 40_000 });
  await settle(page, 1200);
  const fcf = await page.locator(".motion-stagger > div", { hasText: "Free cash flow (FY)" }).first().innerText();
  check("summary shows free cash flow KPI", fcf.includes("₹"), fcf.replaceAll("\n", " "));
  await page.screenshot({ path: path.join(OUT, "company_summary_HINDZINC.png"), fullPage: true });

  // ---- mobile ----
  const m = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  m.on("pageerror", (e) => errors.push(`mobile: ${e.message}`));
  for (const p of ["/", "/markets", "/markets?tab=watch", "/results", "/board-meetings"]) {
    await m.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
    await settle(m, 1500);
    const over = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`mobile ${p}: no horizontal overflow`, over <= 1, `${over}px`);
  }
  await m.getByRole("button", { name: "Open menu" }).click();
  await m.waitForSelector("[role=dialog] >> text=Market summary", { timeout: 5000 });
  check("mobile menu opens with sections", (await m.locator("[role=dialog] a").count()) >= 5);
  await m.screenshot({ path: path.join(OUT, "mobile_menu.png") });

  const real = errors.filter((e) => !e.includes("favicon"));
  check("no console or page errors", !real.length, real.slice(0, 5));
});
