import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adoptCmd, adoptionStatus } from "./adopt-cmd.js";
import { acknowledgeCacheGeneration, invalidateAdoptionCaches, readCacheGeneration } from "./adopt-cache.js";
import {
  consumeAdoptConsent,
  mintHeadlessAdoptConsent,
  mintInteractiveAdoptConsent,
  mintWizardAdoptConsent,
} from "./adopt-consent.js";
import { inventoryAdoptionSource } from "./adopt-inventory.js";
import { abortAdoption, continueAdoption, pinAdoptionFolderPolicy, refreshAdoptionContinuation, startAdoption } from "./adopt-lifecycle.js";
import { adoptDisplacedDir, adoptJournalPath, findAdoptRoot, inspectAdoptFence, loadAdoptJournal, saveAdoptJournal } from "./adopt-journal.js";
import { saveConfig, syncStreamId } from "./config.js";
import { bindingRegistryPath } from "./rbox-paths.js";
import {
  acquireWorkspaceSyncMutex,
  acquireWorkspaceSyncMutexForAdopt,
  assertSyncMutex,
  releaseWorkspaceSyncMutex,
  type WorkspaceSyncMutex,
} from "./sync-mutex.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function sourceRoot(name = "rbox-adopt-life-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  roots.push(root);
  await fs.writeFile(path.join(root, "local.txt"), "B\n");
  return root;
}

async function start(root: string, mutex: WorkspaceSyncMutex) {
  const inventory = await inventoryAdoptionSource(root);
  return startAdoption({
    root, rootReal: await fs.realpath(root), stream: "stream", workspaceId: "ws", projectId: "root",
    remoteUrl: "https://example.invalid", deviceId: "dev", syncGit: false, respectGitignore: false,
  }, inventory, mutex);
}

