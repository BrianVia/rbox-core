import fs from "node:fs/promises";
import path from "node:path";
import { constants, type Stats } from "node:fs";
import { indexByPath } from "./diff.js";
import type { DirCache, DirCacheChild } from "./dircache.js";
import { hashBytes, hashFile } from "./hash.js";
import { HashCache, type HashCacheStatIdentity } from "./hashcache.js";
import type { IgnoreMatcher } from "./ignore.js";
import { isAbsent } from "./fsutil.js";
import { isSafeRelPath } from "./manifest-validate.js";
import { statsStableAcrossHash } from "./manifest.js";
import type { Action } from "./reconcile.js";
import type { FileEntry, Manifest } from "./types.js";

export type OracleVerdict =
  | { kind: "match" }
  | { kind: "mismatch"; sample: string[] }
  | { kind: "indeterminate"; why: string };

export interface AppliedManifestOracle {
  /** Full proof for one repo subtree (rel or "." = workspace). */
  proveRepo(rel: string): Promise<OracleVerdict>;
  /** Token-first boundary proof, widening only to a scan of this repo subtree. */
  reproveRepo(rel: string): Promise<OracleVerdict>;
  /** Hash of the canonical semantic receipt inputs after a complete proof. */
  receiptHash(rel: string): string | undefined;
}

export interface ReceiverEquivalence {
  caseAliases: boolean;
  unicodeAliases: boolean;
}

export type ReceiverEquivalenceProbe = (root: string) => Promise<ReceiverEquivalence>;
let injectedReceiverEquivalenceProbe: ReceiverEquivalenceProbe | undefined;

/** Test seam shared by the manifest oracle and Git receiver-collision guards. */
export function setReceiverEquivalenceProbeForTests(probe: ReceiverEquivalenceProbe | undefined): void {
  injectedReceiverEquivalenceProbe = probe;
}

type TokenKind = "absent" | "file" | "dir" | "symlink" | "other";
interface FsToken {
  kind: TokenKind;
  dev?: number;
  ino?: number;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  executable?: number;
}

interface ProofTokens {
  entries: Map<string, FsToken>;
  directories: Map<string, FsToken>;
}

interface ProofRecord {
  verdict: OracleVerdict;
  receiptHash?: string;
  tokens?: ProofTokens;
}

interface Projected {
  expected: FileEntry[];
  oracle: FileEntry[];
  preScan: FileEntry[];
  touchedKeys: Set<string>;
}

interface ReceiptSource {
  expected: Manifest;
  preScan: Manifest;
  touched: Set<string>;
  invalidWhy?: string;
}

interface InventoryEntry {
  path: string;
  type: FileEntry["type"];
}

type EntryVerification =
  | { kind: "match"; token: FsToken }
  | Exclude<OracleVerdict, { kind: "match" }>;

type CompleteScan =
  | { kind: "ok"; files: FileEntry[]; tokens: ProofTokens }
  | { kind: "indeterminate"; why: string };

const MAX_SAMPLE = 5;
const MATCH: OracleVerdict = { kind: "match" };

function mismatch(paths: string[]): Extract<OracleVerdict, { kind: "mismatch" }> {
  return { kind: "mismatch", sample: [...new Set(paths)].slice(0, MAX_SAMPLE) };
}

function indeterminate(why: string): Extract<OracleVerdict, { kind: "indeterminate" }> {
  return { kind: "indeterminate", why };
}

function tokenKind(st: Stats): Exclude<TokenKind, "absent"> {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}

function tokenFromStat(st: Stats): FsToken {
  return {
    kind: tokenKind(st),
    dev: st.dev,
    ino: st.ino,
    size: st.size,
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    executable: st.mode & 0o111,
  };
}

async function readToken(abs: string): Promise<FsToken> {
  try {
    return tokenFromStat(await fs.lstat(abs));
  } catch (error) {
    if (isAbsent(error)) return { kind: "absent" };
    throw error;
  }
}

function sameToken(a: FsToken, b: FsToken): boolean {
  return a.kind === b.kind && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs &&
    a.executable === b.executable;
}

function semanticEntry(entry: FileEntry): Record<string, unknown> {
  return {
    path: entry.path,
    type: entry.type,
    sha256: entry.sha256,
    symlinkTarget: entry.symlinkTarget ?? "",
    executable: entry.mode & 0o111,
  };
}

