import fs from "node:fs/promises";
import path from "node:path";
import {
  applyGitState,
  assertGitTargetWithinRoot,
  captureGitState,
  discoverGitRepos,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  isGitBusy,
  preserveGitConflict,
  projectIdentity,
  quarantineAndWipeGitState,
  poolMap,
  MAX_GIT_REPOS,
  type GitIdentity,
  type GitRefScope,
  type GitSection,
  type IgnoreMatcher,
  type Manifest,
  type BlobStore,
} from "../engine/index.js";
import type { SyncState, WorkspaceConfig } from "./config.js";
import type { SyncRemote } from "./remote.js";

// ---- git-sync orchestration (design 43 §§6-7, 9, 13.5) ------------------------------
//
// Extracted from sync.ts so the FILE-sync flow there reads top-to-bottom: this module owns
// the per-repo git plan machinery (push), the per-repo apply loop (pull), and the git
// bookkeeping state transitions. Its interface is narrow and typed — planGitSections /
// applyGitSections take explicit inputs (root, cfg, state, …) and never reach back into
// sync.ts internals. Every [v2]…[v6] codex-rule citation is load-bearing and stays attached
// to the logic it governs.

/** Bundling is CPU/IO heavy — bound concurrent captures (design 43 §6.3). */
const GIT_CAPTURE_CONCURRENCY = 4;

/** The push-side new-repo admission cap (design 43 §3 [v2, M4]). Env-overridable for
 *  tests/tuning; the manifest-validation bound stays the hard MAX_GIT_REPOS. The cap
 *  bounds capture WORK for newly-discovered repos — base-carrying repos are ALWAYS
 *  carried, so over-cap can never read as mass deletion on receivers. */
const gitRepoCap = (): number => {
  const n = Number(process.env.RBOX_GIT_REPO_CAP);
  return Number.isInteger(n) && n >= 1 && n <= MAX_GIT_REPOS ? n : MAX_GIT_REPOS;
};

const repoDirOf = (root: string, relPath: string) => (relPath === "." ? root : path.join(root, relPath));
/** The narrower of two ref scopes ("scoped" ⊂ "all") — the projection target for every
 *  cross-scope identity comparison (design 43 §7). */
const narrowerScope = (a: GitRefScope, b: GitRefScope | undefined): GitRefScope => (a === "scoped" || b === "scoped" ? "scoped" : "all");
const projectedKey = (g: GitSection | GitIdentity | undefined, scope: GitRefScope): string => gitIdentityKey(g ? projectIdentity(g, scope) : undefined);
/** Every ciphertext address a git section references (bundle + index + op-state). */
const sectionEncShas = (s: GitSection): string[] => [s.bundleEncSha, ...(s.indexEncSha ? [s.indexEncSha] : []), ...Object.values(s.opState ?? {}).map((r) => r.encSha)];
const emptyToUndef = <T,>(o: Record<string, T>): Record<string, T> | undefined => (Object.keys(o).length ? o : undefined);
const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Local-vs-base divergence, projected onto the narrower of the two scopes (§7).
 *  No base → ANY local git identity is divergence-from-nothing (an independently
 *  created local repo must never be clobbered). No local identity (no repo, empty
 *  repo, deleted/unusable `.git`) → never diverged: there is no committed local work
 *  to preserve, so a clean (re)materialization loses nothing. */
function localDivergedFromBase(localId: GitIdentity | undefined, base: GitSection | undefined): boolean {
  if (!localId) return false;
  if (!base) return true;
  const n = narrowerScope(localId.refScope, base.refScope);
  return projectedKey(localId, n) !== projectedKey(base, n);
}

/** The outcome of push-side git orchestration: the outbound `gitRepos` map, whether it
 *  differs from what the last commit carried, the local-only state after this cycle
 *  (persisted only on a successful commit — recomputed idempotently otherwise), and
 *  the forensic counts for the §10 log line. */
