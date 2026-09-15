// HTTP client for NSE.
//
// Two hosts behave differently:
//   * nsearchives.nseindia.com - the bulk archive (bhavcopy, master lists, XBRL). Plain files.
//   * www.nseindia.com/api/... - JSON endpoints. Most work after a cookie warm-up; a few sit behind
//     Akamai Bot Manager and answer "Access Denied" to non-browser clients. Those raise Blocked and are
//     not worked around - they are an explicit access control.
import { BaseClient, Blocked, HttpError, NotFound, withQuery, type ClientOptions, UA } from "../http";
import { logger } from "../log";

const log = logger("nse.client");

export const WWW = "https://www.nseindia.com";
export const API = WWW + "/api";
export const ARCHIVES = "https://nsearchives.nseindia.com";

const DOC_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
};

const XHR_HEADERS: Record<string, string> = {
  "User-Agent": UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9", Referer: WWW + "/",
  "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", "X-Requested-With": "XMLHttpRequest",
};

const WARMUP_PAGES = ["/", "/market-data/live-equity-market"];
const BLOCK_MARKERS = ["Access Denied", "<TITLE>Access Denied</TITLE>"];

export class NSEClient extends BaseClient {
  constructor(opts: ClientOptions = {}) {
    super(opts);
  }

  /** Load a couple of ordinary pages to establish cookies, as a browser would. */
  async warmup(force = false) {
    if (this.warm && !force) return;
    this.warm = true;
    if (force) this.jar.clear();
    for (const page of WARMUP_PAGES) {
      try {
        const res = await this.fetchOnce(WWW + page, DOC_HEADERS);
        await res.arrayBuffer();
      } catch (e) {
        log.debug(`warmup ${page} failed: ${(e as Error).message}`);
      }
    }
  }

  private async request(url: string): Promise<Response> {
    await this.warmup();
    let last: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchOnce(url, XHR_HEADERS);
        if (res.status === 404) {
          await res.arrayBuffer();
          throw new NotFound(url, 404);
        }
        if (res.status === 401 || res.status === 403) {
          const head = (await res.text()).slice(0, 400);
          if (BLOCK_MARKERS.some((m) => head.includes(m))) throw new Blocked(url, res.status);
          if (attempt === 0) {
            // A stale cookie jar also shows up as 403: re-warm once.
            await this.warmup(true);
            last = new HttpError("HTTP 403", 403);
            continue;
          }
          throw new Blocked(url, res.status);
        }
        if (res.status >= 500 || res.status === 429) {
          await res.arrayBuffer();
          last = new HttpError(`HTTP ${res.status}`, res.status);
        } else if (!res.ok) {
          await res.arrayBuffer();
          throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
        } else {
          return res;
        }
      } catch (e) {
        if (e instanceof NotFound || e instanceof Blocked || (e instanceof HttpError && e.status && e.status < 500 && e.status !== 429 && e.status !== 403)) throw e;
        last = e;
      }
      if (attempt < this.maxRetries) await this.backoff(attempt);
    }
    throw new HttpError(`giving up on ${url}: ${(last as Error)?.message ?? last}`);
  }

  /** GET a www.nseindia.com/api endpoint and decode JSON. */
  async api<T = unknown>(path: string, params?: Record<string, string | number | undefined | null>): Promise<T | null> {
    const res = await this.request(withQuery(`${API}/${path.replace(/^\//, "")}`, params));
    const text = (await res.text()).trim();
    if (BLOCK_MARKERS.some((m) => text.slice(0, 400).includes(m))) throw new Blocked(path);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(`non-JSON from ${path}: ${text.slice(0, 200)}`);
    }
  }

  /** GET a file from nsearchives.nseindia.com (or any absolute URL). */
  async archive(path: string): Promise<Uint8Array> {
    const url = path.startsWith("http") ? path : `${ARCHIVES}/${path.replace(/^\//, "")}`;
    const res = await this.request(url);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A client that shares this one's rate limit (for parallel downloads). */
  sibling(): NSEClient {
    return new NSEClient({ throttle: this.throttle, maxRetries: this.maxRetries, timeoutS: this.timeoutMs / 1000 });
  }
}
