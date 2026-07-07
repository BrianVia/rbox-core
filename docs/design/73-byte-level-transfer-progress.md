# Design 73 - Byte-level transfer progress

**Status:** v3 — two-review adjudication folded: file-owned byte accounting with success reconciliation, indeterminate-total gitcap bytes, dual-fraction human rendering, and refreshed citations. **Driver:** founder-observed 3x tonight: a push with a multi-GB multipart blob kept `rbox status`/`activity.json` at e.g. `upload 126,352/126,369` for 30-90 minutes while bytes moved on the network.

## 1. Problem

The live progress contract is count-only. `TransferProgress` is `(done,total,phase,detail?)`; its docs say `done/total` are entry/blob/repo counts and `total === 0` means indeterminate (`src/cli/transfer-progress.ts:10`, `src/cli/transfer-progress.ts:27`). `encryptAndUpload` advances upload after a whole file settles (`src/cli/sync-recovery.ts:170`, `src/cli/sync-recovery.ts:182`).

A large file uses multipart (`src/cli/remote/blobs.ts:47`, `src/cli/remote/blobs.ts:76`): the server chooses 8 MiB minimum parts (`apps/api/src/blobs.ts:27`, `apps/api/src/blobs.ts:29`) and returns `partSize`/`totalParts` from init (`apps/api/src/blobs.ts:221`, `apps/api/src/blobs.ts:222`). The client loops parts (`src/cli/remote/multipart.ts:72`, `src/cli/remote/multipart.ts:87`) without surfacing part completion. One huge blob is one file-count tick, so real progress reads as a hang.

## 2. Current integration points

