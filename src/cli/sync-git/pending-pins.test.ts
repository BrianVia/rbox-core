import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { GitSection } from "../../engine/types.js";
import { gitFingerprint, gitFingerprintRun } from "./fingerprint.js";
import { readAllRefs } from "./refs.js";
import {
  PENDING_NS,
  pendingPinScope,
  readPendingPins,
  reconcilePendingPins,
  writePendingPins,
} from "./pending-pins.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function repoWithCommits(count: number): Promise<{ root: string; oids: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pending-pins-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-q"]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  const oids: string[] = [];
  for (let i = 0; i < count; i++) {
    await fs.writeFile(path.join(root, "tracked"), `line ${i}\n`);
    await exec("git", ["-C", root, "add", "tracked"]);
    await exec("git", ["-C", root, "commit", "-qm", `commit ${i}`]);
    oids.push((await exec("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim());
  }
  return { root, oids };
}

const sectionFor = (refs: Record<string, string>, head = "ref: refs/heads/main"): GitSection => ({
  bundleSha: "0".repeat(64),
  bundleEncSha: "1".repeat(64),
  bundleCipherSize: 1,
  head,
  refs,
  refScope: "all",
  generatedAt: "2026-08-16T00:00:00.000Z",
});

const gitDirOf = (root: string): string => path.join(root, ".git");

test("pinned incoming tips are readable back under their own key", async () => {
  const { root, oids } = await repoWithCommits(2);
  const incoming = sectionFor({ "refs/heads/main": oids[1]! });
  await writePendingPins(root, "repos/app", "keyA", incoming);
  expect(await readPendingPins(root, "repos/app", "keyA")).toEqual([oids[1]!]);
});

test("a section naming an object this receiver never imported keeps the pins it can", async () => {
  const { root, oids } = await repoWithCommits(1);
  const absent = "9".repeat(40);
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]!, "refs/heads/other": absent }));
  expect(await readPendingPins(root, ".", "keyA")).toEqual([oids[0]!]);
});

test("reconciliation collects a pin the record never named — the crash between pin and record write", async () => {
  const { root, oids } = await repoWithCommits(2);
  // The crash window: the pin lands, the process dies before the record write, so
  // the repo's standing record still names the PREVIOUS incoming key.
  await writePendingPins(root, ".", "crashed-key", sectionFor({ "refs/heads/main": oids[1]! }));
  await writePendingPins(root, ".", "recorded-key", sectionFor({ "refs/heads/main": oids[0]! }));
  await reconcilePendingPins(root, gitDirOf(root), ".", "recorded-key");
  expect(await readPendingPins(root, ".", "crashed-key")).toEqual([]);
  expect(await readPendingPins(root, ".", "recorded-key")).toEqual([oids[0]!]);
});

test("reconciliation with no standing hold collects every pin", async () => {
  const { root, oids } = await repoWithCommits(1);
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  await reconcilePendingPins(root, gitDirOf(root), ".", undefined);
  expect(await readPendingPins(root, ".", "keyA")).toEqual([]);
});

test("reconciliation collects a pin a user's `git pack-refs` moved into packed-refs", async () => {
  const { root, oids } = await repoWithCommits(1);
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  await exec("git", ["-C", root, "pack-refs", "--all"]);
  await reconcilePendingPins(root, gitDirOf(root), ".", undefined);
  expect(await readPendingPins(root, ".", "keyA")).toEqual([]);
});

test("one linked worktree's reconciliation never collects a sibling repo's live pin", async () => {
  const { root, oids } = await repoWithCommits(2);
  await writePendingPins(root, "repos/a", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  await writePendingPins(root, "repos/b", "keyB", sectionFor({ "refs/heads/main": oids[1]! }));
  expect(pendingPinScope("repos/a")).not.toBe(pendingPinScope("repos/b"));
  await reconcilePendingPins(root, gitDirOf(root), "repos/a", "keyA");
  expect(await readPendingPins(root, "repos/b", "keyB")).toEqual([oids[1]!]);
});

test("pins are invisible to the design-270 held-skip fingerprint, loose and packed", async () => {
  const { root, oids } = await repoWithCommits(1);
  const before = await gitFingerprint(gitFingerprintRun("per-decision"), root, ".");
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  expect((await gitFingerprint(gitFingerprintRun("per-decision"), root, ".")).hash).toBe(before.hash);
  await fs.appendFile(path.join(root, ".git", "packed-refs"), `${oids[0]!} ${PENDING_NS}/${pendingPinScope(".")}/keyA/9\n`);
  expect((await gitFingerprint(gitFingerprintRun("per-decision"), root, ".")).hash).toBe(before.hash);
});

test("pins never enter the syncable ref set a capture or quarantine bundle is built from", async () => {
  const { root, oids } = await repoWithCommits(1);
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  expect(Object.keys(await readAllRefs(root)).some((ref) => ref.startsWith(PENDING_NS))).toBe(false);
});

test("evidence survives a daemon restart: pins are durable refs, not process state", async () => {
  const { root, oids } = await repoWithCommits(1);
  await writePendingPins(root, ".", "keyA", sectionFor({ "refs/heads/main": oids[0]! }));
  // A restart re-reads from disk; `git gc` is the only thing that touches these,
  // and a reachable ref protects its objects from it outright.
  await exec("git", ["-C", root, "gc", "--prune=now", "-q"]);
  expect(await readPendingPins(root, ".", "keyA")).toEqual([oids[0]!]);
});
