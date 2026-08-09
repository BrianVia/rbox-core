import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../engine/e2ee/jcs.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { isSafeRelPath, type CaseFoldCollisionGroup } from "../engine/manifest-validate.js";
import { boundedJsonRead } from "./reset-io.js";

export const PATH_WARNINGS_MAX_BYTES = 64 * 1024;
export const PATH_WARNINGS_MAX_GROUPS = 100;
export const PATH_WARNINGS_MAX_PATHS_PER_GROUP = 8;

const HEX64 = /^[0-9a-f]{64}$/;

/** Public alias keeps persistence callers on the classifier's canonical type. */
export type PathCollisionGroup = CaseFoldCollisionGroup;

export interface PathWarningsV1 {
  v: 1;
  fingerprint: string;
  /** Complete counts, including groups and paths omitted from `collisions`. */
  groupCount: number;
  pathCount: number;
  /** Bounded display sample. Collision exclusion itself uses the complete observation. */
  collisions: PathCollisionGroup[];
}

type PathWarningsCandidate = Partial<Record<keyof PathWarningsV1, unknown>>;
type PathCollisionCandidate = Partial<Record<keyof PathCollisionGroup, unknown>>;

export const pathWarningsPath = (root: string): string =>
  path.join(root, ".rbox", "state", "path-warnings.json");

async function requirePlainWarningsParent(root: string): Promise<boolean> {
  let current = path.resolve(root);
  for (const component of [".rbox", "state"]) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe path warning directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function compareGroups(a: readonly string[], b: readonly string[]): number {
  const byFold = compareText(a[0]!.toLowerCase(), b[0]!.toLowerCase());
  if (byFold !== 0) return byFold;
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    const compared = compareText(a[i]!, b[i]!);
    if (compared !== 0) return compared;
  }
  return a.length - b.length;
}

function canonicalGroups(groups: readonly PathCollisionGroup[]): string[][] {
  const seenFolds = new Set<string>();
  const normalized = groups.map((group) => {
    if (!group || !Array.isArray(group.paths)) throw new Error("path collision group is invalid");
    const paths = [...group.paths].sort(compareText);
    if (paths.length < 2) throw new Error("path collision group must contain at least two paths");
    const fold = paths[0]!.toLowerCase();
    for (let i = 0; i < paths.length; i++) {
      const current = paths[i]!;
      if (!isSafeRelPath(current)) throw new Error("path collision group contains an unsafe path");
      if (i > 0 && current === paths[i - 1]) throw new Error("path collision group contains a duplicate path");
      if (current.toLowerCase() !== fold) throw new Error("path collision group members are not case-equivalent");
    }
    if (seenFolds.has(fold)) throw new Error("duplicate path collision group");
    seenFolds.add(fold);
    return paths;
  }).sort(compareGroups);
  return normalized;
}

function fingerprintOf(groups: readonly string[][]): string {
  return crypto.createHash("sha256").update(canonicalize(groups.map((paths) => ({ paths })))).digest("hex");
}

function encoded(record: PathWarningsV1): Buffer {
  return Buffer.concat([Buffer.from(canonicalize(record)), Buffer.from("\n")]);
}

