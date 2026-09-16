// What the platform generated, how well it held up, and what it cost.
//
// GET  -> the measured figures behind the quality page, and a random sample to read through.
// POST -> a reader's rating of one answer, or a reviewer's verdict on one.
import { quality, rate, review, sample } from "@/server/research/audit";
import { ApiError, Args, body, db, handle, json } from "@/server/api/common";

export const GET = handle(async (req: Request) => {
  const a = Args.of(req);
  const d = db();
  return json({
    quality: quality(d, a.int("days", 30, 1, 3650)),
    sample: sample(d, a.int("sample", 8, 0, 50), a.str("all") !== "1"),
  }, { shared: false });
});

export const POST = handle(async (req: Request) => {
  const sent = await body<{ id?: string; rating?: string; review?: string }>(req);
  const id = String(sent.id ?? "");
  if (!id) throw new ApiError(400, "Name the answer being rated.", { error: "bad_request" });
  const d = db();

  if (sent.rating) {
    if (!["helpful", "unhelpful"].includes(sent.rating)) throw new ApiError(400, "A rating is either helpful or unhelpful.", { error: "bad_request" });
    if (!rate(d, id, sent.rating as "helpful" | "unhelpful")) throw new ApiError(404, "That answer is not on record.", { error: "not_found" });
    return json({ id, rating: sent.rating }, { shared: false });
  }
  if (sent.review) {
    if (!["ok", "wrong", "unclear"].includes(sent.review)) throw new ApiError(400, "A review is ok, wrong or unclear.", { error: "bad_request" });
    if (!review(d, id, sent.review as "ok" | "wrong" | "unclear")) throw new ApiError(404, "That answer is not on record.", { error: "not_found" });
    return json({ id, review: sent.review }, { shared: false });
  }
  throw new ApiError(400, "Send either a rating or a review.", { error: "bad_request" });
});
