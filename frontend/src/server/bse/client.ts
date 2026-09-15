// HTTP client for BSE.
//
// BSE's WAF rejects requests without browser-shaped headers, and api.bseindia.com needs an
// Origin/Referer from www.bseindia.com. Bad parameters come back as a 302 to its error page.
import { BadRequest, BaseClient, HttpError, NotFound, withQuery, type ClientOptions, UA } from "../http";
import { logger } from "../log";

const log = logger("bse.client");

export const WWW = "https://www.bseindia.com";
export const API = "https://api.bseindia.com/BseIndiaAPI/api";

const HEADERS: Record<string, string> = {
  "User-Agent": UA, Accept: "application/json, text/plain, */*", "Accept-Language": "en-US,en;q=0.9",
  Referer: WWW + "/", Origin: WWW, "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-site",
};
const ERROR_REDIRECT = "error_Bse.html";

export class BSEClient extends BaseClient {
  constructor(opts: ClientOptions = {}) {
    super(opts);
  }

  private async warmup() {
    if (this.warm) return;
    this.warm = true; // a failed warm-up must not loop
    try {
      const res = await this.fetchOnce(WWW + "/", HEADERS);
      await res.arrayBuffer();
    } catch (e) {
      log.warn(`cookie warmup failed (continuing anyway): ${(e as Error).message}`);
    }
  }

  private async request(url: string): Promise<Response> {
    await this.warmup();
    let last: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchOnce(url, HEADERS, "manual");
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get("location") ?? "";
          await res.arrayBuffer();
          if (loc.includes(ERROR_REDIRECT)) throw new BadRequest(`${url} rejected its parameters`);
          last = new HttpError(`unexpected redirect to ${loc}`);
        } else if (res.status === 404) {
          await res.arrayBuffer();
          throw new NotFound(url, 404);
        } else if (res.status >= 500 || res.status === 429) {
          await res.arrayBuffer();
          last = new HttpError(`HTTP ${res.status}`, res.status);
        } else if (!res.ok) {
          await res.arrayBuffer();
          throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
        } else {
          return res;
        }
      } catch (e) {
        if (e instanceof BadRequest || e instanceof NotFound || (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429)) throw e;
        last = e;
      }
      if (attempt < this.maxRetries) await this.backoff(attempt);
    }
    throw new HttpError(`giving up on ${url} after ${this.maxRetries + 1} attempts: ${(last as Error)?.message ?? last}`);
  }

  /** GET an api.bseindia.com JSON endpoint, e.g. "IndexList/w". */
  async api<T = unknown>(endpoint: string, params?: Record<string, string | number | undefined | null>): Promise<T | null> {
    const res = await this.request(withQuery(`${API}/${endpoint.replace(/^\//, "")}`, params));
    const text = (await res.text()).trim();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`non-JSON response from ${endpoint}: ${text.slice(0, 200)}`);
    }
  }

  /** GET any www.bseindia.com file (bhavcopy, PDFs). */
  async getBytes(url: string): Promise<Uint8Array> {
    const res = await this.request(url);
    return new Uint8Array(await res.arrayBuffer());
  }
}
