import { CasFormatError, CasPasswordError, parseCas } from "@/server/core/cas";
import { ImportError, importCasData } from "@/server/core/portfolio";
import { db, handle, json } from "@/server/api/common";

// Consolidated Account Statement (CDSL / NSDL / CAMS / KFintech). The PDF and its password stay in memory:
// nothing is written to disk and the password is never logged.
export const POST = handle(async (req: Request) => {
  const form = await req.formData().catch(() => null);
  const upload = form?.get("file");
  if (!(upload instanceof File) || !upload.name) return json({ error: "no file supplied" }, { status: 400 });
  const password = String(form?.get("password") ?? "");
  if (!password) return json({ error: "the statement password is required" }, { status: 400 });
  const label = String(form?.get("label") ?? "cas").trim() || "cas";
  try {
    const data = await parseCas(new Uint8Array(await upload.arrayBuffer()), password);
    return json(importCasData(db(), data, label));
  } catch (e) {
    if (e instanceof CasPasswordError) return json({ error: "Could not open the statement: the password is incorrect." }, { status: 400 });
    if (e instanceof CasFormatError) return json({ error: `Could not read this file as a CAS statement: ${e.message}` }, { status: 400 });
    if (e instanceof ImportError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
});
