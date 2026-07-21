import fs from "node:fs/promises";
import path from "node:path";
import { type GitRepoKind, type RepoCtx, detectGitKind, exists, git, gitBusy, gitOk, repoCtx } from "./shared.js";

export interface GitPreflightResult {
  ok: boolean;
  reason?: string;
  kind?: GitRepoKind;
  /** True when the refusal is STRUCTURAL — the repo's shape cannot sync (shallow/bare/
   *  alternates/superproject/toplevel-mismatch) and won't heal by waiting. Push-side
   *  treats structural refusals as section DROPS (self-heals when the user fixes the
   *  shape: fresh preflight passes, no base ties to the old bad section), while
   *  transient refusals (busy, dangling pointer, vanished) defer-with-base-carry.
   *  Live-validation finding (design 43 §14 v6.1): a shallow clone's `bundle --all`
   *  silently omits history — the receiver fail-closes, but a carried shallow-authored
   *  section would retry-defer forever since identity can't see shallowness. */
  structural?: boolean;
}

/** Repository config is the sole authority for the ref-storage format. */
export async function gitRefStorage(repoDir: string): Promise<string | undefined> {
  try {
    const value = await git(repoDir, ["config", "--local", "--get", "extensions.refStorage"]);
    return value || undefined;
  } catch {
    return undefined;
  }
}

// ---- preflight (design 43 §4) ------------------------------------------------

/** Preflight: ordinary non-bare repos whose toplevel IS `repoDir` — as a real `.git`
 *  dir ("dir") or a gitfile worktree/submodule checkout ("pointer"). Dir-repos with
 *  linked worktrees (`.git/worktrees/`) are now ELIGIBLE (design 68 §3.1 — captured with
 *  `bundle --single-worktree --all`, apply guarded by the §3.2 collision defer); submodule
 *  superprojects (`.git/modules/`) stay refused (v1; explicitly unsupported [design 43 v2,
 *  M1]); alternates refused for both kinds (pointer: checked on the RESOLVED object store).
 *  Dangling pointers (main clone deleted) fail cleanly — the repo is skipped this cycle. */
export async function gitPreflight(repoDir: string, knownCtx?: RepoCtx | null): Promise<GitPreflightResult> {
  const kind = await detectGitKind(repoDir);
  if (!kind) {
    const st = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    if (!st) return { ok: false, reason: "no .git" };
    return { ok: false, reason: ".git is neither a directory nor a gitfile pointer — unsupported", structural: true };
  }
  if (knownCtx && knownCtx.kind !== kind) return { ok: false, reason: ".git kind changed during preflight", kind };
  const ctx = knownCtx === null ? undefined : knownCtx ?? (await repoCtx(repoDir));
  if (!ctx) {
    return { ok: false, reason: kind === "pointer" ? "dangling .git pointer (main clone missing?)" : "unreadable .git — unsupported", kind };
  }
  if (await gitRefStorage(repoDir) === "reftable") {
    return {
      ok: false,
      reason: "reftable ref storage is unsupported — convert this repository to files refs before syncing Git history",
      kind,
      structural: true,
    };
  }
  if (!(await gitOk(repoDir, ["rev-parse", "--is-inside-work-tree"]))) return { ok: false, reason: "not a work tree", kind, structural: true };
  if ((await git(repoDir, ["rev-parse", "--is-bare-repository"]).catch(() => "")) !== "false") return { ok: false, reason: "bare repo — unsupported", kind, structural: true };
  // A shallow (or promisor/partial) clone's object store is INCOMPLETE: `git bundle
  // create --all` silently produces a bundle missing parents beyond the shallow
  // boundary, which every receiver then fail-closes on ("did not send all necessary
  // objects" — found by design-43 live validation on a real shallow worktree clone).
  // Structural: refuse until the user unshallows (`git fetch --unshallow`).
  if ((await git(repoDir, ["rev-parse", "--is-shallow-repository"]).catch(() => "")) === "true") {
    return { ok: false, reason: "shallow clone — unsupported (git fetch --unshallow to sync history)", kind, structural: true };
  }
  const top = await git(repoDir, ["rev-parse", "--show-toplevel"]).catch(() => "");
  // git returns a realpath; the repo dir may contain symlinks (e.g. macOS
  // /var/folders -> /private/var/folders), so compare realpaths, not lexical paths.
  const dirReal = await fs.realpath(repoDir).catch(() => path.resolve(repoDir));
  const topReal = top ? await fs.realpath(top).catch(() => path.resolve(top)) : "";
  if (topReal !== dirReal) return { ok: false, reason: "repo toplevel != repo dir", kind, structural: true };
  if (kind === "dir") {
    // `worktrees` is deliberately ABSENT here (design 68 §3.1): a main clone with linked
    // worktrees now captures. `modules` (submodule superproject) + `alternates` stay refused.
    for (const bad of ["objects/info/alternates", "modules"]) {
      if (await exists(path.join(repoDir, ".git", bad))) return { ok: false, reason: `.git/${bad} present — unsupported`, kind, structural: true };
    }
  } else {
    // pointer: the object store is the main clone's — refuse if THAT uses alternates.
    if (await exists(path.join(ctx.commonDir, "objects", "info", "alternates"))) {
      return { ok: false, reason: "resolved gitdir uses objects/info/alternates — unsupported", kind, structural: true };
    }
  }
  return { ok: true, kind };
}

/**
 * Receiver quiescence probe (design 43 §7): is the repo mid-operation (index/HEAD
 * lock, gc, ref locks in the shared store)? Checked per repo BEFORE the pull-side
 * divergence comparison — a lock makes `write-tree` fail, which flips gitIdentity
 * onto the raw-index fallback and would otherwise read as false divergence (a
 * spurious CONFLICT where the design demands "a busy repo defers only itself").
 * A repo with no usable context is not busy (there is nothing to contend with).
 */
export async function isGitBusy(repoDir: string, knownCtx?: RepoCtx | null): Promise<boolean> {
  const ctx = knownCtx === null ? undefined : knownCtx ?? (await repoCtx(repoDir));
  if (!ctx) return false;
  return gitBusy(ctx);
}
