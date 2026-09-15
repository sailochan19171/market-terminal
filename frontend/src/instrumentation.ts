// Starts the background job process with the web server, so data keeps updating without a separate service.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startJobs } = await import("./server/jobs/spawn");
  startJobs();
  // Load the home page's slow aggregates into memory (and the disk cache) before the first visitor asks.
  setTimeout(async () => {
    try {
      const [{ db }, { home }, { pulse }] = await Promise.all([import("./server/api/common"), import("./server/api/v2"), import("./server/api/live")]);
      // Start the NSE fetch before the synchronous database warm-up so both finish together.
      const live = pulse();
      home(db());
      await live;
    } catch (e) {
      console.error(`[warmup] ${(e as Error).message}`);
    }
  }, 2_000);
}
