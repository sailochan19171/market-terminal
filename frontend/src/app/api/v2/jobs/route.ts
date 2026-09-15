import { db, handle, json } from "@/server/api/common";
import * as jobState from "@/server/jobs/state";
import { lockOwner } from "@/server/jobs/lock";
import { lastSlot } from "@/server/jobs/scheduler";
import { progress as backfillProgress } from "@/server/jobs/backfill";

// Health of the background jobs: runner process, data worker, daily update and the company refresh queue.
export const GET = handle(() => {
  const d = db();
  const queue = d.hasTable("company_sync")
    ? d.get("SELECT SUM(status = 'queued') AS queued, SUM(status = 'running') AS running, SUM(status = 'error') AS errors FROM company_sync")
    : null;
  return json({
    runnerPid: lockOwner("jobs"),
    jobs: jobState.all(d),
    lastScheduledDaily: lastSlot().toISOString(),
    companyQueue: queue,
    backfill: backfillProgress(d),
    latest: {
      nseSession: d.scalar("SELECT MAX(trade_date) FROM nse_bhavcopy_day WHERE status = 'ok'"),
      bseSession: d.scalar("SELECT MAX(trade_date) FROM bhavcopy_day WHERE status = 'ok'"),
    },
  }, { shared: false });
});
