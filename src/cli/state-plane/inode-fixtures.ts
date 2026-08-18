/**
 * Test-only fixture construction for "a different inode is now at this path".
 *
 * Never build that by unlinking and recreating: a filesystem that recycles
 * inode numbers hands the same one back, the identity check under test
 * correctly reports a match, and the fixture silently asserts nothing
 * (FLAKE-006 — measured in this repo at tmpfs 0/200 reused, ext4 200/200).
 *
 * The replacement is created at a sibling path while the original is STILL
 * linked, so the kernel cannot hand its number back, and only then renamed over
 * the original. The rename is atomic, so no observer ever sees the path absent.
 *
 * Never: production imports.
 */
import fs from "node:fs";

/** A path's `dev:ino` pair, by `lstat`, as a comparable string. */
export function inodeOf(file: string): string {
  const stat = fs.lstatSync(file);
  return `${Number(stat.dev)}:${Number(stat.ino)}`;
}

/**
 * Put `contents` at `file` under a provably different inode, and return that
 * new identity. Throws rather than producing a vacuous fixture.
 */
export function replaceUnderNewInode(
  file: string,
  contents: Buffer | string,
  options: { mode?: number } = {},
): string {
  const before = inodeOf(file);
  const decoy = `${file}.new-inode`;
  fs.writeFileSync(decoy, contents, options.mode === undefined ? {} : { mode: options.mode });
  const after = inodeOf(decoy);
  if (after === before) {
    fs.unlinkSync(decoy);
    throw new Error(`fixture precondition failed: the replacement for ${file} reused the inode under test`);
  }
  fs.renameSync(decoy, file);
  const settled = inodeOf(file);
  if (settled !== after) {
    throw new Error(`fixture precondition failed: ${file} does not hold the replacement after the rename`);
  }
  return settled;
}
