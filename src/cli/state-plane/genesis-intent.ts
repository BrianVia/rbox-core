/**
 * The genesis intent as a value: its shape, its strict decode, and its bounded
 * reader (design 222 §2.3).
 *
 * Split out of `genesis.ts` for one reason: the state-plane write fence reads
 * this record on EVERY SQLite save, and 163 v13 forbids the fence from opening
 * a database. `genesis.ts` legitimately opens the databases it owns, so a fence
 * that read the intent from there could only be proven open-free by inspection.
 * From here it is provable by reachability — this module's import graph does not
 * contain `bun:sqlite`, and `authority-bootstrap.test.ts` walks it.
 *
 * The reader is bounded the way `readExactFile` is: one no-follow non-blocking
 * descriptor, a regular-file check, and a byte cap. It runs on the hot path
 * while the state lock is held, so a FIFO, a symlink to something enormous, or
 * a directory must refuse rather than block or load.
 *
 * Never: SQLite, writing or retiring the intent, or deciding anything from it.
 */
import fs, { constants } from "node:fs";
import { jsonObject, type JsonValue } from "../../json.js";
import { checkRecord, type Fields, type Refuse, type Spec } from "./closed-record.js";
import { StateAuthorityCorruptError } from "./errors.js";
import { genesisPaths } from "./paths.js";
import type { ClaimedInode } from "./store/open.js";

export type FencedEvidence = {
  root: string;
  stream: string;
  /** `.rbox/state/state-incarnation.json`; its absence is itself a bound fact. */
  incarnation: { dev: number; ino: number; sha256: string } | "absent";
};

export interface GenesisIntent {
  version: 1;
  authorityId: string;
  lineageId: string;
  evidence: FencedEvidence;
  staging: ClaimedInode;
}

/** Five small fields; the largest legal record is under 400 bytes. */
const INTENT_MAX_BYTES = 4096;

/** Read-only; consumed by the coordinator's write fence. Synchronous because
 * that fence is (wave 1A's pin). */
export function readGenesisIntent(root: string): GenesisIntent | undefined {
  const file = genesisPaths.intent(root);
  const text = readBoundedRegularFile(file);
  return text === undefined ? undefined : decodeIntent(file, text);
}

/** `undefined` is absence and nothing else. Every other observation refuses. */
function readBoundedRegularFile(file: string): string | undefined {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO at this path refuses instead of hanging the save
    // that is holding the state lock; O_NOFOLLOW so a symlink never redirects
    // the read. Neither flag changes anything for a regular file.
    fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw corrupt(file, `it could not be opened as a regular file (${code})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw corrupt(file, "it is not a regular file");
    if (stat.size > INTENT_MAX_BYTES) throw corrupt(file, `it is ${stat.size} bytes, over the ${INTENT_MAX_BYTES} cap`);
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.byteLength, 0) !== bytes.byteLength) {
      throw corrupt(file, "it was truncated while being read");
    }
    return bytes.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const INODE: Fields = { dev: "int", ino: "int" };

/** The shape on disk selects which closed spec must accept `incarnation`;
 * neither admits the other, so nothing is coerced into `"absent"`. */
const intentSpec = (incarnation: JsonValue | undefined): Spec => ({ fields: {
  version: { const: 1 }, authorityId: "hex32", lineageId: "hex32",
  evidence: { fields: { root: "string", stream: "string",
    incarnation: incarnation === "absent" ? { const: "absent" } : { fields: { ...INODE, sha256: "hex" } } } },
  staging: { fields: INODE },
} });

/** Strict decode of a closed record: a future version halts, never reads. */
export function decodeIntent(file: string, text: string): GenesisIntent {
  const bad: Refuse = (at, why) => { throw new StateAuthorityCorruptError(file, `${at} ${why}`); };
  let record: JsonValue;
  try { record = JSON.parse(text); } catch { return bad("the genesis intent", "is not JSON"); }
  const object = jsonObject(record) ? record : undefined;
  const evidence = object && jsonObject(object.evidence) ? object.evidence : undefined;
  const incarnation = evidence?.incarnation;
  checkRecord<GenesisIntent>(record, intentSpec(incarnation), "the genesis intent", bad);
  return record;
}

function corrupt(file: string, why: string): StateAuthorityCorruptError {
  return new StateAuthorityCorruptError(file, `the genesis intent ${why}`);
}
