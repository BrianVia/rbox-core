/**
 * `rbox deps notify <install|uninstall|status|on|off>` (design 29) — the optional
 * shell hook that runs the drift check on `cd`/`chpwd`. It ships OFF by default and
 * is opt-in only (the `setup` prompt or `install.sh` consent), because a Node/Bun
 * cold start on every `cd` can't be promised invisible — the post-sync nudge is the
 * primary surface; this is an enhancement for deps that change OUTSIDE rbox.
 *
 * Safety (design §"The shell hook"):
 *   - the rc block VERIFIES the hook file before sourcing it (regular file, not a
 *     symlink, owned by the user, not group/world-writable) — the check must live in
 *     the rc, since the sourced file is exactly what an attacker could swap;
 *   - the hook invokes the ABSOLUTE installed binary (never a bare `rbox` off $PATH,
 *     since a repo could ship a `./rbox`), uses no `eval`, and spawns detached/async
 *     so the prompt is never blocked.
 *
 * The string generators are pure + exported so the (founder-reviewed) snippet and the
 * idempotent install/uninstall are unit-tested without touching a real shell.
 */
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "../engine/index.js";
import { configDir, homeDir } from "./rbox-paths.js";
import { loadDepsState, saveDepsState } from "./deps-drift.js";
import { style } from "./style.js";

export type Shell = "zsh" | "bash" | "fish";

const BEGIN = "# >>> rbox dep-drift >>>";
const END = "# <<< rbox dep-drift <<<";

/** Lockfile/manifest names the pure-shell prefilter checks (no fork in the common,
 *  manifest-free directory). Kept in sync with the engine ecosystems. */
const MANIFEST_FILES = [
  "package.json", "pnpm-lock.yaml", "yarn.lock", "package-lock.json", "npm-shrinkwrap.json",
  "bun.lock", "bun.lockb", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
  "pyproject.toml", "uv.lock", "poetry.lock", "Gemfile", "Gemfile.lock",
];

// ── shell + path resolution ───────────────────────────────────────────────────

/** Resolve the running shell from `$SHELL`, falling back to the parent process name. */
export function detectShell(): Shell | undefined {
  const fromEnv = shellFromString(process.env.SHELL);
  if (fromEnv) return fromEnv;
  try {
    const comm = execFileSync("ps", ["-p", String(process.ppid), "-o", "comm="], { encoding: "utf8" });
    return shellFromString(comm);
  } catch {
    return undefined;
  }
}

function shellFromString(s: string | undefined): Shell | undefined {
  if (!s) return undefined;
  const base = path.basename(s.trim()).replace(/^-/, "");
  if (base.includes("zsh")) return "zsh";
  if (base.includes("fish")) return "fish";
  if (base.includes("bash") || base === "sh") return "bash";
  return undefined;
}

export function rcFileFor(shell: Shell): string {
  const home = homeDir();
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "fish") return path.join(home, ".config", "fish", "config.fish");
  return path.join(home, ".bashrc");
}

export function hookFilePath(shell: Shell): string {
  return path.join(configDir(), `hook.${shell}`);
}

/** The ABSOLUTE installed binary the hook invokes — never a bare `rbox` off $PATH.
 *  Prefers an explicit override, then the compiled binary's own path, then the
 *  default install location. */
export function resolveBinPath(): string {
  if (process.env.RBOX_BIN) return process.env.RBOX_BIN;
  if (path.basename(process.execPath) === "rbox") return process.execPath;
  return path.join(homeDir(), ".rbox", "bin", "rbox");
}

// ── generated snippets (pure) ─────────────────────────────────────────────────

