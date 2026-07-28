import type { GitSection } from "../../../engine/index.js";
import { isSafeRelPath, validateGitRepos } from "../../../engine/index.js";
import { canonicalJson, parseCanonicalJson } from "../digest/codecs.js";

/**
 * The one admission point for a Git section into (and back out of) the state
 * plane. Every `putGitSection` and every read that reconstructs a `GitSection`
 * routes through here, exactly as `RepoRecord` routes through the shared
 * `manifest-validate.ts` semantic validator (`codecs/repo-record.ts`). Before
 * this seam existed, stage input, sealed reads, and authority reads each cast
 * `parseCanonicalJson(...) as unknown as GitSection` with no re-validation.
 *
 * A section's storage key is a repository relPath — the sync root `"."` or a
 * safe POSIX-relative path — and its bytes are the canonical spelling of the
 * validated section. `validateGitRepos` is the same untrusted-input validator
 * the wire manifest runs, so a section this store admits is one the manifest
 * layer would also admit.
 */

export interface EncodedGitSection {
  relPath: string;
  /** Canonical bytes stored in `section_cjson` — the exact spelling the digest covers. */
  canonical: string;
  /** Byte accounting charged against the page ceiling: canonical section + relPath. */
  bytes: number;
}

function assertSafeGitPath(relPath: string): asserts relPath is string {
  if (relPath !== "." && !isSafeRelPath(relPath)) {
    throw new TypeError(`Git section path ${JSON.stringify(relPath)} must be "." or a POSIX-relative path`);
  }
}

function assertValidSection(relPath: string, section: unknown): asserts section is GitSection {
  const result = validateGitRepos({ [relPath]: section });
  if (!result.ok) throw new TypeError(`invalid GitSection at ${relPath}: ${result.error}`);
}

/**
 * Validate a caller-supplied section and produce its canonical bytes and byte
 * accounting. A malformed path or section is a caller error (`TypeError`); the
 * oversize decision stays with the caller, which compares `bytes` to its ceiling.
 */
export function encodeGitSection(relPath: string, section: GitSection): EncodedGitSection {
  assertSafeGitPath(relPath);
  assertValidSection(relPath, section);
  const canonical = canonicalJson(section);
  return { relPath, canonical, bytes: Buffer.byteLength(canonical) + Buffer.byteLength(relPath) };
}

/**
 * Reconstruct a `GitSection` from persisted `section_cjson`. The stored bytes
 * must already be canonical (`parseCanonicalJson` refuses otherwise) and must
 * decode to an admissible section. Any failure throws — callers map it to their
 * own taxonomy: a mutated sealed stage is a `StageChangedError`, a corrupt
 * authority row is a `StateDataCorruptionError`.
 */
export function decodeGitSection(relPath: string, sectionCjson: string): GitSection {
  const parsed = parseCanonicalJson(sectionCjson);
  assertSafeGitPath(relPath);
  assertValidSection(relPath, parsed);
  return parsed as unknown as GitSection;
}
