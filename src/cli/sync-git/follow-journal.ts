/** Checkout-journal lifecycle for the follow pipeline: bind a journal to this
 * repository incarnation, recover one, land its published intent, quarantine an
 * unbindable one, clear a settled one. Moved verbatim out of follow.ts. */
import fs from "node:fs/promises";
import path from "node:path";
import { clearCheckoutJournal, recoverJournal, retireCheckoutJournal, type CheckoutJournalBinding } from "./journal.js";
import { captureCommonDirIdentity } from "../../engine/lockfile.js";
import type { RepoCtx } from "./git-state.js";
import { intentSettled, savePublishedRepoIntent, type PublishedRepoIntentDisposition } from "../sync-published-intent.js";
import { observedLandingRepoBaseProof, recordOriginLineage } from "./base-composer.js";
import type { FollowIntended, FollowOptions } from "./follow-types.js";

export async function checkoutJournalBinding(stream: string, stateNonce: string, ctx: RepoCtx): Promise<CheckoutJournalBinding> {
  const commonDirReal = await fs.realpath(ctx.commonDir);
  return {
    stream,
    stateNonce,
    gitDirReal: await fs.realpath(ctx.gitDir),
    commonDirReal,
    commonDirIdentity: await captureCommonDirIdentity(commonDirReal),
    worktreeId: await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir)),
  };
}

export async function recoverFollowJournal(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
) {
  return recoverJournal<FollowIntended>(workspaceRoot, relPath, binding);
}

type RecoverAndLandFollowJournalResult = {
  recovery: Awaited<ReturnType<typeof recoverFollowJournal>>;
  state: import("../config.js").SyncState;
  disposition?: PublishedRepoIntentDisposition;
};

/** Recover a checkout journal and, when permitted, land and retire its published intent. */
export async function recoverAndLandFollowJournal(
  workspaceRoot: string,
  relPath: string,
  binding: CheckoutJournalBinding,
  state: import("../config.js").SyncState,
  opts: { land?: boolean; crashAt?: FollowOptions["crashAt"] } = {},
): Promise<RecoverAndLandFollowJournalResult> {
  const recovery = await recoverFollowJournal(workspaceRoot, relPath, binding);
  if (recovery.status !== "keep" || opts.land === false) return { recovery, state };
  // recoverJournal only returns "keep" after verifying the published checkout
  // against the live repository, so recovery.observedRefs is the refs actually on
  // disk. A journal written by this rbox already carries a witnessed proof; a
  // legacy (pre-proof) journal carries none, and its authority to install comes
  // from that verified observation — not from the missing proof — as an
  // observed-landing proof that can only install what disk was seen to hold.
  const intended = recovery.intended.baseProof !== undefined
    ? recovery.intended
    : {
        ...recovery.intended,
        // NAMED ROW (design 271 §3): this asserts dir/all regardless of the real
        // repository. Pre-existing; changing it changes journal recovery.
        baseProof: observedLandingRepoBaseProof(
          recovery.observedRefs,
          recordOriginLineage(recovery.intended.record.branchBaseOrigins) ?? "legacy-untrusted",
          { repoKind: "dir", effectiveRefScope: "all", checkoutComplete: true },
        ),
      };
  const published = await savePublishedRepoIntent(workspaceRoot, state, relPath, intended);
  if (intentSettled(published.disposition)) await clearFollowJournal(workspaceRoot, relPath, opts.crashAt);
  return { recovery, state: published.state, disposition: published.disposition };
}

/** No usable repo context means recovery must never touch Git. Supplying an
 * impossible path binding makes a valid journal retire through the engine's
 * ordinary binding-mismatch path; corrupt journals remain visible/deferred. */
export async function quarantineUnboundFollowJournal(workspaceRoot: string, relPath: string, stream: string, stateNonce: string) {
  const recovery = await recoverJournal<FollowIntended>(workspaceRoot, relPath, {
    stream,
    stateNonce,
    gitDirReal: "",
    commonDirReal: "",
    commonDirIdentity: { path: "", realpath: "", dev: "", ino: "", birthtimeNs: "" },
    worktreeId: "",
  });
  // A journal that cannot pass its own schema never will, and with no readable
  // repository there is nothing left for it to protect. Left in place it
  // defers the repository forever, even past its own removal and re-adoption
  // (#879). Retire it exactly as a binding mismatch would; the bytes survive
  // in quarantine for forensics.
  if (recovery.status === "defer" && recovery.unrecoverable) {
    return { status: "binding-mismatch" as const, quarantinePath: await retireCheckoutJournal(workspaceRoot, relPath) };
  }
  return recovery;
}

export async function clearFollowJournal(workspaceRoot: string, relPath: string, crashAt?: FollowOptions["crashAt"]): Promise<void> {
  crashAt?.("before-journal-clear");
  await clearCheckoutJournal(workspaceRoot, relPath);
}
