import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_HELP } from "./help-registry.js";
import { zshCompletions } from "./completions.js";

const firstWord = (s: string) => s.split(" ")[0]!;
const publicCmds = COMMAND_HELP.filter((c) => !c.hidden && !c.alias);
const publicHeads = [...new Set(publicCmds.map((c) => firstWord(c.name)))];

test("script contains every public top-level command as a completion entry", () => {
  const script = zshCompletions();
  // Each head is emitted as a `_describe` value: `'<head>:...'`.
  for (const head of publicHeads) {
    expect(script, `missing top-level completion for '${head}'`).toContain(`'${head}:`);
  }
});

// "multi-word names surface as subcommands with descriptions" is commented out:
// its only live example was "deps install" under the "deps" group, and the whole
// `deps` group is currently disabled (design 50, index.ts/help-registry.ts).
// Reinstate once `deps` (or another multi-word command) returns:
//
// test("multi-word names surface as subcommands with descriptions", () => {
//   const script = zshCompletions();
//   const depsInstall = COMMAND_HELP.find((c) => c.name === "deps install");
//   expect(depsInstall).toBeDefined();
//   expect(script).toContain("_rbox_deps_cmds");
//   expect(script).toContain(`'install:${depsInstall!.summary}`);
// });

test("known flags are completed from registry metadata", () => {
  const script = zshCompletions();
  // Verify the flag actually exists in the registry rather than hardcoding.
  const owners = COMMAND_HELP.filter((c) => c.flags?.some((f) => f.flag.startsWith("--allow-mass-delete")));
  expect(owners.length, "--allow-mass-delete should exist in the registry").toBeGreaterThan(0);
  expect(script).toContain("--allow-mass-delete[");
});

test("no hidden or internal tokens leak into the script", () => {
  const script = zshCompletions();
  expect(script).not.toContain("__daemon-run");
  // Every hidden / deprecated-alias command must be absent as a completion value.
  const suppressed = COMMAND_HELP.filter((c) => c.hidden || c.alias);
  for (const c of suppressed) {
    const head = firstWord(c.name);
    if (publicHeads.includes(head)) continue; // head is also a public group (none today)
    expect(script, `hidden/alias token '${head}' leaked`).not.toContain(`'${head}:`);
  }
});

test("output is deterministic across calls", () => {
  expect(zshCompletions()).toBe(zshCompletions());
});

test("registration is guarded so it works with or without compinit", () => {
  const script = zshCompletions();
  expect(script).toContain("(( $+functions[compdef] )) && compdef _rbox rbox");
});

test("the generated script parses cleanly under `zsh -n`", () => {
  const zsh = Bun.which("zsh");
  if (!zsh) {
    console.warn("zsh not on PATH — skipping `zsh -n` syntax check");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "rbox-completions-"));
  const file = join(dir, "_rbox");
  writeFileSync(file, zshCompletions());
  const res = Bun.spawnSync([zsh, "-n", file]);
  const stderr = new TextDecoder().decode(res.stderr);
  expect(stderr, stderr).toBe("");
  expect(res.exitCode).toBe(0);
});