export interface GitPushPlan {
  gitRepos?: Record<string, GitSection>;
  changed: boolean;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
  captured: string[];
  carried: string[];
  deferred: Array<{ relPath: string; reason: string }>;
  removed: string[];
}

/**
 * Push-side git orchestration (design 43 §6): discover every repo in the tree, then per
 * repo either CARRY (pending section, needs-resolution checkpoint, or unchanged identity
 * per the §7 shape×scope matrix), CAPTURE (bounded pool), DEFER with base carry (any
 * per-repo failure — never abort the push), or REMOVE (repo dir gone entirely, §9).
 * `force` is the per-relPath 422 recapture set [v2, M5]: forced repos skip the carry
 * fast-path; a forced repo that cannot recapture is DROPPED from this commit (the
 * non-looping failure path [v3]) rather than re-referencing blobs the server lost.
 */
export async function planGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  api: SyncRemote,
  force: ReadonlySet<string>,
  matcher: IgnoreMatcher
): Promise<GitPushPlan> {
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const captured: string[] = [];
  const carried: string[] = [];
  const removed: string[] = [];
  const deferred: Array<{ relPath: string; reason: string }> = [];
  const out: Record<string, GitSection> = {};
  const plan = (): GitPushPlan => {
    // Changed = the outbound map differs from what the LAST COMMIT carried. For a
    // pending repo the last commit carried the pending section itself (see the per-repo
    // base-advance in pushManifest), so the expected-previous map is base ∪ pending —
    // a steady pending carry is NOT a change (no echo-commit storm).
    const prev: Record<string, GitSection> = { ...base, ...(state.gitPendingRemote ?? {}) };
    let changed = false;
    for (const k of new Set([...Object.keys(out), ...Object.keys(prev)])) {
      if (!out[k] || !prev[k] || (out[k] !== prev[k] && JSON.stringify(out[k]) !== JSON.stringify(prev[k]))) {
        changed = true;
        break;
      }
    }
    return {
      gitRepos: emptyToUndef(out),
      changed,
      gitReposRemoved: emptyToUndef(removedMem),
      gitNeedsResolution: emptyToUndef(needsRes),
      gitPendingRemote: emptyToUndef(pending),
      captured,
      carried,
      deferred,
      removed,
    };
  };
  if (!cfg.syncGit) {
    // Opt-out: out stays empty → any base entries read as removal (the opt-out
    // propagates), and the local-only bookkeeping is abandoned with it — a surviving
    // pending entry would otherwise re-trigger the per-repo base restore every push
    // (changed forever → echo-commit loop).
    for (const k of Object.keys(pending)) delete pending[k];
    for (const k of Object.keys(needsRes)) delete needsRes[k];
    for (const k of Object.keys(removedMem)) delete removedMem[k];
    return plan();
  }
  if (!cfg.kek) throw new Error("git-sync requires an encryption key (E2EE)"); // §28: artifacts are encrypted
  const kek = cfg.kek;

  const discovered = await discoverGitRepos(root, matcher);
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));

  // §9: removal memories are pruned ONLY when the local `.git` genuinely disappears —
  // never on mere discovery absence (an ignored-but-present leftover is undiscoverable
  // yet must keep its resurrection guard for when it is unignored; codex step-3 MAJOR).
  for (const rel of Object.keys(removedMem)) {
    if (kindByPath.has(rel)) continue;
    const dotGit = await fs.lstat(path.join(repoDirOf(root, rel), ".git")).catch(() => undefined);
    if (!dotGit) delete removedMem[rel];
  }

  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base), ...Object.keys(pending)])].sort();
  // New-repo admission budget [v2, M4]: base/pending repos never count as new work.
  const cap = gitRepoCap();
  let admitted = new Set([...Object.keys(base), ...Object.keys(pending)]).size;

  const toCapture: string[] = [];
  /** Per-repo failure → defer. Forced (422) repos take the M5 non-looping DROP instead:
   *  their base section references exactly the blobs the server lost, so carrying it
   *  would 422 forever — drop from THIS commit; the daemon re-captures when possible. */
  const deferOne = (rel: string, reason: string) => {
    if (force.has(rel)) {
      deferred.push({ relPath: rel, reason: `${reason} — section dropped from this commit (its blobs are missing server-side)` });
      return;
    }
    const b = base[rel];
    if (b) out[rel] = b; // defer-with-base-carry: never regress a synced repo (§6.4)
    deferred.push({ relPath: rel, reason });
  };

  for (const rel of keys) {
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    const pend = pending[rel];

    // Pending unapplied remote [v5]: carry THE PENDING SECTION (the newest known truth),
    // capture suppressed. 422-while-pending [v6] → M5 drop; the pending entry stays for
    // the next pull to refresh (remote re-establishes it or absence-supersedes clears it).
    if (pend) {
      if (force.has(rel)) {
        deferred.push({ relPath: rel, reason: "pending remote section's blobs are missing server-side — dropped this commit; the next pull refreshes it" });
      } else {
        out[rel] = pend;
        carried.push(rel);
      }
      continue;
    }

    if (!kind) {
      if (!baseSec) continue; // never synced, nothing local → nothing to do
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirPresent) {
        // §9: repo dir GONE ENTIRELY → the pusher drops the section (receivers drop
        // their base entry but never touch local .git).
        removed.push(rel);
        delete needsRes[rel];
        continue;
      }
      deferOne(rel, "no usable .git (deleted or unsupported shape) — carrying base");
      continue;
    }

    // Quiescence before ANY identity-based decision (mirrors the pull side): a lock
    // makes write-tree fail → raw-index identity fallback, which would spuriously
    // CLEAR a needsResolution suppression (republishing the conflicted state — the
    // exact [v2, M2] hazard) or a removal memory (resurrection), or re-capture a
    // mid-operation repo. Busy → defer with base carry; next cycle re-examines.
    if (await isGitBusy(repoDirOf(root, rel))) {
      deferOne(rel, "git busy (lock present)");
      continue;
    }

    // Removal memory [v2, B4]: a leftover whose identity still equals the memory is the
    // untouched residue of a remote deletion — NOT re-added. Identity changed → the
    // user worked there → re-adding is intentional; clear the memory and fall through.
    // An UNREADABLE leftover (dangling pointer, transient) keeps its guard and is
    // skipped — clearing on a transient would re-add unchanged git once it heals.
    if (!baseSec && removedMem[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (!id || gitIdentityKey(id) === removedMem[rel]) continue;
      delete removedMem[rel];
    }

    // needsResolution [v2, M2]: carry the checkpointed base until the local identity
    // CHANGES from the recorded conflict-time value (republish must be intentional).
    if (needsRes[rel] !== undefined) {
      const id = await gitIdentity(repoDirOf(root, rel));
      if (gitIdentityKey(id) === needsRes[rel]) {
        if (baseSec) {
          out[rel] = baseSec;
          carried.push(rel);
        }
        continue;
      }
      delete needsRes[rel];
    }

    const pf = await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) {
      // STRUCTURAL refusal (shallow/bare/alternates/…): the shape can't sync and won't
      // heal by waiting — DROP the section instead of carrying it. Carrying would be
      // permanent poison: identity can't see the structural property, so a base section
      // authored before the shape was detected (e.g. a shallow clone's incomplete
      // bundle, found by live validation) would carry — and fail-close on every
      // receiver — forever. Dropping self-heals: receivers clean their bookkeeping via
      // absence (never touching local .git), and when the user fixes the shape a fresh
      // preflight passes with no base tie to the old bad section.
      if (pf.structural) {
        if (baseSec) removed.push(rel);
        deferred.push({ relPath: rel, reason: `${pf.reason} — section ${baseSec ? "dropped" : "not captured"}` });
        delete needsRes[rel];
        continue;
      }
      deferOne(rel, pf.reason ?? "preflight failed");
      continue;
    }
    const id = await gitIdentity(repoDirOf(root, rel));
    if (!id) {
      // empty repo (no commits yet): nothing to capture; keep any synced base.
      if (baseSec) {
        out[rel] = baseSec;
        carried.push(rel);
      }
      continue;
    }

    // §7 capture-side carry-forward — the normative shape×scope matrix [v3; v4]:
    //   dir/all-base      → carry on full-identity match (design-02 semantics)
    //   dir/scoped-base   → ALWAYS capture fresh (a projected compare would hide a
    //                       genuinely new local branch forever)
    //   pointer/scoped    → carry on scoped-identity match
    //   pointer/all-base  → the explicit wider-carry exception: carry when the base's
    //                       SCOPED PROJECTION matches (terminates the convergence loop)
    if (baseSec && !force.has(rel)) {
      const carry =
        pf.kind === "dir"
          ? baseSec.refScope === "all" && gitIdentityKey(id) === gitIdentityKey(baseSec)
          : baseSec.refScope === "scoped"
            ? gitIdentityKey(id) === gitIdentityKey(baseSec)
            : gitIdentityKey(id) === projectedKey(baseSec, "scoped");
      if (carry) {
        out[rel] = baseSec;
        carried.push(rel);
        continue;
      }
    }
    if (!baseSec) {
      if (admitted >= cap) {
        deferred.push({ relPath: rel, reason: `over the ${cap}-repo cap — new repo not captured this cycle` });
        continue;
      }
      admitted++;
    }
    toCapture.push(rel);
  }

  // Changed repos: bounded-concurrency capture. Any per-repo failure defers THAT repo
  // (base carry) — the push itself always proceeds (PR #38 churn discipline).
  await poolMap(toCapture, GIT_CAPTURE_CONCURRENCY, async (rel) => {
    try {
      const sec = await captureGitState(repoDirOf(root, rel), api.blobStore(), kek);
      if (sec) {
        out[rel] = sec;
        captured.push(rel);
      } else {
        deferOne(rel, "capture returned nothing (repo vanished mid-capture or failed self-validation)");
      }
    } catch (e) {
      deferOne(rel, `capture failed: ${errMsg(e)}`);
    }
  });

  return plan();
}

