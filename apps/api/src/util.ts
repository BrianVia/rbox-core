/** Shared control-plane helpers (consolidated from per-file copies). */

/** A lowercase-hex SHA-256 (32 bytes) — every content address / blob ref. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
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
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
