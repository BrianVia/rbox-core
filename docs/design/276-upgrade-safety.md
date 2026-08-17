# 276 — Upgrades are safe: un-brick 1.x→2.0 (#688) and stop the false W1 halts (#765)

Status: DRAFT r1 (recon-grounded; every anchor verified by the recon pass)
Issues: closes #688, closes #765. Stable-tag blocker pair (the two ways an
external user's upgrade leaves sync down or lying about being down).

## Corrected problem statements (recon falsified parts of both issues)

**#688 is a config-admission refusal, not a state-migration brick.**
`rbox upgrade` runs NO state conversion (upgrade-cmd.ts:159-160 comment;
`runMigration` reachable only from explicit `rbox migrate` and
halt-recovery; the rig pins non-conversion as a MUST,
scripts/rig/scenarios/json-upgrade-path.ts:1-4). The actual failure: the
restart path runs design-231 folder-catalog admission
(autostart/daemon-state.ts:73 `requireFolderAdmission`) BEFORE the daemon
spawns; a 1.11.4 machine has discoverable bindings and no
`~/.rbox/config.json`, so `ensureFolderAuthority`
(folder-authority.ts:23-25) throws "rbox folder configuration is absent;
run `rbox config regenerate`" (folder-catalog-publish.ts:179). Silent
auto-generation is reachable only with ZERO bindings (fresh machine).
Worse, the managed flow's catch (upgrade-cmd.ts:184-186) SWALLOWS that
message and prints "restart failed; run rbox stop && rbox start" — the
exact command that fails the same way. Reported but misdiagnosed, and the
sync stays down after the stop at upgrade-cmd.ts:163 already happened.
(The issue's "one-way SQLite conversion / point of no return" framing does
not match the code; the fix races nothing irreversible. `docs/
2.0-UPGRADE-NOTE.md` cited by the issue does not exist; the
compat-matrix "test.todo" claim is stale — it is a live test at :265.)

**#765's W1 is not a halt-class condition.** `recoverSqliteReset` handles
W1 in-process via `recoverOrdinaryWalCrash` and requires it to reach S0
(state-plane/reset/recovery.ts:352-357). Only the top-level adapter
DEMOTES it: reset-journal.ts:202-204 maps `status:"w1"` →
`status:"halt"` + prose, which makes the daemon's
`resetOperationBoundary` bail at daemon.ts:1284-1286 before ever reaching
the loadState recovery at :1293 — then retries in an HOUR
(RESET_RECOVERY_RETRY_MS doing double duty as log-gate interval AND retry
deadline, reset-halt-policy.ts:1 / daemon.ts:1254). The classifier's
"at rest" expectation is purely lstat-shaped (`sidecarVector` in
reset-namespace-inventory.ts:159-172; SW → W1 at classifier.ts:79) with
NO process-ownership input, so the daemon can classify ITS OWN live
handle's sidecars as a crash — the boot race: heal at :1316, then the
first pump's second boundary (daemon.ts:1565→1568) observes the boot's
own store activity ~0.3s later and re-halts; "rbox daemon ready" prints
anyway because :957 samples lifecycle before the pump at :958.

## Design

### F1 (#688) — the admission gate learns the upgrade case; the message never lies

1. **Containment (one line, ships regardless):** `restartDesiredDaemon`'s
   bare `catch {` surfaces `error.message` — the user sees
   "run `rbox config regenerate`" instead of a remedy that re-fails.
2. **Up-front guard:** `restartDaemonsAfterUpgrade` checks folder
   admission BEFORE the stop at upgrade-cmd.ts:163. If admission would
   refuse, the daemon is left RUNNING on the old binary and the flow
   reports exactly what to run — an upgrade must never trade a working
   1.x daemon for a stopped 2.0 one.
3. **Non-lossy auto-regenerate:** `prepareFolderRegeneration` already
   computes the loss report (folder-config-cmd.ts:97+). When the
   regeneration is provably LOSSLESS (empty loss description, no omitted
   bindings), the upgrade/start path performs it automatically —
   consent is for LOSS, not for the mechanical rewrite (the zero-binding
   auto-path at folder-authority.ts:26 is precedent). Lossy cases keep
   the consent gate and the honest message. Both message producers
   (folder-catalog-publish.ts:179 AND folder-inventory.ts:99 "damaged")
   updated — the recon proved a fix at one does not cover the other.

### F2 (#765) — W1 stops masquerading as a halt

1. **Route, don't retune:** the adapter at reset-journal.ts:197-215 stops
   flattening `w1` into `status:"halt"`; it becomes recoverable, so
   `resetOperationBoundary` proceeds into the existing loadState-driven
   recovery (`recoverOrdinaryWalCrash` path) instead of parking for an
   hour. `enterResetHalt` gains the typed row (widen
   ResetSafetyInspection's halt variant with the classifier row —
   recovery.ts:155-158 already carries it) so genuinely terminal rows
   (W2/W3/J0) keep the hour and the log gate, and readiness
   (`remoteWakeup.setReady`) does not flap: W1 is "recovering", never
   "halted".
