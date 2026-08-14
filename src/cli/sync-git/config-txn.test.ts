import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_GIT_CONFIG_FILE_BYTES, type GitConfig } from "./config-sync.js";
import {
  applyConfigTransaction,
  classifyConfigFsError,
  materializeFreshGitConfig,
  readConfigSnapshot,
  readParsedConfigSnapshot,
  sweepConfigTransactionOrphans,
  type GitConfigRunner,
} from "./config-txn.js";
import { acquireLock, formatLockMarker, type LockIdentitySource, type ProcessProbe } from "../../engine/lockfile.js";
import { gitRaw } from "../../engine/git-spawn.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const roots: string[] = [];
const current = { hostId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", bootId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", pid: 800, startTime: "100" };

function identity(probes: Record<number, ProcessProbe> = {}): LockIdentitySource {
  return {
    current: async () => current,
    probe: async (pid) => probes[pid] ?? (pid === current.pid ? { status: "alive", startTime: current.startTime } : { status: "dead" }),
  };
}

const desired: GitConfig = {
  "branch.main.merge": ["refs/heads/main"],
  "branch.main.remote": ["origin"],
  "remote.origin.fetch": ["+refs/heads/*:refs/remotes/origin/*"],
  "remote.origin.url": ["https://example.com/repo.git"],
};

async function tempDir(prefix = "rbox-config-txn-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initRepo(): Promise<{ repo: string; configPath: string }> {
  const repo = await tempDir();
  await exec("git", ["-C", repo, "init", "-q"], { env: TEST_GIT_ENV });
  return { repo, configPath: path.join(repo, ".git", "config") };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("§4 bounded read dispositions", () => {
  test("classifies every named errno bucket", () => {
    for (const code of ["EACCES", "EPERM"]) expect(classifyConfigFsError(Object.assign(new Error(code), { code }))).toMatchObject({ disposition: "permanent", reason: "permission" });
    expect(classifyConfigFsError(Object.assign(new Error("loop"), { code: "ELOOP" }))).toMatchObject({ disposition: "permanent", reason: "symlink" });
    expect(classifyConfigFsError(Object.assign(new Error("missing"), { code: "ENOENT" }))).toMatchObject({ disposition: "transient", reason: "missing" });
    expect(classifyConfigFsError(Object.assign(new Error("io"), { code: "EIO" }))).toMatchObject({ disposition: "transient", reason: "read-error" });
  });

  test("stable over-cap is permanent at gate 0 and transient at locked B2", async () => {
    const root = await tempDir();
    const configPath = path.join(root, "config");
    await fs.writeFile(configPath, Buffer.alloc(MAX_GIT_CONFIG_FILE_BYTES + 1));
    expect(await readConfigSnapshot(configPath, "initial")).toMatchObject({ ok: false, fault: { disposition: "permanent", reason: "over-cap" } });
    expect(await readConfigSnapshot(configPath, "locked")).toMatchObject({ ok: false, fault: { disposition: "transient", reason: "over-cap" } });
  });

  test("a symlink is permanently refused without following it", async () => {
    const root = await tempDir();
    const target = path.join(root, "target");
    const link = path.join(root, "config");
    await fs.writeFile(target, "secret");
    await fs.symlink(target, link);
    expect(await readConfigSnapshot(link)).toMatchObject({ ok: false, fault: { disposition: "permanent", reason: "symlink" } });
  });
});

describe("snapshot-file parsing", () => {
  test("Git receives a bounded same-dir snapshot path, never the live config", async () => {
    const { repo, configPath } = await initRepo();
    await exec("git", ["-C", repo, "config", "remote.origin.url", "https://example.com/repo.git"], { env: TEST_GIT_ENV });
    let parsedPath = "";
    const runner: GitConfigRunner = async (root, args) => {
      parsedPath = args[2]!;
      expect(parsedPath).not.toBe(configPath);
      expect(path.dirname(parsedPath)).toBe(path.dirname(configPath));
      expect(await fs.readFile(parsedPath)).toEqual(await fs.readFile(configPath));
      return gitRaw(root, args);
    };
    const result = await readParsedConfigSnapshot(repo, configPath, "initial", runner);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.entries).toContainEqual(["remote.origin.url", "https://example.com/repo.git"]);
    expect(await fs.lstat(parsedPath).catch(() => undefined)).toBeUndefined();
  });
});

