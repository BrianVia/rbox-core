import path from "node:path";
import fs from "node:fs/promises";
import { findRoot as findWorkspaceRoot } from "./config.js";
import { rememberResolvedRoot } from "./binding-registry.js";
import { runPullCommand, runPushCommand, runSyncCommand } from "./sync-cmd.js";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";
import { parseDaemonTraceStreams } from "./daemon/process-control.js";
import { autostartCmd, bootResume, BOOT_RESUME_MARKER, startDaemonForUser, stopDaemonAndRecordDesired } from "./autostart-cmd.js";
import { addIgnorePattern, listIgnoreRules, purgeIgnored, setRespectGitignore } from "./ignore-cmd.js";
import { approveDevice, keyBackup, keyGenesis, keySave, keyStatus, listDevices, login, logout, recoverCmd, revokeDevice } from "./auth-cmd.js";
import { DEFAULT_REMOTE } from "./api-base.js";
import { fail, setJsonErrorMode, style } from "./style.js";
import { spinner } from "./spinner.js";
import {
  commandSupportsFlag,
  helpFor,
  helpKeyFor,
  isKnownTopLevel,
  renderCommand,
  renderEssentialHelp,
  renderGroupedHelp,
  resolveAlias,
} from "./help-registry.js";
import { recoveryKitOptionsFromFlags } from "./recovery-kit.js";
import { maybeNudgeForUpdate } from "./update-check.js";
import { parseFlags, unknownFlagError } from "./flags.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { refreshSystemLockIdentityLedger } from "../engine/git/lockfile.js";
import { expandUserPath } from "./directory-picker.js";
import { homeDir } from "./rbox-paths.js";

async function canonicalUserPath(value: string): Promise<string> {
  const lexical = path.resolve(expandUserPath(value, homeDir()));
  return fs.realpath(lexical).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? lexical : Promise.reject(error));
}

/** Print per-command, essential, or full-reference help and nothing else. Stdout, exit 0. */
function printHelp(cmd: string | undefined, positional: string[], fullReference = false): void {
  if (!cmd) {
    console.log(fullReference ? renderGroupedHelp() : renderEssentialHelp());
    return;
  }
  const entries = helpFor(helpKeyFor(cmd, positional));
  console.log(entries ? entries.map(renderCommand).join("\n\n") : renderEssentialHelp());
}

// `rbox deps <sub>` group dispatch — commented out (design 51): the whole `deps`
// CLI surface (install/list/check/drift/notify, plus the old hydrate/detect
// aliases and their entries in the command grammar) is disabled
// for now. The underlying implementations (hydrate-cmd.ts, deps-drift.ts,
// deps-notify.ts) are untouched, so re-enabling is: uncomment this function +
// its `case "deps"` below + the registry/alias entries. `postSyncNudge` below is
// UNAFFECTED — it's the automatic post-sync drift notice, not a `deps` command,
// and is the future home of design 51's `notifyOfDepsChange` project setting.
//
// async function runDeps(positional: string[], flags: Record<string, string>): Promise<void> {
//   const sub = positional[0];
//   const pathArg = path.resolve(positional[1] ?? process.cwd());
//   if (sub === "install") {
//     const { hydrateCmd } = await import("./hydrate-cmd.js");
//     await hydrateCmd(pathArg, { allowBuild: flags["allow-build"] === "true", manager: flags.manager, only: flags.only });
//   } else if (sub === "list") {
//     const { detectCmd } = await import("./hydrate-cmd.js");
//     await detectCmd(pathArg, flags.manager);
//   } else if (sub === "check") {
//     const { doctorCmd } = await import("./hydrate-cmd.js");
//     await doctorCmd(pathArg);
//   } else if (sub === "drift") {
//     const { driftCmd } = await import("./deps-drift.js");
//     await driftCmd(pathArg, flags.quiet === "true");
//   } else if (sub === "notify") {
//     const { notifyCmd } = await import("./deps-notify.js");
//     await notifyCmd(positional[1]);
//   } else {
//     console.log("usage: rbox deps <install | list | check | drift | notify> [path]");
//     process.exitCode = 1;
//   }
// }

const LEGACY_WORKSPACE_REQUIRED = "Not inside an rbox workspace. Run `rbox setup` to get started, or `rbox track <path>` to bind a directory.";
// CLI-process presentation mode: keep existing JSON error bytes while the
// versioned JSON surface still promises the legacy workspace vocabulary.
let preserveWorkspaceJsonErrors = false;

function workspaceCopy(human: string, legacy: string): string {
  return preserveWorkspaceJsonErrors ? legacy : human;
}

