// End-to-end checks for the analyst agents workspace (Multi-Agent Stock Analysis spec):
//   a separate full-screen dashboard (own shell, sidebar, chat thread, reports panel) - no market-site header
//   §2    the agent graph works live; §3.10 summary, score cards, key ratios table, strengths, concerns, sources
//   §3.1  a company listed in both markets is put to the reader; a price prediction is refused
//   §5.0  US companies in dollars; follow-ups carry the company forward
//   §7.1  traces page lists requests and shows every agent step; history reopens a stored analysis
//   npm run e2e:agents            (E2E_BASE defaults to http://localhost:3000; uses model calls)
import path from "node:path";
import type { Page } from "playwright";
import { BASE, BAD_TEXT, check, run, shotDir, watchErrors } from "./harness";
import { violations } from "../../src/server/agents/compliance";

const OUT = shotDir("agents");
const body = (page: Page) => page.locator("body").innerText();

async function ask(page: Page, question: string) {
  const before = ((await body(page)).match(/educational research, not investment advice/g) ?? []).length;
  await page.getByLabel("Question for the analyst agents").fill(question);
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  await page.waitForFunction((n) => {
    const text = document.body.innerText;
    return !text.includes("agents working…") && (text.match(/educational research, not investment advice/g) ?? []).length > n;
  }, before, { timeout: 120_000 });
  await page.waitForTimeout(600);
}

