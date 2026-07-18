import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLock,
  defaultStorageStat,
  formatLockMarker,
  inspectLock,
  lockStorageLocal,
  mergeHostIdentityBoots,
  parseDarwinMountOutput,
  parseLockMarker,
  readHostIdentityLedger,
  refreshHostIdentityLedger,
  resolveDarwinIdentityComponents,
  resolveLinuxHostId,
  runIdentityCommand,
  type LockIdentitySource,
  type LockMarker,
  type ProcessProbe,
  type ResolvedLockIdentity,
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

describe("Linux host identity fallback chain", () => {
  test("prefers /etc/machine-id and does not probe later sources", async () => {
    const reads: string[] = [];
    let hostnameCalls = 0;
    const hostId = await resolveLinuxHostId({
      readFile: async (filePath) => {
        reads.push(filePath);
        return "AABBCCDD\n";
      },
      hostname: () => {
        hostnameCalls++;
        return "unused";
      },
    });
    expect(hostId).toBe("aabbccdd");
    expect(reads).toEqual(["/etc/machine-id"]);
    expect(hostnameCalls).toBe(0);
  });

  test("falls back through dbus machine-id and then hostname", async () => {
    const dbusReads: string[] = [];
    const dbus = await resolveLinuxHostId({
      readFile: async (filePath) => {
        dbusReads.push(filePath);
        if (filePath === "/etc/machine-id") throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return "DB05FACE\n";
      },
      hostname: () => "unused",
    });
    expect(dbus).toBe("db05face");
    expect(dbusReads).toEqual(["/etc/machine-id", "/var/lib/dbus/machine-id"]);

    const hostname = await resolveLinuxHostId({
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      hostname: () => "Apple-Guest.local",
    });
    expect(hostname).toBe(crypto.createHash("sha256").update("hostname:apple-guest.local").digest("hex"));
  });

  test("reports unsupported only after every source is unavailable", async () => {
    await expect(resolveLinuxHostId({
      readFile: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      hostname: () => "   ",
    })).rejects.toThrow("no Linux host identity source");
  });
});

