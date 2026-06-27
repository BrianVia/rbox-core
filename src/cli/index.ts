import crypto from "node:crypto";
import path from "node:path";
import { scanManifest } from "../engine/index.js";
import { findRoot, loadConfig, loadState, saveConfig, type WorkspaceConfig } from "./config.js";
import { pull, push, sync } from "./sync.js";
import { runDaemon } from "./daemon.js";
import { logsDaemon, startDaemon, statusDaemon, stopDaemon } from "./daemon-control.js";

const DEFAULT_REMOTE = process.env.RBOX_API ?? "https://rbox-dev-api.brian-via.workers.dev";
const DEFAULT_TOKEN = process.env.RBOX_TOKEN ?? "rbox-dev-7f3a9c2e8b1d4a60";

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
        token: flags.token ?? DEFAULT_TOKEN,
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
    case "push": {
      const root = await resolveRoot(positional[0]);
      const seq = await push(root, await loadConfig(root));
      console.log(`pushed ${root} -> sequence ${seq}`);
      break;
    }
    case "pull": {
      const root = await resolveRoot(positional[0]);
      const actions = await pull(root, await loadConfig(root));
      summarize("pulled", actions, root);
      break;
    }
    case "sync": {
      const root = await resolveRoot(positional[0]);
      const { pulled, pushedSequence } = await sync(root, await loadConfig(root));
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
    case "__daemon-run": {
      // Hidden: the actual in-process daemon loop (spawned detached by `daemon start`).
      const root = path.resolve(positional[0] ?? process.cwd());
      await runDaemon(root);
      break;
    }
    default:
      console.log("rbox — dev-aware sync\n\nCommands:\n  link <path> [--workspace <id>]   bind a directory to a workspace\n  push [path]                      upload local changes\n  pull [path]                      apply remote changes\n  sync [path]                      pull then push\n  status [path]                    show workspace state\n  daemon <start|stop|status|logs>  passive continuous sync");
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
