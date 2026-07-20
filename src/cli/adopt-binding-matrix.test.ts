import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { git } from "../engine/git/shared.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "./config.js";
import { adoptCmd, adoptionStatus } from "./adopt-cmd.js";
import { bindRetainedRepoIncarnations, runGitAdoption } from "./adopt-git.js";
import { inventoryAdoptionSource } from "./adopt-inventory.js";
import { continueAdoption, startAdoption } from "./adopt-lifecycle.js";
import { preflightInitRebind } from "./init-cmd.js";
import {
  ADOPT_VERSION,
  adoptStashDir,
  adoptUnplacedDir,
  readAdoptIdentity,
  type AdoptJournal,
  type AdoptSourceRepo,
} from "./adopt-journal.js";
import { runFileOverlay } from "./adopt-overlay.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "./sync-mutex.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function temp(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function configure(repo: string): Promise<void> {
  await git(repo, ["config", "user.name", "Matrix Test"]);
  await git(repo, ["config", "user.email", "matrix@example.invalid"]);
}
async function commit(repo: string, file: string, bytes: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), bytes);
  await git(repo, ["add", file]);
  await git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}
function source(pathname: string): AdoptSourceRepo {
  return { path: pathname, sourceKind: "dir", worktreeReal: "/pending", gitDirReal: "/pending", commonDirReal: "/pending", objectStoreReal: "/pending" };
}
async function journal(root: string, sourceRepos: AdoptSourceRepo[] = [], syncGit = true): Promise<AdoptJournal> {
  return {
    version: ADOPT_VERSION, journalId: "c".repeat(32), createdAt: new Date(0).toISOString(),
    workspace: { root, rootReal: await fs.realpath(root), stream: "stream", workspaceId: "ws", projectId: "root", remoteUrl: "https://example.invalid", deviceId: "dev", syncGit, respectGitignore: false },
    phase: sourceRepos.length ? "git" : "overlay", pauseReasons: [], inventory: [], sourceRepos, retainedBytes: "0", retainMoves: [],
    baseline: { started: true, complete: true, continuationNonce: "d".repeat(32), consumed: true, mutexIncarnation: "lock" },
    gitRepos: [], overlayMoves: [], createdDirectories: [], cache: { invalidated: false }, finishSync: { attempted: false, complete: false },
  };
}

