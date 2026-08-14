export interface GitChainTimings {
  chainLength: number;
  fetchDecryptMs: number;
  bundleVerifyMs: number;
  gitImportMs: number;
  refTxnExclusiveMs: number;
  ownershipMs: number;
  reflogMs: number;
  connectivityProofMs: number;
  indexOpStateMs: number;
  /** Checkout ownership-journal durable writes, marker observations, and fsyncs. */
  journalMs: number;
  /** Nested parent: reported separately and never added to exclusive leaves. */
  classifyMs: number;
  /** Classifier wall time after subtracting its ownership/reflog child leaves. */
  classifyExclusiveMs: number;
  /** Held-attempt fingerprint decisions and stable input observations. */
  heldInputMs: number;
  /** Standing branch-artifact proof and settlement. */
  standingProofMs: number;
  residualMs: number;
}

export function zeroGitChainTimings(): GitChainTimings {
  return {
    chainLength: 0,
    fetchDecryptMs: 0,
    bundleVerifyMs: 0,
    gitImportMs: 0,
    refTxnExclusiveMs: 0,
    ownershipMs: 0,
    reflogMs: 0,
    connectivityProofMs: 0,
    indexOpStateMs: 0,
    journalMs: 0,
    classifyMs: 0,
    classifyExclusiveMs: 0,
    heldInputMs: 0,
    standingProofMs: 0,
    residualMs: 0,
  };
}

type GitTimedField = Exclude<keyof GitChainTimings,
  "chainLength" | "classifyMs" | "classifyExclusiveMs" | "residualMs">;

export async function addTimedMs<T>(timings: GitChainTimings | undefined, field: GitTimedField, fn: () => T | Promise<T>): Promise<T> {
  if (!timings) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[field] += performance.now() - t0;
  }
}

/** Report the classifier parent while billing only its non-child wall time to
 * the exclusive partition. Classifier-owned Git leaves are deliberately
 * limited to ownership and reflog; keep this subtraction beside that contract. */
export async function addClassifyTimedMs<T>(timings: GitChainTimings | undefined, fn: () => T | Promise<T>): Promise<T> {
  if (!timings) return fn();
  const t0 = performance.now();
  const ownershipBefore = timings.ownershipMs;
  const reflogBefore = timings.reflogMs;
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - t0;
    const childMs = (timings.ownershipMs - ownershipBefore) + (timings.reflogMs - reflogBefore);
    timings.classifyMs += elapsed;
    timings.classifyExclusiveMs += Math.max(0, elapsed - childMs);
  }
}

/** Close the explicit residual against the exact per-repo wall interval. */
export function finalizeGitChainTimings(timings: GitChainTimings, repoWallMs: number): void {
  const attributed = timings.fetchDecryptMs + timings.bundleVerifyMs + timings.gitImportMs
    + timings.refTxnExclusiveMs + timings.ownershipMs + timings.reflogMs
    + timings.connectivityProofMs + timings.indexOpStateMs + timings.journalMs
    + timings.classifyExclusiveMs + timings.heldInputMs + timings.standingProofMs;
  timings.residualMs = Math.max(0, repoWallMs - attributed);
}
