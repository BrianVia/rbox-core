import { expect, test } from "bun:test";
import { canonicalize } from "../../engine/e2ee/jcs.js";
import { hashBytes } from "../../engine/hash.js";
import {
  MAX_P_REPAIR_Q_BYTES,
  buildPRepairQ,
  byteProjection,
  pRepairBaseDisposition,
  pRepairReason,
  pRepairRetryAction,
  pRepairEviction,
  parsePRepairQ,
  skeepHash,
} from "./p-repair.js";

const L = "1".repeat(64);
const I = "2".repeat(64);
const A = "a".repeat(40);
const B = "b".repeat(40);
const U = "c".repeat(40);
const E = "d".repeat(32);

const input = () => ({
  lineageHash: L, repositoryIdentityHash: I,
  artifactRef: "r".repeat(384), artifactOid: A,
  pPayload: { v: 2 as const, lineageHash: L, repositoryIdentityHash: I, ref: "refs/heads/" + "x".repeat(4_096), episode: E, priorOid: A, nextOid: B },
  payloadBytes: Buffer.from("p".repeat(9_000)),
  observed: {
    liveOid: U, baseOid: A, repoGen: Number.MAX_SAFE_INTEGER, stateRevision: Number.MAX_SAFE_INTEGER,
    incomingKey: "incoming", reflogBytes: Buffer.from(Array.from({ length: 9_000 }, (_, i) => i & 0xff)),
    reflogEntries: 42, reflogTop: Buffer.from(Array.from({ length: 8_000 }, (_, i) => 255 - (i & 0xff))),
  },
  skeep: [U, A, B, U], at: "2026-07-16T12:00:00.000Z",
  mismatches: { live: true, reflog: true, baseRefs: false },
});

test("§130 maximal Q projections retain full counts/hashes and remain below 8,192 bytes", () => {
  const built = buildPRepairQ(input());
  expect(built.bytes.byteLength).toBeLessThanOrEqual(MAX_P_REPAIR_Q_BYTES);
  expect(built.value.p.artifactRef).toEqual(byteProjection("r".repeat(384), 384));
  expect(built.value.p.payload.ref.bytes).toBe(Buffer.byteLength(input().pPayload.ref));
  expect(Buffer.from(built.value.p.payload.ref.prefixB64, "base64").byteLength).toBe(768);
  expect(built.value.p.payload.ref.truncated).toBe(true);
  expect(built.value.observed.reflog.sha256).toBe(hashBytes(input().observed.reflogBytes));
  expect(Buffer.from(built.value.observed.reflog.top!.prefixB64, "base64").byteLength).toBe(2_048);
  expect(built.value.p.payloadSha256).toBe(hashBytes(input().payloadBytes));
  expect(built.value.preserved).toEqual({ count: 3, oidsSha256: skeepHash([A, B, U]).oidsSha256 });
  expect(parsePRepairQ(built.bytes)).toEqual(built.value);
});

test("§130 repair reason and BASE disposition tables are total and ordered", () => {
  expect(pRepairReason({ live: true, reflog: true, baseRefs: true })).toBe("base-refs-mismatch");
  expect(pRepairReason({ live: true, reflog: true, baseRefs: false })).toBe("live-mismatch");
  expect(pRepairReason({ live: false, reflog: true, baseRefs: false })).toBe("reflog-mismatch");
  expect(() => pRepairReason({ live: false, reflog: false, baseRefs: false })).toThrow();
  expect(pRepairBaseDisposition(A, B, A)).toBe("advance-prior-to-next");
  expect(pRepairBaseDisposition(A, B, B)).toBe("already-next");
  expect(pRepairBaseDisposition(A, B, null)).toBe("preserve-absent");
  expect(pRepairBaseDisposition(A, B, U)).toBe("preserve-third");
  expect(pRepairBaseDisposition(null, B, null)).toBe("advance-prior-to-next");
});

test("§130 byte projections operate on arbitrary bytes, not JSON text", () => {
  const raw = Buffer.from([0, 255, 34, 92, 10, 128]);
  expect(byteProjection(raw, 4)).toEqual({
    bytes: 6, sha256: hashBytes(raw), prefixB64: raw.subarray(0, 4).toString("base64"), truncated: true,
  });
});

