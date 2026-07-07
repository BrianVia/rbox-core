import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildIgnoreMatcher, nativePruneGlobs } from "./ignore.js";
import { scanManifest } from "./manifest.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ign-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("ignore matcher — .rbox hard exclusion (design 12 C8)", () => {
  test("`.rbox/` is excluded by default", () => {
    const m = buildIgnoreMatcher(root);
    expect(m.ignores(".rbox/")).toBe(true);
    expect(m.ignores(".rbox/state.json")).toBe(true);
    expect(m.ignores(".rbox/keys/ws1.key")).toBe(true);
  });

  test("a `!.rbox` negation in .rboxignore CANNOT re-include it", async () => {
    await fs.writeFile(path.join(root, ".rboxignore"), "!.rbox\n!.rbox/\n!.rbox/state.json\n");
    const m = buildIgnoreMatcher(root);
    expect(m.ignores(".rbox/state.json")).toBe(true); // still excluded — hard rule wins
    expect(m.ignores(".rbox")).toBe(true);
    await fs.rm(path.join(root, ".rboxignore"));
  });

  test("a `!.rbox` negation via the extra ruleset also cannot re-include it", () => {
    const m = buildIgnoreMatcher(root, ["!.rbox", "!.rbox/state.json"]);
    expect(m.ignores(".rbox/state.json")).toBe(true);
  });

  test("non-.rbox paths are unaffected (normal ignore still works)", () => {
    const m = buildIgnoreMatcher(root);
    expect(m.ignores("src/index.ts")).toBe(false);
    expect(m.ignores("node_modules/")).toBe(true); // a normal builtin
  });

  test("a `.git` pointer FILE (worktree/submodule) is ignored, not just the dir", () => {
    // A worktree checkout has `.git` as a FILE whose content is a machine-local
    // absolute path — syncing it plants a dangling pointer on every other machine.
    const m = buildIgnoreMatcher(root);
    expect(m.ignores(".git")).toBe(true); // file form at the root
    expect(m.ignores("savvy-core/daegu/.git")).toBe(true); // nested worktree pointer
    expect(m.ignores(".git/")).toBe(true); // dir form still excluded
    expect(m.ignores("repo/.git/config")).toBe(true);
    expect(m.ignores("src/git-state.ts")).toBe(false); // only the exact name matches
  });

  test("a `!.git` negation CANNOT re-include it (hard exclusion, like .rbox)", () => {
    // Raw `.git` trees synced file-by-file arrive torn; a project's stray `!.git`
    // must not switch that hazard back on — git state transfers via git-sync only.
    const m = buildIgnoreMatcher(root, ["!.git", "!.git/", "!wt/.git", "!.git/config"]);
    expect(m.ignores(".git")).toBe(true);
    expect(m.ignores(".git/config")).toBe(true);
    expect(m.ignores("wt/.git")).toBe(true);
    expect(m.ignores("repo/.git/HEAD")).toBe(true);
  });
});

