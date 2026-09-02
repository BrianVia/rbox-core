/** Never: Git I/O or sync policy. */
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
  /** Deleting the scratch/incoming ref namespaces the follow staged: the
   * enumeration plus the deletes, at every cleanup site on the follow path. */
  refCleanupMs: number;
  /** How many refs those deletes covered — the width `refCleanupMs` bought.
   * A count, never a duration: excluded from the timed fields and from the
   * leaf partition, exactly like `chainLength`. */
  refCleanupRefs: number;
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
  /** Full-follow wall time after subtracting every named leaf accrued inside
   * it. `followDivergedRepo` is the parent of nearly every leaf above, so a
   * gross bucket would double-count; this is `classifyExclusiveMs`'s
   * discipline generalized to the whole leaf set. Without it the follow's own
   * unattributed cost is indistinguishable from cost outside the follow. */
  followMs: number;
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
    refCleanupMs: 0,
    refCleanupRefs: 0,
    journalMs: 0,
    classifyMs: 0,
    classifyExclusiveMs: 0,
    heldInputMs: 0,
    standingProofMs: 0,
    followMs: 0,
    residualMs: 0,
  };
}

type GitTimedField = Exclude<keyof GitChainTimings,
  "chainLength" | "refCleanupRefs" | "classifyMs" | "classifyExclusiveMs" | "followMs" | "residualMs">;

/** The exclusive leaf partition, in one place: what `residualMs` closes
 * against, and what an exclusive parent bucket must subtract. */
const LEAF_FIELDS = [
  "fetchDecryptMs", "bundleVerifyMs", "gitImportMs", "refTxnExclusiveMs",
  "ownershipMs", "reflogMs", "connectivityProofMs", "indexOpStateMs",
  "journalMs", "classifyExclusiveMs", "heldInputMs", "standingProofMs",
  "refCleanupMs",
] as const satisfies ReadonlyArray<keyof GitChainTimings>;

/** The leaves the classifier parents, in one place. `classifyExclusiveMs`
 * subtracts these BY NAME, so a leaf that can accrue inside the classifier and
 * is missing from this list is billed twice — once to itself and once to the
 * exclusive figure. `refCleanupMs` is here because cleanup is reachable from
 * the classifier's call graph, not because the classifier owns it. */
const CLASSIFY_CHILD_FIELDS = ["ownershipMs", "reflogMs", "refCleanupMs"] as const satisfies
  ReadonlyArray<(typeof LEAF_FIELDS)[number]>;

const leafMs = (timings: GitChainTimings): number =>
  LEAF_FIELDS.reduce((sum, field) => sum + timings[field], 0);

export async function addTimedMs<T>(timings: GitChainTimings | undefined, field: GitTimedField, fn: () => T | Promise<T>): Promise<T> {
  if (!timings) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    timings[field] += performance.now() - t0;
  }
}

/** Record the ref width behind `refCleanupMs`. A tally, not a duration, so it
 * has no `addTimedMs` form — but it lives here because the field's owner does. */
export function countRefCleanup(timings: GitChainTimings | undefined, refs: number): void {
  if (timings) timings.refCleanupRefs += refs;
}

/** Report the classifier parent while billing only its non-child wall time to
 * the exclusive partition. The children are named in `CLASSIFY_CHILD_FIELDS` —
 * keep the subtraction there, not inlined here, so a new leaf has one place to
 * be declared instead of a silent double count. */
export async function addClassifyTimedMs<T>(timings: GitChainTimings | undefined, fn: () => T | Promise<T>): Promise<T> {
  if (!timings) return fn();
  const t0 = performance.now();
  const childrenBefore = classifyChildMs(timings);
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - t0;
    const childMs = classifyChildMs(timings) - childrenBefore;
    timings.classifyMs += elapsed;
    timings.classifyExclusiveMs += Math.max(0, elapsed - childMs);
  }
}

const classifyChildMs = (timings: GitChainTimings): number =>
  CLASSIFY_CHILD_FIELDS.reduce((sum, field) => sum + timings[field], 0);

/** Bill the full follow's own cost — everything it spends outside the named
 * leaves it parents. Design 573/814: without this the dominant term of a
 * held-repo pull lands in `residualMs` and the phase report cannot name it. */
export async function addFollowTimedMs<T>(timings: GitChainTimings | undefined, fn: () => T | Promise<T>): Promise<T> {
  if (!timings) return fn();
  const t0 = performance.now();
  const leavesBefore = leafMs(timings);
  try {
    return await fn();
  } finally {
    const elapsed = performance.now() - t0;
    timings.followMs += Math.max(0, elapsed - (leafMs(timings) - leavesBefore));
  }
}

/** Close the explicit residual against the exact per-repo wall interval. */
export function finalizeGitChainTimings(timings: GitChainTimings, repoWallMs: number): void {
  timings.residualMs = Math.max(0, repoWallMs - leafMs(timings) - timings.followMs);
}
