import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
function makeWorkspace(shellLine?: string, shellDeferrals?: string): string {
  const root = mkdtempSync(join(tmpdir(), "rbox-shellinit-ws-"));
  mkdirSync(join(root, ".rbox", "state"), { recursive: true });
  writeFileSync(join(root, ".rbox", "workspace.json"), "{}");
  if (shellLine !== undefined) writeFileSync(join(root, ".rbox", "state", "shell.line"), shellLine);
  if (shellDeferrals !== undefined) writeFileSync(join(root, ".rbox", "state", "shell.deferrals"), shellDeferrals);
  return root;
}

/**
 * Source the plugin, cd into a workspace, and fire the hooks directly (chpwd may
 * not run under `zsh -c`). Returns the raw glyph and the banner (stderr).
 */
function driveHooks(scriptFile: string, wsDir: string, pwd = wsDir): { glyph: string; banner: string } {
  const cmd = [
    `source ${scriptFile}`,
    `cd ${pwd}`,
    "_rbox_chpwd",
    "_rbox_precmd",
    'print -r -- "GLYPH:${RBOX_PROMPT}"',
  ].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd], { cwd: tmpdir() });
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
  expect(s).toContain("prompt-status");
  expect(s).toContain("_RBOX_PROMPT_STATUS_DEFAULT=0");
  expect(s).toContain("RBOX_PROMPT");
  // The v1 whole-line shape gate — refuses any other version tag AND malformed fields.
  expect(s).toContain("^v1 [0-9]{1,12} (ok|pending|active|halt)");
  // The completions are appended verbatim (ends with the #compdef header + footer).
  expect(s).toContain("#compdef rbox");
  expect(s).toContain("compdef _rbox rbox");
});

test("RBOX_USE_PROMPT_STATUS=1 prefers prompt-status and falls back to shell.line by default", () => {
  if (!ZSH) return;
  const dir = mkdtempSync(join(tmpdir(), "rbox-shellinit-bin-"));
  const fake = join(dir, "rbox");
  writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = prompt-status ]; then echo '↑7'; exit 0; fi\nexit 1\n");
  chmodSync(fake, 0o755);
  const file = writeScript();
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - My Workspace\n`);
  const cmd = [
    `RBOX_USE_PROMPT_STATUS=1`,
    `RBOX_BIN=${fake}`,
    `source ${file}`,
    `cd ${ws}`,
    "_rbox_chpwd",
    "_rbox_precmd",
    'print -r -- "GLYPH:${RBOX_PROMPT}"',
  ].join("; ");
  const res = Bun.spawnSync([ZSH, "-f", "-c", cmd], { cwd: tmpdir() });
  const stdout = new TextDecoder().decode(res.stdout);
  const stderr = new TextDecoder().decode(res.stderr);
  expect(stderr).toContain("↑7");
  expect(stdout).toContain("GLYPH:%F{cyan}↑7%f");
});

test("auto-append enables PROMPT_SUBST (stock zsh has it off — the embedded $RBOX_PROMPT would render literally); opting out leaves options untouched", () => {
  if (!ZSH) return;
  const file = writeScript();
  const probe = (env: Record<string, string>) => {
    const res = Bun.spawnSync([ZSH, "-f", "-c", `source ${file}; [[ -o prompt_subst ]] && print ON || print OFF; print -r -- "R:$RPROMPT"`], {
      cwd: tmpdir(),
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

test("a stale sidecar (heartbeat > 15s old) shows the ○ 'not running' state", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now - 20} ok - 80 - - My Workspace\n`);
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

test("shell.deferrals routes on component boundaries and chooses the deepest enclosing repo", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(
    `v1 ${now} ok - 80 - - ws\n`,
    "v1\nrepo\tlocal-edits\t14d\t0\nrepo%2Fnested\tlocal-commits\t30m\t1\nstale\tstale-unattributed\t1h\t0\n",
  );
  mkdirSync(join(ws, "repo", "nested", "src"), { recursive: true });
  mkdirSync(join(ws, "stale"), { recursive: true });
  mkdirSync(join(ws, "repository"), { recursive: true });
  const nested = driveHooks(writeScript(), ws, join(ws, "repo", "nested", "src"));
  expect(nested.glyph).toContain("⚠git:30m+files");
  expect(nested.banner).toContain("git deferred 30m · working files changed");
  expect(nested.banner).not.toContain("in sync");
  expect(driveHooks(writeScript(), ws, join(ws, "repo")).glyph).toContain("⚠git:14d");
  expect(driveHooks(writeScript(), ws, join(ws, "stale")).glyph).toContain("⚠git:1h");
  expect(driveHooks(writeScript(), ws, join(ws, "repository")).glyph).toContain("✓");
});

test("shell.deferrals accepts deletion-pending without dropping the sidecar", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(
    `v1 ${now} ok - 80 - - ws\n`,
    "v1\nrepo\tdeletion-pending\t1h\t0\n",
  );
  mkdirSync(join(ws, "repo"), { recursive: true });
  const driven = driveHooks(writeScript(), ws, join(ws, "repo"));
  expect(driven.glyph).toContain("⚠git:1h");
  expect(driven.banner).toContain("git deferred 1h");
});

