/** Never: journal encoding/writes, recovery decisions, lock lifecycle, Git validation, or reporting. */
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MAX_V1_JOURNAL_BYTES,
  MAX_V2_JOURNAL_BYTES,
  parseStateCasJournal,
  stateCasJournalDir,
  type StateCasLockJournal,
} from "./state-cas-journal.js";

import { V2_HEADER_LINE_PREFIX } from "./state-cas-journal.js";
const V2_HEADER_PREFIX = Buffer.from(V2_HEADER_LINE_PREFIX);

export interface LoadedStateCasJournal {
  path: string;
  journal?: StateCasLockJournal;
}

async function validateJournalDirectory(root: string, directory: string): Promise<void> {
  const rootAbsolute = path.resolve(root);
  const rootReal = await fs.realpath(rootAbsolute);
  let current = rootAbsolute;
  for (const component of path.relative(rootAbsolute, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe state-CAS journal directory: ${current}`);
  }
  const directoryReal = await fs.realpath(directory);
  if (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new Error("state-CAS journal directory escaped workspace");
  }
}

async function admitsV2Size(handle: fs.FileHandle, size: number): Promise<boolean> {
  if (size <= MAX_V1_JOURNAL_BYTES) return true;
  const prefix = Buffer.alloc(V2_HEADER_PREFIX.length);
  const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
  return bytesRead === prefix.length && prefix.equals(V2_HEADER_PREFIX);
}

/** Bounded, no-follow discovery and format-specific read admission for restart recovery. */
export async function loadStateCasJournals(root: string): Promise<LoadedStateCasJournal[]> {
  const directory = stateCasJournalDir(root);
  try { await validateJournalDirectory(root, directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const loaded: LoadedStateCasJournal[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    let handle: fs.FileHandle | undefined;
    let raw: string | undefined;
    try {
      const before = await fs.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_V2_JOURNAL_BYTES) {
        loaded.push({ path: file });
        continue;
      }
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
        || !await admitsV2Size(handle, before.size)) {
        loaded.push({ path: file });
        continue;
      }
      raw = await handle.readFile("utf8");
    } catch { raw = undefined; }
    finally { await handle?.close().catch(() => {}); }
    loaded.push({ path: file, journal: raw === undefined ? undefined : parseStateCasJournal(raw, file) });
  }
  return loaded;
}
