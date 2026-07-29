import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { BUILTIN_IGNORE, buildIgnoreMatcher, HARD_PRUNE_DIRS, isGitRefSignal, isHardExcluded, nativePruneGlobs } from "./ignore.js";
import { applyWatchEvents, scanManifest } from "./manifest.js";

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

describe("design 172 — Git ref signals stay outside the sync plane", () => {
  test("ref-signal predicate accepts the complete supported surface and rejects non-signals", () => {
    const signals = [
      ".git/HEAD",
      ".git/packed-refs",
      ".git/refs/heads/x",
      ".git/refs/tags/x",
      ".git/refs/stash",
      ".git/worktrees/w/HEAD",
      ".git/worktrees/w/refs/heads/x",
      ".git/modules/m/refs/heads/x",
      ".git/modules/a/modules/b/HEAD",
      "nested/repo/.git/refs/tags/v1",
    ];
    const nonSignals = [
      ".git/refs/heads/x.lock",
      ".git/packed-refs.lock",
      ".git/refs/rbox-wip/pin",
      ".git/refs/remotes/origin/x",
      ".git/objects/ab/cd",
      ".git/logs/HEAD",
      ".git/index",
      ".git/config",
      ".git/reftable/tables.list",
      ".git/modules/m/logs/refs/heads/x",
      "HEAD",
      "refs/heads/x",
      "src/.git-state/refs/heads/x",
    ];
    for (const rel of signals) expect(isGitRefSignal(rel), rel).toBe(true);
    for (const rel of nonSignals) expect(isGitRefSignal(rel), rel).toBe(false);
  });

  test("seam isolation: hard excludes and a manifest scan still reject every .git path", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-seam-"));
    try {
      await fs.mkdir(path.join(d, ".git", "refs", "heads"), { recursive: true });
      await fs.writeFile(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n");
      await fs.writeFile(path.join(d, ".git", "refs", "heads", "main"), "a".repeat(40));
      await fs.writeFile(path.join(d, "kept.txt"), "kept");
      const matcher = buildIgnoreMatcher(d);
      expect(matcher.ignores(".git/refs/heads/main")).toBe(true);
      expect(isHardExcluded(".git/refs/heads/main")).toBe(true);
      const manifest = await scanManifest(d, matcher);
      expect(manifest.files.map((entry) => entry.path)).toEqual(["kept.txt"]);
      expect(manifest.files.some((entry) => entry.path === ".git" || entry.path.startsWith(".git/"))).toBe(false);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});

describe("nativePruneGlobs — coarse native watcher prune, negation-aware (design §41)", () => {
  const mkroot = async (rboxignore?: string): Promise<string> => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-np-"));
    if (rboxignore !== undefined) await fs.writeFile(path.join(d, ".rboxignore"), rboxignore);
    return d;
  };
  const prunes = (globs: string[], dir: string) => globs.includes(`**/${dir}`) && globs.includes(`**/${dir}/**`);

  test("a DEFAULT tree admits .git refs but prunes only its top-level objects/logs stores", async () => {
    const d = await mkroot();
    try {
      const g = nativePruneGlobs(d);
      // The regression guard: the built-in `!.env.*` negations must NOT un-prune build dirs.
      for (const dir of ["node_modules", ".rbox", "dist", "build", ".next", "target"]) {
        expect(prunes(g, dir)).toBe(true);
      }
      expect(prunes(g, ".git")).toBe(false);
      expect(g).toContain("**/.git/objects");
      expect(g).toContain("**/.git/objects/**");
      expect(g).toContain("**/.git/logs");
      expect(g).toContain("**/.git/logs/**");
      expect(g.some((glob) => glob.includes(".git/modules"))).toBe(false);
      expect(g.some((glob) => glob.includes("**/{objects,logs}"))).toBe(false);
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
      for (const dir of ["node_modules", ".rbox", "dist", "build", ".next", "target"]) {
        expect(prunes(g, dir)).toBe(true);
      }
      expect(prunes(g, ".git")).toBe(false);
    } finally {
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});

describe("legacy ignore semantics with respectGitignore off", () => {
  test("a `.rboxignore` `!dist/` re-includes children and keeps dist unpruned", async () => {
    const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-legacy-ign-"));
    try {
      await fs.writeFile(path.join(d, ".rboxignore"), "!dist/\n");
      const m = buildIgnoreMatcher(d);
      expect(m.ignores("dist/keep.txt")).toBe(false);
      expect(m.prunes?.("dist/")).toBe(false);
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
      ".idea/workspace.xml", // editor config: untracked-but-precious
      "wandb/run-1/summary.json", // experiment data
      "mlruns/0/meta.yaml", // experiment data
      ".yarn/cache/pkg.zip", // Yarn PnP is committed on purpose by some projects
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

  // Design 224 §3.1 test 4: this fixture (git init, nothing ever added) is exactly
  // the `indexAbsent` case, and its contract INVERTS. An index-less repo with no
  // commits tracks ZERO files, so it no longer un-ignores its own subtree. The
  // fail-closed guarantee that mattered — purge must not delete tracked paths —
  // lives on `protectTrackedPaths`, asserted below alongside the new contract.
  test("indexAbsent: an index-less repo with no commits has an EMPTY tracked set, not an unknown one", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(d, ".gitignore"), "repo/\n");

      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
      expect(m.unevaluatedGitRepoForPath?.("repo/file.txt")).toBeUndefined();
      expect(m.prunes?.("repo/")).toBe(true);
      expect(m.ignores("repo/file.txt")).toBe(true);
      expect(m.tracked?.("repo/file.txt")).toBe(false);

      // Purge protection reads the same empty set: nothing is tracked, so nothing
      // is protected, and no repo blocks the purge refusal.
      const purge = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"], forceTrackedEvaluation: true, protectTrackedPaths: true });
      expect(purge.unevaluatedGitRepoForPath?.("repo/file.txt")).toBeUndefined();
      expect(purge.ignores("repo/file.txt")).toBe(true);
    } finally {
      await cleanup(d);
    }
  });

  test("indexUnreadable: an index deleted from a repo that HAS commits still fails open (purge-safety)", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await git(repo, "config", "user.email", "test@example.com");
      await git(repo, "config", "user.name", "Test User");
      await fs.writeFile(path.join(repo, "committed.txt"), "committed");
      await git(repo, "add", "committed.txt");
      await git(repo, "commit", "-qm", "base");
      await fs.rm(path.join(repo, ".git", "index"));
      await fs.writeFile(path.join(d, ".gitignore"), "repo/\n");

      // HEAD resolves, so the empty `git ls-files` output is NOT evidence of an
      // empty tracked set. Without this signal, purge would delete committed files.
      const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
      expect(m.unevaluatedGitRepoForPath?.("repo/committed.txt")).toBe("repo");
      expect(m.prunes?.("repo/")).toBe(false);
      expect(m.ignores("repo/committed.txt")).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test("indexUnreadable: a stat failure that is not ENOENT still fails open", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "repo");
      await fs.mkdir(repo, { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(repo, "keep.txt"), "x");
      await git(repo, "add", "-f", "keep.txt");
      await fs.writeFile(path.join(d, ".gitignore"), "repo/\n");
      // Make the index unstattable without removing it: `stat()` on a path whose
      // PARENT directory is unsearchable fails EACCES, not ENOENT.
      await fs.chmod(path.join(repo, ".git"), 0o000);
      try {
        const m = buildIgnoreMatcher(d, { respectGitignore: true, knownGitRepos: ["repo"] });
        expect(m.unevaluatedGitRepoForPath?.("repo/keep.txt")).toBe("repo");
        expect(m.ignores("repo/keep.txt")).toBe(false);
      } finally {
        await fs.chmod(path.join(repo, ".git"), 0o700);
      }
    } finally {
      await cleanup(d);
    }
  });

  test("index-less repo no longer defeats the builtin ignore list (design 224 §3.1)", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "proj");
      await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(repo, "venv"), { recursive: true });
      await git(repo, "init", "-qb", "main");
      await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
      await fs.writeFile(path.join(repo, "node_modules", "x.js"), "mod");
      await fs.writeFile(path.join(repo, "venv", "y"), "venv");
      await fs.writeFile(path.join(repo, ".env"), "SECRET=1");
      await fs.writeFile(path.join(repo, "keep.txt"), "real");

      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("proj/node_modules/x.js")).toBe(true);
      expect(m.ignores("proj/venv/y")).toBe(true);
      expect(m.ignores("proj/.env")).toBe(true);
      expect(m.prunes?.("proj/node_modules/")).toBe(true);
      expect(m.prunes?.("proj/venv/")).toBe(true);

      const manifest = await scanManifest(d, m);
      expect(manifest.files.map((f) => f.path).sort()).toEqual(["proj/.gitignore", "proj/keep.txt"]);
    } finally {
      await cleanup(d);
    }
  });

  test("a healthy repo that genuinely tracks a file under node_modules still syncs exactly that file", async () => {
    const d = await mkroot();
    try {
      const repo = path.join(d, "proj");
      await fs.mkdir(path.join(repo, "node_modules"), { recursive: true });
      await git(repo, "init", "-qb", "main");
      await git(repo, "config", "user.email", "test@example.com");
      await git(repo, "config", "user.name", "Test User");
      await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
      await fs.writeFile(path.join(repo, "node_modules", "keep.js"), "kept");
      await fs.writeFile(path.join(repo, "node_modules", "drop.js"), "dropped");
      await git(repo, "add", "-f", "node_modules/keep.js");
      await git(repo, "commit", "-qm", "keep");

      const m = buildIgnoreMatcher(d, { respectGitignore: true });
      expect(m.ignores("proj/node_modules/keep.js")).toBe(false);
      expect(m.ignores("proj/node_modules/drop.js")).toBe(true);
      const manifest = await scanManifest(d, m);
      expect(manifest.files.map((f) => f.path)).toContain("proj/node_modules/keep.js");
      expect(manifest.files.map((f) => f.path)).not.toContain("proj/node_modules/drop.js");
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

describe("design 224 §2.2 — a symlink is ignored iff the same-named directory is", () => {
  const mkroot = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "rbox-ign224-"));
  const cleanup = (d: string) => fs.rm(d, { recursive: true, force: true });
  const paths = async (d: string, m = buildIgnoreMatcher(d)): Promise<string[]> =>
    (await scanManifest(d, m)).files.map((f) => f.path).sort();

  test("a symlink named like a builtin ignore dir is not emitted, at any depth", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "pkg"), { recursive: true });
      await fs.mkdir(path.join(d, "outer"), { recursive: true });
      await fs.writeFile(path.join(d, "real.txt"), "real");
      await fs.writeFile(path.join(d, "target.txt"), "t");
      for (const [dir, name] of [["", "node_modules"], ["", "dist"], ["", ".venv"], ["pkg", "node_modules"], ["pkg", "dist"]] as const) {
        await fs.symlink("../target.txt", path.join(d, dir, name));
      }
      // Nested inside another ignored tree (the parent prune already hides it; this
      // pins that the verdict does not depend on which guard fires first).
      await fs.mkdir(path.join(d, "outer", "coverage"), { recursive: true });
      await fs.symlink("../../target.txt", path.join(d, "outer", "coverage", "node_modules"));

      expect(await paths(d)).toEqual(["real.txt", "target.txt"]);
    } finally {
      await cleanup(d);
    }
  });

  test("a regular FILE named dist/build/target/coverage still syncs (R1 negative twin)", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "pkg"), { recursive: true });
      for (const name of ["dist", "build", "target", "coverage"]) {
        await fs.writeFile(path.join(d, name), "content");
        await fs.writeFile(path.join(d, "pkg", name), "content");
      }
      expect(await paths(d)).toEqual([
        "build", "coverage", "dist",
        "pkg/build", "pkg/coverage", "pkg/dist", "pkg/target",
        "target",
      ]);
    } finally {
      await cleanup(d);
    }
  });

  test("`!dist` and `!dist/` each re-include a dist SYMLINK exactly as they re-include a dist directory", async () => {
    for (const negation of ["!dist\n", "!dist/\n"]) {
      const d = await mkroot();
      try {
        await fs.writeFile(path.join(d, ".rboxignore"), negation);
        await fs.writeFile(path.join(d, "target.txt"), "t");
        await fs.symlink("target.txt", path.join(d, "dist"));
        const m = buildIgnoreMatcher(d);
        expect([negation, m.ignores("dist/")]).toEqual([negation, false]);
        expect([negation, await paths(d, m)]).toEqual([negation, [".rboxignore", "dist", "target.txt"]]);
      } finally {
        await cleanup(d);
      }
    }
  });

  test("a real directory with the same name is still PRUNED, not merely ignored", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "node_modules", "deep"), { recursive: true });
      await fs.writeFile(path.join(d, "node_modules", "deep", "x.js"), "x");
      const m = buildIgnoreMatcher(d);
      expect(m.prunes?.("node_modules/")).toBe(true);
      expect(await paths(d, m)).toEqual([]);
    } finally {
      await cleanup(d);
    }
  });

  test("the incremental watcher arm agrees with the full scan for a new symlink", async () => {
    const d = await mkroot();
    try {
      await fs.writeFile(path.join(d, "target.txt"), "t");
      await fs.writeFile(path.join(d, "keep.txt"), "k");
      await fs.symlink("target.txt", path.join(d, "node_modules"));
      await fs.symlink("target.txt", path.join(d, "link.txt"));
      const m = buildIgnoreMatcher(d);
      const incremental = await applyWatchEvents({ generatedAt: "", files: [] }, d, m, [
        { relPath: "target.txt", kind: "add" },
        { relPath: "keep.txt", kind: "add" },
        { relPath: "node_modules", kind: "add" },
        { relPath: "link.txt", kind: "add" },
      ]);
      expect(incremental.files.map((f) => f.path).sort()).toEqual(["keep.txt", "link.txt", "target.txt"]);
      expect(await paths(d, m)).toEqual(incremental.files.map((f) => f.path).sort());
    } finally {
      await cleanup(d);
    }
  });

  test("a base entry for a now-ignored symlink is dropped by the incremental arm, not carried", async () => {
    const d = await mkroot();
    try {
      await fs.writeFile(path.join(d, "target.txt"), "t");
      await fs.symlink("target.txt", path.join(d, "node_modules"));
      const m = buildIgnoreMatcher(d);
      const base = {
        generatedAt: "",
        files: [{ path: "node_modules", type: "symlink" as const, symlinkTarget: "target.txt", sha256: "0".repeat(64), size: 10, mode: 0o777, mtimeMs: 0 }],
      };
      const next = await applyWatchEvents(base, d, m, [{ relPath: "node_modules", kind: "change" }]);
      expect(next.files.map((f) => f.path)).toEqual([]);
    } finally {
      await cleanup(d);
    }
  });

  test("a nested `.rbox` is hard-excluded as a directory AND as a symlink", async () => {
    const d = await mkroot();
    try {
      await fs.mkdir(path.join(d, "a", "b", ".rbox"), { recursive: true });
      await fs.writeFile(path.join(d, "a", "b", ".rbox", "state.json"), "{}");
      await fs.mkdir(path.join(d, "c"), { recursive: true });
      await fs.writeFile(path.join(d, "target.txt"), "t");
      await fs.symlink("../target.txt", path.join(d, "c", ".rbox"));
      await fs.writeFile(path.join(d, ".rboxignore"), "!.rbox\n!a/b/.rbox\n!c/.rbox\n");

      const m = buildIgnoreMatcher(d);
      expect(isHardExcluded("a/b/.rbox")).toBe(true);
      expect(isHardExcluded("a/b/.rbox/state.json")).toBe(true);
      expect(m.ignores("a/b/.rbox/state.json")).toBe(true);
      expect(m.prunes?.("a/b/.rbox/")).toBe(true);
      expect(m.ignores("c/.rbox")).toBe(true);
      expect(await paths(d, m)).toEqual([".rboxignore", "target.txt"]);
    } finally {
      await cleanup(d);
    }
  });

  test("HARD_PRUNE_DIRS stays a bare-name subset of BUILTIN_IGNORE, and vendor/bundle survives", () => {
    const bareDirNames = new Set(
      BUILTIN_IGNORE.filter((p) => p.endsWith("/") && !p.startsWith("!") && !p.slice(0, -1).includes("/") && !/[*?[\]]/.test(p))
        .map((p) => p.slice(0, -1))
    );
    bareDirNames.add(".git"); // the one slashless hard exclude that is also a prune dir
    for (const dir of HARD_PRUNE_DIRS) {
      expect([dir, dir.includes("/"), bareDirNames.has(dir)]).toEqual([dir, false, true]);
    }
    expect(BUILTIN_IGNORE).toContain("vendor/bundle/");
    expect(buildIgnoreMatcher(root).ignores("vendor/bundle/gems/x.rb")).toBe(true);
  });
});
