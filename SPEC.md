# SPEC — gitcap upload hardening (backlog item, 2026-07-06 stress-test finding)

## Objective

Make git-state capture uploads survive the failure that killed the 6GB
zen-browser-desktop capture: the ciphertext temp lived in `os.tmpdir()` across
the entire hash→multipart-upload window, got truncated externally, the server
correctly rejected the sha mismatch, and the git path — unlike file blobs —
had no retry, so one transient fault permanently deferred the repo's cycle.

Three changes, in one PR:

## 1. Stage git captures under the repo's `.rbox`, not `os.tmpdir()`

- `src/engine/git/capture.ts:48` (approx): `fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcap-"))`
  → stage under the workspace root's `.rbox/` (a `gitcap/` scratch subdir),
  mirroring the apply side, which already refuses `os.tmpdir()` for exactly
  this hazard class — see the comment at `src/engine/git/apply.ts:146-148`
  and copy its rationale style.
- `captureGitState(repoDir, store, kek)` doesn't currently know the workspace
  root — thread a staging-dir (or root) parameter from the caller
  (`src/cli/sync-git.ts` capture pool) the same way other deps thread.
  Same-mount matters: keep any rename/move semantics cheap (the apply side's
  comment explains why).
- The encrypt temp (`.ct`) must also land in that staging dir — check
  `src/engine/crypto.ts` `encryptFileToTemp` (or equivalent) for where the
  ciphertext temp goes and route it via the same dir parameter if it
  currently defaults to tmpdir.
- Cleanup semantics unchanged: same strictly-awaited `finally` removal
  (`capture.ts:122-125`). Add: on CLI startup or capture start, sweep stale
  `.rbox/gitcap/` leftovers from crashed prior runs (bounded: only rm dirs
  older than, say, 24h — do not race a concurrent daemon's live staging).
- `.rbox/` is already excluded from sync (verify — the manifest scan must
  never pick up staging bytes; if exclusion is pattern-based confirm
  `gitcap/` is covered, else add it).

## 2. Sha-mismatch retry parity with file blobs

- File blobs already do this: on `BlobShaMismatchError`, drop the stale temp,
  re-encrypt a fresh snapshot, back off, retry — `src/cli/sync-recovery.ts:134-141`
  (`PER_FILE_UPLOAD_ATTEMPTS`).
- The git path has NO catch between `putGitArtifact` (`src/engine/git/shared.ts:141`)
  and the per-repo deferral (`src/cli/sync-git.ts:321-323`). Add a bounded
  re-encrypt-and-retry (reuse the file path's attempt count/backoff constants,
  don't mint new ones) around the git artifact upload. The retry must
  re-encrypt from the plaintext bundle — which means the plaintext `.bundle`
  must survive until upload succeeds (today the `.snap` copy is deleted
  pre-upload at `crypto.ts:110` — the retry source is the `.bundle` in the
  staging dir, still present until the `finally`; verify and use it).
- On final failure: exactly today's behavior (deferOne with the error).

## 3. Resumable git multipart

- `src/cli/remote/api.ts:178` (approx): the git `putFile` path calls
  `putBlobFile(sha256, srcPath, size)` with no `uploadsDir` — file blobs pass
  one so `putBlobMultipart` can resume (`src/cli/remote/multipart.ts:19-21`).
  Pass the staging dir (or the same uploads-state dir file blobs use — read
  how file blobs choose it and be consistent).

## Constraints

- Do NOT touch: preflight.ts refusal logic, apply-side semantics, sync-git
  capture-set planning (a worktree-support change just landed there —
  rebase your base onto current origin/main first and build on it).
- No new config/flags. No behavior change for the success path beyond file
  locations.
- NOTE: if `src/engine/git/capture.ts` or `sync-git.ts` conflict with the
  freshly-merged worktree-gitsync changes, integrate on top of them — they
  are the newer truth.

## Acceptance criteria (must go green, run from worktree root)

- `bun run typecheck`
- `bun run test`  (known pre-existing failures NOT yours: 4 in
  shell-init/completions tests, one status --json environmental, an
  occasional watcher timeout flake — everything else green)
- New tests:
  - staging dir is under `<root>/.rbox/` and never `os.tmpdir()` (assert path)
  - a first-attempt `BlobShaMismatchError` on a git artifact → re-encrypt +
    retry succeeds; attempts bounded; final failure still defers with reason
  - stale-staging sweep removes only old dirs
  - staged bytes never appear in the scan manifest
