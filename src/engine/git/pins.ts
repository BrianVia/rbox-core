import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HEX40, type RepoCtx, git, gitOk } from "./shared.js";

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

/** Pin every commit the section will reference under a CAPTURE-UNIQUE namespace
 *  `refs/rbox-wip/<epochMs>-<rand>/<n>`: linked worktrees share one ref store, so a
 *  single global scratch ref would race under concurrent sibling captures [v2, B2]. */
export async function createScratchPins(repoDir: string, shas: string[]): Promise<ScratchPins> {
  const ns = `${WIP_NS}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const refs: string[] = [];
  try {
    let n = 0;
    for (const sha of shas) {
      const ref = `${ns}/${n++}`;
      await git(repoDir, ["update-ref", ref, sha]);
      refs.push(ref);
    }
  } catch (e) {
    await deleteScratchPins(repoDir, { refs });
    throw e;
  }
  return { refs };
}

export async function deleteScratchPins(repoDir: string, pins: ScratchPins): Promise<void> {
  for (const ref of pins.refs) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
}

/** Prune stale scratch refs left by CRASHED runs — AGE-GUARDED [v3]: only entries whose
 *  `<epochMs>-<rand>` id is older than 1h are deleted. A blind prune in a SHARED gitdir
 *  would delete a concurrent sibling capture's live pins. */
export async function pruneStaleScratchRefs(repoDir: string, ns: string): Promise<void> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", ns]).catch(() => "");
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const ref of out.split("\n").filter(Boolean)) {
    if (ref === ns) {
      // legacy pre-§43 exact ref (`refs/rbox-wip`) from a crashed old capture — it D/F-blocks
      // the namespaced refs below and old clients only ever ran on unshared root repos, so
      // deleting it blindly is safe (and matches the old cleanup).
      await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
      continue;
    }
    const id = ref.slice(ns.length + 1).split("/")[0] ?? "";
    const epoch = Number.parseInt(id, 10);
    if (Number.isFinite(epoch) && epoch < cutoff) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
  }
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
