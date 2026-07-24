# dl-integrity-retry validation gate evidence

Date: 2026-07-09  
Branch: `dl-integrity-retry`  
Base: `origin/main` / `v0.9.16` (`ead8b7d`)  
Gate command: `bun run gate:dl-integrity`

The command above runs `scripts/dl-integrity-gate.ts`. The controller launches Runs A, B, and C in separate Bun processes because `RBOX_NET_INTEGRITY_RETRIES` is read at module load. It captures each child's raw stdout and stderr in `gate-artifacts/run-a.log`, `gate-artifacts/run-b.log`, and `gate-artifacts/run-c.log`, plus structured counters in `gate-artifacts/summary.json`. The artifact directory is intentionally ignored by Git; this document is the durable merge evidence.

## Fixture and fault model

- Harness: real `pull()` → `applyActions()` → `RemoteBlobStore` → `BlobBatchDownloader` → production `getBlobToFile()`, backed by the existing test `FakeServer` and a gate-only HTTP/fault adapter.
- Files: 10,000 total; 2,000 large (20%) and 8,000 small.
- Large plaintext size: 262,145 bytes (`DEFAULT_BATCH_RECORD_BYTES + 1`). Encrypted GET body: 262,161 bytes. Every large file therefore bypassed the batch endpoint and used the streaming path.
- Large blobs are unique. The 8,000 small entries share one content-addressed blob.
- Download concurrency: production defaults. `RBOX_DOWNLOAD_CONCURRENCY` and all batch-tuning variables were removed from each child environment. This gives the normal 512-task apply supply and 128-wide single-GET gate.
- Percent mode: Mulberry32 seed `7`, `P = 0.02`, evaluated once per large blob in stable manifest order. It selected 42 of 2,000 large blobs. A selected blob's first GET is returned with byte 0 XORed with `0xff`; every later GET is clean.
- Persistent mode: one selected large SHA is byte-flipped on every GET.
- All injected responses preserved length: `bytesReceived = expectedSize = 262161`.
- Routing invariant in every run: 0 large-blob batch violations.

## Run A — negative control

Exact controller child invocation (where `<temp>` is its per-run `mkdtemp` path):

```text
GATE_RUN_ROOT=<temp> GATE_RUN_MODE=A RBOX_NET_INTEGRITY_RETRIES=0 bun scripts/dl-integrity-gate.ts --run A
```

Result: PASS. The join aborted with a `BlobDownloadIntegrityError` in the real pull's cause chain. The seeded set contained 42 faults; fail-fast cancellation observed 8 corrupt responses across 149 large GETs before the controller terminated the isolated child. Recovered count: 0. Duration: 1,115 ms in the child (1,177 ms controller wall time).

Verbatim key output:

```text
[Run A] PASS: join aborted with a same-length download-integrity error
[Run A] download integrity mismatch: wanted 5860999efa44959cfd2b83a5674223b9d7a9ec8e1fd086ce98afb78850221342, got 0fe5b016b6c988a1dabeeef87ad4f68af8904b9bdb5563786a9cc560b4078283 (received 262161 bytes of expected 262161)
```

## Run B — fix

Exact controller child invocation (where `<temp>` is its per-run `mkdtemp` path):

```text
env -u RBOX_NET_INTEGRITY_RETRIES GATE_RUN_ROOT=<temp> GATE_RUN_MODE=B bun scripts/dl-integrity-gate.ts --run B
```

Result: PASS. The join completed. All 42 selected faults fired once, all 42 recovered, and stderr contained exactly 42 `download integrity recovered` lines. There were 2,042 large GETs (2,000 initial + 42 clean re-fetches), 0 unrecovered failures, and 0 large-blob batch violations. The harness then opened and SHA-256 verified all 10,000 final plaintext files against its own manifest. Duration: 9,076 ms in the child (9,115 ms controller wall time).

Verbatim key output (first and last recovery lines shown; raw stderr contains all 42):

```text
rbox: blob 804fe1ed5380… download integrity recovered after 1 retry
rbox: blob 0d9f1f4de8b9… download integrity recovered after 1 retry
[Run B] PASS: join completed and every plaintext file matched the harness manifest
[Run B] verified 10000 files against the harness manifest
```

## Run C — boundary honesty

Exact controller child invocation (where `<temp>` is its per-run `mkdtemp` path):

```text
env -u RBOX_NET_INTEGRITY_RETRIES GATE_RUN_ROOT=<temp> GATE_RUN_MODE=C bun scripts/dl-integrity-gate.ts --run C
```

Result: PASS. One SHA was corrupted on every delivery. The downloader made exactly 5 attempts (initial + the default 4 retries), served 5 same-length corrupt responses, then failed with `BlobDownloadIntegrityError`. The final plaintext destination did not exist, and its directory contained no matching `.rbox-tmp-*`, `.rboxdl-*`, or `.ct` staging remnant. Recovered count: 0. Duration: 5,071 ms in the child (5,112 ms controller wall time).

Verbatim key output:

```text
[Run C] PASS: persistent corruption exhausted retries loudly and left no partial destination
[Run C] download integrity mismatch: wanted 8f982d37f22235d825e9754835d1b1ba72376530e50a3c4f9e1c2afb625bb6a5, got 5858e6a65af75a99fe2d912b07e15283e9438f87a0929b05b356f0d90a42965f (received 262161 bytes of expected 262161)
```

## Repository checks

```text
$ bun test ./src/
924 pass
11 skip
0 fail
3939 expect() calls
Ran 935 tests across 92 files. [173.00s]

$ bun run typecheck
exit 0
```

`json-output.test.ts` did not reproduce its known local failure in this run.

For completeness, I also invoked literal unscoped `bun test`. Bun discovered `apps/api` Cloudflare/Vitest tests and `apps/web` SvelteKit tests in addition to `src`, then attempted to run them with the Bun test runner. The 924-test `src` suite ran, but the command ended with 17 baseline runner-resolution errors such as `Cannot find package 'cloudflare:test'` and unresolved Clerk/Svelte aliases. The repository's configured full Bun command is `bun test ./src/` (`package.json`'s `test` script), which is the green result above. An additional `bun run test:api` attempt could not start Miniflare in this managed sandbox because localhost `listen` and Wrangler's user-level log path were denied with `EPERM`; no API test assertion ran or failed.

## Notes and surprises

- Run A served 8 of the 42 preselected corruptions before the fail-fast pull rejected. This is expected: multiple production-default workers were already in flight, while the controller exits the isolated child immediately after the asserted integrity failure.
- Run C recorded 1,500 total large GETs even though the persistent target used only 5. The apply pool's sibling workers continue while the target spends time in jittered backoff. The gate deliberately asserts only the failed target's destination and staging cleanup, not an unrealistic all-or-nothing tree.
- Recovery backoff uses production jitter, so elapsed durations and recovery-line order can vary. Fault selection, response corruption, counters, and pass/fail assertions are deterministic.