test("shell.deferrals root overflow row warns an omitted 51st repo while explicit rows win", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const explicit = Array.from({ length: 49 }, (_, i) => `repo${i}\tlocal-edits\t14d\t0`).join("\n");
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - ws\n`, `v1\n${explicit}\n.\tother\t1h\t1\n`);
  for (let i = 0; i < 51; i++) mkdirSync(join(ws, `repo${i}`), { recursive: true });
  expect(driveHooks(writeScript(), ws, join(ws, "repo1")).glyph).toContain("⚠git:14d");
  expect(driveHooks(writeScript(), ws, join(ws, "repo50")).glyph).toContain("⚠git:1h+files");
});

test("malformed or oversized shell.deferrals is ignored whole", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const cases = [
    "v2\nrepo\tlocal-edits\t14d\t0\n",
    "v1\nrepo\tnot-a-reason\t14d\t0\n",
    "v1\nrepo%ZZ\tlocal-edits\t14d\t0\n",
    "v1\nrepo\tlocal-edits\t14d\t0\t\n",
    "v1\nrepo\tlocal-edits\t60m\t0\n",
    "v1\nrepo\tlocal-edits\t14d\t0\nunterminated-row",
    `v1\nrepo\tlocal-edits\t${"9".repeat(1000)}m\t0\n`,
    `v1\nrepo\tlocal-edits\t14d\t0\n${"x".repeat(8200)}\tother\t1h\t0\n`,
    `v1\nrepo\tlocal-edits\t14d\t0\n${"é".repeat(4100)}\tother\t1h\t0\n`,
    `v1\n${Array.from({ length: 51 }, (_, i) => `repo${i}\tother\t1h\t0`).join("\n")}\n`,
  ];
  for (const sidecar of cases) {
    const ws = makeWorkspace(`v1 ${now} ok - 80 - - ws\n`, sidecar);
    mkdirSync(join(ws, "repo"), { recursive: true });
    expect(driveHooks(writeScript(), ws, join(ws, "repo")).glyph, sidecar.slice(0, 40)).toContain("✓");
  }
});

test("shell.deferrals does not mask halt, active, or pending shell.line states", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const states = [
    { line: `v1 ${now} halt - 80 - - ws\n`, glyph: "⚠" },
    { line: `v1 ${now} active 50 80 - - ws\n`, glyph: "↻" },
    { line: `v1 ${now} pending - 80 - - ws\n`, glyph: "↑" },
  ];
  for (const { line, glyph } of states) {
    const ws = makeWorkspace(line, "v1\n.\tlocal-edits\t14d\t1\n");
    const driven = driveHooks(writeScript(), ws);
    expect(driven.glyph).toContain(glyph);
    expect(driven.glyph).not.toContain("git:");
    expect(driven.banner).not.toContain("git deferred");
  }
});

test("shell.deferrals present-sidecar reader stays within the 5ms p99 prompt budget", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = Array.from({ length: 50 }, (_, i) => `repo%2Fnested%2Fr${i}\tother\t14d\t0`).join("\n");
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - ws\n`, `v1\n${rows}\n`);
  const file = writeScript();
  const cmd = [
    `source ${file}`,
    `cd ${ws}`,
    "zmodload zsh/datetime",
    `for i in {1..350}; do start=$EPOCHREALTIME; _rbox_deferrals ${ws}; print -r -- $(( (EPOCHREALTIME - start) * 1000000 )); done`,
  ].join("; ");
  const res = Bun.spawnSync([ZSH, "-f", "-c", cmd], { cwd: tmpdir() });
  expect(res.exitCode).toBe(0);
  const micros = new TextDecoder().decode(res.stdout).trim().split("\n").map(Number).filter(Number.isFinite).slice(50).sort((a, b) => a - b);
  expect(micros.length).toBe(300);
  const p99 = micros[Math.ceil(micros.length * 0.99) - 1]!;
  expect(p99).toBeLessThanOrEqual(5_000);
});

// ── review-regression guards ─────────────────────────────────────────────────────

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
  ], { cwd: tmpdir() });
  const out = new TextDecoder().decode(res.stdout);
  expect(out).toContain("FIRST:[ $RBOX_PROMPT]");
  expect(out.match(/SECOND:\[(.*)\]/)?.[1]).not.toContain("$RBOX_PROMPT");
});

// ── review-regression guards ─────────────────────────────────────────────────────

test("hostile shell options (SH_WORD_SPLIT, GLOB_SUBST) cannot glob-expand a '*' name or split spacey roots (codex R2)", () => {
  if (!ZSH) return;
  const now = Math.floor(Date.now() / 1000);
  const ws = makeWorkspace(`v1 ${now} ok - 80 - - *\n`); // a name of literally '*'
  const file = writeScript();
  const cmd = [`setopt sh_word_split glob_subst`, `source ${file}`, `cd ${ws}`, "_rbox_chpwd", "_rbox_precmd", 'print -r -- "GLYPH:${RBOX_PROMPT}"'].join("; ");
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd], { cwd: tmpdir() });
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
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd], { cwd: tmpdir() });
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
  const res = Bun.spawnSync([ZSH!, "-f", "-c", cmd], { cwd: tmpdir() });
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
  ], { cwd: tmpdir() });
  expect(new TextDecoder().decode(before.stdout)).toContain("COMP:_rbox");
  // eval AFTER compinit: the inline guarded compdef registers immediately.
  const after = Bun.spawnSync([
    ZSH,
    "-f",
    "-c",
    `autoload -Uz compinit; compinit -D; source ${file}; print -r -- "COMP:\${_comps[rbox]-MISSING}"`,
  ], { cwd: tmpdir() });
  expect(new TextDecoder().decode(after.stdout)).toContain("COMP:_rbox");
  // no compinit at all: the retry is a silent no-op at each prompt.
  const never = Bun.spawnSync([ZSH, "-f", "-c", `source ${file}; _rbox_compdef_retry; print -r -- "OK"`], { cwd: tmpdir() });
  expect(new TextDecoder().decode(never.stdout)).toContain("OK");
  expect(new TextDecoder().decode(never.stderr)).toBe("");
});
