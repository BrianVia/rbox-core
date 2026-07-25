import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireLock,
  captureCommonDirIdentity,
  classifyProcessIncarnation,
  commonDirIdentityMatches,
  compareProcessStart,
  defaultStorageStat,
  deserializeMarkerObservation,
  formatLockMarker,
  inspectLock,
  lockStorageLocal,
  mergeHostIdentityBoots,
  parseDarwinMountOutput,
  darwinProcessStartForTests,
  parseDarwinProcessStartListing,
  parseLockMarker,
  probeProcessForTests,
  publishLockMarker,
  readHostIdentityLedger,
  refreshHostIdentityLedger,
  resolveDarwinIdentityComponents,
  resolveLinuxHostId,
  runIdentityCommand,
  safeBoundLockParent,
  serializeMarkerObservation,
  systemLockIdentity,
  validProcessIncarnation,
  type LockIdentitySource,
  type LockMarker,
  type MarkerObservation,
  type ProcessProbe,
  type PsLstartRun,
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

describe("shared journal lock safety machinery", () => {
  test("bounded-parent validation reports absence, creates safely, and rejects escapes and symlinks", async () => {
    const root = await tempDir();
    const common = path.join(root, "common");
    await fs.mkdir(common);
    const lockPath = path.join(common, "refs", "heads", "main.lock");

    expect(await safeBoundLockParent(common, lockPath, { create: false })).toBe("absent");
    expect(await safeBoundLockParent(common, lockPath, { create: true })).toBe("safe");
    expect((await fs.lstat(path.dirname(lockPath))).isDirectory()).toBe(true);
    expect(await safeBoundLockParent(common, lockPath, { create: false })).toBe("safe");

    await expect(safeBoundLockParent(common, path.join(root, "outside.lock"), { create: false })).rejects.toThrow("escaped");
    await expect(safeBoundLockParent(common, "relative.lock", { create: false })).rejects.toThrow("escaped");

    const outside = path.join(root, "outside");
    const linked = path.join(common, "linked");
    await fs.mkdir(outside);
    await fs.symlink(outside, linked);
    await expect(safeBoundLockParent(common, path.join(linked, "victim.lock"), { create: false })).rejects.toThrow("unsafe");
    await expect(safeBoundLockParent(common, path.join(linked, "victim.lock"), { create: true })).rejects.toThrow("unsafe");
  });

  test("common-directory identity detects inode replacement and refuses aliases", async () => {
    const root = await tempDir();
    const common = path.join(root, "common");
    await fs.mkdir(common);
    const captured = await captureCommonDirIdentity(common);
    expect(captured).toMatchObject({ path: common, realpath: common });
    expect(await commonDirIdentityMatches(captured)).toBe(true);

    await fs.rename(common, path.join(root, "old-common"));
    await fs.mkdir(common);
    expect(await commonDirIdentityMatches(captured)).toBe(false);

    const alias = path.join(root, "alias");
    await fs.symlink(common, alias);
    await expect(captureCommonDirIdentity(alias)).rejects.toThrow("symlinked");
  });

  test("exact observations serialize without numeric precision loss and reject malformed authority", () => {
    const observation: MarkerObservation = {
      dev: 9_007_199_254_740_993n,
      inode: 18_014_398_509_481_987n,
      size: 3n,
      mtimeNs: -1n,
      birthtimeNs: 1_700_000_000_123_456_789n,
      raw: "abc",
    };
    const serialized = serializeMarkerObservation(observation);
    expect(serialized).toEqual({
      dev: "9007199254740993",
      inode: "18014398509481987",
      size: "3",
      mtimeNs: "-1",
      birthtimeNs: "1700000000123456789",
      raw: "abc",
    });
    expect(deserializeMarkerObservation(serialized)).toEqual(observation);
    // A pre-birthtime observation still parses; its birth time reads back as 0.
    const { birthtimeNs: _drop, ...legacySerialized } = serialized;
    expect(deserializeMarkerObservation(legacySerialized)).toEqual({ ...observation, birthtimeNs: 0n });
    expect(deserializeMarkerObservation({ ...serialized, dev: 1 })).toBeUndefined();
    expect(deserializeMarkerObservation({ ...serialized, inode: "01" })).toBeUndefined();
    expect(deserializeMarkerObservation({ ...serialized, size: "2" })).toBeUndefined();
    expect(deserializeMarkerObservation({ ...serialized, birthtimeNs: "-1" })).toBeUndefined();
    expect(deserializeMarkerObservation({ ...serialized, extra: true })).toBeUndefined();

    const large = { ...serialized, size: "2048", raw: "x".repeat(1024) };
    expect(deserializeMarkerObservation(large)?.size).toBe(2048n);
    expect(deserializeMarkerObservation({ ...large, raw: "x".repeat(1023) })).toBeUndefined();
  });

  test("incarnation validation and classification share fail-closed semantics", async () => {
    expect(validProcessIncarnation(current)).toBe(true);
    expect(validProcessIncarnation({ ...current, pid: 0 })).toBe(false);
    expect(validProcessIncarnation({ ...current, hostId: "" })).toBe(false);

    expect(await classifyProcessIncarnation(current, identity())).toBe("alive");
    expect(await classifyProcessIncarnation({ ...current, bootId: "other-boot" }, identity())).toBe("dead");
    expect(await classifyProcessIncarnation({ ...current, pid: 701 }, identity({ 701: { status: "dead" } }))).toBe("dead");
    expect(await classifyProcessIncarnation({ ...current, pid: 702, startTime: "old" }, identity({ 702: { status: "alive", startTime: "new" } }))).toBe("dead");
    expect(await classifyProcessIncarnation({ ...current, pid: 703 }, identity({ 703: { status: "unknown" } }))).toBe("unknown");
    expect(await classifyProcessIncarnation({ ...current, hostId: "foreign" }, identity())).toBe("unknown");
    expect(await classifyProcessIncarnation(current, {
      current: async () => { throw new Error("unavailable"); },
      probe: async () => ({ status: "dead" }),
    })).toBe("unknown");
  });

  test("beforeLink is the final abort seam before a visible lock exists", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "gated.lock");
    let called = false;
    const result = await publishLockMarker(lockPath, formatLockMarker(marker()), {
      beforeLink: async (candidate, raw) => {
        called = true;
        expect(candidate).toBe(lockPath);
        expect(raw).toBe(formatLockMarker(marker()));
        await expect(fs.lstat(lockPath)).rejects.toThrow();
        throw new Error("gate closed");
      },
    });
    expect(called).toBe(true);
    expect(result.status).toBe("error");
    await expect(fs.lstat(lockPath)).rejects.toThrow();
  });
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

  test("an unreadable ledger degrades to the live identity instead of disabling locking", async () => {
    if (process.getuid?.() === 0) return; // root bypasses the mode-bit denial this relies on
    const root = await tempDir();
    const filePath = path.join(root, "host-identity.json");
    await fs.writeFile(filePath, JSON.stringify({ version: 1, boots: [] }));
    await fs.chmod(filePath, 0o000); // open() now fails EACCES → an unclassified read error
    const resolved: ResolvedLockIdentity = { ...current, platformUuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    // Must NOT throw: the live identity is valid, so locking proceeds; the broken
    // ledger cache degrades to "no persisted boot history".
    const refreshed = await refreshHostIdentityLedger(resolved, filePath, 123);
    expect(refreshed.hostId).toBe(current.hostId);
    expect(refreshed.bootId).toBe(current.bootId);
    expect(refreshed.platformUuid).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await fs.chmod(filePath, 0o600).catch(() => {}); // let tempDir cleanup remove it
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

  test("marker publication never adopts a same-bytes successor inode", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "same-marker.lock");
    const raw = formatLockMarker(marker({ token: "f".repeat(32) }));
    const result = await publishLockMarker(lockPath, raw, {
      afterCreate: async () => {
        await fs.unlink(lockPath);
        await fs.writeFile(lockPath, raw);
      },
    });
    expect(result.status).toBe("error");
    expect(await fs.readFile(lockPath, "utf8")).toBe(raw);
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
  test("exact marker mode survives umask and propagates to the reap fence", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "readable.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 700, startTime: "50", token: "4".repeat(32) })));
    let fenceMode = 0;
    const previousUmask = process.umask(0o077);
    try {
      const acquired = await acquireLock(lockPath, {
        identity: identity(),
        markerMode: 0o644,
        token: () => "5".repeat(32),
        hooks: {
          beforeReapUnlink: async () => {
            fenceMode = (await fs.stat(`${lockPath}.reap`)).mode & 0o777;
          },
        },
      });
      expect(acquired.status).toBe("acquired");
      expect(fenceMode).toBe(0o644);
      expect((await fs.stat(lockPath)).mode & 0o777).toBe(0o644);
      if (acquired.status === "acquired") await acquired.lock.release();
    } finally {
      process.umask(previousUmask);
    }
  });

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

describe("macOS 26 process-start source", () => {
  // macOS 26 dropped the `kern.proc.pid.<pid>` sysctl OID name, so `ps` is the
  // only per-process clock a command-line caller has left there.
  test("a ps listing canonicalizes to whole epoch seconds, identically on every read", () => {
    expect(parseDarwinProcessStartListing("Fri Jul 24 23:05:12 2026")).toBe(String(Date.UTC(2026, 6, 24, 23, 5, 12) / 1000));
    // ps space-pads a single-digit day and pads the field on the right.
    expect(parseDarwinProcessStartListing("Sat Jul  4 00:00:00 2026    ")).toBe(String(Date.UTC(2026, 6, 4, 0, 0, 0) / 1000));
    expect(parseDarwinProcessStartListing("Fri Jul 24 23:05:12 2026")).toBe(parseDarwinProcessStartListing("Fri Jul 24 23:05:12 2026    \n"));
    // Whole seconds only: it must never be mistaken for a sysctl reading.
    expect(parseDarwinProcessStartListing("Fri Jul 24 23:05:12 2026")).toMatch(/^\d+$/);
  });

  test("an unusable ps listing is rejected rather than canonicalized into a wrong incarnation", () => {
    for (const line of [
      "", "not a date", "Fri Jul 24 23:05 2026", "Fri Xyz 24 23:05:12 2026",
      "Fri Jul 32 23:05:12 2026", "Fri Jul 24 24:05:12 2026", "Fri Jul 24 23:60:12 2026", "Fri Jul 24 23:05:60 2026",
      // Impossible calendar dates: Date.UTC would roll these into the next month
      // and hand back a plausible-looking, wrong incarnation.
      "Sat Feb 31 12:00:00 2026", "Sun Feb 29 12:00:00 2026", "Tue Apr 31 12:00:00 2026", "Wed Jun 00 12:00:00 2026",
    ]) {
      expect(parseDarwinProcessStartListing(line), line).toBeUndefined();
    }
    // A real leap day still parses.
    expect(parseDarwinProcessStartListing("Fri Feb 29 12:00:00 2024")).toBe(String(Date.UTC(2024, 1, 29, 12, 0, 0) / 1000));
  });



  test("no ps failure against a live process is ever converted into proof of death", async () => {
    // `pid` is this very process, so the kernel can always contradict a wrong
    // absence claim. Every shape of failed run must stay indeterminate.
    const ambiguous: Array<[string, PsLstartRun]> = [
      ["timed out and killed, no output", { stdout: "", failed: true, incomplete: true }],
      ["failed to spawn", { stdout: "", failed: true, incomplete: true }],
      ["non-zero exit with no output", { stdout: "", failed: true, incomplete: false }],
      ["non-zero exit with output", { stdout: "Fri Jul 24 23:05:12 2026\n", failed: true, incomplete: false }],
      ["completed but unparsable", { stdout: "who knows\n", failed: false, incomplete: false }],
    ];
    for (const [label, run] of ambiguous) {
      const failure = await darwinProcessStartForTests(process.pid, async () => run).then(() => undefined, (error: unknown) => error);
      expect(failure, label).toBeInstanceOf(Error);
      // ESRCH is the one code probeProcess accepts as death without asking the
      // kernel a second time, so no ambiguous run may ever carry it.
      expect((failure as NodeJS.ErrnoException).code, label).not.toBe("ESRCH");
    }
  });

  test("an empty listing reports death only when the kernel confirms the process is gone", async () => {
    const empty: PsLstartRun = { stdout: "", failed: true, incomplete: false };

    // A pid the kernel confirms is gone: 0 is never a probeable process id here.
    const gone = await darwinProcessStartForTests(2_147_483_646, async () => empty).then(() => undefined, (error: unknown) => error);
    expect((gone as NodeJS.ErrnoException).code).toBe("ESRCH");

    // The same empty listing against a live pid must NOT claim death.
    const live = await darwinProcessStartForTests(process.pid, async () => empty).then(() => undefined, (error: unknown) => error);
    expect((live as NodeJS.ErrnoException).code).not.toBe("ESRCH");
  });


  test("neither probe answering never classifies a live process dead, whatever the primary's errno", async () => {
    const ambiguousPs: PsLstartRun = { stdout: "", failed: true, incomplete: true };
    // A live pid that is NOT our own: the self-pid uptime fallback would answer
    // for `process.pid` and hide the classification this test is about.
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const livePid = child.pid!;
    try {
    // ENOENT and ESRCH are the two codes probeProcess accepts as death WITHOUT
    // the corroborating kill(pid, 0), so a primary that merely failed to spawn
    // must not be allowed to escape carrying one of them.
    for (const code of ["ENOENT", "ESRCH", "EPERM", "EACCES", undefined]) {
      const sysctl = async (): Promise<Buffer> => {
        const error = new Error("primary reading failed") as NodeJS.ErrnoException;
        if (code) error.code = code;
        throw error;
      };
      // End to end first: the real classifier must reach the corroborating path.
      const probe = await probeProcessForTests(livePid, (pid) => darwinProcessStartForTests(pid, async () => ambiguousPs, sysctl));
      expect(probe.status, code ?? "no code").not.toBe("dead");

      // Then the mechanism: nothing carrying either short-circuit code escapes.
      const escaped = await darwinProcessStartForTests(livePid, async () => ambiguousPs, sysctl)
        .then(() => undefined, (error: unknown) => error as NodeJS.ErrnoException);
      expect(escaped?.code, code ?? "no code").not.toBe("ENOENT");
      expect(escaped?.code, code ?? "no code").not.toBe("ESRCH");
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a kernel-confirmed absence still reports death through the whole darwin chain", async () => {
    const sysctl = async (): Promise<Buffer> => {
      const error = new Error("primary reading failed") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    };
    // A completed ps run that named no process, for a pid the kernel confirms gone.
    const empty: PsLstartRun = { stdout: "", failed: true, incomplete: false };
    const probe = await probeProcessForTests(2_147_483_646, (pid) => darwinProcessStartForTests(pid, async () => empty, sysctl));
    expect(probe.status).toBe("dead");
  });

  test("start-time readings compare at the coarser of their two resolutions", () => {
    // The same live process read through sysctl and then through ps.
    expect(compareProcessStart("1785539112.123456", "1785539112")).toBe("same");
    expect(compareProcessStart("1785539112", "1785539112.123456")).toBe("same");
    expect(compareProcessStart("1785539112.123456", "1785539112.123456")).toBe("same");
    // A genuinely different incarnation still reads as different.
    expect(compareProcessStart("1785539112.123456", "1785539113")).toBe("different");
    expect(compareProcessStart("1785539112.123456", "1785539112.123457")).toBe("different");
    // Linux tick-since-boot values are unaffected by the microsecond rule.
    expect(compareProcessStart("6318242", "6318242")).toBe("same");
    expect(compareProcessStart("6318242", "6318243")).toBe("different");
  });

  test("a microsecond-clock reading is incomparable with a second clock, never dead", () => {
    // What pre-ps binaries recorded for their own pid when sysctl failed.
    const uptimeFallback = "1785539112000000";
    expect(compareProcessStart(uptimeFallback, "1785539112")).toBe("incomparable");
    expect(compareProcessStart(uptimeFallback, "1785539112.123456")).toBe("incomparable");
    expect(compareProcessStart("1785539112", uptimeFallback)).toBe("incomparable");
    expect(compareProcessStart(uptimeFallback, uptimeFallback)).toBe("same");
  });

  test("an incarnation read through the other clock stays alive, and an unreadable one stays unknown", async () => {
    const owner = { ...current, pid: 900, startTime: "1785539112.123456" };
    // sysctl-recorded owner, ps-probed: the same live process.
    expect(await classifyProcessIncarnation(owner, identity({ 900: { status: "alive", startTime: "1785539112" } }))).toBe("alive");
    // A real restart within the same second is still caught by the fraction.
    expect(await classifyProcessIncarnation(owner, identity({ 900: { status: "alive", startTime: "1785539113" } }))).toBe("dead");
    // A pre-ps microsecond reading cannot be reconciled and must not reap.
    expect(await classifyProcessIncarnation({ ...owner, startTime: "1785539112000000" }, identity({ 900: { status: "alive", startTime: "1785539112" } }))).toBe("unknown");
  });

  test("a live lock whose marker was written through the other clock is never reaped", async () => {
    const root = await tempDir();
    const lockPath = path.join(root, "sync.lock");
    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 900, startTime: "1785539112.123456", token: "7".repeat(32) })));

    const live = await inspectLock(lockPath, identity({ 900: { status: "alive", startTime: "1785539112" } }), async () => true);
    expect(live.kind).toBe("live");

    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 900, startTime: "1785539112000000", token: "7".repeat(32) })));
    const unreadable = await inspectLock(lockPath, identity({ 900: { status: "alive", startTime: "1785539112" } }), async () => true);
    expect(unreadable).toMatchObject({ kind: "foreign", reason: "process start clock unavailable" });

    await fs.writeFile(lockPath, formatLockMarker(marker({ pid: 900, startTime: "1785539112.123456", token: "7".repeat(32) })));
    const restarted = await inspectLock(lockPath, identity({ 900: { status: "alive", startTime: "1785539200" } }), async () => true);
    expect(restarted.kind).toBe("dead");
  });

  test.skipIf(process.platform !== "darwin")("the live darwin probe reads a foreign process and repeats itself exactly", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      const first = await systemLockIdentity.probe(child.pid!);
      const second = await systemLockIdentity.probe(child.pid!);
      expect(first.status).toBe("alive");
      expect(second).toEqual(first);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
