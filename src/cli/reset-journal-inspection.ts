import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "../json.js";
import type {
  MarkerDisposition,
  NextArtifactDisposition,
  OldArtifactDisposition,
  ResetPhysicalObservation,
  ResetPhysicalRow,
  StateDisposition,
} from "./reset-journal-classifier.js";
import type {
  ResetJournalDecodeError,
  SQLiteResetJournalV2,
} from "./reset-journal-codec.js";
import type {
  ResetJournal,
  ResetJournalV2,
} from "./reset-journal-legacy-schema.js";
import type { SqliteResetInspection } from "./state-plane/reset/recovery.js";
import { assertStateReadable } from "./state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "./state-plane/paths.js";
import { boundedHash, boundedJsonRead, retryOnIdentityRace } from "./reset-io.js";
import { observeResetRefs } from "./reset-z-runtime.js";
import {
  assertProtocolLockHeld,
  type RepositoryProtocolFenceRequest,
} from "./sync-git/protocol-locks.js";

export interface ResetJournalHooks {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  crashAt?: (point: string) => void | Promise<void>;
}

export interface ResetArtifactObservation extends ResetPhysicalObservation {
  activeHash?: string;
  candidateHash?: string;
  archiveHash?: string;
  artifactPaths: { active: string; candidate: string; archive: string; marker: string; journal: string };
}

