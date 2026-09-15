// HTTP plumbing shared by the NSE and BSE clients: throttle, cookie jar and retries.
import { config } from "./config";
import { sleep } from "./util";

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class HttpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}
export class NotFound extends HttpError {}
/** Endpoint sits behind a bot manager that needs a real browser; we do not try to get around it. */
export class Blocked extends HttpError {}
/** The server understood the request but rejected its parameters. */
export class BadRequest extends HttpError {}

/** Minimum interval between requests, shared by everything holding the same instance. */
export class Throttle {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  readonly minInterval: number;

  constructor(rps: number) {
    this.minInterval = rps > 0 ? 1000 / rps : 0;
  }

  wait(): Promise<void> {
    if (!this.minInterval) return Promise.resolve();
    const step = this.chain.then(async () => {
      const gap = this.last + this.minInterval - Date.now();
      if (gap > 0) await sleep(gap);
      this.last = Date.now();
    });
    this.chain = step.catch(() => undefined);
    return step;
  }
}

export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }
}

export interface ClientOptions { rps?: number; maxRetries?: number; timeoutS?: number; throttle?: Throttle }

export abstract class BaseClient {
  throttle: Throttle;
  readonly maxRetries: number;
  readonly timeoutMs: number;
  readonly jar = new CookieJar();
  protected warm = false;

  constructor(opts: ClientOptions = {}) {
    this.throttle = opts.throttle ?? new Throttle(opts.rps ?? config.RATE_LIMIT_RPS);
    this.maxRetries = opts.maxRetries ?? config.MAX_RETRIES;
    this.timeoutMs = (opts.timeoutS ?? config.TIMEOUT_S) * 1000;
  }

  protected async fetchOnce(url: string, headers: Record<string, string>, redirect: RequestRedirect = "follow"): Promise<Response> {
    await this.throttle.wait();
    const res = await fetch(url, {
      headers: { ...headers, ...(this.jar.size ? { Cookie: this.jar.header() } : {}) },
      redirect,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    this.jar.absorb(res);
    return res;
  }

  protected backoff(attempt: number) {
    return sleep(2 ** attempt * 1000 + Math.random() * 500);
  }
}

export function withQuery(url: string, params?: Record<string, string | number | undefined | null>) {
  if (!params) return url;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const qs = q.toString();
  return qs ? `${url}${url.includes("?") ? "&" : "?"}${qs}` : url;
}
