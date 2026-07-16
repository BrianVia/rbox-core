import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore } from "../blobstore.js";
import { decryptFileToPath } from "../crypto.js";
import { captureGitState } from "./capture.js";
import { gitIdentity } from "./identity.js";
import {
  expireTombstonePinOrigins,
  expireTombstoneKeepPins,
  parseKeepPinOrigins,
  pinRepairObjectsFirst,
  mergeRepairOrigins,
  prepareRepairOriginCleanup,
  rewriteKeepPinOrigins,
  runUpdateRefTransaction,
  pinDisplaced,
  prepareDisplacedRefPins,
  prepareKeepPins,
  prepareTombstonePrunePins,
  verifyPreparedTombstoneFingerprint,
  withPreparedTombstonePrunePins,
  readRefReflogFingerprint,
  runPreparedUpdateRefTransaction,
  TOMBSTONE_PIN_RETENTION_MS,
  type KeepPinOrigins,
} from "./keep-pins.js";
import { setProtocolLockTraceForTests, withRepoOperationLock, type ProtocolLockTraceEvent } from "./protocol-locks.js";
import { isSyncableRef } from "../manifest-validate.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const runGit = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 116);

let tmp: string;
let repo: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-d116-keep-pins-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await runGit(repo, "init", "-qb", "main");
  await runGit(repo, "config", "user.email", "test@example.com");
  await runGit(repo, "config", "user.name", "Test User");
});

afterEach(async () => {
  setProtocolLockTraceForTests(undefined);
  // All git/capture subprocesses are awaited before bounded fixture teardown.
  await fs.rm(tmp, { recursive: true, force: true });
});

test("§130 shared-origin sidecar refuses symlinks without touching their target", async () => {
  const oid = await commit("symlink.txt", "symlink\n");
  const target = path.join(tmp, "outside-origins.json");
  const initial = `${JSON.stringify({ sentinel: true })}\n`;
  await fs.writeFile(target, initial);
  await fs.symlink(target, path.join(repo, ".git", "rbox-keep-origins.json"));
  await expect(prepareKeepPins(repo, [oid], {
    ref: "refs/heads/main", episode: "symlink", time: "2026-07-16T12:00:00.000Z", class: "human",
  })).rejects.toThrow();
  expect(await fs.readFile(target, "utf8")).toBe(initial);
});

test("§130 reflog fingerprint refuses a symlinked maintenance target", async () => {
  await commit("reflog-symlink.txt", "tip\n");
  const reflog = path.join(repo, ".git", "logs", "refs", "heads", "main");
  const target = path.join(tmp, "outside-reflog");
  await fs.writeFile(target, await fs.readFile(reflog));
  await fs.rm(reflog);
  await fs.symlink(target, reflog);
  await expect(readRefReflogFingerprint(repo, "refs/heads/main")).rejects.toThrow();
});

test("§130 origin lock prevents lost updates across a held common-dir operation", async () => {
  const first = await commit("concurrent-a.txt", "a\n");
  const second = await commit("concurrent-b.txt", "b\n");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const holder = withRepoOperationLock(repo, async () => { entered(); await gate; });
  await acquired;
  await expect(prepareKeepPins(repo, [first], {
    ref: "refs/heads/a", episode: "a", time: "2026-07-16T12:00:00.000Z", class: "human",
  })).rejects.toThrow(/protocol lock held/);
  release();
  await holder;
  await prepareKeepPins(repo, [first], {
    ref: "refs/heads/a", episode: "a", time: "2026-07-16T12:00:00.000Z", class: "human",
  });
  await rewriteKeepPinOrigins(repo, (origins) => {
    origins[second] = [{ ref: "refs/heads/b", episode: "b", time: "2026-07-16T12:00:00.000Z", class: "human" }];
  });
  const origins = parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(Object.keys(origins).sort()).toEqual([first, second].sort());
});

async function commit(name: string, contents: string): Promise<string> {
  await fs.writeFile(path.join(repo, name), contents);
  await runGit(repo, "add", name);
  await runGit(repo, "commit", "-qm", `${name}:${contents}`);
  return runGit(repo, "rev-parse", "HEAD");
}

