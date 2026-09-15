// Broker adapters: YOUR holdings through each broker's official REST API, with your own credentials from .env.
// Nothing here scrapes. Zerodha and Upstox tokens are day-scoped; Angel One logs in with a TOTP each run.
import crypto from "node:crypto";
import { config } from "../config";
import { now, type Db, type Row } from "../db";
import { logger } from "../log";

const log = logger("brokers");

export interface Broker {
  name: string;
  available(): boolean;
  holdings(): Promise<Row[]>;
  watchlist(): Promise<Row[]>;
}

async function getJson(url: string, init: RequestInit): Promise<Row> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${new URL(url).host} HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// Brokers expose no marketwatch endpoint worth using; seed the watchlist from holdings so alerts have something to act on.
const fromHoldings = (rows: Row[]) => rows.map((h) => ({ symbol: h.symbol, exchange: h.exchange, isin: h.isin ?? null }));

class Zerodha implements Broker {
  name = "zerodha";
  available() {
    return Boolean(config.KITE_API_KEY && config.KITE_ACCESS_TOKEN);
  }
  async holdings() {
    const payload = await getJson("https://api.kite.trade/portfolio/holdings", {
      headers: { "X-Kite-Version": "3", Authorization: `token ${config.KITE_API_KEY}:${config.KITE_ACCESS_TOKEN}` },
    });
    return ((payload.data ?? []) as Row[]).map((h) => ({
      symbol: h.tradingsymbol, isin: h.isin, exchange: h.exchange, quantity: Number(h.quantity || 0) + Number(h.t1_quantity || 0),
      avg_price: h.average_price, last_price: h.last_price, pnl: h.pnl, raw: null,
    }));
  }
  async watchlist() {
    return fromHoldings(await this.holdings());
  }
}

class Upstox implements Broker {
  name = "upstox";
  available() {
    return Boolean(config.UPSTOX_ACCESS_TOKEN);
  }
  async holdings() {
    const payload = await getJson("https://api.upstox.com/v2/portfolio/long-term-holdings", {
      headers: { Authorization: `Bearer ${config.UPSTOX_ACCESS_TOKEN}`, Accept: "application/json" },
    });
    return ((payload.data ?? []) as Row[]).map((h) => ({
      symbol: h.tradingsymbol ?? h.trading_symbol, isin: h.isin, exchange: h.exchange, quantity: h.quantity,
      avg_price: h.average_price, last_price: h.last_price, pnl: h.pnl, raw: null,
    }));
  }
  async watchlist() {
    return fromHoldings(await this.holdings());
  }
}

function base32(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/[\s=]/g, "").toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v < 0) throw new Error("ANGEL_TOTP_SECRET is not valid base32");
    bits += v.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), as pyotp produces. */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = crypto.createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

class AngelOne implements Broker {
  name = "angelone";
  private jwt: string | null = null;
  private base = "https://apiconnect.angelone.in";
  available() {
    return Boolean(config.ANGEL_API_KEY && config.ANGEL_CLIENT_ID && config.ANGEL_PASSWORD && config.ANGEL_TOTP_SECRET);
  }
  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json", Accept: "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": config.ANGEL_API_KEY,
      ...(this.jwt ? { Authorization: `Bearer ${this.jwt}` } : {}),
    };
  }
  private async login() {
    const session = await getJson(`${this.base}/rest/auth/angelbroking/user/v1/loginByPassword`, {
      method: "POST", headers: this.headers(),
      body: JSON.stringify({ clientcode: config.ANGEL_CLIENT_ID, password: config.ANGEL_PASSWORD, totp: totp(config.ANGEL_TOTP_SECRET) }),
    });
    if (!session.status || !session.data?.jwtToken) throw new Error(`Angel One login failed: ${session.message}`);
    this.jwt = session.data.jwtToken;
  }
  async holdings() {
    if (!this.jwt) await this.login();
    const payload = await getJson(`${this.base}/rest/secure/angelbroking/portfolio/v1/getHolding`, { headers: this.headers() });
    return ((payload.data ?? []) as Row[]).map((h) => ({
      symbol: h.tradingsymbol, isin: h.isin, exchange: h.exchange, quantity: h.quantity,
      avg_price: h.averageprice, last_price: h.ltp, pnl: h.profitandloss, raw: null,
    }));
  }
  async watchlist() {
    return fromHoldings(await this.holdings());
  }
}

const REGISTRY: Record<string, () => Broker> = { zerodha: () => new Zerodha(), upstox: () => new Upstox(), angelone: () => new AngelOne() };

/** The configured broker adapter, or null when none is set up. */
export function getBroker(name?: string | null): Broker | null {
  const key = (name || config.BROKER || "").toLowerCase();
  if (!key) return null;
  const make = REGISTRY[key];
  if (!make) {
    log.error(`unknown broker '${key}' (known: ${Object.keys(REGISTRY).join(", ")})`);
    return null;
  }
  const broker = make();
  if (!broker.available()) {
    log.error(`broker '${key}' is selected but its credentials are missing from .env`);
    return null;
  }
  return broker;
}

/** Persist a holdings snapshot, stamped with the current time. */
export function saveHoldings(db: Db, broker: string, rows: Row[]): number {
  const asOf = now();
  return db.upsert("holding", rows.map((r) => ({ ...r, broker, as_of: asOf })));
}
