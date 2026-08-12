import { describe, expect, test } from "bun:test";
import { PhaseReport } from "./phase-report.js";
import {
  beginFirstPublishTiming,
  finishFirstPublishStats,
  firstPublishAuthDispatchStart,
  firstPublishAuthSettle,
  firstPublishReady,
  firstPublishTiming,
  firstPublishUploadEnd,
  firstPublishUploadStart,
  formatFirstPublishStats,
} from "../cli/upload-lane-timing.js";

describe("PhaseReport", () => {
  test("accumulates ms + bytes + count per phase across repeated hits", async () => {
    const r = PhaseReport.push();
    await r.phase("encrypt", async () => {});
    r.record("encrypt", { count: 3, ciphertextBytes: 100, changedBytes: 100 });
    await r.phase("encrypt", async () => {});
    r.record("encrypt", { count: 2, ciphertextBytes: 50, changedBytes: 50 });
    r.record("upload", { count: 5, wireBytes: 150 });

    const j = r.toJSON();
    expect(j.phases.encrypt).toMatchObject({ count: 5, ciphertextBytes: 150, changedBytes: 150 });
    expect(j.phases.encrypt!.ms).toBeGreaterThanOrEqual(0);
    expect(j.phases.upload).toMatchObject({ count: 5, wireBytes: 150, ms: 0 });
  });

  test("phase() returns fn's value and runs it exactly once", async () => {
    const r = PhaseReport.pull();
    let calls = 0;
    const out = await r.phase("download", async () => {
      calls++;
      return 42;
    });
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  test("a disabled report is transparent: runs work, records nothing", async () => {
    const r = PhaseReport.disabled("push");
    let calls = 0;
    const out = await r.phase("encrypt", async () => {
      calls++;
      return "ok";
    });
    r.record("encrypt", { ciphertextBytes: 999 });
    r.record("upload", { wireBytes: 999 });

    expect(out).toBe("ok");
    expect(calls).toBe(1);
    const j = r.toJSON();
    expect(j.phases).toEqual({});
    expect(j.peakRssBytes).toBe(0);
  });

  test("logSummaryTo emits only when a phase was recorded", () => {
    const lines: string[] = [];

    // enabled but nothing recorded → no emit (the no-op-tick guarantee)
    PhaseReport.push().logSummaryTo((l) => lines.push(l));
    expect(lines).toEqual([]);

    // enabled + recorded → one line
    const r = PhaseReport.push();
    r.record("scan", { count: 1 });
    r.logSummaryTo((l) => lines.push(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("rbox push");

    // disabled records nothing → no emit even after a record() call
    const off = PhaseReport.disabled("push");
    off.record("scan", { count: 1 });
    off.logSummaryTo((l) => lines.push(l));
    expect(lines.length).toBe(1);
  });

  test("summary line sums each basis across phases and carries no PII", async () => {
    const r = PhaseReport.push();
    r.files = 65421;
    r.blobs = 11925;
    // ciphertext attributed to encrypt, wire to upload — run total is the cross-phase sum.
    r.record("scan", { plaintextBytes: 3_000_000_000 });
    r.record("encrypt", { ciphertextBytes: 2_680_000_000, changedBytes: 2_680_000_000 });
    r.record("upload", { wireBytes: 2_680_000_000 });
    r.record("commit", {});

    const line = r.summaryLine();
    expect(line).toContain("rbox push files=65421 blobs=11925");
    expect(line).toContain("ct=2.68GB");
    expect(line).toContain("wire=2.68GB");
    expect(line).toContain("changed=2.68GB");
    // phase names present, in stable order (scan before encrypt before upload before commit)
    expect(line).toMatch(/scan .*encrypt .*upload .*commit/);
    // nothing that could leak identity: no slashes (paths), no 64-hex (sha), no acct_ id
    expect(line).not.toMatch(/[a-f0-9]{64}/);
    expect(line).not.toContain("/");
    expect(line).not.toContain("acct_");
  });

  test("phase details are emitted in JSON and appended to the summary line", () => {
    const r = PhaseReport.pull();
    r.record("git-apply", { count: 2 });
    r.recordDetails("git-apply", { gitApply: { repos: 2, commonDirGroups: 1 } }, "repos=2 commonDirs=1 repoMs=i0q0w1u,i1q1w1a");

    const j = r.toJSON();
    expect(j.phases["git-apply"]).toMatchObject({ count: 2, details: { gitApply: { repos: 2, commonDirGroups: 1 } } });
    const line = r.summaryLine();
    expect(line).toContain("git-apply");
    expect(line).toContain("repos=2 commonDirs=1");
    expect(line).toContain("repoMs=i0q0w1u,i1q1w1a");
  });

  test("toJSON emits phases in stable order regardless of record order", () => {
    const r = PhaseReport.pull();
    r.record("git-apply", { count: 1 });
    r.record("reconcile", { count: 1 });
    r.record("validate", { count: 1 });
    r.record("apply", { count: 1 });
    r.record("download", { count: 1 });
    r.record("decrypt", { count: 1 });
    expect(Object.keys(r.toJSON().phases)).toEqual(["validate", "reconcile", "download", "decrypt", "apply", "git-apply"]);
  });
});

describe("FirstPublishStats", () => {
  test("has a complete integer-only schema and a privacy-safe token", () => {
    beginFirstPublishTiming(true);
    firstPublishReady(123, "a".repeat(64));
    firstPublishUploadStart();
    firstPublishAuthSettle(firstPublishAuthDispatchStart(), "bearer");
    firstPublishUploadEnd();
    firstPublishTiming.stats.encryptWallMs = 2;
    firstPublishTiming.stats.missingCheckWallMs = 3;
    firstPublishTiming.stats.receiptRedemptionWallMs = 4;
    firstPublishTiming.stats.commitWallMs = 5;
    const stats = finishFirstPublishStats()!;
    expect(Object.keys(stats).sort()).toEqual([
      "authCallCount", "authCriticalPathMs", "commitWallMs", "duplicateEncryptions",
      "encryptWallMs", "finalDrainMs", "finalFlushMs", "firstReadyToFirstUploadStartMs", "missingCheckWallMs",
      "peakQueueHeapBytes", "peakTempDiskBytes", "peakUploaderFramingBytes",
      "producerCpuSaturationPct", "reEncryptedOnResume", "receiptRedemptionOverlapMs",
      "receiptRedemptionWallMs", "redeemMaxEntryBytes", "redeemMaxRequestBytes",
      "redeemReceiptCount", "redeemRequestCount", "serverSatisfiedSkipped", "serverUnsatisfiedTotal",
      "timeToFilesSyncedMs", "timeToFirstReadyCiphertextMs", "uniqueEncryptions", "uploadCriticalPathMs",
    ]);
    expect(Object.values(stats).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
    expect(stats.encryptWallMs + stats.missingCheckWallMs + stats.receiptRedemptionWallMs + stats.commitWallMs).toBe(14);
    const token = formatFirstPublishStats(stats);
    expect(token).not.toContain("/");
    expect(token).not.toMatch(/[a-f0-9]{64}/i);
  });

  test("disabled measurement emits nothing", () => {
    beginFirstPublishTiming(false);
    firstPublishReady(123, "b".repeat(64));
    firstPublishUploadStart();
    firstPublishUploadEnd();
    expect(finishFirstPublishStats()).toBeUndefined();
  });

  test("a dispatch started while disabled cannot settle into a later measurement", () => {
    beginFirstPublishTiming(false);
    const start = firstPublishAuthDispatchStart();
    beginFirstPublishTiming(true);
    firstPublishUploadStart();
    firstPublishAuthSettle(start, "bearer");
    firstPublishUploadEnd();
    const stats = finishFirstPublishStats()!;
    expect(stats.authCallCount).toBe(0);
    expect(stats.authCriticalPathMs).toBe(0);
  });

  test("a second concurrent measurement voids BOTH (ownership invariant, design 108)", () => {
    beginFirstPublishTiming(true);
    expect(firstPublishTiming.enabled).toBe(true);
    beginFirstPublishTiming(true); // overlap: never cross-attribute — void both
    expect(firstPublishTiming.enabled).toBe(false);
    expect(finishFirstPublishStats()).toBeUndefined();
    // A fresh, non-overlapping measurement still arms normally afterwards.
    beginFirstPublishTiming(true);
    expect(firstPublishTiming.enabled).toBe(true);
    beginFirstPublishTiming(false);
  });
});