/** The hook file contents: prefilter → detached async drift check → registration. */
export function hookScript(shell: Shell, binPath: string): string {
  if (shell === "fish") {
    const tests = MANIFEST_FILES.map((f) => `test -f ${f}`).join("; or ");
    return [
      "# rbox dep-drift hook (fish) — generated; edits are overwritten by `rbox deps notify install`.",
      "function __rbox_dep_drift --on-variable PWD",
      `    ${tests}; or return`,
      `    ${q(binPath)} deps drift --quiet &`,
      "    disown",
      "end",
      "",
    ].join("\n");
  }
  // zsh + bash share the same pure-shell prefilter; the function body + registration
  // differ (zsh has chpwd; bash guards a PROMPT_COMMAND on $PWD change).
  const prefilter = MANIFEST_FILES.map((f) => `-f ${f}`).join(" || ");
  if (shell === "zsh") {
    return [
      "# rbox dep-drift hook (zsh) — generated; edits are overwritten by `rbox deps notify install`.",
      "__rbox_dep_drift() {",
      `  [[ ${prefilter} ]] || return`,
      `  ( ${q(binPath)} deps drift --quiet & ) >/dev/null 2>&1`,
      "}",
      "autoload -Uz add-zsh-hook",
      "add-zsh-hook chpwd __rbox_dep_drift",
      "",
    ].join("\n");
  }
  // bash: no chpwd — a PROMPT_COMMAND guard that only runs on an actual $PWD change.
  return [
    "# rbox dep-drift hook (bash) — generated; edits are overwritten by `rbox deps notify install`.",
    "__rbox_dep_drift() {",
    `  [ "$PWD" = "$__rbox_last_pwd" ] && return`,
    `  __rbox_last_pwd="$PWD"`,
    `  [[ ${prefilter} ]] || return`,
    `  ( ${q(binPath)} deps drift --quiet & ) >/dev/null 2>&1`,
    "}",
    'case ";$PROMPT_COMMAND;" in',
    "  *\";__rbox_dep_drift;\"*) ;;",
    '  *) PROMPT_COMMAND="__rbox_dep_drift;${PROMPT_COMMAND}" ;;',
    "esac",
    "",
  ].join("\n");
}

/** The rc block that VERIFIES the hook file before sourcing it (tamper check lives
 *  here, not in the sourced file). Fenced with markers so removal is exact. */
export function rcBlock(shell: Shell, hookPath: string): string {
  if (shell === "fish") {
    // fish `math` lacks a portable bitwise AND, so we enforce regular-file +
    // not-a-symlink + owner-only here; the group/world-writable bit is omitted for
    // fish (documented). A swapped/symlinked hook is still rejected.
    return [
      BEGIN,
      `set -l __rbox_hook ${q(hookPath)}`,
      'if test -f "$__rbox_hook"; and test ! -L "$__rbox_hook"; and test -O "$__rbox_hook"',
      '    source "$__rbox_hook"',
      "end",
      END,
      "",
    ].join("\n");
  }
  return [
    BEGIN,
    `__rbox_hook=${q(hookPath)}`,
    'if [ -f "$__rbox_hook" ] && [ ! -L "$__rbox_hook" ] && [ -O "$__rbox_hook" ]; then',
    "  # reject group/world-writable: mask 022 must be clear",
    `  __rbox_perm=$(stat -f '%Lp' "$__rbox_hook" 2>/dev/null || stat -c '%a' "$__rbox_hook" 2>/dev/null)`,
    '  [ $(( 0${__rbox_perm:-777} & 022 )) -eq 0 ] && . "$__rbox_hook"',
    "fi",
    "unset __rbox_hook __rbox_perm",
    END,
    "",
  ].join("\n");
}

