/** Never: cache persistence, probing. */
import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, isSyncableRef } from "../../engine/index.js";
import { repoCtxFromDisk, type RepoCtx } from "./git-state.js";
import { OP_STATE_DIRS, OP_STATE_FILES } from "../../engine/manifest-validate.js";
import { MAX_GIT_CONFIG_KEYS, MAX_GIT_CONFIG_KEY_BYTES, MAX_GIT_CONFIG_SERIALIZED_BYTES, MAX_GIT_CONFIG_VALUE_BYTES } from "./config-sync.js";
import { git } from "../../engine/git-spawn.js";
import { repoDirOf } from "./shared.js";
// Classifier semantics participate in the schema because held decisions must
// be reprobed when an unchanged on-disk marker changes meaning.
export const GIT_FINGERPRINT_SCHEMA_VERSION = 9;
export interface GitConfigWireBounds {
  maxKeys: number;
  maxSerializedBytes: number;
  maxKeyBytes: number;
  maxValueBytes: number;
}

/** Bind cached git decisions to the wire bounds that produced them. A bounds
 * recalibration changes this version even when every watched git file is
 * unchanged, forcing one fresh probe before the cache self-heals. */
export function gitFingerprintVersionForBounds(bounds: GitConfigWireBounds): string {
  return hashBytes(
    Buffer.from(
      JSON.stringify({
        schema: GIT_FINGERPRINT_SCHEMA_VERSION,
        configWireBounds: [bounds.maxKeys, bounds.maxSerializedBytes, bounds.maxKeyBytes, bounds.maxValueBytes],
      })
    )
  );
}

export const GIT_FINGERPRINT_VERSION = gitFingerprintVersionForBounds({
  maxKeys: MAX_GIT_CONFIG_KEYS,
  maxSerializedBytes: MAX_GIT_CONFIG_SERIALIZED_BYTES,
  maxKeyBytes: MAX_GIT_CONFIG_KEY_BYTES,
  maxValueBytes: MAX_GIT_CONFIG_VALUE_BYTES,
});
const LOOSE_REF_HASH_MAX_BYTES = 4096;
// Large indexes fall back to stat+ctime under the racy-clean margin. Real index
// rewrites change stat and content, so the bracket converges identically; hashing
// multi-MB indexes per tick bought nothing.
const INDEX_HASH_MAX_BYTES = 1024 * 1024;
// Mirrors git's racy-clean discipline: timestamps inside this granularity window
// are not trusted for publish-grade cache hits.
export const GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS = 2000;
export interface GitFingerprint {
  hash: string;
  maxTsMs: number;
  /** False means a semantic index dependency could not be enumerated. Held-skip
   * decisions must fail open instead of trusting the hash in that case. */
  dependenciesComplete: boolean;
  diskCtx?: RepoCtx;
}

type StatToken =
  | { exists: false }
  | { exists: true; type: "file" | "dir" | "symlink" | "other"; mtimeMs: number; ctimeMs: number; size: number; ino: number; target?: string; contentSha256?: string };
