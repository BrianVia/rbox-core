import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDistinctBinaryVersions,
  assertDualBinaryAllowed,
  isMismatchedBinarySelection,
  makeRigBinaryIdentity,
  prepareRigBinarySelection,
  resolveRigBinaryPaths,
  rigGuestMounts,
  rigSourceCommit,
  sourceRigBinaryArtifact,
  stageRigBinaryOverride,
  type RigBinaryArtifact,
  type RigBinaryIdentity,
} from "./binary.js";
import { GUEST } from "./config.js";

function fakeFs(options: { file?: boolean; symlink?: boolean; canonical?: string; executable?: boolean } = {}) {
  return {
    lstatSync(file: string) {
      if (options.file === false) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isFile: () => true, isSymbolicLink: () => options.symlink === true };
    },
    accessSync() {
      if (options.executable === false) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
    realpathSync(file: string) {
      return options.canonical ?? file;
    },
  };
}

describe("rig --binary", () => {
  test("keeps --binary as shorthand and lets per-device flags override it", () => {
    expect(resolveRigBinaryPaths({}, fakeFs())).toEqual({ a: undefined, b: undefined });
    expect(resolveRigBinaryPaths({ binary: "/tmp/both" }, fakeFs())).toEqual({ a: "/tmp/both", b: "/tmp/both" });
    expect(resolveRigBinaryPaths({ binary: "/tmp/both", "binary-a": "/tmp/a" }, fakeFs())).toEqual({ a: "/tmp/a", b: "/tmp/both" });
    expect(resolveRigBinaryPaths({ binary: "/tmp/both", "binary-b": "/tmp/b" }, fakeFs())).toEqual({ a: "/tmp/both", b: "/tmp/b" });
  });

  test("validates every supplied path with its own flag name", () => {
    expect(() => resolveRigBinaryPaths({ binary: "dist/rbox" }, fakeFs())).toThrow("--binary must be an exact absolute");
    expect(() => resolveRigBinaryPaths({ "binary-a": "/tmp/../tmp/rbox" }, fakeFs())).toThrow("--binary-a must be an exact absolute");
    expect(() => resolveRigBinaryPaths({ "binary-b": "/tmp/rbox" }, fakeFs({ file: false }))).toThrow("--binary-b does not exist");
    expect(() => resolveRigBinaryPaths({ binary: "/tmp/rbox" }, fakeFs({ symlink: true }))).toThrow("non-symlink");
    expect(() => resolveRigBinaryPaths({ binary: "/tmp/rbox" }, fakeFs({ canonical: "/private/tmp/rbox" }))).toThrow("canonical");
    expect(() => resolveRigBinaryPaths({ binary: "/tmp/rbox" }, fakeFs({ executable: false }))).toThrow("executable");
  });

  test("checks execute access", () => {
    let mode = 0;
    resolveRigBinaryPaths({ binary: "/tmp/rbox" }, {
      ...fakeFs(),
      accessSync(_file, requested) { mode = requested; },
    });
    expect(mode).toBe(fs.constants.X_OK);
  });

  test("classifies mismatches and refuses unsupported scenarios", () => {
    const artifact = (sha256: string, hostPath?: string): RigBinaryArtifact => ({
      mode: "compiled",
      sha256,
      hostPath,
      stagedDirectory: `/stage/${sha256}`,
    });
    expect(isMismatchedBinarySelection({ a: artifact("same", "/tmp/a"), b: artifact("same", "/tmp/b") })).toBeFalse();
    const mismatched = { a: artifact("aaa", "/tmp/a"), b: artifact("bbb", "/tmp/b") };
    expect(isMismatchedBinarySelection(mismatched)).toBeTrue();
    expect(() => assertDualBinaryAllowed(mismatched, "same-only", false)).toThrow("does not declare dual-binary support");
    expect(() => assertDualBinaryAllowed(mismatched, "dual", true)).not.toThrow();
  });

  test("requires distinct successful version probes for a mismatched run", () => {
    const identity = (device: "A" | "B", version: string, versionExitCode = 0): RigBinaryIdentity => ({
      device,
      mode: "compiled",
      hostPath: `/tmp/${device.toLowerCase()}`,
      sha256: device.repeat(64),
      version,
      versionExitCode,
    });
    const selection = {
      a: { mode: "compiled", sha256: "a", hostPath: "/tmp/a" },
      b: { mode: "compiled", sha256: "b", hostPath: "/tmp/b" },
    } satisfies { a: RigBinaryArtifact; b: RigBinaryArtifact };
    expect(() => assertDistinctBinaryVersions(selection, [identity("A", "rbox 1.11.0"), identity("B", "rbox 2.0.0")])).not.toThrow();
    expect(() => assertDistinctBinaryVersions(selection, [identity("A", "rbox 2.0.0"), identity("B", "rbox 2.0.0")])).toThrow("distinct");
    expect(() => assertDistinctBinaryVersions(selection, [identity("A", "failed", 1), identity("B", "rbox 2.0.0")])).toThrow("probe failed");
    expect(() => assertDistinctBinaryVersions({ a: selection.a, b: selection.a }, [identity("A", "same"), identity("B", "same")])).not.toThrow();
  });

  test("mounts the staged single-file candidate directory after checkout mounts", () => {
    expect(rigGuestMounts("/repo")).toEqual([
      { source: "/repo/src", target: GUEST.srcMount, readonly: true },
      { source: "/repo/scripts", target: GUEST.scriptsMount, readonly: true },
    ]);
    expect(rigGuestMounts("/repo", "/artifacts/staged")).toEqual([
      { source: "/repo/src", target: GUEST.srcMount, readonly: true },
      { source: "/repo/scripts", target: GUEST.scriptsMount, readonly: true },
      { source: "/artifacts/staged", target: "/opt/rbox/bin", readonly: true },
    ]);
  });

  test("stages different device bytes into different content-addressed mounts without Docker", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-rig-binary-test-"));
    try {
      for (const relative of ["src", "patches", "scripts/rig"]) fs.mkdirSync(path.join(root, relative), { recursive: true });
      for (const relative of ["src/cli.ts", "package.json", "bun.lock", "patches/p.patch", "scripts/rig/Dockerfile"]) {
        fs.writeFileSync(path.join(root, relative), relative);
      }
      const a = path.join(root, "rbox-a");
      const b = path.join(root, "rbox-b");
      fs.writeFileSync(a, "binary-a", { mode: 0o755 });
      fs.writeFileSync(b, "binary-b", { mode: 0o755 });
      const selection = prepareRigBinarySelection({ a, b }, root);
      expect(selection.a.sha256).not.toBe(selection.b.sha256);
      expect(selection.a.stagedDirectory).not.toBe(selection.b.stagedDirectory);
      expect(rigGuestMounts(root, selection.a.stagedDirectory).at(-1)?.source).toBe(selection.a.stagedDirectory);
      expect(rigGuestMounts(root, selection.b.stagedDirectory).at(-1)?.source).toBe(selection.b.stagedDirectory);

      fs.writeFileSync(b, "binary-a", { mode: 0o755 });
      const sameBytes = prepareRigBinarySelection({ a, b }, root);
      expect(isMismatchedBinarySelection(sameBytes)).toBeFalse();
      expect(sameBytes.a.stagedDirectory).toBe(sameBytes.b.stagedDirectory);

      const before = sourceRigBinaryArtifact(root).sha256;
      fs.writeFileSync(path.join(root, "src/cli.ts"), "changed");
      expect(sourceRigBinaryArtifact(root).sha256).not.toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a poisoned content-addressed staging cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-rig-cache-test-"));
    let stagedDirectory: string | undefined;
    try {
      const binary = path.join(root, "rbox");
      fs.writeFileSync(binary, `unique-${path.basename(root)}`, { mode: 0o755 });
      const artifact = stageRigBinaryOverride(binary);
      stagedDirectory = artifact.stagedDirectory;
      fs.writeFileSync(path.join(stagedDirectory!, "rbox"), "corrupt", { mode: 0o755 });
      expect(() => stageRigBinaryOverride(binary)).toThrow("cache is corrupt");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (stagedDirectory) fs.rmSync(stagedDirectory, { recursive: true, force: true });
    }
  });
});

test("source artifacts carry the checkout commit and dirty flag", () => {
  const calls: string[][] = [];
  const git = (args: readonly string[]) => {
    calls.push([...args]);
    return args[0] === "rev-parse" ? `${"c".repeat(40)}\n` : " M src/cli.ts\n";
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-rig-commit-test-"));
  try {
    for (const relative of ["src", "patches", "scripts/rig"]) fs.mkdirSync(path.join(root, relative), { recursive: true });
    for (const relative of ["package.json", "bun.lock", "scripts/rig/Dockerfile"]) fs.writeFileSync(path.join(root, relative), relative);
    const artifact = sourceRigBinaryArtifact(root, git);
    expect(artifact.source).toEqual({ commit: "c".repeat(40), dirty: true });
    expect(calls).toEqual([["rev-parse", "HEAD"], ["status", "--porcelain"]]);
    expect(makeRigBinaryIdentity("A", artifact, "rbox 1.0.0", 0).source).toEqual(artifact.source);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a non-git checkout reports no commit instead of throwing", () => {
  expect(rigSourceCommit("/nonexistent", () => { throw new Error("not a repository"); })).toBeUndefined();
  expect(rigSourceCommit("/nonexistent", () => "not-a-sha\n")).toBeUndefined();
});