describe("optimistic config transaction", () => {
  test("add-only fill commits through a final-path-fsynced candidate", async () => {
    const { repo, configPath } = await initRepo();
    let fsyncedCandidate = "";
    const result = await applyConfigTransaction(repo, configPath, desired, {
      identity: identity(),
      hooks: { afterCandidateFsync: (candidate) => { fsyncedCandidate = candidate; } },
    });
    expect(result.status).toBe("completed");
    expect(fsyncedCandidate).toContain("config.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-800-100-");
    expect(await fs.lstat(fsyncedCandidate).catch(() => undefined)).toBeUndefined();
    expect(await gitRaw(repo, ["config", "--local", "--get-all", "remote.origin.url"])).toBe("https://example.com/repo.git\n");
    expect(result).toMatchObject({ status: "completed", post: { ok: true, config: desired } });
  });

  test("present keys are untouched and missing keys receive every value in order", async () => {
    const { repo, configPath } = await initRepo();
    await exec("git", ["-C", repo, "config", "remote.origin.url", "https://local.example/repo.git"], { env: TEST_GIT_ENV });
    const input: GitConfig = { ...desired, "remote.origin.fetch": ["refs/heads/main:refs/remotes/origin/main", "+refs/heads/*:refs/remotes/origin/*"] };
    const result = await applyConfigTransaction(repo, configPath, input, { identity: identity() });
    expect(result.status).toBe("completed");
    expect(await gitRaw(repo, ["config", "--local", "--get-all", "remote.origin.url"])).toBe("https://local.example/repo.git\n");
    expect((await gitRaw(repo, ["config", "--local", "--get-all", "remote.origin.fetch"])).split("\n").filter(Boolean)).toEqual(input["remote.origin.fetch"]!);
  });

  test("symlinked config disables at gate 0", async () => {
    const { repo, configPath } = await initRepo();
    const real = path.join(path.dirname(configPath), "real-config");
    await fs.rename(configPath, real);
    await fs.symlink(real, configPath);
    expect(await applyConfigTransaction(repo, configPath, desired, { identity: identity() })).toMatchObject({ status: "disabled", fault: { reason: "symlink" } });
  });

  test("unsupported link() permanently disables the lane", async () => {
    const { repo, configPath } = await initRepo();
    const result = await applyConfigTransaction(repo, configPath, desired, {
      identity: identity(),
      lock: { hooks: { link: async () => { throw Object.assign(new Error("unsupported"), { code: "EOPNOTSUPP" }); } } },
    });
    expect(result).toMatchObject({ status: "disabled", fault: { disposition: "permanent", reason: "lock-unsupported" } });
  });

  test("symlink introduced at locked B2 permanently disables", async () => {
    const { repo, configPath } = await initRepo();
    const real = path.join(path.dirname(configPath), "real-config");
    let changed = false;
    const result = await applyConfigTransaction(repo, configPath, desired, {
      identity: identity(),
      hooks: {
        afterLock: async () => {
          if (changed) return;
          changed = true;
          await fs.rename(configPath, real);
          await fs.symlink(real, configPath);
        },
      },
    });
    expect(result).toMatchObject({ status: "disabled", fault: { disposition: "permanent", reason: "symlink" } });
  });

  test("B2 != B1 retries three times and defers", async () => {
    const { repo, configPath } = await initRepo();
    const original = await fs.readFile(configPath);
    const result = await applyConfigTransaction(repo, configPath, desired, {
      identity: identity(),
      hooks: { afterLock: async (_lock, attempt) => fs.appendFile(configPath, `# edit ${attempt}\n`) },
      retryDelay: async () => fs.writeFile(configPath, original),
    });
    expect(result).toMatchObject({ status: "deferred", attempts: 3, fault: { disposition: "transient", reason: "bytes-changed" } });
  });

  test("a foreign busy lock retries three times, defers, and remains untouched", async () => {
    const { repo, configPath } = await initRepo();
    await fs.writeFile(`${configPath}.lock`, "git-owned");
    const result = await applyConfigTransaction(repo, configPath, desired, { identity: identity() });
    expect(result).toMatchObject({ status: "deferred", attempts: 3, fault: { reason: "lock-busy" } });
    expect(await fs.readFile(`${configPath}.lock`, "utf8")).toBe("git-owned");
    expect((await fs.readdir(path.dirname(configPath))).filter((name) => name.endsWith(".rbox93"))).toEqual([]);
  });

  test("config disappearing at locked B2 is transient", async () => {
    const { repo, configPath } = await initRepo();
    const result = await applyConfigTransaction(repo, configPath, desired, {
      attempts: 1,
      identity: identity(),
      hooks: { afterLock: async () => fs.unlink(configPath) },
    });
    expect(result).toMatchObject({ status: "deferred", fault: { disposition: "transient", reason: "missing" } });
  });

  test("growth past 1 MiB between B1 and B2 retries then defers", async () => {
    const { repo, configPath } = await initRepo();
    const original = await fs.readFile(configPath);
    const result = await applyConfigTransaction(repo, configPath, desired, {
      identity: identity(),
      hooks: { afterLock: async () => fs.writeFile(configPath, Buffer.alloc(MAX_GIT_CONFIG_FILE_BYTES + 1)) },
      retryDelay: async () => fs.writeFile(configPath, original),
    });
    expect(result).toMatchObject({ status: "deferred", attempts: 3, fault: { disposition: "transient", reason: "over-cap" } });
  });

  test("owner re-check aborts a stolen lock before rename", async () => {
    const { repo, configPath } = await initRepo();
    const before = await fs.readFile(configPath);
    const result = await applyConfigTransaction(repo, configPath, desired, {
      attempts: 1,
      identity: identity(),
      hooks: {
        beforeOwnerRecheck: async (lockPath) => {
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, "git-owned");
        },
      },
    });
    expect(result).toMatchObject({ status: "deferred", fault: { reason: "owner-lost" } });
    expect(await fs.readFile(configPath)).toEqual(before);
    expect(await fs.readFile(`${configPath}.lock`, "utf8")).toBe("git-owned");
  });

  test("post-rename unlink failure is success and stale-ours is reaped next cycle", async () => {
    const { repo, configPath } = await initRepo();
    let failOnce = true;
    const lockHooks = {
      beforeReleaseUnlink: (lockPath: string) => {
        if (lockPath === `${configPath}.lock` && failOnce) {
          failOnce = false;
          throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
        }
      },
    };
    const result = await applyConfigTransaction(repo, configPath, desired, { identity: identity(), lock: { hooks: lockHooks } });
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.warnings.length).toBeGreaterThan(0);
    expect(await fs.lstat(`${configPath}.lock`)).toBeDefined();
    const next = await acquireLock(`${configPath}.lock`, { identity: identity(), hooks: lockHooks, token: () => "f".repeat(32) });
    expect(next.status).toBe("acquired");
    if (next.status === "acquired") await next.lock.release();
  });

  test("a user edit after release changes cfgToken", async () => {
    const { repo, configPath } = await initRepo();
    const result = await applyConfigTransaction(repo, configPath, desired, { identity: identity() });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    await fs.appendFile(configPath, "# user edit\n");
    const edited = await readConfigSnapshot(configPath);
    expect(edited.ok).toBe(true);
    if (edited.ok) expect(edited.snapshot.token).not.toEqual(result.postToken);
  });
});

