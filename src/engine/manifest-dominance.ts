/**
 * Name the directory responsible for a manifest's size (#810). A refusal that
 * only reports a total leaves the user guessing which of thousands of
 * directories to exclude; the whole point is to hand them one command.
 *
 * Pure string/count logic over already-composed entries — no IO, no matcher.
 */
import type { FileEntry } from "./types.js";

/** Either alone makes one directory worth naming: an absolute flood of new
 *  entries in a single scan, or ownership of most of the manifest. */
export const DOMINANT_NEW_ENTRIES = 100_000;
export const DOMINANT_SHARE = 0.5;

export interface DominantDir {
  /** Up to the first two path segments, e.g. `chromium/src`. */
  readonly dir: string;
  readonly count: number;
}

/** Two segments deep: enough to blame `chromium/src` rather than the whole
 *  checkout, shallow enough to stay a single pass with a small map. */
function bucketOf(relPath: string): string | undefined {
  const first = relPath.indexOf("/");
  if (first < 0) return undefined; // a root-level file belongs to no directory
  const second = relPath.indexOf("/", first + 1);
  return second < 0 ? relPath.slice(0, first) : relPath.slice(0, second);
}

/** The directory owning the most of `entries`, or undefined when every entry
 *  sits at the workspace root. Ties break on name so the message is stable. */
export function dominatingDir(entries: readonly FileEntry[]): DominantDir | undefined {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const dir = bucketOf(entry.path);
    if (dir !== undefined) counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best: DominantDir | undefined;
  for (const [dir, count] of counts) {
    if (!best || count > best.count || (count === best.count && dir < best.dir)) best = { dir, count };
  }
  return best;
}

/** Whether this directory is lopsided enough to volunteer a hint the user did
 *  not ask for. A refusal names its directory regardless of this. */
export function isDominant(dir: DominantDir, totalEntries: number): boolean {
  return dir.count >= DOMINANT_NEW_ENTRIES || (totalEntries > 0 && dir.count > totalEntries * DOMINANT_SHARE);
}

/** The remedy sentence: which directory, how much it added, and the one command
 *  that stops it — spelling out that ignoring is not deleting. */
export function dominatingDirHint(dir: DominantDir): string {
  return `${dir.dir} just added ${dir.count.toLocaleString("en-US")} files — looks like build output; ` +
    `\`rbox ignore ${dir.dir}/\` skips it (files stay on disk)`;
}
