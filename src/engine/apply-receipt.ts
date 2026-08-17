import fs from "node:fs/promises";
import path from "node:path";
import { constants, type Stats } from "node:fs";
import { indexByPath } from "./diff.js";
import type { DirCache, DirCacheChild } from "./dircache.js";
import { hashBytes, hashFile } from "./hash.js";
import { HashCache, type HashCacheStatIdentity } from "./hashcache.js";
import type { IgnoreMatcher } from "./ignore.js";
import { isAbsent } from "./fsutil.js";
import { statsStableAcrossHash } from "./manifest.js";
import {
  hardExcluded,
  inProjection,
  matchesConflictGrammarBelow,
  normalizeRel,
  probeReceiverEquivalence,
  receiverEquivalentPath,
  type ReceiverEquivalence,
} from "./receiver-paths.js";
import type { Action } from "./reconcile.js";
import type { FileEntry, Manifest } from "./types.js";

export {
  conservativeReceiverEquivalentPath,
  probeReceiverEquivalence,
  receiverEquivalentCollisionNames,
  receiverEquivalentPath,
  setReceiverEquivalenceProbeForTests,
  type ReceiverEquivalence,
  type ReceiverEquivalenceProbe,
} from "./receiver-paths.js";

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

export type PullOracleObservation =
  | { kind: "prepare"; ms: number; entriesIndexed: number }
  | { kind: "receipt-hash"; ms: number }
  | { kind: "repo-proved" };

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

type ComparableKind = "leaf" | "dir";
type Comparable = (rel: string, kind: ComparableKind) => boolean;
interface ConflictGrammarSink {
  hit: boolean;
}

