// The filings that arrive as a scan, with no text in them at all.
//
// A PDF made by photographing or scanning paper carries pictures of words, not words. Every text extractor
// returns nothing, so the order inside it was simply lost - one filing in five hundred, which is few but not
// none, and the company whose order it was never appeared on the dashboard.
//
// A model that reads the page itself needs no text layer. Gemini takes the PDF as it is and reads what is on
// it, so a scan goes there rather than being written off. It is the backup host, configured for when the main
// one runs dry, and this is the one job that can only be done there.
import { logger } from "../log";
import { backupHost, chat } from "../research/llm";

const log = logger("orders.scan");

export interface ScanReading { text: string; model: string }

/**
 * What the scanned filing says, as text, or null when there is no host that can read a page. The text is then
 * read by the same extraction the other filings go through, so a scan and a text filing are understood the same
 * way and one code path decides what an order is.
 */
export async function textFromScan(bytes: Uint8Array, company: string | null): Promise<ScanReading | null> {
  const host = backupHost();
  // Only Gemini reads a document in this API; the others are sent text and would silently ignore the file.
  if (!host || host.provider !== "gemini") {
    log.warn("a filing arrived as a scan and there is no host configured that can read a page");
    return null;
  }
  // A filing is a page or two; ten megabytes of scan is something else and is not worth sending.
  if (bytes.byteLength > 10_000_000) {
    log.warn(`${company ?? "a company"}: the scan is ${Math.round(bytes.byteLength / 1e6)} MB, too large to send`);
    return null;
  }

  const reply = await chat({
    host,
    system: [
      "You are reading a scanned filing from an Indian stock exchange. It has no text layer, so read the page itself.",
      "Write out what the document says, in plain text, in the order it appears. Keep every figure, date, name and heading exactly as printed.",
      "Do not summarise, do not explain, and do not add anything that is not on the page. If a word cannot be made out, write [unclear].",
    ].join(" "),
    user: `This is a filing by ${company ?? "a listed company"}. Write out its text.`,
    document: { bytes, mediaType: "application/pdf" },
    temperature: 0,
    maxTokens: 2_000,
    timeoutMs: 60_000,
  });

  if (!reply.text || reply.text.replace(/\s/g, "").length < 120) {
    log.warn(`${company ?? "a company"}: the scan could not be read${reply.error ? `: ${reply.error}` : ""}`);
    return null;
  }
  return { text: reply.text, model: reply.model };
}
