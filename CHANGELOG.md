# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

## [0.9.1] — 2026-07-06 — status honesty + capture fixes

### Changed
- **`rbox status` never lies about liveness.** A fresh active cycle leads with
  its live percentage; a standing failure renders in amber beneath it as
  "last attempt failed … — will be retried"; "sync halted" (red) is gone —
  a live daemon always retries. "git-sync: 0 repos synced" during a first
  publish now reports capture progress instead of implying idleness.

### Fixed
- **Case-drifted symbolic HEAD no longer permanently defers a repo's git
  capture** (macOS case-insensitive checkouts: HEAD casing vs packed-refs
  casing). Capture normalizes to the ref store's casing; self-validation
  failures now report the real reason instead of "capture returned nothing."


## [0.9.0] — 2026-07-06 — worktree git-sync, live progress, network resilience, fast status

Born from a founder stress test: a first push over a 140-repo, 131k-file
workspace, run as a real customer would.

### Added
- **Git-state sync for main clones with linked worktrees (design 68).**
  Primary repos using `git worktree` (agent workflows, Conductor) now capture
  index/HEAD/stash via `--single-worktree --all`; applies defer whole-section
  when a ref collides with a branch checked out in a sibling worktree; in-tree
  scratch worktrees no longer re-upload the shared history once per worktree.
- **Live progress for the long sync phases.** First pushes show
  `scanning… N files` and `capturing git state 3/140 — <repo>`; the daemon
  feeds the same progress to `rbox status` and the zsh prompt glyph.
- **Network resilience on the sync path.** Transient socket faults retry with
  bounded backoff (commit POSTs proven idempotent via the server's sequence
  CAS); stalled transfers time out (no-progress watchdog on downloads,
  size-scaled caps on uploads); network errors now say what dropped and that
  re-running is safe — raw runtime errors never reach the terminal.
- **Resumable, hardened git-capture uploads.** Capture stages under the
  workspace's `.rbox/` (immune to tmp reapers), sha-mismatch faults re-encrypt
  and retry like file blobs, GB-scale bundle uploads resume across attempts,
  and stale staging sweeps are pid-aware (a live capture is never swept).

### Changed
- **`rbox status` is ~11× faster on repo-heavy trees (design 69).** 90s → ~8s
  warm on the stress-test workspace: status finally uses the on-disk hash
  cache, discovers repos during the one scan walk, pools the git probes, and
  skips unchanged repos entirely via a stat-only gitdir fingerprint cache
  (zero git subprocesses for a quiet repo).
- **Onboarding prompts tightened.** Workspace naming is one prompt (ENTER
  accepts the suggestion, `-` skips); background-sync + autostart is one
  three-way select; first-push spinners explain the scan phase.

### Fixed
- A transient network fault no longer discards an entire initial push.
- The 6GB-bundle capture failure mode (ciphertext truncated in `os.tmpdir()`
  during long multipart uploads) is closed.

## [0.8.0] — 2026-07-04 — launch-readiness batch (designs 60-67)

### Added
- **Self-serve genesis (design 60).** Cold accounts created via web signup or
  device-code `rbox login` mint their first encryption keys with
  `rbox key genesis`; `rbox setup` runs it inline on the first machine.
- **Daemon autostart (design 61).** `rbox autostart enable|disable|status`
  registers a per-user login agent that restarts background sync after reboot or
  re-login.
- **`rbox usage` + quota UX (design 62).** A dedicated command for plan limits vs
  current usage; typed `402 quota_exceeded` errors name the cap and next step.
- **Data export (design 65).** `rbox export` decrypts every workspace under your
  keys and writes a directory or `.tar.gz`.

### Changed
- **Team checkout disabled (design 63).** Team is listed but not purchasable
  across the CLI, web, and pricing surfaces;
  the server rejects Team checkout intent before any Stripe call.

### Security
- **Abuse hardening (design 64).** Rate limits on the anonymous edge
  (device-code start/poll, release, link/pair) plus a per-account durable-device
  cap.

## [0.7.1] — status probe elision
- `rbox status` elides the remote-head probe when the local daemon is live and
  attributable to the current workspace (design 59); JSON status fetches account
  usage separately.

## [0.7.0] — doctor, diagnostics, recovery kit
- `rbox doctor` + opt-in plaintext support-report upload (design 56).
- Recovery kit: `--kit` / `--kit-path` write the 24-word phrase to a `0600` file,
  tracked by `rbox key status` (design 58).
- Setup picker UX polish; dev-gated bootstrap `--plan`.

## [0.6.8] — destructive-apply safety
- Local trash tier (`rbox trash list|restore|empty`), type-flip healing, and a
  push-side mass-delete guard (design 50).

## [0.6.7] — rbox.yml revival + usage guide
- Scoped `rbox.yml` design revival and the narrative usage guide; the `deps` CLI
  group disabled/commented out (design 51).

## [0.6.6] — daemon IO priority
- Daemon disk-IO priority + idle safety-scan backoff (design 49).

## [0.6.5] — browser-optional login
- Browser-optional device-code login (design 47).

## [0.6.4] — zsh integration
- zsh shell integration: ambient sync status in the prompt + completions
  (design 46).

## [0.6.3] — status health
- Status health verdict, daemon activity sidecar, and live transfer percentages
  (design 45).

## [0.6.2] — rebind safety
- Rebind safety: stream-ownership stamp + mass-delete guard, closing the
  design-44 mass-delete incident.

## [0.6.1] — maintainability pass
- Behavior-preserving module splits across the engine, CLI, and API (antislop
  refactor pass).

## [0.6.0] — nested-repo git sync
- Nested-repo git sync: per-repo GitSections, worktree materialization, all E2EE
  (design 43).
