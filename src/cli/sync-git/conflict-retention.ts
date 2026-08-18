/** Never: granting push carry/capture authority, deleting other namespaces, or state persistence. */
import fs from "node:fs/promises";
import path from "node:path";
import { commitProtocolRefTransaction } from "./base-artifacts.js";
import { partitionOwnedByIncoming } from "./reachability.js";
import { repoCtxFromDisk, type RepoCtx } from "./git-state.js";
import { gitRaw } from "../../engine/git-spawn.js";

export const CONFLICT_REF_PREFIX = "refs/rbox-conflict/";
export const CONFLICT_REF_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const CONFLICT_REF_PRUNE_LIMIT = 64;

interface ConflictRef {
  ref: string;
  oid: string;
}

export interface ConflictRefInspection {
  total: number;
  prunable: ConflictRef[];
  /** A graph/object error makes the whole pass fail closed. */
  indeterminate: boolean;
}

/**
 * Filesystem-only namespace gate. Pushes for ordinary repos pay no Git subprocess
 * merely to discover that there is no conflict-ref hygiene to perform. Packed refs
 * are included because `git pack-refs --all` may remove the loose namespace tree.
 */
export async function conflictRefNamespacePresent(ctx: RepoCtx): Promise<boolean> {
  const loose = await fs.lstat(path.join(ctx.commonDir, "refs", "rbox-conflict")).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error),
  );
  if (loose) return true;
  const packed = await fs.readFile(path.join(ctx.commonDir, "packed-refs"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return packed.split("\n").some((line) => /^[0-9a-f]{40} refs\/rbox-conflict\//.test(line));
}

function parseRefs(raw: string): { branches: ConflictRef[]; conflicts: ConflictRef[] } {
  const branches: ConflictRef[] = [];
  const conflicts: ConflictRef[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const match = /^([^\0]+)\0([0-9a-f]{40})$/.exec(line);
    if (!match) throw new Error("malformed conflict-retention ref inventory");
    const entry = { ref: match[1]!, oid: match[2]! };
    if (entry.ref.startsWith("refs/heads/")) branches.push(entry);
    else if (entry.ref.startsWith(CONFLICT_REF_PREFIX)) conflicts.push(entry);
    else throw new Error("conflict-retention inventory escaped its namespaces");
  }
  return { branches, conflicts };
}

function namespaceTimestampMs(ref: string): number | undefined {
  const segment = ref.slice(CONFLICT_REF_PREFIX.length).split("/", 1)[0];
  if (!segment || !/^\d+$/.test(segment)) return undefined;
  const value = Number(segment);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Read-only status/proof pass shared by push hygiene and `rbox status`. */
export async function inspectConflictRefs(
  repoDir: string,
  nowMs = Date.now(),
  knownCtx?: RepoCtx,
): Promise<ConflictRefInspection> {
  const ctx = knownCtx ?? await repoCtxFromDisk(repoDir).catch(() => undefined);
  if (!ctx || !(await conflictRefNamespacePresent(ctx))) {
    return { total: 0, prunable: [], indeterminate: false };
  }
  const refs = parseRefs(await gitRaw(repoDir, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)",
    "refs/heads/",
    CONFLICT_REF_PREFIX,
  ]));
  if (refs.conflicts.length === 0) return { total: 0, prunable: [], indeterminate: false };

  const proofs = await partitionOwnedByIncoming(
    repoDir,
    refs.conflicts.map((entry) => entry.oid),
    refs.branches.map((entry) => entry.oid),
  );
  if (proofs.some((entry) => entry.proof.status === "indeterminate")) {
    return { total: refs.conflicts.length, prunable: [], indeterminate: true };
  }
  const prunable = refs.conflicts.filter((entry, index) => {
    if (proofs[index]!.proof.status === "owned") return true;
    const timestamp = namespaceTimestampMs(entry.ref);
    return timestamp !== undefined && nowMs - timestamp > CONFLICT_REF_RETENTION_MS;
  });
  return { total: refs.conflicts.length, prunable, indeterminate: false };
}

export async function pruneConflictRefs(
  repoDir: string,
  options: {
    nowMs?: number;
    limit?: number;
    ctx?: RepoCtx;
    onBatch?: (deleted: readonly ConflictRef[]) => void | Promise<void>;
  } = {},
): Promise<{ total: number; prunable: number; deleted: number; indeterminate: boolean }> {
  const limit = Math.max(0, Math.min(CONFLICT_REF_PRUNE_LIMIT, Math.floor(options.limit ?? CONFLICT_REF_PRUNE_LIMIT)));
  const inspection = await inspectConflictRefs(repoDir, options.nowMs ?? Date.now(), options.ctx);
  if (inspection.indeterminate || limit === 0 || inspection.prunable.length === 0) {
    return {
      total: inspection.total,
      prunable: inspection.prunable.length,
      deleted: 0,
      indeterminate: inspection.indeterminate,
    };
  }
  const batch = inspection.prunable.slice(0, limit);
  // Every delete is namespace-confined and old-OID checked inside one transaction.
  // A concurrent ref move aborts the whole batch.
  await commitProtocolRefTransaction(repoDir, batch.map(({ ref, oid }) => `delete ${ref} ${oid}`));
  await options.onBatch?.(batch);
  return { total: inspection.total, prunable: inspection.prunable.length, deleted: batch.length, indeterminate: false };
}
