/**
 * Ignore-rule authority on a scoped binding (design 212 §3.2, r2 finding 6).
 *
 * The matcher reads `.rboxignore`/`.gitignore` from disk. On an ordinary binding a
 * local edit to one of those files is a normal local change that the next push
 * reconciles. A scoped binding never pushes, so a local edit there would silently
 * suppress scoped updates FOREVER while status kept claiming CLEAN. Remote is
 * therefore authoritative for these files: the pull rewrites them from the remote
 * entry, and the divergence is recorded so the user is told rather than surprised.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { Action, FileEntry, Manifest } from "../../engine/index.js";
import { writeFileAtomic } from "../../engine/fsutil.js";
import { RBOX_DIR } from "../workspace-config.js";
import type { ScopeProjection } from "./projection.js";

const FINDINGS_FILE = "scope-findings.json";
const findingsPath = (root: string) => path.join(root, RBOX_DIR, FINDINGS_FILE);

export interface ScopeFindings {
  /** Rule files whose local bytes were overwritten by remote truth, newest run wins.
   *  The straddling repos of the same pull are NOT recorded here: `rbox include`
   *  classifies the live topology itself, so a stored copy could only go stale. */
  ruleFileDivergence: string[];
}

export async function readScopeFindings(root: string): Promise<ScopeFindings | undefined> {
  try {
    const parsed = JSON.parse(await fsp.readFile(findingsPath(root), "utf8")) as Partial<ScopeFindings>;
    if (!Array.isArray(parsed.ruleFileDivergence)) return undefined;
    return { ruleFileDivergence: parsed.ruleFileDivergence.filter((v): v is string => typeof v === "string") };
  } catch {
    return undefined;
  }
}

export async function saveScopeFindings(root: string, findings: ScopeFindings): Promise<void> {
  await fsp.mkdir(path.join(root, RBOX_DIR), { recursive: true });
  await writeFileAtomic(findingsPath(root), `${JSON.stringify(findings, null, 2)}\n`);
}

const entryDiffers = (local: FileEntry | undefined, remote: FileEntry): boolean =>
  local === undefined || local.sha256 !== remote.sha256 || local.type !== remote.type;

/**
 * Overlay remote authority for metadata rule files onto a planned action list.
 * Returns the amended actions plus the paths whose local bytes lost. Any planned
 * conflict/delete for such a path is replaced: keeping a local rule file alive as a
 * `.conflict` copy would leave the matcher reading the losing bytes.
 */
export function applyRuleFileAuthority(
  actions: Action[],
  projection: ScopeProjection,
  base: Manifest,
  local: Manifest,
  remote: Manifest,
): { actions: Action[]; diverged: string[] } {
  const localByPath = new Map(local.files.map((entry) => [entry.path, entry]));
  const baseByPath = new Map(base.files.map((entry) => [entry.path, entry]));
  const diverged: string[] = [];
  const forced = new Map<string, Action>();
  for (const entry of remote.files) {
    if (!projection.isMetadata(entry.path)) continue;
    const here = localByPath.get(entry.path);
    if (!entryDiffers(here, entry)) continue;
    // A local copy that still matches the last-synced base is not an edit — it is
    // simply behind, and the ordinary write already covers it. A copy with NO base
    // at all was authored here, so it is an edit by definition.
    const base = baseByPath.get(entry.path);
    const wasEdited = here !== undefined && (base === undefined || entryDiffers(here, base));
    if (wasEdited) diverged.push(entry.path);
    forced.set(entry.path, { kind: "write", entry, ...(here ? { expectedLocal: here } : {}) });
  }
  // A rule file the publisher DELETED must go too, even if it was edited here —
  // otherwise a stale local rule outlives the rule set it belonged to and keeps
  // filtering this binding's updates.
  const remotePaths = new Set(remote.files.map((entry) => entry.path));
  for (const entry of base.files) {
    if (!projection.isMetadata(entry.path) || remotePaths.has(entry.path)) continue;
    const here = localByPath.get(entry.path);
    if (here === undefined) continue;
    if (entryDiffers(here, entry)) diverged.push(entry.path);
    forced.set(entry.path, { kind: "delete", path: entry.path, expectedLocal: here });
  }
  if (forced.size === 0) return { actions, diverged };
  const kept = actions.filter((action) => !forced.has(action.kind === "write" ? action.entry.path : action.path));
  return { actions: [...kept, ...forced.values()], diverged: diverged.sort() };
}
