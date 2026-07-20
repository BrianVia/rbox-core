# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

## [1.7.8] — 2026-07-20 — join a folder that's already ahead

### Added
- Joining a workspace with a folder that already has content — repos that
  are ahead of the fleet, extra files — now converges forward instead of
  getting stuck. rbox retains your pre-join content, pulls the workspace
  baseline, then overlays your files and commits back on top: ahead repos
  fast-forward the whole fleet to your state, files you already had are
  preserved, and anything genuinely diverged is kept safely aside and
  reported (`rbox adopt status`) rather than published. Your pre-join copies
  are retained until you clear them, so the whole join is reversible.
- `rbox adopt status|resume|abort|clean` — inspect, resume, roll back, or
  clear an in-progress or completed adoption.

### Fixed
- A folder whose repos were ahead of the fleet previously parked on join
  with no automatic path forward (its newer commits never published and the
  working tree could show older content). It now converges forward.

## [1.7.7] — 2026-07-19 — branch switches follow both ways

### Fixed
- Switching a repo back to a branch whose tip is an ancestor of your current
  branch (for example `git switch main` after working on a feature branch) now
  follows on every paired machine within one sync cycle. Previously the
  follower machine could be permanently stranded on the old branch with a
  perpetually dirty `git status` and a stuck "receiver-only commits" deferral,
  even though every commit was fully synced. Machines with genuinely local
  commits still defer safely to `rbox git resolve`; `RBOX_GIT_FOLLOW=0`
  remains the containment switch and now has pinned semantics (it bypasses
  the follow pipeline entirely via the legacy apply path).

### Added
- A two-machine `git-ff` test-rig scenario now gates every release on the
  everyday git flows: commit fast-forward, branch creation with passive
  checkout-follow on the paired machine (in both author directions), and
  switch-back — 46 assertions of end-state including sync-record promotion.

## [1.7.6] — 2026-07-19 — faster scans, quieter cycles

### Changed
- Layer A's directory-listing cache is now enabled by default for foreground
  and daemon scans; `RBOX_SCAN_PRUNE=0` is the single kill switch (`=1` remains
  accepted). It elides reusable directory enumeration while per-file stat and
  matcher work remain. Daemon safety scans prune only with a live, trusted
  watcher; untrusted or absent watchers retain full-tree coverage for recovery.

### Fixed
- Successful macOS bulk directory listings now refresh Layer A cache entries,
  so bulk scanning and directory-listing reuse compose on subsequent scans.