describe("design 166 consent and lifecycle", () => {
  test("interactive, wizard, and explicit headless witnesses are bound and single-use", async () => {
    const expected = { root: "/tmp/adopt-consent", stream: "stream", workspaceId: "ws" };
    for (const witness of [
      mintInteractiveAdoptConsent(expected),
      mintWizardAdoptConsent(expected),
      mintHeadlessAdoptConsent(expected),
    ]) {
      expect(consumeAdoptConsent(witness, expected).consumed).toBe(true);
      expect(() => consumeAdoptConsent(witness, expected)).toThrow("already used");
    }
    const wrong = mintHeadlessAdoptConsent(expected);
    expect(() => consumeAdoptConsent(wrong, { ...expected, workspaceId: "other" })).toThrow("does not match");
  });

  test("phase 0/1 publishes a direct-path journal, retains B, and globally fences ordinary owners", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    expect(journal.phase).toBe("baseline");
    expect(await fs.readFile(path.join(root, ".rbox", "adopt", "stash", "local.txt"), "utf8")).toBe("B\n");
    expect(await fs.lstat(path.join(root, "local.txt")).then(() => true, () => false)).toBe(false);
    expect(await findAdoptRoot(path.join(root, ".rbox", "adopt", "stash"))).toBe(root);
    expect((await inspectAdoptFence(root)).status).toBe("active");
    expect(() => assertSyncMutex(mutex, root)).toThrow("active baseline continuation");
    await releaseWorkspaceSyncMutex(mutex);
    await expect(acquireWorkspaceSyncMutex(root, "cli", { attempts: 1 })).rejects.toThrow("adopt status|resume|abort");
    const status = await adoptionStatus(root);
    expect(status.phase).toBe("baseline");
    expect(status.retained).toContain(path.join(root, ".rbox", "adopt", "stash", "local.txt"));
  });

  test("baseline → overlay → invalidation → complete precedes the ordinary finish sync", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    const stateDir = path.join(root, ".rbox", "state");
    await Promise.all([
      fs.writeFile(path.join(stateDir, "hashcache.json"), "warm"),
      fs.writeFile(path.join(stateDir, "dircache.json"), "warm"),
      fs.writeFile(path.join(stateDir, "scan-probe.json"), "warm"),
      fs.writeFile(path.join(stateDir, "git-divergence.json"), "warm"),
      fs.mkdir(path.join(stateDir, "git-tracked"), { recursive: true }),
    ]);
    await fs.writeFile(path.join(stateDir, "git-tracked", "repo.json"), "warm");
    let baselineCalls = 0;
    let finishObserved: { phase: string; bytes: string; cacheGone: boolean } | undefined;
    const completed = await continueAdoption(journal, mutex, {
      establishBaseline: async (_journal, held) => {
        baselineCalls++;
        // Top-level sync plus its nested pull and push borrow one active nonce.
        assertSyncMutex(held, root);
        assertSyncMutex(held, root);
        assertSyncMutex(held, root);
        await fs.writeFile(path.join(root, "local.txt"), "A\n");
        await fs.writeFile(path.join(root, "a-only.txt"), "A only\n");
      },
      finishSync: async (current) => {
        finishObserved = {
          phase: current.phase,
          bytes: await fs.readFile(path.join(root, "local.txt"), "utf8"),
          cacheGone: !await fs.lstat(path.join(stateDir, "hashcache.json")).then(() => true, () => false),
        };
      },
    });
    expect(baselineCalls).toBe(1);
    expect(completed.phase).toBe("complete");
    expect(completed.cache.invalidated).toBe(true);
    expect(completed.cache.generationAfter).toBe(1);
    expect(finishObserved).toEqual({ phase: "complete", bytes: "B\n", cacheGone: true });
    expect(await fs.readFile(path.join(root, "a-only.txt"), "utf8")).toBe("A only\n");
    expect(await fs.readFile(path.join(adoptDisplacedDir(root), "local.txt"), "utf8")).toBe("A\n");
    expect((await inspectAdoptFence(root)).status).toBe("terminal");
    expect(() => assertSyncMutex(mutex, root)).not.toThrow();
    await releaseWorkspaceSyncMutex(mutex);
    const ordinary = await acquireWorkspaceSyncMutex(root, "cli", { attempts: 1 });
    await releaseWorkspaceSyncMutex(ordinary);
  });

  test("ordinary finish failure does not roll back locally complete adoption", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    const completed = await continueAdoption(journal, mutex, {
      establishBaseline: async () => {},
      finishSync: async () => { throw new Error("capture subset deferred"); },
    });
    expect(completed.phase).toBe("complete");
    expect(completed.finishSync).toEqual({ attempted: true, complete: false, error: "capture subset deferred" });
    expect((await inspectAdoptFence(root)).status).toBe("terminal");
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("pre-baseline abort restores phase-1 moves exactly and invalidates caches before terminal", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    const aborted = await abortAdoption(journal, mutex);
    expect(aborted.phase).toBe("aborted");
    expect(aborted.cache.invalidated).toBe(true);
    expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("B\n");
    expect((await inspectAdoptFence(root)).status).toBe("terminal");
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("post-baseline abort keeps A live, returns B to retention, and restores displaced A", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    await continueAdoption(journal, mutex, {
      establishBaseline: async () => { await fs.writeFile(path.join(root, "local.txt"), "A\n"); },
      finishSync: async () => {},
    });
    const aborted = await abortAdoption(journal, mutex);
    expect(aborted.phase).toBe("aborted");
    expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("A\n");
    expect(await fs.readFile(path.join(root, ".rbox", "adopt", "stash", "local.txt"), "utf8")).toBe("B\n");
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("consumed baseline continuation rejects replay; validated resume mints a new nonce on the exact lock", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    journal.baseline.started = true;
    journal.baseline.consumed = true;
    journal.baseline.complete = false;
    await saveAdoptJournal(root, journal);
    await expect(continueAdoption(journal, mutex, { establishBaseline: async () => {}, finishSync: async () => {} })).rejects.toThrow("already consumed");
    const oldNonce = journal.baseline.continuationNonce;
    await refreshAdoptionContinuation(journal, mutex);
    expect(journal.baseline.continuationNonce).not.toBe(oldNonce);
    expect(journal.baseline.consumed).toBe(false);
    expect(journal.baseline.mutexIncarnation).toBe(mutex.incarnation);
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("recovery refuses degraded/substituted handles while read-only status remains available", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    const fake: WorkspaceSyncMutex = { root, incarnation: "degraded", degraded: { reason: "identity-unavailable" }, released: false };
    await expect(refreshAdoptionContinuation(journal, fake)).rejects.toThrow("non-degraded");
    expect((await adoptionStatus(root)).phase).toBe("baseline");
    await releaseWorkspaceSyncMutex(mutex);
    const recovery = await acquireWorkspaceSyncMutexForAdopt(root, "resume", journal.journalId);
    journal.baseline.mutexIncarnation = "substituted";
    await expect(continueAdoption(journal, recovery, { establishBaseline: async () => {}, finishSync: async () => {} })).rejects.toThrow("incarnation mismatch");
    await releaseWorkspaceSyncMutex(recovery);
  });

  test("cache generations are durable, monotonic, and owner-acknowledged", async () => {
    const root = await sourceRoot();
    await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
    const first = await invalidateAdoptionCaches(root, "adopt-complete");
    const second = await invalidateAdoptionCaches(root, "adopt-abort");
    expect(first).toEqual({ before: 0, after: 1 });
    expect(second).toEqual({ before: 1, after: 2 });
    await acknowledgeCacheGeneration(root, 2, "daemon-test");
    expect((await readCacheGeneration(root))?.acknowledgements["daemon-test"]?.generation).toBe(2);
  });

  test("intervening file writer produces a durable paused classifier instead of overwrite", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    await fs.writeFile(path.join(root, "local.txt"), "A\n");
    // Pre-record the overlay, then replace its retained source before execution.
    journal.phase = "overlay";
    const retained = path.join(root, ".rbox", "adopt", "stash", "local.txt");
    const before = journal.inventory.find((entry) => entry.path === "local.txt")!.identity;
    journal.overlayMoves.push({ path: "local.txt", source: "local.txt", destination: "local.txt", disposition: "displaced", displaced: "local.txt", sourceBefore: before, baselineBefore: await import("./adopt-journal.js").then((m) => m.readAdoptIdentity(path.join(root, "local.txt"), true)), state: "intent" });
    await fs.writeFile(retained, "writer changed B\n");
    await saveAdoptJournal(root, journal);
    const result = await continueAdoption(journal, mutex, { establishBaseline: async () => {}, finishSync: async () => {} });
    expect(result.phase).toBe("paused");
    expect(result.pauseReasons.join(" ")).toContain("identity mismatch");
    expect(await fs.readFile(path.join(root, "local.txt"), "utf8")).toBe("A\n");
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("new-adoption kill switch is isolated from unconditional journal fence and recovery surfaces", async () => {
    const [initSource, mutexSource, commandSource] = await Promise.all([
      fs.readFile(path.join(import.meta.dir, "init-cmd.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "sync-mutex.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "adopt-cmd.ts"), "utf8"),
    ]);
    expect(initSource).toContain('process.env.RBOX_ADOPT_OVERLAY !== "0"');
    expect(mutexSource).not.toContain("RBOX_ADOPT_OVERLAY");
    expect(commandSource).not.toContain("RBOX_ADOPT_OVERLAY");
  });

  test("daemon generation boundary drops resident state and performs an unpruned scan before acknowledgement", async () => {
    const daemon = await fs.readFile(path.join(import.meta.dir, "daemon", "daemon.ts"), "utf8");
    const boundary = daemon.indexOf("private async adoptionCacheGenerationBoundary");
    const fresh = daemon.indexOf("const fresh = new HashCache(", boundary);
    const matcher = daemon.indexOf("this.rebuildMatcher", fresh);
    const scan = daemon.indexOf('"unpruned"', matcher);
    const acknowledge = daemon.indexOf("await acknowledgeCacheGeneration", scan);
    expect(boundary).toBeGreaterThan(0);
    expect(fresh).toBeGreaterThan(boundary);
    expect(matcher).toBeGreaterThan(fresh);
    expect(scan).toBeGreaterThan(matcher);
    expect(acknowledge).toBeGreaterThan(scan);
  });

  test("crash-before-config direct path loads a validated journal without workspace discovery", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    expect(await fs.lstat(path.join(root, ".rbox", "workspace.json")).then(() => true, () => false)).toBe(false);
    expect((await loadAdoptJournal(root))?.journalId).toBe(journal.journalId);
    expect((await adoptionStatus(root)).journalId).toBe(journal.journalId);
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("pinned folder policy is optional, durable, and closed-codec validated", async () => {
    const root = await sourceRoot();
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    expect((await loadAdoptJournal(root))?.pinnedFolderPolicy).toBeUndefined();
    await pinAdoptionFolderPolicy(journal, "a".repeat(64), {
      syncGit: false,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 7, maxBytes: 1234 },
    }, mutex);
    expect((await loadAdoptJournal(root))?.pinnedFolderPolicy).toEqual({
      generation: "a".repeat(64),
      syncGit: false,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 7, maxBytes: 1234 },
    });
    const raw = JSON.parse(await fs.readFile(adoptJournalPath(root), "utf8"));
    raw.pinnedFolderPolicy.extra = true;
    await fs.writeFile(adoptJournalPath(root), JSON.stringify(raw));
    await expect(loadAdoptJournal(root)).rejects.toThrow("invalid adoption journal schema");
    await releaseWorkspaceSyncMutex(mutex);
  });

  test("resume with an unreproducible absent catalog refuses before authenticated sync", async () => {
    const root = await sourceRoot();
    const priorHome = process.env.RBOX_HOME;
    const rboxHome = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-authority-"));
    roots.push(rboxHome);
    process.env.RBOX_HOME = rboxHome;
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const journal = await start(root, mutex);
    const cfg = {
      schema: "e2ee/v1" as const,
      remoteWorkspaceId: journal.workspace.workspaceId,
      projectId: journal.workspace.projectId,
      deviceId: journal.workspace.deviceId,
      rootPath: root,
      remoteUrl: journal.workspace.remoteUrl,
      token: "",
      syncGit: journal.workspace.syncGit,
      respectGitignore: journal.workspace.respectGitignore,
    };
    journal.workspace.stream = syncStreamId(cfg);
    await saveConfig(root, cfg);
    await saveAdoptJournal(root, journal);
    await releaseWorkspaceSyncMutex(mutex);
    // A binding whose folder is gone is the row generation would have to drop,
    // so the absent catalog cannot be initialized silently (design 276 F1.3) —
    // and folder authority still speaks before any authenticated work.
    await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
    await fs.writeFile(bindingRegistryPath(), JSON.stringify({
      schemaVersion: 1,
      entries: [{
        root: path.join(rboxHome, "gone"),
        workspaceId: "ws_gone",
        boundAt: "2026-08-11T00:00:00.000Z",
        lastSeenAt: "2026-08-11T00:00:00.000Z",
      }],
    }));
    try {
      await expect(adoptCmd("resume", root)).rejects.toThrow("rbox config regenerate");
    } finally {
      if (priorHome === undefined) delete process.env.RBOX_HOME;
      else process.env.RBOX_HOME = priorHome;
    }
  });
});
