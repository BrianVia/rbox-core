# Design 73 - Byte-level transfer progress

**Status:** v2 — adversarial review folded (2 High: attempt-scoped credit double-count, condemned-blob remainder credit; 2 Medium: growing-total pct regression, engine/CLI layering). **Driver:** founder-observed 3x tonight: a push with a multi-GB multipart blob kept `rbox status`/`activity.json` at e.g. `upload 126,352/126,369` for 30-90 minutes while bytes moved on the network.

## 1. Problem

The live progress contract is count-only. `TransferProgress` is `(done,total,phase,detail?)`; its docs say `done/total` are entry/blob/repo counts (`src/cli/transfer-progress.ts:10`, `src/cli/transfer-progress.ts:27`). `encryptAndUpload` advances upload after a whole file settles (`src/cli/sync-recovery.ts:172`, `src/cli/sync-recovery.ts:182`).

A large file uses multipart (`src/cli/remote/blobs.ts:47`, `src/cli/remote/blobs.ts:76`): the server chooses 8 MiB minimum parts (`apps/api/src/blobs.ts:27`, `apps/api/src/blobs.ts:29`) and the client loops parts (`src/cli/remote/multipart.ts:72`, `src/cli/remote/multipart.ts:80`) without surfacing part completion. One huge blob is one file-count tick, so real progress reads as a hang.

## 2. Current integration points

- Push wires git capture and file upload into one progress callback (`src/cli/sync.ts:392`, `src/cli/sync.ts:449`); pull maps apply progress to `"download"` counts (`src/cli/sync.ts:178`, `src/cli/sync.ts:184`); scan uses indeterminate counts (`src/cli/sync.ts:44`, `src/cli/sync.ts:47`).
- Foreground `rbox sync` renders `progressLabel(...)` (`src/cli/sync-cmd.ts:34`, `src/cli/sync-cmd.ts:38`).
- Daemon push/pull pass only count progress into `onTransferProgress` (`src/cli/daemon.ts:448`, `src/cli/daemon.ts:590`).
- `activity.json` stores `active: { at, phase, done, total }` (`src/cli/activity.ts:45`, `src/cli/activity.ts:47`) and `loadActivity` rebuilds that known shape on read (`src/cli/activity.ts:109`, `src/cli/activity.ts:112`).
- `rbox status` renders fresh `active` through `healthLine` (`src/cli/status-view.ts:194`, `src/cli/status-view.ts:199`).
- `shell.line` percent is `floor(done/total*100)` on counts (`src/cli/activity.ts:211`, `src/cli/activity.ts:215`).

## 3. Decision

Add bytes as an optional second channel; keep count fields as compatibility and phase identity:

```ts
type TransferProgress = (
  done: number,
  total: number,
  phase: TransferPhase,
  detail?: string,
  bytes?: { bytesDone: number; bytesTotal: number }
) => void;
```

Render count plus bytes when present, e.g. `uploading 126,352/126,369 · 4.1/6.3 GiB`. Percent is byte-based when a byte channel exists, count-based otherwise.

Persist the same optional fields inside `active`:

```ts
active?: {
  at: string; phase: TransferPhase; done: number; total: number;
  bytesDone?: number; bytesTotal?: number;
};
```

This is backward-compatible. Old daemons omit bytes; new readers render counts only when bytes are absent. Old status binaries ignore extra JSON fields because the current reader reconstructs `active` from known keys only (`src/cli/activity.ts:109`, `src/cli/activity.ts:112`), so they render unchanged. New readers validate byte fields independently: finite non-negative integers, `bytesTotal > 0`; malformed bytes drop only the byte suffix, not the whole `active` slot.

## 4. File upload bytes

For the normal file upload phase, `bytesTotal` is the sum of unique missing ciphertext blob sizes computed at phase start. Use ciphertext size, not `FileEntry.size`, because file entries carry plaintext length (`src/engine/types.ts:13`, `src/engine/types.ts:16`) while encryption returns `cipherSize` (`src/engine/crypto.ts:49`, `src/engine/crypto.ts:53`, `src/engine/crypto.ts:113`, `src/engine/crypto.ts:115`).

`encryptAndUpload` already knows the missing ciphertext addresses (`src/cli/sync-recovery.ts:109`, `src/cli/sync-recovery.ts:110`) and builds `toUpload` from them (`src/cli/sync-recovery.ts:114`, `src/cli/sync-recovery.ts:119`). Add a phase-local byte tracker keyed by `encSha`; convergent duplicates still count as multiple files in `done/total`, but their bytes are counted once. Small streamed PUTs credit their whole size after success (`src/cli/remote/blobs.ts:48`, `src/cli/remote/blobs.ts:70`).

The upload pool runs concurrently at default 64 (`src/cli/sync-recovery.ts:31`, `src/cli/sync-recovery.ts:37`, `src/cli/sync-recovery.ts:174`, `src/cli/sync-recovery.ts:176`), so all byte changes go through one tracker. **Semantics: absolute SET, never additive** (review High 1): the tracker holds per-object absolute completed bytes — `setProgress(key, bytesCompletedForCurrentAttempt)` REPLACES the object's entry; `bytesDone` is the sum over objects. A restarted attempt (fresh uploadId after a token invalidation) reports from 0 and the display regresses honestly; double-credit is impossible by construction. `reviseTotal(key, bytes)` adjusts denominators (§6).

## 5. Multipart bytes

Thread an optional byte callback through `putBlobFile` into `putBlobMultipart` (`src/cli/remote/blobs.ts:47`, `src/cli/remote/multipart.ts:8`). Progress means "bytes no longer remaining for this blob", not necessarily bytes sent by this exact process.

