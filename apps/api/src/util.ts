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

// Read a request body fully but ABORT past `maxBytes` (counted on raw bytes, not the spoofable
// Content-Length). Returns raw bytes, an empty Uint8Array for an empty body, or null if it exceeds
// the cap.
export async function readBytesCapped(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// Text wrapper over the byte-preserving capped reader above.
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  const bytes = await readBytesCapped(req, maxBytes);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
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
