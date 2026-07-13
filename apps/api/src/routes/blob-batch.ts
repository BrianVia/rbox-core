import type { Principal } from "../authz.js";
import { blobBatchGet, blobBatchPut, type BatchPutAuthFallback } from "../blob-batch.js";
import { blobPackPut } from "../blob-pack.js";
import { eq, type RouteCtx } from "./shared.js";

/** Batched blob transport routes — additive and deliberately outside `/v1/blobs/*`.
 *  `batchPutAuthFallback` is the §109 grant verdict computed pre-auth in worker.ts,
 *  consumed by the bearer-path batch PUT for its auth AE event and echo header. */
export async function blobBatchRoutes({ req, env, seg }: RouteCtx, p: Principal, batchPutAuthFallback?: BatchPutAuthFallback): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "blob-batch", "get"])) return blobBatchGet(req, env, { accountId: p.accountId });
  if (req.method === "POST" && eq(seg, ["v1", "blob-batch", "put"])) return blobBatchPut(req, env, p.accountId, batchPutAuthFallback);
  if (req.method === "POST" && eq(seg, ["v1", "blob-pack", "put"])) return blobPackPut(req, env, p.accountId);
  return null;
}