describe("nativePruneGlobs — coarse native watcher prune, negation-aware (design §41)", () => {
  const mkroot = async (rboxignore?: string): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-np-"));
    if (rboxignore !== undefined) await fs.writeFile(path.join(d, ".rboxignore"), rboxignore);
    return d;
  };
  const prunes = (globs: string[], dir: string) => globs.includes(`**/${dir}`) && globs.includes(`**/${dir}/**`);

  test("a DEFAULT tree native-prunes node_modules, .git, .rbox AND the build dirs", async () => {
    const d = await mkroot();
    try {
      const g = nativePruneGlobs(d);
      // The regression guard: the built-in `!.env.*` negations must NOT un-prune build dirs.
      for (const dir of ["node_modules", ".git", ".rbox", "dist", "build", ".next", "target"]) {
        expect(prunes(g, dir)).toBe(true);
      }
      // subtree form is present so a native watcher's CHILD events are pruned too
      expect(g).toContain("**/node_modules/**");
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  test("a user `!dist/keep.txt` un-prunes `dist` (only), leaving other build dirs pruned", async () => {
    const d = await mkroot("!dist/keep.txt\n");
    try {
      const g = nativePruneGlobs(d);
      expect(prunes(g, "dist")).toBe(false); // dropped → live events reach the JS matcher
      expect(prunes(g, "build")).toBe(true);
      expect(prunes(g, "node_modules")).toBe(true);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  test("a user `!dist/` un-prunes `dist`", async () => {
    const d = await mkroot("!dist/\n");
    try {
      expect(prunes(nativePruneGlobs(d), "dist")).toBe(false);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  test("a BARE-BASENAME negation (`!.env.example`) removes NOTHING from the prune set", async () => {
    const d = await mkroot("!.env.example\n!keep.txt\n");
    try {
      const g = nativePruneGlobs(d);
      for (const dir of ["node_modules", ".git", ".rbox", "dist", "build", ".next", "target"]) {
        expect(prunes(g, dir)).toBe(true);
      }
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});

describe("builtin ignores — regenerable build/cache dirs (multi-ecosystem)", () => {
  test("distinctive build outputs are excluded at any depth", () => {
    const m = buildIgnoreMatcher(root);
    for (const p of [
      ".build/checkouts/GRDB.swift/Package.swift", // SwiftPM dep clone (live incident)
      "apps/apple/NotekeeperCore/.build/debug/app",
      "DerivedData/Notekeeper/Build/x",
      "api/__pycache__/mod.cpython-312.pyc",
      "infra/cdk.out/stack.template.json",
      "infra/.terraform/providers/x",
      "svc/.gradle/8.5/task",
      "web/.wrangler/state/v3/d1.sqlite-x",
      "site/.output/server/index.mjs",
      "native/cmake-build-debug/CMakeCache.txt",
      "lib/zig-out/bin/tool",
      "ml/.ipynb_checkpoints/nb-checkpoint.ipynb",
    ]) {
      expect(m.ignores(p)).toBe(true);
    }
  });

  test("generic / sometimes-committed names still sync", () => {
    const m = buildIgnoreMatcher(root);
    for (const p of [
      "bin/deploy.sh", // generic bin/ is real content
      "obj/model.obj",
      "out/notes.md",
      "deps/README.md",
      "Pods/Local/podspec.json", // sometimes committed on purpose
      "vendor/patched-lib/x.go",
      ".vscode/settings.json", // editor config: untracked-but-precious
      "wandb/run-1/summary.json", // experiment data
      "terraform.tfstate", // state FILES sync (E2EE backup is a feature)
    ]) {
      expect(m.ignores(p)).toBe(false);
    }
  });
});

describe("design 72 nested gitignore semantics", () => {
  const mkroot = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "rbox-ign72-"));
  const cleanup = (d: string) => fs.rm(d, { recursive: true, force: true });

  test("per-base gitignore evaluation is exact for bare, anchored, directory, and globstar patterns", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "pkg", "sub"), { recursive: true });
      await fs.writeFile(path.join(d, "pkg", ".gitignore"), "/anchored.txt\nbare.txt\ncache/\n**/deep.log\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("pkg/anchored.txt")).toBe(true);
      expect(m.ignores("pkg/sub/anchored.txt")).toBe(false);
      expect(m.ignores("pkg/sub/bare.txt")).toBe(true);
      expect(m.prunes?.("pkg/cache/")).toBe(true);
      expect(m.ignores("pkg/sub/deep.log")).toBe(true);
      expect(m.ignores("other/bare.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("nested gitignore negation cannot re-include below an excluded parent", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "ignored"), { recursive: true });
      await fs.writeFile(path.join(d, ".gitignore"), "ignored/\n");
      await fs.writeFile(path.join(d, "ignored", ".gitignore"), "!keep.txt\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.prunes?.("ignored/")).toBe(true);
      expect(m.ignores("ignored/keep.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test(".rboxignore negation can rescue a file below a gitignored parent by disabling that prune", async () => {
    const d = await mkroot();
    try {
      await fs.writeFile(path.join(d, ".gitignore"), "ignored/\n");
      await fs.writeFile(path.join(d, ".rboxignore"), "!ignored/keep.txt\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.prunes?.("ignored/")).toBe(false);
      expect(m.ignores("ignored/keep.txt")).toBe(false);
      expect(m.ignores("ignored/drop.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test(".rboxignore wildcard negation protects descendants below its static prefix from pruning", async () => {
    const d = await mkroot();
    try {
      await fs.writeFile(path.join(d, ".gitignore"), "ignored/\n");
      await fs.writeFile(path.join(d, ".rboxignore"), "!ignored/**/keep.txt\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.prunes?.("ignored/")).toBe(false);
      expect(m.prunes?.("ignored/a/")).toBe(false);
      expect(m.prunes?.("ignored/a/b/")).toBe(false);
      expect(m.ignores("ignored/a/b/keep.txt")).toBe(false);
      expect(m.ignores("ignored/a/b/drop.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("slashless .rboxignore negation disables gitignore directory pruning but preserves per-file results", async () => {
    const d = await mkroot();
    try {
      await fs.writeFile(path.join(d, ".gitignore"), "ignored/\n");
      await fs.writeFile(path.join(d, ".rboxignore"), "!keep.txt\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.prunes?.("ignored/")).toBe(false);
      expect(m.ignores("ignored/drop.txt")).toBe(true);
      expect(m.ignores("ignored/keep.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("parent gitignore rules cascade across nested repo boundaries", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(repo, "base.txt"), "base");
      await git(repo, "add", "base.txt");
      await fs.writeFile(path.join(d, ".gitignore"), "scratch.txt\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("repo/scratch.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("tracked files under gitignored directories keep the scan from pruning their parent", async () => {
    const d = await mkroot();
    try {
      await git(d, "init", "-qb", "main");
      await fs.mkdir(path.join(d, "ignored"), { recursive: true });
      await fs.writeFile(path.join(d, ".gitignore"), "ignored/\n");
      await fs.writeFile(path.join(d, "ignored", "keep.txt"), "tracked");
      await fs.writeFile(path.join(d, "ignored", "drop.txt"), "untracked");
      await git(d, "add", "-f", "ignored/keep.txt");

      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.prunes?.("ignored/")).toBe(false);
      const manifest = await scanManifest(d, m);
      expect(manifest.files.map((f) => f.path).sort()).toEqual([".gitignore", "ignored/keep.txt"]);
      expect(m.ignores("ignored/keep.txt")).toBe(false);
      expect(m.ignores("ignored/drop.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("tracked gitignored files stay included and the tracked-set cache invalidates with the index", async () => {
    const d = await mkroot();
    try {
      await git(d, "init", "-qb", "main");
      await fs.writeFile(path.join(d, ".gitignore"), "*.txt\n");
      await fs.writeFile(path.join(d, "tracked.txt"), "tracked");
      await git(d, "add", "-f", "tracked.txt");
      let m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("tracked.txt")).toBe(false);
      expect(m.ignores("untracked.txt")).toBe(true);

      await fs.writeFile(path.join(d, "later.txt"), "later");
      await git(d, "add", "-f", "later.txt");
      m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("later.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("missing git index fails closed for a known repo", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(d, ".gitignore"), "repo/\n");

      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
      expect(m.unevaluatedGitRepoForPath?.("repo/file.txt")).toBe("repo");
      expect(m.prunes?.("repo/")).toBe(false);
      expect(m.ignores("repo/file.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("corrupt tracked-set cache fails closed instead of falling back to an empty set", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(d, ".gitignore"), "repo/\n");
      await fs.writeFile(path.join(repo, "keep.txt"), "tracked");
      await git(repo, "add", "-f", "keep.txt");

      let m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
      expect(m.ignores("repo/keep.txt")).toBe(false);
      const cacheDir = path.join(d, ".rbox", "state", "git-tracked");
      const cacheFiles = await fs.readdir(cacheDir);
      expect(cacheFiles.length).toBe(1);
      await fs.writeFile(path.join(cacheDir, cacheFiles[0]!), "{not-json");

      m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
      expect(m.unevaluatedGitRepoForPath?.("repo/keep.txt")).toBe("repo");
      expect(m.prunes?.("repo/")).toBe(false);
      expect(m.ignores("repo/keep.txt")).toBe(false);
      expect(m.ignores("repo/untracked.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("linked worktree tracked sets use the per-worktree index, not the shared common dir", async () => {
    const d = await mkroot();
    try {
      const main = path.join(d, "main");
      const wt = path.join(d, "wt");
      await fs.mkdir(main, { recursive: true });
      await git(main, "init", "-qb", "main");
      await git(main, "config", "user.email", "test@example.com");
      await git(main, "config", "user.name", "Test User");
      await fs.writeFile(path.join(main, "base.txt"), "base");
      await git(main, "add", "base.txt");
      await git(main, "commit", "-qm", "base");
      await git(main, "worktree", "add", "-q", "-b", "wtbranch", wt);
      await fs.writeFile(path.join(wt, ".gitignore"), "*.txt\n");
      await fs.writeFile(path.join(wt, "tracked.txt"), "tracked");
      await git(wt, "add", "-f", "tracked.txt");

      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["wt"] });
      expect(m.ignores("wt/tracked.txt")).toBe(false);
      expect(m.ignores("wt/untracked.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("known repo under ignored parent is walked so tracked files are never purged as ignored", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "hidden");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(d, ".gitignore"), "hidden/\n");
      await fs.writeFile(path.join(repo, "keep.txt"), "tracked");
      await fs.writeFile(path.join(repo, "drop.txt"), "untracked");
      await git(repo, "add", "-f", "keep.txt");
      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["hidden"] });
      const manifest = await scanManifest(d, m);
      expect(manifest.files.map((f) => f.path).sort()).toEqual([".gitignore", "hidden/keep.txt"]);
      expect(m.ignores("hidden/keep.txt")).toBe(false);
      expect(m.ignores("hidden/drop.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("purge safety can identify a base repo whose tracked set could not be evaluated", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "broken"), { recursive: true });
      await fs.writeFile(path.join(d, ".gitignore"), "broken/\n");
      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["broken"] });
      expect(m.unevaluatedGitRepoForPath?.("broken/file.txt")).toBe("broken");
      expect(m.prunes?.("broken/")).toBe(false);
      expect(m.ignores("broken/file.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });
});
