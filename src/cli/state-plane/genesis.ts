/**
 * Genesis (design 222 §2, ratified in 163 v12): SQLite authority for a workspace
 * that has none. Its durable witness, `.rbox/state/genesis-v1.json`, is written
 * before SQLite opens anything and retired last, after `Q`. It is the sole
 * source of `authorityId` and `lineageId` on every resume, and both paths this
 * attempt may own derive from `authorityId`, so it names no deletion target.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../../engine/fsutil.js";
import { assertHealthyOwnedSyncMutex } from "../sync-mutex.js";
import { loadConfigIfPresent, syncStreamId } from "../workspace-config.js";
import { AUTHORITY_MARKER_BYTES, authorityMarkerBytes, classifyStateFormat } from "./authority-marker.js";
import { StateAuthorityCorruptError } from "./errors.js";
import { readGenesisIntent, type FencedEvidence, type GenesisIntent } from "./genesis-intent.js";
import type { HeldStatePlaneLocks } from "./locks.js";
import { genesisPaths, migrationPaths, stateIncarnationPath, statePath, sqliteResetPaths } from "./paths.js";
import { installGenesisLineage } from "./schema/application.js";
import { SQLITE_SIDECARS as SIDECARS } from "./store/artifact-proof.js";
import {
  adoptClaimedStateStore,
  openStateStore,
  openStateStoreForWalTakeover,
  stateStoreDatabase,
  type ClaimedInode,
} from "./store/open.js";
import { selectRow } from "./store/statements.js";

/** The intent's shape, decode, and bounded reader live in `genesis-intent.ts`,
 * which reaches no SQLite: the write fence reads the intent on every save and
 * may not be able to open a database (163 v13). */
export { readGenesisIntent, type FencedEvidence, type GenesisIntent };

/** The two ids the intent publishes before the database exists. */
export interface GenesisIds { authorityId: string; lineageId: string }

export type GenesisRefusal = "legacy-present" | "artifact-present" | "evidence-missing";

export type GenesisOutcome =
  | { kind: "established"; authorityId: string }
  | { kind: "already-established" }
  | { kind: "refused"; reason: GenesisRefusal };

export interface GenesisInspection { readonly claims: boolean; readonly intent?: GenesisIntent }

/** Fault-observation seam, as `writeFileAtomic`'s `onStep` is. */
export interface GenesisFaults { afterQPrepared?: () => Promise<void> }

const CREATED_BY = "genesis-v1";
const REBUILD = Symbol("genesis-rebuild");

/** Does this workspace belong to genesis? Read-only; the caller owns the
 * migration control's absence. */
export async function inspect(root: string, locks: HeldStatePlaneLocks): Promise<GenesisInspection> {
  const intent = readGenesisIntent(root);
  if (intent) return { claims: true, intent };
  const legacy = await classifyStateFormat(statePath(root));
  return { claims: legacy === "absent" && inodeOf(sqliteResetPaths.active(root)) === undefined };
}

/** Establish SQLite authority on a workspace that has none. `mintIds` is called
 * at most once, and only when there is nothing to resume. */
export async function establish(
  root: string, mintIds: () => GenesisIds, locks: HeldStatePlaneLocks, faults: GenesisFaults = {},
): Promise<GenesisOutcome> {
  const resuming = readGenesisIntent(root);
  let evidence: FencedEvidence;
  if (resuming) {
    const resumed = await resume(root, resuming, locks, faults);
    if (resumed !== REBUILD) return resumed;
    evidence = resuming.evidence;
  } else {
    const eligible = await eligibility(root);
    if ("refusal" in eligible) return { kind: "refused", reason: eligible.refusal };
    evidence = eligible.evidence;
  }
  const ids = mintIds();
  const staging = await claimStagedPath(root, ids.authorityId);
  const intent: GenesisIntent = { version: 1, ...ids, evidence, staging };
  await publishIntent(root, intent);
  buildStagedStore(root, intent);
  return placeAndPublish(root, intent, locks, faults);
}

/** Step 1. Nothing is mutated on any branch. */
async function eligibility(root: string): Promise<{ refusal: GenesisRefusal } | { evidence: FencedEvidence }> {
  const legacy = await classifyStateFormat(statePath(root));
  if (legacy === "json") return { refusal: "legacy-present" };
  if (legacy !== "absent") return { refusal: "artifact-present" };
  // One expression, no body: genesis names the control only to stat it, and
  // `control.test.ts` pins this exact statement. Wave 2B's coordinator (§1.3)
  // already decides genesis-vs-migration on the control, so when it lands this
  // observation moves there and the sole-writer gate goes back to unconditional.
  if ([sqliteResetPaths.active(root), migrationPaths.control(root)].some(inodeOf)) {
    return { refusal: "artifact-present" };
  }
  const evidence = await liveEvidence(root);
  return evidence ? { evidence } : { refusal: "evidence-missing" };
}

