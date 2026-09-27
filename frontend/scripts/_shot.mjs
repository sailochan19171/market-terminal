import { chromium } from "playwright";

const OUT = "C:/Users/Home/AppData/Local/Temp/claude/C--Users-Home/b5f361a7-4edb-4302-b184-c671d49f388a/scratchpad/";
const BASE = "https://market-terminal-sai.netlify.app";

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.goto(`${BASE}/orders`, { waitUntil: "networkidle", timeout: 90_000 });

// The site may ask for its password first.
const pass = await page.$('input[type="password"]');
if (pass && process.env.SITE_PASSWORD) {
  await pass.fill(process.env.SITE_PASSWORD);
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: 60_000 });
}

const tabs = ["Orderbook view", "Order view", "Company view"];
for (const tab of tabs) {
  try {
    const el = page.getByRole("button", { name: tab, exact: false }).first();
    if (await el.count()) { await el.click(); await page.waitForTimeout(3500); }
  } catch { /* the tab control may be a different element; the screenshot still shows the page */ }
  const name = tab.split(" ")[0].toLowerCase();
  await page.screenshot({ path: `${OUT}ours-${name}.png`, fullPage: false });
  console.log(`captured ${name}`);
}
const text = await page.evaluate(() => document.body.innerText.slice(0, 900));
console.log("\n--- page text ---\n", text);
await browser.close();
