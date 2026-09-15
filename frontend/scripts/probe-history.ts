// How far back each exchange source serves data: one request per sample date, nothing is saved.
import { NSEClient } from "../src/server/nse/client";
import { BSEClient } from "../src/server/bse/client";
import * as nseBhav from "../src/server/nse/bhavcopy";
import * as bseBhav from "../src/server/bse/bhavcopy";
import * as idx from "../src/server/nse/indexHistory";

async function attempt(label: string, fn: () => Promise<unknown>) {
  const t = Date.now();
  try {
    const out = await fn();
    const n = Array.isArray(out) ? out.length : out === null || out === undefined ? "none" : typeof out === "object" ? Object.keys(out as object).length : String(out).length;
    console.log(`${label.padEnd(44)} ok   ${n} (${Date.now() - t} ms)`);
  } catch (e) {
    console.log(`${label.padEnd(44)} FAIL ${(e as Error).message.slice(0, 80)}`);
  }
}

async function main() {
  const nse = new NSEClient({ rps: 1 });
  const bse = new BSEClient({ rps: 1 });
  for (const day of ["2021-06-01", "2016-06-01", "2011-06-01", "2007-06-01", "2004-06-01", "2000-06-01", "1996-06-03"]) {
    await attempt(`NSE bhavcopy ${day}`, () => nseBhav.fetchDay(nse, day, false));
    await attempt(`BSE bhavcopy ${day}`, () => bseBhav.fetchDay(bse, day, false));
  }
  for (const day of ["2021-06-01", "2016-06-01", "2012-06-01", "2008-06-02", "2004-06-01"]) {
    await attempt(`NSE index history ${day}`, async () => idx.parse(new TextDecoder().decode(await nse.archive(idx.dayPath(day)))));
  }
  for (const [from, to] of [["01-06-2023", "07-06-2023"], ["01-06-2019", "07-06-2019"], ["01-06-2014", "07-06-2014"], ["01-06-2009", "07-06-2009"]]) {
    await attempt(`NSE announcements ${from}`, async () => ((await nse.api<{ length?: number }>("corporate-announcements", { index: "equities", from_date: from, to_date: to })) as unknown[]) ?? []);
    await attempt(`NSE board meetings ${from}`, async () => ((await nse.api<unknown[]>("corporate-board-meetings", { index: "equities", from_date: from, to_date: to })) ?? []));
    await attempt(`NSE corp actions ${from}`, async () => ((await nse.api<unknown[]>("corporates-corporateActions", { index: "equities", from_date: from, to_date: to })) ?? []));
  }
  for (const day of ["20230601", "20190603", "20140602", "20090601"]) {
    await attempt(`BSE announcements ${day}`, async () => {
      const r = await bse.api<{ Table?: unknown[] }>("AnnSubCategoryGetData/w", { pageno: 1, strCat: -1, strPrevDate: day, strScrip: "", strSearch: "P", strToDate: day, strType: "C", subcategory: -1 });
      return r?.Table ?? [];
    });
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