interface Projected {
  expected: FileEntry[];
  oracle: FileEntry[];
  preScan: FileEntry[];
  touchedKeys: Set<string>;
  armed: ConflictGrammarSink;
  comparable: Comparable;
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

interface SemanticReceiptEntry {
  path: string;
  type: FileEntry["type"];
  sha256: string;
  symlinkTarget: string;
  executable: number;
}

function semanticEntry(entry: FileEntry): SemanticReceiptEntry {
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

/** Reaches users verbatim through the git-deferral detail companion, so it is
 *  plain language. `conflict-copies` inside it is load-bearing: `gitReasonOf`
 *  (doctor-cmd.ts) normalizes this string and buckets on that token. */
export const CONFLICT_COPY_POPULATION_WHY = "only conflict-copies remain here, so the comparison was skipped.";

function downgradeIfEmptied(verdict: OracleVerdict, armed: ConflictGrammarSink, pairs: number): OracleVerdict {
  return verdict.kind === "match" && pairs === 0 && armed.hit ? indeterminate(CONFLICT_COPY_POPULATION_WHY) : verdict;
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

const SCAN_FAILURE_WHY = {
  "unsupported-entry": "unsupported entry type in repo subtree",
  "directory-churn": "repo directory changed during proof",
  "scan-churn": "repo subtree changed during scoped scan",
} as const;
type ScanFailure = keyof typeof SCAN_FAILURE_WHY;

class ScanFailed extends Error {
  constructor(failure: ScanFailure) {
    super(SCAN_FAILURE_WHY[failure]);
  }
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
    private readonly observer?: (observation: PullOracleObservation) => void,
  ) {}

  receiptHash(rel: string): string | undefined {
    return this.records.get(rel)?.receiptHash;
  }

  proveRepo(rel: string): Promise<OracleVerdict> {
    const proof = this.serial(rel, () => this.proveFresh(rel));
    return this.observer ? proof.finally(() => this.observe({ kind: "repo-proved" })) : proof;
  }

  reproveRepo(rel: string): Promise<OracleVerdict> {
    const proof = this.serial(rel, async () => {
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
    return this.observer ? proof.finally(() => this.observe({ kind: "repo-proved" })) : proof;
  }

  private observe(observation: PullOracleObservation): void {
    try {
      this.observer?.(observation);
    } catch {
      // Observation cannot affect receipt proof or pull correctness.
    }
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
    const startedAt = this.observer ? performance.now() : undefined;
    const source = this.source();
    const prepared = {
      expectedMap: indexByPath(source.expected),
      oracleMap: indexByPath(this.oracleManifest),
      preMap: indexByPath(source.preScan),
      touched: source.touched,
      invalidWhy: source.invalidWhy,
    };
    this.prepared = prepared;
    if (startedAt !== undefined) {
      this.observe({
        kind: "prepare",
        ms: performance.now() - startedAt,
        entriesIndexed: prepared.expectedMap.size + prepared.oracleMap.size + prepared.preMap.size,
      });
    }
    return prepared;
  }

  private receipt(kind: "pull" | "state", rel: string, expected: FileEntry[], observed: FileEntry[]): string {
    if (!this.observer) return canonicalReceipt(kind, rel, expected, observed);
    const startedAt = performance.now();
    const hash = canonicalReceipt(kind, rel, expected, observed);
    this.observe({ kind: "receipt-hash", ms: performance.now() - startedAt });
    return hash;
  }

  /** Components AT OR ABOVE `root` are the caller's addressing, not content:
   *  `proveRepo(rel)` addresses this repo BY that path, so neither an ancestor's
   *  name nor the repo's OWN name component is evidence about what the repo
   *  contains. Only components strictly below `root` are content.
   *
   *  The grammar arm is LAST on purpose: an entry the hard exclusions or the
   *  ignore matcher already removed was never going to be compared, so its name
   *  is not why the population emptied. Arming on it would make an ignore rule
   *  such as `*.conflict*` a permanent indeterminate for every repo it covers.
   *
   *  `armed` is passed only for COMPARISON populations. Omit it for the stat/hash
   *  fast-path population (`preScan`, §2.5): filtering it must not decide whether
   *  the comparison itself was emptied by conflict copies. */
  private comparableFor(root: string, eq: ReceiverEquivalence, armed?: ConflictGrammarSink): Comparable {
    return (rel, kind) => {
      if (hardExcluded(rel, eq)) return false;
      if (kind === "leaf" ? this.matcher.ignores(rel) : this.prunedDir(rel)) return false;
      if (!matchesConflictGrammarBelow(rel, root)) return true;
      if (armed) armed.hit = true;
      return false;
    };
  }

  private prunedDir(rel: string): boolean {
    const dirForm = `${rel}/`;
    return this.matcher.prunes?.(dirForm) ?? this.matcher.ignores(dirForm);
  }

  private project(rel: string, eq: ReceiverEquivalence): Projected | OracleVerdict {
    const prepared = this.getPrepared();
    if (prepared.invalidWhy) return indeterminate(prepared.invalidWhy);
    const normalized = normalizeRel(rel);
    if (!normalized) return indeterminate("invalid repo subtree path");
    if ([...this.scanDeferred].some((candidate) => inProjection(candidate, normalized, eq))) {
      return indeterminate("scan deferred in repo subtree");
    }
    const armed: ConflictGrammarSink = { hit: false };
    const comparable = this.comparableFor(normalized, eq, armed);
    const unarmedComparable = this.comparableFor(normalized, eq);
    // `inProjection` stays leftmost: this walks the WHOLE manifest, and only the short-circuit stops foreign entries arming `armed`.
    const filter = (map: Map<string, FileEntry>, keep: Comparable): FileEntry[] => [...map.values()].filter((entry) =>
      inProjection(entry.path, normalized, eq) && keep(entry.path, "leaf"));
    const expected = filter(prepared.expectedMap, comparable);
    const oracle = filter(prepared.oracleMap, comparable);
    // `preScan` is a stat/hash fast-path source, never a comparison population:
    // it must not arm the sink, or a pull that deletes the last conflict copy
    // holds for a cycle telling the user to delete files that no longer exist.
    const preScan = filter(prepared.preMap, unarmedComparable);
    return {
      expected,
      oracle,
      preScan,
      armed,
      comparable,
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

    const inventory = await this.inventory(rel, eq, projected.comparable);
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

    const downgraded = downgradeIfEmptied(semantic, projected.armed, projected.expected.length);
    if (downgraded !== semantic) return this.settle(rel, downgraded);
    const receiptHash = this.receipt(this.kind, rel, projected.oracle, projected.expected);
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

  private async inventory(rel: string, eq: ReceiverEquivalence, comparable: Comparable): Promise<{ kind: "ok"; entries: InventoryEntry[]; tokens: ProofTokens } | { kind: "indeterminate"; why: string }> {
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
          if (!comparable(childRel, "dir")) continue;
          await walk(childRel);
        } else if (child.type === "other") {
          if (!this.matcher.ignores(childRel)) throw new ScanFailed("unsupported-entry");
        } else if (comparable(childRel, "leaf")) {
          entries.push({ path: childRel, type: child.type });
        }
      }
      const after = await readToken(absDir);
      if (!sameToken(before, after)) throw new ScanFailed("directory-churn");
      tokens.directories.set(dirRel, after);
    };
    try {
      const scope = await readToken(this.abs(rel));
      if (scope.kind === "absent") {
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "file" || scope.kind === "symlink") {
        if (comparable(rel, "leaf")) entries.push({ path: rel, type: scope.kind });
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "dir") {
        await walk(rel);
      } else {
        throw new ScanFailed("unsupported-entry");
      }
      return { kind: "ok", entries, tokens };
    } catch (error) {
      const why = error instanceof ScanFailed ? error.message : "repo subtree inventory could not be read";
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
    const scanned = await this.scopedScan(rel, eq, projected.comparable);
    if (scanned.kind === "indeterminate") {
      const verdict = indeterminate(scanned.why);
      return this.settle(rel, verdict);
    }
    const verdict = await compareEntries(scanned.files, projected.oracle, eq, this.root);
    if (verdict.kind === "indeterminate") {
      return this.settle(rel, verdict);
    }
    const downgraded = downgradeIfEmptied(verdict, projected.armed, scanned.files.length);
    if (downgraded !== verdict) return this.settle(rel, downgraded);
    const receiptHash = this.receipt(this.kind, rel, projected.oracle, scanned.files);
    this.records.set(rel, { verdict, receiptHash, tokens: verdict.kind === "match" ? scanned.tokens : undefined });
    return verdict;
  }

  private async scopedScan(rel: string, eq: ReceiverEquivalence, comparable: Comparable): Promise<CompleteScan> {
    const files: FileEntry[] = [];
    const tokens: ProofTokens = { entries: new Map(), directories: new Map() };
    const cache = await this.getHashCache();

    const scanLeaf = async (leafRel: string, expectedType?: DirCacheChild["type"]): Promise<void> => {
      const abs = this.abs(leafRel);
      const before = await fs.lstat(abs);
      const kind = tokenKind(before);
      if (expectedType && kind !== expectedType) throw new ScanFailed("scan-churn");
      if (kind === "symlink") {
        const target = await fs.readlink(abs);
        const after = await readToken(abs);
        if (!sameToken(tokenFromStat(before), after)) throw new ScanFailed("scan-churn");
        files.push({ path: leafRel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 });
        tokens.entries.set(leafRel, after);
        return;
      }
      if (kind !== "file") throw new ScanFailed("unsupported-entry");
      await fs.access(abs, constants.R_OK);
      let sha256 = cache.lookup(leafRel, before.mtimeMs, before.size, before.ctimeMs);
      let after = tokenFromStat(before);
      if (!sha256) {
        sha256 = await hashFile(abs, before.size);
        const post = await fs.lstat(abs);
        if (!statsStableAcrossHash(before, post)) throw new ScanFailed("scan-churn");
        after = tokenFromStat(post);
        cache.record(leafRel, { mtimeMs: post.mtimeMs, size: post.size, ctimeMs: post.ctimeMs, sha256 });
      }
      files.push({ path: leafRel, type: "file", sha256, size: after.size!, mode: after.executable!, mtimeMs: after.mtimeMs! });
      tokens.entries.set(leafRel, after);
    };

    const walk = async (dirRel: string): Promise<void> => {
      const absDir = this.abs(dirRel);
      const before = await readToken(absDir);
      if (before.kind !== "dir") throw new ScanFailed("scan-churn");
      const children = await fs.readdir(absDir, { withFileTypes: true });
      for (const child of children) {
        const childRel = dirRel === "." ? child.name : `${dirRel}/${child.name}`;
        if (hardExcluded(childRel, eq)) continue;
        if (child.isDirectory()) {
          if (!comparable(childRel, "dir")) continue;
          await walk(childRel);
        } else {
          const type: DirCacheChild["type"] = child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
          if (type === "other") {
            if (!this.matcher.ignores(childRel)) throw new ScanFailed("unsupported-entry");
          } else if (comparable(childRel, "leaf")) await scanLeaf(childRel, type);
        }
      }
      const after = await readToken(absDir);
      if (!sameToken(before, after)) throw new ScanFailed("scan-churn");
      tokens.directories.set(dirRel, after);
    };

    try {
      const scope = await readToken(this.abs(rel));
      if (scope.kind === "absent") {
        tokens.entries.set(rel, scope);
      } else if (scope.kind === "dir") {
        await walk(rel);
      } else if (scope.kind === "file" || scope.kind === "symlink") {
        if (comparable(rel, "leaf")) await scanLeaf(rel, scope.kind);
      } else {
        throw new ScanFailed("unsupported-entry");
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { kind: "ok", files, tokens };
    } catch (error) {
      const why = error instanceof ScanFailed ? error.message : "repo subtree could not be scanned";
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
  observer?: (observation: PullOracleObservation) => void;
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
      invalidWhy,
    };
  };
  return new ManifestOracle("pull", opts.root, opts.matcher, source, opts.oracle, opts.scanDeferred, opts.dircache, opts.hashcache, opts.observer);
}

export function oracleFromState(opts: {
  base: Manifest;
  matcher: IgnoreMatcher;
  root: string;
}): AppliedManifestOracle {
  return new ManifestOracle("state", opts.root, opts.matcher, () => ({ expected: opts.base, preScan: opts.base, touched: new Set() }), opts.base, new Set(), undefined);
}
