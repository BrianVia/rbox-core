import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildIgnoreMatcher, nativePruneGlobs } from "./ignore.js";

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
