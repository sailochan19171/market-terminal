// Every page at phone width: does anything overflow sideways, is the menu reachable, do controls fit?
//   node scripts/mobile-audit.mjs [base]
import { chromium, devices } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:3320";
const PAGES = ["/", "/markets", "/indices", "/heatmap", "/market-data", "/filings", "/results", "/board-meetings",
  "/corporate-actions", "/shareholding", "/insider", "/screens", "/analyses", "/quality", "/disclosures",
  "/company/RELIANCE", "/research/RELIANCE", "/portfolio", "/watchlist", "/alerts", "/assistant", "/agents", "/orders"];

const phone = devices["iPhone 12"];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ ...phone });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`  page error: ${String(e).slice(0, 90)}`));

for (const path of PAGES) {
  const found = [];
  try {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 180000 });
    await page.waitForTimeout(5000);
    const report = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const overflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
      const wide = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // an element sticking out past the right edge, that is not inside its own scroller
        if (r.right > vw + 2) {
          let p = el.parentElement, scrolls = false;
          while (p && p !== document.body) {
            const s = getComputedStyle(p);
            if (/auto|scroll|hidden|clip/.test(s.overflowX)) { scrolls = true; break; }
            p = p.parentElement;
          }
          if (!scrolls) wide.push(`${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ").slice(0, 2).join(".") : ""} (${Math.round(r.right - vw)}px past)`);
        }
      }
      const tiny = [...document.querySelectorAll("button, a")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height < 28 && el.textContent.trim().length > 0;
      }).length;
      return { vw, overflow, wide: [...new Set(wide)].slice(0, 4), tiny };
    });
    if (report.overflow > 2) found.push(`scrolls sideways by ${report.overflow}px`);
    if (report.wide.length) found.push(`sticking out: ${report.wide.join(", ")}`);
    if (report.tiny > 6) found.push(`${report.tiny} tap targets under 28px tall`);
  } catch (e) {
    found.push(`could not load: ${String(e).slice(0, 70)}`);
  }
  console.log(`${found.length ? "CHECK" : "ok   "} ${path}${found.length ? "\n   " + found.join("\n   ") : ""}`);
}

// the menu itself
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
const burger = page.getByRole("button", { name: /open menu/i });
console.log(`\nhamburger button present: ${await burger.count() > 0}`);
if (await burger.count()) {
  await burger.first().click();
  await page.waitForTimeout(700);
  const dialog = await page.locator("[role=dialog]").count();
  const links = await page.locator("[role=dialog] a").count();
  console.log(`menu opens: ${dialog > 0}, links inside: ${links}`);
  await page.screenshot({ path: "C:/Users/Home/AppData/Local/Temp/claude/C--Users-Home/b5f361a7-4edb-4302-b184-c671d49f388a/scratchpad/m-menu.png" });
}
if (problems.length) console.log("\n" + [...new Set(problems)].slice(0, 5).join("\n"));
await browser.close();
