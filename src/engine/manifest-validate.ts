/**
 * Shared, dependency-free manifest validation — imported by BOTH the control
 * plane (Worker/DO, before a commit advances the sequence) and the client
 * (before apply touches the filesystem). Never trust a manifest off the wire:
 * a malicious or corrupt one with `../`, an absolute path, or a NUL byte could
 * otherwise escape the workspace root (`path.join(root, entry.path)`).
 *
 * Pure string logic only (no node:*), so it bundles cleanly into the Worker.
 */
import type { JsonValue } from "../json.js";
import type { FileEntry, GitArtifactRef, GitPackLink, GitRefTombstone, GitSection, Manifest } from "./types.js";

/** What a validator is actually handed: JSON straight off the wire, or an
 *  in-memory value of the domain type whose contract it must still establish
 *  (a sender re-checking what it built, a reader re-checking a carried record). */
export type WireCandidate<T> = T | JsonValue;

export const MAX_PATH_BYTES = 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024; // hard ceiling on serialized manifest
export const MAX_SYMLINK_TARGET_BYTES = 4096;

/** The newest manifest schema this client understands. Schema 4 adds compression descriptors. */
export const KNOWN_MANIFEST_SCHEMA = 4;
export const MAX_PACK_CHAIN = 8;
/** Bound on `gitRepos` entries — raise-on-measurement; a LOUD error at the boundary, never a
 *  silent drop (§30's lesson; design 43 §2). */
export const MAX_GIT_REPOS = 256;
export const MAX_REF_TOMBSTONES_PER_REF = 16;
export const MAX_REF_TOMBSTONES_PER_REPO = 512;

const SHA_RE = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const utf8 = new TextEncoder();
const isNonNegativeInteger = (v: number | undefined): v is number => v !== undefined && Number.isInteger(v) && v >= 0;
const isNonNegativeSafeInteger = (v: number | undefined): v is number => v !== undefined && Number.isSafeInteger(v) && v >= 0;
const isObj = <T>(v: T): v is T & object => v !== null && typeof v === "object" && !Array.isArray(v);

