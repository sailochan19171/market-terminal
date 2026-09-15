// Small Python-compatibility helpers for the NSE market-data ports.
//
// The TypeScript sources must write exactly what the Python pipeline wrote (same ids, same dates, same
// "raw" JSON), so the few stdlib behaviours they lean on are reproduced here rather than approximated:
// str.strip(), float(), truthiness for `a or b`, datetime.strptime for the handful of formats used,
// csv.DictReader and json.dumps(separators=(",", ":")).

/** Characters Python's str.strip() removes (str.isspace()). */
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Python str.strip(). */
export const pyStrip = (s: string): string => s.replace(STRIP_RE, "");

/** Python truthiness for JSON-ish values (None, "", 0, False, [], {} are falsy). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true; // NaN is truthy in Python
}

/** Python `a or b or ...`: the first truthy value, else the last one. */
export function pyOr(...values: unknown[]): unknown {
  for (const v of values) if (pyTruthy(v)) return v;
  return values[values.length - 1];
}

/** Python repr() of a str. */
function pyReprStr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else if (/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(ch) || (/\p{Zs}/u.test(ch) && ch !== " ")) {
      out += cp <= 0xff ? "\\x" + cp.toString(16).padStart(2, "0") : cp <= 0xffff ? "\\u" + cp.toString(16).padStart(4, "0") : "\\U" + cp.toString(16).padStart(8, "0");
    } else out += ch;
  }
  return quote + out + quote;
}

/** Python repr() of a JSON value (as produced by json.loads). */
export function pyRepr(v: unknown): string {
  if (typeof v === "string") return pyReprStr(v);
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${pyReprStr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  return pyStr(v);
}

/** Python str(v) for a JSON value (None -> "None", True -> "True", lists and dicts as their repr). */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return pyFloatRepr(v, Number.isSafeInteger(v));
  if (typeof v === "object") return pyRepr(v);
  return String(v);
}

/** `(v or "").strip()` - the idiom used for every text field. */
export const textOf = (v: unknown): string => pyStrip(pyTruthy(v) ? String(v) : "");

/** `(v or "").strip() or None` */
export const textOrNull = (v: unknown): string | null => textOf(v) || null;

/** Map Unicode decimal digits (category Nd) to ASCII, as float() and int() do. Nd digits come in runs of ten from 0. */
function asciiDigits(s: string): string {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  return s.replace(/\p{Nd}/gu, (ch) => {
    let cp = ch.codePointAt(0)!;
    const start = cp;
    while (cp > 0 && /\p{Nd}/u.test(String.fromCodePoint(cp - 1))) cp--;
    return String((start - cp) % 10);
  });
}

const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?|inf(?:inity)?|nan)$/i;

/** Python float(str) for text; null where Python raises ValueError. May return NaN / Infinity like Python. */
export function pyFloat(text: string): number | null {
  const s = asciiDigits(pyStrip(text));
  if (!FLOAT_RE.test(s)) return null;
  const lower = s.toLowerCase().replace(/^[+-]/, "");
  const neg = s.startsWith("-");
  if (lower.startsWith("inf")) return neg ? -Infinity : Infinity;
  if (lower === "nan") return NaN;
  return Number(s.replace(/_/g, ""));
}

/** `try: float(str(v).replace(",", "").strip()) except (TypeError, ValueError): None` for a JSON value. */
export function pyFloatLoose(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") return pyFloat(v.replace(/,/g, ""));
  if (v === null || v === undefined) return null; // "None"
  return null; // bools, lists and dicts do not parse
}

/** Python int(float) truncation. */
export const pyInt = (f: number | null): number | null => (f === null ? null : Math.trunc(f));

// --- datetime.strptime (subset) ----------------------------------------------------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ABBR = MONTHS.map((m) => m.slice(0, 3));
const byLen = (list: string[]) => [...list].sort((a, b) => b.length - a.length).join("|");

const DIRECTIVES: Record<string, string> = {
  d: "(3[0-1]|[1-2]\\d|0[1-9]|[1-9]| [1-9])",
  m: "(1[0-2]|0[1-9]|[1-9])",
  Y: "(\\d\\d\\d\\d)",
  y: "(\\d\\d)",
  H: "(2[0-3]|[0-1]\\d|\\d)",
  M: "([0-5]\\d|\\d)",
  S: "(6[0-1]|[0-5]\\d|\\d)",
  b: `(${byLen(ABBR)})`,
  B: `(${byLen(MONTHS)})`,
};

