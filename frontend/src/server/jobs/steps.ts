// The daily end-of-day update, in the order the old daily.ps1 ran it. Each source skips what it already has.
import { getDb } from "../db";
import * as C from "./commands";
import type { Step } from "./scheduler";
import { isConfigured, publish } from "./publish";

export function dailySteps(): Step[] {
  const db = getDb();
  return [
    // BSE
    { name: "scrips", run: () => C.scrips(db) },
    { name: "indices", run: () => C.bseIndexSync(db) },
    { name: "corp-actions", run: () => C.bseCorpActions(db) },
    { name: "bhavcopy", run: () => C.bhavcopy(db, { years: 0.1 }) },
    { name: "announcements", run: () => C.announcements(db, { years: 0.02 }) },
    // NSE
    { name: "nse-symbols", run: () => C.nseSymbolSync(db) },
    { name: "nse-indices", run: () => C.nseIndexSync(db) },
    { name: "nse-bhavcopy", run: () => C.nseBhavcopySync(db, { years: 0.1 }) },
    { name: "nse-index-history", run: () => C.nseIndexHistorySync(db, { years: 0.05 }) },
    { name: "nse-corporate", run: () => C.nseCorporate(db, {}) },
    // Your own holdings, only when a broker is configured in .env.
    { name: "broker", run: async () => (await C.broker(db))?.holdings ?? 0 },
    // Derived figures and stored analyses, so dashboards show the new session.
    { name: "metrics", run: () => C.metrics(db) },
    { name: "analyses", run: () => C.analyses(db) },
    { name: "alerts", run: async () => (await C.alerts(db)).sent },
    // The hosted site gets the new session straight away rather than at the next half-hourly publish.
    ...(isConfigured() ? [{ name: "publish", run: async () => Object.values(publish(db)).reduce((a, b) => a + b, 0) }] : []),
  ];
}