/** Format the §10 forensic push line:
 *  `git-sync: captured N (a, b) · carried N · deferred N (p: reason) · removed N (x)` */
export function formatGitPushLine(plan: GitPushPlan): string {
  const names = (xs: string[]) => (xs.length ? ` (${xs.join(", ")})` : "");
  const defer = plan.deferred.length ? ` (${plan.deferred.map((d) => `${d.relPath}: ${d.reason}`).join("; ")})` : "";
  return `git-sync: captured ${plan.captured.length}${names(plan.captured)} · carried ${plan.carried.length} · deferred ${plan.deferred.length}${defer} · removed ${plan.removed.length}${names(plan.removed)}`;
}

/** Per-repo base advance (design 43 §7 [v5]): a PENDING repo's committed section is the
 *  remote's own unapplied truth — the saved git BASE must keep the OLD entry (or none)
 *  so the next pull still sees remote != base and retries the apply. Advancing the base
 *  to the pending section would make that pull read "unchanged" and clear pending
 *  without ever applying — silently regressing the other machine's work. */
export function gitBaseAfterCommit(
  committedGit: Record<string, GitSection> | undefined,
  pending: Record<string, GitSection> | undefined,
  baseGit: Record<string, GitSection> | undefined
): Record<string, GitSection> | undefined {
  const stateGit = { ...(committedGit ?? {}) };
  for (const rel of Object.keys(pending ?? {})) {
    const old = baseGit?.[rel];
    if (old) stateGit[rel] = old;
    else delete stateGit[rel];
  }
  return emptyToUndef(stateGit);
}

