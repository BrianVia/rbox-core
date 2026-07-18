import { ManifestChainError, type Action } from "../engine/index.js";
import { findRoot, loadConfig } from "./config.js";
import { credentialsForStrictFlow, loadCredentials } from "./credentials.js";
import { keystorePinStore } from "./e2ee-keystore.js";
import { buildAuthedRemote } from "./e2ee-client.js";
import { beginReport } from "./metrics.js";
import { promptConfirm } from "./prompt.js";
import { NeedsRebaselineError } from "./remote.js";
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
  log?: (line: string) => void;
  repair?: typeof repairChain;
}

function count(actions: Action[], kind: Action["kind"]): number {
  return actions.filter((a) => a.kind === kind).length;
}

export async function recoverWorkspaceCmd(pathArg: string | undefined, opts: RecoverOptions = {}, deps: RecoverDeps = {}): Promise<void> {
  const root = await (deps.findRoot ?? findRoot)(pathArg ?? process.cwd());
  if (!root) throw new Error("Not inside an rbox workspace. Run `rbox setup` to get started, or `rbox track <path>` to bind a directory.");
  if (!opts.yes) {
    const ok = await (deps.confirm ?? promptConfirm)({
      message: `Recover ${root}? This re-verifies the server head against the retained local pin, reconciles files, then pushes remaining local diffs.`,
      default: false,
    });
    if (!ok) {
      (deps.log ?? console.log)("recover cancelled");
      return;
    }
  }

  // Strict credential policy precedes sync-mutex acquisition (a local mutation).
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const creds = credentialsForStrictFlow(loaded);
  if (!creds?.accountId) throw new Error("not logged in — run `rbox login`");
  const accountId = creds.accountId;

  await withWorkspaceSyncMutex(root, async (syncMutex) => {
    const cfg0 = await (deps.loadConfig ?? loadConfig)(root);
    const pins = (deps.pinStore ?? keystorePinStore)(accountId, cfg0.remoteWorkspaceId);
    const built = await (deps.buildAuthedRemote ?? buildAuthedRemote)(root, Date.now, undefined, loaded);
    built.deps.syncMutex = syncMutex;
    built.deps.allowMassDelete = opts.allowMassDelete === true;
    // recover both pulls AND repair-publishes; one explicit flag covers both directions
    // (same pattern as `rbox sync --allow-mass-delete`). Env consent maps push-side only,
    // mirroring the other CLI entry points.
    built.deps.allowMassDeletePush = opts.allowMassDelete === true || process.env.RBOX_ALLOW_MASS_DELETE === "1";
    const report = (deps.beginReport ?? beginReport)("sync");
    built.deps.report = report;
    let pulled: Action[];
    try {
      try {
        // The normal path verifies forward from the retained pin. A successful
        // pull needs no ceremony and must not manipulate the pin separately.
        pulled = await (deps.pull ?? pull)(root, built.cfg, built.deps);
      } catch (error) {
        if (!(error instanceof NeedsRebaselineError)) throw error;
        // Pruning is the sole continuity-skipping ceremony: E2eeRemote verifies
        // /latest plus the longest retained segment and atomically overwrites the
        // still-present prior pin only after its floor/equivocation check passes.
        await built.remote.rebaselinePinToRetainedHead();
        pulled = await (deps.pull ?? pull)(root, built.cfg, built.deps);
      }
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
      `${style.bold("recover")}: head re-verified, ${count(pulled, "write")} pulled, ${count(pulled, "delete")} trashed/deleted, ${count(pulled, "conflict")} keep-both conflict(s)`
    );
  });
}
