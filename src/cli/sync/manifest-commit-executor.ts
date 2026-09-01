/** Never: candidate selection, scan/encryption/upload, BASE advancement, or state/config reads. */
import type { Manifest } from "../../engine/index.js";
import type { GitResolutionPublicationReceipt, GlobalManifestMeta } from "../config.js";
import type { CommitOptions, CommitResult, CommitTimings } from "../remote.js";
import type { PublicationIdentity } from "./publish-candidate.js";

/**
 * The sealed commit effect. Every delta/snapshot choice, parent selection, and
 * keep-mine admission is already decided: this plan is materialized onto the
 * wire verbatim. It names no Git plan, no `SyncState`, and no BASE.
 */
export interface ManifestCommitEffectPlan {
  /** The publication this commit belongs to; every receipt echoes it exactly. */
  readonly identity: PublicationIdentity;
  /** The exact manifest to POST — already deferral-pruned and schema-stamped. */
  readonly manifest: Manifest;
  /** §3.6.3: a chain repair posts the PIN's sequence, not the accepted one. */
  readonly parentSequence: number;
  /** Design 204 §4.2: the base the planner verified, or nothing. `validated`
   * carries that verification forward so the writer does not repeat it (#816). */
  readonly deltaBase?: { manifest: Manifest; meta: GlobalManifestMeta; validated?: true };
  /** Design 204 §7: why the planner withheld `deltaBase`, so the writer logs the
   * true non-delta cause instead of inferring one from an absent base. */
  readonly deltaBaseRejection?: "no-base" | "integrity";
  readonly forceSnapshot: boolean;
  readonly blockedFingerprint?: string;
  /** #820: a retry re-uploads the refset sidecar unconditionally. */
  readonly retryAttempt?: true;
  /** Whether the surrounding push report wants per-commit timings. */
  readonly reportTimings: boolean;
  /** Keep-mine publication authority to durably arm at the last boundary before
   * the POST. Absent unless the planner admitted an exact publication. */
  readonly keepMineArm?: GitResolutionPublicationReceipt;
  /** Whether a keep-mine rider rides this publication. It alone — not the arm —
   * selects the resolution-transition classification of a parent conflict. */
  readonly resolutionRider: boolean;
}

/** The bounded reconciliation this executor may read after a lost ACK. */
export type KeepMineReconciliation =
  | { status: "none" }
  | { status: "exact" | "mismatch"; sequence: number; manifest: Manifest };

/**
 * Every effect this executor may order. None of these advances BASE: arming and
 * disarming move keep-mine publication authority only, and the conflict pull
 * installs a revision this executor does not author.
 */
export interface ManifestCommitPort {
  /** Durably install keep-mine publication authority. The transport awaits this
   * at its last client-side boundary; no failure-capable work may follow it. */
  armKeepMine(receipt: GitResolutionPublicationReceipt): Promise<void>;
  commit(request: {
    parentSequence: number;
    manifest: Manifest;
    options?: CommitOptions;
  }): Promise<CommitResult>;
  reportCommitTimings(timings: CommitTimings): void;
  /** Retire an armed receipt no commit acknowledged, then reload durable state. */
  disarmKeepMine(receipt: GitResolutionPublicationReceipt): Promise<void>;
  /** Parent-conflict retry-pressure tally (design 09 §3). Advisory. */
  notifyConflict(): void;
  /** Authenticated lost-ACK reconciliation for an armed receipt. */
  reconcileKeepMine(): Promise<KeepMineReconciliation>;
  /** Absorb the conflicting remote revision and report what it installed. */
  pullAndLoadAccepted(): Promise<{ sequence: number; manifest: Manifest }>;
}

/** The closed outcome of a publication that carried a keep-mine rider. */
export type ResolutionTransitionReceipt =
  | { readonly kind: "published"; readonly sequence: number; readonly manifest: Manifest }
  | {
      readonly kind: "remote-moved";
      readonly sequence: number;
      readonly manifest: Manifest;
      readonly reason: string;
    }
  | { readonly kind: "authentication-failed"; readonly reason: string };

interface ReceiptBase {
  readonly identity: PublicationIdentity;
}

export type ManifestCommitExecutionReceipt =
  | (ReceiptBase & {
      readonly kind: "accepted";
      readonly sequence: number;
      readonly manifestMeta?: GlobalManifestMeta;
      /** The authority armed for this POST, which the acknowledging transition
       * must retire — present only when the arm actually ran. */
      readonly armed?: GitResolutionPublicationReceipt;
    })
  | (ReceiptBase & { readonly kind: "conflict" })
  | (ReceiptBase & { readonly kind: "epoch-stale" })
  | (ReceiptBase & {
      readonly kind: "unsatisfied";
      readonly unsatisfiedBlobs: string[];
      readonly unsatisfiedTotal?: number;
      readonly attemptedManifestChain?: string[];
    })
  | (ReceiptBase & { readonly kind: "ack-uncertain"; readonly reason: string })
  | (ReceiptBase & {
      readonly kind: "resolution-transition";
      readonly transition: ResolutionTransitionReceipt;
    });

