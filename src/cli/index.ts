import crypto from "node:crypto";
import path from "node:path";
import { scanManifest } from "../engine/index.js";
import { findRoot, loadAuthedConfig, loadConfig, loadState, saveConfig, type WorkspaceConfig } from "./config.js";
import { pull, push, sync } from "./sync.js";
import { runDaemon } from "./daemon.js";
import { logsDaemon, startDaemon, statusDaemon, stopDaemon } from "./daemon-control.js";
import { addIgnorePattern, listIgnoreRules } from "./ignore-cmd.js";
import { approveDevice, listDevices, login, logout, revokeDevice } from "./auth-cmd.js";
import { encryptWorkspace, exportKey, importKey } from "./crypto-cmd.js";
import { listVersions, restoreVersion } from "./versions-cmd.js";
import { style } from "./style.js";
import { spinner } from "./spinner.js";

const DEFAULT_REMOTE = process.env.RBOX_API ?? "https://rbox-dev-api.brian-via.workers.dev";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      flags[a.slice(2)] = args[i + 1] && !args[i + 1]!.startsWith("--") ? args[++i]! : "true";
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

async function resolveRoot(arg: string | undefined): Promise<string> {
  const root = await findRoot(arg ? path.resolve(arg) : process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run `rbox link <path>` first.");
  return root;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (cmd) {
    case "init": {
      const { runInit } = await import("./init-cmd.js");
      await runInit(flags, { cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE });
      break;
    }
    case "detect": {
      // Hydration works on any directory — it does not require a linked workspace.
      const { detectCmd } = await import("./hydrate-cmd.js");
      await detectCmd(path.resolve(positional[0] ?? process.cwd()), flags.manager);
      break;
    }
    case "doctor": {
      const { doctorCmd } = await import("./hydrate-cmd.js");
      await doctorCmd(path.resolve(positional[0] ?? process.cwd()));
      break;
    }
    case "hydrate": {
      const { hydrateCmd } = await import("./hydrate-cmd.js");
      await hydrateCmd(path.resolve(positional[0] ?? process.cwd()), {
        allowBuild: flags["allow-build"] === "true",
        manager: flags.manager,
        only: flags.only,
      });
      break;
    }
    case "link": {
      const root = path.resolve(positional[0] ?? process.cwd());
      const remoteUrl = flags.remote ?? DEFAULT_REMOTE;
      const projectId = flags.project ?? "root";
      // New workspace → create it server-side (ownership at creation, M7). Joining
      // an existing one (--workspace) requires the caller's account to own it.
      let workspaceId = flags.workspace;
      if (!workspaceId) {
        const { loadCredentials } = await import("./credentials.js");
        const { createRemoteWorkspace } = await import("./remote.js");
        const creds = await loadCredentials();
        if (!creds) throw new Error("run `rbox login` before creating a workspace");
        workspaceId = await createRemoteWorkspace(remoteUrl, creds.token, projectId);
      }
      const cfg: WorkspaceConfig = {
        remoteWorkspaceId: workspaceId,
        projectId,
        deviceId: flags.device ?? `dev_${crypto.randomUUID().slice(0, 8)}`,
        rootPath: root,
        remoteUrl,
        token: "", // token comes from `rbox login` (per-machine credential), never config
        syncGit: flags.git === "true",
      };
      await saveConfig(root, cfg);
      console.log(`linked ${root}`);
      console.log(`  workspace: ${cfg.remoteWorkspaceId}`);
      console.log(`  device:    ${cfg.deviceId}`);
      console.log(`  remote:    ${cfg.remoteUrl}`);
      if (cfg.syncGit) console.log(`  git-sync:  on (opt-in)`);
      console.log(`\nLink another machine with:\n  rbox link <path> --workspace ${cfg.remoteWorkspaceId}`);
      break;
    }
    case "login": {
      await login(flags.remote ?? DEFAULT_REMOTE, flags.bootstrap === "true" ? undefined : flags.bootstrap);
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
    case "device": {
      const sub = positional[0];
      if (sub === "approve") await approveDevice(positional[1] ?? "");
      else if (sub === "list") await listDevices();
      else if (sub === "revoke") await revokeDevice(positional[1] ?? "");
      else {
        console.log("usage: rbox device <approve <user-code>|list|revoke <device-id>>");
        process.exitCode = 1;
      }
      break;
    }
    case "push": {
      const root = await resolveRoot(positional[0]);
      const sp = spinner("pushing");
      try {
        const seq = await push(root, await loadAuthedConfig(root));
        sp.succeed(`pushed ${style.dim(root)} ${style.sym.arrow} sequence ${style.cyan(String(seq))}`);
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
        const actions = await pull(root, await loadAuthedConfig(root));
        sp.stop();
        summarize("pulled", actions, root);
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
        const { pulled, pushedSequence } = await sync(root, await loadAuthedConfig(root));
        sp.stop();
        summarize("pulled", pulled, root);
        console.log(`${style.bold("pushed")} ${style.sym.arrow} sequence ${style.cyan(String(pushedSequence))}`);
      } catch (e) {
        sp.fail("sync failed");
        throw e;
      }
      break;
    }
    case "status": {
      const root = await resolveRoot(positional[0]);
      const cfg = await loadConfig(root);
      const state = await loadState(root);
      const local = await scanManifest(root);
      console.log(`${style.bold("workspace")} ${style.cyan(cfg.remoteWorkspaceId)} ${style.dim("@")} ${root}`);
      console.log(`  ${style.dim("device:")} ${cfg.deviceId}`);
      console.log(`  ${style.dim("last-synced sequence:")} ${state.lastSyncedSequence}`);
      console.log(`  ${style.dim("local files:")} ${local.files.length}`);
      if (cfg.syncGit) {
        const { gitPreflight } = await import("../engine/index.js");
        const pf = await gitPreflight(root);
        console.log(`  ${style.dim("git-sync:")} ${pf.ok ? style.green("on (eligible)") : style.yellow(`on but skipped — ${pf.reason}`)}`);
      }
      const { loadMetrics } = await import("./metrics.js");
      const m = await loadMetrics(root);
      if (m.syncs > 0 || m.commitConflicts409 > 0 || m.fileConflicts > 0) {
        const conf = m.commitConflicts409 + m.fileConflicts;
        console.log(
          `  ${style.dim("sync metrics:")} ${m.syncs} syncs, ${conf ? style.yellow(`${m.commitConflicts409} commit-409 / ${m.fileConflicts} file-conflict`) : style.green("0 conflicts")}${m.lastConflictAt ? style.dim(` (last ${m.lastConflictAt})`) : ""}`
        );
      }
      break;
    }
    case "daemon": {
      const sub = positional[0];
      const root = await resolveRoot(positional[1]);
      if (sub === "start") await startDaemon(root);
      else if (sub === "stop") await stopDaemon(root);
      else if (sub === "status") await statusDaemon(root);
      else if (sub === "logs") await logsDaemon(root, flags.follow === "true" || flags.f === "true");
      else {
        console.log("usage: rbox daemon <start|stop|status|logs> [path] [--follow]");
        process.exitCode = 1;
      }
      break;
    }
    case "ignore": {
      const root = await resolveRoot(flags.path);
      if (flags.list === "true" || positional.length === 0) listIgnoreRules(root);
      else await addIgnorePattern(root, positional[0]!);
      break;
    }
    case "versions": {
      const root = await resolveRoot(flags.path);
      await listVersions(await loadAuthedConfig(root), positional[0]);
      break;
    }
    case "restore": {
      const root = await resolveRoot(flags.path);
      const arg = positional[0] ?? "";
      const at = arg.lastIndexOf("@");
      if (at < 1) {
        console.log("usage: rbox restore <path>@<seq>");
        process.exitCode = 1;
        break;
      }
      await restoreVersion(root, await loadAuthedConfig(root), arg.slice(0, at), Number(arg.slice(at + 1)));
      break;
    }
    case "encrypt": {
      await encryptWorkspace(await resolveRoot(positional[0]));
      break;
    }
    case "key": {
      const root = await resolveRoot(flags.path); // run inside the workspace
      if (positional[0] === "export") await exportKey(root);
      else if (positional[0] === "import") await importKey(root, positional[1] ?? "");
      else {
        console.log("usage (inside the workspace): rbox key <export | import <recovery-phrase>>");
        process.exitCode = 1;
      }
      break;
    }
    case "__daemon-run": {
      // Hidden: the actual in-process daemon loop (spawned detached by `daemon start`).
      const root = path.resolve(positional[0] ?? process.cwd());
      await runDaemon(root);
      break;
    }
    default:
      // Bare `rbox` in a terminal → the guided onboarding menu (setup / connect /
      // log in). Non-interactive or `rbox help` → the command list (never hangs).
      if (!cmd && process.stdin.isTTY) {
        const { runMenu } = await import("./menu-cmd.js");
        await runMenu({ cwd: process.cwd(), defaultRemote: DEFAULT_REMOTE });
        break;
      }
      console.log(`rbox — dev-aware sync\n\nCommands:\n  ${style.bold("init")} [--new|--workspace <id>]     guided first-time setup (--no-interactive for CI)\n  login [--bootstrap <secret>]     authorize this device\n  pair                             make a token to connect a new machine\n  device <approve|list|revoke>     manage devices\n  link <path> [--workspace <id>]   bind a directory to a workspace\n  push [path]                      upload local changes\n  pull [path]                      apply remote changes\n  sync [path]                      pull then push\n  status [path]                    show workspace state\n  ignore <glob> | --list           manage .rboxignore\n  daemon <start|stop|status|logs>  passive continuous sync\n  detect [path]                    list hydratable projects (lockfiles)\n  doctor [path]                    check host readiness to hydrate\n  hydrate [path] [--allow-build]   reconstruct deps from synced lockfiles`);
      if (cmd && cmd !== "help") process.exitCode = 1;
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
  console.error(`rbox: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