2. **Own-handle consult:** before classifying SW as W1, the boundary
   consults the in-process `liveStores` registry
   (store/open.ts:160-215, the existing
   `ownedStateStoreWriterForReset`/`closeOwnedStateStoreReadersForReset`
   seam): a live daemon-owned handle for state.db is decisive proof of a
   live store, not a crash — the boot race becomes structurally
   impossible within one process. Cross-process observers (the sqlite3
   incident) are covered by recovery-instead-of-halt plus one short
   re-inspection backoff; no new lock convention.
3. **Status trusts the classifier:** status-projection.ts:181-195's
   `|| resetHealth !== undefined` becomes classifier-only;
   health-halt.json only decorates (haltedAt/prior reason), per
   reset-health.ts:46-47's own authority comment. The one load-bearing
   reader (`resetOperationBoundary`'s `persisted` at daemon.ts:1283 —
   forces re-recovery after restart) is UNCHANGED. The test pinning the
   wrong behavior (status-cmd.test.ts:365-374) inverts. `rbox doctor
   reset-journal` already classifier-only — the two surfaces stop
   disagreeing by construction.
4. **"ready" stops lying:** daemon.ts:957 samples lifecycle AFTER the
   first pump (or the ready line states "recovering") so the log cannot
   print ready above a halt.

## Protected functionality

- Explicit-command-only state conversion (`rbox migrate`); the rig's
  json-upgrade-path MUST stays green — 276 converts nothing.
- Lossy regeneration keeps its consent gate verbatim (TTY or --yes).
- W2/W3/J0 halts keep fail-closed semantics, the hour retry, the log
  gate, and `rbox doctor reset-journal --quarantine` flows.
- health-halt.json write/clear sites unchanged (daemon.ts:1256/:1315);
  only the status read's authority changes.
- The at-rest reads discipline (reads-leave-the-store-at-rest.test.ts)
  unchanged — the own-handle consult is a classification input, not a
  license for readers to leave sidecars.
- `rbox upgrade` reporting contract: still exits non-zero when any
  workspace cannot be safely restarted; messages become accurate.

## Validation

- #688 red-first: a fixture 1.x-shaped home (bindings present, no
  catalog) through `restartDaemonsAfterUpgrade` — today's path asserts
  the misdiagnosed message + stopped daemon; the fix asserts (a) daemon
  left running on refusal, (b) exact remedy printed, (c) lossless case
  auto-regenerates and restarts cleanly, (d) lossy case refuses with the
  loss report and keeps the old daemon up. Upgrade-restart admission
  test added to upgrade-daemons.test.ts (recon: no such test exists).
- #765 red-first: (a) foreign-sidecar fixture (zero-byte -wal/-shm
  beside a steady store) — today halts for an hour, fix recovers within
  one boundary pass; (b) boot-race test: boundary inspection while a
  live in-process writer handle is open classifies live-store, not W1;
  (c) status with stale health-halt.json + clean classifier renders
  syncing-normally-with-decoration (inverting status-cmd.test.ts:365);
  (d) crash-rig W1 (real SIGKILL) still converges to S0 — the genuine
  crash case must stay covered by recovery.ts's takeover, now reached
  WITHOUT the hour wait; (e) ready-line ordering.
- Field acceptance: on one fleet host, `sqlite3 file:...?mode=ro` against
  the live store (the #765 trigger, deliberately) followed by a status
  check within a minute — syncing normally, no halt; and a full
  `rbox upgrade` cycle on a fixture 1.11.4 home in the rig.
- Perf: no new work on the steady pull path (the own-handle consult is
  an in-memory WeakRef check inside an already-halt-only branch).

## Requirement ledger

| Mechanism | Owner | Deletion condition |
|---|---|---|
| up-front admission check in restartDaemonsAfterUpgrade | upgrade-cmd | 2.0 stable ubiquitous; 1.x support window ends |
| lossless auto-regenerate branch | folder-authority (one owner, both message producers) | folder catalog v2 makes 1.x configs unrepresentable |
| typed classifier row through ResetSafetyInspection | reset-journal adapter | reset plane v2 |
| liveStores consult in the boundary | daemon resetOperationBoundary | classifier gains cross-process ownership input |

## Non-goals

- No state-migration changes; no auto-`rbox migrate`.
- No cross-process store-ownership lock convention (backoff + recovery
  covers the foreign-reader case).
- No changes to quarantine/doctor recovery flows.
- The #688 issue's nonexistent 2.0-UPGRADE-NOTE §A7 questions
  (next-channel beta.2 stranding, hashcache re-hash) are out of scope —
  re-filed against the release checklist if still real.

## Sequencing

Two PRs, independently mergeable: PR-A = F1 (#688, CLI/upgrade plane);
PR-B = F2 (#765, daemon/reset plane). No cross-dependency (recon Q8:
the paths do not intersect).