/** The per-relPath 422 recapture set [v2, M5]: ONLY the repos whose sections reference a
 *  missing (unsatisfied) encSha are force-recaptured — a missing GIT artifact can't be
 *  satisfied by a file re-upload, and the identity-carry would re-reference the absent
 *  bundle (§28, codex M3). A naive "recapture everything" would drop exactly the repos the
 *  defer machinery is protecting. */
export function gitForceForMissingBlobs(committedGit: Record<string, GitSection> | undefined, missing: Set<string>): Set<string> {
  const gitForce = new Set<string>();
  for (const [rel, sec] of Object.entries(committedGit ?? {})) {
    if (sectionEncShas(sec).some((s) => missing.has(s))) gitForce.add(rel);
  }
  return gitForce;
}

/** The pull-side git outcome: the per-repo base to persist plus the updated local-only maps. */
export interface GitPullOutcome {
  gitRepos?: Record<string, GitSection>;
  gitReposRemoved?: Record<string, string>;
  gitNeedsResolution?: Record<string, string>;
  gitPendingRemote?: Record<string, GitSection>;
}

/**
 * Pull-side git orchestration (design 43 §7, §9, §13.5): iterate
 * `remote.gitRepos ∪ base.gitRepos ∪ gitPendingRemote` per key. Per repo:
 *  - remote ABSENT → conflict-precedence first if a pending repo's local diverged
 *    (§13.5), then clear pending ([v6] absence supersedes pending), record a removal
 *    memory when the local `.git` survives, drop the base entry — NEVER touch local .git.
 *  - unchanged (projected onto the narrower scope) → base advances, no apply.
 *  - local diverged from base → per-repo CONFLICT: preserve remote, checkpoint base to
 *    remote, record `needsResolution` with the conflict-time local identity [v2, M2].
 *  - clean → applyGitState (containment + ignored-subtree refusal BEFORE any mutation);
 *    a removal-memory-matching leftover is treated as ABSENT → clean materialization
 *    (dir: quarantine + ref-wipe first; pointer: NEVER ref-wipe — guarded update-only).
 *  - deferred apply → record `gitPendingRemote`; that repo's base does not advance;
 *    every other repo advances independently.
 */
