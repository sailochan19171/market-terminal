// Consolidated Account Statement (CAS) holdings parser: CAMS / KFintech (detailed and summary),
// NSDL and CDSL eCAS PDFs.
//
// The statement-recognition rules, text-layout heuristics and field regexes are modelled on
// casparser 1.4.1 (https://github.com/codereverser/casparser), MIT License,
// Copyright (c) 2020 Sandeep Somasekharan. This is an independent TypeScript implementation on
// pdfjs-dist text items that reads only the holdings snapshot (closing balances, NAV / price,
// cost / value, ISIN, names, folio and demat account ids); transaction histories are skipped.
//
// Differences from casparser: casparser resolves CAMS/KFin scheme ISINs through its bundled ISIN
// database and backfills equity trading symbols from it. There is no such database here, so the ISIN
// printed on the statement is returned as-is and `symbol` is always null.
//
// The password only unlocks the PDF in memory; it is never logged or stored.
import { existsSync } from "node:fs";
import path from "node:path";

export class CasPasswordError extends Error {
  constructor(message = "Could not open the statement: the password is incorrect.") {
    super(message);
    this.name = "CasPasswordError";
  }
}

export class CasFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasFormatError";
  }
}

export interface CasEquity {
  isin: string | null;
  name: string;
  symbol?: string | null;
  num_shares: number | null;
  price: number | null;
  value?: number | null;
}

export interface CasDematMutualFund {
  isin: string | null;
  name: string;
  balance: number | null;
  avg_cost: number | null;
  nav: number | null;
  pnl: number | null;
  value?: number | null;
  total_cost?: number | null;
  folio?: string | null;
}

export interface CasBond {
  isin: string | null;
  name: string;
  /** Same as num_bonds (the name import code reads). */
  num_units?: number | null;
  balance?: number | null;
  num_shares?: number | null;
  /** Market price per bond when the statement prints one (detailed tables only). */
  price?: number | null;
  face_value?: number | null;
  num_bonds?: number | null;
  market_price?: number | null;
  value?: number | null;
}

export interface CasAccount {
  dp_id?: string;
  client_id?: string;
  name?: string;
  type?: string;
  equities: CasEquity[];
  mutual_funds: CasDematMutualFund[];
  bonds: CasBond[];
}

export interface CasScheme {
  scheme: string;
  isin: string | null;
  close: number | null;
  valuation: { nav: number | null; cost: number | null; value: number | null };
  rta_code?: string;
  rta?: string;
}

export interface CasFolio {
  folio: string;
  amc?: string;
  schemes: CasScheme[];
}

export interface CasData {
  file_type: string; // "CAMS" | "KFINTECH" | "NSDL" | "CDSL" | "UNKNOWN"
  cas_type?: string; // "DETAILED" | "SUMMARY" for CAMS / KFintech
  accounts: CasAccount[];
  folios: CasFolio[];
}

// ---------------------------------------------------------------------------------------------------
// PDF text extraction
// ---------------------------------------------------------------------------------------------------

/** One positioned run of text (roughly one text-show operation). PDF units, y grows upwards. */
interface Atom {
  text: string;
  x: number;
  x2: number;
  y: number; // baseline
  top: number;
  size: number;
  font: string;
}

