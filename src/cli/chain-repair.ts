import { ManifestChainError, type Action, type Manifest } from "../engine/index.js";
import { loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { E2eeRemote } from "./e2ee-remote.js";
import { assertSyncMutex } from "./sync-mutex.js";
import { applyPulledManifest, pushManifest, scanManifestForPush, type SyncDeps } from "./sync.js";

export interface SuffixInfo { seq: number; deviceId: string; reason: string }
export type RepairOutcome =
  | { kind: "repaired"; sequence: number; suffix: SuffixInfo[]; actions: Action[] }
  | { kind: "converged"; sequence: number; suffix: SuffixInfo[]; actions: Action[] }
  | { kind: "declined"; suffix: SuffixInfo[]; actions: Action[] };

const REPAIR_MAX_ATTEMPTS = 5;

function repairRemote(deps: SyncDeps): E2eeRemote {
  if (!(deps.remote instanceof E2eeRemote)) throw new Error("chain repair requires the authenticated E2EE remote");
  return deps.remote;
}

async function describeSuffix(remote: E2eeRemote, applied: number, error: ManifestChainError): Promise<SuffixInfo[]> {
  return (await remote.verifiedSuffix(applied)).map(({ seq, deviceId }) => ({ seq, deviceId, reason: error.reason }));
}

export async function repairChain(
  root: string,
  cfg: WorkspaceConfig,
  deps: SyncDeps,
  error: ManifestChainError,
  opts: { confirmSupersede: (suffix: SuffixInfo[]) => Promise<boolean> }
): Promise<RepairOutcome> {
  // Design 93 §6 disposition: repair always runs under the CALLER's held sync
  // mutex (daemon iteration / recover ceremony) — inherited via deps, asserted
  // here, never re-acquired.
  if (deps.syncMutex) assertSyncMutex(deps.syncMutex, root);
  const remote = repairRemote(deps);
  const originalApplied = (await loadState(root, syncStreamId(cfg))).lastSyncedSequence;
  const detected = await describeSuffix(remote, originalApplied, error);
  const detectedHead = detected.at(-1)?.seq ?? error.head?.seq ?? originalApplied;
  // §3.6.3 convergence probe: a peer may have published a READABLE head between
  // detection and this call (repaired first, or advanced past the break with a
  // decodable commit) — repair must never supersede readable data. If the
  // current verified head decodes, report convergence (the caller re-pulls and
  // resumes normal sync). Races AFTER this probe are closed by the 409 →
  // re-verify branch below; a head that still fails to decode falls through.
  try {
    const readable = await remote.latest();
    return { kind: "converged", sequence: readable.sequence, suffix: detected, actions: [] };
  } catch (probeError) {
    if (!(probeError instanceof ManifestChainError)) throw probeError;
  }
  let actions: Action[] = [];
  for (let seq = detectedHead - 1; seq > originalApplied; seq--) {
    try {
      const historical = await remote.manifestAtSeq(seq);
      actions = await applyPulledManifest(root, cfg, deps, remote, {
        sequence: seq,
        manifest: historical.manifest,
        kek: historical.kek,
        keyEpoch: historical.keyEpoch,
      });
      break;
    } catch (candidateError) {
      if (candidateError instanceof ManifestChainError) continue;
      throw candidateError;
    }
  }
  const applied = (await loadState(root, syncStreamId(cfg))).lastSyncedSequence;
  let suffix = await describeSuffix(remote, applied, error);
  if (!(await opts.confirmSupersede(suffix))) return { kind: "declined", suffix, actions };

  // Each publication has its own bounded 422/epoch retry budget in pushManifest;
  // repair 409s return immediately, so this outer budget is the sole 409-race bound.
  for (let attempt = 0; attempt < REPAIR_MAX_ATTEMPTS; attempt++) {
    const pin = await remote.loadVerifiedPin();
    if (!pin) throw new Error("chain repair has no verified head pin");
    const local: Manifest = await scanManifestForPush(root, cfg, deps);
    const pushed = await pushManifest(root, cfg, local, deps, 0, false, undefined, { kind: "repair", parentSequence: pin.commitSeq });
    if (!pushed.repairConflict) return { kind: "repaired", sequence: pushed.sequence, suffix, actions };
    if (attempt + 1 >= REPAIR_MAX_ATTEMPTS) throw new Error("repair: remote head kept advancing during publication");
    try {
      const latest = await remote.latest();
      return { kind: "converged", sequence: latest.sequence, suffix, actions };
    } catch (nextError) {
      if (!(nextError instanceof ManifestChainError)) throw nextError;
      suffix = await describeSuffix(remote, applied, nextError);
      if (!(await opts.confirmSupersede(suffix))) return { kind: "declined", suffix, actions };
    }
  }
  throw new Error("repair: exhausted retry budget");
}