export async function applyGitSections(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  remote: Manifest,
  store: BlobStore,
  matcher: IgnoreMatcher,
  glog: (line: string) => void
): Promise<GitPullOutcome> {
  const baseRepos = state.lastSyncedManifest.gitRepos ?? {};
  const applied: Record<string, GitSection> = { ...baseRepos };
  const removedMem = { ...(state.gitReposRemoved ?? {}) };
  const needsRes = { ...(state.gitNeedsResolution ?? {}) };
  const pending = { ...(state.gitPendingRemote ?? {}) };
  const pack = (): GitPullOutcome => ({
    gitRepos: emptyToUndef(applied),
    gitReposRemoved: emptyToUndef(removedMem),
    gitNeedsResolution: emptyToUndef(needsRes),
    gitPendingRemote: emptyToUndef(pending),
  });
  if (!cfg.syncGit) return pack();
  const keys = [...new Set([...Object.keys(remote.gitRepos ?? {}), ...Object.keys(baseRepos), ...Object.keys(pending)])].sort();
  if (keys.length === 0) return pack();
  // Fail closed ONCE, before any per-repo work: git sections (incl. pending ones) are
  // E2EE artifacts — without the key nothing below can decrypt-verify.
  if (!cfg.kek && keys.some((k) => remote.gitRepos?.[k] !== undefined || pending[k] !== undefined)) {
    throw new Error("E2EE required: remote has git state but no key on this device — run `rbox pair`/`rbox recover`.");
  }

  const processRepo = async (rel: string): Promise<void> => {
    const remoteSec = remote.gitRepos?.[rel];
    const baseSec = baseRepos[rel];
    const pend = pending[rel];
    const repoDir = repoDirOf(root, rel);
    const dotGit = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);

    // Receiver quiescence (design 43 §7): a busy repo defers only itself, and the busy
    // check must run BEFORE any identity comparison — a lock makes write-tree fail,
    // flipping gitIdentity onto the raw-index fallback, which would read as FALSE
    // divergence (spurious conflict) or poison a removal memory with a transient key.
    const busy = dotGit !== undefined && (await isGitBusy(repoDir));
    if (busy && remoteSec) {
      pending[rel] = remoteSec; // apply needs quiescence — retry next pull; outbound carries newest truth
      glog(`git-sync deferred ${rel}: receiver git busy`);
      return;
    }
    // NOTE: remote ABSENCE is processed even when busy — it never mutates local .git,
    // and skipping it would leave gitPendingRemote/base carrying a section the remote
    // deleted, which the next file-only push would resurrect (codex step-3 BLOCKER).
    const localId = dotGit ? await gitIdentity(repoDir) : undefined;

    if (!remoteSec) {
      // §9 removal + [v6] absence-supersedes-pending. The DIVERGENCE EXAMINATION runs
      // first (§13.5: never stamp a removal memory over unexamined local divergence),
      // then the pure state transitions apply UNCONDITIONALLY — absence is the newer
      // truth no matter what else succeeds — and only then the best-effort recovery
      // preserve. Ordering is crash-safety (codex step-3 round-3 MAJOR): if the
      // preserve throws (blob/fs failure), the per-repo catch must not leave a stale
      // pending/base entry for the next push to resurrect.
      const diverged = pend !== undefined && localDivergedFromBase(localId, baseSec);
      delete pending[rel];
      delete needsRes[rel];
      if (rel in applied) {
        delete applied[rel];
        glog(`git-sync removed ${rel} (remote deleted; local .git untouched)`);
      }
      if (dotGit) {
        // Resurrection guard [v2, B4]: the leftover's identity at removal. On a BUSY
        // repo the live identity is the volatile raw-index fallback — record the base
        // section's identity instead (projected onto the leftover's shape), which is
        // lock-immune and equals the live identity whenever the leftover is untouched.
        removedMem[rel] =
          busy && baseSec ? projectedKey(baseSec, dotGit.isFile() ? "scoped" : "all") : gitIdentityKey(localId);
      }
      // §13.5 conflict precedence: the pending remote section is preserved for manual
      // recovery. Best-effort — preserve never mutates local branches/index/identity,
      // so a failure loses only the convenience recovery bundle (logged loudly); the
      // user's diverged local work is untouched either way. (On a busy repo the
      // raw-index fallback can only over-trigger this — a safe, logged no-clobber.)
      if (diverged && pend) {
        try {
          const { recoveryBundle } = await preserveGitConflict(repoDir, pend, store, cfg.kek!);
          glog(
            `git-sync CONFLICT ${rel} — remote deleted the repo while an apply was pending and local diverged; local kept, pending remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}`
          );
        } catch (e) {
          glog(`git-sync WARNING ${rel}: could not preserve the pending remote section after the remote deletion (local work untouched): ${errMsg(e)}`);
        }
      }
      return;
    }

    // Removal memory: a leftover whose identity still EQUALS the memory is treated as
    // ABSENT (clean materialization target [v3/v4]); a leftover that CHANGED re-enters
    // the normal rules (conflict path) with the memory cleared. An UNREADABLE pointer
    // leftover (dangling gitfile — identity unknowable) defers instead: guessing would
    // either wipe the guard or mis-run the conflict path.
    let cleanMaterialize = false;
    if (removedMem[rel] !== undefined) {
      if (!dotGit) {
        delete removedMem[rel]; // leftover gone → memory pruned; plain fresh target
      } else if (gitIdentityKey(localId) === removedMem[rel]) {
        cleanMaterialize = true;
      } else if (!localId && dotGit.isFile()) {
        pending[rel] = remoteSec;
        glog(`git-sync deferred ${rel}: leftover pointer repo unreadable — keeping removal memory`);
        return;
      } else {
        delete removedMem[rel]; // identity genuinely changed (incl. a re-init'd empty dir repo)
      }
    }

    // Projected identity comparison on the NARROWER of the two scopes (§7) — what makes
    // worktree→standalone→worktree round-trips converge without apply ping-pong.
    const cmpScope = narrowerScope(remoteSec.refScope, baseSec?.refScope);
    const remoteChanged = projectedKey(remoteSec, cmpScope) !== (baseSec ? projectedKey(baseSec, cmpScope) : "none");
    if (!remoteChanged && !pend) {
      applied[rel] = remoteSec; // unchanged → base advances (possibly across scopes)
      return;
    }

    // Already converged? (e.g. a pending retry finding the user manually resolved, or a
    // remote change that equals local work) → advance base, clear pending, no mutation.
    // A removal-memory leftover never takes this shortcut: it must go through the §9
    // clean-materialization path (wipe on dir targets) so stale refs can't survive.
    if (localId && !cleanMaterialize) {
      const n = narrowerScope(localId.refScope, remoteSec.refScope);
      if (projectedKey(localId, n) === projectedKey(remoteSec, n)) {
        applied[rel] = remoteSec;
        delete pending[rel];
        delete removedMem[rel];
        return;
      }
    }

    const kek = cfg.kek!; // guaranteed by the fail-closed gate above
    if (!cleanMaterialize && localDivergedFromBase(localId, baseSec)) {
      // Per-repo conflict: never auto-clobber local. Preserve remote for manual merge,
      // checkpoint base to remote (stop pull-conflict-looping), and suppress capture
      // until the local identity changes from this recorded value [v2, M2].
      const { recoveryBundle } = await preserveGitConflict(repoDir, remoteSec, store, kek);
      applied[rel] = remoteSec;
      needsRes[rel] = gitIdentityKey(localId);
      delete pending[rel];
      glog(`git-sync CONFLICT ${rel} — local kept; remote preserved at ${recoveryBundle ?? "refs/rbox-conflict/*"}. Resolve manually.`);
      return;
    }

    // Clean apply. Refusals and containment run BEFORE any mutation [v2, B5].
    const defer = (reason: string) => {
      pending[rel] = remoteSec; // [v5]: outbound pushes now carry THIS section; retry next pull
      glog(`git-sync deferred ${rel}: ${reason}`);
    };
    if (rel !== "." && (matcher.ignores(rel) || matcher.ignores(`${rel}/`))) {
      defer("target is inside an ignored subtree — refusing to materialize");
      return;
    }
    try {
      await assertGitTargetWithinRoot(root, rel);
    } catch (e) {
      defer(errMsg(e));
      return;
    }

    // Dir leftover clean materialization [v5]: quarantine (capture-grade pinning +
    // index/op-state copies) then wipe syncable refs/index/op-state, so the leftover's
    // old refs can never re-enter a later all-scope capture. Runs as applyGitState's
    // beforeMutate hook — i.e. ONLY after every remote artifact has been fetched,
    // decrypted, and verified — so a missing/corrupt bundle can never strand a wiped
    // repo (codex step-3 MAJOR). Hook/quarantine failure → defer, nothing wiped.
    // Pointer leftover: NEVER ref-wipe (shared main-clone store) — the guarded
    // update-only apply is the whole treatment; the memory clears on success.
    const wipeLeftover = cleanMaterialize && dotGit !== undefined && dotGit.isDirectory();
    const res = await applyGitState(
      repoDir,
      remoteSec,
      store,
      kek,
      wipeLeftover
        ? {
            beforeMutate: async () => {
              await quarantineAndWipeGitState(repoDir);
              delete removedMem[rel]; // leftover quarantined + wiped — the memory served its purpose
            },
          }
        : {}
    );
    if (res.applied) {
      // Belt-and-braces post-init containment re-verify (§7 [v2, B5; v3]).
      try {
        await assertGitTargetWithinRoot(root, rel);
      } catch (e) {
        glog(`git-sync WARNING ${rel}: post-apply containment check failed: ${errMsg(e)}`);
      }
      applied[rel] = remoteSec;
      delete pending[rel];
      delete removedMem[rel];
      glog(`git-sync applied ${rel}${res.filteredRefs?.length ? ` (filtered refs: ${res.filteredRefs.join(" ")})` : ""}`);
    } else {
      defer(res.reason ?? "apply deferred");
    }
  };

  for (const rel of keys) {
    try {
      await processRepo(rel);
    } catch (e) {
      // Per-repo failures defer only THAT repo — one bad repo (a blob missing mid
      // conflict-preserve, an ENOTDIR/hostile target, an fs error) must never abort
      // the whole pull or block the other repos' base advance.
      const remoteSec = remote.gitRepos?.[rel];
      if (remoteSec) pending[rel] = remoteSec;
      glog(`git-sync deferred ${rel}: ${errMsg(e)}`);
    }
  }
  return pack();
}

