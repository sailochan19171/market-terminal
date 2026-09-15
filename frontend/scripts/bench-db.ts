import { Db, init } from "../src/server/db";

function time(label: string, fn: () => void) {
  const t = performance.now();
  fn();
  console.log(label, Math.round(performance.now() - t), "ms");
}

const db = new Db();
time("200 gets before init", () => { for (let i = 0; i < 200; i++) db.get("SELECT close FROM company_metrics WHERE symbol = ?", ["INFY"]); });
time("init", () => init(db));
time("200 gets after init", () => { for (let i = 0; i < 200; i++) db.get("SELECT close FROM company_metrics WHERE symbol = ?", ["INFY"]); });
time("200 raw prepared after init", () => { const st = db.raw.prepare("SELECT close FROM company_metrics WHERE symbol = ?"); for (let i = 0; i < 200; i++) st.get("INFY"); });
console.log("in transaction?", db.raw.isTransaction);
