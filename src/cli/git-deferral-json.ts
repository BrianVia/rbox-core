import type { GitDeferral } from "./config.js";

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
    ...(deferral.checkout?.kind === "branch"
      ? { checkout: { kind: "branch" as const, ...(deferral.checkout.label === undefined ? {} : { label: deferral.checkout.label }) } }
      : deferral.checkout?.kind === "detached"
        ? { checkout: { kind: "detached" as const } }
        : {}),
  };
}

export function serializeGitDeferralLanes(
  deferrals: Iterable<{ repo: string; deferral: GitDeferral }>,
  now: number,
): GitDeferralLaneJson[] {
  return [...deferrals].map(({ repo, deferral }) => serializeGitDeferralLane(repo, deferral, now));
}
