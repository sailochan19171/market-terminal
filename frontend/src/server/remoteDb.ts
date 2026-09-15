// Turso (hosted libSQL) over its HTTP API, behind the same synchronous interface as the local SQLite driver.
//
// Every query in this codebase is written synchronously (node:sqlite). Rather than rewrite all of it, remote
// statements run in a worker thread and the calling thread blocks on Atomics.wait until the response arrives,
// so one code path serves the local database and the hosted one.
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

export type Value = string | number | bigint | null | Uint8Array;
type Row = Record<string, unknown>;

export interface RunResult { changes: number; lastInsertRowid: number }

const TIMEOUT_MS = 55_000;
const BATCH = 200;

// Runs in the worker: one POST per message, the reply goes back on the given port.
const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", async ({ signal, port, url, token, body }) => {
  let reply;
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body });
    reply = { status: r.status, text: await r.text() };
  } catch (e) {
    reply = { error: String((e && e.message) || e) };
  }
  port.postMessage(reply);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
`;

type HranaValue = { type: "null" } | { type: "integer"; value: string } | { type: "float"; value: number } | { type: "text"; value: string } | { type: "blob"; base64: string };

function encode(v: Value): HranaValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "bigint") return { type: "integer", value: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) ? { type: "integer", value: String(v) } : { type: "float", value: v };
  if (v instanceof Uint8Array) return { type: "blob", base64: Buffer.from(v).toString("base64") };
  return { type: "text", value: String(v) };
}

function decode(v: HranaValue): unknown {
  switch (v.type) {
    case "null": return null;
    case "integer": return Number(v.value);
    case "float": return v.value;
    case "text": return v.value;
    case "blob": return new Uint8Array(Buffer.from(v.base64, "base64"));
  }
}

interface ExecResult { cols: { name: string }[]; rows: HranaValue[][]; affected_row_count: number; last_insert_rowid: string | null }

export class RemoteDriver {
  private worker: Worker;
  private baton: string | null = null;
  private baseUrl: string;
  private depth = 0;

  constructor(url: string, private token: string) {
    this.baseUrl = url.replace(/^libsql:\/\//, "https://").replace(/\/+$/, "");
    this.worker = new Worker(WORKER_SOURCE, { eval: true });
    this.worker.unref();
  }

  get inTransaction() {
    return this.depth > 0;
  }

  /** One synchronous round trip to /v2/pipeline. */
  private pipeline(requests: unknown[], keepOpen: boolean): { type: string; response?: { result?: ExecResult }; error?: { message: string } }[] {
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    const body = JSON.stringify({ baton: this.baton, requests: keepOpen ? requests : [...requests, { type: "close" }] });
    this.worker.postMessage({ signal, port: port2, url: `${this.baseUrl}/v2/pipeline`, token: this.token, body }, [port2]);
    if (Atomics.wait(signal, 0, 0, TIMEOUT_MS) === "timed-out") {
      port1.close();
      throw new Error("database request timed out");
    }
    const reply = receiveMessageOnPort(port1)?.message as { status?: number; text?: string; error?: string } | undefined;
    port1.close();
    if (!reply || reply.error) throw new Error(`database unreachable: ${reply?.error ?? "no reply"}`);
    if (reply.status !== 200) throw new Error(`database HTTP ${reply.status}: ${reply.text?.slice(0, 300)}`);
    const parsed = JSON.parse(reply.text!) as { baton: string | null; base_url: string | null; results: { type: string; response?: { result?: ExecResult }; error?: { message: string } }[] };
    this.baton = keepOpen ? parsed.baton : null;
    if (parsed.base_url) this.baseUrl = parsed.base_url.replace(/\/+$/, "");
    return parsed.results;
  }

  private check(results: ReturnType<RemoteDriver["pipeline"]>): ExecResult[] {
    return results.filter((r) => r.type !== "ok" || r.response?.result).map((r) => {
      if (r.type !== "ok") throw new Error(r.error?.message ?? "database error");
      return r.response!.result!;
    });
  }

  execute(sql: string, params: Value[]): ExecResult {
    const req = { type: "execute", stmt: { sql, args: params.map(encode) } };
    return this.check(this.pipeline([req], this.inTransaction))[0];
  }

  all(sql: string, params: Value[]): Row[] {
    const res = this.execute(sql, params);
    const names = res.cols.map((c) => c.name);
    return res.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, decode(r[i])])));
  }

  run(sql: string, params: Value[]): RunResult {
    const res = this.execute(sql, params);
    return { changes: res.affected_row_count, lastInsertRowid: Number(res.last_insert_rowid ?? 0) };
  }

  /** Several statements separated by semicolons (schema scripts). */
  exec(sql: string) {
    this.check(this.pipeline([{ type: "sequence", sql }], this.inTransaction));
  }

  /** The same statement for many parameter lists, a couple of hundred per round trip, atomically. */
  runMany(sql: string, paramsList: Value[][]): number {
    let changes = 0;
    for (let i = 0; i < paramsList.length; i += BATCH) {
      const chunk = paramsList.slice(i, i + BATCH).map((p) => ({ type: "execute", stmt: { sql, args: p.map(encode) } }));
      const wrapped = this.inTransaction ? chunk : [{ type: "execute", stmt: { sql: "BEGIN" } }, ...chunk, { type: "execute", stmt: { sql: "COMMIT" } }];
      for (const r of this.check(this.pipeline(wrapped, this.inTransaction))) changes += r.affected_row_count;
    }
    return changes;
  }

  begin() {
    if (this.depth++ === 0) this.check(this.pipeline([{ type: "execute", stmt: { sql: "BEGIN" } }], true));
  }

  commit() {
    if (--this.depth === 0) this.check(this.pipeline([{ type: "execute", stmt: { sql: "COMMIT" } }], false));
  }

  rollback() {
    this.depth = 0;
    try {
      this.check(this.pipeline([{ type: "execute", stmt: { sql: "ROLLBACK" } }], false));
    } finally {
      this.baton = null;
    }
  }

  close() {
    void this.worker.terminate();
  }
}
