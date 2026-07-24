/** Shared control-plane helpers (consolidated from per-file copies). */

/** A lowercase-hex SHA-256 (32 bytes) — every content address / blob ref. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Stable error class for privacy-safe logging — never the raw message/stack. */
export const errClass = (e: unknown): string => (e instanceof Error ? e.name : typeof e);

/** Structured, metadata-safe error log. The ONLY way to log an error on a path that
 *  touches user metadata (workspace/project/commit/body/device binds): name the event
 *  + its error class, never the raw message/stack (privacy ban-list, design §5). */
/** Split into runs of at most n — the SQLite bound-variable safety idiom for `IN (?,?,…)`. */
export const chunked = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export type CappedReadResult =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "overflow"; bytesCounted: number }
  | { kind: "error"; bytesCounted: number; error: unknown };

/** A normalized finite decimal Content-Length claim, or null when absent/invalid. */
export function contentLengthClaim(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// Read a request body fully but ABORT past `maxBytes` (counted on raw bytes, not the spoofable
// Content-Length). A declared oversize is rejected without reading the stream. On streaming
// overflow, at most the cap plus the just-observed runtime chunk has been retained/observed.
export async function readBytesCapped(req: Request, maxBytes: number): Promise<CappedReadResult> {
  const claimed = contentLengthClaim(req);
  if (claimed !== null && claimed > maxBytes) {
    await req.body?.cancel().catch(() => {});
    return { kind: "overflow", bytesCounted: 0 };
  }
  if (!req.body) return { kind: "ok", bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { kind: "overflow", bytesCounted: total };
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    return { kind: "error", bytesCounted: total, error };
  }
  if (chunks.length === 0) return { kind: "ok", bytes: new Uint8Array(0) };
  if (chunks.length === 1) return { kind: "ok", bytes: chunks[0]! };
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { kind: "ok", bytes: out };
}

// Text wrapper over the byte-preserving capped reader above.
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const result = await readBytesCapped(req, maxBytes);
  if (result.kind === "overflow") return null;
  if (result.kind === "error") throw result.error;
  return new TextDecoder().decode(result.bytes);
}

export type CappedJsonResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/** Bounded, fatal-UTF-8 JSON parsing. Route-specific shape policy stays in `validate`. */
export async function cappedJson<T>(
  req: Request,
  limits: { maxBytes: number },
  validate: (value: unknown) => T | null,
): Promise<CappedJsonResult<T>> {
  const result = await readBytesCapped(req, limits.maxBytes);
  if (result.kind === "overflow") return { ok: false, response: json({ error: "body_too_large" }, 413) };
  if (result.kind === "error") throw result.error;
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(result.bytes);
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: json({ error: "bad_request_shape" }, 400) };
  }
  const parsed = validate(value);
  return parsed === null
    ? { ok: false, response: json({ error: "bad_request_shape" }, 400) }
    : { ok: true, value: parsed };
}

/** JSON-object exactness helper for route validators. */
export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function objectWithKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
}

export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

export function isWellFormed(value: string): boolean {
  const method = (String.prototype as unknown as { isWellFormed?: (this: string) => boolean }).isWellFormed;
  if (method) return method.call(value);
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Truncate well-formed text without cutting a UTF-8 sequence or surrogate pair. */
export function truncateUtf8(value: string, maxBytes: number): string {
  let used = 0;
  let out = "";
  for (const codePoint of value) {
    const width = utf8Bytes(codePoint);
    if (used + width > maxBytes) break;
    out += codePoint;
    used += width;
  }
  return out;
}

export function truncateCodePoints(value: string, max: number): string {
  return [...value].slice(0, max).join("");
}

export function logErr(event: string, e: unknown): void {
  console.error(JSON.stringify({ event, errorClass: errClass(e) }));
}

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

export function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
}

export const packKey = (packId: string): string => `packs/v1/${packId}`;

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function manifestKey(sha: string): string {
  return `manifests/sha256/${sha.slice(0, 2)}/${sha}`;
}

/** Constant-time string compare (lengths leak, contents don't). */
export function ctEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let r = 0;
  for (let i = 0; i < ea.length; i++) r |= ea[i]! ^ eb[i]!;
  return r === 0;
}

/** Match the raw platform-auth header without weakening missing-secret handling. */
export function platformSecretMatches(
  headerValue: string | null,
  env: { RBOX_PLATFORM_SECRET?: string },
): boolean {
  return !!env.RBOX_PLATFORM_SECRET && ctEqual(headerValue ?? "", env.RBOX_PLATFORM_SECRET);
}

/** Lowercase-hex SHA-256 of a string (UTF-8) or raw bytes. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** Lowercase-hex HMAC-SHA256(key, message). */
export async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
