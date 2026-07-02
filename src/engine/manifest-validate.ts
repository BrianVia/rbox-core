/**
 * Shared, dependency-free manifest validation — imported by BOTH the control
 * plane (Worker/DO, before a commit advances the sequence) and the client
 * (before apply touches the filesystem). Never trust a manifest off the wire:
 * a malicious or corrupt one with `../`, an absolute path, or a NUL byte could
 * otherwise escape the workspace root (`path.join(root, entry.path)`).
 *
 * Pure string logic only (no node:*), so it bundles cleanly into the Worker.
 */
import type { GitArtifactRef, GitSection } from "./types.js";

export const MAX_PATH_BYTES = 1024;
export const MAX_ENTRIES = 200_000; // monorepo headroom; plan-tied caps come in M7b
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024; // hard ceiling on serialized manifest
export const MAX_SYMLINK_TARGET_BYTES = 4096;

/** The newest manifest schema this client understands (design 43 §2). Schema 2 = `gitRepos`
 *  map (per-repo git sections). Absent/1 = pre-§43. Anything newer is refused loudly. */
export const KNOWN_MANIFEST_SCHEMA = 2;
/** Bound on `gitRepos` entries — raise-on-measurement; a LOUD error at the boundary, never a
 *  silent drop (§30's lesson; design 43 §2). */
export const MAX_GIT_REPOS = 256;

const SHA_RE = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const utf8 = new TextEncoder();

/** A relative POSIX path that cannot escape the root or smuggle control bytes. */
export function isSafeRelPath(p: unknown): p is string {
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

/**
 * Validate a parsed manifest object. Returns the first problem found, or ok.
 * Enforces: safe relative paths, no duplicate paths (incl. case-insensitive,
 * for APFS/NTFS collisions), known types, well-formed shas/modes, bounded size.
 */
export function validateManifest(m: unknown): ValidationResult {
  if (m == null || typeof m !== "object") return { ok: false, error: "manifest is not an object" };
  const files: unknown = (m as { files?: unknown }).files;
  if (!Array.isArray(files)) return { ok: false, error: "manifest.files is not an array" };
  if (files.length > MAX_ENTRIES) return { ok: false, error: `too many entries (${files.length} > ${MAX_ENTRIES})` };

  const seen = new Set<string>();
  const seenLower = new Set<string>();

  for (const entry of files) {
    if (entry == null || typeof entry !== "object") return { ok: false, error: "entry is not an object" };
    const e = entry as Record<string, unknown>;

    if (!isSafeRelPath(e.path)) return { ok: false, error: `unsafe path: ${JSON.stringify(e.path)}` };
    const p = e.path as string;

    if (seen.has(p)) return { ok: false, error: `duplicate path: ${p}` };
    const lower = p.toLowerCase();
    if (seenLower.has(lower)) return { ok: false, error: `case-insensitive duplicate path: ${p}` };
    seen.add(p);
    seenLower.add(lower);

    if (e.type !== "file" && e.type !== "symlink") return { ok: false, error: `bad type for ${p}: ${JSON.stringify(e.type)}` };
    if (typeof e.sha256 !== "string" || !SHA_RE.test(e.sha256)) return { ok: false, error: `bad sha256 for ${p}` };
    if (e.encSha !== undefined && (typeof e.encSha !== "string" || !SHA_RE.test(e.encSha))) return { ok: false, error: `bad encSha for ${p}` };
    if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size < 0) return { ok: false, error: `bad size for ${p}` };
    if (typeof e.mode !== "number" || !Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) return { ok: false, error: `bad mode for ${p}` };

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

  // ---- schema gate + gitRepos (design 43 §2) --------------------------------
  const mm = m as Record<string, unknown>;
  // Clean break: pre-§43 single-repo `git` sections are refused loudly, never migrated.
  if (mm.git !== undefined) {
    return { ok: false, error: "workspace synced by an older rbox — re-init (legacy `git` section is no longer supported)" };
  }
  const schema = mm.manifestSchema;
  if (schema !== undefined && (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1)) {
    return { ok: false, error: `bad manifestSchema: ${JSON.stringify(schema)}` };
  }
  if (typeof schema === "number" && schema > KNOWN_MANIFEST_SCHEMA) {
    return { ok: false, error: `manifest schema ${schema} is newer than this client understands — upgrade rbox` };
  }

  const gitRepos = mm.gitRepos;
  if (gitRepos !== undefined) {
    if (gitRepos === null || typeof gitRepos !== "object" || Array.isArray(gitRepos)) {
      return { ok: false, error: "manifest.gitRepos is not an object" };
    }
    if (typeof schema !== "number" || schema < 2) return { ok: false, error: "gitRepos requires manifestSchema >= 2" };
    const keys = Object.keys(gitRepos);
    if (keys.length > MAX_GIT_REPOS) return { ok: false, error: `too many git repos (${keys.length} > ${MAX_GIT_REPOS})` };
    const seenGitLower = new Set<string>();
    for (const key of keys) {
      // isSafeRelPath rejects "." itself, hence the explicit disjunct (design 43 §2 [v2]).
      if (!(key === "." || isSafeRelPath(key))) return { ok: false, error: `unsafe gitRepos key: ${JSON.stringify(key)}` };
      const lower = key.toLowerCase();
      if (seenGitLower.has(lower)) return { ok: false, error: `case-insensitive duplicate gitRepos key: ${key}` };
      seenGitLower.add(lower);
      // A repo key must not equal any FILE/symlink entry's path [v2, B5] — a colliding entry
      // could redirect the repo materialization through a synced symlink.
      if (seen.has(key)) return { ok: false, error: `gitRepos key collides with a file entry: ${key}` };
      const section = (gitRepos as Record<string, unknown>)[key];
      if (section === null || typeof section !== "object") return { ok: false, error: `gitRepos[${key}] is not an object` };
      const gv = validateGitSection(section as GitSection);
      if (!gv.ok) return { ok: false, error: `gitRepos[${key}]: ${gv.reason}` };
    }
  }
  return { ok: true };
}

// ---- git section validation (pure string logic — shared with git-state.ts) ----

// Op-state paths (relative to the resolved gitdir) that let you continue a paused
// operation. AUTO_MERGE: git >= 2.38's ort merge writes it (design 43 §5 [v2, minor]).
export const OP_STATE_FILES = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD", "MERGE_MSG", "AUTO_MERGE"];
export const OP_STATE_DIRS = ["rebase-merge", "rebase-apply", "sequencer"];

/** Only these ref namespaces sync. NOT refs/remotes (machine-local origins),
 *  refs/notes, refs/replace, or refs/rbox-* (our internal scratch). */
export function isSyncableRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/") || ref === "refs/stash";
}