run(async (browser) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  watchErrors(page, errors);

  await page.goto(`${BASE}/agents`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Ask about any listed company", { timeout: 90_000 });
  await page.waitForSelector("text=Lynch-style", { timeout: 30_000 });
  const home = await body(page);
  await page.screenshot({ path: path.join(OUT, "workspace-empty.png") });
  check("a separate dashboard: its own shell, not the market site's header", /Analyst Agents/.test(home) && !/Gainers and losers/.test(home) && (await page.locator("header nav a", { hasText: "Traces" }).count()) === 1);
  check("a sidebar with new analysis, personas and history", /New analysis/.test(home) && /Recent analyses/i.test(home) && /Buffett-style/.test(home) && /Lynch-style/.test(home));
  check("personas are described as inspired by, not as the investor", /inspired by the principles of Warren Buffett/i.test(home));
  check("the agent graph is shown before a question", /Ratio engine/.test(home) && /Validator agent/.test(home) && /Persona synthesis/.test(home));

  // ---- a US company, end to end ----
  await ask(page, "Should I look at Apple as a long-term investment?");
  const apple = await body(page);
  await page.screenshot({ path: path.join(OUT, "workspace-apple.png") });
  check("the analysis is answered", /Strengths/.test(apple) && /Concerns/.test(apple), apple.slice(0, 160));
  check("a US company is shown in dollars", /US · NASDAQ/.test(apple) && /\$\d/.test(apple));
  for (const label of ["Persona fit", "Fundamental", "Valuation", "Technical", "Qualitative"]) check(`the ${label} score card`, new RegExp(label, "i").test(apple));
  check("the key ratios table names formula and source", /Key ratio/i.test(apple) && /_v1/.test(apple) && /SEC EDGAR/.test(apple));
  check("the timeline shows all 10 phases completed", /Agent run · 10 of 10 phases/.test(apple));
  check("each phase shows its own detail", /Ratio engine/.test(apple) && /ratios computed across/.test(apple) && /(Plan written by|Default plan)/.test(apple));
  check("the long-form analysis has sections", /Profitability and returns/.test(apple) && /Balance sheet and cash flow/.test(apple));

  // minimize / maximize: a single agent, then the whole analysis
  await page.getByRole("button", { name: /Maximize Ratio engine/i }).first().click();
  await page.waitForTimeout(200);
  check("an agent phase opens full screen", /Restore/.test(await body(page)) && /Profitability/i.test(await body(page)));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Minimize this analysis" }).first().click();
  check("an analysis minimizes to one line", !/Agent run · 10 of 10 phases/.test(await body(page)));
  await page.getByRole("button", { name: "Expand this analysis" }).first().click();
  check("and expands again", /Agent run · 10 of 10 phases/.test(await body(page)));
  check("the disclaimer is attached", /This is educational research, not investment advice/.test(apple));
  check("no directive language", violations(apple).length === 0, violations(apple));
  check("no undefined / NaN / null leaks", !BAD_TEXT.test(apple), apple.match(BAD_TEXT)?.[0] ?? "");

  const panel = page.locator("aside").last();
  const tabs: [string, RegExp][] = [
    ["Overview", /Last \d+ quarters/i], ["Ratios", /Latest FY/i], ["Quality", /Piotroski/], ["Valuation", /base case/i],
    ["Technical", /50-day average/], ["News & moat", /Moat signals/i], ["Checks", /Missing data/i], ["Plan & trace", /open the full trace/],
  ];
  for (const [tab, re] of tabs) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(200);
    check(`the reports panel "${tab}" renders`, re.test(await panel.innerText()));
  }
  await page.getByRole("tab", { name: "Ratios" }).click();
  check("ratios carry a trailing-twelve-month column", /TTM/.test(await panel.innerText()));
  await page.screenshot({ path: path.join(OUT, "workspace-apple-ratios.png") });

  // ---- a follow-up carries the company ----
  check("follow-ups are tied to the company in view", /Follow-ups are about\s+Apple/i.test(await body(page)));
  await ask(page, "Is its debt a concern?");
  check("the follow-up answered about the same company", ((await body(page)).match(/US · NASDAQ/g) ?? []).length >= 2);

  // ---- a company listed in both markets ----
  await page.getByRole("button", { name: /New analysis/ }).click();
  await ask(page, "Analyse Infosys");
  const both = await body(page);
  check("a company listed in both markets is put to the reader", /listed in both India and the US/.test(both) && /NSE \/ BSE/.test(both) && /US-listed/.test(both));
  await page.getByRole("button", { name: /NSE \/ BSE/ }).first().click();
  await page.waitForFunction(() => /India · NSE/.test(document.body.innerText) && !document.body.innerText.includes("agents working…"), undefined, { timeout: 120_000 });
  const infy = await body(page);
  check("choosing the Indian listing analyses it in rupees", /India · NSE/.test(infy) && /₹/.test(infy));

  // ---- a guardrail ----
  await ask(page, "Will Infosys double by next year?");
  check("a price prediction is refused", /price prediction/i.test(await body(page)));

  // ---- history and traces ----
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Ask about any listed company", { timeout: 60_000 });
  await page.waitForTimeout(1000);
  const sidebar = await page.locator("aside").first().innerText();
  check("the conversations are kept in the sidebar", /Should I look at Apple/.test(sidebar) && /Analyse Infosys/.test(sidebar), sidebar.slice(0, 200));
  await page.getByRole("button", { name: /Should I look at Apple/ }).first().click();
  await page.waitForFunction(() => /US · NASDAQ/.test(document.body.innerText) && /Strengths/.test(document.body.innerText), undefined, { timeout: 60_000 });
  check("a stored analysis reopens exactly as it was", /Strengths/.test(await body(page)));

  await page.goto(`${BASE}/agents/traces`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=Request traces", { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Should I look at Apple/ }).first().click();
  await page.waitForSelector("text=input layer", { timeout: 30_000 });
  const traces = await body(page);
  await page.screenshot({ path: path.join(OUT, "traces.png") });
  check("the trace shows every agent step", ["input layer", "orchestrator", "data agent", "ratio engine", "validator", "synthesis"].every((a) => traces.toLowerCase().includes(a)));
  check("the traces page reports p95 latency", /p95 latency/i.test(traces));

  // ---- the company dashboard links into the workspace ----
  await page.goto(`${BASE}/company/ITC?view=agents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "AI analysts" }).waitFor({ timeout: 90_000 });
  await page.getByRole("link", { name: /Open the workspace/ }).waitFor({ timeout: 30_000 });
  check("the company dashboard has the AI analysts tab with a way into the workspace", (await page.getByRole("link", { name: /Open the workspace/ }).count()) === 1);

  check("no page or console errors", errors.length === 0, errors.slice(0, 3));
});
