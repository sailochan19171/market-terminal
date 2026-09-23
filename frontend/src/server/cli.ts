// Command line for the data pipeline (replaces run.py).
//
//   npm run market -- status
//   npm run market -- nse-bhavcopy --years 0.1
//   npm run market -- daily            (run the daily update now)
//   npm run market -- jobs             (the background job runner, as the web server starts it)
import fs from "node:fs";
import readline from "node:readline";
import { Writable } from "node:stream";
import { config } from "./config";
import { getDb, init, now, type Db } from "./db";
import { logger, logToFile } from "./log";
import { db as schemaDb } from "./api/common";
import * as C from "./jobs/commands";
import { dailySteps } from "./jobs/steps";
import { runSteps } from "./jobs/scheduler";
import * as jobState from "./jobs/state";
import { BSEClient } from "./bse/client";
import { NSEClient } from "./nse/client";
import * as bseAnnouncements from "./bse/announcements";
import * as quotes from "./bse/quotes";
import * as F from "./nse/fundamentals";
import { addRule, listRules, seedDefaults } from "./alerts/rules";
import { importCasData, importCsv, ImportError, latestSnapshot, saveWatchlist } from "./core/portfolio";
import { CasFormatError, CasPasswordError, parseCas } from "./core/cas";
import { initFromSnapshot, publish, publishLive } from "./jobs/publish";
import { progress as backfillProgress } from "./jobs/backfill";
import { buildAll as buildKb, stats as kbStats } from "./research/kb";

const log = logger("cli");

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command: string; positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