async function refExists(ref: string): Promise<boolean> {
  return exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", ref], { env: TEST_GIT_ENV }).then(() => true, () => false);
}

test("content-addressed pins are create-only, idempotent, and preserve promoted human provenance", async () => {
  const oid = await commit("one.txt", "one\n");
  const tracking = { ref: "refs/remotes/origin/main", episode: "episode-1", time: "2026-07-13T10:00:00.000Z", class: "tracking" as const };
  const first = await pinDisplaced(repo, [oid, oid], tracking);
  expect(first.oids).toEqual([oid]);
  expect(first.transactionLines).toEqual([`create refs/rbox-local/keep/${oid} ${oid}`]);
  expect(await refExists(`refs/rbox-local/keep/${oid}`)).toBe(true);
  expect(await runGit(repo, "show-ref", "--hash", `refs/rbox-local/keep/${oid}`)).toBe(oid);

  const repeated = await pinDisplaced(repo, [oid], tracking);
  expect(repeated.transactionLines).toEqual([]);

  // r4 F3: prepare persists human provenance before returning any ref transaction
  // lines. At this point the second pin ref deliberately does not exist yet.
  const humanOid = await commit("two.txt", "two\n");
  const human = { ref: "refs/heads/main", episode: "episode-2", time: "2026-07-13T11:00:00.000Z", class: "human" as const };
  const prepared = await prepareKeepPins(repo, [humanOid], human);
  expect(await refExists(`refs/rbox-local/keep/${humanOid}`)).toBe(false);
  const beforeCommit = JSON.parse(await fs.readFile(prepared.sidecarPath, "utf8")) as KeepPinOrigins;
  expect(beforeCommit[humanOid]).toEqual([human]);
  expect(prepared.transactionLines).toEqual([`create refs/rbox-local/keep/${humanOid} ${humanOid}`]);

  // Promotion of an existing origin is monotonic: a later tracking observation
  // cannot demote an OID once human provenance has been durably recorded (r3 F7).
  await prepareKeepPins(repo, [oid], { ...tracking, class: "human" });
  await prepareKeepPins(repo, [oid], tracking);
  const promoted = JSON.parse(await fs.readFile(prepared.sidecarPath, "utf8")) as KeepPinOrigins;
  expect(promoted[oid]).toEqual([{ ...tracking, class: "human" }]);
});

