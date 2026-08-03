/**
 * M2 (design 163 phase M2): the source JSON preserved as two preamble-prefixed
 * copies — the immutable hash-addressed history entry and the fixed convenience
 * backup — neither of which parses as a state file.
 *
 * Separated from the rest of M-5 because it is a pure byte-copy protocol over
 * files this migration creates, while `import-json.ts` owns the staging
 * database. Nothing here opens SQLite and nothing here reads a path it was not
 * given by its own durable control.
 */
import crypto from "node:crypto";
import fs, { constants as O } from "node:fs";
import { migrationPaths } from "../paths.js";
import { observePath } from "./artifact-observation.js";
import type { ArtifactWitness, MigrationControl, SourceWitness } from "./control-codec.js";
import { halt, fsyncFileAndParent } from "./phase-io.js";
import type { ClaimedInode } from "../store/open.js";

/** The mandatory preamble (163:2602). A file carrying it is not valid JSON, so
 * no reader — 1.x or 2.0 — can restore a backup by copying it into place. */
export const BACKUP_MAGIC = "RBOX-LEGACY-STATE-BACKUP-v1";
const COPY_CHUNK_BYTES = 64 * 1024;

const witnessOf = (file: string, sha256: string, inode: { dev: number; ino: number }, bytes: number): ArtifactWitness =>
  ({ path: file, dev: inode.dev, ino: inode.ino, bytes, sha256 });

/** Stream `source` into a fresh exclusive temp behind the preamble, hashing the
 * body as it goes. The body hash must equal the recorded one: a source that
 * changed mid-copy produces a backup that names bytes it does not hold. */
function renderBackupCopy(temp: string, source: SourceWitness): void {
  const out = fs.openSync(temp, O.O_CREAT | O.O_EXCL | O.O_WRONLY | O.O_NOFOLLOW, 0o600);
  try {
    const input = fs.openSync(source.path, O.O_RDONLY | O.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(input);
      if (!stat.isFile() || Number(stat.dev) !== source.dev || Number(stat.ino) !== source.ino) {
        halt("verification", true, "the legacy document changed identity before the backup copy");
      }
      fs.writeSync(out, Buffer.from(`${BACKUP_MAGIC} ${source.sha256}\n`));
      const body = crypto.createHash("sha256");
      const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
      for (let offset = 0; ;) {
        const read = fs.readSync(input, chunk, 0, chunk.byteLength, offset);
        if (read === 0) break;
        body.update(chunk.subarray(0, read));
        fs.writeSync(out, chunk, 0, read);
        offset += read;
      }
      if (body.digest("hex") !== source.sha256) {
        halt("verification", true, "the legacy document changed while it was being preserved");
      }
    } finally {
      fs.closeSync(input);
    }
    fs.fsyncSync(out);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  } finally {
    fs.closeSync(out);
  }
}

/** A backup file's declared body hash and its own physical hash, from ONE
 * no-follow descriptor. `undefined` means the path is not a backup at all. */
export function readBackup(file: string): { declared: string; physical: string; bytes: number } | undefined {
  const observed = observePath(file, true);
  if (observed.state === "absent") return undefined;
  if (observed.state !== "regular" || observed.sha256 === null) {
    return halt("reserved-path", false, `${file} is not a regular backup file`);
  }
  const header = Buffer.alloc(BACKUP_MAGIC.length + 66);
  const fd = fs.openSync(file, O.O_RDONLY | O.O_NOFOLLOW);
  try {
    fs.readSync(fd, header, 0, header.byteLength, 0);
  } finally {
    fs.closeSync(fd);
  }
  const line = header.toString("latin1");
  const match = /^RBOX-LEGACY-STATE-BACKUP-v1 ([0-9a-f]{64})\n/.exec(line);
  if (!match) return halt("reserved-path", false, `${file} does not carry the legacy backup preamble`);
  return { declared: match[1]!, physical: observed.sha256, bytes: observed.bytes };
}

/** Publish `file` as an exact preamble-prefixed copy of the source, reusing it
 * when it already is one. The render→rename pair is the only writer, so a crash
 * leaves either the old exact file or an id-scoped temp nothing else names. */
export function publishBackup(root: string, control: MigrationControl, file: string, source: SourceWitness): ArtifactWitness {
  const existing = readBackup(file);
  if (existing?.declared === source.sha256) {
    const observed = observePath(file);
    if (observed.state !== "regular") halt("reserved-path", false, `${file} vanished while it was being adopted`);
    fsyncFileAndParent(file);
    return witnessOf(file, existing.physical, observed as ClaimedInode, existing.bytes);
  }
  const temp = migrationPaths.backupTemp(root, control.migrationId);
  fs.rmSync(temp, { force: true });
  renderBackupCopy(temp, source);
  fs.renameSync(temp, file);
  fsyncFileAndParent(file);
  const published = readBackup(file);
  const observed = observePath(file);
  if (!published || published.declared !== source.sha256 || observed.state !== "regular") {
    halt("verification", true, `${file} is not the backup just published`);
  }
  return witnessOf(file, published!.physical, observed as ClaimedInode, published!.bytes);
}

