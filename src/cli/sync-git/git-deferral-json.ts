/** Never: deferral policy, persistence, or rendering. */
import type { GitDeferral } from "../config.js";

export interface GitDeferralLaneJson {
  repo: string;
  lane: GitDeferral["lane"];
  reason: GitDeferral["reason"];
  deferredSince: string;
  reasonSince: string;
  ageSeconds: number | null;
  bytesChanged: boolean;
  checkout?: { kind: "branch"; label?: string } | { kind: "detached" };
}

/** The ONE JSON shape of a checkout classification, shared by every emitter so
 * two surfaces cannot describe the same repo's checkout differently. Returns the
 * VALUE, not a spreadable wrapper: every emitter assigns it to `checkout`, and
 * an undefined value drops the key on serialization exactly as an absent one did. */
export function checkoutValue(checkout: GitDeferral["checkout"]): GitDeferralLaneJson["checkout"] {
  if (checkout?.kind === "branch") return { kind: "branch", label: checkout.label };
  return checkout?.kind === "detached" ? { kind: "detached" } : undefined;
}

export function serializeGitDeferralLane(repo: string, deferral: GitDeferral, now: number): GitDeferralLaneJson {
  const parsed = Date.parse(deferral.deferredSince);
  const ageSeconds = Number.isFinite(parsed) && parsed <= now
    ? Math.floor((now - parsed) / 1_000)
    : null;
  return {
    repo,
    lane: deferral.lane,
    reason: deferral.reason,
    deferredSince: deferral.deferredSince,
    reasonSince: deferral.reasonSince,
    ageSeconds,
    bytesChanged: deferral.bytesChanged === true,
    checkout: checkoutValue(deferral.checkout),
  };
}

export function serializeGitDeferralLanes(
  deferrals: Iterable<{ repo: string; deferral: GitDeferral }>,
  now: number,
): GitDeferralLaneJson[] {
  return [...deferrals].map(({ repo, deferral }) => serializeGitDeferralLane(repo, deferral, now));
}