interface Compiled { re: RegExp; keys: string[] }
const compiled = new Map<string, Compiled | null>();

function compile(fmt: string): Compiled | null {
  if (compiled.has(fmt)) return compiled.get(fmt)!;
  const keys: string[] = [];
  let src = "";
  let ok = true;
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "%") {
      const k = fmt[++i];
      if (!DIRECTIVES[k]) { ok = false; break; } // e.g. "%^b": Python raises ValueError (bad directive)
      keys.push(k);
      src += DIRECTIVES[k];
    } else if (/\s/.test(c)) {
      while (i + 1 < fmt.length && /\s/.test(fmt[i + 1])) i++;
      src += "\\s+";
    } else {
      src += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  const out = ok ? { re: new RegExp(`^${src}$`, "i"), keys } : null;
  compiled.set(fmt, out);
  return out;
}

export interface PyDateTime { year: number; month: number; day: number; hour: number; minute: number; second: number }

const daysIn = (y: number, m: number) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** datetime.strptime(s, fmt) for %d %m %Y %y %H %M %S %b %B; null where Python raises ValueError. */
export function strptime(s: string, fmt: string): PyDateTime | null {
  const c = compile(fmt);
  if (!c) return null;
  const m = c.re.exec(s);
  if (!m) return null;
  const dt: PyDateTime = { year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  c.keys.forEach((k, i) => {
    const v = m[i + 1];
    switch (k) {
      case "d": dt.day = parseInt(v.trim(), 10); break;
      case "m": dt.month = parseInt(v, 10); break;
      case "Y": dt.year = parseInt(v, 10); break;
      case "y": { const y = parseInt(v, 10); dt.year = y <= 68 ? y + 2000 : y + 1900; break; }
      case "H": dt.hour = parseInt(v, 10); break;
      case "M": dt.minute = parseInt(v, 10); break;
      case "S": dt.second = parseInt(v, 10); break;
      case "b": dt.month = ABBR.indexOf(v.toLowerCase()) + 1; break;
      case "B": dt.month = MONTHS.indexOf(v.toLowerCase()) + 1; break;
    }
  });
  if (dt.year < 1 || dt.day > daysIn(dt.year, dt.month) || dt.second > 59) return null;
  return dt;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** date.isoformat() */
export const isoDateOf = (d: PyDateTime) => `${String(d.year).padStart(4, "0")}-${p2(d.month)}-${p2(d.day)}`;
/** datetime.isoformat(timespec="seconds") */
export const isoDateTimeOf = (d: PyDateTime) => `${isoDateOf(d)}T${p2(d.hour)}:${p2(d.minute)}:${p2(d.second)}`;

/** date.strftime("%d-%m-%Y") for an ISO date string. */
export function dmy(iso: string, sep = "-"): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}${sep}${m}${sep}${y}`;
}

/** 0 = Monday ... 6 = Sunday, like date.weekday(). */
export function weekday(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// --- csv.DictReader ------------------------------------------------------------------

/** Python csv.Error */
export class CsvError extends Error {}

const FIELD_LIMIT = 131072;
const St = { StartRecord: 0, StartField: 1, InField: 2, InQuoted: 3, QuoteInQuoted: 4, EatCrnl: 5 } as const;
type St = (typeof St)[keyof typeof St];

/** csv.reader(io.StringIO(text)) with the default excel dialect. Yields [] for blank lines like Python. */
export function* csvReader(text: string): Generator<string[]> {
  // io.StringIO splits lines on "\n" only, keeping the terminator.
  const lines: string[] = [];
  let start = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
    lines.push(text.slice(start, i + 1));
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));

  let li = 0;
  for (;;) {
    const fields: string[] = [];
    let field = "";
    let fieldLen = 0;
    let state = St.StartRecord as St;
    const save = () => { fields.push(field); field = ""; fieldLen = 0; };
    const add = (c: string) => {
      if (fieldLen >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
      field += c;
      fieldLen++;
    };
    // EOL is represented by null.
    const step = (c: string | null) => {
      const nl = c === "\n" || c === "\r";
      switch (state) {
        case St.StartRecord:
          if (c === null) return;
          if (nl) { state = St.EatCrnl; return; }
          state = St.StartField;
        // fallthrough
        case St.StartField:
          if (nl || c === null) { save(); state = c === null ? St.StartRecord : St.EatCrnl; }
          else if (c === '"') state = St.InQuoted;
          else if (c === ",") save();
          else { add(c); state = St.InField; }
          return;
        case St.InField:
          if (nl || c === null) { save(); state = c === null ? St.StartRecord : St.EatCrnl; }
          else if (c === ",") { save(); state = St.StartField; }
          else add(c);
          return;
        case St.InQuoted:
          if (c === null) return;
          if (c === '"') state = St.QuoteInQuoted;
          else add(c);
          return;
        case St.QuoteInQuoted:
          if (c === '"') { add(c); state = St.InQuoted; }
          else if (c === ",") { save(); state = St.StartField; }
          else if (nl || c === null) { save(); state = c === null ? St.StartRecord : St.EatCrnl; }
          else { add(c); state = St.InField; }
          return;
        case St.EatCrnl:
          if (nl) return;
          if (c === null) { state = St.StartRecord; return; }
          throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
      }
    };

    let ended = false;
    do {
      if (li >= lines.length) {
        if (fieldLen !== 0 || state === St.InQuoted) { save(); ended = true; break; }
        return;
      }
      const line = lines[li++];
      if (state === St.StartRecord && !line.includes('"') && !line.includes("\r")) {
        // Fast path, same result as the state machine: a plain line is a comma split.
        const body = line.endsWith("\n") ? line.slice(0, -1) : line;
        const parts = body ? body.split(",") : [];
        if (parts.every((p) => p.length <= FIELD_LIMIT)) {
          fields.push(...parts);
          break;
        }
      }
      for (let i = 0; i < line.length; i++) step(line[i]);
      step(null);
    } while (state !== St.StartRecord);
    yield fields;
    if (ended) return;
  }
}

/** One csv.DictReader row as ordered [key, value] pairs; the restkey is null and holds string[]. */
export type DictRow = Map<string | null, string | string[] | null>;

/** csv.DictReader(io.StringIO(text)) */
export function* dictReader(text: string): Generator<DictRow> {
  const reader = csvReader(text);
  const head = reader.next();
  if (head.done) return;
  const names = head.value;
  for (const row of reader) {
    if (!row.length) continue;
    const d: DictRow = new Map();
    const n = Math.min(names.length, row.length);
    for (let i = 0; i < n; i++) d.set(names[i], row[i]);
    if (names.length < row.length) d.set(null, row.slice(names.length));
    else for (let i = row.length; i < names.length; i++) d.set(names[i], null);
    yield d;
  }
}

/** `{(k or "").<norm>: v for k, v in row.items()}` */
export function normKeys(row: DictRow, norm: (k: string) => string): Map<string, string | string[] | null> {
  const out = new Map<string, string | string[] | null>();
  for (const [k, v] of row) out.set(norm(k ?? ""), v);
  return out;
}

/** UTF-8 decode dropping a leading BOM, invalid bytes replaced (bytes.decode("utf-8-sig", errors="replace")). */
export const decodeUtf8Sig = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

// --- json.dumps(v, separators=(",", ":")) ---------------------------------------------

/**
 * repr(float) / str(int). `asInt` says the JSON token was an integer literal. JSON.parse cannot tell "1.0" from "1",
 * so callers treat safe integers as ints and everything else as floats (NSE payloads carry integers or strings,
 * not integral floats; the recorded fixtures contain none).
 */
export function pyFloatRepr(v: number, asInt: boolean): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "Infinity" : "-Infinity";
  if (asInt) return BigInt(v).toString();
  if (v === 0) return Object.is(v, -0) ? "-0.0" : "0.0";
  const [mant, expS] = v.toExponential().split("e");
  const exp = Number(expS);
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let body: string;
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    body = `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  } else if (exp < 0) {
    body = `0.${"0".repeat(-exp - 1)}${digits}`;
  } else if (digits.length > exp + 1) {
    body = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    body = `${digits}${"0".repeat(exp + 1 - digits.length)}.0`;
  }
  return neg ? `-${body}` : body;
}

const ESC: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function pyJsonString(s: string): string {
  return `"${s.replace(/[\\"]|[^ -~]/g, (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
}

/** json.dumps(v, separators=(",", ":")) with Python's defaults (ensure_ascii=True). */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return pyFloatRepr(v, Number.isSafeInteger(v));
  if (typeof v === "string") return pyJsonString(v);
  if (Array.isArray(v)) return `[${v.map(pyJsonDumps).join(",")}]`;
  if (typeof v === "object") {
    return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pyJsonString(k)}:${pyJsonDumps(x)}`).join(",")}}`;
  }
  return pyJsonString(String(v));
}
