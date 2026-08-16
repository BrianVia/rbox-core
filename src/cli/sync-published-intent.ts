/**
 * Completing a published repository intent (the checkout journal's landing).
 *
 * Separate from the source-save path on purpose: this recomposes ONE repository
 * against whatever landed while the checkout ran, lane by lane, and its merge
 * rules answer a different question than `composeStateSavePacket` does — which
 * of two competing episodes is newer, rather than what one source observed.
 */
import { isDeepStrictEqual } from "node:util";
import {
  applyStateSavePacket, expectedStateNonce, repoRecordsForState,
  type GitDeferral, type GitDeferrals, type RepoRecord, type RepoRecordInput, type SyncState,
} from "./config.js";
import { composeRepoBase, type RepoBaseProof } from "./sync-git/base-composer.js";
import { provisionalRepoBaseProof } from "./sync-git/base-proof-selection.js";
import { CONFIG_LANE_FIELDS, inputRecord, isStrictlyNewer } from "./sync-state.js";

export type PublishedRepoIntentDisposition = "landed" | "already-semantic" | "superseded";

/** A published intent is settled for every currently known terminal disposition. */
export const intentSettled = (disposition: PublishedRepoIntentDisposition): boolean =>
  disposition === "landed" || disposition === "already-semantic" || disposition === "superseded";

interface PublishedRepoIntentResult {
  state: SyncState;
  disposition: PublishedRepoIntentDisposition;
}

/** Complete a published checkout journal with a fresh generation-CAS merge.
 * The opaque intended record supplies the checkout/config result, while current
 * capture deferrals are retained. Apply/config transitions are merged by their
 * own episode: a retry-only lastSeen refresh is not a competing transition. */
