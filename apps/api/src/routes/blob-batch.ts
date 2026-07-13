import type { Principal } from "../authz.js";
import { blobBatchGet, blobBatchPut } from "../blob-batch.js";
import { eq, type RouteCtx } from "./shared.js";

/** Batched blob transport routes — additive and deliberately outside `/v1/blobs/*`. */
export async function blobBatchRoutes({ req, env, seg, batchPutAuthFallback }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "blob-batch", "get"])) return blobBatchGet(req, env, { accountId: p.accountId });
  if (req.method === "POST" && eq(seg, ["v1", "blob-batch", "put"])) return blobBatchPut(req, env, p.accountId, batchPutAuthFallback);
  return null;
}