describe("design 166 remaining binding matrix", () => {
  test("nested root/child Git unions preserve every phase-2 directory incarnation and exclude admin paths", async () => {
    const root = await temp("rbox-adopt-nested-");
    const targetParent = path.join(root, "repo");
    const targetChild = path.join(targetParent, "child");
    await fs.mkdir(targetChild, { recursive: true });
    for (const repo of [targetParent, targetChild]) {
      await git(repo, ["init", "-b", "main"]); await configure(repo); await commit(repo, "base.txt", `${repo}\n`, "base");
    }
    const stashParent = path.join(adoptStashDir(root), "repo");
    const stashChild = path.join(stashParent, "child");
    await fs.mkdir(path.dirname(stashParent), { recursive: true });
    await git(root, ["clone", "--no-local", targetParent, stashParent]);
    await fs.rm(stashChild, { recursive: true, force: true });
    await git(stashParent, ["clone", "--no-local", targetChild, stashChild]);
    for (const repo of [stashParent, stashChild]) { await configure(repo); await commit(repo, "ahead.txt", `${repo}\n`, "ahead"); }
    const before = await Promise.all([targetParent, targetChild, path.join(targetParent, ".git"), path.join(targetChild, ".git")].map((entry) => fs.lstat(entry, { bigint: true }).then((stat) => stat.ino)));
    const j = await journal(root, [source("repo"), source("repo/child")]);
    await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {});
    const after = await Promise.all([targetParent, targetChild, path.join(targetParent, ".git"), path.join(targetChild, ".git")].map((entry) => fs.lstat(entry, { bigint: true }).then((stat) => stat.ino)));
    expect(after).toEqual(before);
    expect(j.gitRepos.map((repo) => repo.state)).toEqual(["complete", "complete"]);
    expect(await fs.lstat(path.join(stashParent, ".git")).then(() => true, () => false)).toBe(true);
    expect(await fs.lstat(path.join(stashChild, ".git")).then(() => true, () => false)).toBe(true);
  });

  test("ordinary B source may advance only the scoped branch of a pointer target", async () => {
    const root = await temp("rbox-adopt-pointer-");
    const external = await temp("rbox-adopt-pointer-main-");
    await git(external, ["init", "-b", "main"]); await configure(external);
    await commit(external, "base.txt", "base\n", "base");
    const target = path.join(root, "repo");
    await git(external, ["worktree", "add", "-b", "scoped", target]);
    const stash = path.join(adoptStashDir(root), "repo");
    await fs.mkdir(path.dirname(stash), { recursive: true });
    await git(root, ["clone", "--no-local", "--branch", "scoped", target, stash]);
    await configure(stash);
    const incoming = await commit(stash, "base.txt", "incoming\n", "incoming");
    await git(stash, ["branch", "extra", "HEAD"]);
    await git(stash, ["tag", "retained-tag"]);
    const mainBefore = await git(external, ["rev-parse", "main"]);
    const j = await journal(root, [source("repo")]);
    await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {});
    expect(await git(target, ["rev-parse", "scoped"])).toBe(incoming);
    expect(await git(external, ["rev-parse", "main"])).toBe(mainBefore);
    expect(j.gitRepos[0]?.branches.map((branch) => branch.ref)).toEqual(["refs/heads/scoped"]);
    expect(j.gitRepos[0]?.retainedRefs).toEqual(expect.arrayContaining(["refs/heads/extra", "refs/tags/retained-tag"]));
  });

  test("linked-worktree ownership parks an otherwise eligible branch before fetch", async () => {
    const root = await temp("rbox-adopt-owned-");
    const target = path.join(root, "repo");
    await fs.mkdir(target); await git(target, ["init", "-b", "main"]); await configure(target);
    const base = await commit(target, "base", "base\n", "base");
    await git(target, ["branch", "owned", base]);
    const siblingRoot = await temp("rbox-adopt-owned-wt-");
    const sibling = path.join(siblingRoot, "owned");
    await git(target, ["worktree", "add", sibling, "owned"]);
    const stash = path.join(adoptStashDir(root), "repo");
    await fs.mkdir(path.dirname(stash), { recursive: true });
    await git(root, ["clone", "--no-local", target, stash]); await configure(stash);
    await git(stash, ["checkout", "owned"]);
    await commit(stash, "owned.txt", "ahead\n", "owned ahead");
    const fetches: string[][] = [];
    const j = await journal(root, [source("repo")]); await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {}, { runGit: async (repo, args) => { if (args[0] === "fetch") fetches.push(args); return git(repo, args); } });
    const owned = j.gitRepos[0]?.branches.find((branch) => branch.ref === "refs/heads/owned");
    expect(owned?.state).toBe("parked");
    expect(owned?.reason).toContain("linked worktree");
    expect(fetches).toEqual([]);
  });

  test("target ABA/config-incarnation changes pause prepared proof without target CAS", async () => {
    const root = await temp("rbox-adopt-aba-");
    const target = path.join(root, "repo");
    await fs.mkdir(target); await git(target, ["init", "-b", "main"]); await configure(target);
    const old = await commit(target, "base", "base\n", "base");
    const stash = path.join(adoptStashDir(root), "repo");
    await fs.mkdir(path.dirname(stash), { recursive: true }); await git(root, ["clone", "--no-local", target, stash]); await configure(stash);
    await commit(stash, "ahead", "ahead\n", "ahead");
    const j = await journal(root, [source("repo")]); await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {}, {
      afterFetchBeforeMutation: async () => {
        const third = await commit(target, "third", "third\n", "third");
        await git(target, ["update-ref", "refs/heads/main", old, third]);
        await git(target, ["reset", "--hard", old]);
      },
    });
    expect(j.gitRepos[0]?.state).toBe("paused");
    expect(j.gitRepos[0]?.branches[0]?.reason).toMatch(/reflog|proof changed/);
    expect(await git(target, ["rev-parse", "main"])).toBe(old);
  });

  test("Git target incarnation change after fetch pauses and leaves ref unchanged", async () => {
    const root = await temp("rbox-adopt-incarnation-");
    const target = path.join(root, "repo");
    await fs.mkdir(target); await git(target, ["init", "-b", "main"]); await configure(target);
    const old = await commit(target, "base", "base\n", "base");
    const gitIno = (await fs.lstat(path.join(target, ".git"), { bigint: true })).ino;
    const stash = path.join(adoptStashDir(root), "repo");
    await fs.mkdir(path.dirname(stash), { recursive: true }); await git(root, ["clone", "--no-local", target, stash]); await configure(stash);
    await commit(stash, "ahead", "ahead\n", "ahead");
    const j = await journal(root, [source("repo")]); await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {}, { afterFetchBeforeMutation: async () => { await git(target, ["config", "adopt.changed", "yes"]); } });
    expect(j.gitRepos[0]?.state).toBe("paused");
    expect(await git(target, ["rev-parse", "main"])).toBe(old);
    expect((await fs.lstat(path.join(target, ".git"), { bigint: true })).ino).toBe(gitIno);
  });

  test("outside target reached through a symlink is never mutated", async () => {
    const root = await temp("rbox-adopt-containment-");
    const outside = await temp("rbox-adopt-outside-repo-");
    await git(outside, ["init", "-b", "main"]); await configure(outside);
    const outsideHead = await commit(outside, "outside", "outside\n", "outside");
    await fs.symlink(outside, path.join(root, "repo"));
    const stash = path.join(adoptStashDir(root), "repo");
    await fs.mkdir(stash, { recursive: true }); await git(stash, ["init", "-b", "main"]); await configure(stash); await commit(stash, "inside", "inside\n", "inside");
    const j = await journal(root, [source("repo")]); await bindRetainedRepoIncarnations(j);
    await runGitAdoption(j, async () => {});
    expect(j.gitRepos[0]?.state).toBe("unplaced");
    expect(await git(outside, ["rev-parse", "HEAD"])).toBe(outsideHead);
  });

  test("same-stream re-init refuses before journal publication", async () => {
    const root = await temp("rbox-adopt-reinit-");
    const cfg: WorkspaceConfig = { schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "https://example.invalid", token: "", syncGit: true, respectGitignore: false };
    await saveConfig(root, cfg);
    expect(syncStreamId(cfg)).toBeTruthy();
    await expect(preflightInitRebind({ root, remoteUrl: cfg.remoteUrl, workspace: { kind: "join", id: "ws", project: "root" } })).rejects.toThrow("already bound");
    expect(await fs.lstat(path.join(root, ".rbox", "adopt", "journal.json")).then(() => true, () => false)).toBe(false);
  });

  test("unsupported adoption modes and wizard keyed routes are closed before lifecycle dispatch", async () => {
    const [init, setup] = await Promise.all([
      fs.readFile(path.join(import.meta.dir, "init-cmd.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "setup-cmd.ts"), "utf8"),
    ]);
    expect(init).toContain('plan.workspace.kind !== "join" || plan.firstSync !== "sync"');
    expect(init).toContain("--pull-only and --no-sync are unsupported");
    expect(setup).toContain("!setupOpts.noSync && !oldStream && await rootHasAdoptableContent(dir)");
    const keyed = await fs.readFile(path.join(import.meta.dir, "setup-keyed.ts"), "utf8");
    expect(keyed).not.toContain("adoptConsent");
  });

  test("socket and device identities are special and a live socket is retained unplaced", async () => {
    if (process.platform === "win32") return;
    const root = await temp("rbox-adopt-special-");
    const stash = adoptStashDir(root);
    await Promise.all([fs.mkdir(stash, { recursive: true }), fs.mkdir(adoptUnplacedDir(root), { recursive: true })]);
    const socketPath = path.join(stash, "sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    try {
      const j = await journal(root, [], false);
      await runFileOverlay(j, async () => {});
      expect((await fs.lstat(path.join(adoptUnplacedDir(root), "sock"))).isSocket()).toBe(true);
      expect(j.overlayMoves[0]?.disposition).toBe("special");
      expect((await readAdoptIdentity("/dev/null")).kind).toBe("device");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test("Linux mount-point inventory refuses before any adoption journal or move", async () => {
    if (process.platform !== "linux") return;
    // /dev is a mount point; on some hosts it also holds symlinks that trip the
    // no-follow unsafe-path guard first. Both are valid PRE-JOURNAL refusals —
    // the binding contract is "refuses before any journal or move", not a
    // specific message. Assert the contract: it rejects, and writes no journal.
    await expect(inventoryAdoptionSource("/dev")).rejects.toThrow(/mount point|crosses devices|unsafe adoption inventory path/);
    expect(await fs.lstat("/dev/.rbox/adopt/journal.json").then(() => true, () => false)).toBe(false);
  });

  test("terminal retention is listed until explicit clean removes only the adopt area", async () => {
    const root = await temp("rbox-adopt-clean-");
    await fs.writeFile(path.join(root, "local"), "B\n");
    const mutex = await acquireWorkspaceSyncMutex(root, "cli");
    const inventory = await inventoryAdoptionSource(root);
    const j = await startAdoption({ root, rootReal: await fs.realpath(root), stream: "stream", workspaceId: "ws", projectId: "root", remoteUrl: "https://example.invalid", deviceId: "dev", syncGit: false, respectGitignore: false }, inventory, mutex);
    await continueAdoption(j, mutex, { establishBaseline: async () => { await fs.writeFile(path.join(root, "local"), "A\n"); }, finishSync: async () => {} });
    await releaseWorkspaceSyncMutex(mutex);
    const status = await adoptionStatus(root);
    expect(status.displaced).toContain(path.join(root, ".rbox", "adopt", "displaced", "local"));
    await adoptCmd("clean", root, { yes: true });
    expect(await fs.lstat(path.join(root, ".rbox", "adopt")).then(() => true, () => false)).toBe(false);
    expect(await fs.readFile(path.join(root, "local"), "utf8")).toBe("B\n");
  });

  test("all 47 binding rows remain named in executable adoption coverage", async () => {
    const design = await fs.readFile(path.join(import.meta.dir, "..", "..", "docs", "design", "166-forward-adopt.md"), "utf8");
    const rows = [...design.matchAll(/^\| ([^|]+?) \([^\n]+\) \|/gm)].map((match) => match[1]!.trim());
    expect(rows).toEqual([
      "Forward gate", "A-only survival", "File collision", "Type flips", "Literal selective fetch",
      "source-moved-before-fetch", "source-moved-after-proof", "proved-object-GC'd", "Diverged branch", "B behind",
      "Detached HEAD", "Stash and tags", "B-only repository", "Nested repos", "Pointer target scope",
      "linked-worktree source", "Linked-worktree ownership", "CAS/ABA classifier", "conflicted-merge repo", "clean repo",
      "Ref/index crash matrix", "Git-plane containment", "Same-stream re-init", "Unsupported modes", "Consent routes",
      "Journal kill matrix", "Power-loss shape", "Abort phases", "Crash before config", "Degraded mutex",
      "Shared fence choke point", "Continuation propagation", "Continuation rejection", "Kill switch", "Hardlinks",
      "Large-file identity alias", "No-clobber writer races", "Symlink escape", "Mode-000 directory", "Mount point",
      "Special entries", "Ignore independence", "Warm cache", "Resident daemon generation", "Git incarnation",
      "Finish fanout", "Retention lifecycle",
    ]);
  });
});
