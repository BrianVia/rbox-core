import { expect, test } from "bun:test";
import type { GitSection } from "../../engine/index.js";
import { buildTombstoneAttestations, checkTombstoneAttestation, type BranchArtifactDisposition } from "./tombstone-attestation.js";

const T = "1".repeat(40);
const L = "a".repeat(64);
const ref = "refs/heads/topic";
const key = "incoming-key";

const section = (): GitSection => ({
  bundleSha: "b".repeat(64), bundleEncSha: "c".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main", refs: { "refs/heads/main": "2".repeat(40) },
  refScope: "all", generatedAt: "2026-07-16T12:00:00.000Z",
  refTombstones: { [ref]: [{ oid: T, ts: "2026-07-16T12:00:00.000Z", generation: 1 }] },
  refTombstoneGeneration: 1,
});

const clear: BranchArtifactDisposition = { absence: "absent", present: "absent", keeps: "clear", settledAbsence: "absent" };

function build(overrides: Partial<Parameters<typeof buildTombstoneAttestations>[0]> = {}) {
  return buildTombstoneAttestations({
    section: section(), incomingKey: key, lineageHash: L,
    liveRefs: { [ref]: T }, logicalBaseRefs: { [ref]: T },
    origins: { [ref]: { v: 1, oid: T, lineageHash: L, kind: "pull-p", episode: "e".repeat(32) } },
    artifacts: { [ref]: clear }, pendingEvidence: { [ref]: { incomingKey: key, d2Revalidated: true } },
    ...overrides,
  });
}

test("§130 prevalidation authorizes only exact live+tombstone+BASE+origin equality", () => {
  const map = build();
  expect(Object.isFrozen(map)).toBe(true);
  expect(Object.isFrozen(map.entries[ref]?.[T])).toBe(true);
  expect(checkTombstoneAttestation(map, { incomingKey: key, ref, oid: T, liveOid: T, logicalBaseOid: T }).status).toBe("authorized");

  expect(checkTombstoneAttestation(map, { incomingKey: "stale", ref, oid: T, liveOid: T, logicalBaseOid: T })).toEqual({
    status: "hard-veto", reason: "stale attestation map",
  });
  expect(checkTombstoneAttestation(map, { incomingKey: key, ref, oid: T, liveOid: "3".repeat(40), logicalBaseOid: T }).status).toBe("hard-veto");
  expect(checkTombstoneAttestation(map, { incomingKey: key, ref, oid: T, liveOid: T, logicalBaseOid: null }).status).toBe("hard-veto");
});

test("§130 origin, artifact, and D2 dispositions fail closed", () => {
  for (const map of [
    build({ origins: {} }),
    build({ origins: { [ref]: { v: 1, oid: T, lineageHash: "f".repeat(64), kind: "manual", episode: "e" } } }),
    build({ artifacts: { [ref]: { ...clear, absence: "valid-owning" } } }),
    build({ artifacts: { [ref]: { ...clear, present: "active-foreign" } } }),
    build({ artifacts: { [ref]: { ...clear, keeps: "orphan" } } }),
    build({ pendingEvidence: { [ref]: { incomingKey: key, d2Revalidated: false } } }),
  ]) {
    expect(checkTombstoneAttestation(map, { incomingKey: key, ref, oid: T, liveOid: T, logicalBaseOid: T }).status).toBe("hard-veto");
  }
});

test("§130 invalid wire creates no partial attestation and scoped sections create none", () => {
  const malformed = section();
  malformed.refTombstoneGeneration = 0;
  expect(() => build({ section: malformed })).toThrow(/before tombstone attestation/);
  const scoped = section();
  scoped.refScope = "scoped";
  expect(build({ section: scoped }).entries).toEqual({});
});

test("§130 capable→old→capable skew walk never revalidates positive BASE around A/Z", () => {
  const absenceShapes: Array<{ label: string; liveRefs: Record<string, string>; logicalBaseRefs: Record<string, string>; origins: Parameters<typeof buildTombstoneAttestations>[0]["origins"] }> = [
    { label: "old leaves R absent", liveRefs: {}, logicalBaseRefs: {}, origins: {} },
    { label: "old reapplies advertised T and rewrites BASE", liveRefs: { [ref]: T }, logicalBaseRefs: {}, origins: { [ref]: { v: 1, oid: T, lineageHash: L, kind: "publisher-ack", sourceSeq: 8, incomingKey: "old" } } },
    { label: "user recreates T while old state says positive", liveRefs: { [ref]: T }, logicalBaseRefs: {}, origins: { [ref]: { v: 1, oid: T, lineageHash: L, kind: "manual", episode: "8".repeat(32) } } },
  ];
  for (const shape of absenceShapes) {
    const map = buildTombstoneAttestations({
      section: section(), incomingKey: key, lineageHash: L,
      liveRefs: shape.liveRefs, logicalBaseRefs: shape.logicalBaseRefs,
      origins: shape.origins,
      artifacts: { [ref]: { ...clear, absence: "valid-owning" } },
      pendingEvidence: { [ref]: { incomingKey: key, d2Revalidated: true } },
    });
    expect(checkTombstoneAttestation(map, {
      incomingKey: key, ref, oid: T,
      liveOid: shape.liveRefs[ref] ?? null,
      logicalBaseOid: shape.logicalBaseRefs[ref] ?? null,
    }).status, shape.label).toBe("hard-veto");
  }

  // Old-field truncation only destroys authority: no chain means no attestation,
  // and a dropped origin remains a hard veto even after the chain returns.
  const oldWire = section();
  delete oldWire.refTombstones;
  delete oldWire.refTombstoneGeneration;
  expect(build({ section: oldWire }).entries).toEqual({});
  expect(checkTombstoneAttestation(build({ origins: {} }), {
    incomingKey: key, ref, oid: T, liveOid: T, logicalBaseOid: T,
  })).toEqual({ status: "hard-veto", reason: "positive BASE origin missing" });
});
