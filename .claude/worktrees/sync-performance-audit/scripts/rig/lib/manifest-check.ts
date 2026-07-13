/**
 * Synced-set convergence (design 56 §9). On a real git-repo workload, raw-tree
 * byte identity is the WRONG convergence definition: rbox honors builtin ignores
 * AND nested `.gitignore` files (src/engine/ignore.ts), so both devices legitimately
 * keep on-disk files that were never synced (`.DS_Store`, `.env`, gitignored paths).
 * Re-deriving that ignore set in the rig would re-implement the engine — wrong.
 *
 * The source of truth for "what rbox synced" is each device's DECRYPTED last-synced
 * manifest at `<workDir>/.rbox/state.json` → `lastSyncedManifest.files: FileEntry[]`.
 * These PURE functions parse that manifest and answer three questions:
 *   1. did A and B sync the SAME set? ({@link compareManifests})
 *   2. does B's disk materialize B's manifest? ({@link verifyManifestOnDisk})
 *   3. does B carry any unsynced extras? ({@link findUnsyncedExtras})
 *
 * Identity is `path + sha256 + size` — mtime/mode are excluded (mtime is a local
 * fast-path hint, never content identity; see src/engine/types.ts). For symlinks the
 * manifest `sha256` is the hash of the link-TARGET string; the on-disk fingerprint
 * carries the target verbatim (`symlink:<target>`), so we re-hash it host-side to
 * compare (see {@link fpExpectedSha256}).
 */
import { createHash } from "node:crypto";
import type { Fingerprint, FpEntry } from "./convergence.js";

/**
 * The subset of the engine's `FileEntry` that defines "what rbox synced". `mode`
 * and `mtimeMs` are deliberately dropped — they are not content identity.
 */
export interface ManifestEntry {
  /** POSIX-relative path from the sync root, normalized (no leading `./`). */
  path: string;
  /** Lowercase hex SHA-256 of the file bytes — or of the link-target string, for symlinks. */
  sha256: string;
  /** Byte length of the content (link-target length, for symlinks). */
  size: number;
  type: "file" | "symlink";
}

/** The three dirs rbox NEVER syncs — pruned by the on-disk fingerprint at any depth
 *  by name (must mirror the prune list in convergence.ts `fingerprintScript`). A
 *  manifest entry beneath one of these is exempt from the disk check. */
const PRUNED_SEGMENTS = new Set([".rbox", ".git", "node_modules"]);

/** Strip a leading `./` so fingerprint paths (`./a/b`) and manifest paths (`a/b`)
 *  compare on equal footing. */
export function normPath(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p;
}

/** True if any path segment is one of the never-synced dirs — matches the
 *  fingerprint's by-name prune, at any depth. */
export function isPrunedPath(p: string): boolean {
  return normPath(p).split("/").some((seg) => PRUNED_SEGMENTS.has(seg));
}

/** SHA-256 (hex) of a string's UTF-8 bytes — matches `hashBytes(Buffer.from(target))`
 *  in src/engine/manifest.ts, how the engine derives a symlink's manifest `sha256`. */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface RawFileEntry {
  path?: unknown;
  sha256?: unknown;
  size?: unknown;
  type?: unknown;
}

/**
 * Parse a device's `state.json` text into canonical manifest entries. Throws (never
 * silently returns empty) on invalid JSON or a missing `lastSyncedManifest.files`
 * array — a shape surprise on the real workload must FAIL loud, not read as "nothing
 * synced". Paths are normalized; entries are NOT sorted here (call {@link canonicalManifest}).
 */
export function parseManifestState(stateJson: string): ManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson);
  } catch {
    throw new Error("state.json is not valid JSON");
  }
  const files = (parsed as { lastSyncedManifest?: { files?: unknown } })?.lastSyncedManifest?.files;
  if (!Array.isArray(files)) {
    throw new Error("state.json has no lastSyncedManifest.files array");
  }
  return (files as RawFileEntry[]).map((f) => ({
    path: normPath(String(f.path)),
    sha256: String(f.sha256),
    size: Number(f.size),
    type: f.type === "symlink" ? ("symlink" as const) : ("file" as const),
  }));
}