test("§130 tombstone preservation ages only the authorized tip and keeps reflog-only work human", async () => {
  const tip = await commit("tip.txt", "tip\n");
  const reflogOnly = await commit("tip.txt", "reflog-only\n");
  await runGit(repo, "reset", "--hard", tip);
  const time = "2026-07-16T12:00:00.000Z";
  const prepared = await prepareTombstonePrunePins(repo, "refs/heads/main", tip, "episode", time);
  const origins = parseKeepPinOrigins(await fs.readFile(prepared.sidecarPath, "utf8"));
  expect(origins[tip]).toEqual([{ ref: "refs/heads/main", episode: "episode", time, class: "tombstone" }]);
  expect(origins[reflogOnly]).toEqual([{ ref: "refs/heads/main", episode: "episode", time, class: "human" }]);
  expect(prepared.reflogFingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(expireTombstonePinOrigins(origins, Date.parse(time) + TOMBSTONE_PIN_RETENTION_MS)).toEqual({
    [reflogOnly]: origins[reflogOnly],
  });
  await runUpdateRefTransaction(repo, prepared.transactionLines);
  const expired = await expireTombstoneKeepPins(repo, Date.parse(time) + TOMBSTONE_PIN_RETENTION_MS);
  expect(expired).toEqual({ removedOrigins: 1, deletedPins: 1 });
  expect(await refExists(`refs/rbox-local/keep/${tip}`)).toBe(false);
  expect(await refExists(`refs/rbox-local/keep/${reflogOnly}`)).toBe(true);
  expect(parseKeepPinOrigins(await fs.readFile(prepared.sidecarPath, "utf8"))).toEqual({
    [reflogOnly]: origins[reflogOnly],
  });
});

test("§130 keep-origin parser is strict, bounded, and monotonic across tombstone promotion", async () => {
  const oid = await commit("strict.txt", "strict\n");
  const base = { ref: "refs/heads/main", episode: "e", time: "2026-07-16T12:00:00.000Z" };
  await prepareKeepPins(repo, [oid], { ...base, class: "tracking" });
  await prepareKeepPins(repo, [oid], { ...base, class: "tombstone" });
  await prepareKeepPins(repo, [oid], { ...base, class: "tracking" });
  const parsed = parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(parsed[oid]?.[0]?.class).toBe("tombstone");
  expect(() => parseKeepPinOrigins(JSON.stringify({ [oid]: [{ ...base, class: "human", extra: true }] }))).toThrow(/unknown/);
  expect(() => parseKeepPinOrigins(JSON.stringify({ [oid]: [{ ...base, class: "forever" }] }))).toThrow(/class/);
  expect(() => parseKeepPinOrigins(JSON.stringify({ [oid]: [{ ...base, class: "human" }, { ...base, class: "human" }] }))).toThrow(/duplicate/);
});

test("§130 P-repair commits pins before origins and retry retains stored origin time", async () => {
  const oid = await commit("repair.txt", "repair\n");
  const qRef = `refs/rbox-recovery/base-present/v2/${"1".repeat(64)}/${"2".repeat(64)}/${"3".repeat(32)}`;
  const episode = "3".repeat(32);
  await pinRepairObjectsFirst(repo, [oid]);
  expect(await refExists(`refs/rbox-local/keep/${oid}`)).toBe(true);
  const sidecar = path.join(repo, ".git", "rbox-keep-origins.json");
  expect(await fs.stat(sidecar).then(() => true, () => false)).toBe(false);

  const first = "2026-07-16T12:00:00.000Z";
  await mergeRepairOrigins(repo, [oid], qRef, episode, first);
  await mergeRepairOrigins(repo, [oid], qRef, episode, "2026-07-17T12:00:00.000Z");
  expect(parseKeepPinOrigins(await fs.readFile(sidecar, "utf8"))[oid]).toEqual([
    { ref: qRef, episode, time: first, class: "human" },
  ]);
});

test("§130 originless pin-only crash keeps Skeep reachable through reflog expiry and GC", async () => {
  const kept = await commit("crash-pin.txt", "kept\n");
  await commit("crash-pin.txt", "replacement\n");
  await pinRepairObjectsFirst(repo, [kept]);
  expect(await fs.stat(path.join(repo, ".git", "rbox-keep-origins.json")).then(() => true, () => false)).toBe(false);
  await runGit(repo, "reflog", "expire", "--expire=now", "--all");
  await runGit(repo, "gc", "--prune=now");
  expect(await runGit(repo, "cat-file", "-t", kept)).toBe("commit");
  expect(await runGit(repo, "rev-parse", `refs/rbox-local/keep/${kept}`)).toBe(kept);
});

test("§130 lineage cleanup removes only exact Q origins and preserves shared pins", async () => {
  const oid = await commit("cleanup.txt", "cleanup\n");
  const lineage = "4".repeat(64);
  const episode = "5".repeat(32);
  const qRef = `refs/rbox-recovery/base-present/v2/${lineage}/${"6".repeat(64)}/${episode}`;
  await pinRepairObjectsFirst(repo, [oid]);
  await mergeRepairOrigins(repo, [oid], qRef, episode, "2026-07-16T12:00:00.000Z");
  await prepareKeepPins(repo, [oid], { ref: "refs/heads/shared", episode: "shared", time: "2026-07-16T13:00:00.000Z", class: "human" });
  const cleanup = await prepareRepairOriginCleanup(repo, lineage);
  expect(cleanup.transactionLines).toEqual([]);
  expect(cleanup.removedOrigins).toBe(1);
  expect(await refExists(`refs/rbox-local/keep/${oid}`)).toBe(true);
  expect(parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8"))[oid]).toEqual([
    { ref: "refs/heads/shared", episode: "shared", time: "2026-07-16T13:00:00.000Z", class: "human" },
  ]);

  const onlyRepair = await commit("cleanup-only.txt", "cleanup-only\n");
  await pinRepairObjectsFirst(repo, [onlyRepair]);
  await mergeRepairOrigins(repo, [onlyRepair], qRef, episode, "2026-07-16T12:00:00.000Z");
  const finalCleanup = await prepareRepairOriginCleanup(repo, lineage);
  expect(finalCleanup.transactionLines).toEqual([`delete refs/rbox-local/keep/${onlyRepair} ${onlyRepair}`]);
  await runUpdateRefTransaction(repo, finalCleanup.transactionLines);
  expect(await refExists(`refs/rbox-local/keep/${onlyRepair}`)).toBe(false);
});

