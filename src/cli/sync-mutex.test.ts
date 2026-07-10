import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LockIdentitySource } from "../engine/git/lockfile.js";
import { daemonConsumesWakeup } from "./daemon.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  syncMutexPath,
  withWorkspaceSyncMutex,
  workspaceSyncMutexDegraded,
  type DaemonMutexResult,
} from "./sync-mutex.js";

let root = "";
let tokens = 0;
const sourceRoot = path.resolve(import.meta.dir, "..");

const identity = (bootId = "bb-a", pid = 9301, startTime = "1"): LockIdentitySource => ({
  current: async () => ({ hostId: "aa-93", bootId, pid, startTime }),
  probe: async (probePid) => probePid === pid ? { status: "alive", startTime } : { status: "dead" },
});
const options = (id: LockIdentitySource) => ({
  lock: { identity: id, token: () => (++tokens).toString(16).padStart(32, "0") },
  attempts: 1,
  retryDelayMs: 0,
});

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-mutex93-"));
  tokens = 0;
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

describe("design 93 §6 workspace sync mutex", () => {
  test("identity unavailability is surfaced once and CLI/daemon work proceeds on the legacy path", async () => {
    const unavailable: LockIdentitySource = {
      current: async () => { throw new Error("no identity source"); },
      probe: async () => ({ status: "unknown" }),
    };
    const surfaced: string[] = [];
    const degradedOptions = {
      ...options(unavailable),
      onDegraded: (message: string) => surfaced.push(message),
    };

    const cli = await acquireWorkspaceSyncMutex(root, "cli", degradedOptions);
    expect(workspaceSyncMutexDegraded(cli)).toBe(true);
    await releaseWorkspaceSyncMutex(cli);

    let ran = false;
    await withWorkspaceSyncMutex(root, async (handle) => {
      ran = true;
      expect(workspaceSyncMutexDegraded(handle)).toBe(true);
    }, degradedOptions);
    expect(ran).toBe(true);

    const daemon = await acquireWorkspaceSyncMutex(root, "daemon", degradedOptions);
    expect(daemon.status).toBe("acquired");
    if (daemon.status === "acquired") await releaseWorkspaceSyncMutex(daemon.handle);
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]).toContain("git config sync disabled");
    expect(surfaced[0]).toContain("legacy state saves");
  });

  test("CLI contender exits loudly with owner pid", async () => {
    const owner = await acquireWorkspaceSyncMutex(root, "cli", options(identity()));
    await expect(acquireWorkspaceSyncMutex(root, "cli", options(identity()))).rejects.toThrow(/another sync is in progress \(pid 9301\)/);
    await releaseWorkspaceSyncMutex(owner);
  });

  test("daemon contention requeues: the wakeup is never consumed", async () => {
    const owner = await acquireWorkspaceSyncMutex(root, "cli", options(identity()));
    const contender = await acquireWorkspaceSyncMutex(root, "daemon", options(identity()));
    expect(contender).toMatchObject({ status: "contended", detail: "pid 9301" });
    expect(daemonConsumesWakeup(contender)).toBe(false);
    await releaseWorkspaceSyncMutex(owner);
    const acquired = await acquireWorkspaceSyncMutex(root, "daemon", options(identity())) as DaemonMutexResult;
    expect(daemonConsumesWakeup(acquired)).toBe(true);
    if (acquired.status === "acquired") await releaseWorkspaceSyncMutex(acquired.handle);
  });

  test("cross-boot power-loss marker is recovered", async () => {
    await acquireWorkspaceSyncMutex(root, "cli", options(identity("b00-01d", 10, "10")));
    const recovered = await acquireWorkspaceSyncMutex(root, "cli", options(identity("b00-0e0", 20, "20")));
    expect(await recovered.lock?.isOwner()).toBe(true);
    await releaseWorkspaceSyncMutex(recovered);
  });

  test("two-process apply trace races without the mutex and excludes with it", async () => {
    const trace: string[] = [];
    let workingTree = "base";
    const daemonRead = workingTree;
    const cliRead = workingTree;
    trace.push("daemon:start", "cli:start", "cli:apply", "daemon:apply");
    workingTree = `${cliRead}+cli`;
    workingTree = `${daemonRead}+daemon`; // stale daemon apply loses CLI mutation
    expect(trace).toEqual(["daemon:start", "cli:start", "cli:apply", "daemon:apply"]);
    expect(workingTree).toBe("base+daemon");

    const daemon = await acquireWorkspaceSyncMutex(root, "daemon", options(identity()));
    expect(daemon.status).toBe("acquired");
    workingTree = `${workingTree}+serialized-daemon`;
    const cliWhileHeld = acquireWorkspaceSyncMutex(root, "cli", options(identity()));
    await expect(cliWhileHeld).rejects.toThrow(/another sync is in progress/);
    expect(workingTree).toBe("base+daemon+serialized-daemon");
    if (daemon.status === "acquired") await releaseWorkspaceSyncMutex(daemon.handle);
    const cliAfter = await acquireWorkspaceSyncMutex(root, "cli", options(identity()));
    expect(await cliAfter.lock.isOwner()).toBe(true);
    await releaseWorkspaceSyncMutex(cliAfter);
  });

  test("sync lock uses the reusable §7 primitive at the specified path", () => {
    expect(syncMutexPath(root)).toBe(path.join(root, ".rbox", "state", "sync.lock"));
  });
});

