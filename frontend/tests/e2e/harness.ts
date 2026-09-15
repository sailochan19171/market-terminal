// Tiny runner for the end-to-end suites: PASS/FAIL lines, a summary and an exit code.
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

export const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
export const BAD_TEXT = /\b(undefined|NaN|null)\b|\[object Object\]/;
export const BAD_TEXT_ALL = /\b(undefined|NaN|null)\b|\[object Object\]/g;

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

export function check(name: string, ok: unknown, detail: unknown = "") {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ name, ok: Boolean(ok), detail: text });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${text !== "" ? ` :: ${text.slice(0, 300)}` : ""}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function shotDir(name: string) {
  const dir = path.join(__dirname, "shots", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Collect page errors and console errors from a page. */
export function watchErrors(page: Page, errors: string[], prefix = "") {
  page.on("pageerror", (e) => errors.push(`${prefix}pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${prefix}console: ${m.text()}`);
  });
}

/** Launch the installed Chrome, run the suite, print the summary and exit with its status. */
export async function run(suite: (browser: Browser) => Promise<void>) {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await suite(browser);
  } catch (e) {
    check("suite completed without an exception", false, (e as Error).stack ?? String(e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED: ${f.name} :: ${f.detail.slice(0, 200)}`);
  process.exit(failed.length ? 1 : 0);
}

/** Run `action` and wait until an API response whose URL contains every fragment has arrived and rendered. */
export async function withData(page: Page, fragments: string[], action: () => Promise<unknown>, renderMs = 700) {
  const done = page.waitForResponse((r) => r.url().includes("/api/") && fragments.every((f) => r.url().includes(f)), { timeout: 45_000 });
  await action();
  await done;
  await page.waitForTimeout(renderMs);
}
