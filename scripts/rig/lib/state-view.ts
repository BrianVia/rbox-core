import type { SyncState } from "../../../src/cli/sync-state-model.js";
import type { Device } from "./device.js";

/** Read logical state through the product adapter; state.json may contain JSON or Q. */
export async function readDeviceSyncState(device: Device, root: string): Promise<SyncState> {
  const script = `import { loadRawState } from '/app/src/cli/sync-state-store.ts';
const state = await loadRawState(process.argv[1]);
if (!state) throw new Error('workspace has no durable sync state');
process.stdout.write(JSON.stringify(state));`;
  const result = await device.exec(["bun", "-e", script, root]);
  return JSON.parse(result.stdout) as SyncState;
}

/** Age one durable apply deferral through the normal state generation CAS. */
export async function ageDeviceApplyDeferral(
  device: Device,
  root: string,
  relPath: string,
  agedAt: string,
): Promise<void> {
  const script = `import { applyStateSavePacket, loadRawState } from '/app/src/cli/sync-state-store.ts';
import { expectedStateNonce, repoRecordsForState } from '/app/src/cli/sync-state-model.ts';
import { requireRepoBaseProof } from '/app/src/cli/sync-git/base-proof-selection.ts';
const [root, relPath, agedAt] = process.argv.slice(1);
const state = await loadRawState(root);
if (!state || !state.stream) throw new Error('workspace has no durable sync state');
const record = repoRecordsForState(state)[relPath];
const apply = record?.deferrals?.apply;
if (!record || !apply) throw new Error('repository has no durable apply deferral');
const next = { ...record, deferrals: { ...record.deferrals, apply: { ...apply, deferredSince: agedAt, reasonSince: agedAt } } };
const { repoGen, ...newRecord } = next;
const baseProof = requireRepoBaseProof(relPath, undefined, record, next);
const result = await applyStateSavePacket(root, {
  expectedStream: state.stream,
  expectedNonce: expectedStateNonce(state),
  sourceGlobalSeq: record.sourceSeq,
  repos: [{ relPath, expectedRepoGen: repoGen, newRecord, baseProof }],
});
if (result.status !== 'accepted') throw new Error('deferral aging CAS failed: ' + result.status);`;
  await device.exec(["bun", "-e", script, root, relPath, agedAt]);
}
