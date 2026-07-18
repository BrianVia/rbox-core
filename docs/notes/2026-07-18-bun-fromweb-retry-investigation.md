# Investigation: Bun 1.3.14 `Readable.fromWeb` + blob-download retry

## Verdict

**BUN-DEFECT, verified and narrowly scoped.** Bun 1.3.14's
`node:stream.Readable.fromWeb` does not propagate errors from a constructed Web
`ReadableStream`. It leaks two unhandled rejections and leaves the Node readable
pending. This is a standalone Bun/Node divergence and is the exact reason the
rbox retry test fails after the pipeline rewrite.

This is **not** evidence for the earlier broad claim that real Bun fetch response
bodies lose or hang on `ECONNRESET`. The three previously recorded real-fetch
probes remained negative. The rbox test harness exposes a real adapter defect
through a valid constructed `ReadableStream`; production uses a different,
native fetch-body implementation.

## Environment and controlled rewrite

- Bun: `1.3.14` (`0d9b296a`)
- Node control: `v24.18.0`
- Starting/restored `src/cli/remote/blobs.ts` SHA-256:
  `dbaa069b3ff85119c576e04d78c09ad6e6b4664a6f95f8145114f53e59cb2474`
- Temporary change: only the manual `getReader()`/write pump in
  `downloadToFileOnce` was replaced with
  `pipeline(Readable.fromWeb(res.body), hashingTransform,
  fs.createWriteStream(destPath))`.
- The transform rearmed the same idle timer per chunk, counted `byteLength`,
  updated the same SHA-256 hash, and forwarded the original chunk.
- The outer integrity loop, `retryTransient`, fresh per-attempt write stream,
  composite download signal, custom idle `TimeoutError`, cleanup, and hash
  verification remained in place.

One correction to the original investigation request: `fetchWithDeadline` is
not called by `downloadToFileOnce` in this tree. The function directly calls
`fetch` with `AbortSignal.any([idleController.signal,
AbortSignal.timeout(blobDownloadTimeoutMs(...))])`. That actual wiring was held
fixed.

## Exact failing test

Command:

```sh
bun test src/cli/remote-network-resilience.test.ts
```

Failure:

```text
error: The socket connection was closed unexpectedly. ...
 code: "ECONNRESET"
    at socketClosed (.../remote-network-resilience.test.ts:15:21)
    at pull (.../remote-network-resilience.test.ts:74:26)
    at _read (internal:webstreams_adapters:56:42)
    at <anonymous> (internal:streams/readable:345:17)
    at resume_ (internal:streams/readable:582:16)
(fail) streaming blob GET — retry starts from a clean destination file >
  a partial failed attempt is truncated/recreated before the successful retry

10 pass
1 fail
```

The error was printed twice and the test failed in about 5 ms. The exact helper
returns `new Response(new ReadableStream({ pull }))`; the first pull enqueues
partial bytes and the second calls `controller.error(ECONNRESET)`.

The wider focused run was:

```sh
bun test src/cli/remote/resilient.test.ts \
  src/cli/remote-network-resilience.test.ts \
  src/cli/remote/blob-batch/blob-batch.test.ts
```

It produced 67 passes and the same single rewrite-related failure. A separate
existing live-socket test could not bind inside this sandbox and failed for that
environmental reason. Every blob-batch test passed.

After restoring the manual pump, the exact file returned to:

```text
11 pass
0 fail
```

## Failure chain

1. The mock Web body delivers a partial chunk, then transitions to errored with
   the transient `ECONNRESET` object.
2. The manual `reader.read()` promise rejects inside `downloadToFileOnce`'s
   `try/catch`. Cleanup runs, the error is rethrown, and `retryTransient`
   classifies its code and starts attempt two with a fresh output stream.
3. Bun's `Readable.fromWeb` adapter does not convert that Web reader rejection
   into a Node readable `error`. Two rejections escape at process level and the
   Node readable remains neither ended nor errored.
4. Consequently `pipeline` remains pending. `retryTransient` is never called
   with an error, so its classifier and the error's name/code are not the
   problem. The hashing transform, chunk boundaries, destination stream, and
   idle timer have no opportunity to change that outcome.
5. `bun:test` observes the escaped rejections and fails the test immediately.

The test's `RBOX_NET_RETRIES="2"` assignment occurs after static imports, so it
does not re-evaluate the imported default. That test-harness issue is unrelated:
the default is already two retries, and attempt one never settles under the
defective adapter.

