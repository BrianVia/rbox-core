# 276 — Upgrades are safe: un-brick 1.x→2.0 (#688) and stop the false W1 halts (#765)

Status: r2 (r1 adversarial review REVISE — four HIGH clusters folded: the
"lossless regeneration" concept deleted for the existing auto-init
primitive; the liveStores consult relocated into the state-plane
classifier; the short W1 backoff promoted to first-class; status halt
visibility rebuilt on an ambient lifecycle projection instead of the
poison-pill file. FOUNDER NOTE: F1.3 supersedes the 2026-08-13 #688
de-scope ("externals start fresh; guard only") — today's ranking of #688
as the #1 stable-tag blocker is read as fresh direction; veto if wrong.)
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
2. **Up-front guard, PER WORKSPACE, via the existing seam:** the check
   lives inside `cycleOneDaemon` BEFORE the `stop(root)` at
   upgrade-cmd.ts:163 (a per-workspace refusal must not stop other
   workspaces' daemons), and reuses the `trustedFolderAdmission` token
   pattern `bootResume` already demonstrates (boot-resume.ts:45 →
   daemon-state.ts:73 honors it and skips the re-check) — check and
   restart become atomic in the sense that matters. The residual TOCTOU
   is NOT bounded by the token's generation (nothing compares it): the
   real backstop is the daemon's own construction-time re-check
   (`installInitialFolderPolicy` → `runtimeRefusal`), plus leaving the
   daemon running on refusal, so a catalog edit landing between the check
   and the spawn is caught by the daemon rather than by the token. An upgrade must never trade a working 1.x daemon for a
   stopped 2.0 one. ("Old daemon + new binary on disk" is already a
   supported state: DEPLOYMENTS.md's binary-swap installer transits it on
   every fleet upgrade, and compat-matrix.test.ts:264-273 pins the
   dual-binary scenario — cited as evidence, not asserted.)
3. **Auto-init on the ABSENT case (review-corrected — the "lossless
   regeneration" concept is DELETED):** the #688 machine has NO catalog,
   and the absent case has nothing to lose BY CONSTRUCTION (qualified
   below: only while bindings stay complete policy snapshots) — the
   regeneration/consent machinery exists to REPLACE an existing catalog
   and its "loss description" is a constant string (never empty;
   folder-catalog-generate.ts:149-155 — r1's predicate was not
   computable). The codebase already owns auto-init twice:
   `initializeFolderCatalog` → `publishNoReplace` (catalog lock +
   O_EXCL + durable rename + loser reconciliation,
   folder-catalog-publish.ts:340-365) and
   `initializeFolderCatalogAfterFirstBinding`
   (folder-catalog-generate.ts:131-147). The fix is a GUARD WIDENING at
   folder-authority.ts:26: auto-initialize when zero SKIPPED and zero
   evidenceUnavailable bindings (not only zero bindings). Semantics are
   round-trip-safe ONLY while every binding stays a COMPLETE pre-catalog
   snapshot: generated catalogs snapshot per-folder policy via
   `snapshotPreCatalogPolicy`, the exact inverse of `folderPolicyFields`.
   Review falsified the unqualified claim — `rbox ignore
   --respect-gitignore` (ignore-cmd.ts) wrote the CATALOG only, so a lost
   catalog silently REVERTED the user's ignore policy. That command now
   persists the resolved policy into the binding too, pinned end to end by
   "a respect-gitignore edit survives losing and reinitializing the folder
   catalog" (ignore-cmd.test.ts) — the round-trip proof this design rests
   on. Labels/ordering are derived, which is loss only relative to a
   catalog that existed. This also RETIRES design 266's fold-R4 amendment
   (266 §7.1) early and deliberately reverses its forbidden-call-site
   ruling for the daemon; 266 carries the amendment block.
   `damaged` (bytes exist, loss real) keeps the consent gate verbatim; both message producers (folder-catalog-publish.ts:179
   AND folder-inventory.ts:99) stay accurate.
   FOUNDER SUPERSESSION NOTE: the 2026-08-13 #688 comment de-scoped
   in-place upgrades to "up-front guard only". Today's #1-blocker
   ranking is read as superseding that; with the concept deleted this is
   a ~2-line guard widening on an existing owner, not a new mechanism.
4. **bootResume covered (review finding — the SECOND bricked entry
   point):** boot-resume.ts:32 calls `ensureFolderAuthority()` unguarded
   before the loop, so autostart (login item / systemd) bricks every
   workspace silently on a 1.x home. Because F1.3's fix lives at
   `ensureFolderAuthority` (the one owner), bootResume heals with it;
   validation covers it explicitly.

### F2 (#765) — W1 stops masquerading as a halt

1. **Route, don't retune — for the DAEMON; status renders w1 as
   recovering WITHOUT falling through:** the adapter at
   reset-journal.ts:197-215 surfaces `w1` as its OWN TYPED VARIANT —
   neither halt nor journal-recoverable (there is no journal); each
   Adapter decides: daemon recovers, status early-returns as recovering,
   doctor reports. One type, ZERO caller modes (no recoveryCapable flag); `resetOperationBoundary` proceeds into
   the existing loadState-driven recovery (verified reachable:
   inspectStanding w1 → settleStandingResetUnderHeldFence →
   recoverOrdinaryWalCrash under the canonical state lock,
   reset-journal.ts:337-345). `enterResetHalt` gains the typed row so
   terminal rows (W2/W3/J0) keep the hour + log gate, and W1 is
   "recovering" (readiness does not flap). CRITICAL carve-out (review
   finding 7): `rbox status` keeps an EARLY RETURN on w1, rendered as a
   non-halt "recovering" projection — it must NEVER fall through to
   readState, whose loadState path would acquire the sync mutex and
   attempt a rival W1 takeover against the live daemon (design 138 F2b:
   status is read-only; a second-process status during the #765 trigger
   would otherwise hard-error on "reset checkpoint remained busy").
2. **Own-handle consult lives in the STATE-PLANE CLASSIFIER, not the
   daemon boundary (review finding 8):** `inspectSqliteReset`/
   `classifySqliteResetPredecode` consults the in-process `liveStores`
   registry (store/open.ts:160-215; precedent: lifecycle.ts:58) — a
   live owned writer handle for state.db proves SW is a live store, not
   a crash. Every surface (daemon, status, doctor) then agrees for free,
   and the deeper loadState→takeover path cannot race the process's own
   handle either. Soundness: a crashed-and-restarted process has an
   EMPTY registry (module-level WeakRef set) so a genuine crash is never
   masked; worker threads / a second daemon have their own module
   instance and fall back to today's behavior — stated, not implied.
3. **Short W1 re-inspection backoff — FIRST-CLASS (review finding 9;
   this, not routing, fixes the reported symptom):** when a w1-derived
   recovery FAILS (e.g. checkpoint busy because a foreign reader is
   still attached — store/open.ts:203), the daemon RE-INSPECTS first
   (sidecars usually vanish minutes later; classifier steady → no halt
   at all), else retries on a bounded short backoff (seconds, N
   attempts), escalating to the existing hourly halt only after N.
   Owner: the daemon reset-retry policy beside RESET_RECOVERY_RETRY_MS;
   the short backoff must NOT shorten the halt log gate (the constant
   currently does double duty — split it). Deletion condition: the
   classifier gains cross-process ownership input.
4. **Status halt visibility rebuilt on the ambient lifecycle (review
   finding 10 — the stronger primitive; r1's classifier-only cut would
   have DELETED real visibility):** three enterResetHalt reasons have no
   classifier signature (bootstrapAgreement failure daemon.ts:1273;
   loadSyncBase throw :1294-1296; non-terminal recovery :1301) and
   health-halt.json is today their ONLY trace. Fix: project the daemon's
   `resetLifecycle` into AmbientDaemonStatusV1 (heartbeat-written, so it
   cannot outlive the condition by more than a heartbeat); status
   renders halts from classifier ∪ live-ambient-lifecycle and DROPS its
   health-halt.json read entirely. The file keeps exactly ONE reader
   (resetOperationBoundary's persisted re-recovery trigger,
   daemon.ts:1283) — one fewer authority than today, the stale-file
   false halt dies, every daemon-side halt stays visible, and a dead
   daemon needs no file (status already reports daemon.running===false).
   status-cmd.test.ts:365 is design-138 visibility, NOT a bug pin — it
   is preserved (via the ambient path), not inverted.
5. **"ready" stops lying (backstop, not fix):** re-read resetLifecycle
   after the first pump (daemon.ts:957-959) and pick the message; stays
   honest even after F2.1/F2.2 remove the boot race. (The :953
   setReady pre-sampling is self-correcting via enterResetHalt — noted
   so nobody "fixes" it twice.)

## Protected functionality

- Explicit-command-only state conversion (`rbox migrate`); the rig's
  json-upgrade-path MUST stays green — 276 converts nothing.
- `damaged`-catalog regeneration keeps its consent gate verbatim (TTY
  or --yes).
- W2/W3/J0 halts keep fail-closed semantics, the hour retry, the log
  gate, and `rbox doctor reset-journal --quarantine` flows.
- health-halt.json write/clear sites unchanged (daemon.ts:1256/:1315);
  status no longer reads the file AT ALL (F2.4); its sole remaining
  reader is resetOperationBoundary's persisted trigger at daemon.ts:1283.
- The at-rest reads discipline (reads-leave-the-store-at-rest.test.ts)
  unchanged — the own-handle consult is a classification input, not a
  license for readers to leave sidecars.
- `rbox upgrade` reporting contract: still exits non-zero when any
  workspace cannot be safely restarted; messages become accurate.

## Validation

- #688 red-first: a fixture 1.x-shaped home (bindings present, no
  catalog) through `restartDaemonsAfterUpgrade` — today's path asserts
  the misdiagnosed message + stopped daemon; the fix asserts (a) daemon
  left running on refusal, (b) exact remedy printed, (c) absent-catalog +
  zero-skipped case auto-initializes and restarts cleanly, (d) a case
  with skipped/evidence-unavailable bindings refuses, leaves the daemon
  running, and prints the `rbox config regenerate` remedy, (e) a
  `damaged` catalog still refuses and keeps its consent gate.
  Upgrade-restart admission test added to upgrade-daemons.test.ts
  (recon: no such test exists). Scope note, pinned by its own test:
  folder ADMISSION is decided per workspace, but catalog INITIALIZATION
  reads ONE home-global inventory, so a single unreproducible row refuses
  every workspace at once.
- #765 red-first: (a) foreign-sidecar fixture — today halts an hour, fix
  recovers within one boundary pass; WITH the reader still attached, the
  assertion is "refused on short bounded backoff without a one-hour
  halt", not merely "no halt" (anti-trivial-pass); (b) boot-race:
  classifier consulted while a live in-process writer handle is open →
  live-store, not W1; crashed-and-restarted process (empty registry) →
  still W1 (genuine-crash non-masking); (c) `rbox status` performs ZERO
  store mutation and takes NO workspace mutex while the classifier reads
  w1 (the read-only property design 138 F2b protects); (d) a
  bootstrapAgreement-failure halt is STILL visible in rbox status via
  the ambient projection (the regression r1's cut would have shipped);
  (e) stale health-halt.json + clean classifier + live daemon → syncing
  normally; (f) crash-rig W1 (real SIGKILL) still converges to S0
  without the hour wait; (g) ready-line ordering.
- #688: bootResume on a 1.x-shaped home heals (the silent second entry
  point).
- Field acceptance: on one fleet host, `sqlite3 file:...?mode=ro` against
  the live store (the #765 trigger, deliberately) followed by a status
  check within a minute — syncing normally, no halt; and a full
  `rbox upgrade` cycle on a fixture 1.11.4 home in the rig.
- Perf: no new work on the steady pull path (the own-handle consult is
  an in-memory WeakRef check inside an already-halt-only branch).

## Requirement ledger

| Mechanism | Owner | Deletion condition |
|---|---|---|
| per-workspace admission check in cycleOneDaemon (trustedFolderAdmission token) | upgrade-cmd | 2.0 stable ubiquitous; 1.x support window ends |
| absent-case auto-init guard widening | folder-authority (heals upgrade AND bootResume) | folder catalog v2 makes 1.x configs unrepresentable |
| RULE: every catalog-only policy editor must also persist `folderPolicyFields` into the binding, or auto-init reverts the edit | the editing command (today only ignore-cmd's `setRespectGitignore`) | catalog publication becomes the sole policy record and bindings stop carrying policy |
| RESIDUAL (accepted, bounded): a catalog-only entry with no binding (`rbox config add` on an unbound folder) is not reproduced by auto-init and vanishes with a lost catalog; recovery is re-running `rbox config add` | folder-authority | same as above |
| RESIDUAL (open product question): a leftover daemon runtime dir with no user config vetoes initialization exactly like a real registry row — should it? | founder | ruling recorded |
| typed classifier row through ResetSafetyInspection | reset-journal adapter | reset plane v2 |
| liveStores consult in classifySqliteResetPredecode | state-plane classifier | classifier gains cross-process ownership input |
| short W1 re-inspection backoff (bounded, N attempts, then hourly) | daemon reset-retry policy (split from the log-gate constant) | classifier gains cross-process ownership input |
| resetLifecycle in AmbientDaemonStatusV1 (replaces status's health-file read) | daemon heartbeat writer | reset plane v2 unified halt surface |

The consult's one standing risk: a WRITER handle leaked by a save would keep
answering "live store" and mask a real W1 the daemon should recover. That is
already a pinned invariant rather than a new one — `whole-state-compat.test.ts`
asserts `ownedStateStoreWriterForReset(active)` is undefined after every save
path (":771 the save closes the writer it opened", plus the lineage/genesis
cases), and the consult admits owned writers only, so a reader handle never
suppresses the row (`classifier.test.ts` negative control).


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
