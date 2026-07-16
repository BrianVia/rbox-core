import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection } from "../types.js";
import { enumerateRefReflogOids, HEX40, git, gitRaw, headBranchOf, repoCtx } from "./shared.js";

export interface ImportedScratchNamespace {
  /** Imported scratch names are deliberately not ownership roots. */
  prefix?: string;
  /** Decrypted operation-state bytes, when the caller has staged them. */
  opState?: Record<string, string | Uint8Array>;
}

export type OwnershipProof =
  | { status: "owned" }
  | { status: "unowned" }
  | { status: "indeterminate"; marker: "shallow-store" | "missing-object" | "walk-error" };

export interface PartitionedOwnership {
  tip: string;
  /** Peeled commit identity, available after a successful batch-check. */
  commit?: string;
  proof: OwnershipProof;
}

export type NoDropProof =
  | { status: "proven" }
  | { status: "would-drop"; tip: string }
  | { status: "indeterminate"; marker: "shallow-store" | "missing-object" | "walk-error" };

// r1 F5: graph classification must never turn a promisor fetch into an
// apparently complete local proof.
const graphEnv: NodeJS.ProcessEnv = { GIT_NO_LAZY_FETCH: "1" };

function errorCode(error: unknown): number | undefined {
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

function opStateCommitCandidates(opState: ImportedScratchNamespace["opState"]): string[] {
  const roots = new Set<string>();
  for (const [rel, value] of Object.entries(opState ?? {})) {
    if (!/^(MERGE_HEAD|REBASE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|rebase-merge\/|rebase-apply\/)/.test(rel)) continue;
    const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
    for (const match of text.matchAll(/\b[0-9a-f]{40}\b/g)) roots.add(match[0]!);
  }
  return [...roots];
}

/** Design 116 ownership roots exclude scratch/held/recovery names by construction. */
export function incomingOwnershipRoots(section: GitSection, imported: ImportedScratchNamespace | string = {}): string[] {
  const roots = new Set<string>();
  const branch = headBranchOf(section.head);
  if (branch) {
    const tip = section.refs[branch];
    if (tip && HEX40.test(tip)) roots.add(tip);
  } else {
    const detached = section.head.trim();
    if (HEX40.test(detached)) roots.add(detached);
  }
  for (const [ref, oid] of Object.entries(section.refs)) {
    if ((ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/") || ref === "refs/stash") && HEX40.test(oid)) roots.add(oid);
  }
  if (typeof imported !== "string") for (const oid of opStateCommitCandidates(imported.opState)) roots.add(oid);
  return [...roots].sort();
}

function hasShallowFile(commonDir: string): Promise<boolean | undefined> {
  return fs.access(path.join(commonDir, "shallow")).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : undefined);
}

async function shallow(repoDir: string): Promise<boolean | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return undefined;
  return hasShallowFile(ctx.commonDir);
}

/** repoCtx costs two rev-parses, while the batch budget allows one validating subprocess. */
async function batchedShallow(repoDir: string): Promise<boolean | undefined> {
  try {
    const commonDir = await git(repoDir, ["rev-parse", "--git-common-dir"], { env: graphEnv });
    return hasShallowFile(path.resolve(repoDir, commonDir));
  } catch {
    return undefined;
  }
}

async function peelAndVerify(repoDir: string, roots: readonly string[]): Promise<{ commits: string[] } | { marker: "missing-object" | "walk-error" }> {
  const commits: string[] = [];
  try {
    // Preserve positional duplicates: callers deliberately pass [tip, ...roots]
    // and tip === root is an immediate owned proof, not an empty roots list.
    for (const root of roots) {
      // Explicit ^{commit} peeling is required for annotated tags; a peel error
      // is indeterminate, never evidence that a tip is unreachable (r1 F5).
      const commit = await git(repoDir, ["rev-parse", "--verify", `${root}^{commit}`], { env: graphEnv });
      if (!HEX40.test(commit)) return { marker: "missing-object" };
      commits.push(commit);
    }
    if (commits.length > 0) await git(repoDir, ["rev-list", "--quiet", ...commits, "--"], { env: graphEnv });
    return { commits };
  } catch (error) {
    return { marker: errorCode(error) === 128 ? "missing-object" : "walk-error" };
  }
}

async function tipOwnedByIncomingDetailed(repoDir: string, tip: string, roots: readonly string[]): Promise<PartitionedOwnership> {
  const isShallow = await shallow(repoDir);
  if (isShallow !== false) return { tip, proof: { status: "indeterminate", marker: isShallow ? "shallow-store" : "walk-error" } };
  const graph = await peelAndVerify(repoDir, [tip, ...roots]);
  if ("marker" in graph) return { tip, proof: { status: "indeterminate", marker: graph.marker } };
  const [tipCommit, ...rootCommits] = graph.commits;
  if (!tipCommit) return { tip, proof: { status: "indeterminate", marker: "missing-object" } };
  for (const root of rootCommits) {
    try {
      await git(repoDir, ["merge-base", "--is-ancestor", tipCommit, root!], { env: graphEnv });
      return { tip, commit: tipCommit, proof: { status: "owned" } };
    } catch (error) {
      if (errorCode(error) !== 1) return { tip, proof: { status: "indeterminate", marker: errorCode(error) === 128 ? "missing-object" : "walk-error" } };
    }
  }
  return { tip, commit: tipCommit, proof: { status: "unowned" } };
}

export async function tipOwnedByIncoming(repoDir: string, tip: string, roots: readonly string[]): Promise<OwnershipProof> {
  return (await tipOwnedByIncomingDetailed(repoDir, tip, roots)).proof;
}

async function legacyPartition(repoDir: string, tips: readonly string[], roots: readonly string[]): Promise<PartitionedOwnership[]> {
  const result: PartitionedOwnership[] = [];
  for (const tip of tips) result.push(await tipOwnedByIncomingDetailed(repoDir, tip, roots));
  return result;
}

/** Every per-tip status and marker MUST equal tipOwnedByIncoming's answer: legacyPartition is the semantic oracle, and every fallback preserves it. */
export async function partitionOwnedByIncoming(repoDir: string, tips: readonly string[], roots: readonly string[]): Promise<PartitionedOwnership[]> {
  const isShallow = await batchedShallow(repoDir);
  if (isShallow !== false) {
    const marker = isShallow ? "shallow-store" : "walk-error";
    return tips.map((tip) => ({ tip, proof: { status: "indeterminate", marker } }));
  }

  const inputs = [...tips, ...roots];
  let records: Array<{ commit?: string }>;
  try {
    const raw = await gitRaw(repoDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      env: graphEnv,
      stdin: inputs.map((oid) => `${oid}^{commit}`).join("\n") + "\n",
    });
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length !== inputs.length) return legacyPartition(repoDir, tips, roots);
    // Duplicate raw OIDs and distinct tags peeling to one commit make any OID-keyed map wrong; position is the only correct key.
    records = lines.map((line) => {
      const match = /^([0-9a-f]{40}) commit$/.exec(line);
      return match ? { commit: match[1]! } : {};
    });
  } catch {
    return legacyPartition(repoDir, tips, roots);
  }

  const tipRecords = records.slice(0, tips.length);
  const rootRecords = records.slice(tips.length);
  if (rootRecords.some((record) => !record?.commit)) {
    return tips.map((tip, index) => ({
      tip,
      ...(tipRecords[index]?.commit ? { commit: tipRecords[index]!.commit } : {}),
      proof: { status: "indeterminate", marker: "missing-object" },
    }));
  }

  const commits = records.flatMap((record) => record.commit ? [record.commit] : []);
  try {
    if (commits.length > 0) await git(repoDir, ["rev-list", "--quiet", "--stdin"], {
      env: graphEnv,
      stdin: commits.join("\n") + "\n",
    });
  } catch {
    // Recover exact per-tip markers and preserve independence after any corrupt walk.
    return legacyPartition(repoDir, tips, roots);
  }

  const candidateCommits = new Set(tipRecords.flatMap((record) => record?.commit ? [record.commit] : []));
  const ownedCommits = new Set<string>();
  let pending = "";
  try {
    await gitRaw(repoDir, ["rev-list", "--stdin"], {
      env: graphEnv,
      stdin: rootRecords.map((record) => record.commit!).join("\n") + "\n",
      onStdoutChunk: (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const oid of lines) if (candidateCommits.has(oid)) ownedCommits.add(oid);
      },
    });
    if (pending && candidateCommits.has(pending)) ownedCommits.add(pending);
  } catch {
    return legacyPartition(repoDir, tips, roots);
  }

  return tips.map((tip, index) => {
    const commit = tipRecords[index]?.commit;
    if (!commit) return { tip, proof: { status: "indeterminate", marker: "missing-object" } };
    return { tip, commit, proof: { status: ownedCommits.has(commit) ? "owned" : "unowned" } };
  });
}