- Resume credits already-completed parts instantly. The client reads `completedParts` from multipart status (`src/cli/remote/multipart.ts:37`, `src/cli/remote/multipart.ts:46`) and already skips them (`src/cli/remote/multipart.ts:72`, `src/cli/remote/multipart.ts:74`).
- Each successful part PUT credits that part's `len` (`src/cli/remote/multipart.ts:75`, `src/cli/remote/multipart.ts:89`).
- Per-attempt absolute reporting (§4) makes `uploadId:partNumber` dedup unnecessary: the multipart loop reports `partsCompleted × partSize` (+ the final part's actual length) for the CURRENT uploadId only. A mid-call attempt restart (token removed, fresh uploadId — the review's High-1 scenario) resets the object's absolute progress to 0 and re-climbs.
- The complete-fails-but-present remainder credit from the draft is DROPPED (review High 2): the receipts-protocol `/blobs/check` ignores `gc_candidates`, so that path could report success/full-credit for a condemned blob. On a failed `complete`, the tracker simply keeps the last absolute value and the existing retry logic runs. (The pre-existing acceptance of present-but-condemned blobs in that resume path is filed as a separate backlog item — it self-heals at commit via the validate-side candidate barrier, costing a wasted cycle, not data.)

## 6. Retry, re-encrypt, and deferral

Totals may change when the upload target changes. `uploadFileWithRetry` can re-encrypt a base-carried or stale ciphertext path and mutate `f.sha256`/`f.encSha` (`src/cli/sync-recovery.ts:132`, `src/cli/sync-recovery.ts:151`). On `BlobShaMismatchError` it drops the stale temp and retries (`src/cli/sync-recovery.ts:158`, `src/cli/sync-recovery.ts:164`).

When re-encryption changes the current missing blob, subtract the old unfinished blob's remaining planned bytes, add the new ciphertext size only if the new `encSha` is still missing and not already uploaded, and never subtract credited bytes for completed parts/blobs. If bounded retry defers the file, remove its unfinished bytes from the current phase total before the phase clears. A moving denominator is honest; a stale denominator is not.

## 7. Git artifact uploads

Git capture uploads large bundles outside the file upload phase. `planGitSections` emits only per-repo `gitcap` counts after capture settles (`src/cli/sync-git.ts:120`, `src/cli/sync-git.ts:124`, `src/cli/sync-git.ts:363`, `src/cli/sync-git.ts:389`). Inside the capture, `captureGitState` encrypts/uploads bundle, index, and op-state artifacts (`src/engine/git/capture.ts:239`, `src/engine/git/capture.ts:252`).

`putGitArtifact` calls `store.putFile` with ciphertext size (`src/engine/git/shared.ts:249`, `src/engine/git/shared.ts:264`), and `BlobStore.putFile` is already the streaming upload hook (`src/engine/blobstore.ts:18`, `src/engine/blobstore.ts:20`). Layering (review Medium 2): the engine gains an ENGINE-LOCAL optional callback — `putFile(..., onBytes?: (absoluteBytesCompleted: number) => void)` — with no knowledge of CLI transfer phases; the CLI orchestration layer adapts it into the `TransferProgress` byte channel. The CLI `TransferPhase` type never crosses into `src/engine/`. Gitcap byte totals grow as artifacts become known: a bundle's size is unknowable until git creates it and rbox encrypts it. Once known, render `capturing git state 2/140 · 4.1/6.3 GiB`.

## 8. Rendering, throttling, and non-goals

`progressLabel` appends bytes when `bytesTotal > 0` (`src/cli/status-view.ts:157`, `src/cli/status-view.ts:168`). Use binary units, matching quota formatting (`src/cli/quota-format.ts:1`, `src/cli/quota-format.ts:16`). `shell.line` uses byte percent when available, falling back to count percent and preserving `-` for indeterminate phases (`src/cli/activity.ts:195`, `src/cli/activity.ts:199`). **Displayed pct is clamped monotonic per phase instance** (review Medium 1: gitcap totals grow as bundles become known — repo B's 900 MiB appearing must not drop a rendered 90% to 9%): the RENDER layer keeps a per-phase high-water mark, reset on phase change; the underlying stored bytes stay honest and un-clamped.

Bytes must not amplify daemon writes. Emit bytes through the existing `onProgress` path and keep the current daemon throttle: phase change, final tick, or at most one write per ~500 ms (`src/cli/daemon.ts:725`, `src/cli/daemon.ts:739`).

Downloads are out of scope. They already have a stalled-stream watchdog (`src/cli/remote/blobs.ts:82`, `src/cli/remote/blobs.ts:89`, `src/cli/remote/resilient.ts:120`, `src/cli/remote/resilient.ts:121`); byte-level download progress can mirror this later.

## 9. §verification

- Unit: `progressLabel` renders count-only, byte-appended, and byte-percent cases.
- Unit: `loadActivity` ignores malformed optional bytes without dropping `active`.
- Unit: `renderShellLine` uses byte percent when present and preserves fallback/`-`.
- Unit: multipart resume credits completed parts instantly and never double-credits a retried part.
- Unit: sha-mismatch re-encrypt revises `bytesTotal` by delta without subtracting completed bytes.
- Integration: one 100+ MiB file shows bytes ticking in foreground `rbox sync` and daemon `activity.json`/`rbox status` while file counts stay flat.
- Integration: a git bundle above multipart threshold shows bytes during `gitcap` before repo count advances.
- Regression: activity write rate remains bounded by the existing daemon throttle.
