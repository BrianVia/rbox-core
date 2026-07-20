import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git, gitOk } from "../engine/git/shared.js";
import { bindRetainedRepoIncarnations, abortGitAdoption, runGitAdoption } from "./adopt-git.js";
import { inventoryAdoptionSource } from "./adopt-inventory.js";
import {
  ADOPT_VERSION,
  LINKED_WORKTREE_REFUSAL,
  adoptStashDir,
  type AdoptJournal,
  type AdoptSourceRepo,
} from "./adopt-journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function command(repo: string, args: string[]): Promise<string> { return git(repo, args); }
async function configure(repo: string): Promise<void> {
  await command(repo, ["config", "user.name", "Adopt Test"]);
  await command(repo, ["config", "user.email", "adopt@example.invalid"]);
}
async function commit(repo: string, file: string, bytes: string, message: string): Promise<string> {
  await fs.writeFile(path.join(repo, file), bytes);
  await command(repo, ["add", file]);
  await command(repo, ["commit", "-m", message]);
  return command(repo, ["rev-parse", "HEAD"]);
}

function emptySource(rel = "repo"): AdoptSourceRepo {
  return { path: rel, sourceKind: "dir", worktreeReal: "/pending", gitDirReal: "/pending", commonDirReal: "/pending", objectStoreReal: "/pending" };
}

async function makeJournal(root: string, sources: AdoptSourceRepo[]): Promise<AdoptJournal> {
  return {
    version: ADOPT_VERSION,
    journalId: "a".repeat(32),
    createdAt: new Date(0).toISOString(),
    workspace: { root, rootReal: await fs.realpath(root), stream: "stream", workspaceId: "ws", projectId: "root", remoteUrl: "https://example.invalid", deviceId: "dev", syncGit: true, respectGitignore: false },
    phase: "git", pauseReasons: [], inventory: [], sourceRepos: sources, retainedBytes: "0", retainMoves: [],
    baseline: { started: true, complete: true, continuationNonce: "b".repeat(32), consumed: true, mutexIncarnation: "lock" },
    gitRepos: [], overlayMoves: [], createdDirectories: [], cache: { invalidated: false }, finishSync: { attempted: false, complete: false },
  };
}

async function fixture(opts: { sourceAhead?: boolean } = { sourceAhead: true }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-git-"));
  roots.push(root);
  const target = path.join(root, "repo");
  const source = path.join(adoptStashDir(root), "repo");
  await fs.mkdir(target, { recursive: true });
  await command(target, ["init", "-b", "main"]);
  await configure(target);
  const oldOid = await commit(target, "file.txt", "base\n", "base");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await command(root, ["clone", "--no-local", target, source]);
  await configure(source);
  const incomingOid = opts.sourceAhead === false ? oldOid : await commit(source, "file.txt", "incoming\n", "incoming");
  const journal = await makeJournal(root, [emptySource()]);
  await bindRetainedRepoIncarnations(journal);
  return { root, target, source, oldOid, incomingOid, journal };
}