test("§130 prepared transaction fingerprints the reflog under Git's ref lock", async () => {
  const oldOid = await commit("locked.txt", "old\n");
  const newOid = await commit("locked.txt", "new\n");
  await runGit(repo, "reset", "--hard", oldOid);
  const before = await readRefReflogFingerprint(repo, "refs/heads/main");
  await runPreparedUpdateRefTransaction(
    repo,
    [`update refs/heads/main ${newOid} ${oldOid}`],
    async () => {
      const locked = await readRefReflogFingerprint(repo, "refs/heads/main");
      expect(locked.sha256).toBe(before.sha256);
    },
  );
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(newOid);

  const stable = await readRefReflogFingerprint(repo, "refs/heads/main");
  await expect(runPreparedUpdateRefTransaction(
    repo,
    [`update refs/heads/main ${oldOid} ${newOid}`],
    async () => {
      await fs.appendFile(path.join(repo, ".git", "logs", "refs", "heads", "main"), "hostile-direct-reflog-replacement\n");
      const changed = await readRefReflogFingerprint(repo, "refs/heads/main");
      if (changed.sha256 !== stable.sha256) throw new Error("reflog fingerprint changed at prepared boundary");
    },
  )).rejects.toThrow(/fingerprint changed/);
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(newOid);
});

