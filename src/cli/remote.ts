/**
 * `src/cli/remote.ts` — the public barrel for the rbox control-plane HTTP client.
 *
 * The implementation lives under `src/cli/remote/` split by seam (auth/headers +
 * shared primitives in `context.ts`, typed errors in `errors.ts`, single-PUT/GET in
 * `blobs.ts`, resumable machinery in `multipart.ts`, manifest/commit transport in
 * `commits.ts`, E2EE key + pairing transport in `keys.ts`, and the `RboxApi` facade
 * in `api.ts`). This file re-exports the exact surface importers depend on so no
 * consumer path changes.
 */
export {
  NeedsRebaselineError,
  BlobShaMismatchError,
  AccountAlreadyBootstrappedError,
  QuotaExceededError,
  NetworkError,
} from "./remote/errors.js";
export { isTransientNetworkError, transferTimeoutMs } from "./remote/resilient.js";
export { CommitRejectedError, type CommitOptions, type CommitResult, type CommitTimings, type LatestOptions, type LatestTimings } from "./remote/commits.js";
export { RboxApi, RemoteBlobStore, createRemoteWorkspace, type SyncRemote } from "./remote/api.js";