async function refs(repo: string): Promise<string[]> {
  return (await command(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).split("\n").filter(Boolean).sort();
}

describe("design 166 exact-OID Git fetch-union", () => {
  test("eligible checked-out ahead branch uses literal selective fetch, CAS, saved index, and no worktree write", async () => {
    const f = await fixture();
    const fetchHead = path.join(f.target, ".git", "FETCH_HEAD");
    await fs.writeFile(fetchHead, "sentinel FETCH_HEAD\n");
    await command(f.source, ["tag", "source-tag"]);
    await command(f.source, ["config", "submodule.fake.url", "https://network.invalid/repo"]);
    const beforeRefs = await refs(f.target);
    const beforeWorktree = await fs.readFile(path.join(f.target, "file.txt"), "utf8");
    const calls: string[][] = [];
    await runGitAdoption(f.journal, async () => {}, { runGit: async (repo, args) => { calls.push(args); return git(repo, args); } });

    const branch = f.journal.gitRepos[0]?.branches.find((candidate) => candidate.ref === "refs/heads/main");
    expect(branch?.state).toBe("index-complete");
    expect(branch?.provedSourceOid).toBe(f.incomingOid);
    expect(branch?.initialIndexTree).toBe(branch?.initialHeadTree);
    expect(branch?.boundaryIndexTree).toBe(branch?.boundaryHeadTree);
    expect(branch?.index?.beforeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(branch?.index?.afterHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.find((args) => args[0] === "fetch")).toEqual([
      "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", f.source, f.incomingOid,
    ]);
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.incomingOid);
    expect(await fs.readFile(fetchHead, "utf8")).toBe("sentinel FETCH_HEAD\n");
    expect(await gitOk(f.target, ["show-ref", "--verify", "refs/tags/source-tag"])).toBe(false);
    expect(await fs.readFile(path.join(f.target, "file.txt"), "utf8")).toBe(beforeWorktree);
    const afterRefs = await refs(f.target);
    expect(afterRefs.filter((line) => !beforeRefs.includes(line))).toEqual([`refs/heads/main ${f.incomingOid}`]);
  });

  test("source moved before fetch still transfers only journaled I and excludes divergent D", async () => {
    const f = await fixture();
    let divergent = "";
    const fetches: string[][] = [];
    await runGitAdoption(f.journal, async () => {}, {
      runGit: async (repo, args) => { if (args[0] === "fetch") fetches.push(args); return git(repo, args); },
      beforeFetch: async () => {
        await command(f.source, ["checkout", "--detach", f.oldOid]);
        divergent = await commit(f.source, "divergent.txt", "D\n", "divergent D");
        await command(f.source, ["update-ref", "refs/heads/main", divergent]);
      },
    });
    expect(fetches[0]?.at(-1)).toBe(f.incomingOid);
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.incomingOid);
    expect(await gitOk(f.target, ["cat-file", "-e", `${divergent}^{commit}`])).toBe(false);
  });

  test("source moved after exact-I fetch is irrelevant to prepared CAS", async () => {
    const f = await fixture();
    let divergent = "";
    await runGitAdoption(f.journal, async () => {}, {
      afterFetchBeforeMutation: async () => {
        await command(f.source, ["checkout", "--detach", f.oldOid]);
        divergent = await commit(f.source, "after.txt", "D\n", "after-fetch D");
        await command(f.source, ["update-ref", "refs/heads/main", divergent]);
      },
    });
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.incomingOid);
    expect(await gitOk(f.target, ["cat-file", "-e", `${divergent}^{commit}`])).toBe(false);
  });

  test("proved object garbage-collected before fetch PARKS without ref/index mutation", async () => {
    const f = await fixture();
    const indexBefore = await fs.readFile(path.join(f.target, ".git", "index"));
    let divergent = "";
    await runGitAdoption(f.journal, async () => {}, {
      beforeFetch: async () => {
        await command(f.source, ["checkout", "--detach", f.oldOid]);
        divergent = await commit(f.source, "gc.txt", "D\n", "replacement D");
        await command(f.source, ["update-ref", "refs/heads/main", divergent]);
        await command(f.source, ["reflog", "expire", "--expire=now", "--all"]);
        await command(f.source, ["gc", "--prune=now"]);
      },
    });
    expect(f.journal.gitRepos[0]?.state).toBe("parked");
    expect(f.journal.gitRepos[0]?.branches[0]?.state).toBe("parked");
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.oldOid);
    expect(await fs.readFile(path.join(f.target, ".git", "index"))).toEqual(indexBefore);
    expect(await gitOk(f.target, ["cat-file", "-e", `${divergent}^{commit}`])).toBe(false);
  });

  test("diverged branch, detached HEAD, tags, and stash remain retained-only", async () => {
    const f = await fixture({ sourceAhead: false });
    const sourceUnique = await commit(f.source, "source.txt", "source\n", "source side");
    await command(f.target, ["reset", "--hard", f.oldOid]);
    const targetUnique = await commit(f.target, "target.txt", "target\n", "target side");
    await command(f.source, ["tag", "-a", "annotated", "-m", "tag object", sourceUnique]);
    await fs.writeFile(path.join(f.source, "stash.txt"), "stash\n");
    await command(f.source, ["add", "stash.txt"]);
    await command(f.source, ["stash", "push", "-m", "retained stash"]);
    await command(f.source, ["checkout", "--detach", sourceUnique]);
    const detached = await commit(f.source, "detached.txt", "detached\n", "detached tip");
    const beforeRefs = await refs(f.target);
    await runGitAdoption(f.journal, async () => {});
    expect(await refs(f.target)).toEqual(beforeRefs);
    expect(await command(f.target, ["rev-parse", "main"])).toBe(targetUnique);
    expect(await gitOk(f.target, ["cat-file", "-e", `${detached}^{commit}`])).toBe(false);
    expect(await gitOk(f.target, ["show-ref", "--verify", "refs/tags/annotated"])).toBe(false);
    expect(f.journal.gitRepos[0]?.retainedRefs).toContain("refs/stash");
    expect(f.journal.gitRepos[0]?.retainedRefs).toContain("refs/tags/annotated");
    expect(f.journal.gitRepos[0]?.detachedHead).toBe(detached);
  });

  test("B-behind branch imports nothing while retained additions/stash/tags remain reachable", async () => {
    const f = await fixture({ sourceAhead: false });
    const targetAhead = await commit(f.target, "ahead.txt", "A ahead\n", "A ahead");
    await fs.writeFile(path.join(f.source, "local.txt"), "B local\n");
    await command(f.source, ["add", "local.txt"]);
    await command(f.source, ["stash", "push", "-m", "B stash"]);
    await command(f.source, ["tag", "behind-tag"]);
    const beforeRefs = await refs(f.target);
    const fetches: string[][] = [];
    await runGitAdoption(f.journal, async () => {}, { runGit: async (repo, args) => { if (args[0] === "fetch") fetches.push(args); return git(repo, args); } });
    expect(fetches).toEqual([]);
    expect(await refs(f.target)).toEqual(beforeRefs);
    expect(await command(f.target, ["rev-parse", "main"])).toBe(targetAhead);
    expect(await command(f.source, ["rev-parse", "refs/stash"])).toMatch(/^[0-9a-f]{40}$/);
    expect(f.journal.gitRepos[0]?.retainedRefs).toEqual(expect.arrayContaining(["refs/heads/main", "refs/stash", "refs/tags/behind-tag"]));
  });

  test("dirty index and operation state park the checked-out branch before fetch/read-tree", async () => {
    for (const mode of ["dirty-index", "merge-state"] as const) {
      const f = await fixture();
      if (mode === "dirty-index") {
        await fs.writeFile(path.join(f.target, "indexed.txt"), "index\n");
        await command(f.target, ["add", "indexed.txt"]);
      } else {
        await fs.writeFile(path.join(f.target, ".git", "MERGE_HEAD"), `${f.incomingOid}\n`);
      }
      const indexBefore = await fs.readFile(path.join(f.target, ".git", "index"));
      const calls: string[][] = [];
      await runGitAdoption(f.journal, async () => {}, { runGit: async (repo, args) => { calls.push(args); return git(repo, args); } });
      expect(calls.some((args) => args[0] === "fetch")).toBe(false);
      expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
      expect(f.journal.gitRepos[0]?.branches[0]?.state).toBe("parked");
      expect(await command(f.target, ["rev-parse", "main"])).toBe(f.oldOid);
      expect(await fs.readFile(path.join(f.target, ".git", "index"))).toEqual(indexBefore);
    }
  });

  test("index becoming dirty at the prepared boundary parks after fetch but before CAS", async () => {
    const f = await fixture();
    const calls: string[][] = [];
    await runGitAdoption(f.journal, async () => {}, {
      runGit: async (repo, args) => { calls.push(args); return git(repo, args); },
      afterFetchBeforeMutation: async () => {
        await fs.writeFile(path.join(f.target, "late.txt"), "late\n");
        await command(f.target, ["add", "late.txt"]);
      },
    });
    expect(calls.some((args) => args[0] === "fetch")).toBe(true);
    expect(calls.some((args) => args[0] === "update-ref")).toBe(false);
    expect(f.journal.gitRepos[0]?.branches[0]?.state).toBe("parked");
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.oldOid);
  });

  test("CAS crash classifier recognizes exact old→new reflog transition and abort restores ref and saved index", async () => {
    const f = await fixture();
    const indexBefore = await fs.readFile(path.join(f.target, ".git", "index"));
    let killed = false;
    await runGitAdoption(f.journal, async () => {}, {
      afterCas: () => { if (!killed) { killed = true; throw new Error("simulated kill after CAS"); } },
    });
    expect(f.journal.gitRepos[0]?.state).toBe("paused");
    expect(f.journal.gitRepos[0]?.branches[0]?.state).toBe("cas-intent");
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.incomingOid);

    await runGitAdoption(f.journal, async () => {});
    expect(f.journal.gitRepos[0]?.state).toBe("complete");
    expect(f.journal.gitRepos[0]?.branches[0]?.state).toBe("index-complete");
    await abortGitAdoption(f.journal, async () => {});
    expect(await command(f.target, ["rev-parse", "main"])).toBe(f.oldOid);
    expect(await fs.readFile(path.join(f.target, ".git", "index"))).toEqual(indexBefore);
  });

  test("ref/index crash matrix safely resumes after index copy, ref CAS, read-tree publication, and journal advance", async () => {
    for (const stage of ["index-copy", "ref-cas", "read-tree", "journal-advance"] as const) {
      const f = await fixture();
      const indexBefore = await fs.readFile(path.join(f.target, ".git", "index"));
      let injected = false;
      const once = () => { if (!injected) { injected = true; throw new Error(`simulated kill after ${stage}`); } };
      await runGitAdoption(f.journal, async () => {}, stage === "index-copy"
        ? { beforeCas: once }
        : stage === "ref-cas" ? { afterCas: once }
          : stage === "read-tree" ? { afterIndexPublish: once }
            : {});
      if (stage !== "journal-advance") expect(f.journal.gitRepos[0]?.state).toBe("paused");
      await runGitAdoption(f.journal, async () => {});
      expect(f.journal.gitRepos[0]?.state, stage).toBe("complete");
      expect(f.journal.gitRepos[0]?.branches[0]?.state, stage).toBe("index-complete");
      expect(await command(f.target, ["rev-parse", "main"]), stage).toBe(f.incomingOid);
      await abortGitAdoption(f.journal, async () => {});
      expect(await command(f.target, ["rev-parse", "main"]), stage).toBe(f.oldOid);
      expect(await fs.readFile(path.join(f.target, ".git", "index")), stage).toEqual(indexBefore);
      expect(await fs.lstat(path.join(f.target, ".git", "index.lock")).then(() => true, () => false), stage).toBe(false);
    }
  });

  test("B-only repository has no target import and stays an unplaced retained repo", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-git-only-"));
    roots.push(root);
    const source = path.join(adoptStashDir(root), "only");
    await fs.mkdir(source, { recursive: true });
    await command(source, ["init", "-b", "main"]);
    await configure(source);
    await commit(source, "only.txt", "B only\n", "B only");
    const journal = await makeJournal(root, [emptySource("only")]);
    await bindRetainedRepoIncarnations(journal);
    await runGitAdoption(journal, async () => {});
    expect(journal.gitRepos[0]?.state).toBe("unplaced");
    expect(journal.gitRepos[0]?.reason).toContain("no phase-2 target");
    expect(await command(source, ["rev-parse", "main"])).toMatch(/^[0-9a-f]{40}$/);
  });

  test("linked-worktree source is refused during phase 0 with exact message and no move", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-adopt-linked-"));
    roots.push(root);
    const main = path.join(root, "main-clone");
    const linked = path.join(root, "linked");
    await fs.mkdir(main);
    await command(main, ["init", "-b", "main"]);
    await configure(main);
    await commit(main, "file", "base\n", "base");
    await command(main, ["worktree", "add", "-b", "linked", linked]);
    await expect(inventoryAdoptionSource(root)).rejects.toThrow(LINKED_WORKTREE_REFUSAL);
    expect(await fs.readFile(path.join(linked, "file"), "utf8")).toBe("base\n");
    expect(await fs.lstat(path.join(root, ".rbox", "adopt", "journal.json")).then(() => true, () => false)).toBe(false);
  });
});
