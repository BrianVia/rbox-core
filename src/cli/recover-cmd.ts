import { type Action } from "../engine/index.js";
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

export interface RecoverOptions {
  yes?: boolean;
  allowMassDelete?: boolean;
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
}

function count(actions: Action[], kind: Action["kind"]): number {
  return actions.filter((a) => a.kind === kind).length;
}

export async function recoverWorkspaceCmd(pathArg: string | undefined, opts: RecoverOptions = {}, deps: RecoverDeps = {}): Promise<void> {
  const root = await (deps.findRoot ?? findRoot)(pathArg ?? process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run `rbox track <path>` first.");
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
  await pins.clear();

  const built = await (deps.buildAuthedRemote ?? buildAuthedRemote)(root);
  built.deps.allowMassDelete = opts.allowMassDelete === true;
  const report = (deps.beginReport ?? beginReport)("sync");
  built.deps.report = report;
  const pulled = await (deps.pull ?? pull)(root, built.cfg, built.deps);
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
}

async function latestCommitHead(remoteUrl: string, token: string, workspaceId: string, projectId: string): Promise<{ sequence: number }> {
  return new RboxApi(remoteUrl, token, workspaceId, projectId).latestCommit();
}
