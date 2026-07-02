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
  // The v1 whole-line shape gate — refuses any other version tag AND malformed fields.
  expect(s).toContain("^v1 [0-9]{1,12} (ok|pending|active|halt)");
  // The completions are appended verbatim (ends with the #compdef header + footer).
  expect(s).toContain("#compdef rbox");
  expect(s).toContain("compdef _rbox rbox");
});

test("auto-append enables PROMPT_SUBST (stock zsh has it off — the embedded $RBOX_PROMPT would render literally); opting out leaves options untouched", () => {
  if (!ZSH) return;
  const file = writeScript();
  const probe = (env: Record<string, string>) => {
    const res = Bun.spawnSync([ZSH, "-f", "-c", `source ${file}; [[ -o prompt_subst ]] && print ON || print OFF; print -r -- "R:$RPROMPT"`], {
      env: { ...process.env, ...env },
    });
    return new TextDecoder().decode(res.stdout);
  };
  const auto = probe({});
  expect(auto).toContain("ON");
  expect(auto).toContain("$RBOX_PROMPT"); // appended, unexpanded in the stored value
  const optOut = probe({ RBOX_NO_RPROMPT: "1" });
  expect(optOut).toContain("OFF");
  expect(optOut).not.toContain("$RBOX_PROMPT");
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

// ── codex R1 regressions ─────────────────────────────────────────────────────

test("a hostile workspace name NEVER executes: backticks / $() / prompt escapes are inert text (codex R1 BLOCKER)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - evil \`id\` $(id) %F{red}$HOME\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(banner).not.toContain("uid="); // `id` did not run
  expect(banner).toContain("`id`"); // rendered as literal text
  expect(banner).toContain("$(id)");
  expect(banner).toContain("%F{red}"); // no prompt expansion either
  expect(banner).toContain("$HOME"); // no parameter expansion of the name
  expect(banner).not.toContain("command not found");
  expect(glyph).toContain("✓"); // the name never enters the glyph
});

test("the halt banner's own backticks are literal, not a command (codex R1 BLOCKER)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} halt - 80 - - My Workspace\n`);
  const { banner } = driveHooks(writeScript(), ws);
  expect(banner).toContain("`rbox status`");
  expect(banner).not.toContain("command not found");
});

test("a truncated line is refused whole — field recycling must not fake an ok state (codex R1 MAJOR)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  for (const line of [`v1 ${now} ok\n`, `v1 ${now} ok 12\n`, `v1 ${now} teleport - 80 - - ws\n`, `v1 ${now} ok twelve 80 - - ws\n`]) {
    const ws = makeWorkspace(line);
    const { glyph, banner } = driveHooks(writeScript(), ws);
    expect(glyph, `line: ${line.trim()}`).toBe("");
    expect(banner, `line: ${line.trim()}`).toBe("");
  }
});

test("RBOX_NO_RPROMPT=1 is retroactive: a re-eval removes the auto-appended segment (codex R1)", () => {
  if (!ZSH) return;
  const file = writeScript();
  const res = Bun.spawnSync([
    ZSH,
    "-f",
    "-c",
    `source ${file}; print -r -- "FIRST:[$RPROMPT]"; RBOX_NO_RPROMPT=1; source ${file}; print -r -- "SECOND:[$RPROMPT]"`,
  ]);
  const out = new TextDecoder().decode(res.stdout);
  expect(out).toContain("FIRST:[ $RBOX_PROMPT]");
  expect(out.match(/SECOND:\[(.*)\]/)?.[1]).not.toContain("$RBOX_PROMPT");
});

// ── codex R2 regressions ─────────────────────────────────────────────────────

test("hostile shell options (SH_WORD_SPLIT, GLOB_SUBST) cannot glob-expand a '*' name or split spacey roots (codex R2)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - *\n`); // a name of literally '*'
  const file = writeScript();
  const cmd = [`setopt sh_word_split glob_subst`, `source ${file}`, `cd ${ws}`, "_rbox_chpwd", "_rbox_precmd", 'print -r -- "GLYPH:${RBOX_PROMPT}"'].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd]);
  const banner = new TextDecoder().decode(res.stderr);
  expect(banner).toContain("rbox: * ✓"); // literal star, not a filename listing
  expect(banner).not.toContain("workspace.json"); // globbing would have matched files
});

test("_rbox_read never clobbers the user's regex match globals (codex R2)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - ws\n`);
  const file = writeScript();
  const cmd = [`source ${file}`, `MATCH=keepme`, `cd ${ws}`, "_rbox_chpwd", "_rbox_precmd", 'print -r -- "MATCH:${MATCH}"'].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd]);
  expect(new TextDecoder().decode(res.stdout)).toContain("MATCH:keepme");
});

test("an absurd hand-edited epoch is refused by the gate — no 'number truncated' at prompt time (codex R2)", () => {
  if (!ZSH) return;
  const ws = makeWorkspace(`v1 ${"9".repeat(1000)} ok - 80 - - ws\n`);
  const { glyph, banner } = driveHooks(writeScript(), ws);
  expect(glyph).toBe("");
  expect(banner).toBe("");
  expect(banner).not.toContain("truncated");
});

test("opt-out removal never deletes a USER-owned ' $RBOX_PROMPT' placement (codex R2)", () => {
  if (!ZSH) return;
  const file = writeScript();
  const cmd = [
    `RPROMPT='pre $RBOX_PROMPT post'`, // user placed it themselves
    `source ${file}`, // guard sees it → no auto-append, no flag
    `RBOX_NO_RPROMPT=1`,
    `source ${file}`, // retroactive path must be a no-op (flag unset)
    'print -r -- "R:[$RPROMPT]"',
  ].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd]);
  expect(new TextDecoder().decode(res.stdout)).toContain("R:[pre $RBOX_PROMPT post]");
});

test("completions register even when eval'd BEFORE compinit (codex R3)", () => {
  if (!ZSH) return;
  const file = writeScript();
  // eval → compinit later → first prompt (retry hook) → registered.
  const before = Bun.spawnSync([
    ZSH,
    "-f",
    "-c",
    `source ${file}; autoload -Uz compinit; compinit -D; _rbox_compdef_retry; print -r -- "COMP:\${_comps[rbox]-MISSING}"`,
  ]);
  expect(new TextDecoder().decode(before.stdout)).toContain("COMP:_rbox");
  // eval AFTER compinit: the inline guarded compdef registers immediately.
  const after = Bun.spawnSync([
    ZSH,
    "-f",
    "-c",
    `autoload -Uz compinit; compinit -D; source ${file}; print -r -- "COMP:\${_comps[rbox]-MISSING}"`,
  ]);
  expect(new TextDecoder().decode(after.stdout)).toContain("COMP:_rbox");
  // no compinit at all: the retry is a silent no-op at each prompt.
  const never = Bun.spawnSync([ZSH, "-f", "-c", `source ${file}; _rbox_compdef_retry; print -r -- "OK"`]);
  expect(new TextDecoder().decode(never.stdout)).toContain("OK");
  expect(new TextDecoder().decode(never.stderr)).toBe("");
});