type DotGitToken =
  | { exists: false }
  | { exists: true; type: "dir" }
  | { exists: true; type: "file"; size: number; pointerTarget?: string; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
  | { exists: true; type: "symlink" | "other"; target?: string };
type TreeToken =
  | { exists: false }
  | { exists: true; type: "dir" }
  | { exists: true; type: "file"; size: number; mtimeMs: number; ctimeMs: number; contentSha256?: string }
  | { exists: true; type: "symlink" | "other"; size: number; mtimeMs: number; ctimeMs: number; target?: string };
type IndexToken =
  | { exists: false }
  | { exists: true; type: "dir" | "symlink" | "other"; mtimeMs: number; ctimeMs: number; size: number; target?: string }
  | { exists: true; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number };
type ExistenceToken = { exists: false } | { exists: true; type: "file" | "dir" | "symlink" | "other" };
type WorktreesToken =
  | { exists: false }
  | { exists: true; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
  | { exists: true; type: "symlink" | "other"; target?: string }
  | {
      exists: true;
      type: "dir";
      entries: Array<
        | { name: string; type: "dir" }
        | { name: string; type: "file"; size: number; contentSha256?: string; mtimeMs?: number; ctimeMs?: number }
        | { name: string; type: "symlink" | "other"; target?: string }
      >;
    };

export interface GitFingerprintRun {
  commonDirFingerprints: Map<string, Promise<unknown>>;
  memoPolicy: "cross-repo" | "per-decision";
  decisionRel?: string;
}
function statKind(st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): "file" | "dir" | "symlink" | "other" {
  return st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
}

async function fileContentSha256(abs: string, size: number, maxBytes: number | undefined): Promise<string | undefined> {
  if (maxBytes === undefined || size >= maxBytes) return undefined;
  const bytes = await fs.readFile(abs).catch(() => undefined);
  return bytes ? hashBytes(bytes) : undefined;
}

async function contentOrStatFields(abs: string, size: number, maxBytes: number): Promise<{ contentSha256: string } | { mtimeMs: number; ctimeMs: number }> {
  const contentSha256 = await fileContentSha256(abs, size, maxBytes);
  if (contentSha256) return { contentSha256 };
  const st = await fs.lstat(abs).catch(() => undefined);
  return { mtimeMs: st?.mtimeMs ?? 0, ctimeMs: st?.ctimeMs ?? 0 };
}

async function statToken(abs: string, opts: { hashFileMaxBytes?: number } = {}): Promise<StatToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  const type = statKind(st);
  const token: StatToken = { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, ino: st.ino };
  if (type === "symlink") token.target = await fs.readlink(abs).catch(() => "");
  if (type === "file") token.contentSha256 = await fileContentSha256(abs, st.size, opts.hashFileMaxBytes);
  return token;
}

async function existenceToken(abs: string): Promise<ExistenceToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  return { exists: true, type: statKind(st) };
}

async function indexToken(abs: string): Promise<IndexToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  const type = statKind(st);
  if (type === "file") {
    return { exists: true, type, size: st.size, ...(await contentOrStatFields(abs, st.size, INDEX_HASH_MAX_BYTES)) };
  }
  if (type === "symlink") return { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size, target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size };
}

type SharedIndexToken =
  | { enumerable: false }
  | { enumerable: true; referenced: false }
  | { enumerable: true; referenced: true; name: string; token: IndexToken };

/** Ask Git for the exact split-index dependency rather than globbing every
 * sharedindex.* sibling. An unparseable answer is an incomplete fingerprint,
 * never evidence for a held-skip hit. */
async function sharedIndexToken(repoDir: string, gitDir: string): Promise<SharedIndexToken> {
  let raw: string;
  try {
    raw = await git(repoDir, ["rev-parse", "--path-format=absolute", "--shared-index-path"]);
  } catch {
    return { enumerable: false };
  }
  if (raw === "") return { enumerable: true, referenced: false };
  const absolute = path.resolve(repoDir, raw);
  const name = path.basename(absolute);
  if (path.dirname(absolute) !== path.resolve(gitDir) || !/^sharedindex\.[0-9a-f]+$/.test(name)) {
    return { enumerable: false };
  }
  return { enumerable: true, referenced: true, name, token: await indexToken(absolute) };
}

async function dotGitToken(abs: string, diskCtx: RepoCtx | undefined): Promise<DotGitToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  if (st.isDirectory()) return { exists: true, type: "dir" };
  if (st.isFile()) {
    return {
      exists: true,
      type: "file",
      size: st.size,
      pointerTarget: diskCtx?.kind === "pointer" ? diskCtx.gitDir : undefined,
      ...(await contentOrStatFields(abs, st.size, LOOSE_REF_HASH_MAX_BYTES)),
    };
  }
  if (st.isSymbolicLink()) return { exists: true, type: "symlink", target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type: "other" };
}

