/**
 * The terminal lines that report a Git deferral.
 *
 * `renderGitDeferralLine` is a FROZEN log grammar (design 176 §3): the daemon
 * writes it and doctor-cmd parses it back, so its shape is a wire contract, not
 * prose. The companion line beside it is status-only and therefore free to
 * explain — keeping the two in one module is what keeps that boundary visible.
 */
import type { CheckoutTransactionCapability } from "../sync-git/checkout-txn.js";
import { ageBucket, boundedCuratedDetail, truncateDetail } from "./text.js";
import { gitDeferralReasonPresentation, gitDeferralReasonText } from "./git-projection.js";

/** Pure, terminal-safe local rendering. Detached checkouts never expose an OID. */
export function renderGitDeferralLine(input: {
  relPath: string;
  reason: string;
  deferredSince: string;
  checkout?: { kind: "branch" | "detached"; label?: string };
  bytesChanged?: boolean;
  now: number;
  capability?: CheckoutTransactionCapability;
}): string {
  const checkout = input.checkout?.kind === "branch"
    ? `branch ${input.checkout.label ? truncateDetail(input.checkout.label) : "(unknown)"}`
    : input.checkout?.kind === "detached"
      ? "detached checkout"
      : "checkout unavailable";
  const changed = input.bytesChanged ? " (working files changed since)" : "";
  const reason = input.reason === "unsupported" && input.capability
    ? `needs Git >= 2.46 transactional symref-update${input.capability.version ? `; found ${truncateDetail(input.capability.version)}` : `; ${input.capability.status}`}`
    : gitDeferralReasonText(input.reason);
  return `git deferred ${ageBucket(input.deferredSince, input.now)}: ${reason} on ${checkout} (${truncateDetail(input.relPath)})${changed}`;
}

/** Status-only explanation for the byte-frozen `git deferred` record above.
 * This line is never written to daemon logs or diagnostics, so the parsers of
 * the shared record keep their exact grammar and privacy boundary. */
export function renderGitDeferralCompanion(input: {
  reason: string;
  canResolve: boolean;
  canKeepMine: boolean;
  staleLockDetail?: { lockCount: number; oldestAgeMs: number; samplePath: string };
  /** Curated at the deferral-writing site; rendered verbatim, never composed. */
  detail?: string;
}): string {
  const presentation = gitDeferralReasonPresentation(input.reason);
  const curated = input.detail ? ` ${boundedCuratedDetail(input.detail)}` : "";
  const reassurance = `Your repository is healthy; only rbox's bookkeeping is paused (${presentation.label}).${curated}`;
  if (input.reason === "stale-unattributed" && input.staleLockDetail) {
    const detail = input.staleLockDetail;
    const count = `${detail.lockCount} stable lock${detail.lockCount === 1 ? "" : "s"}`;
    const oldestSeconds = Math.max(0, Math.floor(detail.oldestAgeMs / 1000));
    const oldest = oldestSeconds < 60 ? `${oldestSeconds}s` : oldestSeconds < 3600
      ? `${Math.floor(oldestSeconds / 60)}m`
      : `${Math.floor(oldestSeconds / 3600)}h`;
    return `rbox found ${count} without a known live owner; oldest ${oldest} (for example ${truncateDetail(detail.samplePath)}). ` +
      "Run `rbox doctor`, confirm no Git process owns the reported locks, then remove only the verified stale lock files and let sync retry.";
  }
  if (!input.canResolve) return `${reassurance} ${presentation.repair}`;
  if (!input.canKeepMine) {
    return `${reassurance} Nothing is waiting to publish with \`keep-mine\`; ` +
      "`take-theirs` uses the waiting version from your other computer and sets aside this computer's Git changes.";
  }
  return `${reassurance} To keep this computer's version and publish it, run \`rbox git resolve <repo> keep-mine\`; ` +
    "`take-theirs` uses the version from your other computer and sets aside this computer's Git changes.";
}
