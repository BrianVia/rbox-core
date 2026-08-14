import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../../engine/fsutil.js";
import { type RepoCtx, exists } from "./git-state.js";
import { git } from "../../engine/git-spawn.js";
import { pruneEmptyOpStateDirs, readAllRefs, readOpState } from "./refs.js";

export interface LocalSnapshot {
  refs: Record<string, string>;
  head: string;
  indexBytes?: Buffer;
  opState: Record<string, Buffer>;
  /** Bytes of the refs/stash REFLOG (logs/refs/stash), if present. Publishing
   *  refs/stash appends a reflog entry (--create-reflog) — a rolled-back apply must
   *  not leak remote entries into `git stash list`. */
  stashReflog?: Buffer;
}
export async function snapshotLocal(ctx: RepoCtx): Promise<LocalSnapshot> {
  const refs = await readAllRefs(ctx.repoDir);
  const head = (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const indexBytes = (await exists(path.join(ctx.gitDir, "index"))) ? await fs.readFile(path.join(ctx.gitDir, "index")) : undefined;
  const opState: Record<string, Buffer> = {};
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) opState[rel] = await fs.readFile(path.join(ctx.gitDir, rel));
  const stashReflog = await fs.readFile(path.join(ctx.commonDir, "logs", "refs", "stash")).catch(() => undefined);
  return { refs, head, indexBytes, opState, stashReflog };
}
/** Roll back to the pre-apply snapshot. For a POINTER target, `onlyRefs` restricts the
 *  ref restore to exactly the refs the apply touched — a full reset would clobber
 *  concurrent sibling-worktree ref updates in the SHARED store. */
export async function restoreLocal(ctx: RepoCtx, snap: LocalSnapshot, onlyRefs?: Set<string>, skipRefs: ReadonlySet<string> = new Set()): Promise<void> {
  if (onlyRefs) {
    for (const ref of onlyRefs) {
      if (skipRefs.has(ref)) continue;
      const sha = snap.refs[ref];
      if (sha) await git(ctx.repoDir, ["update-ref", ref, sha]).catch(() => {});
      else await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
    }
  } else {
    // Reset syncable refs to the snapshot.
    for (const ref of Object.keys(await readAllRefs(ctx.repoDir))) if (!skipRefs.has(ref) && !(ref in snap.refs)) await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
    for (const [ref, sha] of Object.entries(snap.refs)) if (!skipRefs.has(ref)) await git(ctx.repoDir, ["update-ref", ref, sha]).catch(() => {});
    // The stash REFLOG must match the snapshot too: the publish appends an entry
    // (--create-reflog) that `git stash list` would still show after a bare ref rollback.
    const stashLog = path.join(ctx.commonDir, "logs", "refs", "stash");
    if (snap.stashReflog) {
      await fs.mkdir(path.dirname(stashLog), { recursive: true }).catch(() => {});
      await writeFileAtomic(stashLog, snap.stashReflog);
    } else {
      await fs.rm(stashLog, { force: true }).catch(() => {});
    }
  }
  if (snap.head) await writeFileAtomic(path.join(ctx.gitDir, "HEAD"), snap.head.endsWith("\n") ? snap.head : `${snap.head}\n`);
  if (snap.indexBytes) await writeFileAtomic(path.join(ctx.gitDir, "index"), snap.indexBytes);
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) if (!(rel in snap.opState)) await fs.rm(path.join(ctx.gitDir, rel), { force: true }).catch(() => {});
  for (const [rel, bytes] of Object.entries(snap.opState)) {
    await fs.mkdir(path.dirname(path.join(ctx.gitDir, rel)), { recursive: true });
    await writeFileAtomic(path.join(ctx.gitDir, rel), bytes);
  }
  await pruneEmptyOpStateDirs(ctx.gitDir, Object.keys(snap.opState));
}
