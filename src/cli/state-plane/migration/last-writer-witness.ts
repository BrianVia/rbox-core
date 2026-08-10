/**
 * The durable last-writer witness (design 163, unit B0, closure 1b).
 *
 * `SyncState` has no version member and must not grow one: a new member is
 * silently dropped by older binaries and by the degraded composer, so it could
 * never prove anything about the writer that wrote last. The witness therefore
 * lives beside the state, in a closed-schema sidecar, and records the body hash
 * of the exact bytes that were published.
 *
 * It is never authority and is never read by the sync engine. Its sole consumer
 * is a future migration's admission check, which must be able to prove that the
 * document on disk right now was published by a barrier-capable binary.
 */
import crypto from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fsyncDirectory, writeFileAtomic } from "../../../engine/fsutil.js";
import { semverGt } from "../../semver.js";
import { RBOX_VERSION } from "../../version.js";
import { RBOX_DIR } from "../../workspace-config.js";

/** The ratified downgrade floor: the first release whose writers maintain this
 * witness. A workspace whose most recent writer predates it is not migratable. */
export const BARRIER_DOWNGRADE_FLOOR = "1.11.0";
const WITNESS_MAX_BYTES = 4 * 1024;
/** Matches the reset materialization bound the state readers already apply. */
const STATE_MAX_BYTES = 256 * 1024 * 1024;

export const lastWriterWitnessPath = (root: string): string =>
  path.join(root, RBOX_DIR, "state", "last-writer.json");

export interface LastWriterWitness {
  version: 1;
  writerVersion: string;
  writtenAtMs: number;
  /** Authoritative: sha256 of the exact published bytes. */
  stateBodySha256: string;
  /** Authoritative: byte length of the exact published bytes. */
  stateSizeBytes: number;
  /** Corroborating: observed on the just-published file. */
  stateMtimeMs: number;
  stateDev: number;
  stateIno: number;
}

const WITNESS_KEYS = [
  "version", "writerVersion", "writtenAtMs",
  "stateBodySha256", "stateSizeBytes", "stateMtimeMs", "stateDev", "stateIno",
] as const;

export type WitnessVerdict =
  | { status: "ok"; witness: LastWriterWitness }
  /** Fail-closed refusal. `detail` names which of the closed failure modes it
   * was; `barrier-witness-identity-drift` specifically means the body matched
   * but something republished those bytes without maintaining the witness. */
  | {
      status: "barrier-witness-missing";
      detail:
        | "absent"
        | "unparseable"
        | "state-absent"
        | "body-mismatch"
        | "barrier-witness-identity-drift"
        | "writer-version-below-floor";
    };

const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Parse the closed schema. Any unknown member, missing member, or wrong type is
 * a foreign witness, not a witness with extras. */
export function parseLastWriterWitness(text: string): LastWriterWitness | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw).sort().join("\0");
  if (keys !== [...WITNESS_KEYS].sort().join("\0")) return undefined;
  const version: unknown = Reflect.get(raw, "version");
  const writerVersion: unknown = Reflect.get(raw, "writerVersion");
  const stateBodySha256: unknown = Reflect.get(raw, "stateBodySha256");
  const writtenAtMs: unknown = Reflect.get(raw, "writtenAtMs");
  const stateSizeBytes: unknown = Reflect.get(raw, "stateSizeBytes");
  const stateMtimeMs: unknown = Reflect.get(raw, "stateMtimeMs");
  const stateDev: unknown = Reflect.get(raw, "stateDev");
  const stateIno: unknown = Reflect.get(raw, "stateIno");
  if (version !== 1) return undefined;
  if (typeof writerVersion !== "string" || writerVersion.length > 40) return undefined;
  if (typeof stateBodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(stateBodySha256)) return undefined;
  if (!isSafeInt(writtenAtMs) || !isSafeInt(stateSizeBytes) || !isSafeInt(stateMtimeMs)
    || !isSafeInt(stateDev) || !isSafeInt(stateIno)) return undefined;
  return { version, writerVersion, writtenAtMs, stateBodySha256, stateSizeBytes, stateMtimeMs, stateDev, stateIno };
}

