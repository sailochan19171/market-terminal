// Text out of the documents a reader actually has: exchange filing PDFs, annual reports, Word files, notes.
//
// Nothing here interprets the content - it only recovers the words and which page they were on, so a later
// answer can quote a page and a reader can open that page and check it. A file we cannot read says so; it is
// never silently stored empty.
import { unzipSync } from "fflate";
import { logger } from "../log";

const log = logger("docs.extract");

export type DocKind = "pdf" | "docx" | "text";

export interface Extracted {
  kind: DocKind;
  /** One entry per page (PDF) or per section (everything else); the index is the page number, from 1. */
  pages: string[];
  chars: number;
  /** True when a PDF holds no text layer at all - a scan. Optical recognition is not done here. */
  imageOnly: boolean;
}

export class UnreadableDocument extends Error {}

const MAX_PAGES = 400;

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;

/** pdf.js, loaded once and only when a PDF actually arrives (it is a large module). */
async function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // The worker runs on this thread: no worker file to locate at runtime, which also keeps bundlers happy.
      const g = globalThis as { pdfjsWorker?: unknown };
      // @ts-expect-error -- the worker bundle ships without type declarations
      if (!g.pdfjsWorker) g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      return import("pdfjs-dist/legacy/build/pdf.mjs");
    })();
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

/** Reading order: top to bottom, then left to right, with a blank line between paragraphs. */
function pageText(items: { str?: string; transform?: number[] }[]): string {
  const lines: { y: number; x: number; text: string }[] = [];
  for (const item of items) {
    const text = item.str;
    if (!text || !text.trim() || !item.transform) continue;
    const [, , , , x, y] = item.transform;
    // Items within a couple of points of each other sit on the same printed line.
    const line = lines.find((l) => Math.abs(l.y - y) < 2.5);
    if (line) {
      line.text += (line.x < x ? " " : "") + text;
      line.x = Math.max(line.x, x);
    } else {
      lines.push({ y, x, text });
    }
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => l.text.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
}

async function fromPdf(bytes: Uint8Array): Promise<Extracted> {
  const pdfjs = await loadPdfjs();
  // pdf.js detaches the buffer it is handed, so give it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, disableFontFace: true, useSystemFonts: false, stopAtErrors: false });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => undefined);
    const name = (e as { name?: string })?.name;
    if (name === "PasswordException") throw new UnreadableDocument("This PDF is password protected. Remove the password and upload it again.");
    throw new UnreadableDocument(`This file could not be read as a PDF: ${(e as Error).message}`);
  }
  try {
    const pages: string[] = [];
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageText(content.items as { str?: string; transform?: number[] }[]));
      page.cleanup();
    }
    if (doc.numPages > MAX_PAGES) log.warn(`read ${MAX_PAGES} of ${doc.numPages} pages`);
    const chars = pages.reduce((s, p) => s + p.length, 0);
    return { kind: "pdf", pages, chars, imageOnly: chars < 40 * pages.length };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

/** A .docx is a zip; the text lives in word/document.xml, one <w:p> per paragraph. */
function fromDocx(bytes: Uint8Array): Extracted {
  let xml: string;
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
    const body = files["word/document.xml"];
    if (!body) throw new Error("no word/document.xml inside");
    xml = new TextDecoder().decode(body);
  } catch (e) {
    throw new UnreadableDocument(`This file could not be read as a Word document: ${(e as Error).message}`);
  }
  const paragraphs = xml.split(/<\/w:p>/).map((p) => {
    const text = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join("");
    return text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  const text = paragraphs.join("\n");
  if (!text) throw new UnreadableDocument("This Word document has no readable text.");
  // Word has no pages until it is laid out, so split into readable sections instead.
  const pages = section(text, 6000);
  return { kind: "docx", pages, chars: text.length, imageOnly: false };
}

function fromText(bytes: Uint8Array): Extracted {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\r\n/g, "\n").trim();
  if (!text) throw new UnreadableDocument("This file is empty.");
  return { kind: "text", pages: section(text, 6000), chars: text.length, imageOnly: false };
}

/** Split on paragraph breaks into parts of roughly `size` characters, never mid-sentence. */
function section(text: string, size: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const para of text.split(/\n{2,}|\n(?=[A-Z0-9])/)) {
    if (current.length + para.length > size && current) {
      parts.push(current.trim());
      current = "";
    }
    current += `${para}\n`;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length ? parts : [text];
}

const EXT = /\.([a-z0-9]+)$/i;

/** Read a file by what it is, not by what it claims to be: the magic bytes decide. */
export async function extract(bytes: Uint8Array, filename = ""): Promise<Extracted> {
  const ext = (filename.match(EXT)?.[1] ?? "").toLowerCase();
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (head.startsWith("%PDF")) return fromPdf(bytes);
  // A .docx is a zip (PK\x03\x04) holding word/document.xml.
  if (head.startsWith("PK") && ext !== "zip") return fromDocx(bytes);
  if (["txt", "md", "csv", "json", "htm", "html", "xml"].includes(ext) || !ext) return fromText(bytes);
  if (ext === "doc") throw new UnreadableDocument("Old .doc files are not supported. Save it as .docx or PDF and upload again.");
  if (["xls", "xlsx", "ppt", "pptx"].includes(ext)) throw new UnreadableDocument(`.${ext} files are not supported yet. Export the pages you need as a PDF.`);
  return fromText(bytes);
}