- Push wires git capture and file upload into one progress callback (`src/cli/sync.ts:408`, `src/cli/sync.ts:465`); pull maps apply progress to `"download"` counts (`src/cli/sync.ts:186`, `src/cli/sync.ts:192`); scan uses indeterminate counts (`src/cli/sync.ts:45`, `src/cli/sync.ts:48`).
- Foreground `rbox sync` renders `progressLabel(...)` (`src/cli/sync-cmd.ts:34`, `src/cli/sync-cmd.ts:38`).
- Daemon push/pull pass only count progress into `onTransferProgress` (`src/cli/daemon.ts:446`, `src/cli/daemon.ts:453`, `src/cli/daemon.ts:590`, `src/cli/daemon.ts:595`).
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
  bytes?: { bytesDone: number; bytesTotal?: number }
) => void;
```

`bytesTotal` is present only when the byte denominator is determinate. Human surfaces render count plus bytes with dual fractions and no unified percent: `uploading 126,352/126,369 · 4.1/6.3 GiB`. When byte total is indeterminate, render the cumulative counter as sent bytes: `capturing git state 2/140 · 4.1 GiB sent`. `shell.line` keeps its single scalar grammar: byte percent when a determinate byte total exists, count percent otherwise, and `-` for indeterminate phases.

Persist the same optional fields inside `active`:

```ts
active?: {
  at: string; phase: TransferPhase; done: number; total: number;
  bytesDone?: number; bytesTotal?: number;
};
```

This is backward-compatible. Old daemons omit bytes; new readers render counts only when bytes are absent. Old status binaries ignore extra JSON fields because the current reader reconstructs `active` from known keys only (`src/cli/activity.ts:109`, `src/cli/activity.ts:112`). New readers validate byte fields independently: `bytesDone` is a finite non-negative integer; `bytesTotal`, when present, is a positive integer and must satisfy `bytesDone <= bytesTotal`. Malformed bytes drop only the byte suffix, not the whole `active` slot.

The only design-69 ordering dependency is this activity-schema extension: the `active` byte fields are additive iff design 69 keeps `local` as a sibling activity/status slot (`docs/design/69-status-perf.md:122`, `docs/design/69-status-perf.md:125`, `docs/design/69-status-perf.md:158`, `docs/design/69-status-perf.md:160`). The `TransferProgress` API has no design-69 dependency.

## 4. File upload byte tracker

For the normal file upload phase, `bytesTotal` is the sum of unique missing ciphertext blob sizes computed at phase start. Use ciphertext size, not `FileEntry.size`, because file entries carry plaintext length (`src/engine/types.ts:13`, `src/engine/types.ts:16`) while encryption returns `cipherSize` (`src/engine/crypto.ts:49`, `src/engine/crypto.ts:53`, `src/engine/crypto.ts:113`, `src/engine/crypto.ts:115`).

`encryptAndUpload` already knows the missing ciphertext addresses (`src/cli/sync-recovery.ts:109`, `src/cli/sync-recovery.ts:110`) and builds `toUpload` from them (`src/cli/sync-recovery.ts:114`, `src/cli/sync-recovery.ts:119`). Convergent duplicates still count as multiple files in `done/total`, but their bytes are counted once.

The tracker is phase-local and file-owned:

- `file -> current encSha`
- `encSha -> live refcount`
- `encSha -> planned ciphertext bytes`
- `encSha -> absolute completed bytes`
- one running `bytesDone`, updated as `bytesDone += newAbs - oldAbs` so ticks are O(1), not a re-sum across 126k objects

**Invariant:** `bytesDone <= bytesTotal` at all times. Every mutation — credit, migrate, defer, or reviseTotal — must preserve it.

**Semantics: absolute SET, never additive.** `setProgress(encSha, absoluteBytesCompleted)` replaces that object's absolute entry. A restarted multipart attempt reports from 0 and the display regresses honestly; double-credit is impossible for a single key.

The v3 load-bearing fix is ownership retraction. The absolute-set tracker only prevents same-key double-credit; it does not by itself handle a file moving to a new key. When `uploadFileWithRetry` re-encrypts and mutates `f.sha256`/`f.encSha` (`src/cli/sync-recovery.ts:139`, `src/cli/sync-recovery.ts:150`), migrate the file to the new `encSha`. If the old key's refcount drops to zero, retract its numerator credit with `setProgress(oldEncSha, 0)` and remove its unfinished planned bytes before adding the new key. If the new `encSha` is already uploaded or no longer missing, do not add it to the phase denominator.

Files that vanish during the encrypt stage are deferred before entering the upload byte tracker (`src/cli/sync-recovery.ts:93`, `src/cli/sync-recovery.ts:96`). Files that vanish during upload-stage re-encryption or exhaust bounded retry are dropped from the tracker and their old key is retracted when no other live file references it (`src/cli/sync-recovery.ts:139`, `src/cli/sync-recovery.ts:145`, `src/cli/sync-recovery.ts:176`, `src/cli/sync-recovery.ts:179`).

The upload pool runs concurrently at default 64 (`src/cli/sync-recovery.ts:31`, `src/cli/sync-recovery.ts:37`, `src/cli/sync-recovery.ts:174`, `src/cli/sync-recovery.ts:176`), so all byte changes go through one tracker.

## 5. Upload success and multipart bytes

Thread an optional byte callback through every streaming upload layer: `SyncRemote.putBlobFile` (`src/cli/remote/api.ts:29`), `RboxApi.putBlobFile` (`src/cli/remote/api.ts:55`, `src/cli/remote/api.ts:56`), `RemoteBlobStore.putFile` (`src/cli/remote/api.ts:180`, `src/cli/remote/api.ts:181`), `E2eeApi.putBlobFile` (`src/cli/e2ee-remote.ts:90`), `E2eeRemote.putBlobFile` (`src/cli/e2ee-remote.ts:430`, `src/cli/e2ee-remote.ts:431`), then `putBlobFile` into `putBlobMultipart` (`src/cli/remote/blobs.ts:47`, `src/cli/remote/multipart.ts:8`).

One success rule applies to every success path: `setProgress(encSha, fullCipherSize)`. Absolute-set makes this idempotent after part credits and prevents a phase from ending at 97% bytes with 100% files.

- Small streamed PUTs reconcile to full size after the successful response is accepted (`src/cli/remote/blobs.ts:48`, `src/cli/remote/blobs.ts:70`).
- Multipart resume credits already-completed parts instantly. The client reads `completedParts` from multipart status (`src/cli/remote/multipart.ts:40`, `src/cli/remote/multipart.ts:45`) and skips those parts in the loop (`src/cli/remote/multipart.ts:72`, `src/cli/remote/multipart.ts:74`).
- Resume credit is `Σ` over completed part numbers `n` of `(n < totalParts ? partSize : size - (totalParts - 1) * partSize)`. This is the same part geometry the client uses for upload ranges (`src/cli/remote/multipart.ts:75`, `src/cli/remote/multipart.ts:77`) and avoids double-counting a short final part.
- Each successful part PUT reports the new absolute completed byte count for the current upload id (`src/cli/remote/multipart.ts:80`, `src/cli/remote/multipart.ts:94`). Byte liveness granularity is one part; because the server minimum is 8 MiB, a very slow uplink can still look frozen inside a single part (`apps/api/src/blobs.ts:27`, `apps/api/src/blobs.ts:29`).
- Multipart complete success reconciles to full size (`src/cli/remote/multipart.ts:105`, `src/cli/remote/multipart.ts:122`). The present-shortcut paths also reconcile to full size: the retry catch checks `missingBlobs` before a fresh attempt (`src/cli/remote/multipart.ts:25`, `src/cli/remote/multipart.ts:26`), and the complete error path treats a now-present blob as success (`src/cli/remote/multipart.ts:109`, `src/cli/remote/multipart.ts:115`).

A multipart attempt resets the object's absolute progress to 0 only after the `missingBlobs` check says the blob is still missing (`src/cli/remote/multipart.ts:25`, `src/cli/remote/multipart.ts:26`). If that check says the blob is present, the path is success and reconciles to full size.

The complete-fails-but-present remainder credit from v1/v2 stays dropped. Server missing checks treat condemned candidates as missing (`apps/api/src/blobs.ts:108`, `apps/api/src/blobs.ts:112`), while multipart complete resurrects a canonical blob only after verified publish by deleting its `gc_candidates` row (`apps/api/src/blobs.ts:335`, `apps/api/src/blobs.ts:342`). On an unreconciled failed `complete`, the tracker keeps the last absolute part value and the existing retry path runs; it must not invent full credit.

## 6. Git artifact uploads

Git capture uploads large bundles outside the file upload phase. `planGitSections` emits per-repo `gitcap` counts after capture settles (`src/cli/sync-git.ts:120`, `src/cli/sync-git.ts:124`, `src/cli/sync-git.ts:369`, `src/cli/sync-git.ts:394`). Inside the capture, `captureGitState` encrypts/uploads bundle, index, and op-state artifacts (`src/engine/git/capture.ts:239`, `src/engine/git/capture.ts:252`).

`putGitArtifact` calls `store.putFile` with ciphertext size (`src/engine/git/shared.ts:249`, `src/engine/git/shared.ts:264`), and `BlobStore.putFile` is already the streaming upload hook (`src/engine/blobstore.ts:18`, `src/engine/blobstore.ts:20`). Layering: the engine gains an engine-local optional callback — `putFile(..., onBytes?: (absoluteBytesCompleted: number) => void)` — with no knowledge of CLI transfer phases. The CLI orchestration layer adapts it into the `TransferProgress` byte channel. The CLI `TransferPhase` type never crosses into `src/engine/`.

Gitcap is byte-indeterminate-total. Do not grow a denominator as artifacts become known. The repo count denominator remains the existing `repoCount`; the byte channel reports only cumulative bytes sent for artifacts captured in this phase instance. Render `capturing git state 2/140 · 4.1 GiB sent`, not `4.1/6.3 GiB`, and do not add a gitcap-specific growing-denominator clamp.

## 7. Rendering, throttling, and non-goals

`progressLabel` appends bytes when present and stays pure (`src/cli/status-view.ts:157`, `src/cli/status-view.ts:168`). Human lines render both available fractions and no single percent. `rbox status` is one-shot and renders raw values through `healthLine` (`src/cli/status-view.ts:194`, `src/cli/status-view.ts:199`). The foreground spinner also consumes the pure label (`src/cli/sync-cmd.ts:34`, `src/cli/sync-cmd.ts:38`). Use binary units, matching quota formatting (`src/cli/quota-format.ts:1`, `src/cli/quota-format.ts:16`).

`renderShellLine` also stays pure. Its v1 grammar has one scalar pct token, so it uses byte percent when `bytesTotal > 0`, count percent when only counts are determinate, and `-` otherwise (`src/cli/activity.ts:195`, `src/cli/activity.ts:199`, `src/cli/activity.ts:211`, `src/cli/activity.ts:215`).

There is no high-water display clamp. Foreground spinners, the daemon writer, `progressLabel`, `renderShellLine`, and one-shot `rbox status` render the raw tracker values they receive. Retry restarts, file-migration retractions, defers, and other regressions are honest progress information; jitter-free monotonicity is not a goal. The upload byte tracker's `bytesDone <= bytesTotal` invariant is the only byte-safety guarantee.

Bytes must not amplify daemon writes. Emit bytes through the existing `onProgress` path and keep the daemon throttle raw: phase change, determinate final tick, same-phase raw regression/restart, or at most one write per ~500 ms (`src/cli/daemon.ts:823`, `src/cli/daemon.ts:844`).

Downloads are out of scope. They already have a stalled-stream watchdog (`src/cli/remote/blobs.ts:82`, `src/cli/remote/blobs.ts:89`, `src/cli/remote/resilient.ts:120`, `src/cli/remote/resilient.ts:121`); byte-level download progress can mirror this later.

## 8. Verification

- Unit: `progressLabel` renders count-only, determinate byte dual-fraction, and indeterminate byte-sent cases with no unified human percent.
- Unit: `loadActivity` accepts valid optional bytes and ignores malformed optional bytes without dropping `active`.
- Unit: `renderShellLine` uses byte percent only with determinate `bytesTotal`, falls back to count percent, and preserves `-`.
- Unit: the upload byte tracker preserves `bytesDone <= bytesTotal` across credit, migrate, defer, and reviseTotal.
- Unit: file encSha migration and upload-stage defer retract old numerator credit when no live file still references the old key.
- Unit: every success path reconciles to full size: small PUT, multipart complete, multipart present-shortcut, and complete-present recovery.
- Unit: multipart resume credits completed parts with the final-part formula and never double-credits a retried part.
- Unit: sha-mismatch re-encrypt revises byte ownership/total without subtracting completed bytes still owned by another live file.
- Unit: engine `onBytes` wrappers thread through `BlobStore`, `RemoteBlobStore`, `SyncRemote`, and `E2eeRemote` without importing CLI phases into `src/engine/`.
- Integration: one 100+ MiB file shows bytes ticking in foreground `rbox sync` and daemon `activity.json`/`rbox status` while file counts stay flat.
- Integration: a git bundle above multipart threshold shows `gitcap` bytes as `GiB sent` before repo count advances, with no byte denominator.
- Regression: activity write rate remains bounded by the existing daemon throttle.
