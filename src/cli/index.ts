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
    case "link": {
      const root = path.resolve(positional[0] ?? process.cwd());
      const cfg: WorkspaceConfig = {
        remoteWorkspaceId: flags.workspace ?? `ws_${crypto.randomUUID().slice(0, 12)}`,
        projectId: flags.project ?? "root",
        deviceId: flags.device ?? `dev_${crypto.randomUUID().slice(0, 8)}`,
        rootPath: root,
        remoteUrl: flags.remote ?? DEFAULT_REMOTE,
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
      const seq = await push(root, await loadAuthedConfig(root));
      console.log(`pushed ${root} -> sequence ${seq}`);
      break;
    }
    case "pull": {
      const root = await resolveRoot(positional[0]);
      const actions = await pull(root, await loadAuthedConfig(root));
      summarize("pulled", actions, root);
      break;
    }
    case "sync": {
      const root = await resolveRoot(positional[0]);
      const { pulled, pushedSequence } = await sync(root, await loadAuthedConfig(root));
      summarize("pulled", pulled, root);
      console.log(`pushed -> sequence ${pushedSequence}`);
      break;
    }
    case "status": {
      const root = await resolveRoot(positional[0]);
      const cfg = await loadConfig(root);
      const state = await loadState(root);
      const local = await scanManifest(root);
      console.log(`workspace ${cfg.remoteWorkspaceId} @ ${root}`);
      console.log(`  device: ${cfg.deviceId}`);
      console.log(`  last-synced sequence: ${state.lastSyncedSequence}`);
      console.log(`  local files: ${local.files.length}`);
      if (cfg.syncGit) {
        const { gitPreflight } = await import("../engine/index.js");
        const pf = await gitPreflight(root);
        console.log(`  git-sync: ${pf.ok ? "on (eligible)" : `on but skipped — ${pf.reason}`}`);
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
      console.log("rbox — dev-aware sync\n\nCommands:\n  login [--bootstrap <secret>]     authorize this device\n  device <approve|list|revoke>     manage devices\n  link <path> [--workspace <id>]   bind a directory to a workspace\n  push [path]                      upload local changes\n  pull [path]                      apply remote changes\n  sync [path]                      pull then push\n  status [path]                    show workspace state\n  ignore <glob> | --list           manage .rboxignore\n  daemon <start|stop|status|logs>  passive continuous sync");
      if (cmd && cmd !== "help") process.exitCode = 1;
  }
}

function summarize(label: string, actions: { kind: string; path?: string; keepLocalAs?: string }[], _root: string): void {
  const writes = actions.filter((a) => a.kind === "write").length;
  const deletes = actions.filter((a) => a.kind === "delete").length;
  const conflicts = actions.filter((a) => a.kind === "conflict");
  console.log(`${label}: ${writes} written, ${deletes} deleted, ${conflicts.length} conflict(s)`);
  for (const c of conflicts) console.log(`  conflict: ${c.path} (local kept as ${c.keepLocalAs})`);
}

main().catch((e) => {
  console.error(`rbox: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