/** Single-quote a path for shell safety (the install dir is user-controlled). */
function q(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ── pure block upsert/remove (idempotent) ─────────────────────────────────────

const BLOCK_RE = new RegExp(`\\n?${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`, "g");

/** Replace an existing rbox block, or append a fresh one. Idempotent. */
export function upsertBlock(rc: string, block: string): string {
  const stripped = removeBlock(rc);
  const sep = stripped.length === 0 || stripped.endsWith("\n") ? "" : "\n";
  return `${stripped}${sep}${block.endsWith("\n") ? block : `${block}\n`}`;
}

/** Strip the rbox block (inclusive of markers). Idempotent — no-op if absent. */
export function removeBlock(rc: string): string {
  return rc.replace(BLOCK_RE, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── commands ──────────────────────────────────────────────────────────────────

async function readRc(file: string): Promise<string> {
  try {
    return await fsp.readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** Install the hook for `shell` (or the detected shell): write the verified hook
 *  file (0600), append the verifying rc block, and record the rc location. */
export async function installNotify(opts: { shell?: Shell } = {}): Promise<void> {
  const shell = opts.shell ?? detectShell();
  if (!shell) {
    throw new Error("couldn't detect your shell — set SHELL or run `rbox deps notify install` from zsh/bash/fish");
  }
  const binPath = resolveBinPath();
  const hookPath = hookFilePath(shell);
  await fsp.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await fsp.writeFile(hookPath, hookScript(shell, binPath), { mode: 0o600 });
  await fsp.chmod(hookPath, 0o600).catch(() => {});

  const rcFile = rcFileFor(shell);
  await fsp.mkdir(path.dirname(rcFile), { recursive: true });
  // Atomic replace so a crash mid-write can't corrupt the user's rc file.
  await writeFileAtomic(rcFile, upsertBlock(await readRc(rcFile), rcBlock(shell, hookPath)));

  const state = await loadDepsState();
  state.notifyEnabled = true;
  state.hooks = [...state.hooks.filter((h) => h.rcFile !== rcFile), { shell, rcFile }];
  await saveDepsState(state);

  console.log(`${style.sym.ok} dependency-change notifications enabled for ${shell}.`);
  console.log(style.dim(`  hook: ${hookPath}`));
  console.log(style.dim(`  added to: ${rcFile} (restart your shell or \`source\` it to activate)`));
  console.log(style.dim("  pause anytime: `rbox deps notify off` · remove: `rbox deps notify uninstall`"));
}

/** Remove the hook from EVERY rc file we recorded (a user may have several shells). */
export async function uninstallNotify(): Promise<void> {
  const state = await loadDepsState();
  const cleaned: string[] = [];
  for (const { rcFile } of state.hooks) {
    const rc = await readRc(rcFile);
    if (!rc) continue;
    const next = removeBlock(rc);
    if (next !== rc) {
      await writeFileAtomic(rcFile, next);
      cleaned.push(rcFile);
    }
  }
  for (const shell of ["zsh", "bash", "fish"] as Shell[]) {
    await fsp.rm(hookFilePath(shell), { force: true });
  }
  state.hooks = [];
  await saveDepsState(state);

  console.log(`${style.sym.ok} dependency-change notifications removed.`);
  if (cleaned.length) for (const f of cleaned) console.log(style.dim(`  cleaned: ${f}`));
  else console.log(style.dim("  no installed hooks were found."));
}

export async function statusNotify(): Promise<void> {
  const state = await loadDepsState();
  console.log(`dependency-change notifications: ${state.notifyEnabled ? style.green("on") : style.yellow("off (paused)")}`);
  if (state.hooks.length) {
    console.log(style.dim("  installed in:"));
    for (const h of state.hooks) console.log(`    ${h.shell}  ${h.rcFile}`);
  } else {
    console.log(style.dim("  no shell hook installed (`rbox deps notify install` to add one)."));
  }
}

/** Instant toggle (no rc edit) — the hook reads this flag and no-ops when off. */
export async function setNotifyEnabled(enabled: boolean): Promise<void> {
  const state = await loadDepsState();
  state.notifyEnabled = enabled;
  await saveDepsState(state);
  console.log(`dependency-change notifications ${enabled ? style.green("on") : style.yellow("off")}.`);
}

/** `rbox deps notify <sub>` dispatch. */
export async function notifyCmd(sub: string | undefined): Promise<void> {
  switch (sub) {
    case "install":
      await installNotify();
      break;
    case "uninstall":
      await uninstallNotify();
      break;
    case "status":
      await statusNotify();
      break;
    case "on":
      await setNotifyEnabled(true);
      break;
    case "off":
      await setNotifyEnabled(false);
      break;
    default:
      console.log("usage: rbox deps notify <install | uninstall | status | on | off>");
      process.exitCode = 1;
  }
}
