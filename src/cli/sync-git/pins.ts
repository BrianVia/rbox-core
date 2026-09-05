import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HEX40, type RepoCtx } from "./git-state.js";
import { git, gitOk } from "../../engine/git-spawn.js";

/** Op-state files whose contents are COMMIT shas that must be PINNED into the bundle's
 *  object closure (design 43 §5 [v2, B3]): `bundle create HEAD refs/heads/x` omits a
 *  MERGE_HEAD commit from another branch (codex repro), which would restore a pseudo-ref
 *  pointing at a missing object. AUTO_MERGE (a TREE) is pinned separately in
 *  collectPinShas; MERGE_MSG is plain text. */
const PSEUDO_REF_SHA_FILES = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "ORIG_HEAD",
  "rebase-merge/orig-head",
  "rebase-apply/orig-head",
];

export const WIP_NS = "refs/rbox-wip";
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000; // 1h — see pruneStaleScratchRefs

// ---- scratch-ref pinning (design 43 §5 [v2, B2/B3; v3]) ------------------------

export interface ScratchPins {
  /** enumerated exact refs, e.g. refs/rbox-wip/<epochMs>-<rand>/0 — a literal glob arg
   *  to `git bundle create` FAILS ("Refusing to create empty bundle"), so these are
   *  passed to the bundle EXPLICITLY, never as a wildcard. */
  refs: string[];
}

/** Optional daemon observation boundary for rbox-owned scratch-ref mutations.
 * Foreground capture has no observer and deliberately omits it. */
export interface OwnedRefMutationBoundary {
  enterOwnedRefMutation(repoDir: string): Promise<OwnedRefMutationLease | undefined>;
}

export interface OwnedRefMutationLease {
  /** Idempotent; observation failure must never turn a successful capture into a failure. */
  finish(): Promise<void>;
}

async function ownedUpdateRef(
  repoDir: string,
  args: string[],
  boundary?: OwnedRefMutationBoundary,
): Promise<void> {
  const lease = await boundary?.enterOwnedRefMutation(repoDir).catch(() => undefined);
  try {
    await git(repoDir, ["update-ref", ...args]);
  } finally {
    await lease?.finish().catch(() => {});
  }
}

/** Delete a set of rbox-owned refs in ONE `git update-ref --stdin` spawn instead of
 *  one spawn per ref (#863: 41 refs cost 64ms of pure spawn latency on the follow
 *  path, and a real FM pull spent 6.9s there).
 *
 *  Two properties of the old `for (…) update-ref -d <ref>` loop are preserved
 *  deliberately:
 *
 *  - A ref that VANISHED between enumeration and delete is not an error. Each
 *    `delete` line carries NO old-value, so git does not verify the ref exists —
 *    identical to `update-ref -d <ref>` without an old value, which exits 0 on a
 *    missing ref (verified, git 2.54).
 *  - A ref that genuinely FAILS (a concurrent `.lock`) must not take the others
 *    down with it. `--stdin` is a single transaction, so one locked ref aborts
 *    the whole batch and deletes nothing — where the old loop deleted everything
 *    it still could. The per-ref fallback restores exactly that tolerance; it
 *    costs one extra spawn only on the failing path, and deletes are idempotent,
 *    so re-running them over a partially applied transaction is safe.
 *
 *  `-z` so no refname can be misread as a quoted line. Ref-lock semantics are
 *  unchanged: update-ref honors them either way. */
export async function deleteRefsBatch(repoDir: string, refs: string[], boundary?: OwnedRefMutationBoundary): Promise<void> {
  if (refs.length === 0) return;
  const lease = await boundary?.enterOwnedRefMutation(repoDir).catch(() => undefined);
  try {
    // -z delete record: `delete SP <ref> NUL <old-value> NUL`, old-value empty = unverified.
    await git(repoDir, ["update-ref", "-z", "--stdin"], { stdin: refs.map((ref) => `delete ${ref}\0\0`).join("") })
      .catch(async () => {
        // Through `ownedUpdateRef`, not a third raw `update-ref` site (design 130).
        // No boundary: the lease above already covers the whole mutation, and
        // passing it here would re-enter one observation per ref.
        for (const ref of refs) await ownedUpdateRef(repoDir, ["-d", ref]).catch(() => {});
      });
  } finally {
    await lease?.finish().catch(() => {});
  }
}

