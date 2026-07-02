/**
 * Per-command help (design 29 §"Per-command help"). A small STATIC registry — one
 * entry per command — decoupled from the dispatcher `switch`. It feeds two things
 * from a single source of truth:
 *
 *   - `rbox <cmd> --help` / `rbox help <cmd>` → that command's block, and
 *   - bare `rbox help` (or an unknown command) → the grouped screen.
 *
 * It can still drift from the real `switch` (separate code), so a parity test
 * (help-registry.test.ts) asserts the public registry matches the command catalog.
 * Presentation only — no entry here changes any command's behavior.
 */
import { style } from "./style.js";

export type HelpGroup =
  | "GETTING STARTED"
  | "SYNCING"
  | "DEPENDENCIES"
  | "DEVICES & ACCOUNT"
  | "BILLING & MAINTENANCE";

export interface CommandHelp {
  /** Command path, e.g. "track" or "deps install". */
  name: string;
  group: HelpGroup;
  /** One line for the grouped screen. */
  summary: string;
  /** Full invocation, e.g. "rbox track <path> [--workspace <id>]". */
  usage: string;
  flags?: { flag: string; desc: string }[];
  examples?: string[];
  /** Excluded from the grouped screen (init, deprecated aliases, internal). */
  hidden?: boolean;
  /** If set, this is a deprecated alias forwarding to that command path. */
  alias?: string;
}

/** Group render order for the grouped screen. */
export const GROUP_ORDER: HelpGroup[] = [
  "GETTING STARTED",
  "SYNCING",
  "DEPENDENCIES",
  "DEVICES & ACCOUNT",
  "BILLING & MAINTENANCE",
];

