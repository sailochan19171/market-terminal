// Small reproductions of Python built-ins the BSE sources relied on, so the TypeScript port stores
// exactly what the Python pipeline stored: str.strip, float(), int(), truthiness, str(), json.dumps
// and the csv module's reader (excel dialect, as csv.DictReader uses it).

/** Characters Python's str.strip() removes (str.isspace), which differ slightly from JS trim(). */
const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

export const pyStrip = (s: string): string => s.replace(STRIP_RE, "");

/** Python truthiness for JSON values. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export const isDict = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Guard where Python would call dict methods on a value (AttributeError otherwise). */
export function asDict(v: unknown): Record<string, unknown> {
  if (!isDict(v)) throw new TypeError(`'${pyType(v)}' object has no attribute 'get'`);
  return v;
}

/** Guard where Python iterates a value that is expected to be a list of rows. */
export function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  throw new TypeError(`cannot iterate rows of '${pyType(v)}'`);
}

function pyType(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "str";
  return "dict";
}

/** repr() of a Python float: shortest round-trip digits, exponent form outside 1e-4 <= |x| < 1e16. */
export function pyFloatRepr(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  if (n === 0) return Object.is(n, -0) ? "-0.0" : "0.0";
  const [mant, expText] = Math.abs(n).toExponential().split("e");
  const digits = mant.replace(".", "");
  const exp = Number(expText);
  const decpt = exp + 1;
  let body: string;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) body = "0." + "0".repeat(-decpt) + digits;
    else if (decpt >= digits.length) body = digits + "0".repeat(decpt - digits.length) + ".0";
    else body = digits.slice(0, decpt) + "." + digits.slice(decpt);
  } else {
    body = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  }
  return (n < 0 ? "-" : "") + body;
}

/** Python str() of a decoded JSON value. JSON parsing loses int-vs-float, so integral numbers print as ints. */
export function pyStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v).toString() : pyFloatRepr(v);
  return pyJsonDumps(v);
}

/** `(v or "").strip()` - raises like Python when a truthy non-string turns up. */
export function strOrEmpty(v: unknown, fallback = ""): string {
  const x = pyTruthy(v) ? v : fallback;
  if (typeof x !== "string") throw new TypeError(`'${pyType(x)}' object has no attribute 'strip'`);
  return pyStrip(x);
}

/** `str(v or "").strip()` */
export const strOf = (v: unknown): string => pyStrip(pyStr(pyTruthy(v) ? v : ""));

const DIG = "\\d(?:_?\\d)*";
const PY_FLOAT_RE = new RegExp(`^[+-]?(?:(?:${DIG}(?:\\.(?:${DIG})?)?|\\.${DIG})(?:[eE][+-]?${DIG})?|inf|infinity|nan)$`, "i");

const ND = /\p{Nd}/u;

/** Map Unicode decimal digits (which Python's int()/float() accept) to ASCII. Digits come in runs of ten. */
export function asciiDigits(s: string): string {
  if (!/[^\u0000-\u007f]/.test(s)) return s;
  return s.replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0)!;
    let k = 0;
    while (ND.test(String.fromCodePoint(cp - 1 - k))) k++;
    return String(k % 10);
  });
}

/** float(text) for a string, or null where Python raises ValueError. */
export function pyParseFloat(text: string): number | null {
  const s = asciiDigits(pyStrip(text));
  if (!PY_FLOAT_RE.test(s)) return null;
  const body = s.replace(/^[+-]/, "").toLowerCase();
  const neg = s.startsWith("-");
  if (body === "nan") return NaN;
  if (body === "inf" || body === "infinity") return neg ? -Infinity : Infinity;
  return Number(s.replace(/_/g, ""));
}

/** `float(str(v).replace(",", "").strip())`, None on failure - the number helper every source used. */
export function pyFloat(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null; // str(None) / str(True) / str(dict) never parse
  return pyParseFloat(v.replace(/,/g, ""));
}

/** int(float): truncates; raises for nan/inf like Python. */
export function pyInt(f: number): number {
  if (Number.isNaN(f)) throw new RangeError("cannot convert float NaN to integer");
  if (!Number.isFinite(f)) throw new RangeError("cannot convert float infinity to integer");
  return Math.trunc(f);
}