function sameSemantic(a: FileEntry, b: FileEntry): boolean {
  return a.type === b.type && a.sha256 === b.sha256 &&
    (a.symlinkTarget ?? "") === (b.symlinkTarget ?? "") &&
    (a.mode & 0o111) === (b.mode & 0o111);
}

function canonicalReceipt(kind: "pull" | "state", rel: string, expected: FileEntry[], observed: FileEntry[]): string {
  const sort = (entries: FileEntry[]) => entries.map(semanticEntry).sort((a, b) => String(a.path) < String(b.path) ? -1 : String(a.path) > String(b.path) ? 1 : 0);
  return hashBytes(Buffer.from(JSON.stringify({ version: 1, kind, rel, expected: sort(expected), observed: sort(observed) })));
}

function normalizeRel(rel: string): string | undefined {
  if (rel === ".") return rel;
  if (!isSafeRelPath(rel) || path.posix.normalize(rel) !== rel) return undefined;
  return rel;
}

function equivalentPart(value: string, eq: ReceiverEquivalence): string {
  let result = value;
  if (eq.unicodeAliases) result = result.normalize("NFC");
  if (eq.caseAliases) result = result.toLowerCase();
  return result;
}

export function receiverEquivalentPath(value: string, eq: ReceiverEquivalence): string {
  return value.split("/").map((part) => equivalentPart(part, eq)).join("/");
}

/** Repo targets and ref stores can alias independently of worktree behavior
 * (for example packed versus loose refs, or state later moved to APFS).
 * The key approximates Unicode FULL case folding, not just toLowerCase():
 * upper-then-lower collapses one-way foldings like final sigma (ς → Σ → σ)
 * that a single lowercase pass leaves distinct while APFS/HFS+ fold tables
 * treat them as one caseless class. Exhaustive per-filesystem fold tables are
 * unknowable statically — this key is a deliberately conservative superset
 * used only to DEFER on collision, never to authorize anything. */
export function conservativeReceiverEquivalentPath(value: string): string {
  return value
    .split("/")
    .map((part) => part.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC"))
    .join("/");
}

export function receiverEquivalentCollisionNames(
  names: Iterable<string>,
  key: (value: string) => string = conservativeReceiverEquivalentPath,
): Set<string> {
  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const canonical = key(name);
    const values = groups.get(canonical) ?? new Set<string>();
    values.add(name);
    groups.set(canonical, values);
  }
  return new Set([...groups.values()].filter((values) => values.size > 1).flatMap((values) => [...values]));
}

function inProjection(candidate: string, rel: string, eq: ReceiverEquivalence): boolean {
  if (rel === ".") return true;
  const c = candidate.split("/");
  const r = rel.split("/");
  if (c.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (equivalentPart(c[i]!, eq) !== equivalentPart(r[i]!, eq)) return false;
  }
  return true;
}

function hardExcluded(candidate: string, eq: ReceiverEquivalence): boolean {
  const parts = candidate.replace(/\/+$/, "").split("/");
  if (parts.length > 0 && equivalentPart(parts[0]!, eq) === equivalentPart(".rbox", eq)) return true;
  return parts.some((part) => equivalentPart(part, eq) === equivalentPart(".git", eq));
}

async function lstatWithoutSymlinkParents(root: string, rel: string): Promise<Stats> {
  const parts = rel.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("symlinked path parent");
  }
  return fs.lstat(path.join(root, rel));
}

async function sameFsIdentity(root: string, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [sa, sb] = await Promise.all([lstatWithoutSymlinkParents(root, a), lstatWithoutSymlinkParents(root, b)]);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

type Alignment<T extends { path: string }, U extends { path: string }> =
  | { kind: "match"; pairs: Array<[T, U]> }
  | { kind: "mismatch"; sample: string[] }
  | { kind: "indeterminate"; why: string };

function groupPaths<V extends { path: string }>(entries: V[], eq: ReceiverEquivalence): Map<string, V[]> {
  const out = new Map<string, V[]>();
  for (const entry of entries) {
    const key = receiverEquivalentPath(entry.path, eq);
    const values = out.get(key) ?? [];
    values.push(entry);
    out.set(key, values);
  }
  return out;
}

function whyFromScanError(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.message === "unsupported-entry") return "unsupported entry type in repo subtree";
  if (error.message === "directory-churn") return "repo directory changed during proof";
  if (error.message === "scan-churn") return "repo subtree changed during scoped scan";
  return undefined;
}

