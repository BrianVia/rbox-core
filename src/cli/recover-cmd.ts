import { ManifestChainError, type Action } from "../engine/index.js";
import { findRoot, loadConfig } from "./config.js";
import { loadCredentials } from "./credentials.js";
import { keystorePinStore } from "./e2ee-keystore.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport } from "./metrics.js";
import { promptConfirm } from "./prompt.js";
import { RboxApi } from "./remote.js";
import { pull, push } from "./sync.js";
import { postSyncNudge, summarize } from "./sync-cmd.js";
import { style } from "./style.js";
import { withWorkspaceSyncMutex } from "./sync-mutex.js";
import { repairChain, type SuffixInfo } from "./chain-repair.js";

export interface RecoverOptions {
  yes?: boolean;
  allowMassDelete?: boolean;
  repairChain?: boolean;
}

export interface RecoverDeps {
  findRoot?: typeof findRoot;
  loadConfig?: typeof loadConfig;
  loadCredentials?: typeof loadCredentials;
  pinStore?: typeof keystorePinStore;
  buildAuthedRemote?: typeof buildAuthedRemote;
  pull?: typeof pull;
  push?: typeof push;
  confirm?: typeof promptConfirm;
  beginReport?: typeof beginReport;
  summarize?: typeof summarize;
  postSyncNudge?: typeof postSyncNudge;
  latestCommit?: typeof latestCommitHead;
  log?: (line: string) => void;
  repair?: typeof repairChain;
  chainProbe?: (remote: Awaited<ReturnType<typeof buildAuthedRemote>>["remote"]) => Promise<void>;
}

function count(actions: Action[], kind: Action["kind"]): number {
  return actions.filter((a) => a.kind === kind).length;
}

export async function recoverWorkspaceCmd(pathArg: string | undefined, opts: RecoverOptions = {}, deps: RecoverDeps = {}): Promise<void> {
  const root = await (deps.findRoot ?? findRoot)(pathArg ?? process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run `rbox setup` to get started, or `rbox track <path>` to bind a directory.");
  if (!opts.yes) {
    const ok = await (deps.confirm ?? promptConfirm)({
      message: `Recover ${root}? This clears the local verified-head pin, pulls the server head, reconciles files, then pushes remaining local diffs.`,
      default: false,
    });
    if (!ok) {
      (deps.log ?? console.log)("recover cancelled");
      return;
    }
  }

  await withWorkspaceSyncMutex(root, async (syncMutex) => {
    const cfg0 = await (deps.loadConfig ?? loadConfig)(root);
    const creds = await (deps.loadCredentials ?? loadCredentials)();
    if (!creds?.accountId) throw new Error("not logged in — run `rbox login`");
    const pins = (deps.pinStore ?? keystorePinStore)(creds.accountId, cfg0.remoteWorkspaceId);
    const pin = await pins.load();
    if (pin) {
      const remoteUrl = creds.remoteUrl ?? cfg0.remoteUrl;
      const { sequence } = await (deps.latestCommit ?? latestCommitHead)(remoteUrl, creds.token, cfg0.remoteWorkspaceId, cfg0.projectId);
      if (sequence < pin.commitSeq) {
        throw new Error(`recover refused: server head sequence ${sequence} is below the local verified pin ${pin.commitSeq} (rollback evident)`);
      }
    }
    const built = await (deps.buildAuthedRemote ?? buildAuthedRemote)(root);
    built.deps.syncMutex = syncMutex;
    built.deps.allowMassDelete = opts.allowMassDelete === true;
    const report = (deps.beginReport ?? beginReport)("sync");
    built.deps.report = report;
    let pulled: Action[];
    try {
      // Retain the verified pin while proving the current head is chain-readable.
      // A chain failure must enter repair with that broken-head pin intact.
      await (deps.chainProbe ?? (async (remote) => { await remote.latest(); }))(built.remote);
      // NOTE(84): §4.3 the successful legacy recovery ceremony still clears the
      // pin before its re-baseline pull; full retained-pin re-verification remains.
      await pins.clear();
      pulled = await (deps.pull ?? pull)(root, built.cfg, built.deps);
    } catch (error) {
      if (!(error instanceof ManifestChainError)) throw error;
      const repairPin = await pins.load();
      if (!error.head || !repairPin || repairPin.commitSeq !== error.head.seq || repairPin.commitHash !== error.head.hash) {
        throw new Error("recover refused chain repair: verified broken-head pin is missing or inconsistent");
      }
      const confirmSupersede = async (suffix: SuffixInfo[]): Promise<boolean> => {
        const describe = suffix.map((item) => `${item.seq}:${item.deviceId}`).join(", ");
        (deps.log ?? console.log)(`chain repair would supersede verified suffix ${describe} — ${suffix[0]?.reason ?? error.reason}`);
        if (opts.yes || opts.repairChain) return true;
        return (deps.confirm ?? promptConfirm)({
          message: `Repair the manifest chain by superseding ${suffix.length} unreadable commit(s)?`,
          default: false,
        });
      };
      const outcome = await (deps.repair ?? repairChain)(root, built.cfg, built.deps, error, { confirmSupersede });
      if (outcome.kind === "declined") {
        (deps.log ?? console.log)("recover cancelled");
        return;
      }
      if (outcome.kind === "repaired") {
        (deps.log ?? console.log)(`${style.bold("recover")}: manifest chain repaired at sequence ${style.cyan(String(outcome.sequence))}`);
        return;
      }
      // A peer published a readable head during our repair attempt. Apply it
      // normally before the ceremony's ordinary push continuation.
      pulled = await (deps.pull ?? pull)(root, built.cfg, built.deps);
    }
    (deps.summarize ?? summarize)("pulled", pulled, root);
    await (deps.postSyncNudge ?? postSyncNudge)(root, pulled, built.cfg);

    const pushed = await (deps.push ?? push)(root, built.cfg, built.deps);
    (deps.log ?? console.log)(
      pushed.committed
        ? `${style.bold("pushed")} ${style.sym.arrow} sequence ${style.cyan(String(pushed.sequence))}`
        : `${style.bold("push")}: already in sync ${style.dim(`(sequence ${pushed.sequence})`)}`
    );
    report?.logSummaryTo((l) => (deps.log ?? console.log)(style.dim(l)));
    (deps.log ?? console.log)(
      `${style.bold("recover")}: pin cleared, ${count(pulled, "write")} pulled, ${count(pulled, "delete")} trashed/deleted, ${count(pulled, "conflict")} keep-both conflict(s)`
    );
  });
}

async function latestCommitHead(remoteUrl: string, token: string, workspaceId: string, projectId: string): Promise<{ sequence: number }> {
  return new RboxApi(remoteUrl, token, workspaceId, projectId).latestCommit();
}