interface IncarnationMarkerCandidate {
  stream?: JsonValue;
  stateNonce?: JsonValue;
  stateRevision?: JsonValue;
}
const exactKeys = (value: IncarnationMarkerCandidate, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const stateDisposition = (hash: string | undefined, journal: ResetJournalV2): StateDisposition =>
  hash === undefined ? "absent" : hash === journal.old.stateSha256 ? "old" : hash === journal.next.stateSha256 ? "next" : "other";
const nextDisposition = (hash: string | undefined, journal: ResetJournalV2): NextArtifactDisposition =>
  hash === undefined ? "absent" : hash === journal.next.stateSha256 ? "next" : "other";
const oldDisposition = (hash: string | undefined, journal: ResetJournalV2): OldArtifactDisposition =>
  hash === undefined ? "absent" : hash === journal.old.stateSha256 ? "old" : "other";

async function markerDisposition(file: string, journal: ResetJournalV2): Promise<MarkerDisposition> {
  try {
    const value = await boundedJsonRead<IncarnationMarkerCandidate>(file, 512 * 1024);
    if (!value) return "absent";
    if (!exactKeys(value, ["stream", "stateNonce", "stateRevision"])) return "other";
    const { stream, stateNonce, stateRevision } = value;
    if (stream !== String(stream) || stateNonce !== String(stateNonce) || !Number.isSafeInteger(stateRevision)) return "other";
    const tuple = `${stream}\0${stateNonce}\0${stateRevision}`;
    if (tuple === `${journal.old.stream}\0${journal.old.stateNonce}\0${journal.old.stateRevision}`) return "old";
    if (tuple === `${journal.next.stream}\0${journal.next.stateNonce}\0${journal.next.stateRevision}`) return "next";
    return "other";
  } catch { return "other"; }
}

export async function observeLegacyResetPhysical(
  journal: ResetJournalV2,
  paths: ResetArtifactObservation["artifactPaths"],
): Promise<ResetArtifactObservation> {
  await assertStateReadable(paths.active);
  const [activeHash, candidateHash, archiveHash, marker, refs] = await Promise.all([
    boundedHash(paths.active), boundedHash(paths.candidate), boundedHash(paths.archive),
    markerDisposition(paths.marker, journal), observeResetRefs(journal.old.z),
  ]);
  return {
    phase: journal.phase, archiveBaseline: journal.old.archiveBaseline,
    active: stateDisposition(activeHash, journal), candidate: nextDisposition(candidateHash, journal),
    archive: oldDisposition(archiveHash, journal), marker,
    recoveryRefs: refs.recovery, activeRefGroups: refs.activeGroups,
    activeHash, candidateHash, archiveHash, artifactPaths: paths,
  };
}

export type ResetJournalInspection =
  | { status: "none" }
  | { status: "halt"; reason: string; journalIdentityHash?: string; journal?: ResetJournal | SQLiteResetJournalV2; observation?: ResetArtifactObservation; decodeError?: ResetJournalDecodeError }
  | {
    status: "recoverable";
    journalIdentityHash: string;
    journal: ResetJournalV2 | SQLiteResetJournalV2;
    configDisposition: "old" | "next";
    row: ResetPhysicalRow;
    observation: ResetArtifactObservation;
  };

export class ResetRecoveryHaltError extends Error {
  readonly code = "RESET_RECOVERY_HALT";
  constructor(readonly inspection: Extract<ResetJournalInspection, { status: "halt" }>) {
    super(`reset recovery halted: ${inspection.reason}`);
    this.name = "ResetRecoveryHaltError";
  }
}

const resetFenceObservationBrand: unique symbol = Symbol("reset-fence-observation");
export interface ResetFenceObservation { readonly [resetFenceObservationBrand]: true }
class ResetFenceEvidence implements ResetFenceObservation {
  readonly [resetFenceObservationBrand] = true;
  constructor(
    readonly root: string,
    readonly callerStream: string | undefined,
    readonly fingerprint: string,
    readonly standing: StandingResetInspection,
  ) {}
}
export type StandingResetInspection =
  | { kind: "none" }
  | { kind: "w1" }
  | { kind: "legacy"; inspection: ResetJournalInspection }
  | { kind: "sqlite"; inspection: SqliteResetInspection };
export type InternalResetFenceObservation = ResetFenceEvidence;

export function resetFenceRequests(standing: StandingResetInspection): RepositoryProtocolFenceRequest[] {
  const journal = standing.kind === "legacy"
    ? standing.inspection.status === "recoverable" ? standing.inspection.journal
      : standing.inspection.status === "halt" ? standing.inspection.journal : undefined
    : standing.kind === "sqlite" && standing.inspection.status === "recoverable"
      ? standing.inspection.journal : undefined;
  if (!journal || !("old" in journal)) return [];
  return journal.old.z.map((entry) => ({
    commonDir: entry.repositoryIdentity.commonDirReal,
    reflogRefs: [entry.activeRef, entry.recoveryRef].sort(), origins: true,
  })).sort((a, b) => a.commonDir.localeCompare(b.commonDir));
}

/** Every ordinary state load observes this fence, so it runs unlocked against a
 * workspace whose writers republish state.json by atomic rename. The retry makes
 * the whole tuple — stat AND control hash — describe one settled file. */
async function artifactIdentity(root: string, file: string): Promise<readonly unknown[]> {
  return retryOnIdentityRace(async () => {
    try {
      const s = await fs.lstat(file, { bigint: true });
      const controlHash = file === statePath(root) || file === sqliteResetPaths.journal(root)
        ? await boundedHash(file, 512 * 1024)
        : undefined;
      return [
        s.isFile(), s.isSymbolicLink(), s.size.toString(), s.mtimeNs.toString(),
        s.dev.toString(), s.ino.toString(), controlHash,
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["absent"];
      throw error;
    }
  });
}

export async function createResetFenceObservation(
  root: string,
  callerStream: string | undefined,
  standing: StandingResetInspection,
  artifacts: readonly string[],
): Promise<InternalResetFenceObservation> {
  const physical = await Promise.all(artifacts.map((file) => artifactIdentity(root, file)));
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify([standing, physical, resetFenceRequests(standing)])).digest("hex");
  return Object.freeze(new ResetFenceEvidence(path.resolve(root), callerStream, fingerprint, standing));
}

export function internalResetFenceObservation(expected: ResetFenceObservation): InternalResetFenceObservation {
  if (!(expected instanceof ResetFenceEvidence)) throw new Error("reset fence observation is not authentic");
  return expected;
}

export function assertResetProtocolFence(root: string, requests: readonly RepositoryProtocolFenceRequest[]): void {
  assertProtocolLockHeld("state", path.resolve(statePath(root)));
  for (const request of requests) {
    const commonDir = path.resolve(request.commonDir);
    assertProtocolLockHeld("operation", commonDir);
    assertProtocolLockHeld("git", commonDir);
    if (request.origins) assertProtocolLockHeld("origin", commonDir);
    for (const ref of request.reflogRefs ?? []) assertProtocolLockHeld("reflog", `${commonDir}\0${ref}`);
  }
}