async function alignPaths<T extends { path: string }, U extends { path: string }>(
  left: T[],
  right: U[],
  eq: ReceiverEquivalence,
  root: string,
): Promise<Alignment<T, U>> {
  const l = groupPaths(left, eq);
  const r = groupPaths(right, eq);
  if ([...l.values(), ...r.values()].some((entries) => entries.length > 1)) {
    return { kind: "indeterminate", why: "receiver path-equivalence collision" };
  }
  const pairs: Array<[T, U]> = [];
  const samples: string[] = [];
  for (const key of new Set([...l.keys(), ...r.keys()])) {
    const a = l.get(key)?.[0];
    const b = r.get(key)?.[0];
    if (!a || !b) {
      samples.push(a?.path ?? b!.path);
      continue;
    }
    if (a.path !== b.path) {
      try {
        if (!(await sameFsIdentity(root, a.path, b.path))) return { kind: "indeterminate", why: "equivalent spellings do not prove one filesystem entry" };
      } catch {
        return { kind: "indeterminate", why: "equivalent spelling identity could not be read" };
      }
    }
    pairs.push([a, b]);
  }
  return samples.length > 0 ? { kind: "mismatch", sample: samples.slice(0, MAX_SAMPLE) } : { kind: "match", pairs };
}

async function compareEntries(left: FileEntry[], right: FileEntry[], eq: ReceiverEquivalence, root: string): Promise<OracleVerdict> {
  const aligned = await alignPaths(left, right, eq, root);
  if (aligned.kind === "indeterminate") return aligned;
  if (aligned.kind === "mismatch") return { kind: "mismatch", sample: aligned.sample };
  const samples = aligned.pairs.filter(([a, b]) => !sameSemantic(a, b)).map(([a]) => a.path);
  return samples.length > 0 ? mismatch(samples) : MATCH;
}