export async function savePublishedRepoIntent(
  root: string,
  snapshot: SyncState,
  relPath: string,
  intended: { record: RepoRecordInput; expectedRepoGen: number; relPath: string; previousRecord?: RepoRecordInput; baseProof?: RepoBaseProof },
): Promise<PublishedRepoIntentResult> {
  if (intended.relPath !== relPath) throw new Error("published journal relPath mismatch");
  const select = (record: RepoRecordInput | undefined, fields: readonly (keyof RepoRecordInput)[]): object =>
    Object.fromEntries(fields.map((field) => [field, record?.[field]]));
  const applyFields = ["base", "branchBaseOrigins", "packedRefsIdentity", "pending", "repoAbsent", "removedKey", "resolutionKey", "partial", "idxProj"] as const;
  const configFields = CONFIG_LANE_FIELDS;
  const replace = (target: RepoRecordInput, desired: RepoRecordInput, fields: readonly (keyof RepoRecordInput)[]): void => {
    for (const field of fields) {
      if (desired[field] === undefined) delete target[field];
      else Object.assign(target, { [field]: desired[field] });
    }
  };
  const laneDeferral = (record: RepoRecordInput | undefined, lane: "apply" | "capture" | "config") => record?.deferrals?.[lane];
  const sameEpisode = (left: GitDeferral | undefined, right: GitDeferral | undefined): boolean =>
    left === undefined || right === undefined
      ? left === right
      : left.deferredSince === right.deferredSince && left.reason === right.reason;
  const deferralSemantic = (current: GitDeferral | undefined, desired: GitDeferral | undefined): boolean => {
    if (!current || !desired) return current === desired;
    const { lastSeen: _currentLastSeen, ...currentEffect } = current;
    const { lastSeen: _desiredLastSeen, ...desiredEffect } = desired;
    return isDeepStrictEqual(currentEffect, desiredEffect)
      && !isStrictlyNewer(desired.lastSeen, current.lastSeen);
  };
  const laneSemantic = (
    current: RepoRecordInput,
    desired: RepoRecordInput,
    fields: readonly (keyof RepoRecordInput)[],
    lane: "apply" | "config",
  ): boolean => isDeepStrictEqual(select(current, fields), select(desired, fields))
    && deferralSemantic(laneDeferral(current, lane), laneDeferral(desired, lane));
  const laneStillAtPredecessor = (
    current: RepoRecordInput,
    previous: RepoRecordInput,
    desired: RepoRecordInput,
    fields: readonly (keyof RepoRecordInput)[],
    lane: "apply" | "config",
  ): boolean => {
    const fieldsCompatible = isDeepStrictEqual(select(current, fields), select(previous, fields))
      || isDeepStrictEqual(select(current, fields), select(desired, fields));
    const currentDeferral = laneDeferral(current, lane);
    return fieldsCompatible && (
      sameEpisode(currentDeferral, laneDeferral(previous, lane))
      || sameEpisode(currentDeferral, laneDeferral(desired, lane))
    );
  };
  const installDeferral = (
    deferrals: GitDeferrals,
    current: GitDeferral | undefined,
    desired: GitDeferral | undefined,
    lane: "apply" | "config",
  ): void => {
    if (!desired) {
      delete deferrals[lane];
      return;
    }
    // Preserve only the newer observation time. The journal's other fields are
    // the intended set effect and must land even when the predecessor refreshed.
    if (current && sameEpisode(current, desired) && isStrictlyNewer(current.lastSeen, desired.lastSeen)) {
      deferrals[lane] = { ...desired, lastSeen: current.lastSeen };
    } else {
      deferrals[lane] = desired;
    }
  };
  let currentSnapshot = snapshot;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = repoRecordsForState(currentSnapshot)[relPath] ?? { repoGen: 0, sourceSeq: 0 };
    const currentInput = inputRecord(current);
    const exactGeneration = current.repoGen === intended.expectedRepoGen;
    const previous = intended.previousRecord ?? { sourceSeq: 0 };
    const appAlready = laneSemantic(currentInput, intended.record, applyFields, "apply");
    const configAlready = laneSemantic(currentInput, intended.record, configFields, "config");
    if (appAlready && configAlready && currentInput.sourceSeq >= intended.record.sourceSeq) {
      return { state: currentSnapshot, disposition: "already-semantic" };
    }
    const appUnchanged = exactGeneration
      || laneStillAtPredecessor(currentInput, previous, intended.record, applyFields, "apply");
    const configUnchanged = exactGeneration
      || laneStillAtPredecessor(currentInput, previous, intended.record, configFields, "config");
    const superseded = (!appAlready && !appUnchanged) || (!configAlready && !configUnchanged);

    // Generation drift means another save landed. Install a journal lane only
    // while it remains at the predecessor episode (a lastSeen refresh is still
    // that episode); a genuinely different episode wins. Capture is never
    // journal-owned and is always preserved.
    const merged: RepoRecordInput = { ...currentInput };
    if (!appAlready && appUnchanged) {
      replace(merged, intended.record, applyFields);
    }
    if (!configAlready && configUnchanged) replace(merged, intended.record, configFields);
    const deferrals = { ...(currentInput.deferrals ?? {}) };
    if (!appAlready && appUnchanged) {
      installDeferral(deferrals, currentInput.deferrals?.apply, intended.record.deferrals?.apply, "apply");
    }
    if (!configAlready && configUnchanged) {
      installDeferral(deferrals, currentInput.deferrals?.config, intended.record.deferrals?.config, "config");
    }
    if (Object.keys(deferrals).length) merged.deferrals = deferrals; else delete merged.deferrals;
    merged.sourceSeq = Math.max(currentInput.sourceSeq, intended.record.sourceSeq);
    const previousValue = { base: currentInput.base, branchBaseOrigins: currentInput.branchBaseOrigins };
    // Authority comes only from the proof the caller supplies. A published
    // checkout that verified its landing against disk supplies an observed-
    // landing proof (see recoverAndLandFollowJournal) that installs the refs it
    // observed; a caller with no proof — including a legacy journal whose
    // landing could not be confirmed — falls to carry, which holds. Missing
    // proof is never on its own a signal to install anything.
    const baseProof = provisionalRepoBaseProof(relPath, intended.baseProof, previousValue);
    const composed = composeRepoBase(
      previousValue,
      { base: merged.base, branchBaseOrigins: merged.branchBaseOrigins },
      baseProof.authority,
      baseProof.lockedProof,
    );
    if (composed.base === undefined) delete merged.base; else merged.base = composed.base;
    if (composed.branchBaseOrigins === undefined) delete merged.branchBaseOrigins;
    else merged.branchBaseOrigins = composed.branchBaseOrigins;
    if (composed.disposition === "pending" && intended.record.base && merged.pending === undefined) merged.pending = intended.record.base;
    if (isDeepStrictEqual(currentInput, merged)) {
      return { state: currentSnapshot, disposition: superseded ? "superseded" : "already-semantic" };
    }

    const result = await applyStateSavePacket(root, {
      expectedStream: currentSnapshot.stream,
      expectedNonce: expectedStateNonce(currentSnapshot),
      sourceGlobalSeq: merged.sourceSeq,
      repos: [{ relPath, expectedRepoGen: current.repoGen, newRecord: merged, baseProof }],
    });
    if (result.status === "accepted") {
      return { state: result.state, disposition: superseded ? "superseded" : "landed" };
    }
    if (result.status === "rejected" && (result.reason === "repo-generation" || result.reason === "global-sequence")) {
      currentSnapshot = result.state;
      continue;
    }
    if (result.status === "busy") throw new Error(`sync state busy (${result.detail})`);
    if (result.status === "unsupported") throw new Error(`sync state transactional save unsupported (${String(result.error)})`);
    throw new Error(`sync state changed during published recovery (${result.reason})`);
  }
  throw new Error("sync state kept changing during published recovery (3 recomputes exhausted)");
}
