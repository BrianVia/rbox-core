/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) — the consensus-critical encoding
 * for every signed E2EE object (commitBody, roster, accountKeyState, admission
 * grant, checkpoint, wrap AAD). Two devices MUST produce byte-identical bytes for
 * the same logical object or signatures won't verify (design 12, V4-7).
 *
 * Scope is deliberately narrow: rbox's signed objects only ever contain strings,
 * non-negative safe integers, booleans, null, arrays, and plain objects — never
 * floats. We REJECT anything outside that (NaN, Infinity, non-integer, unsafe
 * integer, bigint, undefined, functions) rather than guess, because a silent
 * coercion across runtimes is exactly the canonicalization ambiguity this
 * codec exists to exclude. There is no float-formatting code here on purpose.
 */

/** Serialize a value to RFC 8785 canonical JSON bytes (UTF-8). */
export function canonicalize(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalString(value));
}

/** Serialize to the canonical JSON string (sorted keys, no insignificant space). */
export function canonicalString(value: unknown): string {
  return write(value);
}

function write(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value); // JSON.stringify yields RFC 8785-conformant string escaping
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") return writeNumber(value as number);
  if (Array.isArray(value)) return `[${value.map(write).join(",")}]`;
  if (t === "object") return writeObject(value as Record<string, unknown>);
  throw new Error(`jcs: unsupported value of type ${t}`);
}

function writeNumber(n: number): string {
  // rbox signed objects carry only non-negative integers (seq, size, epoch,
  // version, timestamps). Reject everything else so no float-formatting or
  // cross-runtime rounding can ever change a signed preimage.
  if (!Number.isInteger(n) || !Number.isSafeInteger(n) || n < 0) {
    throw new Error(`jcs: numeric fields must be non-negative safe integers (got ${n})`);
  }
  return String(n);
}

function writeObject(obj: Record<string, unknown>): string {
  // RFC 8785 sorts members by the UTF-16 code units of their keys — which is
  // exactly what the default Array.prototype.sort comparator on strings does.
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue; // an absent optional field is omitted, not encoded as null
    parts.push(`${JSON.stringify(k)}:${write(v)}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * Parse UNTRUSTED canonical JSON for signature verification, rejecting the two
 * things RFC 8785 forbids that `JSON.parse` would silently accept: duplicate
 * property names (it keeps the last), and numbers that aren't non-negative safe
 * integers (it would round an unsafe integer). We tokenize the raw text to catch
 * both before handing back the parsed value.
 *
 * The stronger guarantee callers actually rely on is the round-trip: parse, then
 * re-`canonicalize` and byte-compare to what was signed (see `verifyRoundTrip`).
 * parseStrict is the cheap pre-filter that also rejects malformed numbers a
 * round-trip alone wouldn't (since JSON.parse already lost the original digits).
 */
export function parseStrict(text: string): unknown {
  scanTokens(text); // throws on duplicate keys / disallowed numbers
  return JSON.parse(text);
}

/** Verify `text` is the exact canonical encoding of the object it parses to.
 *  This is the verifier-side equality that makes signatures portable. */
export function verifyRoundTrip(text: string): unknown {
  const value = parseStrict(text);
  if (canonicalString(value) !== text) throw new Error("jcs: input is not in canonical form");
  return value;
}

/**
 * Single structural pass over JSON text: rejects duplicate keys within any one
 * object, and rejects number tokens that aren't bare non-negative safe integers.
 * Hand-rolled and total — any malformed input throws.
 *
 * A container stack distinguishes objects from arrays. For an object we track
 * `expectKey`, driven by `{` (expect key), `:` (expect value), `,` (expect key
 * again). Array elements are always values — crucially we never treat an array
 * string element as a key.
 */
type Frame = { kind: "object"; keys: Set<string>; expectKey: boolean } | { kind: "array" };

function scanTokens(text: string): void {
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  const top = () => stack[stack.length - 1];

  const readString = (): string => {
    // assumes text[i] === '"'
    let s = "";
    i++; // opening quote
    while (i < n) {
      const c = text[i++]!;
      if (c === "\\") s += c + (text[i++] ?? "");
      else if (c === '"') return s;
      else s += c;
    }
    throw new Error("jcs: unterminated string");
  };

  while (i < n) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
      i++;
    } else if (c === "[") {
      stack.push({ kind: "array" });
      i++;
    } else if (c === "}" || c === "]") {
      stack.pop();
      i++;
    } else if (c === ":") {
      const f = top();
      if (f?.kind === "object") f.expectKey = false;
      i++;
    } else if (c === ",") {
      const f = top();
      if (f?.kind === "object") f.expectKey = true;
      i++;
    } else if (c === '"') {
      const f = top();
      const str = readString();
      if (f?.kind === "object" && f.expectKey) {
        if (f.keys.has(str)) throw new Error(`jcs: duplicate key "${str}"`);
        f.keys.add(str);
      }
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const start = i;
      while (i < n && /[0-9eE+.\-]/.test(text[i]!)) i++;
      const tok = text.slice(start, i);
      if (/[.\-eE]/.test(tok)) throw new Error(`jcs: non-integer/negative number not allowed (${tok})`);
      if (!Number.isSafeInteger(Number(tok))) throw new Error(`jcs: unsafe integer not allowed (${tok})`);
    } else if (c === "t" || c === "f" || c === "n") {
      while (i < n && text[i]! >= "a" && text[i]! <= "z") i++;
    } else {
      throw new Error(`jcs: unexpected character ${JSON.stringify(c)} at ${i}`);
    }
  }
}
