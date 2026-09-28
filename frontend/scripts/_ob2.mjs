import { chromium } from "playwright";
const OUT = "C:/Users/Home/AppData/Local/Temp/claude/C--Users-Home/b5f361a7-4edb-4302-b184-c671d49f388a/scratchpad/";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("https://market-terminal-sai.netlify.app/orders", { waitUntil: "networkidle", timeout: 90_000 });
const btn = page.getByRole("button", { name: "Orderbook view", exact: false }).first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(4000); }
await page.screenshot({ path: `${OUT}ob-live.png` });
const info = await page.evaluate(() => ({
  cards: document.body.innerText.includes("Fastest-growing"),
  oneReading: (document.body.innerText.match(/one reading/g) ?? []).length,
  bars: document.querySelectorAll("span[title*='INR'], span[title*='₹']").length,
}));
console.log(JSON.stringify(info));
await browser.close();
