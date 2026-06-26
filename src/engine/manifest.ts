import fs from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashFile } from "./hash.js";
import { buildIgnoreMatcher, type IgnoreMatcher } from "./ignore.js";
import type { FileEntry, Manifest } from "./types.js";

/**
 * Walk `root`, applying ignore rules, and produce a content-hashed manifest.
 * Ignored directories are pruned (never descended into) so `node_modules` and
 * friends cost nothing. Symlinks are recorded by their target, never followed.
 */
export async function scanManifest(
  root: string,
  matcher: IgnoreMatcher = buildIgnoreMatcher(root)
): Promise<Manifest> {
  const files: FileEntry[] = [];
  await walk(root, "", matcher, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { generatedAt: new Date().toISOString(), files };
}

async function walk(
  root: string,
  rel: string,
  matcher: IgnoreMatcher,
  out: FileEntry[]
): Promise<void> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(root, childRel);

    if (entry.isDirectory()) {
      if (matcher.ignores(`${childRel}/`)) continue;
      await walk(root, childRel, matcher, out);
    } else if (entry.isSymbolicLink()) {
      if (matcher.ignores(childRel)) continue;
      const target = await fs.readlink(abs);
      out.push({
        path: childRel,
        type: "symlink",
        symlinkTarget: target,
        sha256: hashBytes(Buffer.from(target)),
        size: Buffer.byteLength(target),
        mode: 0o777,
        mtimeMs: 0,
      });
    } else if (entry.isFile()) {
      if (matcher.ignores(childRel)) continue;
      const st = await fs.stat(abs);
      out.push({
        path: childRel,
        type: "file",
        sha256: await hashFile(abs),
        size: st.size,
        mode: st.mode & 0o777,
        mtimeMs: st.mtimeMs,
      });
    }
  }
}
