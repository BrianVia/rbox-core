import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertStateReadable } from "./state-plane/authority-marker.js";
import { canonicalize } from "../engine/e2ee/jcs.js";
import type { JsonObject, JsonValue } from "../json.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { boundedCopy, boundedHash, boundedJsonRead, boundedRead, RESET_STREAM_BYTE_LIMIT } from "./reset-io.js";
import { observeResetJournalBytes } from "./reset-journal.js";
import {
  decodeResetJournal,
  resetJournalFileSource,
  type DecodeResetJournalResult,
} from "./reset-journal-codec.js";
import { RESET_JOURNAL_BYTE_LIMIT } from "./reset-journal-codec.js";

const HEX64 = /^[0-9a-f]{64}$/;
const BUNDLE_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{16}$/;
const MANIFEST_CAP = 256 * 1024;
const COMMIT_CAP = 16 * 1024;
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;

export type ResetQuarantineArtifactKind = "journal" | "candidate" | "archive";

export interface ResetQuarantineArtifactInput {
  kind: ResetQuarantineArtifactKind;
  absolutePath: string;
  /** Archives are durable lineage provenance and are always preserved. */
  cleanup: "remove-exact" | "preserve";
}

export interface ResetQuarantinePlan {
  scope: "journal-only" | "transaction";
  phase: string;
  activeStateSha256?: string;
  recoveredStateSha256?: string;
  markerPrecondition: string;
  refPreconditions: string;
  artifacts: ResetQuarantineArtifactInput[];
}

type QuarantineArtifact = {
  kind: ResetQuarantineArtifactKind;
  original: string;
  bundled: string;
  cleanup: "remove-exact" | "preserve";
  sha256: string;
  bytes: number;
};

type ResetQuarantineManifestBaseV1 = {
  v: 1;
  id: string;
  createdAt: string;
  scope: "journal-only" | "transaction";
  phase: string;
  activeStateSha256?: string;
  recoveredStateSha256?: string;
  markerPrecondition: string;
  refPreconditions: string;
  artifacts: QuarantineArtifact[];
};
export type LegacyResetQuarantineManifestV1 = ResetQuarantineManifestBaseV1 & {
  stateFormat?: never;
  decodedCandidateSha256?: never;
  decodedCandidateBytes?: never;
};
export type SQLiteResetQuarantineManifestV1 = ResetQuarantineManifestBaseV1 & {
  stateFormat: "sqlite/v1";
  decodedCandidateSha256: string;
  decodedCandidateBytes: number;
};
export type ResetQuarantineManifestV1 =
  | LegacyResetQuarantineManifestV1
  | SQLiteResetQuarantineManifestV1;

type ResetQuarantineCommitV1 = {
  v: 1;
  manifestSha256: string;
  inventorySha256: string;
};

export interface ResetQuarantineHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
}

export const resetQuarantineRoot = (root: string): string => path.join(root, ".rbox", "state", "quarantine");
export async function inspectResetJournalForQuarantine(file: string): Promise<DecodeResetJournalResult> {
  return decodeResetJournal(await resetJournalFileSource(file));
}
const manifestPath = (bundle: string): string => path.join(bundle, "manifest.json");
const committedPath = (bundle: string): string => path.join(bundle, "COMMITTED");
/** Exactly what this module canonicalizes: decoded JSON, or a manifest whose
 * absent-only `never` members keep the legacy variant outside `JsonValue`. */
type CanonicalRecord = JsonValue | ResetQuarantineManifestV1;
const canonicalBytes = (value: CanonicalRecord): Buffer => Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);
const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const safeRelative = (root: string, absolute: string): string => {
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`reset quarantine artifact escapes workspace: ${absolute}`);
  const normalized = relative.split(path.sep).join("/");
  if (!normalized.startsWith(".rbox/state/")) throw new Error(`reset quarantine artifact is outside .rbox/state: ${absolute}`);
  if (normalized.startsWith(".rbox/state/quarantine/")) throw new Error("reset quarantine cannot archive its own bundle");
  return normalized;
};
const absoluteOriginal = (root: string, relative: string): string => {
  if (!relative.startsWith(".rbox/state/") || relative.includes("\0") || relative.split("/").includes("..")) throw new Error("reset quarantine manifest contains an unsafe original path");
  return path.join(root, ...relative.split("/"));
};
const absoluteBundled = (bundle: string, relative: string): string => {
  if (!/^artifacts\/[0-9]+-(journal|candidate|archive)$/.test(relative)) throw new Error("reset quarantine manifest contains an unsafe bundle path");
  return path.join(bundle, ...relative.split("/"));
};