const LOST_ACK_REASON =
  "the publish acknowledgement was lost; run rbox push or rbox pull to reconcile";
const REMOTE_MOVED_REASON = "another machine published while confirming";
const UNAUTHENTICATED_REASON =
  "remote truth could not be authenticated; run rbox push or rbox pull to reconcile";

/**
 * Execute one sealed manifest commit: materialize the wire options, arm keep-mine
 * authority immediately before the POST, send it, and classify the response into
 * exactly one receipt bound to the plan's {@link PublicationIdentity}.
 *
 * This executor plans nothing and advances no BASE. A POST failure under an armed
 * authority is a lost acknowledgement, not an error: only an unarmed publication
 * may propagate the transport's throw.
 */
export async function executeManifestCommit(
  plan: ManifestCommitEffectPlan,
  port: ManifestCommitPort,
): Promise<ManifestCommitExecutionReceipt> {
  const identity = plan.identity;
  let timings: CommitTimings | undefined;
  let armed: GitResolutionPublicationReceipt | undefined;

  // Each option key is SET ONLY WHEN IT APPLIES — absent, never present-and-undefined
  // — and `options` itself stays undefined unless at least one key was set. `opt()`
  // materializes it on first use, so that stays true without a separate predicate
  // duplicating the six conditions below.
  let options: CommitOptions | undefined;
  const opt = (): CommitOptions => (options ??= {});
  if (plan.blockedFingerprint !== undefined) opt().blockedFingerprint = plan.blockedFingerprint;
  if (plan.retryAttempt) opt().retryAttempt = true;
  if (plan.reportTimings) opt().onCommitTimings = (value: CommitTimings) => (timings = value);
  if (plan.deltaBase) opt().deltaBase = plan.deltaBase;
  if (plan.deltaBaseRejection) opt().deltaBaseRejection = plan.deltaBaseRejection;
  if (plan.forceSnapshot) opt().forceSnapshot = true;
  const keepMineArm = plan.keepMineArm;
  if (keepMineArm) {
    opt().beforeCommitSend = async () => {
      await port.armKeepMine(keepMineArm);
      armed = keepMineArm;
    };
  }

  let result: CommitResult;
  try {
    result = await port.commit({
      parentSequence: plan.parentSequence,
      manifest: plan.manifest,
      options,
    });
  } catch (error) {
    if (armed) return { kind: "ack-uncertain", identity, reason: LOST_ACK_REASON };
    throw error;
  }
  if (timings) port.reportCommitTimings(timings);

  if (result.epochStale !== undefined) {
    if (armed) await port.disarmKeepMine(armed);
    return { kind: "epoch-stale", identity };
  }
  if (result.conflict) {
    port.notifyConflict();
    if (plan.resolutionRider) {
      try {
        if (armed) {
          const reconciled = await port.reconcileKeepMine();
          if (reconciled.status === "exact") {
            return {
              kind: "resolution-transition",
              identity,
              transition: { kind: "published", sequence: reconciled.sequence, manifest: reconciled.manifest },
            };
          }
          if (reconciled.status === "mismatch") {
            return {
              kind: "resolution-transition",
              identity,
              transition: {
                kind: "remote-moved",
                sequence: reconciled.sequence,
                manifest: reconciled.manifest,
                reason: REMOTE_MOVED_REASON,
              },
            };
          }
        }
        const accepted = await port.pullAndLoadAccepted();
        return {
          kind: "resolution-transition",
          identity,
          transition: {
            kind: "remote-moved",
            sequence: accepted.sequence,
            manifest: accepted.manifest,
            reason: REMOTE_MOVED_REASON,
          },
        };
      } catch {
        return {
          kind: "resolution-transition",
          identity,
          transition: { kind: "authentication-failed", reason: UNAUTHENTICATED_REASON },
        };
      }
    }
    return { kind: "conflict", identity };
  }
  if (result.unsatisfiedBlobs) {
    if (armed) await port.disarmKeepMine(armed);
    return {
      kind: "unsatisfied",
      identity,
      unsatisfiedBlobs: result.unsatisfiedBlobs,
      unsatisfiedTotal: result.unsatisfiedTotal,
      attemptedManifestChain: result.attemptedManifestChain,
    };
  }
  return {
    kind: "accepted",
    identity,
    sequence: result.sequence!,
    manifestMeta: result.manifestMeta,
    armed,
  };
}