const str = (f: Flags, k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const num = (f: Flags, k: string) => (str(f, k) !== undefined ? Number(str(f, k)) : undefined);

function day(f: Flags, k: string): string | undefined {
  const v = str(f, k);
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${k}: expected YYYY-MM-DD, got '${v}'`);
  return v;
}

const windowOf = (f: Flags): C.Window => ({ start: day(f, "start"), end: day(f, "end"), years: num(f, "years") });

const fmt = (v: unknown) => (v === null || v === undefined ? "-" : typeof v === "number" ? v.toFixed(2) : String(v));

/** Read a secret from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  process.stdout.write(prompt);
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => rl.question("", (answer) => {
    rl.close();
    process.stdout.write("\n");
    resolve(answer);
  }));
}

const HELP = `Indian market data pipeline (BSE + NSE)

  status                         what is in the database
  init                           create the database and folders
  daily                          run the daily update now
  jobs                           run the background job runner in the foreground
  metrics                        rebuild per-company derived metrics
  analyses [--limit N]           store scheduled analysis versions
  scrips [--segments a,b] [--active-only]
  bhavcopy [--start D] [--end D] [--years Y] [--refetch] [--no-raw]
  announcements [window] [--scrip CODE] [--refetch]
  corp-actions [--per-scrip] [--limit N]
  indices
  quotes [--scrips a,b] [--watchlist NAME]
  sync-all [window] [--no-raw]
  broker [--broker NAME] [--watchlist NAME] [--no-watchlist]
  portfolio show|import FILE.csv|cas FILE.pdf [--broker LABEL] [--exchange NSE|BSE] [--watchlist NAME]
  watchlist list|add|remove [SYMBOLS...] [--name NAME] [--exchange BSE|NSE]
  alerts run|list|add|seed [--name --kind --params JSON] [--rule R] [--channels a,b] [--dry-run] [--resend] [--limit N]
  nse-symbols
  nse-bhavcopy [window] [--refetch] [--no-raw]
  nse-fundamentals [--limit N] [--index-only] [--loop]
  nse-index-history [window]
  nse-indices [--no-constituents]
  nse-corporate [window] [--only a,b]
  nse-sync-all [window] [--no-raw]
  watch [--every 60] [--minutes N] [--no-orders]
                                 watch BSE announcements live; writes new filings as they appear and
                                 reads each new order filing into figures
  watch [--every 60] [--minutes N] [--no-orders]
                                 watch BSE announcements live; writes new filings as they appear and
                                 reads each new order filing into figures
  publish                        push new and changed rows to the hosted Turso database
  publish init --from FILE       start publishing from the snapshot that was uploaded to Turso
  publish live                   publish the live market pulse once
  kb [--force] [--limit N]       rebuild the research knowledge base from the stored filings
`;

async function run(command: string, pos: string[], f: Flags, db: Db): Promise<number> {
  const print = (s: string) => console.log(s);
  switch (command) {
    case "help":
    case "--help":
      print(HELP);
      return 0;

    case "init": {
      const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
      print(`database : ${config.DB_PATH}\nraw files: ${config.RAW_DIR}\ntables   : ${tables.join(", ")}`);
      return 0;
    }

    case "status": {
      const count = (sql: string) => (db.hasTable(sql.split(" FROM ")[1].split(" ")[0]) ? db.scalar(sql) : "-");
      print(`database: ${config.DB_PATH}`);
      const sections: [string, [string, string][]][] = [
        ["BSE", [["scrips", "SELECT COUNT(*) FROM scrip"], ["bhavcopy rows", "SELECT COUNT(*) FROM bhavcopy"], ["trading days", "SELECT COUNT(*) FROM bhavcopy_day WHERE status='ok'"],
          ["announcements", "SELECT COUNT(*) FROM announcement"], ["corp actions", "SELECT COUNT(*) FROM corp_action"], ["indices", "SELECT COUNT(*) FROM bse_index"],
          ["holdings", "SELECT COUNT(*) FROM holding"], ["watchlist", "SELECT COUNT(*) FROM watchlist"], ["alert rules", "SELECT COUNT(*) FROM alert_rule"], ["alerts sent", "SELECT COUNT(*) FROM alert_sent"]]],
        ["NSE", [["nse symbols", "SELECT COUNT(*) FROM nse_symbol"], ["nse bhavcopy", "SELECT COUNT(*) FROM nse_bhavcopy"], ["nse trading days", "SELECT COUNT(*) FROM nse_bhavcopy_day WHERE status='ok'"],
          ["nse announcements", "SELECT COUNT(*) FROM nse_announcement"], ["nse corp actions", "SELECT COUNT(*) FROM nse_corp_action"], ["nse indices", "SELECT COUNT(*) FROM nse_index"],
          ["nse constituents", "SELECT COUNT(*) FROM nse_index_constituent"], ["nse results", "SELECT COUNT(*) FROM nse_financial_result"], ["nse fundamentals", "SELECT COUNT(*) FROM nse_fundamental"],
          ["nse shareholding", "SELECT COUNT(*) FROM nse_shareholding"], ["nse board meetings", "SELECT COUNT(*) FROM nse_board_meeting"], ["nse insider trades", "SELECT COUNT(*) FROM nse_insider_trade"]]],
      ];
      for (const [label, rows] of sections) {
        print(`  -- ${label} --`);
        for (const [name, sql] of rows) print(`  ${name.padEnd(18)} ${count(sql)}`);
      }
      print(`  ${"filings pending".padEnd(18)} ${F.pendingCount(db)}`);
      print("\njobs:");
      for (const j of jobState.all(db)) print(`  ${String(j.name).padEnd(10)} ${String(j.status ?? "?").padEnd(8)} started ${j.last_started ?? "-"}  heartbeat ${j.heartbeat ?? "-"}  ${j.message ?? ""}`);
      print("\nfull-history backfill:");
      for (const b of backfillProgress(db)) print(`  ${String(b.source).padEnd(20)} ${String(b.status).padEnd(9)} back to ${b.reached ?? "-"}  (${b.rows ?? 0} rows)  ${b.message ?? ""}`);
      print("\nrecent runs:");
      for (const r of db.all("SELECT task, started_at, status, rows FROM run_log ORDER BY id DESC LIMIT 8")) {
        print(`  ${String(r.task).padEnd(20)} ${String(r.started_at).padEnd(26)} ${String(r.status ?? "?").padEnd(6)} ${r.rows ?? 0}`);
      }
      return 0;
    }

    case "daily": {
      logToFile("jobs");
      const { ok, failed } = await runSteps(db, dailySteps());
      print(`daily update: ${ok} steps ok${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
      return failed.length ? 1 : 0;
    }

    case "jobs":
      await import("./jobs/runner");
      return new Promise<number>(() => {}); // the runner exits the process itself

    case "metrics":
      print(`company metrics: ${await C.metrics(db)} rows`);
      return 0;
    case "analyses":
      print(`analyses: ${await C.analyses(db, num(f, "limit"))} new versions`);
      return 0;
    case "scrips":
      print(`scrip master: ${await C.scrips(db, { segments: str(f, "segments")?.split(","), includeInactive: !f["active-only"] })} rows`);
      return 0;
    case "bhavcopy":
      print(`bhavcopy: ${await C.bhavcopy(db, windowOf(f), { refetch: Boolean(f.refetch), saveRaw: !f["no-raw"] })} rows`);
      return 0;
    case "announcements": {
      if (str(f, "scrip")) {
        const [start, end] = C.dateWindow(windowOf(f));
        const rows = await bseAnnouncements.fetchScrip(new BSEClient(), str(f, "scrip")!, start, end);
        print(`announcements: ${db.upsert("announcement", rows as never[])} rows`);
      } else print(`announcements: ${await C.announcements(db, windowOf(f), { refetch: Boolean(f.refetch) })} rows`);
      return 0;
    }
    case "watch": {
      // The live announcement watcher: new filings within a minute, order filings read as they land.
      const { watch } = await import("./bse/live");
      const seen = await watch(db, {
        intervalMs: (num(f, "every") ?? 60) * 1000,
        runForMs: num(f, "minutes") ? num(f, "minutes")! * 60_000 : undefined,
        readOrders: f["no-orders"] !== true,
      });
      print(`watch: ${seen.polls} polls, ${seen.filings} new filings, ${seen.orders} order wins`);
      return 0;
    }
    case "watch": {
      // The live announcement watcher: new filings within a minute, order filings read as they land.
      const { watch } = await import("./bse/live");
      const seen = await watch(db, {
        intervalMs: (num(f, "every") ?? 60) * 1000,
        runForMs: num(f, "minutes") ? num(f, "minutes")! * 60_000 : undefined,
        readOrders: f["no-orders"] !== true,
      });
      print(`watch: ${seen.polls} polls, ${seen.filings} new filings, ${seen.orders} order wins`);
      return 0;
    }
    case "corp-actions":
      print(`corporate actions: ${await C.bseCorpActions(db, { perScrip: Boolean(f["per-scrip"]), limit: num(f, "limit") })} rows`);
      return 0;
    case "indices":
      print(`indices: ${await C.bseIndexSync(db)} rows`);
      return 0;
    case "quotes": {
      const codes = str(f, "scrips")?.split(",") ?? db.all<{ scrip_cd: string }>("SELECT scrip_cd FROM watchlist WHERE name = ? AND scrip_cd IS NOT NULL", [str(f, "watchlist") ?? "default"]).map((r) => String(r.scrip_cd));
      if (!codes.length) {
        print("nothing to quote - add scrips to a watchlist or pass --scrips");
        return 1;
      }
      print(`quote snapshots: ${await quotes.snapshot(new BSEClient(), db, codes)}`);
      return 0;
    }
    case "sync-all": {
      const w = windowOf(f);
      let total = await C.scrips(db);
      total += await C.bseIndexSync(db);
      total += await C.bseCorpActions(db);
      total += await C.bhavcopy(db, w, { saveRaw: !f["no-raw"] });
      total += await C.announcements(db, w);
      print(`full sync complete: ${total} rows`);
      return 0;
    }
    case "broker": {
      const out = await C.broker(db, { name: str(f, "broker"), watchlist: f["no-watchlist"] ? null : str(f, "watchlist") ?? "default" });
      if (!out) {
        print("no broker configured - set BROKER and its credentials in .env");
        return 1;
      }
      print(`${out.broker} holdings: ${out.holdings} rows; watchlist: ${out.watchlist} symbols`);
      return 0;
    }

    case "portfolio": {
      const action = pos[0] ?? "show";
      const file = pos[1];
      const watchlist = str(f, "watchlist") ?? "default";
      if (action === "cas") {
        if (!file) return print("portfolio cas needs a PDF path"), 1;
        // Prompted, not read from the command line, so it never lands in shell history. Kept in memory only.
        const password = await askHidden("Statement password (usually your PAN): ");
        try {
          const res = importCasData(db, await parseCas(new Uint8Array(fs.readFileSync(file)), password), str(f, "broker") ?? "cas", watchlist);
          print(`imported ${res.written} holdings from ${res.file_type} statement (${res.equity} equities, ${res.mutual_fund} mutual funds, ${res.bond} bonds)`);
          return 0;
        } catch (e) {
          if (e instanceof CasPasswordError) print("Could not open the statement: the password is incorrect.");
          else if (e instanceof CasFormatError || e instanceof ImportError) print((e as Error).message);
          else throw e;
          return 1;
        }
      }
      if (action === "import") {
        if (!file || !fs.existsSync(file)) return print(file ? `no such file: ${file}` : "portfolio import needs a CSV path"), 1;
        try {
          const [n, m] = importCsv(db, fs.readFileSync(file, "utf8"), str(f, "broker") ?? "manual", str(f, "exchange") ?? null, watchlist);
          print(`imported ${n} holdings from ${file}${m ? `\nwatchlist '${watchlist}': ${m} symbols` : ""}`);
          return 0;
        } catch (e) {
          if (e instanceof ImportError) return print(`could not read ${file}: ${e.message}`), 1;
          throw e;
        }
      }
      const rows = latestSnapshot(db, str(f, "broker"));
      if (!rows.length) return print("no holdings stored - import a broker CSV with:\n    npm run market -- portfolio import <file.csv>"), 0;
      print(`${"SYMBOL".padEnd(14)} ${"EXCH".padEnd(4)} ${"QTY".padStart(10)} ${"AVG".padStart(10)} ${"LTP".padStart(10)} ${"VALUE".padStart(12)} ${"GAIN%".padStart(10)}`);
      let value = 0, cost = 0;
      for (const r of rows) {
        print(`${String(r.symbol).padEnd(14)} ${String(r.exchange || "-").padEnd(4)} ${fmt(r.quantity).padStart(10)} ${fmt(r.avg_price).padStart(10)} ${fmt(r.close ?? r.last_price).padStart(10)} ${fmt(r.value).padStart(12)} ${fmt(r.gain_pct).padStart(10)}`);
        value += r.value || 0;
        cost += r.cost || 0;
      }
      print(`${"-".repeat(76)}\nTOTAL cost ${fmt(cost)}  value ${fmt(value)}  ${(cost ? ((value - cost) / cost) * 100 : 0).toFixed(2)}%`);
      return 0;
    }

    case "watchlist": {
      const action = pos[0] ?? "list";
      const symbols = pos.slice(1);
      const name = str(f, "name") ?? "default";
      const exchange = str(f, "exchange")?.toUpperCase();
      if (action === "add") {
        print(`added ${saveWatchlist(db, name, symbols.map((s) => ({ symbol: s, exchange: exchange ?? "BSE" })), "manual")} to watchlist '${name}'`);
      } else if (action === "remove") {
        for (const s of symbols) {
          if (exchange) db.run("DELETE FROM watchlist WHERE name = ? AND UPPER(symbol) = UPPER(?) AND UPPER(exchange) = UPPER(?)", [name, s, exchange]);
          else db.run("DELETE FROM watchlist WHERE name = ? AND UPPER(symbol) = UPPER(?)", [name, s]);
        }
        print(`removed ${symbols.length} from watchlist '${name}'`);
      } else {
        const rows = db.all("SELECT w.symbol, w.scrip_cd, w.exchange, s.scrip_name FROM watchlist w LEFT JOIN scrip s ON s.scrip_cd = w.scrip_cd WHERE w.name = ? ORDER BY w.symbol", [name]);
        if (!rows.length) return print(`watchlist '${name}' is empty`), 0;
        print(`watchlist '${name}' (${rows.length}):`);
        for (const r of rows) print(`  ${String(r.symbol).padEnd(14)} ${String(r.scrip_cd || "-").padEnd(8)} ${String(r.exchange).padEnd(6)} ${r.scrip_name ?? ""}`);
      }
      return 0;
    }

    case "alerts": {
      const action = pos[0] ?? "run";
      if (action === "seed") return print(`seeded ${seedDefaults(db)} default rules`), 0;
      if (action === "list") {
        for (const r of listRules(db)) print(`[${r.enabled ? "on " : "off"}] ${String(r.name).padEnd(24)} ${String(r.kind).padEnd(14)} ${r.params}`);
        return 0;
      }
      if (action === "add") {
        if (!str(f, "name") || !str(f, "kind")) return print("alerts add needs --name and --kind"), 1;
        let params;
        try {
          params = JSON.parse(str(f, "params") ?? "{}");
        } catch (e) {
          return print(`--params must be valid JSON: ${(e as Error).message}`), 1;
        }
        addRule(db, str(f, "name")!, str(f, "kind")!, params);
        return print(`rule '${str(f, "name")}' saved`), 0;
      }
      const res = await C.alerts(db, { rule: str(f, "rule"), channels: str(f, "channels")?.split(","), dryRun: Boolean(f["dry-run"]), resend: Boolean(f.resend), limit: num(f, "limit"), print });
      print(`${res.hits} hits (${res.fresh} new)${res.sent ? `; sent ${res.sent} via ${res.channels.join(", ")}` : ""}`);
      return 0;
    }

    case "nse-symbols":
      print(`nse symbols: ${await C.nseSymbolSync(db)} rows`);
      return 0;
    case "nse-bhavcopy":
      print(`nse bhavcopy: ${await C.nseBhavcopySync(db, windowOf(f), { refetch: Boolean(f.refetch), saveRaw: !f["no-raw"] })} rows`);
      return 0;
    case "nse-fundamentals": {
      const client = new NSEClient({ rps: config.FUNDAMENTALS_RPS });
      const priorityOnly = Boolean(f["index-only"]);
      const n = f.loop
        ? await F.runUntilDone(client, db, { priorityOnly })
        : await F.sync(client, db, { limit: num(f, "limit") ?? null, priorityOnly });
      print(`nse fundamentals: ${typeof n === "number" ? n : JSON.stringify(n)}`);
      return 0;
    }
    case "nse-index-history":
      print(`nse index history: ${await C.nseIndexHistorySync(db, windowOf(f))} rows`);
      return 0;
    case "nse-indices":
      print(`nse indices: ${await C.nseIndexSync(db, !f["no-constituents"])} rows`);
      return 0;
    case "nse-corporate":
      print(`nse corporate data: ${await C.nseCorporate(db, windowOf(f), str(f, "only")?.split(","))} rows`);
      return 0;
    case "nse-sync-all": {
      const w = windowOf(f);
      let total = await C.nseSymbolSync(db);
      total += await C.nseIndexSync(db);
      total += await C.nseCorporate(db, w);
      total += await C.nseBhavcopySync(db, w, { saveRaw: !f["no-raw"] });
      print(`nse full sync complete: ${total} rows`);
      return 0;
    }
    case "kb": {
      const out = buildKb(db, { force: Boolean(f.force), limit: num(f, "limit") });
      print(`knowledge base: ${out.companies} companies, ${out.docs} documents`);
      print(JSON.stringify(kbStats(db)));
      return 0;
    }

    case "publish": {
      if (pos[0] === "init") {
        const from = str(f, "from");
        if (!from) return print("publish init needs --from <snapshot file>"), 1;
        initFromSnapshot(from);
        print("publish marks set from " + from);
        return 0;
      }
      if (pos[0] === "live") {
        await publishLive();
        print("live pulse published");
        return 0;
      }
      const sent = publish(db);
      print(Object.entries(sent).filter(([, n]) => n).map(([t, n]) => `  ${t.padEnd(26)} ${n}`).join("\n") || "  nothing new");
      return 0;
    }

    default:
      print(`unknown command '${command}'\n\n${HELP}`);
      return 2;
  }
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  if (command === "jobs") return run(command, positional, flags, getDb());
  const db = command === "help" || command === "--help" ? getDb() : schemaDb();
  init(db);
  log.debug(`${command} at ${now()}`);
  return run(command, positional, flags, db);
}

main().then((code) => process.exit(code), (e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