/**
 * READ-ONLY advisory count of repos whose LOCAL git state a push would publish —
 * the `rbox status` verdict's git dimension (design 45, codex R1). Mirrors
 * {@link planGitSections}'s per-repo capture decision (pending carry, removal
 * memories, needs-resolution suppression, preflight, the §7 shape×scope carry
 * matrix) without any of its work or side effects: no bundling, no state
 * mutation, no memory pruning. Two accepted approximations, both toward
 * UNDER-claiming "in sync" never over-claiming it: repos beyond the new-repo
 * admission cap still count (push defers them, but they ARE unpublished local
 * work), and a busy (locked) repo counts zero (indeterminate — status must not
 * guess). Identity reads use `git write-tree`, which may add unreferenced tree
 * objects — the same "harmless, like `git status`" footprint sync itself has.
 */
export async function gitDivergenceCount(
  root: string,
  cfg: WorkspaceConfig,
  state: SyncState,
  matcher: IgnoreMatcher
): Promise<number> {
  if (!cfg.syncGit) return 0;
  const base = state.lastSyncedManifest.gitRepos ?? {};
  const pending = state.gitPendingRemote ?? {};
  const needsRes = state.gitNeedsResolution ?? {};
  const removedMem = state.gitReposRemoved ?? {};
  const discovered = await discoverGitRepos(root, matcher);
  const kindByPath = new Map(discovered.map((d) => [d.relPath, d.kind]));
  const keys = [...new Set([...kindByPath.keys(), ...Object.keys(base)])].sort();

  let n = 0;
  for (const rel of keys) {
    if (pending[rel]) continue; // unapplied remote truth is carried, never local divergence
    const kind = kindByPath.get(rel);
    const baseSec = base[rel];
    if (!kind) {
      if (!baseSec) continue;
      // Repo dir gone entirely → push would publish the removal. Present-but-
      // undiscoverable (ignored leftover) → push carries; not divergence.
      const dirPresent = await fs
        .lstat(repoDirOf(root, rel))
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!dirPresent) n++;
      continue;
    }
    if (await isGitBusy(repoDirOf(root, rel))) continue; // indeterminate this instant
    const pf = await gitPreflight(repoDirOf(root, rel));
    if (!pf.ok) continue; // structural/transient refusal: push won't capture it either
    const id = await gitIdentity(repoDirOf(root, rel));
    if (!id) continue; // empty repo: nothing to capture, base (if any) carries
    const key = gitIdentityKey(id);
    if (!baseSec && removedMem[rel] !== undefined && key === removedMem[rel]) continue; // untouched removal residue
    if (needsRes[rel] !== undefined && key === needsRes[rel]) continue; // conflict-suppressed until touched
    if (!baseSec) {
      n++; // never-synced local repo → a push would publish it
      continue;
    }
    // The §7 capture-side carry matrix (see planGitSections for the normative copy).
    const carry =
      pf.kind === "dir"
        ? baseSec.refScope === "all" && key === gitIdentityKey(baseSec)
        : baseSec.refScope === "scoped"
          ? key === gitIdentityKey(baseSec)
          : key === projectedKey(baseSec, "scoped");
    if (!carry) n++;
  }
  return n;
}
