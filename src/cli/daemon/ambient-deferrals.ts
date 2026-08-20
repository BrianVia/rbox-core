/**
 * The ambient snapshot's git-deferral ROW: its type, the writer that publishes
 * it, and the validator that reads it back — one module, because they are one
 * contract.
 *
 * They used to sit ~130 lines apart inside `ambient-status.ts`, and that is how
 * design 280 shipped a row that could not reproduce the counts printed beside
 * it: the predicate gained an input (`lastSeen`), the daemon-side counts used
 * it, and this row silently did not carry it (FM, 2026-08-20). A row whose
 * write shape and read shape are edited in the same file cannot drift that way
 * unnoticed.
 *
 * The bounding primitives live here too: everything that crosses the ambient
 * file boundary is untrusted text on the way back in, and both directions must
 * bound it identically.
 */
import type { JsonValue } from "../../json.js";
import {
  gitDeferralReasonPresentation,
  isKnownGitDeferralReason,
  type GitDeferralRemediationClass,
  type GitDeferralRepoProjection,
} from "../status-view/git-projection.js";

/** Control characters and runs of whitespace collapse; scalars, not UTF-16
 * units, are counted, so a bound can never split an astral character. */
export function boundedAmbientText(value: string, maxScalars: number): string {
  const clean = value.replace(/[\r\n\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return [...clean].slice(0, maxScalars).join("");
}

export function ambientIso(value: JsonValue | undefined): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

/**
 * A published row must be able to reproduce the counts published beside it.
 * `lastSeen` is the stuck predicate's wake guard; without it a reader
 * re-projecting these rows computes a DIFFERENT actionability than
 * `deferredNeedsYou` in the same file. Optional because a snapshot written by an
 * older daemon carries none, and absent reads as unknown — which fails safe.
 */
export interface AmbientGitDeferral {
  repo: string;
  reason: string;
  reasonLabel: string;
  reasonText: string;
  remediationClass: GitDeferralRemediationClass | string;
  deferredSince: string;
  reasonSince: string;
  lastSeen?: string;
  checkout?: { kind: "detached" } | { kind: "branch"; label?: string };
}

/** `null` is "present but malformed" — a row that must be rejected whole rather
 * than published without the checkout it claimed to have. */
function ambientCheckout(value: JsonValue | undefined): AmbientGitDeferral["checkout"] | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const checkout = value;
  if (checkout.kind === "detached") return { kind: "detached" };
  if (checkout.kind !== "branch") return null;
  if (checkout.label !== undefined && typeof checkout.label !== "string") return null;
  const branch: AmbientGitDeferral["checkout"] = { kind: "branch" };
  if (typeof checkout.label === "string") branch.label = boundedAmbientText(checkout.label, 512);
  return branch;
}

/** The projection's checkout, bounded for publication. */
function publishedCheckout(checkout: GitDeferralRepoProjection["checkout"]): AmbientGitDeferral["checkout"] | undefined {
  if (checkout?.kind === "detached") return { kind: "detached" };
  if (checkout?.kind !== "branch") return undefined;
  const branch: AmbientGitDeferral["checkout"] = { kind: "branch" };
  if (checkout.label !== undefined) branch.label = boundedAmbientText(checkout.label, 512);
  return branch;
}

/** One projected repo → one published row, or nothing when its identity or its
 * clocks cannot be stated honestly. */
export function serializeAmbientDeferral(deferral: GitDeferralRepoProjection): AmbientGitDeferral[] {
  const repo = boundedAmbientText(deferral.repo, 1_024);
  if (!repo || !ambientIso(deferral.oldestDeferredSince) || !ambientIso(deferral.reasonSince)) return [];
  const checkout = publishedCheckout(deferral.checkout);
  const row: AmbientGitDeferral = {
    repo,
    reason: boundedAmbientText(deferral.displayReason, 128),
    reasonLabel: boundedAmbientText(deferral.reasonLabel, 160),
    reasonText: boundedAmbientText(deferral.reasonText, 512),
    remediationClass: boundedAmbientText(deferral.remediationClass, 64),
    deferredSince: deferral.oldestDeferredSince,
    reasonSince: deferral.reasonSince,
  };
  if (ambientIso(deferral.lastSeen)) row.lastSeen = deferral.lastSeen;
  if (checkout !== undefined) row.checkout = checkout;
  return [row];
}

export function parseAmbientDeferral(value: JsonValue): AmbientGitDeferral | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value;
  if (typeof item.repo !== "string" || typeof item.reason !== "string"
    || typeof item.reasonLabel !== "string" || typeof item.reasonText !== "string"
    || typeof item.remediationClass !== "string"
    || !ambientIso(item.deferredSince) || !ambientIso(item.reasonSince)) return undefined;
  const repo = boundedAmbientText(item.repo, 1_024);
  if (!repo) return undefined;
  const reason = boundedAmbientText(item.reason, 128);
  const suppliedLabel = boundedAmbientText(item.reasonLabel, 160);
  const suppliedText = boundedAmbientText(item.reasonText, 512);
  const suppliedClass = boundedAmbientText(item.remediationClass, 64);
  const checkout = ambientCheckout(item.checkout);
  if (checkout === null) return undefined;
  const known = isKnownGitDeferralReason(reason);
  const presentation = gitDeferralReasonPresentation(reason);
  const row: AmbientGitDeferral = {
    repo,
    reason,
    reasonLabel: known ? suppliedLabel : presentation.label,
    reasonText: known ? suppliedText : presentation.text,
    remediationClass: known ? suppliedClass : "apply-unavailable",
    deferredSince: item.deferredSince,
    reasonSince: item.reasonSince,
  };
  // An absent clock is unknown; an unparseable one is dropped rather than
  // trusted. Both read as "not stuck", which is the safe direction.
  if (ambientIso(item.lastSeen)) row.lastSeen = item.lastSeen;
  if (checkout !== undefined) row.checkout = checkout;
  return row;
}
