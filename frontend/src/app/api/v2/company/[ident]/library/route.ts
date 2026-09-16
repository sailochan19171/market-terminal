// The document library for one company: upload a PDF or Word file, list what has been read, remove one, or ask
// the platform to fetch this company's own filings and read them in full.
//
// Distinct from /documents, which lists the filings the exchanges published. This is what has been read.
import { identityOr404 } from "@/server/api/company";
import { UnreadableDocument } from "@/server/docs/extract";
import { ingest } from "@/server/docs/filings";
import { add, list, MAX_BYTES, remove, stats } from "@/server/docs/store";
import { ApiError, Args, db, handle, json, type Ctx } from "@/server/api/common";

const ident = async (ctx: Ctx<{ ident: string }>) => identityOr404(db(), decodeURIComponent((await ctx.params).ident));

export const GET = handle(async (_req: Request, ctx: Ctx<{ ident: string }>) => {
  const identity = await ident(ctx);
  const d = db();
  return json({ symbol: identity.symbol, documents: list(d, identity.symbol), library: stats(d) }, { shared: false });
});

export const POST = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const identity = await ident(ctx);
  const d = db();
  if (!identity.symbol) throw new ApiError(422, "The document library is keyed to an NSE symbol; this company is listed on BSE only.", { error: "no_data" });

  // "?fetch=8" asks the platform to read this company's own recent filings instead of uploading one.
  const fetchCount = Args.of(req).int("fetch", 0, 0, 25);
  if (fetchCount) {
    const done = await ingest(d, identity.symbol, fetchCount);
    return json({ ...done, documents: list(d, identity.symbol), library: stats(d) }, { shared: false });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "Attach a file to upload.", { error: "bad_request" });
  if (file.size > MAX_BYTES) throw new ApiError(413, `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_BYTES / 1024 / 1024} MB.`, { error: "too_large" });

  try {
    const stored = await add(d, new Uint8Array(await file.arrayBuffer()), {
      symbol: identity.symbol,
      title: String(form?.get("title") || file.name).slice(0, 300),
      kind: "upload",
      source: file.name,
      filename: file.name,
    });
    return json({ document: stored, documents: list(d, identity.symbol), library: stats(d) }, { status: 201, shared: false });
  } catch (e) {
    if (e instanceof UnreadableDocument) throw new ApiError(422, e.message, { error: "unreadable" });
    throw e;
  }
});

export const DELETE = handle(async (req: Request, ctx: Ctx<{ ident: string }>) => {
  const identity = await ident(ctx);
  const id = Args.of(req).str("id");
  if (!id) throw new ApiError(400, "Name the document to remove.", { error: "bad_request" });
  const d = db();
  if (!remove(d, id)) throw new ApiError(404, "That document is not in the library.", { error: "not_found" });
  return json({ removed: id, documents: list(d, identity.symbol), library: stats(d) }, { shared: false });
});