/** Sort by path — the canonical order for comparison + stable reporting. PURE. */
export function canonicalManifest(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface ManifestDiff {
  identical: boolean;
  /** Paths in A's manifest but not B's. */
  onlyA: string[];
  /** Paths in B's manifest but not A's. */
  onlyB: string[];
  /** Paths in both but with differing sha256 or size. */
  differing: string[];
}

/**
 * Compare two manifests by `path + sha256 + size` (mtime/mode ignored). Both
 * directions are reported so a mismatch names exactly what diverged. PURE.
 */
export function compareManifests(a: ManifestEntry[], b: ManifestEntry[]): ManifestDiff {
  const ma = new Map(a.map((e) => [e.path, e]));
  const mb = new Map(b.map((e) => [e.path, e]));
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  const differing: string[] = [];
  for (const [p, ea] of ma) {
    const eb = mb.get(p);
    if (!eb) onlyA.push(p);
    else if (eb.sha256 !== ea.sha256 || eb.size !== ea.size) differing.push(p);
  }
  for (const p of mb.keys()) if (!ma.has(p)) onlyB.push(p);
  onlyA.sort();
  onlyB.sort();
  differing.sort();
  return { identical: onlyA.length === 0 && onlyB.length === 0 && differing.length === 0, onlyA, onlyB, differing };
}

/** The manifest `sha256` a fingerprint entry implies: a file's digest IS its sha256;
 *  a symlink's digest is `symlink:<target>`, whose sha256 is the hash of the target
 *  string (host-side, to match the engine). PURE. */
export function fpExpectedSha256(fp: FpEntry): string {
  if (fp.kind === "symlink") return sha256Hex(fp.digest.slice("symlink:".length));
  return fp.digest;
}

export interface DiskCheck {
  ok: boolean;
  /** Manifest entries with no matching fingerprint path on disk. */
  missing: string[];
  /** Manifest entries present on disk but with a disagreeing digest. */
  mismatched: string[];
  /** Manifest entries under a pruned dir (`.rbox`/`.git`/`node_modules`) — the
   *  fingerprint can't see them, so they're skipped and merely counted. */
  exemptCount: number;
}

/**
 * Verify every manifest entry is materialized on disk with a matching digest, using
 * the EXISTING in-guest fingerprint. Entries under a pruned path are exempt (the
 * fingerprint prunes those dirs by name) — skipped and counted, never failed. PURE.
 */
export function verifyManifestOnDisk(manifest: ManifestEntry[], fp: Fingerprint): DiskCheck {
  const byPath = new Map(fp.entries.map((e) => [normPath(e.path), e]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  let exemptCount = 0;
  for (const m of manifest) {
    if (isPrunedPath(m.path)) {
      exemptCount++;
      continue;
    }
    const fe = byPath.get(m.path);
    if (!fe) {
      missing.push(m.path);
      continue;
    }
    if (fpExpectedSha256(fe) !== m.sha256) mismatched.push(m.path);
  }
  missing.sort();
  mismatched.sort();
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, exemptCount };
}

/**
 * Every fingerprint entry must be in the manifest. B starts empty and only pulls,
 * so any on-disk file the manifest doesn't account for is an unsynced extra (the
 * fingerprint already prunes `.rbox`/`.git`/`node_modules`). PURE.
 */
export function findUnsyncedExtras(fp: Fingerprint, manifest: ManifestEntry[]): string[] {
  const inManifest = new Set(manifest.map((m) => m.path));
  const extras: string[] = [];
  for (const e of fp.entries) {
    const p = normPath(e.path);
    if (!inManifest.has(p)) extras.push(p);
  }
  extras.sort();
  return extras;
}

/** One-line manifest-diff summary for assertion detail (first 5 offenders). PURE. */
export function manifestDiffDetail(d: ManifestDiff): string {
  const sample = [...d.onlyA.map((p) => `A:${p}`), ...d.onlyB.map((p) => `B:${p}`), ...d.differing.map((p) => `≠:${p}`)].slice(0, 5);
  return `onlyA=${d.onlyA.length} onlyB=${d.onlyB.length} diff=${d.differing.length} (${sample.join(", ")})`;
}

/** One-line disk-check summary for assertion detail (first 5 offenders). PURE. */
export function diskCheckDetail(d: DiskCheck): string {
  const sample = [...d.missing.map((p) => `miss:${p}`), ...d.mismatched.map((p) => `≠:${p}`)].slice(0, 5);
  return `missing=${d.missing.length} mismatched=${d.mismatched.length} exempt=${d.exemptCount} (${sample.join(", ")})`;
}