async function treeToken(abs: string, opts: { hashFileMaxBytes?: number } = {}): Promise<TreeToken> {
  const st = await fs.lstat(abs).catch(() => undefined);
  if (!st) return { exists: false };
  // Directory timestamps are traversal byproducts, not Git semantic identity.
  if (st.isDirectory()) return { exists: true, type: "dir" };
  if (st.isFile()) return { exists: true, type: "file", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, contentSha256: await fileContentSha256(abs, st.size, opts.hashFileMaxBytes) };
  if (st.isSymbolicLink()) return { exists: true, type: "symlink", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, target: await fs.readlink(abs).catch(() => "") };
  return { exists: true, type: "other", size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

/** Loose identity refs only: internal rbox refs and directory metadata are
 * capture byproducts, while reflogs are deliberately not fingerprint inputs. */
async function identityRefsToken(abs: string): Promise<Array<{ ref: string; stat: TreeToken }>> {
  const tree = await statTree(abs, "", { hashFileMaxBytes: LOOSE_REF_HASH_MAX_BYTES });
  return tree.flatMap(({ rel, stat }) => {
    if (rel === "." || (stat.exists && stat.type === "dir")) return [];
    const ref = `refs/${rel}`;
    return isSyncableRef(ref) ? [{ ref, stat }] : [];
  });
}

async function packedRefsIdentityToken(abs: string): Promise<unknown> {
  const raw = await fs.readFile(abs, "utf8").catch(() => undefined);
  if (raw === undefined) return [];
  const kept: string[] = [];
  let keepPeeled = false;
  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      keepPeeled = false;
      continue;
    }
    if (line.startsWith("^")) {
      if (keepPeeled) kept.push(line);
      continue;
    }
    const separator = line.indexOf(" ");
    const ref = separator < 0 ? "" : line.slice(separator + 1);
    keepPeeled = isSyncableRef(ref);
    if (keepPeeled) kept.push(line);
  }
  return kept;
}

async function statTree(abs: string, base = "", opts: { hashFileMaxBytes?: number } = {}): Promise<Array<{ rel: string; stat: TreeToken }>> {
  const rootStat = await treeToken(path.join(abs, base), opts);
  const out: Array<{ rel: string; stat: TreeToken }> = [{ rel: base || ".", stat: rootStat }];
  if (!rootStat.exists || rootStat.type !== "dir") return out;
  const entries = await fs.readdir(path.join(abs, base), { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await statTree(abs, rel, opts)));
    else out.push({ rel, stat: await treeToken(path.join(abs, rel), opts) });
  }
  return out;
}

async function worktreesToken(abs: string): Promise<WorktreesToken> {
  const root = await statToken(abs);
  if (!root.exists) return { exists: false };
  if (root.type === "file") {
    return { exists: true, type: "file", size: root.size, ...(await contentOrStatFields(abs, root.size, LOOSE_REF_HASH_MAX_BYTES)) };
  }
  if (root.type === "symlink" || root.type === "other") {
    return root.type === "symlink" ? { exists: true, type: "symlink", target: root.target } : { exists: true, type: "other" };
  }
  const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shallow = await Promise.all(
    entries.map(async (entry) => {
      const st = await fs.lstat(path.join(abs, entry.name)).catch(() => undefined);
      const type = st ? statKind(st) : statKind(entry);
      if (type === "dir") return { name: entry.name, type: "dir" as const };
      if (type === "file" && st) {
        return { name: entry.name, type: "file" as const, size: st.size, ...(await contentOrStatFields(path.join(abs, entry.name), st.size, LOOSE_REF_HASH_MAX_BYTES)) };
      }
      return type === "symlink"
        ? { name: entry.name, type: "symlink" as const, target: await fs.readlink(path.join(abs, entry.name)).catch(() => "") }
        : { name: entry.name, type: "other" as const };
    })
  );
  return { exists: true, type: "dir", entries: shallow };
}

async function opStateFingerprint(gitDir: string): Promise<unknown> {
  const files = await Promise.all(OP_STATE_FILES.map(async (rel) => [rel, await statToken(path.join(gitDir, rel))] as const));
  const dirs = await Promise.all(OP_STATE_DIRS.map(async (rel) => [rel, await statTree(path.join(gitDir, rel))] as const));
  return { files, dirs };
}

async function commonDirFingerprint(ctx: RepoCtx): Promise<unknown> {
  const [shallow, alternates, config, modules, worktrees, gcPid, packedRefs, packedRefsLock, refs] = await Promise.all([
    statToken(path.join(ctx.commonDir, "shallow")),
    statToken(path.join(ctx.commonDir, "objects", "info", "alternates")),
    statToken(path.join(ctx.commonDir, "config")),
    existenceToken(path.join(ctx.commonDir, "modules")),
    worktreesToken(path.join(ctx.commonDir, "worktrees")),
    statToken(path.join(ctx.commonDir, "gc.pid")),
    packedRefsIdentityToken(path.join(ctx.commonDir, "packed-refs")),
    statToken(path.join(ctx.commonDir, "packed-refs.lock")),
    identityRefsToken(path.join(ctx.commonDir, "refs")),
  ]);
  return {
    shallow,
    alternates,
    config,
    modules,
    worktrees,
    gcPid,
    packedRefs,
    packedRefsLock,
    refs,
  };
}

