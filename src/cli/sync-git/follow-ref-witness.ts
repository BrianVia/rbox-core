/** Ref-plane witness helpers: the incoming ref set this receiver kind actually
 * accepts, the stash reflog seed a synced stash needs, the durable self-root a
 * checkout may authorize itself from, and the terminal OID of an applied-ref
 * marker. Moved verbatim out of follow.ts. */
import fs from "node:fs/promises";
import path from "node:path";
import type { GitSection } from "../../engine/index.js";
import { git, repoCtx, type RepoCtx } from "../../engine/git/shared.js";
import type { GitPartialApply } from "../config.js";

export async function ensureStashReflog(repoDir: string, oid: string): Promise<void> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repository unavailable while creating stash reflog");
  const logPath = path.join(ctx.commonDir, "logs", "refs", "stash");
  const stat = await fs.stat(logPath).catch(() => undefined);
  if (stat && stat.size > 0) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const subject = (await git(repoDir, ["log", "-1", "--format=%s", oid]).catch(() => "rbox: synced stash"))
    .replace(/[\r\n\t]+/g, " ") || "rbox: synced stash";
  const ident = (await git(repoDir, ["var", "GIT_COMMITTER_IDENT"])).replace(/[\r\n]+/g, " ");
  const handle = await fs.open(logPath, "a");
  try {
    await handle.write(`${oid} ${oid} ${ident}\t${subject}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function effectiveRefs(ctx: RepoCtx, incoming: GitSection): { refs: Record<string, string>; deleteAbsent: boolean } {
  if (ctx.kind === "dir") return { refs: { ...incoming.refs }, deleteAbsent: incoming.refScope === "all" };
  const refs: Record<string, string> = {};
  for (const [ref, oid] of Object.entries(incoming.refs)) {
    if (ref.startsWith("refs/heads/")) refs[ref] = oid;
  }
  return { refs, deleteAbsent: false };
}

export interface CheckoutSelfRootWitness {
  ref: string;
  oid: string;
}

/** Selects the exact branch ref that makes the live tip a durable self-root.
 * The caller supplies ref-plane exclusions because the current ref is skipped
 * by publication and therefore is not necessarily represented in heldRefs. */
export function selectCheckoutSelfRootWitness(args: {
  currentTip?: string;
  effectiveIncomingRefs: Readonly<Record<string, string>>;
  receiverRefs: Readonly<Record<string, string>>;
  heldRefs?: ReadonlySet<string>;
  forcedRefs?: ReadonlySet<string>;
  ambiguousRefs?: ReadonlySet<string>;
  /** Boundary proofs must revalidate the same initially selected ref. */
  requiredRef?: string;
}): CheckoutSelfRootWitness | undefined {
  if (!args.currentTip) return undefined;
  const refs = args.requiredRef ? [args.requiredRef] : Object.keys(args.effectiveIncomingRefs).sort();
  for (const ref of refs) {
    if (!ref.startsWith("refs/heads/")
      || args.heldRefs?.has(ref)
      || args.forcedRefs?.has(ref)
      || args.ambiguousRefs?.has(ref)) continue;
    const incomingOid = args.effectiveIncomingRefs[ref];
    if (incomingOid === args.currentTip && args.receiverRefs[ref] === incomingOid) {
      return { ref, oid: incomingOid };
    }
  }
  return undefined;
}

export function appliedTerminalOid(value: GitPartialApply["appliedRefs"][string]): string | null | undefined {
  if (value.kind === "direct" || value.kind === "present") return value.oid;
  if (value.kind === "absent") return null;
  if (value.kind === "safe-ref") return value.afterOid;
  return undefined;
}
