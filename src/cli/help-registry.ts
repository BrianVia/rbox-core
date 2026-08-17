/**
 * Command grammar and help (design 29 §"Per-command help"). One static,
 * syntax-only authority feeds:
 *
 *   - `rbox <cmd> --help` / `rbox help <cmd>` → that command's block, and
 *   - bare `rbox help` (or an unknown command) → the essential-flows screen, and
 *   - `rbox help --all` → the grouped full-reference screen.
 *
 * It can still drift from the real lazy dispatcher `switch`, so parity tests
 * assert that every projected top-level token remains dispatchable.
 * This module owns command syntax, visibility, aliases, and their projections.
 * Domain validation and orchestration remain in command handlers.
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
  flags?: CommandFlag[];
  notes?: string[];
  examples?: string[];
  /** Grouped-screen left column override, for when the derived form is too wide. */
  brief?: string;
  /** Excluded from the grouped screen (init, deprecated aliases, internal). */
  hidden?: boolean;
  /** If set, this is a deprecated alias forwarding to canonical syntax. */
  alias?: DeprecatedAlias;
}

export interface CommandFlag {
  /** Display spelling, including the metavar when present. */
  flag: string;
  /** Accepted short spelling, when one exists. */
  short?: `-${string}`;
  desc: string;
  /** Explicit parser/completion arity; never inferred from display prose. */
  takesValue?: true;
  /** Preserve every occurrence in the parser's string-valued compatibility shape. */
  repeatable?: true;
  /** Accepted syntax omitted from help and completions. */
  hidden?: true;
}

interface AliasRoute {
  target: string;
  notice: string;
}

export type DeprecatedAlias =
  | ({ kind: "rename" } & AliasRoute)
  | {
      kind: "subcommands";
      /** Target shown by the legacy detailed-help deprecation line. */
      helpTarget: string;
      routes: Readonly<Record<string, AliasRoute>>;
      fallbackNotice: string;
    };

export interface ResolvedAlias {
  cmd: string;
  positional: string[];
  notice: string;
}

/** Globally accepted parser syntax. `--help` keeps its legacy value-taking parse
 * shape because help dispatch inspects raw argv before any command handler runs. */
