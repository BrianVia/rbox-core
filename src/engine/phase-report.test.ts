import { describe, expect, test } from "bun:test";
import { PhaseReport } from "./phase-report.js";

describe("PhaseReport", () => {
  test("accumulates ms + bytes + count per phase across repeated hits", async () => {
    const r = PhaseReport.push();
    await r.phase("encrypt", async () => {}, { count: 3, ciphertextBytes: 100, changedBytes: 100 });
    await r.phase("encrypt", async () => {}, { count: 2, ciphertextBytes: 50, changedBytes: 50 });
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
    }, { ciphertextBytes: 999 });
    r.record("upload", { wireBytes: 999 });

    expect(out).toBe("ok");
    expect(calls).toBe(1);
    const j = r.toJSON();
    expect(j.phases).toEqual({});
    expect(j.peakRssBytes).toBe(0);
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

  test("toJSON emits phases in stable order regardless of record order", () => {
    const r = PhaseReport.pull();
    r.record("apply", { count: 1 });
    r.record("download", { count: 1 });
    r.record("decrypt", { count: 1 });
    expect(Object.keys(r.toJSON().phases)).toEqual(["download", "decrypt", "apply"]);
  });
});