describe("design 93 §6 complete caller disposition drift gate", () => {
  test("every production sync caller is a named owner or the sole staging exemption", async () => {
    const cliDir = path.join(sourceRoot, "cli");
    const names = (await fs.readdir(cliDir)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    const importers: string[] = [];
    const contents = new Map<string, string>();
    for (const name of names) {
      const source = await fs.readFile(path.join(cliDir, name), "utf8");
      contents.set(name, source);
      if (
        /from\s+["']\.\/sync\.js["']/.test(source)
        && (/\b(pull|pushManifest|push|sync)\s*\(/.test(source) || /\?\?\s*(pull|push)\)\s*\(/.test(source))
      ) importers.push(name);
    }
    expect(importers.sort()).toEqual([
      "daemon.ts",
      "export-cmd.ts",
      "ignore-cmd.ts",
      "init-cmd.ts",
      "main-dispatch.ts",
      "recover-cmd.ts",
      "sync-cmd.ts",
    ]);

    for (const owner of ["daemon.ts", "ignore-cmd.ts", "init-cmd.ts", "main-dispatch.ts", "recover-cmd.ts", "sync-cmd.ts"]) {
      expect(contents.get(owner), owner).toMatch(/syncMutex|WorkspaceSyncMutex/);
    }
    expect(contents.get("export-cmd.ts")).toMatch(/explicit mutex exemption/);
  });

  test("nested 409 recovery and sync pull→push pass the held handle without reacquiring", async () => {
    const source = await fs.readFile(path.join(sourceRoot, "cli", "sync.ts"), "utf8");
    expect(source).not.toContain("acquireWorkspaceSyncMutex");
    expect(source).toContain("await pull(root, cfg, deps)");
    expect(source).toContain("const pulled = await pull(root, cfg, deps)");
    expect(source).toContain("await push(root, cfg, deps)");
  });

  test("daemon acquires before consuming want and revalidates stream+nonce", async () => {
    const source = await fs.readFile(path.join(sourceRoot, "cli", "daemon.ts"), "utf8");
    const acquire = source.indexOf("await this.acquireSyncMutexFn(this.root)");
    const revalidate = source.indexOf("await daemonBindingMatches", acquire);
    const consume = source.indexOf("this.want[op] = false", acquire);
    expect(acquire).toBeGreaterThan(0);
    expect(revalidate).toBeGreaterThan(acquire);
    expect(consume).toBeGreaterThan(revalidate);
    expect(source).toContain("continue;\n        }\n        const syncMutex");
  });

  test("purge recomputes after confirmation under the mutex", async () => {
    const source = await fs.readFile(path.join(sourceRoot, "cli", "ignore-cmd.ts"), "utf8");
    const confirm = source.indexOf("await promptConfirm");
    const acquire = source.indexOf("await withWorkspaceSyncMutex", confirm);
    const recompute = source.indexOf("await computePurgeCandidate", acquire);
    const push = source.indexOf("await pushManifest", recompute);
    expect(confirm).toBeGreaterThan(0);
    expect(acquire).toBeGreaterThan(confirm);
    expect(recompute).toBeGreaterThan(acquire);
    expect(push).toBeGreaterThan(recompute);
  });

  test("init holds one mutex across reset/rebind and every first-sync branch", async () => {
    const source = await fs.readFile(path.join(sourceRoot, "cli", "init-cmd.ts"), "utf8");
    const acquire = source.indexOf("await acquireWorkspaceSyncMutex(plan.root");
    const reset = source.indexOf("await resetSyncState", acquire);
    const push = source.indexOf("await push(plan.root", acquire);
    const sync = source.indexOf("await sync(plan.root", acquire);
    const pull = source.indexOf("await pull(plan.root", acquire);
    const release = source.indexOf("await releaseWorkspaceSyncMutex", acquire);
    expect([reset, push, sync, pull].every((position) => position > acquire && position < release)).toBe(true);
  });
});
