import { ImportError, importCsv } from "@/server/core/portfolio";
import { db, handle, json } from "@/server/api/common";

// A broker CSV export. The file is read in memory; nothing is written to disk.
export const POST = handle(async (req: Request) => {
  const form = await req.formData().catch(() => null);
  const upload = form?.get("file");
  if (!(upload instanceof File) || !upload.name) return json({ error: "no file supplied" }, { status: 400 });
  const broker = String(form?.get("broker") ?? "manual").trim() || "manual";
  try {
    const [imported, watchlist] = importCsv(db(), await upload.text(), broker);
    return json({ imported, watchlist });
  } catch (e) {
    if (e instanceof ImportError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
});