export const COMMAND_HELP: CommandHelp[] = [
  // ── GETTING STARTED ──────────────────────────────────────────────────────
  {
    name: "setup",
    group: "GETTING STARTED",
    summary: "guided onboarding: account → workspace → start syncing",
    usage: "rbox setup",
    examples: ["rbox setup"],
  },
  {
    name: "login",
    group: "GETTING STARTED",
    summary: "authorize this machine",
    usage: "rbox login [--bootstrap <secret>]",
    flags: [{ flag: "--bootstrap <secret>", desc: "create a new account from a bootstrap secret (genesis device)" }],
  },
  {
    name: "logout",
    group: "GETTING STARTED",
    summary: "remove this machine's credential",
    usage: "rbox logout",
  },
  {
    name: "status",
    group: "GETTING STARTED",
    summary: "workspace + background-sync state",
    usage: "rbox status [path]",
  },
  {
    name: "init",
    group: "GETTING STARTED",
    summary: "headless/CI onboarding (the scripting form of setup)",
    usage: "rbox init [--new | --workspace <id>] [--root <path>] [--no-interactive]",
    flags: [
      { flag: "--new", desc: "create a new workspace" },
      { flag: "--workspace <id>", desc: "join an existing workspace" },
      { flag: "--root <path>", desc: "directory to track (default: cwd)" },
      { flag: "--no-interactive", desc: "never prompt (CI); fail fast if inputs are missing" },
    ],
    hidden: true, // documented under `rbox help init`, not in the grouped screen
  },

  // ── SYNCING ──────────────────────────────────────────────────────────────
  {
    name: "start",
    group: "SYNCING",
    summary: "start background sync for this workspace",
    usage: "rbox start [path]",
  },
  {
    name: "stop",
    group: "SYNCING",
    summary: "stop background sync",
    usage: "rbox stop [path]",
  },
  {
    name: "logs",
    group: "SYNCING",
    summary: "tail background-sync logs",
    usage: "rbox logs [path] [--follow] [--lines N]",
    flags: [
      { flag: "--follow", desc: "stream new log lines (Ctrl-C to exit)" },
      { flag: "--lines N", desc: "show the last N lines (default 50)" },
    ],
  },
  {
    name: "sync",
    group: "SYNCING",
    summary: "sync once (pull, then push)",
    usage: "rbox sync [path] [--allow-mass-delete]",
    flags: [{ flag: "--allow-mass-delete", desc: "consent to a pull that deletes half or more of the tracked files" }],
  },
  {
    name: "push",
    group: "SYNCING",
    summary: "upload local changes",
    usage: "rbox push [path]",
  },
  {
    name: "pull",
    group: "SYNCING",
    summary: "apply remote changes",
    usage: "rbox pull [path] [--allow-mass-delete]",
    flags: [{ flag: "--allow-mass-delete", desc: "consent to a pull that deletes half or more of the tracked files" }],
  },
  {
    name: "track",
    group: "SYNCING",
    summary: "bind a directory to a workspace (create/join; no first sync)",
    usage: "rbox track <path> [--workspace <id>]",
    flags: [{ flag: "--workspace <id>", desc: "join an existing workspace instead of creating one" }],
    examples: ["rbox track ~/code/myapp", "rbox track ~/code/myapp --workspace ws_ab12cd34"],
  },
  {
    name: "untrack",
    group: "SYNCING",
    summary: "stop syncing a directory (local unbind; remote untouched)",
    usage: "rbox untrack [path] [--force]",
    flags: [{ flag: "--force", desc: "skip the confirmation prompt and SIGKILL a stuck daemon" }],
  },
  {
    name: "ignore",
    group: "SYNCING",
    summary: "manage .rboxignore",
    usage: "rbox ignore <glob> | --list",
    flags: [{ flag: "--list", desc: "print the effective ignore rules" }],
  },

  // ── DEPENDENCIES ─────────────────────────────────────────────────────────
  // The whole `deps` group is commented out (design 50) — dispatcher wiring is
  // disabled in index.ts (see the note above `runDeps`). Uncomment here + there
  // + the three aliases below (in "hidden: deprecated aliases") to re-enable.
  // {
  //   name: "deps install",
  //   group: "DEPENDENCIES",
  //   summary: "rebuild deps from synced lockfiles",
  //   usage: "rbox deps install [path] [--allow-build] [--only <id>] [--manager <m>]",
  //   flags: [
  //     { flag: "--allow-build", desc: "permit steps that run project build/lifecycle code" },
  //     { flag: "--only <id>", desc: "limit to one ecosystem or rule id (e.g. node, node/pnpm)" },
  //     { flag: "--manager <m>", desc: "disambiguate when multiple lockfiles coexist" },
  //   ],
  // },
  // {
  //   name: "deps list",
  //   group: "DEPENDENCIES",
  //   summary: "list rebuildable projects (lockfiles found)",
  //   usage: "rbox deps list [path] [--manager <m>]",
  //   flags: [{ flag: "--manager <m>", desc: "disambiguate when multiple lockfiles coexist" }],
  // },
  // {
  //   name: "deps check",
  //   group: "DEPENDENCIES",
  //   summary: "check this host is ready to rebuild deps",
  //   usage: "rbox deps check [path]",
  // },
  // {
  //   name: "deps drift",
  //   group: "DEPENDENCIES",
  //   summary: "did this folder's lockfile change since rbox last saw it?",
  //   usage: "rbox deps drift [path] [--quiet]",
  //   flags: [{ flag: "--quiet", desc: "one-line mode used by the shell hook; honors the notify toggle" }],
  // },
  // {
  //   name: "deps notify",
  //   group: "DEPENDENCIES",
  //   summary: "shell-hook drift notifications",
  //   usage: "rbox deps notify <install | uninstall | status | on | off>",
  //   examples: ["rbox deps notify install", "rbox deps notify off", "rbox deps notify uninstall"],
  // },

  // ── DEVICES & ACCOUNT ────────────────────────────────────────────────────
  {
    name: "pair",
    group: "DEVICES & ACCOUNT",
    summary: "create a token to add another machine",
    usage: "rbox pair",
  },
  {
    name: "connect",
    group: "DEVICES & ACCOUNT",
    summary: "add this machine from a pasted token (stdin)",
    usage: "echo <token> | rbox connect",
  },
  {
    name: "recover",
    group: "DEVICES & ACCOUNT",
    summary: "re-enroll this machine from your recovery phrase",
    usage: "rbox recover",
  },
  {
    name: "device",
    group: "DEVICES & ACCOUNT",
    summary: "manage devices",
    usage: "rbox device <approve <user-code> | list | revoke <device-id>>",
  },
  {
    name: "account",
    group: "DEVICES & ACCOUNT",
    summary: "link this CLI to your web login",
    usage: "rbox account <link <code> | status | unlink>",
  },
  {
    name: "key",
    group: "DEVICES & ACCOUNT",
    summary: "encryption status / re-show recovery phrase",
    usage: "rbox key <status | backup>",
  },

  // ── BILLING & MAINTENANCE ────────────────────────────────────────────────
  {
    name: "subscribe",
    group: "BILLING & MAINTENANCE",
    summary: "open a checkout to subscribe this account",
    usage: "rbox subscribe <solo | pro>",
  },
  {
    name: "billing",
    group: "BILLING & MAINTENANCE",
    summary: "open the billing portal",
    usage: "rbox billing",
  },
  {
    name: "upgrade",
    group: "BILLING & MAINTENANCE",
    summary: "update the rbox binary",
    usage: "rbox upgrade [--check]",
    flags: [{ flag: "--check", desc: "report whether an update is available, without installing" }],
  },
  {
    name: "version",
    group: "BILLING & MAINTENANCE",
    summary: "print the rbox version",
    usage: "rbox version",
  },
  {
    name: "shell-init",
    group: "BILLING & MAINTENANCE",
    summary: "print shell integration (prompt status + completions)",
    usage: "rbox shell-init zsh",
    examples: ['eval "$(rbox shell-init zsh)"'],
  },
  {
    name: "completions",
    group: "BILLING & MAINTENANCE",
    summary: "print shell completions",
    usage: "rbox completions zsh",
  },

  // ── hidden: version-history stubs (fail-closed under E2EE, design 12 D11) ──
  {
    name: "versions",
    group: "SYNCING",
    summary: "list version history (or a file's change history)",
    usage: "rbox versions [path] [--limit <n>]",
    hidden: true,
  },
  {
    name: "restore",
    group: "SYNCING",
    summary: "restore a file from a past version",
    usage: "rbox restore <path>@<seq>",
    hidden: true,
  },

  // ── hidden: deprecated aliases (warn on stderr; removed at v0.3) ──────────
  { name: "link", group: "SYNCING", summary: "deprecated → rbox track", usage: "rbox link <path>", hidden: true, alias: "track" },
  { name: "daemon", group: "SYNCING", summary: "deprecated → rbox start/stop/logs", usage: "rbox daemon <start|stop|status|logs>", hidden: true, alias: "start" },
  // hydrate/detect/doctor aliases commented out along with `deps` itself (design 50)
  // — their forward target no longer exists, so keeping them would dangle.
  // { name: "hydrate", group: "DEPENDENCIES", summary: "deprecated → rbox deps install", usage: "rbox hydrate [path]", hidden: true, alias: "deps install" },
  // { name: "detect", group: "DEPENDENCIES", summary: "deprecated → rbox deps list", usage: "rbox detect [path]", hidden: true, alias: "deps list" },
  // { name: "doctor", group: "DEPENDENCIES", summary: "deprecated → rbox deps check", usage: "rbox doctor [path]", hidden: true, alias: "deps check" },
];