async function defaultReceiverEquivalenceProbe(root: string): Promise<ReceiverEquivalence> {
  const parent = path.join(root, ".rbox", "state", "tmp");
  await fs.mkdir(parent, { recursive: true });
  const probe = await fs.mkdtemp(path.join(parent, "apply-receipt-probe-"));
  try {
    const aliases = async (first: string, second: string): Promise<boolean> => {
      const a = path.join(probe, first);
      const b = path.join(probe, second);
      await fs.writeFile(a, "probe", { flag: "wx" });
      try {
        const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
        return sa.dev === sb.dev && sa.ino === sb.ino;
      } catch (error) {
        if (isAbsent(error)) return false;
        throw error;
      } finally {
        await fs.rm(a, { force: true });
      }
    };
    return {
      caseAliases: await aliases("a.rbox-probe-A", "a.rbox-probe-a"),
      unicodeAliases: await aliases("é.rbox-probe", "e\u0301.rbox-probe"),
    };
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

export async function probeReceiverEquivalence(root: string): Promise<ReceiverEquivalence> {
  return (injectedReceiverEquivalenceProbe ?? defaultReceiverEquivalenceProbe)(root);
}

class ManifestOracle implements AppliedManifestOracle {
  private prepared?: {
    expectedMap: Map<string, FileEntry>;
    oracleMap: Map<string, FileEntry>;
    preMap: Map<string, FileEntry>;
    touched: Set<string>;
    invalidWhy?: string;
  };
  private readonly records = new Map<string, ProofRecord>();
  private readonly inflight = new Map<string, Promise<OracleVerdict>>();
  private equivalence?: Promise<ReceiverEquivalence>;
  private hashCache?: Promise<HashCache>;

  constructor(
    private readonly kind: "pull" | "state",
    private readonly root: string,
    private readonly matcher: IgnoreMatcher,
    private readonly source: () => ReceiptSource,
    private readonly oracleManifest: Manifest,
    private readonly scanDeferred: ReadonlySet<string>,
    private readonly dircache?: DirCache,
    private readonly preScanHashCache?: HashCache,
  ) {}

  receiptHash(rel: string): string | undefined {
    return this.records.get(rel)?.receiptHash;
  }

  proveRepo(rel: string): Promise<OracleVerdict> {
    return this.serial(rel, () => this.proveFresh(rel));
  }

  reproveRepo(rel: string): Promise<OracleVerdict> {
    return this.serial(rel, async () => {
      const prior = this.records.get(rel);
      if (!prior?.tokens || prior.verdict.kind !== "match") return this.proveFresh(rel);
      try {
        for (const [entryRel, token] of [...prior.tokens.entries, ...prior.tokens.directories]) {
          if (!sameToken(token, await readToken(this.abs(entryRel)))) return this.scanAndCompare(rel, await this.getEquivalence());
        }
        return MATCH;
      } catch {
        const verdict = indeterminate("receipt tokens could not be read");
        return this.settle(rel, verdict);
      }
    });
  }

  private serial(rel: string, run: () => Promise<OracleVerdict>): Promise<OracleVerdict> {
    const existing = this.inflight.get(rel);
    if (existing) return existing;
    const promise = run().finally(() => this.inflight.delete(rel));
    this.inflight.set(rel, promise);
    return promise;
  }

  private settle(rel: string, verdict: OracleVerdict): OracleVerdict {
    this.records.set(rel, { verdict });
    return verdict;
  }

  private abs(rel: string): string {
    return rel === "." ? this.root : path.join(this.root, rel);
  }

  private getEquivalence(): Promise<ReceiverEquivalence> {
    return this.equivalence ??= probeReceiverEquivalence(this.root);
  }

  private getHashCache(): Promise<HashCache> {
    return this.hashCache ??= HashCache.load(this.root);
  }

  private getPrepared(): NonNullable<ManifestOracle["prepared"]> {
    if (this.prepared) return this.prepared;
    const source = this.source();
    return this.prepared = {
      expectedMap: indexByPath(source.expected),
      oracleMap: indexByPath(this.oracleManifest),
      preMap: indexByPath(source.preScan),
      touched: source.touched,
      ...(source.invalidWhy ? { invalidWhy: source.invalidWhy } : {}),
    };
  }

  private project(rel: string, eq: ReceiverEquivalence): Projected | OracleVerdict {
    const prepared = this.getPrepared();
    if (prepared.invalidWhy) return indeterminate(prepared.invalidWhy);
    const normalized = normalizeRel(rel);
    if (!normalized) return indeterminate("invalid repo subtree path");
    if ([...this.scanDeferred].some((candidate) => inProjection(candidate, normalized, eq))) {
      return indeterminate("scan deferred in repo subtree");
    }
    const filter = (map: Map<string, FileEntry>): FileEntry[] => [...map.values()].filter((entry) =>
      inProjection(entry.path, normalized, eq) && !hardExcluded(entry.path, eq) && !this.matcher.ignores(entry.path));
    const expected = filter(prepared.expectedMap);
    const oracle = filter(prepared.oracleMap);
    const preScan = filter(prepared.preMap);
    return {
      expected,
      oracle,
      preScan,
      touchedKeys: new Set([...prepared.touched].filter((candidate) => inProjection(candidate, normalized, eq)).map((candidate) => receiverEquivalentPath(candidate, eq))),
    };
  }

  private async proveFresh(rel: string): Promise<OracleVerdict> {
    let eq: ReceiverEquivalence;
    try {
      eq = await this.getEquivalence();
    } catch {
      const verdict = indeterminate("filesystem-equivalence probe failed");
      return this.settle(rel, verdict);
    }
    const projected = this.project(rel, eq);
    if ("kind" in projected) {
      return this.settle(rel, projected);
    }
    if (this.kind === "state") return this.scanAndCompareProjected(rel, eq, projected);

    const semantic = await compareEntries(projected.expected, projected.oracle, eq, this.root);
    if (semantic.kind === "indeterminate") {
      return this.settle(rel, semantic);
    }

    const inventory = await this.inventory(rel, eq);
    if (inventory.kind === "indeterminate") {
      const verdict = indeterminate(inventory.why);
      return this.settle(rel, verdict);
    }
    const aligned = await alignPaths(projected.expected, inventory.entries, eq, this.root);
    if (aligned.kind === "indeterminate") {
      return this.settle(rel, aligned);
    }
    if (aligned.kind === "mismatch" || aligned.pairs.some(([expected, actual]) => expected.type !== actual.type)) {
      return this.scanAndCompareProjected(rel, eq, projected);
    }

    const preGroups = groupPaths(projected.preScan, eq);
    if ([...preGroups.values()].some((entries) => entries.length > 1)) {
      const verdict = indeterminate("receiver path-equivalence collision");
      return this.settle(rel, verdict);
    }

    for (const [expected, actual] of aligned.pairs) {
      const pre = preGroups.get(receiverEquivalentPath(expected.path, eq))?.[0];
      const verified = await this.verifyFastEntry(
        expected,
        actual.path,
        projected.touchedKeys.has(receiverEquivalentPath(expected.path, eq)),
        pre,
        pre ? this.preScanHashCache?.statIdentity(pre.path, pre.sha256) : undefined,
      );
      if (verified.kind !== "match") {
        if (verified.kind === "mismatch") {
          return this.scanAndCompareProjected(rel, eq, projected);
        }
        return this.settle(rel, verified);
      }
      // The receipt token must be the token bracketed by the verification above.
      // A fresh restat here could adopt an edit that landed after different bytes
      // were verified, causing the boundary re-proof to bless that edit.
      inventory.tokens.entries.set(actual.path, verified.token);
    }

    const receiptHash = canonicalReceipt(this.kind, rel, projected.oracle, projected.expected);
    this.records.set(rel, { verdict: semantic, receiptHash, tokens: semantic.kind === "match" ? inventory.tokens : undefined });
    return semantic;
  }

  private async verifyFastEntry(
    expected: FileEntry,
    actualPath: string,
    touched: boolean,
    pre?: FileEntry,
    preStat?: HashCacheStatIdentity,
  ): Promise<EntryVerification> {
    const abs = this.abs(actualPath);
    let st: Stats;
    try {
      st = await fs.lstat(abs);
    } catch (error) {
      return isAbsent(error) ? mismatch([actualPath]) : indeterminate("repo entry could not be read");
    }
    if (expected.type === "symlink") {
      if (!st.isSymbolicLink()) return mismatch([actualPath]);
      try {
        const target = await fs.readlink(abs);
        const after = await readToken(abs);
        if (!sameToken(tokenFromStat(st), after)) return indeterminate("symlink changed during proof");
        return target === (expected.symlinkTarget ?? "") && hashBytes(Buffer.from(target)) === expected.sha256
          ? { kind: "match", token: after }
          : mismatch([actualPath]);
      } catch {
        return indeterminate("symlink target could not be read");
      }
    }
    if (!st.isFile() || (st.mode & 0o111) !== (expected.mode & 0o111)) return mismatch([actualPath]);
    try {
      await fs.access(abs, constants.R_OK);
    } catch {
      return indeterminate("repo entry is unreadable");
    }
    // An action-touched entry is never accepted from stat metadata: a human edit
    // can replace the just-applied bytes with equal-sized content and restore its
    // mtime before Git classification. Untouched entries retain the scan fast path,
    // but only when every pre-scan stat field still available agrees.
    const untouchedTokenAgrees = !touched && pre !== undefined &&
      st.size === pre.size && st.mtimeMs === pre.mtimeMs &&
      (preStat === undefined || (
        st.size === preStat.size && st.mtimeMs === preStat.mtimeMs && st.ctimeMs === preStat.ctimeMs
      ));
    if (untouchedTokenAgrees) return { kind: "match", token: tokenFromStat(st) };
    try {
      const before = st;
      const sha256 = await hashFile(abs, before.size);
      const after = await fs.lstat(abs);
      if (!statsStableAcrossHash(before, after)) return indeterminate("repo entry changed during proof");
      return sha256 === expected.sha256 ? { kind: "match", token: tokenFromStat(after) } : mismatch([actualPath]);
    } catch {
      return indeterminate("repo entry could not be hashed");
    }
  }

  private async inventory(rel: string, eq: ReceiverEquivalence): Promise<{ kind: "ok"; entries: InventoryEntry[]; tokens: ProofTokens } | { kind: "indeterminate"; why: string }> {
    const entries: InventoryEntry[] = [];
    const tokens: ProofTokens = { entries: new Map(), directories: new Map() };
    const walk = async (dirRel: string): Promise<void> => {
      const absDir = this.abs(dirRel);
      const before = await readToken(absDir);
      if (before.kind !== "dir") throw new Error("scope-not-directory");
      let children = this.dircache?.reuse(dirRel === "." ? "" : dirRel, await fs.lstat(absDir));
      if (!children) {
        const raw = await fs.readdir(absDir, { withFileTypes: true });
        children = raw.map((entry): DirCacheChild => ({
          name: entry.name,
          type: entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : "other",
        }));
      }
      for (const child of children) {
        const childRel = dirRel === "." ? child.name : `${dirRel}/${child.name}`;
        if (hardExcluded(childRel, eq)) continue;
        if (child.type === "dir") {
          const dirForm = `${childRel}/`;
          if (this.matcher.prunes?.(dirForm) ?? this.matcher.ignores(dirForm)) continue;
          await walk(childRel);
        } else if (child.type === "other") {
          if (!this.matcher.ignores(childRel)) throw new Error("unsupported-entry");
        } else if (!this.matcher.ignores(childRel)) {
          entries.push({ path: childRel, type: child.type });
        }
      }
      const after = await readToken(absDir);
      if (!sameToken(before, after)) throw new Error("directory-churn");
      tokens.directories.set(dirRel, after);
    };
    try {
      const scope = await readToken(this.abs(rel));
      if (scope.kind === "absent") {
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "file" || scope.kind === "symlink") {
        if (!hardExcluded(rel, eq) && !this.matcher.ignores(rel)) entries.push({ path: rel, type: scope.kind });
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "dir") {
        await walk(rel);
      } else {
        return { kind: "indeterminate", why: "unsupported entry type in repo subtree" };
      }
      return { kind: "ok", entries, tokens };
    } catch (error) {
      const why = whyFromScanError(error) ?? "repo subtree inventory could not be read";
      return { kind: "indeterminate", why };
    }
  }

  private async scanAndCompare(rel: string, eq: ReceiverEquivalence): Promise<OracleVerdict> {
    const projected = this.project(rel, eq);
    if ("kind" in projected) {
      return this.settle(rel, projected);
    }
    return this.scanAndCompareProjected(rel, eq, projected);
  }

  private async scanAndCompareProjected(rel: string, eq: ReceiverEquivalence, projected: Projected): Promise<OracleVerdict> {
    const scanned = await this.scopedScan(rel, eq);
    if (scanned.kind === "indeterminate") {
      const verdict = indeterminate(scanned.why);
      return this.settle(rel, verdict);
    }
    const verdict = await compareEntries(scanned.files, projected.oracle, eq, this.root);
    if (verdict.kind === "indeterminate") {
      return this.settle(rel, verdict);
    }
    const receiptHash = canonicalReceipt(this.kind, rel, projected.oracle, scanned.files);
    this.records.set(rel, { verdict, receiptHash, tokens: verdict.kind === "match" ? scanned.tokens : undefined });
    return verdict;
  }

  private async scopedScan(rel: string, eq: ReceiverEquivalence): Promise<CompleteScan> {
    const files: FileEntry[] = [];
    const tokens: ProofTokens = { entries: new Map(), directories: new Map() };
    const cache = await this.getHashCache();

    const scanLeaf = async (leafRel: string, expectedType?: DirCacheChild["type"]): Promise<void> => {
      const abs = this.abs(leafRel);
      const before = await fs.lstat(abs);
      const kind = tokenKind(before);
      if (expectedType && kind !== expectedType) throw new Error("scan-churn");
      if (kind === "symlink") {
        const target = await fs.readlink(abs);
        const after = await readToken(abs);
        if (!sameToken(tokenFromStat(before), after)) throw new Error("scan-churn");
        files.push({ path: leafRel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 });
        tokens.entries.set(leafRel, after);
        return;
      }
      if (kind !== "file") throw new Error("unsupported-entry");
      await fs.access(abs, constants.R_OK);
      let sha256 = cache.lookup(leafRel, before.mtimeMs, before.size, before.ctimeMs);
      let after = tokenFromStat(before);
      if (!sha256) {
        sha256 = await hashFile(abs, before.size);
        const post = await fs.lstat(abs);
        if (!statsStableAcrossHash(before, post)) throw new Error("scan-churn");
        after = tokenFromStat(post);
        cache.record(leafRel, { mtimeMs: post.mtimeMs, size: post.size, ctimeMs: post.ctimeMs, sha256 });
      }
      files.push({ path: leafRel, type: "file", sha256, size: after.size!, mode: after.executable!, mtimeMs: after.mtimeMs! });
      tokens.entries.set(leafRel, after);
    };

    const walk = async (dirRel: string): Promise<void> => {
      const absDir = this.abs(dirRel);
      const before = await readToken(absDir);
      if (before.kind !== "dir") throw new Error("scan-churn");
      const children = await fs.readdir(absDir, { withFileTypes: true });
      for (const child of children) {
        const childRel = dirRel === "." ? child.name : `${dirRel}/${child.name}`;
        if (hardExcluded(childRel, eq)) continue;
        if (child.isDirectory()) {
          const dirForm = `${childRel}/`;
          if (this.matcher.prunes?.(dirForm) ?? this.matcher.ignores(dirForm)) continue;
          await walk(childRel);
        } else if (!this.matcher.ignores(childRel)) {
          const type: DirCacheChild["type"] = child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
          if (type === "other") throw new Error("unsupported-entry");
          await scanLeaf(childRel, type);
        }
      }
      const after = await readToken(absDir);
      if (!sameToken(before, after)) throw new Error("scan-churn");
      tokens.directories.set(dirRel, after);
    };

    try {
      const scope = await readToken(this.abs(rel));
      if (scope.kind === "absent") {
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "dir") {
        await walk(rel);
      } else if (scope.kind === "file" || scope.kind === "symlink") {
        if (!hardExcluded(rel, eq) && !this.matcher.ignores(rel)) await scanLeaf(rel, scope.kind);
      } else {
        throw new Error("unsupported-entry");
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { kind: "ok", files, tokens };
    } catch (error) {
      const why = whyFromScanError(error) ?? "repo subtree could not be scanned";
      return { kind: "indeterminate", why };
    }
  }
}

export function oracleFromPull(opts: {
  preScan: Manifest;
  actions: Action[];
  oracle: Manifest;
  matcher: IgnoreMatcher;
  dircache?: DirCache;
  /** Hash cache used by preScan. Untouched files may trust its mtime+size+ctime
   *  identity; action-touched files are always content-hashed. */
  hashcache?: HashCache;
  root: string;
  scanDeferred: ReadonlySet<string>;
}): AppliedManifestOracle {
  const source = (): ReceiptSource => {
    const preApply = indexByPath(opts.preScan);
    const expected = new Map(preApply);
    const touched = new Set<string>();
    let invalidWhy: string | undefined;
    for (const action of opts.actions) {
      if (action.kind === "write") {
        expected.set(action.entry.path, action.entry);
        touched.add(action.entry.path);
      } else if (action.kind === "delete") {
        expected.delete(action.path);
        touched.add(action.path);
      } else {
        const prior = preApply.get(action.path);
        expected.set(action.path, action.entry);
        touched.add(action.path);
        touched.add(action.keepLocalAs);
        if (!prior) invalidWhy = "conflict receipt lacks its prior local entry";
        else expected.set(action.keepLocalAs, { ...prior, path: action.keepLocalAs });
      }
    }
    return {
      expected: { generatedAt: opts.preScan.generatedAt, files: [...expected.values()] },
      preScan: opts.preScan,
      touched,
      ...(invalidWhy ? { invalidWhy } : {}),
    };
  };
  return new ManifestOracle("pull", opts.root, opts.matcher, source, opts.oracle, opts.scanDeferred, opts.dircache, opts.hashcache);
}

export function oracleFromState(opts: {
  base: Manifest;
  matcher: IgnoreMatcher;
  root: string;
}): AppliedManifestOracle {
  return new ManifestOracle("state", opts.root, opts.matcher, () => ({ expected: opts.base, preScan: opts.base, touched: new Set() }), opts.base, new Set(), undefined);
}
