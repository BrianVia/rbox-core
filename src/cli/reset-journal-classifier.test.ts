import { describe, expect, test } from "bun:test";
import {
  classifyResetPhysicalSignature,
  type ResetPhysicalObservation,
  type ResetPhysicalRowId,
} from "./reset-journal-classifier.js";

const p = (count: number, total = 2) => ({ kind: "prefix" as const, count, total });
const base: ResetPhysicalObservation = {
  phase: "prepared", active: "old", candidate: "absent", archive: "absent", marker: "absent",
  recoveryRefs: p(0), activeRefGroups: p(0),
};

const rows: Array<[ResetPhysicalRowId, ResetPhysicalObservation]> = [
  ["P0", base],
  ["P1", { ...base, candidate: "next" }],
  ["P2", { ...base, candidate: "next", archive: "old" }],
  ["P3.1", { ...base, candidate: "next", archive: "old", recoveryRefs: p(1) }],
  ["P3.2", { ...base, candidate: "next", archive: "old", recoveryRefs: p(2) }],
  ["R0", { ...base, phase: "ready", candidate: "next", archive: "old", recoveryRefs: p(2) }],
  ["R1", { ...base, phase: "ready", active: "next", candidate: "absent", archive: "old", recoveryRefs: p(2) }],
  ["R2", { ...base, phase: "ready", active: "next", candidate: "next", archive: "old", recoveryRefs: p(2) }],
  ["I0", { ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", recoveryRefs: p(2) }],
  ["I1", { ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", recoveryRefs: p(2) }],
  ["I2", { ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", marker: "next", recoveryRefs: p(2) }],
  ["I3.1", { ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", marker: "next", recoveryRefs: p(2), activeRefGroups: p(1) }],
  ["I3.2", { ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", marker: "next", recoveryRefs: p(2), activeRefGroups: p(2) }],
  ["Z0", { ...base, phase: "z-retired", active: "next", candidate: "absent", archive: "old", marker: "next", recoveryRefs: p(2), activeRefGroups: p(2) }],
];

describe("design 138 normative correlated reset rows", () => {
  test("every P/R/I/Z table row is admitted row-for-row", () => {
    for (const [id, observation] of rows) expect(classifyResetPhysicalSignature(observation)?.ids).toContain(id);
  });

  test("n=0 and m=0 collapse R0=Rn and A0=Am without inventing P3/I3 rows", () => {
    const empty = p(0, 0);
    expect(classifyResetPhysicalSignature({ ...base, candidate: "next", archive: "old", recoveryRefs: empty, activeRefGroups: empty })?.ids).toEqual(["P2"]);
    expect(classifyResetPhysicalSignature({ ...base, phase: "installed", active: "next", candidate: "absent", archive: "old", marker: "next", recoveryRefs: empty, activeRefGroups: empty })?.ids).toEqual(["I2"]);
  });

  test("every physical axis deviation is rejected instead of cross-product admitted", () => {
    const valid = rows.find(([id]) => id === "R0")![1];
    const deviations: ResetPhysicalObservation[] = [
      { ...valid, phase: "installed" },
      { ...valid, active: "absent" },
      { ...valid, active: "other" },
      { ...valid, candidate: "absent" },
      { ...valid, candidate: "other" },
      { ...valid, archive: "absent" },
      { ...valid, archive: "other" },
      { ...valid, marker: "next" },
      { ...valid, marker: "other" },
      { ...valid, recoveryRefs: p(1) },
      { ...valid, recoveryRefs: { kind: "other", count: 1, total: 2 } },
      { ...valid, activeRefGroups: p(1) },
      { ...valid, activeRefGroups: { kind: "other", count: 0, total: 2 } },
    ];
    for (const observation of deviations) expect(classifyResetPhysicalSignature(observation)).toBeUndefined();
  });

  test("same-stream wrong hash/nonce lands on other and is rejected", () => {
    expect(classifyResetPhysicalSignature({ ...base, active: "other" })).toBeUndefined();
    expect(classifyResetPhysicalSignature({ ...base, marker: "other" })).toBeUndefined();
  });

  test("prepared archive-present/candidate-absent and arbitrary ref bitmaps are never legal", () => {
    expect(classifyResetPhysicalSignature({ ...base, archive: "old" })).toBeUndefined();
    expect(classifyResetPhysicalSignature({ ...base, candidate: "next", archive: "old", recoveryRefs: { kind: "other", count: 1, total: 2 } })).toBeUndefined();
  });

  test("a common-directory group is indivisible", () => {
    const installed = rows.find(([id]) => id === "I2")![1];
    expect(classifyResetPhysicalSignature({ ...installed, activeRefGroups: { kind: "other", count: 1, total: 2 } })).toBeUndefined();
  });
});
