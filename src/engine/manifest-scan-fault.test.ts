import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getuid } from "node:process";
import { hashFile, realHashFileForTests, overrideHashFileForTests } from "./hash.js";
import { applyWatchEvents, scanManifest } from "./manifest.js";
import { buildIgnoreMatcher } from "./ignore.js";

const faults = new Map<string, string>();
let resetHashFile: (() => void) | undefined;

beforeEach(() => {
  resetHashFile = overrideHashFileForTests(async (abs: string, size?: number): Promise<string> => {
    const code = faults.get(path.basename(abs));
    if (code) {
      faults.delete(path.basename(abs));
      throw Object.assign(new Error("injected hash fault"), { code });
    }
    return realHashFileForTests(abs, size);
  });
});
const asRoot = typeof getuid === "function" && getuid() === 0;

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scan-fault-"));
});
afterEach(async () => {
  resetHashFile?.();
  resetHashFile = undefined;
  faults.clear();
  await fs.chmod(path.join(root, "blocked.bin"), 0o600).catch(() => undefined);
  await fs.chmod(path.join(root, "locked"), 0o700).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
});

test("a deferrable per-file hash fault does not abort the scan", async () => {
  await fs.writeFile(path.join(root, "normal.txt"), "ok");
  await fs.writeFile(path.join(root, "unreadable.txt"), "secret");
  faults.set("unreadable.txt", "EACCES");
  const deferred = new Set<string>();
  const errnos: string[] = [];

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred, undefined, undefined, "unpruned", (code) => errnos.push(code));

  expect(deferred).toEqual(new Set(["unreadable.txt"]));
  expect(manifest.files.map((entry) => entry.path)).toEqual(["normal.txt"]);
  expect(errnos).toEqual(["EACCES"]);
});

test("a stale hash override reset cannot clear a newer fixture override", async () => {
  const staleReset = resetHashFile!;
  const sameOverride = async () => "newer";
  const supersededReset = overrideHashFileForTests(sameOverride);
  const currentReset = overrideHashFileForTests(sameOverride);
  staleReset();
  supersededReset();
  expect(await hashFile(path.join(root, "does-not-need-to-exist"))).toBe("newer");
  currentReset();
  resetHashFile = undefined;
});

test("a non-deferrable per-file hash fault still fails the scan loudly", async () => {
  await fs.writeFile(path.join(root, "fatal.txt"), "fatal");
  faults.set("fatal.txt", "EMFILE");
  await expect(scanManifest(root)).rejects.toMatchObject({ code: "EMFILE" });
});

test.skipIf(asRoot)("mode-000 file defers and the scan completes", async () => {
  await fs.writeFile(path.join(root, "blocked.bin"), "blocked");
  await fs.writeFile(path.join(root, "normal.txt"), "ok");
  await fs.chmod(path.join(root, "blocked.bin"), 0o000);
  const deferred = new Set<string>();

  const manifest = await scanManifest(root, undefined, undefined, undefined, undefined, undefined, deferred);

  expect(deferred).toContain("blocked.bin");
  expect(manifest.files.map((entry) => entry.path)).toEqual(["normal.txt"]);
});

test.skipIf(asRoot)("mode-000 directory fails the scan loudly", async () => {
  const locked = path.join(root, "locked");
  await fs.mkdir(locked);
  await fs.writeFile(path.join(locked, "inner.txt"), "inner");
  await fs.chmod(locked, 0o000);
  try {
    await expect(scanManifest(root)).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await fs.chmod(locked, 0o700);
  }
});

test("stale unlink keeps a present file when hashing faults", async () => {
  await fs.writeFile(path.join(root, "present.txt"), "present");
  const matcher = buildIgnoreMatcher(root);
  const base = await scanManifest(root, matcher);
  faults.set("present.txt", "EACCES");
  const deferred = new Set<string>();

  const manifest = await applyWatchEvents(base, root, matcher, [{ relPath: "present.txt", kind: "unlink" }], undefined, deferred);

  expect(deferred).toContain("present.txt");
  expect(manifest.files.map((entry) => entry.path)).toEqual(["present.txt"]);
});
