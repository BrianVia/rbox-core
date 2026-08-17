import fs from "node:fs/promises";
import path from "node:path";
import { isRboxConflictArtifact } from "./conflict-name.js";
import { isAbsent } from "./fsutil.js";
import { isSafeRelPath } from "./manifest-validate.js";

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

export function normalizeRel(rel: string): string | undefined {
  if (rel === ".") return rel;
  if (!isSafeRelPath(rel) || path.posix.normalize(rel) !== rel) return undefined;
  return rel;
}

export function equivalentPart(value: string, eq: ReceiverEquivalence): string {
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

export function inProjection(candidate: string, rel: string, eq: ReceiverEquivalence): boolean {
  if (rel === ".") return true;
  const c = candidate.split("/");
  const r = rel.split("/");
  if (c.length < r.length) return false;
  for (let i = 0; i < r.length; i++) {
    if (equivalentPart(c[i]!, eq) !== equivalentPart(r[i]!, eq)) return false;
  }
  return true;
}

export function hardExcluded(candidate: string, eq: ReceiverEquivalence): boolean {
  const parts = candidate.replace(/\/+$/, "").split("/");
  if (parts.length > 0 && equivalentPart(parts[0]!, eq) === equivalentPart(".rbox", eq)) return true;
  return parts.some((part) => equivalentPart(part, eq) === equivalentPart(".git", eq));
}

/** True iff some component of `rel` STRICTLY BELOW `root` is an rbox conflict artifact. */
export function matchesConflictGrammarBelow(rel: string, root: string): boolean {
  return rel.split("/").slice(root === "." ? 0 : root.split("/").length).some(isRboxConflictArtifact);
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
      unicodeAliases: await aliases("\u00e9.rbox-probe", "e\u0301.rbox-probe"),
    };
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

export async function probeReceiverEquivalence(root: string): Promise<ReceiverEquivalence> {
  return (injectedReceiverEquivalenceProbe ?? defaultReceiverEquivalenceProbe)(root);
}