/** json.dumps(v, separators=(",", ":")) with the default ensure_ascii=True. */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return BigInt(v).toString();
    return Number.isNaN(v) ? "NaN" : !Number.isFinite(v) ? (v > 0 ? "Infinity" : "-Infinity") : pyFloatRepr(v);
  }
  if (typeof v === "string") return pyJsonString(v);
  if (Array.isArray(v)) return "[" + v.map(pyJsonDumps).join(",") + "]";
  return "{" + Object.entries(v as object).map(([k, x]) => pyJsonString(k) + ":" + pyJsonDumps(x)).join(",") + "}";
}

const SHORT_ESC: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" };

function pyJsonString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (SHORT_ESC[ch]) out += SHORT_ESC[ch];
    else if (code < 0x20 || code > 0x7e) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

// --- csv -------------------------------------------------------------------------------------
export class CsvError extends Error {}

const FIELD_LIMIT = 131072;
const enum S { StartRecord, StartField, InField, InQuoted, QuoteInQuoted, EatCrnl }

/** Rows exactly as Python's csv.reader(io.StringIO(text)) yields them (excel dialect, strict=False). */
export function* pyCsvReader(text: string): Generator<string[]> {
  // io.StringIO iterates lines ending in "\n" only; the reader then walks each line char by char.
  const lines: string[] = [];
  for (let at = 0; at < text.length;) {
    const nl = text.indexOf("\n", at);
    const stop = nl < 0 ? text.length : nl + 1;
    lines.push(text.slice(at, stop));
    at = stop;
  }
  let li = 0;
  for (;;) {
    const fields: string[] = [];
    let field = "";
    let fieldLen = 0;
    let state = S.StartRecord as S;
    const save = () => { fields.push(field); field = ""; fieldLen = 0; };
    const add = (c: string) => {
      if (fieldLen >= FIELD_LIMIT) throw new CsvError(`field larger than field limit (${FIELD_LIMIT})`);
      field += c;
      fieldLen++;
    };
    const step = (c: string | null) => { // null marks end of line
      const nl = c === "\n" || c === "\r";
      switch (state) {
        case S.StartRecord:
          if (c === null) return;
          if (nl) { state = S.EatCrnl; return; }
          state = S.StartField;
        // falls through
        case S.StartField:
          if (nl || c === null) { save(); state = c === null ? S.StartRecord : S.EatCrnl; }
          else if (c === '"') state = S.InQuoted;
          else if (c === ",") save();
          else { add(c); state = S.InField; }
          return;
        case S.InField:
          if (nl || c === null) { save(); state = c === null ? S.StartRecord : S.EatCrnl; }
          else if (c === ",") { save(); state = S.StartField; }
          else add(c);
          return;
        case S.InQuoted:
          if (c === null) return;
          if (c === '"') state = S.QuoteInQuoted;
          else add(c);
          return;
        case S.QuoteInQuoted:
          if (c === '"') { add(c); state = S.InQuoted; }
          else if (c === ",") { save(); state = S.StartField; }
          else if (nl || c === null) { save(); state = c === null ? S.StartRecord : S.EatCrnl; }
          else { add(c); state = S.InField; }
          return;
        case S.EatCrnl:
          if (nl) return;
          if (c === null) { state = S.StartRecord; return; }
          throw new CsvError("new-line character seen in unquoted field - do you need to open the file with newline=''?");
      }
    };
    let ended = false;
    do {
      if (li >= lines.length) {
        if (fieldLen !== 0 || state === S.InQuoted) { save(); ended = true; break; }
        return;
      }
      for (const c of lines[li++]) step(c);
      step(null);
    } while (state !== S.StartRecord);
    yield fields;
    if (ended) return;
  }
}

/** Python csv.DictReader rows: first row names the columns, blank lines skipped, short rows padded
 *  with null, extra values collected under the `null` key (restkey=None). */
export function* pyDictReader(text: string): Generator<Map<string | null, string | null | string[]>> {
  const reader = pyCsvReader(text);
  const head = reader.next();
  if (head.done) return;
  const names = head.value;
  for (const row of reader) {
    if (!row.length) continue;
    const d = new Map<string | null, string | null | string[]>();
    const n = Math.min(names.length, row.length);
    for (let i = 0; i < n; i++) d.set(names[i], row[i]);
    if (names.length < row.length) d.set(null, row.slice(names.length));
    else for (const key of names.slice(row.length)) d.set(key, null);
    yield d;
  }
}
