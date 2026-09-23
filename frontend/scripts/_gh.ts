import { execFileSync } from "node:child_process";
const token = execFileSync("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n", encoding: "utf8" })
  .split(/\r?\n/).find((l) => l.startsWith("password="))!.slice(9);
const REPO = "sailochan19171/market-terminal";
const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
const get = async (u: string) => (await fetch(`https://api.github.com${u}`, { headers: H })).json();
async function main() {
  const wf = await get(`/repos/${REPO}/actions/workflows`) as { workflows: { id: number; path: string }[] };
  const id = wf.workflows.find((w) => w.path.endsWith("market-data.yml"))!.id;
  await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${id}/dispatches`, { method: "POST", headers: H, body: JSON.stringify({ ref: "main" }) });
  console.log("run requested; watching...");
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    const runs = await get(`/repos/${REPO}/actions/runs?per_page=1`) as { workflow_runs: { id: number; status: string; conclusion: string | null; html_url: string }[] };
    const run = runs.workflow_runs[0];
    if (run.status !== "completed") { if (i % 3 === 0) console.log(`  ${run.status}...`); continue; }
    console.log(`\nrun ${run.id}: ${run.conclusion}`);
    const jobs = await get(`/repos/${REPO}/actions/runs/${run.id}/jobs`) as { jobs: { id: number; steps: { name: string; conclusion: string | null }[] }[] };
    for (const s of jobs.jobs[0].steps) console.log(`   ${(s.conclusion ?? "-").padEnd(8)} ${s.name}`);
    const log = await (await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${jobs.jobs[0].id}/logs`, { headers: H })).text();
    console.log("\n--- what the run found ---");
    for (const l of log.split("\n")) if (/announcements|orders|database:|BSE |NSE |unread|error|rows/i.test(l) && !/^##\[/.test(l)) console.log("   " + l.replace(/^\S+\s/, "").slice(0, 150));
    console.log(run.html_url);
    return;
  }
}
main();
