/** Admission: everything a CAS packet must prove about ITSELF before a single
 * sealed row is read.
 *
 * These rules run on the caller's refs and claims, so every failure here is a
 * structural throw rather than a rejection: a packet that contradicts its own
 * artifacts is never a race someone can retry into success.
 */
import { canonicalJson } from "../digest/codecs.js";
import { sameStageBinding } from "../digest/repo-transition-v1.js";
import { StageChangedError } from "../errors.js";
import { canonicalBinding as canonicalDeltaBinding } from "./delta-stages.js";
import type { CasDeltaGlobal, CasPacket } from "./write-packet.js";

export function admitCasPacket(packet: CasPacket): void {
  assertPairing(packet);
  assertTransitionSnapshot(packet);
}

/**
 * A global packet must be paired with the transition stage built from it, and the
 * design explicitly allows further stages that are named only as Git evidence — so
 * the global binding must be PRESENT, not alone.
 */
function assertPairing(packet: CasPacket): void {
  const bindings = packet.repoTransitions.sourceStageBindings;
  if (packet.global && packet.globalDelta) {
    throw new StageChangedError(packet.repoTransitions.stageId, "a packet carries a complete global or a delta, never both");
  }
  const global = packet.global ?? packet.globalDelta;
  if (!global) {
    if (bindings.length !== 0 || packet.repoTransitions.globalBinding !== undefined) {
      throw new StageChangedError(packet.repoTransitions.stageId, "a repo-only packet must declare an empty source-stage list");
    }
    return;
  }
  if (!bindings.some((binding) => sameStageBinding(binding, global.stage))) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the global stage is not one of the transition stage's source bindings");
  }
  // The transition stage must have been SEALED knowing which binding is global;
  // otherwise its rows were admitted without the global-present-per-row rule.
  const sealedGlobal = packet.repoTransitions.globalBinding;
  if (!sealedGlobal || !sameStageBinding(sealedGlobal, global.stage)) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the transition stage was not sealed against this global stage");
  }
  if (global.stage.plane !== "base") {
    throw new StageChangedError(global.stage.stageId, "a CAS global stage must be a BASE stage");
  }
  if (packet.global && packet.global.stage.counts.gitSections !== 0) {
    throw new StageChangedError(packet.global.stage.stageId, "the global ref names a file-only stage; stage Git must be consumed into transitions");
  }
  // The header that commits is the sealed one. A caller-supplied header is only
  // ever a claim, so it is compared and refused rather than trusted.
  if (canonicalJson(global.fileHeader) !== canonicalJson(global.stage.header)) {
    throw new StageChangedError(global.stage.stageId, "the packet's file header is not the header this stage was sealed with");
  }
  if (packet.globalDelta) assertDeltaBinding(packet.globalDelta);
}

/** A delta with no caller-minted binding is structurally inadmissible, and a
 * caller's binding that disagrees with the sealed one is never believed: the
 * value exists in two carriers precisely so neither can be trusted alone. */
function assertDeltaBinding(delta: CasDeltaGlobal): void {
  const sealed = delta.stage.binding;
  const claimed = delta.binding;
  if (!sealed || !claimed) {
    throw new StageChangedError(delta.stage.stageId, "a delta global must carry a predecessor binding");
  }
  if (!claimed.nonce || !Number.isSafeInteger(claimed.stateRevision) || claimed.stateRevision < 0) {
    throw new StageChangedError(delta.stage.stageId, "a delta binding must name a nonce and a nonnegative revision");
  }
  if (canonicalDeltaBinding(sealed) !== canonicalDeltaBinding(claimed)) {
    throw new StageChangedError(delta.stage.stageId, "the packet's delta binding is not the binding this delta was sealed with");
  }
}

function assertTransitionSnapshot(packet: CasPacket): void {
  const token = packet.repoTransitions.snapshotToken;
  const expected = packet.expected;
  const matches = token.lineageId === expected.lineageId
    && token.stream === expected.stream
    && (token.nonce ?? "legacy") === expected.nonce
    && (token.stateRevision ?? 0) === expected.stateRevision
    && token.baseGeneration === expected.baseGeneration
    && token.localRevision === expected.localRevision;
  if (!matches) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the transition stage is bound to a different snapshot than the packet expects");
  }
}