async function readLastWriterWitness(root: string): Promise<LastWriterWitness | undefined> {
  const file = lastWriterWitnessPath(root);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > WITNESS_MAX_BYTES) return undefined;
  return parseLastWriterWitness(await fs.readFile(file, "utf8").catch(() => ""));
}

/**
 * Record the witness for bytes that have just been published and directory-
 * synced, while the publishing actor still holds the state lock.
 *
 * A failed witness write never fails the state write — the state is already
 * durable — it merely leaves the witness stale, which the verifier treats as a
 * refusal rather than as consent.
 */
export async function recordLastWriterWitness(
  root: string,
  statePath: string,
  publishedBytes: string | Uint8Array,
  nowMs: () => number = Date.now,
): Promise<LastWriterWitness | undefined> {
  try {
    const body = typeof publishedBytes === "string" ? Buffer.from(publishedBytes, "utf8") : Buffer.from(publishedBytes);
    const sample = await sampleStateFile(statePath);
    if (!sample) return undefined;
    const { stat } = sample;
    // The identity is only recorded when the file still carries the bytes this
    // actor published. What remains uncloseable from here is a writer that
    // ignores the state lock and republishes BYTE-IDENTICAL content in this
    // window — by construction indistinguishable from our own publication, and
    // the residue design 163 § 1a names rather than claims to have closed.
    if (!sample.body.equals(body)) return undefined;
    const witness: LastWriterWitness = {
      version: 1,
      writerVersion: RBOX_VERSION,
      writtenAtMs: nowMs(),
      stateBodySha256: crypto.createHash("sha256").update(body).digest("hex"),
      stateSizeBytes: body.byteLength,
      stateMtimeMs: Math.floor(stat.mtimeMs),
      stateDev: Number(stat.dev),
      stateIno: Number(stat.ino),
    };
    const file = lastWriterWitnessPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify(witness, null, 2)}\n`);
    await fsyncDirectory(path.dirname(file));
    return witness;
  } catch {
    return undefined;
  }
}

/**
 * One no-follow sample of the live state file: identity and bytes read through
 * the same descriptor, so the five recorded fields always describe one file
 * rather than a pair of pathname lookups an identical-byte replacement could
 * straddle.
 */
async function sampleStateFile(statePath: string): Promise<{ stat: Stats; body: Buffer } | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > STATE_MAX_BYTES) return undefined;
    const body = await handle.readFile();
    const after = await handle.stat();
    // The descriptor pins the inode, but a writer could still have appended to
    // it between the two stats; a changed size or mtime invalidates the sample.
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || body.byteLength !== stat.size) return undefined;
    return { stat, body };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Verify the witness against the live state file. All five state fields must
 * match. When they disagree the content hash is what is trusted: a body
 * mismatch is decisive regardless of identity, and an identity mismatch under a
 * matching body is still a refusal, reported as identity drift.
 */
export async function verifyLastWriterWitness(
  root: string,
  statePath: string,
  floor: string = BARRIER_DOWNGRADE_FLOOR,
): Promise<WitnessVerdict> {
  const witness = await readLastWriterWitness(root);
  if (!witness) return { status: "barrier-witness-missing", detail: "absent" };
  const sample = await sampleStateFile(statePath);
  if (!sample) return { status: "barrier-witness-missing", detail: "state-absent" };
  const { stat, body } = sample;
  const bodySha256 = crypto.createHash("sha256").update(body).digest("hex");
  if (bodySha256 !== witness.stateBodySha256 || body.byteLength !== witness.stateSizeBytes) {
    return { status: "barrier-witness-missing", detail: "body-mismatch" };
  }
  if (Math.floor(stat.mtimeMs) !== witness.stateMtimeMs
    || Number(stat.dev) !== witness.stateDev
    || Number(stat.ino) !== witness.stateIno) {
    return { status: "barrier-witness-missing", detail: "barrier-witness-identity-drift" };
  }
  try {
    if (semverGt(floor, witness.writerVersion)) return { status: "barrier-witness-missing", detail: "writer-version-below-floor" };
  } catch {
    return { status: "barrier-witness-missing", detail: "unparseable" };
  }
  return { status: "ok", witness };
}
