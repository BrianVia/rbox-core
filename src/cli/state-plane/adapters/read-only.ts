import type { Manifest } from "../../../engine/index.js";
import {
  type GlobalManifestMeta, type RepoRecord, type SyncState,
} from "../../sync-state-model.js";
import {
  stateFromRepoRecords, stripObsoleteResolutionIntents,
} from "../../sync-state-records.js";
import { canonicalJson } from "../digest/codecs.js";
import { SnapshotChangedError } from "../errors.js";
import type {
  LineageSnapshot, MaterializeManifestRequest, Plane, ReadSnapshot,
} from "../ports.js";
import { openReadSnapshot } from "../store/read-snapshot.js";
import type { StateStoreHandle } from "../store/open.js";

function collectGit(snapshot: ReadSnapshot, role: "meta-wire" | "manifest-projection"): GlobalManifestMeta["gitRepos"] {
  const result: GlobalManifestMeta["gitRepos"] = {};
  let after: string | undefined;
  for (;;) {
    const page = role === "meta-wire"
      ? snapshot.metaGitRepoCursor(after, 16)
      : snapshot.manifestGitRepoCursor(after, 16);
    for (const row of page.rows) result[row.relPath] = row.section;
    if (page.done) break;
    after = page.after;
  }
  return result;
}

function materializeManifest(snapshot: ReadSnapshot, plane: Plane): Manifest {
  const files = [];
  let after: string | undefined;
  for (;;) {
    const page = snapshot.files(plane, after, 512);
    files.push(...page.rows);
    if (page.done) break;
    after = page.after;
  }
  const header = plane === "base" ? snapshot.token.baseHeader : snapshot.token.localHeader;
  const gitRepos = plane === "base" ? collectGit(snapshot, "manifest-projection") : {};
  const manifest = {
    ...Object.fromEntries(Object.entries(header).filter(([key]) =>
      !["complete", "sourceSequence", "trustEpoch"].includes(key))),
    generatedAt: header.generatedAt,
    files,
  } as Manifest;
  if (header.manifestSchema !== undefined) manifest.manifestSchema = header.manifestSchema;
  if (plane === "base" && (snapshot.token.manifestGitReposPresent || Object.keys(gitRepos).length)) {
    manifest.gitRepos = gitRepos;
  }
  return manifest;
}

function manifestMeta(snapshot: ReadSnapshot): GlobalManifestMeta | undefined {
  const core = snapshot.token.manifestMeta;
  if (!core) return undefined;
  const chain: string[] = [];
  let after: number | undefined;
  for (;;) {
    const page = snapshot.manifestChainCursor(after, 512);
    for (const row of page.rows) chain.push(row.encSha);
    if (page.done) break;
    after = Number(page.after);
  }
  return {
    ...core,
    chain,
    gitRepos: collectGit(snapshot, "meta-wire"),
  } as GlobalManifestMeta;
}

/** Drop the members a projection left explicitly `undefined`. An optional member
 * that is absent and one that is present-but-undefined are the same value to
 * this type, so the record's own type survives the filter. */
function withoutUndefinedMembers<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

export function loadRawStateFromStore(store: StateStoreHandle): SyncState {
  const guard = openReadSnapshot(store);
  const token = guard.token;
  const records: Record<string, RepoRecord> = {};
  let after: string | undefined;
  for (;;) {
    const page = guard.repos(after, 16);
    for (const row of page.rows) records[row.relPath] = row.record;
    if (page.done) break;
    after = page.after;
  }
  const meta = manifestMeta(guard);
  // Members are appended in the legacy document's own order; the optional ones
  // stay absent rather than present-and-undefined.
  const base: SyncState = {
    ...token.lineageExtras,
    stream: token.stream,
    lastSyncedSequence: token.lastSyncedSequence,
    lastSyncedManifest: materializeManifest(guard, "base"),
  };
  if (meta) base.manifestMeta = meta;
  if (token.nonce !== undefined) base.stateNonce = token.nonce;
  if (token.stateRevision !== undefined) base.stateRevision = token.stateRevision;
  if (token.telemetryBindingId !== undefined) base.telemetryBindingId = token.telemetryBindingId;
  base.repoRecords = records;
  const normalized = stripObsoleteResolutionIntents(stateFromRepoRecords(base, records));
  const cleanManifest = withoutUndefinedMembers<Manifest>(normalized.lastSyncedManifest);
  const cleanState = withoutUndefinedMembers<SyncState>({ ...normalized, lastSyncedManifest: cleanManifest });
  const result = token.manifestGitReposPresent && cleanState.lastSyncedManifest.gitRepos === undefined
    ? { ...cleanState, lastSyncedManifest: { ...cleanState.lastSyncedManifest, gitRepos: {} } }
    : cleanState;
  // Nothing assembled above is publishable until one final fresh assertion
  // proves that every nested short projection belonged to this token.
  guard.finishProjection();
  return result;
}

export function materializeManifestFromStore(
  store: StateStoreHandle,
  request: MaterializeManifestRequest,
): Manifest {
  if (request.purpose !== "wire-snapshot" && request.purpose !== "wire-delta") {
    throw new TypeError("materializeManifest purpose must be wire-snapshot or wire-delta");
  }
  const snapshot = openReadSnapshot(store);
  if (canonicalJson(snapshot.token) !== canonicalJson(request.projectionToken)) throw new SnapshotChangedError();
  const manifest = materializeManifest(snapshot, request.plane);
  snapshot.finishProjection();
  return manifest;
}
