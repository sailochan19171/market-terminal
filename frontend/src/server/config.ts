// Configuration from the environment and the pipeline's .env file.
import fs from "node:fs";
import path from "node:path";

/** The pipeline root (the folder holding data/ and .env), one level above the Next.js app. */
function findRoot(): string {
  if (process.env.MARKET_ROOT) return path.resolve(process.env.MARKET_ROOT);
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "data")) && fs.existsSync(path.join(dir, "frontend"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), "..");
}

export const ROOT = findRoot();

// Minimal .env loader: KEY=value lines, # comments, optional quotes. Real env vars win.
(() => {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2].replace(/\s+#.*$/, "").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

const s = (key: string, def = "") => (process.env[key] ?? def).trim() || def;
const f = (key: string, def: number) => {
  const v = Number(s(key));
  return s(key) && Number.isFinite(v) ? v : def;
};
const p = (key: string, def: string) => {
  const raw = s(key, def);
  return path.isAbsolute(raw) ? raw : path.join(/* turbopackIgnore: true */ ROOT, raw);
};
const list = (key: string) => s(key).split(",").map((x) => x.trim()).filter(Boolean);

export const config = {
  DB_PATH: p("BSE_DB_PATH", "data/bse.db"),
  RAW_DIR: p("BSE_RAW_DIR", "data/raw"),
  LOG_DIR: p("MARKET_LOG_DIR", "data/logs"),
  BACKFILL_YEARS: f("BSE_BACKFILL_YEARS", 2),
  RATE_LIMIT_RPS: f("BSE_RATE_LIMIT_RPS", 2),
  MAX_RETRIES: f("BSE_MAX_RETRIES", 4),
  TIMEOUT_S: f("BSE_TIMEOUT", 30),

  ALERT_CHANNELS: list("ALERT_CHANNELS").map((c) => c.toLowerCase()),
  TELEGRAM_BOT_TOKEN: s("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_CHAT_ID: s("TELEGRAM_CHAT_ID"),
  SMTP_HOST: s("SMTP_HOST"),
  SMTP_PORT: f("SMTP_PORT", 587),
  SMTP_USER: s("SMTP_USER"),
  SMTP_PASSWORD: s("SMTP_PASSWORD"),
  ALERT_EMAIL_FROM: s("ALERT_EMAIL_FROM"),
  ALERT_EMAIL_TO: list("ALERT_EMAIL_TO"),

  BROKER: s("BROKER").toLowerCase(),
  KITE_API_KEY: s("KITE_API_KEY"),
  KITE_ACCESS_TOKEN: s("KITE_ACCESS_TOKEN"),
  UPSTOX_ACCESS_TOKEN: s("UPSTOX_ACCESS_TOKEN"),
  ANGEL_API_KEY: s("ANGEL_API_KEY"),
  ANGEL_CLIENT_ID: s("ANGEL_CLIENT_ID"),
  ANGEL_PASSWORD: s("ANGEL_PASSWORD"),
  ANGEL_TOTP_SECRET: s("ANGEL_TOTP_SECRET"),

  /** "turso" on the hosted site: read and write the Turso database instead of the local file. */
  DB_MODE: s("MARKET_DB", "local").toLowerCase(),
  TURSO_DATABASE_URL: s("TURSO_DATABASE_URL"),
  TURSO_AUTH_TOKEN: s("TURSO_AUTH_TOKEN"),

  /** Set MARKET_JOBS=off to run the web app without background data jobs. The hosted site never runs them:
   *  serverless functions cannot keep a worker alive, so this PC updates the data and publishes it. */
  JOBS_ENABLED: s("MARKET_JOBS", "on").toLowerCase() !== "off" && s("MARKET_DB", "local").toLowerCase() !== "turso",
  FUNDAMENTALS_WORKERS: f("FUNDAMENTALS_WORKERS", 4),
  FUNDAMENTALS_RPS: f("FUNDAMENTALS_RPS", 4),
};

export function ensureDirs() {
  for (const d of [path.dirname(config.DB_PATH), config.RAW_DIR, config.LOG_DIR]) fs.mkdirSync(d, { recursive: true });
}
