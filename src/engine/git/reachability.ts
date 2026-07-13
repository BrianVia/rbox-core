import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSection } from "../types.js";
import { HEX40, headBranchOf, repoCtx } from "./shared.js";

const exec = promisify(execFile);
const ZERO_OID = "0".repeat(40);

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

export type NoDropProof =
  | { status: "proven" }
  | { status: "would-drop"; tip: string }
  | { status: "indeterminate"; marker: "shallow-store" | "missing-object" | "walk-error" };

function cleanGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    // r1 F5: graph classification must never turn a promisor fetch into an
    // apparently complete local proof.
    GIT_NO_LAZY_FETCH: "1",
  } as NodeJS.ProcessEnv;
}

async function walkGit(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", repoDir, ...args], { env: cleanGitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return stdout.toString().trim();
}

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

async function shallow(repoDir: string): Promise<boolean | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return undefined;
  return fs.access(path.join(ctx.commonDir, "shallow")).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : undefined);
}

async function peelAndVerify(repoDir: string, roots: readonly string[]): Promise<{ commits: string[] } | { marker: "missing-object" | "walk-error" }> {
  const commits: string[] = [];
  try {
    // Preserve positional duplicates: callers deliberately pass [tip, ...roots]
    // and tip === root is an immediate owned proof, not an empty roots list.
    for (const root of roots) {
      // Explicit ^{commit} peeling is required for annotated tags; a peel error
      // is indeterminate, never evidence that a tip is unreachable (r1 F5).
      const commit = await walkGit(repoDir, ["rev-parse", "--verify", `${root}^{commit}`]);
      if (!HEX40.test(commit)) return { marker: "missing-object" };
      commits.push(commit);
    }
    if (commits.length > 0) await walkGit(repoDir, ["rev-list", "--quiet", ...commits, "--"]);
    return { commits };
  } catch (error) {
    return { marker: errorCode(error) === 128 ? "missing-object" : "walk-error" };
  }
}

export async function tipOwnedByIncoming(repoDir: string, tip: string, roots: readonly string[]): Promise<OwnershipProof> {
  const isShallow = await shallow(repoDir);
  if (isShallow !== false) return { status: "indeterminate", marker: isShallow ? "shallow-store" : "walk-error" };
  const graph = await peelAndVerify(repoDir, [tip, ...roots]);
  if ("marker" in graph) return { status: "indeterminate", marker: graph.marker };
  const [tipCommit, ...rootCommits] = graph.commits;
  if (!tipCommit) return { status: "indeterminate", marker: "missing-object" };
  for (const root of rootCommits) {
    try {
      await walkGit(repoDir, ["merge-base", "--is-ancestor", tipCommit, root!]);
      return { status: "owned" };
    } catch (error) {
      if (errorCode(error) !== 1) return { status: "indeterminate", marker: errorCode(error) === 128 ? "missing-object" : "walk-error" };
    }
  }
  return { status: "unowned" };
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
        await walkGit(repoDir, ["merge-base", "--is-ancestor", tip, root!]);
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
  const raw = await fs.readFile(path.join(ctx.commonDir, "logs", "refs", "stash"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const out = new Set<string>();
  for (const line of raw.split("\n")) {
    const [oldOid, newOid] = line.split(" ");
    if (oldOid && HEX40.test(oldOid) && oldOid !== ZERO_OID) out.add(oldOid);
    if (newOid && HEX40.test(newOid) && newOid !== ZERO_OID) out.add(newOid);
  }
  return [...out];
}
