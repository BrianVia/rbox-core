import path from "node:path";
import { type Action } from "../engine/index.js";
import { progressLabel } from "./status-view.js";
import { findRoot, type WorkspaceConfig } from "./config.js";
import { pull, push, sync } from "./sync.js";
import { beginReport } from "./metrics.js";
import { DEFAULT_LOG_LINES, logsDaemon } from "./daemon-control.js";
import { autostartCmd, bootResume, BOOT_RESUME_MARKER, startDaemonAndRecordDesired, stopDaemonAndRecordDesired } from "./autostart-cmd.js";
import { addIgnorePattern, listIgnoreRules } from "./ignore-cmd.js";
import { approveDevice, keyBackup, keyGenesis, keyStatus, listDevices, login, logout, recoverCmd, revokeDevice } from "./auth-cmd.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { PROD_REMOTE } from "./credentials.js";
import { fail, setJsonErrorMode, style } from "./style.js";
import { spinner } from "./spinner.js";
import { resolveAlias } from "./deprecations.js";
import { isKnownTopLevel } from "./command-catalog.js";
import { commandSupportsFlag, helpFor, helpKeyFor, renderCommand, renderGroupedHelp } from "./help-registry.js";
import { recoveryKitOptionsFromFlags } from "./recovery-kit.js";
import { maybeNudgeForUpdate } from "./update-check.js";
import { parseFlags } from "./flags.js";

const DEFAULT_REMOTE = process.env.RBOX_API ?? PROD_REMOTE;

/** Print per-command help (or the grouped screen) and nothing else. Stdout, exit 0. */
function printHelp(cmd: string | undefined, positional: string[]): void {
  if (!cmd) {
    console.log(renderGroupedHelp());
    return;
  }
  const entries = helpFor(helpKeyFor(cmd, positional));
  console.log(entries ? entries.map(renderCommand).join("\n\n") : renderGroupedHelp());
}

// `rbox deps <sub>` group dispatch — commented out (design 51): the whole `deps`
// CLI surface (install/list/check/drift/notify, plus the old hydrate/detect
// aliases in deprecations.ts and their entries in help-registry.ts) is disabled
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

/** Post-sync drift nudge: if a pull/sync wrote a changed lockfile, print the
 *  one-line drift notice (design 29). Best-effort — never breaks a sync. */
async function postSyncNudge(root: string, actions: Action[], cfg: WorkspaceConfig): Promise<void> {
  if (cfg.noDrift || process.env.RBOX_NO_DRIFT === "1") return;
  const written = actions.filter((a): a is Extract<Action, { kind: "write" }> => a.kind === "write").map((a) => a.entry.path);
  if (written.length === 0) return;
  try {
    const { nudgeForWrittenPaths, renderNotices } = await import("./deps-drift.js");
    const notices = await nudgeForWrittenPaths(root, written);
    if (notices.length) process.stderr.write(`${renderNotices(notices)}\n`);
  } catch {
    /* nudge is advisory; a failure here must not fail the sync */
  }
}