/** The seven crash images of §2.5.2. The intent supplies both ids; case 4 is
 * the one image with nothing to resume, and it returns to `establish`. */
async function resume(
  root: string, intent: GenesisIntent, locks: HeldStatePlaneLocks, faults: GenesisFaults,
): Promise<GenesisOutcome | typeof REBUILD> {
  const live = await liveEvidence(root);
  // Case 7, before case 5: a copied or moved `.rbox` must not reach a removal.
  if (!live || evidenceKey(live) !== evidenceKey(intent.evidence)) {
    throw corrupt(root, "the recorded genesis evidence is not this workspace's");
  }
  const active = sqliteResetPaths.active(root);
  const legacy = await classifyStateFormat(statePath(root));
  if (legacy === "authority-marker") {                                            // case 1
    if (!(await holdsMarkerFor(statePath(root), intent.authorityId))) throw corrupt(root, "a foreign authority marker is published");
    if (!isFinishedGenesis(active, intent, live)) throw corrupt(root, "the published authority has no matching genesis database");
    await sealAtRest(active);
    await fsyncDirectory(rboxDir(root));
    await removeOwnQSibling(root, intent);
    await retireIntent(root);
    return { kind: "already-established" };
  }
  if (legacy === "json") return legacyPresent(root, intent, live);                // case 5
  if (legacy !== "absent") throw corrupt(root, "an unrecognized file holds the authority path");
  if (inodeOf(active)) {                                                          // case 2, else case 6
    if (!isFinishedGenesis(active, intent, live)) throw corrupt(root, "an unrecorded database holds the active path");
    await sealAtRest(active);
    return finishWithQ(root, intent, locks, faults);
  }
  const staged = genesisPaths.staged(root, intent.authorityId);
  const found = inodeOf(staged);
  if (!found) return REBUILD;                                                     // case 4
  if (!sameInode(found, intent.staging)) throw corrupt(root, "a foreign file holds the staged genesis path");
  if (!isFinishedGenesis(staged, intent, live)) {                                 // case 3, unopenable
    await truncateRecordedInode(staged, intent.staging);
    buildStagedStore(root, intent);
  }
  return placeAndPublish(root, intent, locks, faults);                             // case 3, clean
}