async function durableAtomic(file: string, bytes: Uint8Array): Promise<void> {
  await writeFileAtomic(file, bytes, { mode: 0o600 });
  await fsyncDirectory(path.dirname(file));
}

async function publishCommitRecord(file: string, bytes: Uint8Array, hooks: ResetQuarantineHooks): Promise<void> {
  const parent = path.dirname(file);
  const tmp = path.join(parent, `.rbox-tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}-COMMITTED`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let renamed = false;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await hooks.crashAt?.("after-commit-temp-fsync");
    await fs.rename(tmp, file);
    renamed = true;
    await hooks.crashAt?.("after-commit-rename");
    await fsyncDirectory(parent);
  } finally {
    await handle?.close().catch(() => {});
    // A caught publication failure owns exactly this positively identified
    // temp. Once rename succeeds the COMMITTED path is durable protocol state
    // and must never be removed by error cleanup.
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function boundedJson(file: string, cap: number): Promise<JsonValue | undefined> {
  try {
    return await boundedJsonRead<JsonValue>(file, cap);
  } catch {
    return undefined;
  }
}

/** One field read out of a decoded quarantine record: a JSON value, or absent. */
type JsonField = JsonValue | undefined;
const plain = (value: JsonField): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const hex64 = (value: JsonField): value is string => typeof value === "string" && HEX64.test(value);

function validateManifest(value: JsonField, expectedId?: string): ResetQuarantineManifestV1 | undefined {
  if (!plain(value)) return undefined;
  const m = value;
  if (m.v !== 1 || typeof m.id !== "string" || !BUNDLE_ID.test(m.id) || (expectedId !== undefined && m.id !== expectedId)
    || typeof m.createdAt !== "string" || !Number.isFinite(Date.parse(m.createdAt))
    || (m.scope !== "journal-only" && m.scope !== "transaction")
    || typeof m.phase !== "string" || typeof m.markerPrecondition !== "string" || typeof m.refPreconditions !== "string"
    || (m.activeStateSha256 !== undefined && !hex64(m.activeStateSha256))
    || (m.recoveredStateSha256 !== undefined && !hex64(m.recoveredStateSha256))
    || !Array.isArray(m.artifacts) || m.artifacts.length < 1 || m.artifacts.length > 4) return undefined;
  const sqliteWitness = m.stateFormat === "sqlite/v1"
    && hex64(m.decodedCandidateSha256)
    && Number.isSafeInteger(m.decodedCandidateBytes) && Number(m.decodedCandidateBytes) >= 1
    && Number(m.decodedCandidateBytes) <= 256 * 1024;
  if (m.stateFormat !== undefined && !sqliteWitness) return undefined;
  if (m.stateFormat === undefined && (m.decodedCandidateSha256 !== undefined || m.decodedCandidateBytes !== undefined)) return undefined;
  let journals = 0;
  const originals = new Set<string>();
  const bundled = new Set<string>();
  for (const a of m.artifacts) {
    if (!plain(a) || (a.kind !== "journal" && a.kind !== "candidate" && a.kind !== "archive")
      || (a.cleanup !== "remove-exact" && a.cleanup !== "preserve")
      || typeof a.original !== "string" || typeof a.bundled !== "string" || !hex64(a.sha256)
      || typeof a.bytes !== "number" || !Number.isSafeInteger(a.bytes) || a.bytes < 0
      || originals.has(a.original) || bundled.has(a.bundled)) return undefined;
    if (a.kind === "journal") journals++;
    if (a.kind === "archive" && a.cleanup !== "preserve") return undefined;
    originals.add(a.original); bundled.add(a.bundled);
  }
  if (journals !== 1 || (m.scope === "journal-only" && m.artifacts.length !== 1)) return undefined;
  // The accepted record is returned as read: its exact bytes are re-canonicalized
  // against the committed inventory digest, so no key may be dropped or added.
  return m as ResetQuarantineManifestV1;
}

function validateCommit(value: JsonField): ResetQuarantineCommitV1 | undefined {
  if (!plain(value)) return undefined;
  const c = value;
  const keys = Object.keys(c).sort().join("\0");
  return keys === ["inventorySha256", "manifestSha256", "v"].sort().join("\0") && c.v === 1
    && hex64(c.manifestSha256) && hex64(c.inventorySha256)
    ? c as ResetQuarantineCommitV1 : undefined;
}

const inventoryHash = (manifest: ResetQuarantineManifestV1): string => sha256(canonicalBytes(manifest.artifacts.map((a) => ({
  kind: a.kind, original: a.original, bundled: a.bundled, cleanup: a.cleanup, sha256: a.sha256, bytes: a.bytes,
}))));

async function requireQuarantineDbS0(file: string): Promise<void> {
  if (!file.endsWith(".db")) return;
  for (const suffix of SQLITE_SIDECARS) {
    const sidecar = await fs.lstat(`${file}${suffix}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (sidecar !== undefined) {
      throw new Error(`reset quarantine requires an S0 DB artifact; sidecar is standing: ${file}${suffix}`);
    }
  }
}

async function verifyBundle(bundle: string, manifest: ResetQuarantineManifestV1): Promise<boolean> {
  for (const artifact of manifest.artifacts) {
    const file = absoluteBundled(bundle, artifact.bundled);
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes) return false;
    if (await boundedHash(file, RESET_STREAM_BYTE_LIMIT) !== artifact.sha256) return false;
  }
  return true;
}

async function loadCommittedBundle(bundle: string): Promise<ResetQuarantineManifestV1 | undefined> {
  const id = path.basename(bundle);
  if (!BUNDLE_ID.test(id)) return undefined;
  const manifest = validateManifest(await boundedJson(manifestPath(bundle), MANIFEST_CAP), id);
  const commit = validateCommit(await boundedJson(committedPath(bundle), COMMIT_CAP));
  if (!manifest || !commit) return undefined;
  const bytes = canonicalBytes(manifest);
  if (sha256(bytes) !== commit.manifestSha256 || inventoryHash(manifest) !== commit.inventorySha256) return undefined;
  return await verifyBundle(bundle, manifest) ? manifest : undefined;
}

/** Read-only bundle inspection for the doctor dispatcher. */
export async function readResetQuarantineBundle(root: string, bundle: string): Promise<ResetQuarantineManifestV1 | undefined> {
  if (path.dirname(bundle) !== resetQuarantineRoot(root) || !BUNDLE_ID.test(path.basename(bundle))) return undefined;
  return loadCommittedBundle(bundle);
}

export type ResetQuarantineResidue =
  | { kind: "absent" }
  | { kind: "quarantine-pending"; bundles: readonly string[] }
  | { kind: "post-q-quarantine-residue"; bundles: readonly string[] };

/**
 * Read-only M0/doctor quarantine admission inspection. Every entry in the
 * durable quarantine tree counts: malformed and partial bundles need the same
 * explicit doctor remedy as a committed bundle and are never silently resumed.
 */
export async function inspectResetQuarantineResidue(
  root: string,
  authority: "legacy-json" | "sqlite",
): Promise<ResetQuarantineResidue> {
  const parent = resetQuarantineRoot(root);
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const bundles = entries.map((entry) => entry.name).sort();
  if (bundles.length === 0) return { kind: "absent" };
  return authority === "sqlite"
    ? { kind: "post-q-quarantine-residue", bundles }
    : { kind: "quarantine-pending", bundles };
}

export function resetQuarantineArtifactPath(bundle: string, artifact: { bundled: string }): string {
  return absoluteBundled(bundle, artifact.bundled);
}

async function removeExact(file: string, expectedHash: string): Promise<"absent" | "removed" | "replaced"> {
  const actual = await boundedHash(file, RESET_STREAM_BYTE_LIMIT);
  if (actual === undefined) return "absent";
  if (actual !== expectedHash) return "replaced";
  await fs.rm(file);
  await fsyncDirectory(path.dirname(file));
  return "removed";
}

async function finishCommittedQuarantine(root: string, bundle: string, manifest: ResetQuarantineManifestV1, hooks: ResetQuarantineHooks = {}): Promise<void> {
  const journal = manifest.artifacts.find((a) => a.kind === "journal")!;
  const journalResult = await removeExact(absoluteOriginal(root, journal.original), journal.sha256);
  // A replacement journal owns every deterministic artifact name from this
  // point onward. Never let an old cleanup transaction touch its candidate.
  if (journalResult === "replaced") return;
  await hooks.crashAt?.("after-journal-remove");
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "journal" || artifact.cleanup !== "remove-exact") continue;
    await removeExact(absoluteOriginal(root, artifact.original), artifact.sha256);
    await hooks.crashAt?.(`after-${artifact.kind}-remove`);
  }
}

/** Resume/clean every bundle while the caller holds the recovery fence. */
export async function resumeResetQuarantinesUnderFence(root: string, hooks: ResetQuarantineHooks = {}): Promise<void> {
  const parent = resetQuarantineRoot(root);
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !BUNDLE_ID.test(entry.name)) continue;
    await resumeResetQuarantineUnderFence(root, path.join(parent, entry.name), hooks);
  }
}

/** Resume exactly one bundle under the fence derived from its bundled journal. */
export async function resumeResetQuarantineUnderFence(root: string, bundle: string, hooks: ResetQuarantineHooks = {}): Promise<"partial-cleaned" | "committed-finished"> {
  if (path.dirname(bundle) !== resetQuarantineRoot(root) || !BUNDLE_ID.test(path.basename(bundle))) throw new Error("reset quarantine bundle path is invalid");
  const committed = await boundedJson(committedPath(bundle), COMMIT_CAP);
  if (committed === undefined) {
    await fs.rm(bundle, { recursive: true });
    await fsyncDirectory(path.dirname(bundle));
    return "partial-cleaned";
  }
  const manifest = await loadCommittedBundle(bundle);
  if (!manifest) {
    // A marker that fails record↔manifest↔inventory self-validation is not a
    // commit point. The protocol has not removed originals before a valid
    // marker, so this is the same partial-bundle cleanup as marker absence.
    await fs.rm(bundle, { recursive: true });
    await fsyncDirectory(path.dirname(bundle));
    return "partial-cleaned";
  }
  await finishCommittedQuarantine(root, bundle, manifest, hooks);
  return "committed-finished";
}

/** Commit a fenced quarantine. Originals are untouched until the self-validating
 * commit record and every bundle byte are durable. */
export async function quarantineResetUnderFence(root: string, plan: ResetQuarantinePlan, hooks: ResetQuarantineHooks = {}): Promise<string> {
  if (plan.scope === "journal-only" && (plan.artifacts.length !== 1 || plan.artifacts[0]?.kind !== "journal")) throw new Error("journal-only quarantine may contain only the reset journal");
  if (!plan.artifacts.some((a) => a.kind === "journal")) throw new Error("reset quarantine plan has no journal");
  const now = (hooks.now ?? (() => new Date()))();
  const id = `${now.toISOString().replace(/:/g, "-")}-${(hooks.randomBytes ?? crypto.randomBytes)(8).toString("hex")}`;
  if (!BUNDLE_ID.test(id)) throw new Error("reset quarantine bundle id is invalid");
  const parent = resetQuarantineRoot(root);
  const created = await ensureDirectoryChain(parent, "reset quarantine directory");
  const bundle = path.join(parent, id);
  await fs.mkdir(bundle, { mode: 0o700 });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
  await fs.mkdir(path.join(bundle, "artifacts"), { mode: 0o700 });
  await fsyncDirectory(bundle);

  const artifacts: QuarantineArtifact[] = [];
  for (let index = 0; index < plan.artifacts.length; index++) {
    const input = plan.artifacts[index]!;
    if (input.kind === "archive" && input.cleanup !== "preserve") throw new Error("reset lineage archives must be copied, never moved");
    if (input.kind === "candidate" || input.kind === "archive") {
      await requireQuarantineDbS0(input.absolutePath);
    }
    const original = safeRelative(root, input.absolutePath);
    const hash = await boundedHash(input.absolutePath, RESET_STREAM_BYTE_LIMIT);
    const stat = await fs.lstat(input.absolutePath).catch(() => undefined);
    if (!hash || !stat?.isFile() || stat.isSymbolicLink()) throw new Error(`reset quarantine artifact is absent or unsafe: ${input.absolutePath}`);
    artifacts.push({ kind: input.kind, original, bundled: `artifacts/${index}-${input.kind}`, cleanup: input.cleanup, sha256: hash, bytes: stat.size });
  }
  const journalInput = plan.artifacts.find((artifact) => artifact.kind === "journal")!;
  const decoded = await inspectResetJournalForQuarantine(journalInput.absolutePath);
  const manifestBase: ResetQuarantineManifestBaseV1 = {
    v: 1, id, createdAt: now.toISOString(), scope: plan.scope, phase: plan.phase,
    ...(plan.activeStateSha256 === undefined ? {} : { activeStateSha256: plan.activeStateSha256 }),
    ...(plan.recoveredStateSha256 === undefined ? {} : { recoveredStateSha256: plan.recoveredStateSha256 }),
    markerPrecondition: plan.markerPrecondition, refPreconditions: plan.refPreconditions, artifacts,
  };
  const manifest: ResetQuarantineManifestV1 = decoded.ok && "stateFormat" in decoded.journal
    ? {
      ...manifestBase,
      stateFormat: "sqlite/v1",
      decodedCandidateSha256: decoded.journal.next.stateSha256,
      decodedCandidateBytes: decoded.journal.next.dbBytes.byteLength,
    }
    : manifestBase;
  const manifestBytes = canonicalBytes(manifest);
  await durableAtomic(manifestPath(bundle), manifestBytes);
  await hooks.crashAt?.("after-manifest-publish");
  for (const artifact of artifacts) {
    const copied = await boundedCopy(absoluteOriginal(root, artifact.original), absoluteBundled(bundle, artifact.bundled), RESET_STREAM_BYTE_LIMIT);
    if (!copied || await boundedHash(absoluteBundled(bundle, artifact.bundled), RESET_STREAM_BYTE_LIMIT) !== artifact.sha256) throw new Error(`reset quarantine copy verification failed: ${artifact.kind}`);
    await hooks.crashAt?.(`after-${artifact.kind}-copy`);
  }
  if (!await verifyBundle(bundle, manifest)) throw new Error("reset quarantine bundle verification failed");
  // Re-publish and fsync the manifest after all copy verification, explicitly
  // placing its durability before the commit point.
  await durableAtomic(manifestPath(bundle), manifestBytes);
  await hooks.crashAt?.("after-manifest-fsync");
  const commit: ResetQuarantineCommitV1 = { v: 1, manifestSha256: sha256(manifestBytes), inventorySha256: inventoryHash(manifest) };
  await hooks.crashAt?.("before-commit-publish");
  await publishCommitRecord(committedPath(bundle), canonicalBytes(commit), hooks);
  await fsyncDirectory(bundle);
  await fsyncDirectory(parent);
  await hooks.crashAt?.("after-commit-publish");
  await finishCommittedQuarantine(root, bundle, manifest, hooks);
  return bundle;
}

export interface RestoreResetOptions {
  /** Fresh durable config stream eligibility is checked by the doctor adapter. */
  configEligible: boolean;
}

/** Restore a valid bundle under the recovery fence. Inert artifacts publish
 * first; the reset journal is the sole and final transaction publication. */
export async function restoreResetQuarantineUnderFence(root: string, bundle: string, options: RestoreResetOptions, hooks: ResetQuarantineHooks = {}): Promise<"restored" | "already-restored"> {
  if (path.dirname(bundle) !== resetQuarantineRoot(root) || !BUNDLE_ID.test(path.basename(bundle))) throw new Error("reset quarantine bundle path is invalid");
  if (!options.configEligible) throw new Error("reset quarantine restore refused: durable config is not eligible for this journal");
  const manifest = await loadCommittedBundle(bundle);
  if (!manifest) throw new Error("reset quarantine bundle is uncommitted or corrupt");
  if (manifest.activeStateSha256) {
    // The restore decision is taken from the live state's hash; a newer state
    // plane must be recognized rather than hashed as if it were JSON.
    const activePath = manifest.stateFormat === "sqlite/v1"
      ? path.join(root, ".rbox", "state", "state.db")
      : path.join(root, ".rbox", "state.json");
    if (manifest.stateFormat !== "sqlite/v1") await assertStateReadable(activePath);
    const active = await boundedHash(activePath, RESET_STREAM_BYTE_LIMIT);
    if (manifest.recoveredStateSha256 !== undefined && active === manifest.recoveredStateSha256) {
      const journal = manifest.artifacts.find((a) => a.kind === "journal")!;
      if (await boundedHash(absoluteOriginal(root, journal.original), RESET_STREAM_BYTE_LIMIT) !== undefined) {
        throw new Error("reset quarantine restore refused: recovered state has a standing journal");
      }
      await fs.rm(bundle, { recursive: true });
      await fsyncDirectory(path.dirname(bundle));
      return "already-restored";
    }
    if (active !== manifest.activeStateSha256) throw new Error("reset quarantine restore refused: active state advanced since quarantine");
  }
  if (manifest.scope === "transaction") {
    const journalArtifact = manifest.artifacts.find((artifact) => artifact.kind === "journal");
    if (!journalArtifact) throw new Error("reset quarantine transaction has no journal");
    const bundledJournal = absoluteBundled(bundle, journalArtifact.bundled);
    const decoded = await decodeResetJournal(await resetJournalFileSource(bundledJournal));
    if (!decoded.ok) throw new Error(`reset quarantine transaction journal is invalid: ${decoded.error.code}`);
    const decodedJournal = decoded.journal;
    const observation = "stateFormat" in decodedJournal
      ? await (async () => {
        const { sqliteResetFacade } = await import("./state-plane/reset/index.js");
        return sqliteResetFacade.observeControlPlane(root, decodedJournal);
      })()
      : (await observeResetJournalBytes(
        root,
        (await boundedRead(bundledJournal, RESET_JOURNAL_BYTE_LIMIT))!,
      )).observation;
    const currentRefs = JSON.stringify({ recovery: observation.recoveryRefs, active: observation.activeRefGroups });
    if (String(observation.marker) !== manifest.markerPrecondition || currentRefs !== manifest.refPreconditions) {
      throw new Error("reset quarantine restore refused: marker or recovery refs changed since quarantine");
    }
  }
  const journal = manifest.artifacts.find((a) => a.kind === "journal")!;
  const journalDest = absoluteOriginal(root, journal.original);
  const standing = await boundedHash(journalDest, RESET_STREAM_BYTE_LIMIT);
  if (standing === journal.sha256) {
    await fs.rm(bundle, { recursive: true });
    await fsyncDirectory(path.dirname(bundle));
    return "already-restored";
  }
  if (standing !== undefined) throw new Error("reset quarantine restore refused: a different reset journal is standing");
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "journal") continue;
    const dest = absoluteOriginal(root, artifact.original);
    const current = await boundedHash(dest, RESET_STREAM_BYTE_LIMIT);
    if (current !== undefined && current !== artifact.sha256) throw new Error(`reset quarantine restore refused: ${artifact.kind} destination changed`);
  }
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "journal") continue;
    const dest = absoluteOriginal(root, artifact.original);
    if (await boundedHash(dest, RESET_STREAM_BYTE_LIMIT) === artifact.sha256) continue;
    await boundedCopy(absoluteBundled(bundle, artifact.bundled), dest, RESET_STREAM_BYTE_LIMIT);
    if (await boundedHash(dest, RESET_STREAM_BYTE_LIMIT) !== artifact.sha256) throw new Error(`reset quarantine restore verification failed: ${artifact.kind}`);
    await hooks.crashAt?.(`after-${artifact.kind}-restore`);
  }
  await hooks.crashAt?.("before-journal-publish");
  await boundedCopy(absoluteBundled(bundle, journal.bundled), journalDest, RESET_STREAM_BYTE_LIMIT);
  if (await boundedHash(journalDest, RESET_STREAM_BYTE_LIMIT) !== journal.sha256) throw new Error("reset quarantine restored journal verification failed");
  await hooks.crashAt?.("after-journal-publish");
  await fs.rm(bundle, { recursive: true });
  await fsyncDirectory(path.dirname(bundle));
  return "restored";
}