async function resolveRoot(arg: string | undefined): Promise<string> {
  const root = await findRoot(arg ? path.resolve(arg) : process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run `rbox track <path>` first.");
  return root;
}

async function resolvePathFlagRoot(arg: string | undefined): Promise<string> {
  const root = await findRoot(arg ? path.resolve(arg) : process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run from the workspace, or pass --path <dir>.");
  return root;
}

async function main(): Promise<void> {
  let [cmd] = process.argv.slice(2) as [string | undefined];
  const rest = process.argv.slice(3);
  const parsed = parseFlags(rest);
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
    printHelp(positional[0], positional.slice(1));
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
  setJsonErrorMode(jsonMode);
  if (rawJsonMode && !jsonMode) flags.json = "false";

  if (!rawJsonMode && cmd !== "status" && cmd !== "upgrade" && cmd !== "help" && cmd !== "__daemon-run" && cmd !== BOOT_RESUME_MARKER) {
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
      await runSetup({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE });
      break;
    }
    case "track": {
      const { track, printTrackResult } = await import("./track-cmd.js");
      printTrackResult(await track(positional[0], flags, DEFAULT_REMOTE));
      break;
    }
    case "untrack": {
      const root = await resolveRoot(positional[0]);
      const { untrack } = await import("./untrack-cmd.js");
      await untrack({
        root,
        force: flags.force === "true",
        confirm: async () => {
          if (process.stdin.isTTY !== true) return true; // non-interactive → proceed
          const { promptConfirm } = await import("./prompt.js");
          return promptConfirm({ message: `Stop syncing ${root}? Local files stay.`, default: false });
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
      await login(flags.remote ?? DEFAULT_REMOTE, flags.bootstrap, flags.plan, recoveryKitOptionsFromFlags(flags));
      break;
    }
    case "logout": {
      await logout();
      break;
    }
    case "pair": {
      const { pairCreate } = await import("./auth-cmd.js");
      await pairCreate();
      break;
    }
    case "upgrade": {
      const { upgradeCmd } = await import("./upgrade-cmd.js");
      await upgradeCmd(flags.remote ?? DEFAULT_REMOTE, { check: flags.check === "true" });
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
      await subscribe(positional[0]);
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
      const sp = spinner("pushing");
      try {
        const { cfg, deps } = await buildAuthedRemote(root);
        deps.onProgress = (done, total, phase, detail) => sp.update(progressLabel(phase, done, total, detail));
        // Push-side consent (design 50 §4, review B2): op-scoped — NEVER the pull-side
        // `allowMassDelete`, which the 409-recovery pull inside pushManifest would inherit.
        deps.allowMassDeletePush = flags["allow-mass-delete"] === "true";
        const report = beginReport("push");
        deps.report = report;
        const { sequence: seq, committed } = await push(root, cfg, deps);
        sp.succeed(
          committed
            ? `pushed ${style.dim(root)} ${style.sym.arrow} sequence ${style.cyan(String(seq))}`
            : `already in sync — nothing to upload ${style.dim(`(sequence ${seq})`)}`
        );
        report?.logSummaryTo((l) => console.log(style.dim(l)));
      } catch (e) {
        sp.fail("push failed");
        throw e;
      }
      break;
    }
    case "pull": {
      const root = await resolveRoot(positional[0]);
      const sp = spinner("pulling");
      try {
        const { cfg, deps } = await buildAuthedRemote(root);
        deps.onProgress = (done, total, phase, detail) => sp.update(progressLabel(phase, done, total, detail));
        deps.allowMassDelete = flags["allow-mass-delete"] === "true";
        const report = beginReport("pull");
        deps.report = report;
        const actions = await pull(root, cfg, deps);
        sp.stop();
        summarize("pulled", actions, root);
        report?.logSummaryTo((l) => console.log(style.dim(l)));
        await postSyncNudge(root, actions, cfg);
      } catch (e) {
        sp.fail("pull failed");
        throw e;
      }
      break;
    }
    case "sync": {
      const root = await resolveRoot(positional[0]);
      const sp = spinner("syncing");
      try {
        const { cfg, deps } = await buildAuthedRemote(root);
        deps.onProgress = (done, total, phase, detail) => sp.update(progressLabel(phase, done, total, detail));
        deps.allowMassDelete = flags["allow-mass-delete"] === "true";
        const report = beginReport("sync");
        deps.report = report;
        const { pulled, pushedSequence, pushCommitted } = await sync(root, cfg, deps);
        sp.stop();
        summarize("pulled", pulled, root);
        console.log(
          pushCommitted
            ? `${style.bold("pushed")} ${style.sym.arrow} sequence ${style.cyan(String(pushedSequence))}`
            : `${style.bold("push")}: already in sync ${style.dim(`(sequence ${pushedSequence})`)}`
        );
        report?.logSummaryTo((l) => console.log(style.dim(l)));
        await postSyncNudge(root, pulled, cfg);
      } catch (e) {
        sp.fail("sync failed");
        throw e;
      }
      break;
    }
    case "export": {
      const { runExport } = await import("./export-cmd.js");
      await runExport(flags);
      break;
    }
    case "status": {
      if (positional.length > 1) {
        fail("usage: rbox status [path] [--json]");
        break;
      }
      const root = await resolveRoot(positional[0]);
      const { statusCmd } = await import("./status-cmd.js");
      await statusCmd(root, { json: jsonMode });
      break;
    }
    case "doctor": {
      const report = flags.report === "true";
      const diagnostics = flags.diagnostics === "true";
      const { doctorCmd, refuseDisabledDiagnosticsUpload } = await import("./doctor-cmd.js");
      if (refuseDisabledDiagnosticsUpload({ report, diagnostics })) break;
      const root = await resolveRoot(undefined);
      await doctorCmd(root, { report, yes: flags.yes === "true", diagnostics });
      break;
    }
    case "start": {
      await startDaemonAndRecordDesired(await resolveRoot(positional[0]));
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
      if (flags.list === "true" || positional.length === 0) listIgnoreRules(root);
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
      // Enroll this machine from a pairing token read on STDIN (never argv, C11):
      //   rbox pair        # on a signed-in machine → prints the token
      //   echo <token> | rbox connect
      const { redeemPair } = await import("./auth-cmd.js");
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      const token = Buffer.concat(chunks).toString("utf8").trim();
      if (!token) throw new Error("no pairing token on stdin (pipe the token from `rbox pair`)");
      await redeemPair(flags.remote ?? DEFAULT_REMOTE, token);
      break;
    }
    case "recover": {
      await recoverCmd(recoveryKitOptionsFromFlags(flags));
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
      await restoreCmd(root, spec);
      break;
    }
    case "key": {
      if (positional[0] === "status") await keyStatus({ json: jsonMode });
      else if (positional[0] === "backup") await keyBackup(recoveryKitOptionsFromFlags(flags));
      else if (positional[0] === "genesis") await keyGenesis(flags.yes === "true", recoveryKitOptionsFromFlags(flags));
      else {
        fail("usage: rbox key <status | backup | genesis --yes> [--kit] [--kit-path <path>]");
      }
      break;
    }
    case "shell-init": {
      // design 46: print the zsh prompt integration + completions to stdout, for
      // `eval "$(rbox shell-init zsh)"` in .zshrc. Only zsh today (bash/fish use the
      // starship snippet in docs/shell-integration.md).
      if (positional[0] !== "zsh") {
        process.stderr.write("usage: rbox shell-init zsh\n");
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
        process.stderr.write("usage: rbox completions zsh\n");
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
      const { watcherSelfTest } = await import("./watcher-selftest.js");
      process.exit(await watcherSelfTest(positional[0]));
      break;
    }
    default:
      // Bare `rbox` in a terminal → the guided `setup` front door (design 29).
      // Non-interactive bare `rbox`, or an unknown command → the grouped help
      // screen (never hangs). An unknown command also exits non-zero.
      if (!cmd && process.stdin.isTTY) {
        const { runSetup } = await import("./setup-cmd.js");
        await runSetup({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE });
        break;
      }
      console.log(renderGroupedHelp());
      if (cmd && !isKnownTopLevel(cmd)) process.exitCode = 1;
  }
}

function summarize(label: string, actions: { kind: string; path?: string; keepLocalAs?: string }[], _root: string): void {
  const writes = actions.filter((a) => a.kind === "write").length;
  const deletes = actions.filter((a) => a.kind === "delete").length;
  const conflicts = actions.filter((a) => a.kind === "conflict");
  const conflictPart = conflicts.length ? style.red(`${conflicts.length} conflict(s)`) : style.dim("0 conflict(s)");
  console.log(`${style.bold(label)}: ${style.green(`${writes} written`)}, ${deletes} deleted, ${conflictPart}`);
  for (const c of conflicts) console.log(`  ${style.sym.warn} conflict: ${style.yellow(c.path ?? "?")} ${style.dim(`(local kept as ${c.keepLocalAs})`)}`);
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