/** Pin every commit the section will reference under a CAPTURE-UNIQUE namespace
 *  `refs/rbox-wip/<epochMs>-<rand>/<n>`: linked worktrees share one ref store, so a
 *  single global scratch ref would race under concurrent sibling captures [v2, B2]. */
export async function createScratchPins(repoDir: string, shas: string[], boundary?: OwnedRefMutationBoundary): Promise<ScratchPins> {
  if (shas.length === 0) return { refs: [] };
  const ns = `${WIP_NS}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const refs = shas.map((_, n) => `${ns}/${n}`);
  const lease = await boundary?.enterOwnedRefMutation(repoDir).catch(() => undefined);
  try {
    await git(repoDir, ["update-ref", "-z", "--stdin"], {
      stdin: shas.map((sha, n) => `create ${refs[n]!}\0${sha}\0`).join(""),
    });
  } catch (e) {
    await deleteScratchPins(repoDir, { refs });
    throw e;
  } finally {
    await lease?.finish().catch(() => {});
  }
  return { refs };
}

export async function deleteScratchPins(repoDir: string, pins: ScratchPins, boundary?: OwnedRefMutationBoundary): Promise<void> {
  await deleteRefsBatch(repoDir, pins.refs, boundary);
}

/** Prune stale scratch refs left by CRASHED runs — AGE-GUARDED [v3]: only entries whose
 *  `<epochMs>-<rand>` id is older than 1h are deleted. A blind prune in a SHARED gitdir
 *  would delete a concurrent sibling capture's live pins.
 *
 *  Returns how many refs it deleted, so a caller that times the prune can report
 *  the width behind that time (`refCleanupRefs`). */
export async function pruneStaleScratchRefs(repoDir: string, ns: string, boundary?: OwnedRefMutationBoundary): Promise<number> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", ns]).catch(() => "");
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  const stale = out.split("\n").filter(Boolean).filter((ref) => {
    // legacy pre-§43 exact ref (`refs/rbox-wip`) from a crashed old capture — it D/F-blocks
    // the namespaced refs below and old clients only ever ran on unshared root repos, so
    // deleting it blindly is safe (and matches the old cleanup).
    if (ref === ns) return true;
    const id = ref.slice(ns.length + 1).split("/")[0] ?? "";
    const epoch = Number.parseInt(id, 10);
    return Number.isFinite(epoch) && epoch < cutoff;
  });
  await deleteRefsBatch(repoDir, stale, boundary);
  return stale.length;
}

/** Objects the section references that a scoped bundle might not reach: the detached-HEAD
 *  sha (a bundle's HEAD advertisement is NOT imported by `git fetch 'refs/*:…'` — codex
 *  verified), every pseudo-ref COMMIT sha the op-state references, and the AUTO_MERGE
 *  TREE (ort writes it on conflict; restoring the file without its tree object leaves
 *  `git diff AUTO_MERGE` broken on the receiver — codex repro. A ref may point at a tree
 *  and `git bundle create` ships its closure — verified locally, git 2.50.1). Applied to
 *  DIR captures too (the pseudo-ref hole is latent in design 02: `--all` usually reaches
 *  those commits via a branch, but nothing guarantees it). Only shas whose objects verify
 *  are pinned — a stale pseudo-ref must not fail the whole bundle. */
export async function collectPinShas(ctx: RepoCtx, head: string, opStateRoot = ctx.gitDir): Promise<string[]> {
  const shas = new Set<string>();
  const h = head.trim();
  if (HEX40.test(h)) shas.add(h); // detached HEAD
  for (const rel of PSEUDO_REF_SHA_FILES) {
    const txt = await fs.readFile(path.join(opStateRoot, rel), "utf8").catch(() => "");
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (HEX40.test(s)) shas.add(s); // MERGE_HEAD may list several (octopus)
    }
  }
  const out: string[] = [];
  for (const s of shas) {
    if (await gitOk(ctx.repoDir, ["rev-parse", "--verify", "--quiet", `${s}^{commit}`])) out.push(s);
  }
  const autoMerge = (await fs.readFile(path.join(opStateRoot, "AUTO_MERGE"), "utf8").catch(() => "")).trim();
  if (HEX40.test(autoMerge) && !out.includes(autoMerge) && (await gitOk(ctx.repoDir, ["rev-parse", "--verify", "--quiet", `${autoMerge}^{tree}`]))) {
    out.push(autoMerge);
  }
  return out;
}
