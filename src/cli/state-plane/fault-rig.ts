/** Filesystem-residue inspection for live genesis and compatibility tests. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type RboxResidue = Record<string, string>;

/**
 * Every byte under `.rbox`, sidecars included.
 *
 * Lock files and the locking health probe are excluded because their contents
 * legitimately differ between otherwise equivalent runs.
 */
export function rboxResidue(root: string): RboxResidue {
  const base = path.join(root, ".rbox");
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (entry.name.endsWith(".lock") || entry.name === "locking-health.json") continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (entry.isSymbolicLink()) {
        out[rel] = `symlink:${fs.readlinkSync(abs)}`;
        continue;
      }
      if (!entry.isFile()) {
        out[rel] = "special";
        continue;
      }
      out[rel] = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
    }
  };
  walk(base);
  return out;
}

/** The residue paths only, which is what §7.3's table is written in terms of. */
export const rboxResiduePaths = (root: string): string[] => Object.keys(rboxResidue(root)).sort();