## Standalone reduction

Repro:
`docs/notes/bun-1.3.14-fromweb-controller-error-repro.mjs`

```sh
bun docs/notes/bun-1.3.14-fromweb-controller-error-repro.mjs
```

Output (exit 1, intentional defect signal):

```text
runtime Bun 1.3.14
getReader caught:ECONNRESET
fromWeb+pipeline HUNG-after-100ms
escaped unhandledRejection:ECONNRESET,unhandledRejection:ECONNRESET
```

Node control:

```sh
node docs/notes/bun-1.3.14-fromweb-controller-error-repro.mjs
```

```text
runtime Node v24.18.0
getReader caught:ECONNRESET
fromWeb+pipeline rejected:ECONNRESET
escaped none
```

Replacing `pipeline` with async iteration over `Readable.fromWeb(body)` produced
the same Bun hang and escaped errors, while Node caught `ECONNRESET`. That
isolates the faulty API to `Readable.fromWeb`, not `pipeline`. An independent
audit also reproduced the failure for synchronous and microtask
`controller.error`, thrown/rejected `pull`, `start` errors, and first-pull
errors. It is not a chunk-timing artifact.

## Scope and migration decision

The earlier real-fetch probes recorded on this same Bun version found:

1. A real HTTP mid-stream socket destroy rejected as `ECONNRESET` through both
   the manual reader and `Readable.fromWeb`/`pipeline`.
2. A real stalled HTTP body aborted with the custom `TimeoutError` preserved
   that name through both consumers.
3. Five aborted real-fetch adapter runs leaked no unhandled rejection.

Those probes could not be rerun in this worktree because the sandbox denies TCP
and Unix-domain `listen`; the attempted bind returned `EADDRINUSE`/`EPERM`.
Therefore the proven upstream issue must be filed as **constructed Web-stream
error propagation**, not as fetch-body `ECONNRESET` propagation.

A bridge-free production migration is plausible because rbox consumes real Bun
fetch bodies, not arbitrary constructed Web streams. It is not yet cleared to
ship. The migration gate must replace the synthetic retry fixture with a real
local HTTP server and run the full rewritten `RboxApi.getBlobToFile` path:

- attempt one sends partial bytes with a larger `Content-Length`, then destroys
  the socket; attempt two returns the complete blob;
- assert two GETs, prompt first-attempt settlement, partial-file removal/fresh
  truncation, correct final bytes/hash, and no process-level leaks;
- separately stall attempt one until the real idle watchdog aborts it with the
  custom `TimeoutError`, then assert attempt two succeeds with the same cleanup
  guarantees.

Until those production-shaped gates pass outside this sandbox, retain the
manual pump. A `pipeTo(TransformStream)` compatibility bridge is only warranted
if rbox must support arbitrary constructed Web streams; it should not be added
solely to accommodate this test harness.

## Filed & decision

**Filed upstream: oven-sh/bun#34559** (https://github.com/oven-sh/bun/issues/34559).

**Decision (2026-07-18, founder-deferred to orchestrator): HOLD the migration.**
The bug is in `fromWeb`'s handling of ANY errored `ReadableStream`, and a
reset native fetch body IS an errored `ReadableStream`, so the production
interrupted-download path very plausibly hits the same hang — the controlled
retry-harness test failed, and the downside (a blob download that silently
hangs and never retries, on the sync path) far outweighs deleting ~15 lines.
Keep the working `getReader()` pump. REAPPLY the
`pipeline(Readable.fromWeb(res.body), <hashing/idle-watchdog Transform>,
createWriteStream)` migration only after (a) Bun#34559 is fixed AND (b) a real
local-HTTP integration test proves an actual interrupted download retries
cleanly (partial-drop → retry → complete, hash-correct, zero leaked rejections).
No separate branch is kept: the change is a trivial ~15-line redo guided by
this doc and audit item 2. Watch #34559.

## Upstream filing summary

Suggested title:

> Bun 1.3.14 `Readable.fromWeb` hangs and leaks rejections when a constructed
> `ReadableStream` errors

Expected: the Node readable emits/rejects with the original `ECONNRESET`, so
`pipeline` or async iteration settles. Actual: two unhandled rejections escape
and the adapter remains pending. The minimal repro above is self-terminating and
shows the Node 24 control behavior.