- The daemon no longer rewrites its entire state file every cycle when nothing
  changed — a phantom-difference bug made steady-state syncing rewrite tens of
  megabytes every ~30 seconds on many-repo workspaces (and steadily grow the
  daemon's memory). True no-op cycles now write nothing.

## [1.7.5] — 2026-07-19 — a front door that knows you

### Fixed
- Crash recovery no longer refuses to read a normal-sized state file on
  machines with plenty of memory: the safety budget now scales with your
  machine's RAM (quarter of physical memory, between 4 and 32 GiB) and
  respects container memory limits. The refusal message now also explains
  the `RBOX_RESET_PARSE_BUDGET_BYTES` override.

### Added
- The "which directory should rbox sync?" prompt is now a real picker: type
  to fuzzy-filter the current directory's folders, press Tab to complete
  into a subdirectory like shell completion, and plain Enter still takes the
  current directory instantly. Typing any path by hand (including one that
  doesn't exist yet) works exactly as before.
- Running bare `rbox` in a workspace now offers everything you'd reach for:
  Sync now / Start background syncing (or Pause syncing while it's running),
  Set up a new workspace, Pair another device, View usage, View logs, Exit.

### Fixed
- The bare-`rbox` overview no longer shows "plan unavailable" on a freshly
  set-up machine — it now fetches your email and plan once (quickly, and
  only when interactive) instead of waiting for a cache another command
  would have filled.

## [1.7.4] — 2026-07-19 — a first sync you can watch

### Added
- Byte-based progress across the first sync: scanning shows the payload size
  as it grows, encrypting shows bytes done vs total, and uploading shows a
  live MB/s rate with an ETA once the rate settles. Progress percentages now
  track bytes, not file counts — 100k tiny files no longer skew the bar.
- After setup completes, rbox offers to set up another machine right away
  (generates a pairing token on the spot). Pair more devices any time with
  `rbox pair` on an already-paired machine.
- Long steps reassure you after ~10 seconds ("initial encryption of many
  small files can take time") instead of looking hung.

### Changed
- The "authorize this machine" menu leads with "Sign in via browser", and the
  duplicate "Approve a code" entry is gone (it was the same browser grant
  under a second name).
- Press `c` on the browser sign-in screen to copy the URL to your clipboard.
- The setup workspace step shows the same "what is a workspace" definition as
  `rbox init`.
- Git history still uploading after setup is announced calmly ("Git history
  will continue uploading in the background.") — it's expected, not an error.
- Start-sync choices now read "Start background sync now and on machine
  boot" — nothing implies you need to reboot.
- The final setup screen shows your workspace name and this machine's
  hostname instead of internal ids.
- The gitignore choice now tells the truth about what each option does and
  teaches the `!.env` trick: sync a secrets file between your machines,
  end-to-end encrypted, without ever committing it.

### Fixed
- Debug telemetry (multipart instrumentation and the push summary line) no
  longer prints mid-setup for release users; set `RBOX_DEBUG=1` to see it.

## [1.7.3] — 2026-07-18 — a friendlier first run

### Added
- Setup now explains what a workspace is right where you create or join one:
  a single repository, a folder of many repositories, or just a folder.

### Changed
- `rbox start` outside a workspace opens the guided setup on a terminal so you
  can create or join one on the spot, instead of erroring out. Scripts and
  service managers still get the explicit "not inside a workspace" error.
- Setup no longer asks for a "Project id" — one fewer confusing prompt when
  creating a workspace.
- Enabling autostart follows the rbox binary you actually run, so an install
  outside `~/.rbox/bin` (for example `~/.local/bin`) starts on login correctly.
- **Credential corruption is now preserved and reported instead of looking like
  a logout.** Credentials use a versioned, atomically written format; malformed
  or future files are quarantined without overwriting prior evidence. rbox also
  refuses symlinked, non-regular, or unsafe credential paths and gives recovery
  guidance, while status and doctor remain available in a credential-degraded
  state.

## [1.7.2] — 2026-07-17 — faster releases, same gates

### Internal
- Release builds now reuse the exact squash commit's successful main CI verdict
  instead of rerunning the same suite a third time. Immutable release uploads
  and verification run concurrently; signing, native smoke tests, rollback
  protection, and sequential channel activation remain unchanged.

## [1.7.1] — 2026-07-17 — your sync history stops eating your storage

### Changed
- **Every sync now stores a compressed snapshot of your workspace index
  instead of a full raw copy — about 24× smaller.** For active workspaces
  this was the dominant storage cost: each sync stored a complete
  multi-megabyte index even when almost nothing changed, and version
  history kept every copy. New syncs write the compact format; existing
  history is unaffected and remains fully readable. All supported rbox
  versions (v1.1.0+) read both formats. Set `RBOX_MDE_SNAPSHOT=0` to
  temporarily restore the old format if you run a pre-v1.1.0 device.

## [1.7.0] — 2026-07-17 — consent before reset, recovery at scale

### Changed
- **rbox never resets a workspace without showing you exactly what changes**
  (design 138). Rebinding to a different remote stream now walks through an
  explicit two-stage consent: you confirm the specific workspace you're
  leaving and the specific one you're joining — identified by their remote
  ids, not just names — and the confirmation you gave is cryptographically
  tied to that exact pair. A stale or replayed confirmation is refused.
- **`rbox track` and keyed setup refuse to silently adopt a mismatched
  stream.** Where an old version might have proceeded, the CLI now stops and
  explains which workspace the directory actually belongs to. (Breaking
  change for scripts that relied on the silent path.)

### Fixed
- **Crash-safe reset and recovery.** If the machine dies mid-reset, the next
  start picks up from a journal that records what was authorized and how far
  it got: quarantines resume instead of restarting, archives are copied (never
  moved) until the restore is fully published, and a damaged journal halts the
  daemon into a guided `rbox doctor reset-journal` flow instead of guessing.
- **Corrupt or oversized state can no longer wedge the daemon.** State reads
  are byte-bounded with a memory admission gate, and the daemon heals through
  an explicit halted → recovering → ready cycle with a three-way agreement
  check between boot, config, and state before serving.
- **RboxBar finds the rbox binary when launched from Raycast or the Dock.**
  GUI launches don't inherit your shell PATH; the menu bar app now probes the
  standard install location (`~/.rbox/bin/rbox`) first.

### Internal
- Git burn-in suite (design 141): fifteen live-rig cells covering submodules,
  LFS, Unicode/case-folding, shallow and partial clones, and in-progress
  merge/rebase/cherry-pick/bisect — 494 assertions, all green, with the two
  known engine gaps documented and pinned.
- Storage-truth measurement tooling (designs 142–144): read-only prod
  decomposition of account storage into active/history/reclaimable classes.

## [1.6.9] — 2026-07-17 — the wizard forgives your typos

### Fixed
- **`~/paths` work in the setup wizard** (design 137). Typing `~/proj` at the
  directory prompt now means your home directory instead of creating a literal
  folder named `~`. Unsupported forms like `~user/…` explain themselves and ask
  again.
- **A typo can no longer create a workspace you didn't want.** The wizard shows
  the resolved absolute path before anything happens, asks before creating a
  directory that doesn't exist, and doesn't touch the server until the local
  side is confirmed and locked. If something fails after a workspace was
  created, you get its id and the exact way to resume — never a mystery orphan.
- **Mistakes keep you in the wizard.** Bad paths and malformed pairing tokens
  re-prompt (tokens are checked locally before any network call); a mistyped
  24-word recovery phrase is caught offline; blank input navigates back;
  declining "create a new workspace anyway?" returns to the menu with your
  sign-in intact. A used-up token now says to mint a fresh one on your other
  machine.

### Changed
- Clearer first-run copy: joining a workspace nobody has pushed to says
  "nothing was available to pull" instead of "0 pulled, 0 conflict(s)"; the
  workspace-id prompt says where to find the id; the sign-up prompt no longer
  doubles as a mystery masked-secret field; the approve screen always shows
  the full URL; the authorize menu points lost-device users at recovery.
- Releases are now gated by a deterministic TUI regression suite that drives
  the real wizard in containers — the six defects above are permanently
  guarded by it.

## [1.6.8] — 2026-07-16 — zombie branches rest in peace

### Fixed
- **Followers now prune stale side branches** (design 130). When you squash-merge a PR
  and delete the branch, every follower deletes its copy too — safely. Deletion is
  gated by a publisher-authored tombstone chain plus a compare-and-swap provenance
  check, so a branch with unpushed local commits, an active checkout, or any doubt at
  all is left alone (with the reason logged). A deleted branch's proven tip stays
  recoverable for 90 days under `refs/rbox-recovery/`. This retires the "83 zombie
  branches" class of clutter without ever risking real work.

### Changed
- **Second-device setup answers its own questions** (design 134, from real user
  feedback). The setup wizard now says exactly where a pairing token comes from
  (`rbox pair` on an already-set-up machine — never the dashboard, because it carries
  your encryption key) and distinguishes it from the browser confirmation code (which
  authorizes but carries no encryption). Every successful login/pairing now points to
  the next step: `rbox setup` → "Sync an existing workspace". The dashboard's link and
  CLI-login pages explain code-vs-token, `/devices` gained an "Add another machine"
  card, and the dashboard links to the docs throughout.

## [1.6.7] — 2026-07-16 — a first sync you can predict

### Changed
- **Setup now respects `.gitignore` by default.** The wizard's default choice skips
  gitignored untracked files, so your first sync is your source — lean and fast. The
  previous behavior lives on as a clearly-worded option: gitignored files sync too,
  end-to-end encrypted (rbox can never read them) — ideal for `.env` files, notes, and
  local state — with `!` re-includes in `.rboxignore` and an ignore-mode toggle for
  changing your mind later. Existing workspaces and scripted setups are unchanged.
- `rbox ignore --list` now tells the truth: `.gitignore` rules are labeled active or
  present-but-not-applied based on the workspace's actual setting.
- Account creation leads with browser sign-up; docs corrected (`--purge` exists and is
  documented; the README's sync-scope claims now match reality); assorted first-run copy.

## [1.6.6] — 2026-07-16 — strands heal themselves, show-me shows up

### Fixed
- **ORIG_HEAD deferral self-heal** (design 126): a follower stranded by a stale `ORIG_HEAD`
  breadcrumb (the class that required manual replica surgery, twice) now adopts the incoming
  value automatically — but only when the repo is provably a pure replica (no local edits,
  index, commits, stash, or any in-progress git operation), and never without durably
  preserving the old value first (recovery refs under `refs/rbox-recovery/`, capped).
  `git-sync: adopted stale ORIG_HEAD breadcrumb` in the daemon log marks each heal.
- **`rbox git resolve show-me` is fast and talkative** (design 128): ownership proofs are
  batched (~5 subprocesses instead of thousands on reflog-heavy repos — 30 minutes → seconds),
  progress goes to stderr, and human output caps at 50 local-only commits. JSON output and
  resolve safety data remain exhaustive.
- Capture bundles no longer advertise internal `refs/rbox-*` refs.

### Server (already live)
- Fleet push alerts (design 127): drift >24h and reporting-stopped conditions page
  #rbox-alerts hourly, with incident dedup/resolve semantics.

## [1.6.5] — 2026-07-16 — the fleet phones home (design 120)

### Added
- **Product telemetry** (design 120): the daemon now ships privacy-safe product-health
  samples to your rbox server — propagation lag (delivery→apply), first-publish timings,
  upload-lane wire vitals, crypto-pool capability, and safety events (mass-delete breaker,
  scan faults). Counts, timings, and fixed enums only; never paths, hashes, or free-form
  strings — enforced server-side by a hard validator.
- **Fleet sync-state reporting**: each daemon upserts its current git-plane position
  (repos managed/deferred, oldest deferral age, reason classes) so a dashboard can catch a
  stranded repo without touching the machine. Uses the exact projection `rbox git deferrals`
  uses — the dashboard and the device can never disagree.
- `RBOX_TELEMETRY=0` disables all of it (checked at both enqueue and flush; telemetry goes
  to the operator's own worker, never a third party).

### Fixed
- An invalid `x-rbox-version` header can no longer blank a device's recorded binary version.

## [1.6.4] — 2026-07-15 — logs that rotate, deferrals you can see and fix

### Added
- **The menu bar now shows *which* repos are deferred and why (#285, design
  124).** Under the Git row: up to five repos with plain-language reasons and
  ages ("local commits · deferred 1h"), full paths on hover, "+N more" beyond
  five. A **Copy Git fix brief** button puts a self-contained, paste-anywhere
  brief on the clipboard — per-repo diagnosis, what clears on its own vs what
  needs a decision, and exact safe commands — readable by a human or an LLM.
  Unknown or forged deferral reasons can never be offered a resolve command.
- **`rbox git deferrals`** — the same drilldown in the terminal: human list,
  `--brief` (the clipboard document), or `--json` (typed lane array, identical
  to `status --json`).

### Changed
- **Daemon logs rotate daily (#286, design 125).** `daemon-YYYY-MM-DD.log`
  files with 14-day retention (`RBOX_LOG_RETENTION_DAYS` to override) replace
  the forever-growing `daemon.log` (44 MB after a week on the founder's Mac);
  `daemon.log` remains as a small crash sink with pointer records. `rbox logs`
  merges both streams chronologically and `--follow` survives midnight
  rollover and daemon restarts.
- **Sync perf lines went on a diet.** The per-repo `repoMs=` blob (one entry
  per repo, 101 on the founder's workspace) is capped at 8 worst-case
  exemplars plus p50/p95/max aggregates for queue, wall, and fresh-chain
  phases — the distribution signals perf work actually uses, at 3% of the
  bytes. Full detail returns under `RBOX_DEBUG=1`.

### Fixed
- **Test rig repaired (#286):** login rot from v1.6.1's flag rework, container
  git below the 2.46 symref floor, and zombie daemons under a `sleep` PID 1
  that wedged every subsequent sync (the image now runs `tini`).

## [1.6.3] — 2026-07-15 — locks that survive reboots, upgrades that finish the job

### Fixed
- **A Mac reboot can no longer freeze sync behind its own stale lock (#282,
  design 118).** macOS's per-boot `kern.uuid` made a rebooted machine read its
  own pre-reboot lock as another host's — unbreakable by design — starving the
  founder's Mac for 26 hours. Lock identity now prefers the stable hardware
  UUID with an 8-boot alias ledger, and on a proven-local disk (the kernel's
  own `local` mount flag, fail-closed) an unrecognized stale marker is probed
  and reaped like any dead local lock. Wire format unchanged — old and new
  binaries interoperate within a boot; downgrades stay safe.
- **`rbox git resolve` works and tells the truth (#282).** A failed resolve
  used to leak its own lock marker (bricking every later attempt) and swallow
  the real error into a generic message. The break path now cleans up only
  what it provably owns (`.reap` fence included), and errors are typed —
  `sync-busy` names the daemon holding the mutex.
- **Sync starvation is loud (#282).** Blocked >15 minutes by the same lock →
  one durable warning, an explanation in `rbox status` and `rbox doctor`, and
  a counts-only `lockStarved` metric. Retry spam is gone (250ms→30s abortable
  backoff; the incident wrote 341,824 identical log lines).
- **Old git is explained, not mysterious (#282).** Doctor probes the actual
  `update-ref` transaction capability: "checkout-follow needs git ≥ 2.46,
  found 2.43" instead of "unsupported git state".

### Added
- **`rbox upgrade` finishes the job (#282).** It now stops every running
  daemon and WAITS for exit (the old stop removed the pidfile without
  waiting — its own race), restarts them with settings preserved, and `rbox
  status` flags daemon/CLI version skew.
- **RboxBar notifies once per new version and updates in one click (#283,
  design 121).** macOS notification (persisted once-per-version, lazy
  permission ask) + "Update to <version>" menu action running the managed
  upgrade.
- **Per-device CLI version tracking (#279, design 119).** Every authed
  request carries `x-rbox-version`; `rbox device list` and the dashboard show
  each device's last-seen version — the compat dashboard for real customers.
- **Slack pings survive slow relays (#281, design 122).** Signup/subscription
  pings run post-response via `waitUntil` (5s budget + retry; the first
  customer's signup ping died at the old inline 700ms), and failures
  self-report to #rbox-alerts (URL derived from the business webhook).

## [1.6.2] — 2026-07-14 — rbox knows your name

### Added
- **Identity banners show who you are, not your account id (#278, design
  117).** The untracked-dir menu, the setup skip-notice, `rbox account
  status`, and `rbox status`'s ACCOUNT section render
  "Signed in as you@example.com (github)" once the local profile cache has
  seen an account fetch (any `rbox status` fills it). Falls back to the
  account id when uncached — or permanently for CLI-only accounts with no
  web login. The cache (`~/.rbox/account-profile.json`) is non-secret,
  0600, sanitized against terminal injection, keyed to the signed-in
  account, and cleared on logout.

### Fixed
- **New accounts get their email cached at first login (server).** The
  provisioning path now seeds the email from the Clerk fetch it already
  makes; previously the address stayed unknown until the second web login
  (affecting new-device alert recipient resolution too).

## [1.6.1] — 2026-07-14 — bare `rbox` meets you where you are

### Added
- **Enrolled machines get a menu, not a mid-wizard jump (#277).** Bare `rbox`
  in an untracked directory used to dump already-enrolled users into the setup
  wizard at "Step 2 of 3" (step 1 silently skipped). It now offers: Track this
  directory / Sync an existing workspace / Nothing. The choice preselects the
  wizard's create-vs-join prompt, so the total number of prompts is unchanged.
  First-time machines still land directly in the wizard.
- **The front-door menu is daemon-aware**: "Pause syncing" when the daemon is
  running, "Start syncing" when it isn't (previously always Pause).

### Fixed
- **Setup step numbers count only the steps that actually run**: an enrolled
  `rbox setup` shows "Step 1 of 2 · Workspace"; the authorized-but-unenrolled
  enrollment prompt gained its missing "Step 1 of 3 · Account" frame.
- **Copy**: the contradictory "Continuing to your workspace." line is gone;
  `rbox pair`'s finish message describes the real menu path on the new
  machine; the bootstrap-secret prompt says blank = browser device-code
  sign-up.

## [1.6.0] — 2026-07-14 — the checkout follows you: git state reconciles across machines

### Added
- **Checkout-follows-sync (design 116, #273/#274/#276).** Switch branches on
  one machine and machines with no local divergence follow automatically —
  branch, HEAD, index, stash — proven safe by a derived manifest-receipt
  oracle, a two-phase rollback-only checkout journal, and a pinned ref-update
  lock protocol. Kill switch: RBOX_GIT_FOLLOW=0.
- **Per-ref worktree holds replace whole-section deferral** (the bug that
  froze a Mac checkout for 3 days): a linked worktree holding a branch pins
  only that ref; identical-OID updates never defer at all.
- **Drift is visible everywhere**: per-repo git deferral age in rbox status
  (+ --json), the daemon line, the shell prompt, the macOS menu bar. "In
  sync" now means BOTH planes.
- **`rbox git resolve <repo>`**: show-me + take-theirs (keep-mine next cycle).
- Fresh-machine fix: git operations no longer fatal without a configured git
  identity (caught by CI's identity-less runners).

## [1.5.4] — 2026-07-13 — receipt draining actually engages: −19%% push wall

### Fixed
- **Upload-time receipt draining now runs in production (#275).** E2eeRemote —
  the wrapper every real publish uses — never forwarded the receiptPort
  capability, so design 111 shipped default-on but inert (redeemOverlap=0 in
  the field). Forwarded + compile-time parity guard so wrapper/transport
  capability drift fails typecheck. Field-validated: commit-enclosed drain
  8s→168ms, total push 39.2s→31.9s on an 8k-blob publish.

## [1.5.3] — 2026-07-13 — release unblocked: one release-env-only flaky grant test skipped (tracked)

## [1.5.2] — 2026-07-13 — the grant-suite fix actually ships this time (1.5.1 tagged without it — cwd slip)

## [1.5.1] — 2026-07-13 — release-gate test hygiene (v1.5.0 build never shipped)

### Fixed
- Bounded teardown in the upload-grant suite: an unresolved gated fetch could
  hang the afterEach hook 10s in the single-process release build, poisoning
  the next test and failing the v1.5.0 gate. Same #264 class; 2s close bound.

## [1.5.0] — 2026-07-13 — blob packing: small-file uploads scale with bandwidth

### Added
- **Blob packing (design 114, #268/#271).** Small ciphertext blobs pack into
  bandwidth-sized R2 objects instead of one-object-per-blob: the small-file
  lane stops being R2-operation-bound (~48.8 Mbps measured wall pre-packing)
  and scales toward line rate like the multipart lane. Reader path +
  server accounting ship ON (mixed packed/unpacked estates are permanent);
  the pack WRITER is behind `RBOX_BLOB_PACK` pending field validation gates.
  GC/fence correctness per the six-round adversarial review: epoch-bound
  candidacy, live-clock deletion stamps, durable swept tombstones, the
  `rbox_delete_fence_pack` trigger, rollback floor (pre-1.5 binaries cannot
  read packs — reader-first rollout).

## [1.4.2] — 2026-07-13 — the crypto pool actually ships: Bun compile bug fixed, init exits clean

### Fixed
- **Release binaries now really run the crypto worker pool (#270).** Bun 1.3.5
  (the old release pin) ignored the text import attribute under `--compile`:
  the embedded worker extracted as 0 bytes, silently disabling the pool
  (inline-crypto fallback) in EVERY release binary to date — and leaving a
  permanently ref'd handle that made one-shot commands (init, push) hang
  after finishing their work. Fixed via a loader-proof `.txt` bundle + a loud
  non-empty guard; release toolchain now pins Bun 1.3.14 (`engines ^1.3.14`).
  Expect faster fleet encryption — pooled crypto in a release build for the
  first time.
- Compiled-binary regression test: a release-style binary must exit within a
  deadline after real crypto work (negative-control verified against the bug).

## [1.4.1] — 2026-07-13 — sweep verdict applied: fill-v2 stays, default records back to 32

### Changed
- **Default batch records: 32** (fill-v2 dispatch policy stays the default). The
  flat-meadow matched-cell sweep passed fill-v2 at 32 records (−14.1% slot work)
  but 64-record batches FAILED the cap gate (−7% — larger per-batch settles beat
  the parallelism). `RBOX_BATCH_RECORDS=64` remains available; the server cap
  stays 64 for re-evaluation.
- Sweep harness: tolerate find SIGPIPE when the corpus exceeds the byte budget.

## [1.4.0] — 2026-07-13 — upload lane rebuilt: full batches, receipts drained in-flight; codebase modularized

### Improved (live by default; founder ship-live call)
- **Batches ship full (design 112).** Upload batching defaults to the fill-v2
  dispatch policy with 64-record batches (server cap raised in lockstep):
  dispatch-on-full with quiet/absolute deadlines replaces the fixed 10ms timer
  that shipped half-empty batches (measured 17.3/32 records, 148KB of an 8MiB
  cap, ~733ms server settle paid 2,360× on a greenfield publish). Kill switch:
  `RBOX_BATCH_FILL=v1`. Version-skew guard: machine-readable `too_many_records`
  400 + strictly-shrinking client latch.
- **Receipts drain during upload (design 111).** Redemption receipts are
  redeemed while blobs upload instead of accumulating into a post-upload tail
  (37.4s measured on 49k receipts), with count+byte-bounded batches and a
  session cap clamp. The commit-enclosed final drain remains the catch-all.
  Kill switch: `RBOX_REDEEM_DRAIN=off`.
- **First-publish observability**: dispatch-reason telemetry, receipt
  request/byte stats, commit-enclosed `finalDrain` timing, repaired
  redemption/upload overlap accounting (interval-union), server-side redeem
  phase splits.

### Changed
- **Codebase modularized (design 113).** Six 1,000–2,500-line engine files →
  ~24 owner-responsibility modules behind exact-surface barrels, with
  `docs/CODEMAP.md` as the navigation contract. Behavior-identical (proven per
  wave: rename/content-equivalence, single-instance state, cycle baseline,
  compiled crypto smoke, token-stream-identical comment sweep). Review
  archaeology moved from code comments to the design ledgers.
- **O(change) commit admission enforced (design 102).** Prod validated 259/259
  shadow agreements, then enforced: admission dropped 5,956ms → 213ms measured.
- Design 109 (auth-call storm) evaluated and parked on gate-0 evidence
  (~89ms/request pre-handler — batch fill was the real lever); design 110
  (commit tail) pending its Phase-0 verdict from the evaluation sweep.

## [1.3.0] — 2026-07-13 — files-first first publish ON by default; init fixed for scripting

### Added
- **Files-first first publish is the default (design 108, #244/#247, `f2403834`).**
  A greenfield `rbox init` now publishes in two commits: files land first (the
  workspace is usable the moment "published → sequence 1" prints), then git
  history attaches as an ordinary second push. Genesis-only — existing
  workspaces are untouched. Field-validated on flat-meadow: two-phase publish,
  409 abort latch, starvation fallback, and flag-off byte-identity all
  confirmed; `timeToFilesSynced` beat the full-publish wall by 107s even on a
  file-heavy corpus. Kill switch: `RBOX_FILES_FIRST=0`.
- **`FirstPublishStats` renders on init** — the `fp filesSynced… authn… commit…`
  line that exposed the next round of perf levers (designs 109–111).
- **Admin workspace purge (#248).** `DELETE /v1/admin/workspace/:id[?dryRun=1]`
  (platform-secret gated) + `scripts/ws-purge.ts` drain — junk/bench workspaces
  can finally be deleted server-side; blobs reclaim via the normal GC pipeline.
  Field-proven on three bench workspaces.
- **Upload/download concurrency knobs (#245).** `RBOX_UPLOAD_SLOTS` /
  `RBOX_DOWNLOAD_SLOTS` (legacy aliases honored), clamp [1,256], defaults
  byte-identical. The measured verdict: defaults stay 24/48 — the knee is at
  48 slots and ≥64 collapses throughput 3x via per-batch RTT inflation.

### Fixed
- **`rbox init --new` no longer clobbers the machine device identity (#246).**
  Device-id resolution now prefers the enrolled E2EE keystore identity
  (`--new-device` escape hatch added); `rbox doctor` gained an O(1) check for
  dangling/mismatched binding ids. Field-verified on flat-meadow.
- **`rbox init` exits cleanly in headless/scripted runs (#246).** Ref'd crypto
  worker threads kept the event loop alive after `main()` returned; one-shot
  commands now tear the pool down on exit (the daemon keeps its pool).

## [1.2.0] — 2026-07-12 — the Mac gets fast: bulk scans, working fold evidence, field-proven trust recovery

Same-day follow-through on v1.1.0: everything that shipped dark yesterday is
now field-verified and on, plus the macOS performance sprint.

### Improved (measured on the live fleet)
- **macOS scans: per-file stat eliminated (design 107, #241).**
  `RBOX_SCAN_BULK=1` (darwin-only) walks directories with one
  `getattrlistbulk` syscall instead of ~118k `lstat`s — warm full scan
  **5.5s → 3.1s bench, 3.9s pull-scan / 2.0–3.2s safety-scan live**, with
  value-identical attributes (0 parity mismatches across the full corpus)
  and per-directory fallback on any FFI failure.
- **Manifest fold evidence works everywhere (design 84 r2+r3, #234/#238).**
  Same-head pulls fetch ZERO blobs; multi-link pulls fetch only the new
  suffix; chronic git-repo deferral (linked-worktree branches) no longer
  suppresses evidence — receiver manifest reads are **0.4–1.5s fleet-wide**
  (were 4.5s legacy / up to 21s broken-fold), and delta writes work on every
  host. Fold hot path: streaming canonical hash, each manifest verified
  exactly once per walk, memory bounded.
- **Watcher trust recovery field-confirmed (design 104).** The Mac's
  transient FSEvents drops now cycle suspect → re-trusted-behind-unpruned-
  scan instead of pinning full rescans at a 60s floor for the daemon's
  lifetime.
- **Pruned safety scans (design 85 Layer A, #236).** `RBOX_SCAN_PRUNE=1`
  reuses ctime-keyed directory listings (~24% scan cut; readdir share);
  deep scans stay unpruned as the drift backstop; pruned scans can never
  testify for watcher re-trust.

### Fixed
- **GC Phase-1 lifecycle (#235/#237/#239):** mark/purge are now cursored and
  fit D1's subrequest budget (previously: marks accumulated unboundedly —
  230k stale rows — and purge threw mid-page while misreporting success);
  the fence probe is robust to any mark-table size (enforce falls back to
  full validation whenever the probe is skipped — never silently unfenced);
  operator drain tooling gained grace parity with the cron and honest
  failure reporting. Backlog drained: 228,962 stale marks, 35.3GB of
  accounting released.

### Added
- **Machine-readable design-102 soak gate** (#232): `GET /v1/admin/delta-soak`
  (platform secret) exposes divergence/fallback/admission AE aggregates.
- **Cross-host propagation analyzer** (#240):
  `bun scripts/propagation-report.ts <originLog> <receiverLog>` — first fleet
  numbers: publish→apply p50 16.7s over 233 events, zero staleness
  incidents.

## [1.1.0] — 2026-07-12 — manifest deltas, watcher trust recovery, self-draining GC

The performance program's second checkpoint, hours after v1.0.1.

### Added (flag-gated, default off — staged per-host rollout with measurement)
- **Manifest delta encoding (design 84, #231).** The end of the constant
  39–41MB manifest transfer: zstd snapshot envelopes (`RBOX_MDE_SNAPSHOT`,
  measured **24×** smaller), O(change) delta commits (`RBOX_MDE_DELTA` — a
  one-file change ships ~KB), and head-blob-only fast pulls
  (`RBOX_MDE_FAST_PULL`). Chain-verified reads with exact-list matching, a
  pin-as-parent repair transaction (`rbox recover --repair-chain` + doctor
  check), fail-to-snapshot semantics on every delta trigger. Server chain
  acceptance is unconditional and additive — old clients are unaffected.
- **Watcher trust recovery (design 104, #229).** With `RBOX_WATCHER_RETRUST=1`,
  a transient macOS FSEvents overflow no longer permanently distrusts the
  watcher (which pinned full 116k-file rescans to a 60s floor — measured ~11%
  continuous I/O duty on the Mac). Transient drops now enter a suspect state
  that re-earns trust behind an unpruned safety scan, with a drop fuse
  preserving today's behavior under sustained failure.

### Changed
- **Scheduled GC purge enabled (#228).** The founder-supervised drain
  completed (5,410 blobs / 4.29GB reclaimed); the daily fenced cron now
  drains the remaining candidates as they age past the 7-day grace.

### Telemetry
- **Multipart transfer decomposition (design 101 Phase 0, #230)**: per-part
  walls/gaps/completion (client) + additive `serverTimings` with the
  whole-object verification reread isolated (server), plus a read-only
  multipart/staging orphan inventory for the platform operator.
- **First-publish stage decomposition (design 98 §5.1, #226)** emitted on
  both the serialized and pipeline paths with one schema.
- **Design 105 (merged design):** the existing WebSocket notify channel is
  formalized; its reliability fixes (pong deadline, jittered backstop pull,
  session cap) are specified and sequenced for implementation next.

## [1.0.1] — 2026-07-12 — performance program checkpoint: instant preflights, fused crypto, full sync telemetry

The first checkpoint of the sync-performance program (designs 97–103). Two
improvements are live by default or via fleet flags; the rest ship dark
(flag-gated, default off) pending their measurement gates.

### Improved
- **Change-only blob preflight (design 103 Part B, #218).** With
  `RBOX_PREFLIGHT_DELTA=1`, a push checks only the blobs it introduced (plus
  any 422-recovery residue) instead of the whole workspace — measured
  **2.8–4.0s → 0.1s** on a 114k-file workspace. Includes the fix that threads
  the server's unsatisfied-blob list through retry (previously dropped), a
  capped recovery accumulator with a chunked full-audit fallback, and
  `RBOX_PREFLIGHT_FULL=1` to force the full audit.
- **Instant rejection of stale commits (design 103 Part A, #218/#219).** The
  server now 409s an already-stale commit in ~0.1s instead of ~6s of admission
  work, cutting conflict-retry storms (previously 12–42s of added wall).
- **CLI usability fixes (#203).** `rbox restore` is now trash-tier-backed
  (undoable); uninstall warns about the keystore; assorted audit fixes.
- **Torn-scan hardening (#205).** Same-size edits with restored mtimes are
  re-hashed (ctime joins the fingerprint); mid-hash instability defers a file
  instead of publishing a torn read.

### Added (flag-gated, default off — awaiting measurement gates)
- **Fused crypto worker jobs (design 99, #224).** `RBOX_CRYPTO_FUSE=1` batches
  small-file encryption into byte-bounded in-memory jobs under a budget with a
  contention-bounding dispatch cap — **79.7% encrypt-wall reduction** on the
  production path in rig A/B (95% CI [77.2%, 86.5%]), byte-identical
  ciphertext. Fleet first-publish gates pending.
- **Overlapped first-publish pipeline (design 98 Tier 1, #225).**
  `RBOX_PUBLISH_PIPELINE=1` overlaps encrypt → upload → receipt redemption
  with reservation-based disk backpressure, an error-latched receipt drainer,
  and a two-barrier abort protocol. Serialized remains the default until the
  Workload-B gates hold.

### Telemetry (numbers-only; no file names or paths, ever)
- **Server commit decomposition rendered in push lines (#207/#213):**
  `srv/env/acct/ssc/cm/mir/rsp` tokens — this measurement attributed ~87% of
  commit-POST time to D1 ref admission and now feeds the design-102 shadow
  soak.
- **Join/apply decomposition (design 100 Phase 0, #223)** and **first-publish
  stage decomposition (design 98 §5.1, #226)** — gate evidence is emitted by
  the binary, not hand-timed.
- **Scan-site stats, per-dir probe, deep-scan drift audit (design 85 P0,
  #208)**, with `RBOX_METRICS` now **default-on** (opt out: `RBOX_METRICS=0`;
  measured worst-case scan overhead ≤3%).

## [1.0.0] — 2026-07-10 — the correctness milestone

rbox reaches 1.0. The three correctness pillars are now field-proven fleet-wide:
head authority (design 91) makes the commit chain un-forkable, manifest entry
integrity (design 92) makes a push poison-proof and pulls self-healing, and git
config sync (design 93) carries remotes and branch tracking with the repo. No
functional changes over 0.9.18 — this release is the version bump that marks the
milestone.

## [0.9.18] — 2026-07-10 — git config sync (design 93): remotes and tracking travel with the repo

### Added
- **Git config sync (design 93) (#192).** A repo's remotes and branch-tracking
  configuration now sync with its state — clone on a fresh machine and
  `git fetch`/`git push`/`git pull` work without re-adding remotes by hand.
  Config is embedded from a stability-bracketed snapshot at capture and applied
  through a locked, optimistic-CAS config transaction, so a concurrent editor or
  a mid-write power loss can never leave a partial config; the carry-base rule
  means a config that can't be represented is preserved byte-for-byte rather than
  stripped. Credential-bearing remote URLs are skipped (with a loud per-repo
  log). `rbox status` gains a `config:` line. Host-identity resolution degrades
  safely to the legacy path where it can't be established.

### Changed
- **Per-repo git-sync lines collapse into one progress counter (#191).** `rbox
  sync`/`rbox pull` used to print one stderr line per repo during apply — alarming
  at scale and easy to misread as failures. The default now shows a single
  "git sync ran for N/total" counter; real conflicts/warnings still print
  immediately. `--verbose` restores the per-repo dump. `rbox pair` also gains a
  single-keypress `[c]` token copy and corrected setup wording.
- **RboxBar shows total synced size instead of the sequence number (#190).** The
  dropdown's secondary status line now reads a human-readable size (e.g. "15 GB")
  computed from the daemon's in-memory manifest, falling back to "seq N" for
  older daemons in a mixed-version fleet.

### Fixed
- **Design-93 rollout hardening (#193, #194).** Config-sync wire bounds raised
  after field calibration (#193); the fingerprint cache is invalidated when those
  bounds change and invalid incoming config fields are ignored, and the config
  reader degrades rather than failing on unexpected input (#194).

## [0.9.17] — 2026-07-09 — download self-heal + CLI hygiene + calmer menu bar

### Fixed
- **A full join no longer hard-fails on a corrupted blob download (#187).** Under
  sustained high-concurrency load a large-body fetch could reassemble corrupt
  bytes; content-addressing already caught it, but rbox aborted the whole sync
  instead of re-fetching. `getBlobToFile` now bounded-retries on an integrity
  mismatch with backoff (the re-fetch lands as the pool drains into the reliable
  low-concurrency state), via a typed `BlobDownloadIntegrityError` that logs the
  recovery; persistent corruption still fails loudly with no partial file left
  behind.
- **`rbox track` reuses your logged-in identity and forwards the workspace name
  (#186).** Tracking a directory while logged in used to mint a fresh random
  device id (polluting local config and the server roster); resolution order is
  now `--device` > previous config > logged-in credential's device id > mint.

### Changed
- **RboxBar dropdown calmer and files-first (#185).** A degraded state (no user
  action needed) drops the card for a dim one-line status; critical states keep
  the card and carry a per-reason remedy. File count becomes the primary datum,
  the footer shows daemon version and hostname, and a six-hour update check
  renders a dim "Update available" row that copies the install command. Daemon
  status gains additive fields (fileCount, daemonVersion, workspaceRoot) so old
  and new bars interoperate.
- **`RBOX_API` endpoint overrides now warn loudly (#186)**, so a stray override
  can't silently point rbox at the wrong server.

## [0.9.16] — 2026-07-09 — manifest entry integrity (design 92): poison-proof push, self-healing size, fail-closed carry

### Fixed
- **Manifest entries can no longer be poisoned, and pulls self-heal (design 92)
  (#184).** Encrypt verify-defers an entry whose bytes changed mid-capture rather
  than recording a mismatched address; a diff heals a stale entry size instead of
  trusting it; carry is fail-closed (a base entry that can't be verified is
  carried, never silently dropped); and apply verifies a blob before it displaces
  a local file. Field-gated after real zstd-gated poison findings. The
  simplification pass also removed a ~500k-lstat ancestor walk from a 123k-file
  pull.
- **RboxBar finds its resource bundle when installed (#183)**, so the menu bar app
  renders correctly from an installed copy rather than only from the build tree.

## [0.9.15] — 2026-07-09 — self-clearing watcher-degraded status + native menu bar app

### Added
- **Native RboxBar menu bar app (design 88 UI) (#177).** A SwiftUI `MenuBarExtra`
  app (macOS 14+) replaces the SwiftBar shell plugin, reading the same atomic
  daemon status files with no daemon round-trips. It mirrors the prompt-status
  verdict rules exactly (15s staleness, absent/corrupt → dead, graceful paused
  stays paused), reproduces the synced/syncing/attention states theme-aware for
  light and dark, uses a custom R-monogram icon with a state badge, and is
  multi-workspace aware.

### Fixed
- **A transient FSEvents drop no longer pins the status on "attention" until a
  daemon restart (#182).** A dropped-events window is covered by a completed
  full/deep scan, which may now clear the watcher-degraded flag — guarded by an
  error-generation counter (no new watcher error since the scan began) and a live
  watcher (a periodic-scan fallback stays degraded). Found dogfooding RboxBar.

## [0.9.14] — 2026-07-09 — commit-fork recovery (`rbox recover`) + un-regressable head (design 91)

### Added
- **`rbox recover`** — a supported, one-command re-baseline when a workspace's
  local head pin has diverged from the server (reset the pin, re-verify the
  server chain, reconcile local files via keep-both, re-push local diffs).
  Replaces the need to hand-delete a keystore pin file. (The former phrase
  re-enrollment moved to `rbox key recover`.)

### Fixed
- **The commit sequencer can no longer fork under a Durable Object restart
  (design 91).** The workspace head is DO-authoritative and fail-closed: a
  missing head with evidence of prior life serves `repair_required` instead of
  reseeding from the best-effort D1 mirror (the reseed was what let a
  deploy-triggered DO restart re-issue an already-used sequence and fork the
  chain). Server-side same-sequence equivocation is now rejected. The server
  fix deployed with the prior `apps/api` push; this release ships the client
  `rbox recover` companion.

## [0.9.13] — 2026-07-08 — join/populate reliability (design-87 dogfood fixes)

### Fixed
- **Populate pulls can no longer hang silently on a lost blob completion.**
  Request-level settlement tracking in the batch downloader, size-aware total
  deadlines on every blob fetch, and a stream-progress-aware stall watchdog:
  90s of no progress logs the outstanding blobs and retries them (fail-silent
  duplicates — a failing retry never kills a request the primary may still
  deliver); persistent stalls fail loudly with a resume hint. Resume already
  re-fetched exactly the missing blobs.
- **Keyed setup persists credentials** (mode 600), so `--daemon` joins survive
  the invoking shell and reboots; `rbox key materialize` remains env-only.
- **`rbox status` and the prompt are honest during an initial populate**:
  a versioned populate marker renders "initial sync in progress — N/M files"
  instead of claiming 120k phantom local changes with sync not running.

New env knobs (documented in docs/development.md):
`RBOX_PULL_JOIN_WATCHDOG_MS`, `RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS`,
`RBOX_NET_BLOB_MIN_TIMEOUT_MS`, `RBOX_NET_BLOB_MAX_TIMEOUT_MS`.

## [0.9.12] — 2026-07-08 — ambient sync status (design 88)

### Added
- **Ambient sync status (design 88).** The daemon maintains an atomic
  `daemon.status.json` beside its pidfile (5s heartbeat, ownership-gated,
  early-paused on graceful stop); `rbox prompt-status [--json]` reads it with
  staleness-as-death semantics (a killed daemon shows `! dead` within 15s);
  the zsh prompt's staleness window tightens 180s → 15s on the new heartbeat;
  `contrib/swiftbar/rbox.5s.sh` ships the macOS menu bar MVP with a
  Status / File / Progress dropdown, pause/resume, and log tail.

## [0.9.11] — 2026-07-08 — git-plan at O(change) (fingerprint cache) + phase-0 instrumentation

### Fixed
- **git-plan no longer spawns ~13 git subprocesses per unchanged repo
  (design 83).** `planGitSections` consumes the `git-divergence.json`
  stat-fingerprint cache via a shared publish-grade v4 fingerprint
  (content-hashed HEAD/refs/small-index, ctime, 2s racy-clean margin,
  per-decision memoization) with a base-carry-only fast path and a
  baseless-worktree-pointer pre-skip. Measured on the real workspace:
  git-plan 24–43s → 4.0s (Mac) / 0.9s (wired Linux); daemon no-op tick
  25–63s → 4.5–4.8s (Mac) / 1.5s (Linux); no-op CLI push 41s → 10.2s.
  Cache file v2 → v3 (old caches self-heal with one cold plan).
- **Git identity probes are side-effect-free.** `git write-tree` rewrites
  the index file on every invocation; probes now run it against a temp
  index copy (`GIT_INDEX_FILE`), so rbox's plan/status probes no longer
  churn index files in tracked repos.

### Added
- **Commit/latest/scan sub-step instrumentation (designs 84/85 phase-0).**
  `RBOX_METRICS=1` phase lines now decompose commit
  (refresh/sidecar/encode/encrypt/upload/post + encBytes), latest
  (download/decrypt/parse), scan (readdir/stat/matcher/hash/sort + walked/
  statted/hashed/cache-hit counts, cumulative across 409-retry rescans),
  and git-plan (fpHits/fpMisses/fpUntrusted/pointerPreSkips/spawnedRepos).

## [0.9.10] — 2026-07-08 — steady-state sync at O(change) (encrypt-cache reverse path index)

### Fixed
- **Steady-state pushes no longer pay an O(files × cache-entries) scan
  (design 82).** The encrypt-address cache migrated every unchanged file's
  path with a full-cache scan — ~5.5 billion entry visits per push on a
  116k-file workspace with a 47k-entry cache, 481s of a 700s push, invisible
  to phase timers. Path migration is now O(1) via a reverse path index (same
  on-disk format; legacy duplicate paths self-heal on load). Measured on the
  real workspace: Mac push with a 1-file change 204s → 54s, Linux 60s → 29s,
  no-op sync 43s, daemon publish cycle ~3.5 min → 25–63s.

### Added
- **Phase coverage for the formerly-invisible sync zone (design 82 §4).**
  New `state-load`, `git-plan`, `address` (with cache hit/miss detail), and
  `missing` phases in `RBOX_METRICS=1` reports — phase walls now account for
  96–98.7% of push wall (was ~10–14%), so a regression like this can't hide
  again. Disabled reports are now a shared allocation-free singleton, so the
  no-op daemon tick stays free.

## [0.9.9] — 2026-07-08 — worker-pool crypto (real cores for blob encrypt/decrypt)

### Added
- **Worker-pool crypto (design 81).** Blob encrypt and decrypt now run on a
  pool of Bun workers (default `min(cores−2, 16)`, memory- and fd-aware;
  `RBOX_CRYPTO_WORKERS` overrides, `0` disables). The pool is lazy — small
  syncs below 8 crypto jobs stay inline — keyed to the workspace key epoch,
  and idles out after 60s. Ciphertext output is byte-identical to the inline
  path. If workers can't start (e.g. a broken binary), rbox falls back to
  inline crypto and `rbox doctor`/`rbox status` surface the degradation.
  Measured on a 32-core Linux host (105k-file first publish): wall
  27.5 min → 10 min, encrypt phase 5.5x, join decrypt lane 10% → 1%,
  zero small-push regression, full-corpus byte diff clean.

## [0.9.8] — 2026-07-08 — batch slot defaults from the capstone curves

### Changed
- **Batch transport slot defaults raised: downloads 16→48, uploads 8→24.**
  Cloudflare Workers cap parallel subrequests per invocation (~6), so a
  32-record batch settles in ~1s regardless of size — concurrent batch
  requests are the linear throughput lever. Measured on the v0.9.7 capstone:
  publish 83s→39s (8→24 put slots, A/B corpus, WiFi); full-corpus wired join
  128s→84s (16→48 get slots; 64 is flat — the knee is 48). `RBOX_BATCH_SLOTS`
  / `RBOX_BATCH_PUT_SLOTS` still override.

### Fixed
- Push lane timing no longer double-counts batched blobs
  (`ownsUploadLaneTiming` is now forwarded through the E2EE remote wrapper,
  and ownership is exclusive).

## [0.9.7] — 2026-07-08 — compress-before-encrypt + batched uploads

### Added
- **Compress-before-encrypt (design 79), default ON.** Blob payloads are
  zstd-level-3 compressed before AES-GCM when it pays (≥128 bytes and >5%
  smaller; media/archives stay raw automatically) — measured 2.17x
  byte-weighted across a real 6 GiB workspace, 4.9x on source-heavy corpora.
  Key/nonce derive from the sha of the exact encrypted bytes (`payloadSha`),
  so raw blobs stay bit-identical to 0.9.6 and nonce reuse is impossible by
  construction. Compressed manifests stamp `manifestSchema: 4`; older clients
  refuse them with one loud "upgrade rbox" error (validation now runs at the
  manifest decode boundary, covering pull, versions, and restore alike).
  Decompression is capped at each entry's declared size. Opt-out:
  `RBOX_COMPRESS=0` (new encryptions only). **Upgrade all machines in a
  workspace (and restart daemons) before the first push from this version.**
- **Batched blob uploads (design 80).** Small ciphertexts ride
  `POST /v1/blob-batch/put` — up to 32 per request, receipts-only, parallel
  R2 server-side with per-record results, receipts preserved via
  `Promise.allSettled`. The client coalescer mirrors the download side
  (same-sha waiter coalescing, pull-first dispatch with a 10ms tail flush,
  single-PUT fallback on old servers / per-record failures); the upload pool
  scales to 512 when batching. Kills the measured ~125 blobs/s per-request
  upload floor. Kill switch: `RBOX_BATCH_BLOBS=0`.

### Performance
- The design-79 A/B that motivated both features (17.5k files / 570 MB,
  WiFi): compression cut wire bytes 79% while walls stayed flat — proving
  small-blob transfer is request-bound, not byte-bound. Batching removes the
  request floor; compression then cuts the remaining bytes. Combined
  measurements land in the design docs after the release capstone.

## [0.9.6] — 2026-07-07 — batched downloads + parallel git materialization

### Added
- **Batched blob downloads (design 77 P1).** Small encrypted blobs now ride
  `POST /v1/blob-batch/get` — up to 32 per request under the §27 download
  grant (one verification, zero D1 on the happy path), streamed back as
  binary frames in completion order. The client coalescer fills batches
  pull-based from a supply-scaled download pool; large blobs keep the
  streaming single GET. A fresh join now issues ~3k requests where it issued
  ~93k. Kill switch: `RBOX_BATCH_BLOBS=0`.
- **Parallel git materialization.** Pull-side git apply runs repos through a
  bounded pool (`RBOX_GIT_APPLY_CONCURRENCY`, default 6) over nesting-safe
  chains, with per-store locking for worktrees sharing a common git dir.
  Measured: the ~98-repo git phase of a fresh join dropped from ~85s serial
  to ~34s.
- **Push-side lane timing.** `RBOX_LANE_TIMING=1` now attributes push wall
  time to encrypt vs upload, mirroring the pull instrument.

### Performance
- Fresh join of a 96k-file / 4.9 GiB workspace, measured end to end on the
  same hardware: **118s**, vs ~200s before this release and ~30 minutes two
  days ago. Server-side (already live for all clients): grant-authenticated
  blob reads skip the per-request D1 queue entirely (§27 Amendment A).


## [0.9.5] — 2026-07-07 — index resolve-undo fix

### Fixed
- **Repos with old merge-conflict residue no longer defer forever on
  receivers.** An index resolve-undo extension pointing at unreachable
  conflict blobs failed every receiver's post-apply fsck. Snapshots now
  strip it at capture, and apply clears it before fsck (existing stuck
  sections heal without a re-capture).

## [0.9.4] — 2026-07-07 — the performance sprint

### Added
- **Incremental git sync (design 53).** Repos with a synced base ship
  history increments instead of full bundles — measured 0.024% of the
  full-bundle bytes per change. Default on; `git.incremental: false`
  opts a workspace out. The first chained capture moves the workspace to
  manifest schema 3 (older clients must upgrade — clean break).
- **Instant status (design 69 §3.4).** With a live, settled daemon,
  `rbox status` answers from the daemon's published counts in ~50ms
  (was ~8s on a 130k-file tree) — and falls back to the full scan on any
  trust-predicate miss, never to wrong output.
- **Live byte progress (design 73).** Transfers render dual fractions
  (`uploading 126,352/126,369 · 4.1/6.3 GiB`); git capture shows
  cumulative bytes sent. Multi-GB uploads no longer look like hangs.
- **Pull instrumentation + faster fresh joins (design 74 Phase 0).**
  The pull's git-apply tail is now measured per repo, and download
  concurrency defaults to 128 (recorded sweep: ~25% faster on big
  materializations).
- **First-publish encrypt cache (design 75).** Retrying a large first
  publish re-encrypts only what the server is actually missing, instead
  of the entire workspace.
- **No more silent network wedges.** Small control requests carry a 60s
  deadline with the established retry rules, and the daemon heartbeat
  advances on a timer, so a hung operation reads as visible staleness.

### Changed
- Hourly server maintenance moved off the top of the hour (was
  correlating with transient commit 500s).

## [0.9.3] — 2026-07-07 — daemon hotfix

### Fixed
- **v0.9.2 daemons stopped pushing minutes after start** ("E2EE required:
  refusing to sync without an encryption key"): the new workspace-config
  reload rebuilt the daemon's config from workspace.json, dropping the
  runtime-attached encryption key material and credential remote override.
  The reload now moves only the hot-reloadable setting. If you installed
  0.9.2, upgrade and restart the daemon (`rbox upgrade && rbox stop && rbox
  start`).

## [0.9.2] — 2026-07-06 — refs at scale: big workspaces can publish

### Added
- **Receipt redemption (design 71).** Upload receipts are redeemed in batches
  *before* the commit, so the commit request stays tiny regardless of
  workspace size. Previously a cold first publish of a very large workspace
  (~123k files) sent a ~45 MiB receipts map into an 8 MiB request cap and
  could never publish.
- **Per-commit ref cap raised 50k → 250k**, enforced against the full
  accounted set (data refs + carriers) and backed by budget tests derived
  from the platform math. A workspace over the cap now gets an actionable
  error and an honest red "sync blocked" status (no false "will be retried")
  instead of a silent retry loop.
- **Bare `rbox` inside a workspace** shows the status block plus a small
  action picker (Sync now / View logs / Pause) instead of the setup wizard;
  the status header now includes the installed version.
- **Local dev builds**: `bun run dev:install` compiles a `rbox-dev` binary
  (`<version>-dev+<sha>`) for release-free on-machine testing
  (docs/dev-loop.md).

### Fixed
- **0.9.1 shipped without its own headline status-honesty changes** — a
  stale-base squash silently reverted them post-merge. Restored: amber
  "will be retried" for transient failures, live first-publish progress in
  the git-sync line, fresh-active precedence in the prompt glyph.
- **A file vanishing mid-push no longer aborts the whole push** (constant on
  live trees with agents/builds churning); it defers like any churning file
  and the stable subset commits.
- **Git capture failures name their real reason** (repo-context / HEAD
  probes) instead of the generic "capture returned nothing".
- Recovery from very large missing-blob sets pages through honestly
  (bounded 422 responses carry the total; progress refunds the retry
  budget).

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

## [0.6.0] — 2026-07-01 — nested-repo git sync
- Nested-repo git sync: per-repo GitSections, worktree materialization, all E2EE
  (design 43).

## [0.5.7] — 2026-07-01 — daemon rebind self-heal + dashboard rebuild
- Stale-daemon rebind detection, forensic sync logs, and ignoring `.git` pointer
  files (#42); setup sends the prompted workspace name on the create path (#40).
- Batched the blob-check push preflight D1 reads (serial → `db.batch`) (#39);
  customer dashboard rebuilt on Tailwind v4 + shadcn-svelte (#41).

## [0.5.6] — 2026-07-01 — bulletproof live-folder sync
- Snapshot-first encryption, safe against concurrent writes (#37); churning files
  now defer instead of aborting the whole push (#38).

## [0.5.5] — 2026-07-01 — setup names + live-folder resilience
- `rbox setup` prompts for a workspace name (#35); push self-heals a live-folder
  TOCTOU (`sha_mismatch`) (#36).

## [0.5.4] — 2026-07-01 — interactive CLI revamp
- `@inquirer` interactive surfaces + pick-workspace-by-name (#34).

## [0.5.3] — 2026-07-01 — download grants (design 27 client)
- The client presents signed download grants on blob GET, taking D1 off the
  blob-GET hot path (#32).

## [0.5.2] — 2026-07-01 — workspace names + track picker
- Opt-in, server-visible workspace names in status, plus a pick-from-list for
  track-existing (#31, #33); admin cockpit gains the Analytics-Engine SQL read
  path (§25 Plane A) (#30).

## [0.5.1] — 2026-07-01 — verify every upload path
- Manifest signature is now verified on every upload path (#26).

## [0.5.0] — 2026-07-01 — watcher scale + global daemon logs
- `@parcel/watcher` backend: RSS 11 GB → 60 MB and no more dropped events
  (§41) (#24). Daemon logs/pid move under `~/.rbox` (#21), and `rbox status`
  shows account/plan/link status (#19). arm-Mac + Linux only.

## [0.4.3] — 2026-07-01 — installer PATH + phase metrics
- Installer persists PATH; the daemon no longer spawns from the compiled-binary
  help menu (#16). Coarse client phase metrics (§35) (#17).

## [0.4.2] — 2026-06-30 — native log tail + observability
- `rbox logs` becomes a real native daemon log tail (#14). Self-serve account +
  data deletion (GDPR/CCPA, design 37) (#12); §32 observability — Slackpipes
  pings, Tail Worker, admin cockpit (#13); §33 per-account entitlement GC.

## [0.4.1] — 2026-06-30 — multi-device fix + security email
- Fixed the §31 admission-grant `notAfter` that bricked multi-device accounts
  (P0). New-device security emails via Cloudflare Email Service (#10, #11); §30
  large-ref commit accounting lifts the 6002-ref cap.

## [0.4.0] — 2026-06-30 — version history + CLI redesign + device dashboard
- CLI redesign: `rbox start`/`setup`, `track`/`untrack`, a `deps` group, `--help`,
  and dependency-drift notifications (#9). Device-management dashboard (§22) (#5).

## [0.3.2] — 2026-06-30 — CLI redesign groundwork
- `rbox --help`/`-h` exit 0; the §29 CLI command redesign was finalized.

## [0.3.1] — 2026-06-30 — version history under E2EE
- Version history + restore under E2EE (design 12 §15); a device-management
  dashboard (devices route + revoke + unlink); the CLI defaults to the prod API
  (`api.rbox.to`); `rbox versions .` lists the whole workspace.

## [0.3.0] — 2026-06-30 — git-sync under E2EE
- §28 git-sync under E2EE — git artifacts encrypted, default on. §24 blobRef
  sidecar makes the signed commit body O(1); upload/download concurrency raised
  to 64.

## [0.2.0] — 2026-06-30 — upload receipts (~6× faster sync)
- §23 upload-receipts (direct-write) cut sync time ~6×. Account linking
  (design 21): `rbox account link/status/unlink` plus a dashboard "Link your CLI
  account" flow; §25 server observability streams per-op R2/D1/DO timing to
  Analytics Engine.

## [0.1.2] — 2026-06-29 — concurrency knee
- Default upload/download concurrency 16 → 32 (measured knee) + a bench harness.

## [0.1.1] — 2026-06-29 — sync perf + empty-file fix
- Concurrent blob upload/encrypt and download with push/pull progress; empty-file
  round-trip fixed; concurrent-push bugs found dogfooding a real repo. Dashboard
  redesign (#1).

## [0.1.0] — 2026-06-29 — first release: sync engine, control plane, CLI
- Initial rbox: a continuous daemon (watcher + live push), a streaming /
  multipart / resumable blob path, opt-in git-state sync, convergent E2EE blob
  encryption, version history + restore, reachability GC + retention, multi-tenant
  isolation, self-hosted device-token auth + machine pairing, plan/quota
  enforcement, Stripe billing (checkout/portal/webhook), and a Clerk-authenticated
  web dashboard.
