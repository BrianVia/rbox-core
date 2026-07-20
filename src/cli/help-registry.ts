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
  notes?: string[];
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
    usage: "rbox setup [--workspace <name|id>] [--dir <path>] [--key -] [--key-file <path>] [--daemon] [--pull-only] [--force]",
    flags: [
      { flag: "--workspace <name|id>", desc: "with RBOX_KEY, sync an existing workspace non-interactively (alias: -w)" },
      { flag: "--dir <path>", desc: "target directory (keyed setup only)" },
      { flag: "--key -", desc: "read the bundle from stdin; the RBOX_KEY env var is read automatically — literal --key=<value> is rejected (argv leaks)" },
      { flag: "--key-file <path>", desc: "read the RBOX_KEY bundle from a file" },
      { flag: "--daemon", desc: "after the first pull, start background sync (keyed setup only)" },
      { flag: "--pull-only", desc: "with --daemon, never push local changes (keyed setup only)" },
      { flag: "--force", desc: "allow a non-empty target directory (keyed setup only)" },
    ],
    examples: ["rbox setup"],
  },
  {
    name: "login",
    group: "GETTING STARTED",
    summary: "authorize this machine",
    usage: "rbox login [--bootstrap <secret>] [--plan <solo|pro>] [--label <text>] [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--bootstrap <secret>", desc: "create a brand-new account from a bootstrap secret (a one-time secret; this machine becomes the account's first key-holding device)" },
      { flag: "--plan <solo|pro>", desc: "request a bootstrap plan when the server supports plan selection" },
      { flag: "--label <text>", desc: "set the device label (defaults to this machine's hostname)" },
      { flag: "--kit", desc: "save the recovery phrase to a plaintext 'recovery kit' file at the default path" },
      { flag: "--kit-path <path>", desc: "save the recovery kit to a specific file" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)" },
    ],
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
    usage: "rbox status [path] [--json | --verbose | --git]",
    flags: [
      { flag: "--json", desc: "print JSON" },
      { flag: "--verbose", desc: "print the complete legacy status detail" },
      { flag: "--git", desc: "show per-repository Git deferral detail" },
    ],
  },
  {
    name: "init",
    group: "GETTING STARTED",
    summary: "headless/CI onboarding (the scripting form of setup)",
    usage: "rbox init [--new | --workspace <id>] [--root <path>] [--adopt] [--respect-gitignore] [--new-device] [--bootstrap <secret>] [--kit] [--kit-path <path>] [--no-interactive]",
    flags: [
      { flag: "--new", desc: "create a new workspace" },
      { flag: "--workspace <id>", desc: "join an existing workspace (alias: -w)" },
      { flag: "--root <path>", desc: "directory to track (default: cwd)" },
      { flag: "--adopt", desc: "on a non-empty join, retain local content and adopt it over the remote baseline" },
      { flag: "--bootstrap <secret>", desc: "create a brand-new account from a bootstrap secret before initializing" },
      { flag: "--respect-gitignore", desc: "skip gitignored untracked files in this workspace" },
      { flag: "--new-device", desc: "mint a new device identity instead of reusing this machine's enrolled device (advanced)" },
      { flag: "--kit", desc: "save the recovery phrase to a plaintext 'recovery kit' file at the default path" },
      { flag: "--kit-path <path>", desc: "save the recovery kit to a specific file" },
      { flag: "--no-interactive", desc: "never prompt (CI); fail fast if inputs are missing" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)" },
      { flag: "--git <true|false>", desc: "sync git repo state, encrypted (default true; pass false to opt out)" },
    ],
  },
  {
    name: "adopt",
    group: "GETTING STARTED",
    summary: "inspect or recover a retained non-empty join",
    usage: "rbox adopt <status|resume|abort|clean> [path] [--json] [--yes]",
    flags: [
      { flag: "--json", desc: "print status as JSON" },
      { flag: "--yes", desc: "confirm permanent removal for adopt clean" },
    ],
  },

  // ── SYNCING ──────────────────────────────────────────────────────────────
  {
    name: "start",
    group: "SYNCING",
    summary: "start background sync for this workspace",
    usage: "rbox start [path] [--pull-only]",
    flags: [{ flag: "--pull-only", desc: "watch remote changes without pushing local changes" }],
    notes: ["Run outside a workspace with no path, on a terminal, and rbox opens the guided setup to create or join one."],
  },
  {
    name: "stop",
    group: "SYNCING",
    summary: "stop background sync",
    usage: "rbox stop [path]",
  },
  {
    name: "autostart enable",
    group: "SYNCING",
    summary: "resume background sync after login",
    usage: "rbox autostart enable",
  },
  {
    name: "autostart disable",
    group: "SYNCING",
    summary: "disable login resume",
    usage: "rbox autostart disable",
  },
  {
    name: "autostart status",
    group: "SYNCING",
    summary: "show autostart state",
    usage: "rbox autostart status",
  },
  {
    name: "logs",
    group: "SYNCING",
    summary: "tail background-sync logs",
    usage: "rbox logs [path] [--follow] [--limit N]",
    flags: [
      { flag: "--follow", desc: "stream new log lines (Ctrl-C to exit) (alias: -f)" },
      { flag: "--limit N", desc: "show the last N lines (default 50)" },
      { flag: "--lines N", desc: "alias for --limit (alias: -n)" },
    ],
  },
  {
    name: "sync",
    group: "SYNCING",
    summary: "sync once (pull, then push)",
    usage: "rbox sync [path] [--allow-mass-delete] [--pull-only] [--verbose]",
    flags: [
      { flag: "--allow-mass-delete", desc: "consent to both pull-side and push-side mass-delete guards for this run" },
      { flag: "--pull-only", desc: "pull remote changes and skip the push phase" },
      { flag: "--verbose", desc: "print each git repo's apply/conflict/defer line instead of a running count" },
    ],
  },
  {
    name: "git deferrals",
    group: "SYNCING",
    summary: "show deferred Git repos and copyable repair guidance",
    usage: "rbox git deferrals [--brief | --json]",
    flags: [
      { flag: "--brief", desc: "print a complete copyable diagnosis and repair brief" },
      { flag: "--json", desc: "print the raw lane-level deferrals as JSON" },
    ],
    notes: ["Run from anywhere inside the workspace; no repository argument is accepted."],
  },
  {
    name: "git resolve",
    group: "SYNCING",
    summary: "inspect or resolve a deferred Git checkout",
    usage: "rbox git resolve <repo> [show-me|take-theirs|keep-mine] [--json] [--confirm <token>] [--force-discard-incoming]",
    flags: [
      { flag: "--json", desc: "print a typed JSON result (commit OIDs are omitted)" },
      { flag: "--confirm <token>", desc: "confirm the exact snapshot printed by show-me" },
      { flag: "--force-discard-incoming", desc: "keep-mine only: acknowledge incoming artifacts cannot be retained" },
    ],
    notes: [
      "The default verb is show-me.",
      "take-theirs quarantines and pins local Git work before following incoming metadata; working files are not rewritten.",
    ],
  },
  {
    name: "push",
    group: "SYNCING",
    summary: "upload local changes",
    usage: "rbox push [path] [--allow-mass-delete]",
    flags: [{ flag: "--allow-mass-delete", desc: "consent to the push-side mass-delete guard (or env RBOX_ALLOW_MASS_DELETE=1)" }],
  },
  {
    name: "pull",
    group: "SYNCING",
    summary: "apply remote changes",
    usage: "rbox pull [path] [--allow-mass-delete] [--verbose]",
    flags: [
      { flag: "--allow-mass-delete", desc: "consent to a pull that deletes half or more of the tracked files" },
      { flag: "--verbose", desc: "print each git repo's apply/conflict/defer line instead of a running count" },
    ],
  },
  {
    name: "export",
    group: "SYNCING",
    summary: "export decrypted files",
    usage: "rbox export [--all | --workspace <id>] [--out <dir | file.tar.gz>]",
    flags: [
      { flag: "--all", desc: "export every workspace (default)" },
      { flag: "--workspace <id>", desc: "export one workspace (alias: -w)" },
      { flag: "--out <path>", desc: "write to a directory or .tar.gz (default: ~/Downloads)" },
    ],
    examples: ["rbox export", "rbox export --workspace ws_ab12cd34", "rbox export --out ~/backup.tar.gz"],
  },
  {
    name: "track",
    group: "SYNCING",
    summary: "bind a directory to a workspace (create/join; no first sync)",
    usage: "rbox track [path] [--workspace <id>] [--respect-gitignore] [--new-device]",
    flags: [
      { flag: "--workspace <id>", desc: "join an existing workspace instead of creating one (alias: -w)" },
      { flag: "--respect-gitignore", desc: "skip gitignored untracked files in this workspace" },
      { flag: "--new-device", desc: "mint a new device identity instead of reusing this machine's enrolled device (advanced)" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)" },
      { flag: "--git <true|false>", desc: "sync git repo state, encrypted (default true; pass false to opt out)" },
    ],
    notes: ["[path] defaults to the current directory"],
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
    usage: "rbox ignore <glob> | --list | --respect-gitignore <on|off> | --purge [--yes] [--path <dir>]",
    flags: [
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace" },
      { flag: "--list", desc: "print the effective ignore rules" },
      { flag: "--respect-gitignore <on|off>", desc: "toggle skipping gitignored untracked files" },
      { flag: "--purge", desc: "delete already-synced paths that are now ignored after a dry-run" },
      { flag: "--yes", desc: "confirm --purge in headless mode (alias: -y)" },
      { flag: "--allow-mass-delete", desc: "also consent to the push-side mass-delete guard" },
    ],
    examples: ["rbox ignore 'dist/**'", "rbox ignore --list"],
  },
  {
    name: "trash list",
    group: "SYNCING",
    summary: "list files rbox moved to the local trash",
    usage: "rbox trash list [--path <dir>] [--json]",
    flags: [
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace" },
      { flag: "--json", desc: "print JSON" },
    ],
  },
  {
    name: "trash restore",
    group: "SYNCING",
    summary: "restore a trashed file back into the workspace",
    usage: "rbox trash restore <path> [--batch <name>] [--path <dir>]",
    flags: [
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace" },
      { flag: "--batch <name>", desc: "restore from a specific trash batch (default: newest)" },
    ],
    notes: ["restores files rbox itself moved to the local trash — to fetch an older synced version, see `rbox restore`"],
  },
  {
    name: "trash empty",
    group: "SYNCING",
    summary: "permanently delete trashed files (frees disk)",
    usage: "rbox trash empty [--path <dir>]",
    flags: [{ flag: "--path <dir>", desc: "workspace root; use when running outside the workspace" }],
  },
  {
    name: "versions",
    group: "SYNCING",
    summary: "list version history (or a file's change history)",
    usage: "rbox versions [file] [--limit <n>] [--json]",
    flags: [
      { flag: "--limit <n>", desc: "maximum versions to show" },
      { flag: "--json", desc: "print JSON" },
    ],
    notes: ["[file] is a path INSIDE the current directory's workspace (it scopes history to that file); unlike other commands, it does not locate the workspace."],
    examples: ["rbox versions", "rbox versions src/app.ts --limit 20"],
  },
  {
    name: "restore",
    group: "SYNCING",
    summary: "restore a file from a past version",
    usage: "rbox restore <file>@<seq>",
    notes: [
      "<file> is resolved inside the current directory's workspace.",
      "restores from synced version history — for files rbox moved to the local trash, see `rbox trash restore`",
    ],
    examples: ["rbox restore src/app.ts@3"],
  },

  // ── DEPENDENCIES ─────────────────────────────────────────────────────────
  // The whole `deps` group is commented out (design 51) — dispatcher wiring is
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
    usage: "rbox connect",
    flags: [{ flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)" }],
    examples: ["rbox connect", "echo <token> | rbox connect"],
  },
  {
    name: "recover",
    group: "DEVICES & ACCOUNT",
    summary: "clear the local head pin and re-baseline a halted workspace",
    usage: "rbox recover [path] [--yes] [--repair-chain] [--allow-mass-delete]",
    flags: [
      { flag: "--yes", desc: "skip the confirmation prompt (alias: -y)" },
      { flag: "--repair-chain", desc: "confirm superseding an authenticated unreadable manifest suffix" },
      { flag: "--allow-mass-delete", desc: "consent to both pull-side and push-side mass-delete guards" },
    ],
  },
  {
    name: "device",
    group: "DEVICES & ACCOUNT",
    summary: "manage devices",
    usage: "rbox device <approve <user-code> | list [--json] | revoke <device-id>>",
    flags: [{ flag: "--json", desc: "with `list`, print JSON" }],
  },
  {
    name: "account",
    group: "DEVICES & ACCOUNT",
    summary: "link this CLI to your web login",
    usage: "rbox account <link <code> | status [--json] | unlink>",
    flags: [{ flag: "--json", desc: "with `status`, print JSON" }],
  },
  {
    name: "key",
    group: "DEVICES & ACCOUNT",
    summary: "encryption and agent sync keys",
    usage: "rbox key <status | backup | genesis | recover | create-ci | materialize | list | revoke>",
    flags: [
      { flag: "--json", desc: "with `status`, print JSON" },
      { flag: "--kit", desc: "with `backup`, write the cached recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "with `backup`, write the cached recovery phrase to a specific recovery kit file" },
    ],
  },
  {
    name: "key status",
    group: "DEVICES & ACCOUNT",
    summary: "show this machine's encryption enrollment state",
    usage: "rbox key status [--json]",
    flags: [{ flag: "--json", desc: "print JSON" }],
  },
  {
    name: "key backup",
    group: "DEVICES & ACCOUNT",
    summary: "re-show your recovery phrase (if it was cached at setup)",
    usage: "rbox key backup [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--kit", desc: "write the cached recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "write the cached recovery phrase to a specific recovery kit file" },
    ],
  },
  {
    name: "key recover",
    group: "DEVICES & ACCOUNT",
    summary: "re-enroll this machine from your recovery phrase (requires `rbox login` first)",
    usage: "rbox key recover [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--kit", desc: "write the entered recovery phrase to the default recovery kit path after recovery" },
      { flag: "--kit-path <path>", desc: "write the entered recovery phrase to a specific recovery kit file" },
    ],
  },
  {
    name: "key genesis",
    group: "DEVICES & ACCOUNT",
    summary: "set up encryption on the first machine",
    usage: "rbox key genesis --yes [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--yes", desc: "required to mint the account's first encryption keys (alias: -y)" },
      { flag: "--kit", desc: "write the recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "write the recovery phrase to a specific recovery kit file" },
    ],
  },
  {
    name: "key create-ci",
    group: "DEVICES & ACCOUNT",
    summary: "create an agent/CI sync key bundle",
    usage: "rbox key create-ci --expires <dur> [--label <text>] [--accept-root-key]",
    flags: [
      { flag: "--expires <dur>", desc: "required; suggested 90d, maximum 1y" },
      { flag: "--label <text>", desc: "dashboard label" },
      { flag: "--accept-root-key", desc: "skip the interactive account-root warning confirmation" },
    ],
  },
  {
    name: "key materialize",
    group: "DEVICES & ACCOUNT",
    summary: "unpack RBOX_KEY into the local keystore",
    usage: "rbox key materialize [--dir <path>] [--key -] [--key-file <path>]",
    flags: [
      { flag: "--dir <path>", desc: "RBOX_HOME directory to write (default: standard location)" },
      { flag: "--key -", desc: "read the bundle from stdin; the RBOX_KEY env var is read automatically — literal --key=<value> is rejected (argv leaks)" },
      { flag: "--key-file <path>", desc: "read the RBOX_KEY bundle from a file" },
    ],
  },
  {
    name: "key list",
    group: "DEVICES & ACCOUNT",
    summary: "list agent/CI sync keys",
    usage: "rbox key list [--json]",
    flags: [{ flag: "--json", desc: "print JSON" }],
  },
  {
    name: "key revoke",
    group: "DEVICES & ACCOUNT",
    summary: "revoke an agent/CI sync key",
    usage: "rbox key revoke <id>",
  },

  // ── BILLING & MAINTENANCE ────────────────────────────────────────────────
  {
    name: "subscribe",
    group: "BILLING & MAINTENANCE",
    summary: "open a checkout to subscribe this account",
    usage: "rbox subscribe <solo | pro> [--annual]",
    flags: [
      { flag: "--annual", desc: "use annual billing (two months free)" },
    ],
  },
  {
    name: "billing",
    group: "BILLING & MAINTENANCE",
    summary: "open the billing portal",
    usage: "rbox billing",
  },
  {
    name: "usage",
    group: "BILLING & MAINTENANCE",
    summary: "show plan limits and current account usage",
    usage: "rbox usage [--json]",
    flags: [{ flag: "--json", desc: "print JSON" }],
  },
  {
    name: "doctor",
    group: "BILLING & MAINTENANCE",
    summary: "check workspace health; optionally upload a support report",
    usage: "rbox doctor [reset-journal] [--report | --quarantine | --restore <bundle>] [--path <dir>]",
    flags: [
      { flag: "--report", desc: "build and print the support report locally" },
      { flag: "--diagnostics", desc: "with --report, upload the report to rbox support (stored unencrypted for 30 days)" },
      { flag: "--yes", desc: "skip the upload consent prompt; required with --report --diagnostics in non-interactive mode (alias: -y)" },
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace" },
      { flag: "--quarantine", desc: "with reset-journal, preserve and remove an unsafe standing journal" },
      { flag: "--restore <bundle>", desc: "with reset-journal, restore a committed quarantine bundle" },
    ],
  },
  {
    name: "upgrade",
    group: "BILLING & MAINTENANCE",
    summary: "update the rbox binary",
    usage: "rbox upgrade [--check]",
    flags: [
      { flag: "--check", desc: "report whether an update is available, without installing" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)" },
    ],
  },
  {
    name: "uninstall",
    group: "BILLING & MAINTENANCE",
    summary: "remove local rbox state and installed files",
    usage: "rbox uninstall [--yes]",
    flags: [{ flag: "--yes", desc: "perform the removal; without it, print the steps only (alias: -y)" }],
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
    notes: ["adds the rbox status segment to your prompt and installs tab-completions for rbox commands"],
    examples: ['eval "$(rbox shell-init zsh)"'],
  },
  {
    name: "completions",
    group: "BILLING & MAINTENANCE",
    summary: "print shell completions",
    usage: "rbox completions zsh",
    notes: ["`rbox shell-init zsh` already includes these completions — use `completions` only if you manage compdef yourself"],
    examples: ["rbox completions zsh > ~/.zsh/completions/_rbox"],
  },
  {
    name: "prompt-status",
    group: "BILLING & MAINTENANCE",
    summary: "print programmatic ambient prompt status",
    usage: "rbox prompt-status [path] [--json]",
    flags: [{ flag: "--json", desc: "print JSON" }],
    hidden: true,
  },

  // ── hidden: deprecated aliases ───────────────────────────────────────────
  { name: "link", group: "SYNCING", summary: "deprecated → rbox track", usage: "rbox link <path>", hidden: true, alias: "track" },
  { name: "daemon", group: "SYNCING", summary: "deprecated → rbox start/stop/logs", usage: "rbox daemon <start|stop|status|logs>", hidden: true, alias: "start" },
  // hydrate/detect aliases commented out along with `deps` itself (design 51)
  // — their forward target no longer exists, so keeping them would dangle.
  // The old deps-doctor alias is intentionally not restored; `doctor` is support diagnostics.
  // { name: "hydrate", group: "DEPENDENCIES", summary: "deprecated → rbox deps install", usage: "rbox hydrate [path]", hidden: true, alias: "deps install" },
  // { name: "detect", group: "DEPENDENCIES", summary: "deprecated → rbox deps list", usage: "rbox detect [path]", hidden: true, alias: "deps list" },
];

