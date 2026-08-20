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
 * two surfaces cannot describe the same repo's checkout differently. */
export function checkoutJson(checkout: GitDeferral["checkout"]): { checkout: NonNullable<GitDeferralLaneJson["checkout"]> } | Record<string, never> {
  if (checkout?.kind === "branch") {
    return { checkout: { kind: "branch", ...(checkout.label === undefined ? {} : { label: checkout.label }) } };
  }
  return checkout?.kind === "detached" ? { checkout: { kind: "detached" } } : {};
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
    ...checkoutJson(deferral.checkout),
  };
}

export function serializeGitDeferralLanes(
  deferrals: Iterable<{ repo: string; deferral: GitDeferral }>,
  now: number,
): GitDeferralLaneJson[] {
  return [...deferrals].map(({ repo, deferral }) => serializeGitDeferralLane(repo, deferral, now));
}
