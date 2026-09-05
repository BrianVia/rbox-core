// Never: rewrite the source index/config or shared-index contents, or create shared-index files.
import fs from "node:fs/promises";
import path from "node:path";
import { gitWithIndexFile } from "../../engine/git-spawn.js";

const PRIVATE_INDEX_CONFIG = ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=keep"];

/** Copy and, when necessary, flatten a private index. The caller owns the destination. */
export async function copyPortableIndex(repoDir: string, source: string, destination: string): Promise<boolean> {
  await fs.copyFile(source, destination);
  const shared = await gitWithPrivateIndex(repoDir, destination, ["-c", "core.splitIndex=true", "rev-parse", "--shared-index-path"]);
  // splitIndex=false can hide the dependency during Git's index read. The
  // read-only true override exposes it; an ordinary index gets the null OID.
  if (!shared) return false;
  const dependency = /^sharedindex\.([0-9a-f]{40})$/.exec(path.basename(shared));
  if (!dependency) throw new Error("unexpected shared-index dependency path");
  if (/^0{40}$/.test(dependency[1]!)) return false;
  await gitWithPrivateIndex(repoDir, destination, ["update-index", "--no-split-index"]);
  await gitWithPrivateIndex(repoDir, destination, ["update-index", "--clear-resolve-undo"]);
  return true;
}

export function gitWithPrivateIndex(repoDir: string, indexFile: string, args: readonly string[]): Promise<string> {
  return gitWithIndexFile(repoDir, indexFile, [...PRIVATE_INDEX_CONFIG, ...args]);
}