/** Pure check-ref-format subset for the only namespace design 130 admits. */
function validTombstoneBranchRef(ref: string): boolean {
  if (!ref.startsWith("refs/heads/")) return false;
  const tail = ref.slice("refs/heads/".length);
  if (!tail || tail.startsWith("/") || tail.endsWith("/") || tail.endsWith(".")) return false;
  if (tail.includes("//") || tail.includes("..") || tail.includes("@{")) return false;
  if (/[\x00-\x20\x7f~^:?*\[\\]/.test(tail)) return false;
  return tail.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

const canonicalUtcMilliseconds = (value: string | undefined): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

/** Strict reader-side validation for the optional design-130 wire fields. Their joint
 * absence is the skew-compatible old-writer shape; once either is present, both fields
 * and the complete bounded container must be valid before an attestation can be built. */
export function validateRefTombstones(section: Partial<GitSection>): GitSectionValidation {
  const raw = section.refTombstones;
  const generation = section.refTombstoneGeneration;
  if (raw === undefined && generation === undefined) return { ok: true };
  if (raw === undefined || generation === undefined) return { ok: false, reason: "incomplete ref tombstone fields" };
  if (!isObj(raw)) return { ok: false, reason: "bad refTombstones" };
  if (!isNonNegativeSafeInteger(generation)) return { ok: false, reason: "bad refTombstoneGeneration" };
  let total = 0;
  let maximum = 0;
  for (const [ref, value] of Object.entries(raw as Partial<Record<string, Array<Partial<GitRefTombstone>>>>)) {
    if (!validTombstoneBranchRef(ref)) return { ok: false, reason: `bad tombstone ref ${ref}` };
    if (!Array.isArray(value) || value.length === 0) return { ok: false, reason: `bad tombstone chain ${ref}` };
    if (value.length > MAX_REF_TOMBSTONES_PER_REF) return { ok: false, reason: `tombstone chain ${ref} exceeds ${MAX_REF_TOMBSTONES_PER_REF}` };
    total += value.length;
    if (total > MAX_REF_TOMBSTONES_PER_REPO) return { ok: false, reason: `refTombstones exceeds ${MAX_REF_TOMBSTONES_PER_REPO}` };
    const seen = new Set<string>();
    let priorGeneration = 0;
    for (const item of value) {
      if (!isObj(item)) return { ok: false, reason: `bad tombstone entry ${ref}` };
      const entry = item as Partial<GitRefTombstone>;
      if (Object.keys(entry).sort().join(",") !== "generation,oid,ts") return { ok: false, reason: `bad tombstone entry ${ref}` };
      if (typeof entry.oid !== "string" || !HEX40.test(entry.oid)) return { ok: false, reason: `bad tombstone oid ${ref}` };
      if (seen.has(entry.oid)) return { ok: false, reason: `duplicate tombstone oid ${ref}` };
      seen.add(entry.oid);
      if (!canonicalUtcMilliseconds(entry.ts)) return { ok: false, reason: `bad tombstone timestamp ${ref}` };
      if (!isNonNegativeSafeInteger(entry.generation) || entry.generation === 0 || entry.generation <= priorGeneration) {
        return { ok: false, reason: `bad tombstone generation ${ref}` };
      }
      priorGeneration = entry.generation;
      maximum = Math.max(maximum, entry.generation);
    }
  }
  if (generation < maximum) return { ok: false, reason: "refTombstoneGeneration below retained entry" };
  if (generation === 0 && total !== 0) return { ok: false, reason: "zero refTombstoneGeneration with non-empty chains" };
  return { ok: true };
}

/** A relative POSIX path that cannot escape the root or smuggle control bytes. */
export function isSafeRelPath(p: string | undefined): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (utf8.encode(p).length > MAX_PATH_BYTES) return false;
  if (p.includes("\0") || p.includes("\\")) return false; // NUL, backslash (Windows-style / smuggling)
  if (p.startsWith("/")) return false; // absolute
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false; // empty (//, leading/trailing /), . , ..
  }
  return true;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

/** A git-section verdict: every refusal carries the reason that produced it. */
export type GitSectionValidation = { ok: true } | { ok: false; reason: string };

/** The exact case-equivalence contract used by manifest wire validation. Keep
 * local publication projection on this helper: locale/filesystem-specific
 * folding would let a writer author a manifest a reader rejects. */
export function manifestPathCaseFold(path: string): string {
  return path.toLowerCase();
}

export interface CaseFoldCollisionGroup {
  /** Distinct raw paths in deterministic code-point order. */
  paths: string[];
}

/** Return every group of distinct paths that aliases under the wire manifest's
 * case-insensitive path rule. Exact duplicate paths remain the validator's
 * separate `duplicate path` error and are intentionally not classified here. */
export function caseFoldCollisionGroups(
  entries: readonly { path: string }[],
): CaseFoldCollisionGroup[] {
  const byFold = new Map<string, Set<string>>();
  for (const entry of entries) {
    const fold = manifestPathCaseFold(entry.path);
    let paths = byFold.get(fold);
    if (!paths) byFold.set(fold, paths = new Set());
    paths.add(entry.path);
  }
  return [...byFold.entries()]
    .filter(([, paths]) => paths.size > 1)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([, paths]) => ({ paths: [...paths].sort() }));
}

/** Validate the standalone gitRepos map using the same rules as a manifest.
 * `schema` and `filePaths` let validateManifest additionally enforce its schema
 * gates and file/repo collision rule; persisted fold evidence uses the newest
 * understood schema because the described manifest was already validated. */
export function validateGitRepos(
  gitRepos: WireCandidate<Manifest["gitRepos"]>,
  schema: number = KNOWN_MANIFEST_SCHEMA,
  filePaths: ReadonlySet<string> = new Set(),
): ValidationResult {
  if (!isObj(gitRepos)) return { ok: false, error: "manifest.gitRepos is not an object" };
  const repos = gitRepos as Partial<Record<string, Partial<GitSection>>>;
  if (schema < 2) return { ok: false, error: "gitRepos requires manifestSchema >= 2" };
  const keys = Object.keys(gitRepos);
  if (keys.length > MAX_GIT_REPOS) return { ok: false, error: `too many git repos (${keys.length} > ${MAX_GIT_REPOS})` };
  const seenGitLower = new Set<string>();
  for (const key of keys) {
    if (!(key === "." || isSafeRelPath(key))) return { ok: false, error: `unsafe gitRepos key: ${JSON.stringify(key)}` };
    const lower = key.toLowerCase();
    if (seenGitLower.has(lower)) return { ok: false, error: `case-insensitive duplicate gitRepos key: ${key}` };
    seenGitLower.add(lower);
    if (filePaths.has(key)) return { ok: false, error: `gitRepos key collides with a file entry: ${key}` };
    const section = repos[key];
    if (section === null || typeof section !== "object") return { ok: false, error: `gitRepos[${key}] is not an object` };
    if (gitSectionRequiresSchema4(section) && schema < 4) return { ok: false, error: "compressed entries require manifestSchema >= 4" };
    const gv = validateGitSection(section);
    if (!gv.ok) return { ok: false, error: `gitRepos[${key}]: ${gv.reason}` };
    if (packChainRequiresSchema3(section) && schema < 3) return { ok: false, error: `gitRepos[${key}]: packChain requires manifestSchema >= 3` };
  }
  return { ok: true };
}

