import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "../../engine/e2ee/jcs.js";
import { basePresentArtifactRef, basePresentKeepRef, type BasePresentPayload } from "./base-artifacts.js";
import { buildPRepairQ, buildPRepairReceipt, parsePRepairReceipt } from "./p-repair.js";
import type { GitSection } from "../../engine/types.js";
import { loadRawState, statePath, type SyncState } from "../config.js";
import { createPRepairStatePort } from "./p-repair-state.js";

const L = "1".repeat(64);
const I = "2".repeat(64);
const PRIOR = "a".repeat(40);
const NEXT = "b".repeat(40);
const P_OID = "c".repeat(40);
const Q_OID = "d".repeat(40);
const EPISODE = "e".repeat(32);
const REF = "refs/heads/main";

const section = (oid: string): GitSection => ({
  bundleSha: "3".repeat(64), bundleEncSha: "4".repeat(64), bundleCipherSize: 1,
  head: `ref: ${REF}\n`, refs: { [REF]: oid, "refs/tags/keep": PRIOR }, refScope: "all", generatedAt: "2026-07-16T12:00:00.000Z",
});

const payload: BasePresentPayload = {
  v: 2, lineageHash: L, repositoryIdentityHash: I, ref: REF, episode: EPISODE, priorOid: PRIOR, nextOid: NEXT,
};
const p = {
  ref: basePresentArtifactRef(payload, REF), targetOid: P_OID, payload, payloadBytes: canonicalize(payload),
};

function receipt(at: string) {
  const built = buildPRepairQ({
    lineageHash: L, repositoryIdentityHash: I, artifactRef: p.ref, artifactOid: P_OID,
    pPayload: payload, payloadBytes: p.payloadBytes,
    observed: { liveOid: NEXT, baseOid: PRIOR, repoGen: 0, stateRevision: 0, incomingKey: "incoming", reflogBytes: Buffer.from("reflog"), reflogEntries: 1, reflogTop: Buffer.from("top") },
    skeep: [PRIOR, NEXT], at, mismatches: { live: true, reflog: false, baseRefs: false },
  });
  return buildPRepairReceipt({
    lineageHash: L, repositoryIdentityHash: I, ref: REF, episode: EPISODE,
    p: { ref: p.ref, targetOid: P_OID },
    k: [
      { ref: basePresentKeepRef(payload, REF, EPISODE, "prior"), targetOid: PRIOR },
      { ref: basePresentKeepRef(payload, REF, EPISODE, "next"), targetOid: NEXT },
    ],
    q: { ref: built.ref, targetOid: Q_OID, value: built.value }, skeep: [PRIOR, NEXT], reflogBytes: Buffer.from("reflog"), eviction: null,
  });
}

let root: string | undefined;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); root = undefined; });

test("§130 state port advances BASE through composer and mutates only the P-bound journal member", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-p-repair-state-"));
  await fs.mkdir(path.join(root, ".rbox"));
  const state: SyncState = {
    stream: "stream", lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "", files: [] },
    stateNonce: "nonce", stateRevision: 0,
    repoRecords: { repo: {
      repoGen: 0, sourceSeq: 1, base: section(PRIOR),
      partial: { incomingKey: "incoming", checkoutPending: true,
        appliedRefs: { [REF]: { kind: "present", oid: NEXT, artifactOid: P_OID, episode: EPISODE }, "refs/tags/keep": { kind: "direct", oid: PRIOR } },
        heldRefs: {}, configApplied: false },
    } },
  };
  await fs.writeFile(statePath(root), JSON.stringify(state));
  const port = createPRepairStatePort({ root, stream: "stream", relPath: "repo", repoKind: "dir", effectiveRefScope: "all", p });
  const before = await port.read();
  const first = receipt("2026-07-16T12:00:00.000Z");
  expect(await port.cas({
    expected: before,
    nextBaseOid: NEXT,
    receipt: first,
    lockedObservation: {
      liveOid: first.q.value.observed.liveOid,
      reflogSha256: first.reflog.sha256,
      artifactsValidated: true,
      keepRefsVerified: true,
    },
  })).toBe("accepted");
  let saved = (await loadRawState(root))!.repoRecords!.repo!;
  expect(saved.base?.refs[REF]).toBe(NEXT);
  expect(saved.base?.refs["refs/tags/keep"]).toBe(PRIOR);
  expect(saved.branchBaseOrigins?.[REF]).toEqual({ v: 1, oid: NEXT, lineageHash: L, kind: "pull-p", episode: EPISODE });
  expect(saved.partial?.appliedRefs[REF]).toBeUndefined();
  expect(saved.partial?.appliedRefs["refs/tags/keep"]).toEqual({ kind: "direct", oid: PRIOR });
  expect(saved.partial?.pRepaired?.[REF]).toEqual(first);

  const legacy = structuredClone(first);
  legacy.q.value.repair.reason = "base-shape-mismatch";
  expect(await port.replaceReceipt!({ expected: await port.read(), prior: first, next: legacy })).toBe("accepted");
  saved = (await loadRawState(root))!.repoRecords!.repo!;
  expect(parsePRepairReceipt(saved.partial!.pRepaired![REF]!).q.value.repair.reason).toBe("base-shape-mismatch");

  const second = receipt("2026-07-17T12:00:00.000Z");
  expect(await port.replaceReceipt!({ expected: await port.read(), prior: legacy, next: second })).toBe("accepted");
  saved = (await loadRawState(root))!.repoRecords!.repo!;
  expect(saved.base?.refs[REF]).toBe(NEXT);
  expect(saved.partial?.pRepaired?.[REF]).toEqual(second);
  expect(await port.compactReceipt!({ expected: await port.read(), receipt: second })).toBe("accepted");
  saved = (await loadRawState(root))!.repoRecords!.repo!;
  expect(saved.partial?.pRepaired).toBeUndefined();
  expect(saved.partial?.appliedRefs["refs/tags/keep"]).toEqual({ kind: "direct", oid: PRIOR });
});

/** Design 271 §2.1: the P-repair state port stays 2-valued. A record with no
 * serialized BASE is `rejected` here — the landing is the follow path's job. */
test("a record with no serialized BASE is still a plain CAS rejection, not a typed hold", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-p-repair-state-baseless-"));
  await fs.mkdir(path.join(root, ".rbox"));
  const state: SyncState = {
    stream: "stream", lastSyncedSequence: 1, lastSyncedManifest: { generatedAt: "", files: [] },
    stateNonce: "nonce", stateRevision: 0,
    repoRecords: { repo: { repoGen: 0, sourceSeq: 1 } },
  };
  await fs.writeFile(statePath(root), JSON.stringify(state));
  const port = createPRepairStatePort({ root, stream: "stream", relPath: "repo", repoKind: "dir", effectiveRefScope: "all", p });
  const before = await port.read();
  const only = receipt("2026-07-16T12:00:00.000Z");

  expect(await port.cas({
    expected: before,
    nextBaseOid: NEXT,
    receipt: only,
    lockedObservation: {
      liveOid: only.q.value.observed.liveOid,
      reflogSha256: only.reflog.sha256,
      artifactsValidated: true,
      keepRefsVerified: true,
    },
  })).toBe("rejected");
  expect((await loadRawState(root))!.repoRecords!.repo!.base).toBeUndefined();
});