/** Reject a malformed/hostile artifact ref before it touches `.git`. */
function validArtifactRef(r: GitArtifactRef | undefined): boolean {
  return !!r && typeof r === "object" && typeof r.sha === "string" && SHA_RE.test(r.sha) && typeof r.encSha === "string" && SHA_RE.test(r.encSha) && Number.isInteger(r.cipherSize) && r.cipherSize >= 0;
}

/** Reject a malformed/hostile git section before it touches `.git`. Runs on wire data
 *  (inside validateManifest) so every field is treated as untrusted. */
export function validateGitSection(s: GitSection): { ok: boolean; reason?: string } {
  // §28: the bundle is mandatory and addressed by both its plaintext sha (decrypt-verify) and
  // its encSha (the ciphertext blob actually fetched). Both must be well-formed.
  if (typeof s.bundleSha !== "string" || !SHA_RE.test(s.bundleSha) || typeof s.bundleEncSha !== "string" || !SHA_RE.test(s.bundleEncSha)) return { ok: false, reason: "bad bundle sha/encSha" };
  if (!Number.isInteger(s.bundleCipherSize) || s.bundleCipherSize < 0) return { ok: false, reason: "bad bundleCipherSize" };
  // index is optional but, if present, both shas + size travel together.
  if (s.indexSha || s.indexEncSha || s.indexCipherSize !== undefined) {
    if (!validArtifactRef({ sha: s.indexSha!, encSha: s.indexEncSha!, cipherSize: s.indexCipherSize! })) return { ok: false, reason: "bad index ref" };
  }
  // HEAD is either detached (40-hex) or symbolic onto a BRANCH the section itself carries —
  // capture can produce nothing else (an unborn HEAD never captures), so a symbolic HEAD
  // outside refs/heads/* or naming a branch absent from `refs` is malformed/hostile: applying
  // it would leave an unborn HEAD over restored index entries (codex repro).
  if (typeof s.head !== "string" || !/^(ref: refs\/heads\/[A-Za-z0-9._\/-]+|[0-9a-f]{40})$/.test(s.head.trim())) return { ok: false, reason: "bad HEAD" };
  if (s.refs === null || typeof s.refs !== "object" || Array.isArray(s.refs)) return { ok: false, reason: "bad refs" };
  for (const [ref, sha] of Object.entries(s.refs)) {
    if (!isSyncableRef(ref) || ref.includes("..") || ref.includes("\0")) return { ok: false, reason: `bad ref ${ref}` };
    if (typeof sha !== "string" || !HEX40.test(sha)) return { ok: false, reason: `bad ref sha ${ref}` };
  }
  const headBranch = /^ref: (refs\/heads\/\S+)$/.exec(s.head.trim())?.[1];
  if (headBranch && (s.refs as Record<string, unknown>)[headBranch] === undefined) return { ok: false, reason: `HEAD branch ${headBranch} not in refs` };
  for (const [rel, ref] of Object.entries(s.opState ?? {})) {
    const okRel = OP_STATE_FILES.includes(rel) || OP_STATE_DIRS.some((d) => rel.startsWith(`${d}/`));
    if (!okRel || rel.includes("..") || rel.includes("\0") || rel.startsWith("/")) return { ok: false, reason: `bad opState ${rel}` };
    if (!validArtifactRef(ref)) return { ok: false, reason: `bad opState ref ${rel}` };
  }
  // design 43 §2: refScope is mandatory — it gates apply-side ref deletion (§7).
  if (s.refScope !== "all" && s.refScope !== "scoped") return { ok: false, reason: "bad refScope" };
  return { ok: true };
}
