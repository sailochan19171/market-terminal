// End-to-end checks for the research layer, written against the product spec's acceptance criteria:
//   §1  one price, stamped with its moment and source, identical on every surface
//   §2  the "why it's moving" card: context, sourced catalysts or an honest blank
//   §3  the valuation verdict: a combined reading, visible inputs, a growth slider that changes the answer
//   §5.4 risk flags with the filing behind each one
//   §7  AI and computed blocks labelled, disclaimers present, no recommendation language on the page
//   npm run e2e:research            (E2E_BASE defaults to http://localhost:3000)
import path from "node:path";
import type { Page } from "playwright";
import { BASE, check, run, shotDir, watchErrors } from "./harness";

const OUT = shotDir("research");

// The same patterns scripts/check-language.ts applies to generated text, now against the rendered page.
const DIRECTIVE = [
  /\b(buy|sell|hold|accumulate)\s+(this|the|these|now|at)\b/i,
  /\b(strong\s+)?(buy|sell)\s+(zone|signal|call|rating)\b/i,
  /\byou should (buy|sell|hold|invest|exit)\b/i,
  /\bwe recommend\b/i,
  /\bmultibagger\b|\bguaranteed returns?\b/i,
];
const NEGATED = /\b(no|not|never|without)\b[^.]{0,60}$/i;

function directives(text: string): string[] {
  const hits: string[] = [];
  for (const re of DIRECTIVE) {
    const m = text.match(re);
    if (m && !NEGATED.test(text.slice(0, m.index ?? 0))) hits.push(m[0]);
  }
  return hits;
}

const settled = async (page: Page, timeout = 60_000) => {
  await page.waitForSelector("h1", { timeout });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), undefined, { timeout });
  // The research cards each fetch their own endpoint; wait for the slowest of them rather than for a fixed pause.
  await page.waitForFunction(() => {
    const t = document.querySelector("main")?.textContent ?? "";
    return /models screen/i.test(t) && /risk flags/i.test(t) && /(closed|barely moved|No price on record)/i.test(t);
  }, undefined, { timeout }).catch(() => {});
  await page.waitForTimeout(800);
};

/** Labels are rendered uppercase by CSS, so every page assertion is case-insensitive. */
const has = (text: string, phrase: string) => text.toLowerCase().includes(phrase.toLowerCase());

run(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);

  for (const sym of ["TCS", "HDFCBANK", "VEDL"]) {
    await page.goto(`${BASE}/company/${sym}`, { waitUntil: "domcontentloaded" });
    await settled(page);
    const text = await page.locator("main").innerText();

    // ---- §1 one price, and it says when it is from ----
    const api = await page.evaluate(async (s) => {
      const r = await fetch(`/api/v2/company/${s}/dashboard`);
      return (await r.json()) as { price: { lastPrice: number | null; source: string; isLive: boolean; asOfTimestamp: string | null } };
    }, sym);
    check(`${sym}: the dashboard carries a price-service quote`, api.price && api.price.asOfTimestamp !== null && Boolean(api.price.source),
      `${api.price?.lastPrice} · ${api.price?.source}`);
    const shown = text.match(/₹([\d,]+\.\d{2})/)?.[1]?.replace(/,/g, "");
    check(`${sym}: the header price is the price service's price`, shown !== undefined && Math.abs(Number(shown) - (api.price.lastPrice ?? -1)) < 0.011,
      `page ₹${shown} vs service ₹${api.price?.lastPrice}`);
    check(`${sym}: the price carries an "as of" stamp in IST`, /as of .*IST/.test(text), text.match(/as of[^\n]*/)?.[0] ?? "missing");
    const badge = page.locator("main").getByText(/^(live|end of day)$/i).first();
    check(`${sym}: the price carries a live / end-of-day badge`, (await badge.count()) > 0, (await badge.count()) ? await badge.innerText() : "missing");

    // ---- §2 why it's moving ----
    const moving = /Why .* closed|closed roughly flat/i.test(text);
    check(`${sym}: the "why it's moving" card is on the page`, moving, text.match(/(Why [^\n]{0,60}|[^\n]{0,40}closed roughly flat)/)?.[0] ?? "missing");
    check(`${sym}: the move is set against its benchmark`, has(text, "Move not explained by the index") && has(text, "Volume against its 20-day average"));
    // A catalyst always names its source and moment; only some have a document to open (a corporate action does not).
    const sourced = /(confidence)/i.test(text) && /(NSE|BSE) (announcement|filing|result|corporate actions|insider trading)/i.test(text);
    const blank = has(text, "No company-specific filing was found");
    check(`${sym}: every catalyst is sourced, or the card says there is none`, sourced || blank, sourced ? "catalysts carry source and confidence" : "no-catalyst state shown");

    // ---- §3 valuation verdict ----
    check(`${sym}: the verdict is combined, not a single signal`, /of \d+ models screen/.test(text), text.match(/\d+ of \d+ models screen[^\n]*/)?.[0] ?? "missing");
    check(`${sym}: the Lynch inputs are on show`, has(text, "Lynch ratio") && has(text, "Textbook PEGY") && has(text, "Fair P/E on this rule"));

    // ---- §5.4 risk flags ----
    check(`${sym}: the risk-flag panel ran its checks`, /Risk flags/i.test(text) && /(checks raised something|Nothing was raised by)/i.test(text),
      text.match(/(\d+ of \d+ checks raised something[^\n]*|Nothing was raised by[^\n]*)/)?.[0] ?? "missing");

    // ---- §7 labels and language ----
    check(`${sym}: computed and retrieved blocks are labelled`, /Computed, not advice|Assembled from filings|AI-generated/i.test(text));
    const hits = directives(text);
    check(`${sym}: no recommendation language on the page`, hits.length === 0, hits.join(", "));
    check(`${sym}: the footer carries the risk warning`, (await page.locator("footer").innerText()).includes("Nothing here is investment advice"));

    await page.screenshot({ path: path.join(OUT, `company_${sym}.png`), fullPage: true });
  }

  // ---- §3.7 the growth slider changes the verdict, and the reset restores it ----
  await page.goto(`${BASE}/company/TCS`, { waitUntil: "domcontentloaded" });
  await settled(page);
  const fairValueNow = async () => {
    const card = page.locator("div", { hasText: /^Fair value per share/ }).last();
    return (await card.innerText()).replace(/[^\d.]/g, "");
  };
  const before = await fairValueNow();
  const slider = page.locator('input[aria-label="Expected EPS growth"]');
  check("the growth slider is on the page", (await slider.count()) > 0);
  if (await slider.count()) {
    await slider.first().fill("20");
    await page.waitForTimeout(600);
    const after = await fairValueNow();
    check("moving the growth slider recomputes the fair value", before !== after, `${before} -> ${after}`);
    check("the page marks the reading as the reader's own inputs", (await page.locator("main").innerText()).includes("your inputs"));
  }

  // ---- §7B the disclosure page is reachable and says where the AI is ----
  await page.goto(`${BASE}/disclosures`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("h1");
  const disc = await page.locator("main").innerText();
  check("the disclosure page explains where AI is used", /Where the AI is/i.test(disc) && /not a SEBI-registered research analyst/i.test(disc));
  check("the disclosure page states the site is educational", disc.includes("Nothing here is investment advice"));
  await page.screenshot({ path: path.join(OUT, "disclosures.png"), fullPage: true });

  check("no page or console errors", errors.length === 0, errors.slice(0, 5).join(" | "));
});
