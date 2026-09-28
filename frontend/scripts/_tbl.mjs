import { chromium } from "playwright";

const OUT = "C:/Users/Home/AppData/Local/Temp/claude/C--Users-Home/b5f361a7-4edb-4302-b184-c671d49f388a/scratchpad/";
const BASE = "https://market-terminal-sai.netlify.app";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
for (const tab of ["Company view", "Orderbook view"]) {
  await page.goto(`${BASE}/orders`, { waitUntil: "networkidle", timeout: 90_000 });
  const btn = page.getByRole("button", { name: tab, exact: false }).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(3500); }
  const table = page.locator("table").first();
  if (await table.count()) await table.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}tbl-${tab.split(" ")[0].toLowerCase()}.png` });
  console.log("captured", tab);
}
await browser.close();
