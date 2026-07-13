# Spec: implement design 93 — git config sync

Branch `d93-git-config-sync` (this worktree). The design doc is
`docs/design/93-git-config-sync.md` (v4+, adversarially reviewed through 4+
rounds — REVIEW-93.md is the latest round). **The doc is binding**: every
mechanism (§4 wire form + validation, §6 lane state/sync-point rule/publish +
apply predicates/path coverage table, §7 transaction + reaping protocol, §8
grammar predicate, §9 receiver ownership gate) is specified to the decision
level; do not invent alternatives. Where the doc cites file:line, verify
against the live code and adapt mechanically (line numbers may have drifted).

## Order of work (one commit per step, conventional style)

1. `src/engine/git/config-sync.ts` (new): allowlist table, canonicalization,
   §8 grammar predicate module (`refComponentOk` + per-key value validators +
   credential rejection), bounds. Pure logic + exhaustive boundary-table unit
   tests FIRST — this module is shared by capture, validation, and apply.
2. Wire form: `GitSection.config` type (types.ts), `validateGitSection`
   canonical-form enforcement (manifest-validate.ts) + the unknown-field
   tolerance regression pin. Raw (non-trimming) exec helper + `-z` config
   reads in `src/engine/git/shared.ts`; `config.lock` joins `gitBusy`.
3. §7 lockfile primitive + transaction module: atomic create-with-content via
   same-dir fsync'd temp + link(); marker = host-id/boot-id/pid/start-time/
   token (cross-host = FOREIGN); no-follow (lstat/O_NOFOLLOW) marker
   inspection everywhere; reaper-fence recovery (<lock>.reap, unlink under
   occupied-path argument — NO rename-claim); regular-file gate on config
   (symlink ⇒ lane disabled, surfaced) at B1 AND locked B2; bounded ≤1MiB+1
   reads at every read site; optimistic-CAS candidate build UNLOCKED with
   incarnation-named unique candidates, final-path re-open fsync, B2==B1
   literal byte compare, owner re-check before rename; orphan sweep only for
   dead SAME-HOST incarnations; fresh-target plain path. Deterministic unit
   tests per §11 lock/transaction list (two-reaper fence, pid-reuse,
   symlinked config, foreign/unknown ⇒ never removed, growth past cap, etc.).
4. §6 lane state per design v10: per-repo RepoRecord with repoGen (generation
   equality is THE CAS — no hashing/record equality), sourceSeq, exact
   sidecar values, lane fields; save packets with expectedStream +
   stateNonce + bidirectional source atomicity (stale global rejects the
   whole packet) + immediate in-operation recompute; file-only global
   candidate with gitRepos reconstruction; no-op site emits per-repo
   transitions only; the WORKSPACE SYNC MUTEX with the COMPLETE owner set (daemon pump
   iterations; push/pull/sync; recover; ignore --purge at the command
   decision boundary with post-confirmation recomputation under the mutex;
   init/setup first-sync; reset/rebind) + the export-cmd staging-pull
   exemption + the static caller-enumeration drift test; CLI contender =
   loud exit, DAEMON contender = re-queue tick with backoff (wakeup never
   consumed); daemon revalidates stream+stateNonce each iteration start;
   save packets carry expectedNonce (loaded nonce or the "legacy" sentinel,
   matching only nonce-less state); resetSyncState under the sync mutex +
   state lock regenerating stateNonce; GitPushPlan
   gains authoredCfgHashByRepo populated ONLY on presence/edit publication
   or a real owned recapture WHOSE CONFIG WAS EMBEDDED ON THE WIRE
   (over-bounds/carried/deferred/pending/non-owned/dropped = NO entry),
   stamped at the ACK site alone. Truth-table tests incl. BOTH pinned
   traces + unrelated-ACK + all §11 transactional-unit interleavings.
5. §6 push lane: predicate at every exit in the coverage table (slow carry,
   trusted fast carry via cachedLocalCfg + cache entry version bump, defers,
   non-owned carries); carried-section config patch; status mirror parity.
6. §6 pull lane: apply predicate ahead of BOTH unchanged shortcuts and the
   pending-clear; combined-change apply inside applyGitState's mutation
   boundary; config-only failure → gitPendingRemote + old base; conflict
   checkpoint pinned.
7. Capture embed (§6 real-capture row + §9 ownership gate + §3 credential
   skip + §7 stability bracket).
8. E2E suite per §11 (two-root real sync loop — follow the existing e2e
   harness patterns in src/cli/git-sync.test.ts / e2ee-sync.test.ts).

## Acceptance criteria (all must pass)

1. Every §11 unit + transaction + E2E case implemented and green.
2. Full `bun test ./src/` green (no new failures vs main) and
   `bun run typecheck` green.
3. File scope = design doc §12 (includes src/cli/config.ts, status-cmd.ts,
   track-cmd.ts/init-cmd.ts reset callers, rig scenarios). NO server
   (apps/api) changes — this is client-only by design.
4. Existing pinned tests stay green UNMODIFIED unless the doc explicitly
   supersedes one — if you believe a pinned test must change, STOP and record
   it in IMPLEMENTATION_NOTES.md with the justification instead of changing it.
5. IMPLEMENTATION_NOTES.md: per-step notes, any doc↔code drift found, test
   evidence, anything you had to decide that the doc did not specify (flag
   these LOUDLY — they are review targets).

## Step 8b (after E2E): rig scenario

Add `scripts/rig/scenarios/git-config-sync.ts` (register in
`scenarios/index.ts`), cloned from `git-entanglement.ts` scaffolding — see
GATES.md Lane 1 for the exact scenario shape. It must pass via
`bun run rig run git-config-sync` (rig runs the worktree source directly).
If `bun run rig doctor` fails on this machine, note it in
IMPLEMENTATION_NOTES.md and do NOT block the other acceptance criteria.