function workspaceRequiredError(): Error {
  return new Error(workspaceCopy(
    "Not inside a synced folder. Run `rbox setup` to get started, or `rbox track <path>` to sync a folder.",
    LEGACY_WORKSPACE_REQUIRED,
  ));
}

/** `start` used to open the guided front door when it could not resolve a workspace
 *  on a TTY, which made one command mean two different things. It now only starts a
 *  workspace's background sync, and routes setup to the bare-`rbox` front door. */
function startWorkspaceRequiredError(): Error {
  return new Error("Not inside a synced folder. Run `rbox` to get started, or pass the folder: rbox start <path>");
}

async function resolveRoot(arg: string | undefined): Promise<string> {
  const root = await findRoot(arg ? path.resolve(arg) : process.cwd());
  if (!root) throw workspaceRequiredError();
  return root;
}

/**
 * Design 211's convergence net. Every workspace-local command resolves its root
 * through here, so operating on a workspace also records (or refreshes) its
 * entry in the local binding registry. That is what folds in bindings made by an
 * older binary, and what covers any future bind path that forgets to register
 * itself. Read-mostly and best-effort: it writes only when something changed.
 */
async function findRoot(start: string): Promise<string | undefined> {
  const root = await findWorkspaceRoot(start);
  if (root !== undefined) await rememberResolvedRoot(root);
  return root;
}

async function resolvePathFlagRoot(arg: string | undefined): Promise<string> {
  const root = await findRoot(arg ? path.resolve(arg) : process.cwd());
  if (!root) throw new Error(workspaceCopy(
    "Not inside a synced folder. Run from the folder, or pass --path <dir>.",
    "Not inside an rbox workspace. Run from the workspace, or pass --path <dir>.",
  ));
  return root;
}

/** #498: outside a workspace, `rbox doctor`/`rbox status` summarize every synced
 * folder on this machine instead of dead-ending on "Not inside an rbox workspace". */
async function runMachineTriage(jsonMode: boolean, surface: "doctor" | "status" = "doctor"): Promise<void> {
  const { collectMachineAggregate, renderMachineStatusTable, renderMachineTriage } = await import("./doctor-machine.js");
  const { triage, configuredButUnbound } = await collectMachineAggregate();
  if (jsonMode) {
    const { emitJson } = await import("./json.js");
    emitJson(triage);
    return;
  }
  const render = surface === "status" ? renderMachineStatusTable : renderMachineTriage;
  for (const line of render(triage, configuredButUnbound)) console.log(line);
}

/** `--all` is an aggregate over every locally known workspace, so a PATH — which
 * selects exactly one — cannot mean anything alongside it (CLI-surface memo §3). */
function assertAllWithoutPath(cmd: string, all: boolean, pathArg: string | undefined): void {
  if (all && pathArg !== undefined) {
    throw new Error(workspaceCopy(
      `--all covers every locally known synced folder, so it cannot be combined with a path. Use \`rbox ${cmd} --all\` or \`rbox ${cmd} ${pathArg}\`.`,
      `--all covers every locally known workspace, so it cannot be combined with a path. Use \`rbox ${cmd} --all\` or \`rbox ${cmd} ${pathArg}\`.`,
    ));
  }
}

export type FrontDoorImport = () => Promise<Pick<typeof import("./front-door.js"), "resolveBareRboxTarget" | "runFrontDoor" | "runUntrackedMenu">>;
export type UpgradeCommandImport = () => Promise<Pick<typeof import("./upgrade-cmd.js"), "upgradeCmd">>;

async function runGuidedFrontDoor(importFrontDoor: FrontDoorImport = () => import("./front-door.js")): Promise<void> {
  const { resolveBareRboxTarget, runFrontDoor, runUntrackedMenu } = await importFrontDoor();
  const target = await resolveBareRboxTarget(process.cwd());
  if (target.kind === "front-door") {
    await runFrontDoor(target.root);
  } else if (target.kind === "untracked-menu") {
    const kind = await runUntrackedMenu(process.cwd(), target.accountId);
    if (kind) {
      const { runSetup } = await import("./setup-cmd.js");
      await runSetup({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE, flags: {}, preselectedWorkspaceKind: kind, viaUntrackedMenu: true });
    }
  } else {
    const { runSetup } = await import("./setup-cmd.js");
    await runSetup({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE, flags: {} });
  }
}

export interface MainDispatchDeps {
  now?: () => Date;
  frontDoorImport?: FrontDoorImport;
  authCommandImport?: () => Promise<Pick<typeof import("./auth-cmd.js"), "pairCreate" | "readPairingTokenInteractive" | "redeemPair">>;
  upgradeCommandImport?: UpgradeCommandImport;
  isElevated?: () => boolean;
  refreshSystemLockIdentityLedger?: typeof refreshSystemLockIdentityLedger;
}