describe("design 118 Darwin identity acquisition", () => {
  const KERN = "11111111-1111-4111-8111-111111111111";
  const BOOT = "22222222-2222-4222-8222-222222222222";
  const PLATFORM = "33333333-3333-4333-8333-333333333333";

  test("components validate and recover independently after transient failures", async () => {
    const calls = new Map<string, number>();
    const found = await resolveDarwinIdentityComponents(async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (args.includes("kern.uuid") && calls.get(key) === 1) throw Object.assign(new Error("denied"), { code: "EPERM" });
      if (args.includes("kern.uuid")) return Buffer.from(`${KERN}\n`);
      if (args.includes("kern.bootsessionuuid")) return Buffer.from(`${BOOT}\n`);
      if (args.includes("kern.iokit.platform-uuid")) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Buffer.from(`    \"IOPlatformUUID\" = \"${PLATFORM}\"\n`);
    });
    expect(found).toEqual({ kernUuid: KERN.toLowerCase(), bootSessionUuid: BOOT.toLowerCase(), platformUuid: PLATFORM.toLowerCase() });
    expect([...calls.values()].some((count) => count > 1)).toBe(true);
  });

  test("missing or oversized components remain independently absent", async () => {
    const found = await resolveDarwinIdentityComponents(async (_command, args) => {
      if (args.includes("kern.uuid")) return Buffer.alloc(2048, 0x61);
      if (args.includes("kern.bootsessionuuid")) return Buffer.from(BOOT);
      throw Object.assign(new Error("sandbox denial"), { code: "EPERM" });
    });
    expect(found).toEqual({ kernUuid: undefined, bootSessionUuid: BOOT.toLowerCase(), platformUuid: undefined });
  });

  test("identity subprocess timeout kills a hung command", async () => {
    const started = Date.now();
    await expect(runIdentityCommand("/bin/sh", ["-c", "while :; do :; done"])).rejects.toMatchObject({ killed: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(12_000);
  }, 15_000);
});

describe("design 118 local-filesystem proof", () => {
  test("allows only the complete Darwin and Linux filesystem sets", async () => {
    for (const type of [0xef53n, 0x9123683en, 0x58465342n, 0x2fc12fc1n, 0xf2f52010n, 0x01021994n, 0x794c7630n]) {
      expect(await lockStorageLocal("/state", async () => ({ dev: type, type }), "linux"), String(type)).toBe(true);
    }
    for (const type of ["apfs", "hfs", "APFS"]) {
      expect(await lockStorageLocal("/state", async () => ({ dev: 1n, type, local: true }), "darwin"), type).toBe(true);
    }
    for (const type of [0x6969n, 0xff534d42n, 0x65735546n, 0n]) {
      expect(await lockStorageLocal("/state", async () => ({ dev: 9n, type }), "linux"), String(type)).toBe(false);
    }
    for (const type of ["nfs", "smbfs", "fusefs", "unknown", ""]) {
      expect(await lockStorageLocal("/state", async () => ({ dev: 2n, type, local: true }), "darwin"), type).toBe(false);
    }
    expect(await lockStorageLocal("/state", async () => ({ dev: 4n, type: "apfs", local: false }), "darwin")).toBe(false);
    expect(await lockStorageLocal("/state", async () => ({ dev: 5n, type: "apfs" }), "darwin")).toBe(false);
    expect(await lockStorageLocal("/state", async () => { throw new Error("statfs failed"); }, "linux")).toBe(false);
    expect(await lockStorageLocal("/state", async () => { throw new Error("mount timed out"); }, "darwin")).toBe(false);
    expect(await lockStorageLocal("/state", async () => ({ dev: 3n, type: "apfs" }), "linux")).toBe(false);
  });

  // Verbatim from the field incident that exposed the `%T` bug.
  const incidentMountLine = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)";
  const representativeMountFixture = [
    incidentMountLine,
    "/dev/disk3s6 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
    "/dev/disk4s1 on /Volumes/Field Data (Primary) (apfs, local, nodev, nosuid, journaled)",
  ].join("\n");

  test("Darwin mount parsing selects the longest path-component prefix", () => {
    expect(parseDarwinMountOutput(representativeMountFixture, "/System/Volumes/Data/Users/founder/repo/.rbox/state"))
      .toEqual({ type: "apfs", local: true });
    expect(parseDarwinMountOutput(representativeMountFixture, "/System/Volumes/Database"))
      .toEqual({ type: "apfs", local: true });
    expect(parseDarwinMountOutput(representativeMountFixture, "/System/Volumes/Data/home/founder"))
      .toEqual({ type: "autofs", local: false });
  });

  test("Darwin mount parsing accepts spaces and balanced parentheses", () => {
    expect(parseDarwinMountOutput(representativeMountFixture, "/Volumes/Field Data (Primary)/repo/.rbox/state"))
      .toEqual({ type: "apfs", local: true });
  });

  test("Darwin mount parsing fails closed on ambiguous or malformed records", () => {
    expect(parseDarwinMountOutput(`${incidentMountLine}\n/dev/disk4s1 on /Volumes/Field on Data (apfs, local)`, "/Volumes/Field on Data/repo"))
      .toBeUndefined();
    expect(parseDarwinMountOutput(`${incidentMountLine}\nsource on label on /Volumes/Target (apfs, local)`, "/Volumes/Target/repo"))
      .toBeUndefined();
    expect(parseDarwinMountOutput(`${incidentMountLine}\n on /Volumes/Target (apfs, local)`, "/Volumes/Target/repo"))
      .toBeUndefined();
    expect(parseDarwinMountOutput(`${incidentMountLine}\n    on /Volumes/Target (apfs, local)`, "/Volumes/Target/repo"))
      .toBeUndefined();
    expect(parseDarwinMountOutput(`${incidentMountLine}\n/dev/disk4s1 on /Volumes/Field (Data (apfs, local)`, "/Volumes/Field (Data/repo"))
      .toBeUndefined();
    expect(parseDarwinMountOutput(`${incidentMountLine}\nnot a mount record`, "/repo/.rbox/state"))
      .toEqual({ type: "apfs", local: true });
    expect(parseDarwinMountOutput(`${incidentMountLine}\n/dev/disk4s1 on /Volumes/Other on Data (apfs, local)`, "/repo/.rbox/state"))
      .toEqual({ type: "apfs", local: true });
    expect(parseDarwinMountOutput("/dev/disk4s1 on /Volumes/Elsewhere (apfs, local)", "/repo/.rbox/state"))
      .toBeUndefined();
  });

  test.skipIf(process.platform !== "darwin")("Darwin real adapter proves the repository state directory local", async () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    const rboxDir = path.join(repoRoot, ".rbox");
    const stateDir = path.join(rboxDir, "state");
    const stateExisted = await fs.stat(stateDir).then(() => true, () => false);
    const rboxExisted = await fs.stat(rboxDir).then(() => true, () => false);
    await fs.mkdir(stateDir, { recursive: true });
    try {
      const stat = await defaultStorageStat(stateDir);
      expect(stat.local).toBe(true);
      expect(await lockStorageLocal(stateDir)).toBe(true);
    } finally {
      if (!stateExisted) await fs.rmdir(stateDir).catch(() => {});
      if (!rboxExisted) await fs.rmdir(rboxDir).catch(() => {});
    }
  });
});