/** Build the durable, display-bounded projection of a complete collision observation. */
export function buildPathWarnings(groups: readonly PathCollisionGroup[]): PathWarningsV1 | undefined {
  if (groups.length === 0) return undefined;
  const complete = canonicalGroups(groups);
  const groupCount = complete.length;
  const pathCount = complete.reduce((count, paths) => count + paths.length, 0);
  const fingerprint = fingerprintOf(complete);
  const collisions: PathCollisionGroup[] = [];

  for (const paths of complete) {
    if (collisions.length >= PATH_WARNINGS_MAX_GROUPS) break;
    const sample = paths.slice(0, PATH_WARNINGS_MAX_PATHS_PER_GROUP);
    let accepted = false;
    while (sample.length >= 2) {
      const candidate: PathWarningsV1 = {
        v: 1, fingerprint, groupCount, pathCount,
        collisions: [...collisions, { paths: [...sample] }],
      };
      if (encoded(candidate).byteLength <= PATH_WARNINGS_MAX_BYTES) {
        collisions.push({ paths: [...sample] });
        accepted = true;
        break;
      }
      sample.pop();
    }
    // Later groups may be shorter and still fit, so a large omitted group does
    // not prevent the bounded sample from representing more of the observation.
    if (!accepted) continue;
  }

  if (collisions.length === 0) throw new Error("path warning record cannot fit one collision group");
  return { v: 1, fingerprint, groupCount, pathCount, collisions };
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validate(value: unknown): PathWarningsV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as PathWarningsCandidate;
  if (!exactKeys(record, ["v", "fingerprint", "groupCount", "pathCount", "collisions"])) return undefined;
  if (record.v !== 1 || typeof record.fingerprint !== "string" || !HEX64.test(record.fingerprint)) return undefined;
  if (!Number.isSafeInteger(record.groupCount) || (record.groupCount as number) < 1) return undefined;
  if (!Number.isSafeInteger(record.pathCount) || (record.pathCount as number) < 2 * (record.groupCount as number)) return undefined;
  if (!Array.isArray(record.collisions) || record.collisions.length < 1
    || record.collisions.length > PATH_WARNINGS_MAX_GROUPS
    || record.collisions.length > (record.groupCount as number)) return undefined;

  const collisions: PathCollisionGroup[] = [];
  let storedPaths = 0;
  for (const raw of record.collisions) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const group = raw as PathCollisionCandidate;
    if (!exactKeys(group, ["paths"]) || !Array.isArray(group.paths)
      || group.paths.length < 2 || group.paths.length > PATH_WARNINGS_MAX_PATHS_PER_GROUP) return undefined;
    if (!group.paths.every(isSafeRelPath)) return undefined;
    const paths = group.paths as string[];
    for (let i = 0; i < paths.length; i++) {
      if (i > 0 && compareText(paths[i - 1]!, paths[i]!) >= 0) return undefined;
      if (paths[i]!.toLowerCase() !== paths[0]!.toLowerCase()) return undefined;
    }
    collisions.push({ paths: [...paths] });
    storedPaths += paths.length;
  }
  for (let i = 1; i < collisions.length; i++) {
    if (compareGroups(collisions[i - 1]!.paths, collisions[i]!.paths) >= 0) return undefined;
    if (collisions[i - 1]!.paths[0]!.toLowerCase() === collisions[i]!.paths[0]!.toLowerCase()) return undefined;
  }
  if (storedPaths > (record.pathCount as number)) return undefined;

  return {
    v: 1,
    fingerprint: record.fingerprint,
    groupCount: record.groupCount as number,
    pathCount: record.pathCount as number,
    collisions,
  };
}

/** Advisory reader: absent, unsafe, corrupt, oversized, or unsupported records disappear. */
export async function readPathWarnings(root: string): Promise<PathWarningsV1 | undefined> {
  try {
    if (!await requirePlainWarningsParent(root)) return undefined;
    return validate(await boundedJsonRead(pathWarningsPath(root), PATH_WARNINGS_MAX_BYTES));
  } catch {
    return undefined;
  }
}

/** Persist a pre-built warning record atomically. Callers own best-effort error handling. */
export async function writePathWarnings(root: string, warnings: PathWarningsV1): Promise<void> {
  const valid = validate(warnings);
  if (!valid) throw new Error("path warning record is invalid");
  const bytes = encoded(valid);
  if (bytes.byteLength > PATH_WARNINGS_MAX_BYTES) throw new Error("path warning record exceeds its encoded bound");
  const file = pathWarningsPath(root);
  const parent = path.dirname(file);
  // Match read/clear no-follow: an existing but symlinked .rbox/state throws.
  await requirePlainWarningsParent(root);
  const created = await ensureDirectoryChain(parent, "path warning directory");
  await writeFileAtomic(file, bytes, { mode: 0o600, exactMode: true });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

/** Replace from a complete observation, or clear when the observation is empty. */
export async function savePathWarnings(root: string, groups: readonly PathCollisionGroup[]): Promise<PathWarningsV1 | undefined> {
  const warnings = buildPathWarnings(groups);
  if (!warnings) {
    await clearPathWarnings(root);
    return undefined;
  }
  await writePathWarnings(root, warnings);
  return warnings;
}

/** Idempotent, parent-durable removal. */
export async function clearPathWarnings(root: string): Promise<boolean> {
  const file = pathWarningsPath(root);
  if (!await requirePlainWarningsParent(root)) return false;
  try {
    await fs.rm(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(file));
  return true;
}
