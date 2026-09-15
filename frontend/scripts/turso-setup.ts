// One-time setup of the hosted database: create it on Turso from a local snapshot and save its credentials.
//   TURSO_API_TOKEN in ../.env, then: npx tsx scripts/turso-setup.ts D:/market-deploy/bse.db
// Tokens are written to .env only; nothing secret is printed.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/server/config";
import { Db } from "../src/server/db";

const NAME = process.env.TURSO_DB_NAME ?? "market-terminal";
// Netlify's free functions run in US East (Ohio); the database sits next to them.
const PREFERRED = ["aws-us-east-2", "aws-us-east-1"];

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://api.turso.tech${url}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.TURSO_API_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${url}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

function saveEnv(values: Record<string, string>) {
  const file = path.join(ROOT, ".env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`;
    text = new RegExp(`^${k}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
  }
  fs.writeFileSync(file, text);
}

async function main() {
  const snapshot = process.argv[2];
  if (!snapshot || !fs.existsSync(snapshot)) throw new Error("usage: turso-setup.ts <snapshot.db>");
  if (!process.env.TURSO_API_TOKEN) throw new Error(`add TURSO_API_TOKEN=... to ${path.join(ROOT, ".env")} first`);

  const orgs = await api<{ slug: string; type: string; name: string }[]>("GET", "/v1/organizations");
  const org = orgs.find((o) => o.type === "personal") ?? orgs[0];
  console.log(`organisation: ${org.slug}`);

  const { locations } = await api<{ locations: Record<string, string> }>("GET", "/v1/locations");
  const groups = (await api<{ groups: { name: string; primary: string; locations: string[] }[] }>("GET", `/v1/organizations/${org.slug}/groups`)).groups;
  let group = groups.find((g) => PREFERRED.includes(g.primary)) ?? groups[0];
  if (!group) {
    const location = PREFERRED.find((l) => l in locations) ?? Object.keys(locations)[0];
    console.log(`creating group "default" in ${location} (${locations[location]})`);
    group = (await api<{ group: { name: string; primary: string; locations: string[] } }>("POST", `/v1/organizations/${org.slug}/groups`, { name: "default", location })).group;
  }
  console.log(`group: ${group.name}, primary location ${group.primary} (${locations[group.primary] ?? "?"})`);

  const existing = (await api<{ databases: { Name: string; Hostname: string }[] }>("GET", `/v1/organizations/${org.slug}/databases`)).databases.find((d) => d.Name === NAME);
  let hostname = existing?.Hostname;
  if (existing) {
    console.log(`database ${NAME} already exists (${hostname}); uploading into it again is not possible, delete it first to re-seed`);
  } else {
    const created = await api<{ database: { Name: string; Hostname: string } }>("POST", `/v1/organizations/${org.slug}/databases`, { name: NAME, group: group.name, seed: { type: "database_upload" } });
    hostname = created.database.Hostname;
    console.log(`created database ${NAME} (${hostname})`);
  }

  const { jwt } = await api<{ jwt: string }>("POST", `/v1/organizations/${org.slug}/databases/${NAME}/auth/tokens?authorization=full-access`);
  saveEnv({ TURSO_DATABASE_URL: `libsql://${hostname}`, TURSO_AUTH_TOKEN: jwt });
  console.log("saved TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to .env");

  if (!existing) {
    const size = fs.statSync(snapshot).size;
    console.log(`uploading ${(size / 1e9).toFixed(2)} GB, this takes a while...`);
    // curl streams the file (-T) instead of loading 2.7 GB into memory; the token goes in via a config on stdin.
    const up = spawnSync("curl.exe", ["-sS", "--fail-with-body", "-X", "POST", "-T", snapshot, "-K", "-", "-o", "-", "-w", "\nHTTP %{http_code} in %{time_total}s\n", `https://${hostname}/v1/upload`], {
      input: `header = "Authorization: Bearer ${jwt}"\n`, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    console.log((up.stdout || "").slice(-400), (up.stderr || "").slice(-400));
    if (up.status !== 0) throw new Error(`upload failed (curl exit ${up.status})`);
  }

  const remote = new Db({ kind: "remote", url: `libsql://${hostname}`, token: jwt });
  const t = Date.now();
  const metrics = remote.scalar("SELECT COUNT(*) FROM company_metrics");
  const last = remote.scalar("SELECT MAX(trade_date) FROM nse_bhavcopy_day WHERE status = 'ok'");
  console.log(`hosted database answers: ${metrics} companies, last NSE session ${last} (${Date.now() - t} ms)`);
  remote.close();
}

main().then(() => process.exit(0), (e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
