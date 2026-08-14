import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { repoCtx } from "../cli/sync-git/git-state.js";
import { git } from "../engine/git-spawn.js";
import { isSafeRelPath } from "../engine/manifest-validate.js";
import {
  LINKED_WORKTREE_REFUSAL,
  readAdoptIdentity,
  type AdoptInventoryEntry,
  type AdoptSourceRepo,
} from "./adopt-journal.js";

export interface AdoptInventory {
  entries: AdoptInventoryEntry[];
  sourceRepos: AdoptSourceRepo[];
  retainedBytes: bigint;
  topLevel: string[];
}

function posixRel(root: string, abs: string): string {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!isSafeRelPath(rel)) throw new Error(`unsafe adoption inventory path: ${rel}`);
  return rel;
}

async function linuxMountPoints(): Promise<Set<string>> {
  if (process.platform !== "linux") return new Set();
  const raw = await fs.readFile("/proc/self/mountinfo", "utf8").catch(() => "");
  const unescape = (value: string) => value.replace(/\\040/g, " ").replace(/\\011/g, "\t").replace(/\\012/g, "\n").replace(/\\134/g, "\\");
  return new Set(raw.split("\n").filter(Boolean).map((line) => line.split(" ")[4]).filter((v): v is string => !!v).map(unescape).map((value) => path.resolve(value)));
}

function assertReadableDirectory(abs: string, mode: number): void {
  if ((mode & 0o555) === 0) throw new Error(`unreadable adoption source directory: ${abs}`);
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function probeOrdinaryRepo(root: string, repoDir: string): Promise<AdoptSourceRepo> {
  const ctx = await repoCtx(repoDir);
  if (!ctx || ctx.kind !== "dir") throw new Error(LINKED_WORKTREE_REFUSAL);
  const [rootReal, worktreeReal, gitDirReal, commonDirReal] = await Promise.all([
    fs.realpath(root), fs.realpath(repoDir), fs.realpath(ctx.gitDir), fs.realpath(ctx.commonDir),
  ]);
  const objectRaw = await git(repoDir, ["rev-parse", "--git-path", "objects"]);
  const objectStoreReal = await fs.realpath(path.resolve(repoDir, objectRaw));
  if (!inside(rootReal, worktreeReal) || !inside(worktreeReal, gitDirReal) || !inside(worktreeReal, commonDirReal) || !inside(worktreeReal, objectStoreReal)) {
    throw new Error(LINKED_WORKTREE_REFUSAL);
  }
  const alternates = path.join(objectStoreReal, "info", "alternates");
  const alternateStat = await fs.lstat(alternates).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  let alternateText = "";
  if (alternateStat) {
    if (!alternateStat.isFile() || alternateStat.isSymbolicLink()) throw new Error(`adoption source repository is not self-contained: ${repoDir}`);
    const handle = await fs.open(alternates, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { alternateText = await handle.readFile("utf8"); } finally { await handle.close(); }
  }
  for (const line of alternateText.split(/\r?\n/).filter(Boolean)) {
    const resolved = await fs.realpath(path.resolve(objectStoreReal, line));
    if (!inside(worktreeReal, resolved)) throw new Error(`adoption source repository is not self-contained: ${repoDir}`);
  }
  return {
    path: path.resolve(root) === path.resolve(repoDir) ? "." : posixRel(root, repoDir),
    sourceKind: "dir",
    worktreeReal,
    gitDirReal,
    commonDirReal,
    objectStoreReal,
  };
}

/** Phase-0, no-follow inventory. It performs every refusal before journal publication. */
export async function inventoryAdoptionSource(rootInput: string): Promise<AdoptInventory> {
  const root = path.resolve(rootInput);
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`adoption root must be a real directory: ${root}`);
  assertReadableDirectory(root, Number(rootStat.mode));
  const rootDev = rootStat.dev;
  const mounts = await linuxMountPoints();
  const rootReal = await fs.realpath(root);
  const entries: AdoptInventoryEntry[] = [];
  const sourceRepos: AdoptSourceRepo[] = [];
  const topLevel: string[] = [];
  let retainedBytes = 0n;

  const rootDotGit = await fs.lstat(path.join(root, ".git")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (rootDotGit) {
    if (!rootDotGit.isDirectory() || rootDotGit.isSymbolicLink()) throw new Error(LINKED_WORKTREE_REFUSAL);
    const rootRepo = await probeOrdinaryRepo(root, root);
    rootRepo.path = ".";
    sourceRepos.push(rootRepo);
  }

  const walk = async (dir: string): Promise<void> => {
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      throw new Error(`unreadable adoption source directory: ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    children.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const child of children) {
      if (dir === root && child.name === ".rbox") continue;
      const abs = path.join(dir, child.name);
      const rel = posixRel(root, abs);
      const stat = await fs.lstat(abs, { bigint: true });
      if (stat.dev !== rootDev || (path.resolve(abs) !== rootReal && mounts.has(path.resolve(abs)))) {
        throw new Error(`adoption source is a mount point or crosses devices: ${abs}`);
      }
      if (stat.isFile() && (Number(stat.mode) & 0o444) === 0) throw new Error(`unreadable adoption source file: ${abs}`);
      const identity = await readAdoptIdentity(abs, stat.isFile());
      entries.push({ path: rel, identity });
      if (!rel.includes("/")) topLevel.push(rel);
      if (stat.isFile()) retainedBytes += stat.size;
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      assertReadableDirectory(abs, Number(stat.mode));

      const dotGit = path.join(abs, ".git");
      const gitStat = await fs.lstat(dotGit).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      if (gitStat) {
        if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error(LINKED_WORKTREE_REFUSAL);
        sourceRepos.push(await probeOrdinaryRepo(root, abs));
      }
      await walk(abs);
    }
  };
  await walk(root);
  sourceRepos.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, sourceRepos, retainedBytes, topLevel };
}

export async function rootHasAdoptableContent(root: string): Promise<boolean> {
  try {
    const names = await fs.readdir(root);
    return names.some((name) => name !== ".rbox");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
