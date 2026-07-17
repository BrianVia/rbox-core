import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AcquireLockOptions, LockIdentitySource } from "./lockfile.js";
import {
  PROTOCOL_LOCK_ORDER,
  reflogMaintenanceLockPath,
  setProtocolLockTraceForTests,
  withCommonDirOperationLocks,
  withKeepOriginsLock,
  withPostHeadCompatibilityException,
  withProtocolLockClass,
  withReflogMaintenanceLocks,
  withRepoProtocolLocks,
  withRepositoryRecoveryFence,
  type ProtocolLockClass,
  type ProtocolLockTraceEvent,
} from "./protocol-locks.js";

const identity: LockIdentitySource = {
  current: async () => ({ hostId: "a".repeat(32), bootId: "b".repeat(32), pid: process.pid, startTime: "1" }),
  probe: async () => ({ status: "alive", startTime: "1" }),
};
let token = 0;
const lockOptions: AcquireLockOptions = {
  identity,
  token: () => (++token).toString(16).padStart(32, "0"),
  storageLocal: async () => true,
};

afterEach(() => setProtocolLockTraceForTests(undefined));

test("§130 reflog lock paths validate R and hash its exact UTF-8 bytes", () => {
  expect(path.basename(reflogMaintenanceLockPath("/common", "refs/heads/topic"))).toMatch(/^[0-9a-f]{64}\.lock$/);
  for (const ref of ["heads/topic", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a[b", "refs//topic"]) {
    expect(() => reflogMaintenanceLockPath("/common", ref)).toThrow(/invalid reflog lock ref/);
  }
});

test("§130 lock classes acquire in the normative subsequence and release in exact reverse", async () => {
  const common = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-protocol-order-"));
  const trace: ProtocolLockTraceEvent[] = [];
  setProtocolLockTraceForTests((event) => trace.push(event));
  try {
    await withProtocolLockClass("workspace", "workspace", () =>
      withProtocolLockClass("chain", common, () =>
        withCommonDirOperationLocks([common], () =>
          withReflogMaintenanceLocks(common, ["refs/heads/z", "refs/heads/a"], () =>
            withKeepOriginsLock(common, () =>
              withProtocolLockClass("git", "git-primary", () =>
                withProtocolLockClass("reservation", "refs/heads/a", () =>
                  withProtocolLockClass("orig-head", "ORIG_HEAD", () =>
                    withProtocolLockClass("index", "index", () =>
                      withProtocolLockClass("state", "state", async () => {}))))), lockOptions), lockOptions), lockOptions)));

    const acquired = trace.filter((event) => event.action === "acquire");
    expect(acquired.map((event) => event.class)).toEqual([
      "workspace", "chain", "operation", "reflog", "reflog", "origin",
      "git", "reservation", "orig-head", "index", "state",
    ]);
    expect(acquired.filter((event) => event.class === "reflog").map((event) => event.identity))
      .toEqual([`${await fs.realpath(common)}\0refs/heads/a`, `${await fs.realpath(common)}\0refs/heads/z`]);
    expect(trace.filter((event) => event.action === "release").map((event) => event.class))
      .toEqual(acquired.map((event) => event.class).reverse());
  } finally {
    await fs.rm(common, { recursive: true, force: true });
  }
});

test("design 138 recovery fence holds repository order through nested settlement and repair phases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-protocol-fence-"));
  const a = path.join(root, "a");
  const z = path.join(root, "z");
  await Promise.all([fs.mkdir(a), fs.mkdir(z)]);
  for (const repo of [a, z]) {
    const child = Bun.spawn(["git", "init", "-q", repo], { stdout: "ignore", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    if (await child.exited !== 0) throw new Error(`git init failed: ${error}`);
  }
  const commonA = path.join(a, ".git");
  const commonZ = path.join(z, ".git");
  const trace: ProtocolLockTraceEvent[] = [];
  setProtocolLockTraceForTests((event) => trace.push(event));
  try {
    await withRepositoryRecoveryFence([
      { commonDir: commonZ, reflogRefs: ["refs/heads/z"], origins: true },
      { commonDir: commonA, reflogRefs: ["refs/heads/a"], origins: true },
    ], path.join(root, ".rbox", "state.json"), async () => {
      // Exact-P settlement's ordinary wrappers must recognize the complete
      // held set, including its prepared Git transaction and state CAS.
      await withRepoProtocolLocks(a, { reflogRefs: ["refs/heads/a"] }, () =>
        withProtocolLockClass("git", "exact-settlement", () =>
          withProtocolLockClass("state", path.join(root, ".rbox", "state.json"), async () => {})), lockOptions);
      // Moved-P repair additionally asks for the origin lock; it too must be a
      // held-aware no-op rather than a second out-of-order acquisition.
      await withRepoProtocolLocks(z, { reflogRefs: ["refs/heads/z"], origins: true }, () =>
        withProtocolLockClass("git", "moved-p-repair", () =>
          withProtocolLockClass("state", path.join(root, ".rbox", "state.json"), async () => {})), lockOptions);
    }, lockOptions);

    const acquired = trace.filter((event) => event.action === "acquire");
    expect(acquired.map((event) => event.class)).toEqual([
      "operation", "operation",
      "reflog", "reflog",
      "origin", "origin",
      "git", "git",
      "reservation", "reservation",
      "orig-head", "orig-head",
      "index", "index",
      "state",
    ]);
    expect(acquired.at(-1)?.class).toBe("state");
    expect(acquired.filter((event) => event.class === "state")).toHaveLength(1);
    for (const lockClass of ["git", "reservation", "orig-head", "index"] as const) {
      expect(acquired.filter((event) => event.class === lockClass)).toHaveLength(2);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("§130 rejects every later-to-earlier inversion and non-canonical same-class nesting", async () => {
  const classes = Object.keys(PROTOCOL_LOCK_ORDER) as ProtocolLockClass[];
  for (const later of classes) {
    for (const earlier of classes) {
      if (PROTOCOL_LOCK_ORDER[later] <= PROTOCOL_LOCK_ORDER[earlier]) continue;
      await expect(withProtocolLockClass(later, later, () =>
        withProtocolLockClass(earlier, earlier, async () => {})))
        .rejects.toThrow(/protocol lock inversion/);
    }
  }
  await expect(withProtocolLockClass("reflog", "refs/heads/z", () =>
    withProtocolLockClass("reflog", "refs/heads/a", async () => {})))
    .rejects.toThrow(/canonical byte order/);
});

test("§130 operation locks sort common-dir realpaths and release after callback failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-protocol-multidir-"));
  const a = path.join(root, "a");
  const z = path.join(root, "z");
  await Promise.all([fs.mkdir(a), fs.mkdir(z)]);
  const trace: ProtocolLockTraceEvent[] = [];
  setProtocolLockTraceForTests((event) => trace.push(event));
  try {
    await expect(withCommonDirOperationLocks([z, a, z], async () => {
      throw new Error("injected callback failure");
    }, lockOptions)).rejects.toThrow(/injected/);
    const operations = trace.filter((event) => event.class === "operation");
    expect(operations.map((event) => `${event.action}:${event.identity}`)).toEqual([
      `acquire:${await fs.realpath(a)}`,
      `acquire:${await fs.realpath(z)}`,
      `release:${await fs.realpath(z)}`,
      `release:${await fs.realpath(a)}`,
    ]);
    await expect(fs.stat(path.join(a, "rbox-operation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(z, "rbox-operation.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("§130 post-HEAD inversion is isolated to Git while reservation/index remain", async () => {
  await expect(withProtocolLockClass("reservation", "reservation", () =>
    withProtocolLockClass("index", "index", () =>
      withProtocolLockClass("git", "post-head", async () => {}))))
    .rejects.toThrow(/protocol lock inversion/);

  await withProtocolLockClass("reservation", "reservation", () =>
    withProtocolLockClass("index", "index", () =>
      withPostHeadCompatibilityException(() =>
        withProtocolLockClass("git", "post-head", async () => {}))));

  await expect(withProtocolLockClass("index", "index", () =>
    withPostHeadCompatibilityException(() =>
      withProtocolLockClass("git", "post-head", async () => {}))))
    .rejects.toThrow(/requires reservation and index/);
  await expect(withProtocolLockClass("reservation", "reservation", () =>
    withProtocolLockClass("index", "index", () =>
      withPostHeadCompatibilityException(async () => {
        await withProtocolLockClass("git", "post-head-1", async () => {});
        await withProtocolLockClass("git", "post-head-2", async () => {});
      }))))
    .rejects.toThrow(/exactly one Git phase/);

  await expect(withProtocolLockClass("orig-head", "ORIG_HEAD", () =>
    withProtocolLockClass("index", "index", () =>
      withPostHeadCompatibilityException(async () => {}))))
    .rejects.toThrow(/forbidden lock class/);
  await expect(withProtocolLockClass("state", "state", () =>
    withPostHeadCompatibilityException(async () => {})))
    .rejects.toThrow(/forbidden lock class/);
});