/**
 * Validate a parsed manifest object. Returns the first problem found, or ok.
 * Enforces: safe relative paths, no duplicate or file/descendant paths (incl.
 * case-insensitive, for APFS/NTFS collisions), known types, well-formed
 * shas/modes, bounded size. Deliberately NOT the workspace entry cap: #838
 * moved it to its only owner, `entryCapTrips` in cli/sync/policy.ts — a
 * receiver must accept any size it is handed, or an over-cap chain wedges
 * with no path back under the cap.
 */
export function validateManifest(m: WireCandidate<Partial<Manifest>>): ValidationResult {
  if (m == null || typeof m !== "object") return { ok: false, error: "manifest is not an object" };
  const files: unknown = (m as { files?: unknown }).files;
  if (!Array.isArray(files)) return { ok: false, error: "manifest.files is not an array" };
  const mm = m as Partial<Manifest> & { git?: unknown };
  const schema = mm.manifestSchema;

  const seen = new Set<string>();
  const seenLower = new Set<string>();
  const pathsLower: string[] = [];

  for (const entry of files) {
    if (entry == null || typeof entry !== "object") return { ok: false, error: "entry is not an object" };
    const e = entry as Partial<FileEntry>;

    if (!isSafeRelPath(e.path)) return { ok: false, error: `unsafe path: ${JSON.stringify(e.path)}` };
    const p = e.path;

    if (seen.has(p)) return { ok: false, error: `duplicate path: ${p}` };
    const lower = manifestPathCaseFold(p);
    if (seenLower.has(lower)) return { ok: false, error: `case-insensitive duplicate path: ${p}` };
    seen.add(p);
    seenLower.add(lower);
    pathsLower.push(lower);

    if (e.type !== "file" && e.type !== "symlink") return { ok: false, error: `bad type for ${p}: ${JSON.stringify(e.type)}` };
    if (typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256)) return { ok: false, error: `bad sha256 for ${p}` };
    if (e.encSha !== undefined && (typeof e.encSha !== "string" || !SHA_RE.test(e.encSha))) return { ok: false, error: `bad encSha for ${p}` };
    if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) return { ok: false, error: `bad size for ${p}` };
    if (typeof e.mode !== "number" || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) return { ok: false, error: `bad mode for ${p}` };
    if (e.comp !== undefined) {
      if (typeof schema !== "number" || schema < 4) return { ok: false, error: "compressed entries require manifestSchema >= 4" };
      if (e.comp !== "zstd") return { ok: false, error: `bad comp for ${p}` };
      if (typeof e.payloadSha !== "string" || !SHA_RE.test(e.payloadSha)) return { ok: false, error: `bad payloadSha for ${p}` };
      if (!isNonNegativeInteger(e.cipherSize)) return { ok: false, error: `bad cipherSize for ${p}` };
      if (e.encSha === undefined) return { ok: false, error: `compressed entry missing encSha for ${p}` };
    } else {
      if (e.payloadSha !== undefined) return { ok: false, error: `payloadSha without comp for ${p}` };
      if (e.cipherSize !== undefined) return { ok: false, error: `cipherSize without comp for ${p}` };
    }

    if (e.type === "symlink") {
      const t = e.symlinkTarget;
      if (typeof t !== "string" || t.length === 0) return { ok: false, error: `symlink ${p} missing target` };
      if (t.includes("\0")) return { ok: false, error: `symlink ${p} target has NUL` };
      if (utf8.encode(t).length > MAX_SYMLINK_TARGET_BYTES) return { ok: false, error: `symlink ${p} target too long` };
      // Note: the target STRING may point anywhere (legitimate symlinks do). Writing a symlink
      // does not write *through* it; the real defense against a symlink+file traversal combo is
      // the apply-time realpath-within-root guard (see apply.ts), not target validation here.
    }
  }

  // File/descendant entries cannot coexist because one path must materialize as
  // both a file and a directory. Match case-insensitively like duplicate paths.
  for (const child of pathsLower) {
    for (let idx = child.lastIndexOf("/"); idx > 0; idx = child.lastIndexOf("/", idx - 1)) {
      const parent = child.slice(0, idx);
      if (seenLower.has(parent)) return { ok: false, error: `file/descendant path collision: ${parent} and ${child}` };
    }
  }

  // ---- schema gate + gitRepos (design 43 §2) --------------------------------
  // Clean break: pre-§43 single-repo `git` sections are refused loudly, never migrated.
  if (mm.git !== undefined) {
    return { ok: false, error: "workspace synced by an older rbox — re-init (legacy `git` section is no longer supported)" };
  }
  if (schema !== undefined && (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1)) {
    return { ok: false, error: `bad manifestSchema: ${JSON.stringify(schema)}` };
  }
  if (typeof schema === "number" && schema > KNOWN_MANIFEST_SCHEMA) {
    return { ok: false, error: `manifest schema ${schema} is newer than this client understands — upgrade rbox` };
  }

  const gitRepos = mm.gitRepos;
  if (gitRepos !== undefined) {
    if (!isObj(gitRepos)) {
      return { ok: false, error: "manifest.gitRepos is not an object" };
    }
    if (typeof schema !== "number" || schema < 2) return { ok: false, error: "gitRepos requires manifestSchema >= 2" };
    const reposValidation = validateGitRepos(gitRepos, schema, seen);
    if (!reposValidation.ok) return reposValidation;
  }
  return { ok: true };
}