export const GLOBAL_FLAGS: readonly CommandFlag[] = [
  { flag: "--json", desc: "request JSON when the selected command supports it", hidden: true },
  { flag: "--help <ignored>", desc: "show command help", takesValue: true, hidden: true },
];

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
    summary: "guided onboarding: account → folder → start syncing",
    usage: "rbox setup [--workspace <name|id>] [--dir <path>] [--key -] [--key-file <path>] [--daemon] [--pull-only] [--force]",
    flags: [
      { flag: "--workspace <name|id>", short: "-w", desc: "with RBOX_KEY, sync an existing workspace non-interactively (alias: -w)", takesValue: true },
      { flag: "--dir <path>", desc: "target directory (keyed setup only)", takesValue: true },
      { flag: "--key -", desc: "read the bundle from stdin; the RBOX_KEY env var is read automatically — literal --key=<value> is rejected (argv leaks)", takesValue: true },
      { flag: "--key-file <path>", desc: "read the RBOX_KEY bundle from a file", takesValue: true },
      { flag: "--daemon", desc: "after the first pull, start background sync (keyed setup only)" },
      { flag: "--pull-only", desc: "with --daemon, never push local changes (keyed setup only)" },
      { flag: "--force", desc: "allow a non-empty target directory (keyed setup only)" },
      { flag: "--new", desc: "internal guided-setup selection", hidden: true },
      { flag: "--name <name>", desc: "internal guided-setup workspace name", takesValue: true, hidden: true },
      { flag: "--no-sync", desc: "internal guided-setup first-sync selection", hidden: true },
      { flag: "--respect-gitignore", desc: "internal guided-setup ignore selection", hidden: true },
    ],
    examples: ["rbox setup"],
  },
  {
    name: "login",
    group: "GETTING STARTED",
    summary: "authorize this machine",
    usage: "rbox login [--bootstrap <secret>] [--plan <solo|pro>] [--label <text>] [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--bootstrap <secret>", desc: "create a brand-new account from a bootstrap secret (a one-time secret; this machine becomes the account's first key-holding device)", takesValue: true },
      { flag: "--plan <solo|pro>", desc: "request a bootstrap plan when the server supports plan selection", takesValue: true },
      { flag: "--label <text>", desc: "set the device label (defaults to this machine's hostname)", takesValue: true },
      { flag: "--kit", desc: "save the recovery phrase to a plaintext 'recovery kit' file at the default path" },
      { flag: "--kit-path <path>", desc: "save the recovery kit to a specific file", takesValue: true },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)", takesValue: true },
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
    summary: "synced-folder + background-sync state",
    usage: "rbox status [path] [--all] [--json | --verbose | --git [<repo>]]",
    flags: [
      { flag: "--all", desc: "show every locally known synced folder (cannot be combined with a path); with --git, list every paused repo instead of the first few per group" },
      { flag: "--json", desc: "print JSON" },
      { flag: "--verbose", desc: "print the complete legacy status detail" },
      { flag: "--git", desc: "explain every repo where rbox paused Git sync, and what to do about it" },
    ],
    notes: [
      "`rbox status <path>` reports on the synced folder at that path.",
      "With --git, a path that names a paused repo shows just that repo, both sides in full: `rbox status --git conductor-workspaces/acme/checkout-flow`. Any other path keeps its usual meaning and reports on the whole folder.",
    ],
  },
  {
    name: "init",
    group: "GETTING STARTED",
    summary: "headless/CI onboarding (the scripting form of setup)",
    usage: "rbox init [--new | --workspace <id>] [--root <path>] [--scope <folder>[,<folder>…] --pull-only] [--adopt] [--respect-gitignore] [--new-device] [--bootstrap <secret>] [--kit] [--kit-path <path>] [--no-interactive]",
    flags: [
      { flag: "--new", desc: "create a new workspace" },
      { flag: "--workspace <id>", short: "-w", desc: "join an existing workspace (alias: -w)", takesValue: true },
      { flag: "--root <path>", desc: "directory to track (default: cwd)", takesValue: true },
      { flag: "--scope <folder>…", desc: "sync only these workspace folders on this machine (comma-separated); requires --pull-only", takesValue: true },
      { flag: "--pull-only", desc: "only receive changes, never send them" },
      { flag: "--adopt", desc: "on a non-empty join, retain local content and adopt it over the remote baseline" },
      { flag: "--bootstrap <secret>", desc: "create a brand-new account from a bootstrap secret before initializing", takesValue: true },
      { flag: "--respect-gitignore", desc: "skip gitignored untracked files in this workspace" },
      { flag: "--new-device", desc: "mint a new device identity instead of reusing this machine's enrolled device (advanced)" },
      { flag: "--kit", desc: "save the recovery phrase to a plaintext 'recovery kit' file at the default path" },
      { flag: "--kit-path <path>", desc: "save the recovery kit to a specific file", takesValue: true },
      { flag: "--no-interactive", desc: "never prompt (CI); fail fast if inputs are missing" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)", takesValue: true },
      { flag: "--git <true|false>", desc: "sync git repo state, encrypted (default true; pass false to opt out)", takesValue: true },
      { flag: "--name <name>", desc: "internal workspace name", takesValue: true, hidden: true },
      { flag: "--project <id>", desc: "internal project identifier", takesValue: true, hidden: true },
    ],
  },
  {
    name: "include",
    group: "SYNCING",
    summary: "sync only the folders you include on this machine",
    usage: "rbox include [add <folder>… | remove <folder>…] [--json]",
    flags: [{ flag: "--json", desc: "machine-readable output" }],
    notes: [
      "A machine that syncs only some folders receives changes but never sends them — push code out of it with git.",
      "Folders are workspace-relative, and a folder cannot cut a git repository in half.",
      "Removing a folder moves its files to the local trash; `rbox trash restore` undoes that.",
    ],
    examples: ["rbox include", "rbox include add Personal/repo-A", "rbox include remove Personal/repo-A"],
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
  // <!-- FOUNDER-SIGN-OFF: draft copy for rbox config -->
  {
    name: "config",
    group: "GETTING STARTED",
    summary: "show this machine's folder configuration",
    usage: "rbox config [--json]",
    flags: [{ flag: "--json", desc: "print folder intent and status as JSON" }],
  },
  // <!-- FOUNDER-SIGN-OFF: draft copy for rbox config -->
  {
    name: "config add",
    group: "GETTING STARTED",
    summary: "add an existing synced folder to this machine's configuration",
    usage: "rbox config add <path>",
  },
  // <!-- FOUNDER-SIGN-OFF: draft copy for rbox config -->
  {
    name: "config regenerate",
    group: "GETTING STARTED",
    summary: "rebuild folder configuration from local bindings",
    usage: "rbox config regenerate [--yes]",
    flags: [{ flag: "--yes", short: "-y", desc: "replace the configuration without prompting (alias: -y)" }],
  },
  // <!-- FOUNDER-SIGN-OFF: draft copy for rbox config -->
  {
    name: "config repair",
    group: "GETTING STARTED",
    summary: "finish rebinding a folder moved on this machine",
    usage: "rbox config repair <path>",
  },

  // ── SYNCING ──────────────────────────────────────────────────────────────
  {
    name: "start",
    group: "SYNCING",
    summary: "start background sync for this folder",
    usage: "rbox start [path] [--pull-only | --read-write] [--trace[=<streams>]]",
    flags: [
      { flag: "--pull-only", desc: "watch remote changes without pushing local changes" },
      { flag: "--read-write", desc: "pull and push changes" },
      { flag: "--trace", desc: "trace all diagnostics, or select with --trace=propagation,held" },
    ],
    notes: ["[path] defaults to the current directory; run `rbox` to set one up."],
  },
  {
    name: "stop",
    group: "SYNCING",
    summary: "stop background sync",
    usage: "rbox stop [path]",
  },
  {
    name: "autostart",
    group: "SYNCING",
    summary: "start background sync automatically after login",
    usage: "rbox autostart <enable | disable | status>",
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
      { flag: "--follow", short: "-f", desc: "stream new log lines (Ctrl-C to exit) (alias: -f)" },
      { flag: "--limit N", desc: "show the last N lines (default 50)", takesValue: true },
      { flag: "--lines N", short: "-n", desc: "alias for --limit (alias: -n)", takesValue: true },
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
    name: "git",
    group: "SYNCING",
    summary: "inspect and resolve deferred Git repos",
    usage: "rbox git <deferrals | resolve | republish>",
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
    usage: "rbox git resolve <repo> [show-me|take-theirs|keep-mine] [--json] [--confirm <token>] [--force-discard-incoming] [--dry-run]  |  rbox git resolve --under <folder> [show-me|keep-mine] [--group <story>] [--dry-run] [--yes --expect-repos <n>]",
    flags: [
      { flag: "--json", desc: "print a typed JSON result (commit OIDs are omitted)" },
      { flag: "--confirm <token>", desc: "confirm the exact snapshot printed by show-me", takesValue: true },
      { flag: "--force-discard-incoming", desc: "keep-mine only: acknowledge your other computer's waiting Git artifacts cannot be retained" },
      { flag: "--dry-run", desc: "show what the command would do, and what it would save first; changes nothing" },
      { flag: "--under <folder>", desc: "act on every paused repo under a folder instead of one repo; the verb follows it", takesValue: true },
      { flag: "--group <story>", desc: "with --under: narrow to repos paused for one reason", takesValue: true },
      { flag: "--yes", desc: "with --under: skip the typed confirmation; requires --expect-repos" },
      { flag: "--expect-repos <n>", desc: "with --under --yes: refuse unless exactly n repos would change", takesValue: true },
    ],
    notes: [
      "The default verb is show-me.",
      "keep-mine keeps this computer's version and publishes it to your other computers.",
      "take-theirs uses the version published by your other computer; this computer's Git work is set aside in a quarantine first, and working files are not rewritten.",
      "Try --dry-run first: it prints what would change and where your backup would be saved.",
      "With --under <folder> the repository argument is omitted and the verb comes next, e.g. `rbox git resolve --under . keep-mine --dry-run`. Use `--under .` for the whole workspace.",
      "--under supports show-me and keep-mine. take-theirs stays one repo at a time until the command that restores its backup ships.",
      "Batch asks you to type the repo count. For scripts use `--yes --expect-repos <n>`, so a script written for 3 repos cannot act on 98.",
    ],
  },
  {
    name: "git republish",
    group: "SYNCING",
    summary: "restart one repository's Git pack chain on the next publish",
    usage: "rbox git republish <repo> [--json]",
    flags: [{ flag: "--json", desc: "print the recorded request as JSON" }],
    notes: [
      "Run on the machine that publishes this repository.",
      "Use it when other machines keep deferring the repo with a Git pack link verify failure: the next publish sends one self-contained bundle they can import from scratch.",
      "Records an intent only — nothing is captured, uploaded, or changed in your repository until the next publish.",
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
      { flag: "--workspace <id>", short: "-w", desc: "export one workspace (alias: -w)", takesValue: true },
      { flag: "--out <path>", desc: "write to a directory or .tar.gz (default: ~/Downloads)", takesValue: true },
    ],
    examples: ["rbox export", "rbox export --workspace ws_ab12cd34", "rbox export --out ~/backup.tar.gz"],
  },
  {
    name: "track",
    group: "SYNCING",
    summary: "set up a folder for syncing (create/join; no first sync)",
    usage: "rbox track [path] [--workspace <id>] [--include <folder>] [--respect-gitignore] [--new-device]",
    flags: [
      { flag: "--workspace <id>", short: "-w", desc: "join an existing workspace instead of creating one (alias: -w)", takesValue: true },
      { flag: "--include <folder>", desc: "sync only this folder (repeat for more); implies this machine never sends changes", takesValue: true, repeatable: true },
      { flag: "--respect-gitignore", desc: "skip gitignored untracked files in this workspace" },
      { flag: "--new-device", desc: "mint a new device identity instead of reusing this machine's enrolled device (advanced)" },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)", takesValue: true },
      { flag: "--git <true|false>", desc: "sync git repo state, encrypted (default true; pass false to opt out)", takesValue: true },
      { flag: "--project <id>", desc: "internal project identifier", takesValue: true, hidden: true },
      { flag: "--name <name>", desc: "internal workspace name", takesValue: true, hidden: true },
      { flag: "--device <id>", desc: "internal device identifier override", takesValue: true, hidden: true },
      { flag: "--no-interactive", desc: "internal non-interactive mode", hidden: true },
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
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace", takesValue: true },
      { flag: "--list", desc: "print the effective ignore rules" },
      { flag: "--respect-gitignore <on|off>", desc: "toggle skipping gitignored untracked files", takesValue: true },
      { flag: "--purge", desc: "delete already-synced paths that are now ignored after a dry-run" },
      { flag: "--yes", short: "-y", desc: "confirm --purge in headless mode (alias: -y)" },
      { flag: "--allow-mass-delete", desc: "also consent to the push-side mass-delete guard" },
    ],
    examples: ["rbox ignore 'dist/**'", "rbox ignore --list"],
  },
  {
    name: "trash",
    group: "SYNCING",
    summary: "list, restore, or permanently delete locally trashed files",
    usage: "rbox trash <list | restore | empty>",
  },
  {
    name: "trash list",
    group: "SYNCING",
    summary: "list files rbox moved to the local trash",
    usage: "rbox trash list [--path <dir>] [--json]",
    flags: [
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace", takesValue: true },
      { flag: "--json", desc: "print JSON" },
    ],
  },
  {
    name: "trash restore",
    group: "SYNCING",
    summary: "restore a trashed file back into the workspace",
    usage: "rbox trash restore <path> [--batch <name>] [--path <dir>]",
    flags: [
      { flag: "--path <dir>", desc: "workspace root; use when running outside the workspace", takesValue: true },
      { flag: "--batch <name>", desc: "restore from a specific trash batch (default: newest)", takesValue: true },
    ],
    notes: ["restores files rbox itself moved to the local trash — to fetch an older synced version, see `rbox restore`"],
  },
  {
    name: "trash empty",
    group: "SYNCING",
    summary: "permanently delete trashed files (frees disk)",
    usage: "rbox trash empty [--path <dir>]",
    flags: [{ flag: "--path <dir>", desc: "workspace root; use when running outside the workspace", takesValue: true }],
  },
  {
    name: "versions",
    group: "SYNCING",
    summary: "list version history (or a file's change history)",
    usage: "rbox versions [file] [--limit <n>] [--json]",
    flags: [
      { flag: "--limit <n>", desc: "maximum versions to show", takesValue: true },
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
    summary: "authorize + encrypt this machine with a pairing token",
    usage: "rbox connect [<pairing-token>]",
    flags: [{ flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)", takesValue: true }],
    notes: ["Run `rbox pair` on an enrolled machine and paste its complete command here. Omit the argument for a masked prompt/stdin."],
    examples: ["rbox connect rbox-pair_<id>.<secret>", "rbox connect", "echo <token> | rbox connect"],
  },
  {
    name: "recover",
    group: "DEVICES & ACCOUNT",
    summary: "clear the local head pin and re-baseline a halted workspace",
    usage: "rbox recover [path] [--yes] [--repair-chain] [--allow-mass-delete]",
    flags: [
      { flag: "--yes", short: "-y", desc: "skip the confirmation prompt (alias: -y)" },
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
    usage: "rbox key <status | save | backup | genesis | recover | create-ci | materialize | list | revoke>",
    brief: "key <subcommand>",
    flags: [
      { flag: "--json", desc: "with `status`, print JSON" },
      { flag: "--kit", desc: "with `backup`, write the cached recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "with `backup`, write the cached recovery phrase to a specific recovery kit file", takesValue: true },
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
    name: "key save",
    group: "DEVICES & ACCOUNT",
    summary: "save a validated recovery phrase to Keychain or an explicit file",
    usage: "rbox key save [--kit-path <path>]",
    flags: [{ flag: "--kit-path <path>", desc: "save to this resolved plaintext file instead of the platform default", takesValue: true }],
  },
  {
    name: "key backup",
    group: "DEVICES & ACCOUNT",
    summary: "re-show your recovery phrase (if it was cached at setup)",
    usage: "rbox key backup [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--kit", desc: "write the cached recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "write the cached recovery phrase to a specific recovery kit file", takesValue: true },
    ],
  },
  {
    name: "key recover",
    group: "DEVICES & ACCOUNT",
    summary: "re-enroll this machine from your recovery phrase (requires `rbox login` first)",
    usage: "rbox key recover [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--kit", desc: "write the entered recovery phrase to the default recovery kit path after recovery" },
      { flag: "--kit-path <path>", desc: "write the entered recovery phrase to a specific recovery kit file", takesValue: true },
    ],
  },
  {
    name: "key genesis",
    group: "DEVICES & ACCOUNT",
    summary: "set up encryption on the first machine",
    usage: "rbox key genesis --yes [--kit] [--kit-path <path>]",
    flags: [
      { flag: "--yes", short: "-y", desc: "required to mint the account's first encryption keys (alias: -y)" },
      { flag: "--kit", desc: "write the recovery phrase to the default recovery kit path" },
      { flag: "--kit-path <path>", desc: "write the recovery phrase to a specific recovery kit file", takesValue: true },
    ],
  },
  {
    name: "key create-ci",
    group: "DEVICES & ACCOUNT",
    summary: "create an agent/CI sync key bundle",
    usage: "rbox key create-ci --expires <dur> [--label <text>] [--accept-root-key]",
    flags: [
      { flag: "--expires <dur>", desc: "required; suggested 90d, maximum 1y", takesValue: true },
      { flag: "--label <text>", desc: "dashboard label", takesValue: true },
      { flag: "--accept-root-key", desc: "skip the interactive account-root warning confirmation" },
    ],
  },
  {
    name: "key materialize",
    group: "DEVICES & ACCOUNT",
    summary: "unpack RBOX_KEY into the local keystore",
    usage: "rbox key materialize [--dir <path>] [--key -] [--key-file <path>]",
    flags: [
      { flag: "--dir <path>", desc: "RBOX_HOME directory to write (default: standard location)", takesValue: true },
      { flag: "--key -", desc: "read the bundle from stdin; the RBOX_KEY env var is read automatically — literal --key=<value> is rejected (argv leaks)", takesValue: true },
      { flag: "--key-file <path>", desc: "read the RBOX_KEY bundle from a file", takesValue: true },
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
    name: "migrate",
    group: "BILLING & MAINTENANCE",
    summary: "convert this workspace's sync records to rbox's current format",
    usage: "rbox migrate [path] [--json]",
    flags: [{ flag: "--json", desc: "print the outcome as JSON (for scripts, CI, and agents)" }],
    notes: [
      "Nothing else may be using the workspace: run `rbox stop` first if background sync is on.",
      "rbox does this for you during `rbox upgrade`; run it by hand only when doctor asks you to.",
    ],
  },
  {
    name: "doctor",
    group: "BILLING & MAINTENANCE",
    summary: "explain what is stuck and how to fix it, in plain English",
    usage: "rbox doctor [reset-journal] [path] [--all] [--json | --report | --residue-bytes | --quarantine | --restore <bundle>]",
    flags: [
      { flag: "--all", desc: "check every locally known synced folder (cannot be combined with a path)" },
      { flag: "--json", desc: "print the findings as JSON (outside a workspace, the all-workspaces summary)" },
      { flag: "--report", desc: "build and print the support report locally" },
      { flag: "--residue-bytes", desc: "measure known Git quarantine and conflict directories" },
      { flag: "--diagnostics", desc: "with --report, upload the report to rbox support (stored unencrypted for 30 days)" },
      { flag: "--yes", short: "-y", desc: "skip the upload consent prompt; required with --report --diagnostics in non-interactive mode (alias: -y)" },
      { flag: "--path <dir>", desc: "compatibility alias for the [path] positional", takesValue: true },
      { flag: "--quarantine", desc: "with reset-journal, preserve and remove an unsafe standing journal" },
      { flag: "--restore <bundle>", desc: "with reset-journal, restore a committed quarantine bundle", takesValue: true },
      { flag: "--retry-state-migration", desc: "resume a paused conversion of this workspace's sync records after fixing what stopped it" },
      { flag: "--abort-state-migration", desc: "abandon an unfinished conversion and keep the sync records rbox is using now" },
    ],
  },
  {
    name: "upgrade",
    group: "BILLING & MAINTENANCE",
    summary: "update the rbox binary",
    usage: "rbox upgrade [--check] [--channel <latest|next>]",
    flags: [
      { flag: "--check", desc: "report whether an update is available, without installing" },
      { flag: "--channel <latest|next>", desc: "switch and persist the release channel (default: latest)", takesValue: true },
      { flag: "--remote <url>", desc: "rbox API server (default: production; the RBOX_API env var also overrides)", takesValue: true },
    ],
  },
  {
    name: "uninstall",
    group: "BILLING & MAINTENANCE",
    summary: "remove local rbox state and installed files",
    usage: "rbox uninstall [--yes]",
    flags: [{ flag: "--yes", short: "-y", desc: "perform the removal; without it, print the steps only (alias: -y)" }],
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
  {
    name: "link",
    group: "SYNCING",
    summary: "deprecated → rbox track",
    usage: "rbox link <path>",
    hidden: true,
    alias: { kind: "rename", target: "track", notice: "note: 'rbox link' is now 'rbox track'." },
  },
  {
    name: "daemon",
    group: "SYNCING",
    summary: "deprecated → rbox start/stop/logs",
    usage: "rbox daemon <start|stop|status|logs>",
    hidden: true,
    alias: {
      kind: "subcommands",
      helpTarget: "start",
      fallbackNotice: "note: 'rbox daemon …' is now 'rbox start/stop/logs'.",
      routes: {
        start: { target: "start", notice: "note: 'rbox daemon …' is now 'rbox start/stop/logs'." },
        stop: { target: "stop", notice: "note: 'rbox daemon …' is now 'rbox start/stop/logs'." },
        logs: { target: "logs", notice: "note: 'rbox daemon …' is now 'rbox start/stop/logs'." },
        status: { target: "status", notice: "note: daemon status is now part of 'rbox status'." },
      },
    },
  },
  // hydrate/detect aliases commented out along with `deps` itself (design 51)
  // — their forward target no longer exists, so keeping them would dangle.
  // The old deps-doctor alias is intentionally not restored; `doctor` is support diagnostics.
  // { name: "hydrate", group: "DEPENDENCIES", summary: "deprecated → rbox deps install", usage: "rbox hydrate [path]", hidden: true, alias: "deps install" },
  // { name: "detect", group: "DEPENDENCIES", summary: "deprecated → rbox deps list", usage: "rbox detect [path]", hidden: true, alias: "deps list" },
];

const byName = new Map(COMMAND_HELP.map((c) => [c.name, c]));
const firstWord = (name: string): string => name.split(" ")[0]!;

/** Public command paths shown by help and completion projections. */
export const PUBLIC_COMMANDS: readonly string[] = COMMAND_HELP.filter((command) => !command.hidden).map((command) => command.name);

/** Deprecated command tokens accepted by the parser and dispatcher. */
export const ALIAS_COMMANDS: readonly string[] = COMMAND_HELP.filter((command) => command.alias).map((command) => command.name);

/** Every top-level token the existing lazy dispatcher handles. */
export const KNOWN_TOP_LEVEL: ReadonlySet<string> = new Set([
  ...COMMAND_HELP.map((command) => firstWord(command.name)),
  "help",
  "__daemon-run",
  "__boot-resume",
]);

export function isKnownTopLevel(command: string | undefined): boolean {
  return command !== undefined && KNOWN_TOP_LEVEL.has(command);
}

function aliasTarget(alias: DeprecatedAlias): string {
  return alias.kind === "rename" ? alias.target : alias.helpTarget;
}

/** Resolve deprecated syntax before the existing lazy dispatcher switch. */
export function resolveAlias(command: string, positional: string[]): ResolvedAlias | null {
  const alias = byName.get(command)?.alias;
  if (!alias) return null;
  if (alias.kind === "rename") {
    const [cmd, subcommand] = alias.target.split(" ");
    return {
      cmd: cmd!,
      positional: subcommand ? [subcommand, ...positional] : positional,
      notice: alias.notice,
    };
  }
  const [subcommand, ...rest] = positional;
  const route = subcommand === undefined ? undefined : alias.routes[subcommand];
  return route
    ? { cmd: route.target, positional: rest, notice: route.notice }
    : { cmd: command, positional, notice: alias.fallbackNotice };
}

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

/**
 * Resolve a deprecated alias entry (`link`, `daemon`) to the command path it forwards to.
 * An alias runs the target's exact operation on the same argv but
 * declares no flags of its own, so anything reading a command's flag DECLARATIONS — the
 * parser's per-command arity — must read the target's. Help rendering deliberately does
 * NOT resolve: `rbox link --help` shows the alias entry and its "deprecated → …" line.
 */
export function resolveCommandAlias(commandPath: string): string {
  const alias = byName.get(commandPath)?.alias;
  return alias ? aliasTarget(alias) : commandPath;
}

/** Render one command's detailed help block. */
export function renderCommand(c: CommandHelp): string {
  const lines: string[] = [];
  lines.push(`${style.bold(c.name)} — ${c.summary}`);
  lines.push("");
  lines.push(`${style.dim("usage:")} ${c.usage}`);
  if (c.notes?.length) for (const note of c.notes) lines.push(style.dim(note));
  if (c.alias) lines.push(style.yellow(`deprecated: use \`rbox ${aliasTarget(c.alias)}\``));
  const visibleFlags = c.flags?.filter((flag) => !flag.hidden);
  if (visibleFlags?.length) {
    lines.push("");
    lines.push(style.dim("flags:"));
    const w = Math.max(...visibleFlags.map((flag) => flag.flag.length));
    for (const flag of visibleFlags) lines.push(`  ${flag.flag.padEnd(w)}  ${style.dim(flag.desc)}`);
  }
  if (c.examples?.length) {
    lines.push("");
    lines.push(style.dim("examples:"));
    for (const ex of c.examples) lines.push(`  ${ex}`);
  }
  return lines.join("\n");
}

/**
 * Render the founder-approved top-level help screen: the common loop only, with
 * the real signatures. The `[PATH]` argument is the point — it already exists in
 * every one of these commands, and hiding it here is what made `start` read like
 * a machine-wide daemon switch instead of a workspace verb.
 *
 * Column widths are computed across ALL rows so one description column runs the
 * length of the screen.
 */
const ESSENTIAL_HELP_GROUPS: { heading: string; entries: [string, string][] }[] = [
  {
    heading: "GET STARTED",
    entries: [
      ["rbox", "set up rbox, or pick what to do in this folder"],
      ["rbox status [PATH]", "show one synced folder, or all when outside one"],
    ],
  },
  {
    heading: "SYNC",
    entries: [
      ["rbox sync [PATH]", "sync once"],
      ["rbox start [PATH]", "start background sync"],
      ["rbox stop [PATH]", "stop background sync"],
      ["rbox logs [PATH]", "show background-sync logs"],
    ],
  },
  {
    heading: "ADD A MACHINE",
    entries: [
      ["rbox pair", "create a token on a machine that's already set up"],
      ["rbox connect TOKEN", "authorize + encrypt this machine with that token"],
    ],
  },
  {
    heading: "FIX",
    entries: [["rbox doctor [PATH]", "explain what's wrong and what to run next"]],
  },
  {
    heading: "MORE",
    entries: [
      ["rbox <command> --help", "flags and details for one command"],
      ["rbox help --all", "the full command reference"],
    ],
  },
];

export function renderEssentialHelp(): string {
  const lines: string[] = [];
  lines.push(`${style.bold("rbox")} — end-to-end encrypted sync for your dev folders`);

  const w = Math.max(...ESSENTIAL_HELP_GROUPS.flatMap(({ entries }) => entries.map(([command]) => command.length)));
  for (const { heading, entries } of ESSENTIAL_HELP_GROUPS) {
    lines.push("");
    lines.push(style.dim(heading));
    for (const [command, summary] of entries) lines.push(`  ${command.padEnd(w)}  ${style.dim(summary)}`);
  }
  lines.push("");
  lines.push(style.dim("PATH names any location inside a synced folder; it selects that whole folder."));
  lines.push(style.dim("Exit codes: 0 ok, 1 error, 130 user cancel (Ctrl-C)."));
  return lines.join("\n");
}

/**
 * Render the full reference screen: one row per TOP-LEVEL command, flags omitted.
 * Subcommand leaves ("key status", "trash restore") stay registered for `--help`
 * and completions but collapse into their parent's row here — the reference screen
 * answers "what commands exist", and `rbox <command> --help` answers the rest.
 */
export function renderGroupedHelp(): string {
  const lines: string[] = [];
  lines.push(`${style.bold("rbox")} — dev-aware sync ${style.dim("(end-to-end encrypted)")}`);
  const visible = COMMAND_HELP.filter((c) => !c.hidden && !c.name.includes(" "));
  for (const group of GROUP_ORDER) {
    const entries = visible.filter((c) => c.group === group);
    if (!entries.length) continue;
    lines.push("");
    lines.push(style.dim(group));
    const w = Math.max(...entries.map((e) => briefUsage(e).length));
    for (const e of entries) lines.push(`  ${briefUsage(e).padEnd(w)}  ${style.dim(e.summary)}`);
  }
  lines.push("");
  lines.push(style.dim("Run `rbox <command> --help` for details on any command."));
  lines.push(style.dim("Exit codes: 0 ok, 1 error, 130 user cancel (Ctrl-C)."));
  return lines.join("\n");
}

/** The grouped-screen left column: the usage minus the leading "rbox " and minus
 *  every flag — `[--x]` groups and top-level `| --x …` alternates — so the column
 *  shows only the command's shape (subverbs + positionals). */
function briefUsage(c: CommandHelp): string {
  if (c.brief) return c.brief;
  const body = c.usage.startsWith("rbox ") ? c.usage.slice("rbox ".length) : c.name;
  return body
    .replace(/\s*\[--[^\]]*\]/g, "")
    .replace(/\s*\|\s*--\S+( <[^>]+>)?/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
  return c.flags?.some((flag) => flag.flag.split(/\s+/, 1)[0] === normalized) ?? false;
}

export function commandSupportsFlag(cmd: string | undefined, positional: string[], flagName: string): boolean {
  if (!cmd) return false;
  return helpFor(helpKeyFor(cmd, positional))?.some((entry) => commandHasFlag(entry, flagName)) ?? false;
}