/** Step 2. A crash here leaves a zero-byte file no record names; nothing sweeps it. */
async function claimStagedPath(root: string, authorityId: string): Promise<ClaimedInode> {
  const file = genesisPaths.staged(root, authorityId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const claimed = await withFile(file, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O.O_NOFOLLOW, async (handle) => {
    await handle.sync();
    const stat = await handle.stat();
    return { dev: stat.dev, ino: stat.ino };
  });
  await fsyncDirectory(path.dirname(file));
  return claimed;
}

/** Step 3. Only now may SQLite open anything. Publishing over a superseded
 * intent is one rename, so case 4 needs no second file. */
async function publishIntent(root: string, intent: GenesisIntent): Promise<void> {
  await writeFileAtomic(genesisPaths.intent(root), JSON.stringify(intent), { mode: 0o600, exactMode: true });
  await fsyncDirectory(sqliteResetPaths.stateRoot(root));
}

/** Step 4. The installed lineage comes from the intent, never from a caller. */
function buildStagedStore(root: string, intent: GenesisIntent): void {
  adoptClaimedStateStore(
    genesisPaths.staged(root, intent.authorityId),
    intent.staging,
    (db) => installGenesisLineage(db, {
      stream: intent.evidence.stream,
      authorityId: intent.authorityId,
      lineageId: intent.lineageId,
      createdBy: CREATED_BY,
    }),
  ).close();
}

/** Steps 5 through 7. */
async function placeAndPublish(
  root: string, intent: GenesisIntent, locks: HeldStatePlaneLocks, faults: GenesisFaults,
): Promise<GenesisOutcome> {
  const staged = genesisPaths.staged(root, intent.authorityId);
  await sealAtRest(staged);
  await fsp.rename(staged, sqliteResetPaths.active(root));
  await fsyncDirectory(sqliteResetPaths.stateRoot(root));
  return finishWithQ(root, intent, locks, faults);
}

async function finishWithQ(
  root: string, intent: GenesisIntent, locks: HeldStatePlaneLocks, faults: GenesisFaults,
): Promise<GenesisOutcome> {
  const sibling = genesisPaths.qSibling(root, intent.authorityId);
  await writeAuthorityMarker(sibling, intent.authorityId);                        // step 6
  await faults.afterQPrepared?.();
  const live = await liveEvidence(root);                                          // step 7
  if (!live || evidenceKey(live) !== evidenceKey(intent.evidence)) {
    throw corrupt(root, "this workspace's evidence changed while genesis was running");
  }
  await assertHealthyOwnedSyncMutex(locks.mutex, root);
  if (!await locks.stateLock.isOwner()) throw new Error("genesis publication refused: state lock ownership was lost");
  // The literal final operation before the rename, with nothing between them.
  // Each format gets `resume`'s answer, not one collapsed refusal: only `"json"`
  // is a legacy workspace. A marker or a foreign artifact appearing here would
  // make `legacyPresent` delete the database step 5 just placed.
  const holder = await classifyStateFormat(statePath(root));
  if (holder === "json") return legacyPresent(root, intent, live);
  if (holder !== "absent") throw corrupt(root, "an unrecognized file holds the authority path");
  await fsp.rename(sibling, statePath(root));
  await fsyncDirectory(rboxDir(root));
  await retireIntent(root);
  return { kind: "established", authorityId: intent.authorityId };
}

/** Case 5. JSON is authority; only artifacts confirmed to be ours are removed. */
async function legacyPresent(root: string, intent: GenesisIntent, live: FencedEvidence): Promise<GenesisOutcome> {
  await removeOwnArtifacts(root, intent, live);
  await retireIntent(root);
  return { kind: "refused", reason: "legacy-present" };
}

/** All eight rows of §2.5.1. Every value checked was published by the intent
 * before the database existed — that is what closes the `dev`/`ino` reuse
 * hazard. Cheapest first: the two file-level rows decide every halt image but
 * C2's recycled inode, so nothing else is ever opened. This predicate alone
 * authorizes removing the active path, hence it carries evidence itself. */
function isFinishedGenesis(file: string, intent: GenesisIntent, live: FencedEvidence): boolean {
  if (evidenceKey(live) !== evidenceKey(intent.evidence)) return false;
  if (!sameInode(inodeOf(file), intent.staging)) return false;
  return withoutOwnSidecars(file, () => {
    let store;
    try {
      store = openStateStore(file, { readonly: true });
    } catch {
      return false;
    }
    try {
      const row = selectRow<{ origin_kind: string; migration_id: string; entry_count: number; repo_count: number }>(
        stateStoreDatabase(store),
        "SELECT origin_kind,migration_id,entry_count,repo_count FROM migration_completion WHERE singleton=1",
      );
      return store.header.authority_id === intent.authorityId
        && store.header.active_lineage_id === intent.lineageId
        && row?.origin_kind === "genesis"
        && row.migration_id === `genesis:${intent.lineageId}`
        && row.entry_count === 0
        && row.repo_count === 0;
    } catch {
      return false;
    } finally {
      store.close();
    }
  });
}

/** A read-only open creates `-wal`/`-shm` and, unlike a read-write one, cannot
 * remove them — so §2.5.1 is a zero-write halt only if the open undoes exactly
 * what it created. Never a pre-existing sidecar: that discards unreplayed
 * frames. Sound only under §3.1's single-opener window. */
function withoutOwnSidecars<T>(file: string, run: () => T): T {
  const before = SIDECARS.filter((suffix) => inodeOf(`${file}${suffix}`));
  try {
    return run();
  } finally {
    for (const s of SIDECARS) if (!before.includes(s)) fs.rmSync(`${file}${s}`, { force: true });
  }
}

/** Recover, checkpoint, validate, close, require `S0`, fsync file and parent. */
async function sealAtRest(file: string): Promise<void> {
  openStateStoreForWalTakeover(file).close();
  for (const suffix of SIDECARS) {
    if (inodeOf(`${file}${suffix}`)) throw new Error(`state database did not come to rest: ${file}${suffix} remains`);
  }
  await withFile(file, O.O_RDONLY | O.O_NOFOLLOW, (handle) => handle.sync());
  await fsyncDirectory(path.dirname(file));
}

/** Case 3's repair: truncate in place so the inode survives and the next crash
 * reads case 3 again rather than case 6. This destroys what the active path
 * would only halt over; the whole margin is that the staged path is scoped to
 * this attempt's `authorityId`, so any later producer under `.rbox/state/` must
 * stay outside that scope. */
async function truncateRecordedInode(file: string, recorded: ClaimedInode): Promise<void> {
  await withFile(file, O.O_WRONLY | O.O_NOFOLLOW, async (handle) => {
    const opened = await handle.stat();
    if (!sameInode({ dev: opened.dev, ino: opened.ino }, recorded)) throw new Error("staged genesis path changed identity");
    await handle.truncate(0);
    await handle.sync();
  });
  for (const suffix of SIDECARS) await fsp.rm(`${file}${suffix}`, { force: true });
}

/** Owned, not discovered: the sibling is rewritten from offset zero. */
async function writeAuthorityMarker(file: string, authorityId: string): Promise<void> {
  const bytes = authorityMarkerBytes(authorityId);
  await withFile(file, O.O_CREAT | O.O_WRONLY | O.O_NOFOLLOW, async (handle) => {
    await handle.write(bytes, 0, bytes.byteLength, 0);
    await handle.truncate(bytes.byteLength);
    await handle.sync();
  });
  await fsyncDirectory(path.dirname(file));
}

/** Bounded recognition: one no-follow descriptor, at most one byte past the
 * marker, so a huge or foreign file at the path is refused, never loaded. */
async function holdsMarkerFor(file: string, id: string): Promise<boolean> {
  const expected = authorityMarkerBytes(id);
  const buffer = Buffer.alloc(AUTHORITY_MARKER_BYTES + 1);
  return withFile(file, O.O_RDONLY | O.O_NOFOLLOW, async (handle) => {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return bytesRead === AUTHORITY_MARKER_BYTES && expected.equals(buffer.subarray(0, bytesRead));
  }).catch(() => false);
}

/** Only paths whose identity is confirmed. The active path is not
 * attempt-scoped, so only the full §2.5.1 conjunction authorizes removing it. */
async function removeOwnArtifacts(root: string, intent: GenesisIntent, live: FencedEvidence): Promise<void> {
  const staged = genesisPaths.staged(root, intent.authorityId);
  if (sameInode(inodeOf(staged), intent.staging)) {
    for (const suffix of ["", ...SIDECARS]) await fsp.rm(`${staged}${suffix}`, { force: true });
  }
  const active = sqliteResetPaths.active(root);
  if (isFinishedGenesis(active, intent, live)) {
    for (const suffix of ["", ...SIDECARS]) await fsp.rm(`${active}${suffix}`, { force: true });
  }
  await removeOwnQSibling(root, intent);
  await fsyncDirectory(sqliteResetPaths.stateRoot(root));
}

async function removeOwnQSibling(root: string, intent: GenesisIntent): Promise<void> {
  const sibling = genesisPaths.qSibling(root, intent.authorityId);
  if (!(await holdsMarkerFor(sibling, intent.authorityId))) return;
  await fsp.rm(sibling, { force: true });
  await fsyncDirectory(rboxDir(root));
}

async function retireIntent(root: string): Promise<void> {
  await fsp.rm(genesisPaths.intent(root), { force: true });
  await fsyncDirectory(sqliteResetPaths.stateRoot(root));
}

async function liveEvidence(root: string): Promise<FencedEvidence | undefined> {
  const config = await loadConfigIfPresent(root);
  if (!config) return undefined;
  // realpath, not resolve: the same workspace reached through a symlinked parent
  // must bind one key, or a healthy workspace halts as case 7 forever.
  return { root: await fsp.realpath(root), stream: syncStreamId(config), incarnation: await incarnationIdentity(root) };
}

async function incarnationIdentity(root: string): Promise<FencedEvidence["incarnation"]> {
  try {
    return await withFile(stateIncarnationPath(root), O.O_RDONLY | O.O_NOFOLLOW, async (handle) => {
      const stat = await handle.stat();
      const sha256 = createHash("sha256").update(await handle.readFile()).digest("hex");
      return { dev: stat.dev, ino: stat.ino, sha256 };
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "absent";
    throw error;
  }
}

async function withFile<T>(file: string, flags: number, run: (handle: fsp.FileHandle) => Promise<T>): Promise<T> {
  const handle = await fsp.open(file, flags, 0o600);
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
}

function evidenceKey(evidence: FencedEvidence): string {
  const incarnation = evidence.incarnation;
  return JSON.stringify([
    evidence.root,
    evidence.stream,
    incarnation === "absent" ? "absent" : [incarnation.dev, incarnation.ino, incarnation.sha256],
  ]);
}

const O = fs.constants;

function rboxDir(root: string): string {
  return path.dirname(sqliteResetPaths.stateRoot(root));
}

function corrupt(root: string, detail: string): StateAuthorityCorruptError {
  return new StateAuthorityCorruptError(statePath(root), detail);
}

function inodeOf(file: string): ClaimedInode | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat && { dev: stat.dev, ino: stat.ino };
}

function sameInode(found: ClaimedInode | undefined, expected: ClaimedInode): boolean {
  return found?.dev === expected.dev && found.ino === expected.ino;
}
