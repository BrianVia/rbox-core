import type { SyncState } from "../../../src/cli/sync-state-model.js";
import type { Device } from "./device.js";

export interface DeviceStateAuthority {
  readonly format: "absent" | "authority-marker" | "json" | "foreign";
  readonly authorityId?: string;
  readonly originKind?: "genesis" | "migration";
  readonly entryCount?: number;
  readonly repoCount?: number;
}

/**
 * Observe the durable authority through the product classifier. For SQLite, also
 * read the completion witness through the validated store handle so the rig proves
 * genesis provenance rather than treating the presence of Q as sufficient.
 */
export async function readDeviceStateAuthority(
  device: Device,
  root: string,
): Promise<DeviceStateAuthority> {
  const script = `import { classifyStateFormat } from '/app/src/cli/state-plane/authority-marker.ts';
import { selectStateAuthority } from '/app/src/cli/state-plane/authority-bootstrap.ts';
import { sqliteResetPaths, statePath } from '/app/src/cli/state-plane/paths.ts';
import { openStateStore, stateStoreDatabase } from '/app/src/cli/state-plane/store/open.ts';
const root = process.argv[1];
const format = await classifyStateFormat(statePath(root));
if (format !== 'authority-marker') {
  process.stdout.write(JSON.stringify({ format }));
} else {
  const selection = await selectStateAuthority(root);
  if (selection.kind !== 'sqlite-store') throw new Error('authority marker did not select SQLite');
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    const completion = stateStoreDatabase(store).query(
      'SELECT origin_kind,entry_count,repo_count FROM migration_completion WHERE singleton=1',
    ).get();
    if (!completion) throw new Error('SQLite authority has no completion witness');
    process.stdout.write(JSON.stringify({
      format,
      authorityId: selection.authorityId,
      originKind: completion.origin_kind,
      entryCount: completion.entry_count,
      repoCount: completion.repo_count,
    }));
  } finally {
    store.close();
  }
}`;
  const result = await device.exec(["bun", "-e", script, root]);
  return JSON.parse(result.stdout) as DeviceStateAuthority;
}

/**
 * Install the old authority shape after bind-only `track`, before any sync entry
 * can admit genesis. This is a rig fixture, not a product hook: it uses the
 * existing explicit compatibility/test writer and refuses to replace any state.
 */
export async function installLegacyJsonStateFixture(device: Device, root: string): Promise<void> {
  const script = `import { loadConfig, syncStreamId } from '/app/src/cli/workspace-config.ts';
import { classifyStateFormat } from '/app/src/cli/state-plane/authority-marker.ts';
import { statePath } from '/app/src/cli/state-plane/paths.ts';
import { saveStateUnsafeLegacyOrTest } from '/app/src/cli/sync-state-store.ts';
const root = process.argv[1];
const before = await classifyStateFormat(statePath(root));
if (before !== 'absent') throw new Error('legacy fixture requires absent state, found ' + before);
const config = await loadConfig(root);
await saveStateUnsafeLegacyOrTest(root, {
  stream: syncStreamId(config),
  lastSyncedSequence: 0,
  lastSyncedManifest: { generatedAt: '', files: [] },
});
const after = await classifyStateFormat(statePath(root));
if (after !== 'json') throw new Error('legacy fixture did not publish JSON authority');`;
  await device.exec(["bun", "-e", script, root]);
}

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