describe("design 118 host identity ledger", () => {
  const boot = (n: number, seenAt = n) => ({
    kernUuid: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000001`,
    bootSessionUuid: `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000002`,
    seenAt,
  });

  test("duplicate coherent pairs merge enrichment and greatest seenAt", () => {
    const value = boot(1, 10);
    const merged = mergeHostIdentityBoots([{ ...value, seenAt: 20 }], {
      ...value, platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seenAt: 5,
    });
    expect(merged).toEqual([{ ...value, platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seenAt: 20 }]);
  });

  test("pins current and deterministically retains only seven newest historical pairs", () => {
    const currentBoot = boot(99, 0);
    const history = Array.from({ length: 10 }, (_, i) => boot(i + 1, i < 2 ? 50 : i));
    const merged = mergeHostIdentityBoots(history, currentBoot);
    expect(merged).toHaveLength(8);
    expect(merged[0]).toEqual(currentBoot);
    expect(merged.slice(1).map((entry) => entry.bootSessionUuid)).toEqual(
      [...history].sort((a, b) => b.seenAt - a.seenAt || b.bootSessionUuid.localeCompare(a.bootSessionUuid)).slice(0, 7).map((entry) => entry.bootSessionUuid),
    );
  });

  test("bounded strict reads quarantine corruption and rewrite mode 0600", async () => {
    const root = await tempDir();
    const filePath = path.join(root, "host-identity.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 1, boots: [], extra: "forged" }));
    const resolved: ResolvedLockIdentity = { ...current, platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const refreshed = await refreshHostIdentityLedger(resolved, filePath, 123);
    expect(refreshed.knownBoots).toEqual([{
      kernUuid: current.hostId, bootSessionUuid: current.bootId,
      platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", seenAt: 123,
    }]);
    expect(await fs.readFile(`${filePath}.corrupt`, "utf8")).toContain("extra");
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await readHostIdentityLedger(filePath)).toEqual(refreshed.knownBoots);
  });

  test("no-follow read rejects symlinks without reading their target", async () => {
    const root = await tempDir();
    const target = path.join(root, "secret");
    const ledger = path.join(root, "host-identity.json");
    await fs.writeFile(target, JSON.stringify({ version: 1, boots: [boot(1)] }));
    await fs.symlink(target, ledger);
    expect(await readHostIdentityLedger(ledger)).toBeUndefined();
  });

  test("an unchanged ledger refresh does not rewrite the durable file", async () => {
    const root = await tempDir();
    const filePath = path.join(root, "host-identity.json");
    const resolved: ResolvedLockIdentity = { ...current, platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    await refreshHostIdentityLedger(resolved, filePath, 123);
    const before = await fs.stat(filePath, { bigint: true });
    await refreshHostIdentityLedger(resolved, filePath, 123);
    const after = await fs.stat(filePath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  test("system identity-ledger refresh is memoized across two lock acquires", async () => {
    const root = await tempDir();
    const savedHome = process.env.RBOX_HOME;
    const savedIdentityDir = process.env.RBOX_TEST_HOST_IDENTITY_DIR;
    delete process.env.RBOX_HOME;
    process.env.RBOX_TEST_HOST_IDENTITY_DIR = root;
    try {
      const first = await acquireLock(path.join(root, "first.lock"));
      expect(first.status).toBe("acquired");
      if (first.status !== "acquired") return;
      await first.lock.release();
      const ledgerBefore = process.platform === "darwin"
        ? await fs.stat(path.join(root, "host-identity.json"), { bigint: true })
        : undefined;

      const second = await acquireLock(path.join(root, "second.lock"));
      expect(second.status).toBe("acquired");
      if (second.status === "acquired") await second.lock.release();
      if (ledgerBefore) {
        const ledgerAfter = await fs.stat(path.join(root, "host-identity.json"), { bigint: true });
        expect(ledgerAfter.ino).toBe(ledgerBefore.ino);
        expect(ledgerAfter.mtimeNs).toBe(ledgerBefore.mtimeNs);
      }
    } finally {
      if (savedHome === undefined) delete process.env.RBOX_HOME;
      else process.env.RBOX_HOME = savedHome;
      if (savedIdentityDir === undefined) delete process.env.RBOX_TEST_HOST_IDENTITY_DIR;
      else process.env.RBOX_TEST_HOST_IDENTITY_DIR = savedIdentityDir;
    }
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

  test("create verification failure cleans up only the exact marker", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "verify.lock");
    const replacement = formatLockMarker(marker({ token: "e".repeat(32) }));
    const result = await acquireLock(lockPath, {
      identity: identity(),
      token: () => "d".repeat(32),
      hooks: { afterCreate: async () => { await fs.unlink(lockPath); await fs.writeFile(lockPath, replacement); } },
    });
    expect(result.status).toBe("held");
    expect(await fs.readFile(lockPath, "utf8")).toBe(replacement);
  });

  test("a retained exact marker from indeterminate verification heals on the next acquire", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "retained.lock");
    let fail = true;
    const options = {
      identity: identity(),
      token: () => "c".repeat(32),
      hooks: {
        afterCreate: async () => { if (fail) throw new Error("verification unavailable"); },
        beforeCreatedCleanup: async () => { if (fail) throw new Error("cleanup unavailable"); },
      },
    };
    const first = await acquireLock(lockPath, options);
    expect(first.status).toBe("held");
    fail = false;
    const second = await acquireLock(lockPath, options);
    expect(second.status).toBe("acquired");
    if (second.status === "acquired") await second.lock.release();
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

  test("two independent processes serialize breakers through the fence", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "process-race.lock");
    const ready = path.join(root, "ready");
    const release = path.join(root, "release");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 999_999, token: "7".repeat(32) })));
    const moduleUrl = pathToFileURL(path.join(import.meta.dir, "lockfile.ts")).href;
    const common = `
      import fs from "node:fs/promises";
      import { acquireLock } from ${JSON.stringify(moduleUrl)};
      const identity = {
        current: async () => ({ hostId: ${JSON.stringify(current.hostId)}, bootId: ${JSON.stringify(current.bootId)}, pid: process.pid, startTime: "1" }),
        probe: async (pid) => { try { process.kill(pid, 0); return { status: "alive", startTime: "1" }; } catch { return { status: "dead" }; } },
      };
    `;
    const firstCode = `${common}
      const result = await acquireLock(${JSON.stringify(lockPath)}, {
        identity, token: () => "8".repeat(32),
        hooks: { beforeReapUnlink: async () => {
          await fs.writeFile(${JSON.stringify(ready)}, "ready");
          while (!(await fs.stat(${JSON.stringify(release)}).then(() => true, () => false))) await Bun.sleep(10);
        } },
      });
      console.log(result.status);
      if (result.status === "acquired") await result.lock.release();
    `;
    const child = spawn(process.execPath, ["-e", firstCode], { stdio: ["ignore", "pipe", "pipe"] });
    let firstOut = "";
    let firstErr = "";
    child.stdout.on("data", (chunk) => { firstOut += String(chunk); });
    child.stderr.on("data", (chunk) => { firstErr += String(chunk); });
    for (let i = 0; i < 1_000 && !(await fs.stat(ready).then(() => true, () => false)); i++) await Bun.sleep(10);
    expect(await fs.stat(ready).then(() => true, () => false)).toBe(true);

    const secondCode = `${common}
      const result = await acquireLock(${JSON.stringify(lockPath)}, { identity, token: () => "9".repeat(32) });
      console.log(result.status, result.status === "held" ? result.blockerKind : "");
    `;
    const second = spawn(process.execPath, ["-e", secondCode], { stdio: ["ignore", "pipe", "pipe"] });
    let secondOut = "";
    let secondErr = "";
    second.stdout.on("data", (chunk) => { secondOut += String(chunk); });
    second.stderr.on("data", (chunk) => { secondErr += String(chunk); });
    const secondExit = await new Promise<number | null>((resolve) => second.on("exit", resolve));
    expect({ secondExit, secondErr }).toEqual({ secondExit: 0, secondErr: "" });
    expect(secondOut.trim()).toBe("held fence");

    await fs.writeFile(release, "release");
    const firstExit = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect({ firstExit, firstErr }).toEqual({ firstExit: 0, firstErr: "" });
    expect(firstOut.trim()).toBe("acquired");
  }, 20_000);

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

  test("reaper-fence release failure is the causal blocker", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 730, token: "a".repeat(32) })));
    let replaced = false;
    const result = await acquireLock(lockPath, {
      identity: identity(),
      token: () => "b".repeat(32),
      hooks: {
        beforeReleaseUnlink: async (target) => {
          if (!replaced && target.endsWith(".reap")) {
            replaced = true;
            await fs.unlink(target);
            await fs.writeFile(target, formatLockMarker(marker({ token: "f".repeat(32) })));
          }
        },
      },
    });
    expect(result).toMatchObject({ status: "held", blockerKind: "fence", warningReason: "fence" });
  });

  test("byte-identical replacement on a new inode aborts observation-coupled reaping", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "config.lock");
    const dead = formatLockMarker(marker({ pid: 731, token: "1".repeat(32) }));
    await fs.writeFile(lockPath, dead);
    const result = await acquireLock(lockPath, {
      identity: identity(),
      token: () => "2".repeat(32),
      hooks: {
        beforeReapUnlink: async () => {
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, dead);
        },
      },
    });
    expect(result.status).toBe("held");
    expect(await fs.readFile(lockPath, "utf8")).toBe(dead);
  });

  test("size, mtime, and content changes each abort observation-coupled reaping", async () => {
    for (const change of ["size", "mtime", "content"] as const) {
      const root = await tempDir();
      const lockPath = path.join(root, `${change}.lock`);
      const dead = formatLockMarker(marker({ pid: 732, token: "3".repeat(32) }));
      await fs.writeFile(lockPath, dead);
      let generation = 0;
      const result = await acquireLock(lockPath, {
        identity: identity(), token: () => "4".repeat(32),
        hooks: {
          beforeReapUnlink: async () => {
            generation++;
            if (change === "size") await fs.appendFile(lockPath, "x");
            else if (change === "mtime") {
              const when = new Date(Date.now() + generation * 10_000);
              await fs.utimes(lockPath, when, when);
            } else {
              const next = formatLockMarker(marker({ pid: 732, token: (generation % 2 ? "5" : "6").repeat(32) }));
              await fs.writeFile(lockPath, next);
            }
          },
        },
      });
      expect(result.status, change).toBe("held");
      expect(await fs.stat(lockPath), change).toBeDefined();
    }
  });
});

describe("liveness recovery classes", () => {
  test("covers the eight legacy/new marker compatibility cells", async () => {
    const bootA = "aaaaaaaa-0000-4000-8000-000000000001";
    const bootB = "bbbbbbbb-0000-4000-8000-000000000002";
    const kernA = "cccccccc-0000-4000-8000-000000000003";
    const raw = formatLockMarker(marker({ hostId: kernA, bootId: bootA, pid: 900, startTime: "9" }));
    const oldResult = (readerBoot: string) => readerBoot === bootA ? "probe" : "foreign";
    const newSource = (readerBoot: string): LockIdentitySource => ({
      current: async (): Promise<ResolvedLockIdentity> => ({
        hostId: readerBoot === bootA ? kernA : "dddddddd-0000-4000-8000-000000000004",
        bootId: readerBoot,
        pid: 901,
        startTime: "10",
        knownBoots: [{ kernUuid: kernA, bootSessionUuid: bootA, seenAt: 1 }],
      }),
      probe: async () => ({ status: "alive", startTime: "9" }),
    });
    for (const logical of ["legacy", "enriched"] as const) {
      expect(oldResult(bootA), `${logical}/old/A`).toBe("probe");
      expect(oldResult(bootB), `${logical}/old/B`).toBe("foreign");
      const rootA = await tempDir();
      const pathA = path.join(rootA, `${logical}-A.lock`);
      await fs.writeFile(pathA, raw);
      expect((await inspectLock(pathA, newSource(bootA))).kind, `${logical}/new/A`).toBe("live");
      const rootB = await tempDir();
      const pathB = path.join(rootB, `${logical}-B.lock`);
      await fs.writeFile(pathB, raw);
      expect((await inspectLock(pathB, newSource(bootB))).kind, `${logical}/new/B`).toBe("dead");
    }
  });

  test("proven-local unknown identity probes dead, recycled, and matching-live PIDs", async () => {
    const cases: Array<{ pid: number; probe: ProcessProbe; expected: "dead" | "live"; drift?: boolean }> = [
      { pid: 810, probe: { status: "dead" }, expected: "dead" },
      { pid: 811, probe: { status: "alive", startTime: "different" }, expected: "dead" },
      { pid: 812, probe: { status: "alive", startTime: "50" }, expected: "live", drift: true },
    ];
    for (const item of cases) {
      const root = await tempDir();
      const lockPath = path.join(root, "sync.lock");
      await fs.writeFile(lockPath, formatLockMarker(marker({ hostId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", pid: item.pid, startTime: "50" })));
      const inspection = await inspectLock(lockPath, identity({ [item.pid]: item.probe }), async () => true);
      expect(inspection.kind).toBe(item.expected);
      if (inspection.kind === "live") expect(inspection.identityDrift).toBe(item.drift);
      const result = await acquireLock(lockPath, { identity: identity({ [item.pid]: item.probe }), storageLocal: async () => true, token: () => "9".repeat(32) });
      expect(result.status).toBe(item.expected === "dead" ? "acquired" : "held");
      if (result.status === "held") expect(result.warningReason).toBe("identity-drift");
      if (result.status === "acquired") await result.lock.release();
    }
  });

  test("unproven locality never removes an unknown-host main marker or fence", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "sync.lock");
    const foreign = formatLockMarker(marker({ hostId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", pid: 820 }));
    await fs.writeFile(lockPath, foreign);
    await fs.writeFile(`${lockPath}.reap`, foreign);
    const result = await acquireLock(lockPath, { identity: identity(), storageLocal: async () => false });
    expect(result.status).toBe("held");
    expect(await fs.readFile(lockPath, "utf8")).toBe(foreign);
    expect(await fs.readFile(`${lockPath}.reap`, "utf8")).toBe(foreign);
  });

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
      if (item.name === "unknown") expect((await inspectLock(lockPath, item.source)).kind).toBe("foreign");
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
