// NOTE (design 51): `deps-notify.ts` is currently unreachable from the CLI —
// `rbox deps notify`, `rbox setup`'s notify prompt, and `install.sh`'s
// --with-dep-notify are all commented out (the whole `deps` group is
// disabled). These tests intentionally keep exercising the module directly:
// the implementation is untouched, only its callers are disconnected, so this
// coverage stays meaningful for when it's re-wired.
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectShell,
  hookScript,
  installNotify,
  rcBlock,
  rcFileFor,
  removeBlock,
  uninstallNotify,
  upsertBlock,
} from "./deps-notify.js";
import { loadDepsState } from "./deps-drift.js";

// ── pure block upsert/remove (idempotent rc editing) ────────────────────────

test("upsertBlock appends when absent and replaces in place when present (idempotent)", () => {
  const rc = "export PATH=/usr/bin\nalias ll='ls -l'\n";
  const block = "# >>> rbox dep-drift >>>\nfoo\n# <<< rbox dep-drift <<<\n";
  const once = upsertBlock(rc, block);
  expect(once).toContain("alias ll='ls -l'"); // existing content preserved
  expect((once.match(/rbox dep-drift >>>/g) ?? []).length).toBe(1);

  const newBlock = "# >>> rbox dep-drift >>>\nbar\n# <<< rbox dep-drift <<<\n";
  const twice = upsertBlock(once, newBlock);
  expect((twice.match(/rbox dep-drift >>>/g) ?? []).length).toBe(1); // not duplicated
  expect(twice).toContain("bar");
  expect(twice).not.toContain("foo");
});

test("removeBlock strips the fenced block and is a no-op when absent", () => {
  const block = "# >>> rbox dep-drift >>>\nfoo\n# <<< rbox dep-drift <<<\n";
  const rc = upsertBlock("setopt nomatch\n", block);
  const stripped = removeBlock(rc);
  expect(stripped).not.toContain("rbox dep-drift");
  expect(stripped).toContain("setopt nomatch");
  expect(removeBlock(stripped)).toBe(stripped); // idempotent
});

// ── generated snippets (security-sensitive — founder review) ─────────────────

const BIN = "/Users/me/.rbox/bin/rbox";

test("hook script invokes the ABSOLUTE binary, runs the quiet drift check, and uses no eval", () => {
  for (const shell of ["zsh", "bash", "fish"] as const) {
    const s = hookScript(shell, BIN);
    expect(s).toContain(`'${BIN}' deps drift --quiet`); // absolute + single-quoted, never bare `rbox`
    expect(s).not.toContain("eval");
    expect(s).not.toMatch(/(^|[^.])\brbox deps drift/); // not a bare $PATH-resolved rbox
  }
});

test("hook script registers the right per-shell change trigger and prefilters before forking", () => {
  expect(hookScript("zsh", BIN)).toContain("add-zsh-hook chpwd __rbox_dep_drift");
  expect(hookScript("bash", BIN)).toContain("PROMPT_COMMAND"); // no chpwd in bash
  expect(hookScript("fish", BIN)).toContain("--on-variable PWD");
  expect(hookScript("zsh", BIN)).toContain("package.json"); // pure-shell prefilter present
});

test("rc block verifies the hook (regular file, not a symlink, owner) BEFORE sourcing it", () => {
  const block = rcBlock("zsh", "/cfg/hook.zsh");
  expect(block).toContain("# >>> rbox dep-drift >>>");
  expect(block).toContain('[ ! -L "$__rbox_hook" ]'); // reject symlink
  expect(block).toContain('[ -O "$__rbox_hook" ]'); // owner-only
  expect(block).toContain("& 022"); // reject group/world-writable
  // The source happens only inside the guard, after the checks.
  const guardIdx = block.indexOf("[ ! -L");
  const sourceIdx = block.indexOf('. "$__rbox_hook"');
  expect(guardIdx).toBeGreaterThanOrEqual(0);
  expect(sourceIdx).toBeGreaterThan(guardIdx);
  expect(block).not.toContain("eval");
});

test("detectShell maps $SHELL to a supported shell", () => {
  const orig = process.env.SHELL;
  try {
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
    process.env.SHELL = "/usr/local/bin/fish";
    expect(detectShell()).toBe("fish");
    process.env.SHELL = "/bin/bash";
    expect(detectShell()).toBe("bash");
    process.env.SHELL = "/bin/sh"; // bare sh → bash family
    expect(detectShell()).toBe("bash");
  } finally {
    if (orig === undefined) delete process.env.SHELL;
    else process.env.SHELL = orig;
  }
});

// ── install / uninstall round-trip (against an isolated HOME) ─────────────────

let home: string;
let cfgDir: string;
let origHome: string | undefined;
const origLog = console.log;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-home-"));
  cfgDir = path.join(home, ".config", "rbox");
  origHome = process.env.HOME;
  process.env.HOME = home;
  process.env.RBOX_CONFIG_DIR = cfgDir;
  process.env.RBOX_BIN = BIN;
  console.log = () => {};
});
afterEach(async () => {
  console.log = origLog;
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  delete process.env.RBOX_CONFIG_DIR;
  delete process.env.RBOX_BIN;
  await fs.rm(home, { recursive: true, force: true });
});

test("install writes the hook + rc block and records the rc location; uninstall cleans all of it", async () => {
  await installNotify({ shell: "zsh" });

  const rcFile = rcFileFor("zsh");
  const rc = await fs.readFile(rcFile, "utf8");
  expect(rc).toContain("# >>> rbox dep-drift >>>");

  const hookPath = path.join(cfgDir, "hook.zsh");
  const hook = await fs.readFile(hookPath, "utf8");
  expect(hook).toContain(`'${BIN}' deps drift --quiet`);
  // Hook file is not group/world-writable (the rc guard requires `& 022 == 0`).
  expect((await fs.stat(hookPath)).mode & 0o022).toBe(0);

  const state = await loadDepsState();
  expect(state.notifyEnabled).toBe(true);
  expect(state.hooks).toEqual([{ shell: "zsh", rcFile }]);

  await uninstallNotify();
  expect(await fs.readFile(rcFile, "utf8")).not.toContain("rbox dep-drift");
  await expect(fs.access(hookPath)).rejects.toThrow();
  expect((await loadDepsState()).hooks).toEqual([]);
});

test("install is idempotent — re-running does not duplicate the rc block", async () => {
  await installNotify({ shell: "zsh" });
  await installNotify({ shell: "zsh" });
  const rc = await fs.readFile(rcFileFor("zsh"), "utf8");
  expect((rc.match(/rbox dep-drift >>>/g) ?? []).length).toBe(1);
  expect((await loadDepsState()).hooks).toHaveLength(1);
});