export async function main(deps: MainDispatchDeps = {}): Promise<void> {
  let [cmd] = process.argv.slice(2) as [string | undefined];
  const elevated = (deps.isElevated ?? (() => typeof process.geteuid === "function" && process.geteuid() === 0))();
  // Resolve and persist this boot even for commands which never acquire a
  // workspace lock. Locking remains availability-biased when identity is
  // unavailable, so non-locking commands must not fail on this health hook.
  // Elevated upgrade is deliberately home-isolated: its install-scoped lock
  // uses live OS identity without refreshing the optional ~/.rbox ledger.
  if (!(cmd === "upgrade" && elevated)) {
    await (deps.refreshSystemLockIdentityLedger ?? refreshSystemLockIdentityLedger)().catch(() => {});
  }
  const rest = process.argv.slice(3);
  const parsed = parseFlags(rest, cmd);
  let positional = parsed.positional;
  const flags = parsed.flags;
  const rawJsonMode = flags.json === "true";

  // `rbox --version` / `-v` / `version` → the binary's embedded version.
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    const { RBOX_VERSION } = await import("./version.js");
    console.log(RBOX_VERSION);
    return;
  }

  // Help dispatch (design 29 §"Per-command help") — BEFORE running anything (so an
  // alias's `--help` shows its own "deprecated → …" block):
  //   `rbox help [<cmd>]`, `rbox --help`/`-h`, and `rbox <cmd> --help`/`-h`.
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    const fullReference = cmd === "help" && positional.length === 0 && flags.all === "true";
    printHelp(positional[0], positional.slice(1), fullReference);
    return;
  }
  if (cmd && (rest.includes("--help") || rest.includes("-h"))) {
    printHelp(cmd, positional);
    return;
  }

  // Deprecated aliases (design 29): rewrite to the canonical command in ONE pass and
  // warn on stderr, so the switch below only ever handles canonical commands.
  if (cmd) {
    const alias = resolveAlias(cmd, positional);
    if (alias) {
      process.stderr.write(`${alias.notice}\n`);
      cmd = alias.cmd;
      positional = alias.positional;
    }
  }

  const jsonMode = rawJsonMode && commandSupportsFlag(cmd, positional, "--json");
  preserveWorkspaceJsonErrors = jsonMode;
  setJsonErrorMode(jsonMode);
  if (rawJsonMode && !jsonMode) flags.json = "false";

  if (cmd && cmd !== "help" && !cmd.startsWith("__") && cmd !== BOOT_RESUME_MARKER) {
    const err = unknownFlagError(cmd, positional, flags);
    if (err) {
      fail(err);
      return;
    }
  }

  // Bare `rbox` (cmd === undefined) is excluded too: in a tracked dir it renders the
  // status block (whose own update line covers this — nudging here would print BEFORE
  // the block, which `rbox status` never does), and mid-setup an upgrade nag is noise.
  const isGitDeferrals = cmd === "git" && positional[0] === "deferrals";
  if (!rawJsonMode && !isGitDeferrals && cmd && cmd !== "status" && cmd !== "upgrade" && cmd !== "help" && cmd !== "__daemon-run" && cmd !== BOOT_RESUME_MARKER) {
    await maybeNudgeForUpdate();
  }

  switch (cmd) {
    case "init": {
      const { runInit } = await import("./init-cmd.js");
      await runInit(flags, { cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE });
      break;
    }
    case "setup": {
      const { runSetup } = await import("./setup-cmd.js");
      await runSetup({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE, flags });
      break;
    }
    case "adopt": {
      if (positional.length > 2) throw new Error("usage: rbox adopt <status|resume|abort|clean> [path] [--json] [--yes]");
      const { adoptCmd } = await import("./adopt-cmd.js");
      await adoptCmd(positional[0], positional[1] ?? process.cwd(), { json: jsonMode, yes: flags.yes === "true" });
      break;
    }
    case "config": {
      const { folderConfigCmd } = await import("./folder-config-cmd.js");
      await folderConfigCmd(positional, { json: jsonMode, yes: flags.yes === "true" });
      break;
    }
    case "track": {
      const { track, printTrackResult } = await import("./track-cmd.js");
      printTrackResult(await track(positional[0], flags, DEFAULT_REMOTE));
      break;
    }
    case "untrack": {
      const explicit = positional[0] === undefined ? undefined : await canonicalUserPath(positional[0]);
      // An EXACT registry hit wins before any upward search. A root the registry
      // still lists but whose `.rbox/` binding is gone has no workspace to walk
      // up to, and walking up would untrack whichever ancestor happens to be a
      // workspace — destroying a binding the user never named. Forgetting the
      // named root is the remedy `status --all` prints for that row (design 211).
      const registered = explicit !== undefined
        && await (await import("./binding-registry.js")).isRegisteredRoot(explicit);
      let configured = false;
      let damaged = false;
      if (explicit !== undefined) {
        const catalog = await import("./folder-config.js");
        const state = await catalog.inspectFolderCatalog();
        damaged = state.kind === "damaged";
        if (state.kind === "authoritative") {
          for (const folder of state.snapshot.folders) {
            if (await canonicalUserPath(folder.normalizedPath) === explicit) {
              configured = true;
              break;
            }
          }
        }
      }
      let resolved: string | undefined;
      if (registered || configured) {
        resolved = explicit;
      } else if (damaged && explicit !== undefined) {
        const observed = await findRoot(explicit);
        resolved = observed !== undefined && await canonicalUserPath(observed) === explicit ? explicit : undefined;
      } else {
        resolved = await findRoot(explicit ?? process.cwd());
      }
      if (resolved === undefined) throw workspaceRequiredError();
      const root = resolved;
      const { untrack } = await import("./untrack-cmd.js");
      await untrack({
        root,
        force: flags.force === "true",
        confirm: async () => {
          const { confirmDestructive } = await import("./prompt.js");
          return confirmDestructive({
            message: `Stop syncing ${root}? Local files stay.`,
            default: false,
            headless: "proceed",
          });
        },
      });
      break;
    }
    // case "deps": disabled (design 51) — see runDeps above. Falls through to
    // `default:`, which prints the grouped help and exits 1 (unknown command),
    // same as any other command the dispatcher doesn't recognize.
    case "login": {
      // `--bootstrap` MUST carry a secret. A value-less/empty flag (parsed as
      // "true") used to silently fall through to the device-approval flow and
      // block ~10min looking hung — fail fast with a clear message instead.
      if (flags.bootstrap === "true") throw new Error("`--bootstrap` needs a secret value: `rbox login --bootstrap <secret>` (or just `rbox login` for device approval)");
      await login(flags.remote ?? DEFAULT_REMOTE, flags.bootstrap, flags.plan, recoveryKitOptionsFromFlags(flags), flags.label);
      break;
    }
    case "logout": {
      await logout();
      break;
    }
    case "pair": {
      if (positional.length !== 0) throw new Error("usage: rbox pair");
      const { pairCreate } = await (deps.authCommandImport ?? (() => import("./auth-cmd.js")))();
      await pairCreate();
      break;
    }
    case "upgrade": {
      const { upgradeCmd } = await (deps.upgradeCommandImport ?? (() => import("./upgrade-cmd.js")))();
      await upgradeCmd(flags.remote ?? DEFAULT_REMOTE, {
        check: flags.check === "true",
        channel: flags.channel,
        commandDeps: { isElevated: () => elevated },
      });
      break;
    }
    case "device": {
      const sub = positional[0];
      if (sub === "approve") await approveDevice(positional[1] ?? "");
      else if (sub === "list") await listDevices({ json: jsonMode });
      else if (sub === "revoke") await revokeDevice(positional[1] ?? "");
      else {
        fail("usage: rbox device <approve <user-code>|list|revoke <device-id>>");
      }
      break;
    }
    case "account": {
      // Web↔CLI account linking (design 21). Distinct from `link <path>` (§4.0).
      const sub = positional[0];
      const { accountLink, accountStatus, accountUnlink } = await import("./account-cmd.js");
      if (sub === "link") await accountLink(positional[1] ?? "");
      else if (sub === "status") await accountStatus({ json: jsonMode });
      else if (sub === "unlink") await accountUnlink();
      else {
        fail("usage: rbox account <link <code>|status|unlink>");
      }
      break;
    }
    case "subscribe": {
      // PRIMARY billing path (design 21 §3.4.1): open a Stripe checkout bound to
      // THIS account's durable token — no web shell, no Clerk identity bind.
      const { subscribe } = await import("./subscribe-cmd.js");
      await subscribe(positional[0], { annual: flags.annual === "true" });
      break;
    }
    case "billing": {
      const { billingPortal } = await import("./subscribe-cmd.js");
      await billingPortal();
      break;
    }
    case "uninstall": {
      const { uninstallCmd } = await import("./uninstall-cmd.js");
      await uninstallCmd(flags);
      break;
    }
    case "usage": {
      const { usageCmd } = await import("./usage-cmd.js");
      await usageCmd({ json: jsonMode });
      break;
    }
    case "push": {
      const root = await resolveRoot(positional[0]);
      await runPushCommand(root, { allowMassDelete: flags["allow-mass-delete"] === "true" });
      break;
    }
    case "pull": {
      const root = await resolveRoot(positional[0]);
      await runPullCommand(root, {
        allowMassDelete: flags["allow-mass-delete"] === "true",
        verbose: flags["verbose"] === "true",
      });
      break;
    }
    case "sync": {
      const root = await resolveRoot(positional[0]);
      await runSyncCommand(root, {
        allowMassDelete: flags["allow-mass-delete"] === "true",
        pullOnly: flags["pull-only"] === "true",
        verbose: flags["verbose"] === "true",
      });
      break;
    }
    case "include": {
      const root = await resolveRoot(undefined);
      const { scopeCmd } = await import("./scope/scope-cmd.js");
      await scopeCmd(root, positional[0], positional.slice(1), { json: jsonMode });
      break;
    }
    case "export": {
      const { runExport } = await import("./export-cmd.js");
      const localRoot = await findRoot(process.cwd());
      if (localRoot) await withWorkspaceSyncMutex(localRoot, async () => runExport(flags));
      else {
        const { findAdoptRoot, inspectAdoptFence } = await import("./adopt-journal.js");
        const adoptRoot = await findAdoptRoot(process.cwd());
        if (adoptRoot) {
          const fence = await inspectAdoptFence(adoptRoot);
          if (fence.status === "active" || fence.status === "corrupt") throw new Error("workspace has an incomplete adoption; run `rbox adopt status|resume|abort`");
        }
        await runExport(flags);
      }
      break;
    }
    case "status": {
      if (positional.length > 1) {
        fail("usage: rbox status [path] [--all] [--json | --verbose | --git]");
        break;
      }
      const presentations = [flags.json, flags.verbose, flags.git].filter((value) => value === "true").length;
      if (presentations > 1) {
        fail("choose only one status presentation flag: --json, --verbose, or --git");
        break;
      }
      assertAllWithoutPath("status", flags.all === "true", positional[0]);
      if (flags.all === "true") {
        // --verbose and --git are single-workspace detail views; silently
        // ignoring them would report the wrong thing with a success exit code.
        if (flags.verbose === "true" || flags.git === "true") {
          throw new Error(workspaceCopy(
            "--all is the aggregate view; --verbose and --git report one synced folder. Use `rbox status --all [--json]`.",
            "--all is the aggregate view; --verbose and --git report one workspace. Use `rbox status --all [--json]`.",
          ));
        }
        await runMachineTriage(jsonMode, "status");
        break;
      }
      const statusRoot = await findRoot(positional[0] ? path.resolve(positional[0]) : process.cwd());
      if (!statusRoot) {
        await runMachineTriage(jsonMode, "status");
        break;
      }
      const root = statusRoot;
      const { statusCmd } = await import("./status-cmd.js");
      await statusCmd(root, {
        json: jsonMode,
        verbose: flags.verbose === "true",
        git: flags.git === "true",
        now: deps.now?.(),
      });
      break;
    }
    case "migrate": {
      // Entry point B of design 222 §3.2. Workspace-scoped like every other local
      // verb, and refused outside a workspace rather than silently resolved to the
      // machine-wide surface: there is no machine-wide meaning for converting one
      // workspace's records.
      const root = await findRoot(positional[0] ? path.resolve(positional[0]) : process.cwd());
      if (!root) {
        throw new Error(workspaceCopy(
          "Not inside a synced folder. Run from the folder, or pass its path: rbox migrate <path>.",
          "Not inside an rbox workspace. Run from the workspace, or pass the workspace path: rbox migrate <path>.",
        ));
      }
      const { migrateCmd } = await import("./state-plane-cmd.js");
      const code = await migrateCmd(root, { json: jsonMode });
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "doctor": {
      const report = flags.report === "true";
      const retryStateMigration = flags["retry-state-migration"] === "true";
      const abortStateMigration = flags["abort-state-migration"] === "true";
      if (retryStateMigration && abortStateMigration) {
        throw new Error("choose one: --retry-state-migration resumes a paused conversion, --abort-state-migration abandons it");
      }
      const diagnostics = flags.diagnostics === "true";
      const residueBytes = flags["residue-bytes"] === "true";
      if (diagnostics && !report) throw new Error("--diagnostics uploads the support report — combine it with --report: rbox doctor --report --diagnostics");
      // The workspace root is an optional positional (`rbox doctor <path>`), like
      // every other workspace-local verb; `--path <dir>` stays as a compatibility
      // alias. `reset-journal` is a sub-verb, so the path follows it when present.
      const resetJournal = positional[0] === "reset-journal";
      const doctorPath = (resetJournal ? positional[1] : positional[0]) ?? flags.path;
      assertAllWithoutPath("doctor", flags.all === "true", doctorPath);
      if (flags.all === "true") {
        // Bounded, read-only diagnostics across the registry. The workspace-scoped
        // support-report and reset-journal work has no machine-wide meaning.
        if (report || diagnostics || residueBytes || resetJournal || flags.quarantine === "true" || flags.restore !== undefined) {
          throw new Error("--all runs the read-only all-workspaces check; support-report, residue measurement, and reset-journal work are workspace-scoped");
        }
        await runMachineTriage(jsonMode);
        break;
      }
      const doctorRoot = await findRoot(doctorPath ? path.resolve(doctorPath) : process.cwd());
      if (!doctorRoot) {
        // Support-report and reset-journal work is workspace-scoped; only the
        // plain triage read has a meaningful machine-wide answer.
        if (report || diagnostics || resetJournal || doctorPath !== undefined || flags.quarantine === "true" || flags.restore !== undefined) {
          throw new Error(workspaceCopy(
            "Not inside a synced folder. Run from the folder, or pass its path: rbox doctor <path>.",
            "Not inside an rbox workspace. Run from the workspace, or pass the workspace path: rbox doctor <path>.",
          ));
        }
        await runMachineTriage(jsonMode);
        break;
      }
      const root = doctorRoot;
      if (resetJournal) {
        if (report || diagnostics) throw new Error("reset-journal rescue cannot be combined with support-report flags");
        const { resetJournalDoctorCmd } = await import("./reset-journal-doctor.js");
        await resetJournalDoctorCmd(root, { quarantine: flags.quarantine === "true", restore: flags.restore });
        break;
      }
      if (flags.quarantine === "true" || flags.restore !== undefined) throw new Error("--quarantine/--restore require `rbox doctor reset-journal`");
      // The two authorized interventions on a suspended conversion (222 §7.3,
      // §7.9). They MUTATE, so each is the whole command rather than an extra
      // section under the read-only triage.
      if (retryStateMigration || abortStateMigration) {
        if (report || diagnostics || residueBytes) {
          throw new Error("--retry-state-migration/--abort-state-migration act on the workspace; run `rbox doctor --report` separately");
        }
        const { abortStateMigrationCmd, retryStateMigrationCmd } = await import("./state-plane-cmd.js");
        const act = retryStateMigration ? retryStateMigrationCmd : abortStateMigrationCmd;
        const code = await act(root, { json: jsonMode });
        if (code !== 0) process.exitCode = code;
        break;
      }
      const { doctorCmd } = await import("./doctor-cmd.js");
      await doctorCmd(root, { report, yes: flags.yes === "true", diagnostics, residueBytes, json: jsonMode, now: deps.now?.().getTime() });
      break;
    }
    case "start": {
      if (flags["pull-only"] === "true" && flags["read-write"] === "true") {
        throw new Error("choose only one background sync mode: --pull-only or --read-write");
      }
      const mode = flags["pull-only"] === "true"
        ? "pull-only" as const
        : flags["read-write"] === "true"
          ? "read-write" as const
          : undefined;
      const traceStreams = flags.trace === undefined ? undefined : parseDaemonTraceStreams(flags.trace);
      const root = await findRoot(positional[0] ? path.resolve(positional[0]) : process.cwd());
      if (!root) throw startWorkspaceRequiredError();
      await startDaemonForUser(root, { mode, traceStreams });
      break;
    }
    case "stop": {
      await stopDaemonAndRecordDesired(await resolveRoot(positional[0]));
      break;
    }
    case "autostart": {
      await autostartCmd(positional[0]);
      break;
    }
    case "logs": {
      const follow = flags.follow === "true";
      const n = flags.limit ?? flags.lines;
      const lines = n !== undefined && Number.isInteger(Number(n)) && Number(n) >= 0 ? Number(n) : DEFAULT_LOG_LINES;
      await logsDaemon(await resolveRoot(positional[0]), { follow, lines });
      break;
    }
    case "ignore": {
      const root = await resolvePathFlagRoot(flags.path);
      if (flags["respect-gitignore"] !== undefined) await setRespectGitignore(root, flags["respect-gitignore"]);
      else if (flags.purge === "true") await purgeIgnored(root, { yes: flags.yes === "true", allowMassDelete: flags["allow-mass-delete"] === "true" });
      else if (flags.list === "true" || positional.length === 0) await listIgnoreRules(root, { full: flags.list === "true" });
      else await addIgnorePattern(root, positional[0]!);
      break;
    }
    case "trash": {
      // Local trash tier (design 50 §2): list | restore <path> [--batch <name>] | empty.
      const root = await resolvePathFlagRoot(flags.path);
      const { trashCmd } = await import("./trash-cmd.js");
      await trashCmd(root, positional, flags);
      break;
    }
    case "connect": {
      // The canonical onboarding path accepts the short-lived, single-use token
      // in argv for one-shot setup. Bare `connect` retains masked prompt/stdin.
      if (positional.length > 1) throw new Error("usage: rbox connect [<pairing-token>] [--remote <url>]");
      const { readPairingTokenInteractive, redeemPair } = await (deps.authCommandImport ?? (() => import("./auth-cmd.js")))();
      const token = positional[0] ?? await readPairingTokenInteractive();
      if (!token) throw new Error("no pairing token provided (run `rbox pair` on a signed-in machine, then run the displayed `rbox connect <pairing-token>` command here)");
      await redeemPair(flags.remote ?? DEFAULT_REMOTE, token);
      break;
    }
    case "recover": {
      const { recoverWorkspaceCmd } = await import("./recover-cmd.js");
      await recoverWorkspaceCmd(positional[0], {
        yes: flags.yes === "true",
        repairChain: flags["repair-chain"] === "true",
        allowMassDelete: flags["allow-mass-delete"] === "true",
      });
      break;
    }
    case "versions": {
      // E2EE version history (design 12 §15 / D11): verified signed-commit chain +
      // per-epoch KEK decrypt, fail-closed — never the old plaintext manifestAt path.
      // `rbox versions [path]` — root is the current workspace; an optional
      // workspace-relative path scopes the listing to that file's change history.
      const { versionsCmd } = await import("./versions-cmd.js");
      let lim: number | undefined;
      if (flags.limit !== undefined) {
        lim = Number(flags.limit);
        if (flags.limit === "true" || !Number.isInteger(lim) || lim < 1) {
          fail("usage: rbox versions [path] [--limit <n>] [--json]");
          break;
        }
      }
      const root = await resolveRoot(undefined);
      // `.` / the workspace root means "the whole workspace" (full list), matching how
      // the other commands treat a bare directory arg; only a real subpath scopes.
      const pathArg = positional[0] === undefined || positional[0] === "." || path.resolve(positional[0]) === root ? undefined : positional[0];
      await versionsCmd(root, pathArg, lim, { json: jsonMode });
      break;
    }
    case "restore": {
      // `rbox restore <path>@<seq>` (design 12 §15 / D11): fetch + verify the commit
      // at <seq>, KEK-decrypt the manifest under its keyEpoch, decrypt the blob, and
      // atomically write the file. A restore, NOT a history rewrite. Fail-closed.
      const { restoreCmd } = await import("./versions-cmd.js");
      const spec = positional[0];
      if (!spec) throw new Error("usage: rbox restore <path>@<seq>  (e.g. rbox restore src/app.ts@3)");
      const root = await resolveRoot(undefined);
      await withWorkspaceSyncMutex(root, async () => restoreCmd(root, spec));
      break;
    }
    case "key": {
      const sub = positional[0];
      if (sub === "status") await keyStatus({ json: jsonMode });
      else if (sub === "save") await keySave(recoveryKitOptionsFromFlags({ ...flags, kit: "true" }), { json: rawJsonMode });
      else if (sub === "backup") await keyBackup(recoveryKitOptionsFromFlags(flags));
      else if (sub === "genesis") await keyGenesis(flags.yes === "true", recoveryKitOptionsFromFlags(flags));
      else if (sub === "recover") await recoverCmd(recoveryKitOptionsFromFlags(flags));
      else {
        const { createCiKey, materializeCmd, listKeys, revokeKey } = await import("./key-cmd.js");
        if (sub === "create-ci") await createCiKey(flags);
        else if (sub === "materialize") await materializeCmd(flags);
        else if (sub === "list") await listKeys({ json: jsonMode });
        else if (sub === "revoke") await revokeKey(positional[1] ?? "");
        else fail("usage: rbox key <status | save | backup | genesis --yes | recover | create-ci --expires <dur> | materialize | list | revoke <id>>");
      }
      break;
    }
    case "git": {
      const sub = positional[0];
      if (sub === "deferrals") {
        if (positional.length !== 1 || (flags.brief === "true" && jsonMode)) {
          fail("usage: rbox git deferrals [--brief | --json]");
          break;
        }
        const root = await resolveRoot(undefined);
        const { gitDeferralsCmd } = await import("./git-cmd.js");
        const code = await gitDeferralsCmd(root, { brief: flags.brief === "true", json: jsonMode }, { now: deps.now });
        if (code !== 0) process.exitCode = code;
        break;
      }
      if (sub === "republish") {
        const target = positional[1];
        if (!target || positional.length !== 2) {
          fail("usage: rbox git republish <repo> [--json]");
          break;
        }
        const root = await resolveRoot(target);
        const { gitRepublishCmd } = await import("./git-cmd.js");
        const code = await withWorkspaceSyncMutex(root, (syncMutex) =>
          gitRepublishCmd(root, target, syncMutex, { json: jsonMode }, { now: deps.now }));
        if (code !== 0) process.exitCode = code;
        break;
      }
      const repo = positional[1];
      const verb = positional[2] ?? "show-me";
      if (sub !== "resolve" || !repo || positional.length > 3 || !["show-me", "take-theirs", "keep-mine"].includes(verb)) {
        fail("usage: rbox git resolve <repo> [show-me|take-theirs|keep-mine] [--json] [--confirm <token>] [--force-discard-incoming]");
        break;
      }
      const root = await resolveRoot(repo);
      const { gitResolveCmd } = await import("./git-cmd.js");
      const code = await gitResolveCmd(root, repo, verb as "show-me" | "take-theirs" | "keep-mine", {
        json: jsonMode,
        confirm: flags.confirm,
        forceDiscardIncoming: flags["force-discard-incoming"] === "true",
      });
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "shell-init": {
      // design 46: print the zsh prompt integration + completions to stdout, for
      // `eval "$(rbox shell-init zsh)"` in .zshrc. Only zsh today (bash/fish use the
      // starship snippet in docs/shell-integration.md).
      if (positional[0] !== "zsh") {
        process.stderr.write("usage: rbox shell-init zsh\n(zsh only today — bash/fish users: see docs/shell-integration.md in the rbox repo for the prompt snippet)\n");
        process.exitCode = 1;
        break;
      }
      const { shellInitZsh } = await import("./shell-init.js");
      process.stdout.write(shellInitZsh());
      break;
    }
    case "completions": {
      // design 46: print the zsh completion script (generated from COMMAND_HELP).
      if (positional[0] !== "zsh") {
        process.stderr.write("usage: rbox completions zsh\n(zsh only today — bash/fish are not yet supported)\n");
        process.exitCode = 1;
        break;
      }
      const { zshCompletions } = await import("./completions.js");
      process.stdout.write(zshCompletions());
      break;
    }
    case "__daemon-run": {
      // Hidden: the actual in-process daemon loop (spawned detached by `start`).
      // Imported lazily so chokidar/the watcher load ONLY in the daemon process,
      // never on the hot `deps drift`/help paths that boot through this dispatcher.
      const { runDaemon } = await import("./daemon.js");
      const root = path.resolve(positional[0] ?? process.cwd());
      await runDaemon(root);
      break;
    }
    case BOOT_RESUME_MARKER: {
      // Hidden login resumer; launchd/systemd are not crash supervisors.
      await bootResume();
      break;
    }
    case "__watcher-selftest": {
      // Hidden: release-CI self-check (design §41 §6). Proves the native watcher loads
      // from THIS (compiled) binary on this OS/arch and delivers an event. Not in help.
      const { watcherSelfTest } = await import("./daemon/watcher-selftest.js");
      process.exit(await watcherSelfTest(positional[0]));
      break;
    }
    case "__git-refwatch-platform-selftest": {
      // Hidden release gate: Darwin must construct zero Linux ref side-channel handles.
      const { gitRefWatchPlatformSelfTest } = await import("./daemon/watcher-selftest.js");
      process.exit(await gitRefWatchPlatformSelfTest());
      break;
    }
    case "__crypto-smoke": {
      // Hidden: compiled-binary smoke for design 81. Proves worker-pool crypto actually
      // executes in this binary; inline fallback alone exits non-zero.
      const { cryptoSmoke } = await import("./crypto-smoke.js");
      const jobs = flags.jobs !== undefined ? Number(flags.jobs) : undefined;
      process.exit(await cryptoSmoke({ jobs }));
      break;
    }
    default:
      // Bare `rbox` in a terminal → status/actions when already inside a workspace,
      // otherwise the guided `setup` front door (design 29).
      // Non-interactive bare `rbox`, or an unknown command → the essential help
      // screen (never hangs). An unknown command also exits non-zero.
      if (!cmd && process.stdin.isTTY) {
        await runGuidedFrontDoor(deps.frontDoorImport);
        break;
      }
      console.log(renderEssentialHelp());
      if (cmd && !isKnownTopLevel(cmd)) process.exitCode = 1;
  }
}
