import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listIgnoreRules } from "./ignore-cmd.js";

const originalLog = console.log;
afterEach(() => { console.log = originalLog; });

test("bare ignore collapses builtins while --list prints every rule", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ignore-list-"));
  await fs.mkdir(path.join(root, ".rbox"));
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), "{}");
  await fs.writeFile(path.join(root, ".gitignore"), "generated/**\n");
  await fs.writeFile(path.join(root, ".rboxignore"), "dist/**\n");
  const logs: string[] = [];
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  try {
    await listIgnoreRules(root);
    const summary = logs.join("\n");
    expect(summary).toContain("respectGitignore: off");
    expect(summary).toContain("[.gitignore present but NOT applied (respectGitignore off)] generated/**");
    expect(summary).toContain("default patterns (node_modules, .git, build caches, …)");
    expect(summary).toContain("[.rboxignore] dist/**");
    expect(summary).not.toContain("[builtin] node_modules");
    logs.length = 0;
    await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({ respectGitignore: true }));
    await listIgnoreRules(root, { full: true });
    expect(logs.join("\n")).toContain("respectGitignore: on");
    expect(logs.join("\n")).toContain("[.gitignore ACTIVE] generated/**");
    expect(logs.join("\n")).toContain("[builtin] node_modules");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
