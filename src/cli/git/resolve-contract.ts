/**
 * The resolve command's shared vocabulary: its three verbs, the SHAPES its one
 * exit can produce, the environment and dependency seams the orchestrator
 * injects, the closed refusal-code union, and the curated path-free text for the
 * five typed refusals raised inside the resolve mutex body.
 *
 * It is deliberately a leaf. Every other resolve module imports these names;
 * this one imports nothing from the family, so the verbs, output shapes and
 * refusal codes cannot drift into a particular verb's implementation.
 *
 * `GitResolveShow` and `ResolveOutput` live HERE rather than beside the renderer
 * because they are the contract, not the rendering of it: `observeOutput` gives
 * batch the typed outcome, and declaring that seam in terms of a type owned by
 * the renderer made the dependency run both ways. `resolve-presentation.ts`
 * re-exports both names for its existing importers.
 */
import type { BlobStore } from "../../engine/index.js";
import type { GitDeferralReason, WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import type { ScopeHaltCondition } from "../scope/binding-scope.js";
import type { CheckoutCapabilityProbe } from "../sync-git/checkout-txn.js";
import type { SyncMutexOptions } from "../sync-mutex.js";
import type { SyncDeps } from "../sync/deps.js";
import type { PushResult } from "../sync/push.js";
import type { ResolutionDiscardReport } from "../sync-git/resolution-intent.js";

export type GitResolveVerb = "show-me" | "take-theirs" | "keep-mine";

export interface ResolveEnvironment {
  cfg: WorkspaceConfig;
  store: BlobStore;
  remote?: SyncRemote;
}

export interface ProgressScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface GitResolveDeps {
  build?: (root: string) => Promise<ResolveEnvironment>;
  capabilityProbe?: CheckoutCapabilityProbe;
  mutexOptions?: SyncMutexOptions;
  /** Test seam for the closed proof-refusal mapping after a real snapshot. */
  forceProofIndeterminate?: boolean;
  /** Test seam for the two mutex-body refusals whose real trigger is a crash or
   *  concurrent-writer window inside the follow. Names the site; the emission,
   *  curated text, code and exit status are the production ones. */
  forceMutexBodyRefusal?: "incomplete-checkout" | "journal-recovery";
  /** Test seam: runs inside checkout-txn's lock-bound second-proof callback. */
  beforeSecondProof?: () => Promise<void>;
  /** Test seam: runs immediately before keep-mine reloads every confirmed input. */
  beforeConfirmRecheck?: () => Promise<void>;
  /** Test seam around the ordinary in-process push pipeline. */
  confirmedPush?: (args: { cfg: WorkspaceConfig; deps: SyncDeps; resolution: import("../sync-git/resolution-intent.js").GitResolutionRider }) => Promise<PushResult>;
  now?: () => Date;
  /** This machine's name for the human report only; never reaches --json. */
  hostname?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** The decided, already-sanitized result of one invocation, handed over as a
   * TYPED value. `rbox git resolve --under` runs the single-repo command in
   * process and needs its outcome; without this it would serialize to JSON and
   * reparse an `unknown` shape inside the same process, which is a parse with
   * no boundary to justify it. Never a second output surface: emission is
   * unchanged and this observer cannot alter it. */
  observeOutput?: (output: ResolveOutput) => void;
  /** Test seam for heartbeat scheduling; production remains ten seconds. */
  progressIntervalMs?: number;
  /** Test seam for proving heartbeat lifecycle without waiting on wall time. */
  progressScheduler?: ProgressScheduler;
}

export interface GitResolveShow {
  status: "show-me";
  repo: string;
  incomingCheckout: { kind: "branch" | "detached"; label?: string };
  localOnlyCommits: Array<{ labels: string[]; subject: string }>;
  oracle: "clean" | "dirty" | "indeterminate";
  index: "matches-incoming" | "diverged" | "absent" | "indeterminate";
  operationState: "matches-incoming" | "diverged";
  stash: "clean" | "diverged" | "not-owned";
  deferrals: Array<{ lane: string; reason: string; deferredSince: string; ageSeconds: number; bytesChanged?: boolean }>;
  snapshot: string;
}
export type ResolveOutput =
  | GitResolveShow
  | { status: "resolved"; verb: "take-theirs"; repo: string; snapshot: string; quarantine: string }
  | {
      status: "preview";
      verb: "keep-mine";
      repo: string;
      message: string;
      current: GitResolveShow;
      discardReport: ResolutionDiscardReport;
      confirm: { snapshot: string; forceDiscardIncoming: boolean };
    }
  | { status: "snapshot-mismatch"; verb: "take-theirs" | "keep-mine"; repo: string; message: string; current: GitResolveShow; discardReport?: ResolutionDiscardReport }
  | { status: "refused"; verb: GitResolveVerb; repo: string; code: ResolveRefusalCode; message: string; current?: GitResolveShow }
  | { status: "published"; verb: "keep-mine"; repo: string; sequence: number }
  | { status: "ack-uncertain"; verb: "keep-mine"; repo: string; message: string };
/** `makeIntended` is a callback the follow executor invokes; it cannot emit and
 * return, so its two refusals travel as classes the outer catch classifies. */
export class ManualLineageProofUnavailableError extends Error {
  constructor() {
    super("manual lineage proof unavailable");
    this.name = "ManualLineageProofUnavailableError";
  }
}

export class ManualBaseProofIncompleteError extends Error {
  constructor() {
    super("manual BASE proof is incomplete");
    this.name = "ManualBaseProofIncompleteError";
  }
}

/** Curated, path-free refusal text for the five typed resolve sites. */
export const RESOLVE_TYPED_REFUSAL = {
  "incomplete-checkout": "the incoming checkout was published for some refs but not all; the resolution is incomplete — retry after Git state settles",
  "journal-recovery": "the published checkout journal could not be recovered; retry after Git state settles, or inspect the local recovery copy",
  artifact: "the incoming checkout was applied but its settlement could not finish; your prior state is preserved in the Git quarantine — retry after Git state settles",
  "manual-lineage-proof": "this repository's Git lineage proof is unavailable; retry after Git state settles",
  "manual-base-proof": "the resolution may have partially applied and could not be fully proven — retry after Git state settles",
} as const;

export type ResolveRefusalCode =
  | "sync-busy" | "proof-indeterminate" | "journal-recovery" | "no-incoming" | "mutex-degraded" | "operation-failed"
  /** Design 271 §2.7: the five literal refusals inside the resolve mutex body,
   *  each answering "why" instead of collapsing into `operation-failed`. */
  | "incomplete-checkout" | "manual-lineage-proof" | "manual-base-proof"
  /** Design 212: this binding syncs part of the workspace, or its scope witnesses
   *  disagree. Either way keep-mine cannot publish from here. */
  | ScopeHaltCondition
  | GitDeferralReason;
