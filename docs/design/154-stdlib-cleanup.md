# 154 — Behavior-preserving stdlib cleanup

Status: **REVIEW v4**

Source: the 2026-07-17 complexity audit follow-up. Scope is closed: only the
six substitutions below and their direct tests/imports may change. No module
ownership changes are involved, so `docs/CODEMAP.md` is unchanged.

## Invariants

- Existing success values, friendly error messages, retry classifications,
  file cleanup, producer ordering, and shutdown/early-wakeup behavior remain
  unchanged.
- `bun run typecheck` passes. `bun test src/cli` passes except the acknowledged
  pre-existing `same-SHA size mismatch commits a metadata heal` failure.
- Changes remain uncommitted.

## Substitutions

1. In `account-cmd.ts`, `status-cmd.ts` (two helpers), and `doctor-cmd.ts`, pass
   `AbortSignal.timeout(timeoutMs)` directly to `fetch`. Preserve each outer
   catch boundary: account/status continue collapsing timeout, abort, network,
   malformed-body, and non-OK outcomes exactly as today; doctor continues its
   friendly per-check mapping.
2. In `remote/blobs.ts`, use `pipeline(Readable.fromWeb(res.body), transform,
   fs.createWriteStream(destPath))`. The transform rearms the idle watchdog,
   counts bytes, updates SHA-256, and forwards every chunk unchanged. Keep hash
   verification after the pipeline and remove `destPath` on every pipeline/hash
   failure. Pass the composite signal to `pipeline` as well: Bun 1.3.14 can hang
   when `Readable.fromWeb` receives a Web-stream `TimeoutError` without that
   explicit cancellation. If pipeline rejects with `AbortError` while this signal
   is aborted specifically with a `TimeoutError`, rethrow that reason so retry
   classification remains transient; never replace a write/transform error.
   Disarm idle immediately when pipeline settles, before hashing. Verify with an
   actual Bun `fetch` response body from a large `blob:` URL (not a constructed
   Web stream): abort the composite signal during a backpressured pipeline and
   assert prompt settlement plus restored transient `TimeoutError` identity.

   Bun 1.3.14 also fails to deliver constructed body-level network errors from
   `Readable.fromWeb` to Node (the existing partial-`ECONNRESET` regression test
   hangs and leaks an uncaught error). Use a standard Web-stream compatibility
   bridge: `res.body.pipeTo(identityTransform.writable, { preventAbort: true })`
   feeds `Readable.fromWeb(identityTransform.readable)`. A body-pipe rejection
   aborts the Node pipeline and its original error is rethrown for retry
   classification. A pipeline/write failure aborts the Web pipe; it must never
   be replaced by that cleanup abort. This bridge moves no chunks in user code;
   Node `pipeline` still owns backpressure, output completion, destruction, and
   the hashing/progress transform.
3. In `daemon/daemon.ts`, replace the resolver/timer sleep with
   `node:timers/promises.setTimeout(delayMs, undefined, { signal })`. Swallow only
   `AbortError`. Store a controller for early reprobe/shutdown and clear it in
   `finally` only when it is still the same controller, preventing an older
   waiter from clearing a newer one. Remove the resolver/timer fields entirely;
   both early-reprobe and shutdown wake paths abort the stored controller.
4. In `remote/blob-batch/packer.ts`, make the shared write helper await one
   `FileHandle.writeFile(bytes)` call, then update position and hash. Header,
   member chunks, directory, and footer all continue through that helper.
5. In `status-cmd.ts`, implement the Git repo feed with an object-mode
   `PassThrough`. `push` calls `write` and deliberately ignores its return value;
   `close` calls `end`; consumption uses `iterator({ destroyOnReturn: false })`.
   Retain a closed flag so pushes after close are ignored and close is idempotent.
6. In `doctor-cmd.ts`, call `loadRawState(root)` and classify its boundary
   errors into the existing friendly invalid-JSON/read-failure results. Only a
   `ResetCorruptionError` explicitly reporting malformed JSON or parser nesting
   maps to "not valid JSON" only when its message names `.rbox/state.json`;
   unsafe/oversize/I/O and every incarnation-marker error map to "could not
   read". Preserve no-state success and stream mismatch wording.
   Because `loadRawState` may recover from the incarnation marker when
   `state.json` is absent, doctor validates the returned raw state's stream. Its
   existing loader semantics for valid falsy JSON (treated as absent) are
   accepted as part of reusing the canonical loader rather than re-parsing.

## Verification

- Add or adjust focused tests only where needed to pin adapter settlement/error
  identity, post-close feed behavior, conditional daemon-controller cleanup,
  and doctor boundary mapping.
- Run the directly affected test files first, then `bun run typecheck`, then
  `bun test src/cli`; inspect the final diff for closed scope.
