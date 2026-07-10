import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireLock,
  formatLockMarker,
  inspectLock,
  parseLockMarker,
  type LockIdentitySource,
  type LockMarker,
  type ProcessProbe,
} from "./lockfile.js";

const roots: string[] = [];
const current = { hostId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", bootId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", pid: 700, startTime: "100.000001" };

function identity(probes: Record<number, ProcessProbe> = {}): LockIdentitySource {
  return {
    current: async () => current,
    probe: async (pid) => probes[pid] ?? (pid === current.pid ? { status: "alive", startTime: current.startTime } : { status: "dead" }),
  };
}

function marker(overrides: Partial<LockMarker> = {}): LockMarker {
  return { ...current, token: "1".repeat(32), ...overrides };
}

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lockfile-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("rbox-93 marker grammar", () => {
  test("round-trips the exact host/boot/pid/start/token marker", () => {
    const value = marker();
    expect(parseLockMarker(formatLockMarker(value))).toEqual(value);
    expect(parseLockMarker("rbox-93 host boot 1 2 token\n")).toBeUndefined();
    expect(parseLockMarker(`${formatLockMarker(value)}extra`)).toBeUndefined();
  });
});

describe("atomic lock construction and ownership", () => {
  test("a simulated power loss after temp fsync never publishes an empty or partial lock", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    let staged = "";
    const acquired = await acquireLock(lockPath, {
      identity: identity(),
      token: () => "2".repeat(32),
      hooks: {
        afterTempFsync: async (tempPath, raw) => {
          staged = await fs.readFile(tempPath, "utf8");
          expect(staged).toBe(raw);
          expect(await fs.lstat(lockPath).catch(() => undefined)).toBeUndefined();
          throw new Error("power loss");
        },
      },
    });
    expect(acquired.status).toBe("error");
    expect(staged.length).toBeGreaterThan(0);
    expect(await fs.lstat(lockPath).catch(() => undefined)).toBeUndefined();
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("release refuses a stolen lock", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "state.lock");
    const acquired = await acquireLock(lockPath, { identity: identity(), token: () => "3".repeat(32) });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, formatLockMarker(marker({ token: "4".repeat(32) })));
    expect(await acquired.lock.release()).toEqual({ released: false, durable: false });
    expect((await fs.readFile(lockPath, "utf8"))).toContain("4".repeat(32));
  });

  test("a filesystem without hard-link support fails closed", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    const acquired = await acquireLock(lockPath, {
      identity: identity(),
      hooks: { link: async () => { throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" }); } },
    });
    expect(acquired.status).toBe("unsupported");
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("reaper fencing", () => {
  test("two reapers serialize through <lock>.reap", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 701, startTime: "50", token: "5".repeat(32) })));
    let entered!: () => void;
    const atFence = new Promise<void>((resolve) => { entered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let first = true;
    const firstAcquire = acquireLock(lockPath, {
      identity: identity(),
      token: () => "6".repeat(32),
      hooks: {
        beforeReapUnlink: async () => {
          if (!first) return;
          first = false;
          entered();
          await blocked;
        },
      },
    });
    await atFence;
    const secondAcquire = await acquireLock(lockPath, { identity: identity(), token: () => "7".repeat(32) });
    expect(secondAcquire.status).toBe("held");
    expect((await fs.lstat(`${lockPath}.reap`)).isFile()).toBe(true);
    unblock();
    const winner = await firstAcquire;
    expect(winner.status).toBe("acquired");
    if (winner.status === "acquired") await winner.lock.release();
  });

  test("an occupied-path change is re-read under the fence and never unlinked", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 702, startTime: "50", token: "8".repeat(32) })));
    const live = formatLockMarker(marker({ token: "9".repeat(32) }));
    const acquired = await acquireLock(lockPath, {
      identity: identity(),
      token: () => "a".repeat(32),
      hooks: {
        beforeReapInspect: async () => {
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, live);
        },
      },
    });
    expect(acquired.status).toBe("held");
    expect(await fs.readFile(lockPath, "utf8")).toBe(live);
  });

  test("a dead reaper fence is removed directly without recursive .reap locks", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 703, token: "b".repeat(32) })));
    await fs.writeFile(`${lockPath}.reap`, formatLockMarker(marker({ pid: 704, token: "c".repeat(32) })));
    const acquired = await acquireLock(lockPath, { identity: identity(), token: () => "d".repeat(32) });
    expect(acquired.status).toBe("acquired");
    expect(await fs.lstat(`${lockPath}.reap.reap`).catch(() => undefined)).toBeUndefined();
    if (acquired.status === "acquired") await acquired.lock.release();
  });
});

describe("liveness recovery classes", () => {
  test("cross-host, git-authored, malformed, symlink, and unknown-liveness locks are never removed", async () => {
    const cases: Array<{ name: string; write(lockPath: string): Promise<void>; source?: LockIdentitySource }> = [
      { name: "cross-host", write: (p) => fs.writeFile(p, formatLockMarker(marker({ hostId: "cccccccc-cccc-cccc-cccc-cccccccccccc" }))) },
      { name: "git-authored", write: (p) => fs.writeFile(p, "") },
      { name: "malformed", write: (p) => fs.writeFile(p, "rbox-93 broken") },
      { name: "symlink", write: async (p) => fs.symlink("missing", p) },
      {
        name: "unknown",
        write: (p) => fs.writeFile(p, formatLockMarker(marker({ pid: 705, token: "e".repeat(32) }))),
        source: identity({ 705: { status: "unknown" } }),
      },
    ];
    for (const item of cases) {
      const root = await tempDir();
      const lockPath = path.join(root, "config.lock");
      await item.write(lockPath);
      if (item.name === "unknown") expect((await inspectLock(lockPath, item.source)).kind).toBe("live");
      const acquired = await acquireLock(lockPath, { identity: item.source ?? identity(), token: () => "f".repeat(32) });
      expect(acquired.status, item.name).toBe("held");
      expect(await fs.lstat(lockPath), item.name).toBeDefined();
    }
  });

  test("a same-host marker from a different boot is reaped after power-loss recovery", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "sync.lock");
    const priorBoot = formatLockMarker(marker({ bootId: "dddddddd-dddd-dddd-dddd-dddddddddddd", token: "0".repeat(32) }));
    await fs.writeFile(lockPath, priorBoot);

    expect((await inspectLock(lockPath, identity())).kind).toBe("dead");
    const acquired = await acquireLock(lockPath, { identity: identity(), token: () => "f".repeat(32) });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    expect(await fs.readFile(lockPath, "utf8")).toBe(acquired.lock.raw);
    expect(acquired.lock.raw).not.toBe(priorBoot);
    await acquired.lock.release();
  });

  test("pid reuse is dead by start-time mismatch and is reaped", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 706, startTime: "10", token: "1".repeat(32) })));
    const source = identity({ 706: { status: "alive", startTime: "11" } });
    expect((await inspectLock(lockPath, source)).kind).toBe("dead");
    const acquired = await acquireLock(lockPath, { identity: source, token: () => "2".repeat(32) });
    expect(acquired.status).toBe("acquired");
    if (acquired.status === "acquired") await acquired.lock.release();
  });
});
