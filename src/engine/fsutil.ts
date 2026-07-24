import fs from "node:fs/promises";
import path from "node:path";

/** Prefix for transient temp files. Ignore-listed (see ignore.ts) so a crashed
 *  temp left beside a real file is never scanned into a manifest. */
export const RBOX_TMP_PREFIX = ".rbox-tmp-";

let counter = 0;

/** The errno string of a Node filesystem error, or undefined for a value that
 *  is not an errno-bearing exception. Single source for the per-file errno
 *  classification hand-rolled across the engine. */
export function errCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** The target does not exist: ENOENT, or ENOTDIR when a parent component is a
 *  file (or was evicted). Both mean "not there" to a caller resolving a path. */
export function isAbsent(e: unknown): boolean {
  const code = errCode(e);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A name-claim collided: the destination already exists (EEXIST). */
export function isEEXIST(e: unknown): boolean {
  return errCode(e) === "EEXIST";
}

/**
 * Write `data` to `absPath` atomically: stage to a sibling temp, fsync it, then
 * rename over the target. A crash can leave a temp (ignore-listed) but never a
 * half-written real file. Same-directory temp guarantees the rename is on one
 * filesystem (rename across filesystems is not atomic).
 */
export async function writeFileAtomic(
  absPath: string,
  data: string | Uint8Array,
  opts: {
    beforeTempCreate?: () => void | Promise<void>;
    beforeRename?: () => boolean | Promise<boolean>;
    mode?: number;
    flag?: string;
    /** Opt-in exact mode enforcement for secret material; ordinary callers keep umask semantics. */
    exactMode?: boolean;
    /** Internal fault-observation hook used by persistence tests. */
    onStep?: (step: "temp-opened" | "temp-written" | "temp-synced" | "temp-closed" | "before-rename" | "after-rename") => void | Promise<void>;
  } = {}
): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `${RBOX_TMP_PREFIX}${process.pid}-${counter++}-${path.basename(absPath)}`);
  let fh: fs.FileHandle | undefined;
  try {
    try {
      await opts.beforeTempCreate?.();
      fh = await fs.open(tmp, opts.flag ?? "w", opts.mode);
      await opts.onStep?.("temp-opened");
      await fh.writeFile(data);
      await opts.onStep?.("temp-written");
      if (opts.exactMode && opts.mode !== undefined) await fh.chmod(opts.mode);
      await fh.sync(); // durability: bytes hit disk before the rename publishes them
      await opts.onStep?.("temp-synced");
    } finally {
      await fh?.close();
      await opts.onStep?.("temp-closed");
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  let publish = true;
  try {
    publish = opts.beforeRename ? await opts.beforeRename() : true;
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  if (!publish) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return;
  }
  try {
    await opts.onStep?.("before-rename");
    await fs.rename(tmp, absPath);
    await opts.onStep?.("after-rename");
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Flush directory metadata after publishing or removing an entry. Callers choose
 * whether durability failure is fatal; the file-handle lifecycle is shared here. */
export async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Create a plain-directory chain without following a symlink at any existing
 * component. Returns the directories created by this call for durability
 * publication by {@link fsyncCreatedDirectoryAncestors}. */
export async function ensureDirectoryChain(abs: string, description = "directory"): Promise<Set<string>> {
  const missing: string[] = [];
  let probe = path.resolve(abs);
  for (;;) {
    try {
      const stat = await fs.lstat(probe);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe ${description}: ${probe}`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(probe);
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`${description} has no existing ancestor: ${abs}`);
      probe = parent;
    }
  }
  const created = new Set<string>();
  for (const dir of missing.reverse()) {
    try {
      await fs.mkdir(dir, { mode: 0o700 });
      created.add(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe ${description}: ${dir}`);
    }
  }
  return created;
}

/** Publish each newly-created child entry bottom-up through the first ancestor
 * that predated {@link ensureDirectoryChain}. */
export async function fsyncCreatedDirectoryAncestors(dir: string, created: ReadonlySet<string>): Promise<void> {
  let child = path.resolve(dir);
  while (created.has(child)) {
    const parent = path.dirname(child);
    await fsyncDirectory(parent);
    child = parent;
  }
}

/** Refuse to operate on a path whose real parent escapes the workspace — e.g. a
 *  synced symlink `foo -> /etc` followed by a file entry `foo/passwd`. Static
 *  manifest validation can't catch this (it's runtime FS state), so this is the
 *  complementary runtime guard. */
export async function assertWithinRoot(destRoot: string, abs: string): Promise<void> {
  const rootReal = await fs.realpath(destRoot);
  let probe = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`refusing to write outside workspace via symlinked parent: ${abs}`);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(probe);
        if (parent === probe) return; // reached FS root without escaping
        probe = parent;
        continue;
      }
      throw e;
    }
  }
}

