import { SHA256_HEX_RE as SHA_RE } from "./util.js";

/**
 * The opaque signed-commit envelope + its wire-level parsing, factored out of the
 * WorkspaceSync DO (workspace-sync.ts). Everything here is PURE (no DO/storage
 * state): the envelope/body types, the request-body caps, the capped body reader,
 * and the §24 ref-mode discriminator. The DO orchestrates; this module just reads
 * the wire. The server NEVER verifies the signature — clients verify from genesis.
 */

// Opaque body cap. With §24 the body is O(1) for large repos (the refs live in an R2
// sidecar, only its {sidecarSha,count,totalBytes} descriptor is inline). Small repos still
// inline blobRefs ({encSha,size} ≈ 85B each); 1MB covers ~12k inline refs + fits D1's ~2MB
// row limit. The §24 client switches to the sidecar before bodies approach this cap.
export const MAX_COMMIT_BODY = 1024 * 1024; // 1MB
// §30: hard ceiling on the request body, enforced by ACTUAL bytes read before JSON.parse
// (readBodyCapped) so a hostile/huge receipts map can't OOM the isolate (codex r3/r4 MAJOR).
// Sized to keep the JSON.parse HEAP safe, not just the wire bytes: a pathological 8MB body
// (millions of tiny keys) expands to only ~40-60MB of JS objects — well within the 128MB
// isolate — whereas 32MB could threaten it. This is a SECOND axis from MAX_REFS_PER_COMMIT
// (which bounds ref COUNT): a COLD push's receipt map (~375B/ref) must also fit here, so 8MB
// covers the validated 12k (~4MB) with headroom; a cold push much past ~20k refs is bounded by
// this and stays behind the same dev measurement as the 50k count ceiling. Incremental pushes
// (few NEW receipts) reach MAX_REFS_PER_COMMIT freely — their body is small.
export const MAX_REQUEST_BODY = 8 * 1024 * 1024; // 8MB — parse-heap-safe

export const MAX_COMMIT_SPAN = 5000; // commits?since span cap → over this, client re-baselines
export const MAX_MISSING_SHAS_RESPONSE = 10_000;

export function unsatisfiedBlobsBody(missing: string[]): { error: "unsatisfied_blobs"; missing: string[]; missingTotal: number } {
  return {
    error: "unsatisfied_blobs",
    missing: missing.slice(0, MAX_MISSING_SHAS_RESPONSE),
    missingTotal: missing.length,
  };
}

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

/** The opaque signed commit envelope the server stores verbatim (design 12, v4).
 *  The server reads a FEW fields out of `body` for validation but NEVER verifies
 *  the signature — clients verify from genesis. */
export interface SignedCommit {
  body: string; // canonical JSON of the commitBody (opaque)
  commitHash: string; // hex
  sig: string; // b64url Ed25519 (opaque)
}
/** The minimal slice of commitBody the server inspects. Everything else is opaque. */
export interface CommitBodyView {
  type?: unknown;
  seq?: unknown;
  parentSeq?: unknown;
  accountEpoch?: unknown;
  encManifestSha?: unknown;
  deviceId?: unknown;
  blobRefs?: unknown;
  blobRefset?: unknown; // §24 sidecar descriptor {sidecarSha,count,totalBytes}
}

/** §24 strict discriminator: a commit body carries EXACTLY ONE ref carrier — inline
 *  `blobRefs` (array) XOR a `blobRefset` descriptor (object). Returns the validated mode,
 *  or null if both/neither/wrong-type (→ caller rejects before accounting/head-advance).
 *  Note: the body was JSON.parse'd; a duplicate JSON key would have collapsed, but the
 *  client signs the canonical form and every honest reader runs the engine `parseCommit`
 *  (verifyRoundTrip) — the server's accounting never trusts a key the signature didn't cover
 *  because it re-derives the ref set from the receipt-authenticated sidecar bytes, not the body. */
export type RefMode = { kind: "inline"; refShas: string[] } | { kind: "sidecar"; sidecarSha: string; count: number; totalBytes: number };

export function readRefMode(cb: CommitBodyView): RefMode | null {
  const hasInline = Array.isArray(cb.blobRefs);
  const rs = cb.blobRefset;
  const hasSidecar = !!rs && typeof rs === "object" && !Array.isArray(rs);
  if (hasInline === hasSidecar) return null; // both or neither
  if (hasInline) {
    // NB: the > MAX_REFS_PER_COMMIT rejection lives in the commit handler (structured 413
    // too_many_refs), NOT here — returning null here would mask it as a generic 400 (codex r3
    // MINOR). Inline bodies are already bounded by MAX_COMMIT_BODY, so this array stays small.
    const refs = cb.blobRefs as Array<{ encSha?: unknown }>;
    const refShas: string[] = [];
    for (const r of refs) {
      if (!r || typeof r.encSha !== "string" || !SHA_RE.test(r.encSha)) return null;
      refShas.push(r.encSha);
    }
    return { kind: "inline", refShas };
  }
  const d = rs as { sidecarSha?: unknown; count?: unknown; totalBytes?: unknown };
  if (typeof d.sidecarSha !== "string" || !SHA_RE.test(d.sidecarSha)) return null;
  if (!Number.isSafeInteger(d.count) || (d.count as number) < 0) return null; // > MAX → structured 413 in the handler, not a null/400 here
  if (!Number.isSafeInteger(d.totalBytes) || (d.totalBytes as number) < 0) return null;
  return { kind: "sidecar", sidecarSha: d.sidecarSha, count: d.count as number, totalBytes: d.totalBytes as number };
}