test("§130 Q parser rejects unknown fields and projection lies", () => {
  const built = buildPRepairQ(input());
  const withUnknown = { ...built.value, unknown: true };
  expect(() => parsePRepairQ(Buffer.from(JSON.stringify(withUnknown)))).toThrow();
  const badProjection = structuredClone(built.value);
  badProjection.p.payload.ref.truncated = false;
  expect(() => parsePRepairQ(Buffer.from(JSON.stringify(badProjection)))).toThrow();
});

test("legacy base-shape-mismatch Q bytes parse without normalization", () => {
  const legacy = structuredClone(buildPRepairQ(input()).value);
  legacy.repair.reason = "base-shape-mismatch";
  const bytes = canonicalize(legacy);
  const parsed = parsePRepairQ(bytes);
  expect(parsed.repair.reason).toBe("base-shape-mismatch");
  expect(canonicalize(parsed)).toEqual(bytes);
});

test("§130 retry matrix is closed over every specified durable shape", () => {
  const base = {
    receipt: "matching" as const, p: "exact" as const, k: "exact" as const, q: "absent" as const,
    keepRefsExact: true, originSetHashMatches: true, liveReflogMatchesReceipt: true,
    eviction: "null" as const,
  };
  const rows: Array<[Parameters<typeof pRepairRetryAction>[0], ReturnType<typeof pRepairRetryAction>]> = [
    [{ ...base, receipt: "absent" }, "recompute"],
    [base, "resume-ref-commit"],
    [{ ...base, liveReflogMatchesReceipt: false }, "refresh-receipt"],
    [{ ...base, p: "absent", k: "absent", q: "exact", eviction: "absent" }, "compact-and-restart"],
    [{ ...base, receipt: "absent", p: "absent", k: "absent", q: "exact", eviction: "absent" }, "restore-terminal-bookkeeping"],
    [{ ...base, receipt: "absent", p: "absent", k: "absent", q: "absent" }, "corruption-hold"],
    [{ ...base, receipt: "wrong" }, "artifact-contradiction-hold"],
    [{ ...base, q: "exact" }, "artifact-contradiction-hold"],
    [{ ...base, originSetHashMatches: false }, "artifact-contradiction-hold"],
    [{ ...base, eviction: "mixed-or-wrong" }, "artifact-contradiction-hold"],
  ];
  for (const [observation, expected] of rows) expect(pRepairRetryAction(observation)).toBe(expected);
});

test("§130 retry matrix exhaustively classifies the complete bounded Cartesian product", () => {
  const receipts = ["absent", "matching", "wrong"] as const;
  const ps = ["exact", "absent", "wrong"] as const;
  const ks = ["exact", "absent", "partial-or-wrong"] as const;
  const qs = ["absent", "exact", "wrong"] as const;
  const booleans = [false, true] as const;
  const evictions = ["null", "present-exact", "absent", "mixed-or-wrong"] as const;
  const actions = new Set([
    "recompute", "resume-ref-commit", "refresh-receipt", "compact-and-restart",
    "restore-terminal-bookkeeping", "corruption-hold", "artifact-contradiction-hold",
  ] as const);
  let rows = 0;
  for (const receipt of receipts) for (const p of ps) for (const k of ks) for (const q of qs)
    for (const keepRefsExact of booleans) for (const originSetHashMatches of booleans)
      for (const liveReflogMatchesReceipt of booleans) for (const eviction of evictions) {
        const action = pRepairRetryAction({
          receipt, p, k, q, keepRefsExact, originSetHashMatches, liveReflogMatchesReceipt, eviction,
        });
        expect(actions.has(action)).toBe(true);
        rows++;
      }
  expect(rows).toBe(2_592);
});

test("§130 Q cap freezes oldest (repair.at, refname) expected-target victim", () => {
  const value = buildPRepairQ(input()).value;
  const entries = Array.from({ length: 256 }, (_, index) => ({
    ref: `refs/rbox-recovery/base-present/v2/${L}/${String(index).padStart(64, "0")}/${E}`,
    targetOid: index.toString(16).padStart(40, "0"),
    value: { ...value, repair: { ...value.repair, at: index < 2 ? "2026-07-01T00:00:00.000Z" : "2026-07-02T00:00:00.000Z" } },
  }));
  expect(pRepairEviction(L, "refs/rbox-recovery/base-present/v2/new", entries)).toEqual({
    qRef: entries[0]!.ref,
    targetOid: entries[0]!.targetOid,
  });
  expect(pRepairEviction(L, "refs/rbox-recovery/base-present/v2/new", entries.slice(0, 255))).toBeNull();
});
