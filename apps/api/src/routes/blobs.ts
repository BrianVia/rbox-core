import { badRequest, eq, type RouteCtx } from "./shared.js";
import { SHA256_HEX_RE as SHA_RE } from "../util.js";
import { blobGet, blobPut, blobsCheck, multipartComplete, multipartInit, multipartPart, multipartStatus } from "../blobs.js";
import type { Principal } from "../authz.js";

/**
 * Blob routes — all entitlement-gated by p.accountId. `blobs/check` MUST precede
 * the `blobs/:sha` block: "check" is not a valid sha, so the :sha matcher would
 * throw badRequest("invalid sha256") for it (a load-bearing precedence).
 */
export async function blobsRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  // POST /v1/blobs/check — entitlement-scoped to the caller's account.
  if (req.method === "POST" && eq(seg, ["v1", "blobs", "check"])) return blobsCheck(req, env, p.accountId);

  // /v1/blobs/:sha[...] — all entitlement-gated by p.accountId.
  if (seg[0] === "v1" && seg[1] === "blobs" && seg.length >= 3) {
    const sha = seg[2]!;
    if (!SHA_RE.test(sha)) throw badRequest("invalid sha256");
    if (seg.length === 3) {
      if (req.method === "PUT") return blobPut(req, env, sha, p.accountId);
      // §27 — an optional download grant (from `latest()`) lets blobGet skip the per-blob
      // D1 entitlement read. Absent/invalid → blobGet falls back to the D1 path.
      if (req.method === "GET") return blobGet(env, sha, p.accountId, req.headers.get("x-rbox-download-grant") ?? undefined);
    }
    if (seg[3] === "multipart") {
      const uploadId = seg[4];
      if (seg.length === 4 && req.method === "POST") return multipartInit(req, env, sha, p.accountId);
      if (seg.length === 5 && uploadId && req.method === "GET") return multipartStatus(env, sha, uploadId, p.accountId);
      if (seg.length === 7 && uploadId && seg[5] === "part" && req.method === "PUT") return multipartPart(req, env, sha, uploadId, Number(seg[6]), p.accountId);
      if (seg.length === 6 && uploadId && seg[5] === "complete" && req.method === "POST") return multipartComplete(env, sha, uploadId, p.accountId);
    }
  }
  return null;
}