// ---- git section validation (pure string logic — shared with git-state.ts) ----

// Op-state paths (relative to the resolved gitdir) that let you continue a paused
// operation. AUTO_MERGE: git >= 2.38's ort merge writes it (design 43 §5 [v2, minor]).
export const OP_STATE_FILES = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD", "MERGE_MSG", "AUTO_MERGE"] as const;
export const OP_STATE_DIRS = ["rebase-merge", "rebase-apply", "sequencer"] as const;

export type OpStateRoot = typeof OP_STATE_FILES[number] | typeof OP_STATE_DIRS[number];
export type OpStateClassification = "breadcrumb" | "in-progress";

/** Explicit by design: a newly-added op-state root must not silently inherit a
 * safety classification. The `satisfies` constraint makes omission a typecheck
 * failure, while `as const` preserves the individually-reviewed literals.
 *
 * `in-progress` means what GIT means by it (`wt_status_get_state`): MERGE_HEAD
 * (merge), CHERRY_PICK_HEAD, REVERT_HEAD, a `rebase-merge/`/`rebase-apply/`
 * directory (presence alone — see pruneEmptyOpStateDirs), or `sequencer/`.
 * Everything else is a breadcrumb: a file git leaves behind that no `git
 * --continue`/`--abort` consumes and `git status` does not report.
 *
 * MERGE_MSG and AUTO_MERGE were in-progress until a paying customer's repo sat
 * unresolvable for seven days behind "a Git operation is in progress" with a
 * clean tree, no MERGE_HEAD, and nothing for git to finish or abort. Both are
 * routinely left behind by CONCLUDED operations — MERGE_MSG is a commit-message
 * draft (git writes it before the merge/cherry-pick commit and does not always
 * remove it after), AUTO_MERGE is ort's scratch tree — so treating either as an
 * operation makes the refusal unactionable: the user cannot clear a state git
 * does not believe it is in. Design 126 §"Design" picked in-progress for both on
 * the theory that a false deferral is merely "a visible deferral, safe
 * direction"; the field showed a false deferral is instead a permanent strand,
 * and even foresaw the AUTO_MERGE-after-squash false-defer. Nothing is lost:
 * every real operation that writes them also writes a marker above.
 *
 * REBASE_HEAD is also a breadcrumb. Design 126 deferred that classification
 * until field evidence existed; a concluded linked-worktree rebase has now
 * left it behind. Git's resumability authority is the rebase directory, not
 * this file, so every live rebase still has an in-progress marker above. */