interface PageText {
  number: number;
  atoms: Atom[]; // horizontal text only
  sample: string; // all text, rotated included, for issuer detection
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;

function loadPdfjs(): Promise<Pdfjs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      // Run the pdf.js worker on the main thread: no worker file to locate at runtime, which also keeps
      // bundlers happy.
      const g = globalThis as { pdfjsWorker?: unknown };
      if (!g.pdfjsWorker) {
        // @ts-ignore -- the worker bundle ships without type declarations
        g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
      }
      return import("pdfjs-dist/legacy/build/pdf.mjs");
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

/** CMaps (CID fonts without a ToUnicode map) and standard-font metrics, read from the installed package. */
function pdfjsDataUrls(): { cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string } {
  const base = path.join(process.cwd(), "node_modules", "pdfjs-dist");
  const cmaps = path.join(base, "cmaps");
  const fonts = path.join(base, "standard_fonts");
  return {
    // pdf.js wants directory URLs with a trailing "/"; Node's fs accepts forward slashes on Windows too.
    ...(existsSync(cmaps) ? { cMapUrl: `${cmaps.split(path.sep).join("/")}/`, cMapPacked: true } : {}),
    ...(existsSync(fonts) ? { standardFontDataUrl: `${fonts.split(path.sep).join("/")}/` } : {}),
  };
}

const DEVANAGARI =/[\u0900-\u097F]/;

async function extractPages(pdf: Uint8Array, password: string): Promise<PageText[]> {
  const pdfjs = await loadPdfjs();
  // pdf.js takes ownership of (and detaches) the buffer it is given, so hand it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    password,
    ...pdfjsDataUrls(),
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string })?.name;
    if (name === "PasswordException") throw new CasPasswordError();
    if (name === "InvalidPDFException") throw new CasFormatError("This file is not a valid PDF.");
    throw new CasFormatError(`Could not read this PDF: ${(err as Error)?.message ?? String(err)}`);
  }
  try {
    const pages: PageText[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [vx, vy] = page.view;
      const content = await page.getTextContent();
      const atoms: Atom[] = [];
      const sample: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const text = item.str;
        if (item.hasEOL) sample.push("\n");
        if (!text.trim()) continue;
        sample.push(text, " ");
        const [a, b, c, d, e, f] = item.transform as number[];
        // Vertical runs are the rotated CAMSCASWS / KFINCASWS watermark: noise for layout reading.
        if (Math.abs(b) > Math.abs(a)) continue;
        // NSDL / CDSL overlay Hindi translations in a Devanagari font.
        if (DEVANAGARI.test(text)) continue;
        const size = Math.abs(d) || Math.hypot(c, d) || item.height || 1;
        const x = e - vx;
        const y = f - vy;
        atoms.push({ text, x, x2: x + Math.max(0, item.width), y, top: y + 0.8 * size, size, font: item.fontName });
      }
      pages.push({ number: n, atoms, sample: sample.join("") });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

/** casparser `_decimal`: commas stripped, "(x)" / "-x" negative, null when unparseable. */
function decimal(s: string | null | undefined): number | null {
  if (s == null) return null;
  let t = s.trim();
  if (!t) return null;
  const neg = t.startsWith("(") || t.startsWith("-");
  t = t.replace(/^\(+/, "").replace(/\)+$/, "").replace(/^-+/, "").replace(/,/g, "");
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

const NUMERIC_RE = /^-?(?:[\d,]+(?:\.\d+)?|\.\d+)$/;
const looksNumeric = (s: string) => {
  const t = s.trim();
  return !!t && NUMERIC_RE.test(t);
};

function optNum(s: string | null | undefined): number | null {
  if (s == null) return null;
  const t = String(s).replace(/,/g, "").trim();
  if (!t || t === "-" || t === "--" || t === "N.A" || t === "NA") return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

const toNum = (s: string | null | undefined) => optNum(s) ?? 0;

function detectFileType(pages: PageText[]): string {
  const text = ws(pages.slice(0, 2).map((p) => p.sample).join("\n"));
  if (text.includes("CAMSCASWS")) return "CAMS";
  if (text.includes("KFINCASWS")) return "KFINTECH";
  if (text.includes("NSDL Consolidated Account Statement") || text.includes("About NSDL")) return "NSDL";
  if (text.includes("Central Depository Services (India) Limited")) return "CDSL";
  return "UNKNOWN";
}

function detectCasType(pages: PageText[]): string {
  const m = (pages[0]?.sample ?? "").match(/consolidated\s+account\s+(statement|summary)/i);
  if (!m) return "UNKNOWN";
  return m[1].toLowerCase() === "statement" ? "DETAILED" : "SUMMARY";
}

// ---------------------------------------------------------------------------------------------------
// CAMS / KFintech: baseline-clustered lines
// ---------------------------------------------------------------------------------------------------

interface Line {
  baseline: number;
  atoms: Atom[];
  text: string;
}

/** Drop overlay duplicates: same font, overlapping x, baselines 0.05-3pt apart (a doubled glyph layer). */
function dedupeOverlay(atoms: Atom[]): Atom[] {
  if (atoms.length < 2) return atoms;
  const order = atoms.map((a, i) => [i, a] as const).sort((p, q) => q[1].top - p[1].top);
  const rows: (readonly [number, Atom])[][] = [];
  let anchor: number | null = null;
  for (const pair of order) {
    if (anchor === null || Math.abs(pair[1].top - anchor) > 3) {
      rows.push([pair]);
      anchor = pair[1].top;
    } else rows[rows.length - 1].push(pair);
  }
  const drop = new Set<number>();
  for (const row of rows) {
    if (row.length < 2) continue;
    const tops = row.map(([, a]) => a.top).sort((p, q) => p - q);
    const median = tops[Math.floor(row.length / 2)];
    for (let i = 0; i < row.length; i++) {
      const [oi, ai] = row[i];
      if (drop.has(oi)) continue;
      for (let j = i + 1; j < row.length; j++) {
        const [oj, aj] = row[j];
        if (drop.has(oj) || !ai.font || ai.font !== aj.font) continue;
        const overlap = Math.min(ai.x2, aj.x2) - Math.max(ai.x, aj.x);
        if (overlap <= 0) continue;
        const narrower = Math.min(ai.x2 - ai.x, aj.x2 - aj.x);
        if (narrower <= 0 || overlap / narrower < 0.5) continue;
        if (Math.abs(ai.top - aj.top) < 0.05) continue;
        drop.add(Math.abs(ai.top - median) > Math.abs(aj.top - median) ? oi : oj);
      }
    }
  }
  return atoms.filter((_, i) => !drop.has(i));
}

function lineText(atoms: Atom[]): string {
  const sorted = [...atoms].sort((a, b) => a.x - b.x);
  let out = "";
  let prevX2: number | null = null;
  for (const a of sorted) {
    if (prevX2 !== null && out && !/\s$/.test(out) && !/^\s/.test(a.text) && a.x - prevX2 > Math.max(0.8, 0.12 * a.size)) {
      out += " ";
    }
    out += a.text;
    prevX2 = a.x2;
  }
  return out.replace(/\s+/g, " ").trim();
}

function toLines(page: PageText): Line[] {
  const atoms = dedupeOverlay(page.atoms).sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { baseline: number; weight: number; atoms: Atom[] }[] = [];
  for (const a of atoms) {
    const last = lines[lines.length - 1];
    const w = Math.max(1, a.text.length);
    if (last && Math.abs(a.y - last.baseline) <= 1.5) {
      last.baseline = (last.baseline * last.weight + a.y * w) / (last.weight + w);
      last.weight += w;
      last.atoms.push(a);
    } else lines.push({ baseline: a.y, weight: w, atoms: [a] });
  }
  return lines.map((l) => ({ baseline: l.baseline, atoms: l.atoms, text: lineText(l.atoms) }));
}

// Scheme header / footer grammar (CAMS & KFintech DETAILED).
const TXN_HEADER_LABELS = new Set(["Date", "Transaction", "Amount", "Units", "Price", "Unit", "Balance", "NAV"]);
const FOLIO_LINE_RE = /Folio\s+No\s*:\s*(\d+(?:\s*\/\s*\d+)?)/i;
const INLINE_ISIN_RE = /[-\s]*ISIN\s*:\s*([A-Z0-9]+)/i;
const INLINE_ADVISOR_RE = /[-\s]*\(\s*Advisor\s*:\s*([^)]+?)\)/gi;
const FULL_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const ISIN_ANYWHERE_RE = /\bINF[0-9A-Z]{8}\d\b/;
const RTA_TOKEN_RE = /\b(CAMS|KFINTECH|KFIN|KARVY)\b/i;
const SCHEME_HEAD_RTA_RE = /Registrar\s*:\s*(\S+)/i;
const OPEN_BAL_RE = /Opening\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const CLOSE_BAL_RE = /Closing\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const NAV_RE = /NAV\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const VALUATION_RE = /(?:Valuation|Market\s+Value)\s+on\s+(\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const COST_VALUE_RE = /Total\s+Cost\s+Value\s*:?\s*([\d,.]+)/i;
const AMC_RE = /^(.+?\s+(?:MF|Mutual\s*Fund|Fund\s*House))$/i;
const DATE_CELL_RE = /^\s*(\d{1,2}[-\s]*[A-Za-z]{3}[-\s]*\d{4})/;
const HEADER_MARKER_RE = /Registrar\s*:|Advisor\s*:|ISIN\s*:|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b/i;
const SCHEME_CODE_RE = /^\s*(?=[A-Z0-9 ]{0,40}[A-Z])[A-Z0-9]+(?: [A-Z0-9]+)*-/i;
const TRAILING_MARKER_RE = /(Registrar\s*:|Advisor\s*:|ISIN\s*:|\(\s*Advisor\s*:)\s*$/i;
const NAME_EXCISE_ISIN_RE = /[-\s]*ISIN\s*:\s*INF[A-Z0-9]*/gi;
const NAME_TERMINATOR_RE = /\(\s*Advisor\s*:|Registrar\s*:?|Nominee\s+\d|\bARN-?\d+\b|\bINA\d+\b|\b(?:CAMS|KFINTECH|KFIN|KARVY)\b/i;

function parsedSchemeName(raw: string): string {
  let s = raw.replace(/\((formerly|erstwhile)[\s\S]+?\)/gi, "").trim();
  s = s.replace(/\((Demat|Non-Demat)[\s\S]*/gi, "").trim();
  s = s.replace(/\s+/g, " ").trim();
  return s.replace(/[^a-zA-Z0-9_)]+$/, "").trim();
}

const isHeaderLine = (t: string) => HEADER_MARKER_RE.test(t) || RTA_TOKEN_RE.test(t) || SCHEME_CODE_RE.test(t);

function expectsContinuation(t: string): boolean {
  if (TRAILING_MARKER_RE.test(t.trim())) return true;
  const adv = /\(\s*Advisor\s*:/i.exec(t);
  return !!adv && !t.slice(adv.index + adv[0].length).includes(")");
}

/** Build a scheme from the lines between a folio header / previous footer and `Opening Unit Balance`. */
function buildScheme(buf: string[]): CasScheme | null {
  const lines = buf.map((s) => s.trim()).filter(Boolean);
  const sIdx = lines.findIndex((l) => SCHEME_CODE_RE.test(l) && l.split("-")[0].trim().toUpperCase() !== "ARN");
  if (sIdx < 0) return null;
  const members: number[] = [];
  let forced = false;
  lines.forEach((l, i) => {
    if (forced || isHeaderLine(l)) {
      members.push(i);
      forced = expectsContinuation(l);
    } else forced = false;
  });
  const headerText = members.map((i) => lines[i]).join(" ");
  if (!headerText.includes("Registrar")) return null;

  const dash = lines[sIdx].indexOf("-");
  const code = lines[sIdx].slice(0, dash).trim();
  let nameText = [lines[sIdx].slice(dash + 1), ...members.filter((i) => i > sIdx).map((i) => lines[i])].join(" ");
  nameText = nameText.replace(INLINE_ADVISOR_RE, "").replace(NAME_EXCISE_ISIN_RE, "");
  const cut = NAME_TERMINATOR_RE.exec(nameText);
  const name = parsedSchemeName(cut ? nameText.slice(0, cut.index) : nameText);

  let isin: string | null = INLINE_ISIN_RE.exec(headerText)?.[1]?.trim() ?? null;
  if (!isin || !FULL_ISIN_RE.test(isin)) isin = ISIN_ANYWHERE_RE.exec(headerText)?.[0] ?? null;

  const rtaTok = RTA_TOKEN_RE.exec(headerText);
  const rta = rtaTok ? rtaTok[1].toUpperCase() : SCHEME_HEAD_RTA_RE.exec(headerText)?.[1]?.trim() || "CAMS";
  return { scheme: name, isin, close: 0, valuation: { nav: 0, cost: null, value: 0 }, rta_code: code, rta };
}

/** First y-window (<= 15pt) holding >= 4 transaction-table column labels: [first, last] line index. */
function txnHeaderWindow(lines: Line[]): [number, number] {
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[i].baseline - lines[j + 1].baseline <= 15) j++;
    const labels = new Set<string>();
    for (let k = i; k <= j; k++) for (const w of lines[k].text.split(" ")) if (TXN_HEADER_LABELS.has(w)) labels.add(w);
    if (labels.size >= 4) return [i, j];
  }
  return [-1, -1];
}

function parseCamsDetailed(pages: PageText[]): CasFolio[] {
  const folios = new Map<string, CasFolio>();
  let amc: string | null = null;
  let folio: CasFolio | null = null;
  let scheme: CasScheme | null = null;
  let buf: string[] = [];
  let headerActive = false;

  for (const page of pages) {
    const lines = toLines(page);
    const [hFirst, hLast] = txnHeaderWindow(lines);
    lines.forEach((line, i) => {
      const text = line.text;
      if (AMC_RE.test(text)) {
        amc = text;
        buf = [];
        headerActive = false;
        return;
      }
      if (text.includes("Folio No") && !DATE_CELL_RE.test(text)) {
        const m = FOLIO_LINE_RE.exec(text);
        if (m) {
          const no = m[1].trim();
          const key = `${amc ?? "UNKNOWN"}|${no}`;
          if (!folios.has(key)) folios.set(key, { folio: no, amc: amc ?? "UNKNOWN", schemes: [] });
          folio = folios.get(key)!;
          scheme = null;
          buf = [];
          headerActive = true;
          return;
        }
      }
      const open = OPEN_BAL_RE.exec(text);
      if (open) {
        if (headerActive) {
          scheme = buildScheme(buf);
          if (scheme && folio) folio.schemes.push(scheme);
          headerActive = false;
          buf = [];
        }
        return;
      }
      let consumed = false;
      if (scheme) {
        let m = CLOSE_BAL_RE.exec(text);
        if (m) {
          scheme.close = decimal(m[1]) || 0;
          buf = [];
          headerActive = true;
          consumed = true;
        }
        if ((m = NAV_RE.exec(text))) {
          scheme.valuation.nav = decimal(m[2]) || 0;
          consumed = true;
        }
        if ((m = VALUATION_RE.exec(text))) {
          scheme.valuation.value = decimal(m[2]) || 0;
          consumed = true;
        }
        if ((m = COST_VALUE_RE.exec(text))) {
          scheme.valuation.cost = decimal(m[1]);
          consumed = true;
        }
      }
      if (headerActive && !consumed && !(hFirst <= i && i <= hLast)) buf.push(text);
    });
  }
  return [...folios.values()];
}

// ---------------------------------------------------------------------------------------------------
// CAMS / KFintech SUMMARY: column-assigned rows
// ---------------------------------------------------------------------------------------------------

interface Glyph {
  ch: string;
  x0: number;
  x1: number;
  size: number;
}

/** Approximate per-character positions by spreading each run's width evenly over its characters. */
function glyphs(line: Line): Glyph[] {
  const out: Glyph[] = [];
  for (const a of line.atoms) {
    const chars = [...a.text];
    const step = (a.x2 - a.x) / Math.max(1, chars.length);
    chars.forEach((ch, i) => out.push({ ch, x0: a.x + step * i, x1: a.x + step * (i + 1), size: a.size }));
  }
  return out.sort((p, q) => p.x0 - q.x0);
}

function glyphText(gs: Glyph[]): string {
  let out = "";
  let prev: Glyph | null = null;
  for (const g of gs) {
    if (/\s/.test(g.ch)) {
      out += " ";
      prev = null;
      continue;
    }
    if (prev && g.x0 - prev.x1 > Math.max(1.5, 0.4 * g.size)) out += " ";
    out += g.ch;
    prev = g;
  }
  return ws(out);
}

function words(line: Line): [string, number, number][] {
  const out: [string, number, number][] = [];
  let cur = "";
  let x0 = 0;
  let x1 = 0;
  for (const g of glyphs(line)) {
    if (/\s/.test(g.ch)) {
      if (cur) out.push([cur, x0, x1]);
      cur = "";
      continue;
    }
    if (cur && g.x0 - x1 > 1.5) {
      out.push([cur, x0, x1]);
      cur = "";
    }
    if (!cur) x0 = g.x0;
    cur += g.ch;
    x1 = g.x1;
  }
  if (cur) out.push([cur, x0, x1]);
  return out;
}

interface Column {
  label: string;
  lo: number;
  hi: number;
  align: "left" | "right";
}

const SUMMARY_HEADER_LABELS = new Set([
  "Folio", "No", "No.", "ISIN", "Scheme", "Name", "Cost", "Value", "Unit", "Balance", "Closing", "NAV", "Date",
  "Price", "Market", "Registrar",
]);
const SUMMARY_COLUMN_RULES: [string[], string, "left" | "right"][] = [
  [["Folio"], "Folio", "left"],
  [["ISIN"], "ISIN", "left"],
  [["Scheme"], "Scheme", "left"],
  [["Cost"], "Cost", "right"],
  [["Closing", "Balance"], "Balance", "right"],
  [["Unit", "Balance"], "Balance", "right"],
  [["NAV", "Date"], "NAVDate", "left"],
  [["NAV"], "NAV", "right"],
  [["Price"], "NAV", "right"],
  [["Market"], "MarketValue", "right"],
  [["Registrar"], "Registrar", "left"],
];

function summaryColumns(lines: Line[]): { last: number; cols: Column[] } | null {
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[i].baseline - lines[j + 1].baseline <= 15) j++;
    const ws_: [string, number, number][] = [];
    for (let k = i; k <= j; k++) ws_.push(...words(lines[k]));
    const labels = new Set(ws_.map((w) => w[0]).filter((w) => SUMMARY_HEADER_LABELS.has(w)));
    if (labels.size < 5 || !labels.has("Folio") || !labels.has("Scheme")) continue;
    // Cluster header words by x across all header baselines, then name each cluster by its tokens.
    const sorted = [...ws_].sort((a, b) => a[1] - b[1]);
    const clusters: [string, number, number][][] = [];
    let maxX1 = 0;
    for (const w of sorted) {
      if (clusters.length && w[1] - maxX1 > 7) {
        clusters.push([w]);
        maxX1 = w[2];
      } else {
        if (!clusters.length) clusters.push([]);
        clusters[clusters.length - 1].push(w);
        maxX1 = Math.max(maxX1, w[2]);
      }
    }
    const cols: Column[] = [];
    const seen = new Set<string>();
    for (const cl of clusters) {
      const tokens = new Set(cl.map((w) => w[0]));
      for (const [req, label, align] of SUMMARY_COLUMN_RULES) {
        if (req.every((r) => tokens.has(r)) && !seen.has(label)) {
          cols.push({ label, lo: Math.min(...cl.map((w) => w[1])), hi: Math.max(...cl.map((w) => w[2])), align });
          seen.add(label);
          break;
        }
      }
    }
    cols.sort((a, b) => a.lo - b.lo);
    return { last: j, cols };
  }
  return null;
}

function summaryCells(line: Line, cols: Column[]): Record<string, string> {
  const sorted = [...cols].sort((a, b) => (a.lo + a.hi) / 2 - (b.lo + b.hi) / 2);
  const ranges = sorted.map((c, i) => {
    if (c.align === "right") return [c, c.hi - 42, c.hi + 3] as const;
    const next = sorted[i + 1];
    const hi = !next ? Infinity : next.align === "right" ? next.hi - 42 : next.lo - 3;
    return [c, c.lo - 3, hi] as const;
  });
  const buckets: Record<string, Glyph[]> = {};
  for (const g of glyphs(line)) {
    const mid = (g.x0 + g.x1) / 2;
    for (const [c, lo, hi] of ranges) {
      if (lo <= mid && mid < hi) {
        (buckets[c.label] ??= []).push(g);
        break;
      }
    }
  }
  const out: Record<string, string> = {};
  for (const [label, gs] of Object.entries(buckets)) out[label] = glyphText(gs);
  return out;
}

const SUMMARY_FOLIO_RE = /^\s*(\d{6,}(?:\s*\/\s*\d+)?)/;
const SUMMARY_ISIN_RE = /(INF[A-Z0-9]{8}\d)/;
const SCHEME_CELL_RE = /^\s*([\w\s]{2,15}?)\s*-\s*(.+)$/;
const SCHEME_LOOKS_LIKE_DATA = /^\s*[A-Z0-9][\w\s]{1,15}\s*-\s*\S/;
const SUMMARY_TOTAL_RE = /^\s*(?:grand\s+|sub\s+|portfolio\s+)?total\b/i;

function parseCamsSummary(pages: PageText[]): CasFolio[] {
  const folios = new Map<string, CasFolio>();
  let amc: string | null = null;
  let scheme: CasScheme | null = null;
  let lastCols: Column[] = [];

  for (const page of pages) {
    const lines = toLines(page);
    const header = summaryColumns(lines);
    const headerIdx = header ? header.last : -1;
    const cols = header ? header.cols : lastCols;
    if (header) lastCols = header.cols;

    lines.forEach((line, i) => {
      const text = line.text;
      if (AMC_RE.test(text)) {
        amc = text;
        return;
      }
      if (!cols.length || i <= headerIdx) return;
      const cells = summaryCells(line, cols);
      const folioRaw = (cells.Folio ?? "").trim();
      const isinM = SUMMARY_ISIN_RE.exec((cells.ISIN ?? "").trim()) ?? SUMMARY_ISIN_RE.exec(folioRaw);
      const folioNo = SUMMARY_FOLIO_RE.exec(folioRaw)?.[1]?.trim() ?? "";
      const schemeCell = (cells.Scheme ?? "").trim();
      const balance = (cells.Balance ?? "").trim();
      const navDate = (cells.NAVDate ?? "").trim();
      const nav = (cells.NAV ?? "").trim();
      const value = (cells.MarketValue ?? "").trim();
      const cost = (cells.Cost ?? "").trim();
      const rta = (cells.Registrar ?? "").trim();

      if (!folioNo && (SUMMARY_TOTAL_RE.test(schemeCell) || SUMMARY_TOTAL_RE.test(text))) {
        scheme = null;
        return;
      }
      if (folioNo && schemeCell && SCHEME_LOOKS_LIKE_DATA.test(schemeCell)) {
        if (!folios.has(folioNo)) folios.set(folioNo, { folio: folioNo, amc: amc ?? "UNKNOWN", schemes: [] });
        let code = "";
        let name = schemeCell;
        const m = SCHEME_CELL_RE.exec(schemeCell);
        if (m) {
          code = m[1].trim();
          name = m[2].trim();
        }
        scheme = {
          scheme: name,
          isin: isinM ? isinM[1] : null,
          close: decimal(balance) || 0,
          valuation: { nav: decimal(nav) || 0, cost: cost ? decimal(cost) : null, value: decimal(value) || 0 },
          rta_code: code,
          rta: rta || "CAMS",
        };
        folios.get(folioNo)!.schemes.push(scheme);
        return;
      }
      if (scheme && !folioNo && schemeCell && !navDate && !balance && !nav && !value && !cost) {
        scheme.scheme = `${scheme.scheme} ${schemeCell}`.trim();
      }
    });
  }
  return [...folios.values()];
}

// ---------------------------------------------------------------------------------------------------
// NSDL / CDSL: blocks of cells
// ---------------------------------------------------------------------------------------------------

interface Cell {
  x: number;
  x2: number;
  top: number;
  text: string;
}

interface Block {
  page: number;
  cells: Cell[];
  text: string; // cells joined by "\t\t"
}

const SOFT_HYPHEN = "\u00ad";

function dedupeAtoms(atoms: Atom[]): Atom[] {
  const seen = new Set<string>();
  const byLine = new Map<string, Atom[]>();
  const keep: Atom[] = [];
  for (const a of atoms) {
    const key = `${a.x.toFixed(1)}|${a.top.toFixed(1)}|${a.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lk = a.top.toFixed(1);
    const kept = byLine.get(lk) ?? [];
    const t = a.text.trim();
    if (kept.some((k) => k.text.trim() === t && a.x < k.x2 && k.x < a.x2)) continue;
    kept.push(a);
    byLine.set(lk, kept);
    keep.push(a);
  }
  return keep;
}

function blocks(pages: PageText[]): Block[] {
  const out: Block[] = [];
  for (const page of pages) {
    const atoms = dedupeAtoms(page.atoms).sort((a, b) => b.top - a.top || a.x - b.x);
    // Raw lines: tops within 1.5pt of the line's first atom.
    const rawLines: Atom[][] = [];
    let curTop = 0;
    for (const a of atoms) {
      if (rawLines.length && Math.abs(a.top - curTop) <= 1.5) rawLines[rawLines.length - 1].push(a);
      else {
        rawLines.push([a]);
        curTop = a.top;
      }
    }
    // Blocks: consecutive lines whose top-to-top gap is <= 9pt (multi-line cells within one table row).
    const atomBlocks: Atom[][] = [];
    let prevTop = 0;
    for (const line of rawLines) {
      const t = line[0].top;
      if (atomBlocks.length && prevTop - t <= 9) atomBlocks[atomBlocks.length - 1].push(...line);
      else atomBlocks.push([...line]);
      prevTop = t;
    }
    for (const ba of atomBlocks) {
      const cells = blockCells(ba);
      if (cells.length) out.push({ page: page.number, cells, text: cells.map((c) => c.text).filter(Boolean).join("\t\t") });
    }
  }
  return out;
}

/** Group a block's atoms into vertical strips (multi-line cells) by left-edge alignment. */
function blockCells(atoms: Atom[]): Cell[] {
  const strips: Atom[][] = [];
  for (const a of [...atoms].sort((p, q) => q.top - p.top || p.x - q.x)) {
    const center = (a.x + a.x2) / 2;
    let placed = false;
    for (const strip of strips) {
      const last = strip[strip.length - 1];
      const gap = last.top - a.top;
      if (Math.abs(a.x - last.x) > 3 || gap < -0.1 || gap > 9) continue;
      const drifts = Math.abs(center - (last.x + last.x2) / 2) > 1;
      if (a.x < 100 || drifts) {
        strip.push(a);
        placed = true;
        break;
      }
    }
    if (!placed) strips.push([a]);
  }
  strips.sort((p, q) => Math.min(...p.map((a) => a.x)) - Math.min(...q.map((a) => a.x)));
  const cells: Cell[] = [];
  for (const strip of strips) {
    const ordered = [...strip].sort((p, q) => q.top - p.top || p.x - q.x);
    const pieces: string[] = [];
    let continuation = false;
    for (const a of ordered) {
      const part = a.text.trim();
      if (!part) continue;
      if (continuation) pieces[pieces.length - 1] += part;
      else pieces.push(part);
      const lastPiece = pieces[pieces.length - 1];
      continuation = lastPiece.endsWith(SOFT_HYPHEN);
      if (continuation) pieces[pieces.length - 1] = lastPiece.slice(0, -1);
    }
    const text = pieces.join("\n").split(SOFT_HYPHEN).join("");
    if (!text) continue;
    cells.push({
      x: Math.min(...strip.map((a) => a.x)),
      x2: Math.max(...strip.map((a) => a.x2)),
      top: Math.max(...strip.map((a) => a.top)),
      text,
    });
  }
  return cells;
}

const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}\d$/;
const INF_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const ANY_ISIN_IN_TEXT_RE = /\b(IN[EF9][0-9A-Z]{8}\d)\b/i;
const FOLIO_TAIL_RE = /^\d+\/\d+$/;
const PLACEHOLDER_UCCS = new Set(["NOT AVAILABLE", "NA", "N.A.", ""]);
const oneLine = (s: string) => s.replace(/\n/g, " ").trim();

interface DematAccount extends CasAccount {
  equities: CasEquity[];
  mutual_funds: CasDematMutualFund[];
  bonds: CasBond[];
}

const newAccount = (name: string, type: string, dp_id = "", client_id = ""): DematAccount => ({
  dp_id, client_id, name, type, equities: [], mutual_funds: [], bonds: [],
});

const isTotalRow = (b: Block) => ["sub total", "total", "grand total"].includes((b.cells[0]?.text ?? "").trim().toLowerCase());

function closes(balance: number, nav: number, value: number): boolean {
  if (balance <= 0 || nav <= 0 || value <= 0) return false;
  return Math.abs(balance * nav - value) <= Math.max(0.01, Math.abs(value) * 0.005) + 1e-9;
}

function relClose(a: number, b: number, rel = 0.005): boolean {
  if (b === 0) return Math.abs(a) <= 0.01 + 1e-9;
  return Math.abs(a - b) / Math.abs(b) <= rel + 1e-12;
}

function pickBalanceClosing(cands: number[], nav: number, value: number): number {
  if (!cands.length) return 0;
  const pos = cands.filter((c) => c > 0);
  const pool = pos.length ? pos : cands;
  if (nav > 0 && value > 0) {
    const closed = pool.filter((c) => closes(c, nav, value));
    if (closed.length === 1) return closed[0];
  }
  return Math.max(...pool);
}

function equityRow(b: Block, detailed: boolean): CasEquity | null {
  if (!b.cells.length) return null;
  const isin = b.cells[0].text.split("\n")[0].trim();
  if (!ISIN_RE.test(isin)) return null;
  const name = b.cells.length > 1 ? oneLine(b.cells[1].text) : "";
  const nums = b.cells.slice(2).map((c) => c.text.trim()).filter(looksNumeric);
  if (nums.length < 3) return null;
  let price = toNum(nums[nums.length - 2]);
  const value = toNum(nums[nums.length - 1]);
  let shares: number;
  if (detailed || nums.length >= 9) shares = toNum(nums[0]);
  else if (nums.length === 4) shares = toNum(nums[nums.length - 3]);
  else shares = pickBalanceClosing(nums.slice(0, -2).map(toNum), price, value);
  if (shares > 0 && value > 0 && !closes(shares, price, value)) price = value / shares;
  return { isin, name, symbol: null, num_shares: shares, price, value };
}

function summaryMfRow(b: Block): CasDematMutualFund | null {
  if (!b.cells.length) return null;
  const isin = b.cells[0].text.trim();
  if (!ISIN_RE.test(isin)) return null;
  const name = b.cells.length > 1 ? oneLine(b.cells[1].text) : "";
  const nums = b.cells.slice(2).map((c) => c.text.trim()).filter(looksNumeric);
  if (nums.length < 3) return null;
  let nav = toNum(nums[nums.length - 2]);
  const value = toNum(nums[nums.length - 1]);
  const balance = pickBalanceClosing(nums.slice(0, -2).map(toNum), nav, value);
  if (balance > 0 && value > 0 && !closes(balance, nav, value)) nav = value / balance;
  return { isin, name, balance, nav, value, avg_cost: null, total_cost: null, pnl: null, folio: null };
}

function detailedMfRow(b: Block): CasDematMutualFund | null {
  if (!b.cells.length) return null;
  const isin = b.cells[0].text.trim();
  if (!INF_ISIN_RE.test(isin)) return null;
  const name = b.cells.length > 1 ? oneLine(b.cells[1].text) : "";
  const nums = b.cells.slice(2).map((c) => c.text.trim()).filter(looksNumeric);
  if (nums.length < 3) return null;
  return {
    isin, name, balance: toNum(nums[0]), nav: toNum(nums[nums.length - 2]), value: toNum(nums[nums.length - 1]),
    avg_cost: null, total_cost: null, pnl: null, folio: null,
  };
}

const isFolioToken = (s: string) => {
  const t = s.trim().replace(/,/g, "");
  return !!t && (FOLIO_TAIL_RE.test(t) || (/^\d+$/.test(t) && t.length >= 4));
};

function isTruncatedFragment(r: number, value: number): boolean {
  if (r <= 0 || r >= value) return false;
  const digits = String(Math.trunc(r)).length;
  if (digits < 4) return false;
  const diffCents = Math.round((value - r) * 100);
  return diffCents % Math.round(10 ** digits * 100) === 0;
}

/** NSDL "Mutual Fund Folios (F)" row: ISIN [UCC], name, folio, units, then a numeric tail resolved arithmetically. */
function mfHoldingsRow(b: Block): CasDematMutualFund | null {
  const cells = b.cells;
  const isinIdx = cells.findIndex((c) => INF_ISIN_RE.test(c.text.split("\n")[0].trim()));
  if (isinIdx < 0) return null;
  const isinLines = cells[isinIdx].text.split("\n").map((l) => l.trim()).filter(Boolean);
  const isin = isinLines[0];

  let name: string | null = null;
  if (isinIdx > 0) {
    const parts = cells.slice(0, isinIdx).filter((c) => c.text.trim()).map((c) => oneLine(c.text));
    if (parts.length) name = parts.join(" ") || null;
  }
  let idx = isinIdx + 1;
  if (name === null && idx < cells.length && !isFolioToken(cells[idx].text) && !looksNumeric(cells[idx].text)) {
    name = oneLine(cells[idx].text) || null;
    idx++;
  }
  let folio: string | null = null;
  if (idx < cells.length && isFolioToken(cells[idx].text)) {
    folio = cells[idx].text.trim().replace(/,/g, "");
    idx++;
    if (idx < cells.length && FOLIO_TAIL_RE.test(cells[idx].text.trim())) {
      folio += cells[idx].text.trim();
      idx++;
    }
  }
  while (idx < cells.length && !looksNumeric(cells[idx].text)) idx++;

  // Units column: the first numeric, plus any lone 1-2 character UCC digit rendered beside it.
  const cluster: Cell[] = [];
  let startX = 0;
  while (idx < cells.length && looksNumeric(cells[idx].text)) {
    const t = cells[idx].text.trim();
    if (!cluster.length) startX = cells[idx].x;
    else if (!(Math.abs(cells[idx].x - startX) <= 35 && t.length <= 2)) break;
    cluster.push(cells[idx]);
    idx++;
  }
  const balance = cluster.length ? Math.max(...cluster.map((c) => toNum(c.text))) : 0;

  const tail = cells.slice(idx).filter((c) => looksNumeric(c.text)).map((c) => [c.x, toNum(c.text)] as [number, number]);
  tail.sort((p, q) => p[0] - q[0]);
  const r = resolveMfTail(balance, tail);
  return { isin, name: name ?? "", balance, nav: r.nav, value: r.value, avg_cost: r.avgCost, total_cost: r.totalCost, pnl: r.pnl, folio };
}

function resolveMfTail(balance: number, tail: [number, number][]) {
  let nav = 0;
  let value = 0;
  let navIdx: number | null = null;
  let valIdx: number | null = null;
  const res = { nav: 0, value: 0, avgCost: null as number | null, totalCost: null as number | null, pnl: null as number | null };
  if (!tail.length) return res;

  const pairs: [number, number, number][] = [];
  for (let i = 0; i + 1 < tail.length; i++) if (closes(balance, tail[i][1], tail[i + 1][1])) pairs.push([i, tail[i][1], tail[i + 1][1]]);
  for (let i = 0; i + 2 < tail.length; i++) if (closes(balance, tail[i][1], tail[i + 2][1])) pairs.push([i, tail[i][1], tail[i + 2][1]]);
  if (pairs.length) {
    // Rightmost closing pair is (nav, value); an (avg cost, total cost) pair also closes but sits further left.
    const best = pairs.reduce((p, q) => (q[0] > p[0] ? q : p));
    [navIdx, nav, value] = best;
    valIdx = navIdx + 1;
    for (let j = navIdx + 1; j < tail.length; j++) {
      if (tail[j][1] === value) {
        valIdx = j;
        break;
      }
    }
  } else {
    valIdx = tail.reduce((bi, t, i) => (t[1] > tail[bi][1] ? i : bi), 0);
    value = tail[valIdx][1];
    nav = balance > 0 ? value / balance : 0;
  }

  const costTail = navIdx !== null && navIdx < tail.length ? tail.slice(0, navIdx) : tail.slice(0, Math.min(2, valIdx ?? 0));
  let avgCost: number | null = null;
  let totalCost: number | null = null;
  if (costTail.length >= 2) {
    avgCost = costTail[costTail.length - 2][1];
    totalCost = costTail[costTail.length - 1][1];
  } else if (costTail.length === 1) totalCost = costTail[0][1];
  if (navIdx !== null && valIdx !== null && valIdx === navIdx + 2 && valIdx < tail.length) totalCost = tail[navIdx + 1][1];

  // Market value printed twice (full and truncated) or echoed total cost within the value column.
  const valueCands = [value];
  const valX = tail[valIdx][0];
  tail.forEach(([x, v], j) => {
    if (j !== valIdx && Math.abs(x - valX) <= 35) valueCands.push(v);
  });
  value = pickMfValue(balance, nav, totalCost, valueCands);
  if (balance > 0 && value > 0 && !closes(balance, nav, value)) nav = value / balance;

  const consumed = new Set<number>();
  if (navIdx !== null) {
    for (let j = 0; j <= navIdx; j++) consumed.add(j);
    consumed.add(valIdx);
    if (valIdx === navIdx + 2) consumed.add(navIdx + 1);
  } else {
    for (let j = 0; j < Math.min(2, valIdx); j++) consumed.add(j);
    consumed.add(valIdx);
  }
  tail.forEach(([x, v], j) => {
    if (!consumed.has(j) && Math.abs(x - valX) <= 35 && valueCands.includes(v) && v !== value) consumed.add(j);
  });
  let remaining = tail.filter((_, j) => !consumed.has(j)).map((t) => t[1]).filter((v) => v !== 0);
  if (value > 0) {
    const expected = totalCost && totalCost > 0 ? value - totalCost : null;
    remaining = remaining.filter((v) => (expected !== null && relClose(v, expected)) || !isTruncatedFragment(v, value));
  }

  let pnl: number | null = null;
  if (remaining.length === 1) {
    const v = remaining[0];
    if (totalCost && totalCost > 0) {
      if (relClose(v, value - totalCost)) pnl = v;
      else if (Math.abs(v) >= 50) pnl = v;
    } else pnl = v;
  } else if (remaining.length >= 2) {
    if (totalCost && totalCost > 0) {
      const expected = value - totalCost;
      pnl = remaining.find((v) => relClose(v, expected)) ?? null;
      if (pnl === null) pnl = remaining.reduce((p, q) => (Math.abs(q - expected) < Math.abs(p - expected) ? q : p));
    } else pnl = remaining[0];
  }
  return { nav, value, avgCost, totalCost, pnl };
}

function pickMfValue(balance: number, nav: number, totalCost: number | null, cands: number[]): number {
  if (!cands.length) return 0;
  if (cands.length === 1) return cands[0];
  let pool = [...cands];
  const pos = pool.filter((v) => v > 0);
  if (pos.length) pool = pos;
  if (totalCost && totalCost > 0 && pool.length > 1) {
    pool = pool.filter((v) => Math.abs(v - totalCost) / totalCost > 0.03 || (balance > 0 && nav > 0 && closes(balance, nav, v)));
    if (!pool.length) pool = pos.length ? pos : [...cands];
  }
  if (balance > 0 && nav > 0) {
    const closed = pool.filter((v) => closes(balance, nav, v));
    if (closed.length === 1) return closed[0];
  }
  return Math.max(...pool);
}

// NSDL summary bonds table: columns by absolute x band.
const BOND_COLS: [string, number, number][] = [
  ["isin", 15, 80], ["name", 80, 175], ["coupon_band", 175, 240], ["maturity", 240, 310],
  ["num_bonds", 310, 390], ["face_value", 390, 510], ["value", 510, 600],
];

function bondSummaryRow(b: Block): CasBond | null {
  if (!b.cells.length) return null;
  const isin = b.cells[0].text.split("\n")[0].trim();
  if (!ISIN_RE.test(isin)) return null;
  const by: Record<string, Cell[]> = {};
  for (const c of b.cells) {
    const col = BOND_COLS.find(([, lo, hi]) => lo <= c.x && c.x < hi);
    if (col) (by[col[0]] ??= []).push(c);
  }
  const name = (by.name ?? []).map((c) => oneLine(c.text)).join(" ").trim();
  const numBonds = by.num_bonds ? toNum(by.num_bonds[0].text) : 0;
  const faceValue = by.face_value ? optNum(by.face_value[0].text) : null;
  const value = by.value ? toNum(by.value[0].text) : 0;
  return { isin, name, num_bonds: numBonds, num_units: numBonds, face_value: faceValue, market_price: null, price: null, value };
}

function bondDetailedRow(b: Block): CasBond | null {
  if (!b.cells.length) return null;
  const isin = b.cells[0].text.trim();
  if (!ISIN_RE.test(isin)) return null;
  const name = b.cells.length > 1 ? oneLine(b.cells[1].text) : "";
  const nums = b.cells.slice(2).map((c) => c.text.trim()).filter(looksNumeric);
  if (nums.length < 3) return null;
  const numBonds = toNum(nums[0]);
  const mp = optNum(nums[nums.length - 2]);
  return { isin, name, num_bonds: numBonds, num_units: numBonds, market_price: mp, price: mp, face_value: null, value: toNum(nums[nums.length - 1]) };
}

const accountKey = (type: string, dp: string, client: string) => `${type.toUpperCase()}|${dp.trim()}|${client.trim()}`;

const NSDL_DEMAT_TYPE_RE = /^(NSDL|CDSL)\s+Demat\s+Account\s*$/i;
const NSDL_DP_CLIENT_RE = /DP\s*ID\s*:?\s*(\S+?)\s+Client\s*ID\s*:?\s*(\d+)/i;

const SECTION_MARKERS: Record<string, string> = {
  "equity shares": "equities",
  "equities (e)": "equities",
  "mutual funds (m)": "mfunds",
  "mutual funds units held with the amc": "mfunds",
  "corporate bonds (c)": "bonds",
};
const UNSUPPORTED_SECTIONS = new Set([
  "preference shares (p)", "alternate investment fund (a)", "money market instruments (i)",
  "securitised instruments (s)", "government securities (g)", "postal saving scheme (o)",
  "national pension system (n)", "zero coupon zero principal(z)",
]);

function nsdlMode(b: Block, section: string | null): string | null {
  if (ANY_ISIN_IN_TEXT_RE.test(b.text)) return null;
  const t = b.text.toLowerCase().replace(/\n/g, " ").split("\t\t").join(" ");
  if (t.includes("folio no") && (t.includes("average") || t.includes("total cost"))) return "mf_holdings";
  if (t.includes("current bal") && (t.includes("market price") || t.includes("value in"))) {
    return section === "bonds" ? "bonds_detailed" : section === "mfunds" ? "mfunds_detailed" : "equities_detailed";
  }
  if (t.includes("coupon") && (t.includes("maturity") || t.includes("frequency"))) return "bonds_summary";
  if (t.includes("stock symbol") && t.includes("company name")) return "equities_summary";
  if (t.includes("isin description") && (t.includes("nav") || t.includes("value in"))) return "mfunds_summary";
  return null;
}

function parseNsdl(pages: PageText[]): CasAccount[] {
  const all = blocks(pages);
  const byKey = new Map<string, DematAccount>();
  const ordered: DematAccount[] = [];
  let mfFolios: DematAccount | null = null;

  // Account roster (page 2).
  for (const b of all) {
    if (b.page !== 2) continue;
    const cells = b.cells;
    if ((cells.length === 4 || cells.length === 5) && NSDL_DEMAT_TYPE_RE.test(cells[0].text.trim())) {
      const dpIdx = cells.findIndex((c, i) => i >= 1 && NSDL_DP_CLIENT_RE.test(c.text));
      if (dpIdx >= 1) {
        const type = NSDL_DEMAT_TYPE_RE.exec(cells[0].text.trim())![1].toUpperCase();
        const dpc = NSDL_DP_CLIENT_RE.exec(cells[dpIdx].text)!;
        const brokerLines = cells[dpIdx].text.split("\n").map((l) => l.trim()).filter((l) => l && !NSDL_DP_CLIENT_RE.test(l));
        const broker = brokerLines[0] ?? (dpIdx >= 2 ? cells[dpIdx - 1].text.trim() : "");
        const key = accountKey(type, dpc[1], dpc[2]);
        if (!byKey.has(key)) {
          const ac = newAccount(broker, `${type} Demat Account`, dpc[1], dpc[2]);
          byKey.set(key, ac);
          ordered.push(ac);
        }
        continue;
      }
    }
    if (cells.length === 4 && /^Mutual\s+Fund\s+Folios\b/i.test(cells[0].text.trim()) && !mfFolios) {
      mfFolios = newAccount("Mutual Fund Folios", "Mutual Fund Folios");
      ordered.push(mfFolios);
    }
  }

  const later = all.filter((b) => b.page > 2);
  let account: DematAccount | null = null;
  let mode: string | null = null;
  let section: string | null = null;
  for (let i = 0; i < later.length; i++) {
    const b = later[i];
    // Per-account section header: type + DP/Client ids in one block, or split over the next few blocks.
    const typeM = /\b(NSDL|CDSL)\b\s+Demat\s+Account/i.exec(b.text);
    if (typeM) {
      let key: string | null = null;
      let consumed = 1;
      const dpc = NSDL_DP_CLIENT_RE.exec(b.text);
      if (dpc && b.cells.length >= 3 && b.cells.length <= 8 && b.text.length < 500) {
        key = accountKey(typeM[1], dpc[1], dpc[2]);
      } else if (b.text.toLowerCase().includes("account holder")) {
        for (let j = 1; j < 4 && i + j < later.length && later[i + j].page === b.page; j++) {
          const m = NSDL_DP_CLIENT_RE.exec(later[i + j].text);
          if (m) {
            key = accountKey(typeM[1], m[1], m[2]);
            consumed = j + 1;
            break;
          }
        }
      }
      if (key !== null) {
        account = byKey.get(key) ?? null;
        mode = null;
        section = null;
        i += consumed - 1;
        continue;
      }
    }
    if (b.text.toLowerCase().includes("mutual fund folios (f)")) {
      account = mfFolios;
      mode = "mf_holdings";
      section = "mfunds";
      continue;
    }
    if (account) {
      const m = nsdlMode(b, section);
      if (m) {
        mode = m;
        continue;
      }
      if (isTotalRow(b)) continue;
      if (b.cells.length <= 2) {
        const t = b.text.trim().toLowerCase();
        const sec = SECTION_MARKERS[t] ?? (UNSUPPORTED_SECTIONS.has(t) ? "unsupported" : null);
        if (sec) {
          section = sec;
          mode = null;
          continue;
        }
      }
    }
    if (!account || !mode) continue;
    switch (mode) {
      case "equities_summary":
      case "equities_detailed": {
        const e = equityRow(b, mode === "equities_detailed");
        if (e) account.equities.push(e);
        break;
      }
      case "mfunds_summary": {
        const mf = summaryMfRow(b);
        if (mf) account.mutual_funds.push(mf);
        break;
      }
      case "mfunds_detailed": {
        const mf = detailedMfRow(b);
        if (mf) account.mutual_funds.push(mf);
        break;
      }
      case "mf_holdings": {
        const mf = mfHoldingsRow(b);
        if (mf) account.mutual_funds.push(mf);
        break;
      }
      case "bonds_summary": {
        const bd = bondSummaryRow(b);
        if (bd) account.bonds.push(bd);
        break;
      }
      case "bonds_detailed": {
        const bd = bondDetailedRow(b);
        if (bd) account.bonds.push(bd);
        break;
      }
    }
  }
  return ordered;
}

const CDSL_SUMMARY_DPC_RE = /DP\s*Id\s*:\s*(\S+?)\s+Client\s*Id\s*:\s*(\d+)/i;
const CDSL_SECTION_DPC_RE = /DP\s*Name\s*:\s*([\s\S]+?)\s+DP\s*ID\s*:\s*(\S+)\s+CLIENT\s*ID\s*:\s*(\S+)/i;
const CDSL_SECTION_BOID_RE = /DP\s*Name\s*:\s*([\s\S]+?)\s+(?:BO\s*ID|DPID)\s*:\s*([A-Z0-9]{16})/i;

function cdslHoldingsHeader(b: Block): boolean {
  if (ANY_ISIN_IN_TEXT_RE.test(b.text)) return false;
  const t = b.text.toLowerCase().replace(/\n/g, " ").split("\t\t").join(" ");
  return (t.includes("isin") && (t.includes("security") || t.includes("scheme name"))) ||
    (t.includes("current") && t.includes("bal") && t.includes("market"));
}

function parseCdsl(pages: PageText[]): CasAccount[] {
  const all = blocks(pages);
  const byKey = new Map<string, DematAccount>();
  const ordered: DematAccount[] = [];
  let mfFolios: DematAccount | null = null;

  for (const b of all) {
    if (b.page !== 2 || b.cells.length !== 4) continue;
    const c0 = b.cells[0].text.trim();
    const typeM = /^(CDSL|NSDL)\s+Demat\s+Account\s*$/i.exec(c0);
    if (typeM && CDSL_SUMMARY_DPC_RE.test(b.cells[1].text)) {
      const lines = b.cells[1].text.split("\n").map((l) => l.trim()).filter(Boolean);
      const dpc = CDSL_SUMMARY_DPC_RE.exec(b.cells[1].text)!;
      const key = accountKey(typeM[1], dpc[1], dpc[2]);
      if (!byKey.has(key)) {
        const ac = newAccount(lines[0] ?? "", `${typeM[1].toUpperCase()} Demat Account`, dpc[1], dpc[2]);
        byKey.set(key, ac);
        ordered.push(ac);
      }
      continue;
    }
    if (/^Mutual\s+Fund\s+Folios/i.test(c0) && !mfFolios) {
      mfFolios = newAccount("Mutual Fund Folios", "Mutual Fund Folios");
      ordered.push(mfFolios);
    }
  }

  let account: DematAccount | null = null;
  let mode: "equities" | "mf_holdings" | null = null;
  for (const b of all) {
    if (b.page < 3) continue;
    const text = b.text;
    const lower = text.toLowerCase();
    const bo = CDSL_SECTION_BOID_RE.exec(text);
    if (bo) {
      const id = bo[2];
      const split = id.length !== 16 ? null : id.slice(0, 2).toUpperCase() === "IN" ? "NSDL" : /^\d+$/.test(id) ? "CDSL" : null;
      if (split) {
        account = byKey.get(accountKey(split, id.slice(0, 8), id.slice(8))) ?? null;
        mode = null;
        continue;
      }
    }
    const dpc = CDSL_SECTION_DPC_RE.exec(text);
    if (dpc) {
      const upper = text.toUpperCase();
      const type = upper.includes("NSDL") && !upper.includes("CDSL") ? "NSDL" : "CDSL";
      account = byKey.get(accountKey(type, dpc[2], dpc[3])) ?? null;
      mode = null;
      continue;
    }
    if (lower.includes("statement of transactions")) {
      mode = null;
      continue;
    }
    if (lower.includes("holding statement") && lower.includes("as on")) {
      mode = "equities";
      continue;
    }
    if (lower.includes("mutual fund units held as on")) {
      account = mfFolios;
      mode = "mf_holdings";
      continue;
    }
    if (cdslHoldingsHeader(b) || isTotalRow(b)) continue;
    if (!account || !mode) continue;
    if (mode === "equities") {
      const row = cdslHoldingsRow(b);
      if (!row) continue;
      if (INF_ISIN_RE.test(row.isin)) {
        // ETFs sit in the equity table but are mutual-fund units.
        account.mutual_funds.push({
          isin: row.isin, name: row.name, balance: row.shares, nav: row.price, value: row.value,
          avg_cost: null, total_cost: null, pnl: null, folio: null,
        });
      } else {
        account.equities.push({ isin: row.isin, name: row.name, symbol: null, num_shares: row.shares, price: row.price, value: row.value });
      }
    } else {
      const mf = cdslMfRow(b);
      if (mf) account.mutual_funds.push(mf);
    }
  }
  return ordered;
}

/** CDSL holding row: ISIN | Security | Current Bal | ... | Market Price | Value. */
function cdslHoldingsRow(b: Block) {
  const cells = b.cells;
  if (!cells.length) return null;
  const isin = cells[0].text.trim();
  if (!ISIN_RE.test(isin)) return null;
  let start = -1;
  for (let i = 1; i < cells.length; i++) {
    const t = cells[i].text.trim();
    if (looksNumeric(t) || t === "--" || t === "-") {
      start = i;
      break;
    }
  }
  if (start < 0 || cells.length - start < 3) return null;
  const name = cells.slice(1, start).map((c) => c.text.trim()).filter((t) => t && t !== "@").map(oneLine).join(" ");
  return {
    isin,
    name,
    shares: toNum(cells[start].text),
    price: toNum(cells[cells.length - 2].text),
    value: toNum(cells[cells.length - 1].text),
  };
}

/** CDSL "MUTUAL FUND UNITS HELD" row: name | ISIN | folio | [ARN/DIRECT] | units | NAV | [invested] | value | ... */
function cdslMfRow(b: Block): CasDematMutualFund | null {
  const cells = b.cells;
  if (cells.length < 5) return null;
  let isinIdx = -1;
  for (let i = 0; i < Math.min(3, cells.length); i++) {
    if (ISIN_RE.test(cells[i].text.trim())) {
      isinIdx = i;
      break;
    }
  }
  if (isinIdx < 0) return null;
  const isin = cells[isinIdx].text.trim();
  const name = cells.slice(0, isinIdx).filter((c) => c.text.trim()).map((c) => oneLine(c.text)).join(" ");
  let folio: string | null = null;
  let folioEnd = isinIdx + 1;
  if (isinIdx + 1 < cells.length) folio = cells[isinIdx + 1].text.trim() || null;
  if (folio && isinIdx + 2 < cells.length) {
    const tail = cells[isinIdx + 2].text.trim();
    if (/^\d+\/\d+$/.test(tail)) {
      folio += tail;
      folioEnd = isinIdx + 2;
    }
  }
  const disc = folioEnd + 1;
  const hasDistrib = disc < cells.length && !looksNumeric(cells[disc].text);
  const nums = cells.slice(disc + (hasDistrib ? 1 : 0)).map((c) => c.text.trim()).filter(looksNumeric);
  if (nums.length < 3) return null;
  const balance = toNum(nums[0]);
  const nav = toNum(nums[1]);
  let invested: number | null = null;
  let value: number;
  if (nums.length >= 4) {
    invested = optNum(nums[2]);
    value = toNum(nums[3]);
  } else value = toNum(nums[2]);

  let pnl: number | null = null;
  if (hasDistrib && invested !== null && invested > 0) {
    const expected = value - invested;
    const valueIdx = nums.length >= 4 ? 3 : 2;
    const remaining = nums.slice(valueIdx + 1).map(toNum).filter((v) => v !== 0);
    pnl = remaining.find((v) => relClose(v, expected)) ?? null;
    if (pnl === null && nums.length >= 6) {
      const pos = optNum(nums[nums.length - 2]);
      if (pos !== null && relClose(pos, expected)) pnl = pos;
    }
    if (pnl === 0) pnl = null;
  }
  return { isin, name, balance, nav, value, avg_cost: null, total_cost: invested, pnl, folio };
}

// ---------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------

/**
 * Parse a CAS PDF into its holdings snapshot.
 * @throws CasPasswordError when the password does not unlock the PDF.
 * @throws CasFormatError when the file is not a PDF or not a recognisable CAS.
 */
export async function parseCas(pdf: Uint8Array, password: string): Promise<CasData> {
  if (!pdf || !pdf.length) throw new CasFormatError("The file is empty.");
  const pages = await extractPages(pdf, password ?? "");
  const fileType = detectFileType(pages);
  if (fileType === "UNKNOWN") {
    throw new CasFormatError(
      "This PDF is not a recognised Consolidated Account Statement. Supported statements are CAMS, KFintech, NSDL and CDSL CAS PDFs.",
    );
  }
  if (fileType === "CAMS" || fileType === "KFINTECH") {
    const casType = detectCasType(pages);
    if (casType === "UNKNOWN") {
      throw new CasFormatError(
        `Could not tell whether this ${fileType} statement is a detailed statement or a summary.`,
      );
    }
    const folios = casType === "DETAILED" ? parseCamsDetailed(pages) : parseCamsSummary(pages);
    return { file_type: fileType, cas_type: casType, accounts: [], folios };
  }
  const accounts = fileType === "NSDL" ? parseNsdl(pages) : parseCdsl(pages);
  return { file_type: fileType, accounts, folios: [] };
}
