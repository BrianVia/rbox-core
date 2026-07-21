# Fold plan — design 175 round 1 (pre-drafted on Opus findings; merge codex R1 before applying)

Rulings (Opus R1):

1. **F1 lock-predicate contradiction — ACCEPT.** New exported predicate
   `isGitRefSideChannelSignal(rootKind, basename)` (basename-shaped, per watch
   root), built on the SAME tail table as `isSignalTail` (shared const table,
   not copied logic) + lock-inclusive acceptance. Invariant 3 re-scoped:
   "single truth" = (a) file-plane exclusion is owned by the hard-exclude,
   (b) the ref tail TABLE is shared between `isGitRefSignal` and the
   side-channel predicate, proven by a shared-table equivalence test on the
   non-lock subset. `isGitRefSignal` itself is UNCHANGED (macOS/main-path
   behavior preserved → invariant 6 intact).
2. **F2 telemetry provenance — ACCEPT-MODIFIED.** Add push provenance
   mirroring the pull `Carrier` pattern: `queuedPushProvenance` with
   precedence `signal > candidate > scan > other`, raised at `request()`
   time, consumed at pump time, reset per push. Attribution is PER-PUSH (not
   per-capture); a scan that co-requests a push while a signal is queued
   attributes to `signal` (precedence, deterministic). Counters:
   `git_capture { signalPushes, scanPushes }` — renamed to match per-push
   semantics. Test: raise orders, assert precedence + reset.
3. **F3 floor eligibility — ACCEPT.** `eligible := (in-tree repo of kind
   "dir") OR (any side-channel root in state armed|attaching|failed)`.
   Pointer-only / out-of-root repos do NOT pin (preserves 172 shipped
   semantics — explicit note). Set recomputed on every reconcile AND on
   safety-scan completion (repo removal is not push-gated). Zero-repo
   workspace releases the pin (test).
4. **F4 arming seam — ACCEPT-MODIFIED (design change).** DROP push-result
   threading entirely (no `GitPushPlan` change; genesis + blocked-push gaps
   vanish). Registry discovery is watcher/daemon-owned:
   (a) initial: the existing watcher-start `discoverGitRepos` walk feeds the
   first reconcile (contexts via `repoCtxFromDisk` at that point);
   (b) repo-candidate signal → debounced TARGETED discovery of the candidate
   subtree only;
   (c) full re-discovery on safety-scan completion (cheap, ignore-pruned,
   already the scan cadence).
   Arm-then-push handshake unchanged, and per Opus F7 the handshake push MUST
   be a real `planGitSections` push (fresh fingerprints), stated normatively.
5. **F5 candidate predicate — ACCEPT.** Exact path-segment `=== ".git"` (dir
   or pointer file), same as `git-discover.ts`; candidate signals ride the
   SAME SignalDebouncer; discovery-negative candidates are cheap no-ops
   (stated).
6. **F6 upgrade gate wiring — ACCEPT.** Concrete: new required CI job
   `bun-refwatch-contract` (ubuntu runner, the repo's pinned Bun version,
   runs `bun scripts/probe/bun-refwatch-contract.ts`); release safety comes
   from the exact-SHA main-CI gate already in release.yml. Rig Dockerfile
   1.3.5 → 1.3.14 in this PR. Probe stays platform-agnostic in code but the
   GATE is Linux-only (macOS run proves nothing — stated).
7. **F7 handshake caveat — ACCEPT** (folded into #4).
8. **F8 silent modes — ACCEPT.** State plainly: descendant-add-failure and
   overflow are not injectable; their safety rests on the floor-retention
   tests. ADD a product-level integration flood test (registry + debouncer +
   daemon seam under Parcel churn, reusing probe harness technique).
9. **F9 macOS normative line — ACCEPT.** "Implementation MUST keep the
   `process.platform === 'linux'` gate on both the registry construction and
   the floor pin; macOS creates zero side-channel handles."