function memoizedCommonDirFingerprint(run: GitFingerprintRun, ctx: RepoCtx): Promise<unknown> {
  const key = path.resolve(ctx.commonDir);
  let p = run.commonDirFingerprints.get(key);
  if (!p) {
    p = commonDirFingerprint(ctx);
    run.commonDirFingerprints.set(key, p);
  }
  return p;
}

export function gitFingerprintRun(memoPolicy: GitFingerprintRun["memoPolicy"]): GitFingerprintRun {
  return { commonDirFingerprints: new Map(), memoPolicy };
}

function beginFingerprintDecision(run: GitFingerprintRun, rel: string): void {
  if (run.memoPolicy !== "per-decision" || run.decisionRel === rel) return;
  run.commonDirFingerprints.clear();
  run.decisionRel = rel;
}

function maxFingerprintTimestampMs(v: unknown): number {
  let max = 0;
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const item of x) visit(item);
      return;
    }
    if (x === null || typeof x !== "object") return;
    for (const [key, value] of Object.entries(x)) {
      if ((key === "mtimeMs" || key === "ctimeMs" || key === "maxMtimeMs" || key === "maxCtimeMs") && typeof value === "number") {
        max = Math.max(max, value);
      } else {
        visit(value);
      }
    }
  };
  visit(v);
  return max;
}
async function gitDirFingerprint(
  repoDir: string,
  gitDir: string,
  includeIndexDependencies: boolean,
): Promise<{ value: unknown; dependenciesComplete: boolean }> {
  const [head, index, sharedIndex, indexLock, headLock, configWorktree, opState] = await Promise.all([
    statToken(path.join(gitDir, "HEAD"), { hashFileMaxBytes: LOOSE_REF_HASH_MAX_BYTES }),
    indexToken(path.join(gitDir, "index")),
    includeIndexDependencies ? sharedIndexToken(repoDir, gitDir) : Promise.resolve(undefined),
    statToken(path.join(gitDir, "index.lock")),
    statToken(path.join(gitDir, "HEAD.lock")),
    statToken(path.join(gitDir, "config.worktree")),
    opStateFingerprint(gitDir),
  ]);
  return {
    value: { head, index, sharedIndex, indexLock, headLock, configWorktree, opState },
    dependenciesComplete: sharedIndex?.enumerable ?? true,
  };
}

export async function gitFingerprint(
  run: GitFingerprintRun,
  root: string,
  rel: string,
  opts: { includeIndexDependencies?: boolean } = {},
): Promise<GitFingerprint> {
  beginFingerprintDecision(run, rel);
  const repoDir = repoDirOf(root, rel);
  const dotGit = path.join(repoDir, ".git");
  const diskCtx = await repoCtxFromDisk(repoDir).catch(() => undefined);
  const [dotGitPart, gitDirResult, commonDirPart] = await Promise.all([
    dotGitToken(dotGit, diskCtx),
    diskCtx ? gitDirFingerprint(repoDir, diskCtx.gitDir, opts.includeIndexDependencies === true) : Promise.resolve({ value: null, dependenciesComplete: true }),
    diskCtx ? memoizedCommonDirFingerprint(run, diskCtx) : Promise.resolve(null),
  ]);
  const parts = {
    version: GIT_FINGERPRINT_VERSION,
    dotGit: dotGitPart,
    ctx: diskCtx ? { kind: diskCtx.kind, gitDir: diskCtx.gitDir, commonDir: diskCtx.commonDir } : null,
    gitDir: gitDirResult.value,
    commonDir: commonDirPart,
  };
  return {
    hash: hashBytes(Buffer.from(JSON.stringify(parts))),
    maxTsMs: maxFingerprintTimestampMs(parts),
    dependenciesComplete: gitDirResult.dependenciesComplete,
    diskCtx,
  };
}
