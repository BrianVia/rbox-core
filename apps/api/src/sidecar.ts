// §24.3 — resolve a commit's blobRef sidecar (refs moved OUT of the signed body).
// DIRECT-WRITE reality (post-§23): the client PUTs the sidecar to its CANONICAL R2 key
// (blobKey(sidecarSha)) + mints a receipt like any blob — there is NO staging/promote.
// At commit the server resolves the bytes here, then `sidecarSha` flows through
// validateCommitRefs + commitAccounting exactly like a data ref (charged from its
// server-measured R2 size, granted, present=1) so the published head's sidecar is durable.
//
// Allocation is bounded by the R2 object's REPORTED size vs the expected length
// (18 + 40·count) BEFORE buffering — a hostile count never drives an allocation.

import type { Env } from "./env.js";
import { blobKey, sha256Hex } from "./util.js";
import { verifyReceipt } from "./receipts.js";
import { parseRefset, parseRefsetShaSet, refsetByteLength } from "../../../src/engine/refset.js";

/** The §24 sidecar descriptor as it appears in the signed commit body. (Defined locally so
 *  the Worker shares only the dependency-free refset codec with the engine, not its crypto graph.) */
export interface SidecarDescriptor {
  sidecarSha: string;
  count: number;
  totalBytes: number;
}

export type SidecarResult =
  | { ok: true; refShas: string[] }
  | { ok: false; needsUpload: string[] } // sidecar not entitled/uploaded yet → 422
  | { ok: false; badSidecar: string }; // present but corrupt/mismatched/unparseable → 400

export type LoadSidecarResult = { ok: true; refs: ReturnType<typeof parseRefset> } | { ok: false; reason: string };

/**
 * Fetch + strictly validate the sidecar OBJECT (no entitlement/descriptor logic — that's the
 * caller's). Allocation is bounded by the R2-reported size matching the expected length
 * (18 + 40·count, which also pins parsed count == count) BEFORE buffering; then hash-verify +
 * strict parse. Shared by the commit resolver and GC `roots()` so the two never drift.
 */
export async function loadSidecarRefs(env: Env, sidecarSha: string, count: number): Promise<LoadSidecarResult> {
  const obj = await env.rbox_dev_blobs.get(blobKey(sidecarSha));
  if (!obj) return { ok: false, reason: "missing" };
  if (obj.size !== refsetByteLength(count)) return { ok: false, reason: `size ${obj.size} != expected ${refsetByteLength(count)}` };
  const buf = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(buf)) !== sidecarSha) return { ok: false, reason: "sha256 mismatch" };
  try {
    return { ok: true, refs: parseRefset(buf) }; // strict: magic, exact length, sorted, no dup, safe sizes
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "parse failed" };
  }
}

export async function loadSidecarShaSet(env: Env, sidecarSha: string, count: number): Promise<{ ok: true; refs: Set<string> } | { ok: false; reason: string }> {
  const obj = await env.rbox_dev_blobs.get(blobKey(sidecarSha));
  if (!obj) return { ok: false, reason: "missing" };
  if (obj.size !== refsetByteLength(count)) return { ok: false, reason: `size ${obj.size} != expected ${refsetByteLength(count)}` };
  const buf = new Uint8Array(await obj.arrayBuffer());
  if ((await sha256Hex(buf)) !== sidecarSha) return { ok: false, reason: "sha256 mismatch" };
  try {
    return { ok: true, refs: parseRefsetShaSet(buf) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "parse failed" };
  }
}

/**
 * Resolve + strictly validate a sidecar, returning its data-ref shas (NOT including
 * sidecarSha itself — the caller adds that to the accounting set). Fails CLOSED:
 * - sidecar neither entitled+present NOR backed by a valid receipt → needsUpload (anti
 *   cross-account read: we never GET an object the account can't already prove it owns);
 * - R2 object missing → needsUpload;
 * - size/hash/encoding/descriptor mismatch → badSidecar (the signed body committed to
 *   sidecarSha + count + totalBytes; any disagreement is fatal, never silently coerced).
 */
export async function resolveSidecarBytes(
  env: Env,
  db: D1Database,
  accountId: string,
  descriptor: SidecarDescriptor,
  receipts: Record<string, string>,
  nowMs: number,
): Promise<SidecarResult> {
  const { sidecarSha, count, totalBytes } = descriptor;

  // Entitlement gate BEFORE the R2 GET. Receipt first (no D1); else entitled+present (1 read).
  let allowed = false;
  const r = receipts[sidecarSha];
  if (r) {
    const v = await verifyReceipt(env, r, { accountId, encSha: sidecarSha, nowMs });
    if (v.ok) allowed = true;
  }
  if (!allowed) {
    const row = await db
      .prepare("SELECT 1 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256 WHERE r.account_id = ? AND b.present = 1 AND r.sha256 = ?")
      .bind(accountId, sidecarSha)
      .first<{ 1: number }>();
    if (row) allowed = true;
  }
  if (!allowed) return { ok: false, needsUpload: [sidecarSha] };

  // A receipt/entitlement proves the account uploaded the sidecar, but R2 could still lag a
  // just-uploaded object → treat a missing object as needsUpload; bytes that exist but don't
  // match the signed descriptor are a hard badSidecar (the size gate also pins count == count).
  const loaded = await loadSidecarRefs(env, sidecarSha, count);
  if (!loaded.ok) {
    if (loaded.reason === "missing") return { ok: false, needsUpload: [sidecarSha] };
    return { ok: false, badSidecar: loaded.reason };
  }
  // Descriptor's totalBytes MUST match the canonical bytes (advisory fields gate, never bill).
  let sum = 0;
  for (const x of loaded.refs) sum += x.size;
  if (sum !== totalBytes) return { ok: false, badSidecar: `sidecar totalBytes ${sum} != descriptor ${totalBytes}` };

  return { ok: true, refShas: loaded.refs.map((x) => x.encSha) };
}
