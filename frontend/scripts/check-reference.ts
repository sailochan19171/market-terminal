// The reference company set (spec §10.2, §10.3): full ratio reports on 10 companies across both markets.
//
// Each company pins the edge case it was chosen for (a bank gets the financial set, negative equity suppresses ROE,
// a loss-maker has no P/E...). Ratios with hand-calculated values from the annual filing are checked within 1%.
// Every computed ratio for all ten is written to tests/fixtures/reference-ratios.csv - the "spreadsheet" a reviewer
// fills in from the annual reports, so the remaining hand checks can be added to reference.json.
//   npm run check:reference        (needs network for the US companies)
import { readFileSync, writeFileSync } from "node:fs";
import { Db } from "../src/server/db";
import { personas } from "../src/server/agents/config";
import { providerFor } from "../src/server/agents/providers";
import { ratioReport } from "../src/server/agents/ratios";
import { validateContract } from "../src/server/agents/schemas";
import type { Market, RatioSeries } from "../src/server/agents/state";

interface Ref {
  symbol: string; market: Market; case: string;
  expect: { sectorSet?: string; minYears?: number; maxYears?: number; minRatios?: number; unavailable?: string; hasRatio?: string; lacksRatio?: string; noAltman?: boolean; nullReason?: [string, string]; restated?: boolean; minDebtToEquity?: number };
  hand: Record<string, number | string>;
}

let failed = 0;
const check = (what: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};

async function main() {
  const db = new Db({ kind: "local", readOnly: true });
  const refs = (JSON.parse(readFileSync("tests/fixtures/reference.json", "utf8")) as { companies: Ref[] }).companies;
  const buffett = personas().find((p) => p.id === "buffett")!;
  const csv: string[] = ["market,symbol,category,ratio,formula_id,fiscal_year,value,ttm,reason,hand_value"];
  const markets = refs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.market]: (m[r.market] ?? 0) + 1 }), {});
  check("at least 4 companies per market", (markets.IN ?? 0) >= 4 && (markets.US ?? 0) >= 4, JSON.stringify(markets));

  for (const ref of refs) {
    console.log(`\n${ref.symbol} (${ref.market}) - ${ref.case}`);
    let raw;
    try {
      raw = await providerFor(ref.market).load(db, ref.symbol, 10);
    } catch (e) {
      check("data loads", false, (e as Error).message);
      continue;
    }
    const r = ratioReport(db, raw, buffett.thresholds);
    const all = Object.entries(r.categories).flatMap(([cat, ratios]) => Object.entries(ratios).map(([k, s]) => [cat, k, s] as [string, string, RatioSeries]));
    const find = (k: string) => all.find(([, key]) => key === k)?.[2];
    const e = ref.expect;
    check("contract", validateContract("RatioReport", r).length === 0);
    if (e.sectorSet) check(`sector set is ${e.sectorSet}`, r.sectorSet === e.sectorSet, r.sectorSet);
    if (e.minYears) check(`at least ${e.minYears} fiscal years`, r.years.length >= e.minYears, String(r.years.length));
    if (e.maxYears) check(`at most ${e.maxYears} fiscal years`, r.years.length <= e.maxYears, String(r.years.length));
    if (e.minRatios) {
      const computed = all.filter(([, , s]) => s.latest !== null).length;
      check(`at least ${e.minRatios} ratios computed`, computed >= e.minRatios, `${computed} of ${all.length}`);
    }
    if (e.unavailable) check(`reports "${e.unavailable}" as unavailable`, r.unavailable.some((u) => u.key === e.unavailable), r.unavailable.map((u) => u.key).slice(0, 6).join(", "));
    if (e.hasRatio) check(`has ${e.hasRatio}`, Boolean(find(e.hasRatio)?.latest != null));
    if (e.lacksRatio) check(`skips ${e.lacksRatio}`, !find(e.lacksRatio));
    if (e.noAltman) check("skips the Altman Z-score", r.qualityScores.altmanZ.score === null);
    if (e.nullReason) {
      const [key, reason] = e.nullReason;
      const s = find(key);
      check(`${key} is null with reason ${reason}`, s?.latest === null && s.series.at(-1)?.reason === reason, `${s?.latest} / ${s?.series.at(-1)?.reason}`);
    }
    if (e.restated) check("keeps as-reported figures beside the restated ones", raw.annual.some((a) => a.asReported));
    if (e.minDebtToEquity) check(`debt to equity above ${e.minDebtToEquity}`, (find("debtToEquity")?.latest ?? 0) > e.minDebtToEquity, find("debtToEquity")?.latest?.toFixed(2) ?? "none");

    for (const [key, want] of Object.entries(ref.hand)) {
      if (key.startsWith("_") || typeof want !== "number") continue;
      const got = find(key)?.latest ?? null;
      check(`${key} within 1% of the hand calculation`, got !== null && Math.abs(got - want) <= Math.abs(want) * 0.01, `${got?.toFixed(5)} vs ${want}`);
    }
    for (const [cat, key, s] of all) {
      const last = s.series.at(-1);
      csv.push([ref.market, ref.symbol, cat, key, s.formulaId, last?.year ?? "", s.latest ?? "", s.ttm?.value ?? "", last?.reason ?? "", typeof ref.hand[key] === "number" ? ref.hand[key] : ""].join(","));
    }
  }
  writeFileSync("tests/fixtures/reference-ratios.csv", `${csv.join("\n")}\n`);
  db.close();
  console.log(`\nWrote tests/fixtures/reference-ratios.csv (${csv.length - 1} ratio rows)`);
  console.log(failed ? `${failed} check${failed === 1 ? "" : "s"} failed` : "All checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
