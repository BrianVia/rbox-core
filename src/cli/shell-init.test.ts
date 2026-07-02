import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellInitZsh } from "./shell-init.js";

const ZSH = Bun.which("zsh");

/** Write the full shell-init script to a temp file and return its path. */
function writeScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "rbox-shellinit-"));
  const file = join(dir, "init.zsh");
  writeFileSync(file, shellInitZsh());
  return file;
}

/**
 * A temp workspace dir with `.rbox/workspace.json` and (optionally) a hand-written
 * `shell.line`. Returns the workspace root path.
 */
function makeWorkspace(shellLine?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rbox-shellinit-ws-"));
  mkdirSync(join(root, ".rbox", "state"), { recursive: true });
  writeFileSync(join(root, ".rbox", "workspace.json"), "{}");
  if (shellLine !== undefined) writeFileSync(join(root, ".rbox", "state", "shell.line"), shellLine);
  return root;
}

/**
 * Source the plugin, cd into a workspace, and fire the hooks directly (chpwd may
 * not run under `zsh -c`). Returns the raw glyph and the banner (stderr).
 */
function driveHooks(scriptFile: string, wsDir: string): { glyph: string; banner: string } {
  const cmd = [
    `source ${scriptFile}`,
    `cd ${wsDir}`,
    "_rbox_chpwd",
    "_rbox_precmd",
    'print -r -- "GLYPH:${RBOX_PROMPT}"',
  ].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd]);
  const stdout = new TextDecoder().decode(res.stdout);
  const stderr = new TextDecoder().decode(res.stderr);
  const glyph = (stdout.match(/GLYPH:(.*)/)?.[1] ?? "").trimEnd();
  return { glyph, banner: stderr };
}

test("the script embeds both hooks, root discovery, the version guard, and completions", () => {
  const s = shellInitZsh();
  expect(s).toContain("add-zsh-hook chpwd _rbox_chpwd");
  expect(s).toContain("add-zsh-hook precmd _rbox_precmd");
  expect(s).toContain("_rbox_find_root");
  expect(s).toContain("RBOX_PROMPT");
  // The v1 version guard — the sidecar contract is refused for any other tag.
  expect(s).toContain("== v1");
  // The completions are appended verbatim (ends with the #compdef header + footer).
  expect(s).toContain("#compdef rbox");
  expect(s).toContain("compdef _rbox rbox");
});

test("the full output parses cleanly under `zsh -n`", () => {
  if (!ZSH) {
    console.warn("zsh not on PATH — skipping `zsh -n` syntax check");
    return;
  }
  const file = writeScript();
  const res = Bun.spawnSync([ZSH, "-n", file]);
  const stderr = new TextDecoder().decode(res.stderr);
  expect(stderr, stderr).toBe("");
  expect(res.exitCode).toBe(0);
});

test("entering an in-sync workspace prints the ✓ banner and glyph", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 ${now - 120} push My Workspace\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(glyph).toContain("✓");
  expect(banner).toContain("rbox: My Workspace");
  expect(banner).toContain("✓");
  expect(banner).toContain("in sync");
  // Name may contain spaces and is read as the trailing field.
  expect(banner).toContain("(seq 80)");
});

test("a halted workspace shows the ⚠ glyph and a halt banner", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} halt - 80 - - My Workspace\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(glyph).toContain("⚠");
  expect(banner).toContain("⚠");
  expect(banner).toContain("halted");
});

test("a stale sidecar (heartbeat > 180s old) shows the ○ 'not running' state", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now - 200} ok - 80 - - My Workspace\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(glyph).toContain("○");
  expect(banner).toContain("○");
  expect(banner).toContain("not running");
});

test("a malformed / wrong-version sidecar degrades silently (no glyph, no banner)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  // Wrong version tag → refused; the workspace has a marker but no valid line.
  const ws = makeWorkspace(`v2 ${now} ok - 80 - - My Workspace\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(glyph).toBe("");
  expect(banner).toBe("");
});