export const OP_STATE_CLASSIFICATION = {
  MERGE_HEAD: "in-progress",
  REBASE_HEAD: "breadcrumb",
  CHERRY_PICK_HEAD: "in-progress",
  REVERT_HEAD: "in-progress",
  ORIG_HEAD: "breadcrumb",
  MERGE_MSG: "breadcrumb",
  AUTO_MERGE: "breadcrumb",
  "rebase-merge": "in-progress",
  "rebase-apply": "in-progress",
  sequencer: "in-progress",
} as const satisfies Record<OpStateRoot, OpStateClassification>;

/** Compile-only negative case: extending the op-state universe without adding
 * a classification must remain an error. Kept in an uncalled function so the
 * root `tsc --noEmit` gate exercises the failure contract directly. */
function opStateClassificationExhaustivenessTypecheckOnly(): void {
  type HypotheticalFutureRoot = OpStateRoot | "UNCLASSIFIED_FUTURE_ROOT";
  function requireEveryRootClassified(_map: Record<HypotheticalFutureRoot, OpStateClassification>): void {}
  // @ts-expect-error UNCLASSIFIED_FUTURE_ROOT deliberately has no map entry.
  requireEveryRootClassified(OP_STATE_CLASSIFICATION);
}
void opStateClassificationExhaustivenessTypecheckOnly;

/** Only these ref namespaces sync. NOT refs/remotes (machine-local origins),
 *  refs/notes, refs/replace, or refs/rbox-* (our internal scratch). */
export function isSyncableRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/") || ref === "refs/stash";
}

function validArtifactRef(ref: Partial<GitArtifactRef>): ref is GitArtifactRef {
  if (!isObj(ref)) return false;
  return (
    typeof ref.sha === "string" &&
    SHA_RE.test(ref.sha) &&
    typeof ref.encSha === "string" &&
    SHA_RE.test(ref.encSha) &&
    isNonNegativeInteger(ref.cipherSize) &&
    validCompressionFields(ref.comp, ref.payloadSha)
  );
}

function validCompressionFields(comp: "zstd" | undefined, payloadSha: string | undefined): boolean {
  if (comp === undefined) return payloadSha === undefined;
  return comp === "zstd" && typeof payloadSha === "string" && SHA_RE.test(payloadSha);
}

function packChainRequiresSchema3(section: Partial<GitSection>): boolean {
  if (!isObj(section)) return false;
  return Array.isArray(section?.packChain) && section.packChain.length > 0;
}

function refHasCompressionFields(r: Partial<GitArtifactRef>): boolean {
  if (!isObj(r)) return false;
  return r?.comp !== undefined || r?.payloadSha !== undefined;
}

/** Shared by the commit-side schema stamper (sync.ts) and this file's schema-4
 *  gates: stamping and validation MUST agree on which fields imply schema 4,
 *  or a client could stamp a manifest its own validator then rejects. */
export function manifestRequiresSchema4(m: Pick<Manifest, "files" | "gitRepos">): boolean {
  return m.files.some((f) => f.comp !== undefined) || Object.values(m.gitRepos ?? {}).some(gitSectionRequiresSchema4);
}

function gitSectionRequiresSchema4(section: Partial<GitSection>): boolean {
  if (!isObj(section)) return false;
  if (section.bundleComp !== undefined || section.bundlePayloadSha !== undefined || section.indexComp !== undefined || section.indexPayloadSha !== undefined) return true;
  if (Array.isArray(section.packChain) && section.packChain.some(refHasCompressionFields)) return true;
  const opState = section.opState;
  return !!opState && typeof opState === "object" && !Array.isArray(opState) && Object.values(opState).some(refHasCompressionFields);
}

function invalidPackChainReason(packChain: Partial<GitPackLink>[] | undefined): string | undefined {
  if (packChain === undefined) return undefined;
  if (!Array.isArray(packChain)) return "bad packChain";
  if (packChain.length + 1 > MAX_PACK_CHAIN) return `packChain exceeds ${MAX_PACK_CHAIN} total links`;
  for (let i = 0; i < packChain.length; i++) {
    const link = packChain[i];
    if (!isObj(link)) return `bad packChain ref ${i}`;
    if (!Array.isArray(link.tips) || link.tips.length === 0) return `bad packChain tips ${i}`;
    const tips = link.tips;
    if (!validArtifactRef(link)) return `bad packChain ref ${i}`;
    for (const tip of tips) {
      if (typeof tip !== "string" || !HEX40.test(tip)) return `bad packChain tip ${i}`;
    }
  }
  return undefined;
}

