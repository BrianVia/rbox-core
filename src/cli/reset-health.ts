import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "../engine/e2ee/jcs.js";
import type { JsonValue } from "../json.js";
import { ensureDirectoryChain, fsyncCreatedDirectoryAncestors, fsyncDirectory, writeFileAtomic } from "../engine/fsutil.js";
import { boundedJsonRead } from "./reset-io.js";

const MAX_HEALTH_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 4096;
const HEX64 = /^[0-9a-f]{64}$/;

export interface ResetHaltHealthV1 {
  v: 1;
  reason: string;
  journalIdentity: string;
  haltedAt: string;
}

/** The decoded advisory document, keyed by the members this record owns: exactly
 * what `boundedJsonRead` (i.e. `JSON.parse`) produced for the file's bytes. */
type ResetHaltHealthCandidate = Partial<Record<keyof ResetHaltHealthV1, JsonValue>>;

export const resetHaltHealthPath = (root: string): string =>
  path.join(root, ".rbox", "state", "health-halt.json");

export const resetJournalIdentity = (bytes: Uint8Array): string =>
  crypto.createHash("sha256").update(bytes).digest("hex");

function isCanonicalTime(value: JsonValue | undefined): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validate(value: JsonValue): ResetHaltHealthV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record: ResetHaltHealthCandidate = value;
  const keys = Object.keys(record).sort();
  if (keys.join("\0") !== ["haltedAt", "journalIdentity", "reason", "v"].sort().join("\0")) return undefined;
  if (record.v !== 1 || typeof record.reason !== "string" || Buffer.byteLength(record.reason) > MAX_REASON_BYTES || record.reason.includes("\0")) return undefined;
  if (typeof record.journalIdentity !== "string" || !HEX64.test(record.journalIdentity) || !isCanonicalTime(record.haltedAt)) return undefined;
  return { v: 1, reason: record.reason, journalIdentity: record.journalIdentity, haltedAt: record.haltedAt };
}

/** Read-only by contract. Invalid or unsafe records are ignored: the standing
 * journal classifier, not this advisory file, remains the authority. */
export async function readResetHaltHealth(root: string): Promise<ResetHaltHealthV1 | undefined> {
  const file = resetHaltHealthPath(root);
  try {
    const document = await boundedJsonRead<JsonValue>(file, MAX_HEALTH_BYTES);
    return document === undefined ? undefined : validate(document);
  } catch {
    return undefined;
  }
}

/** Daemon-owned mutation. CLI/status/doctor callers must never call this. */
export async function writeResetHaltHealth(root: string, input: Omit<ResetHaltHealthV1, "v">): Promise<void> {
  const health = validate({ v: 1, ...input });
  if (!health) throw new Error("reset halt health record is invalid");
  const file = resetHaltHealthPath(root);
  const parent = path.dirname(file);
  const created = await ensureDirectoryChain(parent, "reset health directory");
  await writeFileAtomic(file, Buffer.concat([Buffer.from(canonicalize(health)), Buffer.from("\n")]), { mode: 0o600 });
  await fsyncDirectory(parent);
  await fsyncCreatedDirectoryAncestors(parent, created);
}

/** Daemon-owned mutation. Idempotent and parent-durable when a record existed. */
export async function clearResetHaltHealth(root: string): Promise<boolean> {
  const file = resetHaltHealthPath(root);
  try {
    await fs.rm(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fsyncDirectory(path.dirname(file));
  return true;
}