describe("candidate orphan sweep", () => {
  test("removes dead same-host incarnations and old malformed names, sparing live/cross-host/unknown", async () => {
    const root = await tempDir();
    const configPath = path.join(root, "config");
    await fs.writeFile(configPath, "");
    const token = "1".repeat(32);
    const names = {
      dead: `config.${current.hostId}-801-10-${token}.rbox93`,
      deadLock: `config.${current.hostId}-801-10-${token}.rbox93.lock`,
      live: `config.${current.hostId}-802-20-${token}.rbox93`,
      unknown: `config.${current.hostId}-803-30-${token}.rbox93`,
      cross: `config.cccccccc-cccc-cccc-cccc-cccccccccccc-804-40-${token}.rbox93`,
      malformed: "config.unparseable.rbox93",
      youngMalformed: "config.young.rbox93",
    };
    for (const name of Object.values(names)) await fs.writeFile(path.join(root, name), name);
    const now = Date.now();
    await fs.utimes(path.join(root, names.malformed), new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    const source = identity({
      801: { status: "dead" },
      802: { status: "alive", startTime: "20" },
      803: { status: "unknown" },
    });
    const swept = await sweepConfigTransactionOrphans(configPath, source, now);
    expect(swept.removed.sort()).toEqual([names.dead, names.deadLock, names.malformed].sort());
    for (const name of [names.live, names.unknown, names.cross, names.youngMalformed]) expect(await fs.lstat(path.join(root, name))).toBeDefined();
  });
});

describe("fresh materialization", () => {
  test("uses plain --local --add and cleans the fresh target on failure", async () => {
    const { repo } = await initRepo();
    const seen: string[][] = [];
    await materializeFreshGitConfig(repo, desired, repo, async (root, args) => {
      seen.push(args);
      return gitRaw(root, args);
    });
    expect(seen.every((args) => args[0] === "config" && args[1] === "--local" && args[2] === "--add")).toBe(true);

    const doomed = await tempDir("rbox-config-fresh-");
    await exec("git", ["-C", doomed, "init", "-q"], { env: TEST_GIT_ENV });
    let calls = 0;
    await expect(materializeFreshGitConfig(doomed, desired, doomed, async () => {
      if (++calls === 2) throw new Error("git failed");
      return "";
    })).rejects.toThrow("git failed");
    expect(await fs.lstat(doomed).catch(() => undefined)).toBeUndefined();
  });
});
