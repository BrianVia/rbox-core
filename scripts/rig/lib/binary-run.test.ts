import { expect, test } from "bun:test";
import { binaryGuardReport, binaryVersionGuardError } from "./binary-run.js";
import type { RigBinaryArtifact, RigBinaryIdentity } from "./binary.js";

const artifact = (sha256: string): RigBinaryArtifact => ({ mode: "compiled", sha256 });
const identity = (device: "A" | "B", version: string, versionExitCode = 0): RigBinaryIdentity => ({
  device,
  mode: "compiled",
  sha256: device.repeat(64),
  version,
  versionExitCode,
});

test("equal differential versions produce a persisted-identity FAIL envelope", () => {
  const binaries: [RigBinaryIdentity, RigBinaryIdentity] = [identity("A", "2.0.0"), identity("B", "2.0.0")];
  const error = binaryVersionGuardError({ a: artifact("a"), b: artifact("b") }, binaries);
  expect(error).toContain("distinct");
  const report = binaryGuardReport("future-dual", binaries, error!, "2026-07-28T00:00:00.000Z");
  expect(report.verdict).toBe("FAIL");
  expect(report.steps[0]?.name).toBe("dual-binary version identity");
  expect(report.binaries).toEqual(binaries);
});

test("same content needs no differential version guard", () => {
  const binaries: [RigBinaryIdentity, RigBinaryIdentity] = [identity("A", "2.0.0"), identity("B", "2.0.0")];
  expect(binaryVersionGuardError({ a: artifact("same"), b: artifact("same") }, binaries)).toBeUndefined();
});
