// Put the pipeline's credentials into the repository's Actions secrets, so the scheduled workflow can reach
// the hosted database and the model.
//
// Values are read from .env and sent sealed (libsodium sealed box, as GitHub requires); nothing is printed.
//   npx tsx scripts/set-actions-secrets.ts <owner/repo>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import sodium from "libsodium-wrappers";

const REPO = process.argv[2] ?? "sailochan19171/market-terminal";
const WANTED = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN", "LLM_API_KEY"];

/** The token git already uses for this host, from the system credential store. */
function gitToken(): string {
  const out = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" });
  const token = out.split(/\r?\n/).find((l) => l.startsWith("password="))?.slice("password=".length);
  if (!token) throw new Error("no GitHub credential is stored for github.com");
  return token;
}

function fromEnvFile(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[2].trim()) out.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

async function api(token: string, url: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com${url}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...init.headers },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

async function main() {
  const env = fromEnvFile(path.join(process.cwd(), "..", ".env"));
  const missing = WANTED.filter((k) => !env.get(k));
  if (missing.length) throw new Error(`.env has no value for: ${missing.join(", ")}`);

  const token = gitToken();
  await sodium.ready;
  const key = await api(token, `/repos/${REPO}/actions/secrets/public-key`) as { key: string; key_id: string };

  for (const name of WANTED) {
    const sealed = sodium.crypto_box_seal(sodium.from_string(env.get(name)!), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
    await api(token, `/repos/${REPO}/actions/secrets/${name}`, {
      method: "PUT",
      body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id }),
    });
    console.log(`  set ${name} (${env.get(name)!.length} characters)`);
  }

  const list = await api(token, `/repos/${REPO}/actions/secrets`) as { secrets: { name: string; updated_at: string }[] };
  console.log(`\nsecrets on ${REPO}: ${list.secrets.map((s) => s.name).join(", ")}`);
}

main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