export async function noDropProof(
  repoDir: string,
  plannedRefs: Readonly<Record<string, string>> | readonly string[],
  heldRefs: Readonly<Record<string, string>> | readonly string[],
  recoveryPins: Readonly<Record<string, string>> | readonly string[],
  protectedTips: readonly string[],
): Promise<NoDropProof> {
  const isShallow = await shallow(repoDir);
  if (isShallow !== false) return { status: "indeterminate", marker: isShallow ? "shallow-store" : "walk-error" };
  const values = (v: Readonly<Record<string, string>> | readonly string[]) => Array.isArray(v) ? [...v] : Object.values(v);
  const durableRoots = [...values(plannedRefs), ...values(heldRefs), ...values(recoveryPins)];
  const graph = await peelAndVerify(repoDir, [...durableRoots, ...protectedTips]);
  if ("marker" in graph) return { status: "indeterminate", marker: graph.marker };
  const durable = graph.commits.slice(0, durableRoots.length);
  const protectedCommits = graph.commits.slice(durableRoots.length);
  for (let i = 0; i < protectedCommits.length; i++) {
    const tip = protectedCommits[i]!;
    let reachable = false;
    for (const root of durable) {
      try {
        await git(repoDir, ["merge-base", "--is-ancestor", tip, root!], { env: graphEnv });
        reachable = true;
        break;
      } catch (error) {
        if (errorCode(error) !== 1) return { status: "indeterminate", marker: errorCode(error) === 128 ? "missing-object" : "walk-error" };
      }
    }
    if (!reachable) return { status: "would-drop", tip: protectedTips[i]! };
  }
  return { status: "proven" };
}

/** Every stash reflog old/new OID is protection input for owning dir repos. */
export async function enumerateStashReflogOids(repoDir: string): Promise<string[]> {
  const ctx = await repoCtx(repoDir);
  if (!ctx || ctx.kind !== "dir") return [];
  return enumerateRefReflogOids(repoDir, "refs/stash");
}