test("§130 tombstone callback holds operation→reflog→origin→Git and aborts on fingerprint drift", async () => {
  const oldOid = await commit("tombstone-lock.txt", "old\n");
  const nextOid = await commit("tombstone-lock.txt", "next\n");
  await runGit(repo, "reset", "--hard", oldOid);
  const trace: ProtocolLockTraceEvent[] = [];
  setProtocolLockTraceForTests((event) => trace.push(event));
  await expect(withPreparedTombstonePrunePins(
    repo,
    "refs/heads/main",
    oldOid,
    "locked-episode",
    "2026-07-16T12:00:00.000Z",
    async (prepared) => {
      await fs.appendFile(path.join(repo, ".git", "logs", "refs", "heads", "main"), "hostile-direct-write\n");
      await runPreparedUpdateRefTransaction(repo, [
        ...prepared.transactionLines,
        `update refs/heads/main ${nextOid} ${oldOid}`,
      ], () => verifyPreparedTombstoneFingerprint(repo, "refs/heads/main", prepared.reflogFingerprint));
    },
  )).rejects.toThrow(/reflog changed/);
  expect(await runGit(repo, "rev-parse", "refs/heads/main")).toBe(oldOid);
  const acquire = trace.filter((event) => event.action === "acquire").map((event) => event.class);
  expect(acquire).toEqual(["operation", "reflog", "origin", "git"]);
  expect(trace.filter((event) => event.action === "release").map((event) => event.class))
    .toEqual(["git", "origin", "reflog", "operation"]);
  const origins = parseKeepPinOrigins(await fs.readFile(path.join(repo, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(origins[oldOid]?.[0]?.class).toBe("tombstone");
});

test("reflog protection returns same-transaction create lines for reflog-only commits", async () => {
  const base = await commit("history.txt", "base\n");
  const displaced = await commit("history.txt", "displaced\n");
  await runGit(repo, "reset", "--hard", base);

  const result = await prepareDisplacedRefPins(repo, "refs/heads/main", [base], {
    ref: "refs/heads/main",
    episode: "force-replace",
    time: "2026-07-13T12:00:00.000Z",
    class: "human",
  });

  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error("unexpected indeterminate reachability proof");
  expect(result.oids).toContain(displaced);
  expect(result.oids).not.toContain(base);
  expect(result.transactionLines).toContain(`create refs/rbox-local/keep/${displaced} ${displaced}`);
  expect(await refExists(`refs/rbox-local/keep/${displaced}`)).toBe(false);
});

test("a reflog-less unique live tip is pinned before deletion (confirmation-pass finding)", async () => {
  const base = await commit("history.txt", "base\n");
  const unique = await commit("history.txt", "unique on doomed\n");
  await runGit(repo, "update-ref", "refs/heads/doomed", unique);
  await runGit(repo, "reset", "--hard", base);
  // Simulate reflogs disabled/pruned: with no reflog the enumeration alone
  // finds nothing and deletion would strand `unique` with no keep pin.
  await fs.rm(path.join(repo, ".git", "logs", "refs", "heads", "doomed"), { force: true });

  const result = await prepareDisplacedRefPins(repo, "refs/heads/doomed", [base], {
    ref: "refs/heads/doomed",
    episode: "reflogless-delete",
    time: "2026-07-13T12:30:00.000Z",
    class: "human",
  });

  expect(result.status).toBe("prepared");
  if (result.status !== "prepared") throw new Error("unexpected indeterminate reachability proof");
  expect(result.oids).toContain(unique);
  expect(result.transactionLines).toContain(`create refs/rbox-local/keep/${unique} ${unique}`);
});

test("recovery namespace is excluded from syncable refs, capture, and ordinary identity", async () => {
  const oid = await commit("tracked.txt", "tracked\n");
  await pinDisplaced(repo, [oid], {
    ref: "refs/heads/main",
    episode: "capture-exclusion",
    time: "2026-07-13T13:00:00.000Z",
    class: "human",
  });

  expect(isSyncableRef("refs/heads/main")).toBe(true);
  expect(isSyncableRef("refs/tags/v1")).toBe(true);
  expect(isSyncableRef("refs/stash")).toBe(true);
  expect(isSyncableRef(`refs/rbox-local/keep/${oid}`)).toBe(false);

  const identity = await gitIdentity(repo);
  expect(identity?.refs["refs/heads/main"]).toBe(oid);
  expect(Object.keys(identity?.refs ?? {}).some((ref) => ref.startsWith("refs/rbox-local/"))).toBe(false);

  const section = await captureGitState(repo, new LocalBlobStore(path.join(tmp, "store")), KEK, { workspaceRoot: tmp });
  expect(section).toBeDefined();
  expect(section?.refs["refs/heads/main"]).toBe(oid);
  expect(Object.keys(section?.refs ?? {}).some((ref) => ref.startsWith("refs/rbox-local/"))).toBe(false);
});

test("design 126 capture bundles never advertise recovery refs while syncable refs remain", async () => {
  const oid = await commit("capture.txt", "capture\n");
  await runGit(repo, "tag", "syncable-tag", oid);
  await runGit(repo, "update-ref", "refs/rbox-recovery/orig-head/primary/1700000000000-deadbeef", oid);
  const store = new LocalBlobStore(path.join(tmp, "bundle-store"));
  const section = await captureGitState(repo, store, KEK, { workspaceRoot: tmp });
  if (!section) throw new Error("capture returned no section");
  const ciphertext = path.join(tmp, "captured-bundle.enc");
  const bundle = path.join(tmp, "captured.bundle");
  await fs.writeFile(ciphertext, await store.get(section.bundleEncSha));
  await decryptFileToPath(ciphertext, KEK, section.bundleSha, bundle, { comp: section.bundleComp, payloadSha: section.bundlePayloadSha });
  const advertised = await runGit(repo, "bundle", "list-heads", bundle);

  expect(advertised).toContain("refs/heads/main");
  expect(advertised).toContain("refs/tags/syncable-tag");
  expect(advertised).not.toContain("refs/rbox-recovery/");
});