/** Reject a malformed/hostile git section before it touches `.git`. Runs on wire data
 *  (inside validateManifest) so every field is treated as untrusted. */
export function validateGitSection(input: WireCandidate<Partial<GitSection>>): GitSectionValidation {
  if (!isObj(input)) return { ok: false, reason: "bad git section" };
  const s = input as Partial<GitSection>;
  // §28: the bundle is mandatory and addressed by both its plaintext sha (decrypt-verify) and
  // its encSha (the ciphertext blob actually fetched). Both must be well-formed.
  if (typeof s.bundleSha !== "string" || !SHA_RE.test(s.bundleSha) || typeof s.bundleEncSha !== "string" || !SHA_RE.test(s.bundleEncSha)) return { ok: false, reason: "bad bundle sha/encSha" };
  if (!isNonNegativeInteger(s.bundleCipherSize)) return { ok: false, reason: "bad bundleCipherSize" };
  if (!validCompressionFields(s.bundleComp, s.bundlePayloadSha)) return { ok: false, reason: "bad bundle compression" };
  const packChainReason = invalidPackChainReason(s.packChain);
  if (packChainReason) return { ok: false, reason: packChainReason };
  // index is optional but, if present, both shas + size travel together.
  if (s.indexSha || s.indexEncSha || s.indexCipherSize !== undefined || s.indexComp !== undefined || s.indexPayloadSha !== undefined) {
    if (!validArtifactRef({ sha: s.indexSha!, encSha: s.indexEncSha!, cipherSize: s.indexCipherSize!, comp: s.indexComp, payloadSha: s.indexPayloadSha })) return { ok: false, reason: "bad index ref" };
  }
  // HEAD is either detached (40-hex) or symbolic onto a BRANCH the section itself carries —
  // capture can produce nothing else (an unborn HEAD never captures), so a symbolic HEAD
  // outside refs/heads/* or naming a branch absent from `refs` is malformed/hostile: applying
  // it would leave an unborn HEAD over restored index entries (codex repro).
  if (typeof s.head !== "string" || !/^(ref: refs\/heads\/[A-Za-z0-9._\/-]+|[0-9a-f]{40})$/.test(s.head.trim())) return { ok: false, reason: "bad HEAD" };
  const refs = s.refs;
  if (!isObj(refs)) return { ok: false, reason: "bad refs" };
  for (const [ref, sha] of Object.entries(refs)) {
    if (!isSyncableRef(ref) || ref.includes("..") || ref.includes("\0")) return { ok: false, reason: `bad ref ${ref}` };
    if (typeof sha !== "string" || !HEX40.test(sha)) return { ok: false, reason: `bad ref sha ${ref}` };
  }
  const headBranch = /^ref: (refs\/heads\/\S+)$/.exec(s.head.trim())?.[1];
  if (headBranch && refs[headBranch] === undefined) return { ok: false, reason: `HEAD branch ${headBranch} not in refs` };
  const tombstones = validateRefTombstones(s);
  if (!tombstones.ok) return tombstones;
  const opState = s.opState == null ? {} : s.opState;
  if (typeof opState !== "object" || Array.isArray(opState)) return { ok: false, reason: "bad opState" };
  for (const [rel, ref] of Object.entries(opState)) {
    const okRel = (OP_STATE_FILES as readonly string[]).includes(rel) || OP_STATE_DIRS.some((d) => rel.startsWith(`${d}/`));
    if (!okRel || rel.includes("..") || rel.includes("\0") || rel.startsWith("/")) return { ok: false, reason: `bad opState ${rel}` };
    if (!validArtifactRef(ref)) return { ok: false, reason: `bad opState ref ${rel}` };
  }
  // Design 93 v12: `config` is an additive convenience field. Reader-side
  // invalidity must never make the containing Git section (and therefore the
  // whole manifest) fatal. The consuming config lane validates it, logs once,
  // and treats an invalid field as absent; Git state remains independently safe
  // to apply because none of the logic below consumes `config`.
  // design 43 §2: refScope is mandatory — it gates apply-side ref deletion (§7).
  if (s.refScope !== "all" && s.refScope !== "scoped") return { ok: false, reason: "bad refScope" };
  return { ok: true };
}