/** Optional observation hooks for {@link moveNoClobber}'s directory branch — the
 *  apply path threads its stat counters through these so fsutil stays free of any
 *  dependency on the apply-stats module. Absent, the branch behaves identically. */
export interface MoveNoClobberHooks {
  /** Fired once the directory-name mkdir settles (`created` = it succeeded). */
  onMkdir?: (created: boolean) => void;
  /** Fired after the directory rename lands. */
  onRename?: () => void;
}

/** Move `from` to `to` iff `to` does not exist, ATOMICALLY (no check-then-rename
 *  window): files hard-link (EEXIST-atomic) then drop the source; symlinks
 *  recreate via symlink(2) (EEXIST-atomic); directories claim the name with
 *  mkdir (EEXIST-atomic) then rename over the just-made empty dir (POSIX allows
 *  dir→empty-dir). Returns false when the name was already taken. Implements the
 *  "conflict copies never overwrite" invariant: every destination claim is
 *  exclusive at the filesystem operation itself, avoiding access-then-rename races. */
export async function moveNoClobber(
  from: string,
  to: string,
  st: { isDirectory(): boolean; isSymbolicLink(): boolean },
  hooks: MoveNoClobberHooks = {},
): Promise<boolean> {
  try {
    if (st.isDirectory()) {
      let ok = false;
      try {
        await fs.mkdir(to);
        ok = true;
      } finally {
        hooks.onMkdir?.(ok);
      }
      await fs.rename(from, to);
      hooks.onRename?.();
    } else if (st.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(from), to);
      await fs.unlink(from);
    } else {
      await fs.link(from, to);
      await fs.unlink(from);
    }
    return true;
  } catch (e) {
    if (isEEXIST(e)) return false;
    throw e;
  }
}

/** Claim the first free `~N`-suffixed name for an atomic no-clobber move: try
 *  `baseRel`, then `baseRel~2`, `baseRel~3`… (a conflict copy must never clobber
 *  an EARLIER copy — conflict names are second-precision, so same-second twins
 *  collide). `toAbs` resolves each candidate to its absolute path; `prepare` runs
 *  per candidate BEFORE the move attempt (e.g. mkdir parents / within-root guard);
 *  `hooks` thread {@link moveNoClobber}'s directory counters. Returns the
 *  workspace-relative name actually claimed. */
export async function claimUnclobberedName(opts: {
  from: string;
  st: { isDirectory(): boolean; isSymbolicLink(): boolean };
  baseRel: string;
  toAbs: (rel: string) => string;
  prepare?: (rel: string, abs: string) => void | Promise<void>;
  hooks?: MoveNoClobberHooks;
}): Promise<string> {
  let rel = opts.baseRel;
  for (let i = 2; ; i++) {
    const abs = opts.toAbs(rel);
    await opts.prepare?.(rel, abs);
    if (await moveNoClobber(opts.from, abs, opts.st, opts.hooks)) return rel;
    rel = `${opts.baseRel}~${i}`;
  }
}