const byName = new Map(COMMAND_HELP.map((c) => [c.name, c]));

/**
 * Help entries for a command path. A bare group token ("deps") returns all of its
 * subcommands; a leaf ("track", "deps install") returns the single entry. `undefined`
 * when nothing matches (caller falls back to the grouped screen).
 */
export function helpFor(commandPath: string): CommandHelp[] | undefined {
  const exact = byName.get(commandPath);
  const subs = COMMAND_HELP.filter((c) => c.name.startsWith(`${commandPath} `));
  if (exact) return [exact, ...subs];
  return subs.length ? subs : undefined;
}

/** Render one command's detailed help block. */
export function renderCommand(c: CommandHelp): string {
  const lines: string[] = [];
  lines.push(`${style.bold(c.name)} — ${c.summary}`);
  lines.push("");
  lines.push(`${style.dim("usage:")} ${c.usage}`);
  if (c.notes?.length) for (const note of c.notes) lines.push(style.dim(note));
  if (c.alias) lines.push(style.yellow(`deprecated: use \`rbox ${c.alias}\``));
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
  lines.push(style.dim("Exit codes: 0 ok, 1 error, 130 user cancel (Ctrl-C)."));
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

function commandHasFlag(c: CommandHelp, flagName: string): boolean {
  const normalized = flagName.startsWith("--") ? flagName : `--${flagName}`;
  return c.flags?.some((f) => f.flag.match(/^(--[a-z0-9][a-z0-9-]*)\b/i)?.[1] === normalized) ?? false;
}

export function commandSupportsFlag(cmd: string | undefined, positional: string[], flagName: string): boolean {
  if (!cmd) return false;
  return helpFor(helpKeyFor(cmd, positional))?.some((entry) => commandHasFlag(entry, flagName)) ?? false;
}