const byName = new Map(COMMAND_HELP.map((c) => [c.name, c]));

/**
 * Help entries for a command path. A bare group token ("deps") returns all of its
 * subcommands; a leaf ("track", "deps install") returns the single entry. `undefined`
 * when nothing matches (caller falls back to the grouped screen).
 */
export function helpFor(commandPath: string): CommandHelp[] | undefined {
  const exact = byName.get(commandPath);
  if (exact) return [exact];
  const subs = COMMAND_HELP.filter((c) => c.name.startsWith(`${commandPath} `));
  return subs.length ? subs : undefined;
}

/** Render one command's detailed help block. */
export function renderCommand(c: CommandHelp): string {
  const lines: string[] = [];
  lines.push(`${style.bold(c.name)} — ${c.summary}`);
  lines.push("");
  lines.push(`${style.dim("usage:")} ${c.usage}`);
  if (c.alias) lines.push(style.yellow(`(deprecated — use \`rbox ${c.alias}\`; this alias is removed at v0.3)`));
  if (c.flags?.length) {
    lines.push("");
    lines.push(style.dim("flags:"));
    const w = Math.max(...c.flags.map((f) => f.flag.length));
    for (const f of c.flags) lines.push(`  ${f.flag.padEnd(w)}  ${style.dim(f.desc)}`);
  }
  if (c.examples?.length) {
    lines.push("");
    lines.push(style.dim("examples:"));
    for (const ex of c.examples) lines.push(`  ${ex}`);
  }
  return lines.join("\n");
}

/** Render the grouped help screen (every non-hidden entry, in group order). */
export function renderGroupedHelp(): string {
  const lines: string[] = [];
  lines.push(`${style.bold("rbox")} — dev-aware sync ${style.dim("(end-to-end encrypted)")}`);
  const visible = COMMAND_HELP.filter((c) => !c.hidden);
  for (const group of GROUP_ORDER) {
    const entries = visible.filter((c) => c.group === group);
    if (!entries.length) continue;
    lines.push("");
    lines.push(style.dim(group));
    const w = Math.max(...entries.map((e) => usageBody(e).length));
    for (const e of entries) lines.push(`  ${usageBody(e).padEnd(w)}  ${style.dim(e.summary)}`);
  }
  lines.push("");
  lines.push(style.dim("Run `rbox <command> --help` for details on any command."));
  return lines.join("\n");
}

/** The grouped-screen left column: the usage minus the leading "rbox ", or just the
 *  command name when the usage isn't a plain `rbox …` form (e.g. `connect`'s pipe). */
function usageBody(c: CommandHelp): string {
  return c.usage.startsWith("rbox ") ? c.usage.slice("rbox ".length) : c.name;
}

/** Build the lookup key for `--help` from the command + its positional args, longest
 *  registered match first (so `deps install --help` resolves to the leaf, not the group). */
export function helpKeyFor(cmd: string, positional: string[]): string {
  const two = `${cmd} ${positional[0] ?? ""}`.trim();
  if (positional[0] && byName.has(two)) return two;
  return cmd;
}
