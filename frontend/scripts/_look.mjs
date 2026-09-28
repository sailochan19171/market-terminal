import { chromium } from "playwright";

const OUT = "C:/Users/Home/AppData/Local/Temp/claude/C--Users-Home/b5f361a7-4edb-4302-b184-c671d49f388a/scratchpad/";
const BASE = process.env.BASE ?? "https://market-terminal-sai.netlify.app";
const sizes = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const tabs = ["Orderbook view", "Order view", "Company view"];

const browser = await chromium.launch({ channel: "chrome", headless: true });
for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  await page.goto(`${BASE}/orders`, { waitUntil: "networkidle", timeout: 90_000 });
  for (const tab of tabs) {
    const btn = page.getByRole("button", { name: tab, exact: false }).first();
    if (await btn.count()) { await btn.click(); await page.waitForTimeout(3000); }
    const name = `${size.name}-${tab.split(" ")[0].toLowerCase()}`;
    await page.screenshot({ path: `${OUT}look-${name}.png`, fullPage: false });

    // What actually overflows sideways, and which cells are wider than the column they sit in.
    const report = await page.evaluate(() => {
      const doc = document.documentElement;
      const sideways = doc.scrollWidth - doc.clientWidth;
      const wide = [];
      for (const el of document.querySelectorAll("table, .overflow-x-auto, main *")) {
        const r = el.getBoundingClientRect();
        if (r.width > window.innerWidth + 2 && el.children.length < 40) {
          wide.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(r.width)}px`);
        }
        if (wide.length > 5) break;
      }
      // Cells whose text is wider than the cell itself: that is what reads as overlapping.
      const clipped = [];
      for (const td of document.querySelectorAll("td, th")) {
        if (td.scrollWidth > td.clientWidth + 4) {
          clipped.push(`${td.tagName.toLowerCase()} "${(td.textContent ?? "").trim().slice(0, 26)}" ${td.scrollWidth}>${td.clientWidth}`);
        }
        if (clipped.length > 6) break;
      }
      return { sideways, wide, clipped };
    });
    console.log(`\n${name}: page scrolls ${report.sideways}px sideways`);
    for (const w of report.wide) console.log("   wider than the screen:", w);
    for (const c of report.clipped) console.log("   text wider than its cell:", c);
  }
  await page.close();
}
await browser.close();
